import { getDocumentContext, findInlineCodeEnd, skipInlineCode, skipQuotedAttribute } from './document'

export interface AttributeContext {
  component: string
  mode: 'name' | 'value'
  prop?: string
  bound: boolean
  quote?: string
  start: number
  end: number
  hasValue: boolean
  existing: string[]
}

function bracketEnd (line: string, start: number, open: string, close: string, quoted = false): number {
  let depth = 1
  for (let i = start + 1; i < line.length; i++) {
    if (line[i] === '\\') { i++; continue }
    if (quoted && (line[i] === '"' || line[i] === "'" || line[i] === '`')) { i = skipQuotedAttribute(line, i) - 1; continue }
    if (line[i] === open) { depth++ }
    if (line[i] === close && --depth === 0) { return i + 1 }
  }
  return line.length
}

/** Parse only the component attribute group around the cursor, including unfinished input. */
function attributeGroup (line: string, open: number, cursor: number, component: string): { context?: AttributeContext, end: number } {
  let context: Omit<AttributeContext, 'existing'> | undefined
  const attributes: Array<{ prop: string, start: number }> = []
  let current: number | undefined
  let offset = open + 1
  while (offset <= line.length) {
    const whitespace = offset
    while (/\s/.test(line[offset] ?? '') && offset < line.length) { offset++ }
    if (!context && cursor >= whitespace && cursor < offset) {
      context = { component, mode: 'name', bound: false, start: cursor, end: cursor, hasValue: false }
      current = undefined
    }
    if (offset === line.length || line[offset] === '}') {
      if (!context && cursor === offset) {
        context = { component, mode: 'name', bound: false, start: cursor, end: cursor, hasValue: false }
        current = undefined
      }
      break
    }
    if (line[offset] === '.' || line[offset] === '#') {
      attributes.push({ prop: line[offset] === '.' ? 'class' : 'id', start: offset })
      while (offset < line.length && !/[\s}]/.test(line[offset])) { offset++ }
      continue
    }

    const tokenStart = offset
    const bound = line[offset] === ':'
    if (bound) { offset++ }
    const nameStart = offset
    const name = line.slice(offset).match(/^[\w$-]*/)?.[0] ?? ''
    offset += name.length
    const nameEnd = offset
    if (!name && !bound) { offset++; continue }
    const prop = name
    attributes.push({ prop, start: tokenStart })
    let equals = offset
    while (/\s/.test(line[equals] ?? '') && equals < line.length) { equals++ }
    const hasValue = line[equals] === '='
    if (cursor >= nameStart && cursor <= nameEnd) {
      context = { component, mode: 'name', prop, bound, start: nameStart, end: nameEnd, hasValue }
      current = tokenStart
    }
    if (!hasValue) { continue }

    offset = equals + 1
    while (/\s/.test(line[offset] ?? '') && offset < line.length) { offset++ }
    const valueStart = offset
    if (valueStart > equals + 1 && /^:?[a-z_$][\w$-]*\s*=/i.test(line.slice(valueStart))) {
      // An empty value before another assignment must not consume that attribute.
      if (cursor >= equals + 1 && cursor < valueStart) {
        context = { component, mode: 'value', prop, bound, start: equals + 1, end: cursor, hasValue: true }
        current = tokenStart
      }
      continue
    }
    const quote = line[offset] === '"' || line[offset] === "'" ? line[offset] : undefined
    let closed = false
    if (quote) {
      offset = skipQuotedAttribute(line, offset)
      let slashes = 0
      for (let i = offset - 2; i >= valueStart && line[i] === '\\'; i--) { slashes++ }
      closed = offset > valueStart + 1 && line[offset - 1] === quote && slashes % 2 === 0
      if (!closed) {
        // A trailing group brace is often already present while a quote is unfinished.
        let braces = 0
        for (let i = valueStart + 1; i < line.length; i++) {
          if (line[i] === '\\') { i++; continue }
          if (line[i] === '{') { braces++ }
          if (line[i] === '}') {
            if (braces) { braces-- } else if (i >= cursor) { offset = i; break }
          }
        }
      }
    } else if (line[offset] === '{' || line[offset] === '[' || line[offset] === '`') {
      // Compound/bound expressions aren't scalar string completion positions.
      offset = line[offset] === '`' ? skipQuotedAttribute(line, offset) : bracketEnd(line, offset, line[offset], line[offset] === '{' ? '}' : ']', true)
      continue
    } else {
      while (offset < line.length && !/[\s}]/.test(line[offset])) {
        if (line[offset] === '\\') { offset++ }
        offset++
      }
    }
    if (cursor >= equals + 1 && cursor <= offset - (closed ? 1 : 0)) {
      context = { component, mode: 'value', prop, bound, quote, start: Math.min(valueStart, cursor), end: offset, hasValue: true }
      current = tokenStart
    }
  }
  return {
    context: context ? { ...context, existing: attributes.filter(attribute => attribute.start !== current).map(attribute => attribute.prop) } : undefined,
    end: offset + (line[offset] === '}' ? 1 : 0)
  }
}

/** Attribute suggestions apply to identified components, never native Markdown attributes. */
export function getAttributeContext (lines: string[], lineNumber: number, cursor: number): AttributeContext | undefined {
  const document = getDocumentContext(lines, lineNumber)
  if (document.protected) { return }
  const line = lines[lineNumber]
  let comment = document.comment
  if (document.inlineCode) {
    const end = findInlineCodeEnd(line, 0, document.inlineCode)
    if (end === undefined || cursor < end) { return }
  }
  const offset = document.inlineCode ? findInlineCodeEnd(line, 0, document.inlineCode)! : 0
  for (let i = offset; i < line.length;) {
    if (comment) {
      const end = line.indexOf('-->', i)
      if (end < 0) { return }
      comment = false
      i = end + 3
      continue
    }
    if (line.startsWith('<!--', i)) { comment = true; i += 4; continue }
    if (line[i] === '\\') { i += 2; continue }
    if (line[i] === '`') { i = skipInlineCode(line, i); continue }
    // Scan rendered link/span text, but not image alt text or link destinations.
    if (line[i] === '[' && line[i - 1] === '!') { i = bracketEnd(line, i, '[', ']'); continue }
    if (line[i] === ']' && (line[i + 1] === '(' || line[i + 1] === '[')) {
      const open = line[i + 1]
      i = bracketEnd(line, i + 1, open, open === '(' ? ')' : ']', true)
      continue
    }
    if (line[i] === '{') {
      // Skip native element attributes and interpolation, including their quoted text.
      i = attributeGroup(line, i, -1, '').end
      continue
    }
    if (line[i] !== ':') { i++; continue }
    const colonStart = i
    while (line[i] === ':') { i++ }
    const colons = i - colonStart
    if (colons >= 2 ? line.slice(0, colonStart).trim() !== '' : colonStart > 0 && !/[\s*_[]/.test(line[colonStart - 1])) { continue }
    const name = line.slice(i).match(/^[a-z_$][\w$-]*/i)?.[0]
    if (!name) { continue }
    i += name.length
    if (line[i] === '[') { i = bracketEnd(line, i, '[', ']') }
    if (colons >= 2) { while (/\s/.test(line[i] ?? '') && i < line.length) { i++ } }
    if (line[i] !== '{' || line[i + 1] === '{') { continue }
    const group = attributeGroup(line, i, cursor, name)
    if (group.context) { return group.context }
    i = group.end
  }
}

export function formatAttributeString (value: string, quote = '"'): string | undefined {
  // Plain Comark attributes preserve escapes rather than JSON-decoding them.
  // Change delimiters instead of adding escapes that would change the received value.
  if (/[\r\n]/.test(value) || value.endsWith('\\')) { return }
  if (/^(?:\{[\s\S]*\}|\[[\s\S]*\])$/.test(value)) {
    try { JSON.parse(value); return } catch { /* Non-JSON braces remain strings. */ }
  }
  if (value.includes(quote)) { quote = quote === '"' ? "'" : '"' }
  if (value.includes(quote)) { return }
  return quote + value + quote
}
