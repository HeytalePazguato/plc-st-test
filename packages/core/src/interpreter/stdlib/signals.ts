import type { FbIo } from '@plc-st/plugin-api'
import { IecType } from '../numeric.js'
import type { IecValue } from '../values.js'

/** Reads a BOOL input or output of a stub as a JS boolean. */
export function readBool(io: FbIo, name: string): boolean {
  const v = io.get(name)
  return v.kind === 'scalar' && v.value === true
}

/** Reads an integer input or output of a stub as a JS number (its declared type is INT, so it always fits). */
export function readInt(io: FbIo, name: string): number {
  const v = io.get(name)
  if (v.kind !== 'scalar') throw new Error(`stub parameter '${name}' is not a scalar`)
  return Number(v.value)
}

/** Saturates `n` to the INT range; IEC counters stop at the limits instead of wrapping. */
export function clampInt(n: number): number {
  return Math.min(32767, Math.max(-32768, n))
}

/** A BOOL value to store into an output. */
export function boolValue(value: boolean): IecValue {
  return { kind: 'scalar', type: IecType.BOOL, value }
}

/** An INT value to store into an output, saturated to the INT range. */
export function intValue(value: number): IecValue {
  return { kind: 'scalar', type: IecType.INT, value: clampInt(value) }
}
