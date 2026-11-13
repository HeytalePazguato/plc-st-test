/**
 * The `NodeEvaluator` core hands to dialect node handlers: the expression evaluator, l-value resolution, typed store and located errors, behind the plugin-api contract so dialects never import core.
 *
 * `expressions.ts` and `statements.ts` import this module and this module imports them; the cycle is safe because every method resolves its import when called, never at module initialisation.
 */

import type { Node } from 'web-tree-sitter'
import type { IecValue, NodeEvaluator, Slot } from '@plc-st/plugin-api'
import type { EvalContext } from './context.js'
import { evalExpression, evalLValue, fail } from './expressions.js'
import { storeValue } from './statements.js'

export const NODE_EVALUATOR: NodeEvaluator = Object.freeze({
  evaluate: (node: unknown, ctx: unknown) => evalExpression(node as Node, ctx as EvalContext),
  lvalue: (node: unknown, ctx: unknown) => evalLValue(node as Node, ctx as EvalContext),
  store: (slot: Slot, value: IecValue, node: unknown, ctx: unknown) => {
    storeValue(slot, value, node as Node, ctx as EvalContext)
  },
  error: (node: unknown, ctx: unknown, message: string) => fail(node as Node, ctx as EvalContext, message),
})
