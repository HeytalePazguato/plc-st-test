import { describe, it, expect, beforeAll } from 'vitest'
import type { Language } from 'web-tree-sitter'
import { SourceMap, type Project, type SourceUnit } from '@plc-st/project-model'
import { loadGrammar, baseGrammarPath } from '../src/parser/parse.js'
import { buildSymbolTableFromProject } from '../src/symbols/table.js'
import { createEvalContext, instantiateFb, type FbInstance } from '../src/interpreter/pou.js'
import { SimClock } from '../src/interpreter/clock.js'
import { CycleEngine } from '../src/interpreter/cycle.js'
import { Session } from '../src/session.js'
import { DEFAULT_LIMITS, type Limits } from '../src/limits.js'
import { IecLimitError, IecTimeoutError } from '../src/errors.js'

let lang: Language

const MACHINE = `
TYPE E_S : (IDLE := 0, S1, S2, S3, DONE) := IDLE;
END_TYPE

FUNCTION_BLOCK TEST_Machine
VAR
  eState : E_S;
  nTemp : INT;
END_VAR
VAR_TEMP
  nScratch : INT;
END_VAR
METHOD Cycle
nScratch := nScratch + 1;
nTemp := nScratch;
CASE eState OF
  E_S.IDLE: eState := E_S.S1;
  E_S.S1: eState := E_S.S2;
  E_S.S2: eState := E_S.S3;
  E_S.S3: eState := E_S.DONE;
END_CASE
END_METHOD
END_FUNCTION_BLOCK
`

const NO_CYCLE = `
FUNCTION_BLOCK TEST_Empty
VAR
  n : INT;
END_VAR
END_FUNCTION_BLOCK
`

function unit(id: string, text: string): SourceUnit {
  const lines = text.split('\n').length
  return { id, role: 'pou', isTest: false, text, map: SourceMap.fromJSON([{ genStartLine: 1, lineCount: lines, file: `${id}.TcPOU`, origStartLine: 1, origStartCol: 1 }]) }
}

function load(text: string, typeName: string, limits: Partial<Limits> = {}) {
  const project: Project = { vendor: 'twincat', dialect: 'twincat', name: 'F', root: '/f', projectFile: '/f/F.plcproj', units: [unit('U', text)], libraries: [], defines: {}, warnings: [] }
  const symbols = buildSymbolTableFromProject(project, lang, { caseSensitive: false })
  expect(symbols.diagnostics).toEqual([])
  const session = new Session({ caseSensitive: false, limits: { ...DEFAULT_LIMITS, ...limits } })
  const clock = new SimClock()
  const engine = new CycleEngine(clock, 10_000_000n, session)
  const ctx = createEvalContext({ symbols, session, clock: engine })
  const suite: FbInstance = instantiateFb(typeName, ctx)
  return { ctx, session, clock, engine, suite }
}

function field(inst: FbInstance, name: string): unknown {
  const v = inst.value.fields.get(name)
  if (v === undefined) throw new Error(name)
  return v.kind === 'enum' ? v.value : v.kind === 'scalar' ? v.value : v
}

describe('CycleEngine', () => {
  beforeAll(async () => {
    lang = await loadGrammar(baseGrammarPath())
  })

  it('a state machine in Cycle reaches state 4 after exactly 4 cycles', () => {
    const r = load(MACHINE, 'TEST_Machine')
    r.engine.runCycles(3, r.suite, r.ctx)
    expect(field(r.suite, 'eState')).toBe(3)
    r.engine.runCycles(1, r.suite, r.ctx)
    expect(field(r.suite, 'eState')).toBe(4)
    expect(r.engine.cycle).toBe(4)
  })

  it('runUntil returns the exact cycle count and caches the parsed fragment', () => {
    const r = load(MACHINE, 'TEST_Machine')
    expect(r.engine.runUntil('eState = E_S.DONE', 100, r.suite, r.ctx)).toBe(4)
    expect(r.clock.nowNs()).toBe(40_000_000n)
    // Already DONE: a second call consumes exactly one more cycle.
    expect(r.engine.runUntil('eState = E_S.DONE', 100, r.suite, r.ctx)).toBe(1)
  })

  it('runUntil throws IecTimeoutError naming the expression', () => {
    const r = load(MACHINE, 'TEST_Machine')
    expect(() => r.engine.runUntil('eState = E_S.S3 AND nTemp < 0', 5, r.suite, r.ctx)).toThrow(IecTimeoutError)
    expect(() => r.engine.runUntil('FALSE', 5, r.suite, r.ctx)).toThrow('RUN_UNTIL(FALSE) not TRUE after 5 cycles')
  })

  it('the clock equals n × cycle time and is visible to host code through ctx.clock', () => {
    const r = load(MACHINE, 'TEST_Machine')
    r.engine.runCycles(7, r.suite, r.ctx)
    expect(r.clock.nowNs()).toBe(70_000_000n)
    expect(r.ctx.clock?.nowNs).toBe(70_000_000n)
    expect(r.ctx.clock?.cycle).toBe(7)
  })

  it('resets the suite VAR_TEMP at the end of every cycle', () => {
    const r = load(MACHINE, 'TEST_Machine')
    r.engine.runCycles(3, r.suite, r.ctx)
    expect(field(r.suite, 'nTemp')).toBe(1)
  })

  it('a suite without a Cycle method only advances time', () => {
    const r = load(NO_CYCLE, 'TEST_Empty')
    r.engine.runCycles(3, r.suite, r.ctx)
    expect(r.clock.nowNs()).toBe(30_000_000n)
    expect(r.engine.cycle).toBe(3)
  })

  it('calls pre and post hooks once per cycle, in order, with the cycle number', () => {
    const r = load(MACHINE, 'TEST_Machine')
    const log: string[] = []
    r.session.preCycle.push((c) => log.push(`pre${String(c)}`))
    r.session.postCycle.push((c) => log.push(`post${String(c)}`))
    r.engine.runCycles(2, r.suite, r.ctx)
    expect(log).toEqual(['pre1', 'post1', 'pre2', 'post2'])
  })

  it('enforces maxCyclesPerTest cumulatively', () => {
    const r = load(MACHINE, 'TEST_Machine', { maxCyclesPerTest: 5 })
    r.engine.runCycles(3, r.suite, r.ctx)
    expect(() => r.engine.runCycles(3, r.suite, r.ctx)).toThrow(IecLimitError)
    expect(r.engine.cycle).toBe(5)
  })
})
