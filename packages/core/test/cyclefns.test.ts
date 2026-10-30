import { describe, it, expect, beforeAll } from 'vitest'
import type { Language } from 'web-tree-sitter'
import { SourceMap, type Project, type SourceUnit } from '@plc-st/project-model'
import { loadGrammar, baseGrammarPath } from '../src/parser/parse.js'
import { buildSymbolTableFromProject } from '../src/symbols/table.js'
import { discoverSuites } from '../src/runner/discovery.js'
import { defaultSessionFactory, runSuite, type RunEnv } from '../src/runner/isolation.js'
import { registerCycleFns } from '../src/runner/cyclefns.js'
import { IecRuntimeError } from '../src/errors.js'
import { Session } from '../src/session.js'

let lang: Language

function unit(id: string, text: string, file: string): SourceUnit {
  const lines = text.split('\n').length
  return { id, text, role: 'pou', isTest: true, map: SourceMap.fromJSON([{ genStartLine: 1, lineCount: lines, file, origStartLine: 1, origStartCol: 1 }]) }
}

function project(units: SourceUnit[]): Project {
  return { vendor: 'standard', dialect: 'standard', name: 'F', root: '/f', projectFile: '/f/p', units, libraries: [], defines: {}, warnings: [] }
}

const SRC = `TYPE E_CalcState : (IDLE := 0, BUSY := 1, DONE := 2); END_TYPE

FUNCTION_BLOCK FB_Calc
VAR
  eState : E_CalcState := E_CalcState.DONE;
  nTicks : DINT := 0;
END_VAR
METHOD Reset
  eState := E_CalcState.BUSY;
  nTicks := 0;
END_METHOD
METHOD Run
  nTicks := nTicks + 1;
  IF eState = E_CalcState.BUSY AND nTicks >= 3 THEN
    eState := E_CalcState.IDLE;
  END_IF
END_METHOD
END_FUNCTION_BLOCK

FUNCTION_BLOCK TEST_Calc
VAR
  uut : FB_Calc;
  n : DINT;
END_VAR
METHOD Cycle
  uut.Run();
END_METHOD
METHOD Test_StateMachineReachesIdleAfterReset
  uut.Reset();
  RUN_CYCLES(5);
  ASSERT_EQUAL(uut.eState, E_CalcState.IDLE, 'should be idle');
END_METHOD
METHOD Test_UntilReturnsCycles
  uut.Reset();
  n := RUN_UNTIL('uut.eState = E_CalcState.IDLE', 10);
  ASSERT_EQUAL(n, 3);
END_METHOD
METHOD Test_UntilTimesOut
  uut.Reset();
  n := RUN_UNTIL('uut.nTicks > 100', 4);
END_METHOD
METHOD Test_NegativeCycles
  RUN_CYCLES(-1);
END_METHOD
END_FUNCTION_BLOCK`

function runIt() {
  const table = buildSymbolTableFromProject(project([unit('x', SRC, 'x.st')]), lang, { caseSensitive: false })
  const env: RunEnv = { table, sessionFactory: defaultSessionFactory({ table }), cycleTimeNs: 10_000_000n }
  const { suites } = discoverSuites(table, { strategy: 'method' })
  const suite = suites.find((s) => s.suite === 'TEST_Calc')!
  return runSuite(suite, env)
}

describe('RUN_CYCLES / RUN_UNTIL', () => {
  beforeAll(async () => {
    lang = await loadGrammar(baseGrammarPath())
  })

  it('runs the spec example: the state machine reaches IDLE after RUN_CYCLES(5)', () => {
    const t = runIt().tests.find((x) => x.name === 'Test_StateMachineReachesIdleAfterReset')!
    expect(t.failure).toBeUndefined()
    expect(t.status).toBe('passed')
  })

  it('RUN_UNTIL returns the number of cycles consumed', () => {
    const t = runIt().tests.find((x) => x.name === 'Test_UntilReturnsCycles')!
    expect(t.failure).toBeUndefined()
    expect(t.status).toBe('passed')
  })

  it('RUN_UNTIL timeout is failed/timeout and names the expression', () => {
    const t = runIt().tests.find((x) => x.name === 'Test_UntilTimesOut')!
    expect(t.status).toBe('failed')
    expect(t.failure?.kind).toBe('timeout')
    expect(t.failure?.message).toContain('uut.nTicks > 100')
  })

  it('RUN_CYCLES with a negative count is a runtime error', () => {
    const t = runIt().tests.find((x) => x.name === 'Test_NegativeCycles')!
    expect(t.status).toBe('errored')
    expect(t.failure?.kind).toBe('runtime')
  })

  it('errors outside a running test', () => {
    const session = new Session({ caseSensitive: false })
    registerCycleFns(session)
    const hc = {} as never
    expect(() => session.hostFns.get('RUN_CYCLES')!.call([{ value: { kind: 'scalar', type: 'DINT', value: 1 } }], hc)).toThrow(IecRuntimeError)
    expect(() => session.hostFns.get('RUN_CYCLES')!.call([{ value: { kind: 'scalar', type: 'DINT', value: 1 } }], hc)).toThrow('RUN_CYCLES can only be used inside a test')
  })
})
