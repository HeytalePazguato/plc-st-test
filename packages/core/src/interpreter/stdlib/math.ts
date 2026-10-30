/**
 * IEC 61131-3 numeric functions as host functions. A REAL argument gives a REAL result rounded to 32 bits, an LREAL argument stays a double, and an integer argument to a floating-point function gives an LREAL (vendor IDEs convert it implicitly).
 *
 * Domain errors (SQRT of a negative number, LN/LOG of a non-positive number, ASIN/ACOS outside [-1, 1], an EXPT without a real result) raise IecRuntimeError. IEC leaves them implementation-defined and real runtimes return NaN; failing loudly makes a test catch the bug instead of passing on a NaN that compares unequal to everything.
 */
import type { CallArg, HostFnDef, IecType, IecValue } from '@plc-st/plugin-api'
import { IecRuntimeError } from '../../errors.js'
import { isIntType } from '../numeric.js'
import { fixedNames, hostFn, isRealType, makeNumber, orderArgs, scalarAt, toNumber, type Scalar } from './fnutil.js'

function numericAt(fn: string, args: CallArg[], i: number): Scalar {
  const v = scalarAt(fn, args, i)
  if (!isIntType(v.type) && !isRealType(v.type)) throw new IecRuntimeError(`${fn}: argument ${String(i + 1)} must be a number, got ${v.type}`)
  return v
}

/** REAL stays REAL, everything else computes in double precision. */
const floatResultType = (t: IecType): IecType => (t === 'REAL' ? 'REAL' : 'LREAL')

function realResult(fn: string, type: IecType, x: number): IecValue {
  if (!Number.isFinite(x)) throw new IecRuntimeError(`${fn}: the result is not a finite number`)
  return makeNumber(type, x)
}

/** A one-argument floating-point function with a domain check. */
function unary(name: string, f: (x: number) => number, inDomain: (x: number) => boolean = () => true): HostFnDef {
  return hostFn(name, 1, 1, (raw) => {
    const args = orderArgs(name, raw, fixedNames(['IN']))
    const v = numericAt(name, args, 0)
    const x = toNumber(name, v)
    if (!inDomain(x)) throw new IecRuntimeError(`${name}: argument ${String(x)} is outside the function's domain`)
    return realResult(name, floatResultType(v.type), f(x))
  })
}

const ABS = hostFn('ABS', 1, 1, (raw) => {
  const args = orderArgs('ABS', raw, fixedNames(['IN']))
  const v = numericAt('ABS', args, 0)
  if (typeof v.value === 'bigint') return makeNumber(v.type, v.value < 0n ? -v.value : v.value)
  // Integers keep their type and wrap (ABS of SINT -128 is -128, as on the PLC); reals keep their precision.
  return makeNumber(v.type, Math.abs(Number(v.value)))
})

const EXPT = hostFn('EXPT', 2, 2, (raw) => {
  const args = orderArgs('EXPT', raw, fixedNames(['IN1', 'IN2']))
  const base = numericAt('EXPT', args, 0)
  const exp = numericAt('EXPT', args, 1)
  const r = Math.pow(toNumber('EXPT', base), toNumber('EXPT', exp))
  if (Number.isNaN(r)) throw new IecRuntimeError(`EXPT: ${String(base.value)} ** ${String(exp.value)} has no real result`)
  return realResult('EXPT', floatResultType(base.type), r)
})

const TRUNC = hostFn('TRUNC', 1, 1, (raw) => {
  const args = orderArgs('TRUNC', raw, fixedNames(['IN']))
  const v = numericAt('TRUNC', args, 0)
  if (isIntType(v.type)) return makeNumber(v.type, v.value as number | bigint)
  const t = Math.trunc(toNumber('TRUNC', v))
  if (!Number.isFinite(t)) throw new IecRuntimeError('TRUNC: argument is not a finite number')
  // REAL truncates to DINT and LREAL to LINT, matching the vendor libraries.
  return v.type === 'REAL' ? makeNumber('DINT', t) : makeNumber('LINT', BigInt(t))
})

export const MATH_FNS: readonly HostFnDef[] = [
  ABS,
  unary('SQRT', Math.sqrt, (x) => x >= 0),
  unary('LN', Math.log, (x) => x > 0),
  unary('LOG', Math.log10, (x) => x > 0),
  unary('EXP', Math.exp),
  unary('SIN', Math.sin),
  unary('COS', Math.cos),
  unary('TAN', Math.tan),
  unary('ASIN', Math.asin, (x) => x >= -1 && x <= 1),
  unary('ACOS', Math.acos, (x) => x >= -1 && x <= 1),
  unary('ATAN', Math.atan),
  EXPT,
  TRUNC,
]
