import type { Node } from 'web-tree-sitter'
import { evalExpression, fail } from '../../src/interpreter/expressions.js'
import { ScopeChainImpl } from '../../src/interpreter/scope.js'
import type { ConstEvaluator, TypeResolver } from '../../src/interpreter/values.js'
import type { EvalContext } from '../../src/interpreter/context.js'
import type { SymbolTable } from '../../src/symbols/table.js'
import { Session } from '../../src/session.js'
import { DEFAULT_LIMITS } from '../../src/limits.js'

/** A `ConstEvaluator` backed by the real expression evaluator, for tests that build defaults from bare type nodes without a project. Enum members resolve through `resolver`; node locations are reported as `test:1`. */
export function testConstEval(resolver: TypeResolver): ConstEvaluator {
  const symbols = {
    locate: () => ({ file: 'test', line: 1, col: 1 }),
    normalizeKey: (name: string) => name.toLowerCase(),
    getEnum: (name: string) => {
      const t = resolver.resolveType(name)
      return t?.kind === 'enum' ? t : undefined
    },
    getEnums: () => [],
  } as unknown as SymbolTable
  const ctx: EvalContext = {
    symbols,
    chain: new ScopeChainImpl([]),
    limits: DEFAULT_LIMITS,
    callPou: (callee) => {
      throw new Error(`unexpected call to ${callee}`)
    },
    session: new Session({ caseSensitive: false }),
  }
  return { evaluate: (node: Node, enumHint) => evalExpression(node, ctx, enumHint), error: (node: Node, message) => fail(node, ctx, message) }
}
