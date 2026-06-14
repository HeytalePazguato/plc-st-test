/**
 * Cross-file symbol table for IEC 61131-3 Structured Text.
 *
 * `buildSymbolTable` collects POUs (functions, function blocks, programs,
 * interfaces), their VAR blocks and methods, and TYPE declarations (enums,
 * structs, aliases) across every parsed file, then resolves named references
 * (including FB-typed instances and enum members) across file boundaries.
 *
 * The table implements `TypeResolver` from the value model so the interpreter
 * can build default values for user-defined types without a circular import.
 */

import type { Node } from 'web-tree-sitter'
import type { ParsedFile, Diagnostic } from '../parser/parse.js'
import type {
  TypeResolver,
  ResolvedType,
  EnumTypeInfo,
  StructTypeInfo,
  AliasTypeInfo,
} from '../interpreter/values.js'

/** Kind of a single variable, mapped from its declaring VAR block. */
export type VarKind = 'input' | 'output' | 'inout' | 'local' | 'temp'

/** One declared variable. `instanceOf` is set for FB-typed locals. */
export interface VarEntry {
  name: string
  kind: VarKind
  typeNode: Node
  initNode?: Node
  /** Name of the FUNCTION_BLOCK this variable is an instance of, if any. */
  instanceOf?: string
}

/** A VAR_* block and the variables it declares. */
export interface VarBlock {
  kind: VarKind
  vars: VarEntry[]
}

/** A method (FB/program member, or interface method signature). */
export interface Method {
  name: string
  varBlocks: VarBlock[]
  /** The method_declaration/signature node; body statements are its `body` field. */
  bodyNode?: Node
  returnTypeNode?: Node
}

/** Kind of program organization unit. */
export type PouKind = 'function' | 'functionBlock' | 'program' | 'interface'

/** A program organization unit collected from the source. */
export interface Pou {
  name: string
  kind: PouKind
  methods: Method[]
  varBlocks: VarBlock[]
  extendsName?: string
  implementsNames: string[]
  /** The declaration node; body statements are accessible via its `body` field. */
  bodyNode?: Node
  /** Path of the file this POU was declared in. */
  file: string
}

export interface BuildOptions {
  caseSensitive?: boolean
}

// ---------------------------------------------------------------------------
// Node-kind helpers.
// ---------------------------------------------------------------------------

function varBlockKind(type: string): VarKind | undefined {
  switch (type) {
    case 'var_input':
      return 'input'
    case 'var_output':
      return 'output'
    case 'var_in_out':
      return 'inout'
    case 'var_block':
      return 'local'
    case 'var_temp':
      return 'temp'
    default:
      return undefined
  }
}

function pouKind(type: string): PouKind | undefined {
  switch (type) {
    case 'function_declaration':
      return 'function'
    case 'function_block_declaration':
      return 'functionBlock'
    case 'program_declaration':
      return 'program'
    case 'interface_declaration':
      return 'interface'
    default:
      return undefined
  }
}

/** Evaluate an integer literal node (base prefixes, underscores, sign). */
function evalInt(node: Node): number {
  let s = node.text.trim().replace(/_/g, '')
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
  const v = parseInt(s, base)
  return neg ? -v : v
}

// ---------------------------------------------------------------------------
// Symbol table.
// ---------------------------------------------------------------------------

export class SymbolTable implements TypeResolver {
  readonly diagnostics: Diagnostic[] = []

  private readonly caseSensitive: boolean
  private readonly pous = new Map<string, Pou>()
  private readonly enums = new Map<string, EnumTypeInfo>()
  private readonly structs = new Map<string, StructTypeInfo>()
  private readonly aliases = new Map<string, AliasTypeInfo>()

  constructor(opts?: BuildOptions) {
    this.caseSensitive = opts?.caseSensitive ?? false
  }

  /** The single point of case folding for every map insert and lookup. */
  private key(name: string): string {
    return this.caseSensitive ? name : name.toLowerCase()
  }

  // --- TypeResolver -------------------------------------------------------

  resolveType(name: string): ResolvedType | undefined {
    const k = this.key(name)
    return this.enums.get(k) ?? this.structs.get(k) ?? this.aliases.get(k)
  }

  // --- Public lookups -----------------------------------------------------

  getPou(name: string): Pou | undefined {
    return this.pous.get(this.key(name))
  }

  getEnum(name: string): EnumTypeInfo | undefined {
    return this.enums.get(this.key(name))
  }

  /** All collected POUs (insertion order). */
  getPous(): Pou[] {
    return [...this.pous.values()]
  }

  // --- Build (internal) ---------------------------------------------------

  /** @internal Register a POU, reporting a diagnostic on duplicate keys. */
  addPou(pou: Pou): void {
    const k = this.key(pou.name)
    const existing = this.pous.get(k)
    if (existing !== undefined) {
      this.diagnostics.push({
        file: pou.file,
        line: 1,
        col: 1,
        message: `Duplicate POU '${pou.name}' (already declared in ${existing.file})`,
      })
      return
    }
    this.pous.set(k, pou)
  }

  /** @internal */
  addEnum(info: EnumTypeInfo): void {
    this.enums.set(this.key(info.typeName), info)
  }

  /** @internal */
  addStruct(info: StructTypeInfo): void {
    this.structs.set(this.key(info.typeName), info)
  }

  /** @internal */
  addAlias(info: AliasTypeInfo): void {
    this.aliases.set(this.key(info.typeName), info)
  }

  /** @internal True if `name` names a collected FUNCTION_BLOCK. */
  isFunctionBlock(name: string): boolean {
    const pou = this.pous.get(this.key(name))
    return pou !== undefined && pou.kind === 'functionBlock'
  }
}

// ---------------------------------------------------------------------------
// Collection.
// ---------------------------------------------------------------------------

/** Build a cross-file symbol table from already-parsed files. */
export function buildSymbolTable(
  files: ParsedFile[],
  opts?: BuildOptions,
): SymbolTable {
  const table = new SymbolTable(opts)
  const instanceVars: VarEntry[] = []

  for (const file of files) {
    collectDeclarations(file.tree.rootNode, file.filePath, table, instanceVars)
  }

  // Second pass: an FB-typed local is one whose named type is a known FB.
  for (const v of instanceVars) {
    const typeName = v.typeNode.text
    if (table.isFunctionBlock(typeName)) {
      v.instanceOf = typeName
    }
  }

  return table
}

/** Recurse into namespaces; collect POUs and TYPE declarations elsewhere. */
function collectDeclarations(
  node: Node,
  file: string,
  table: SymbolTable,
  instanceVars: VarEntry[],
): void {
  for (const child of node.namedChildren) {
    if (child.type === 'namespace_declaration') {
      collectDeclarations(child, file, table, instanceVars)
      continue
    }
    if (child.type === 'type_declaration') {
      collectTypeDeclaration(child, table)
      continue
    }
    const kind = pouKind(child.type)
    if (kind !== undefined) {
      table.addPou(collectPou(child, kind, file, instanceVars))
    }
  }
}

function collectPou(
  node: Node,
  kind: PouKind,
  file: string,
  instanceVars: VarEntry[],
): Pou {
  const nameNode = node.childForFieldName('name')
  const name = nameNode !== null ? nameNode.text : '<anonymous>'

  const extendsNode = node.childForFieldName('extends')
  const extendsName = extendsNode !== null ? extendsNode.text : undefined

  const implementsNames = node
    .childrenForFieldName('implements')
    .filter((c) => c.type === 'identifier' || c.type === 'qualified_identifier')
    .map((c) => c.text)

  const varBlocks = collectVarBlocks(node, instanceVars)
  const methods = collectMethods(node, instanceVars)

  return {
    name,
    kind,
    methods,
    varBlocks,
    extendsName,
    implementsNames,
    bodyNode: node,
    file,
  }
}

function collectMethods(node: Node, instanceVars: VarEntry[]): Method[] {
  const methods: Method[] = []
  for (const child of node.namedChildren) {
    if (
      child.type !== 'method_declaration' &&
      child.type !== 'method_signature'
    ) {
      continue
    }
    const nameNode = child.childForFieldName('name')
    const returnTypeNode = child.childForFieldName('return_type')
    methods.push({
      name: nameNode !== null ? nameNode.text : '<anonymous>',
      varBlocks: collectVarBlocks(child, instanceVars),
      bodyNode: child,
      returnTypeNode: returnTypeNode ?? undefined,
    })
  }
  return methods
}

function collectVarBlocks(node: Node, instanceVars: VarEntry[]): VarBlock[] {
  const blocks: VarBlock[] = []
  for (const child of node.namedChildren) {
    const kind = varBlockKind(child.type)
    if (kind === undefined) continue
    const vars: VarEntry[] = []
    for (const decl of child.namedChildren) {
      if (decl.type !== 'variable_declaration') continue
      const typeNode = decl.childForFieldName('type')
      if (typeNode === null) continue
      const initNode = decl.childForFieldName('initial_value') ?? undefined
      const names = decl
        .childrenForFieldName('names')
        .filter((c) => c.type === 'identifier')
      for (const nameNode of names) {
        const entry: VarEntry = {
          name: nameNode.text,
          kind,
          typeNode,
          initNode,
        }
        vars.push(entry)
        if (
          typeNode.type === 'identifier' ||
          typeNode.type === 'qualified_identifier'
        ) {
          // Candidate FB instance; resolved in the second pass.
          instanceVars.push(entry)
        }
      }
    }
    blocks.push({ kind, vars })
  }
  return blocks
}

function collectTypeDeclaration(node: Node, table: SymbolTable): void {
  for (const def of node.namedChildren) {
    if (def.type !== 'type_definition') continue
    const nameNode = def.childForFieldName('name')
    const defn = def.childForFieldName('definition')
    if (nameNode === null || defn === null) continue
    const typeName = nameNode.text

    if (defn.type === 'enumerated_type_inline') {
      table.addEnum({ kind: 'enum', typeName, members: collectEnum(defn) })
    } else if (defn.type === 'structure_type_inline') {
      table.addStruct({
        kind: 'struct',
        typeName,
        fields: collectStructFields(defn),
      })
    } else {
      const initNode = def.childForFieldName('default') ?? undefined
      table.addAlias({ kind: 'alias', typeName, typeNode: defn, initNode })
    }
  }
}

function collectEnum(node: Node): { name: string; value: number }[] {
  const members: { name: string; value: number }[] = []
  let next = 0
  for (const e of node.namedChildren) {
    if (e.type !== 'enumerator') continue
    const nameNode = e.childForFieldName('name')
    if (nameNode === null) continue
    const valueNode = e.childForFieldName('value')
    const value = valueNode !== null ? evalInt(valueNode) : next
    members.push({ name: nameNode.text, value })
    next = value + 1
  }
  return members
}

function collectStructFields(
  node: Node,
): { name: string; typeNode: Node; initNode?: Node }[] {
  const fields: { name: string; typeNode: Node; initNode?: Node }[] = []
  for (const f of node.namedChildren) {
    if (f.type !== 'structure_field') continue
    const nameNode = f.childForFieldName('name')
    const typeNode = f.childForFieldName('type')
    if (nameNode === null || typeNode === null) continue
    const initNode = f.childForFieldName('default') ?? undefined
    fields.push({ name: nameNode.text, typeNode, initNode })
  }
  return fields
}
