import * as vscode from 'vscode'
import { kebabCase } from 'scule'
import type { MDCComponentData } from './completion-providers'
import { logger } from './logger'
import * as path from 'node:path'
import { findReactConfig, getReactMetadata, invalidateReactMetadata } from './utils/react/metadata'
import { clearCompletionMetadataCaches } from './completion-providers'

interface MetadataCache {
  metadata: MDCComponentData[] | null
  lastFile: string | null
  lastFetch: number
  generation: number
  folder?: vscode.WorkspaceFolder
  project?: string
  source?: 'url' | 'local' | 'react'
  pending?: Promise<MDCComponentData[] | null>
}
const scopes = new Map<string, MetadataCache>()
const DEFAULT_CACHE_TTL_MINUTES = 30 // 30 minutes

/**
 * Fetches metadata from a specified URL with optional force parameter.
 *
 * @param {string} url - The URL endpoint to fetch metadata from
 * @param {boolean} force - When true, displays VS Code information messages during fetch process. Defaults to false.
 * @returns A Promise that resolves to the fetched metadata object, or null if the fetch fails
 * @throws Will throw an error if the fetch response is not ok
 */
async function fetchRemoteComponentMetadata (url: string, force = false, resource?: vscode.Uri): Promise<MDCComponentData[] | null> {
  try {
    logger(`Fetching MDC component metadata from: ${url}`)
    vscode.window.showInformationMessage(`MDC: Fetching component metadata from: ${url}`)

    const response = await fetch(url)

    if (!response.ok) {
      throw new Error(`Failed to fetch MDC component metadata: ${response.statusText}`)
    }

    // Convert response to Uint8Array for consistency with file processing
    const data = new Uint8Array(await response.arrayBuffer())
    const metadata = processMetadataFile({
      metadataContent: data,
      filePath: url,
      force,
      source: 'remote',
      resource
    })

    if (metadata) {
      const message = `MDC: Component metadata fetched successfully (${metadata.length} components found).`
      vscode.window.showInformationMessage(message)
      const config = vscode.workspace.getConfiguration('mdc', resource)
      if (config.get('debug')) {
        logger(message)
      }
    }

    return metadata
  } catch (error: any) {
    const errorMessage = `MDC: ${error.message}`
    logger(errorMessage, 'error')
    vscode.window.showErrorMessage(errorMessage)
    return null
  }
}

interface ProcessMetadataOptions {
  /** The raw content of the metadata file */
  metadataContent: Uint8Array
  /** The path or URL of the metadata file being processed */
  filePath: string
  /** When true, displays VS Code information messages during processing */
  force?: boolean
  /** Indicates whether the content is from a local file or remote URL */
  source?: 'remote' | 'local'
  resource?: vscode.Uri
}

/**
 * Processes a metadata file containing MDC component information.
 *
 * @param {ProcessMetadataOptions} options - Configuration options for processing metadata
 * @returns {MDCComponentData[]} An array of MDCComponentData objects sorted by component name, or null if processing fails.
 *
 * @description
 * This function performs the following steps:
 * 1. Decodes the file content from Uint8Array to text
 * 2. Extracts the default export object using regex
 * 3. Parses the JSON content
 * 4. Creates a map of component metadata, converting component names to kebab-case
 * 5. Sorts the components by name
 */
const processMetadataFile = ({
  metadataContent,
  filePath,
  source = 'local',
  force = false,
  resource
}: ProcessMetadataOptions): MDCComponentData[] | null => {
  const config = vscode.workspace.getConfiguration('mdc', resource)
  const textContent = new TextDecoder().decode(metadataContent)

  logger(`Processing ${source} metadata from: ${filePath}`)

  // Try parsing as direct JSON first
  try {
    const directContent = JSON.parse(textContent)
    if (Array.isArray(directContent) &&
      directContent.length > 0 &&
      'mdc_name' in directContent[0] &&
      'component_meta' in directContent[0] &&
      'meta' in directContent[0].component_meta) {
      const config = vscode.workspace.getConfiguration('mdc', resource)
      if (config.get('debug')) {
        logger(`${directContent.length} components found (no data transformation needed).`)
      }
      return directContent
    }

    // If we got here, the JSON was valid but needs transformation
    logger('Valid JSON found, attempting data transformation...')

    // Try transforming the JSON content
    const componentsMap = new Map<string, MDCComponentData>()
    Object.values(directContent).forEach((componentMeta: any) => {
      const kebabCaseName = kebabCase(componentMeta.kebabName || componentMeta.pascalName)
      if (!componentsMap.has(kebabCaseName)) {
        componentsMap.set(kebabCaseName, {
          mdc_name: kebabCaseName,
          component_meta: componentMeta
        })
      }
    })

    // Sort the array of component metadata entries based on mdc_name.
    const metadata = Array.from(componentsMap.values()).sort((a, b) => a.mdc_name.localeCompare(b.mdc_name))

    if (config.get('debug')) {
      logger(`${metadata?.length} components found (transformed data format).`)
    }

    return metadata
  } catch {
    // JSON parse failed, if this is a local file, try export pattern
    if (source === 'local') {
      logger('Direct JSON parse failed, checking for export pattern...')

      const match = textContent.match(/export\s+default\s+([{[][\s\S]*?\n[}\]])/m)
      if (match?.[1]) {
        try {
          return processMetadataFile({
            metadataContent: new TextEncoder().encode(match[1]),
            filePath,
            force,
            source: 'remote', // Treat exported content as if it were remote JSON
            resource
          })
        } catch {
          logger('Export pattern processing failed.', 'error')
        }
      }
    }
  }

  logger(`Unable to process ${source} metadata content from: ${filePath}`, 'error')
  return null
}

/**
 * Attempts to find and load local component metadata from `.nuxt/component-meta.mjs` files in the current workspace or its subdirectories.
 */
async function fetchLocalComponentMetadata (entry: MetadataCache, force = false, resource?: vscode.Uri): Promise<MDCComponentData[] | null> {
  const config = vscode.workspace.getConfiguration('mdc', resource)
  const metadataFilePattern = config.get<string>('componentMetadataLocalFilePattern', '**/.nuxt/component-meta.mjs')
  const metadataExcludeDirectoriesPattern = config.get<string>('componentMetadataLocalExcludePattern', '{**/node_modules/**,**/dist/**,**/.output/**,**/.cache/**,**/.playground/**}')

  try {
    const folder = entry.folder
    if (!folder) {
      logger('No workspace folders found.')
      return null
    }

    // If we have a cached file path and this isn't a force refresh, try it first
    if (!force && entry.lastFile) {
      try {
        const fileContent = await vscode.workspace.fs.readFile(vscode.Uri.file(entry.lastFile))
        const metadata = processMetadataFile({
          metadataContent: fileContent,
          filePath: entry.lastFile,
          force,
          source: 'local',
          resource
        })
        if (metadata) {
          return metadata
        }
        // If processing failed, clear the cache and continue with full search
        entry.lastFile = null
      } catch (error: any) {
        logger(`Cached file no longer accessible: ${error.message}`)
        entry.lastFile = null
      }
    }

    // Full file search if needed
    const sourceFilePattern = new vscode.RelativePattern(folder, metadataFilePattern)
    // Find files, excluding the provided directory patterns
    const files = await vscode.workspace.findFiles(sourceFilePattern, metadataExcludeDirectoriesPattern)
    if (!files.length) {
      logger('No files found.')
      return null
    }

    // Try each file until we find valid metadata
    for (const file of files) {
      logger(`Attempting to read metadata file: ${file.fsPath}`)
      try {
        const fileContent = await vscode.workspace.fs.readFile(file)
        const metadata = processMetadataFile({
          metadataContent: fileContent,
          filePath: file.fsPath,
          force,
          source: 'local',
          resource
        })
        if (metadata) {
          entry.lastFile = file.fsPath
          return metadata
        }
      } catch (parseError) {
        logger(`Error parsing metadata from ${file.fsPath}: ${parseError}`, 'error')
        continue
      }
    }

    logger('No valid metadata found in available sources.')
    return null
  } catch (error: any) {
    logger(`Error loading local metadata: ${error.message}`, 'error')
    return null
  }
}

/** Load document-scoped URL/local metadata, falling back to React discovery, with coalesced caching. */
export async function getComponentMetadata (force = false, resource?: vscode.Uri): Promise<MDCComponentData[] | null> {
  const folders = vscode.workspace.workspaceFolders ?? []
  const document = resource ?? vscode.window.activeTextEditor?.document.uri
  const folder = document?.scheme === 'file' ? vscode.workspace.getWorkspaceFolder(document) : folders.length === 1 ? folders[0] : undefined
  const scopedResource = document?.scheme === 'file' ? document : folder?.uri
  const config = vscode.workspace.getConfiguration('mdc', scopedResource)
  if (!config.get<boolean>('enableComponentMetadataCompletions', false)) { return null }
  const project = folder && findReactConfig(document?.scheme === 'file' ? document.fsPath : folder.uri.fsPath, folder.uri.fsPath)
  const url = config.get<string>('componentMetadataURL')
  const key = JSON.stringify([folder?.uri.toString(), project, url, config.get('componentMetadataLocalFilePattern'), config.get('componentMetadataLocalExcludePattern')])
  let entry = scopes.get(key)
  if (!entry) {
    entry = { metadata: null, lastFile: null, lastFetch: 0, generation: 0, folder, project }
    scopes.set(key, entry)
  }
  if (force) { invalidateEntry(entry); invalidateReactMetadata(project); clearCompletionMetadataCaches() }
  const ttl = 60 * 1000 * Number(config.get('componentMetadataCacheTTL') || DEFAULT_CACHE_TTL_MINUTES)
  if (entry.pending) { return entry.pending }
  if (entry.lastFetch && Date.now() - entry.lastFetch < ttl) { return entry.metadata }
  const current = entry
  const generation = entry.generation
  entry.pending = (async () => {
    let metadata: MDCComponentData[] | null = null
    if (url) {
      current.source = 'url'
      metadata = await fetchRemoteComponentMetadata(url, force, scopedResource)
    } else {
      current.source = 'local'
      metadata = await fetchLocalComponentMetadata(current, force, scopedResource)
      if (!metadata && project) {
        current.source = 'react'
        try {
          const started = Date.now()
          metadata = (await getReactMetadata(project, force)).metadata
          logger(`React metadata: ${metadata.length} components (${Date.now() - started}ms).`)
        } catch (error) { logger(`React metadata discovery failed: ${String(error)}`, 'error') }
      }
    }
    if (current.generation === generation) {
      current.metadata = metadata
      current.lastFetch = Date.now()
    }
    return metadata
  })().finally(() => { if (current.generation === generation) { current.pending = undefined } })
  return entry.pending
}

function invalidateEntry (entry: MetadataCache): void {
  entry.generation++
  entry.metadata = null
  entry.lastFetch = 0
  entry.pending = undefined
}

/** Saved sources and config/metadata files invalidate only their relevant cached scopes. */
export function registerMetadataWatchers (): vscode.Disposable {
  function invalidate (uri?: vscode.Uri) {
    const file = uri && path.normalize(uri.fsPath)
    const guarded = uri && vscode.workspace.getWorkspaceFolder(uri)
    const relative = file && guarded ? path.relative(guarded.uri.fsPath, file) : file
    if (guarded && relative && /(?:^|[\\/])(?:node_modules|\.next|\.git|out|out-test|\.vscode-test)(?:[\\/]|$)/.test(relative)) { return }
    const supplied = file && [...scopes.values()].some(entry => entry.lastFile === file)
    const affected = invalidateReactMetadata(file)
    if (file && !supplied && !affected.size && !/\.(?:[mc]?[jt]sx?|json)$/.test(file)) { return }
    for (const entry of scopes.values()) {
      if (!file || (entry.source !== 'url' && (entry.lastFile === file || entry.project && affected.has(entry.project) || entry.folder && file.startsWith(entry.folder.uri.fsPath + path.sep)))) {
        invalidateEntry(entry)
      }
    }
    clearCompletionMetadataCaches()
  }
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs,json}')
  return vscode.Disposable.from(watcher,
    watcher.onDidChange(invalidate), watcher.onDidCreate(invalidate), watcher.onDidDelete(invalidate),
    vscode.workspace.onDidSaveTextDocument(document => invalidate(document.uri)),
    vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('mdc')) { invalidate() } }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { scopes.clear(); invalidateReactMetadata(); clearCompletionMetadataCaches() })
  )
}
