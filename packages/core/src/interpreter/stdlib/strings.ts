/**
 * IEC 61131-3 string functions as host functions. Positions are 1-based. Results carry no declared length; assignment truncates them to the target's STRING(n). STRING and WSTRING may not be mixed in one call.
 *
 * Out-of-range arguments are errors rather than silently clamped (a negative length, a position below 1, or an INSERT/DELETE/REPLACE position past the end), because vendor runtimes disagree on the fallback and a test should not pass on one vendor's quirk. MID starting past the end returns an empty string, which all common runtimes do.
 */
import type { CallArg, HostFnDef, IecValue } from '@plc-st/plugin-api'
import { IecRuntimeError } from '../../errors.js'
import { VARIADIC_MAX, fixedNames, hostFn, intAt, isStringType, orderArgs, scalarAt } from './fnutil.js'

interface Text {
  text: string
  wide: boolean
}

function textAt(fn: string, args: CallArg[], i: number): Text {
  const v = scalarAt(fn, args, i)
  if (!isStringType(v.type)) throw new IecRuntimeError(`${fn}: argument ${String(i + 1)} must be a STRING or WSTRING, got ${v.type}`)
  return { text: String(v.value), wide: v.type === 'WSTRING' }
}

/** Enforces that all string arguments share STRING or WSTRING and returns which. */
function sameWidth(fn: string, texts: Text[]): boolean {
  const wide = texts[0].wide
  if (texts.some((t) => t.wide !== wide)) throw new IecRuntimeError(`${fn}: cannot mix STRING and WSTRING arguments`)
  return wide
}

function stringValue(text: string, wide: boolean): IecValue {
  return { kind: 'scalar', type: wide ? 'WSTRING' : 'STRING', value: text }
}

function nonNegative(fn: string, what: string, n: number): number {
  if (n < 0) throw new IecRuntimeError(`${fn}: ${what} must not be negative, got ${String(n)}`)
  return n
}

function position(fn: string, p: number, max: number): number {
  if (p < 1 || p > max) throw new IecRuntimeError(`${fn}: position P=${String(p)} is outside 1..${String(max)}`)
  return p
}

const LEN = hostFn('LEN', 1, 1, (raw) => {
  const args = orderArgs('LEN', raw, fixedNames(['IN']))
  const n = textAt('LEN', args, 0).text.length
  if (n > 32767) throw new IecRuntimeError(`LEN: length ${String(n)} exceeds the INT result range`)
  return { kind: 'scalar', type: 'INT', value: n }
})

const LEFT = hostFn('LEFT', 2, 2, (raw) => {
  const args = orderArgs('LEFT', raw, fixedNames(['IN', 'L']))
  const s = textAt('LEFT', args, 0)
  return stringValue(s.text.slice(0, nonNegative('LEFT', 'L', intAt('LEFT', args, 1))), s.wide)
})

const RIGHT = hostFn('RIGHT', 2, 2, (raw) => {
  const args = orderArgs('RIGHT', raw, fixedNames(['IN', 'L']))
  const s = textAt('RIGHT', args, 0)
  const l = nonNegative('RIGHT', 'L', intAt('RIGHT', args, 1))
  return stringValue(l === 0 ? '' : s.text.slice(-l), s.wide)
})

const MID = hostFn('MID', 3, 3, (raw) => {
  const args = orderArgs('MID', raw, fixedNames(['IN', 'L', 'P']))
  const s = textAt('MID', args, 0)
  const l = nonNegative('MID', 'L', intAt('MID', args, 1))
  const p = intAt('MID', args, 2)
  if (p < 1) throw new IecRuntimeError(`MID: position P=${String(p)} must be at least 1`)
  return stringValue(s.text.slice(p - 1, p - 1 + l), s.wide)
})

const FIND = hostFn('FIND', 2, 2, (raw) => {
  const args = orderArgs('FIND', raw, fixedNames(['IN1', 'IN2']))
  const hay = textAt('FIND', args, 0)
  const needle = textAt('FIND', args, 1)
  sameWidth('FIND', [hay, needle])
  // 1-based position of the first occurrence, 0 when absent (an empty search string is never "found").
  const idx = needle.text.length === 0 ? -1 : hay.text.indexOf(needle.text)
  return { kind: 'scalar', type: 'INT', value: idx + 1 }
})

const INSERT = hostFn('INSERT', 3, 3, (raw) => {
  const args = orderArgs('INSERT', raw, fixedNames(['IN1', 'IN2', 'P']))
  const a = textAt('INSERT', args, 0)
  const b = textAt('INSERT', args, 1)
  const wide = sameWidth('INSERT', [a, b])
  // IN2 goes after the P-th character of IN1; P = 0 inserts at the start.
  const p = intAt('INSERT', args, 2)
  if (p < 0 || p > a.text.length) throw new IecRuntimeError(`INSERT: position P=${String(p)} is outside 0..${String(a.text.length)}`)
  return stringValue(a.text.slice(0, p) + b.text + a.text.slice(p), wide)
})

const DELETE = hostFn('DELETE', 3, 3, (raw) => {
  const args = orderArgs('DELETE', raw, fixedNames(['IN', 'L', 'P']))
  const s = textAt('DELETE', args, 0)
  const l = nonNegative('DELETE', 'L', intAt('DELETE', args, 1))
  const p = position('DELETE', intAt('DELETE', args, 2), Math.max(1, s.text.length))
  return stringValue(s.text.slice(0, p - 1) + s.text.slice(p - 1 + l), s.wide)
})

const REPLACE = hostFn('REPLACE', 4, 4, (raw) => {
  const args = orderArgs('REPLACE', raw, fixedNames(['IN1', 'IN2', 'L', 'P']))
  const a = textAt('REPLACE', args, 0)
  const b = textAt('REPLACE', args, 1)
  const wide = sameWidth('REPLACE', [a, b])
  const l = nonNegative('REPLACE', 'L', intAt('REPLACE', args, 2))
  const p = position('REPLACE', intAt('REPLACE', args, 3), Math.max(1, a.text.length))
  return stringValue(a.text.slice(0, p - 1) + b.text + a.text.slice(p - 1 + l), wide)
})

const CONCAT = hostFn('CONCAT', 1, VARIADIC_MAX, (raw) => {
  const args = orderArgs('CONCAT', raw, (i) => `IN${String(i + 1)}`)
  const texts = args.map((_, i) => textAt('CONCAT', args, i))
  return stringValue(texts.map((t) => t.text).join(''), sameWidth('CONCAT', texts))
})

export const STRING_FNS: readonly HostFnDef[] = [LEN, LEFT, RIGHT, MID, FIND, INSERT, DELETE, REPLACE, CONCAT]
