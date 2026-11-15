/**
 * TwinCAT memory and system intrinsics.
 *
 * - `__NEW(T)` / `__NEW(T, n)` allocate an instance (or an array `[0..n-1]`) of `T` through the core, counting toward the allocation limit, run FB_init for function blocks and return a `POINTER` handle, so `p^`, `p^.Method()` and `p^[i]` work through the pointer support in `pointers.ts`.
 * - `__DELETE(p)` disposes what `p` points at (FB_exit, children first) and sets `p` to NULL; deleting NULL does nothing and a pointer that `__NEW` did not allocate is a runtime error.
 * - `__SYSTEM.GetCurrentTaskIndex()` returns 0, the single simulated task; every other `__SYSTEM` intrinsic raises a runtime error naming it.
 */

import type { IecValue, NodeEvaluator, NodeHandler } from '@plc-st/plugin-api'
import type { Node } from 'web-tree-sitter'

function field(node: Node, name: string, ctx: unknown, evaluator: NodeEvaluator): Node {
  const child = node.childForFieldName(name)
  if (child === null) throw evaluator.error(node, ctx, `malformed ${node.type}: missing '${name}'`)
  return child
}

export const newExpression: NodeHandler = (raw, ctx, evaluator) => {
  const node = raw as Node
  const type = field(node, 'type', ctx, evaluator)
  const sizeNode = node.childForFieldName('size')
  let count: number | undefined
  if (sizeNode !== null) {
    const size = evaluator.evaluate(sizeNode, ctx)
    if (size.kind !== 'scalar' || (typeof size.value !== 'number' && typeof size.value !== 'bigint')) throw evaluator.error(sizeNode, ctx, `the element count '${sizeNode.text}' of __NEW must be an integer`)
    count = Number(size.value)
  }
  return { kind: 'scalar', type: 'POINTER', value: evaluator.allocate(type, count, ctx) } satisfies IecValue
}

export const deleteStatement: NodeHandler = (raw, ctx, evaluator) => {
  const node = raw as Node
  const operand = field(node, 'operand', ctx, evaluator)
  const slot = evaluator.lvalue(operand, ctx)
  const pointer = slot.value
  if (pointer.kind !== 'scalar' || pointer.type !== 'POINTER') throw evaluator.error(operand, ctx, `'${operand.text}' is not a pointer and cannot be deleted`)
  const handle = Number(pointer.value)
  if (handle === 0) return undefined
  evaluator.free(handle, operand, ctx)
  evaluator.store(slot, { kind: 'scalar', type: 'POINTER', value: 0 }, node, ctx)
  return undefined
}

export const systemCall: NodeHandler = (raw, ctx, evaluator) => {
  const node = raw as Node
  const intrinsic = field(node, 'intrinsic', ctx, evaluator).text
  if (intrinsic.toUpperCase() === 'GETCURRENTTASKINDEX') return { kind: 'scalar', type: 'BYTE', value: 0 } satisfies IecValue
  throw evaluator.error(node, ctx, `__SYSTEM.${intrinsic} is not supported by the simulator`)
}
