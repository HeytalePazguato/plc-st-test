import { describe, it, expect, beforeAll } from 'vitest'
import type { Language, Node } from 'web-tree-sitter'
import { SourceMap, type Project } from '@plc-st/project-model'
import type { CallArg } from '@plc-st/plugin-api'
import { loadGrammar, baseGrammarPath } from '../src/parser/parse.js'
import { buildSymbolTableFromProject } from '../src/symbols/table.js'
import { Scope, ScopeChainImpl } from '../src/interpreter/scope.js'
import { defaultValue, type IecValue } from '../src/interpreter/values.js'
import { testConstEval } from './helpers/const-eval.js'
import { IecType } from '../src/interpreter/numeric.js'
import { execBody, execStatement } from '../src/interpreter/statements.js'
import type { CallPou, ControlSignal, EvalContext } from '../src/interpreter/context.js'
import { Session, type CoverageSink } from '../src/session.js'
import { DEFAULT_LIMITS, type Limits } from '../src/limits.js'
import { IecRuntimeError } from '../src/errors.js'

let lang: Language

const FILE = 'POUs/Main.TcPOU'
/** Original line of the unit's first generated line. */
const ORIG_START = 200

interface Env {
  types?: string[]
  decls?: string[]
  caseSensitive?: boolean
  callPou?: CallPou
  limits?: Partial<Limits>
}

interface Run {
  ctx: EvalContext
  scope: Scope
  body: Node[]
  signal: ControlSignal
  /** Original-file line of body line `i` (0-based within `body` lines). */
  lineOf: (i: number) => number
}

/** Build PROGRAM Main (mapped to `FILE` from `ORIG_START`) with `decls` and the `body` lines, without running it. */
function prepare(body: string[], env: Env = {}): Omit<Run, 'signal'> {
  const head = [...(env.types ?? []), 'PROGRAM Main', 'VAR', ...(env.decls ?? []), 'END_VAR']
  const lines = [...head, ...body, 'END_PROGRAM']
  const project: Project = {
    vendor: 'twincat',
    dialect: 'twincat',
    name: 'Fixture',
    root: '/fixture',
    projectFile: '/fixture/Fixture.plcproj',
    units: [
      {
        id: 'pou:Main',
        role: 'pou',
        isTest: false,
        text: lines.join('\n'),
        map: SourceMap.fromJSON([{ genStartLine: 1, lineCount: lines.length, file: FILE, origStartLine: ORIG_START, origStartCol: 1 }]),
      },
    ],
    libraries: [],
    defines: {},
    warnings: [],
  }
  const caseSensitive = env.caseSensitive ?? false
  const symbols = buildSymbolTableFromProject(project, lang, { caseSensitive })
  expect(symbols.diagnostics).toEqual([])
  const pou = symbols.getPou('Main')
  if (pou?.bodyNode === undefined) throw new Error('Main not found')
  const scope = new Scope(caseSensitive)
  for (const block of pou.varBlocks) {
    for (const v of block.vars) scope.declare(v.name, { value: defaultValue(v.typeNode, symbols, testConstEval(symbols)) }, v.kind)
  }
  const session = new Session({ caseSensitive })
  const callPou: CallPou = env.callPou ?? ((callee) => {
    throw new Error(`unexpected call to ${callee}`)
  })
  const limits = { ...DEFAULT_LIMITS, ...env.limits }
  const ctx: EvalContext = { symbols, chain: new ScopeChainImpl([scope]), limits, callPou, session }
  return { ctx, scope, body: pou.bodyNode.childrenForFieldName('body'), lineOf: (i) => ORIG_START + head.length + i }
}

function run(body: string[], env?: Env): Run {
  const p = prepare(body, env)
  return { ...p, signal: execBody(p.body, p.ctx) }
}

function get(scope: Scope, name: string): IecValue {
  const v = scope.get(name)?.value
  if (v === undefined) throw new Error(`no variable ${name}`)
  return v
}

/** Plain JS value of scalar variable `name` after running `body`. */
function value(r: Run, name: string): unknown {
  const v = get(r.scope, name)
  if (v.kind === 'enum') return v.value
  if (v.kind !== 'scalar') throw new Error(`${name} is ${v.kind}`)
  return v.value
}

const scalar = (type: IecType, v: number | bigint | boolean | string): IecValue => ({ kind: 'scalar', type, value: v })

describe('statements', () => {
  beforeAll(async () => {
    lang = await loadGrammar(baseGrammarPath())
  })

  describe('assignment', () => {
    it('stores a copy, not an alias of the source', () => {
      const r = run(['a := b;', 'b[0] := 9;'], { decls: ['a : ARRAY[0..1] OF INT;', 'b : ARRAY[0..1] OF INT;'] })
      const a = get(r.scope, 'a')
      expect(a.kind === 'array' ? a.data[0] : undefined).toEqual(scalar(IecType.INT, 0))
    })

    it('SINT wraps on assignment', () => {
      const r = run(['s := 200;', 'u := -1;', 'l := 16#FFFF_FFFF_FFFF;', 'w := l;'], { decls: ['s : SINT;', 'u : USINT;', 'l : LINT;', 'w : WORD;'] })
      expect(get(r.scope, 's')).toEqual(scalar(IecType.SINT, -56))
      expect(value(r, 'u')).toBe(255)
      expect(value(r, 'l')).toBe(0xffff_ffff_ffffn)
      expect(get(r.scope, 'w')).toEqual(scalar(IecType.WORD, 0xffff))
    })

    it('REAL rounds to single precision on assignment; LREAL does not', () => {
      const r = run(['r := 0.1;', 'lr := 0.1;', 'ri := 3;', 'i := 2.5;', 'j := 3.5;'], { decls: ['r : REAL;', 'lr : LREAL;', 'ri : REAL;', 'i : INT;', 'j : INT;'] })
      expect(get(r.scope, 'r')).toEqual(scalar(IecType.REAL, Math.fround(0.1)))
      expect(value(r, 'lr')).toBe(0.1)
      expect(get(r.scope, 'ri')).toEqual(scalar(IecType.REAL, 3))
      // Implicit REAL -> integer rounds half to even, like REAL_TO_INT.
      expect(value(r, 'i')).toBe(2)
      expect(value(r, 'j')).toBe(4)
    })

    it('STRING(n) truncates to its declared length, also in arrays and struct fields', () => {
      const r = run(["s := 'hello world';", "t := 'hello world';", "arr[1] := 'abcdef';", "st.name := 'abcdef';", 'u := s;'], {
        types: ['TYPE ST_Named : STRUCT name : STRING(3); END_STRUCT; END_TYPE'],
        decls: ['s : STRING(5);', 't : STRING;', 'arr : ARRAY[0..1] OF STRING(2);', 'st : ST_Named;', 'u : STRING(80);'],
      })
      expect(get(r.scope, 's')).toEqual({ kind: 'scalar', type: IecType.STRING, value: 'hello', maxLength: 5 })
      expect(value(r, 't')).toBe('hello world')
      const arr = get(r.scope, 'arr')
      expect(arr.kind === 'array' ? arr.data[1] : undefined).toEqual({ kind: 'scalar', type: IecType.STRING, value: 'ab', maxLength: 2 })
      const st = get(r.scope, 'st')
      expect(st.kind === 'struct' ? st.fields.get('name') : undefined).toEqual({ kind: 'scalar', type: IecType.STRING, value: 'abc', maxLength: 3 })
      // Copying from a STRING(5) into a STRING(80) keeps the target's capacity.
      expect(get(r.scope, 'u')).toEqual({ kind: 'scalar', type: IecType.STRING, value: 'hello', maxLength: 80 })
    })

    it('TIME variables hold nanosecond bigints', () => {
      const r = run(['t := t + T#1s500ms;'], { decls: ['t : TIME;'] })
      expect(get(r.scope, 't')).toEqual(scalar(IecType.TIME, 1_500_000_000n))
    })

    it('bare and qualified enum members resolve against the target type', () => {
      const r = run(['c := Blue;', 'd := E_Other.Black;'], {
        types: ['TYPE E_Color : (Red, Green, Blue); END_TYPE', 'TYPE E_Other : (Red, Black); END_TYPE'],
        decls: ['c : E_Color;', 'd : E_Other;'],
      })
      expect(get(r.scope, 'c')).toEqual({ kind: 'enum', typeName: 'E_Color', value: 2 })
      expect(get(r.scope, 'd')).toEqual({ kind: 'enum', typeName: 'E_Other', value: 1 })
    })

    it('rejects incompatible types with the original location', () => {
      const p = prepare(["i := 'x';"], { decls: ['i : INT;'] })
      expect(() => execBody(p.body, p.ctx)).toThrow(`cannot assign STRING to INT at ${FILE}:${String(p.lineOf(0))}`)
      const q = prepare(['b := 1;'], { decls: ['b : BOOL;'] })
      expect(() => execBody(q.body, q.ctx)).toThrow(/cannot assign DINT to BOOL/)
    })
  })

  describe('IF and CASE', () => {
    it('IF / ELSIF / ELSE pick the first true branch', () => {
      const body = ['IF x > 10 THEN r := 1; ELSIF x > 5 THEN r := 2; ELSIF x > 0 THEN r := 3; ELSE r := 4; END_IF']
      for (const [x, expected] of [[11, 1], [6, 2], [1, 3], [0, 4]]) {
        expect(value(run(body, { decls: [`x : INT := ${String(x)};`, 'r : INT;'] }), 'r')).toBe(expected)
      }
      expect(value(run(['IF FALSE THEN r := 1; END_IF'], { decls: ['r : INT := 7;'] }), 'r')).toBe(7)
    })

    it('a non-BOOL condition is an error', () => {
      const p = prepare(['IF 1 THEN ; END_IF'])
      expect(() => execBody(p.body, p.ctx)).toThrow(/condition '1' must be BOOL/)
    })

    it('CASE matches single values, ranges and lists, else ELSE', () => {
      const body = ['CASE x OF', '1: r := 10;', '2..5, 7: r := 20;', '8, 10..12: r := 30;', 'ELSE r := 99;', 'END_CASE']
      const expected: [number, number][] = [[1, 10], [2, 20], [5, 20], [7, 20], [6, 99], [8, 30], [11, 30], [13, 99], [-1, 99]]
      for (const [x, r] of expected) {
        expect(value(run(body, { decls: [`x : INT := ${String(x)};`, 'r : INT;'] }), 'r')).toBe(r)
      }
      expect(value(run(['CASE 3 OF 1: r := 1; END_CASE'], { decls: ['r : INT := 5;'] }), 'r')).toBe(5)
    })

    it('CASE on an enum with bare and qualified arms', () => {
      const types = ['TYPE E_State : (Idle, Run := 5, Stop, Fault); END_TYPE', 'TYPE E_Other : (Idle, Busy); END_TYPE']
      const body = ['CASE st OF', 'Idle: r := 1;', 'E_State.Run, Stop: r := 2;', 'ELSE r := 3;', 'END_CASE']
      const at = (s: string): unknown => value(run(body, { types, decls: [`st : E_State := E_State.${s};`, 'r : INT;'] }), 'r')
      // `Idle` is declared by both enums: the selector's type disambiguates it.
      expect(at('Idle')).toBe(1)
      expect(at('Run')).toBe(2)
      expect(at('Stop')).toBe(2)
      expect(at('Fault')).toBe(3)
      const p = prepare(['CASE st OF E_Other.Busy: ; END_CASE'], { types, decls: ['st : E_State;'] })
      expect(() => execBody(p.body, p.ctx)).toThrow(/CASE label 'E_Other.Busy' is E_Other but the selector is E_State/)
    })

    it('10-deep nested IF/CASE fixture computes the expected value', () => {
      // Alternate IF and CASE levels; each level adds its depth to r when taken, and the innermost sets the final marker.
      const lines: string[] = []
      for (let d = 1; d <= 10; d++) {
        if (d % 2 === 1) lines.push(`IF x >= ${String(d)} THEN`, `r := r + ${String(d)};`)
        else lines.push(`CASE x MOD ${String(d)} OF`, `0..${String(d - 1)}:`, `r := r * 2 + ${String(d)};`)
      }
      lines.push('r := r + 1000;')
      for (let d = 10; d >= 1; d--) lines.push(d % 2 === 1 ? 'ELSE r := -1; END_IF' : `ELSE r := -2; END_CASE`)
      let expected = 0
      for (let d = 1; d <= 10; d++) expected = d % 2 === 1 ? expected + d : expected * 2 + d
      expected += 1000
      expect(value(run(lines, { decls: ['x : DINT := 10;', 'r : DINT;'] }), 'r')).toBe(expected)
      // Failing the 9th-level IF takes its ELSE and nothing deeper runs.
      expect(value(run(lines, { decls: ['x : DINT := 8;', 'r : DINT;'] }), 'r')).toBe(-1)
    })
  })

  describe('FOR', () => {
    it('FOR i:=10 TO 1 BY -2 iterates 5 times', () => {
      const r = run(['FOR i := 10 TO 1 BY -2 DO n := n + 1; s := s + i; END_FOR'], { decls: ['i : INT;', 'n : INT;', 's : INT;'] })
      expect(value(r, 'n')).toBe(5)
      expect(value(r, 's')).toBe(10 + 8 + 6 + 4 + 2)
      expect(value(r, 'i')).toBe(0)
    })

    it('FOR i:=1 TO 5 BY -1 iterates 0 times', () => {
      const r = run(['FOR i := 1 TO 5 BY -1 DO n := n + 1; END_FOR'], { decls: ['i : INT;', 'n : INT;'] })
      expect(value(r, 'n')).toBe(0)
      expect(value(r, 'i')).toBe(1)
    })

    it('default step 1, expression step, and the control variable ends one step past the end', () => {
      const r = run(['FOR i := 1 TO 5 DO n := n + 1; END_FOR', 'FOR j := 0 TO 10 BY k * 2 DO m := m + 1; END_FOR'], { decls: ['i : INT;', 'n : INT;', 'j : INT;', 'k : INT := 2;', 'm : INT;'] })
      expect(value(r, 'n')).toBe(5)
      expect(value(r, 'i')).toBe(6)
      expect(value(r, 'm')).toBe(3)
      expect(value(r, 'j')).toBe(12)
    })

    it('a zero step raises at the step expression', () => {
      const p = prepare(['FOR i := 1 TO 5 BY z DO ; END_FOR'], { decls: ['i : INT;', 'z : INT;'] })
      expect(() => execBody(p.body, p.ctx)).toThrow(IecRuntimeError)
      expect(() => execBody(p.body, p.ctx)).toThrow(`FOR step must not be zero at ${FILE}:${String(p.lineOf(0))}`)
    })

    it('end and step are evaluated once', () => {
      const r = run(['FOR i := 1 TO lim DO lim := lim + 1; n := n + 1; END_FOR'], { decls: ['i : INT;', 'lim : INT := 3;', 'n : INT;'] })
      expect(value(r, 'n')).toBe(3)
    })
  })

  describe('WHILE, REPEAT, EXIT, CONTINUE, RETURN', () => {
    it('WHILE tests before the body', () => {
      expect(value(run(['WHILE i < 4 DO i := i + 1; END_WHILE'], { decls: ['i : INT;'] }), 'i')).toBe(4)
      expect(value(run(['WHILE FALSE DO i := 9; END_WHILE'], { decls: ['i : INT;'] }), 'i')).toBe(0)
    })

    it('REPEAT runs the body at least once and stops when UNTIL holds', () => {
      expect(value(run(['REPEAT i := i + 1; UNTIL i >= 3 END_REPEAT'], { decls: ['i : INT;'] }), 'i')).toBe(3)
      expect(value(run(['REPEAT i := i + 1; UNTIL TRUE END_REPEAT'], { decls: ['i : INT;'] }), 'i')).toBe(1)
    })

    it('EXIT leaves only the inner loop', () => {
      const r = run(['FOR i := 1 TO 3 DO', 'FOR j := 1 TO 10 DO', 'IF j > 2 THEN EXIT; END_IF', 'n := n + 1;', 'END_FOR', 'outer := outer + 1;', 'END_FOR'], {
        decls: ['i : INT;', 'j : INT;', 'n : INT;', 'outer : INT;'],
      })
      expect(value(r, 'outer')).toBe(3)
      expect(value(r, 'n')).toBe(6)
      expect(value(r, 'j')).toBe(3)
      expect(r.signal).toEqual({ type: 'normal' })
    })

    it('EXIT leaves WHILE and REPEAT', () => {
      expect(value(run(['WHILE TRUE DO i := i + 1; IF i = 5 THEN EXIT; END_IF END_WHILE'], { decls: ['i : INT;'] }), 'i')).toBe(5)
      expect(value(run(['REPEAT i := i + 1; EXIT; UNTIL FALSE END_REPEAT'], { decls: ['i : INT;'] }), 'i')).toBe(1)
    })

    it('CONTINUE skips the rest of the iteration in FOR, WHILE and REPEAT', () => {
      const r = run(
        [
          'FOR i := 1 TO 6 DO IF i MOD 2 = 0 THEN CONTINUE; END_IF a := a + i; END_FOR',
          'WHILE k < 6 DO k := k + 1; IF k MOD 3 = 0 THEN CONTINUE; END_IF b := b + 1; END_WHILE',
          'REPEAT m := m + 1; IF m < 4 THEN CONTINUE; END_IF c := c + 1; UNTIL m >= 5 END_REPEAT',
        ],
        { decls: ['i : INT;', 'a : INT;', 'k : INT;', 'b : INT;', 'm : INT;', 'c : INT;'] },
      )
      expect(value(r, 'a')).toBe(1 + 3 + 5)
      expect(value(r, 'b')).toBe(4)
      expect(value(r, 'c')).toBe(2)
    })

    it('RETURN stops the body and propagates out of loops', () => {
      const r = run(['i := 1;', 'WHILE TRUE DO IF i = 3 THEN RETURN; END_IF i := i + 1; END_WHILE', 'i := 100;'], { decls: ['i : INT;'] })
      expect(r.signal).toEqual({ type: 'return' })
      expect(value(r, 'i')).toBe(3)
    })

    it('EXIT outside a loop propagates to the caller', () => {
      const r = run(['EXIT;', 'i := 1;'], { decls: ['i : INT;'] })
      expect(r.signal).toEqual({ type: 'exit' })
      expect(value(r, 'i')).toBe(0)
    })

    it('empty statements do nothing', () => {
      expect(run([';', ';;']).signal).toEqual({ type: 'normal' })
    })
  })

  describe('loop limits', () => {
    it('exceeding max iterations raises with the statement original line', () => {
      for (const loop of ['WHILE TRUE DO i := i + 1; END_WHILE', 'REPEAT i := i + 1; UNTIL FALSE END_REPEAT', 'FOR i := 0 TO 100 DO ; END_FOR']) {
        const p = prepare(['i := 0;', loop], { decls: ['i : DINT;'], limits: { maxLoopIterations: 50 } })
        expect(() => execBody(p.body, p.ctx)).toThrow(IecRuntimeError)
        expect(() => execBody(p.body, p.ctx)).toThrow(`loop exceeded the maximum of 50 iterations (limits.maxLoopIterations) at ${FILE}:${String(p.lineOf(1))}`)
      }
    })

    it('the budget is per loop execution, not cumulative', () => {
      const r = run(['FOR i := 1 TO 10 DO FOR j := 1 TO 10 DO n := n + 1; END_FOR END_FOR'], { decls: ['i : INT;', 'j : INT;', 'n : INT;'], limits: { maxLoopIterations: 10 } })
      expect(value(r, 'n')).toBe(100)
    })

    it('a SINT control variable that wraps past its end value is caught by the limit', () => {
      const p = prepare(['FOR s := 120 TO 127 DO ; END_FOR'], { decls: ['s : SINT;'], limits: { maxLoopIterations: 1000 } })
      expect(() => execBody(p.body, p.ctx)).toThrow(/loop exceeded the maximum of 1000 iterations/)
    })
  })

  describe('invocation statements', () => {
    it('call FBs, methods and void functions through ctx.callPou', () => {
      const calls: { callee: string; args: CallArg[] }[] = []
      const callPou: CallPou = (callee, args) => {
        calls.push({ callee, args })
        return undefined
      }
      const r = run(['fb(a := 1, b => i);', 'fb.M();', 'Foo(i);'], { decls: ['i : INT;', 'fb : FB_A;'], callPou })
      expect(r.signal).toEqual({ type: 'normal' })
      expect(calls.map((c) => c.callee)).toEqual(['fb', 'fb.M', 'Foo'])
      expect(calls[0].args[1].slot).toBe(r.scope.get('i'))
    })

    it('a call result used as a statement is discarded', () => {
      const r = run(['F();'], { callPou: () => scalar(IecType.DINT, 1) })
      expect(r.signal).toEqual({ type: 'normal' })
    })
  })

  describe('coverage', () => {
    it('reports taken branches only when a sink exists', () => {
      const p = prepare(['IF x THEN ; ELSE ; END_IF', 'CASE 2 OF 1: ; 2: ; END_CASE', 'FOR i := 1 TO 2 DO ; END_FOR'], { decls: ['x : BOOL;', 'i : INT;'] })
      // No sink: nothing happens (and nothing throws).
      expect(execBody(p.body, p.ctx)).toEqual({ type: 'normal' })
      const hits: string[] = []
      const sink: CoverageSink = { hit: (id) => hits.push(id), snapshot: () => new Map() }
      p.ctx.session.coverage = sink
      execBody(p.body, p.ctx)
      expect(hits).toEqual([`${FILE}:${String(p.lineOf(0))}:else`, `${FILE}:${String(p.lineOf(1))}:case`, `${FILE}:${String(p.lineOf(2))}:for-body`, `${FILE}:${String(p.lineOf(2))}:for-body`])
    })
  })

  describe('node handlers and unsupported statements', () => {
    it('a registered handler runs an unknown statement type and may return a signal', () => {
      const { ctx } = prepare([])
      const fake = { type: 'vendor_jump', text: 'JMP' } as unknown as Node
      ctx.session.nodeHandlers.set('vendor_jump', () => ({ type: 'exit' }))
      expect(execStatement(fake, ctx)).toEqual({ type: 'exit' })
      ctx.session.nodeHandlers.set('vendor_jump', () => 42)
      expect(execStatement(fake, ctx)).toEqual({ type: 'normal' })
    })

    it('an unhandled statement type raises with its original location', () => {
      const p = prepare(['r REF= x;'], { decls: ['r : INT;', 'x : INT;'] })
      expect(p.body[0].type).toBe('reference_assignment_statement')
      expect(() => execBody(p.body, p.ctx)).toThrow(`unsupported construct reference_assignment_statement at ${FILE}:${String(p.lineOf(0))}`)
    })
  })
})
