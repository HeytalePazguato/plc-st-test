import { describe, it, expect, beforeAll } from 'vitest'
import type { Language } from 'web-tree-sitter'
import { SourceMap, type Project, type SourceUnit } from '@plc-st/project-model'
import type { CallArg, HostCallContext, IecType, IecValue } from '@plc-st/plugin-api'
import { loadGrammar, baseGrammarPath } from '../src/parser/parse.js'
import { buildSymbolTableFromProject } from '../src/symbols/table.js'
import { createEvalContext, instantiateFb, type FbInstance } from '../src/interpreter/pou.js'
import { registerStdlib } from '../src/interpreter/stdlib/index.js'
import { roundHalfEven } from '../src/interpreter/stdlib/fnutil.js'
import { IecRuntimeError } from '../src/errors.js'
import { Session } from '../src/session.js'

let lang: Language

const ctx: HostCallContext = { cycle: 0, nowNs: 0n, location: { file: 'test.st', line: 1, col: 1 }, resolvePath: () => undefined, warn: () => undefined }

const v = (type: IecType, value: number | bigint | boolean | string): IecValue => ({ kind: 'scalar', type, value })
const pos = (...values: IecValue[]): CallArg[] => values.map((value) => ({ value }))

function session(): Session {
  const s = new Session({ caseSensitive: false })
  registerStdlib(s)
  return s
}

/** Calls a registered stdlib function directly and returns the scalar result. */
function call(s: Session, name: string, args: CallArg[]): IecValue {
  const fn = s.hostFns.get(name)
  if (fn === undefined) throw new Error(`${name} is not registered`)
  const r = fn.call(args, ctx)
  if (r === undefined) throw new Error(`${name} returned nothing`)
  return r
}

const scalar = (r: IecValue): { type: IecType; value: unknown } => {
  if (r.kind !== 'scalar') throw new Error(`expected a scalar, got ${r.kind}`)
  return { type: r.type, value: r.value }
}

const ST = `
FUNCTION_BLOCK TEST_Fns
VAR
  s5 : STRING(5);
  r : REAL;
  i : INT;
  iNeg : INT;
  iOdd : INT;
  si : SINT;
  d : DINT;
  lim : INT;
  n : INT;
  f : INT;
  mid : STRING;
  t : TIME;
  msOut : DINT;
  txt : STRING;
END_VAR
METHOD Run
s5 := CONCAT('abc', 'defgh');
r := SQRT(REAL#2.0);
i := REAL_TO_INT(REAL#2.5);
iOdd := REAL_TO_INT(REAL#3.5);
iNeg := REAL_TO_INT(REAL#-2.5);
si := INT_TO_SINT(200);
d := MUX(1, 10, 20, 30);
lim := LIMIT(0, 5, 3);
n := LEN('hello');
f := FIND(IN1 := 'conveyor', IN2 := 'vey');
mid := MID(IN := 'conveyor', L := 3, P := 4);
t := DINT_TO_TIME(1500);
msOut := TIME_TO_DINT(T#2s250ms);
txt := INT_TO_STRING(-42);
END_METHOD
END_FUNCTION_BLOCK
`

function runSt(): FbInstance {
  const lines = ST.split('\n').length
  const unit: SourceUnit = { id: 'TEST_Fns', role: 'pou', isTest: true, text: ST, map: SourceMap.fromJSON([{ genStartLine: 1, lineCount: lines, file: 'TEST_Fns.TcPOU', origStartLine: 1, origStartCol: 1 }]) }
  const project: Project = { vendor: 'twincat', dialect: 'twincat', name: 'F', root: '/f', projectFile: '/f/F.plcproj', units: [unit], libraries: [], defines: {}, warnings: [] }
  const symbols = buildSymbolTableFromProject(project, lang, { caseSensitive: false })
  expect(symbols.diagnostics).toEqual([])
  const s = session()
  const evalCtx = createEvalContext({ symbols, session: s })
  const inst = instantiateFb('TEST_Fns', evalCtx)
  inst.callMethod('Run', [])
  return inst
}

function field(inst: FbInstance, name: string): unknown {
  const value = inst.value
  if (value.kind !== 'struct') throw new Error('instance is not a struct')
  const f = [...value.fields.entries()].find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1]
  if (f?.kind !== 'scalar') throw new Error(`${name} is not a scalar field`)
  return f.value
}

describe('stdlib functions from ST', () => {
  beforeAll(async () => {
    lang = await loadGrammar(baseGrammarPath())
  })

  it('computes the acceptance cases through real ST calls', () => {
    const inst = runSt()
    expect(field(inst, 's5')).toBe('abcde')
    expect(field(inst, 'r')).toBe(Math.fround(Math.SQRT2))
    expect(field(inst, 'i')).toBe(2)
    expect(field(inst, 'iOdd')).toBe(4)
    expect(field(inst, 'iNeg')).toBe(-2)
    expect(field(inst, 'si')).toBe(-56)
    expect(field(inst, 'd')).toBe(20)
    expect(field(inst, 'lim')).toBe(3)
    expect(field(inst, 'n')).toBe(5)
    expect(field(inst, 'f')).toBe(4)
    expect(field(inst, 'mid')).toBe('vey')
    expect(field(inst, 't')).toBe(1_500_000_000n)
    expect(field(inst, 'msOut')).toBe(2250)
    expect(field(inst, 'txt')).toBe('-42')
  })
})

describe('string functions', () => {
  const s = session()
  const str = (text: string): IecValue => v('STRING', text)

  it('slices with 1-based positions', () => {
    expect(scalar(call(s, 'LEFT', pos(str('ABCDE'), v('INT', 2)))).value).toBe('AB')
    expect(scalar(call(s, 'RIGHT', pos(str('ABCDE'), v('INT', 2)))).value).toBe('DE')
    expect(scalar(call(s, 'RIGHT', pos(str('ABCDE'), v('INT', 0)))).value).toBe('')
    expect(scalar(call(s, 'MID', pos(str('ABCDE'), v('INT', 2), v('INT', 2)))).value).toBe('BC')
    expect(scalar(call(s, 'MID', pos(str('ABC'), v('INT', 2), v('INT', 9)))).value).toBe('')
  })

  it('inserts, deletes and replaces per IEC', () => {
    expect(scalar(call(s, 'INSERT', pos(str('ABC'), str('XY'), v('INT', 2)))).value).toBe('ABXYC')
    expect(scalar(call(s, 'INSERT', pos(str('ABC'), str('XY'), v('INT', 0)))).value).toBe('XYABC')
    expect(scalar(call(s, 'DELETE', pos(str('ABXYC'), v('INT', 2), v('INT', 3)))).value).toBe('ABC')
    expect(scalar(call(s, 'REPLACE', pos(str('ABCDE'), str('X'), v('INT', 2), v('INT', 3)))).value).toBe('ABXE')
  })

  it('FIND returns 0 when absent and CONCAT is variadic', () => {
    expect(scalar(call(s, 'FIND', pos(str('ABC'), str('Z')))).value).toBe(0)
    expect(scalar(call(s, 'FIND', pos(str('ABC'), str('')))).value).toBe(0)
    expect(scalar(call(s, 'CONCAT', pos(str('a'), str('b'), str('c'), str('d')))).value).toBe('abcd')
  })

  it('rejects invalid positions, negative lengths and mixed widths', () => {
    expect(() => call(s, 'LEFT', pos(str('ABC'), v('INT', -1)))).toThrow(IecRuntimeError)
    expect(() => call(s, 'MID', pos(str('ABC'), v('INT', 1), v('INT', 0)))).toThrow(/at least 1/)
    expect(() => call(s, 'INSERT', pos(str('ABC'), str('X'), v('INT', 4)))).toThrow(/outside 0..3/)
    expect(() => call(s, 'CONCAT', pos(str('a'), v('WSTRING', 'b')))).toThrow(/mix STRING and WSTRING/)
  })

  it('keeps WSTRING results wide', () => {
    expect(scalar(call(s, 'CONCAT', pos(v('WSTRING', 'ä'), v('WSTRING', 'ö')))).type).toBe('WSTRING')
  })
})

describe('math functions', () => {
  const s = session()

  it('keeps REAL precision for REAL inputs and doubles for LREAL', () => {
    expect(scalar(call(s, 'SQRT', pos(v('REAL', 2))))).toEqual({ type: 'REAL', value: Math.fround(Math.SQRT2) })
    expect(scalar(call(s, 'SQRT', pos(v('LREAL', 2))))).toEqual({ type: 'LREAL', value: Math.SQRT2 })
    expect(scalar(call(s, 'SQRT', pos(v('DINT', 4))))).toEqual({ type: 'LREAL', value: 2 })
  })

  it('ABS keeps integer types and wraps like the PLC', () => {
    expect(scalar(call(s, 'ABS', pos(v('INT', -5))))).toEqual({ type: 'INT', value: 5 })
    expect(scalar(call(s, 'ABS', pos(v('SINT', -128))))).toEqual({ type: 'SINT', value: -128 })
    expect(scalar(call(s, 'ABS', pos(v('LINT', -7n))))).toEqual({ type: 'LINT', value: 7n })
  })

  it('raises domain errors instead of returning NaN', () => {
    expect(() => call(s, 'SQRT', pos(v('REAL', -1)))).toThrow(/outside the function's domain/)
    expect(() => call(s, 'LN', pos(v('REAL', 0)))).toThrow(IecRuntimeError)
    expect(() => call(s, 'ASIN', pos(v('LREAL', 2)))).toThrow(IecRuntimeError)
    expect(() => call(s, 'EXPT', pos(v('REAL', -8), v('REAL', 0.5)))).toThrow(/no real result/)
  })

  it('EXPT and TRUNC', () => {
    expect(scalar(call(s, 'EXPT', pos(v('LREAL', 2), v('INT', 10))))).toEqual({ type: 'LREAL', value: 1024 })
    expect(scalar(call(s, 'TRUNC', pos(v('REAL', -2.7))))).toEqual({ type: 'DINT', value: -2 })
    expect(scalar(call(s, 'TRUNC', pos(v('LREAL', 3.9))))).toEqual({ type: 'LINT', value: 3n })
  })
})

describe('selection functions', () => {
  const s = session()

  it('MIN, MAX and LIMIT widen numeric types', () => {
    expect(scalar(call(s, 'MAX', pos(v('INT', 3), v('DINT', 100000), v('SINT', -1))))).toEqual({ type: 'DINT', value: 100000 })
    expect(scalar(call(s, 'MIN', pos(v('INT', 3), v('REAL', 1.5))))).toEqual({ type: 'REAL', value: 1.5 })
    expect(scalar(call(s, 'LIMIT', pos(v('INT', 0), v('INT', 5), v('INT', 3))))).toEqual({ type: 'INT', value: 3 })
    expect(scalar(call(s, 'LIMIT', pos(v('INT', 0), v('INT', -4), v('INT', 3))))).toEqual({ type: 'INT', value: 0 })
  })

  it('compares TIME and STRING within their type', () => {
    expect(scalar(call(s, 'MAX', pos(v('TIME', 1n), v('TIME', 5n)))).value).toBe(5n)
    expect(() => call(s, 'MAX', pos(v('TIME', 1n), v('STRING', 'x')))).toThrow(IecRuntimeError)
  })

  it('SEL and MUX pick inputs and validate the selector', () => {
    expect(scalar(call(s, 'SEL', pos(v('BOOL', true), v('INT', 1), v('INT', 2)))).value).toBe(2)
    expect(scalar(call(s, 'MUX', pos(v('INT', 1), v('INT', 10), v('INT', 20), v('INT', 30)))).value).toBe(20)
    expect(() => call(s, 'MUX', pos(v('INT', 3), v('INT', 10), v('INT', 20)))).toThrow(/outside 0..1/)
    expect(() => call(s, 'SEL', pos(v('INT', 1), v('INT', 1), v('INT', 2)))).toThrow(/must be BOOL/)
  })
})

describe('bit-shift functions', () => {
  const s = session()

  it('SHL and SHR shift in zeros within the width', () => {
    expect(scalar(call(s, 'SHL', pos(v('BYTE', 0b1000_0001), v('INT', 1))))).toEqual({ type: 'BYTE', value: 0b0000_0010 })
    expect(scalar(call(s, 'SHR', pos(v('WORD', 0x8000), v('INT', 15))))).toEqual({ type: 'WORD', value: 1 })
    expect(scalar(call(s, 'SHL', pos(v('BYTE', 0xff), v('INT', 8))))).toEqual({ type: 'BYTE', value: 0 })
    expect(scalar(call(s, 'SHL', pos(v('LWORD', 1n), v('INT', 63))))).toEqual({ type: 'LWORD', value: 2n ** 63n })
  })

  it('ROL and ROR rotate modulo the width', () => {
    expect(scalar(call(s, 'ROL', pos(v('BYTE', 0b1000_0001), v('INT', 1))))).toEqual({ type: 'BYTE', value: 0b0000_0011 })
    expect(scalar(call(s, 'ROR', pos(v('BYTE', 0b0000_0011), v('INT', 1))))).toEqual({ type: 'BYTE', value: 0b1000_0001 })
    expect(scalar(call(s, 'ROL', pos(v('DWORD', 0x8000_0000), v('INT', 33))))).toEqual({ type: 'DWORD', value: 1 })
  })

  it('works on the bit pattern of signed integers and rejects bad arguments', () => {
    expect(scalar(call(s, 'SHL', pos(v('SINT', 64), v('INT', 1))))).toEqual({ type: 'SINT', value: -128 })
    expect(scalar(call(s, 'SHR', pos(v('SINT', -128), v('INT', 7))))).toEqual({ type: 'SINT', value: 1 })
    expect(() => call(s, 'SHL', pos(v('BYTE', 1), v('INT', -1)))).toThrow(/must not be negative/)
    expect(() => call(s, 'SHL', pos(v('REAL', 1), v('INT', 1)))).toThrow(/bit string or integer/)
  })
})

describe('conversion functions', () => {
  const s = session()

  it('rounds REAL to integers half-to-even and wraps on narrowing', () => {
    expect(roundHalfEven(2.5)).toBe(2)
    expect(roundHalfEven(3.5)).toBe(4)
    expect(roundHalfEven(-2.5)).toBe(-2)
    expect(scalar(call(s, 'REAL_TO_INT', pos(v('REAL', 2.5))))).toEqual({ type: 'INT', value: 2 })
    expect(scalar(call(s, 'INT_TO_SINT', pos(v('DINT', 200))))).toEqual({ type: 'SINT', value: -56 })
    expect(scalar(call(s, 'LREAL_TO_LINT', pos(v('LREAL', 1e15 + 0.5))))).toEqual({ type: 'LINT', value: 1_000_000_000_000_000n })
  })

  it('converts BOOL, TIME and REAL both ways', () => {
    expect(scalar(call(s, 'BOOL_TO_INT', pos(v('BOOL', true)))).value).toBe(1)
    expect(scalar(call(s, 'INT_TO_BOOL', pos(v('INT', 0)))).value).toBe(false)
    expect(scalar(call(s, 'TIME_TO_REAL', pos(v('TIME', 1_500_000n)))).value).toBe(1.5)
    expect(scalar(call(s, 'REAL_TO_TIME', pos(v('REAL', 2.5)))).value).toBe(2_500_000n)
    expect(scalar(call(s, 'INT_TO_REAL', pos(v('INT', 3))))).toEqual({ type: 'REAL', value: 3 })
  })

  it('parses and formats IEC literal syntax for STRING conversions', () => {
    expect(scalar(call(s, 'STRING_TO_INT', pos(v('STRING', '16#FF')))).value).toBe(255)
    expect(scalar(call(s, 'STRING_TO_DINT', pos(v('STRING', '-1_000')))).value).toBe(-1000)
    expect(scalar(call(s, 'STRING_TO_REAL', pos(v('STRING', '2.5E1')))).value).toBe(25)
    expect(scalar(call(s, 'STRING_TO_TIME', pos(v('STRING', 'T#1s500ms')))).value).toBe(1_500_000_000n)
    expect(scalar(call(s, 'STRING_TO_BOOL', pos(v('STRING', 'true')))).value).toBe(true)
    expect(scalar(call(s, 'REAL_TO_STRING', pos(v('REAL', Math.fround(0.1))))).value).toBe('0.1')
    expect(scalar(call(s, 'TIME_TO_STRING', pos(v('TIME', 1_500_000_000n)))).value).toBe('T#1s500ms')
    expect(scalar(call(s, 'BOOL_TO_STRING', pos(v('BOOL', false)))).value).toBe('FALSE')
  })

  it('rejects values that cannot be represented', () => {
    expect(() => call(s, 'STRING_TO_INT', pos(v('STRING', '12abc')))).toThrow(/is not an integer/)
    expect(() => call(s, 'LREAL_TO_INT', pos(v('LREAL', Number.NaN)))).toThrow(IecRuntimeError)
    expect(() => call(s, 'STRING_TO_TIME', pos(v('STRING', 'later')))).toThrow(/not a TIME literal/)
  })

  it('registers every A_TO_B pair and the generic TO_B forms', () => {
    for (const name of ['INT_TO_SINT', 'REAL_TO_INT', 'TIME_TO_DINT', 'DATE_TO_STRING', 'WSTRING_TO_STRING', 'TO_INT', 'TO_LREAL', 'TO_STRING']) expect(s.hostFns.get(name)?.name).toBe(name)
    expect(scalar(call(s, 'TO_INT', pos(v('REAL', 3.5)))).value).toBe(4)
  })
})
