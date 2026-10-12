/* eslint-disable no-template-curly-in-string */
import { kebabCase, camelCase } from 'scule'
import * as vscode from 'vscode'
import type { ComponentMeta } from 'vue-component-meta'
import type { Component } from '@nuxt/schema'
import { logger } from './logger'
import { getComponentYamlContext } from './utils/document'
import { getPropLiteralValues } from './utils/prop-literals'
import { isInsideYamlScalar, getYamlValuePosition, formatYamlLiteral } from './utils/yaml-props'
import { getAttributeContext, formatAttributeString, type AttributeContext } from './utils/attribute-props'

type MDCComponentMeta = Omit<Component, 'filePath' | 'shortPath'> & {
  meta: ComponentMeta
  mode?: string
  global?: boolean
  pascalName?: string
  kebabName?: string
  chunkName?: string
  fullPath?: string
  filePath?: string
  shortPath?: string
}

type MdcPropType = 'string' | 'number' | 'boolean' | 'array' | 'array-unquoted' | 'object'

export interface MDCComponentData {
  /** The kebab-case name of the component to be utilized in MDC. */
  mdc_name: string
  /** A description of the MDC component as well as suggested use-cases, etc. */
  description?: string
  /** Component documentation, provided via Markdown string. */
  documentation_markdown?: string
  /** The documentation URL for the component. */
  docs_url?: string
  /** MDC component meta */
  component_meta: MDCComponentMeta
}

interface MdcCompletionItemProviderConfig {
  document: vscode.TextDocument
  position: vscode.Position
}

/** Cache for storing model line content to avoid repeated getLinesContent() calls */
const lineContentCache = new WeakMap<vscode.TextDocument, string[]>()
/** Cache for storing prop name conversions between kebab-case and camelCase */
const propNameCache = new Map<string, { kebab: string, camel: string }>()
/** Cache for storing nested props by component name */
const nestedPropsCache = new Map<string, Map<string, Record<string, any> | null>>()
/** Cache for storing prop value types by component name */
const propTypeCache = new Map<string, Map<string, MdcPropType>>()
/** Cache for storing documentation links by component name */
const docsLinkCache = new Map<string, string>()
/** Cache for storing YAML block boundaries by model and line number */
const yamlBlockBoundaryCache = new WeakMap<vscode.TextDocument, Map<number, { start: number, end: number }>>()

/**
 * Retrieves the lines of content from a vscode document, using cache when available.
 *
 * @param {vscode.TextDocument} document - The VS Code text document
 * @returns {string[]} - Array of text lines from the document
 */
function getModelLines (document: vscode.TextDocument): string[] {
  let lines = lineContentCache.get(document)
  if (!lines) {
    lines = document.getText().split('\n')
    lineContentCache.set(document, lines)
  }
  return lines
}

/**
 * Invalidates all caches associated with a specific VS Code text document.
 * Should be called when the document content changes or when starting a new completion request.
 *
 * @param {vscode.TextDocument} document - The VS Code text document to invalidate caches for
 */
function invalidateLineCache (document: vscode.TextDocument): void {
  lineContentCache.delete(document)
  yamlBlockBoundaryCache.delete(document)
}

/**
 * Retrieves cached prop name conversions or generates new ones for a component's prop.
 *
 * @param {string} componentName - The MDC component name
 * @param {string} propName - The property name to convert
 * @returns {{ kebab: string; camel: string }} - Object containing both kebab-case and camelCase versions
 */
function getCachedPropNames (componentName: string, propName: string): { kebab: string, camel: string } {
  const cacheKey = `${componentName}:${propName}`
  let cached = propNameCache.get(cacheKey)
  if (!cached) {
    cached = {
      kebab: kebabCase(propName),
      camel: camelCase(propName)
    }
    propNameCache.set(cacheKey, cached)
  }
  return cached
}

/**
 * Retrieves nested props from a component's prop schema, using cache when available.
 *
 * @param {MDCComponentData} component - The MDC component
 * @param {any} prop - The prop to extract nested props from
 * @returns {Record<string, any> | null} - Object containing nested props or null if none exist
 */
function getNestedProps (component: MDCComponentData, prop: any): Record<string, any> | null {
  if (!component.mdc_name) { return null }

  let componentCache = nestedPropsCache.get(component.mdc_name)
  if (!componentCache) {
    componentCache = new Map()
    nestedPropsCache.set(component.mdc_name, componentCache)
  }

  const cacheKey = prop.name
  let cached = componentCache.get(cacheKey)
  if (cached === undefined) {
    if (!prop.schema?.schema) {
      cached = null
    } else {
      const objectSchema = Object.values(prop.schema.schema).find((s: any) => typeof s === 'object' && s?.kind === 'object')
      cached = objectSchema ? (objectSchema as { kind: string, type: string, schema: Record<string, any> }).schema : null
    }
    componentCache.set(cacheKey, cached)
  }
  return cached
}

/**
 * Determines the value type of a prop, using cache when available.
 *
 * @param {MDCComponentData} component - The MDC component
 * @param {any} prop - The prop to determine the type for
 * @returns {MdcPropType} - The determined prop value type
 */
function getPropValueType (component: MDCComponentData, prop: any): MdcPropType {
  if (!component.mdc_name) { return 'string' }

  let componentCache = propTypeCache.get(component.mdc_name)
  if (!componentCache) {
    componentCache = new Map()
    propTypeCache.set(component.mdc_name, componentCache)
  }

  const cacheKey = prop.name
  let propType = componentCache.get(cacheKey)
  if (!propType) {
    if (prop.type?.includes('Record<') || prop.type?.toLowerCase()?.includes('object') || prop.type?.includes('Array<string,')) {
      return 'object'
    } else if (prop.type?.includes('string[]') || prop.type?.includes('Array<string')) {
      propType = 'array'
    } else if (prop.type?.includes('number[]') || prop.type?.includes('Array<number') || prop.type?.includes('Array<boolean')) {
      propType = 'array-unquoted'
    } else if (prop.type?.includes('boolean')) {
      propType = 'boolean'
    } else if (prop.type?.includes('number')) {
      propType = 'number'
    } else if (prop.type?.includes('string')) {
      propType = 'string'
    } else if ((prop.schema as Record<string, any> | undefined)?.schema && Object.values((prop.schema as Record<string, any> | undefined)?.schema).some((s: any) => typeof s === 'object' && s?.kind === 'object')) {
      propType = 'object'
    } else {
      propType = 'string'
    }
    componentCache.set(cacheKey, propType)
  }
  return propType
}

/**
 * Determines if the current position is inside a YAML block.
 *
 * @param {vscode.TextDocument} document - The VS Code text document.
 * @param {number} lineNumber - The 1-based line number of the current cursor position.
 * @returns {boolean} - True if inside a YAML block, false otherwise.
 */
function isInsideYAMLBlock (document: vscode.TextDocument, lineNumber: number): boolean {
  const lines = getModelLines(document)
  let insideYAMLBlock = false

  for (let i = 0; i < lineNumber; i++) {
    const line = lines?.[i]?.trim()
    if (!line) {
      continue
    }
    // Toggle insideYAMLBlock flag when encountering YAML block delimiters (---)
    if (/^\s*---\s*$/.test(line)) {
      insideYAMLBlock = !insideYAMLBlock
    }
  }

  // Return true if inside a YAML block
  return insideYAMLBlock
}

/**
 * Determines if the current position is inside a markdown code block.
 *
 * @param {vscode.TextDocument} document - The VS Code text document.
 * @param {number} lineNumber - The 1-based line number of the current cursor position.
 * @returns {boolean} - True if inside a markdown code block, false otherwise.
 */
function isInsideCodeBlock (document: vscode.TextDocument, lineNumber: number): boolean {
  const lines = getModelLines(document)
  let insideCodeBlock = false

  for (let i = 0; i < lineNumber; i++) {
    const line = lines?.[i]?.trim()
    if (!line) {
      continue
    }
    // Toggle insideCodeBlock flag when encountering a code block delimiter (``` or ~~~)
    if (/^\s*(?:`{3,}|~{3,})/.test(line)) {
      insideCodeBlock = !insideCodeBlock
    }
  }

  // Return true if inside a markdown code block
  return insideCodeBlock
}

/**
 * Generates a string representing slot content.
 */
function getSlotContent (cursorIndex?: number): string {
  const placeholderText = '<!-- Slot content -->'
  // Two spaces before the content to auto-indent
  return typeof cursorIndex === 'number' ? '\n${' + cursorIndex + ':' + placeholderText + '}' : `\n${placeholderText}`
}

/**
 * Gets the documentation link for a component, using cache when available.
 *
 * @param {MDCComponentData | undefined} component - The MDC component
 * @returns {string} - Markdown formatted documentation link or empty string
 */
function getComponentDocsLink (component?: MDCComponentData): string {
  if (!component?.mdc_name) { return '' }

  let cached = docsLinkCache.get(component.mdc_name)
  if (cached === undefined) {
    cached = (!component.docs_url)
      ? ''
      : `[View the '${component.mdc_name}' docs ↗](${component.docs_url})`
    docsLinkCache.set(component.mdc_name, cached)
  }

  return cached
}

/**
 * Gets the boundaries of a YAML block at a specific line, using cache when available.
 *
 * @param {vscode.TextDocument} document - The VS Code text document
 * @param {number} lineNumber - The 1-based line number to get YAML block boundaries for
 * @returns {{ start: number; end: number } | undefined} - Object containing block boundaries or undefined if not in a YAML block
 */
function getYAMLBlockBoundaries (document: vscode.TextDocument, lineNumber: number): { start: number, end: number } | undefined {
  let documentCache = yamlBlockBoundaryCache.get(document)
  if (!documentCache) {
    documentCache = new Map()
    yamlBlockBoundaryCache.set(document, documentCache)
  }
  let boundaries = documentCache.get(lineNumber)
  if (!boundaries) {
    const context = getComponentYamlContext(getModelLines(document), lineNumber)
    if (context) {
      boundaries = { start: context.start, end: context.end }
      documentCache.set(lineNumber, boundaries)
    }
  }
  return boundaries
}

/**
 * Get the current YAML path based on indentation levels and MDC component context
 */
function getCurrentYAMLPath (document: vscode.TextDocument, lineNumber: number): string[] {
  const lines = getModelLines(document)
  const path: string[] = []

  // Handle case where we're at line start
  if (lineNumber <= 0 || lineNumber > lines.length) { return path }

  // Get current line, do **not** need to subtract 1
  const currentLine = lines[lineNumber]
  const currentIndentation = currentLine.length - currentLine.trimStart().length

  const boundaries = getYAMLBlockBoundaries(document, lineNumber)
  if (!boundaries) { return path }

  let lastIndentation = currentIndentation
  // Scan backwards to find parent prop
  for (let i = lineNumber - 1; i >= boundaries.start; i--) {
    const line = lines[i]
    const lineIndentation = line.length - line.trimStart().length
    const trimmedLine = line.trim()

    // Skip empty lines, YAML block markers, or lines beyond the block end
    if (!trimmedLine || trimmedLine === '---' || i > boundaries.end) { continue }

    // A line is a potential parent if:
    // 1. It ends with a colon (allowing for whitespace)
    // 2. It has less indentation than current line
    const isParentProp = trimmedLine.match(/:\s*$/) && lineIndentation < lastIndentation

    if (isParentProp) {
      const propMatch = trimmedLine.match(/^([\w-]+):/)?.[1]
      if (propMatch) {
        path.unshift(propMatch)
        lastIndentation = lineIndentation
      }
    }
  }

  return path
}

/**
 * Get existing props from the current YAML block
 */
function getCurrentYAMLBlockProps (document: vscode.TextDocument, lineNumber: number): Set<string> {
  const lines = getModelLines(document)
  const existingProps = new Set<string>()
  const currentIndentation = lines[lineNumber].length - lines[lineNumber].trimStart().length

  const boundaries = getYAMLBlockBoundaries(document, lineNumber)
  if (!boundaries) { return existingProps }

  // Extract props at the same indentation level from the current YAML block
  for (let i = boundaries.start + 1; i < boundaries.end; i++) {
    if (i === lineNumber) { continue }
    const line = lines[i]
    const lineIndentation = line.length - line.trimStart().length

    // Only process lines at the same indentation level as the cursor
    if (lineIndentation === currentIndentation) {
      const match = line.trim().match(/^([\w-]+):/)
      if (match) {
        const propName = match[1]
        existingProps.add(kebabCase(propName))
        existingProps.add(camelCase(propName))
      }
    }
  }

  return existingProps
}

/**
 * Computes the VS Code completion replacement range for a kebab-case name token.
 *
 * `getWordRangeAtPosition` treats `-` as a word separator and returns only the segment
 * after the last hyphen, which breaks fuzzy filtering (VS Code sees too narrow a prefix)
 * and replacement (only the last segment is overwritten, leaving a prefix on the line).
 * This anchors the range start after the given leading prefix and extends the end through
 * any trailing `[a-zA-Z-]` characters past the cursor for correct mid-word behavior.
 *
 * @param lineContent - Full text of the current line
 * @param position - Current cursor position
 * @param prefixPattern - Regex matching the leading characters to exclude from the range (e.g. colons, whitespace)
 * @returns `vscode.Range` suitable for a `CompletionItem.range`
 */
function getKebabNameRange (
  lineContent: string,
  position: vscode.Position,
  prefixPattern: RegExp,
): vscode.Range {
  const prefixMatch = lineContent.match(prefixPattern)
  const startChar = prefixMatch ? prefixMatch[0].length : 0
  let endChar = position.character
  while (endChar < lineContent.length && /[a-zA-Z-]/.test(lineContent[endChar])) {
    endChar++
  }
  return new vscode.Range(
    new vscode.Position(position.line, startChar),
    new vscode.Position(position.line, endChar),
  )
}

/**
 * Generate the VS Code completion item provider for MDC components.
 *
 * @param {MDCComponentData[]} componentData - The MDC component data
 * @param {MdcCompletionItemProviderConfig} { document, position }
 * @return {*}  {(vscode.CompletionItem[] | undefined)}
 */
export function getMdcComponentCompletionItemProvider (componentData: MDCComponentData[] = [], { document, position }: MdcCompletionItemProviderConfig): vscode.CompletionItem[] | undefined {
  // Get the text until the current cursor position
  const lineContent = document.lineAt(position.line).text
  const textUntilPosition = lineContent.slice(0, position.character)

  /**
   * Define basic pattern to identify MDC component usage,
   * meaning a line that starts with a colon or double colon.
   *
   * Example: `:` or `::` - it will then suggest MDC component names.
   */
  const mdcPattern = /^\s*:{1,}[a-zA-Z-]{0,}\s*$/

  // If conditions not met, exit early
  if (
    !mdcPattern.test(textUntilPosition) || // If it doesn't match the syntax
    componentData.length === 0 || // If there is no component data
    isInsideYAMLBlock(document, position.line) || // If inside a YAML block
    isInsideCodeBlock(document, position.line) // If inside a code block
  ) {
    return
  }

  // Count the number of `:` colon characters in the input text in order to properly match in the output
  const colonCharacterCount = (textUntilPosition.match(/:/g) || []).length
  // Ensure there is always a minimum of 2 colons
  const blockSeparator = ':'.repeat(Math.max(2, colonCharacterCount))

  // If the line immediately below is already a YAML block opener, the full block scaffold
  // (props + slot + closing ::) is already present — only replace the component name.
  const hasExistingBlock = position.line + 1 < document.lineCount
    && document.lineAt(position.line + 1).text.trim() === '---'

  function getMdcComponentInsertText ({ name, contentPlaceholder = '' }: {
    /** The MDC component name */
    name: string
    contentPlaceholder?: string
  }) {
    const componentName = kebabCase(name)
    const prefix = colonCharacterCount === 1 ? ':' : ''
    if (hasExistingBlock) {
      return `${prefix}${componentName}`
    }
    const propsPlaceholder = '\n---${1:}\n---'
    return `${prefix}${componentName}${propsPlaceholder}${contentPlaceholder}\n${blockSeparator}\n`
  }

  // Create a Map to store unique suggestions
  const uniqueSuggestions = new Map<string, vscode.CompletionItem>()

  // Loop through the component data and generate suggestions
  for (const component of componentData) {
    if (!!component.mdc_name && !uniqueSuggestions.has(component.mdc_name)) {
      const docsMarkdownLink = getComponentDocsLink(component)
      const documentationMarkdown = component.documentation_markdown ? component.documentation_markdown : component.docs_url ? docsMarkdownLink : undefined

      uniqueSuggestions.set(component.mdc_name, {
        label: component.mdc_name,
        kind: vscode.CompletionItemKind.Function,
        range: getKebabNameRange(lineContent, position, /^\s*:+/),
        insertText: new vscode.SnippetString(getMdcComponentInsertText({
          name: component.mdc_name,
          // Conditionally render the default slot content placeholder if the component has slots
          contentPlaceholder: component.component_meta?.meta?.slots?.length ? getSlotContent(2) : ''
        })),
        detail: component.description,
        documentation: documentationMarkdown
          ? new vscode.MarkdownString(documentationMarkdown)
          : undefined,
        // Skip formatting when renaming an existing block — no structural change was made.
        command: hasExistingBlock ? undefined : {
          command: 'editor.action.formatDocument',
          title: 'Format Document'
        }
      })
    }
  }

  // Create an array of unique suggestions from the Map
  const suggestions = Array.from(uniqueSuggestions.values())

  return suggestions
}

/**
 * Generate the VS Code completion item provider for MDC component props.
 *
 * @param {MDCComponentData[]} componentData - The MDC component data
 * @param {MdcCompletionItemProviderConfig} { document, position }: MdcCompletionItemProviderConfig
 * @return {*}  {(vscode.CompletionItem[] | undefined)}
 */
export function getMdcComponentPropCompletionItemProvider (componentData: MDCComponentData[] = [], { document, position }: MdcCompletionItemProviderConfig): vscode.CompletionItem[] | undefined {
  // Invalidate cache at the start of a new completion request
  invalidateLineCache(document)
  // Get the text until the current cursor position
  const lineContent = document.lineAt(position.line).text
  const textUntilPosition = lineContent.slice(0, position.character)

  const lines = getModelLines(document)
  const attributes = getAttributeContext(lines, position.line, position.character)
  if (attributes) {
    return getAttributePropCompletions(componentData, attributes, lineContent, position)
  }
  const context = getComponentYamlContext(lines, position.line)
  if (!context || isInsideYamlScalar(lines, position.line, context.start)) { return }

  const currentMdcBlockName = context.component
  const mdcComponent = componentData.find(c => c.mdc_name === currentMdcBlockName)
  if (!mdcComponent?.component_meta?.meta?.props) { return }
  const docsMarkdownLink = getComponentDocsLink(mdcComponent)
  const currentYAMLPath = getCurrentYAMLPath(document, position.line)
  const valuePosition = getYamlValuePosition(lineContent, position.character)

  if (valuePosition) {
    // Value completion handles top-level scalar props only.
    const indent = lineContent.length - lineContent.trimStart().length
    if (currentYAMLPath.length || indent !== context.indent) { return }
    const prop = mdcComponent.component_meta.meta.props.find(p =>
      p.name === valuePosition.prop || kebabCase(p.name) === valuePosition.prop || camelCase(p.name) === valuePosition.prop
    )
    if (!prop) { return }
    return getPropLiteralValues(prop).map(value => ({
      label: typeof value === 'string' ? JSON.stringify(value) : String(value),
      kind: vscode.CompletionItemKind.EnumMember,
      detail: prop.type,
      documentation: new vscode.MarkdownString([prop.description, docsMarkdownLink].filter(Boolean).join('\n\n')),
      filterText: valuePosition.quote ? valuePosition.quote + String(value) : String(value),
      insertText: (lineContent[valuePosition.start - 1] === ':' ? ' ' : '') + formatYamlLiteral(value, valuePosition.quote),
      range: new vscode.Range(position.line, valuePosition.start, position.line, valuePosition.end)
    }))
  }

  // Preserve the existing property-name provider and its nested-schema behavior.
  if (!/^\s*[a-zA-Z-]*$/.test(textUntilPosition)) { return }

  const suggestionsByComponent = new Map<string, vscode.CompletionItem[]>()
  suggestionsByComponent.set(currentMdcBlockName, [])

  // Get either top-level props or nested props based on YAML path
  let propsToSuggest: any[] = []
  if (currentYAMLPath.length > 0) {
    // Find the parent prop
    const parentProp = mdcComponent.component_meta.meta.props.find(p =>
      kebabCase(p.name) === currentYAMLPath[0]
    )

    if (parentProp) {
      const nestedProps = getNestedProps(mdcComponent, parentProp)
      if (nestedProps) {
        // Convert nested props schema to array format
        propsToSuggest = Object.entries(nestedProps).map(([name, schema]) => ({
          name,
          ...(schema as object)
        }))
      }
    }
  } else {
    // Use top-level props
    propsToSuggest = mdcComponent.component_meta.meta.props
  }

  const existingProps = getCurrentYAMLBlockProps(document, position.line)
  const editingExistingKey = /^\s*[\w-]+\s*:/.test(lineContent)

  for (const prop of propsToSuggest) {
    const { kebab: propNameKebab, camel: propNameCamel } = getCachedPropNames(currentMdcBlockName, prop.name)

    // Skip existing props
    if (existingProps.has(propNameKebab) || existingProps.has(propNameCamel)) { continue }

    // Determine the prop value type
    const propValueType = getPropValueType(mdcComponent, prop)

    function getPropInsertText (name: string, type: string) {
      if (prop.name === 'styles') {
        // Special handling for the `styles` prop since it's always a multiline string
        return `${name}: |\n` + '  ${0:/** Add CSS */}'
      } else if (type === 'boolean') {
        return `${name}: ` + '${0:true}'
      } else if (type === 'number') {
        return `${name}: ` + '${0:}'
      } else if (type === 'array') {
        return `${name}: ` + '["${0:}"]'
      } else if (type === 'array-unquoted') {
        return `${name}: ` + '[${0:}]'
      } else if (type === 'string') {
        return `${name}: ` + '"${0:}"'
      } else {
        // Object
        return `${name}: ` + '\n  ${0:}'
      }
    }

    suggestionsByComponent.get(currentMdcBlockName)!.push({
      // @ts-ignore - This satisfies the `CompletionItemLabel` interface: https://code.visualstudio.com/api/references/vscode-api#CompletionItemLabel
      label: {
        label: propNameKebab,
        description: prop.type?.replace('| undefined', '').replace('| null', ''), // Shows up as gray text next to the label
        detail: prop.required ? ' (required)' : undefined // Shows up as dimmed text after description
      },
      filterText: `${propNameKebab} ${propNameCamel}`,
      sortText: prop.required ? '_' + propNameKebab : propNameKebab, // Force "required" props to the top
      kind: vscode.CompletionItemKind.Property,
      range: getKebabNameRange(lineContent, position, /^\s*/),
      insertText: new vscode.SnippetString(editingExistingKey ? propNameKebab : getPropInsertText(propNameKebab, propValueType)), // Always insert kebab-case
      detail: prop.description, // Shows up in the details section of the completion item
      documentation: new vscode.MarkdownString(docsMarkdownLink),
      command: {
        command: 'editor.action.triggerSuggest',
        title: 'Trigger Suggestions'
      }
    })
  }

  return Array.from(suggestionsByComponent.values()).flat()
}

function getAttributePropCompletions (
  componentData: MDCComponentData[],
  context: AttributeContext,
  line: string,
  position: vscode.Position
): vscode.CompletionItem[] | undefined {
  const component = componentData.find(component => component.mdc_name === context.component)
  const props = component?.component_meta?.meta?.props
  if (!props) { return }
  const range = new vscode.Range(position.line, context.start, position.line, context.end)
  const docs = getComponentDocsLink(component)
  if (context.mode === 'value') {
    // Bound expressions and typed literals are distinct from plain string attributes.
    if (context.bound) { return }
    const prop = props.find(prop => prop.name === context.prop || kebabCase(prop.name) === context.prop || camelCase(prop.name) === context.prop)
    if (!prop) { return }
    return getPropLiteralValues(prop).filter((value): value is string => typeof value === 'string').flatMap(value => {
      const insertText = formatAttributeString(value, context.quote)
      if (insertText === undefined) { return [] }
      return [{
        label: JSON.stringify(value),
        kind: vscode.CompletionItemKind.EnumMember,
        range,
        filterText: context.quote ? context.quote + value : value,
        insertText,
        detail: prop.type,
        documentation: new vscode.MarkdownString([prop.description, docs].filter(Boolean).join('\n\n'))
      }]
    })
  }

  const existing = new Set(context.existing.flatMap(name => [kebabCase(name), camelCase(name)]))
  return props.filter(prop => !existing.has(kebabCase(prop.name)) && !existing.has(camelCase(prop.name))).map((prop): vscode.CompletionItem => {
    const { kebab, camel } = getCachedPropNames(context.component, prop.name)
    const values = getPropLiteralValues(prop)
    const boolean = values.includes(true) && values.every(value => typeof value === 'boolean')
    const string = (values.length > 0 && values.every(value => typeof value === 'string'))
      || prop.schema === 'string' || /^string(?:\s*\|\s*(?:undefined|null))*$/.test(prop.type ?? '')
    const snippetName = kebab.replace(/[\\$}]/g, '\\$&')
    let insert = snippetName
    if (!context.hasValue && !boolean) {
      // Non-string props get an explicit binding snippet, never a quoted numeric/boolean value.
      insert = (!string && !context.bound ? ':' : '') + snippetName + '="${0:}"'
    }
    if (!context.prop && context.start > 0 && !/[\s{:]/.test(line[context.start - 1])) { insert = ' ' + insert }
    return {
      // @ts-ignore - CompletionItemLabel is available since VS Code 1.75, but these typings predate it.
      label: { label: kebab, description: prop.type?.replace('| undefined', '').replace('| null', ''), detail: prop.required ? ' (required)' : undefined },
      kind: vscode.CompletionItemKind.Property,
      range,
      filterText: `${kebab} ${camel}`,
      sortText: prop.required ? '_' + kebab : kebab,
      insertText: new vscode.SnippetString(insert),
      detail: prop.description,
      documentation: new vscode.MarkdownString(docs),
      command: { command: 'editor.action.triggerSuggest', title: 'Trigger Suggestions' }
    }
  })
}

/**
 * Creates document lifecycle listeners to manage cache cleanup
 */
export function createCacheCleanupListeners (): vscode.Disposable {
  const watchedDocuments = new Set<string>()

  /**
   * Check if the document is a markdown or MDC file by checking both extension and language ID
   */
  function isMarkdownOrMDCDocument (document: vscode.TextDocument): boolean {
    const extension = document.uri.fsPath.toLowerCase()
    const isMDCOrMDFile = extension.endsWith('.mdc') || extension.endsWith('.md')
    const isMDCOrMDLanguage = document.languageId === 'mdc' || document.languageId === 'markdown'
    return isMDCOrMDFile || isMDCOrMDLanguage
  }

  const disposable = vscode.Disposable.from(
    // Listen for document close events
    vscode.workspace.onDidCloseTextDocument((document) => {
      if (!isMarkdownOrMDCDocument(document)) { return }

      const uri = document.uri.toString()
      if (watchedDocuments.has(uri)) {
        cleanupDocumentCaches(document)
        watchedDocuments.delete(uri)
      }
    }),

    // Listen for document open events
    vscode.workspace.onDidOpenTextDocument((document) => {
      if (!isMarkdownOrMDCDocument(document)) { return }

      watchedDocuments.add(document.uri.toString())
    })
  )

  // Return disposable that cleans up everything
  return {
    dispose: () => {
      disposable.dispose()
      // Clean up any remaining caches
      propNameCache.clear()
      nestedPropsCache.clear()
      propTypeCache.clear()
      docsLinkCache.clear()
      watchedDocuments.clear()
    }
  }
}

/**
 * Cleans up all caches associated with a document
 */
function cleanupDocumentCaches (document: vscode.TextDocument): void {
  logger('Clean up caches for document: ' + document.uri.toString())
  // Clear document-specific caches
  lineContentCache.delete(document)
  yamlBlockBoundaryCache.delete(document)

  // Clear component-related caches if this is the last document
  if (vscode.workspace.textDocuments.length <= 1) {
    logger('Clean up component-related caches')
    propNameCache.clear()
    nestedPropsCache.clear()
    propTypeCache.clear()
    docsLinkCache.clear()
  }
}
