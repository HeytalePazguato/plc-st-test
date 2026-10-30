import { describe, it, expect, beforeAll } from 'vitest'
import type { Language } from 'web-tree-sitter'
import { SourceMap, type Project, type SourceUnit } from '@plc-st/project-model'
import { loadGrammar, baseGrammarPath } from '../src/parser/parse.js'
import { buildSymbolTableFromProject, type SymbolTable } from '../src/symbols/table.js'
import { IecType } from '../src/interpreter/numeric.js'
import type { IecValue } from '../src/interpreter/values.js'
import type { EvalContext } from '../src/interpreter/context.js'
import { callInstance, createEvalContext, instantiateFb, type FbInstance } from '../src/interpreter/pou.js'
import { mockAt } from '../src/mock/mock.js'
import { CycleEngine } from '../src/interpreter/cycle.js'
import { SimClock } from '../src/interpreter/clock.js'
import { registerStdlib } from '../src/interpreter/stdlib/index.js'
import { applyAutoStubs } from '../src/mock/autostub.js'
import { Session, type TestRuntime } from '../src/session.js'
import { DEFAULT_LIMITS, type Limits } from '../src/limits.js'
import { IecLimitError, IecRuntimeError } from '../src/errors.js'
import { INTERFACE_NOT_IMPLEMENTED } from '../src/oop/interface.js'

let lang: Language

function unit(id: string, text: string): SourceUnit {
  const lines = text.split('\n').length
  return { id, role: 'pou', isTest: false, text, map: SourceMap.fromJSON([{ genStartLine: 1, lineCount: lines, file: `${id}.st`, origStartLine: 1, origStartCol: 1 }]) }
}

function table(source: string): SymbolTable {
  const project: Project = { vendor: 'twincat', dialect: 'twincat', name: 'Fixture', root: '/fixture', projectFile: '/fixture/Fixture.plcproj', units: [unit('oop', source)], libraries: [], defines: {}, warnings: [] }
  return buildSymbolTableFromProject(project, lang, { caseSensitive: false })
}

interface Loaded {
  ctx: EvalContext
  session: Session
  main: FbInstance
  scan: () => void
  get: (name: string) => unknown
}

/** Build `source` next to PROGRAM Main with `decls` / `body`, and instantiate it. */
function load(source: string, decls: string[], body: string[], limits: Partial<Limits> = {}): Loaded {
  const text = `${source}\nPROGRAM Main\nVAR\n${decls.join('\n')}\nEND_VAR\n${body.join('\n')}\nEND_PROGRAM\n`
  const symbols = table(text)
  expect(symbols.diagnostics.filter((d) => d.code === undefined)).toEqual([])
  const session = new Session({ caseSensitive: false, limits: { ...DEFAULT_LIMITS, ...limits } })
  registerStdlib(session)
  const ctx = createEvalContext({ symbols, session })
  const main = instantiateFb('Main', ctx)
  return {
    ctx,
    session,
    main,
    scan: () => callInstance(main, [], ctx),
    get: (name) => {
      const v = main.value.fields.get(name)
      if (v?.kind !== 'scalar') throw new Error(`${name} is ${String(v?.kind)}`)
      return v.value
    },
  }
}

const int = (n: number): IecValue => ({ kind: 'scalar', type: IecType.INT, value: n })

const THERMOSTAT = `
FUNCTION_BLOCK FB_Thermostat
VAR
  _setpoint : INT := 20;
  nGets : INT;
  nSets : INT;
END_VAR
PROPERTY Setpoint : INT
GET
  nGets := nGets + 1;
  Setpoint := _setpoint;
END_GET
SET
  nSets := nSets + 1;
  IF Setpoint > 100 THEN
    _setpoint := 100;
  ELSE
    _setpoint := Setpoint;
  END_IF
END_SET
END_PROPERTY
PROPERTY Limit : INT
SET
  _setpoint := Limit;
END_SET
END_PROPERTY
PROPERTY Doubled : INT
GET
  Doubled := _setpoint * 2;
END_GET
END_PROPERTY
METHOD Bump
  Setpoint := Setpoint + 1;
  THIS^.Setpoint := THIS^.Setpoint + 1;
END_METHOD
METHOD ReadInternal : INT
  ReadInternal := _setpoint;
END_METHOD
END_FUNCTION_BLOCK
`

const SHAPES = `
FUNCTION_BLOCK FB_A
VAR_INPUT
  nIn : INT := 1;
END_VAR
VAR
  nA : INT := 10;
  sLog : STRING;
END_VAR
PROPERTY Tag : INT
GET
  Tag := 1;
END_GET
END_PROPERTY
METHOD Name : INT
  Name := 1;
END_METHOD
METHOD Describe : INT
  Describe := THIS^.Name() * 10;
END_METHOD
METHOD Chain : INT
  Chain := 1;
END_METHOD
sLog := CONCAT(sLog, 'A');
END_FUNCTION_BLOCK

FUNCTION_BLOCK FB_B EXTENDS FB_A
VAR
  nB : INT := 20;
END_VAR
PROPERTY Tag : INT
GET
  Tag := SUPER^.Tag + 1;
END_GET
END_PROPERTY
METHOD Name : INT
  Name := SUPER^.Name() + 1;
END_METHOD
METHOD Chain : INT
  Chain := SUPER^.Chain() + 10;
END_METHOD
sLog := CONCAT(sLog, 'B');
SUPER^();
END_FUNCTION_BLOCK

FUNCTION_BLOCK FB_C EXTENDS FB_B
METHOD Name : INT
  Name := SUPER.Name() + 100;
END_METHOD
METHOD Chain : INT
  Chain := SUPER^.Chain() + 100;
END_METHOD
METHOD Fields : INT
  Fields := SUPER^.nA + THIS^.nB;
END_METHOD
sLog := CONCAT(sLog, 'C');
SUPER^();
END_FUNCTION_BLOCK
`

const MOTORS = `
INTERFACE I_Named
METHOD GetName : INT
END_METHOD
END_INTERFACE

INTERFACE I_Motor EXTENDS I_Named
METHOD Speed : INT
VAR_INPUT
  n : INT;
END_VAR
END_METHOD
PROPERTY Rated : INT
GET
END_GET
SET
END_SET
END_PROPERTY
END_INTERFACE

FUNCTION_BLOCK FB_Slow IMPLEMENTS I_Motor
VAR
  _rated : INT := 5;
END_VAR
PROPERTY Rated : INT
GET
  Rated := _rated;
END_GET
SET
  _rated := Rated;
END_SET
END_PROPERTY
METHOD GetName : INT
  GetName := 1;
END_METHOD
METHOD Speed : INT
VAR_INPUT
  n : INT;
END_VAR
  Speed := n + 1;
END_METHOD
END_FUNCTION_BLOCK

FUNCTION_BLOCK FB_Fast EXTENDS FB_Slow
METHOD Speed : INT
VAR_INPUT
  n : INT;
END_VAR
  Speed := n * 100;
END_METHOD
END_FUNCTION_BLOCK

FUNCTION_BLOCK FB_Other
END_FUNCTION_BLOCK

FUNCTION F_Run : INT
VAR_INPUT
  m : I_Motor;
END_VAR
F_Run := m.Speed(n := 3);
END_FUNCTION
`

describe('OOP', () => {
  beforeAll(async () => {
    lang = await loadGrammar(baseGrammarPath())
  })

  describe('PROPERTY', () => {
    it('collects properties with their accessors', () => {
      const pou = table(THERMOSTAT).getPou('FB_Thermostat')
      expect(pou?.properties.map((p) => [p.name, p.get !== undefined, p.set !== undefined])).toEqual([
        ['Setpoint', true, true],
        ['Limit', false, true],
        ['Doubled', true, false],
      ])
    })

    it('runs SET on assignment, without running GET', () => {
      const { scan, get } = load(THERMOSTAT, ['t : FB_Thermostat;', 'nSets : INT;', 'nGets : INT;', 'nValue : INT;'], ['t.Setpoint := 150;', 'nSets := t.nSets;', 'nGets := t.nGets;', 'nValue := t.ReadInternal();'])
      scan()
      expect(get('nSets')).toBe(1)
      expect(get('nGets')).toBe(0)
      expect(get('nValue')).toBe(100)
    })

    it('runs GET on read', () => {
      const { scan, get } = load(THERMOSTAT, ['t : FB_Thermostat;', 'nValue : INT;', 'nGets : INT;'], ['nValue := t.Setpoint;', 'nGets := t.nGets;'])
      scan()
      expect(get('nValue')).toBe(20)
      expect(get('nGets')).toBe(1)
    })

    it('reaches properties by bare name and through THIS^ inside the instance', () => {
      const { scan, get } = load(THERMOSTAT, ['t : FB_Thermostat;', 'nValue : INT;'], ['t.Bump();', 'nValue := t.Setpoint;'])
      scan()
      expect(get('nValue')).toBe(22)
    })

    it('converts the assigned value to the declared type', () => {
      const { scan, get } = load(THERMOSTAT, ['t : FB_Thermostat;', 'nValue : INT;'], ['t.Setpoint := 41.5;', 'nValue := t.Setpoint;'])
      scan()
      expect(get('nValue')).toBe(42)
    })

    it('accepts a property as an output binding target, running only SET', () => {
      const source = `${THERMOSTAT}
FUNCTION_BLOCK FB_Out
VAR_OUTPUT
  Q : INT := 7;
END_VAR
END_FUNCTION_BLOCK`
      const { scan, get } = load(source, ['t : FB_Thermostat;', 'o : FB_Out;', 'nValue : INT;', 'nGets : INT;'], ['o(Q => t.Setpoint);', 'nGets := t.nGets;', 'nValue := t.ReadInternal();'])
      scan()
      expect(get('nValue')).toBe(7)
      expect(get('nGets')).toBe(0)
    })

    it('rejects reading a SET-only and writing a GET-only property', () => {
      const read = load(THERMOSTAT, ['t : FB_Thermostat;', 'nValue : INT;'], ['nValue := t.Limit;'])
      expect(() => read.scan()).toThrow(/property 'FB_Thermostat.Limit' has no GET accessor at oop\.st:\d+/)
      const write = load(THERMOSTAT, ['t : FB_Thermostat;'], ['t.Doubled := 1;'])
      expect(() => write.scan()).toThrow(/property 'FB_Thermostat.Doubled' has no SET accessor at oop\.st:\d+/)
    })

    it('counts accessors against the recursion limit', () => {
      const source = `
FUNCTION_BLOCK FB_Loop
PROPERTY P : INT
GET
  P := THIS^.P;
END_GET
END_PROPERTY
METHOD Bare : INT
  Bare := Q;
END_METHOD
PROPERTY Q : INT
GET
  Q := Q2;
END_GET
END_PROPERTY
PROPERTY Q2 : INT
GET
  Q2 := Q;
END_GET
END_PROPERTY
END_FUNCTION_BLOCK`
      const member = load(source, ['l : FB_Loop;', 'n : INT;'], ['n := l.P;'], { maxRecursionDepth: 16 })
      expect(() => member.scan()).toThrow(IecLimitError)
      const bare = load(source, ['l : FB_Loop;', 'n : INT;'], ['n := l.Bare();'], { maxRecursionDepth: 16 })
      expect(() => bare.scan()).toThrow(IecLimitError)
    })

    it('lets a variable win over a property of the same name', () => {
      const source = `
FUNCTION_BLOCK FB_Clash
VAR
  P : INT := 3;
END_VAR
PROPERTY P : INT
GET
  P := 9;
END_GET
END_PROPERTY
END_FUNCTION_BLOCK`
      const { scan, get } = load(source, ['c : FB_Clash;', 'n : INT;'], ['n := c.P;'])
      scan()
      expect(get('n')).toBe(3)
    })

    it('reads a property in a RUN_UNTIL expression', () => {
      const { ctx, main, session } = load(THERMOSTAT, ['t : FB_Thermostat;'], [])
      const engine = new CycleEngine(new SimClock(), 1_000_000n, session)
      expect(engine.runUntil('t.Setpoint = 20', 3, main, ctx)).toBe(1)
    })
  })

  describe('EXTENDS', () => {
    it('includes the base VARs in a derived instance', () => {
      const { main } = load(SHAPES, ['c : FB_C;'], [])
      const c = main.value.fields.get('c')
      expect(c?.kind === 'struct' ? [...c.fields.keys()] : []).toEqual(['nIn', 'nA', 'sLog', 'nB'])
    })

    it('accepts inherited inputs and member reads', () => {
      const { scan, get } = load(SHAPES, ['c : FB_C;', 'nIn : INT;', 'nFields : INT;'], ['c(nIn := 5);', 'nIn := c.nIn;', 'nFields := c.Fields();'])
      scan()
      expect(get('nIn')).toBe(5)
      expect(get('nFields')).toBe(30)
    })

    it('overrides a method, and SUPER^.M() and SUPER.M() reach the base', () => {
      const { scan, get } = load(SHAPES, ['a : FB_A;', 'b : FB_B;', 'c : FB_C;', 'nA : INT;', 'nB : INT;', 'nC : INT;'], ['nA := a.Name();', 'nB := b.Name();', 'nC := c.Name();'])
      scan()
      expect(get('nA')).toBe(1)
      expect(get('nB')).toBe(2)
      expect(get('nC')).toBe(102)
    })

    it('resolves SUPER from the declaring POU across three levels', () => {
      const { scan, get } = load(SHAPES, ['c : FB_C;', 'n : INT;'], ['n := c.Chain();'])
      scan()
      expect(get('n')).toBe(111)
    })

    it('dispatches an inherited method virtually', () => {
      const { scan, get } = load(SHAPES, ['b : FB_B;', 'n : INT;'], ['n := b.Describe();'])
      scan()
      expect(get('n')).toBe(20)
    })

    it('overrides a property, and SUPER^.P reaches the base', () => {
      const { scan, get } = load(SHAPES, ['a : FB_A;', 'c : FB_C;', 'nA : INT;', 'nC : INT;'], ['nA := a.Tag;', 'nC := c.Tag;'])
      scan()
      expect(get('nA')).toBe(1)
      expect(get('nC')).toBe(2)
    })

    it('SUPER^() runs each base body once, on the same instance', () => {
      const { scan, ctx, main } = load(SHAPES, ['c : FB_C;'], ['c();'])
      scan()
      const c = main.value.fields.get('c')
      expect(ctx.symbols.getPou('FB_C')?.extendsName).toBe('FB_B')
      expect(c?.kind === 'struct' ? c.fields.get('sLog') : undefined).toMatchObject({ value: 'CBA' })
    })

    it('SUPER^() keeps the caller\'s VAR_TEMP and resets the base\'s', () => {
      const source = `
FUNCTION_BLOCK FB_Base
VAR_TEMP
  tBase : INT;
END_VAR
VAR_OUTPUT
  nSeen : INT;
END_VAR
nSeen := tBase;
tBase := tBase + 1;
END_FUNCTION_BLOCK

FUNCTION_BLOCK FB_Derived EXTENDS FB_Base
VAR_TEMP
  tOwn : INT;
END_VAR
VAR_OUTPUT
  nOwn : INT;
END_VAR
tOwn := 5;
SUPER^();
SUPER^();
nOwn := tOwn;
END_FUNCTION_BLOCK`
      const { scan, get } = load(source, ['d : FB_Derived;', 'nOwn : INT;', 'nSeen : INT;'], ['d(nOwn => nOwn, nSeen => nSeen);'])
      scan()
      expect(get('nOwn')).toBe(5)
      expect(get('nSeen')).toBe(0)
    })

    it('reports a SUPER call without a base', () => {
      const source = `
FUNCTION_BLOCK FB_Root
METHOD M
  SUPER^.M();
END_METHOD
METHOD Body
  SUPER^();
END_METHOD
END_FUNCTION_BLOCK`
      const method = load(source, ['r : FB_Root;'], ['r.M();'])
      expect(() => method.scan()).toThrow(IecRuntimeError)
      const body = load(source, ['r : FB_Root;'], ['r.Body();'])
      expect(() => body.scan()).toThrow(IecRuntimeError)
    })
  })

  describe('THIS', () => {
    it('binds THIS^ in methods, for members and as an argument', () => {
      const source = `
FUNCTION_BLOCK FB_Peer
VAR
  nPeer : INT;
END_VAR
METHOD Take
VAR_INPUT
  other : I_Tag;
END_VAR
  nPeer := other.Tag();
END_METHOD
METHOD Get : INT
  Get := nPeer;
END_METHOD
END_FUNCTION_BLOCK

INTERFACE I_Tag
METHOD Tag : INT
END_METHOD
END_INTERFACE

FUNCTION_BLOCK FB_Self IMPLEMENTS I_Tag
VAR
  x : INT := 4;
  peer : FB_Peer;
END_VAR
METHOD Tag : INT
  Tag := THIS^.x * 2;
END_METHOD
METHOD Run : INT
  peer.Take(THIS^);
  Run := peer.Get();
END_METHOD
END_FUNCTION_BLOCK`
      const { scan, get } = load(source, ['s : FB_Self;', 'n : INT;'], ['n := s.Run();'])
      scan()
      expect(get('n')).toBe(8)
    })
  })

  describe('IMPLEMENTS', () => {
    const iface = `
INTERFACE I_Base
METHOD Stop
END_METHOD
END_INTERFACE

INTERFACE I_Run EXTENDS I_Base
METHOD Start
END_METHOD
PROPERTY Level : INT
GET
END_GET
END_PROPERTY
END_INTERFACE
`
    const messages = (source: string): string[] => table(iface + source).diagnostics.filter((d) => d.code === INTERFACE_NOT_IMPLEMENTED).map((d) => d.message)

    it('names the interface and the method a function block is missing', () => {
      const source = `
FUNCTION_BLOCK FB_Bad IMPLEMENTS I_Run
METHOD Stop
END_METHOD
PROPERTY Level : INT
GET
  Level := 1;
END_GET
END_PROPERTY
END_FUNCTION_BLOCK`
      expect(messages(source)).toEqual(["Function block 'FB_Bad' does not implement method 'Start' of interface 'I_Run'"])
    })

    it('locates the diagnostic at the function block', () => {
      const symbols = table(`${iface}\nFUNCTION_BLOCK FB_Bad IMPLEMENTS I_Base\nEND_FUNCTION_BLOCK`)
      const diagnostic = symbols.diagnostics.find((d) => d.code === INTERFACE_NOT_IMPLEMENTED)
      expect(diagnostic?.location).toMatchObject({ file: 'oop.st', line: 16 })
    })

    it('requires what the interface extends, and its properties', () => {
      const source = `
FUNCTION_BLOCK FB_Bad IMPLEMENTS I_Run
METHOD Start
END_METHOD
END_FUNCTION_BLOCK`
      expect(messages(source)).toEqual(["Function block 'FB_Bad' does not implement property 'Level' of interface 'I_Run'", "Function block 'FB_Bad' does not implement method 'Stop' of interface 'I_Base'"])
    })

    it('accepts inherited members, in any case', () => {
      const source = `
FUNCTION_BLOCK FB_Parent
METHOD STOP
END_METHOD
PROPERTY level : INT
GET
  level := 1;
END_GET
END_PROPERTY
END_FUNCTION_BLOCK

FUNCTION_BLOCK FB_Good EXTENDS FB_Parent IMPLEMENTS I_Run
METHOD start
END_METHOD
END_FUNCTION_BLOCK`
      expect(messages(source)).toEqual([])
    })

    it('leaves an ABSTRACT block\'s members to its concrete descendants', () => {
      const source = `
ABSTRACT FUNCTION_BLOCK FB_Partial IMPLEMENTS I_Base
METHOD ABSTRACT Stop
END_METHOD
END_FUNCTION_BLOCK

FUNCTION_BLOCK FB_Done EXTENDS FB_Partial
METHOD Stop
END_METHOD
END_FUNCTION_BLOCK

FUNCTION_BLOCK FB_NotDone EXTENDS FB_Partial
END_FUNCTION_BLOCK`
      expect(messages(source)).toEqual(["Function block 'FB_NotDone' does not implement method 'Stop' of interface 'I_Base'"])
    })

    it('skips interfaces no unit declares', () => {
      expect(messages('FUNCTION_BLOCK FB_Lib IMPLEMENTS Lib.I_Unknown\nEND_FUNCTION_BLOCK')).toEqual([])
    })
  })

  describe('interface-typed variables', () => {
    it('calls the assigned instance\'s method', () => {
      const { scan, get } = load(MOTORS, ['slow : FB_Slow;', 'm : I_Motor;', 'n : INT;'], ['m := slow;', 'n := m.Speed(n := 1);'])
      scan()
      expect(get('n')).toBe(2)
    })

    it('rebinds on reassignment without touching the old target', () => {
      const { scan, get } = load(MOTORS, ['slow : FB_Slow;', 'fast : FB_Fast;', 'm : I_Motor;', 'n1 : INT;', 'n2 : INT;', 'nRated : INT;'], ['m := slow;', 'm.Rated := 7;', 'n1 := m.Speed(n := 2);', 'm := fast;', 'n2 := m.Speed(n := 2);', 'nRated := fast.Rated;'])
      scan()
      expect(get('n1')).toBe(3)
      expect(get('n2')).toBe(200)
      expect(get('nRated')).toBe(5)
    })

    it('shares the instance rather than a copy', () => {
      const { scan, get } = load(MOTORS, ['slow : FB_Slow;', 'm : I_Motor;', 'n : INT;'], ['m := slow;', 'm.Rated := 9;', 'n := slow.Rated;'])
      scan()
      expect(get('n')).toBe(9)
    })

    it('passes through a function input and between interface variables', () => {
      const { scan, get } = load(MOTORS, ['fast : FB_Fast;', 'm : I_Motor;', 'named : I_Named;', 'again : I_Motor;', 'n : INT;', 'nName : INT;'], ['m := fast;', 'named := m;', 'again := m;', 'n := F_Run(m := again);', 'nName := named.GetName();'])
      scan()
      expect(get('n')).toBe(300)
      expect(get('nName')).toBe(1)
    })

    it('keeps a binding held in a struct array member through a copy', () => {
      const source = `${MOTORS}
TYPE ST_Slot :
STRUCT
  m : I_Motor;
END_STRUCT;
END_TYPE`
      const { scan, get } = load(source, ['slow : FB_Slow;', 'a : ST_Slot;', 'b : ST_Slot;', 'list : ARRAY[0..1] OF I_Motor;', 'n1 : INT;', 'n2 : INT;'], ['a.m := slow;', 'b := a;', 'list[1] := slow;', 'n1 := b.m.Speed(n := 1);', 'n2 := list[1].Speed(n := 4);'])
      scan()
      expect(get('n1')).toBe(2)
      expect(get('n2')).toBe(5)
    })

    it('fails clearly on an unassigned variable', () => {
      const call = load(MOTORS, ['m : I_Motor;', 'n : INT;'], ['n := m.Speed(n := 1);'])
      expect(() => call.scan()).toThrow(/interface variable 'm' is not assigned at oop\.st:\d+/)
      const read = load(MOTORS, ['m : I_Motor;', 'n : INT;'], ['n := m.Rated;'])
      expect(() => read.scan()).toThrow(/interface variable 'm' is not assigned at oop\.st:\d+/)
    })

    it('rejects an instance that does not implement the interface, and non-instances', () => {
      const other = load(MOTORS, ['o : FB_Other;', 'm : I_Motor;'], ['m := o;'])
      expect(() => other.scan()).toThrow(/cannot assign FB_Other to I_Motor at oop\.st:\d+/)
      const scalar = load(MOTORS, ['m : I_Motor;'], ['m := 1;'])
      expect(() => scalar.scan()).toThrow(/cannot assign DINT to I_Motor/)
    })

    it('resets to unassigned when given an unassigned value', () => {
      const { scan } = load(MOTORS, ['slow : FB_Slow;', 'm : I_Motor;', 'empty : I_Motor;', 'n : INT;'], ['m := slow;', 'm := empty;', 'n := m.Speed(n := 1);'])
      expect(() => scan()).toThrow(/is not assigned/)
    })
  })

  describe('mocks', () => {
    /** A suite whose `uut` holds `motor`, for mock paths. */
    const SUITE = `${MOTORS}
${THERMOSTAT}
FUNCTION_BLOCK FB_Uut
VAR
  motor : FB_Fast;
  stat : FB_Thermostat;
  iface : I_Motor;
END_VAR
END_FUNCTION_BLOCK`

    const runtime = (l: Loaded): TestRuntime => ({ suite: l.main, ctx: l.ctx, engine: new CycleEngine(new SimClock(), 1_000_000n, l.session) })

    it('records property access on a mock without running accessors', () => {
      const l = load(SUITE, ['uut : FB_Uut;', 'n : INT;'], ['uut.stat.Setpoint := 5;', 'n := uut.stat.Setpoint;'])
      mockAt('uut.stat', runtime(l))
      l.scan()
      expect(l.get('n')).toBe(0)
      const calls = l.session.mocks.calls('uut.stat.Setpoint')
      expect(calls.map((c) => c.args)).toEqual([{ Setpoint: int(5) }, {}])
    })

    it('dispatches through an interface variable to a mock', () => {
      const l = load(SUITE, ['uut : FB_Uut;', 'n : INT;'], ['uut.iface := uut.motor;', 'n := uut.iface.Speed(n := 3);'])
      mockAt('uut.motor', runtime(l))
      l.scan()
      expect(l.get('n')).toBe(0)
      expect(l.session.mocks.calls('uut.motor.Speed')).toHaveLength(1)
    })

    it('auto-stubs an unknown FB type declared in a property accessor', () => {
      const source = `
FUNCTION_BLOCK FB_Lib
PROPERTY Level : INT
GET
VAR
  sensor : Vendor.FB_Sensor;
END_VAR
  sensor(bEnable := TRUE);
  Level := 3;
END_GET
END_PROPERTY
END_FUNCTION_BLOCK
PROGRAM Main
VAR
  l : FB_Lib;
  n : INT;
END_VAR
n := l.Level;
END_PROGRAM`
      const symbols = table(source)
      const session = new Session({ caseSensitive: false, limits: DEFAULT_LIMITS })
      applyAutoStubs(symbols, session, { strict: false })
      expect(session.warnings.map((w) => w.code)).toEqual(['LIBRARY_AUTOSTUBBED'])
      const ctx = createEvalContext({ symbols, session })
      const main = instantiateFb('Main', ctx)
      callInstance(main, [], ctx)
      expect(main.value.fields.get('n')).toMatchObject({ value: 3 })
    })

    it('keeps inherited inputs and overrides on a mocked derived instance', () => {
      const source = `${SHAPES}
FUNCTION_BLOCK FB_Holder
VAR
  c : FB_C;
END_VAR
END_FUNCTION_BLOCK`
      const l = load(source, ['uut : FB_Holder;', 'n : INT;'], ['uut.c(nIn := 4);', 'n := uut.c.Name();'])
      mockAt('uut.c', runtime(l))
      l.scan()
      expect(l.get('n')).toBe(0)
      expect(l.session.mocks.calls('uut.c').map((c) => c.args)).toEqual([{ nIn: int(4) }])
      expect(l.session.mocks.calls('uut.c.Name')).toHaveLength(1)
    })
  })
})
