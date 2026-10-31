import { describe, it, expect, beforeAll } from 'vitest'
import type { Language } from 'web-tree-sitter'
import { SourceMap, type Project, type SourceUnit } from '@plc-st/project-model'
import type { DialectHooks, FbInstanceRef, FbStubDef, HostFnDef } from '@plc-st/plugin-api'
import { loadGrammar, baseGrammarPath } from '../src/parser/parse.js'
import { buildSymbolTableFromProject } from '../src/symbols/table.js'
import { IecType } from '../src/interpreter/numeric.js'
import type { IecValue } from '../src/interpreter/values.js'
import type { EvalContext } from '../src/interpreter/context.js'
import { HOSTFN_SHADOWS_POU, callInstance, callPou, createEvalContext, disposeFb, fbInstanceOf, instantiateFb, type FbInstance } from '../src/interpreter/pou.js'
import { Session } from '../src/session.js'
import { DEFAULT_LIMITS, type Limits } from '../src/limits.js'
import { IecLimitError } from '../src/errors.js'

let lang: Language

const COUNTER = `
FUNCTION_BLOCK FB_Counter
VAR_INPUT
  bEnable : BOOL := TRUE;
END_VAR
VAR_OUTPUT
  nCount : INT;
END_VAR
VAR
  nStep : INT := 1;
END_VAR
METHOD SetStep : BOOL
VAR_INPUT
  n : INT;
END_VAR
THIS^.nStep := n;
SetStep := TRUE;
END_METHOD
METHOD Clear
Reset();
END_METHOD
IF bEnable THEN
  nCount := nCount + nStep;
END_IF
END_FUNCTION_BLOCK
`

const FUNCTIONS = `
FUNCTION F_Calls : INT
VAR
  nCalls : INT;
END_VAR
nCalls := nCalls + 1;
F_Calls := nCalls;
END_FUNCTION

FUNCTION F_Add : INT
VAR_INPUT
  a : INT;
  b : INT;
END_VAR
F_Add := a + b;
END_FUNCTION

FUNCTION F_Rec : INT
VAR_INPUT
  n : INT;
END_VAR
IF n <= 0 THEN
  F_Rec := 0;
ELSE
  F_Rec := F_Rec(n - 1) + 1;
END_IF
END_FUNCTION

FUNCTION F_Swap : BOOL
VAR_IN_OUT
  x : INT;
  y : INT;
END_VAR
VAR_OUTPUT
  sum : INT;
END_VAR
VAR_TEMP
  t : INT;
END_VAR
t := x;
x := y;
y := t;
sum := x + y;
F_Swap := TRUE;
END_FUNCTION

FUNCTION_BLOCK FB_Inc
VAR_IN_OUT
  v : INT;
END_VAR
v := v + 1;
END_FUNCTION_BLOCK
`

/** A TON-like stub: Q follows IN once PT has been seen, ET mirrors PT; counts its own invocations in per-instance state. */
const TON_STUB: FbStubDef = {
  name: 'TON',
  inputs: [
    { name: 'IN', type: 'BOOL' },
    { name: 'PT', type: 'TIME' },
  ],
  outputs: [
    { name: 'Q', type: 'BOOL' },
    { name: 'ET', type: 'TIME' },
  ],
  createState: () => ({ calls: 0 }),
  call(state, io) {
    ;(state as { calls: number }).calls += 1
    io.set('Q', io.get('IN'))
    io.set('ET', io.get('PT'))
  },
}

interface Env {
  /** Extra units, e.g. actions. */
  actions?: { owner: string; name: string; body: string[] }[]
  hostFns?: HostFnDef[]
  stubs?: FbStubDef[]
  hooks?: DialectHooks
  limits?: Partial<Limits>
}

interface Loaded {
  ctx: EvalContext
  session: Session
  main: FbInstance
  /** Run one scan of PROGRAM Main. */
  scan: () => void
}

function unit(id: string, role: SourceUnit['role'], text: string, extra: Partial<SourceUnit> = {}): SourceUnit {
  const lines = text.split('\n').length
  return { id, role, isTest: false, text, map: SourceMap.fromJSON([{ genStartLine: 1, lineCount: lines, file: `${id}.TcPOU`, origStartLine: 1, origStartCol: 1 }]), ...extra }
}

/** Build PROGRAM Main with `decls` / `body` next to the FB_Counter and FUNCTIONS fixtures, and instantiate it. */
function load(decls: string[], body: string[], env: Env = {}): Loaded {
  const main = ['PROGRAM Main', 'VAR', ...decls, 'END_VAR', ...body, 'END_PROGRAM'].join('\n')
  const units = [unit('FB_Counter', 'pou', COUNTER), unit('Functions', 'pou', FUNCTIONS), unit('Main', 'pou', main)]
  for (const a of env.actions ?? []) units.push(unit(`${a.owner}.${a.name}`, 'action', a.body.join('\n'), { owner: a.owner, name: a.name }))
  const project: Project = { vendor: 'beckhoff', dialect: 'beckhoff', name: 'Fixture', root: '/fixture', projectFile: '/fixture/Fixture.plcproj', units, libraries: [], defines: {}, warnings: [] }
  const symbols = buildSymbolTableFromProject(project, lang, { caseSensitive: false })
  expect(symbols.diagnostics).toEqual([])
  const session = new Session({ caseSensitive: false, limits: { ...DEFAULT_LIMITS, ...env.limits } })
  for (const f of env.hostFns ?? []) session.hostFns.register(f, 'test')
  for (const s of env.stubs ?? [TON_STUB]) session.fbStubs.register(s, 'test')
  const ctx = createEvalContext({ symbols, session, hooks: env.hooks })
  const inst = instantiateFb('Main', ctx)
  return { ctx, session, main: inst, scan: () => callInstance(inst, [], ctx) }
}

/** Value at a dotted path below `inst`. */
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

const int = (n: number): IecValue => ({ kind: 'scalar', type: IecType.INT, value: n })

describe('POU dispatch', () => {
  beforeAll(async () => {
    lang = await loadGrammar(baseGrammarPath())
  })

  describe('function blocks', () => {
    it('a counter FB keeps its state across 3 calls', () => {
      const r = load(['fbA : FB_Counter;'], ['fbA();'])
      r.scan()
      r.scan()
      r.scan()
      expect(js(r.main, 'fbA.nCount')).toBe(3)
    })

    it('binds named inputs and keeps outputs readable after the call', () => {
      const r = load(['fbA : FB_Counter;', 'n : INT;'], ['fbA(bEnable := FALSE);', 'fbA(bEnable := TRUE, nCount => n);', 'n := n + fbA.nCount;'])
      r.scan()
      expect(js(r.main, 'fbA.bEnable')).toBe(true)
      expect(js(r.main, 'n')).toBe(2)
    })

    it('VAR_IN_OUT aliases the caller variable through the call', () => {
      const r = load(['fbI : FB_Inc;', 'n : INT := 5;'], ['fbI(v := n);', 'fbI(n);'])
      r.scan()
      expect(js(r.main, 'n')).toBe(7)
    })

    it('VAR_IN_OUT with a literal argument raises', () => {
      const r = load(['fbI : FB_Inc;'], ['fbI(v := 5);'])
      expect(r.scan).toThrow(/VAR_IN_OUT 'v' of 'FB_Inc' needs a variable argument.*Main\.TcPOU:5/)
    })

    it('invokes FB instances held in an array element', () => {
      const r = load(['arr : ARRAY[1..2] OF FB_Counter;', 'i : INT := 2;'], ['arr[i]();', 'arr[i]();', 'arr[1]();'])
      r.scan()
      const arr = at(r.main, 'arr')
      const counts = arr.kind === 'array' ? arr.data.map((e) => (e.kind === 'struct' ? e.fields.get('nCount') : undefined)) : []
      expect(counts).toEqual([int(1), int(2)])
    })

    it('rejects unknown parameters and too many positional arguments', () => {
      expect(load(['fbA : FB_Counter;'], ['fbA(bNope := TRUE);']).scan).toThrow(/'FB_Counter' has no input, output or in-out parameter 'bNope'/)
      expect(load(['fbA : FB_Counter;'], ['fbA(TRUE, 1);']).scan).toThrow(/too many arguments for 'FB_Counter'/)
    })
  })

  describe('functions', () => {
    it('a FUNCTION keeps no state between calls', () => {
      const r = load(['a : INT;', 'b : INT;'], ['a := F_Calls();', 'b := F_Calls();'])
      r.scan()
      expect(js(r.main, 'a')).toBe(1)
      expect(js(r.main, 'b')).toBe(1)
    })

    it('returns through the function-name variable with positional and named inputs', () => {
      const r = load(['a : INT;', 'b : INT;'], ['a := F_Add(2, 3);', 'b := F_Add(b := 10, a := 1);'])
      r.scan()
      expect(js(r.main, 'a')).toBe(5)
      expect(js(r.main, 'b')).toBe(11)
      expect(callPou('F_Add', [{ value: int(4) }, { value: int(5) }], r.ctx)).toEqual(int(9))
    })

    it('VAR_IN_OUT aliasing and output binding through a function call', () => {
      const r = load(['p : INT := 1;', 'q : INT := 2;', 's : INT;'], ['F_Swap(p, q, sum => s);'])
      r.scan()
      expect([js(r.main, 'p'), js(r.main, 'q'), js(r.main, 's')]).toEqual([2, 1, 3])
    })

    it('recursion within the limit works and beyond it raises', () => {
      const ok = load(['n : INT;'], ['n := F_Rec(5);'], { limits: { maxRecursionDepth: 10 } })
      ok.scan()
      expect(js(ok.main, 'n')).toBe(5)
      const deep = load(['n : INT;'], ['n := F_Rec(50);'], { limits: { maxRecursionDepth: 10 } })
      expect(deep.scan).toThrow(IecLimitError)
      expect(deep.scan).toThrow(/maximum of 10 \(limits\.maxRecursionDepth\) calling 'F_Rec'/)
    })

    it('an unknown callee raises with its location', () => {
      expect(load([], ['Nope();']).scan).toThrow(/'Nope' is not a function, function block instance, method or action at Main\.TcPOU:4/)
    })
  })

  describe('stub function blocks', () => {
    it('positional T1(bStart, T#5s) binds IN and PT', () => {
      const r = load(['T1 : TON;', 'bStart : BOOL := TRUE;', 'q : BOOL;'], ['T1(bStart, T#5s);', 'q := T1.Q;'])
      r.scan()
      expect(js(r.main, 'T1.IN')).toBe(true)
      expect(js(r.main, 'T1.PT')).toBe(5_000_000_000n)
      expect(js(r.main, 'T1.ET')).toBe(5_000_000_000n)
      expect(js(r.main, 'q')).toBe(true)
    })

    it('keeps per-instance stub state and supports output bindings', () => {
      const r = load(['T1 : TON;', 'T2 : TON;', 'q : BOOL;'], ['T1(IN := TRUE, PT := T#1s, Q => q);', 'T1(IN := FALSE);', 'T2();'])
      r.scan()
      const t1 = fbInstanceOf(at(r.main, 'T1'))
      const t2 = fbInstanceOf(at(r.main, 'T2'))
      expect(t1?.stub?.state).toEqual({ calls: 2 })
      expect(t2?.stub?.state).toEqual({ calls: 1 })
      expect(js(r.main, 'q')).toBe(true)
      expect(js(r.main, 'T1.Q')).toBe(false)
    })
  })

  describe('methods and actions', () => {
    it('a method mutates instance VAR (via THIS^) visible to the next body call', () => {
      const r = load(['fbA : FB_Counter;', 'ok : BOOL;'], ['ok := fbA.SetStep(5);', 'fbA();'])
      r.scan()
      expect(js(r.main, 'ok')).toBe(true)
      expect(js(r.main, 'fbA.nStep')).toBe(5)
      expect(js(r.main, 'fbA.nCount')).toBe(5)
      r.scan()
      expect(js(r.main, 'fbA.nCount')).toBe(10)
    })

    it('action Reset called as fb.Reset() mutates that instance only', () => {
      const actions = [{ owner: 'FB_Counter', name: 'Reset', body: ['nCount := 0;'] }]
      const r = load(['fbA : FB_Counter;', 'fbB : FB_Counter;'], ['fbA();', 'fbA();', 'fbB();', 'fbA.Reset();'], { actions })
      r.scan()
      expect(js(r.main, 'fbA.nCount')).toBe(0)
      expect(js(r.main, 'fbB.nCount')).toBe(1)
    })

    it('a bare action call inside the owner runs on the same instance', () => {
      const actions = [{ owner: 'FB_Counter', name: 'Reset', body: ['nCount := 0;'] }]
      const r = load(['fbA : FB_Counter;', 'fbB : FB_Counter;'], ['fbA();', 'fbB();', 'fbA.Clear();'], { actions })
      r.scan()
      expect(js(r.main, 'fbA.nCount')).toBe(0)
      expect(js(r.main, 'fbB.nCount')).toBe(1)
    })

    it('FbInstanceRef.hasMethod / callMethod', () => {
      const r = load(['fbA : FB_Counter;'], [])
      const fb = fbInstanceOf(at(r.main, 'fbA'))
      expect(fb?.hasMethod('setstep')).toBe(true)
      expect(fb?.hasMethod('Nope')).toBe(false)
      expect(fb?.callMethod('SetStep', [{ value: int(7) }])).toEqual({ kind: 'scalar', type: IecType.BOOL, value: true })
      expect(js(r.main, 'fbA.nStep')).toBe(7)
    })
  })

  describe('host functions', () => {
    it('take precedence over a user POU of the same name, with exactly one warning', () => {
      const hostAdd: HostFnDef = { name: 'F_Add', minArgs: 2, maxArgs: 2, call: () => int(99) }
      const r = load(['a : INT;', 'b : INT;'], ['a := F_Add(1, 2);', 'b := f_add(3, 4);'], { hostFns: [hostAdd] })
      r.scan()
      r.scan()
      expect(js(r.main, 'a')).toBe(99)
      expect(js(r.main, 'b')).toBe(99)
      const shadows = r.session.warnings.filter((w) => w.code === HOSTFN_SHADOWS_POU)
      expect(shadows).toHaveLength(1)
      expect(shadows[0]?.message).toContain("'F_Add'")
    })

    it('receive arguments and a call-site context; arity is checked', () => {
      const seen: unknown[] = []
      const double: HostFnDef = {
        name: 'DOUBLE',
        minArgs: 1,
        maxArgs: 1,
        call: (args, hc) => {
          seen.push(hc.location.file, hc.resolvePath('fbA.nStep')?.value)
          const v = args[0]?.value
          return v?.kind === 'scalar' ? int(Number(v.value) * 2) : undefined
        },
      }
      const r = load(['fbA : FB_Counter;', 'n : INT;'], ['n := DOUBLE(21);'], { hostFns: [double] })
      r.scan()
      expect(js(r.main, 'n')).toBe(42)
      expect(seen).toEqual(['Main.TcPOU', int(1)])
      expect(r.session.warnings).toEqual([])
      expect(load([], ['DOUBLE();'], { hostFns: [double] }).scan).toThrow(/'DOUBLE' takes 1 argument\(s\), got 0/)
    })
  })

  describe('lifecycle hooks', () => {
    it('onInstantiate / onDispose run once per instance, nested first', () => {
      const created: FbInstanceRef[] = []
      const disposed: FbInstanceRef[] = []
      const hooks: DialectHooks = {
        onInstantiate: (inst) => created.push(inst),
        onDispose: (inst) => disposed.push(inst),
      }
      const r = load(['fbA : FB_Counter;', 'fbB : FB_Counter;', 'T1 : TON;', 'arr : ARRAY[1..2] OF FB_Inc;'], ['fbA();', 'fbA();'], { hooks })
      r.scan()
      expect(created.map((i) => i.typeName)).toEqual(['FB_Counter', 'FB_Counter', 'TON', 'FB_Inc', 'FB_Inc', 'Main'])
      expect(new Set(created).size).toBe(created.length)
      disposeFb(r.main, r.ctx)
      disposeFb(r.main, r.ctx)
      expect(disposed).toHaveLength(created.length)
      expect(new Set(disposed)).toEqual(new Set(created))
      expect(disposed[disposed.length - 1]).toBe(r.main)
    })
  })
})
