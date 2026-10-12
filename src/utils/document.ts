export interface ComponentYamlContext {
  component: string
  start: number
  end: number
  indent: number
}

export const indentation = (line: string) => line.length - line.trimStart().length
const fencePattern = /^(`{3,}|~{3,})(.*)$/

export interface DocumentContext {
  yaml?: ComponentYamlContext
  protected: boolean
  comment: boolean
  inlineCode?: string
}

/** Return the end of a quoted attribute, or the line end while it is incomplete. */
export function skipQuotedAttribute (line: string, start: number): number {
  const quote = line[start]
  for (let i = start + 1; i < line.length; i++) {
    if (line[i] === '\\') { i++; continue }
    if (line[i] === quote) { return i + 1 }
  }
  return line.length
}

/** Skip one inline code span, including an incomplete span while authoring. */
export function skipInlineCode (line: string, start: number): number {
  const marker = line.slice(start).match(/^`+/)![0]
  return findInlineCodeEnd(line, start + marker.length, marker) ?? line.length
}

export function findInlineCodeEnd (line: string, start: number, marker: string): number | undefined {
  let next = start
  while (next < line.length) {
    const end = line.indexOf(marker, next)
    if (end < 0) { break }
    if (line[end - 1] !== '`' && line[end + marker.length] !== '`') { return end + marker.length }
    next = end + marker.length
  }
}

function inlineState (line: string, comment: boolean, inlineCode?: string): { comment: boolean, inlineCode?: string } {
  let braces = 0
  if (!line.trim()) { inlineCode = undefined }
  for (let i = 0; i < line.length; i++) {
    if (comment) {
      const end = line.indexOf('-->', i)
      if (end < 0) { return { comment: true } }
      comment = false
      i = end + 2
    } else if (inlineCode) {
      const end = findInlineCodeEnd(line, i, inlineCode)
      if (end === undefined) { return { comment, inlineCode } }
      inlineCode = undefined
      i = end - 1
    } else if (line[i] === '\\') {
      i++
    } else if (braces && (line[i] === '"' || line[i] === "'")) {
      i = skipQuotedAttribute(line, i) - 1
    } else if (line[i] === '`') {
      const marker = line.slice(i).match(/^`+/)![0]
      const end = findInlineCodeEnd(line, i + marker.length, marker)
      if (end === undefined) { return { comment, inlineCode: marker } }
      i = end - 1
    } else if (line.startsWith('<!--', i)) {
      comment = true
      i += 3
    } else if (line[i] === '{') {
      braces++
    } else if (line[i] === '}') {
      braces = Math.max(0, braces - 1)
    }
  }
  return { comment, inlineCode }
}

/** Share YAML/code/comment boundaries between component prop completion providers. */
export function getDocumentContext (lines: string[], lineNumber: number): DocumentContext {
  const stack: Array<{ name: string, colons: number, indent: number, initial: boolean }> = []
  let comment = false
  let inlineCode: string | undefined
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
        return { protected: true, comment: false, yaml: { component: block.component, start: block.start, end, indent: firstProp ? indentation(firstProp) : block.indent } }
      }
      if (i === lineNumber) { return { protected: true, comment: false } }
      continue
    }

    if (i === lineNumber) {
      return { protected: !inlineCode && (fencePattern.test(text) || indentation(line) >= (stack[stack.length - 1]?.indent ?? 0) + 4), comment, inlineCode }
    }
    const parent = stack[stack.length - 1]
    // Indented code may contain literal fence markers and inline delimiters.
    if (!comment && !inlineCode && text && indentation(line) >= (parent?.indent ?? 0) + 4) {
      if (parent) { parent.initial = false }
      continue
    }
    const fence = text.match(fencePattern)
    if (!comment && !inlineCode) {
      if (i === 0 && text === '---') {
        block = { start: i, marker: '---', indent: indentation(line) }
        continue
      }
      if (fence || (text === '---' && parent?.initial)) {
        const props = parent?.initial && (text === '---' || /^\s*yaml\s+\[props\]\s*$/.test(fence![2]))
        block = { start: i, marker: fence?.[1] ?? '---', component: props ? parent.name : undefined, indent: indentation(line) }
        if (parent) { parent.initial = false }
        continue
      }
    }
    const opening = text.match(/^(:{2,})([\w-]+)(?:\s*\{.*\})?\s*$/)
    const wasComment = comment
    const wasCode = inlineCode
    const state = inlineState(line, comment, inlineCode)
    comment = state.comment
    inlineCode = state.inlineCode
    if (wasComment || comment || wasCode || inlineCode || text.startsWith('<!--')) {
      if (stack.length) { stack[stack.length - 1].initial = false }
      continue
    }
    if (!text) { continue }
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
  return { protected: false, comment }
}

/** Locate a component's initial props block, not document frontmatter or code samples. */
export function getComponentYamlContext (lines: string[], lineNumber: number): ComponentYamlContext | undefined {
  return getDocumentContext(lines, lineNumber).yaml
}
