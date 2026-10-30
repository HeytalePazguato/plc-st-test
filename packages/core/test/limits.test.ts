import { describe, it, expect, beforeAll } from 'vitest'
import type { Language } from 'web-tree-sitter'
import { SourceMap, type Project, type SourceUnit } from '@plc-st/project-model'
import { loadGrammar, baseGrammarPath } from '../src/parser/parse.js'
import { buildSymbolTableFromProject } from '../src/symbols/table.js'
import { createEvalContext, instantiateFb } from '../src/interpreter/pou.js'
import { SimClock } from '../src/interpreter/clock.js'
import { CycleEngine } from '../src/interpreter/cycle.js'
import { Session } from '../src/session.js'
import { DEFAULT_LIMITS, type Limits } from '../src/limits.js'
import { IecError, IecLimitError } from '../src/errors.js'

let lang: Language

function unit(id: string, text: string): SourceUnit {
  const lines = text.split('\n').length
  return { id, role: 'pou', isTest: false, text, map: SourceMap.fromJSON([{ genStartLine: 1, lineCount: lines, file: `${id}.TcPOU`, origStartLine: 1, origStartCol: 1 }]) }
}

function load(text: string, typeName: string, limits: Partial<Limits> = {}, instantiate = true) {
  const project: Project = { vendor: 'twincat', dialect: 'twincat', name: 'F', root: '/f', projectFile: '/f/F.plcproj', units: [unit('U', text)], libraries: [], defines: {}, warnings: [] }
  const symbols = buildSymbolTableFromProject(project, lang, { caseSensitive: false })
  expect(symbols.diagnostics).toEqual([])
  const session = new Session({ caseSensitive: false, limits: { ...DEFAULT_LIMITS, ...limits } })
  const engine = new CycleEngine(new SimClock(), 10_000_000n, session)
  const ctx = createEvalContext({ symbols, session, clock: engine })
  return { ctx, session, engine, suite: instantiate ? instantiateFb(typeName, ctx) : undefined }
}

const fb = (vars: string, body = '') => `FUNCTION_BLOCK TEST_L\nVAR\n${vars}\nEND_VAR\nMETHOD Cycle\n${body}\nEND_METHOD\nEND_FUNCTION_BLOCK\n`

describe('limits', () => {
  beforeAll(async () => {
    lang = await loadGrammar(baseGrammarPath())
  })

  it('exposes the new limits with their defaults and IecLimitError is an IecError', () => {
    expect(DEFAULT_LIMITS.maxAllocatedElements).toBe(10_000_000)
    expect(DEFAULT_LIMITS.maxStringLength).toBe(65_535)
    expect(new IecLimitError('x')).toBeInstanceOf(IecError)
    expect(new IecLimitError('x').name).toBe('IecLimitError')
  })

  it('rejects ARRAY[0..99999999] OF LREAL without allocating it', () => {
    const before = process.memoryUsage().heapUsed
    expect(() => load(fb('a : ARRAY[0..99999999] OF LREAL;'), 'TEST_L')).toThrow(IecLimitError)
    expect(() => load(fb('a : ARRAY[0..99999999] OF LREAL;'), 'TEST_L')).toThrow(/allocation limit exceeded/)
    const grown = process.memoryUsage().heapUsed - before
    expect(grown).toBeLessThan(50 * 1024 * 1024)
  })

  it('counts scalar slots into session.allocation and allows arrays within the limit', () => {
    const r = load(fb('a : ARRAY[0..9] OF INT;\nn : INT;'), 'TEST_L')
    expect(r.session.allocation).toBe(11)
  })

  it('accounts nested element cost: an array of structs is charged per field', () => {
    const src = `TYPE ST : STRUCT\n  a : INT;\n  b : INT;\nEND_STRUCT;\nEND_TYPE;\n${fb('arr : ARRAY[1..10] OF ST;')}`
    expect(() => load(src, 'TEST_L', { maxAllocatedElements: 20 })).toThrow(IecLimitError)
    expect(() => load(src, 'TEST_L', { maxAllocatedElements: 1000 })).not.toThrow()
  })

  it('overrides maxAllocatedElements through the Limits object', () => {
    expect(() => load(fb('a : ARRAY[0..99] OF INT;'), 'TEST_L', { maxAllocatedElements: 50 })).toThrow(IecLimitError)
    expect(() => load(fb('a : ARRAY[0..99] OF INT;'), 'TEST_L', { maxAllocatedElements: 500 })).not.toThrow()
  })

  it('startDeadline resets the allocation counter', () => {
    const r = load(fb('a : ARRAY[0..9] OF INT;'), 'TEST_L')
    expect(r.session.allocation).toBeGreaterThan(0)
    r.session.startDeadline(1000)
    expect(r.session.allocation).toBe(0)
    expect(r.session.deadline).toBe(1000 + DEFAULT_LIMITS.maxExecutionTimeMs)
  })

  it('rejects STRING lengths beyond maxStringLength at declaration', () => {
    expect(() => load(fb('s : STRING(70000);'), 'TEST_L')).toThrow(/max_string_length=65535/)
    expect(() => load(fb('s : STRING(65535);'), 'TEST_L')).not.toThrow()
    expect(() => load(fb('s : STRING(100);'), 'TEST_L', { maxStringLength: 50 })).toThrow(IecLimitError)
  })

  it('stops WHILE TRUE with a 200 ms deadline within 1 s', () => {
    const r = load(fb('', 'WHILE TRUE DO\nEND_WHILE'), 'TEST_L', { maxExecutionTimeMs: 200, maxLoopIterations: Number.MAX_SAFE_INTEGER })
    r.session.startDeadline()
    const t0 = Date.now()
    expect(() => r.engine.runCycles(1, r.suite!, r.ctx)).toThrow(/test exceeded max_execution_time_ms=200/)
    expect(Date.now() - t0).toBeLessThan(1000)
  })

  it('throws IecLimitError for the deadline and checks it once per cycle', () => {
    const r = load(fb('n : INT;', 'n := n + 1;'), 'TEST_L')
    r.session.startDeadline(Date.now() - 10_000_000)
    expect(() => r.engine.runCycles(1, r.suite!, r.ctx)).toThrow(IecLimitError)
  })

  it('does not enforce a deadline until startDeadline is called', () => {
    const r = load(fb('n : INT;', 'n := n + 1;'), 'TEST_L')
    expect(r.session.deadline).toBe(Infinity)
    expect(() => r.engine.runCycles(5, r.suite!, r.ctx)).not.toThrow()
  })

  it('raises IecLimitError when maxCyclesPerTest is exceeded', () => {
    const r = load(fb('n : INT;', 'n := n + 1;'), 'TEST_L', { maxCyclesPerTest: 3 })
    expect(() => r.engine.runCycles(4, r.suite!, r.ctx)).toThrow(IecLimitError)
    expect(() => r.engine.runCycles(1, r.suite!, r.ctx)).toThrow(/maxCyclesPerTest/)
  })
})
