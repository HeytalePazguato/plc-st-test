/**
 * IEC 61131-3 selection functions as host functions. MIN, MAX and LIMIT compare numbers across types and return the widened type; TIME, STRING and BOOL compare within their own type. SEL and MUX return a copy of the selected input whatever its type.
 */
import type { CallArg, HostFnDef, IecType, IecValue } from '@plc-st/plugin-api'
import { IecRuntimeError } from '../../errors.js'
import { isIntType, widen } from '../numeric.js'
import { cloneValue } from '../values.js'
import { VARIADIC_MAX, fixedNames, hostFn, intAt, isNumericType, makeNumber, orderArgs, scalarAt, type Scalar } from './fnutil.js'

/** -1, 0 or 1 comparing two scalars of compatible types. */
function compare(fn: string, a: Scalar, b: Scalar): number {
  if (isNumericType(a.type) && isNumericType(b.type)) {
    if (isIntType(a.type) && isIntType(b.type)) {
      const x = BigInt(a.value as number | bigint)
      const y = BigInt(b.value as number | bigint)
      return x < y ? -1 : x > y ? 1 : 0
    }
    const x = Number(a.value)
    const y = Number(b.value)
    return x < y ? -1 : x > y ? 1 : 0
  }
  if (a.type !== b.type) throw new IecRuntimeError(`${fn}: cannot compare ${a.type} with ${b.type}`)
  const x = a.value
  const y = b.value
  return x < y ? -1 : x > y ? 1 : 0
}

/** The common result type of the inputs: the widest numeric type, or the shared non-numeric type. */
function resultType(fn: string, values: Scalar[]): IecType {
  if (values.every((v) => isNumericType(v.type))) return values.map((v) => v.type).reduce((a, b) => widen(a, b))
  const t = values[0].type
  if (values.some((v) => v.type !== t)) throw new IecRuntimeError(`${fn}: inputs must share one type, got ${values.map((v) => v.type).join(', ')}`)
  return t
}

/** The chosen input converted to the call's result type. */
function asResult(v: Scalar, type: IecType): IecValue {
  return isNumericType(type) ? makeNumber(type, v.value as number | bigint) : cloneValue(v)
}

function extreme(name: string, pickFirst: (c: number) => boolean): HostFnDef {
  return hostFn(name, 2, VARIADIC_MAX, (raw) => {
    const args = orderArgs(name, raw, (i) => `IN${String(i + 1)}`)
    const values = args.map((_, i) => scalarAt(name, args, i))
    const type = resultType(name, values)
    let best = values[0]
    for (const v of values.slice(1)) if (pickFirst(compare(name, v, best))) best = v
    return asResult(best, type)
  })
}

const LIMIT = hostFn('LIMIT', 3, 3, (raw) => {
  const args = orderArgs('LIMIT', raw, fixedNames(['MN', 'IN', 'MX']))
  const [mn, inp, mx] = [0, 1, 2].map((i) => scalarAt('LIMIT', args, i))
  const type = resultType('LIMIT', [mn, inp, mx])
  const clamped = compare('LIMIT', inp, mn) < 0 ? mn : compare('LIMIT', inp, mx) > 0 ? mx : inp
  return asResult(clamped, type)
})

const SEL = hostFn('SEL', 3, 3, (raw) => {
  const args = orderArgs('SEL', raw, fixedNames(['G', 'IN0', 'IN1']))
  const g = scalarAt('SEL', args, 0)
  if (g.type !== 'BOOL') throw new IecRuntimeError(`SEL: selector G must be BOOL, got ${g.type}`)
  return cloneValue((g.value === true ? args[2] : args[1]).value)
})

const MUX = hostFn('MUX', 2, VARIADIC_MAX, (raw) => {
  const args = orderArgs('MUX', raw, (i) => (i === 0 ? 'K' : `IN${String(i - 1)}`))
  const k = intAt('MUX', args, 0)
  const inputs = args.slice(1) as CallArg[]
  if (k < 0 || k >= inputs.length) throw new IecRuntimeError(`MUX: selector K=${String(k)} is outside 0..${String(inputs.length - 1)}`)
  return cloneValue(inputs[k].value)
})

export const SELECTION_FNS: readonly HostFnDef[] = [
  extreme('MAX', (c) => c > 0),
  extreme('MIN', (c) => c < 0),
  LIMIT,
  SEL,
  MUX,
]
