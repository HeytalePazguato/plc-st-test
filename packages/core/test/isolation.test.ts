import { describe, it, expect, beforeAll } from 'vitest'
import type { Language } from 'web-tree-sitter'
import { validateResultsV1 } from '@plc-st/plugin-api'
import { SourceMap, type Project, type SourceUnit } from '@plc-st/project-model'
import { loadGrammar, baseGrammarPath } from '../src/parser/parse.js'
import { buildSymbolTableFromProject } from '../src/symbols/table.js'
import { discoverSuites } from '../src/runner/discovery.js'
import { defaultSessionFactory, runSuite, type RunEnv } from '../src/runner/isolation.js'
import { runAll } from '../src/runner/results.js'
import { IecLimitError } from '../src/errors.js'
import type { Session } from '../src/session.js'
import { VERSION } from '../src/index.js'

let lang: Language

function unit(id: string, text: string, file: string, extra: Partial<SourceUnit> = {}): SourceUnit {
  const lines = text.split('\n').length
  return {
    id,
    text,
    role: 'pou',
    isTest: true,
    map: SourceMap.fromJSON([{ genStartLine: 1, lineCount: lines, file, origStartLine: 1, origStartCol: 1 }]),
    ...extra,
  }
}

function project(units: SourceUnit[]): Project {
  return { vendor: 'standard', dialect: 'standard', name: 'F', root: '/f', projectFile: '/f/p', units, libraries: [], defines: {}, warnings: [] }
}

const SRC = `FUNCTION_BLOCK TEST_X
VAR
  n : INT := 0;
END_VAR
METHOD SetUp
END_METHOD
METHOD TearDown
  TD();
END_METHOD
METHOD Test_1
  n := 5;
  ASSERT_EQUAL(n, 6);
END_METHOD
METHOD Test_2
  ASSERT_EQUAL(n, 0);
END_METHOD
METHOD Test_Wait
  WAIT_FOREVER();
END_METHOD
METHOD Test_Limit
  BLOW_UP();
END_METHOD
METHOD Test_Div
  n := 1 / n;
END_METHOD
METHOD Test_Internal
  BOOM();
END_METHOD
END_FUNCTION_BLOCK`

const ACTION_SRC = `PROGRAM TEST_P
VAR
  n : INT := 0;
END_VAR
END_PROGRAM`

const FAILING_TD = `FUNCTION_BLOCK TEST_T
METHOD TearDown
  ASSERT_TRUE(FALSE, 'teardown broke');
END_METHOD
METHOD Test_Ok
END_METHOD
END_FUNCTION_BLOCK`

function setup(units: SourceUnit[], strategy: 'method' | 'action' = 'method') {
  const table = buildSymbolTableFromProject(project(units), lang, { caseSensitive: false })
  const counts = { teardown: 0 }
  const base = defaultSessionFactory({ table })
  const sessionFactory = (): Session => {
    const s = base()
    const fn = (name: string, call: () => void) =>
      s.hostFns.register({ name, minArgs: 0, maxArgs: 0, call: () => (call(), undefined) }, 'test')
    fn('TD', () => void counts.teardown++)
    fn('WAIT_FOREVER', () => {
      const rt = s.runtime!
      rt.engine.runUntil('FALSE', 3, rt.suite, rt.ctx)
    })
    fn('BLOW_UP', () => {
      throw new IecLimitError('too big')
    })
    fn('BOOM', () => {
      throw new TypeError('kaput')
    })
    return s
  }
  const env: RunEnv = { table, sessionFactory, cycleTimeNs: 1_000_000n, project: { vendor: 'standard', dialect: 'standard', name: 'F', projectFile: '/f/p' } }
  const { suites } = discoverSuites(table, { strategy })
  return { table, env, suites, counts }
}

describe('isolation runner', () => {
  beforeAll(async () => {
    lang = await loadGrammar(baseGrammarPath())
  })

  it('isolates tests, runs TearDown for each, and names results Suite.Test', () => {
    const { env, suites, counts } = setup([unit('x', SRC, 'x.st')])
    const result = runSuite(suites[0], env)
    const by = (n: string) => result.tests.find((t) => t.name === n)!
    expect(by('Test_1').fullName).toBe('TEST_X.Test_1')
    expect(by('Test_1').status).toBe('failed')
    expect(by('Test_1').failure?.kind).toBe('assertion')
    expect(by('Test_1').failure?.expected).toBeDefined()
    expect(by('Test_1').failure?.location.file).toBe('x.st')
    expect(by('Test_2').status).toBe('passed')
    expect(by('Test_Wait').status).toBe('failed')
    expect(by('Test_Wait').failure?.kind).toBe('timeout')
    expect(by('Test_Wait').failure?.message).toContain('FALSE')
    expect(by('Test_Limit').status).toBe('errored')
    expect(by('Test_Limit').failure?.kind).toBe('limit')
    expect(by('Test_Div').status).toBe('errored')
    expect(by('Test_Div').failure?.kind).toBe('runtime')
    expect(by('Test_Internal').status).toBe('errored')
    expect(by('Test_Internal').failure?.message).toMatch(/^internal error:/)
    expect(counts.teardown).toBe(result.tests.length)
  })

  it('fails an otherwise passing test when TearDown fails', () => {
    const { env, suites } = setup([unit('t', FAILING_TD, 't.st')])
    const result = runSuite(suites[0], env)
    expect(result.tests[0].status).toBe('failed')
    expect(result.tests[0].failure?.message).toContain('teardown broke')
  })

  it('runs action-based tests', () => {
    const act = (name: string, body: string) => unit(`action:TEST_P.${name}`, body, 'p.st', { role: 'action', owner: 'TEST_P', name })
    const { env, suites } = setup([unit('p', ACTION_SRC, 'p.st'), act('A_Pass', 'n := 1;\nASSERT_EQUAL(n, 1);'), act('A_Fail', 'ASSERT_EQUAL(n, 1);')], 'action')
    const result = runSuite(suites[0], env)
    expect(result.tests.map((t) => [t.name, t.status])).toEqual([
      ['A_Pass', 'passed'],
      ['A_Fail', 'failed'],
    ])
  })

  it('exposes the current test runtime on the session while a test runs', () => {
    const { env, suites } = setup([unit('x', SRC, 'x.st')])
    expect(env.sessionFactory().runtime).toBeUndefined()
    expect(runSuite(suites[0], env).tests.length).toBeGreaterThan(0)
  })

  it('runAll builds a valid v1 document', () => {
    const { env, suites } = setup([unit('x', SRC, 'x.st')])
    const out = runAll(suites, env)
    expect(validateResultsV1(out)).toEqual([])
    expect(out.tool).toEqual({ name: 'plc-st-test', version: VERSION })
    expect(out.summary).toEqual({ total: 6, passed: 1, failed: 2, errored: 3, skipped: 0 })
    expect(Number.isNaN(Date.parse(out.startedAt))).toBe(false)
    expect(out.suites[0].name).toBe('TEST_X')
  })
})
