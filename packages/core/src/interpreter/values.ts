/**
 * Runtime value model for the IEC 61131-3 interpreter.
 *
 * A value is one of four shapes: a scalar (elementary type), an array, a struct, or an enum. `defaultValue` walks a grammar type-specifier node and produces the IEC initial value for it (honouring a declared initializer when the surrounding declaration carries one). The value and resolver types (`IecValue`, `TypeResolver`, …) are declared in `@plc-st/plugin-api` so plugins share them; they are re-exported here so existing core imports keep working.
 */

import type { Node } from 'web-tree-sitter'
import type { EnumTypeInfo, IecValue, TypeResolver } from '@plc-st/plugin-api'
import { IecLimitError, IecRuntimeError } from '../errors.js'
import type { Limits } from '../limits.js'
import { IecType, isBigIntType, isIntType, froundReal, wrapInt } from './numeric.js'

export type {
  AliasTypeInfo,
  EnumTypeInfo,
  IecValue,
  ResolvedType,
  StructTypeInfo,
  TypeResolver,
} from '@plc-st/plugin-api'

// ---------------------------------------------------------------------------
// Elementary type name -> IecType.
// ---------------------------------------------------------------------------

/**
 * Map every `elementary_type` keyword the grammar can emit onto an `IecType`. The date/time family folds onto TIME and CHAR/WCHAR onto STRING/WSTRING since those distinct elementary types are not modelled separately yet.
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
  // Not elementary_type keywords (the grammar gives them a string_type node) but valid typed-literal prefixes.
  STRING: IecType.STRING,
  WSTRING: IecType.WSTRING,
}

/** The `IecType` an elementary type keyword (e.g. `INT`, `tod`) folds onto, or `undefined` when `name` is not an elementary keyword. */
export function elementaryType(name: string): IecType | undefined {
  return Object.hasOwn(ELEMENTARY, name.toUpperCase()) ? ELEMENTARY[name.toUpperCase()] : undefined
}

function elementaryToIecType(name: string): IecType {
  const t = elementaryType(name)
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
      {
        const n = evalIntLiteral(initNode.text, isBigIntType(type) || type === IecType.TIME)
        return isIntType(type) ? wrapInt(n, type) : n
      }
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
  if (isBigIntType(type) || type === IecType.TIME) return 0n
  return 0
}

// ---------------------------------------------------------------------------
// Default-value construction.
// ---------------------------------------------------------------------------

/**
 * Find an initializer expression attached to the declaration that owns `typeNode`. The grammar names it `initial_value` on a variable_declaration and `default` on a structure_field / type_definition; in all cases it is a sibling field of the type specifier, not a child of it.
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
 * Produce the IEC initial value for the type that `typeNode` describes. If the owning declaration carries an initializer it is honoured, otherwise the IEC default for the type is used. Named types are looked up through `resolver`.
 */
export function defaultValue(typeNode: Node, resolver: TypeResolver, meter?: AllocationMeter): IecValue {
  return buildDefault(typeNode, findInitializer(typeNode), resolver, meter)
}

/** Allocation accounting target; a `Session` satisfies it. Without a meter nothing is counted or limited. */
export interface AllocationMeter {
  allocation: number
  readonly limits: Pick<Limits, 'maxAllocatedElements' | 'maxStringLength'>
}

function limitExceeded(meter: AllocationMeter, wanted: number): IecLimitError {
  return new IecLimitError(`allocation limit exceeded: ${String(wanted)} scalar slots requested, ${String(meter.limits.maxAllocatedElements - meter.allocation)} remaining of max_allocated_elements=${String(meter.limits.maxAllocatedElements)}`)
}

/** Count `n` scalar slots against the meter, throwing before they are allocated when the limit would be exceeded. */
export function chargeAllocation(meter: AllocationMeter | undefined, n: number): void {
  if (meter === undefined) return
  if (meter.allocation + n > meter.limits.maxAllocatedElements) throw limitExceeded(meter, n)
  meter.allocation += n
}

function buildDefault(
  typeNode: Node,
  initNode: Node | undefined,
  resolver: TypeResolver,
  meter?: AllocationMeter,
): IecValue {
  switch (typeNode.type) {
    case 'elementary_type': {
      chargeAllocation(meter, 1)
      const type = elementaryToIecType(typeNode.text)
      return { kind: 'scalar', type, value: scalarValue(type, initNode) }
    }
    case 'subrange_type': {
      chargeAllocation(meter, 1)
      // e.g. INT(0..100): the value carries the base elementary type.
      const base = typeNode.namedChildren.find(
        (c) => c.type === 'elementary_type',
      )
      const type = base ? elementaryToIecType(base.text) : IecType.INT
      return { kind: 'scalar', type, value: scalarValue(type, initNode) }
    }
    case 'string_type':
      return stringDefault(typeNode, initNode, meter)
    case 'array_type':
      return arrayDefault(typeNode, initNode, resolver, meter)
    case 'enumerated_type_inline':
      chargeAllocation(meter, 1)
      return inlineEnumDefault(typeNode, '')
    case 'structure_type_inline':
      return inlineStructDefault(typeNode, '', resolver, meter)
    case 'identifier':
    case 'qualified_identifier':
      return namedDefault(typeNode.text, initNode, resolver, meter)
    default:
      // Unknown specifier (pointer/reference/generic): use an opaque struct.
      chargeAllocation(meter, 1)
      return { kind: 'struct', typeName: typeNode.text, fields: new Map() }
  }
}

function stringDefault(typeNode: Node, initNode: Node | undefined, meter?: AllocationMeter): IecValue {
  const type = typeNode.text.toUpperCase().startsWith('WSTRING')
    ? IecType.WSTRING
    : IecType.STRING
  const lengthNode = typeNode.childForFieldName('length')
  const maxLen =
    lengthNode !== null
      ? Number(evalIntLiteral(lengthNode.text, false))
      : undefined
  if (meter !== undefined && maxLen !== undefined && maxLen > meter.limits.maxStringLength) {
    throw new IecLimitError(`string length ${String(maxLen)} exceeds max_string_length=${String(meter.limits.maxStringLength)} (${typeNode.text})`)
  }
  chargeAllocation(meter, 1)
  let value = ''
  if (initNode !== undefined && initNode.type === 'string_literal') {
    value = stringLiteralText(initNode.text)
  }
  if (maxLen === undefined) return { kind: 'scalar', type, value }
  return { kind: 'scalar', type, value: value.slice(0, maxLen), maxLength: maxLen }
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

/**
 * The element initializer nodes of an array initializer, with `N(v1, v2)` repetitions expanded. The base grammar emits an array initializer as a run of sibling `initial_value`/`default` children starting with a `[` token (the bracket is hidden inside `_array_initializer`), so `initNode` is that `[` and the elements are the named siblings up to the closing `]`. Returns `undefined` when `initNode` is not an array initializer. The expanded length is computed before any node list is materialised so a huge repetition count cannot exhaust memory.
 */
function arrayInitElements(initNode: Node | undefined, name: string, capacity: number): Node[] | undefined {
  if (initNode === undefined || initNode.type !== '[') return undefined
  const groups: { nodes: Node[]; count: number }[] = []
  let length = 0
  for (let n = initNode.nextSibling; n !== null && n.type !== ']'; n = n.nextSibling) {
    if (!n.isNamed) continue
    let group: { nodes: Node[]; count: number }
    if (n.type === 'array_repetition') {
      const countNode = n.childForFieldName('count')
      const count = countNode === null ? 1 : Number(evalIntLiteral(countNode.text, false))
      if (!Number.isInteger(count) || count < 0) throw new IecRuntimeError(`invalid repetition count '${countNode?.text ?? ''}' in initializer of ${name}`)
      group = { nodes: n.namedChildren.filter((c) => countNode === null || c.id !== countNode.id), count }
    } else {
      group = { nodes: [n], count: 1 }
    }
    length += group.nodes.length * group.count
    if (length > capacity) throw new IecRuntimeError(`too many initializer elements for ${name}: array holds ${String(capacity)} but at least ${String(length)} were given`)
    groups.push(group)
  }
  const out: Node[] = []
  for (const g of groups) for (let i = 0; i < g.count; i++) out.push(...g.nodes)
  return out
}

/** The declared name of the variable/field/type that owns `typeNode`, for error messages. */
function ownerName(typeNode: Node): string {
  const parent = typeNode.parent
  const nameNode = parent?.childForFieldName('names') ?? parent?.childForFieldName('name')
  return nameNode?.text ?? typeNode.text
}

function arrayDefault(typeNode: Node, initNode: Node | undefined, resolver: TypeResolver, meter?: AllocationMeter): IecValue {
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
  // Validated against the element count before anything is allocated; initializers are laid out row-major, matching `data`.
  const inits = arrayInitElements(initNode, ownerName(typeNode), total) ?? []
  if (total === 0) return { kind: 'array', elemType, dims, data }
  const build = (i: number): IecValue => (elemNode ? buildDefault(elemNode, inits[i], resolver) : { kind: 'scalar', type: IecType.INT, value: 0 })
  if (meter === undefined) {
    for (let i = 0; i < total; i++) data.push(build(i))
    return { kind: 'array', elemType, dims, data }
  }
  // Build one element first (it charges its own slots), then check the remaining elements against the limit BEFORE building them, so a huge array is rejected without being allocated. The rest are built unmetered because their slots are charged here in bulk.
  const before = meter.allocation
  data.push(elemNode ? buildDefault(elemNode, inits[0], resolver, meter) : build(0))
  const perElement = Math.max(1, meter.allocation - before)
  const rest = (total - 1) * perElement
  if (meter.allocation + rest > meter.limits.maxAllocatedElements) throw limitExceeded(meter, total * perElement)
  meter.allocation += rest
  for (let i = 1; i < total; i++) data.push(build(i))
  return { kind: 'array', elemType, dims, data }
}

/** Field name -> value node of a `structure_initializer` (`(a := 1, b := 2)`); empty when `initNode` is not one. */
function structInitFields(initNode: Node | undefined): Map<string, Node> {
  const out = new Map<string, Node>()
  if (initNode === undefined || initNode.type !== 'structure_initializer') return out
  for (const f of initNode.namedChildren) {
    if (f.type !== 'structure_initializer_field') continue
    const name = f.childForFieldName('name')
    const value = f.childForFieldName('value')
    if (name !== null && value !== null) out.set(name.text.toUpperCase(), value)
  }
  return out
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
  meter?: AllocationMeter,
): IecValue {
  chargeAllocation(meter, 1)
  const fields = new Map<string, IecValue>()
  for (const f of typeNode.namedChildren) {
    if (f.type !== 'structure_field') continue
    const nameNode = f.childForFieldName('name')
    const fieldTypeNode = f.childForFieldName('type')
    if (nameNode === null || fieldTypeNode === null) continue
    const init = f.childForFieldName('default') ?? undefined
    fields.set(nameNode.text, buildDefault(fieldTypeNode, init, resolver, meter))
  }
  return { kind: 'struct', typeName, fields }
}

function namedDefault(
  name: string,
  initNode: Node | undefined,
  resolver: TypeResolver,
  meter?: AllocationMeter,
): IecValue {
  const resolved = resolver.resolveType(name)
  if (resolved === undefined) {
    chargeAllocation(meter, 1)
    // Unknown named type (e.g. an FB instance): opaque empty struct.
    return { kind: 'struct', typeName: name, fields: new Map() }
  }
  if (resolved.kind === 'struct') {
    chargeAllocation(meter, 1)
    const fields = new Map<string, IecValue>()
    const overrides = structInitFields(initNode)
    for (const f of resolved.fields) {
      fields.set(
        f.name,
        buildDefault(
          f.typeNode,
          overrides.get(f.name.toUpperCase()) ?? f.initNode ?? findInitializer(f.typeNode),
          resolver,
          meter,
        ),
      )
    }
    return { kind: 'struct', typeName: resolved.typeName, fields }
  }
  if (resolved.kind === 'enum') {
    chargeAllocation(meter, 1)
    const value = enumDefaultValue(resolved, initNode)
    return { kind: 'enum', typeName: resolved.typeName, value }
  }
  // alias: recurse on the aliased type. The variable's own initializer (if any) wins over the alias's declared default.
  return buildDefault(resolved.typeNode, initNode ?? resolved.initNode, resolver, meter)
}

function enumDefaultValue(
  resolved: EnumTypeInfo,
  initNode: Node | undefined,
): number {
  if (initNode !== undefined) {
    if (
      initNode.type === 'identifier' ||
      initNode.type === 'qualified_identifier' ||
      initNode.type === 'member_access_expression'
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
      return v.maxLength === undefined ? { kind: 'scalar', type: v.type, value: v.value } : { kind: 'scalar', type: v.type, value: v.value, maxLength: v.maxLength }
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
