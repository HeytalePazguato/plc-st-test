/**
 * Cross-file symbol table for IEC 61131-3 Structured Text.
 *
 * `buildSymbolTable` collects POUs (functions, function blocks, programs, interfaces), their VAR blocks and methods, and TYPE declarations (enums, structs, aliases) across every parsed file, then resolves named references (including FB-typed instances and enum members) across file boundaries.
 *
 * The table implements `TypeResolver` from the value model so the interpreter can build default values for user-defined types without a circular import.
 *
 * `buildSymbolTableFromProject` builds the same table from a `Project`: every unit is parsed separately, ACTION units are attached to their owning POU, and each tree is remembered together with its unit's `SourceMap` so `locate(node)` and every diagnostic report positions in the original vendor files.
 */

import type { Language, Node, Tree } from 'web-tree-sitter'
import { SourceMap, type OriginalLocation, type Project, type SourceUnit } from '@plc-st/project-model'
import { parseSource, type ParsedFile } from '../parser/parse.js'
import { parseStatementFragment, wrapStatementFragment, STATEMENT_FRAGMENT_LINE_OFFSET } from '../parser/fragment.js'
import { IecError } from '../errors.js'
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

/** An ACTION attached to a POU (from a project unit with role 'action'). */
export interface Action {
  name: string
  /** The action's body statements, in order. */
  bodyNodes: Node[]
  /** Id of the source unit the action came from. */
  unitId: string
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
  /** Path of the (original) file this POU was declared in. */
  file: string
  /** Id of the source unit this POU was declared in (the file path for `buildSymbolTable`). */
  unitId: string
  /** Whether the POU was declared in a test unit. */
  isTest: boolean
  /** Actions owned by this POU. */
  actions: Action[]
}

export interface BuildOptions {
  caseSensitive?: boolean
}

export interface ProjectBuildOptions {
  caseSensitive: boolean
  /** Text transform applied to every unit before parsing (e.g. conditional compilation); must keep the line count so source maps stay valid. */
  preprocess?: (text: string) => string
}

/** A diagnostic located in an original source file. */
export interface SymbolDiagnostic {
  location: OriginalLocation
  message: string
}

/** Where a parsed tree came from, so its nodes can be mapped back to original files. */
interface TreeOrigin {
  unitId: string
  map: SourceMap
  /** Synthetic lines preceding the unit text in the tree (the wrapper of an action fragment). */
  lineOffset: number
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
  readonly diagnostics: SymbolDiagnostic[] = []

  private readonly caseSensitive: boolean
  // Keyed by Tree: web-tree-sitter creates a fresh Node wrapper per access, but every node keeps a reference to its (stable) Tree.
  private readonly origins = new Map<Tree, TreeOrigin>()
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

  /** Public case-folding so collaborators (e.g. the scope chain in task 2.1) resolve identifiers with the SAME case-mode as this table. */
  normalizeKey(name: string): string {
    return this.key(name)
  }

  /** Whether identifiers are treated case-sensitively (e.g. the B&R dialect). */
  get isCaseSensitive(): boolean {
    return this.caseSensitive
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

  /** Original-file location of `node`'s start, via the source map of the unit it was parsed from. Throws for nodes from trees this table did not build. */
  locate(node: Node): OriginalLocation {
    const origin = this.origins.get(node.tree)
    if (origin === undefined) {
      throw new IecError(`cannot locate node '${node.type}': it does not belong to this symbol table`)
    }
    return origin.map.map(node.startPosition.row + 1 - origin.lineOffset, node.startPosition.column + 1)
  }

  // --- Build (internal) ---------------------------------------------------

  /** @internal Remember which unit (and map) `tree` was parsed from. */
  registerTree(tree: Tree, origin: TreeOrigin): void {
    this.origins.set(tree, origin)
  }

  /** @internal */
  addDiagnostic(location: OriginalLocation, message: string): void {
    this.diagnostics.push({ location, message })
  }

  /** @internal Register a POU, reporting a diagnostic on duplicate keys. */
  addPou(pou: Pou): void {
    const k = this.key(pou.name)
    const existing = this.pous.get(k)
    if (existing !== undefined) {
      const location = pou.bodyNode !== undefined ? this.locate(pou.bodyNode) : { file: pou.file, line: 1, col: 1 }
      this.addDiagnostic(location, `Duplicate POU '${pou.name}' (already declared in ${existing.file})`)
      return
    }
    this.pous.set(k, pou)
  }

  /** @internal Attach an action to `pou`, reporting a diagnostic on a duplicate action name. */
  addAction(pou: Pou, action: Action, location: OriginalLocation): void {
    const k = this.key(action.name)
    if (pou.actions.some((a) => this.key(a.name) === k)) {
      this.addDiagnostic(location, `Duplicate action '${action.name}' on POU '${pou.name}'`)
      return
    }
    pou.actions.push(action)
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

/** A parsed declaration unit (POUs / TYPEs / globals) awaiting collection. */
interface DeclarationUnit {
  root: Node
  unitId: string
  isTest: boolean
}

function lineCount(text: string): number {
  let n = 1
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) n++
  return n
}

/** Build a cross-file symbol table from already-parsed files; each file is treated as an identity-mapped, non-test unit whose id is its path. */
export function buildSymbolTable(
  files: ParsedFile[],
  opts?: BuildOptions,
): SymbolTable {
  const table = new SymbolTable(opts)
  const units: DeclarationUnit[] = []
  for (const file of files) {
    const map = SourceMap.identity(file.filePath, lineCount(file.source))
    table.registerTree(file.tree, { unitId: file.filePath, map, lineOffset: 0 })
    for (const d of file.diagnostics) table.addDiagnostic(map.map(d.line, d.col), d.message)
    units.push({ root: file.tree.rootNode, unitId: file.filePath, isTest: false })
  }
  collectUnits(units, table)
  return table
}

/** Build a symbol table from every unit of `project`, attaching ACTION units to their owning POUs; all locations are mapped back through each unit's `SourceMap`. */
export function buildSymbolTableFromProject(
  project: Project,
  language: Language,
  opts: ProjectBuildOptions,
): SymbolTable {
  const table = new SymbolTable({ caseSensitive: opts.caseSensitive })
  const units: DeclarationUnit[] = []
  const actions: { unit: SourceUnit; text: string }[] = []

  for (const unit of project.units) {
    const text = preprocessUnit(unit, opts.preprocess)
    if (unit.role === 'action') {
      // Attached after every POU is collected, so an owner declared in a later unit is still found.
      actions.push({ unit, text })
      continue
    }
    const parsed = parseSource(language, text, unit.id)
    table.registerTree(parsed.tree, { unitId: unit.id, map: unit.map, lineOffset: 0 })
    for (const d of parsed.diagnostics) table.addDiagnostic(unit.map.map(d.line, d.col), d.message)
    units.push({ root: parsed.tree.rootNode, unitId: unit.id, isTest: unit.isTest })
  }

  collectUnits(units, table)
  for (const { unit, text } of actions) attachAction(unit, text, language, table)
  return table
}

function preprocessUnit(unit: SourceUnit, preprocess: ((text: string) => string) | undefined): string {
  if (preprocess === undefined) return unit.text
  const out = preprocess(unit.text)
  const before = lineCount(unit.text)
  const after = lineCount(out)
  if (after !== before) {
    throw new IecError(`preprocess changed line count of unit '${unit.id}' (${String(before)} -> ${String(after)})`)
  }
  return out
}

function attachAction(unit: SourceUnit, text: string, language: Language, table: SymbolTable): void {
  const unitStart = unit.map.map(1, 1)
  const ownerName = unit.owner ?? ''
  const owner = table.getPou(ownerName)
  if (owner === undefined) {
    table.addDiagnostic(unitStart, `action owner '${ownerName}' not found`)
    return
  }

  let bodyNodes: Node[]
  try {
    bodyNodes = parseStatementFragment(language, text)
  } catch (err) {
    if (!(err instanceof IecError)) throw err
    // Re-parse the identical wrapped source to report every syntax error at its mapped position (the thrown error only carries the first one, as text).
    const wrapped = parseSource(language, wrapStatementFragment(text), unit.id)
    const lastLine = lineCount(text)
    for (const d of wrapped.diagnostics) {
      const line = Math.min(Math.max(d.line - STATEMENT_FRAGMENT_LINE_OFFSET, 1), lastLine)
      table.addDiagnostic(unit.map.map(line, d.col), d.message)
    }
    if (wrapped.diagnostics.length === 0) table.addDiagnostic(unitStart, err.message)
    return
  }

  const first = bodyNodes[0]
  if (first !== undefined) {
    table.registerTree(first.tree, { unitId: unit.id, map: unit.map, lineOffset: STATEMENT_FRAGMENT_LINE_OFFSET })
  }
  table.addAction(owner, { name: unit.name ?? '<anonymous>', bodyNodes, unitId: unit.id }, unitStart)
}

/** Collect declarations from every unit, then resolve FB-typed variables across all of them. */
function collectUnits(units: DeclarationUnit[], table: SymbolTable): void {
  const instanceVars: VarEntry[] = []

  for (const unit of units) {
    collectDeclarations(unit.root, unit, table, instanceVars)
  }

  // Second pass: an FB-typed local is one whose named type is a known FB.
  for (const v of instanceVars) {
    const typeName = v.typeNode.text
    if (table.isFunctionBlock(typeName)) {
      v.instanceOf = typeName
    }
  }
}

/** Recurse into namespaces; collect POUs and TYPE declarations elsewhere. */
function collectDeclarations(
  node: Node,
  unit: DeclarationUnit,
  table: SymbolTable,
  instanceVars: VarEntry[],
): void {
  for (const child of node.namedChildren) {
    if (child.type === 'namespace_declaration') {
      collectDeclarations(child, unit, table, instanceVars)
      continue
    }
    if (child.type === 'type_declaration') {
      collectTypeDeclaration(child, table)
      continue
    }
    const kind = pouKind(child.type)
    if (kind !== undefined) {
      table.addPou(collectPou(child, kind, unit, table, instanceVars))
    }
  }
}

function collectPou(
  node: Node,
  kind: PouKind,
  unit: DeclarationUnit,
  table: SymbolTable,
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
    file: table.locate(node).file,
    unitId: unit.unitId,
    isTest: unit.isTest,
    actions: [],
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
