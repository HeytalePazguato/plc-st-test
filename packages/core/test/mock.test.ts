import { describe, it, expect, beforeAll } from 'vitest'
import type { FbStubDef, SuiteResultV1 } from '@plc-st/plugin-api'
import type { Language } from 'web-tree-sitter'
import { SourceMap, type Project, type SourceUnit } from '@plc-st/project-model'
import { IecError } from '../src/errors.js'
import { createEvalContext, instantiateFb } from '../src/interpreter/pou.js'
import { levenshtein, resolveMockTarget } from '../src/mock/resolve.js'
import { baseGrammarPath, loadGrammar } from '../src/parser/parse.js'
import { discoverSuites } from '../src/runner/discovery.js'
import { defaultSessionFactory, runSuiteDetailed, type SuiteRun } from '../src/runner/isolation.js'
import { MockStore, type Session } from '../src/session.js'
import { buildSymbolTableFromProject, type SymbolTable } from '../src/symbols/table.js'

let lang: Language

function unit(id: string, text: string, file: string, extra: Partial<SourceUnit> = {}): SourceUnit {
  const lines = text.split('\n').length
  return { id, text, role: 'pou', isTest: true, map: SourceMap.fromJSON([{ genStartLine: 1, lineCount: lines, file, origStartLine: 1, origStartCol: 1 }]), ...extra }
}

function tableOf(units: SourceUnit[], caseSensitive = false): SymbolTable {
  const project: Project = { vendor: 'standard', dialect: 'standard', name: 'F', root: '/f', projectFile: '/f/p', units, libraries: [], defines: {}, warnings: [] }
  return buildSymbolTableFromProject(project, lang, { caseSensitive })
}

const DUT = `FUNCTION_BLOCK FB_Base
VAR_INPUT
  nBase : DINT;
END_VAR
END_FUNCTION_BLOCK

FUNCTION_BLOCK FB_CommsClient EXTENDS FB_Base
VAR_INPUT
  nValue : DINT;
  sName : STRING(10);
END_VAR
VAR_OUTPUT
  bDone : BOOL;
  nStatus : INT;
  rLevel : REAL;
END_VAR
VAR
  nSideEffect : DINT;
END_VAR
METHOD Connect : DINT
VAR_INPUT
  nPort : DINT;
END_VAR
nSideEffect := 100;
Connect := 42;
END_METHOD
nSideEffect := nSideEffect + 1;
bDone := TRUE;
END_FUNCTION_BLOCK

FUNCTION_BLOCK FB_Machine
VAR
  fbCommsClient : FB_CommsClient;
  nSeen : INT;
  bSeen : BOOL;
  nConnected : DINT;
END_VAR
fbCommsClient(nValue := 7, sName := 'abc', nStatus => nSeen);
bSeen := fbCommsClient.bDone;
nConnected := fbCommsClient.Connect(nPort := 502);
END_FUNCTION_BLOCK`

function suiteOf(body: string): string {
  return `FUNCTION_BLOCK TEST_Machine
VAR
  uut : FB_Machine;
  fbDirect : FB_CommsClient;
  nPlain : DINT;
  tmr : TON;
  b : BOOL;
  n : DINT;
END_VAR
METHOD Cycle
  uut();
END_METHOD
${body}
END_FUNCTION_BLOCK`
}

function run(body: string, extra: SourceUnit[] = [], caseSensitive = false): SuiteRun {
  const table = tableOf([unit('dut', DUT, 'dut.st'), unit('suite', suiteOf(body), 'suite.st'), ...extra], caseSensitive)
  expect(table.diagnostics).toEqual([])
  const sessionFactory = defaultSessionFactory({ table })
  const [desc] = discoverSuites(table, { strategy: 'method' }).suites
  return runSuiteDetailed(desc, { table, sessionFactory, cycleTimeNs: 10_000_000n })
}

const statusOf = (r: SuiteResultV1): string[] => r.tests.map((t) => `${t.name}:${t.status}${t.failure === undefined ? '' : `:${t.failure.message}`}`)

function expectPassed(r: SuiteRun): void {
  expect(statusOf(r.result)).toEqual(r.result.tests.map((t) => `${t.name}:passed`))
}

beforeAll(async () => {
  lang = await loadGrammar(baseGrammarPath())
})

describe('resolveMockTarget', () => {
  function suite(table: SymbolTable) {
    const session = defaultSessionFactory({ table })()
    return instantiateFb('TEST_Machine', createEvalContext({ symbols: table, session }))
  }

  it('walks dotted paths to the owner and the declared spelling, ignoring case by default', () => {
    const table = tableOf([unit('dut', DUT, 'dut.st'), unit('suite', suiteOf(''), 'suite.st')])
    const s = suite(table)
    const { owner, member } = resolveMockTarget('UUT.FBCOMMSCLIENT', s, table)
    expect(owner.typeName).toBe('FB_Machine')
    expect(member).toBe('fbCommsClient')
  })

  it('honours a case-sensitive dialect and still suggests the right spelling', () => {
    const table = tableOf([unit('dut', DUT, 'dut.st'), unit('suite', suiteOf(''), 'suite.st')], true)
    const s = suite(table)
    expect(resolveMockTarget('uut.fbCommsClient', s, table).member).toBe('fbCommsClient')
    expect(() => resolveMockTarget('uut.FBCommsClient', s, table)).toThrow("did you mean 'fbCommsClient'")
  })

  it('reports a typo as an IecError with the suggestion', () => {
    const table = tableOf([unit('dut', DUT, 'dut.st'), unit('suite', suiteOf(''), 'suite.st')])
    const s = suite(table)
    expect(() => resolveMockTarget('uut.fbComsClient', s, table)).toThrow(IecError)
    expect(() => resolveMockTarget('uut.fbComsClient', s, table)).toThrow("unknown mock target 'uut.fbComsClient' — did you mean 'fbCommsClient'?")
    expect(() => resolveMockTarget('ut.fbCommsClient', s, table)).toThrow("did you mean 'uut'")
  })

  it('drops the suggestion beyond distance 3 and rejects walking through a non-instance', () => {
    const table = tableOf([unit('dut', DUT, 'dut.st'), unit('suite', suiteOf(''), 'suite.st')])
    const s = suite(table)
    const far = (): unknown => resolveMockTarget('uut.somethingElseEntirely', s, table)
    expect(far).toThrow("unknown mock target 'uut.somethingElseEntirely'")
    expect(far).not.toThrow('did you mean')
    expect(() => resolveMockTarget('nPlain.x', s, table)).toThrow("'nPlain' is not a function block instance")
  })

  it('computes the edit distance', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3)
    expect(levenshtein('', 'abc')).toBe(3)
    expect(levenshtein('fbComsClient', 'fbCommsClient')).toBe(1)
  })
})

describe('MockStore', () => {
  it('keys paths under the case mode and clears', () => {
    const store = new MockStore(false)
    store.record('uut.Fb', { args: {}, cycle: 1 })
    expect(store.calls('UUT.fb')).toHaveLength(1)
    store.clear()
    expect(store.calls('uut.Fb')).toEqual([])
    const sensitive = new MockStore(true)
    sensitive.record('uut.Fb', { args: {}, cycle: 1 })
    expect(sensitive.calls('uut.fb')).toEqual([])
  })
})

describe('MOCK', () => {
  it('never runs the real body: the side-effect variable stays untouched and outputs stay at their defaults', () => {
    const r = run(`METHOD Test_Real
  RUN_CYCLES(2);
  ASSERT_EQUAL(uut.fbCommsClient.nSideEffect, 100);
  ASSERT_TRUE(uut.bSeen);
END_METHOD
METHOD Test_Mocked
  fbDirect();
  ASSERT_EQUAL(fbDirect.nSideEffect, 1);
  MOCK('fbDirect');
  fbDirect();
  fbDirect.Connect(nPort := 1);
  ASSERT_FALSE(fbDirect.bDone);
  MOCK('uut.fbCommsClient');
  RUN_CYCLES(3);
  ASSERT_FALSE(uut.bSeen);
  ASSERT_EQUAL(uut.nConnected, 0);
  ASSERT_EQUAL(uut.nSeen, 0);
END_METHOD`)
    expectPassed(r)
  })

  it('leaves a variable the real body would write through VAR_IN_OUT alone, and records it', () => {
    const fb = unit('fb', `FUNCTION_BLOCK FB_Side
VAR_IN_OUT
  nCounter : DINT;
END_VAR
nCounter := nCounter + 1;
END_FUNCTION_BLOCK`, 'fb.st')
    const table = tableOf([fb, unit('suite', `FUNCTION_BLOCK TEST_Side
VAR
  fbSide : FB_Side;
  nShared : DINT := 5;
END_VAR
METHOD Test_Real
  fbSide(nCounter := nShared);
  ASSERT_EQUAL(nShared, 6);
END_METHOD
METHOD Test_Mocked
  MOCK('fbSide');
  fbSide(nCounter := nShared);
  ASSERT_EQUAL(nShared, 5);
END_METHOD
END_FUNCTION_BLOCK`, 'suite.st')])
    const [desc] = discoverSuites(table, { strategy: 'method' }).suites
    const r = runSuiteDetailed(desc, { table, sessionFactory: defaultSessionFactory({ table }), cycleTimeNs: 1n })
    expectPassed(r)
    expect(r.sessions[1].mocks.calls('fbSide')[0].args.nCounter).toMatchObject({ value: 5 })
  })

  it('exposes only the declared inputs and outputs, inherited ones included', () => {
    const r = run(`METHOD Test_Internal
  MOCK('fbDirect');
  n := fbDirect.nSideEffect;
END_METHOD
METHOD Test_Inherited
  MOCK('fbDirect');
  fbDirect(nBase := 3);
END_METHOD`)
    const [internal, inherited] = r.result.tests
    expect(internal.status).toBe('errored')
    expect(internal.failure?.message).toContain('nSideEffect')
    expect(inherited.status).toBe('passed')
    expect(r.sessions[1].mocks.calls('fbDirect')[0].args.nBase).toMatchObject({ value: 3 })
  })

  it('records every invocation with its arguments and cycle, copied at call time', () => {
    const r = run(`METHOD Test_Record
  MOCK('uut.fbCommsClient');
  RUN_CYCLES(2);
  uut.fbCommsClient(nValue := 9);
  uut.fbCommsClient();
END_METHOD`)
    expectPassed(r)
    const calls = r.sessions[0].mocks.calls('uut.fbCommsClient')
    expect(calls.map((c) => c.cycle)).toEqual([1, 2, 2, 2])
    expect(calls[0].args).toEqual({
      nBase: { kind: 'scalar', type: 'DINT', value: 0 },
      nValue: { kind: 'scalar', type: 'DINT', value: 7 },
      sName: { kind: 'scalar', type: 'STRING', value: 'abc', maxLength: 10 },
    })
    expect(calls[2].args.nValue).toMatchObject({ value: 9 })
    // An unpassed input keeps its value, as it would for a real call.
    expect(calls[3].args.nValue).toMatchObject({ value: 9 })
  })

  it('records methods under path.Method, returning defaults without running them', () => {
    const r = run(`METHOD Test_Method
  MOCK('fbDirect');
  n := 5;
  n := fbDirect.CONNECT(nPort := 502);
  ASSERT_EQUAL(n, 0);
END_METHOD`)
    expectPassed(r)
    const { mocks } = r.sessions[0]
    expect(mocks.calls('fbDirect')).toEqual([])
    expect(mocks.calls('fbDirect.Connect')).toHaveLength(1)
    expect(mocks.calls('fbDirect.Connect')[0].args.nPort).toMatchObject({ value: 502 })
  })

  it('records actions under path.Action without running them', () => {
    const action = unit('act', 'nSideEffect := 55;', 'act.st', { role: 'action', owner: 'FB_CommsClient', name: 'Reset' })
    const r = run(
      `METHOD Test_Action
  MOCK('fbDirect');
  fbDirect.Reset();
END_METHOD`,
      [action],
    )
    expectPassed(r)
    expect(r.sessions[0].mocks.calls('fbDirect.Reset')).toHaveLength(1)
  })

  it('replaces host-implemented function blocks too', () => {
    const r = run(`METHOD Test_Timer
  MOCK('tmr');
  tmr(IN := TRUE, PT := T#0ms);
  RUN_CYCLES(1);
  tmr(IN := TRUE, PT := T#0ms);
  ASSERT_FALSE(tmr.Q);
END_METHOD
METHOD Test_Returns
  MOCK_RETURNS('tmr.Q', TRUE);
  tmr(IN := FALSE, PT := T#1s);
  ASSERT_TRUE(tmr.Q);
END_METHOD`)
    expectPassed(r)
    expect(r.sessions[0].mocks.calls('tmr')).toHaveLength(2)
  })

  it('does not let a stub def run through its mock', () => {
    const table = tableOf([unit('suite', `FUNCTION_BLOCK TEST_S
VAR
  fbStub : FB_Host;
END_VAR
METHOD Test_A
  MOCK('fbStub');
  fbStub(nIn := 3);
END_METHOD
END_FUNCTION_BLOCK`, 'suite.st')])
    let ran = 0
    const def: FbStubDef = { name: 'FB_Host', inputs: [{ name: 'nIn', type: 'DINT' }], outputs: [], call: () => (ran += 1) }
    const factory = defaultSessionFactory({ table })
    const sessionFactory = (): Session => {
      const s = factory()
      s.fbStubs.register(def, 'test')
      return s
    }
    const [desc] = discoverSuites(table, { strategy: 'method' }).suites
    const r = runSuiteDetailed(desc, { table, sessionFactory, cycleTimeNs: 1n })
    expectPassed(r)
    expect(ran).toBe(0)
    expect(r.sessions[0].mocks.calls('fbStub')).toHaveLength(1)
  })

  it('keeps a second MOCK of the same path a no-op, and no mock survives into the next test', () => {
    const r = run(`METHOD Test_Twice
  MOCK_RETURNS('fbDirect.nStatus', 5);
  fbDirect();
  MOCK('FBDIRECT');
  fbDirect();
  ASSERT_EQUAL(fbDirect.nStatus, 5);
END_METHOD
METHOD Test_Next
  fbDirect();
  ASSERT_TRUE(fbDirect.bDone);
END_METHOD`)
    expectPassed(r)
    expect(r.sessions[0].mocks.calls('fbDirect')).toHaveLength(2)
    expect(r.sessions[1].mocks.calls('fbDirect')).toEqual([])
  })

  it('resolves an output initializer naming a constant of the replaced FB', () => {
    const fb = unit('fb', `FUNCTION_BLOCK FB_Const
VAR CONSTANT
  cStart : DINT := 11;
END_VAR
VAR_OUTPUT
  nOut : DINT := cStart;
END_VAR
END_FUNCTION_BLOCK`, 'fb.st')
    const table = tableOf([fb, unit('suite', `FUNCTION_BLOCK TEST_C
VAR
  fbC : FB_Const;
END_VAR
METHOD Test_Const
  MOCK('fbC');
  ASSERT_EQUAL(fbC.nOut, 11);
END_METHOD
END_FUNCTION_BLOCK`, 'suite.st')])
    const [desc] = discoverSuites(table, { strategy: 'method' }).suites
    expectPassed(runSuiteDetailed(desc, { table, sessionFactory: defaultSessionFactory({ table }), cycleTimeNs: 1n }))
  })

  it('reports a typo, a non-instance target and a malformed call as test errors', () => {
    const r = run(`METHOD Test_Typo
  MOCK('uut.fbComsClient');
END_METHOD
METHOD Test_NotInstance
  MOCK('nPlain');
END_METHOD
METHOD Test_NotString
  MOCK(1);
END_METHOD`)
    expect(r.result.tests.map((t) => t.status)).toEqual(['errored', 'errored', 'errored'])
    const [typo, plain, notString] = r.result.tests.map((t) => t.failure?.message)
    expect(typo).toBe("unknown mock target 'uut.fbComsClient' — did you mean 'fbCommsClient'?")
    expect(plain).toContain("mock target 'nPlain' is not a function block instance")
    expect(notString).toContain('MOCK: path must be a STRING')
  })

  it('cannot be used outside a test', () => {
    const session = defaultSessionFactory({ table: tableOf([unit('dut', DUT, 'dut.st')]) })()
    const ctx = createEvalContext({ symbols: tableOf([unit('dut', DUT, 'dut.st')]), session })
    expect(() => ctx.callPou('MOCK', [{ value: { kind: 'scalar', type: 'STRING', value: 'uut' } }], ctx)).toThrow('MOCK can only be used inside a test')
  })
})

describe('MOCK_RETURNS', () => {
  it('makes the value visible to the caller after the call, through member reads and output bindings', () => {
    const r = run(`METHOD Test_Visible
  MOCK('uut.fbCommsClient');
  MOCK_RETURNS('uut.fbCommsClient.bDone', TRUE);
  MOCK_RETURNS('uut.fbCommsClient.nStatus', 3);
  RUN_CYCLES(1);
  ASSERT_TRUE(uut.bSeen);
  ASSERT_EQUAL(uut.nSeen, 3);
  ASSERT_EQUAL(uut.fbCommsClient.rLevel, REAL#0.0);
END_METHOD`)
    expectPassed(r)
  })

  it('persists across calls and overwrites of the output, and converts to the declared type', () => {
    const r = run(`METHOD Test_Persistent
  MOCK_RETURNS('fbDirect.nStatus', 70000);
  MOCK_RETURNS('fbDirect.rLevel', 2);
  ASSERT_EQUAL_REAL(fbDirect.rLevel, REAL#2.0);
  ASSERT_EQUAL(fbDirect.nStatus, 4464);
  fbDirect.nStatus := 1;
  fbDirect();
  ASSERT_EQUAL(fbDirect.nStatus, 4464);
END_METHOD
METHOD Test_Replaces
  MOCK_RETURNS('fbDirect.bDone', TRUE);
  MOCK_RETURNS('fbDirect.bDone', FALSE);
  fbDirect();
  ASSERT_FALSE(fbDirect.bDone);
END_METHOD`)
    expectPassed(r)
  })

  it('mocks an instance that is not mocked yet, so the real body cannot overwrite the value', () => {
    const r = run(`METHOD Test_Implicit
  MOCK_RETURNS('fbDirect.bDone', FALSE);
  fbDirect();
  ASSERT_FALSE(fbDirect.bDone);
END_METHOD`)
    expectPassed(r)
    expect(r.sessions[0].mocks.calls('fbDirect')).toHaveLength(1)
  })

  it('reports an unknown output, an input, a pathless target and a bad value', () => {
    const r = run(`METHOD Test_UnknownOutput
  MOCK_RETURNS('fbDirect.bDon', TRUE);
END_METHOD
METHOD Test_Input
  MOCK_RETURNS('fbDirect.nValue', 1);
END_METHOD
METHOD Test_NoOutput
  MOCK_RETURNS('fbDirect', TRUE);
END_METHOD
METHOD Test_BadValue
  MOCK_RETURNS('fbDirect.bDone', 'text');
END_METHOD`)
    expect(r.result.tests.map((t) => t.status)).toEqual(['errored', 'errored', 'errored', 'errored'])
    const [unknown, input, noOutput, bad] = r.result.tests.map((t) => t.failure?.message)
    expect(unknown).toBe("unknown mock target 'fbDirect.bDon' — did you mean 'bDone'?")
    expect(input).toContain("unknown mock target 'fbDirect.nValue'")
    expect(noOutput).toContain("must name an output as '<instance path>.<output>'")
    expect(bad).toBeDefined()
  })
})
