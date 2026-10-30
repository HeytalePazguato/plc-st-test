import { describe, it, expect, beforeAll } from 'vitest'
import type { Language } from 'web-tree-sitter'
import { SourceMap, type Project, type SourceUnit } from '@plc-st/project-model'
import { loadGrammar, baseGrammarPath } from '../src/parser/parse.js'
import { buildSymbolTableFromProject } from '../src/symbols/table.js'
import { discoverSuites } from '../src/runner/discovery.js'
import { defaultSessionFactory, runSuite, type RunEnv } from '../src/runner/isolation.js'
import { PARAM_NAMES } from '../src/runner/params.js'

let lang: Language

function unit(id: string, text: string, file: string, extra: Partial<SourceUnit> = {}): SourceUnit {
  const lines = text.split('\n').length
  return { id, text, role: 'pou', isTest: true, ...extra, map: SourceMap.fromJSON([{ genStartLine: 1, lineCount: lines, file, origStartLine: 1, origStartCol: 1 }]) }
}

function project(units: SourceUnit[]): Project {
  return { vendor: 'standard', dialect: 'standard', name: 'F', root: '/f', projectFile: '/f/p', units, libraries: [], defines: {}, warnings: [] }
}

function runSource(src: string) {
  return runUnits([unit('x', src, 'x.st')], 'method')
}

function runUnits(units: SourceUnit[], strategy: 'method' | 'action') {
  const table = buildSymbolTableFromProject(project(units), lang, { caseSensitive: false })
  const env: RunEnv = { table, sessionFactory: defaultSessionFactory({ table }), cycleTimeNs: 10_000_000n }
  const { suites } = discoverSuites(table, { strategy })
  return runSuite(suites.find((s) => s.suite === 'TEST_X')!, env)
}

const TYPES = `TYPE ST_Row : STRUCT
  nIn : DINT;
  nExp : DINT;
END_STRUCT END_TYPE

`

const HEAD = `${TYPES}FUNCTION_BLOCK TEST_X
VAR
  aTestData : ARRAY[0..3] OF ST_Row;
  nSetUps : DINT;
  nTearDowns : DINT;
  nBefore : DINT;
END_VAR
METHOD SetUp
  nSetUps := nSetUps + 1;
  aTestData[0].nIn := 1; aTestData[0].nExp := 2;
  aTestData[1].nIn := 2; aTestData[1].nExp := 4;
  aTestData[2].nIn := 3; aTestData[2].nExp := 7;
  aTestData[3].nIn := 4; aTestData[3].nExp := 8;
END_METHOD
METHOD TearDown
  nTearDowns := nTearDowns + 1;
END_METHOD
`

describe('FOR_EACH_ROW / ROW', () => {
  beforeAll(async () => {
    lang = await loadGrammar(baseGrammarPath())
  })

  it('lists its host function names', () => {
    expect(PARAM_NAMES).toEqual(['FOR_EACH_ROW', 'ROW'])
  })

  it('expands a 4-row table into Test_A[0]..[3] and fails only the bad row', () => {
    const r = runSource(`${HEAD}METHOD Test_A
  VAR
    row : ST_Row;
  END_VAR
  FOR_EACH_ROW('aTestData');
  row := ROW();
  ASSERT_EQUAL(row.nIn * 2, row.nExp);
END_METHOD
END_FUNCTION_BLOCK`)
    expect(r.tests.map((t) => t.fullName)).toEqual(['TEST_X.Test_A[0]', 'TEST_X.Test_A[1]', 'TEST_X.Test_A[2]', 'TEST_X.Test_A[3]'])
    expect(r.tests.map((t) => t.status)).toEqual(['passed', 'passed', 'failed', 'passed'])
    expect(r.tests[2].failure?.kind).toBe('assertion')
  })

  it('runs only the statements after FOR_EACH_ROW, with SetUp and TearDown per row on a fresh instance', () => {
    const r = runSource(`${HEAD}METHOD Test_A
  nBefore := nBefore + 1;
  FOR_EACH_ROW('aTestData');
  ASSERT_EQUAL(nSetUps, 1);
  ASSERT_EQUAL(nBefore, 0);
  ASSERT_EQUAL(nTearDowns, 0);
END_METHOD
END_FUNCTION_BLOCK`)
    expect(r.tests.map((t) => t.status)).toEqual(['passed', 'passed', 'passed', 'passed'])
  })

  it('leaves tests without FOR_EACH_ROW alone', () => {
    const r = runSource(`${HEAD}METHOD Test_B
  ASSERT_TRUE(TRUE);
END_METHOD
END_FUNCTION_BLOCK`)
    expect(r.tests.map((t) => t.name)).toEqual(['Test_B'])
  })

  it('errors on an unknown table and on ROW outside FOR_EACH_ROW', () => {
    const r = runSource(`${HEAD}METHOD Test_Unknown
  FOR_EACH_ROW('aMissing');
END_METHOD
END_FUNCTION_BLOCK`)
    expect(r.tests[0].status).toBe('errored')
    expect(r.tests[0].failure?.message).toContain("unknown variable 'aMissing'")

    const s = runSource(`${HEAD}METHOD Test_NoRow
  ROW();
END_METHOD
END_FUNCTION_BLOCK`)
    expect(s.tests[0].status).toBe('errored')
    expect(s.tests[0].failure?.message).toContain('ROW can only be used after FOR_EACH_ROW')
  })

  it('works in action-based tests', () => {
    const src = `${TYPES}PROGRAM TEST_X
VAR
  aTestData : ARRAY[0..3] OF ST_Row;
END_VAR
END_PROGRAM`
    const setUp = `aTestData[0].nIn := 1; aTestData[0].nExp := 2;
aTestData[1].nIn := 2; aTestData[1].nExp := 4;
aTestData[2].nIn := 3; aTestData[2].nExp := 7;
aTestData[3].nIn := 4; aTestData[3].nExp := 8;`
    const act = (name: string, body: string) => unit(`action:TEST_X.${name}`, body, 'x.st', { role: 'action', owner: 'TEST_X', name })
    const r = runUnits([unit('x', src, 'x.st'), act('SetUp', setUp), act('Test_A', "FOR_EACH_ROW('aTestData');\nASSERT_EQUAL(ROW().nIn * 2, ROW().nExp);")], 'action')
    expect(r.tests.map((t) => t.name)).toEqual(['Test_A[0]', 'Test_A[1]', 'Test_A[2]', 'Test_A[3]'])
    expect(r.tests.map((t) => t.status)).toEqual(['passed', 'passed', 'failed', 'passed'])
  })
})
