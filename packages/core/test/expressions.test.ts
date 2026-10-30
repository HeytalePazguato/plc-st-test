import { describe, it, expect, beforeAll } from 'vitest'
import type { Language, Node } from 'web-tree-sitter'
import { SourceMap, type Project } from '@plc-st/project-model'
import type { CallArg } from '@plc-st/plugin-api'
import { loadGrammar, baseGrammarPath } from '../src/parser/parse.js'
import { buildSymbolTableFromProject } from '../src/symbols/table.js'
import { Scope, ScopeChainImpl } from '../src/interpreter/scope.js'
import { defaultValue, type IecValue } from '../src/interpreter/values.js'
import { IecType } from '../src/interpreter/numeric.js'
import { evalExpression, evalLValue, evalCall } from '../src/interpreter/expressions.js'
import type { CallPou, EvalContext } from '../src/interpreter/context.js'
import { Session } from '../src/session.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import { IecRuntimeError } from '../src/errors.js'

let lang: Language

const FILE = 'POUs/Main.TcPOU'
/** Original line of the unit's first generated line. */
const ORIG_START = 100

interface Env {
  decls?: string[]
  types?: string[]
  caseSensitive?: boolean
  callPou?: CallPou
  /** Adjust variable values after defaults are built. */
  init?: (scope: Scope) => void
}

interface Prepared {
  node: Node
  ctx: EvalContext
  scope: Scope
  /** Original-file line of the expression's statement. */
  line: number
}

/** Parse `expr` as the right-hand side of a statement inside PROGRAM Main (mapped to `FILE` starting at `ORIG_START`) and build a context whose scope holds Main's variables. */
function prepare(expr: string, env: Env = {}): Prepared {
  const lines = [...(env.types ?? []), 'PROGRAM Main', 'VAR', ...(env.decls ?? []), 'END_VAR', `__r := ${expr};`, 'END_PROGRAM']
  const text = lines.join('\n')
  const stmtIndex = lines.length - 2
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
        text,
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
    for (const v of block.vars) scope.declare(v.name, { value: defaultValue(v.typeNode, symbols) }, v.kind)
  }
  env.init?.(scope)
  const stmt = pou.bodyNode.childrenForFieldName('body').find((n) => n.type === 'assignment_statement')
  const node = stmt?.childForFieldName('right')
  if (node === undefined || node === null) throw new Error('expression not found')
  const session = new Session({ caseSensitive })
  const callPou: CallPou = env.callPou ?? ((callee) => {
    throw new Error(`unexpected call to ${callee}`)
  })
  const ctx: EvalContext = { symbols, chain: new ScopeChainImpl([scope]), limits: DEFAULT_LIMITS, callPou, session }
  return { node, ctx, scope, line: ORIG_START + stmtIndex }
}

function evaluate(expr: string, env?: Env): IecValue {
  const { node, ctx } = prepare(expr, env)
  return evalExpression(node, ctx)
}

/** The plain JS value of a scalar result. */
function value(expr: string, env?: Env): unknown {
  const v = evaluate(expr, env)
  if (v.kind !== 'scalar') throw new Error(`expected scalar, got ${v.kind}`)
  return v.value
}

function set(scope: Scope, name: string, v: IecValue): void {
  const slot = scope.get(name)
  if (slot === undefined) throw new Error(`no variable ${name}`)
  slot.value = v
}

const scalar = (type: IecType, v: number | bigint | boolean | string): IecValue => ({ kind: 'scalar', type, value: v })

describe('evalExpression', () => {
  beforeAll(async () => {
    lang = await loadGrammar(baseGrammarPath())
  })

  describe('literals', () => {
    it('integers in every base, with separators and sign', () => {
      expect(evaluate('16#FF')).toEqual(scalar(IecType.DINT, 255))
      expect(value('2#1010')).toBe(10)
      expect(value('8#17')).toBe(15)
      expect(value('1_000')).toBe(1000)
      expect(value('-5')).toBe(-5)
      expect(evaluate('16#FFFF_FFFF')).toEqual(scalar(IecType.LINT, 0xffff_ffffn))
    })

    it('typed literals, range-checked', () => {
      expect(evaluate('INT#5')).toEqual(scalar(IecType.INT, 5))
      expect(evaluate('INT#-5')).toEqual(scalar(IecType.INT, -5))
      expect(evaluate('BYTE#16#F0')).toEqual(scalar(IecType.BYTE, 0xf0))
      expect(evaluate('LWORD#16#FF')).toEqual(scalar(IecType.LWORD, 255n))
      expect(evaluate('BOOL#1')).toEqual(scalar(IecType.BOOL, true))
      expect(evaluate('REAL#1e3')).toEqual(scalar(IecType.REAL, 1000))
      expect(() => evaluate('SINT#200')).toThrow(/out of range for SINT/)
    })

    it('reals with exponents; REAL rounds to single precision, LREAL does not', () => {
      expect(evaluate('1.5e3')).toEqual(scalar(IecType.LREAL, 1500))
      expect(evaluate('LREAL#1.5e3')).toEqual(scalar(IecType.LREAL, 1500))
      expect(evaluate('REAL#1.1')).toEqual(scalar(IecType.REAL, Math.fround(1.1)))
      expect(value('2.5E-1')).toBe(0.25)
    })

    it('booleans', () => {
      expect(evaluate('TRUE')).toEqual(scalar(IecType.BOOL, true))
      expect(value('false')).toBe(false)
    })

    it('STRING and WSTRING with $ escapes', () => {
      expect(evaluate("'a$Nb$27$$$R$T$L$P'")).toEqual(scalar(IecType.STRING, "a\nb'$\r\t\n\f"))
      expect(evaluate('"w$0041$""')).toEqual(scalar(IecType.WSTRING, 'wA"'))
      expect(evaluate("WSTRING#\"x\"")).toEqual(scalar(IecType.WSTRING, 'x'))
    })

    it('durations to nanoseconds, including compound and fractional forms', () => {
      expect(evaluate('T#1m30s')).toEqual(scalar(IecType.TIME, 90_000_000_000n))
      expect(value('T#1h2m3s4ms')).toBe(3_723_004_000_000n)
      expect(value('TIME#-1.5s')).toBe(-1_500_000_000n)
      expect(value('t#1d')).toBe(86_400_000_000_000n)
      expect(value('T#2.5ms')).toBe(2_500_000n)
      expect(value('LTIME#5us3ns')).toBe(5_003n)
    })

    it('D#, TOD#, DT# fold onto TIME nanoseconds', () => {
      expect(value('D#1970-01-02')).toBe(86_400_000_000_000n)
      expect(value('TOD#12:30:15.5')).toBe(45_015_500_000_000n)
      expect(value('DT#1970-01-01-00:00:01')).toBe(1_000_000_000n)
      expect(() => evaluate('D#2024-02-30')).toThrow(/invalid date literal/)
    })
  })

  describe('operators', () => {
    it('2+3*4**2 = 50 (precedence, ** yields LREAL)', () => {
      expect(value('2+3*4**2')).toBe(50)
      expect(evaluate('2**10')).toEqual(scalar(IecType.LREAL, 1024))
    })

    it('NOT TRUE OR TRUE = TRUE and other BOOL logic', () => {
      expect(value('NOT TRUE OR TRUE')).toBe(true)
      expect(value('TRUE XOR TRUE')).toBe(false)
      expect(value('TRUE & FALSE')).toBe(false)
      expect(value('TRUE AND NOT FALSE')).toBe(true)
    })

    it('bitwise logic on bit strings: BYTE#16#F0 AND BYTE#16#3C = 16#30', () => {
      expect(evaluate('BYTE#16#F0 AND BYTE#16#3C')).toEqual(scalar(IecType.BYTE, 0x30))
      expect(value('(BYTE#16#F0 AND BYTE#16#3C) = 16#30')).toBe(true)
      expect(evaluate('BYTE#16#F0 OR BYTE#16#0F')).toEqual(scalar(IecType.BYTE, 0xff))
      expect(evaluate('WORD#16#FF00 XOR WORD#16#0FF0')).toEqual(scalar(IecType.WORD, 0xf0f0))
      expect(evaluate('NOT BYTE#16#0F')).toEqual(scalar(IecType.BYTE, 0xf0))
      expect(evaluate('DWORD#16#FFFFFFFF AND DWORD#16#80000001')).toEqual(scalar(IecType.DWORD, 0x8000_0001))
      expect(evaluate('NOT LWORD#0')).toEqual(scalar(IecType.LWORD, 0xffff_ffff_ffff_ffffn))
      // An untyped literal adopts its bit-string partner's type.
      expect(evaluate('b AND 16#0F', { decls: ['b : BYTE := 16#AB;'] })).toEqual(scalar(IecType.BYTE, 0x0b))
      expect(() => evaluate('TRUE AND BYTE#1')).toThrow(/AND is not applicable to BOOL and BYTE/)
    })

    it('overflow wraps through numeric.ts', () => {
      expect(evaluate('SINT#127 + SINT#1')).toEqual(scalar(IecType.SINT, -128))
      expect(evaluate('s + 1', { decls: ['s : SINT := 127;'] })).toEqual(scalar(IecType.SINT, -128))
      expect(evaluate('u - 1', { decls: ['u : UINT;'] })).toEqual(scalar(IecType.UINT, 65535))
      expect(evaluate('-SINT#-128')).toEqual(scalar(IecType.SINT, -128))
      expect(evaluate('LINT#9223372036854775807 + LINT#1')).toEqual(scalar(IecType.LINT, -(2n ** 63n)))
      // A literal that does not fit the partner widens instead of wrapping.
      expect(evaluate('s + 300', { decls: ['s : SINT := 1;'] })).toEqual(scalar(IecType.DINT, 301))
    })

    it('IEC widening across integer and real types', () => {
      expect(evaluate('INT#1 + DINT#2')).toEqual(scalar(IecType.DINT, 3))
      expect(evaluate('INT#3 / REAL#2')).toEqual(scalar(IecType.REAL, 1.5))
      expect(evaluate('r * 2', { decls: ['r : REAL := 1.5;'] })).toEqual(scalar(IecType.REAL, 3))
      expect(evaluate('7 / 2')).toEqual(scalar(IecType.DINT, 3))
    })

    it('MOD truncates toward zero; division by zero is located', () => {
      expect(value('7 MOD 3')).toBe(1)
      expect(value('-7 MOD 3')).toBe(-1)
      const { node, ctx, line } = prepare('1 / 0')
      expect(() => evalExpression(node, ctx)).toThrow(`division by zero at ${FILE}:${String(line)}`)
    })

    it('unary minus/plus', () => {
      expect(evaluate('-x', { decls: ['x : INT := 4;'] })).toEqual(scalar(IecType.INT, -4))
      expect(evaluate('-REAL#1.5')).toEqual(scalar(IecType.REAL, -1.5))
      expect(evaluate('-T#1s')).toEqual(scalar(IecType.TIME, -1_000_000_000n))
      expect(() => evaluate("-'a'")).toThrow(/unary - is not applicable to STRING/)
    })

    it('TIME arithmetic', () => {
      expect(value('T#1s + T#500ms')).toBe(1_500_000_000n)
      expect(value('T#1s * 3')).toBe(3_000_000_000n)
      expect(value('T#1s / 4')).toBe(250_000_000n)
      expect(value('t - T#1s', { decls: ['t : TIME;'] })).toBe(-1_000_000_000n)
    })
  })

  describe('comparisons', () => {
    it('numbers across types', () => {
      expect(value('1 = 1.0')).toBe(true)
      expect(value('INT#3 < LINT#4')).toBe(true)
      expect(value('ULINT#18446744073709551615 > 0')).toBe(true)
      expect(value('REAL#1.5 >= 2')).toBe(false)
      expect(value('2 <> 2')).toBe(false)
    })

    it('STRING comparisons are lexicographic', () => {
      expect(value("'abc' = 'abc'")).toBe(true)
      expect(value("'abc' < 'abd'")).toBe(true)
      expect(value("'b' > 'abc'")).toBe(true)
      expect(value("s <> 'x'", { decls: ["s : STRING := 'x';"] })).toBe(false)
      expect(value("'' <= 'a'")).toBe(true)
      expect(() => evaluate("'1' = 1")).toThrow(/cannot compare STRING with DINT/)
    })

    it('TIME and BOOL', () => {
      expect(value('T#1s > T#999ms')).toBe(true)
      expect(value('T#60s = T#1m')).toBe(true)
      expect(value('t = T#0s', { decls: ['t : TIME;'] })).toBe(true)
      expect(value('TRUE > FALSE')).toBe(true)
    })
  })

  describe('variables, arrays, structs, FB members', () => {
    const arrDecls = ['arr : ARRAY[0..3] OF INT;', 'm : ARRAY[1..2, 0..2] OF DINT;', 'i : INT := 2;']

    it('reads variables case-insensitively by default', () => {
      expect(value('X + 1', { decls: ['x : INT := 4;'] })).toBe(5)
    })

    it('case-sensitive mode keeps names distinct', () => {
      expect(() => evaluate('X', { decls: ['x : INT;'], caseSensitive: true })).toThrow(/unknown identifier 'X'/)
    })

    it('arr[4] on ARRAY[0..3] raises with the bounds in the message', () => {
      const { node, ctx, line } = prepare('arr[4]', { decls: arrDecls })
      expect(() => evalExpression(node, ctx)).toThrow(IecRuntimeError)
      expect(() => evalExpression(node, ctx)).toThrow(`index 4 out of bounds [0..3] for arr at ${FILE}:${String(line)}`)
      expect(() => evaluate('arr[-1]', { decls: arrDecls })).toThrow(/index -1 out of bounds \[0\.\.3\] for arr/)
    })

    it('element slots write through, row-major for multiple dimensions', () => {
      const { node, ctx, scope } = prepare('m[2, i]', { decls: arrDecls })
      evalLValue(node, ctx).value = scalar(IecType.DINT, 42)
      const m = scope.get('m')?.value
      if (m?.kind !== 'array') throw new Error('m is not an array')
      expect(m.data[5]).toEqual(scalar(IecType.DINT, 42))
      expect(evalExpression(node, ctx)).toEqual(scalar(IecType.DINT, 42))
      expect(() => evaluate('m[1, 3]', { decls: arrDecls })).toThrow(/index 3 out of bounds \[0\.\.2\] for m/)
      expect(() => evaluate('m[1]', { decls: arrDecls })).toThrow(/2 dimension\(s\) but 1 index/)
    })

    it('struct fields, nested, with case-insensitive member names', () => {
      const env: Env = {
        types: ['TYPE ST_Inner : STRUCT v : INT := 7; END_STRUCT; END_TYPE', 'TYPE ST_Outer : STRUCT inner : ST_Inner; list : ARRAY[0..1] OF ST_Inner; END_STRUCT; END_TYPE'],
        decls: ['o : ST_Outer;'],
      }
      expect(value('o.inner.v', env)).toBe(7)
      expect(value('O.Inner.V * 2', env)).toBe(14)
      expect(value('o.list[1].v', env)).toBe(7)
      expect(() => evaluate('o.nope', env)).toThrow(/'o' has no member 'nope'/)
      expect(() => evaluate('o.Inner', { ...env, caseSensitive: true })).toThrow(/has no member 'Inner'/)

      const { node, ctx, scope } = prepare('o.inner.v', env)
      evalLValue(node, ctx).value = scalar(IecType.INT, 9)
      const o = scope.get('o')?.value
      const inner = o?.kind === 'struct' ? o.fields.get('inner') : undefined
      expect(inner?.kind === 'struct' ? inner.fields.get('v') : undefined).toEqual(scalar(IecType.INT, 9))
    })

    it('FB instance inputs and outputs are readable members', () => {
      const env: Env = {
        types: ['FUNCTION_BLOCK FB_Motor', 'VAR_INPUT xEnable : BOOL; END_VAR', 'VAR_OUTPUT xRunning : BOOL; END_VAR', 'END_FUNCTION_BLOCK'],
        decls: ['fbMotor : FB_Motor;'],
        init: (scope) => {
          set(scope, 'fbMotor', {
            kind: 'struct',
            typeName: 'FB_Motor',
            fields: new Map<string, IecValue>([
              ['xEnable', scalar(IecType.BOOL, true)],
              ['xRunning', scalar(IecType.BOOL, false)],
            ]),
          })
        },
      }
      expect(value('fbMotor.xEnable AND NOT fbMotor.xRunning', env)).toBe(true)
      expect(value('fbMotor.XRUNNING', env)).toBe(false)
    })
  })

  describe('enums', () => {
    const env: Env = {
      types: ['TYPE E_Color : (Red, Green := 5, Blue); END_TYPE', 'TYPE E_Other : (Red, Black); END_TYPE'],
      decls: ['color : E_Color := E_Color.Blue;', 'other : E_Other;'],
    }

    it('qualified members', () => {
      expect(evaluate('E_Color.Blue', env)).toEqual({ kind: 'enum', typeName: 'E_Color', value: 6 })
      expect(value('color = E_Color.Blue', env)).toBe(true)
      expect(value('e_color.green < E_COLOR.BLUE', env)).toBe(true)
      expect(() => evaluate('E_Color.Purple', env)).toThrow(/'Purple' is not a member of enum E_Color/)
    })

    it('bare members resolve from the comparison partner, on either side', () => {
      expect(value('color = Blue', env)).toBe(true)
      expect(value('color <> Red', env)).toBe(true)
      expect(value('Red = other', env)).toBe(true)
    })

    it('bare members fall back to a unique search; ambiguity is an error', () => {
      expect(evaluate('Black', env)).toEqual({ kind: 'enum', typeName: 'E_Other', value: 1 })
      expect(evaluate('Green', env)).toEqual({ kind: 'enum', typeName: 'E_Color', value: 5 })
      expect(() => evaluate('Red', env)).toThrow(/ambiguous enum member 'Red' \(declared by E_Color, E_Other\)/)
    })

    it('comparing different enum types is an error', () => {
      expect(() => evaluate('color = other', env)).toThrow(/cannot compare E_Color with E_Other/)
    })
  })

  describe('calls', () => {
    it('delegates to ctx.callPou with positional, named and output arguments', () => {
      const seen: { callee: string; args: CallArg[] }[] = []
      const env: Env = {
        decls: ['x : INT := 3;', 'y : INT;'],
        callPou: (callee, args) => {
          seen.push({ callee, args })
          return scalar(IecType.DINT, 42)
        },
      }
      const { node, ctx, scope } = prepare('F_Add(x, b := 1 + 1, c => y) + 1', env)
      expect(evalExpression(node, ctx)).toEqual(scalar(IecType.DINT, 43))
      expect(seen).toHaveLength(1)
      const [{ callee, args }] = seen
      expect(callee).toBe('F_Add')
      expect(args[0]).toEqual({ value: scalar(IecType.INT, 3), slot: scope.get('x') })
      expect(args[0].slot).toBe(scope.get('x'))
      expect(args[1]).toEqual({ name: 'b', value: scalar(IecType.DINT, 2) })
      expect(args[2].name).toBe('c')
      expect(args[2].slot).toBe(scope.get('y'))
    })

    it('a call without a result is an error in an expression but fine via evalCall', () => {
      const { node, ctx } = prepare('DoIt()', { callPou: () => undefined })
      expect(() => evalExpression(node, ctx)).toThrow(/'DoIt' does not return a value/)
      expect(evalCall(node, ctx)).toBeUndefined()
    })
  })

  describe('node handlers and unsupported constructs', () => {
    it('invokes a registered node handler for a fake node type', () => {
      const { ctx } = prepare('0')
      const fake = { type: 'vendor_magic', text: 'MAGIC' } as unknown as Node
      const calls: unknown[] = []
      ctx.session.nodeHandlers.set('vendor_magic', (node, handlerCtx) => {
        calls.push(node, handlerCtx)
        return scalar(IecType.DINT, 7)
      })
      expect(evalExpression(fake, ctx)).toEqual(scalar(IecType.DINT, 7))
      expect(calls).toEqual([fake, ctx])
    })

    it('invokes a handler for a grammar node core does not support (pointer dereference)', () => {
      const { node, ctx } = prepare('p^ + 1', { decls: ['p : INT := 5;'] })
      ctx.session.nodeHandlers.set('dereference_expression', (n, c) => evalExpression((n as Node).childForFieldName('pointer') as Node, c as EvalContext))
      expect(evalExpression(node, ctx)).toEqual(scalar(IecType.INT, 6))
    })

    it('an unknown node type raises with its original-file location', () => {
      const { node, ctx, line } = prepare('ADR(x)', { decls: ['x : INT;'] })
      expect(() => evalExpression(node, ctx)).toThrow(`unsupported construct address_of_expression at ${FILE}:${String(line)}`)
      expect(() => evalLValue(node, ctx)).toThrow(`unsupported construct address_of_expression at ${FILE}:${String(line)}`)
    })

    it('evalLValue rejects non-assignable expressions and unknown variables', () => {
      const a = prepare('1 + 2')
      expect(() => evalLValue(a.node, a.ctx)).toThrow(/'1 \+ 2' is not assignable/)
      const b = prepare('nope')
      expect(() => evalLValue(b.node, b.ctx)).toThrow(`unknown variable 'nope' at ${FILE}:${String(b.line)}`)
    })
  })
})
