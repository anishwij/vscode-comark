import { describe, expect, it } from 'vitest'
import { getComponentYamlContext, getPropLiteralValues, getYamlValuePosition, formatYamlLiteral, isInsideYamlScalar } from './yaml-props'
import metadata from '../../test/fixtures/component-metadata.json'

function context (source: string) {
  const offset = source.indexOf('¦')
  const line = source.slice(0, offset).split('\n').length - 1
  return getComponentYamlContext(source.replace('¦', '').split('\n'), line)
}

describe('component YAML context', () => {
  it.each(['---', '```yaml [props]', '~~~~yaml [props]'])('recognizes an initial %s block with inline props', opener => {
    const close = opener === '---' ? '---' : opener.match(/^[`~]+/)![0]
    expect(context(`::card{variant="muted"}\n${opener}\nvariant: ¦\n${close}\n::`)).toMatchObject({ component: 'card', start: 1, end: 3, indent: 0 })
  })

  it('recognizes incomplete props blocks', () => {
    expect(context('::card\n---\nvariant: ¦')).toMatchObject({ component: 'card', end: 3 })
  })

  it('does not treat literal fences or inline delimiters in indented code as document state', () => {
    for (const literal of ['```', '~~~yaml [props]', '<!--', '`unclosed']) {
      expect(context(`    ${literal}\n\n::card\n---\nvariant: ¦\n---\n::`)).toMatchObject({ component: 'card' })
    }
    expect(context('::outer\n    ```\n\n:::card\n---\nvariant: ¦\n---\n:::\n::')).toMatchObject({ component: 'card' })
  })

  it.each([':::', '::::', '::'])('selects the innermost component and closes %s correctly', marker => {
    expect(context(`::card\n${marker}alert\n---\nvariant: ¦\n---\n${marker}\n::`)).toMatchObject({ component: 'alert' })
    expect(context(`::card\n${marker}alert\n${marker}\n\n---\nvariant: ¦\n---\n::`)).toBeUndefined()
    expect(context(`::card\n${marker}alert\n${marker}\n::\n::card\n---\nvariant: ¦\n---\n::`)).toMatchObject({ component: 'card' })
  })

  it('supports indentation and comment markers in quoted opening attributes', () => {
    expect(context('::card{title="<!-- hello"}\n---\nvariant: ¦\n---\n::')).toMatchObject({ component: 'card' })
    expect(context("  :::card{title='<!-- hello'}\n  ---\n  variant: ¦\n  ---\n  :::")).toMatchObject({ component: 'card', indent: 2 })
  })

  it('does not close a YAML block on a delimiter inside a block scalar', () => {
    expect(context('::card\n---\ntext: |\n  ---\nvariant: ¦\n---\n::')).toMatchObject({ component: 'card', end: 5 })
  })

  it.each([
    '---\nvariant: ¦\n---',
    '```md\n::card\n---\nvariant: ¦\n---\n::\n```',
    '~~~~md\n```\n::card\n---\nvariant: ¦\n---\n::\n~~~~',
    '<!--\n::card\n---\nvariant: ¦\n---\n::\n-->',
    '    ::card\n    ---\n    variant: ¦\n    ---\n    ::',
    '::card\n```yaml\nvariant: ¦\n```\n::',
    '::card\nParagraph\n---\nvariant: ¦\n---\n::',
    '::card\n#footer\n```yaml [props]\nvariant: ¦\n```\n::',
    '::card\nParagraph\n```yaml [props]\nvariant: ¦\n```\n::',
    'Paragraph\n---\nvariant: ¦\n---',
    '::card\n---\nvariant: outline\n---\nvariant: ¦\n::',
  ])('excludes frontmatter, comments, prose, and ordinary code: %s', source => {
    expect(context(source)).toBeUndefined()
  })
})

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

describe('literal metadata', () => {
  it('reads representative vue-component-meta enum schemas, including an aliased prop type', () => {
    const props = metadata[0].component_meta.meta.props
    expect(getPropLiteralValues(props.find(prop => prop.name === 'variant')!)).toEqual(['default', 'outline', 'muted'])
    expect(getPropLiteralValues(props.find(prop => prop.name === 'enabled')!)).toEqual([false, true])
    expect(getPropLiteralValues(props.find(prop => prop.name === 'count')!)).toEqual([1, 2, 3])
  })

  it('prefers structured schema over the displayed type', () => {
    expect(getPropLiteralValues({ type: '"wrong"', schema: { kind: 'enum', schema: ['"right"', 'undefined'] } })).toEqual(['right'])
    expect(getPropLiteralValues({ type: '"wrong"', schema: { kind: 'object' } })).toEqual([])
  })

  it.each([
    ['"default" | "outline" | undefined', ['default', 'outline']],
    ["'a|b' | 'can\\'t' | 'say \"hello\"'", ['a|b', "can't", 'say "hello"']],
    ['"a\\\\b" | "line\\nend"', ['a\\b', 'line\nend']],
    ['-1 | 0 | 2.5 | 1e2', [-1, 0, 2.5, 100]],
    ['boolean | undefined', [true, false]],
    ['"true" | true | "1" | 1', ['true', true, '1', 1]],
    ['"a" | "a" | null', ['a']],
    ['Variant', []], ['string', []], ['number', []], ['"a" | string', []],
    ['"a" | unknown', []], ['"a" |', []], ['Array<"a">', []],
    ['(() => process.exit())()', []],
  ])('conservatively reads %s', (type, expected) => {
    expect(getPropLiteralValues({ type: type as string })).toEqual(expected)
  })

  it('uses current metadata without retaining old enum values', () => {
    const prop = { type: 'Variant', schema: { kind: 'enum', schema: ['"old"'] } }
    expect(getPropLiteralValues(prop)).toEqual(['old'])
    prop.schema.schema = ['"new"']
    expect(getPropLiteralValues(prop)).toEqual(['new'])
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
