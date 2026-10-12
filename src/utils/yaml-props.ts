import type { PropLiteral } from './prop-literals'
import { indentation } from './document'

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
    const value = quote ? line : line.match(/^\s*[\w$-]+:\s*(.*)$/)?.[1]
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

export interface YamlValuePosition {
  prop: string
  start: number
  end: number
  quote?: string
}

/** Locate one scalar value, including its quotes, but excluding an inline comment. */
export function getYamlValuePosition (line: string, character: number): YamlValuePosition | undefined {
  const property = line.match(/^\s*([\w$-]+):/)
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
