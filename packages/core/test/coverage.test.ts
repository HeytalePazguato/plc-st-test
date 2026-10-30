import { describe, it, expect, beforeAll, vi } from 'vitest'
import type { Language } from 'web-tree-sitter'
import { SourceMap, type Project, type SourceUnit } from '@plc-st/project-model'
import { loadGrammar, baseGrammarPath } from '../src/parser/parse.js'
import { buildSymbolTableFromProject, type SymbolTable } from '../src/symbols/table.js'
import { discoverSuites } from '../src/runner/discovery.js'
import { defaultSessionFactory, runSuite } from '../src/runner/isolation.js'
import { CountingSink, instrument, startCoverage, summarizeCoverage, type CoverageRun } from '../src/coverage/instrument.js'
import type { Session } from '../src/session.js'

let lang: Language

const FILE = 'POUs/FB_Uut.TcPOU'
const TEST_FILE = 'Tests/TEST_Uut.TcPOU'
/** Original line of each production unit's first generated line, so a reported line that skipped the source map is visibly wrong. */
const ORIG_START = 100

function unit(id: string, lines: string[], extra: Partial<SourceUnit> = {}): SourceUnit {
  return {
    id,
    text: lines.join('\n'),
    role: 'pou',
    isTest: false,
    map: SourceMap.fromJSON([{ genStartLine: 1, lineCount: lines.length, file: FILE, origStartLine: ORIG_START, origStartCol: 1 }]),
    ...extra,
  }
}

function testUnit(id: string, lines: string[]): SourceUnit {
  return unit(id, lines, { isTest: true, map: SourceMap.identity(TEST_FILE, lines.length) })
}

function build(units: SourceUnit[]): SymbolTable {
  const project: Project = { vendor: 'standard', dialect: 'standard', name: 'F', root: '/f', projectFile: '/f/p', units, libraries: [], defines: {}, warnings: [] }
  const table = buildSymbolTableFromProject(project, lang, { caseSensitive: false })
  expect(table.diagnostics).toEqual([])
  return table
}

/** Original line of `FB_UUT[i]`. */
const line = (i: number): number => ORIG_START + i

const FB_UUT = [
  /* 0 */ 'FUNCTION_BLOCK FB_Uut',
  /* 1 */ 'VAR_INPUT',
  /* 2 */ '  b : BOOL;',
  /* 3 */ 'END_VAR',
  /* 4 */ 'VAR_OUTPUT',
  /* 5 */ '  n : INT;',
  /* 6 */ 'END_VAR',
  /* 7 */ 'IF b THEN',
  /* 8 */ '  n := 1;',
  /* 9 */ 'ELSE',
  /* 10 */ '  n := 2;',
  /* 11 */ 'END_IF',
  /* 12 */ 'END_FUNCTION_BLOCK',
]

/** A suite with one test per entry of `calls`, each running `calls[i]` on an instance `uut` of FB_Uut. */
function suite(calls: string[]): SourceUnit {
  return testUnit('test:Uut', ['FUNCTION_BLOCK TEST_Uut', 'VAR', '  uut : FB_Uut;', 'END_VAR', ...calls.flatMap((c, i) => [`METHOD Test_${String(i)}`, `  ${c}`, 'END_METHOD']), 'END_FUNCTION_BLOCK'])
}

/** Runs every suite of `table` with coverage enabled and returns the summary. */
function cover(table: SymbolTable, run: CoverageRun | undefined = startCoverage(table, { enabled: true })): ReturnType<typeof summarizeCoverage> {
  if (run === undefined) throw new Error('coverage is disabled')
  const sessionFactory = defaultSessionFactory({ table, coverage: run })
  const { suites } = discoverSuites(table, { strategy: 'method' })
  for (const desc of suites) {
    const result = runSuite(desc, { table, sessionFactory, cycleTimeNs: 10_000_000n })
    for (const test of result.tests) expect(test.failure).toBeUndefined()
  }
  return summarizeCoverage(run.branches, run.sink.snapshot())
}

function ids(table: SymbolTable): string[] {
  return instrument(table)
    .branches.map((b) => b.id)
    .sort()
}

beforeAll(async () => {
  lang = await loadGrammar(baseGrammarPath())
})

describe('coverage', () => {
  describe('acceptance', () => {
    it('an IF/ELSE whose tests only take the IF is 50 % with the ELSE missed at its original line', () => {
      const table = build([unit('pou:Uut', FB_UUT), suite(['uut(b := TRUE);'])])
      const summary = cover(table)
      expect(summary.pous).toEqual([{ name: 'FB_Uut', file: FILE, branchesTotal: 2, branchesHit: 1, missed: [{ line: line(9), kind: 'else' }] }])
      expect(summary.branchesHit / summary.branchesTotal).toBe(0.5)
    })

    it('hits add up across the tests of a run, each with its own session', () => {
      const table = build([unit('pou:Uut', FB_UUT), suite(['uut(b := TRUE);', 'uut(b := FALSE);'])])
      const summary = cover(table)
      expect(summary).toMatchObject({ branchesTotal: 2, branchesHit: 2 })
      expect(summary.pous[0].missed).toEqual([])
    })

    it('disabled coverage never constructs a sink, instruments nothing and leaves sessions without one', () => {
      const table = build([unit('pou:Uut', FB_UUT), suite(['uut(b := TRUE);'])])
      const createSink = vi.fn(() => new CountingSink())
      const run = startCoverage(table, { enabled: false, createSink })
      expect(run).toBeUndefined()

      const sessions: Session[] = []
      const base = defaultSessionFactory({ table, coverage: run })
      const sessionFactory = (): Session => {
        const session = base()
        sessions.push(session)
        return session
      }
      const { suites } = discoverSuites(table, { strategy: 'method' })
      expect(runSuite(suites[0], { table, sessionFactory, cycleTimeNs: 10_000_000n }).tests[0].status).toBe('passed')

      expect(createSink).not.toHaveBeenCalled()
      expect(sessions).toHaveLength(1)
      expect(sessions[0].coverage).toBeUndefined()
      expect(sessions[0].branches).toBeUndefined()
    })

    it('enabled coverage constructs one sink per run, whatever the number of tests', () => {
      const table = build([unit('pou:Uut', FB_UUT), suite(['uut(b := TRUE);', 'uut(b := FALSE);'])])
      const sink = new CountingSink()
      const hit = vi.spyOn(sink, 'hit')
      const createSink = vi.fn(() => sink)
      cover(table, startCoverage(table, { enabled: true, createSink }))
      expect(createSink).toHaveBeenCalledTimes(1)
      expect(hit).toHaveBeenCalledTimes(2)
    })

    it('test-suite POUs are excluded, even when they branch and their code runs', () => {
      const body = ['FUNCTION_BLOCK TEST_Branchy', 'VAR', '  uut : FB_Uut;', 'END_VAR', 'METHOD Test_A', '  IF TRUE THEN uut(b := TRUE); ELSE uut(b := FALSE); END_IF', 'END_METHOD', 'END_FUNCTION_BLOCK']
      const table = build([unit('pou:Uut', FB_UUT), testUnit('test:Branchy', body)])
      const run = startCoverage(table, { enabled: true })
      expect(run?.branches.branches.every((b) => b.pou === 'FB_Uut')).toBe(true)
      const hit = vi.spyOn(run?.sink as CountingSink, 'hit')
      const summary = cover(table, run)
      expect(summary.pous.map((p) => p.name)).toEqual(['FB_Uut'])
      expect(hit.mock.calls.every(([id]) => id.startsWith('FB_Uut:'))).toBe(true)
    })
  })

  describe('ids', () => {
    it('have the form <pou>:<origFile>:<line>:<kind>:<n>', () => {
      const table = build([unit('pou:Uut', FB_UUT)])
      expect(ids(table)).toEqual([`FB_Uut:${FILE}:${String(line(7))}:if:0`, `FB_Uut:${FILE}:${String(line(9))}:else:0`])
    })

    it('are the same on every instrumentation and every build', () => {
      const units = [unit('pou:Uut', FB_UUT)]
      expect(ids(build(units))).toEqual(ids(build(units)))
    })

    it('number the branches sharing a line, kind and POU in source order, and stay unique', () => {
      const table = build([unit('pou:P', ['PROGRAM P', 'VAR', '  a, b, c : BOOL;', 'END_VAR', 'IF a THEN ; ELSIF b THEN ; ELSIF c THEN ; END_IF IF a THEN ; END_IF', 'END_PROGRAM'])])
      const prefix = `P:${FILE}:${String(line(4))}`
      expect(instrument(table).branches.map((b) => b.id)).toEqual([`${prefix}:if:0`, `${prefix}:elsif:0`, `${prefix}:elsif:1`, `${prefix}:implicit-else:0`, `${prefix}:if:1`, `${prefix}:implicit-else:1`])
    })

    it('find their branch from a fresh node wrapper, including nested statements', () => {
      const table = build([unit('pou:P', ['PROGRAM P', 'VAR', '  a : BOOL;', 'END_VAR', 'IF a THEN', '  IF a THEN ; END_IF', 'END_IF', 'END_PROGRAM'])])
      const map = instrument(table)
      const nodes = table.getPou('P')?.bodyNode?.descendantsOfType('if_statement') ?? []
      expect(nodes).toHaveLength(2)
      expect(nodes.map((n) => map.idOf(n, 'if'))).toEqual([`P:${FILE}:${String(line(4))}:if:0`, `P:${FILE}:${String(line(5))}:if:0`])
    })
  })

  describe('arms', () => {
    /** Coverage of `FB_T`, with `body` after its VAR blocks, under one test calling it with each `k` in `calls`. */
    function fixture(body: string[], calls: string[]): ReturnType<typeof summarizeCoverage> {
      const vars = ['FUNCTION_BLOCK FB_T', 'VAR_INPUT', '  k : INT;', 'END_VAR', 'VAR', '  i : INT;', '  n : INT;', 'END_VAR']
      const table = build([unit('pou:T', [...vars, ...body, 'END_FUNCTION_BLOCK']), testUnit('test:T', ['FUNCTION_BLOCK TEST_T', 'VAR', '  uut : FB_T;', 'END_VAR', 'METHOD Test_A', ...calls.map((c) => `  uut(k := ${c});`), 'END_METHOD', 'END_FUNCTION_BLOCK'])])
      return cover(table)
    }
    /** Original line of `body[i]` in `fixture`. */
    const bodyLine = (i: number): number => ORIG_START + 8 + i

    it('counts an IF without ELSE as two branches: the implicit ELSE is missed at the IF line', () => {
      const s = fixture(['IF k > 0 THEN', '  n := 1;', 'END_IF'], ['1'])
      expect(s.pous[0]).toMatchObject({ branchesTotal: 2, branchesHit: 1, missed: [{ line: bodyLine(0), kind: 'implicit-else' }] })
    })

    it('hits the implicit ELSE when no arm is taken', () => {
      const s = fixture(['IF k > 0 THEN', '  n := 1;', 'END_IF'], ['0'])
      expect(s.pous[0]).toMatchObject({ branchesHit: 1, missed: [{ line: bodyLine(0), kind: 'if' }] })
    })

    it('tracks each ELSIF', () => {
      const s = fixture(['IF k = 1 THEN', '  n := 1;', 'ELSIF k = 2 THEN', '  n := 2;', 'ELSIF k = 3 THEN', '  n := 3;', 'ELSE', '  n := 4;', 'END_IF'], ['2', '9'])
      expect(s.pous[0]).toMatchObject({
        branchesTotal: 4,
        branchesHit: 2,
        missed: [
          { line: bodyLine(0), kind: 'if' },
          { line: bodyLine(4), kind: 'elsif' },
        ],
      })
    })

    it('tracks CASE arms and an explicit ELSE, a label list being one arm', () => {
      const s = fixture(['CASE k OF', '  1, 2: n := 1;', '  3..5: n := 2;', '  ELSE n := 3;', 'END_CASE'], ['2'])
      expect(s.pous[0]).toMatchObject({
        branchesTotal: 3,
        branchesHit: 1,
        missed: [
          { line: bodyLine(2), kind: 'case' },
          { line: bodyLine(3), kind: 'case-else' },
        ],
      })
    })

    it('counts the implicit ELSE of a CASE', () => {
      const body = ['CASE k OF', '  1: n := 1;', 'END_CASE']
      expect(fixture(body, ['1']).pous[0]).toMatchObject({ branchesTotal: 2, branchesHit: 1, missed: [{ line: bodyLine(0), kind: 'case-implicit-else' }] })
      expect(fixture(body, ['7']).pous[0]).toMatchObject({ branchesTotal: 2, branchesHit: 1, missed: [{ line: bodyLine(1), kind: 'case' }] })
    })

    it.each([
      ['FOR', ['FOR i := 1 TO k DO', '  n := i;', 'END_FOR'], 'for'],
      ['WHILE', ['i := 0;', 'WHILE i < k DO', '  i := i + 1;', 'END_WHILE'], 'while'],
    ])('tracks %s entered vs skipped, counting executions and not iterations', (_name, body, kind) => {
      const at = bodyLine(body.findIndex((l) => l.endsWith(' DO')))
      expect(fixture(body, ['3']).pous[0]).toMatchObject({ branchesTotal: 2, branchesHit: 1, missed: [{ line: at, kind: `${kind}-skipped` }] })
      expect(fixture(body, ['0']).pous[0]).toMatchObject({ branchesTotal: 2, branchesHit: 1, missed: [{ line: at, kind: `${kind}-entered` }] })
      expect(fixture(body, ['3', '0']).pous[0]).toMatchObject({ branchesHit: 2, missed: [] })
    })

    it('counts one hit per loop execution', () => {
      const table = build([unit('pou:T', ['FUNCTION_BLOCK FB_T', 'VAR', '  i : INT;', 'END_VAR', 'FOR i := 1 TO 5 DO', '  ;', 'END_FOR', 'END_FUNCTION_BLOCK']), testUnit('test:T', ['FUNCTION_BLOCK TEST_T', 'VAR', '  uut : FB_T;', 'END_VAR', 'METHOD Test_A', '  uut();', '  uut();', 'END_METHOD', 'END_FUNCTION_BLOCK'])])
      const run = startCoverage(table, { enabled: true })
      cover(table, run)
      expect([...(run?.sink.snapshot().values() ?? [])]).toEqual([2])
    })

    it('counts a loop left by EXIT as entered', () => {
      const s = fixture(['FOR i := 1 TO 5 DO', '  EXIT;', 'END_FOR'], ['0'])
      expect(s.pous[0]).toMatchObject({ branchesHit: 1, missed: [{ line: bodyLine(0), kind: 'for-skipped' }] })
    })

    it('gives REPEAT only an entered branch, as its body always runs', () => {
      const body = ['IF k > 0 THEN', '  REPEAT', '    i := i + 1;', '  UNTIL TRUE', '  END_REPEAT', 'END_IF']
      expect(fixture(body, ['1']).pous[0]).toMatchObject({ branchesTotal: 3, branchesHit: 2, missed: [{ line: bodyLine(0), kind: 'implicit-else' }] })
      expect(fixture(body, ['0']).pous[0].missed).toEqual([
        { line: bodyLine(0), kind: 'if' },
        { line: bodyLine(1), kind: 'repeat-entered' },
      ])
    })

    it('leaves a branch whose condition raised unhit', () => {
      const table = build([unit('pou:T', ['FUNCTION_BLOCK FB_T', 'VAR_INPUT', '  k : INT;', 'END_VAR', 'WHILE 1 / k > 0 DO', '  EXIT;', 'END_WHILE', 'END_FUNCTION_BLOCK']), testUnit('test:T', ['FUNCTION_BLOCK TEST_T', 'VAR', '  uut : FB_T;', 'END_VAR', 'METHOD Test_A', '  uut(k := 0);', 'END_METHOD', 'END_FUNCTION_BLOCK'])])
      const run = startCoverage(table, { enabled: true })
      if (run === undefined) throw new Error('coverage is disabled')
      const sessionFactory = defaultSessionFactory({ table, coverage: run })
      expect(runSuite(discoverSuites(table, { strategy: 'method' }).suites[0], { table, sessionFactory, cycleTimeNs: 1n }).tests[0].status).toBe('errored')
      expect(run.sink.snapshot().size).toBe(0)
    })
  })

  describe('POU members', () => {
    const MEMBERS = [
      /* 0 */ 'FUNCTION_BLOCK FB_M',
      /* 1 */ 'VAR',
      /* 2 */ '  x : INT;',
      /* 3 */ 'END_VAR',
      /* 4 */ 'METHOD M : INT',
      /* 5 */ 'VAR_INPUT',
      /* 6 */ '  k : INT;',
      /* 7 */ 'END_VAR',
      /* 8 */ '  IF k > 0 THEN',
      /* 9 */ '    M := 1;',
      /* 10 */ '  END_IF',
      /* 11 */ 'END_METHOD',
      /* 12 */ 'PROPERTY P : INT',
      /* 13 */ 'GET',
      /* 14 */ '  IF x > 0 THEN',
      /* 15 */ '    P := 1;',
      /* 16 */ '  END_IF',
      /* 17 */ 'END_GET',
      /* 18 */ 'SET',
      /* 19 */ '  IF P > 0 THEN',
      /* 20 */ '    x := P;',
      /* 21 */ '  END_IF',
      /* 22 */ 'END_SET',
      /* 23 */ 'END_PROPERTY',
      /* 24 */ 'END_FUNCTION_BLOCK',
    ]

    it('instruments methods and both property accessors, and attributes hits to them', () => {
      const table = build([unit('pou:M', MEMBERS), testUnit('test:M', ['FUNCTION_BLOCK TEST_M', 'VAR', '  m : FB_M;', '  n : INT;', 'END_VAR', 'METHOD Test_A', '  n := m.M(k := 1);', '  m.P := 5;', '  n := m.P;', 'END_METHOD', 'END_FUNCTION_BLOCK'])])
      const s = cover(table)
      expect(s.pous).toHaveLength(1)
      expect(s.pous[0]).toMatchObject({
        name: 'FB_M',
        branchesTotal: 6,
        branchesHit: 3,
        missed: [
          { line: line(8), kind: 'implicit-else' },
          { line: line(14), kind: 'implicit-else' },
          { line: line(19), kind: 'implicit-else' },
        ],
      })
    })

    it('attributes an inherited method to the POU declaring it', () => {
      const base = ['FUNCTION_BLOCK FB_Base', 'METHOD Go : BOOL', '  IF TRUE THEN', '    Go := TRUE;', '  END_IF', 'END_METHOD', 'END_FUNCTION_BLOCK']
      const derived = ['FUNCTION_BLOCK FB_Derived EXTENDS FB_Base', 'END_FUNCTION_BLOCK']
      const table = build([unit('pou:Base', base), unit('pou:Derived', derived), testUnit('test:D', ['FUNCTION_BLOCK TEST_D', 'VAR', '  d : FB_Derived;', '  r : BOOL;', 'END_VAR', 'METHOD Test_A', '  r := d.Go();', 'END_METHOD', 'END_FUNCTION_BLOCK'])])
      expect(cover(table).pous.map((p) => [p.name, p.branchesHit, p.branchesTotal])).toEqual([['FB_Base', 1, 2]])
    })

    it('does not count code a mock replaces', () => {
      const table = build([unit('pou:Uut', FB_UUT), suite(["MOCK('uut'); uut(b := TRUE);"])])
      expect(cover(table)).toMatchObject({ branchesTotal: 2, branchesHit: 0 })
    })

    it('covers a production action, statements at its top level included, in the action file with its original lines', () => {
      const actionMap = SourceMap.fromJSON([{ genStartLine: 1, lineCount: 3, file: 'POUs/Act.st', origStartLine: 50, origStartCol: 1 }])
      const table = build([
        unit('pou:Uut', ['FUNCTION_BLOCK FB_A', 'VAR', '  n : INT;', 'END_VAR', 'IF n > 0 THEN', '  n := 0;', 'END_IF', 'END_FUNCTION_BLOCK']),
        unit('act:A', ['IF n = 0 THEN', '  n := 2;', 'END_IF'], { role: 'action', owner: 'FB_A', name: 'Act', map: actionMap }),
        testUnit('test:A', ['FUNCTION_BLOCK TEST_A', 'VAR', '  a : FB_A;', 'END_VAR', 'METHOD Test_A', '  a.Act();', 'END_METHOD', 'END_FUNCTION_BLOCK']),
      ])
      expect(cover(table).pous).toEqual([
        { name: 'FB_A', file: FILE, branchesTotal: 2, branchesHit: 0, missed: [{ line: line(4), kind: 'if' }, { line: line(4), kind: 'implicit-else' }] },
        { name: 'FB_A', file: 'POUs/Act.st', branchesTotal: 2, branchesHit: 1, missed: [{ line: 50, kind: 'implicit-else' }] },
      ])
    })

    it('excludes an action from a test unit, even on a production POU', () => {
      const table = build([unit('pou:Uut', FB_UUT), unit('act:T', ['IF TRUE THEN', '  ;', 'END_IF'], { role: 'action', owner: 'FB_Uut', name: 'Helper', isTest: true })])
      expect(instrument(table).branches.map((b) => b.kind)).toEqual(['if', 'else'])
    })

    it('omits POUs without branches', () => {
      const table = build([unit('pou:Uut', FB_UUT), unit('pou:Plain', ['FUNCTION_BLOCK FB_Plain', 'END_FUNCTION_BLOCK'])])
      expect(summarizeCoverage(instrument(table), new Map()).pous.map((p) => p.name)).toEqual(['FB_Uut'])
    })
  })

  describe('CountingSink', () => {
    it('counts hits per id, and its snapshot is a copy', () => {
      const sink = new CountingSink()
      sink.hit('a')
      sink.hit('a')
      sink.hit('b')
      const snap = sink.snapshot()
      expect([...snap]).toEqual([
        ['a', 2],
        ['b', 1],
      ])
      sink.hit('a')
      expect(snap.get('a')).toBe(2)
    })
  })
})
