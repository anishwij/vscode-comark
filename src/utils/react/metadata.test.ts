import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { analyzeReactProject, findReactConfig, getReactMetadata, invalidateReactMetadata } from './metadata'
import { getPropLiteralValues } from '../prop-literals'
import { usesExactPropNames } from '../metadata-naming'

const roots: string[] = []
function project (page: string, extra: Record<string, string> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comark-react-'))
  roots.push(root)
  const files = {
    'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', jsx: 'preserve', types: [], paths: { '@/*': ['./src/*'] }, plugins: [{ name: './never-run-plugin' }] }, include: ['src'] }),
    'src/comark.d.ts': `declare module '@comark/react' {
      export function MarkdownDocument(props: { components?: unknown }): any
      export function Markdown(props: { components?: unknown }): any
      export function MarkdownLive(props: { components?: unknown }): any
      export function MarkdownClient(props: { components?: unknown }): any
      export function defineMarkdownComponent(config: { components?: unknown }): (props: {}) => any
      export function defineMarkdownDocumentComponent(config: { components?: unknown }): (props: {}) => any
    }`,
    'src/base.ts': '/** Common props. */\nexport interface Base {\n  /** The card heading. */\n  title: string;\n  enabled?: boolean; count?: 1 | 2\n}',
    'src/card.tsx': `import { cva, type VariantProps } from 'class-variance-authority'
      import type { Base } from './base'
      const styles = cva('', { variants: { variant: { outline: '', muted: '' } } })
      export interface Props extends Base, VariantProps<typeof styles> { children?: unknown; slotHeader?: unknown; slotFooter?: unknown }
      /** The registered card. */ export function ActualFileName(props: Props) { return null }
      export function Badge(props: { variant?: 'success' | 'danger' }) { return null }
      throw new Error('Source modules must not be executed')`,
    'src/page.tsx': page,
    ...extra,
  }
  fs.symlinkSync(path.resolve('node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), text)
  }
  return root
}
const imports = `import { MarkdownDocument as Renderer } from '@comark/react'; import { ActualFileName as Card, Badge } from '@/card';`
const analyze = (root: string) => analyzeReactProject(path.join(root, 'tsconfig.json'))

afterEach(() => { for (const root of roots.splice(0)) { fs.rmSync(root, { recursive: true, force: true }) } })

describe('static React registrations', () => {
  it('uses actual mapping keys and checker-resolved imported/inherited/CVA props', async () => {
    const root = project(`${imports} const components = { card: Card }; export const page = <Renderer components={components} />`)
    const result = await analyze(root)
    expect(result.metadata.map(item => item.mdc_name)).toEqual(['card'])
    const meta = result.metadata[0].component_meta.meta
    expect(meta.props.find(prop => prop.name === 'title')).toMatchObject({ required: true, description: 'The card heading.', type: 'string' })
    expect(meta.props.find(prop => prop.name === 'enabled')).toMatchObject({ required: false })
    expect(getPropLiteralValues(meta.props.find(prop => prop.name === 'enabled')!)).toEqual([false, true])
    expect(getPropLiteralValues(meta.props.find(prop => prop.name === 'count')!)).toEqual([1, 2])
    expect(getPropLiteralValues(meta.props.find(prop => prop.name === 'variant')!)).toEqual(['outline', 'muted'])
    expect(meta.slots.map(slot => slot.name)).toEqual(['default', 'header', 'footer'])
    expect(meta.props.every(prop => !('default' in prop))).toBe(true)
    expect(result.metadata[0].mdc_name).not.toBe('actual-file-name')
    expect(usesExactPropNames(result.metadata[0])).toBe(true)
  })

  it('exposes runtime-resolvable normalized PascalCase registration names', async () => {
    const root = project(`${imports} export const page = <Renderer components={{ Card, FooBar: Card, fooBar: Badge, HTTPCard: Card }} />`)
    const result = await analyze(root)
    expect(result.metadata.map(item => item.mdc_name)).toEqual(['card', 'foo-bar'])
    expect(getPropLiteralValues(result.metadata[1].component_meta.meta.props.find(prop => prop.name === 'variant')!)).toEqual(['outline', 'muted'])
  })

  it('does not advertise camelCase or acronym keys that the renderer cannot resolve', async () => {
    const root = project(`${imports} export const page = <Renderer components={{ fooBar: Card, HTTPCard: Card }} />`)
    expect((await analyze(root)).metadata).toEqual([])
  })

  it.each([
    ['card: Card, Card: Badge', ['success', 'danger']],
    ['card: Badge, Card, ProseCard: Badge', ['success', 'danger']],
    ['card: Badge, Card: Badge, ProseCard: Card', ['outline', 'muted']],
  ])('uses ProsePascalTag, PascalTag, then exact tag precedence: %s', async (mapping, values) => {
    const root = project(`${imports} export const page = <Renderer components={{ ${mapping} }} />`)
    const card = (await analyze(root)).metadata.find(item => item.mdc_name === 'card')!
    expect(getPropLiteralValues(card.component_meta.meta.props.find(prop => prop.name === 'variant')!)).toEqual(values)
  })

  it('does not substitute lower-priority props when a higher-priority entry is unresolved', async () => {
    const root = project(`${imports} declare const unknown: any; export const page = <Renderer components={{ card: Card, Card: Badge, ProseCard: unknown }} />`)
    const result = await analyze(root)
    expect(result.metadata.some(item => item.mdc_name === 'card')).toBe(false)
    expect(result.conflicts).toContain('card')
  })

  it.each([
    `${imports} export const page = <Renderer components={{ card: Card }} />`,
    `${imports} const mapping = { card: Card } as const; const alias = mapping; const View = Renderer; export const page = <View components={alias} />`,
    `${imports} const mapping = { card: Card } satisfies Record<string, unknown>; export const page = <Renderer components={mapping} />`,
    `${imports} const base = { card: Card }; const mapping = { ...base, badge: Badge }; export const page = <Renderer components={mapping} />`,
    `import * as Comark from '@comark/react'; import { ActualFileName as Card } from '@/card'; export const page = <Comark.MarkdownDocument components={{ card: Card }} />`,
  ])('resolves direct objects, const aliases, wrappers, spreads and namespace imports', async source => {
    expect((await analyze(project(source))).metadata.some(item => item.mdc_name === 'card')).toBe(true)
  })

  it('resolves an imported const map through a tsconfig path alias', async () => {
    const root = project(`import { MarkdownDocument } from '@comark/react'; import { components } from '@/map'; export const page = <MarkdownDocument components={components} />`, {
      'src/map.ts': `import { ActualFileName } from './card'; export const components = { card: ActualFileName } as const`,
    })
    expect((await analyze(root)).metadata.map(item => item.mdc_name)).toEqual(['card'])
  })

  it.each(['defineMarkdownComponent', 'defineMarkdownDocumentComponent'])('reads the public %s static config', async factory => {
    expect((await analyze(project(`import { ${factory} as define } from '@comark/react'; import { ActualFileName as Card } from '@/card'; export const Render = define({ components: { card: Card } });`))).metadata.map(item => item.mdc_name)).toEqual(['card'])
  })

  it.each([
    `import { ActualFileName as Card } from '@/card'; function Other(props: any) { return null } export const page = <Other components={{ card: Card }} />`,
    `import { ActualFileName as Card } from '@/card'; function MarkdownDocument(props: any) { return null } export const page = <MarkdownDocument components={{ card: Card }} />`,
    `${imports} declare const dynamic: any; export const page = <Renderer components={dynamic} />`,
    `${imports} declare const factory: () => any; export const page = <Renderer components={factory()} />`,
    `${imports} let mutable = { card: Card }; export const page = <Renderer components={mutable} />`,
    `${imports} declare const dynamic: any; export const page = <Renderer components={{ card: Card, ...dynamic }} />`,
    `${imports} declare const condition: boolean; export const page = <Renderer components={{ card: condition ? Card : Badge }} />`,
    `${imports} const a = b; const b = a; export const page = <Renderer components={a} />`,
    `${imports} const a = { ...b }; const b = { ...a }; export const page = <Renderer components={a} />`,
    `${imports} declare const dynamic: any; export const page = <Renderer components={{ card: Card }} {...dynamic} />`,
  ])('skips unrelated, dynamic, unresolved and cyclic registrations', async source => {
    expect((await analyze(project(source))).metadata).toEqual([])
  })

  it('omits conflicting same-tag maps without combining their variants', async () => {
    const root = project(`${imports} export const a = <Renderer components={{ card: Card }} />; export const b = <Renderer components={{ card: Badge }} />`)
    expect((await analyze(root)).metadata).toEqual([])
  })

  it('keeps independent projects isolated and scopes a document to its closest config', async () => {
    const card = project(`${imports} export const page = <Renderer components={{ card: Card }} />`)
    const badge = project(`${imports} export const page = <Renderer components={{ card: Badge }} />`)
    const first = (await analyze(card)).metadata[0]
    const second = (await analyze(badge)).metadata[0]
    expect(getPropLiteralValues(first.component_meta.meta.props.find(prop => prop.name === 'variant')!)).toEqual(['outline', 'muted'])
    expect(getPropLiteralValues(second.component_meta.meta.props[0])).toEqual(['success', 'danger'])
    fs.mkdirSync(path.join(card, 'nested'))
    fs.writeFileSync(path.join(card, 'nested/tsconfig.json'), '{}')
    expect(findReactConfig(path.join(card, 'nested/content.md'), card)).toBe(path.join(card, 'nested/tsconfig.json'))
    expect(findReactConfig(path.join(badge, 'content.md'), card)).toBeUndefined()
  })

  it('coalesces warm analysis and picks up saved source/config edits on invalidation', async () => {
    const root = project(`${imports} export const page = <Renderer components={{ card: Card }} />`)
    const config = path.join(root, 'tsconfig.json')
    const pending = getReactMetadata(config)
    expect(getReactMetadata(config)).toBe(pending)
    const first = await pending
    expect(await getReactMetadata(config)).toBe(first)
    const file = path.join(root, 'src/card.tsx')
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace("muted: ''", "fresh: ''"))
    invalidateReactMetadata(file)
    const second = await getReactMetadata(config)
    expect(getPropLiteralValues(second.metadata[0].component_meta.meta.props.find(prop => prop.name === 'variant')!)).toEqual(['outline', 'fresh'])
    expect(second).not.toBe(first)
  })

  it('keeps Markdown saves warm and reports consuming projects for external dependencies', async () => {
    const shared = project('', { 'src/base.ts': "export interface Base { title: string; size?: 'one' | 'two' }" })
    const root = project(`${imports} export const page = <Renderer components={{ card: Card }} />`, {
      'src/base.ts': `export { Base } from '${path.join(shared, 'src/base').replaceAll('\\', '/')}'`,
    })
    const config = path.join(root, 'tsconfig.json')
    const first = await getReactMetadata(config)
    expect(invalidateReactMetadata(path.join(root, 'content.md')).size).toBe(0)
    expect(await getReactMetadata(config)).toBe(first)
    const file = path.join(shared, 'src/base.ts')
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace("'two'", "'fresh'"))
    expect(invalidateReactMetadata(file).has(config)).toBe(true)
    const updated = await getReactMetadata(config)
    expect(getPropLiteralValues(updated.metadata[0].component_meta.meta.props.find(prop => prop.name === 'size')!)).toEqual(['one', 'fresh'])
  })

  it('can retry a rejected analysis after a config is repaired', async () => {
    const root = project(`${imports} export const page = <Renderer components={{ card: Card }} />`)
    const config = path.join(root, 'tsconfig.json')
    const original = fs.readFileSync(config)
    fs.writeFileSync(config, '{ broken')
    await expect(getReactMetadata(config)).rejects.toThrow()
    fs.writeFileSync(config, original)
    invalidateReactMetadata(config)
    expect((await getReactMetadata(config)).metadata.map(item => item.mdc_name)).toEqual(['card'])
  })

  it('follows Vite-style solution references with each app config options and refreshes them', async () => {
    const root = project(`${imports} export const page = <Renderer components={{ card: Card }} />`)
    const config = path.join(root, 'tsconfig.json')
    const app = path.join(root, 'tsconfig.app.json')
    const appConfig = fs.readFileSync(config, 'utf8')
    fs.writeFileSync(app, appConfig)
    fs.writeFileSync(path.join(root, 'node.ts'), 'export const value = 1')
    fs.writeFileSync(path.join(root, 'tsconfig.node.json'), JSON.stringify({ files: ['node.ts'], compilerOptions: { types: [] } }))
    fs.writeFileSync(config, JSON.stringify({ files: [], compilerOptions: { paths: { '@/*': ['./wrong/*'] } }, references: [{ path: './tsconfig.app.json' }, { path: './tsconfig.node.json' }] }))
    const first = await getReactMetadata(config)
    expect(getPropLiteralValues(first.metadata[0].component_meta.meta.props.find(prop => prop.name === 'variant')!)).toEqual(['outline', 'muted'])
    expect(first.dependencies).toContain(app)
    const source = path.join(root, 'src/card.tsx')
    fs.writeFileSync(source, fs.readFileSync(source, 'utf8').replace("muted: ''", "fresh: ''"))
    invalidateReactMetadata(source)
    expect(getPropLiteralValues((await getReactMetadata(config)).metadata[0].component_meta.meta.props.find(prop => prop.name === 'variant')!)).toEqual(['outline', 'fresh'])
    fs.writeFileSync(app, JSON.stringify({ ...JSON.parse(appConfig), exclude: ['src/page.tsx'] }))
    invalidateReactMetadata(app)
    expect((await getReactMetadata(config)).metadata).toEqual([])
    // A reference cycle does not recurse forever or execute a build.
    fs.writeFileSync(app, JSON.stringify({ ...JSON.parse(appConfig), references: [{ path: './tsconfig.json' }] }))
    invalidateReactMetadata(app)
    expect((await getReactMetadata(config)).metadata.map(item => item.mdc_name)).toEqual(['card'])
  })

  it('does not reintroduce a tag already ambiguous in another referenced project', async () => {
    const ambiguous = project(`${imports} export const a = <Renderer components={{ card: Card }} />; export const b = <Renderer components={{ card: Badge }} />`)
    const other = project(`${imports} export const page = <Renderer components={{ card: Card }} />`)
    const root = project('')
    fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ files: [], references: [{ path: path.join(ambiguous, 'tsconfig.json') }, { path: path.join(other, 'tsconfig.json') }] }))
    const result = await analyze(root)
    expect(result.conflicts).toContain('card')
    expect(result.metadata).toEqual([])
  })
})
