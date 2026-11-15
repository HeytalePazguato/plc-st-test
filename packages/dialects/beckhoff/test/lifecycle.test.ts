import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { Language, Parser, type Node } from 'web-tree-sitter'
import type { CallArg, FbInstanceRef, HostCallContext, IecValue, NodeEvaluator, Slot } from '@plc-st/plugin-api'
import { beckhoffDialect, beckhoffNodeHandlers, fbReinitHostFn, onDispose, onInstantiate } from '../src/index.js'

/**
 * The hooks run against a recording `FbInstanceRef`; the intrinsics run against nodes parsed by the real Beckhoff wasm and a stand-in `NodeEvaluator` whose `allocate` and `free` record their calls (dialects may not import `@plc-st/core`). The CLI's end-to-end tests (`beckhoff-lifecycle` fixture) run the same constructs through the real interpreter.
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

interface Call {
  method: string
  args: CallArg[]
}

function instance(methods: string[], typeName = 'FB_X'): FbInstanceRef & { calls: Call[] } {
  const calls: Call[] = []
  return {
    typeName,
    calls,
    hasMethod: (name) => methods.includes(name),
    callMethod: (method, args) => {
      calls.push({ method, args })
      return undefined
    },
  }
}

function hostContext(overrides: Partial<HostCallContext> = {}): HostCallContext & { warnings: string[] } {
  const warnings: string[] = []
  return {
    cycle: 0,
    nowNs: 0n,
    location: { file: 'x.st', line: 1, col: 1 },
    resolvePath: () => undefined,
    instanceAt: () => undefined,
    error: (message) => new Error(message),
    warn: (code) => warnings.push(code),
    warnings,
    ...overrides,
  }
}

describe('lifecycle hooks', () => {
  it('is registered on the dialect', () => {
    expect(beckhoffDialect.hooks?.onInstantiate).toBe(onInstantiate)
    expect(beckhoffDialect.hooks?.onDispose).toBe(onDispose)
    expect(beckhoffDialect.hostFns).toContain(fbReinitHostFn)
  })

  it('calls FB_init with the implicit inputs and the declaration arguments', () => {
    const inst = instance(['FB_init'])
    onInstantiate(inst, hostContext(), [{ name: 'nParam', value: int(5) }])
    expect(inst.calls).toEqual([{ method: 'FB_init', args: [{ name: 'bInitRetains', value: bool(false) }, { name: 'bInCopyCode', value: bool(false) }, { name: 'nParam', value: int(5) }] }])
  })

  it('does nothing for a function block without FB_init', () => {
    const inst = instance([])
    const ctx = hostContext()
    onInstantiate(inst, ctx, [])
    expect(inst.calls).toEqual([])
    expect(ctx.warnings).toEqual([])
  })

  it('warns and ignores declaration arguments when there is no FB_init', () => {
    const ctx = hostContext()
    onInstantiate(instance([]), ctx, [{ name: 'nParam', value: int(5) }])
    expect(ctx.warnings).toEqual(['FB_INIT_MISSING'])
  })

  it('rejects positional declaration arguments', () => {
    expect(() => onInstantiate(instance(['FB_init']), hostContext(), [{ value: int(5) }])).toThrow(/must be named/)
  })

  it('calls FB_exit with bInCopyCode := FALSE on dispose, only when declared', () => {
    const withExit = instance(['FB_exit'])
    onDispose(withExit, hostContext())
    expect(withExit.calls).toEqual([{ method: 'FB_exit', args: [{ name: 'bInCopyCode', value: bool(false) }] }])
    const without = instance([])
    onDispose(without, hostContext())
    expect(without.calls).toEqual([])
  })
})

describe('FB_REINIT', () => {
  const path = (value: string): CallArg => ({ value: { kind: 'scalar', type: 'STRING', value } })

  it('calls FB_reinit on the instance at the path', () => {
    const inst = instance(['FB_reinit'])
    const ctx = hostContext({ instanceAt: (p) => (p === 'fbX' ? inst : undefined) })
    expect(fbReinitHostFn.call([path('fbX')], ctx)).toBeUndefined()
    expect(inst.calls).toEqual([{ method: 'FB_reinit', args: [] }])
  })

  it('errors on an unknown path, a missing FB_reinit and a non-string argument', () => {
    expect(() => fbReinitHostFn.call([path('nope')], hostContext())).toThrow(/not a function block instance/)
    expect(() => fbReinitHostFn.call([path('fbX')], hostContext({ instanceAt: () => instance([]) }))).toThrow(/declares no FB_reinit/)
    expect(() => fbReinitHostFn.call([{ value: int(1) }], hostContext())).toThrow(/as a STRING/)
  })
})

interface Ctx {
  vars: Map<string, Slot>
  allocated: { type: string; count: number | undefined }[]
  freed: number[]
}

const evaluator: NodeEvaluator = {
  evaluate(raw, ctx) {
    const node = raw as Node
    if (node.type === 'integer_literal') return int(Number(node.text))
    if (node.type === 'identifier') return evaluator.lvalue(node, ctx).value
    const handler = beckhoffNodeHandlers[node.type]
    if (handler === undefined) throw new Error(`no handler for ${node.type}`)
    return handler(node, ctx, evaluator) as IecValue
  },
  lvalue(raw, ctx) {
    const node = raw as Node
    const slot = (ctx as Ctx).vars.get(node.text.toLowerCase())
    if (slot === undefined) throw evaluator.error(node, ctx, `unknown variable '${node.text}'`)
    return slot
  },
  rawLvalue: (raw, ctx) => evaluator.lvalue(raw, ctx),
  store(slot, value) {
    slot.value = value
  },
  error: (_raw, _ctx, message) => new Error(message),
  handleOf: () => 0,
  slotOf: () => undefined,
  allocate(type, count, ctx) {
    ;(ctx as Ctx).allocated.push({ type: (type as Node).text, count })
    return (ctx as Ctx).allocated.length
  },
  free(handle, _node, ctx) {
    ;(ctx as Ctx).freed.push(handle)
  },
}

function context(vars: Record<string, IecValue>): Ctx {
  return { vars: new Map(Object.entries(vars).map(([k, v]) => [k.toLowerCase(), { value: v }])), allocated: [], freed: [] }
}

/** Run the statements of `body` the way core does and return the value of the last assignment. */
function run(body: string, ctx: Ctx): IecValue | undefined {
  const tree = parser.parse(`FUNCTION_BLOCK FB_T\nVAR\n  p : INT;\nEND_VAR\n${body}\nEND_FUNCTION_BLOCK\n`)!
  expect(tree.rootNode.hasError, tree.rootNode.toString()).toBe(false)
  let last: IecValue | undefined
  for (const stmt of tree.rootNode.namedChildren[0]!.childrenForFieldName('body').filter((n): n is Node => n !== null && n.type !== 'comment')) {
    if (stmt.type === 'assignment_statement') {
      last = evaluator.evaluate(stmt.childForFieldName('right')!, ctx)
      evaluator.store(evaluator.lvalue(stmt.childForFieldName('left')!, ctx), last, stmt, ctx)
    } else {
      beckhoffNodeHandlers[stmt.type]!(stmt, ctx, evaluator)
    }
  }
  return last
}

describe('intrinsics', () => {
  it('__NEW(T) and __NEW(T, n) allocate through the evaluator and yield a POINTER', () => {
    const ctx = context({ p: { kind: 'scalar', type: 'POINTER', value: 0 } })
    expect(run('p := __NEW(FB_X);', ctx)).toEqual({ kind: 'scalar', type: 'POINTER', value: 1 })
    run('p := __NEW(INT, 4);', ctx)
    expect(ctx.allocated).toEqual([{ type: 'FB_X', count: undefined }, { type: 'INT', count: 4 }])
  })

  it('__DELETE(p) frees the allocation and nulls p; deleting NULL does nothing', () => {
    const ctx = context({ p: { kind: 'scalar', type: 'POINTER', value: 7 } })
    run('__DELETE(p);', ctx)
    expect(ctx.freed).toEqual([7])
    expect(ctx.vars.get('p')!.value).toEqual({ kind: 'scalar', type: 'POINTER', value: 0 })
    run('__DELETE(p);', ctx)
    expect(ctx.freed).toEqual([7])
  })

  it('__DELETE of a non-pointer is an error', () => {
    expect(() => run('__DELETE(p);', context({ p: int(1) }))).toThrow(/not a pointer/)
  })

  it('__SYSTEM.GetCurrentTaskIndex() is 0 and any other intrinsic names itself in the error', () => {
    const ctx = context({ p: int(9) })
    expect(run('p := __SYSTEM.GetCurrentTaskIndex();', ctx)).toMatchObject({ value: 0 })
    expect(() => run('p := __SYSTEM.GetCurrentTaskTime();', ctx)).toThrow('__SYSTEM.GetCurrentTaskTime is not supported by the simulator')
  })
})
