import { describe, expect, it } from 'vitest'
import { getComponentYamlContext } from './document'

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
