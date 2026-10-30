/**
 * Runtime value model shared by core and plugins (types only; the implementations — `defaultValue`, `cloneValue`, `valueEquals` — live in `@plc-st/core`).
 *
 * `TypeResolver` is declared here so the core symbol table can implement it without a circular import, and so dialect plugins can reason about resolved types without depending on core.
 */

import type { Node } from 'web-tree-sitter'

/** Elementary IEC 61131-3 types modelled by the interpreter. Core exposes a same-named runtime constant (`IecType.BOOL`, …) whose values are exactly these strings. */
export type IecType =
  | 'BOOL'
  | 'BYTE'
  | 'WORD'
  | 'DWORD'
  | 'LWORD'
  | 'SINT'
  | 'USINT'
  | 'INT'
  | 'UINT'
  | 'DINT'
  | 'UDINT'
  | 'LINT'
  | 'ULINT'
  | 'REAL'
  | 'LREAL'
  | 'TIME'
  | 'STRING'
  | 'WSTRING'

/** A runtime value: scalar, array, struct, or enum. Types up to 32 bits are JS `number`; LINT/ULINT/LWORD and TIME (nanoseconds; the date/time family folds onto it) are `bigint`. `maxLength` is the declared capacity of a `STRING(n)`/`WSTRING(n)` variable; assignments truncate to it. */
export type IecValue =
  | { kind: 'scalar'; type: IecType; value: number | bigint | boolean | string; maxLength?: number }
  | {
      kind: 'array'
      elemType: IecType | string
      dims: [number, number][]
      data: IecValue[]
    }
  | { kind: 'struct'; typeName: string; fields: Map<string, IecValue> }
  | { kind: 'enum'; typeName: string; value: number }

export interface StructTypeInfo {
  kind: 'struct'
  typeName: string
  fields: { name: string; typeNode: Node; initNode?: Node }[]
}

export interface EnumTypeInfo {
  kind: 'enum'
  typeName: string
  members: { name: string; value: number }[]
  /** The type-level default (`TYPE E : (A, B) := B; END_TYPE`); variables of the type start there instead of at the first enumerator. */
  initNode?: Node
}

export interface AliasTypeInfo {
  kind: 'alias'
  typeName: string
  typeNode: Node
  initNode?: Node
}

export type ResolvedType = StructTypeInfo | EnumTypeInfo | AliasTypeInfo

/** Resolves a named (user-defined) type; implemented by the core cross-file symbol table. */
export interface TypeResolver {
  resolveType(name: string): ResolvedType | undefined
}
