/**
 * IEC 61131-3 numeric fidelity.
 *
 * JavaScript numbers are IEEE-754 doubles, but PLC numerics have fixed bit widths, signedness, and two's-complement wrap-around. This module enforces that fidelity so that, e.g., `SINT` 127 + 1 yields -128 rather than 128, and `REAL` arithmetic is rounded to 32-bit precision.
 *
 * Representation rule:
 *   - Types up to 32 bits are represented as JS `number` (safe-integer range).
 *   - 64-bit types (LINT/ULINT/LWORD) exceed the safe-integer range and are represented as `bigint`.
 */

import { IecRuntimeError } from '../errors.js'

/** Elementary IEC 61131-3 types (string enum for stable, debuggable values). */
export enum IecType {
  BOOL = 'BOOL',
  BYTE = 'BYTE',
  WORD = 'WORD',
  DWORD = 'DWORD',
  LWORD = 'LWORD',
  SINT = 'SINT',
  USINT = 'USINT',
  INT = 'INT',
  UINT = 'UINT',
  DINT = 'DINT',
  UDINT = 'UDINT',
  LINT = 'LINT',
  ULINT = 'ULINT',
  REAL = 'REAL',
  LREAL = 'LREAL',
  TIME = 'TIME',
  STRING = 'STRING',
  WSTRING = 'WSTRING',
}

/** Bit width + signedness metadata for the integer/bit types. */
interface IntMeta {
  bits: 8 | 16 | 32 | 64
  signed: boolean
}

const INT_META: Partial<Record<IecType, IntMeta>> = {
  // Bit-string types are always unsigned.
  [IecType.BYTE]: { bits: 8, signed: false },
  [IecType.WORD]: { bits: 16, signed: false },
  [IecType.DWORD]: { bits: 32, signed: false },
  [IecType.LWORD]: { bits: 64, signed: false },
  // Signed integers.
  [IecType.SINT]: { bits: 8, signed: true },
  [IecType.INT]: { bits: 16, signed: true },
  [IecType.DINT]: { bits: 32, signed: true },
  [IecType.LINT]: { bits: 64, signed: true },
  // Unsigned integers.
  [IecType.USINT]: { bits: 8, signed: false },
  [IecType.UINT]: { bits: 16, signed: false },
  [IecType.UDINT]: { bits: 32, signed: false },
  [IecType.ULINT]: { bits: 64, signed: false },
}

/** True for the 64-bit types, which exceed JS safe-integer range (use BigInt). */
export function isBigIntType(t: IecType): boolean {
  return t === IecType.LINT || t === IecType.ULINT || t === IecType.LWORD
}

/** True for any integer/bit type (has bit-width metadata). */
function isIntType(t: IecType): boolean {
  return INT_META[t] !== undefined
}

function metaOf(t: IecType): IntMeta {
  const m = INT_META[t]
  if (m === undefined) {
    throw new IecRuntimeError(`type ${t} is not an integer type`)
  }
  return m
}

/**
 * Exact two's-complement wrap of `v` into the bit width of type `t`.
 *
 * For ≤32-bit types the work is done in `number` (manual modulo on the 2^width ring, then mapped into the signed or unsigned range). For 64-bit types it is done in `bigint` via BigInt.asIntN / asUintN. The returned representation matches the type (number for ≤32-bit, bigint for 64-bit).
 */
export function wrapInt(v: number | bigint, t: IecType): number | bigint {
  const { bits, signed } = metaOf(t)

  if (bits === 64) {
    const b = typeof v === 'bigint' ? v : BigInt(Math.trunc(v))
    return signed ? BigInt.asIntN(64, b) : BigInt.asUintN(64, b)
  }

  // ≤32-bit: operate in number on the 2^bits ring.
  const n = typeof v === 'bigint' ? Number(BigInt.asIntN(64, v)) : Math.trunc(v)
  const ring = 2 ** bits
  // JS `%` can yield negative results; normalise into [0, ring).
  let u = n % ring
  if (u < 0) u += ring
  if (signed) {
    const half = ring / 2
    return u >= half ? u - ring : u
  }
  return u
}

/** Round to 32-bit IEEE-754 precision (REAL). LREAL stays a full double. */
export function froundReal(n: number): number {
  return Math.fround(n)
}

/**
 * Implicit-widening common type per IEC 61131-3.
 *
 * Rule: assign each numeric type a rank; the wider (higher rank) type wins.
 *   - Any mix involving a float widens to the float: REAL < LREAL beats all ints.
 *   - Integer ranks follow bit width: 8 < 16 < 32 < 64, with the unsigned analogue sharing the rank of its signed sibling at the same width, and bit-string types ranked by their width as well.
 *   - When two operands have the same rank the first operand's type is kept (callers that need a specific signedness/representation can override).
 * Non-numeric types (BOOL/TIME/STRING/WSTRING) are not widened here.
 */
export function widen(ta: IecType, tb: IecType): IecType {
  const ra = rank(ta)
  const rb = rank(tb)
  if (ra < 0 || rb < 0) {
    throw new IecRuntimeError(`cannot widen non-numeric types ${ta} and ${tb}`)
  }
  if (ra === rb) return ta
  return ra > rb ? ta : tb
}

/** Widening rank. Higher = wider. Floats rank above all integers. -1 = N/A. */
function rank(t: IecType): number {
  switch (t) {
    // 8-bit integers/bit-strings.
    case IecType.SINT:
    case IecType.USINT:
    case IecType.BYTE:
      return 1
    // 16-bit.
    case IecType.INT:
    case IecType.UINT:
    case IecType.WORD:
      return 2
    // 32-bit.
    case IecType.DINT:
    case IecType.UDINT:
    case IecType.DWORD:
      return 3
    // 64-bit.
    case IecType.LINT:
    case IecType.ULINT:
    case IecType.LWORD:
      return 4
    // Floats outrank every integer.
    case IecType.REAL:
      return 5
    case IecType.LREAL:
      return 6
    default:
      return -1
  }
}

/** Coerce a raw arithmetic result into the representation/range of `type`. */
function coerce(v: number | bigint, type: IecType): number | bigint {
  if (isIntType(type)) {
    return wrapInt(v, type)
  }
  if (type === IecType.REAL) {
    return froundReal(v as number)
  }
  // LREAL (and any other float): plain double.
  return v as number
}

/** Operand pair coerced to a matching numeric representation for `type`. */
function operands(
  a: number | bigint,
  b: number | bigint,
  type: IecType,
): [number, number] | [bigint, bigint] {
  if (isBigIntType(type)) {
    return [toBig(a), toBig(b)]
  }
  return [toNum(a), toNum(b)]
}

function toBig(v: number | bigint): bigint {
  return typeof v === 'bigint' ? v : BigInt(Math.trunc(v))
}

function toNum(v: number | bigint): number {
  return typeof v === 'bigint' ? Number(v) : v
}

export function add(a: number | bigint, b: number | bigint, type: IecType): number | bigint {
  if (isBigIntType(type)) {
    const [x, y] = operands(a, b, type) as [bigint, bigint]
    return coerce(x + y, type)
  }
  const [x, y] = operands(a, b, type) as [number, number]
  return coerce(x + y, type)
}

export function sub(a: number | bigint, b: number | bigint, type: IecType): number | bigint {
  if (isBigIntType(type)) {
    const [x, y] = operands(a, b, type) as [bigint, bigint]
    return coerce(x - y, type)
  }
  const [x, y] = operands(a, b, type) as [number, number]
  return coerce(x - y, type)
}

export function mul(a: number | bigint, b: number | bigint, type: IecType): number | bigint {
  if (isBigIntType(type)) {
    const [x, y] = operands(a, b, type) as [bigint, bigint]
    return coerce(x * y, type)
  }
  const [x, y] = operands(a, b, type) as [number, number]
  return coerce(x * y, type)
}

/** Division. Integer types truncate toward zero; division by zero throws. */
export function div(a: number | bigint, b: number | bigint, type: IecType): number | bigint {
  if (isBigIntType(type)) {
    const [x, y] = operands(a, b, type) as [bigint, bigint]
    if (y === 0n) throw new IecRuntimeError('division by zero')
    // bigint `/` already truncates toward zero.
    return coerce(x / y, type)
  }
  const [x, y] = operands(a, b, type) as [number, number]
  if (isIntType(type)) {
    if (y === 0) throw new IecRuntimeError('division by zero')
    return coerce(Math.trunc(x / y), type)
  }
  // Float division: IEC has no "divide by zero" for REAL (yields inf/NaN),
  // but ST treats it as a runtime fault, so we guard it too.
  if (y === 0) throw new IecRuntimeError('division by zero')
  return coerce(x / y, type)
}

/** Modulo. Truncated-division remainder (sign follows dividend); /0 throws. */
export function mod(a: number | bigint, b: number | bigint, type: IecType): number | bigint {
  if (isBigIntType(type)) {
    const [x, y] = operands(a, b, type) as [bigint, bigint]
    if (y === 0n) throw new IecRuntimeError('division by zero')
    return coerce(x % y, type)
  }
  const [x, y] = operands(a, b, type) as [number, number]
  if (y === 0) throw new IecRuntimeError('division by zero')
  // JS `%` is the truncated remainder, matching IEC MOD semantics.
  const r = x % y
  return coerce(isIntType(type) ? Math.trunc(r) : r, type)
}

export function pow(a: number | bigint, b: number | bigint, type: IecType): number | bigint {
  if (isBigIntType(type)) {
    const [x, y] = operands(a, b, type) as [bigint, bigint]
    if (y < 0n) {
      throw new IecRuntimeError('negative exponent on integer power')
    }
    return coerce(x ** y, type)
  }
  const [x, y] = operands(a, b, type) as [number, number]
  return coerce(Math.pow(x, y), type)
}
