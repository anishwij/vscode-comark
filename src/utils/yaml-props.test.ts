import { describe, expect, it } from 'vitest'
import { getYamlValuePosition, formatYamlLiteral, isInsideYamlScalar } from './yaml-props'

describe('YAML scalar exclusion', () => {
  it.each(['|', '>-', '|2+'])('excludes %s content but resumes after a dedent', marker => {
    const lines = ['::card', '---', `text: ${marker}`, '  variant: o', 'variant: o', '---']
    expect(isInsideYamlScalar(lines, 3, 1)).toBe(true)
    expect(isInsideYamlScalar(lines, 4, 1)).toBe(false)
  })

  it.each(['"', "'"])('excludes multiline %s strings', quote => {
    const lines = ['::card', '---', `text: ${quote}content`, 'variant: o', `end${quote}`, 'variant: o', '---']
    expect(isInsideYamlScalar(lines, 3, 1)).toBe(true)
    expect(isInsideYamlScalar(lines, 5, 1)).toBe(false)
  })
})

describe('value replacement', () => {
  function replace (source: string, value: string | number | boolean) {
    const cursor = source.indexOf('¦')
    const line = source.replace('¦', '')
    const position = getYamlValuePosition(line, cursor)!
    expect(position.start).toBeLessThanOrEqual(cursor)
    expect(position.end).toBeGreaterThanOrEqual(cursor)
    const insert = (line[position.start - 1] === ':' ? ' ' : '') + formatYamlLiteral(value, position.quote)
    return line.slice(0, position.start) + insert + line.slice(position.end)
  }

  it.each([
    ['variant: o¦', 'variant: "outline"'],
    ['variant: "o¦" # note', 'variant: "outline" # note'],
    ["variant: 'o¦' # note", "variant: 'outline' # note"],
    ['variant: "o¦', 'variant: "outline"'],
    ['variant: "¦', 'variant: "outline"'],
    ["variant: '¦", "variant: 'outline'"],
    ["variant: 'o¦", "variant: 'outline'"],
    ['variant: "ou¦tline"', 'variant: "outline"'],
    ['variant: o  ¦', 'variant: "outline"'],
    ['variant: ¦  ', 'variant: "outline"'],
    ['variant:¦', 'variant: "outline"'],
  ])('replaces only the scalar in %s', (source, expected) => {
    expect(replace(source, 'outline')).toBe(expected)
  })

  it('keeps strings distinct from booleans and numbers', () => {
    expect(replace('enabled: "¦"', true)).toBe('enabled: true')
    expect(replace('enabled: ¦', 'true')).toBe('enabled: "true"')
    expect(replace('count: \'¦\'', 2)).toBe('count: 2')
    expect(replace("text: '¦'", "can't")).toBe("text: 'can''t'")
  })

  it.each(['variant: outline # co¦mment', 'variant: |¦', 'variant: [¦', ':variant: frontmatter.¦', 'variant: "outline" ¦'])('does not offer scalar choices in %s', source => {
    expect(getYamlValuePosition(source.replace('¦', ''), source.indexOf('¦'))).toBeUndefined()
  })
})
