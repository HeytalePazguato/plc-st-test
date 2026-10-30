/**
 * IEC 61131-3 type conversions as host functions: every `<A>_TO_<B>` among the elementary types plus the generic `TO_<B>` forms.
 *
 * Rules: REAL/LREAL to an integer rounds to nearest with ties to even; narrowing between integers wraps like the PLC does; BOOL converts to and from 0/1; TIME converts to and from integer or real milliseconds (DATE, TOD and DT share the TIME representation); STRING/WSTRING converts to and from numbers using IEC literal syntax (`16#FF`, `1_000`, `2.5E3`, `T#1s500ms`, `TRUE`). The source category is taken from the actual argument, so `INT_TO_SINT(200)` works on the untyped literal 200. A value that cannot be represented (NaN, infinity, an unparsable string) is an IecRuntimeError.
 */
import type { HostFnDef, IecType, IecValue } from '@plc-st/plugin-api'
import { IecRuntimeError } from '../../errors.js'
import { formatReal, formatTime } from '../../format.js'
import { isBigIntType, isIntType } from '../numeric.js'
import { fixedNames, hostFn, isRealType, isStringType, makeNumber, orderArgs, roundHalfEven, scalarAt, type Scalar } from './fnutil.js'

const INT_NAMES = ['SINT', 'INT', 'DINT', 'LINT', 'USINT', 'UINT', 'UDINT', 'ULINT', 'BYTE', 'WORD', 'DWORD', 'LWORD'] as const
/** Every type name that appears in a conversion function name; DATE, TOD and DT map onto TIME. */
const TYPE_NAMES = [...INT_NAMES, 'REAL', 'LREAL', 'BOOL', 'TIME', 'DATE', 'TOD', 'DT', 'STRING', 'WSTRING'] as const

const NS_PER_MS = 1_000_000n

/** The value-model type behind a conversion type name. */
function modelType(name: string): IecType {
  return name === 'DATE' || name === 'TOD' || name === 'DT' ? 'TIME' : (name as IecType)
}

/** Parses an IEC integer literal: optional sign, `_` separators, and `2#`/`8#`/`16#` bases. */
function parseIntegerText(fn: string, text: string): bigint {
  const t = text.trim().replace(/_/g, '')
  const m = /^([+-]?)(?:(2|8|16)#)?([0-9A-Fa-f]+)$/.exec(t)
  if (m === null) throw new IecRuntimeError(`${fn}: '${text}' is not an integer`)
  const [, sign, base, digits] = m
  const prefix = base === '2' ? '0b' : base === '8' ? '0o' : base === '16' ? '0x' : ''
  if (prefix === '' && !/^\d+$/.test(digits)) throw new IecRuntimeError(`${fn}: '${text}' is not an integer`)
  const v = BigInt(prefix + digits)
  return sign === '-' ? -v : v
}

/** Parses an IEC real literal (`1.5`, `-2.5E3`, `1_000.25`). */
function parseRealText(fn: string, text: string): number {
  const t = text.trim().replace(/_/g, '')
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(t)) throw new IecRuntimeError(`${fn}: '${text}' is not a number`)
  return Number(t)
}

const TIME_UNITS: Record<string, number> = { d: 86_400_000_000_000, h: 3_600_000_000_000, m: 60_000_000_000, s: 1_000_000_000, ms: 1_000_000, us: 1_000, ns: 1 }

/** Parses a TIME literal (`T#1h2m3s4ms`, `TIME#-500ms`, bare `1s500ms`) into nanoseconds. */
function parseTimeText(fn: string, text: string): bigint {
  const t = text.trim().replace(/_/g, '').replace(/^(T|TIME|LTIME)#/i, '')
  const m = /^([+-]?)(.+)$/.exec(t)
  const body = m?.[2] ?? ''
  const parts = [...body.matchAll(/(\d+(?:\.\d+)?)(ms|us|ns|d|h|m|s)/gi)]
  if (parts.length === 0 || parts.map((p) => p[0]).join('') !== body) throw new IecRuntimeError(`${fn}: '${text}' is not a TIME literal`)
  let ns = 0
  for (const [, amount, unit] of parts) ns += Number(amount) * TIME_UNITS[unit.toLowerCase()]
  const total = BigInt(Math.round(ns))
  return m?.[1] === '-' ? -total : total
}

function fail(fn: string, v: Scalar, target: string): never {
  throw new IecRuntimeError(`${fn}: cannot convert ${v.type} ${String(v.value)} to ${target}`)
}

/** Rounds a real to an integer of `type` (ties to even) and wraps it. */
function realToInt(fn: string, x: number, type: IecType): IecValue {
  if (!Number.isFinite(x)) throw new IecRuntimeError(`${fn}: cannot convert ${String(x)} to ${type}`)
  const r = roundHalfEven(x)
  return makeNumber(type, isBigIntType(type) ? BigInt(r) : r)
}

function toInteger(fn: string, v: Scalar, type: IecType): IecValue {
  if (typeof v.value === 'boolean') return makeNumber(type, v.value ? 1 : 0)
  if (isIntType(v.type)) return makeNumber(type, v.value as number | bigint)
  if (isRealType(v.type)) return realToInt(fn, Number(v.value), type)
  if (v.type === 'TIME') return makeNumber(type, (v.value as bigint) / NS_PER_MS)
  if (isStringType(v.type)) return makeNumber(type, parseIntegerText(fn, String(v.value)))
  return fail(fn, v, type)
}

function toReal(fn: string, v: Scalar, type: IecType): IecValue {
  if (typeof v.value === 'boolean') return makeNumber(type, v.value ? 1 : 0)
  if (isIntType(v.type) || isRealType(v.type)) return makeNumber(type, Number(v.value))
  if (v.type === 'TIME') return makeNumber(type, Number(v.value as bigint) / 1e6)
  if (isStringType(v.type)) return makeNumber(type, parseRealText(fn, String(v.value)))
  return fail(fn, v, type)
}

function toBool(fn: string, v: Scalar): IecValue {
  const bool = (value: boolean): IecValue => ({ kind: 'scalar', type: 'BOOL', value })
  if (typeof v.value === 'boolean') return bool(v.value)
  if (typeof v.value === 'number' || typeof v.value === 'bigint') return bool(Number(v.value) !== 0)
  const s = String(v.value).trim().toUpperCase()
  if (s === 'TRUE' || s === '1') return bool(true)
  if (s === 'FALSE' || s === '0') return bool(false)
  return fail(fn, v, 'BOOL')
}

function toTime(fn: string, v: Scalar, target: string): IecValue {
  const time = (ns: bigint): IecValue => ({ kind: 'scalar', type: 'TIME', value: ns })
  if (v.type === 'TIME') return time(v.value as bigint)
  if (typeof v.value === 'boolean') return time(v.value ? NS_PER_MS : 0n)
  if (isIntType(v.type)) return time(BigInt(v.value as number | bigint) * NS_PER_MS)
  if (isRealType(v.type)) {
    const ms = Number(v.value)
    if (!Number.isFinite(ms)) return fail(fn, v, target)
    return time(BigInt(Math.round(ms * 1e6)))
  }
  if (isStringType(v.type) && target === 'TIME') return time(parseTimeText(fn, String(v.value)))
  return fail(fn, v, target)
}

function toText(v: Scalar, type: 'STRING' | 'WSTRING'): IecValue {
  let text: string
  if (typeof v.value === 'boolean') text = v.value ? 'TRUE' : 'FALSE'
  else if (v.type === 'TIME') text = formatTime(v.value as bigint)
  else if (isRealType(v.type)) text = formatReal(Number(v.value), v.type === 'REAL')
  else text = String(v.value)
  return { kind: 'scalar', type, value: text }
}

/** Converts one elementary value to the type named `target` (a TYPE_NAMES entry). */
export function convertScalar(fn: string, v: Scalar, target: string): IecValue {
  const type = modelType(target)
  if (isIntType(type)) return toInteger(fn, v, type)
  if (isRealType(type)) return toReal(fn, v, type)
  if (type === 'BOOL') return toBool(fn, v)
  if (type === 'TIME') return toTime(fn, v, target)
  if (type === 'STRING' || type === 'WSTRING') return toText(v, type)
  return fail(fn, v, target)
}

function converter(name: string, target: string): HostFnDef {
  return hostFn(name, 1, 1, (raw) => {
    const args = orderArgs(name, raw, fixedNames(['IN']))
    return convertScalar(name, scalarAt(name, args, 0), target)
  })
}

function buildConversions(): HostFnDef[] {
  const defs: HostFnDef[] = []
  for (const to of TYPE_NAMES) {
    defs.push(converter(`TO_${to}`, to))
    for (const from of TYPE_NAMES) if (from !== to) defs.push(converter(`${from}_TO_${to}`, to))
  }
  return defs
}

export const CONVERSION_FNS: readonly HostFnDef[] = buildConversions()
