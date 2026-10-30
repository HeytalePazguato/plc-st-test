import { Parser, type Language, type Node } from 'web-tree-sitter'
import { IecError } from '../errors.js'

const EXPR_PREFIX = 'FUNCTION __frag : BOOL\n__frag := ('
const EXPR_SUFFIX = ');\nEND_FUNCTION'
const STMT_PREFIX = 'PROGRAM __frag\n'
const STMT_SUFFIX = '\nEND_PROGRAM'

/** First ERROR / MISSING node in the subtree, in document order. */
function findProblem(node: Node): Node | undefined {
  if (node.isMissing || node.isError || node.type === 'ERROR') return node
  if (!node.hasError) return undefined
  for (const child of node.children) {
    const hit = findProblem(child)
    if (hit !== undefined) return hit
  }
  return undefined
}

function parseWrapped(language: Language, src: string, prefix: string, suffix: string): Node {
  const parser = new Parser()
  parser.setLanguage(language)
  const tree = parser.parse(prefix + src + suffix)
  if (tree === null) throw new IecError(`invalid fragment: ${src}`)
  const root = tree.rootNode
  const problem = root.hasError ? findProblem(root) : undefined
  if (problem !== undefined) {
    // Report the position relative to the fragment, not the synthetic wrapper.
    const prefixRows = prefix.split('\n').length - 1
    const prefixCol = prefix.length - (prefix.lastIndexOf('\n') + 1)
    const row = Math.max(problem.startPosition.row - prefixRows, 0)
    const rawCol = problem.startPosition.column
    const col = Math.max(problem.startPosition.row === prefixRows ? rawCol - prefixCol : rawCol, 0)
    const what = problem.isMissing ? `missing ${problem.type}` : 'syntax error'
    throw new IecError(`invalid fragment: ${src} (${what} at line ${row + 1}, col ${col + 1})`)
  }
  return root
}

/**
 * Parse a single ST expression by wrapping it in a throwaway FUNCTION and returning the inner expression node (the wrapping parentheses are stripped). Throws `IecError('invalid fragment: <src>')` on any syntax error.
 */
export function parseExpressionFragment(language: Language, exprSrc: string): Node {
  const root = parseWrapped(language, exprSrc, EXPR_PREFIX, EXPR_SUFFIX)
  const assign = root.namedChildren[0]?.childForFieldName('body')
  const inner = assign?.childForFieldName('right')?.namedChildren[0]
  if (inner === undefined || inner === null) throw new IecError(`invalid fragment: ${exprSrc}`)
  return inner
}

/**
 * Parse a sequence of ST statements by wrapping them in a throwaway PROGRAM and returning the body statements. Throws `IecError('invalid fragment: <src>')` on any syntax error.
 */
export function parseStatementFragment(language: Language, stmts: string): Node[] {
  const root = parseWrapped(language, stmts, STMT_PREFIX, STMT_SUFFIX)
  const program = root.namedChildren[0]
  if (program === undefined) throw new IecError(`invalid fragment: ${stmts}`)
  return program.childrenForFieldName('body').filter((n) => n.isNamed)
}
