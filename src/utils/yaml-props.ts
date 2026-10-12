export interface ComponentYamlContext {
  component: string
  start: number
  end: number
  indent: number
}

const indentation = (line: string) => line.length - line.trimStart().length
const fencePattern = /^(`{3,}|~{3,})(.*)$/

/** Locate a component's initial props block, not document frontmatter or code samples. */
export function getComponentYamlContext (lines: string[], lineNumber: number): ComponentYamlContext | undefined {
  const stack: Array<{ name: string, colons: number, indent: number, initial: boolean }> = []
  let comment = false
  let block: { start: number, marker: string, component?: string, indent: number } | undefined

  for (let i = 0; i <= lineNumber; i++) {
    const line = lines[i] ?? ''
    const text = line.trim()
    if (block) {
      const closes = block.marker === '---'
        ? text === '---' && indentation(line) === block.indent
        : new RegExp(`^${block.marker[0]}{${block.marker.length},}\\s*$`).test(text)
      if (closes) {
        block = undefined
      } else if (i === lineNumber && block.component) {
        let end = lines.length
        for (let j = i + 1; j < lines.length; j++) {
          const closing = block.marker === '---'
            ? lines[j].trim() === '---' && indentation(lines[j]) === block.indent
            : new RegExp(`^${block.marker[0]}{${block.marker.length},}\\s*$`).test(lines[j].trim())
          if (closing) { end = j; break }
        }
        const firstProp = lines.slice(block.start + 1, end).find(value => /^\s*[\w-]+\s*:/.test(value))
        return { component: block.component, start: block.start, end, indent: firstProp ? indentation(firstProp) : block.indent }
      }
      continue
    }

    const parent = stack[stack.length - 1]
    // Indented code may contain literal fence markers and inline delimiters.
    if (!comment && text && indentation(line) >= (parent?.indent ?? 0) + 4) {
      if (parent) { parent.initial = false }
      continue
    }
    const opening = text.match(/^(:{2,})([\w-]+)(?:\s*\{.*\})?\s*$/)
    // HTML comment markers in quoted component attributes are literal text.
    const unquoted = opening ? text.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '') : text
    if (comment || unquoted.includes('<!--')) {
      comment = !text.includes('-->')
      if (stack.length) { stack[stack.length - 1].initial = false }
      continue
    }
    if (!text) { continue }
    if (i === 0 && text === '---') {
      block = { start: i, marker: '---', indent: indentation(line) }
      continue
    }

    const fence = text.match(fencePattern)
    if (fence || (text === '---' && parent?.initial)) {
      const props = parent?.initial && (text === '---' || /^\s*yaml\s+\[props\]\s*$/.test(fence![2]))
      block = { start: i, marker: fence?.[1] ?? '---', component: props ? parent.name : undefined, indent: indentation(line) }
      if (parent) { parent.initial = false }
      continue
    }

    if (opening) {
      if (parent) { parent.initial = false }
      stack.push({ name: opening[2], colons: opening[1].length, indent: indentation(line), initial: true })
    } else if (/^:{2,}$/.test(text)) {
      let index = stack.length - 1
      while (index >= 0 && stack[index].colons !== text.length) { index-- }
      if (index >= 0) { stack.splice(index) }
    } else if (parent) {
      parent.initial = false
    }
  }
}

/** A line within a YAML scalar is content, even when it looks like another property. */
export function isInsideYamlScalar (lines: string[], lineNumber: number, start: number): boolean {
  let scalarIndent: number | undefined
  let quote: string | undefined
  for (let i = start + 1; i < lineNumber; i++) {
    const line = lines[i]
    if (scalarIndent !== undefined) {
      if (!line.trim() || indentation(line) > scalarIndent) { continue }
      scalarIndent = undefined
    }
    const value = quote ? line : line.match(/^\s*[\w-]+:\s*(.*)$/)?.[1]
    if (value === undefined) { continue }
    if (!quote && /^[|>][\d+-]*(?:\s+#.*)?\s*$/.test(value)) {
      scalarIndent = indentation(line)
      continue
    }
    let offset = 0
    if (!quote && (value[0] === '"' || value[0] === "'")) { quote = value[0]; offset = 1 }
    if (quote) {
      for (let j = offset; j < value.length; j++) {
        if (quote === '"' && value[j] === '\\') { j++; continue }
        if (value[j] === quote) {
          if (quote === "'" && value[j + 1] === "'") { j++; continue }
          quote = undefined
          break
        }
      }
    }
  }
  return quote !== undefined || (scalarIndent !== undefined && (!lines[lineNumber].trim() || indentation(lines[lineNumber]) > scalarIndent))
}

export type PropLiteral = string | number | boolean

/** Parse only literal unions; never resolve aliases or evaluate type expressions. */
function parseLiteralUnion (type: string): PropLiteral[] | undefined {
  const values: PropLiteral[] = []
  let offset = 0
  while (offset < type.length) {
    const rest = type.slice(offset)
    const match = rest.match(/^\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?|true|false|boolean|undefined|null)\s*(\||$)/i)
    if (!match) { return }
    const token = match[1]
    if (token === 'boolean') { values.push(true, false) } else if (token !== 'undefined' && token !== 'null') {
      if (token[0] === "'") {
        // Translate a single-quoted literal to JSON without splitting inside escapes.
        let json = '"'
        for (let i = 1; i < token.length - 1; i++) {
          if (token[i] === '\\') {
            const escaped = token[++i]
            json += escaped === "'" ? "'" : '\\' + escaped
          } else {
            json += token[i] === '"' ? '\\"' : token[i]
          }
        }
        try { values.push(JSON.parse(json + '"')) } catch { return }
      } else {
        try {
          const value = JSON.parse(token)
          if (typeof value === 'number' && !Number.isFinite(value)) { return }
          values.push(value)
        } catch { return }
      }
    }
    offset += match[0].length
    if (match[2] && offset === type.length) { return }
  }
  return values
}

/** vue-component-meta represents unions as enum schemas with literal type-string leaves. */
export function getPropLiteralValues (prop: { type?: string, schema?: unknown }): PropLiteral[] {
  function readSchema (schema: unknown): PropLiteral[] | undefined {
    if (typeof schema === 'string') { return parseLiteralUnion(schema) }
    if (!schema || typeof schema !== 'object') { return }
    const enumSchema = schema as { kind?: string, schema?: unknown[] }
    if (enumSchema.kind !== 'enum' || !Array.isArray(enumSchema.schema)) { return }
    const values: PropLiteral[] = []
    for (const member of enumSchema.schema) {
      const literals = readSchema(member)
      if (!literals) { return }
      values.push(...literals)
    }
    return values
  }
  const values = prop.schema === undefined ? parseLiteralUnion(prop.type ?? '') : readSchema(prop.schema)
  return [...new Set(values ?? [])]
}

export interface YamlValuePosition {
  prop: string
  start: number
  end: number
  quote?: string
}

/** Locate one scalar value, including its quotes, but excluding an inline comment. */
export function getYamlValuePosition (line: string, character: number): YamlValuePosition | undefined {
  const property = line.match(/^\s*([\w-]+):/)
  if (!property) { return }
  if (character < property[0].length) { return }
  let valueStart = property[0].length
  while (/[ \t]/.test(line[valueStart] ?? '') && valueStart < line.length) { valueStart++ }
  const start = Math.min(valueStart, character)
  const quote = line[valueStart] === '"' || line[valueStart] === "'" ? line[valueStart] : undefined
  let end = line.length
  if (quote) {
    let closed = false
    for (let i = valueStart + 1; i < line.length; i++) {
      if (quote === '"' && line[i] === '\\') { i++; continue }
      if (line[i] === quote) {
        if (quote === "'" && line[i + 1] === "'") { i++; continue }
        end = i + 1
        closed = true
        break
      }
    }
    if (character > end - (closed ? 1 : 0)) { return }
  } else {
    const comment = line.slice(valueStart).search(/(^|\s)#/)
    if (comment >= 0) { end = valueStart + comment }
    end = valueStart + line.slice(valueStart, end).trimEnd().length
    if (character > end && line.slice(end, character).trim()) { return }
    if (/^[|>{[&*!#]/.test(line.slice(valueStart))) { return }
    end = Math.max(end, character)
  }
  return { prop: property[1], start, end, quote }
}

export function formatYamlLiteral (value: PropLiteral, quote?: string): string {
  if (typeof value !== 'string') { return String(value) }
  if (quote === "'" && !/[\r\n]/.test(value)) { return `'${value.replace(/'/g, "''")}'` }
  return JSON.stringify(value)
}
