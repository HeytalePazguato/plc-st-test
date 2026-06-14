import { describe, it, expect, beforeAll } from 'vitest'
import { initParser, parseSource, walk } from '../src/parser/parse.js'
import type { Node } from 'web-tree-sitter'
import { IecType } from '../src/interpreter/numeric.js'
import {
  defaultValue,
  cloneValue,
  valueEquals,
  type IecValue,
  type ResolvedType,
  type TypeResolver,
} from '../src/interpreter/values.js'

/** Find the first node of `type` in a parsed source. */
function findNode(source: string, type: string): Node {
  const parsed = parseSource(source, 'inline.st')
  let found: Node | undefined
  walk(parsed.tree.rootNode, (n) => {
    if (found === undefined && n.type === type) found = n
  })
  if (found === undefined) throw new Error(`no ${type} node found`)
  return found
}

/** The `type` field of the first variable_declaration in an FB body. */
function varType(decls: string): Node {
  const src = `FUNCTION_BLOCK FB_T VAR ${decls} END_VAR END_FUNCTION_BLOCK`
  const vd = findNode(src, 'variable_declaration')
  const t = vd.childForFieldName('type')
  if (t === null) throw new Error('variable_declaration has no type')
  return t
}

/** A resolver that knows nothing (for elementary/array/string cases). */
const emptyResolver: TypeResolver = { resolveType: () => undefined }

describe('values', () => {
  beforeAll(async () => {
    await initParser()
  })

  it('ARRAY[1..3] OF INT default = three INT zeros with dims [[1,3]]', () => {
    const node = varType('arr : ARRAY[1..3] OF INT;')
    const v = defaultValue(node, emptyResolver)
    expect(v.kind).toBe('array')
    if (v.kind !== 'array') throw new Error('expected array')
    expect(v.elemType).toBe(IecType.INT)
    expect(v.dims).toEqual([[1, 3]])
    expect(v.data).toHaveLength(3)
    for (const el of v.data) {
      expect(el).toEqual({ kind: 'scalar', type: IecType.INT, value: 0 })
    }
  })

  it('STRUCT defaults recurse (INT 0, BOOL false)', () => {
    // Build the struct field type nodes from real ST, then a fake resolver.
    const src = `TYPE TS : STRUCT a : INT; b : BOOL; END_STRUCT; END_TYPE`
    const structNode = findNode(src, 'structure_type_inline')
    const fieldNodes = structNode.namedChildren.filter(
      (c) => c.type === 'structure_field',
    )
    const resolver: TypeResolver = {
      resolveType: (name): ResolvedType | undefined =>
        name === 'TS'
          ? {
              kind: 'struct',
              typeName: 'TS',
              fields: fieldNodes.map((f) => {
                const nameNode = f.childForFieldName('name')
                const typeNode = f.childForFieldName('type')
                if (nameNode === null || typeNode === null) {
                  throw new Error('bad field')
                }
                return { name: nameNode.text, typeNode }
              }),
            }
          : undefined,
    }
    const node = varType('s : TS;')
    const v = defaultValue(node, resolver)
    expect(v.kind).toBe('struct')
    if (v.kind !== 'struct') throw new Error('expected struct')
    expect(v.typeName).toBe('TS')
    expect(v.fields.get('a')).toEqual({
      kind: 'scalar',
      type: IecType.INT,
      value: 0,
    })
    expect(v.fields.get('b')).toEqual({
      kind: 'scalar',
      type: IecType.BOOL,
      value: false,
    })
  })

  it('struct field initializers are honoured (INT := 5)', () => {
    const v = defaultValue(
      findNode(
        `TYPE TS : STRUCT y : INT := 5; END_STRUCT; END_TYPE`,
        'structure_type_inline',
      ),
      emptyResolver,
    )
    expect(v.kind).toBe('struct')
    if (v.kind !== 'struct') throw new Error('expected struct')
    expect(v.fields.get('y')).toEqual({
      kind: 'scalar',
      type: IecType.INT,
      value: 5,
    })
  })

  it("STRING(10) with initializer 'hello world' truncates to 'hello worl'", () => {
    const node = varType("s : STRING(10) := 'hello world';")
    const v = defaultValue(node, emptyResolver)
    expect(v).toEqual({
      kind: 'scalar',
      type: IecType.STRING,
      value: 'hello worl',
    })
  })

  it('elementary defaults: BOOL false, REAL 0, TIME 0, LINT 0n', () => {
    expect(defaultValue(varType('b : BOOL;'), emptyResolver)).toEqual({
      kind: 'scalar',
      type: IecType.BOOL,
      value: false,
    })
    expect(defaultValue(varType('r : REAL;'), emptyResolver)).toEqual({
      kind: 'scalar',
      type: IecType.REAL,
      value: 0,
    })
    expect(defaultValue(varType('t : TIME;'), emptyResolver)).toEqual({
      kind: 'scalar',
      type: IecType.TIME,
      value: 0,
    })
    expect(defaultValue(varType('l : LINT;'), emptyResolver)).toEqual({
      kind: 'scalar',
      type: IecType.LINT,
      value: 0n,
    })
  })

  it('enum default is the first member value (honouring explicit values)', () => {
    const resolver: TypeResolver = {
      resolveType: (name): ResolvedType | undefined =>
        name === 'EColor'
          ? {
              kind: 'enum',
              typeName: 'EColor',
              members: [
                { name: 'Red', value: 0 },
                { name: 'Green', value: 3 },
                { name: 'Blue', value: 4 },
              ],
            }
          : undefined,
    }
    const v = defaultValue(varType('c : EColor;'), resolver)
    expect(v).toEqual({ kind: 'enum', typeName: 'EColor', value: 0 })
  })

  it('alias resolves through to the underlying type and default', () => {
    const aliasTypeNode = findNode(
      `TYPE TAlias : INT := 7; END_TYPE`,
      'type_definition',
    )
    const innerType = aliasTypeNode.childForFieldName('definition')
    const innerInit = aliasTypeNode.childForFieldName('default')
    if (innerType === null || innerInit === null) throw new Error('bad alias')
    const resolver: TypeResolver = {
      resolveType: (name): ResolvedType | undefined =>
        name === 'TAlias'
          ? {
              kind: 'alias',
              typeName: 'TAlias',
              typeNode: innerType,
              initNode: innerInit,
            }
          : undefined,
    }
    const v = defaultValue(varType('a : TAlias;'), resolver)
    expect(v).toEqual({ kind: 'scalar', type: IecType.INT, value: 7 })
  })

  it('cloneValue of an array is an independent copy', () => {
    const original = defaultValue(
      varType('arr : ARRAY[1..3] OF INT;'),
      emptyResolver,
    )
    const clone = cloneValue(original)
    expect(valueEquals(original, clone)).toBe(true)
    if (clone.kind !== 'array' || original.kind !== 'array') {
      throw new Error('expected arrays')
    }
    const first = clone.data[0]
    if (first.kind !== 'scalar') throw new Error('expected scalar')
    first.value = 99
    // Original element is untouched.
    const origFirst = original.data[0]
    if (origFirst.kind !== 'scalar') throw new Error('expected scalar')
    expect(origFirst.value).toBe(0)
    expect(valueEquals(original, clone)).toBe(false)
  })

  it('cloneValue of a struct copies the field Map independently', () => {
    const s: IecValue = {
      kind: 'struct',
      typeName: 'TS',
      fields: new Map<string, IecValue>([
        ['a', { kind: 'scalar', type: IecType.INT, value: 1 }],
      ]),
    }
    const clone = cloneValue(s)
    if (clone.kind !== 'struct') throw new Error('expected struct')
    clone.fields.set('a', { kind: 'scalar', type: IecType.INT, value: 2 })
    expect(s.fields.get('a')).toEqual({
      kind: 'scalar',
      type: IecType.INT,
      value: 1,
    })
  })

  it('valueEquals compares REAL by exact bits and rejects type mismatch', () => {
    const a: IecValue = { kind: 'scalar', type: IecType.REAL, value: 1.5 }
    const b: IecValue = { kind: 'scalar', type: IecType.REAL, value: 1.5 }
    const c: IecValue = { kind: 'scalar', type: IecType.LREAL, value: 1.5 }
    expect(valueEquals(a, b)).toBe(true)
    expect(valueEquals(a, c)).toBe(false)
  })
})
