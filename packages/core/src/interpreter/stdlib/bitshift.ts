/**
 * IEC 61131-3 bit-shift functions as host functions: SHL and SHR shift in zeros, ROL and ROR rotate within the argument's bit width. They operate on bit strings (BYTE, WORD, DWORD, LWORD) and, as the vendor runtimes allow, on the integer types too, working on the two's-complement bit pattern. The result keeps the argument's type; a negative shift count is an error, and a count at or beyond the width shifts every bit out (SHL/SHR) or rotates modulo the width (ROL/ROR).
 */
import type { CallArg, HostFnDef, IecType, IecValue } from '@plc-st/plugin-api'
import { IecRuntimeError } from '../../errors.js'
import { isIntType } from '../numeric.js'
import { fixedNames, hostFn, intAt, makeNumber, orderArgs, scalarAt, type Scalar } from './fnutil.js'

const WIDTH: Partial<Record<IecType, number>> = { BYTE: 8, SINT: 8, USINT: 8, WORD: 16, INT: 16, UINT: 16, DWORD: 32, DINT: 32, UDINT: 32, LWORD: 64, LINT: 64, ULINT: 64 }

interface Operands {
  v: Scalar
  bits: bigint
  width: number
  n: number
}

function operands(fn: string, raw: CallArg[]): Operands {
  const args = orderArgs(fn, raw, fixedNames(['IN', 'N']))
  const v = scalarAt(fn, args, 0)
  const width = WIDTH[v.type]
  if (width === undefined || !isIntType(v.type)) throw new IecRuntimeError(`${fn}: IN must be a bit string or integer, got ${v.type}`)
  const n = intAt(fn, args, 1)
  if (n < 0) throw new IecRuntimeError(`${fn}: shift count N must not be negative, got ${String(n)}`)
  // Work on the unsigned bit pattern of the declared width.
  const bits = BigInt.asUintN(width, BigInt(v.value as number | bigint))
  return { v, bits, width, n }
}

/** Converts a width-bit pattern back to a value of the argument's type; makeNumber's wrap reinterprets the top bit for signed types. */
function result(v: Scalar, width: number, bits: bigint): IecValue {
  return makeNumber(v.type, BigInt.asUintN(width, bits))
}

const SHL = hostFn('SHL', 2, 2, (raw) => {
  const { v, bits, width, n } = operands('SHL', raw)
  return result(v, width, n >= width ? 0n : bits << BigInt(n))
})

const SHR = hostFn('SHR', 2, 2, (raw) => {
  const { v, bits, width, n } = operands('SHR', raw)
  return result(v, width, n >= width ? 0n : bits >> BigInt(n))
})

function rotate(fn: string, left: boolean): HostFnDef {
  return hostFn(fn, 2, 2, (raw) => {
    const { v, bits, width, n } = operands(fn, raw)
    const k = BigInt(n % width)
    const w = BigInt(width)
    const rotated = k === 0n ? bits : left ? (bits << k) | (bits >> (w - k)) : (bits >> k) | (bits << (w - k))
    return result(v, width, rotated)
  })
}

export const BITSHIFT_FNS: readonly HostFnDef[] = [SHL, SHR, rotate('ROL', true), rotate('ROR', false)]
