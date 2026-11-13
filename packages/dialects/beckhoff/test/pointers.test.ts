import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { Language, Parser, type Node } from 'web-tree-sitter'
import type { IecValue, NodeEvaluator, Slot } from '@plc-st/plugin-api'
import { beckhoffDialect, beckhoffNodeHandlers, isValidRefHostFn, sizeOf, sizeofHostFn } from '../src/index.js'

/**
 * The handlers run against nodes parsed by the real published `tree-sitter-iec61131-3-st-beckhoff` wasm. Dialects may not import `@plc-st/core`, so the `NodeEvaluator` is a stand-in with a slot table, plain variables, integer literals, `+` and the dialect's own handlers; the CLI's end-to-end tests run the same constructs through the real interpreter (reference auto-dereference lives in core, so only the explicit `REF=` binding is checked here).
 */

let parser: Parser

beforeAll(async () => {
  await Parser.init()
  const language = await Language.load(new Uint8Array(readFileSync(beckhoffDialect.grammarWasmPath())))
  parser = new Parser()
  parser.setLanguage(language)
})

const int = (value: number): IecValue => ({ kind: 'scalar', type: 'INT', value })
const nullPointer = (): IecValue => ({ kind: 'scalar', type: 'POINTER', value: 0 })
const nullReference = (): IecValue => ({ kind: 'scalar', type: 'REFERENCE', value: 0 })

class StandInError extends Error {}

interface Ctx {
  vars: Map<string, Slot>
  table: Slot[]
}

const lvalueHandler = beckhoffDialect.lvalueHandlers!.dereference_expression!

const evaluator: NodeEvaluator = {
  evaluate(raw, rawCtx) {
    const node = raw as Node
    switch (node.type) {
      case 'integer_literal':
        return int(Number(node.text))
      case 'identifier':
        return evaluator.lvalue(node, rawCtx).value
      case 'parenthesized_expression':
        return evaluator.evaluate(node.namedChildren[0]!, rawCtx)
      default: {
        const handler = beckhoffNodeHandlers[node.type]
        if (handler === undefined) throw evaluator.error(node, rawCtx, `stand-in evaluator has no ${node.type}`)
        return handler(node, rawCtx, evaluator) as IecValue
      }
    }
  },
  lvalue(raw, rawCtx) {
    const node = raw as Node
    if (node.type === 'dereference_expression') return lvalueHandler(node, rawCtx, evaluator)
    return evaluator.rawLvalue(node, rawCtx)
  },
  rawLvalue(raw, rawCtx) {
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
  handleOf(slot, rawCtx) {
    const table = (rawCtx as Ctx).table
    const known = table.indexOf(slot)
    if (known >= 0) return known + 1
    table.push(slot)
    return table.length
  },
  slotOf(handle, rawCtx) {
    return (rawCtx as Ctx).table[handle - 1]
  },
}

function context(vars: Record<string, IecValue>): Ctx {
  return { vars: new Map(Object.entries(vars).map(([k, v]) => [k.toLowerCase(), { value: v }])), table: [] }
}

function statements(body: string): Node[] {
  const tree = parser.parse(`FUNCTION_BLOCK FB_T\nVAR\n  x : INT;\nEND_VAR\n${body}\nEND_FUNCTION_BLOCK\n`)!
  expect(tree.rootNode.hasError, tree.rootNode.toString()).toBe(false)
  return tree.rootNode.namedChildren[0]!.childrenForFieldName('body').filter((n): n is Node => n !== null && n.type !== 'comment')
}

/** Run statements the way core does: `:=` through the lvalue and store, anything else through the dialect's handler. */
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

describe('pointers', () => {
  it('registers the handlers, the dereference lvalue and the host functions', () => {
    expect(Object.keys(beckhoffNodeHandlers)).toEqual(expect.arrayContaining(['address_of_expression', 'dereference_expression', 'reference_assignment_statement']))
    expect(Object.keys(beckhoffDialect.lvalueHandlers ?? {})).toEqual(['dereference_expression'])
    expect(beckhoffDialect.hostFns).toEqual([sizeofHostFn, isValidRefHostFn])
  })

  it('ADR(x) yields a POINTER handle and p^ reads and writes through it', () => {
    const ctx = context({ nVal: int(3), pInt: nullPointer() })
    run('pInt := ADR(nVal);', ctx)
    expect(ctx.vars.get('pint')!.value).toEqual({ kind: 'scalar', type: 'POINTER', value: 1 })
    run('x := pInt^;', { ...ctx, vars: new Map([...ctx.vars, ['x', { value: int(0) }]]) })
    run('pInt^ := 7;', ctx)
    expect(ctx.vars.get('nval')!.value).toEqual(int(7))
  })

  it('gives the same variable the same handle', () => {
    const ctx = context({ nVal: int(0), pA: nullPointer(), pB: nullPointer() })
    run('pA := ADR(nVal); pB := ADR(nVal);', ctx)
    expect(ctx.vars.get('pa')!.value).toEqual(ctx.vars.get('pb')!.value)
  })

  it('a NULL pointer dereference is a located runtime error, on read and on write', () => {
    const ctx = context({ pInt: nullPointer(), x: int(0) })
    expect(() => run('x := pInt^;', ctx)).toThrow(/null pointer dereference: 'pInt' is NULL at line 5/)
    expect(() => run('pInt^ := 1;', ctx)).toThrow(/null pointer dereference/)
  })

  it('dereferencing something that is not a pointer, or a stale handle, is an error', () => {
    expect(() => run('x := nVal^;', context({ nVal: int(1), x: int(0) }))).toThrow(/'nVal' is not a pointer/)
    expect(() => run('x := p^;', context({ p: { kind: 'scalar', type: 'POINTER', value: 9 }, x: int(0) }))).toThrow(/does not point at a variable/)
  })

  it('REF= binds a reference to the variable behind the right-hand side', () => {
    const ctx = context({ nVal: int(5), rVal: nullReference() })
    run('rVal REF= nVal;', ctx)
    expect(ctx.vars.get('rval')!.value).toEqual({ kind: 'scalar', type: 'REFERENCE', value: 1 })
    expect(ctx.table[0]).toBe(ctx.vars.get('nval'))
  })

  it('REF= on something that is not a reference is an error', () => {
    expect(() => run('nVal REF= other;', context({ nVal: int(1), other: int(2) }))).toThrow(/target 'nVal' of REF= must be declared REFERENCE TO or REF_TO/)
  })

  it('__ISVALIDREF tells bound from unbound references', () => {
    const call = (value: IecValue): IecValue | undefined => isValidRefHostFn.call([{ value }], undefined as never)
    expect(call(nullReference())).toEqual({ kind: 'scalar', type: 'BOOL', value: false })
    expect(call({ kind: 'scalar', type: 'REFERENCE', value: 3 })).toEqual({ kind: 'scalar', type: 'BOOL', value: true })
    expect(isValidRefHostFn.rawArgs).toBe(true)
  })

  it('SIZEOF is the IEC byte size of the declared type', () => {
    const scalar = (type: 'BOOL' | 'INT' | 'DINT' | 'LREAL' | 'TIME' | 'STRING' | 'WSTRING' | 'POINTER', maxLength?: number): IecValue => ({ kind: 'scalar', type, value: 0, ...(maxLength === undefined ? {} : { maxLength }) })
    expect([scalar('BOOL'), scalar('INT'), scalar('DINT'), scalar('LREAL'), scalar('TIME'), scalar('POINTER')].map(sizeOf)).toEqual([1, 2, 4, 8, 4, 8])
    expect(sizeOf(scalar('STRING', 10))).toBe(11)
    expect(sizeOf(scalar('STRING'))).toBe(81)
    expect(sizeOf(scalar('WSTRING', 10))).toBe(22)
    expect(sizeOf({ kind: 'enum', typeName: 'E', value: 0 })).toBe(2)
    expect(sizeOf({ kind: 'array', elemType: 'INT', dims: [[1, 3]], data: [int(0), int(0), int(0)] })).toBe(6)
    expect(sizeOf({ kind: 'struct', typeName: 'ST', fields: new Map([['a', int(0)], ['b', scalar('DINT')]]) })).toBe(6)
    expect(sizeofHostFn.call([{ value: int(0) }], undefined as never)).toEqual({ kind: 'scalar', type: 'UDINT', value: 2 })
  })
})
