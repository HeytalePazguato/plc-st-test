/**
 * TwinCAT pointers and references on top of the core's slot table. Node names and fields follow the node-type contract of the base grammar and of `tree-sitter-iec61131-3-st-beckhoff`.
 *
 * - `ADR(x)` evaluates to a `POINTER` scalar whose value is the session's slot handle for `x` (`0` is NULL), so a pointer survives copies and compares with `=` / `<>`. The slot is the live storage of `x`, so `pInt^ := 7` changes `nVal`, and `pFb^.Method()` / `pSt^.field` reach the instance or structure itself.
 * - `p^` reads and writes through the slot (the lvalue handler makes it assignable); a NULL or unknown pointer is a runtime error.
 * - `r REF= x` binds the `REFERENCE TO` variable `r` to the variable `x`; afterwards every read and write of `r` goes to `x` (core follows the reference). An unbound reference errors when used, and `__ISVALIDREF(r)` tells whether it is bound.
 * - `SIZEOF(x)` is the IEC byte size of the declared type of `x` (64-bit target: pointers and references are 8 bytes, TIME 4, `STRING(n)` n+1, `WSTRING(n)` 2(n+1), an enum 2). A structure or function block instance is the plain sum of its members, without alignment padding.
 *
 * Pointer arithmetic is refused by core with `pointer arithmetic is not supported (fidelity statement)`.
 */

import type { HostFnDef, IecValue, LvalueHandler, NodeEvaluator, NodeHandler, Slot } from '@plc-st/plugin-api'
import type { Node } from 'web-tree-sitter'

function field(node: Node, name: string, ctx: unknown, evaluator: NodeEvaluator): Node {
  const child = node.childForFieldName(name)
  if (child === null) throw evaluator.error(node, ctx, `malformed ${node.type}: missing '${name}'`)
  return child
}

/** The slot a pointer expression points at; NULL, non-pointer and unknown values are runtime errors. */
function target(pointerNode: Node, ctx: unknown, evaluator: NodeEvaluator): Slot {
  const pointer = evaluator.evaluate(pointerNode, ctx)
  if (pointer.kind !== 'scalar' || pointer.type !== 'POINTER') throw evaluator.error(pointerNode, ctx, `'${pointerNode.text}' is not a pointer and cannot be dereferenced`)
  const handle = Number(pointer.value)
  if (handle === 0) throw evaluator.error(pointerNode, ctx, `null pointer dereference: '${pointerNode.text}' is NULL`)
  const slot = evaluator.slotOf(handle, ctx)
  if (slot === undefined) throw evaluator.error(pointerNode, ctx, `invalid pointer dereference: '${pointerNode.text}' does not point at a variable`)
  return slot
}

export const addressOfExpression: NodeHandler = (raw, ctx, evaluator) => {
  const node = raw as Node
  const slot = evaluator.lvalue(field(node, 'operand', ctx, evaluator), ctx)
  return { kind: 'scalar', type: 'POINTER', value: evaluator.handleOf(slot, ctx) } satisfies IecValue
}

export const dereferenceExpression: NodeHandler = (raw, ctx, evaluator) => {
  const node = raw as Node
  return target(field(node, 'pointer', ctx, evaluator), ctx, evaluator).value
}

export const dereferenceLvalue: LvalueHandler = (raw, ctx, evaluator) => {
  const node = raw as Node
  return target(field(node, 'pointer', ctx, evaluator), ctx, evaluator)
}

export const referenceAssignmentStatement: NodeHandler = (raw, ctx, evaluator) => {
  const node = raw as Node
  const left = field(node, 'left', ctx, evaluator)
  const reference = evaluator.rawLvalue(left, ctx)
  if (reference.value.kind !== 'scalar' || reference.value.type !== 'REFERENCE') throw evaluator.error(left, ctx, `target '${left.text}' of REF= must be declared REFERENCE TO or REF_TO`)
  const right = field(node, 'right', ctx, evaluator)
  const variable = evaluator.lvalue(right, ctx)
  reference.value = { kind: 'scalar', type: 'REFERENCE', value: evaluator.handleOf(variable, ctx) }
  return undefined
}

/** IEC byte size of `value`'s declared type. */
export function sizeOf(value: IecValue): number {
  switch (value.kind) {
    case 'scalar':
      switch (value.type) {
        case 'BOOL':
        case 'BYTE':
        case 'SINT':
        case 'USINT':
          return 1
        case 'WORD':
        case 'INT':
        case 'UINT':
          return 2
        case 'DWORD':
        case 'DINT':
        case 'UDINT':
        case 'REAL':
        case 'TIME':
          return 4
        case 'LWORD':
        case 'LINT':
        case 'ULINT':
        case 'LREAL':
        case 'POINTER':
        case 'REFERENCE':
          return 8
        case 'STRING':
          return (value.maxLength ?? 80) + 1
        case 'WSTRING':
          return ((value.maxLength ?? 255) + 1) * 2
      }
      return 0
    case 'enum':
      return 2
    case 'array':
      return value.data.reduce((sum, element) => sum + sizeOf(element), 0)
    case 'struct':
      return [...value.fields.values()].reduce((sum, member) => sum + sizeOf(member), 0)
  }
}

export const sizeofHostFn: HostFnDef = {
  name: 'SIZEOF',
  minArgs: 1,
  maxArgs: 1,
  call: (args) => ({ kind: 'scalar', type: 'UDINT', value: sizeOf(args[0]!.value) }),
}

export const isValidRefHostFn: HostFnDef = {
  name: '__ISVALIDREF',
  minArgs: 1,
  maxArgs: 1,
  rawArgs: true,
  call: (args) => {
    const value = args[0]!.value
    // Only a reference can be unbound; any other variable is trivially valid.
    return { kind: 'scalar', type: 'BOOL', value: value.kind !== 'scalar' || value.type !== 'REFERENCE' || Number(value.value) !== 0 }
  },
}
