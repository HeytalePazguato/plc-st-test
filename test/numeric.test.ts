import { describe, it, expect } from 'vitest'
import {
  IecType,
  isBigIntType,
  wrapInt,
  froundReal,
  widen,
  add,
  sub,
  mul,
  div,
  mod,
  pow,
} from '../src/interpreter/numeric.js'
import { IecError, IecRuntimeError } from '../src/errors.js'

describe('wrapInt — two\'s-complement wrap', () => {
  it('SINT: 127 + 1 = -128', () => {
    expect(add(127, 1, IecType.SINT)).toBe(-128)
  })

  it('SINT: -128 - 1 = 127', () => {
    expect(sub(-128, 1, IecType.SINT)).toBe(127)
  })

  it('USINT: 255 + 1 = 0', () => {
    expect(add(255, 1, IecType.USINT)).toBe(0)
  })

  it('USINT: 0 - 1 = 255', () => {
    expect(sub(0, 1, IecType.USINT)).toBe(255)
  })

  it('INT: 32767 + 1 = -32768', () => {
    expect(add(32767, 1, IecType.INT)).toBe(-32768)
  })

  it('UINT: wraps at 65536', () => {
    expect(add(65535, 1, IecType.UINT)).toBe(0)
  })

  it('DINT: 2^31 - 1 + 1 = -2^31', () => {
    expect(add(2 ** 31 - 1, 1, IecType.DINT)).toBe(-(2 ** 31))
  })

  it('UDINT: wraps at 2^32', () => {
    expect(add(2 ** 32 - 1, 1, IecType.UDINT)).toBe(0)
  })

  it('BYTE/WORD/DWORD are unsigned bit-strings', () => {
    expect(wrapInt(256, IecType.BYTE)).toBe(0)
    expect(wrapInt(-1, IecType.BYTE)).toBe(255)
    expect(wrapInt(65536, IecType.WORD)).toBe(0)
    expect(wrapInt(-1, IecType.DWORD)).toBe(2 ** 32 - 1)
  })
})

describe('wrapInt — 64-bit BigInt types', () => {
  it('isBigIntType is true only for LINT/ULINT/LWORD', () => {
    expect(isBigIntType(IecType.LINT)).toBe(true)
    expect(isBigIntType(IecType.ULINT)).toBe(true)
    expect(isBigIntType(IecType.LWORD)).toBe(true)
    expect(isBigIntType(IecType.DINT)).toBe(false)
    expect(isBigIntType(IecType.REAL)).toBe(false)
  })

  it('LINT: max (2^63 - 1) + 1 wraps to -2^63', () => {
    const max = 2n ** 63n - 1n
    expect(add(max, 1n, IecType.LINT)).toBe(-(2n ** 63n))
  })

  it('ULINT: max (2^64 - 1) + 1 wraps to 0', () => {
    const max = 2n ** 64n - 1n
    expect(add(max, 1n, IecType.ULINT)).toBe(0n)
  })

  it('LWORD: -1 wraps to 2^64 - 1 (unsigned)', () => {
    expect(wrapInt(-1n, IecType.LWORD)).toBe(2n ** 64n - 1n)
  })

  it('returns bigint for 64-bit types', () => {
    expect(typeof add(1n, 2n, IecType.LINT)).toBe('bigint')
  })
})

describe('froundReal / REAL precision', () => {
  it('froundReal applies Math.fround', () => {
    expect(froundReal(0.1)).toBe(Math.fround(0.1))
  })

  it('REAL add(0.1, 0.2) is fround-rounded', () => {
    expect(add(0.1, 0.2, IecType.REAL)).toBe(Math.fround(0.30000001192092896))
  })

  it('LREAL keeps full double precision (no fround)', () => {
    expect(add(0.1, 0.2, IecType.LREAL)).toBe(0.1 + 0.2)
  })

  it('REAL result is a number', () => {
    expect(typeof add(1, 2, IecType.REAL)).toBe('number')
  })
})

describe('widen', () => {
  it('INT + DINT = DINT', () => {
    expect(widen(IecType.INT, IecType.DINT)).toBe(IecType.DINT)
    expect(widen(IecType.DINT, IecType.INT)).toBe(IecType.DINT)
  })

  it('SINT + INT = INT', () => {
    expect(widen(IecType.SINT, IecType.INT)).toBe(IecType.INT)
  })

  it('integer + REAL widens to REAL', () => {
    expect(widen(IecType.DINT, IecType.REAL)).toBe(IecType.REAL)
  })

  it('REAL + LREAL widens to LREAL', () => {
    expect(widen(IecType.REAL, IecType.LREAL)).toBe(IecType.LREAL)
  })

  it('LINT outranks DINT', () => {
    expect(widen(IecType.DINT, IecType.LINT)).toBe(IecType.LINT)
  })

  it('same rank keeps the first operand type', () => {
    expect(widen(IecType.UINT, IecType.INT)).toBe(IecType.UINT)
  })
})

describe('arithmetic helpers', () => {
  it('mul wraps for integer types', () => {
    expect(mul(200, 2, IecType.SINT)).toBe(wrapInt(400, IecType.SINT))
    expect(mul(200, 2, IecType.SINT)).toBe(-112)
  })

  it('div truncates toward zero for integers', () => {
    expect(div(7, 2, IecType.INT)).toBe(3)
    expect(div(-7, 2, IecType.INT)).toBe(-3)
  })

  it('div on REAL keeps fractional result (fround-rounded)', () => {
    expect(div(1, 2, IecType.REAL)).toBe(0.5)
  })

  it('mod follows dividend sign (truncated remainder)', () => {
    expect(mod(7, 3, IecType.INT)).toBe(1)
    expect(mod(-7, 3, IecType.INT)).toBe(-1)
  })

  it('pow works for integers with wrap', () => {
    expect(pow(2, 3, IecType.INT)).toBe(8)
  })

  it('bigint arithmetic for LINT', () => {
    expect(mul(3n, 4n, IecType.LINT)).toBe(12n)
    expect(div(10n, 3n, IecType.LINT)).toBe(3n)
    expect(mod(10n, 3n, IecType.LINT)).toBe(1n)
  })
})

describe('division by zero', () => {
  it('div by zero throws IecRuntimeError with exact message', () => {
    expect(() => div(1, 0, IecType.INT)).toThrowError(IecRuntimeError)
    expect(() => div(1, 0, IecType.INT)).toThrowError('division by zero')
  })

  it('mod by zero throws IecRuntimeError', () => {
    expect(() => mod(1, 0, IecType.INT)).toThrowError('division by zero')
  })

  it('div by zero (bigint) throws IecRuntimeError', () => {
    expect(() => div(1n, 0n, IecType.LINT)).toThrowError(IecRuntimeError)
  })

  it('IecRuntimeError is an IecError with correct name', () => {
    const err = new IecRuntimeError('x')
    expect(err).toBeInstanceOf(IecError)
    expect(err.name).toBe('IecRuntimeError')
  })
})
