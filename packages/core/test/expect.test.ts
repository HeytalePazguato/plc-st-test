import { describe, it, expect, beforeAll } from 'vitest'
import type { SuiteResultV1 } from '@plc-st/plugin-api'
import type { Language } from 'web-tree-sitter'
import { SourceMap, type Project, type SourceUnit } from '@plc-st/project-model'
import { MOCK_NAMES } from '../src/mock/expect.js'
import { baseGrammarPath, loadGrammar } from '../src/parser/parse.js'
import { discoverSuites } from '../src/runner/discovery.js'
import { defaultSessionFactory, runSuiteDetailed } from '../src/runner/isolation.js'
import { buildSymbolTableFromProject } from '../src/symbols/table.js'

let lang: Language

function unit(id: string, text: string, file: string): SourceUnit {
  const lines = text.split('\n').length
  return { id, text, role: 'pou', isTest: true, map: SourceMap.fromJSON([{ genStartLine: 1, lineCount: lines, file, origStartLine: 1, origStartCol: 1 }]) }
}

const DUT = `FUNCTION_BLOCK FB_Client
VAR_INPUT
  nValue : DINT;
  sName : STRING(10);
END_VAR
VAR_OUTPUT
  bDone : BOOL;
END_VAR
METHOD Reset
END_METHOD
bDone := TRUE;
END_FUNCTION_BLOCK`

/** Runs `body` (test methods) against a suite owning `fb : FB_Client`; the single result per test, by name. */
function run(body: string, caseSensitive = false): Record<string, SuiteResultV1['tests'][number]> {
  const suite = `FUNCTION_BLOCK TEST_Expect
VAR
  fb : FB_Client;
END_VAR
${body}
END_FUNCTION_BLOCK`
  const project: Project = { vendor: 'standard', dialect: 'standard', name: 'F', root: '/f', projectFile: '/f/p', units: [unit('dut', DUT, 'dut.st'), unit('suite', suite, 'suite.st')], libraries: [], defines: {}, warnings: [] }
  const table = buildSymbolTableFromProject(project, lang, { caseSensitive })
  expect(table.diagnostics).toEqual([])
  const [desc] = discoverSuites(table, { strategy: 'method' }).suites
  const { result } = runSuiteDetailed(desc, { table, sessionFactory: defaultSessionFactory({ table }), cycleTimeNs: 10_000_000n })
  return Object.fromEntries(result.tests.map((t) => [t.name, t]))
}

/** Three calls recorded at cycles 1, 4 and 7. */
const THREE_CALLS = `MOCK('fb');
  RUN_CYCLES(1);
  fb(nValue := 10, sName := 'a');
  RUN_CYCLES(3);
  fb(nValue := 20, sName := 'b');
  RUN_CYCLES(3);
  fb(nValue := 30, sName := 'c');`

beforeAll(async () => {
  lang = await loadGrammar(baseGrammarPath())
})

describe('MOCK_NAMES', () => {
  it('lists the mock and expectation host functions', () => {
    expect(MOCK_NAMES).toEqual(['MOCK', 'MOCK_RETURNS', 'EXPECT_CALLS', 'EXPECT_CALLED_WITH', 'EXPECT_NOT_CALLED'])
  })
})

describe('EXPECT_CALLS', () => {
  it('passes when the count matches', () => {
    const r = run(`METHOD Test_A
  ${THREE_CALLS}
  EXPECT_CALLS('fb', 3);
END_METHOD`)
    expect(r.Test_A.status).toBe('passed')
  })

  it('fails listing the actual count and cycle numbers', () => {
    const r = run(`METHOD Test_A
  ${THREE_CALLS}
  EXPECT_CALLS('fb', 2);
END_METHOD`)
    expect(r.Test_A.status).toBe('failed')
    expect(r.Test_A.failure?.kind).toBe('assertion')
    expect(r.Test_A.failure?.message).toContain('3 calls at cycles 1, 4, 7')
    expect(r.Test_A.failure?.message).toContain('expected 2 calls')
  })

  it('counts the calls recorded at that moment and handles zero and one', () => {
    const r = run(`METHOD Test_Moment
  MOCK('fb');
  EXPECT_CALLS('fb', 0);
  RUN_CYCLES(2);
  fb();
  EXPECT_CALLS('fb', 1);
  fb();
  EXPECT_CALLS('fb', 2);
END_METHOD
METHOD Test_One
  MOCK('fb');
  RUN_CYCLES(2);
  fb();
  EXPECT_CALLS('fb', 0);
END_METHOD
METHOD Test_Zero
  MOCK('fb');
  EXPECT_CALLS('fb', 1);
END_METHOD
METHOD Test_Method
  MOCK('fb');
  fb.Reset();
  EXPECT_CALLS('fb.Reset', 1);
  EXPECT_CALLS('fb', 0);
END_METHOD`)
    expect(r.Test_Moment.status).toBe('passed')
    expect(r.Test_One.failure?.message).toContain('actual 1 call at cycle 2')
    expect(r.Test_Zero.failure?.message).toContain('actual 0 calls')
    expect(r.Test_Method.status).toBe('passed')
  })

  it('rejects a non-integer or negative count and a non-string path', () => {
    const r = run(`METHOD Test_Real
  EXPECT_CALLS('fb', 1.5);
END_METHOD
METHOD Test_Negative
  EXPECT_CALLS('fb', -1);
END_METHOD
METHOD Test_Path
  EXPECT_CALLS(3, 1);
END_METHOD`)
    expect(r.Test_Real.status).toBe('errored')
    expect(r.Test_Real.failure?.message).toContain('n must be an integer')
    expect(r.Test_Negative.failure?.message).toContain('must not be negative')
    expect(r.Test_Path.failure?.message).toContain('path must be a STRING')
  })
})

describe('EXPECT_CALLED_WITH', () => {
  it('matches any recorded call by input name', () => {
    const r = run(`METHOD Test_A
  ${THREE_CALLS}
  EXPECT_CALLED_WITH('fb', 'nValue', 20);
  EXPECT_CALLED_WITH('fb', 'sName', 'c');
  EXPECT_CALLED_WITH('fb', 'NVALUE', 10);
END_METHOD`)
    expect(r.Test_A.status).toBe('passed')
  })

  it('fails with the values that were seen', () => {
    const r = run(`METHOD Test_A
  ${THREE_CALLS}
  EXPECT_CALLED_WITH('fb', 'nValue', 99);
END_METHOD
METHOD Test_Input
  ${THREE_CALLS}
  EXPECT_CALLED_WITH('fb', 'nMissing', 1);
END_METHOD
METHOD Test_Never
  MOCK('fb');
  EXPECT_CALLED_WITH('fb', 'nValue', 1);
END_METHOD`)
    expect(r.Test_A.failure?.kind).toBe('assertion')
    expect(r.Test_A.failure?.message).toContain('never called with nValue := 99; nValue was 10, 20, 30')
    expect(r.Test_Input.failure?.message).toContain("has no input 'nMissing' (recorded inputs: nValue, sName)")
    expect(r.Test_Never.failure?.message).toContain("'fb' was never called")
  })

  it('is case sensitive in a case-sensitive dialect', () => {
    const r = run(`METHOD Test_A
  ${THREE_CALLS}
  EXPECT_CALLED_WITH('fb', 'NVALUE', 10);
END_METHOD`, true)
    expect(r.Test_A.status).toBe('failed')
  })
})

describe('EXPECT_NOT_CALLED', () => {
  it('passes without calls and fails listing them otherwise', () => {
    const r = run(`METHOD Test_Pass
  MOCK('fb');
  EXPECT_NOT_CALLED('fb');
END_METHOD
METHOD Test_Fail
  ${THREE_CALLS}
  EXPECT_NOT_CALLED('fb');
END_METHOD`)
    expect(r.Test_Pass.status).toBe('passed')
    expect(r.Test_Fail.status).toBe('failed')
    expect(r.Test_Fail.failure?.message).toContain('3 calls at cycles 1, 4, 7')
  })
})
