import { describe, it, expect, beforeAll } from 'vitest'
import type { Language } from 'web-tree-sitter'
import { SourceMap, type Project, type SourceUnit } from '@plc-st/project-model'
import type { CallArg, HostCallContext, IecValue } from '@plc-st/plugin-api'
import { loadGrammar, baseGrammarPath } from '../src/parser/parse.js'
import { buildSymbolTableFromProject } from '../src/symbols/table.js'
import { createEvalContext, instantiateFb } from '../src/interpreter/pou.js'
import { ASSERTION_NAMES, registerAssertions } from '../src/assertions.js'
import { formatTime, formatValue } from '../src/format.js'
import { AssertionFailure, IecRuntimeError } from '../src/errors.js'
import { Session } from '../src/session.js'

let lang: Language

const ST = `
TYPE E_Mode : (OFF := 0, AUTO := 1, MANUAL := 3);
END_TYPE

FUNCTION_BLOCK TEST_Asserts
VAR
  a : ARRAY[0..2] OF INT := [1, 2, 3];
  b : ARRAY[0..2] OF INT := [1, 2, 3];
  c : ARRAY[0..2] OF INT := [1, 2, 4];
  m1 : ARRAY[1..2, 0..1] OF INT;
  m2 : ARRAY[1..2, 0..1] OF INT;
  n : INT := 5;
  eA : E_Mode := E_Mode.AUTO;
  eB : E_Mode := E_Mode.MANUAL;
  r : REAL := 1.5;
  t : TIME := T#1s500ms;
  s : STRING := 'hi';
END_VAR
METHOD ArraysEqual
ASSERT_ARRAY_EQUAL(a, b);
ASSERT_EQUAL(a, b, 'arrays');
END_METHOD
METHOD IntMismatch
ASSERT_EQUAL(n, 6);
END_METHOD
METHOD IntMismatchMsg
ASSERT_EQUAL(n, 6, 'count');
END_METHOD
METHOD EnumMismatch
ASSERT_EQUAL(eA, eB);
END_METHOD
METHOD TypedOk
ASSERT_EQUAL_INT(n, 5);
ASSERT_EQUAL_REAL(r, 1.5);
ASSERT_EQUAL_TIME(t, T#1s500ms);
ASSERT_EQUAL_STRING(s, 'hi');
ASSERT_NOT_EQUAL_INT(n, 6);
ASSERT_EQUAL_BOOL(TRUE, TRUE);
END_METHOD
METHOD TypedMismatch
ASSERT_EQUAL_INT(5, REAL#5.0);
END_METHOD
METHOD NearOk
ASSERT_NEAR(1.0, 1.05, 0.1);
END_METHOD
METHOD NearFail
ASSERT_NEAR(1.0, 1.2, 0.1);
END_METHOD
METHOD ArrayFail
c[2] := 4; a[2] := 3;
ASSERT_ARRAY_EQUAL(a, c);
END_METHOD
METHOD MultiFail
m1[2,1] := 4; m2[2,1] := 5;
ASSERT_ARRAY_EQUAL(m1, m2);
END_METHOD
METHOD TrueFail
ASSERT_TRUE(n = 6, 'n is 6');
END_METHOD
METHOD NotEqualFail
ASSERT_NOT_EQUAL(n, 5);
END_METHOD
END_FUNCTION_BLOCK
`

function setup(): { run: (method: string) => void; session: Session } {
  const lines = ST.split('\n').length
  const unit: SourceUnit = { id: 'TEST_Asserts', role: 'pou', isTest: true, text: ST, map: SourceMap.fromJSON([{ genStartLine: 1, lineCount: lines, file: 'TEST_Asserts.TcPOU', origStartLine: 1, origStartCol: 1 }]) }
  const project: Project = { vendor: 'twincat', dialect: 'twincat', name: 'F', root: '/f', projectFile: '/f/F.plcproj', units: [unit], libraries: [], defines: {}, warnings: [] }
  const symbols = buildSymbolTableFromProject(project, lang, { caseSensitive: false })
  expect(symbols.diagnostics).toEqual([])
  const session = new Session({ caseSensitive: false })
  registerAssertions(session, symbols)
  const ctx = createEvalContext({ symbols, session })
  const inst = instantiateFb('TEST_Asserts', ctx)
  return { run: (m) => void inst.callMethod(m, []), session }
}

function failure(fn: () => void): AssertionFailure {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(AssertionFailure)
    return e as AssertionFailure
  }
  throw new Error('expected an AssertionFailure')
}

describe('assertions from ST', () => {
  beforeAll(async () => {
    lang = await loadGrammar(baseGrammarPath())
  })

  it('equal arrays pass, typed variants pass, ASSERT_NEAR within tolerance passes', () => {
    const { run } = setup()
    run('ArraysEqual')
    run('TypedOk')
    run('NearOk')
  })

  it('INT 5 vs 6 throws with expected/actual and the user message', () => {
    const { run } = setup()
    const f = failure(() => run('IntMismatch'))
    expect(f.expected).toBe('6')
    expect(f.actual).toBe('5')
    expect(f.location.line).toBeGreaterThan(0)
    expect(f.location.file).toBe('TEST_Asserts.TcPOU')
    expect(failure(() => run('IntMismatchMsg')).message).toContain('count')
  })

  it('enum mismatch shows member names', () => {
    const f = failure(() => setup().run('EnumMismatch'))
    expect(f.expected).toBe('E_Mode.MANUAL (3)')
    expect(f.actual).toBe('E_Mode.AUTO (1)')
  })

  it('ASSERT_EQUAL_INT(5, REAL#5.0) fails with a type mismatch', () => {
    const f = failure(() => setup().run('TypedMismatch'))
    expect(f.message).toMatch(/type mismatch/)
    expect(f.message).toContain('REAL')
  })

  it('ASSERT_NEAR(1.0, 1.2, 0.1) fails showing delta 0.2', () => {
    const f = failure(() => setup().run('NearFail'))
    expect(f.message).toContain('delta 0.2')
  })

  it('ASSERT_ARRAY_EQUAL reports the first mismatching index, with bounds for multi-dim arrays', () => {
    expect(failure(() => setup().run('ArrayFail')).message).toContain('index [2]')
    const multi = failure(() => setup().run('MultiFail'))
    expect(multi.message).toContain('index [2,1] (declared 1..2, 0..1)')
    expect(multi.expected).toBe('5')
    expect(multi.actual).toBe('4')
  })

  it('ASSERT_TRUE and ASSERT_NOT_EQUAL failures', () => {
    expect(failure(() => setup().run('TrueFail')).message).toContain('n is 6')
    expect(failure(() => setup().run('NotEqualFail')).message).toContain('equal')
  })
})

const call = (session: Session, name: string, ...vals: IecValue[]): void => {
  const def = session.hostFns.get(name)
  if (!def) throw new Error(`${name} not registered`)
  const hc: HostCallContext = { cycle: 0, nowNs: 0n, location: { file: 'x.st', line: 1, col: 1 }, resolvePath: () => undefined, warn: () => {} }
  def.call(vals.map((value): CallArg => ({ value })), hc)
}
const sc = (type: 'INT' | 'DINT' | 'REAL' | 'LREAL' | 'BOOL' | 'STRING' | 'TIME' | 'BYTE', value: number | bigint | boolean | string): IecValue => ({ kind: 'scalar', type, value })

describe('assertions called directly', () => {
  it('registers every name in ASSERTION_NAMES', () => {
    const session = new Session({ caseSensitive: false })
    registerAssertions(session)
    for (const n of ASSERTION_NAMES) expect(session.hostFns.get(n), n).toBeDefined()
    expect(ASSERTION_NAMES).toContain('ASSERT_NOT_EQUAL_LWORD')
    expect(ASSERTION_NAMES).toContain('ASSERT_EQUAL_DT')
    expect(ASSERTION_NAMES).toHaveLength(6 + 21 * 2)
  })

  it('typed variants range-check literals and reject other types', () => {
    const session = new Session({ caseSensitive: false })
    registerAssertions(session)
    call(session, 'ASSERT_EQUAL_INT', sc('DINT', 5), sc('INT', 5))
    expect(() => call(session, 'ASSERT_EQUAL_INT', sc('DINT', 70000), sc('DINT', 70000))).toThrow(/type mismatch/)
    expect(() => call(session, 'ASSERT_EQUAL_BYTE', sc('INT', 5), sc('STRING', 'x'))).toThrow(AssertionFailure)
    call(session, 'ASSERT_EQUAL_REAL', sc('LREAL', 1.1), sc('REAL', Math.fround(1.1)))
    call(session, 'ASSERT_NOT_EQUAL_TIME', sc('TIME', 1n), sc('TIME', 2n))
  })

  it('malformed calls raise IecRuntimeError, and NEAR boundary is inclusive', () => {
    const session = new Session({ caseSensitive: false })
    registerAssertions(session)
    expect(() => call(session, 'ASSERT_TRUE', sc('INT', 1))).toThrow(IecRuntimeError)
    expect(() => call(session, 'ASSERT_NEAR', sc('INT', 1), sc('REAL', 1), sc('REAL', 1))).toThrow(IecRuntimeError)
    call(session, 'ASSERT_NEAR', sc('LREAL', 1.0), sc('LREAL', 1.1), sc('LREAL', 0.1))
  })
})

describe('formatValue', () => {
  it('formats times, reals, strings, containers', () => {
    expect(formatTime(1_500_000_000n)).toBe('T#1s500ms')
    expect(formatTime(0n)).toBe('T#0s')
    expect(formatTime(-60_000_000_000n)).toBe('T#-1m')
    expect(formatValue(sc('REAL', Math.fround(0.1)))).toBe('0.1')
    expect(formatValue(sc('LREAL', 0.1 + 0.2))).toBe('0.30000000000000004')
    expect(formatValue(sc('LREAL', 5))).toBe('5.0')
    expect(formatValue(sc('STRING', "it's"))).toBe("'it$'s'")
    expect(formatValue({ kind: 'enum', typeName: 'E_X', value: 2 })).toBe('E_X(2)')
    const arr: IecValue = { kind: 'array', elemType: 'INT', dims: [[1, 2], [0, 1]], data: [1, 2, 3, 4].map((n) => sc('INT', n)) }
    expect(formatValue(arr)).toBe('[[1, 2], [3, 4]]')
    expect(formatValue({ kind: 'struct', typeName: 'S', fields: new Map([['a', sc('BOOL', true)]]) })).toBe('{a := TRUE}')
  })
})
