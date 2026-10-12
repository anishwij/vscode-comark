import * as path from 'node:path'
import * as fs from 'node:fs'
import type * as TS from 'typescript'
import type { MDCComponentData } from '../../completion-providers'
import { kebabCase, pascalCase } from 'scule'
import { markReactComponentMetadata } from '../metadata-naming'

let compiler: Promise<typeof TS> | undefined
const renderers = new Set(['Markdown', 'MarkdownDocument', 'MarkdownLive', 'MarkdownClient'])
const factories = new Set(['defineMarkdownComponent', 'defineMarkdownDocumentComponent'])

export function findReactConfig (file: string, workspace: string): string | undefined {
  let directory = fs.existsSync(file) && fs.statSync(file).isDirectory() ? file : path.dirname(file)
  while (directory === workspace || directory.startsWith(workspace + path.sep)) {
    const config = path.join(directory, 'tsconfig.json')
    if (fs.existsSync(config)) { return config }
    if (directory === workspace) { break }
    directory = path.dirname(directory)
  }
}

export interface ReactAnalysis {
  metadata: MDCComponentData[]
  dependencies: string[]
  program: TS.Program
  conflicts: string[]
  references: string[]
  projects?: Record<string, ReactAnalysis>
}

/** Read static registrations and checker-exposed callable props; never execute project code. */
async function analyzeSingleProject (config: string, oldProgram?: TS.Program): Promise<ReactAnalysis> {
  const ts = await (compiler ??= import('typescript'))
  const configs = new Set<string>([config])
  const parsed = ts.getParsedCommandLineOfConfigFile(config, { noEmit: true }, {
    ...ts.sys,
    readFile: file => { configs.add(file); return ts.sys.readFile(file) },
    onUnRecoverableConfigFileDiagnostic: () => {}
  })
  if (!parsed || parsed.errors.length) { throw new Error('Unable to read TypeScript project configuration') }
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options, oldProgram })
  const checker = program.getTypeChecker()
  const symbols = new Map<TS.Symbol, string>()
  const sources = program.getSourceFiles().filter(source => !source.isDeclarationFile && !source.fileName.includes('/node_modules/'))
  const resolveSymbol = (symbol?: TS.Symbol) => symbol && (symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol)
  for (const source of sources) {
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== '@comark/react') { continue }
      const bindings = statement.importClause?.namedBindings
      if (bindings && ts.isNamedImports(bindings)) {
        for (const item of bindings.elements) {
          const name = (item.propertyName ?? item.name).text
          const symbol = resolveSymbol(checker.getSymbolAtLocation(item.name))
          if (symbol && (renderers.has(name) || factories.has(name))) { symbols.set(symbol, name) }
        }
      } else if (bindings && ts.isNamespaceImport(bindings)) {
        const symbol = resolveSymbol(checker.getSymbolAtLocation(bindings.name))
        if (symbol) {
          for (const exported of checker.getExportsOfModule(symbol)) {
            const resolved = resolveSymbol(exported)
            if (resolved && (renderers.has(exported.name) || factories.has(exported.name))) { symbols.set(resolved, exported.name) }
          }
        }
      }
    }
  }

  function unwrap (expression: TS.Expression): TS.Expression {
    while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression) || ts.isTypeAssertionExpression(expression) || ts.isNonNullExpression(expression)) { expression = expression.expression }
    return expression
  }
  function initializer (expression: TS.Expression, seen = new Set<TS.Symbol>()): TS.Expression | undefined {
    expression = unwrap(expression)
    if (!ts.isIdentifier(expression) && !ts.isPropertyAccessExpression(expression)) { return expression }
    const symbol = resolveSymbol(checker.getSymbolAtLocation(expression))
    if (!symbol || seen.has(symbol)) { return }
    seen.add(symbol)
    for (const declaration of symbol.declarations ?? []) {
      if (ts.isVariableDeclaration(declaration) && ts.isVariableDeclarationList(declaration.parent) && declaration.parent.flags & ts.NodeFlags.Const && declaration.initializer) { return initializer(declaration.initializer, seen) }
      if (ts.isExportAssignment(declaration)) { return initializer(declaration.expression, seen) }
      if (ts.isPropertyAssignment(declaration)) { return initializer(declaration.initializer, seen) }
    }
    return expression
  }
  function apiName (expression: TS.Expression): string | undefined {
    expression = unwrap(expression)
    const symbol = resolveSymbol(checker.getSymbolAtLocation(expression))
    if (symbol && symbols.has(symbol)) { return symbols.get(symbol) }
    const value = initializer(expression)
    return value && value !== expression ? apiName(value) : undefined
  }
  function key (name: TS.PropertyName): string | undefined {
    if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) { return name.text }
    if (ts.isComputedPropertyName(name)) {
      const value = initializer(name.expression)
      if (value && ts.isStringLiteralLike(value)) { return value.text }
    }
  }
  function objectMap (expression: TS.Expression, seen = new Set<TS.Expression>()): Map<string, TS.Expression> | undefined {
    const value = initializer(expression)
    if (!value || !ts.isObjectLiteralExpression(value) || seen.has(value)) { return }
    seen.add(value)
    const result = new Map<string, TS.Expression>()
    for (const property of value.properties) {
      if (ts.isSpreadAssignment(property)) {
        const spread = objectMap(property.expression, new Set(seen))
        if (!spread) { return }
        for (const [name, component] of spread) { result.set(name, component) }
      } else if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) {
        const name = key(property.name)
        if (name === undefined) { return }
        result.set(name, ts.isPropertyAssignment(property) ? unwrap(property.initializer) : property.name)
      } else { return }
    }
    return result
  }
  function schema (type: TS.Type): unknown {
    if (type.isUnion()) { return { kind: 'enum', type: checker.typeToString(type), schema: type.types.map(schema) } }
    if (type.isStringLiteral()) { return JSON.stringify(type.value) }
    if (type.isNumberLiteral()) { return String(type.value) }
    return checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation)
  }
  function componentMetadata (name: string, expression: TS.Expression): MDCComponentData | undefined {
    if (!ts.isIdentifier(expression) && !ts.isPropertyAccessExpression(expression) && !ts.isArrowFunction(expression) && !ts.isFunctionExpression(expression)) { return }
    const type = checker.getTypeAtLocation(expression)
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Union)) { return }
    const signatures = checker.getSignaturesOfType(type, ts.SignatureKind.Call)
    if (signatures.length !== 1) { return }
    const parameter = signatures[0].parameters[0]
    const propsType = parameter && checker.getTypeOfSymbolAtLocation(parameter, parameter.valueDeclaration ?? expression)
    if (propsType && propsType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) { return }
    const props = propsType ? checker.getPropertiesOfType(propsType).map(prop => {
      const propType = checker.getTypeOfSymbolAtLocation(prop, prop.valueDeclaration ?? expression)
      return {
        name: prop.name,
        type: checker.typeToString(propType, undefined, ts.TypeFormatFlags.NoTruncation),
        schema: schema(propType),
        required: !(prop.flags & ts.SymbolFlags.Optional),
        global: false,
        description: ts.displayPartsToString(prop.getDocumentationComment(checker)),
        tags: prop.getJsDocTags(checker).map(tag => ({
          name: tag.name,
          text: ts.displayPartsToString(tag.text)
        }))
      }
    }) : []
    const slots = props.filter(prop => prop.name === 'children' || /^slot[A-Z]/.test(prop.name)).map(prop => ({
      name: prop.name === 'children' ? 'default' : prop.name[4].toLowerCase() + prop.name.slice(5),
      type: prop.type,
      schema: prop.schema,
      description: prop.description,
      tags: prop.tags
    }))
    const symbol = resolveSymbol(checker.getSymbolAtLocation(expression))
    return markReactComponentMetadata({
      mdc_name: name,
      description: symbol ? ts.displayPartsToString(symbol.getDocumentationComment(checker)) : undefined,
      component_meta: {
        filePath: symbol?.valueDeclaration?.getSourceFile().fileName,
        meta: { type: 2, props, slots, events: [], exposed: [] }
      }
    } as unknown as MDCComponentData)
  }

  const registrations = new Map<string, MDCComponentData>()
  const conflicts = new Set<string>()
  function register (expression: TS.Expression) {
    const map = objectMap(expression)
    if (!map) { return }
    const tags = new Set([...map.keys()].flatMap(name => [
      kebabCase(name),
      ...(name.startsWith('Prose') && name.length > 5 ? [kebabCase(name.slice(5))] : [])
    ]))
    for (const name of tags) {
      // Match @comark/react's ProsePascalTag -> PascalTag -> normalized tag lookup.
      const pascal = pascalCase(name)
      const key = [`Prose${pascal}`, pascal, name].find(candidate => map.has(candidate))
      if (!key) { continue }
      const value = map.get(key)!
      const metadata = componentMetadata(name, value)
      if (!metadata) { conflicts.add(name); continue }
      const previous = registrations.get(name)
      if (previous && JSON.stringify(previous) !== JSON.stringify(metadata)) { conflicts.add(name) }
      else { registrations.set(name, metadata) }
    }
  }
  for (const source of sources) {
    function visit (node: TS.Node) {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const name = apiName(node.tagName as TS.Expression)
        if (name && renderers.has(name)) {
          const properties = node.attributes.properties
          const matches = properties.filter(property => ts.isJsxAttribute(property) && property.name.getText(source) === 'components') as TS.JsxAttribute[]
          if (matches.length === 1 && !properties.slice(properties.indexOf(matches[0]) + 1).some(ts.isJsxSpreadAttribute)) {
            const expression = matches[0].initializer
            if (expression && ts.isJsxExpression(expression) && expression.expression) { register(expression.expression) }
          }
        }
      } else if (ts.isCallExpression(node)) {
        const name = apiName(node.expression)
        if (name && factories.has(name) && node.arguments[0]) {
          const config = objectMap(node.arguments[0])
          const components = config?.get('components')
          if (components) { register(components) }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return {
    metadata: [...registrations.values()].filter(item => !conflicts.has(item.mdc_name)),
    dependencies: [...new Set([...configs, ...program.getSourceFiles().map(source => source.fileName)])],
    program,
    conflicts: [...conflicts],
    references: (parsed.projectReferences ?? []).map(reference => ts.resolveProjectReferencePath(reference))
  }
}

/** Solution-style configs retain each referenced project's own options and aliases. */
export async function analyzeReactProject (config: string, oldProgram?: TS.Program, oldProjects: Record<string, ReactAnalysis> = {}): Promise<ReactAnalysis> {
  const visited = new Set<string>()
  const projects: Record<string, ReactAnalysis> = {}
  async function visit (file: string, previous?: TS.Program): Promise<ReactAnalysis | undefined> {
    file = path.resolve(file)
    // Canonicalize only cycle identity; dependencies must keep the editor's logical paths.
    const identity = fs.existsSync(file) ? fs.realpathSync(file) : file
    if (visited.has(identity)) { return }
    visited.add(identity)
    const analysis = await analyzeSingleProject(file, previous ?? oldProjects[file]?.program)
    projects[file] = analysis
    for (const reference of analysis.references) { await visit(reference) }
    return analysis
  }
  const root = (await visit(config, oldProgram))!
  const metadata = new Map<string, MDCComponentData>()
  const conflicts = new Set<string>()
  for (const analysis of Object.values(projects)) {
    for (const name of analysis.conflicts) { conflicts.add(name) }
    for (const item of analysis.metadata) {
      const previous = metadata.get(item.mdc_name)
      if (previous && JSON.stringify(previous) !== JSON.stringify(item)) { conflicts.add(item.mdc_name) }
      else { metadata.set(item.mdc_name, item) }
    }
  }
  return {
    ...root,
    metadata: [...metadata.values()].filter(item => !conflicts.has(item.mdc_name)),
    conflicts: [...conflicts],
    dependencies: [...new Set(Object.values(projects).flatMap(analysis => analysis.dependencies))],
    projects
  }
}

const projects = new Map<string, { promise: Promise<ReactAnalysis>, stale: boolean, analysis?: ReactAnalysis }>()
export function getReactMetadata (config: string, force = false): Promise<ReactAnalysis> {
  const previous = projects.get(config)
  if (previous && !previous.stale && !force) { return previous.promise }
  const entry = {
    stale: false,
    analysis: previous?.analysis,
    promise: undefined as unknown as Promise<ReactAnalysis>
  }
  entry.promise = analyzeReactProject(config, previous?.analysis?.program, previous?.analysis?.projects)
    .then(analysis => {
      entry.analysis = analysis
      return analysis
    })
    .catch(error => {
      if (projects.get(config) === entry) { projects.delete(config) }
      throw error
    })
  projects.set(config, entry)
  return entry.promise
}
export function invalidateReactMetadata (file?: string): Set<string> {
  const affected = new Set<string>()
  for (const [config, project] of projects) {
    const dependency = file && project.analysis?.dependencies.some(dependency => path.normalize(dependency) === path.normalize(file))
    const relevant = !file || /\.(?:[mc]?[jt]sx?|json)$/.test(file) || dependency
    if (relevant && (!file || file.startsWith(path.dirname(config) + path.sep) || dependency)) {
      project.stale = true
      affected.add(config)
    }
  }
  return affected
}
