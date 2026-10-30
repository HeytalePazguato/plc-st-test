import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Parser, Language, type Tree, type Node } from 'web-tree-sitter'

export interface Diagnostic {
  file: string
  line: number
  col: number
  message: string
}

export interface ParsedFile {
  filePath: string
  source: string
  tree: Tree
  diagnostics: Diagnostic[]
}

let initPromise: Promise<void> | undefined
const languageCache = new Map<string, Promise<Language>>()

/**
 * Absolute path to the bundled base IEC 61131-3 ST grammar `.wasm`.
 */
export function baseGrammarPath(): string {
  const require = createRequire(import.meta.url)
  return require.resolve(
    'tree-sitter-iec61131-3-st/tree-sitter-iec61131_3_st.wasm',
  )
}

/**
 * Initialise web-tree-sitter (once) and load the grammar at `wasmPath`. Languages are cached per absolute path, so loading the same wasm twice yields the identical `Language` object.
 */
export function loadGrammar(wasmPath: string): Promise<Language> {
  const abs = resolve(wasmPath)
  let cached = languageCache.get(abs)
  if (cached === undefined) {
    cached = (async (): Promise<Language> => {
      initPromise ??= Parser.init()
      await initPromise
      return Language.load(new Uint8Array(readFileSync(abs)))
    })()
    languageCache.set(abs, cached)
    // Do not cache failures.
    cached.catch(() => languageCache.delete(abs))
  }
  return cached
}

/**
 * Parse Structured Text source synchronously with an already-loaded `language`.
 */
export function parseSource(
  language: Language,
  source: string,
  filePath: string,
): ParsedFile {
  const parser = new Parser()
  parser.setLanguage(language)
  const tree = parser.parse(source)
  if (tree === null) {
    throw new Error(`Failed to parse ${filePath}: parser returned no tree.`)
  }

  const diagnostics: Diagnostic[] = []
  collectDiagnostics(tree.rootNode, filePath, diagnostics)

  return { filePath, source, tree, diagnostics }
}

/**
 * Walk every node (including unnamed ERROR/MISSING nodes) collecting syntax diagnostics. Uses the raw children so error recovery nodes are seen.
 */
function collectDiagnostics(
  node: Node,
  file: string,
  diagnostics: Diagnostic[],
): void {
  if (node.isMissing) {
    diagnostics.push({
      file,
      line: node.startPosition.row + 1,
      col: node.startPosition.column + 1,
      message: `Missing ${node.type}`,
    })
  } else if (node.isError || node.type === 'ERROR') {
    diagnostics.push({
      file,
      line: node.startPosition.row + 1,
      col: node.startPosition.column + 1,
      message: `Syntax error near '${node.text}'`,
    })
  }
  for (const child of node.children) {
    collectDiagnostics(child, file, diagnostics)
  }
}

/**
 * Depth-first traversal visiting every named node exactly once. The visitor is called on `node` itself (when named) before recursing into its named children.
 */
export function walk(node: Node, visitor: (node: Node) => void): void {
  if (node.isNamed) {
    visitor(node)
  }
  for (const child of node.namedChildren) {
    walk(child, visitor)
  }
}
