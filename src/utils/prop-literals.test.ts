import { describe, expect, it } from 'vitest'
import { getPropLiteralValues } from './prop-literals'
import metadata from '../../test/fixtures/component-metadata.json'

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
