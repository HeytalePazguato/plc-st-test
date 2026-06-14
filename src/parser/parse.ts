import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
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
let language: Language | undefined

/**
 * Initialise web-tree-sitter and load the IEC 61131-3 ST grammar.
 * Idempotent: the underlying work runs at most once; repeated calls return
 * the same cached promise.
 */
export async function initParser(): Promise<void> {
  if (initPromise === undefined) {
    initPromise = (async (): Promise<void> => {
      await Parser.init()
      const require = createRequire(import.meta.url)
      const wasmPath = require.resolve(
        'tree-sitter-iec61131-3-st/tree-sitter-iec61131_3_st.wasm',
      )
      const bytes = new Uint8Array(readFileSync(wasmPath))
      language = await Language.load(bytes)
    })()
  }
  return initPromise
}

/**
 * Parse Structured Text source synchronously. `initParser()` must have been
 * awaited first; otherwise an Error is thrown.
 */
export function parseSource(source: string, filePath: string): ParsedFile {
  if (language === undefined) {
    throw new Error(
      'Parser language not loaded. Call and await initParser() before parseSource().',
    )
  }

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
 * Walk every node (including unnamed ERROR/MISSING nodes) collecting syntax
 * diagnostics. Uses the raw children so error recovery nodes are seen.
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
 * Depth-first traversal visiting every named node exactly once. The visitor is
 * called on `node` itself (when named) before recursing into its named
 * children.
 */
export function walk(node: Node, visitor: (node: Node) => void): void {
  if (node.isNamed) {
    visitor(node)
  }
  for (const child of node.namedChildren) {
    walk(child, visitor)
  }
}
