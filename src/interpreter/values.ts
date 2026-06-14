/**
 * Runtime value model for the IEC 61131-3 interpreter.
 *
 * A value is one of four shapes: a scalar (elementary type), an array, a
 * struct, or an enum. `defaultValue` walks a grammar type-specifier node and
 * produces the IEC initial value for it (honouring a declared initializer when
 * the surrounding declaration carries one). The `TypeResolver` interface is
 * declared here — rather than imported from the symbol table — so the symbol
 * table can implement it without creating a circular import.
 */

import type { Node } from 'web-tree-sitter'
import { IecType, isBigIntType, froundReal } from './numeric.js'

/** A runtime value: scalar, array, struct, or enum. */
export type IecValue =
  | { kind: 'scalar'; type: IecType; value: number | bigint | boolean | string }
  | {
      kind: 'array'
      elemType: IecType | string
      dims: [number, number][]
      data: IecValue[]
    }
  | { kind: 'struct'; typeName: string; fields: Map<string, IecValue> }
  | { kind: 'enum'; typeName: string; value: number }

// ---------------------------------------------------------------------------
// Resolver interface (implemented by the cross-file symbol table).
// ---------------------------------------------------------------------------

export interface StructTypeInfo {
  kind: 'struct'
  typeName: string
  fields: { name: string; typeNode: Node; initNode?: Node }[]
}

export interface EnumTypeInfo {
  kind: 'enum'
  typeName: string
  members: { name: string; value: number }[]
}

export interface AliasTypeInfo {
  kind: 'alias'
  typeName: string
  typeNode: Node
  initNode?: Node
}

export type ResolvedType = StructTypeInfo | EnumTypeInfo | AliasTypeInfo

export interface TypeResolver {
  resolveType(name: string): ResolvedType | undefined
}

// ---------------------------------------------------------------------------
// Elementary type name -> IecType.
// ---------------------------------------------------------------------------

/**
 * Map every `elementary_type` keyword the grammar can emit onto an `IecType`.
 * The date/time family folds onto TIME and CHAR/WCHAR onto STRING/WSTRING since
 * those distinct elementary types are not modelled separately yet.
 */
const ELEMENTARY: Record<string, IecType> = {
  BOOL: IecType.BOOL,
  BYTE: IecType.BYTE,
  WORD: IecType.WORD,
  DWORD: IecType.DWORD,
  LWORD: IecType.LWORD,
  SINT: IecType.SINT,
  USINT: IecType.USINT,
  INT: IecType.INT,
  UINT: IecType.UINT,
  DINT: IecType.DINT,
  UDINT: IecType.UDINT,
  LINT: IecType.LINT,
  ULINT: IecType.ULINT,
  REAL: IecType.REAL,
  LREAL: IecType.LREAL,
  TIME: IecType.TIME,
  LTIME: IecType.TIME,
  DATE: IecType.TIME,
  LDATE: IecType.TIME,
  TIME_OF_DAY: IecType.TIME,
  TOD: IecType.TIME,
  LTIME_OF_DAY: IecType.TIME,
  LTOD: IecType.TIME,
  DATE_AND_TIME: IecType.TIME,
  DT: IecType.TIME,
  LDATE_AND_TIME: IecType.TIME,
  LDT: IecType.TIME,
  CHAR: IecType.STRING,
  WCHAR: IecType.WSTRING,
}

function elementaryToIecType(name: string): IecType {
  const t = ELEMENTARY[name.toUpperCase()]
  if (t === undefined) {
    // Unknown elementary keyword: fall back to DINT so callers never crash.
    return IecType.DINT
  }
  return t
}

// ---------------------------------------------------------------------------
// Literal evaluation helpers.
// ---------------------------------------------------------------------------

/** Evaluate an `integer_literal` text (base prefixes, underscores, sign). */
function evalIntLiteral(text: string, big: boolean): number | bigint {
  let s = text.trim().replace(/_/g, '')
  let neg = false
  if (s.startsWith('+') || s.startsWith('-')) {
    neg = s.startsWith('-')
    s = s.slice(1)
  }
  let base = 10
  const m = /^(2|8|16)#(.+)$/.exec(s)
  if (m) {
    base = Number(m[1])
    s = m[2]
  }
  if (big) {
    const B = BigInt(base)
    let v = 0n
    for (const ch of s) {
      v = v * B + BigInt(parseInt(ch, 16))
    }
    return neg ? -v : v
  }
  const v = parseInt(s, base)
  return neg ? -v : v
}

/** Strip the surrounding quotes from a `string_literal` node's text. */
function stringLiteralText(text: string): string {
  if (text.length >= 2) {
    const first = text[0]
    const last = text[text.length - 1]
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
      return text.slice(1, -1)
    }
  }
  return text
}

/** Scalar value for an elementary `type`, honouring `initNode` when present. */
function scalarValue(
  type: IecType,
  initNode: Node | undefined,
): number | bigint | boolean | string {
  if (initNode === undefined) {
    return scalarDefault(type)
  }
  switch (initNode.type) {
    case 'boolean_literal':
      return initNode.text.toUpperCase() === 'TRUE'
    case 'integer_literal': {
      if (type === IecType.REAL) return froundReal(Number(initNode.text.replace(/_/g, '')))
      if (type === IecType.LREAL) return Number(initNode.text.replace(/_/g, ''))
      if (type === IecType.STRING || type === IecType.WSTRING) return initNode.text
      if (type === IecType.BOOL) return initNode.text.trim() !== '0'
      return evalIntLiteral(initNode.text, isBigIntType(type))
    }
    case 'real_literal': {
      const n = Number(initNode.text.replace(/_/g, ''))
      return type === IecType.REAL ? froundReal(n) : n
    }
    case 'string_literal':
      return stringLiteralText(initNode.text)
    default:
      // time_literal, typed_literal, identifier, etc.: keep the IEC default.
      return scalarDefault(type)
  }
}

/** IEC default for an elementary `type` (no initializer). */
function scalarDefault(type: IecType): number | bigint | boolean | string {
  if (type === IecType.BOOL) return false
  if (type === IecType.STRING || type === IecType.WSTRING) return ''
  if (isBigIntType(type)) return 0n
  return 0
}

// ---------------------------------------------------------------------------
// Default-value construction.
// ---------------------------------------------------------------------------

/**
 * Find an initializer expression attached to the declaration that owns
 * `typeNode`. The grammar names it `initial_value` on a variable_declaration
 * and `default` on a structure_field / type_definition; in all cases it is a
 * sibling field of the type specifier, not a child of it.
 */
function findInitializer(typeNode: Node): Node | undefined {
  const parent = typeNode.parent
  if (parent === null) return undefined
  return (
    parent.childForFieldName('initial_value') ??
    parent.childForFieldName('default') ??
    undefined
  )
}

/**
 * Produce the IEC initial value for the type that `typeNode` describes. If the
 * owning declaration carries an initializer it is honoured, otherwise the IEC
 * default for the type is used. Named types are looked up through `resolver`.
 */
export function defaultValue(typeNode: Node, resolver: TypeResolver): IecValue {
  return buildDefault(typeNode, findInitializer(typeNode), resolver)
}

function buildDefault(
  typeNode: Node,
  initNode: Node | undefined,
  resolver: TypeResolver,
): IecValue {
  switch (typeNode.type) {
    case 'elementary_type': {
      const type = elementaryToIecType(typeNode.text)
      return { kind: 'scalar', type, value: scalarValue(type, initNode) }
    }
    case 'subrange_type': {
      // e.g. INT(0..100): the value carries the base elementary type.
      const base = typeNode.namedChildren.find(
        (c) => c.type === 'elementary_type',
      )
      const type = base ? elementaryToIecType(base.text) : IecType.INT
      return { kind: 'scalar', type, value: scalarValue(type, initNode) }
    }
    case 'string_type':
      return stringDefault(typeNode, initNode)
    case 'array_type':
      return arrayDefault(typeNode, resolver)
    case 'enumerated_type_inline':
      return inlineEnumDefault(typeNode, '')
    case 'structure_type_inline':
      return inlineStructDefault(typeNode, '', resolver)
    case 'identifier':
    case 'qualified_identifier':
      return namedDefault(typeNode.text, initNode, resolver)
    default:
      // Unknown specifier (pointer/reference/generic): use an opaque struct.
      return { kind: 'struct', typeName: typeNode.text, fields: new Map() }
  }
}

function stringDefault(typeNode: Node, initNode: Node | undefined): IecValue {
  const type = typeNode.text.toUpperCase().startsWith('WSTRING')
    ? IecType.WSTRING
    : IecType.STRING
  const lengthNode = typeNode.childForFieldName('length')
  const maxLen =
    lengthNode !== null
      ? Number(evalIntLiteral(lengthNode.text, false))
      : undefined
  let value = ''
  if (initNode !== undefined && initNode.type === 'string_literal') {
    value = stringLiteralText(initNode.text)
  }
  if (maxLen !== undefined && value.length > maxLen) {
    value = value.slice(0, maxLen)
  }
  return { kind: 'scalar', type, value }
}

function elemTypeOf(node: Node): IecType | string {
  if (node.type === 'elementary_type') return elementaryToIecType(node.text)
  if (node.type === 'string_type') {
    return node.text.toUpperCase().startsWith('WSTRING')
      ? IecType.WSTRING
      : IecType.STRING
  }
  if (node.type === 'subrange_type') {
    const base = node.namedChildren.find((c) => c.type === 'elementary_type')
    return base ? elementaryToIecType(base.text) : IecType.INT
  }
  return node.text
}

function arrayDefault(typeNode: Node, resolver: TypeResolver): IecValue {
  const ranges = typeNode.childrenForFieldName('range')
  const dims: [number, number][] = []
  let total = 1
  for (const r of ranges) {
    const lowerNode = r.childForFieldName('lower')
    const upperNode = r.childForFieldName('upper')
    const lo = lowerNode ? Number(evalIntLiteral(lowerNode.text, false)) : 0
    const hi = upperNode ? Number(evalIntLiteral(upperNode.text, false)) : -1
    dims.push([lo, hi])
    total *= Math.max(0, hi - lo + 1)
  }
  const elemNode = typeNode.childForFieldName('element_type')
  const elemType = elemNode ? elemTypeOf(elemNode) : IecType.INT
  const data: IecValue[] = []
  for (let i = 0; i < total; i++) {
    data.push(
      elemNode
        ? buildDefault(elemNode, undefined, resolver)
        : { kind: 'scalar', type: IecType.INT, value: 0 },
    )
  }
  return { kind: 'array', elemType, dims, data }
}

function inlineEnumDefault(typeNode: Node, typeName: string): IecValue {
  let value = 0
  let next = 0
  let first = true
  for (const e of typeNode.namedChildren) {
    if (e.type !== 'enumerator') continue
    const valNode = e.childForFieldName('value')
    const v =
      valNode !== null ? Number(evalIntLiteral(valNode.text, false)) : next
    if (first) {
      value = v
      first = false
    }
    next = v + 1
  }
  return { kind: 'enum', typeName, value }
}

function inlineStructDefault(
  typeNode: Node,
  typeName: string,
  resolver: TypeResolver,
): IecValue {
  const fields = new Map<string, IecValue>()
  for (const f of typeNode.namedChildren) {
    if (f.type !== 'structure_field') continue
    const nameNode = f.childForFieldName('name')
    const fieldTypeNode = f.childForFieldName('type')
    if (nameNode === null || fieldTypeNode === null) continue
    const init = f.childForFieldName('default') ?? undefined
    fields.set(nameNode.text, buildDefault(fieldTypeNode, init, resolver))
  }
  return { kind: 'struct', typeName, fields }
}

function namedDefault(
  name: string,
  initNode: Node | undefined,
  resolver: TypeResolver,
): IecValue {
  const resolved = resolver.resolveType(name)
  if (resolved === undefined) {
    // Unknown named type (e.g. an FB instance): opaque empty struct.
    return { kind: 'struct', typeName: name, fields: new Map() }
  }
  if (resolved.kind === 'struct') {
    const fields = new Map<string, IecValue>()
    for (const f of resolved.fields) {
      fields.set(
        f.name,
        buildDefault(
          f.typeNode,
          f.initNode ?? findInitializer(f.typeNode),
          resolver,
        ),
      )
    }
    return { kind: 'struct', typeName: resolved.typeName, fields }
  }
  if (resolved.kind === 'enum') {
    const value = enumDefaultValue(resolved, initNode)
    return { kind: 'enum', typeName: resolved.typeName, value }
  }
  // alias: recurse on the aliased type. The variable's own initializer (if any)
  // wins over the alias's declared default.
  return buildDefault(resolved.typeNode, initNode ?? resolved.initNode, resolver)
}

function enumDefaultValue(
  resolved: EnumTypeInfo,
  initNode: Node | undefined,
): number {
  if (initNode !== undefined) {
    if (
      initNode.type === 'identifier' ||
      initNode.type === 'qualified_identifier'
    ) {
      const memberName = initNode.text.split('.').pop() ?? initNode.text
      const member = resolved.members.find((m) => m.name === memberName)
      if (member !== undefined) return member.value
    } else if (initNode.type === 'integer_literal') {
      return Number(evalIntLiteral(initNode.text, false))
    }
  }
  return resolved.members.length > 0 ? resolved.members[0].value : 0
}

// ---------------------------------------------------------------------------
// Clone & equality.
// ---------------------------------------------------------------------------

/** Deep clone: arrays, structs, and field Maps are all independent copies. */
export function cloneValue(v: IecValue): IecValue {
  switch (v.kind) {
    case 'scalar':
      return { kind: 'scalar', type: v.type, value: v.value }
    case 'array':
      return {
        kind: 'array',
        elemType: v.elemType,
        dims: v.dims.map((d) => [d[0], d[1]] as [number, number]),
        data: v.data.map(cloneValue),
      }
    case 'struct': {
      const fields = new Map<string, IecValue>()
      for (const [k, fv] of v.fields) fields.set(k, cloneValue(fv))
      return { kind: 'struct', typeName: v.typeName, fields }
    }
    case 'enum':
      return { kind: 'enum', typeName: v.typeName, value: v.value }
  }
}

/** Deep equality. REAL/LREAL compared by exact bits via Object.is. */
export function valueEquals(a: IecValue, b: IecValue): boolean {
  if (a.kind !== b.kind) return false
  switch (a.kind) {
    case 'scalar': {
      const o = b as Extract<IecValue, { kind: 'scalar' }>
      return a.type === o.type && Object.is(a.value, o.value)
    }
    case 'array': {
      const o = b as Extract<IecValue, { kind: 'array' }>
      if (a.elemType !== o.elemType) return false
      if (a.dims.length !== o.dims.length) return false
      for (let i = 0; i < a.dims.length; i++) {
        if (a.dims[i][0] !== o.dims[i][0] || a.dims[i][1] !== o.dims[i][1]) {
          return false
        }
      }
      if (a.data.length !== o.data.length) return false
      for (let i = 0; i < a.data.length; i++) {
        if (!valueEquals(a.data[i], o.data[i])) return false
      }
      return true
    }
    case 'struct': {
      const o = b as Extract<IecValue, { kind: 'struct' }>
      if (a.typeName !== o.typeName) return false
      if (a.fields.size !== o.fields.size) return false
      for (const [k, av] of a.fields) {
        const bv = o.fields.get(k)
        if (bv === undefined || !valueEquals(av, bv)) return false
      }
      return true
    }
    case 'enum': {
      const o = b as Extract<IecValue, { kind: 'enum' }>
      return a.typeName === o.typeName && a.value === o.value
    }
  }
}
