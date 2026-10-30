import { describe, it, expect, beforeAll } from 'vitest'
import type { Language, Node } from 'web-tree-sitter'
import { loadGrammar, baseGrammarPath, parseSource, walk } from '../src/parser/parse.js'
import { testConstEval } from './helpers/const-eval.js'
import { IecType } from '../src/interpreter/numeric.js'
import { defaultValue, type IecValue, type TypeResolver } from '../src/interpreter/values.js'
import { Scope, ScopeChainImpl, resetTemps } from '../src/interpreter/scope.js'
import type { Slot } from '../src/interpreter/context.js'
import type { VarKind } from '../src/symbols/table.js'
import { Session } from '../src/session.js'
import { IecError } from '../src/errors.js'

let lang: Language

const FB_SRC = `
FUNCTION_BLOCK FB_Counter
VAR_IN_OUT
  io : INT;
END_VAR
VAR
  count : INT := 5;
END_VAR
VAR_TEMP
  tmp : INT := 7;
  flag : BOOL;
END_VAR
END_FUNCTION_BLOCK
`

const KIND_OF_BLOCK: Record<string, VarKind> = {
  var_in_out: 'inout',
  var_block: 'local',
  var_temp: 'temp',
}

const emptyResolver: TypeResolver = { resolveType: () => undefined }

/** Parse FB_SRC and return each declared variable's type node and kind. */
function declarations(): Map<string, { typeNode: Node; kind: VarKind }> {
  const parsed = parseSource(lang, FB_SRC, 'scope.st')
  const out = new Map<string, { typeNode: Node; kind: VarKind }>()
  walk(parsed.tree.rootNode, (n) => {
    if (n.type !== 'variable_declaration') return
    const kind = n.parent !== null ? KIND_OF_BLOCK[n.parent.type] : undefined
    const typeNode = n.childForFieldName('type')
    if (kind === undefined || typeNode === null) return
    for (const name of n.childrenForFieldName('names')) {
      if (name.type === 'identifier') out.set(name.text, { typeNode, kind })
    }
  })
  return out
}

const int = (value: number): IecValue => ({ kind: 'scalar', type: IecType.INT, value })

/** Build the FB_Counter scope with `io` aliased to `callerSlot`. */
function fbScope(callerSlot: Slot, caseSensitive = false) {
  const decls = declarations()
  const scope = new Scope(caseSensitive)
  for (const [name, { typeNode, kind }] of decls) {
    if (kind === 'inout') scope.declare(name, callerSlot, kind)
    else scope.declare(name, { value: defaultValue(typeNode, emptyResolver, testConstEval(emptyResolver)) }, kind)
  }
  const typeOf = (name: string): Node => {
    const d = decls.get(name)
    if (d === undefined) throw new Error(`unknown ${name}`)
    return d.typeNode
  }
  return { scope, typeOf }
}

describe('scope chain', () => {
  beforeAll(async () => {
    lang = await loadGrammar(baseGrammarPath())
  })

  it('a write through a VAR_IN_OUT alias is visible to the caller', () => {
    const callerScope = new Scope(false)
    const callerSlot: Slot = { value: int(1) }
    callerScope.declare('x', callerSlot, 'local')
    const { scope } = fbScope(callerSlot)
    const chain = new ScopeChainImpl([callerScope]).push(scope)

    chain.lookup('io')!.value = int(42)

    expect(callerScope.get('x')!.value).toEqual(int(42))
    expect(chain.lookup('io')).toBe(callerSlot)
  })

  it('VAR persists across two body invocations of the same scope', () => {
    const { scope, typeOf } = fbScope({ value: int(0) })
    for (let i = 0; i < 2; i++) {
      resetTemps(scope, typeOf, emptyResolver, testConstEval(emptyResolver))
      const count = scope.get('count')!
      const v = count.value
      if (v.kind !== 'scalar') throw new Error('expected scalar')
      count.value = int((v.value as number) + 1)
    }
    expect(scope.get('count')!.value).toEqual(int(7))
  })

  it('resetTemps restores VAR_TEMP defaults but not VAR, keeping the same Slot objects', () => {
    const { scope, typeOf } = fbScope({ value: int(0) })
    const tmp = scope.get('tmp')!
    const flag = scope.get('flag')!
    expect(tmp.value).toEqual(int(7))

    tmp.value = int(99)
    flag.value = { kind: 'scalar', type: IecType.BOOL, value: true }
    scope.get('count')!.value = int(11)

    resetTemps(scope, typeOf, emptyResolver, testConstEval(emptyResolver))

    expect(scope.get('tmp')).toBe(tmp)
    expect(tmp.value).toEqual(int(7))
    expect(flag.value).toEqual({ kind: 'scalar', type: IecType.BOOL, value: false })
    expect(scope.get('count')!.value).toEqual(int(11))
  })

  it('resetTemps never touches an aliased VAR_IN_OUT slot', () => {
    const callerSlot: Slot = { value: int(3) }
    const { scope, typeOf } = fbScope(callerSlot)
    resetTemps(scope, typeOf, emptyResolver, testConstEval(emptyResolver))
    expect(callerSlot.value).toEqual(int(3))
  })

  it('innermost shadowing wins', () => {
    const outer = new Scope(false)
    outer.declare('v', { value: int(1) }, 'local')
    outer.declare('onlyOuter', { value: int(2) }, 'local')
    const inner = new Scope(false)
    inner.declare('v', { value: int(10) }, 'temp')

    const base = new ScopeChainImpl([outer])
    const chain = base.push(inner)

    expect(chain.lookup('v')!.value).toEqual(int(10))
    expect(chain.lookup('onlyOuter')!.value).toEqual(int(2))
    expect(chain.lookup('missing')).toBeUndefined()
    // push is immutable: the original chain still sees the outer binding.
    expect(base.lookup('v')!.value).toEqual(int(1))
  })

  it('a case-sensitive chain distinguishes a/A while a case-insensitive one does not', () => {
    const sensitive = new Session({ caseSensitive: true })
    const insensitive = new Session({ caseSensitive: false })

    const cs = new Scope(sensitive.caseSensitive)
    cs.declare('a', { value: int(1) }, 'local')
    cs.declare('A', { value: int(2) }, 'local')
    const csChain = new ScopeChainImpl([cs])
    expect(csChain.lookup('a')!.value).toEqual(int(1))
    expect(csChain.lookup('A')!.value).toEqual(int(2))

    const ci = new Scope(insensitive.caseSensitive)
    ci.declare('a', { value: int(1) }, 'local')
    expect(() => ci.declare('A', { value: int(2) }, 'local')).toThrow(IecError)
    const ciChain = new ScopeChainImpl([ci])
    expect(ciChain.lookup('A')).toBe(ciChain.lookup('a'))
  })

  it('redeclaring a name in the same scope throws IecError', () => {
    const scope = new Scope(true)
    scope.declare('x', { value: int(0) }, 'local')
    expect(() => scope.declare('x', { value: int(0) }, 'temp')).toThrow(IecError)
  })

  it('entries() lists declarations in order with their kinds', () => {
    const { scope } = fbScope({ value: int(0) })
    expect(scope.entries().map(([n, , k]) => [n, k])).toEqual([
      ['io', 'inout'],
      ['count', 'local'],
      ['tmp', 'temp'],
      ['flag', 'temp'],
    ])
  })
})
