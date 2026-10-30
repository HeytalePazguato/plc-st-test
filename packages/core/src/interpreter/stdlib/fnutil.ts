/**
 * Shared helpers for the standard-library host functions (strings, math, selection, conversion): argument ordering for positional and formal (named) calls, scalar extraction, numeric coercion, and IEC rounding.
 */
import type { CallArg, HostFnDef, IecType, IecValue } from '@plc-st/plugin-api'
import { IecRuntimeError } from '../../errors.js'
import { froundReal, isBigIntType, isIntType, wrapInt } from '../numeric.js'

export type Scalar = Extract<IecValue, { kind: 'scalar' }>

/** Upper bound for variadic functions (CONCAT, MIN, MAX, MUX). */
export const VARIADIC_MAX = 255

/** Builds a host function definition. */
export function hostFn(name: string, minArgs: number, maxArgs: number, call: HostFnDef['call']): HostFnDef {
  return { name, minArgs, maxArgs, call }
}

/**
 * Returns the arguments in parameter order. A positional call is returned unchanged; a formal call (`LEFT(IN := s, L := 3)`) is reordered by the IEC parameter names, so both styles reach the implementation identically.
 */
export function orderArgs(fn: string, args: CallArg[], paramName: (i: number) => string): CallArg[] {
  if (!args.some((a) => a.name !== undefined)) return args
  const byName = new Map(args.map((a) => [(a.name ?? '').toUpperCase(), a]))
  return args.map((_, i) => {
    const a = byName.get(paramName(i).toUpperCase())
    if (a === undefined) throw new IecRuntimeError(`${fn}: missing argument ${paramName(i)}`)
    return a
  })
}

/** The parameter-name function for a fixed signature such as `['IN', 'L', 'P']`. */
export function fixedNames(names: readonly string[]): (i: number) => string {
  return (i) => names[i] ?? `IN${String(i + 1)}`
}

/** The i-th argument as an elementary value. */
export function scalarAt(fn: string, args: CallArg[], i: number): Scalar {
  const a = args[i]
  if (a === undefined) throw new IecRuntimeError(`${fn}: missing argument ${String(i + 1)}`)
  if (a.value.kind !== 'scalar') throw new IecRuntimeError(`${fn}: argument ${String(i + 1)} must be an elementary value, got ${a.value.kind}`)
  return a.value
}

export const isRealType = (t: IecType): boolean => t === 'REAL' || t === 'LREAL'
export const isNumericType = (t: IecType): boolean => isIntType(t) || isRealType(t)
export const isStringType = (t: IecType): boolean => t === 'STRING' || t === 'WSTRING'

/** The i-th argument as a JS integer (for lengths, positions and selectors). */
export function intAt(fn: string, args: CallArg[], i: number): number {
  const v = scalarAt(fn, args, i)
  if (!isIntType(v.type)) throw new IecRuntimeError(`${fn}: argument ${String(i + 1)} must be an integer, got ${v.type}`)
  return Number(v.value)
}

/** A numeric scalar as a JS number (BOOL counts as 0/1). */
export function toNumber(fn: string, v: Scalar): number {
  if (typeof v.value === 'number') return v.value
  if (typeof v.value === 'bigint') return Number(v.value)
  if (typeof v.value === 'boolean') return v.value ? 1 : 0
  throw new IecRuntimeError(`${fn}: expected a number, got ${v.type}`)
}

/** Builds a numeric value of `type`, applying the IEC wrap (integers) or 32-bit rounding (REAL). */
export function makeNumber(type: IecType, value: number | bigint): IecValue {
  if (isIntType(type)) {
    const wrapped = wrapInt(value, type)
    return { kind: 'scalar', type, value: isBigIntType(type) ? BigInt(wrapped) : Number(wrapped) }
  }
  if (type === 'REAL') return { kind: 'scalar', type, value: froundReal(Number(value)) }
  return { kind: 'scalar', type, value: Number(value) }
}

/** IEC 61131-3 REAL-to-integer rounding: to nearest, ties to even (2.5 → 2, 3.5 → 4, -2.5 → -2). */
export function roundHalfEven(x: number): number {
  const floor = Math.floor(x)
  const diff = x - floor
  if (diff > 0.5) return floor + 1
  if (diff < 0.5) return floor
  return floor % 2 === 0 ? floor : floor + 1
}
