import { existsSync, readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { Language, Parser, type Node } from 'web-tree-sitter'
import { isCompatible, type IecValue, type NodeEvaluator, type PluginModule, type Slot } from '@plc-st/plugin-api'
import plugin, { beckhoffDialect, beckhoffNodeHandlers } from '../src/index.js'

/**
 * The handlers run against nodes parsed by the real published `tree-sitter-iec61131-3-st-beckhoff` wasm. Dialects may not import `@plc-st/core`, so the `NodeEvaluator` here is a small stand-in covering the base constructs these sources use (BOOL/INT literals and variables, parentheses, `/`, `>`, `AND`); the CLI's end-to-end test runs the same constructs through the real interpreter.
 */

let parser: Parser

beforeAll(async () => {
  await Parser.init()
  const language = await Language.load(new Uint8Array(readFileSync(beckhoffDialect.grammarWasmPath())))
  parser = new Parser()
  parser.setLanguage(language)
})

const bool = (value: boolean): IecValue => ({ kind: 'scalar', type: 'BOOL', value })
const int = (value: number): IecValue => ({ kind: 'scalar', type: 'INT', value })

class StandInError extends Error {}

interface Ctx {
  vars: Map<string, Slot>
  /** Every node the evaluator was asked to evaluate, by source text, to prove what was skipped. */
  evaluated: string[]
}

const evaluator: NodeEvaluator = {
  evaluate(raw, rawCtx) {
    const node = raw as Node
    const ctx = rawCtx as Ctx
    ctx.evaluated.push(node.text)
    switch (node.type) {
      case 'boolean_literal':
        return bool(node.text.toUpperCase() === 'TRUE')
      case 'integer_literal':
        return int(Number(node.text))
      case 'identifier':
        return evaluator.lvalue(node, ctx).value
      case 'parenthesized_expression':
        return evaluator.evaluate(node.namedChildren[0]!, ctx)
      case 'binary_expression': {
        const l = evaluator.evaluate(node.childForFieldName('left')!, ctx)
        const r = evaluator.evaluate(node.childForFieldName('right')!, ctx)
        const op = node.childForFieldName('operator')!.text.toUpperCase()
        const a = (l as { value: number | boolean }).value
        const b = (r as { value: number | boolean }).value
        if (op === '/') {
          if (b === 0) throw evaluator.error(node, ctx, 'division by zero')
          return int(Math.trunc((a as number) / (b as number)))
        }
        if (op === '>') return bool((a as number) > (b as number))
        if (op === 'AND') return bool((a as boolean) && (b as boolean))
        throw evaluator.error(node, ctx, `stand-in evaluator has no operator ${op}`)
      }
      default: {
        const handler = beckhoffNodeHandlers[node.type]
        if (handler === undefined) throw evaluator.error(node, ctx, `stand-in evaluator has no ${node.type}`)
        return handler(node, ctx, evaluator) as IecValue
      }
    }
  },
  lvalue(raw, rawCtx) {
    const node = raw as Node
    const slot = (rawCtx as Ctx).vars.get(node.text.toLowerCase())
    if (slot === undefined) throw evaluator.error(node, rawCtx, `unknown variable '${node.text}'`)
    return slot
  },
  store(slot, value) {
    slot.value = value
  },
  error(raw, _ctx, message) {
    return new StandInError(`${message} at line ${String((raw as Node).startPosition.row + 1)}`)
  },
  rawLvalue(node, ctx) {
    return evaluator.lvalue(node, ctx)
  },
  handleOf() {
    throw new Error('the stand-in has no slot table')
  },
  slotOf() {
    return undefined
  },
}

function context(vars: Record<string, IecValue>): Ctx {
  return { vars: new Map(Object.entries(vars).map(([k, v]) => [k.toLowerCase(), { value: v }])), evaluated: [] }
}

/** Parse `body` as the body of a function block and return its statement nodes, failing on any syntax error. */
function statements(body: string): Node[] {
  const tree = parser.parse(`FUNCTION_BLOCK FB_T\nVAR\n  x : BOOL;\nEND_VAR\n${body}\nEND_FUNCTION_BLOCK\n`)!
  expect(tree.rootNode.hasError, tree.rootNode.toString()).toBe(false)
  return tree.rootNode.namedChildren[0]!.childrenForFieldName('body').filter((n): n is Node => n !== null && n.type !== 'comment')
}

/** Run statements the way core does: an assignment directly, anything else through the dialect's handler for its node type. */
function run(body: string, ctx: Ctx): void {
  for (const stmt of statements(body)) {
    if (stmt.type === 'assignment_statement') {
      evaluator.store(evaluator.lvalue(stmt.childForFieldName('left')!, ctx), evaluator.evaluate(stmt.childForFieldName('right')!, ctx), stmt, ctx)
      continue
    }
    const handler = beckhoffNodeHandlers[stmt.type]
    if (handler === undefined) throw new Error(`no handler for statement ${stmt.type}`)
    handler(stmt, ctx, evaluator)
  }
}

/** Evaluate `expr` as the right-hand side of `x := <expr>;`. */
function evaluate(expr: string, ctx: Ctx): IecValue {
  const stmt = statements(`x := ${expr};`)[0]!
  return evaluator.evaluate(stmt.childForFieldName('right')!, ctx)
}

describe('beckhoffDialect', () => {
  it('declares the Beckhoff flavour', () => {
    expect(beckhoffDialect).toMatchObject({
      id: 'beckhoff',
      apiVersion: 1,
      caseSensitive: false,
      testStrategy: 'method',
      builtinLibraries: ['Tc2_Standard', 'Tc2_System', 'Tc3_Module', 'PlcStTest'],
    })
    expect(Object.keys(beckhoffDialect.nodeHandlers ?? {}).sort()).toEqual(['address_of_expression', 'attribute_pragma', 'conditional_directive', 'dereference_expression', 'pragma', 'reference_assignment_statement', 'set_reset_assignment_statement', 'short_circuit_expression'])
  })

  it('resolves the published Beckhoff grammar wasm', () => {
    const wasmPath = beckhoffDialect.grammarWasmPath()
    expect(wasmPath).toMatch(/tree-sitter-iec61131-3-st-beckhoff[\\/]tree-sitter-iec61131_3_st_beckhoff\.wasm$/)
    expect(existsSync(wasmPath)).toBe(true)
  })

  it('is the default PluginModule export', () => {
    const mod: PluginModule = plugin
    expect(isCompatible(mod.apiVersion)).toBe(true)
    expect(mod.dialects).toEqual([beckhoffDialect])
  })
})

describe('short_circuit_expression', () => {
  it('AND_THEN skips the right side when the left is FALSE', () => {
    const ctx = context({ a: bool(false), b: int(0) })
    expect(evaluate('a AND_THEN (1/b > 0)', ctx)).toEqual(bool(false))
    expect(ctx.evaluated).not.toContain('1/b')
  })

  it('AND_THEN evaluates the right side when the left is TRUE', () => {
    expect(evaluate('a AND_THEN (4/b > 0)', context({ a: bool(true), b: int(2) }))).toEqual(bool(true))
    expect(evaluate('a AND_THEN (b > 5)', context({ a: bool(true), b: int(2) }))).toEqual(bool(false))
    expect(() => evaluate('a AND_THEN (1/b > 0)', context({ a: bool(true), b: int(0) }))).toThrow(/division by zero/)
  })

  it('OR_ELSE skips the right side when the left is TRUE', () => {
    const ctx = context({ a: bool(true), b: int(0) })
    expect(evaluate('a OR_ELSE (1/b > 0)', ctx)).toEqual(bool(true))
    expect(ctx.evaluated).not.toContain('1/b')
  })

  it('OR_ELSE evaluates the right side when the left is FALSE', () => {
    expect(evaluate('a OR_ELSE (b > 1)', context({ a: bool(false), b: int(2) }))).toEqual(bool(true))
    expect(evaluate('a OR_ELSE (b > 5)', context({ a: bool(false), b: int(2) }))).toEqual(bool(false))
    expect(() => evaluate('a OR_ELSE (1/b > 0)', context({ a: bool(false), b: int(0) }))).toThrow(/division by zero/)
  })

  it('is case-insensitive and binds like AND / OR', () => {
    // `a OR_ELSE b AND_THEN c` is `a OR_ELSE (b AND_THEN c)`, so a TRUE `a` skips both.
    const ctx = context({ a: bool(true), b: bool(true), c: int(0) })
    expect(evaluate('a or_else b and_then (1/c > 0)', ctx)).toEqual(bool(true))
    expect(ctx.evaluated).toEqual(['a or_else b and_then (1/c > 0)', 'a'])
  })

  it('rejects a non-BOOL operand', () => {
    expect(() => evaluate('b AND_THEN a', context({ a: bool(true), b: int(1) }))).toThrow(/operand 'b' of AND_THEN must be BOOL/)
    expect(() => evaluate('a OR_ELSE b', context({ a: bool(false), b: int(1) }))).toThrow(/operand 'b' of OR_ELSE must be BOOL/)
  })
})

describe('set_reset_assignment_statement', () => {
  it('S= latches TRUE and a FALSE condition leaves the target unchanged', () => {
    const ctx = context({ x: bool(false) })
    run('x S= TRUE;\nx S= FALSE;', ctx)
    expect(ctx.vars.get('x')!.value).toEqual(bool(true))
  })

  it('S= with a FALSE condition does not set an unset target', () => {
    const ctx = context({ x: bool(false) })
    run('x S= FALSE;', ctx)
    expect(ctx.vars.get('x')!.value).toEqual(bool(false))
  })

  it('R= clears on a TRUE condition and otherwise leaves the target unchanged', () => {
    const ctx = context({ x: bool(true), c: bool(false) })
    run('x R= c;', ctx)
    expect(ctx.vars.get('x')!.value).toEqual(bool(true))
    run('x R= TRUE;\nx R= FALSE;', ctx)
    expect(ctx.vars.get('x')!.value).toEqual(bool(false))
  })

  it('accepts lower-case operators and expression conditions', () => {
    const ctx = context({ x: bool(false), a: bool(true), b: int(3) })
    run('x s= a AND_THEN (b > 2);', ctx)
    expect(ctx.vars.get('x')!.value).toEqual(bool(true))
    run('x r= b > 2;', ctx)
    expect(ctx.vars.get('x')!.value).toEqual(bool(false))
  })

  it('rejects a non-BOOL target or condition', () => {
    expect(() => run('n S= TRUE;', context({ n: int(0) }))).toThrow(/target 'n' of S= must be BOOL/)
    expect(() => run('x R= n;', context({ x: bool(true), n: int(1) }))).toThrow(/operand 'n' of R= must be BOOL/)
  })
})

describe('pragmas', () => {
  it("{attribute 'hide'} in statement position evaluates silently", () => {
    const ctx = context({ x: bool(false) })
    const nodes = statements("{attribute 'hide'}\nx := TRUE;")
    expect(nodes.map((n) => n.type)).toEqual(['pragma', 'assignment_statement'])
    expect(nodes[0]!.namedChildren[0]!.type).toBe('attribute_pragma')
    expect(() => run("{attribute 'hide'}\nx := TRUE;", ctx)).not.toThrow()
    expect(ctx.vars.get('x')!.value).toEqual(bool(true))
    expect(beckhoffNodeHandlers.attribute_pragma!(nodes[0]!.namedChildren[0]!, ctx, evaluator)).toBeUndefined()
  })

  it('conditional directives are no-ops, so every region runs', () => {
    const ctx = context({ x: bool(false) })
    const nodes = statements('{IF defined(FOO)}\nx S= TRUE;\n{END_IF}')
    expect(nodes.map((n) => n.type)).toEqual(['pragma', 'set_reset_assignment_statement', 'pragma'])
    expect(nodes[0]!.namedChildren[0]!.type).toBe('conditional_directive')
    run('{IF defined(FOO)}\nx S= TRUE;\n{END_IF}', ctx)
    expect(ctx.vars.get('x')!.value).toEqual(bool(true))
    expect(beckhoffNodeHandlers.conditional_directive!(nodes[0]!.namedChildren[0]!, ctx, evaluator)).toBeUndefined()
  })

  it('opaque pragmas are no-ops too', () => {
    const ctx = context({})
    expect(() => run('{warning "check this"}', ctx)).not.toThrow()
    expect(ctx.evaluated).toEqual([])
  })
})
