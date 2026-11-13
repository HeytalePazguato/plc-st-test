/**
 * Node handlers for the Beckhoff TwinCAT 3 constructs the core interpreter does not evaluate itself. Node names and fields follow the node-type contract of `tree-sitter-iec61131-3-st-beckhoff`.
 *
 * - `short_circuit_expression`: `a AND_THEN b` evaluates `b` only when `a` is TRUE, `a OR_ELSE b` only when `a` is FALSE; both operands must be BOOL and the result is BOOL.
 * - `set_reset_assignment_statement`: `x S= c;` stores TRUE into `x` when `c` is TRUE and `x R= c;` stores FALSE when `c` is TRUE; otherwise `x` is left unchanged. The target is resolved before `c` is evaluated, so an invalid target always errors.
 * - `pragma` in statement position, with the `attribute_pragma` and `conditional_directive` it wraps: no-ops. Attributes do not change simulation semantics, and conditional regions are not evaluated (every region runs) until a preprocessing hook handles them.
 */

import type { IecValue, NodeEvaluator, NodeHandler } from '@plc-st/plugin-api'
import type { Node } from 'web-tree-sitter'

const TRUE: IecValue = { kind: 'scalar', type: 'BOOL', value: true }
const FALSE: IecValue = { kind: 'scalar', type: 'BOOL', value: false }

function field(node: Node, name: string, ctx: unknown, evaluator: NodeEvaluator): Node {
  const child = node.childForFieldName(name)
  if (child === null) throw evaluator.error(node, ctx, `malformed ${node.type}: missing '${name}'`)
  return child
}

/** Evaluate `node` and require a BOOL, naming the operator in the error. */
function bool(node: Node, ctx: unknown, evaluator: NodeEvaluator, operator: string): boolean {
  const value = evaluator.evaluate(node, ctx)
  if (value.kind !== 'scalar' || value.type !== 'BOOL') throw evaluator.error(node, ctx, `operand '${node.text}' of ${operator} must be BOOL`)
  return value.value as boolean
}

export const shortCircuitExpression: NodeHandler = (raw, ctx, evaluator) => {
  const node = raw as Node
  const operator = field(node, 'operator', ctx, evaluator).text.toUpperCase()
  if (operator !== 'AND_THEN' && operator !== 'OR_ELSE') throw evaluator.error(node, ctx, `unsupported short-circuit operator ${operator}`)
  const left = bool(field(node, 'left', ctx, evaluator), ctx, evaluator, operator)
  // AND_THEN is decided by a FALSE left side and OR_ELSE by a TRUE one; only then is the right side skipped.
  if (operator === 'AND_THEN' ? !left : left) return left ? TRUE : FALSE
  return bool(field(node, 'right', ctx, evaluator), ctx, evaluator, operator) ? TRUE : FALSE
}

export const setResetAssignmentStatement: NodeHandler = (raw, ctx, evaluator) => {
  const node = raw as Node
  const operator = field(node, 'operator', ctx, evaluator)
  if (operator.type !== 'set_assign' && operator.type !== 'reset_assign') throw evaluator.error(node, ctx, `unsupported set/reset operator ${operator.text}`)
  const left = field(node, 'left', ctx, evaluator)
  const slot = evaluator.lvalue(left, ctx)
  if (slot.value.kind !== 'scalar' || slot.value.type !== 'BOOL') throw evaluator.error(left, ctx, `target '${left.text}' of ${operator.text} must be BOOL`)
  if (!bool(field(node, 'right', ctx, evaluator), ctx, evaluator, operator.text)) return undefined
  evaluator.store(slot, operator.type === 'set_assign' ? TRUE : FALSE, node, ctx)
  return undefined
}

/** Pragmas carry compiler metadata only; in statement position they do nothing. */
export const noOp: NodeHandler = () => undefined

export const beckhoffNodeHandlers: Readonly<Record<string, NodeHandler>> = Object.freeze({
  short_circuit_expression: shortCircuitExpression,
  set_reset_assignment_statement: setResetAssignmentStatement,
  pragma: noOp,
  attribute_pragma: noOp,
  conditional_directive: noOp,
})
