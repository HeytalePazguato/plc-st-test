import { describe, it, expect, beforeAll } from 'vitest'
import type { Language } from 'web-tree-sitter'
import { SourceMap, type Project, type SourceUnit } from '@plc-st/project-model'
import { loadGrammar, baseGrammarPath } from '../src/parser/parse.js'
import { buildSymbolTableFromProject } from '../src/symbols/table.js'
import { IecType } from '../src/interpreter/numeric.js'
import type { IecValue } from '../src/interpreter/values.js'
import { callInstance, createEvalContext, instantiateFb, type FbInstance } from '../src/interpreter/pou.js'
import type { EvalContext } from '../src/interpreter/context.js'
import { registerStdlib } from '../src/interpreter/stdlib/index.js'
import { Session } from '../src/session.js'

let lang: Language

/** Instantiates every stdlib block (CTU, CTD, CTUD, R_TRIG, F_TRIG, SR, RS) once and drives them from the same inputs on each call. */
const HARNESS = `
FUNCTION_BLOCK FB_Harness
VAR_INPUT
  bCU : BOOL;
  bCD : BOOL;
  bR : BOOL;
  bLD : BOOL;
  nPV : INT;
  bClk : BOOL;
  bS : BOOL;
  bR1 : BOOL;
END_VAR
VAR
  ctu : CTU;
  ctd : CTD;
  ctud : CTUD;
  rTrig : R_TRIG;
  fTrig : F_TRIG;
  sr : SR;
  rs : RS;
END_VAR
ctu(CU := bCU, R := bR, PV := nPV);
ctd(CD := bCD, LD := bLD, PV := nPV);
ctud(CU := bCU, CD := bCD, R := bR, LD := bLD, PV := nPV);
rTrig(CLK := bClk);
fTrig(CLK := bClk);
sr(S1 := bS, R := bR);
rs(S := bS, R1 := bR1);
END_FUNCTION_BLOCK
`

function unit(id: string, text: string): SourceUnit {
  const lines = text.split('\n').length
  return { id, role: 'pou', isTest: false, text, map: SourceMap.fromJSON([{ genStartLine: 1, lineCount: lines, file: `${id}.TcPOU`, origStartLine: 1, origStartCol: 1 }]) }
}

interface Rig {
  ctx: EvalContext
  harness: FbInstance
  /** Merges the given signals into the harness inputs (they keep their last value) and runs one call. */
  step: (next?: Partial<Signals>) => void
}

interface Signals {
  cu: boolean
  cd: boolean
  r: boolean
  ld: boolean
  pv: number
  clk: boolean
  s: boolean
  r1: boolean
}

const bool = (value: boolean): IecValue => ({ kind: 'scalar', type: IecType.BOOL, value })
const int = (value: number): IecValue => ({ kind: 'scalar', type: IecType.INT, value })

function rig(): Rig {
  const project: Project = { vendor: 'beckhoff', dialect: 'beckhoff', name: 'Fixture', root: '/fixture', projectFile: '/fixture/Fixture.plcproj', units: [unit('FB_Harness', HARNESS)], libraries: [], defines: {}, warnings: [] }
  const symbols = buildSymbolTableFromProject(project, lang, { caseSensitive: false })
  expect(symbols.diagnostics).toEqual([])
  const session = new Session({ caseSensitive: false })
  registerStdlib(session)
  const ctx = createEvalContext({ symbols, session })
  const harness = instantiateFb('FB_Harness', ctx)
  const sig: Signals = { cu: false, cd: false, r: false, ld: false, pv: 0, clk: false, s: false, r1: false }
  const step = (next: Partial<Signals> = {}): void => {
    Object.assign(sig, next)
    const args = [bool(sig.cu), bool(sig.cd), bool(sig.r), bool(sig.ld), int(sig.pv), bool(sig.clk), bool(sig.s), bool(sig.r1)]
    callInstance(harness, args.map((value) => ({ value })), ctx)
  }
  return { ctx, harness, step }
}

/** Value at a dotted path below `inst` (case-insensitive member names). */
function at(inst: FbInstance, path: string): IecValue {
  let v: IecValue | undefined = inst.value
  for (const part of path.split('.')) {
    if (v?.kind !== 'struct') throw new Error(`${path}: not a struct at ${part}`)
    v = [...v.fields.entries()].find(([k]) => k.toLowerCase() === part.toLowerCase())?.[1]
  }
  if (v === undefined) throw new Error(`${path} not found`)
  return v
}

function js(inst: FbInstance, path: string): unknown {
  const v = at(inst, path)
  if (v.kind !== 'scalar') throw new Error(`${path} is ${v.kind}`)
  return v.value
}

describe('stdlib basic function blocks', () => {
  beforeAll(async () => {
    lang = await loadGrammar(baseGrammarPath())
  })

  it('registers every block under its standard name', () => {
    const session = new Session({ caseSensitive: false })
    registerStdlib(session)
    for (const name of ['CTU', 'CTD', 'CTUD', 'R_TRIG', 'F_TRIG', 'SR', 'RS']) expect(session.fbStubs.get(name)?.name).toBe(name)
  })

  describe('counters', () => {
    it('CTU counts only rising edges of CU', () => {
      const r = rig()
      r.step({ cu: true })
      r.step({ cu: true })
      r.step({ cu: true })
      expect(js(r.harness, 'ctu.CV')).toBe(1)
      r.step({ cu: false })
      expect(js(r.harness, 'ctu.CV')).toBe(1)
      r.step({ cu: true })
      expect(js(r.harness, 'ctu.CV')).toBe(2)
    })

    it('CTU sets Q when CV reaches PV', () => {
      const r = rig()
      r.step({ pv: 2, cu: true })
      expect(js(r.harness, 'ctu.Q')).toBe(false)
      r.step({ cu: false })
      r.step({ cu: true })
      expect(js(r.harness, 'ctu.CV')).toBe(2)
      expect(js(r.harness, 'ctu.Q')).toBe(true)
    })

    it('CTU reset holds CV at 0 and does not count edges while R is TRUE', () => {
      const r = rig()
      r.step({ pv: 3, cu: true })
      r.step({ cu: false })
      r.step({ cu: true })
      expect(js(r.harness, 'ctu.CV')).toBe(2)
      r.step({ cu: false, r: true })
      expect(js(r.harness, 'ctu.CV')).toBe(0)
      expect(js(r.harness, 'ctu.Q')).toBe(false)
      r.step({ cu: true })
      expect(js(r.harness, 'ctu.CV')).toBe(0)
      r.step({ r: false })
      expect(js(r.harness, 'ctu.CV')).toBe(0)
    })

    it('CTD loads PV on LD, counts down on rising CD and sets Q when CV <= 0', () => {
      const r = rig()
      r.step({ ld: true, pv: 3 })
      expect(js(r.harness, 'ctd.CV')).toBe(3)
      expect(js(r.harness, 'ctd.Q')).toBe(false)
      r.step({ ld: false })
      r.step({ cd: true })
      r.step({ cd: false })
      r.step({ cd: true })
      r.step({ cd: false })
      r.step({ cd: true })
      expect(js(r.harness, 'ctd.CV')).toBe(0)
      expect(js(r.harness, 'ctd.Q')).toBe(true)
    })

    it('CTD underflows past zero (negative CV) and saturates at the INT minimum', () => {
      const r = rig()
      r.step({ ld: true, pv: 0 })
      r.step({ ld: false, cd: true })
      expect(js(r.harness, 'ctd.CV')).toBe(-1)
      expect(js(r.harness, 'ctd.Q')).toBe(true)
      r.step({ ld: true, pv: -32768 })
      r.step({ ld: false, cd: false })
      r.step({ cd: true })
      expect(js(r.harness, 'ctd.CV')).toBe(-32768)
      r.step({ cd: false })
      r.step({ cd: true })
      expect(js(r.harness, 'ctd.CV')).toBe(-32768)
    })

    it('CTD LD takes priority over counting', () => {
      const r = rig()
      r.step({ ld: true, pv: 3, cd: true })
      expect(js(r.harness, 'ctd.CV')).toBe(3)
    })

    it('CTUD counts up on CU and down on CD, with QU and QD tracking PV', () => {
      const r = rig()
      r.step({ pv: 2, cu: true })
      expect([js(r.harness, 'ctud.CV'), js(r.harness, 'ctud.QU'), js(r.harness, 'ctud.QD')]).toEqual([1, false, false])
      r.step({ cu: false })
      r.step({ cu: true })
      expect([js(r.harness, 'ctud.CV'), js(r.harness, 'ctud.QU'), js(r.harness, 'ctud.QD')]).toEqual([2, true, false])
      r.step({ cu: false, cd: true })
      expect([js(r.harness, 'ctud.CV'), js(r.harness, 'ctud.QU'), js(r.harness, 'ctud.QD')]).toEqual([1, false, false])
      r.step({ cd: false })
      r.step({ cd: true })
      expect([js(r.harness, 'ctud.CV'), js(r.harness, 'ctud.QU'), js(r.harness, 'ctud.QD')]).toEqual([0, false, true])
    })

    it('CTUD counts up when CU and CD rise on the same call, and R / LD take priority', () => {
      const r = rig()
      r.step({ pv: 2 })
      r.step({ cu: true, cd: true })
      expect(js(r.harness, 'ctud.CV')).toBe(1)
      r.step({ r: true })
      expect([js(r.harness, 'ctud.CV'), js(r.harness, 'ctud.QU'), js(r.harness, 'ctud.QD')]).toEqual([0, false, true])
      r.step({ r: false, ld: true, pv: 2 })
      expect([js(r.harness, 'ctud.CV'), js(r.harness, 'ctud.QU')]).toEqual([2, true])
    })
  })

  describe('edge detection', () => {
    it('R_TRIG Q is TRUE for exactly one invocation per rising edge', () => {
      const r = rig()
      const q: unknown[] = []
      for (const clk of [true, true, true, false, true]) {
        r.step({ clk })
        q.push(js(r.harness, 'rTrig.Q'))
      }
      expect(q).toEqual([true, false, false, false, true])
    })

    it('F_TRIG Q is TRUE for exactly one invocation per falling edge', () => {
      const r = rig()
      const q: unknown[] = []
      for (const clk of [true, true, false, false, true, false]) {
        r.step({ clk })
        q.push(js(r.harness, 'fTrig.Q'))
      }
      expect(q).toEqual([false, false, true, false, false, true])
    })
  })

  describe('bistables', () => {
    it('SR is set-dominant: S1 and R together give Q1 TRUE, and Q1 holds until R', () => {
      const r = rig()
      r.step({ s: true, r: true })
      expect(js(r.harness, 'sr.Q1')).toBe(true)
      r.step({ s: false, r: false })
      expect(js(r.harness, 'sr.Q1')).toBe(true)
      r.step({ r: true })
      expect(js(r.harness, 'sr.Q1')).toBe(false)
    })

    it('RS is reset-dominant: S and R1 together give Q1 FALSE, and Q1 holds until R1', () => {
      const r = rig()
      r.step({ s: true, r1: true })
      expect(js(r.harness, 'rs.Q1')).toBe(false)
      r.step({ s: true, r1: false })
      expect(js(r.harness, 'rs.Q1')).toBe(true)
      r.step({ s: false })
      expect(js(r.harness, 'rs.Q1')).toBe(true)
      r.step({ r1: true })
      expect(js(r.harness, 'rs.Q1')).toBe(false)
    })
  })
})
