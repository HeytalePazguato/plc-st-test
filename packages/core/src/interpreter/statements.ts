/**
 * Statement execution for IEC 61131-3 Structured Text.
 *
 * `execStatement` runs one grammar statement node and `execBody` a statement list; both return a `ControlSignal` so EXIT / CONTINUE / RETURN unwind to the construct that handles them: loops consume EXIT and CONTINUE of their own body (so EXIT leaves only the innermost loop), RETURN propagates to the POU dispatcher, and a signal that reaches the top of a body is the caller's business.
 *
 * Assignment stores a converted copy of the right-hand side in the target's declared representation, taken from the value already stored in the target (declared types are fixed, so the stored value always carries them): integers wrap to the target width, REAL rounds to single precision, STRING(n)/WSTRING(n) truncate to their `maxLength`, structs/arrays/enums are deep-copied with a type check. Implicit REAL → integer conversion rounds half to even, like REAL_TO_INT.
 *
 * FOR evaluates start, end and step once, rejects a zero step, skips the body when the bounds and the step's sign disagree, re-reads the control variable each iteration (so the guard sees the stored, wrapped value) and leaves it at the first value past the end after a normal termination. Every loop execution is capped at `limits.maxLoopIterations`; exceeding it raises an `IecRuntimeError` naming the loop's original file and line.
 *
 * Coverage: when the session has a `CoverageSink`, each taken branch reports `<file>:<line>:<kind>` (a placeholder id scheme; task 5.5 formalises ids). Without a sink no location work is done.
 */

import type { Node } from 'web-tree-sitter'
import type { Slot } from '@plc-st/plugin-api'
import { NORMAL, type ControlSignal, type EvalContext } from './context.js'
import { evalCall, evalExpression, evalLValue, fail, where } from './expressions.js'
import { IecType, froundReal, isBigIntType, isIntType, wrapInt } from './numeric.js'
import { cloneValue, type IecValue } from './values.js'
import { IecRuntimeError } from '../errors.js'

type Scalar = Extract<IecValue, { kind: 'scalar' }>

const EXIT: ControlSignal = { type: 'exit' }
const CONTINUE: ControlSignal = { type: 'continue' }
const RETURN: ControlSignal = { type: 'return' }

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

/** Execute a statement list in order, stopping at (and returning) the first non-normal signal. */
export function execBody(nodes: readonly Node[], ctx: EvalContext): ControlSignal {
  for (const node of nodes) {
    const signal = execStatement(node, ctx)
    if (signal.type !== 'normal') return signal
  }
  return NORMAL
}

/** Execute one statement node. Unknown node types are offered to the session's `nodeHandlers` (a handler may return a `ControlSignal`; anything else counts as normal completion) before raising `unsupported construct <type> at <file>:<line>`. */
export function execStatement(node: Node, ctx: EvalContext): ControlSignal {
  switch (node.type) {
    case 'assignment_statement':
      assign(evalLValue(field(node, 'left'), ctx), field(node, 'right'), node, ctx)
      return NORMAL
    case 'invocation_statement':
      evalCall(inner(node), ctx)
      return NORMAL
    case 'empty_statement':
    case 'comment':
      return NORMAL
    case 'if_statement':
      return execIf(node, ctx)
    case 'case_statement':
      return execCase(node, ctx)
    case 'for_statement':
      return execFor(node, ctx)
    case 'while_statement':
      return execWhile(node, ctx)
    case 'repeat_statement':
      return execRepeat(node, ctx)
    case 'exit_statement':
      return EXIT
    case 'continue_statement':
      return CONTINUE
    case 'return_statement':
      if (node.childForFieldName('value') !== null) return handled(node, ctx, 'RETURN with a value')
      return RETURN
    default:
      return handled(node, ctx, `unsupported construct ${node.type}`)
  }
}

/** Store `value` into `slot`, converted to the representation of the value the slot already holds (its declared type). `node` locates conversion errors. */
export function storeValue(slot: Slot, value: IecValue, node: Node, ctx: EvalContext): void {
  slot.value = convertForStore(slot.value, value, node, ctx)
}

// ---------------------------------------------------------------------------
// Node helpers.
// ---------------------------------------------------------------------------

function field(node: Node, name: string): Node {
  const child = node.childForFieldName(name)
  if (child === null) throw new IecRuntimeError(`malformed ${node.type}: missing '${name}'`)
  return child
}

function statements(node: Node, fieldName: string): Node[] {
  return node.childrenForFieldName(fieldName).filter((c) => c.isNamed && c.type !== 'comment')
}

function inner(node: Node): Node {
  const child = node.namedChildren.find((c) => c.type !== 'comment')
  if (child === undefined) throw new IecRuntimeError(`malformed ${node.type}: empty`)
  return child
}

function clauses(node: Node, type: string): Node[] {
  return node.namedChildren.filter((c) => c.type === type)
}

function handled(node: Node, ctx: EvalContext, message: string): ControlSignal {
  const handler = ctx.session.nodeHandlers.get(node.type)
  if (handler === undefined) throw fail(node, ctx, message)
  const result = handler(node, ctx)
  return isSignal(result) ? result : NORMAL
}

function isSignal(v: unknown): v is ControlSignal {
  if (typeof v !== 'object' || v === null || !('type' in v)) return false
  const t = (v as { type: unknown }).type
  return t === 'normal' || t === 'exit' || t === 'continue' || t === 'return'
}

/** Report a taken branch to the coverage sink, if there is one. */
function hit(node: Node, kind: string, ctx: EvalContext): void {
  const sink = ctx.session.coverage
  if (sink === undefined) return
  sink.hit(`${where(node, ctx)}:${kind}`)
}

function condition(node: Node, ctx: EvalContext): boolean {
  const v = evalExpression(node, ctx)
  if (v.kind !== 'scalar' || v.type !== IecType.BOOL) throw fail(node, ctx, `condition '${node.text}' must be BOOL`)
  return v.value as boolean
}

// ---------------------------------------------------------------------------
// Assignment.
// ---------------------------------------------------------------------------

function assign(slot: Slot, rhs: Node, node: Node, ctx: EvalContext): void {
  const target = slot.value
  const value = evalExpression(rhs, ctx, target.kind === 'enum' && target.typeName !== '' ? target.typeName : undefined)
  storeValue(slot, value, node, ctx)
}

function describe(v: IecValue): string {
  switch (v.kind) {
    case 'scalar':
      return v.maxLength === undefined ? v.type : `${v.type}(${String(v.maxLength)})`
    case 'enum':
      return v.typeName === '' ? 'enum' : v.typeName
    case 'struct':
      return v.typeName === '' ? 'STRUCT' : v.typeName
    case 'array':
      return 'ARRAY'
  }
}

function sameName(a: string, b: string, ctx: EvalContext): boolean {
  return a === '' || b === '' || ctx.symbols.normalizeKey(a) === ctx.symbols.normalizeKey(b)
}

function convertForStore(target: IecValue, value: IecValue, node: Node, ctx: EvalContext): IecValue {
  const mismatch = (): Error => fail(node, ctx, `cannot assign ${describe(value)} to ${describe(target)}`)
  switch (target.kind) {
    case 'scalar':
      return convertScalar(target, value, mismatch)
    case 'enum':
      if (value.kind === 'enum' && sameName(target.typeName, value.typeName, ctx)) return { kind: 'enum', typeName: target.typeName, value: value.value }
      // Dialects allow an integer to be stored into an enum variable.
      if (value.kind === 'scalar' && isIntType(value.type)) return { kind: 'enum', typeName: target.typeName, value: Number(value.value) }
      throw mismatch()
    case 'struct':
      if (value.kind !== 'struct' || !sameName(target.typeName, value.typeName, ctx)) throw mismatch()
      return cloneValue(value)
    case 'array': {
      if (value.kind !== 'array' || value.data.length !== target.data.length) throw mismatch()
      // Element-wise so each element keeps the target's element representation (e.g. STRING(n) capacity).
      const data = target.data.map((t, i) => convertForStore(t, value.data[i], node, ctx))
      return { kind: 'array', elemType: target.elemType, dims: target.dims.map((d) => [d[0], d[1]] as [number, number]), data }
    }
  }
}

function convertScalar(target: Scalar, value: IecValue, mismatch: () => Error): Scalar {
  const t = target.type
  const make = (v: Scalar['value']): Scalar => (target.maxLength === undefined ? { kind: 'scalar', type: t, value: v } : { kind: 'scalar', type: t, value: v, maxLength: target.maxLength })
  if (value.kind === 'enum') {
    if (!isIntType(t)) throw mismatch()
    return make(wrapInt(value.value, t))
  }
  if (value.kind !== 'scalar') throw mismatch()
  const s = value.type
  if (t === IecType.BOOL) {
    if (s !== IecType.BOOL) throw mismatch()
    return make(value.value)
  }
  if (t === IecType.STRING || t === IecType.WSTRING) {
    if (s !== IecType.STRING && s !== IecType.WSTRING) throw mismatch()
    const str = value.value as string
    return make(target.maxLength !== undefined && str.length > target.maxLength ? str.slice(0, target.maxLength) : str)
  }
  if (t === IecType.TIME) {
    if (s !== IecType.TIME) throw mismatch()
    return make(typeof value.value === 'bigint' ? value.value : BigInt(Math.trunc(Number(value.value))))
  }
  if (t === IecType.REAL || t === IecType.LREAL) {
    if (!isIntType(s) && s !== IecType.REAL && s !== IecType.LREAL) throw mismatch()
    const n = Number(value.value)
    return make(t === IecType.REAL ? froundReal(n) : n)
  }
  if (isIntType(t)) {
    if (isIntType(s)) return make(wrapTo(value.value as number | bigint, t))
    if (s === IecType.REAL || s === IecType.LREAL) return make(wrapTo(roundHalfEven(value.value as number), t))
  }
  throw mismatch()
}

/** Wrap an integer (number or bigint) into `t`'s width and representation, exactly for any 64-bit source. */
function wrapTo(v: number | bigint, t: IecType): number | bigint {
  if (typeof v === 'bigint' && !isBigIntType(t)) return wrapInt(Number(BigInt.asIntN(32, v)), t)
  return wrapInt(v, t)
}

function roundHalfEven(n: number): number {
  const r = Math.round(n)
  return Math.abs(n % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r
}

// ---------------------------------------------------------------------------
// Selection.
// ---------------------------------------------------------------------------

function execIf(node: Node, ctx: EvalContext): ControlSignal {
  if (condition(field(node, 'condition'), ctx)) {
    hit(node, 'then', ctx)
    return execBody(statements(node, 'consequence'), ctx)
  }
  for (const clause of clauses(node, 'elsif_clause')) {
    if (condition(field(clause, 'condition'), ctx)) {
      hit(clause, 'elsif', ctx)
      return execBody(statements(clause, 'body'), ctx)
    }
  }
  const otherwise = clauses(node, 'else_clause')[0] as Node | undefined
  if (otherwise === undefined) {
    hit(node, 'if-none', ctx)
    return NORMAL
  }
  hit(otherwise, 'else', ctx)
  return execBody(statements(otherwise, 'body'), ctx)
}

/** Ordinal of a CASE subject or label: integer value, or an enum member's value. */
interface Ordinal {
  value: bigint
  enumType?: string
}

function ordinal(v: IecValue, node: Node, ctx: EvalContext): Ordinal {
  if (v.kind === 'enum') return { value: BigInt(v.value), enumType: v.typeName }
  if (v.kind === 'scalar' && isIntType(v.type)) return { value: typeof v.value === 'bigint' ? v.value : BigInt(v.value as number) }
  throw fail(node, ctx, `CASE selector '${node.text}' must be an integer or enumeration value`)
}

function execCase(node: Node, ctx: EvalContext): ControlSignal {
  const subjectNode = field(node, 'subject')
  const subjectValue = evalExpression(subjectNode, ctx)
  const subject = ordinal(subjectValue, subjectNode, ctx)
  const hint = subject.enumType !== undefined && subject.enumType !== '' ? subject.enumType : undefined
  const label = (n: Node): bigint => {
    const o = ordinal(evalExpression(n, ctx, hint), n, ctx)
    if (o.enumType !== undefined && subject.enumType !== undefined && !sameName(o.enumType, subject.enumType, ctx)) {
      throw fail(n, ctx, `CASE label '${n.text}' is ${o.enumType} but the selector is ${subject.enumType}`)
    }
    return o.value
  }
  for (const clause of clauses(node, 'case_clause')) {
    const matches = clause.namedChildren
      .filter((c) => c.type === 'case_value')
      .some((cv) => {
        const v = inner(cv)
        if (v.type !== 'subrange') return label(v) === subject.value
        return label(field(v, 'lower')) <= subject.value && subject.value <= label(field(v, 'upper'))
      })
    if (matches) {
      hit(clause, 'case', ctx)
      return execBody(statements(clause, 'body'), ctx)
    }
  }
  const otherwise = clauses(node, 'else_clause')[0] as Node | undefined
  if (otherwise === undefined) {
    hit(node, 'case-none', ctx)
    return NORMAL
  }
  hit(otherwise, 'case-else', ctx)
  return execBody(statements(otherwise, 'body'), ctx)
}

// ---------------------------------------------------------------------------
// Iteration.
// ---------------------------------------------------------------------------

/** Per-execution iteration budget of one loop statement. */
function iterationGuard(node: Node, ctx: EvalContext): () => void {
  const max = ctx.limits.maxLoopIterations
  let count = 0
  return () => {
    count += 1
    // The wall-clock deadline is only consulted every 1024 iterations to keep the loop hot path cheap.
    if ((count & 1023) === 0) ctx.session.checkDeadline()
    if (count > max) throw fail(node, ctx, `loop exceeded the maximum of ${String(max)} iterations (limits.maxLoopIterations)`)
  }
}

/** Run one iteration's body; `true` when the loop must stop with `signal` (EXIT is consumed into NORMAL). */
function iterate(body: Node[], ctx: EvalContext): { stop: boolean; signal: ControlSignal } {
  const signal = execBody(body, ctx)
  if (signal.type === 'exit') return { stop: true, signal: NORMAL }
  if (signal.type === 'return') return { stop: true, signal }
  return { stop: false, signal: NORMAL }
}

function integerOf(v: IecValue, node: Node, ctx: EvalContext, what: string): bigint {
  if (v.kind === 'scalar' && isIntType(v.type)) return typeof v.value === 'bigint' ? v.value : BigInt(v.value as number)
  throw fail(node, ctx, `FOR ${what} '${node.text}' must be an integer`)
}

function execFor(node: Node, ctx: EvalContext): ControlSignal {
  const controlNode = field(node, 'control')
  const control = evalLValue(controlNode, ctx)
  const controlType = control.value.kind === 'scalar' && isIntType(control.value.type) ? control.value.type : undefined
  if (controlType === undefined) throw fail(controlNode, ctx, `FOR control variable '${controlNode.text}' must be an integer`)

  const startNode = field(node, 'start')
  const endNode = field(node, 'end')
  const stepNode = node.childForFieldName('step')
  const start = evalExpression(startNode, ctx)
  integerOf(start, startNode, ctx, 'start value')
  const end = integerOf(evalExpression(endNode, ctx), endNode, ctx, 'end value')
  const step = stepNode === null ? 1n : integerOf(evalExpression(stepNode, ctx), stepNode, ctx, 'step')
  if (step === 0n) throw fail(stepNode ?? node, ctx, 'FOR step must not be zero')

  storeValue(control, start, node, ctx)
  const body = statements(node, 'body')
  const guard = iterationGuard(node, ctx)
  const current = (): bigint => integerOf(control.value, controlNode, ctx, 'control variable')
  for (;;) {
    const i = current()
    if (step > 0n ? i > end : i < end) break
    guard()
    hit(node, 'for-body', ctx)
    const { stop, signal } = iterate(body, ctx)
    if (stop) return signal
    control.value = { kind: 'scalar', type: controlType, value: wrapTo(current() + step, controlType) }
  }
  return NORMAL
}

function execWhile(node: Node, ctx: EvalContext): ControlSignal {
  const cond = field(node, 'condition')
  const body = statements(node, 'body')
  const guard = iterationGuard(node, ctx)
  while (condition(cond, ctx)) {
    guard()
    hit(node, 'while-body', ctx)
    const { stop, signal } = iterate(body, ctx)
    if (stop) return signal
  }
  return NORMAL
}

function execRepeat(node: Node, ctx: EvalContext): ControlSignal {
  const cond = field(node, 'condition')
  const body = statements(node, 'body')
  const guard = iterationGuard(node, ctx)
  do {
    guard()
    hit(node, 'repeat-body', ctx)
    const { stop, signal } = iterate(body, ctx)
    if (stop) return signal
  } while (!condition(cond, ctx))
  return NORMAL
}
