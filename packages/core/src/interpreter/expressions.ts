/**
 * Expression evaluation for IEC 61131-3 Structured Text.
 *
 * `evalExpression` turns a grammar expression node into an `IecValue`; `evalLValue` resolves an assignable expression (variable, struct/FB member, array element) to the `Slot` that stores it. All integer/real arithmetic goes through numeric.ts so wrap-around, REAL rounding and IEC widening match the PLC.
 *
 * Literal typing: an untyped integer literal is a DINT (LINT/ULINT when it does not fit) and an untyped real literal is an LREAL, but in a binary operation an untyped literal adopts its typed partner's type when its value fits (so `byteVar AND 16#0F` stays BYTE and `sintVar + 1` wraps as SINT). `**` always yields a floating-point result (IEC EXPT returns ANY_REAL): the wider float operand type, or LREAL for two integers.
 *
 * TIME values are nanoseconds as `bigint`. D#, TOD# and DT# literals fold onto TIME (as the value model does for the date/time family): DATE and DATE_AND_TIME are nanoseconds since 1970-01-01 UTC, TIME_OF_DAY is nanoseconds since midnight.
 *
 * Values returned for variables, members and elements are the stored objects themselves (no copy), so a caller that stores a result elsewhere must `cloneValue` it first. Pointers/references are not supported in core: such nodes, like any other unknown node type, are offered to the session's `nodeHandlers` before an `unsupported construct` error is raised.
 */

import type { Node } from 'web-tree-sitter'
import type { CallArg, Slot } from '@plc-st/plugin-api'
import type { EvalContext } from './context.js'
import { IecType, isBigIntType, isIntType, wrapInt, froundReal, widen, add, sub, mul, div, mod, pow } from './numeric.js'
import { elementaryType, type IecValue } from './values.js'
import { IecError, IecRuntimeError } from '../errors.js'
import { caseKey } from '../case.js'

type Scalar = Extract<IecValue, { kind: 'scalar' }>
type ArrayValue = Extract<IecValue, { kind: 'array' }>
type StructValue = Extract<IecValue, { kind: 'struct' }>
type EnumValue = Extract<IecValue, { kind: 'enum' }>
type Num = number | bigint

// ---------------------------------------------------------------------------
// Errors and node helpers.
// ---------------------------------------------------------------------------

/** `<file>:<line>` of `node` in the original source, or the parse-tree line when the node's tree is unknown to the symbol table. */
export function where(node: Node, ctx: EvalContext): string {
  try {
    const loc = ctx.symbols.locate(node)
    return `${loc.file}:${String(loc.line)}`
  } catch (err) {
    if (!(err instanceof IecError)) throw err
    return `line ${String(node.startPosition.row + 1)}`
  }
}

/** An `IecRuntimeError` whose message ends with `node`'s original location. */
export function fail(node: Node, ctx: EvalContext, message: string): IecRuntimeError {
  return new IecRuntimeError(`${message} at ${where(node, ctx)}`)
}

/** Run a numeric.ts computation, attaching `node`'s location to the errors it raises (division by zero, …). */
function located<T>(node: Node, ctx: EvalContext, compute: () => T): T {
  try {
    return compute()
  } catch (err) {
    if (err instanceof IecRuntimeError) throw fail(node, ctx, err.message)
    throw err
  }
}

function field(node: Node, name: string): Node {
  const child = node.childForFieldName(name)
  if (child === null) throw new IecRuntimeError(`malformed ${node.type}: missing '${name}'`)
  return child
}

/** Named, non-comment children (comments are grammar extras and may appear anywhere). */
function operands(node: Node): Node[] {
  return node.namedChildren.filter((c) => c.type !== 'comment')
}

function inner(node: Node): Node {
  const child = operands(node)[0]
  if (child === undefined) throw new IecRuntimeError(`malformed ${node.type}: empty`)
  return child
}

function operatorOf(node: Node): string {
  return field(node, 'operator').text.toUpperCase()
}

// ---------------------------------------------------------------------------
// Value helpers.
// ---------------------------------------------------------------------------

function scalar(type: IecType, value: Scalar['value']): Scalar {
  return { kind: 'scalar', type, value }
}

function bool(value: boolean): Scalar {
  return scalar(IecType.BOOL, value)
}

function isFloatType(t: IecType): boolean {
  return t === IecType.REAL || t === IecType.LREAL
}

function isNumericType(t: IecType): boolean {
  return isIntType(t) || isFloatType(t)
}

function isStringType(t: IecType): boolean {
  return t === IecType.STRING || t === IecType.WSTRING
}

function toBig(v: Scalar['value']): bigint {
  return typeof v === 'bigint' ? v : BigInt(Math.trunc(Number(v)))
}

/** The value in the representation numeric.ts uses for `type` (bigint for 64-bit integers, number otherwise). */
function represent(v: bigint, type: IecType): Num {
  return isBigIntType(type) ? v : Number(v)
}

function describe(v: IecValue): string {
  switch (v.kind) {
    case 'scalar':
      return v.type
    case 'enum':
      return v.typeName === '' ? 'enum' : v.typeName
    case 'struct':
      return v.typeName === '' ? 'STRUCT' : v.typeName
    case 'array':
      return 'ARRAY'
  }
}

function expectScalar(v: IecValue, node: Node, ctx: EvalContext): Scalar {
  if (v.kind !== 'scalar') throw fail(node, ctx, `expected an elementary value but '${node.text}' is ${describe(v)}`)
  return v
}

/** True when `node` is an untyped numeric literal (possibly signed or parenthesised), whose type adapts to its partner in a binary operation. */
function isUntypedLiteral(node: Node): boolean {
  switch (node.type) {
    case 'integer_literal':
    case 'real_literal':
      return true
    case 'parenthesized_expression':
      return isUntypedLiteral(inner(node))
    case 'unary_expression':
      return operatorOf(node) !== 'NOT' && isUntypedLiteral(field(node, 'operand'))
    default:
      return false
  }
}

/** Whether an untyped literal value `lit` can take `target` as its type without changing value. */
function adoptable(lit: Scalar, target: IecType): boolean {
  if (isFloatType(target)) return isNumericType(lit.type)
  if (!isIntType(target) || !isIntType(lit.type)) return false
  const v = toBig(lit.value)
  return toBig(wrapInt(v, target)) === v
}

/** Operation type of two numeric operands: an untyped literal adopts its typed partner's type, otherwise IEC widening applies. */
function commonType(l: Scalar, lUntyped: boolean, r: Scalar, rUntyped: boolean): IecType {
  if (lUntyped && !rUntyped && adoptable(l, r.type)) return r.type
  if (rUntyped && !lUntyped && adoptable(r, l.type)) return l.type
  return widen(l.type, r.type)
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

/**
 * Evaluate `node` to a value. `enumHint` names the enum type a bare enum member (e.g. `Red` instead of `E_Color.Red`) should be resolved against first, for callers that know the expected type (assignment target, CASE subject); comparison operands get it from their partner automatically.
 */
export function evalExpression(node: Node, ctx: EvalContext, enumHint?: string): IecValue {
  switch (node.type) {
    case 'boolean_literal':
      return bool(node.text.toUpperCase() === 'TRUE')
    case 'integer_literal':
      return untypedInteger(node, ctx)
    case 'real_literal':
      return scalar(IecType.LREAL, parseReal(node.text))
    case 'string_literal':
      return stringLiteral(node, ctx)
    case 'time_literal':
      return scalar(IecType.TIME, parseDuration(node, ctx))
    case 'date_literal':
      return scalar(IecType.TIME, parseDate(literalBody(node), node, ctx))
    case 'time_of_day_literal':
      return scalar(IecType.TIME, parseTimeOfDay(literalBody(node), node, ctx))
    case 'date_and_time_literal':
      return scalar(IecType.TIME, parseDateAndTime(node, ctx))
    case 'typed_literal':
      return typedLiteral(node, ctx)
    case 'parenthesized_expression':
      return evalExpression(inner(node), ctx, enumHint)
    case 'identifier':
      return identifier(node, ctx, enumHint)
    case 'member_access_expression':
      return qualifiedEnum(node, ctx) ?? evalLValue(node, ctx).value
    case 'index_expression':
      return evalLValue(node, ctx).value
    case 'unary_expression':
      return unary(node, ctx)
    case 'binary_expression':
      return binary(node, ctx)
    case 'call_expression': {
      const result = evalCall(node, ctx)
      if (result === undefined) throw fail(node, ctx, `'${field(node, 'function').text}' does not return a value`)
      return result
    }
    default: {
      const handler = ctx.session.nodeHandlers.get(node.type)
      if (handler !== undefined) return handler(node, ctx) as IecValue
      throw fail(node, ctx, `unsupported construct ${node.type}`)
    }
  }
}

/** Resolve an assignable expression — variable, struct/FB member, array element — to its storage `Slot`. Member and element slots are live views: writing `value` updates the containing struct/array in place. */
export function evalLValue(node: Node, ctx: EvalContext): Slot {
  switch (node.type) {
    case 'identifier': {
      const slot = ctx.chain.lookup(node.text)
      if (slot === undefined) throw fail(node, ctx, `unknown variable '${node.text}'`)
      return slot
    }
    case 'parenthesized_expression':
      return evalLValue(inner(node), ctx)
    case 'member_access_expression':
      return memberSlot(node, ctx)
    case 'index_expression':
      return elementSlot(node, ctx)
    default:
      if (ctx.session.nodeHandlers.has(node.type) || !EXPRESSION_TYPES.includes(node.type)) {
        throw fail(node, ctx, `unsupported construct ${node.type}`)
      }
      throw fail(node, ctx, `'${node.text}' is not assignable`)
  }
}

/** Evaluate a call expression through `ctx.callPou`; `undefined` for a call without a result (valid as an invocation statement). Variables passed as arguments carry their `Slot` so VAR_IN_OUT parameters can alias them; `name => target` output bindings always carry the target's slot. */
export function evalCall(node: Node, ctx: EvalContext): IecValue | undefined {
  const callee = field(node, 'function').text
  const args: CallArg[] = []
  for (const arg of operands(field(node, 'arguments'))) {
    if (arg.type !== 'named_argument') {
      args.push(argument(arg, ctx))
      continue
    }
    const name = field(arg, 'name').text
    const valueNode = field(arg, 'value')
    if (arg.children.some((c) => c.type === '=>')) {
      const slot = evalLValue(valueNode, ctx)
      args.push({ name, value: slot.value, slot })
    } else {
      args.push({ name, ...argument(valueNode, ctx) })
    }
  }
  return ctx.callPou(callee, args, ctx)
}

/** Expression node types core evaluates itself (used to tell "not assignable" from "unsupported"). */
const EXPRESSION_TYPES: readonly string[] = [
  'boolean_literal',
  'integer_literal',
  'real_literal',
  'string_literal',
  'time_literal',
  'date_literal',
  'time_of_day_literal',
  'date_and_time_literal',
  'typed_literal',
  'parenthesized_expression',
  'identifier',
  'member_access_expression',
  'index_expression',
  'unary_expression',
  'binary_expression',
  'call_expression',
]

// ---------------------------------------------------------------------------
// Names, members, elements, calls.
// ---------------------------------------------------------------------------

function identifier(node: Node, ctx: EvalContext, enumHint: string | undefined): IecValue {
  const slot = ctx.chain.lookup(node.text)
  if (slot !== undefined) return slot.value
  const member = bareEnum(node, ctx, enumHint)
  if (member !== undefined) return member
  throw fail(node, ctx, `unknown identifier '${node.text}'`)
}

/** Resolve a bare enum member: first in `enumHint`, else by a unique search over every enum type; a member declared by several enums is an error. */
function bareEnum(node: Node, ctx: EvalContext, enumHint: string | undefined): EnumValue | undefined {
  const { symbols } = ctx
  const k = symbols.normalizeKey(node.text)
  if (enumHint !== undefined) {
    const info = symbols.getEnum(enumHint)
    const m = info?.members.find((x) => symbols.normalizeKey(x.name) === k)
    if (info !== undefined && m !== undefined) return { kind: 'enum', typeName: info.typeName, value: m.value }
  }
  const hits = symbols.getEnums().flatMap((info) =>
    info.members.filter((x) => symbols.normalizeKey(x.name) === k).map((m) => ({ typeName: info.typeName, value: m.value })),
  )
  if (hits.length > 1) {
    const owners = hits.map((h) => h.typeName).join(', ')
    throw fail(node, ctx, `ambiguous enum member '${node.text}' (declared by ${owners}); qualify it as <Type>.${node.text}`)
  }
  const hit = hits[0]
  return hit === undefined ? undefined : { kind: 'enum', ...hit }
}

/** True for a bare identifier (possibly parenthesised) that names no variable, i.e. a candidate bare enum member. */
function isBareName(node: Node, ctx: EvalContext): boolean {
  if (node.type === 'parenthesized_expression') return isBareName(inner(node), ctx)
  return node.type === 'identifier' && ctx.chain.lookup(node.text) === undefined
}

/** Identifier path of `a.b.c`, or `undefined` when the expression is not a pure name path. */
function namePath(node: Node): string[] | undefined {
  if (node.type === 'identifier') return [node.text]
  if (node.type !== 'member_access_expression') return undefined
  const head = namePath(field(node, 'object'))
  return head === undefined ? undefined : [...head, field(node, 'member').text]
}

/** `E_X.A` (or `NS.E_X.A`) when the path's root is not a variable and its last qualifier names an enum type. */
function qualifiedEnum(node: Node, ctx: EvalContext): EnumValue | undefined {
  const path = namePath(field(node, 'object'))
  if (path === undefined || ctx.chain.lookup(path[0]) !== undefined) return undefined
  const info = ctx.symbols.getEnum(path[path.length - 1])
  if (info === undefined) return undefined
  const member = field(node, 'member').text
  const k = ctx.symbols.normalizeKey(member)
  const m = info.members.find((x) => ctx.symbols.normalizeKey(x.name) === k)
  if (m === undefined) throw fail(node, ctx, `'${member}' is not a member of enum ${info.typeName}`)
  return { kind: 'enum', typeName: info.typeName, value: m.value }
}

/** Key under which `fields` stores `name`, honouring the session's case mode. */
function fieldKey(s: StructValue, name: string, ctx: EvalContext): string | undefined {
  if (s.fields.has(name)) return name
  const k = caseKey(name, ctx.session.caseSensitive)
  for (const key of s.fields.keys()) {
    if (caseKey(key, ctx.session.caseSensitive) === k) return key
  }
  return undefined
}

/** Struct field or FB instance member (inputs/outputs are fields of the instance value). */
function memberSlot(node: Node, ctx: EvalContext): Slot {
  const objectNode = field(node, 'object')
  const member = field(node, 'member').text
  const base = evalExpression(objectNode, ctx)
  if (base.kind !== 'struct') {
    throw fail(node, ctx, `'${objectNode.text}' is ${describe(base)}, not a structure or function block instance`)
  }
  const key = fieldKey(base, member, ctx)
  if (key === undefined) throw fail(node, ctx, `'${objectNode.text}' has no member '${member}'`)
  return {
    get value(): IecValue {
      return base.fields.get(key) as IecValue
    },
    set value(v: IecValue) {
      base.fields.set(key, v)
    },
  }
}

function arrayIndex(node: Node, ctx: EvalContext): number {
  const v = evalExpression(node, ctx)
  if (v.kind === 'enum') return v.value
  if (v.kind === 'scalar' && isIntType(v.type)) return Number(v.value)
  throw fail(node, ctx, `array index '${node.text}' must be an integer, got ${describe(v)}`)
}

/** Array element; indices are bounds-checked per dimension and laid out row-major (last index fastest). */
function elementSlot(node: Node, ctx: EvalContext): Slot {
  const objectNode = field(node, 'object')
  const base: IecValue = evalExpression(objectNode, ctx)
  if (base.kind !== 'array') throw fail(node, ctx, `'${objectNode.text}' is ${describe(base)}, not an array`)
  const arr: ArrayValue = base
  const indexNodes = node.childrenForFieldName('index').filter((c) => c.isNamed && c.type !== 'comment')
  if (indexNodes.length !== arr.dims.length) {
    throw fail(node, ctx, `'${objectNode.text}' has ${String(arr.dims.length)} dimension(s) but ${String(indexNodes.length)} index(es) were given`)
  }
  let flat = 0
  indexNodes.forEach((indexNode, i) => {
    const [lo, hi] = arr.dims[i]
    const idx = arrayIndex(indexNode, ctx)
    if (idx < lo || idx > hi) {
      throw fail(node, ctx, `index ${String(idx)} out of bounds [${String(lo)}..${String(hi)}] for ${objectNode.text}`)
    }
    flat = flat * (hi - lo + 1) + (idx - lo)
  })
  return {
    get value(): IecValue {
      return arr.data[flat]
    },
    set value(v: IecValue) {
      arr.data[flat] = v
    },
  }
}

/** True when `node` denotes storage (so a call argument can carry its slot). */
function isAddressable(node: Node, ctx: EvalContext): boolean {
  switch (node.type) {
    case 'identifier':
      return ctx.chain.lookup(node.text) !== undefined
    case 'parenthesized_expression':
      return isAddressable(inner(node), ctx)
    case 'member_access_expression':
    case 'index_expression':
      return isAddressable(field(node, 'object'), ctx)
    default:
      return false
  }
}

function argument(node: Node, ctx: EvalContext): { value: IecValue; slot?: Slot } {
  if (!isAddressable(node, ctx)) return { value: evalExpression(node, ctx) }
  const slot = evalLValue(node, ctx)
  return { value: slot.value, slot }
}

// ---------------------------------------------------------------------------
// Operators.
// ---------------------------------------------------------------------------

function unary(node: Node, ctx: EvalContext): IecValue {
  const op = operatorOf(node)
  const operandNode = field(node, 'operand')
  const v = expectScalar(evalExpression(operandNode, ctx), operandNode, ctx)
  if (op === 'NOT') {
    if (v.type === IecType.BOOL) return bool(!(v.value as boolean))
    if (isIntType(v.type)) return scalar(v.type, bitNot(v.value as Num, v.type))
    throw fail(node, ctx, `NOT is not applicable to ${v.type}`)
  }
  if (v.type === IecType.TIME) return op === '-' ? scalar(IecType.TIME, -toBig(v.value)) : scalar(IecType.TIME, toBig(v.value))
  if (!isNumericType(v.type)) throw fail(node, ctx, `unary ${op} is not applicable to ${v.type}`)
  if (op === '+') return v
  if (isIntType(v.type)) return scalar(v.type, located(node, ctx, () => sub(0, v.value as Num, v.type)))
  const negated = -(v.value as number)
  return scalar(v.type, v.type === IecType.REAL ? froundReal(negated) : negated)
}

function bitNot(v: Num, type: IecType): Num {
  return wrapInt(typeof v === 'bigint' ? ~v : ~v, type)
}

function binary(node: Node, ctx: EvalContext): IecValue {
  const op = operatorOf(node)
  const leftNode = field(node, 'left')
  const rightNode = field(node, 'right')
  // A bare enum member takes its type from the partner, so evaluate the partner first.
  let l: IecValue
  let r: IecValue
  if (isBareName(leftNode, ctx)) {
    r = evalExpression(rightNode, ctx)
    l = evalExpression(leftNode, ctx, r.kind === 'enum' ? r.typeName : undefined)
  } else {
    l = evalExpression(leftNode, ctx)
    r = evalExpression(rightNode, ctx, l.kind === 'enum' ? l.typeName : undefined)
  }

  switch (op) {
    case '=':
    case '<>': {
      const c = compare(l, r, node, ctx)
      return bool(op === '=' ? c === 0 : c !== 0)
    }
    case '<':
      return bool(compare(l, r, node, ctx) < 0)
    case '>':
      return bool(compare(l, r, node, ctx) > 0)
    case '<=':
      return bool(compare(l, r, node, ctx) <= 0)
    case '>=':
      return bool(compare(l, r, node, ctx) >= 0)
    default:
      break
  }

  const ls = expectScalar(l, leftNode, ctx)
  const rs = expectScalar(r, rightNode, ctx)
  if (op === 'AND' || op === '&' || op === 'OR' || op === 'XOR') {
    return logical(op, ls, rs, node, ctx)
  }
  return located(node, ctx, () => arithmetic(op, ls, isUntypedLiteral(leftNode), rs, isUntypedLiteral(rightNode), node, ctx))
}

/** BOOL logic, or bitwise logic on integer/bit-string operands in their common type. */
function logical(op: string, l: Scalar, r: Scalar, node: Node, ctx: EvalContext): Scalar {
  if (l.type === IecType.BOOL && r.type === IecType.BOOL) {
    const a = l.value as boolean
    const b = r.value as boolean
    return bool(op === 'OR' ? a || b : op === 'XOR' ? a !== b : a && b)
  }
  if (!isIntType(l.type) || !isIntType(r.type)) throw fail(node, ctx, `${op} is not applicable to ${l.type} and ${r.type}`)
  const type = located(node, ctx, () => commonType(l, isUntypedLiteral(field(node, 'left')), r, isUntypedLiteral(field(node, 'right'))))
  const a = toBig(l.value)
  const b = toBig(r.value)
  const result = op === 'OR' ? a | b : op === 'XOR' ? a ^ b : a & b
  return scalar(type, wrapInt(represent(result, type), type))
}

function arithmetic(op: string, l: Scalar, lUntyped: boolean, r: Scalar, rUntyped: boolean, node: Node, ctx: EvalContext): Scalar {
  if (l.type === IecType.TIME || r.type === IecType.TIME) return timeArithmetic(op, l, r, node, ctx)
  if (!isNumericType(l.type) || !isNumericType(r.type)) {
    throw fail(node, ctx, `operator ${op} is not applicable to ${l.type} and ${r.type}`)
  }
  const type = commonType(l, lUntyped, r, rUntyped)
  const a = l.value as Num
  const b = r.value as Num
  switch (op) {
    case '+':
      return scalar(type, add(a, b, type))
    case '-':
      return scalar(type, sub(a, b, type))
    case '*':
      return scalar(type, mul(a, b, type))
    case '/':
      return scalar(type, div(a, b, type))
    case 'MOD':
      return scalar(type, mod(a, b, type))
    case '**': {
      const realType = isFloatType(type) ? type : IecType.LREAL
      return scalar(realType, pow(a, b, realType))
    }
    default:
      throw fail(node, ctx, `unsupported operator ${op}`)
  }
}

/** TIME ± TIME, TIME * ANY_NUM, ANY_NUM * TIME and TIME / ANY_NUM, all in nanoseconds. */
function timeArithmetic(op: string, l: Scalar, r: Scalar, node: Node, ctx: EvalContext): Scalar {
  const time = (v: bigint): Scalar => scalar(IecType.TIME, v)
  const scale = (t: Scalar, n: Scalar, f: (a: bigint, b: bigint) => bigint, g: (a: number, b: number) => number): Scalar => {
    if (isIntType(n.type)) return time(f(toBig(t.value), toBig(n.value)))
    return time(BigInt(Math.trunc(g(Number(t.value), n.value as number))))
  }
  const lt = l.type === IecType.TIME
  const rt = r.type === IecType.TIME
  if (lt && rt && (op === '+' || op === '-')) {
    return time(op === '+' ? toBig(l.value) + toBig(r.value) : toBig(l.value) - toBig(r.value))
  }
  if (op === '*' && lt !== rt) {
    const [t, n] = lt ? [l, r] : [r, l]
    if (isNumericType(n.type)) return scale(t, n, (a, b) => a * b, (a, b) => a * b)
  }
  if (op === '/' && lt && !rt && isNumericType(r.type)) {
    if (Number(r.value) === 0) throw new IecRuntimeError('division by zero')
    return scale(l, r, (a, b) => a / b, (a, b) => a / b)
  }
  throw fail(node, ctx, `operator ${op} is not applicable to ${l.type} and ${r.type}`)
}

/** Three-way comparison; NaN when either operand is a floating-point NaN (so only `<>` holds). */
function compare(l: IecValue, r: IecValue, node: Node, ctx: EvalContext): number {
  const mismatch = (): IecRuntimeError => fail(node, ctx, `cannot compare ${describe(l)} with ${describe(r)}`)
  if (l.kind === 'enum' || r.kind === 'enum') {
    if (l.kind === 'enum' && r.kind === 'enum') {
      if (l.typeName !== '' && r.typeName !== '' && ctx.symbols.normalizeKey(l.typeName) !== ctx.symbols.normalizeKey(r.typeName)) {
        throw mismatch()
      }
      return Math.sign(l.value - r.value)
    }
    // Enum against an integer compares the underlying value (dialects allow the implicit conversion).
    const [e, s, sign] = l.kind === 'enum' ? [l, r, 1] : [r as EnumValue, l, -1]
    if (s.kind !== 'scalar' || !isIntType(s.type)) throw mismatch()
    return sign * Math.sign(e.value - Number(s.value))
  }
  if (l.kind !== 'scalar' || r.kind !== 'scalar') throw mismatch()
  if (l.type === IecType.BOOL && r.type === IecType.BOOL) return Number(l.value) - Number(r.value)
  if (isStringType(l.type) && isStringType(r.type)) {
    const a = l.value as string
    const b = r.value as string
    return a < b ? -1 : a > b ? 1 : 0
  }
  if (l.type === IecType.TIME && r.type === IecType.TIME) return bigCompare(toBig(l.value), toBig(r.value))
  if (isNumericType(l.type) && isNumericType(r.type)) {
    if (isIntType(l.type) && isIntType(r.type)) return bigCompare(toBig(l.value), toBig(r.value))
    const a = Number(l.value)
    const b = Number(r.value)
    if (Number.isNaN(a) || Number.isNaN(b)) return NaN
    return Math.sign(a - b)
  }
  throw mismatch()
}

function bigCompare(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0
}

// ---------------------------------------------------------------------------
// Literals.
// ---------------------------------------------------------------------------

const DINT_MIN = -(2n ** 31n)
const DINT_MAX = 2n ** 31n - 1n
const LINT_MIN = -(2n ** 63n)
const LINT_MAX = 2n ** 63n - 1n
const ULINT_MAX = 2n ** 64n - 1n

/** Integer literal text (sign, `2#`/`8#`/`16#` base prefix, `_` separators) as an exact bigint. */
function parseInteger(text: string): bigint {
  let s = text.trim().replace(/_/g, '')
  const negative = s.startsWith('-')
  if (s.startsWith('-') || s.startsWith('+')) s = s.slice(1)
  const m = /^(2|8|16)#(.+)$/.exec(s)
  const prefix = m === null ? '' : m[1] === '16' ? '0x' : m[1] === '8' ? '0o' : '0b'
  const v = BigInt(prefix + (m === null ? s : m[2]))
  return negative ? -v : v
}

function parseReal(text: string): number {
  return Number(text.replace(/_/g, ''))
}

/** Untyped integer literal: DINT when it fits, else LINT, else ULINT. */
function untypedInteger(node: Node, ctx: EvalContext): Scalar {
  const v = parseInteger(node.text)
  if (v >= DINT_MIN && v <= DINT_MAX) return scalar(IecType.DINT, Number(v))
  if (v >= LINT_MIN && v <= LINT_MAX) return scalar(IecType.LINT, v)
  if (v >= 0n && v <= ULINT_MAX) return scalar(IecType.ULINT, v)
  throw fail(node, ctx, `integer literal ${node.text} is out of range`)
}

const STRING_ESCAPES: Record<string, string> = { $: '$', "'": "'", '"': '"', L: '\n', N: '\n', P: '\f', R: '\r', T: '\t' }

/** Decode a quoted STRING ('…', `$hh` escapes) or WSTRING ("…", `$hhhh` escapes) literal. */
function decodeString(quoted: string, node: Node, ctx: EvalContext): { type: IecType; value: string } {
  const wide = quoted.startsWith('"')
  const body = quoted.slice(1, -1)
  const hexLen = wide ? 4 : 2
  let out = ''
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c !== '$') {
      out += c
      continue
    }
    const named = STRING_ESCAPES[body.charAt(i + 1).toUpperCase()] as string | undefined
    if (named !== undefined) {
      out += named
      i += 1
      continue
    }
    const hex = body.slice(i + 1, i + 1 + hexLen)
    if (!new RegExp(`^[0-9A-Fa-f]{${String(hexLen)}}$`).test(hex)) throw fail(node, ctx, `invalid escape in string literal ${quoted}`)
    out += String.fromCharCode(parseInt(hex, 16))
    i += hexLen
  }
  return { type: wide ? IecType.WSTRING : IecType.STRING, value: out }
}

function stringLiteral(node: Node, ctx: EvalContext): Scalar {
  const { type, value } = decodeString(node.text, node, ctx)
  return scalar(type, value)
}

/** Text after the `PREFIX#` of a date/time literal. */
function literalBody(node: Node): string {
  return node.text.slice(node.text.indexOf('#') + 1)
}

const UNIT_NS: Record<string, bigint> = {
  d: 86_400_000_000_000n,
  h: 3_600_000_000_000n,
  m: 60_000_000_000n,
  s: 1_000_000_000n,
  ms: 1_000_000n,
  us: 1_000n,
  ns: 1n,
}

/** `amount` (digits with an optional `.fraction`) times `unit` nanoseconds, truncated to whole nanoseconds. */
function scaled(amount: string, unit: bigint): bigint {
  const [whole, fraction = ''] = amount.split('.')
  const frac = fraction === '' ? 0n : (BigInt(fraction) * unit) / 10n ** BigInt(fraction.length)
  return BigInt(whole) * unit + frac
}

/** `T#`/`TIME#`/`LTIME#` duration, including compound forms like `T#1h2m3s4ms`, in nanoseconds. */
function parseDuration(node: Node, ctx: EvalContext): bigint {
  let body = literalBody(node)
  const negative = body.startsWith('-')
  if (body.startsWith('-') || body.startsWith('+')) body = body.slice(1)
  let total = 0n
  let consumed = 0
  for (const m of body.matchAll(/(\d+(?:\.\d+)?)(ms|us|ns|d|h|m|s)/gi)) {
    total += scaled(m[1], UNIT_NS[m[2].toLowerCase()])
    consumed += m[0].length
  }
  if (consumed !== body.length || consumed === 0) throw fail(node, ctx, `invalid time literal ${node.text}`)
  return negative ? -total : total
}

/** Milliseconds since the epoch of `yyyy-mm-dd`, validated (no day/month roll-over). */
function dateMs(text: string, node: Node, ctx: EvalContext): number {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text)
  if (m === null) throw fail(node, ctx, `invalid date literal ${node.text}`)
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const date = new Date(Date.UTC(y, mo - 1, d))
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) {
    throw fail(node, ctx, `invalid date literal ${node.text}`)
  }
  return date.getTime()
}

function parseDate(text: string, node: Node, ctx: EvalContext): bigint {
  return BigInt(dateMs(text, node, ctx)) * 1_000_000n
}

/** `hh:mm:ss(.fraction)` as nanoseconds since midnight. */
function parseTimeOfDay(text: string, node: Node, ctx: EvalContext): bigint {
  const m = /^(\d{1,2}):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(text)
  if (m === null) throw fail(node, ctx, `invalid time-of-day literal ${node.text}`)
  const [h, min] = [Number(m[1]), Number(m[2])]
  const sec = scaled(m[3], UNIT_NS.s)
  if (h > 23 || min > 59 || sec >= 60n * UNIT_NS.s) throw fail(node, ctx, `invalid time-of-day literal ${node.text}`)
  return BigInt(h) * UNIT_NS.h + BigInt(min) * UNIT_NS.m + sec
}

/** `yyyy-mm-dd-hh:mm:ss(.fraction)` as nanoseconds since the epoch. */
function parseDateAndTime(node: Node, ctx: EvalContext): bigint {
  // The date is the first three '-'-separated fields, the time of day the fourth.
  const parts = literalBody(node).split('-')
  if (parts.length !== 4) throw fail(node, ctx, `invalid date-and-time literal ${node.text}`)
  return parseDate(parts.slice(0, 3).join('-'), node, ctx) + parseTimeOfDay(parts[3], node, ctx)
}

/** `TYPE#value` (e.g. `INT#5`, `BYTE#16#F0`, `REAL#1e3`, `BOOL#1`, `WSTRING#"x"`), range-checked against the type. */
function typedLiteral(node: Node, ctx: EvalContext): Scalar {
  const typeName = field(node, 'type').text
  const valueNode = field(node, 'value')
  const type = elementaryType(typeName)
  if (type === undefined) throw fail(node, ctx, `unknown literal type '${typeName}'`)
  const bad = (): IecRuntimeError => fail(node, ctx, `invalid ${typeName} literal ${node.text}`)

  if (type === IecType.BOOL) {
    if (valueNode.type === 'boolean_literal') return bool(valueNode.text.toUpperCase() === 'TRUE')
    if (valueNode.type !== 'integer_literal') throw bad()
    const v = parseInteger(valueNode.text)
    if (v !== 0n && v !== 1n) throw bad()
    return bool(v === 1n)
  }
  if (isStringType(type)) {
    if (valueNode.type !== 'string_literal') throw bad()
    return scalar(type, decodeString(valueNode.text, valueNode, ctx).value)
  }
  if (isFloatType(type)) {
    if (valueNode.type !== 'integer_literal' && valueNode.type !== 'real_literal') throw bad()
    const n = valueNode.type === 'integer_literal' ? Number(parseInteger(valueNode.text)) : parseReal(valueNode.text)
    return scalar(type, type === IecType.REAL ? froundReal(n) : n)
  }
  if (isIntType(type)) {
    if (valueNode.type !== 'integer_literal') throw bad()
    const v = parseInteger(valueNode.text)
    if (toBig(wrapInt(v, type)) !== v) throw fail(node, ctx, `literal ${valueNode.text} is out of range for ${type}`)
    return scalar(type, represent(v, type))
  }
  throw bad()
}
