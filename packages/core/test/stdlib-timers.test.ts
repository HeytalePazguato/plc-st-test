import { describe, it, expect, beforeAll } from 'vitest'
import type { Language } from 'web-tree-sitter'
import { SourceMap, type Project, type SourceUnit } from '@plc-st/project-model'
import { loadGrammar, baseGrammarPath } from '../src/parser/parse.js'
import { buildSymbolTableFromProject } from '../src/symbols/table.js'
import { IecType } from '../src/interpreter/numeric.js'
import { createEvalContext, instantiateFb, type FbInstance } from '../src/interpreter/pou.js'
import { SimClock } from '../src/interpreter/clock.js'
import { CycleEngine } from '../src/interpreter/cycle.js'
import { registerStdlib } from '../src/interpreter/stdlib/index.js'
import { Session } from '../src/session.js'

let lang: Language

/** Drives one TON, TOF and TP from the same IN/PT every scan cycle. */
const HARNESS = `
FUNCTION_BLOCK TEST_Timers
VAR
  bIn : BOOL;
  tPt : TIME := T#1s;
  ton : TON;
  tof : TOF;
  tp : TP;
END_VAR
METHOD Cycle
ton(IN := bIn, PT := tPt);
tof(IN := bIn, PT := tPt);
tp(IN := bIn, PT := tPt);
END_METHOD
END_FUNCTION_BLOCK
`

function unit(id: string, text: string): SourceUnit {
  const lines = text.split('\n').length
  return { id, role: 'pou', isTest: false, text, map: SourceMap.fromJSON([{ genStartLine: 1, lineCount: lines, file: `${id}.TcPOU`, origStartLine: 1, origStartCol: 1 }]) }
}

const MS = 1_000_000n

interface Rig {
  /** Sets IN. */
  input: (v: boolean) => void
  /** Sets PT in milliseconds. */
  pt: (ms: number) => void
  /** Runs `n` cycles of 1 ms each. */
  run: (n: number) => void
  q: (timer: 'ton' | 'tof' | 'tp') => boolean
  /** ET in milliseconds. */
  et: (timer: 'ton' | 'tof' | 'tp') => number
}

function rig(): Rig {
  const project: Project = { vendor: 'twincat', dialect: 'twincat', name: 'Fixture', root: '/fixture', projectFile: '/fixture/Fixture.plcproj', units: [unit('TEST_Timers', HARNESS)], libraries: [], defines: {}, warnings: [] }
  const symbols = buildSymbolTableFromProject(project, lang, { caseSensitive: false })
  expect(symbols.diagnostics).toEqual([])
  const session = new Session({ caseSensitive: false })
  registerStdlib(session)
  const engine = new CycleEngine(new SimClock(), MS, session)
  const ctx = createEvalContext({ symbols, session, clock: engine })
  const suite: FbInstance = instantiateFb('TEST_Timers', ctx)
  const member = (timer: string, name: string): bigint | boolean => {
    const t = suite.value.fields.get(timer)
    if (t?.kind !== 'struct') throw new Error(`${timer} is not a struct`)
    const v = t.fields.get(name)
    if (v?.kind !== 'scalar') throw new Error(`${timer}.${name} is not a scalar`)
    return v.value as bigint | boolean
  }
  return {
    input: (v) => suite.value.fields.set('bIn', { kind: 'scalar', type: IecType.BOOL, value: v }),
    pt: (ms) => suite.value.fields.set('tPt', { kind: 'scalar', type: IecType.TIME, value: BigInt(ms) * MS }),
    run: (n) => engine.runCycles(n, suite, ctx),
    q: (timer) => member(timer, 'Q') as boolean,
    et: (timer) => Number((member(timer, 'ET') as bigint) / MS),
  }
}

describe('stdlib timers', () => {
  beforeAll(async () => {
    lang = await loadGrammar(baseGrammarPath())
  })

  it('registers TON, TOF and TP', () => {
    const session = new Session({ caseSensitive: false })
    registerStdlib(session)
    for (const name of ['TON', 'TOF', 'TP']) expect(session.fbStubs.get(name)?.name).toBe(name)
  })

  describe('TON', () => {
    it('idle: Q FALSE and ET 0 while IN is FALSE', () => {
      const r = rig()
      r.run(5)
      expect(r.q('ton')).toBe(false)
      expect(r.et('ton')).toBe(0)
    })

    it('Q is FALSE after 999 ms and TRUE after 1001 ms with PT T#1s', () => {
      const r = rig()
      r.input(true)
      r.run(1) // the rising edge: timing starts here
      r.run(999)
      expect(r.q('ton')).toBe(false)
      expect(r.et('ton')).toBe(999)
      r.run(2)
      expect(r.q('ton')).toBe(true)
    })

    it('ET saturates at PT while Q stays TRUE', () => {
      const r = rig()
      r.input(true)
      r.run(2000)
      expect(r.q('ton')).toBe(true)
      expect(r.et('ton')).toBe(1000)
    })

    it('IN dropping before PT resets ET to 0 and Q stays FALSE', () => {
      const r = rig()
      r.input(true)
      r.run(500)
      expect(r.et('ton')).toBe(499)
      r.input(false)
      r.run(1)
      expect(r.et('ton')).toBe(0)
      expect(r.q('ton')).toBe(false)
    })

    it('IN dropping after Q rose clears Q and ET at once', () => {
      const r = rig()
      r.input(true)
      r.run(1500)
      r.input(false)
      r.run(1)
      expect(r.q('ton')).toBe(false)
      expect(r.et('ton')).toBe(0)
    })

    it('restarts timing from zero on the next rising edge', () => {
      const r = rig()
      r.input(true)
      r.run(500)
      r.input(false)
      r.run(10)
      r.input(true)
      r.run(1)
      r.run(900)
      expect(r.q('ton')).toBe(false)
      r.run(101)
      expect(r.q('ton')).toBe(true)
    })

    it('honours a PT change between calls', () => {
      const r = rig()
      r.input(true)
      r.run(500)
      r.pt(300)
      r.run(1)
      expect(r.q('ton')).toBe(true)
      expect(r.et('ton')).toBe(300)
    })
  })

  describe('TOF', () => {
    it('idle: Q FALSE and ET 0 while IN has never been TRUE', () => {
      const r = rig()
      r.run(5)
      expect(r.q('tof')).toBe(false)
      expect(r.et('tof')).toBe(0)
    })

    it('Q follows IN immediately when IN rises, with ET 0', () => {
      const r = rig()
      r.input(true)
      r.run(1)
      expect(r.q('tof')).toBe(true)
      expect(r.et('tof')).toBe(0)
    })

    it('Q stays TRUE for PT after IN falls (TRUE at 999 ms, FALSE at 1001 ms)', () => {
      const r = rig()
      r.input(true)
      r.run(10)
      r.input(false)
      r.run(1) // falling edge: timing starts here
      r.run(999)
      expect(r.q('tof')).toBe(true)
      expect(r.et('tof')).toBe(999)
      r.run(2)
      expect(r.q('tof')).toBe(false)
    })

    it('ET holds PT after expiry while IN stays FALSE', () => {
      const r = rig()
      r.input(true)
      r.run(1)
      r.input(false)
      r.run(3000)
      expect(r.q('tof')).toBe(false)
      expect(r.et('tof')).toBe(1000)
    })

    it('IN rising again during the delay keeps Q TRUE and resets ET to 0', () => {
      const r = rig()
      r.input(true)
      r.run(1)
      r.input(false)
      r.run(500)
      expect(r.et('tof')).toBe(499)
      r.input(true)
      r.run(1)
      expect(r.q('tof')).toBe(true)
      expect(r.et('tof')).toBe(0)
      r.run(2000)
      expect(r.q('tof')).toBe(true)
    })

    it('IN rising after expiry resets ET from PT to 0', () => {
      const r = rig()
      r.input(true)
      r.run(1)
      r.input(false)
      r.run(2000)
      r.input(true)
      r.run(1)
      expect(r.q('tof')).toBe(true)
      expect(r.et('tof')).toBe(0)
    })

    it('a new falling edge restarts the delay from zero', () => {
      const r = rig()
      r.input(true)
      r.run(1)
      r.input(false)
      r.run(600)
      r.input(true)
      r.run(1)
      r.input(false)
      r.run(1)
      r.run(900)
      expect(r.q('tof')).toBe(true)
      r.run(101)
      expect(r.q('tof')).toBe(false)
    })
  })

  describe('TP', () => {
    it('idle: Q FALSE and ET 0 while IN is FALSE', () => {
      const r = rig()
      r.run(5)
      expect(r.q('tp')).toBe(false)
      expect(r.et('tp')).toBe(0)
    })

    it('a rising edge starts the pulse: Q TRUE with ET counting', () => {
      const r = rig()
      r.input(true)
      r.run(1)
      expect(r.q('tp')).toBe(true)
      expect(r.et('tp')).toBe(0)
      r.run(500)
      expect(r.q('tp')).toBe(true)
      expect(r.et('tp')).toBe(500)
    })

    it('the pulse lasts PT (TRUE at 999 ms, FALSE at 1001 ms) even if IN is held', () => {
      const r = rig()
      r.input(true)
      r.run(1)
      r.run(999)
      expect(r.q('tp')).toBe(true)
      r.run(2)
      expect(r.q('tp')).toBe(false)
    })

    it('the pulse completes when IN falls before PT elapses', () => {
      const r = rig()
      r.input(true)
      r.run(1)
      r.input(false)
      r.run(500)
      expect(r.q('tp')).toBe(true)
      expect(r.et('tp')).toBe(500)
      r.run(501)
      expect(r.q('tp')).toBe(false)
    })

    it('ignores IN retriggers while the pulse runs', () => {
      const r = rig()
      r.input(true)
      r.run(1)
      r.run(400)
      r.input(false)
      r.run(100)
      r.input(true) // retrigger attempt at ~500 ms: must not extend the pulse
      r.run(1)
      r.run(600)
      expect(r.q('tp')).toBe(false)
    })

    it('ET holds PT after the pulse while IN stays TRUE', () => {
      const r = rig()
      r.input(true)
      r.run(3000)
      expect(r.q('tp')).toBe(false)
      expect(r.et('tp')).toBe(1000)
    })

    it('ET resets to 0 once the pulse has ended and IN is FALSE', () => {
      const r = rig()
      r.input(true)
      r.run(3000)
      r.input(false)
      r.run(1)
      expect(r.q('tp')).toBe(false)
      expect(r.et('tp')).toBe(0)
    })

    it('ET resets to 0 when the pulse ends with IN already FALSE', () => {
      const r = rig()
      r.input(true)
      r.run(1)
      r.input(false)
      r.run(1200)
      expect(r.q('tp')).toBe(false)
      expect(r.et('tp')).toBe(0)
    })

    it('a new rising edge after the pulse ended starts another pulse', () => {
      const r = rig()
      r.input(true)
      r.run(1)
      r.input(false)
      r.run(1500)
      r.input(true)
      r.run(1)
      expect(r.q('tp')).toBe(true)
      expect(r.et('tp')).toBe(0)
    })

    it('honours a PT change while the pulse runs', () => {
      const r = rig()
      r.input(true)
      r.run(1)
      r.run(200)
      r.pt(100)
      r.run(1)
      expect(r.q('tp')).toBe(false)
    })
  })
})
