/**
 * `ASSERT_*` host functions: generic, floating-point, array and per-type variants. A failing assertion throws `AssertionFailure`; a malformed call (wrong argument types for the function itself) throws `IecRuntimeError`.
 */
import type { CallArg, HostCallContext, IecType, IecValue, TypeResolver } from '@plc-st/plugin-api'
import { AssertionFailure, IecRuntimeError } from './errors.js'
import { formatReal, formatValue } from './format.js'
import type { Session } from './session.js'

type Scalar = Extract<IecValue, { kind: 'scalar' }>
type ArrayValue = Extract<IecValue, { kind: 'array' }>
type Fail = (message: string, expected: string, actual: string, userMsg?: string) => never

const INT_RANGES: Partial<Record<IecType, [bigint, bigint]>> = {
  SINT: [-128n, 127n],
  INT: [-32768n, 32767n],
  DINT: [-2147483648n, 2147483647n],
  LINT: [-(2n ** 63n), 2n ** 63n - 1n],
  USINT: [0n, 255n],
  BYTE: [0n, 255n],
  UINT: [0n, 65535n],
  WORD: [0n, 65535n],
  UDINT: [0n, 4294967295n],
  DWORD: [0n, 4294967295n],
  ULINT: [0n, 2n ** 64n - 1n],
  LWORD: [0n, 2n ** 64n - 1n],
}

/** Typed-variant suffixes; DATE/TOD/DT fold onto TIME in the value model, so they check as TIME. */
const TYPED: readonly string[] = ['BOOL', 'SINT', 'INT', 'DINT', 'LINT', 'USINT', 'UINT', 'UDINT', 'ULINT', 'BYTE', 'WORD', 'DWORD', 'LWORD', 'REAL', 'LREAL', 'STRING', 'WSTRING', 'TIME', 'DATE', 'TOD', 'DT']

export const ASSERTION_NAMES: readonly string[] = [
  'ASSERT_TRUE',
  'ASSERT_FALSE',
  'ASSERT_EQUAL',
  'ASSERT_NOT_EQUAL',
  'ASSERT_NEAR',
  'ASSERT_ARRAY_EQUAL',
  ...TYPED.flatMap((t) => [`ASSERT_EQUAL_${t}`, `ASSERT_NOT_EQUAL_${t}`]),
]

function describeType(v: IecValue): string {
  switch (v.kind) {
    case 'scalar':
      return v.type
    case 'enum':
    case 'struct':
      return v.typeName
    case 'array':
      return `ARRAY OF ${String(v.elemType)}`
  }
}

const isInt = (t: IecType): boolean => INT_RANGES[t] !== undefined
const isReal = (t: IecType): boolean => t === 'REAL' || t === 'LREAL'

/** `[i]` / `[i,j]` for a flat row-major position using the declared lower bounds; multi-dim arrays also show their declared bounds. */
function indexText(arr: ArrayValue, flat: number): string {
  const idx: number[] = []
  let rest = flat
  for (let d = arr.dims.length - 1; d >= 0; d--) {
    const len = arr.dims[d][1] - arr.dims[d][0] + 1
    idx[d] = arr.dims[d][0] + (rest % len)
    rest = Math.floor(rest / len)
  }
  const text = `[${idx.join(',')}]`
  return arr.dims.length > 1 ? `${text} (declared ${arr.dims.map(([lo, hi]) => `${String(lo)}..${String(hi)}`).join(', ')})` : text
}

const sameDims = (a: ArrayValue, b: ArrayValue): boolean => a.dims.length === b.dims.length && a.dims.every((d, i) => d[0] === b.dims[i][0] && d[1] === b.dims[i][1])

/** Why `a` and `b` differ, or `undefined` when equal. Integers/bit strings compare by value regardless of width (an untyped literal is a DINT); REAL/LREAL compare numerically; other categories must match exactly. */
function mismatch(a: IecValue, b: IecValue): { kind: 'type' | 'value'; detail?: string } | undefined {
  if (a.kind !== b.kind) return { kind: 'type' }
  switch (a.kind) {
    case 'scalar': {
      const o = b as Scalar
      if (isInt(a.type) && isInt(o.type)) return BigInt(a.value as number | bigint) === BigInt(o.value as number | bigint) ? undefined : { kind: 'value' }
      if (isReal(a.type) && isReal(o.type)) {
        const x = Number(a.value)
        const y = Number(o.value)
        const same = x === y || (Number.isNaN(x) && Number.isNaN(y)) || (a.type !== o.type && Math.fround(x) === Math.fround(y))
        return same ? undefined : { kind: 'value' }
      }
      if (a.type !== o.type) return { kind: 'type' }
      return a.value === o.value ? undefined : { kind: 'value' }
    }
    case 'enum': {
      const o = b as Extract<IecValue, { kind: 'enum' }>
      if (a.typeName !== o.typeName) return { kind: 'type' }
      return a.value === o.value ? undefined : { kind: 'value' }
    }
    case 'array': {
      const o = b as ArrayValue
      if (!sameDims(a, o)) return { kind: 'value', detail: 'array bounds' }
      for (let i = 0; i < a.data.length; i++) {
        const m = mismatch(a.data[i], o.data[i])
        if (m) return { kind: m.kind, detail: `index ${indexText(a, i)}` }
      }
      return undefined
    }
    case 'struct': {
      const o = b as Extract<IecValue, { kind: 'struct' }>
      if (a.typeName !== o.typeName) return { kind: 'type' }
      for (const [k, av] of a.fields) {
        const bv = o.fields.get(k)
        if (bv === undefined) return { kind: 'value', detail: `field ${k}` }
        const m = mismatch(av, bv)
        if (m) return { kind: m.kind, detail: `field ${k}` }
      }
      return undefined
    }
  }
}

/** Registers every assertion on `session.hostFns`. `resolver` (usually the symbol table) lets failure messages show enum member names. */
export function registerAssertions(session: Session, resolver?: TypeResolver): void {
  const fmt = (v: IecValue): string => formatValue(v, resolver)
  const reg = (name: string, minArgs: number, maxArgs: number, body: (args: CallArg[], hc: HostCallContext, fail: Fail) => void): void => {
    session.hostFns.register(
      {
        name,
        minArgs,
        maxArgs,
        call(args, hc) {
          body(args, hc, (message, expected, actual, userMsg) => {
            throw new AssertionFailure(`${name} failed${userMsg === undefined ? ': ' : `: ${userMsg} — `}${message}`, expected, actual, hc.location)
          })
          return undefined
        },
      },
      'assertions',
    )
  }

  const userMessage = (name: string, args: CallArg[], i: number): string | undefined => {
    const a = args.at(i)
    if (a === undefined) return undefined
    if (a.value.kind !== 'scalar' || (a.value.type !== 'STRING' && a.value.type !== 'WSTRING')) throw new IecRuntimeError(`${name}: message argument must be a STRING`)
    return String(a.value.value)
  }
  const bool = (name: string, a: CallArg): boolean => {
    if (a.value.kind !== 'scalar' || a.value.type !== 'BOOL') throw new IecRuntimeError(`${name}: condition must be BOOL, got ${describeType(a.value)}`)
    return a.value.value === true
  }

  reg('ASSERT_TRUE', 1, 2, (args, _hc, fail) => {
    if (!bool('ASSERT_TRUE', args[0])) fail('condition is FALSE', 'TRUE', 'FALSE', userMessage('ASSERT_TRUE', args, 1))
  })
  reg('ASSERT_FALSE', 1, 2, (args, _hc, fail) => {
    if (bool('ASSERT_FALSE', args[0])) fail('condition is TRUE', 'FALSE', 'TRUE', userMessage('ASSERT_FALSE', args, 1))
  })

  const compare = (negate: boolean, actual: IecValue, expected: IecValue, userMsg: string | undefined, fail: Fail, typeLabel?: string): void => {
    const m = mismatch(actual, expected)
    if (m?.kind === 'type') {
      fail(`type mismatch: actual is ${describeType(actual)}, expected is ${describeType(expected)}${typeLabel === undefined ? '' : ` (${typeLabel})`}`, fmt(expected), fmt(actual), userMsg)
    }
    if (!negate && m) fail(`expected ${fmt(expected)}, actual ${fmt(actual)}${m.detail === undefined ? '' : ` (first difference at ${m.detail})`}`, fmt(expected), fmt(actual), userMsg)
    if (negate && !m) fail(`values are equal: ${fmt(actual)}`, `not ${fmt(expected)}`, fmt(actual), userMsg)
  }

  reg('ASSERT_EQUAL', 2, 3, (args, _hc, fail) => compare(false, args[0].value, args[1].value, userMessage('ASSERT_EQUAL', args, 2), fail))
  reg('ASSERT_NOT_EQUAL', 2, 3, (args, _hc, fail) => compare(true, args[0].value, args[1].value, userMessage('ASSERT_NOT_EQUAL', args, 2), fail))

  reg('ASSERT_NEAR', 3, 4, (args, _hc, fail) => {
    const nums = args.slice(0, 3).map((a, i) => {
      if (a.value.kind !== 'scalar' || !isReal(a.value.type)) throw new IecRuntimeError(`ASSERT_NEAR: argument ${String(i + 1)} must be REAL or LREAL, got ${describeType(a.value)}`)
      return Number(a.value.value)
    })
    const [actual, expected, tol] = nums
    if (tol < 0 || Number.isNaN(tol)) throw new IecRuntimeError('ASSERT_NEAR: tolerance must be >= 0')
    // Rounded to 12 significant digits so representation noise (1.2 - 1.0 = 0.19999999999999996) neither fails a boundary case nor clutters the message.
    const delta = Number(Math.abs(actual - expected).toPrecision(12))
    if (Number.isNaN(delta) || delta > tol) {
      fail(`expected ${formatReal(expected)} ± ${formatReal(tol)}, actual ${formatReal(actual)} (delta ${formatReal(delta)})`, `${formatReal(expected)} ± ${formatReal(tol)}`, formatReal(actual), userMessage('ASSERT_NEAR', args, 3))
    }
  })

  reg('ASSERT_ARRAY_EQUAL', 2, 3, (args, _hc, fail) => {
    const [a, e] = [args[0].value, args[1].value]
    if (a.kind !== 'array' || e.kind !== 'array') throw new IecRuntimeError('ASSERT_ARRAY_EQUAL: both arguments must be arrays')
    const userMsg = userMessage('ASSERT_ARRAY_EQUAL', args, 2)
    const bounds = (v: ArrayValue): string => v.dims.map(([lo, hi]) => `${String(lo)}..${String(hi)}`).join(', ')
    if (!sameDims(a, e)) fail(`array bounds differ: expected [${bounds(e)}], actual [${bounds(a)}]`, fmt(e), fmt(a), userMsg)
    for (let i = 0; i < a.data.length; i++) {
      const m = mismatch(a.data[i], e.data[i])
      if (m) {
        const what = m.kind === 'type' ? `type mismatch: actual is ${describeType(a.data[i])}, expected is ${describeType(e.data[i])}` : `expected ${fmt(e.data[i])}, actual ${fmt(a.data[i])}`
        fail(`first mismatch at index ${indexText(a, i)}: ${what}`, fmt(e.data[i]), fmt(a.data[i]), userMsg)
      }
    }
  })

  for (const t of TYPED) {
    const family: IecType = t === 'DATE' || t === 'TOD' || t === 'DT' ? 'TIME' : (t as IecType)
    const fits = (v: IecValue): boolean => {
      if (v.kind !== 'scalar') return false
      const range = INT_RANGES[family]
      if (range) {
        if (!isInt(v.type)) return false
        const n = BigInt(v.value as number | bigint)
        return n >= range[0] && n <= range[1]
      }
      if (family === 'REAL' || family === 'LREAL') return isReal(v.type)
      return v.type === family
    }
    const norm = (v: IecValue): IecValue => (family === 'REAL' && v.kind === 'scalar' ? { kind: 'scalar', type: 'REAL', value: Math.fround(Number(v.value)) } : v)
    for (const negate of [false, true]) {
      const name = `${negate ? 'ASSERT_NOT_EQUAL' : 'ASSERT_EQUAL'}_${t}`
      reg(name, 2, 3, (args, _hc, fail) => {
        const userMsg = userMessage(name, args, 2)
        for (const [label, a] of [['actual', args[0]], ['expected', args[1]]] as const) {
          if (!fits(a.value)) fail(`type mismatch: ${label} argument is ${describeType(a.value)} (${fmt(a.value)}), not ${t}`, t, describeType(a.value), userMsg)
        }
        compare(negate, norm(args[0].value), norm(args[1].value), userMsg, fail, t)
      })
    }
  }
}
