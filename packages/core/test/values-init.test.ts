import { describe, it, expect, beforeAll } from 'vitest'
import type { Language, Node } from 'web-tree-sitter'
import { loadGrammar, baseGrammarPath, parseSource, walk } from '../src/parser/parse.js'
import { IecType } from '../src/interpreter/numeric.js'
import { IecRuntimeError } from '../src/errors.js'
import { testConstEval } from './helpers/const-eval.js'
import { defaultValue, type IecValue, type ResolvedType, type TypeResolver } from '../src/interpreter/values.js'

let lang: Language

/** The `type` node of the first variable_declaration in an FB, plus the parsed source's root for type lookups. */
function varType(decls: string, types = ''): { node: Node; resolver: TypeResolver } {
  const parsed = parseSource(lang, `${types} FUNCTION_BLOCK FB_T VAR ${decls} END_VAR END_FUNCTION_BLOCK`, 'inline.st')
  let found: Node | undefined
  const typeDefs = new Map<string, Node>()
  walk(parsed.tree.rootNode, (n) => {
    if (found === undefined && n.type === 'variable_declaration') found = n
    if (n.type === 'type_declaration' || n.type === 'type_definition') typeDefs.set(n.childForFieldName('name')?.text ?? '', n)
  })
  const t = found?.childForFieldName('type')
  if (t === null || t === undefined) throw new Error('no variable type')
  const resolver: TypeResolver = {
    resolveType(name): ResolvedType | undefined {
      const def = typeDefs.get(name)
      if (def === undefined) return undefined
      const fields = def.descendantsOfType('structure_field').map((f) => ({ name: f.childForFieldName('name')?.text ?? '', typeNode: f.childForFieldName('type') as Node, initNode: f.childForFieldName('default') ?? undefined }))
      return { kind: 'struct', typeName: name, fields }
    },
  }
  return { node: t, resolver }
}

function ints(v: IecValue): unknown[] {
  if (v.kind !== 'array') throw new Error('expected array')
  return v.data.map((e) => (e.kind === 'scalar' ? e.value : undefined))
}

function init(decl: string): IecValue {
  const { node, resolver } = varType(decl)
  return defaultValue(node, resolver, testConstEval(resolver))
}

describe('array initializers', () => {
  beforeAll(async () => {
    lang = await loadGrammar(baseGrammarPath())
  })

  it('honours a plain list', () => {
    expect(ints(init('arr : ARRAY[1..3] OF INT := [1, 2, 3];'))).toEqual([1, 2, 3])
  })

  it('expands the repetition form 2(5)', () => {
    expect(ints(init('arr : ARRAY[1..3] OF INT := [2(5), 3];'))).toEqual([5, 5, 3])
  })

  it('keeps the element default for the elements a partial initializer omits', () => {
    expect(ints(init('arr : ARRAY[1..4] OF INT := [7, 8];'))).toEqual([7, 8, 0, 0])
  })

  it('fills multi-dimensional arrays row-major', () => {
    const v = init('m : ARRAY[1..2, 1..3] OF INT := [1, 2, 3, 4, 5, 6];')
    expect(v.kind === 'array' && v.dims).toEqual([[1, 2], [1, 3]])
    expect(ints(v)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('rejects an out-of-range element instead of wrapping it', () => {
    expect(() => init('a : ARRAY[1..2] OF SINT := [200, -1];')).toThrow(IecRuntimeError)
    expect(() => init('a : ARRAY[1..2] OF SINT := [200, -1];')).toThrow(/out of range for SINT/)
    expect(ints(init('a : ARRAY[1..2] OF SINT := [127, -1];'))).toEqual([127, -1])
  })

  it('frounds and truncates elements through the element type', () => {
    expect(ints(init('a : ARRAY[1..1] OF REAL := [0.1];'))).toEqual([Math.fround(0.1)])
    const s = init("a : ARRAY[1..2] OF STRING(3) := ['abcdef', 'x'];")
    expect(ints(s)).toEqual(['abc', 'x'])
  })

  it('uses 64-bit element types as bigint', () => {
    expect(ints(init('a : ARRAY[1..2] OF LINT := [5, 6];'))).toEqual([5n, 6n])
  })

  it('throws an IecRuntimeError naming the variable when there are too many elements', () => {
    expect(() => init('tooMany : ARRAY[1..2] OF INT := [1, 2, 3];')).toThrow(IecRuntimeError)
    expect(() => init('tooMany : ARRAY[1..2] OF INT := [1, 2, 3];')).toThrow(/tooMany/)
    expect(() => init('tooMany : ARRAY[1..2] OF INT := [3(1)];')).toThrow(/tooMany/)
  })

  it('counts the allocation before building a huge repetition-initialised array', () => {
    const { node, resolver } = varType('big : ARRAY[1..1000000] OF INT := [5];')
    const meter = { allocation: 0, limits: { maxAllocatedElements: 100, maxStringLength: 255 } }
    expect(() => defaultValue(node, resolver, testConstEval(resolver), meter)).toThrow(/allocation limit/)
  })

  it('initialises struct variables and arrays of structs', () => {
    const types = 'TYPE S : STRUCT x : INT; y : INT := 9; END_STRUCT; END_TYPE'
    const sv = varType('d : S := (x := 4);', types)
    const s = defaultValue(sv.node, sv.resolver, testConstEval(sv.resolver))
    expect(s.kind === 'struct' && [...s.fields.values()].map((f) => (f.kind === 'scalar' ? f.value : null))).toEqual([4, 9])
    const av = varType('c : ARRAY[1..2] OF S;', types)
    const a = defaultValue(av.node, av.resolver, testConstEval(av.resolver))
    expect(a.kind === 'array' && a.data.length).toBe(2)
  })

  it('still defaults scalars and enums', () => {
    const e = varType('e : INT := 3;')
    expect(defaultValue(e.node, e.resolver, testConstEval(e.resolver))).toEqual({ kind: 'scalar', type: IecType.INT, value: 3 })
    const resolver: TypeResolver = { resolveType: () => ({ kind: 'enum', typeName: 'E', members: [{ name: 'A', value: 0 }, { name: 'B', value: 1 }] }) }
    const ev = varType('x : E := E.B;')
    expect(defaultValue(ev.node, resolver, testConstEval(resolver))).toEqual({ kind: 'enum', typeName: 'E', value: 1 })
  })
})
