import { describe, expect, it } from 'vitest'
import { getAttributeContext, formatAttributeString } from './attribute-props'

function context (source: string) {
  const cursor = source.indexOf('¦')
  const prefix = source.slice(0, cursor).split('\n')
  const result = getAttributeContext(source.replace('¦', '').split('\n'), prefix.length - 1, prefix[prefix.length - 1].length)
  if (result) {
    expect(result.start).toBeLessThanOrEqual(prefix[prefix.length - 1].length)
    expect(result.end).toBeGreaterThanOrEqual(prefix[prefix.length - 1].length)
  }
  return result
}

describe('component attribute context', () => {
  it.each([
    '::card{v¦}', ':::card{v¦}', '::::card{v¦}', '::card {v¦}', '::card{¦',
    '::card{v¦', '::card{¦}', '::card{variant="outline" ¦}',
  ])('finds a name position in %s', source => {
    expect(context(source)).toMatchObject({ component: 'card', mode: 'name', bound: false })
  })

  it.each([
    'Text :badge[New]{v¦}', 'Text :badge{v¦}[New]', ':badge[**New**]{v¦}',
    'Text :badge[New]{variant="green"} and :tooltip{t¦}',
    'Text :tooltip{text="hello"} then :badge[New]{v¦}',
  ])('finds the right inline component in %s', source => {
    expect(context(source)?.component).toBe(source.includes('tooltip{t¦}') ? 'tooltip' : 'badge')
  })

  it('keeps the full current key range and detects an existing value', () => {
    const result = context('::card{long-var¦iant="wide" title="Example"}')!
    expect(result).toMatchObject({ component: 'card', prop: 'long-variant', mode: 'name', hasValue: true, existing: ['title'] })
    expect('::card{long-variant="wide"}'.slice(result.start, result.end)).toBe('long-variant')
  })

  it.each([
    '[See :badge[New]{v¦}](url)', '[A :badge[New]{v¦}]{.span}',
    '[:badge[New]{v¦}][ref]', '**:badge[New]{v¦}**', '_:badge[New]{v¦}_',
    '[**:badge[New]{variant="o¦"}**](url)',
  ])('finds components in rendered link, span, and emphasis content: %s', source => {
    expect(context(source)).toMatchObject({ component: 'badge' })
  })

  it('preserves bound prefixes and counts bound, camel-case, and shorthand attributes', () => {
    expect(context('::card{:v¦}')).toMatchObject({ bound: true, prop: 'v', mode: 'name' })
    expect(context('::card{:variant="data.choice¦"}')).toMatchObject({ bound: true, prop: 'variant', mode: 'value' })
    expect(context('::card{longVariant="wide" :variant="data.choice" .featured #card ¦}')).toMatchObject({
      existing: ['longVariant', 'variant', 'class', 'id'],
    })
  })

  it.each([
    '::card{variant="o¦"}', "::card{variant='o¦'}", '::card{variant=o¦}',
    '::card{variant="o¦', '::card{variant="o¦}', "::card{variant='o¦}",
    '::card{variant="¦}', '::card{variant=¦}', '::card{variant=¦  }',
    '::card{variant="ou¦tline" title="Keep"}',
    '::card{variant="o¦" title="Keep {braces}"} after',
  ])('locates the whole value without replacing surrounding syntax: %s', source => {
    expect(context(source)).toMatchObject({ component: 'card', mode: 'value', prop: 'variant', bound: false })
  })

  it('preserves closing braces while completing an unfinished quote', () => {
    const source = '::card{variant="o¦} after'
    const result = context(source)!
    const line = source.replace('¦', '')
    expect(line.slice(0, result.start) + formatAttributeString('outline', result.quote) + line.slice(result.end)).toBe('::card{variant="outline"} after')
  })

  it('does not consume a following assignment when completing an empty value', () => {
    for (const source of ['::card{variant=¦ title="Keep"}', '::card{variant= ¦ title="Keep"}']) {
      const result = context(source)!
      const line = source.replace('¦', '')
      expect(result).toMatchObject({ mode: 'value', prop: 'variant', existing: ['title'] })
      expect(line.slice(0, result.start) + formatAttributeString('outline') + line.slice(result.end)).toBe('::card{variant="outline" title="Keep"}')
    }
    expect(context('::card{variant= ti¦tle="Keep"}')).toMatchObject({ mode: 'name', prop: 'title', hasValue: true })
  })

  it('handles braces and escapes inside an already quoted value', () => {
    expect(context(String.raw`::card{variant="a{b}\\c¦" title="Keep"}`)).toMatchObject({ mode: 'value', existing: ['title'] })
    expect(context(String.raw`::card{variant="a\"b¦"}`)).toMatchObject({ mode: 'value' })
    expect(context(`::card{:options={text:'}'} v¦}`)).toMatchObject({ mode: 'name', prop: 'v', existing: ['options'] })
    expect(context(`::card{:options={text:':badge{v¦}'}}`)).toBeUndefined()
  })

  it.each([
    '[Span]{v¦}', '[Link](url){v¦}', '![Image](image.png){v¦}', '**Bold**{v¦}',
    '[Link](url " :badge{v¦}")', '[Link][ :badge{v¦}]', '![Alt :badge{v¦}](image.png)',
    'Text ::card{v¦}', 'http://card{v¦}', String.raw`\::card{v¦}`, String.raw`Text \:badge{v¦}`,
    '`::card{v¦}`', '`` :badge[New]{v¦} ``',
    'Text `code\n:badge[New]{v¦}\nend`', 'Text ``code\n` :badge[New]{v¦}\nend``',
    '```md\n::card{v¦}\n```', '~~~~md\n```\n::card{v¦}\n~~~~',
    '---\ntitle: :badge{v¦}\n---', '::card\n---\ntitle: :badge{v¦}\n---\n::',
    '::card\n```yaml [props]\ntitle: :badge{v¦}\n```\n::',
    '<!-- ::card{v¦} -->', '<!--\n:badge{v¦}\n-->', '    ::card{v¦}',
    '::card{.fea¦tured}', '::card{#ca¦rd}', '::card{variant={cho¦ice}}',
  ])('excludes unrelated or protected syntax: %s', source => {
    expect(context(source)).toBeUndefined()
  })

  it('resumes after comments and code spans end, without reading their component-like text', () => {
    expect(context('<!-- :tooltip{text="ignore"} --> :badge[New]{v¦}')).toMatchObject({ component: 'badge' })
    expect(context('Text `code\nend` :badge[New]{v¦}')).toMatchObject({ component: 'badge' })
    expect(context('Text :tooltip{text="<!-- literal"}\n::card{v¦}')).toMatchObject({ component: 'card' })
    expect(context('Text `code\n\n:badge[New]{v¦}')).toMatchObject({ component: 'badge' })
  })
})

describe('lossless plain attribute strings', () => {
  it.each([
    ['outline', undefined, '"outline"'], ['outline', "'", "'outline'"],
    ['say "hello"', undefined, "'say \"hello\"'"], ["can't", "'", '"can\'t"'],
    [String.raw`a\b`, undefined, String.raw`"a\b"`],
    ['spaces | {braces} $1 ${0} }', undefined, '"spaces | {braces} $1 ${0} }"'],
    ['{braces}', undefined, '"{braces}"'],
  ])('formats %s without changing its value', (value, quote, expected) => {
    expect(formatAttributeString(value, quote)).toBe(expected)
  })

  it.each(['both \' and "', 'trailing\\', 'line\nbreak', '{"a":1}', '[1,2]'])('omits unrepresentable string %s', value => {
    expect(formatAttributeString(value)).toBeUndefined()
  })
})
