/**
 * Library auto-stubbing: function block types and functions that the project only references (a vendor library the dialect does not provide) get a stand-in so the code under test still runs.
 *
 * Non-strict, every unresolved symbol is registered on the session with its signature inferred from the usage sites and reported once as `LIBRARY_AUTOSTUBBED`. Strict (`strict_libraries`), nothing is registered and one `IecError` lists every unresolved symbol. An auto-stubbed instance is an ordinary stub instance, so `MOCK`, `MOCK_RETURNS` and the `EXPECT_*` assertions address it by path like any other.
 */
import type { FbStubDef, HostFnDef, IecValue, VarSpec } from '@plc-st/plugin-api'
import type { LibraryRef } from '@plc-st/project-model'
import type { Node } from 'web-tree-sitter'
import { caseKey } from '../case.js'
import { IecError } from '../errors.js'
import { IecType, isBigIntType } from '../interpreter/numeric.js'
import { elementaryType } from '../interpreter/values.js'
import type { Session } from '../session.js'
import type { Method, Pou, SymbolTable, UnresolvedType, VarEntry } from '../symbols/table.js'

export interface AutoStubOptions {
  /** Fail with one `IecError` listing every unresolved symbol instead of stubbing them. */
  strict: boolean
  /** The project's referenced libraries, used to name the library an unresolved symbol most likely comes from. */
  libraries?: readonly LibraryRef[]
  /** Library names the dialect provides itself; a symbol qualified with one of them is never stubbed. */
  builtinLibraries?: readonly string[]
}

/** Where a symbol was first used, and what its usage says about its signature. */
interface FbUsage {
  name: string
  library: string | undefined
  where: Node
  inputs: Map<string, string>
  outputs: Map<string, string>
}

interface FnUsage {
  name: string
  where: Node
  /** Result type from the first use in an expression; undefined while the function was only ever called as a statement. */
  result: string | undefined
}

/** The type used when the context says nothing: wide enough to hold any number. */
const DEFAULT_TYPE = 'LREAL'

/** The ST type name of `text` when it can declare a stub variable (an elementary type or a STRING), else undefined. */
function specType(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  const t = text.trim()
  return elementaryType(t) !== undefined || /^W?STRING\s*(?:[([]\s*\d+\s*[)\]])?$/i.test(t) ? t : undefined
}

/** The declared variables visible in `pou`: its own and those of its methods (a clash between a method local and a POU variable is vanishingly rare, so one flat map is enough). */
function declaredVars(pou: Pou, caseSensitive: boolean): Map<string, VarEntry> {
  const vars = new Map<string, VarEntry>()
  for (const blocks of [pou.varBlocks, ...pou.methods.map((m: Method) => m.varBlocks)]) {
    for (const block of blocks) for (const v of block.vars) vars.set(caseKey(v.name, caseSensitive), v)
  }
  return vars
}

/** The body nodes to scan for one POU: its declaration (body and methods) and its actions. */
function bodiesOf(pou: Pou): Node[] {
  return [...(pou.bodyNode !== undefined ? [pou.bodyNode] : []), ...pou.actions.flatMap((a) => a.bodyNodes)]
}

function descendants(root: Node, ...types: string[]): Node[] {
  return root.descendantsOfType(types)
}

/** The type of expression `node` as far as it can be told without evaluating it. */
function exprType(node: Node, vars: Map<string, VarEntry>, caseSensitive: boolean): string | undefined {
  switch (node.type) {
    case 'boolean_literal':
      return 'BOOL'
    case 'integer_literal':
      return 'DINT'
    case 'real_literal':
      return 'LREAL'
    case 'string_literal':
      return 'STRING'
    case 'time_literal':
      return 'TIME'
    case 'typed_literal':
      return specType(node.childForFieldName('type')?.text)
    case 'identifier':
      return specType(vars.get(caseKey(node.text, caseSensitive))?.typeNode.text)
    case 'parenthesized_expression':
      return node.namedChildren[0] === undefined ? undefined : exprType(node.namedChildren[0], vars, caseSensitive)
    case 'unary_expression':
      return node.childForFieldName('operator')?.text === 'NOT' ? 'BOOL' : undefined
    case 'binary_expression':
      return ['=', '<>', '<', '<=', '>', '>=', 'AND', 'OR', 'XOR'].includes(node.childForFieldName('operator')?.text ?? '') ? 'BOOL' : undefined
    default:
      return undefined
  }
}

/** The type the context of `node` (the place it is read) expects of it: a condition is BOOL, an assignment takes its target's type, a comparison its other operand's. */
function contextType(node: Node, vars: Map<string, VarEntry>, caseSensitive: boolean): string | undefined {
  const parent = node.parent
  if (parent === null) return undefined
  switch (parent.type) {
    case 'assignment_statement':
      return parent.childForFieldName('right')?.id === node.id ? exprType(parent.childForFieldName('left') ?? node, vars, caseSensitive) : undefined
    case 'if_statement':
    case 'while_statement':
    case 'repeat_statement':
      return parent.childForFieldName('condition')?.id === node.id ? 'BOOL' : undefined
    case 'unary_expression':
      return parent.childForFieldName('operator')?.text === 'NOT' ? 'BOOL' : undefined
    case 'binary_expression': {
      const op = parent.childForFieldName('operator')?.text ?? ''
      if (['AND', 'OR', 'XOR'].includes(op)) return 'BOOL'
      const other = parent.childForFieldName('left')?.id === node.id ? parent.childForFieldName('right') : parent.childForFieldName('left')
      return other === null ? undefined : exprType(other, vars, caseSensitive)
    }
    case 'parenthesized_expression':
      return contextType(parent, vars, caseSensitive)
    default:
      return undefined
  }
}

/** The library an unresolved symbol most likely belongs to, or undefined when the project does not say. */
function libraryOf(qualifier: string | undefined, libraries: readonly LibraryRef[]): string | undefined {
  if (qualifier !== undefined) return qualifier
  const candidates = libraries.filter((l) => l.kind === 'compiled' || l.kind === 'system').map((l) => l.name)
  if (candidates.length === 0) return undefined
  return candidates.length === 1 ? candidates[0] : `one of ${candidates.join(', ')}`
}

const lastSegment = (name: string): string => name.slice(name.lastIndexOf('.') + 1)

/** Collect and merge (by unqualified name, as the interpreter resolves it) the FB types to stub, with the signature their instances' usage implies. */
function collectFbs(table: SymbolTable, session: Session, opts: AutoStubOptions): FbUsage[] {
  const caseSensitive = table.isCaseSensitive
  const builtin = new Set((opts.builtinLibraries ?? []).map((n) => caseKey(n, caseSensitive)))
  const byName = new Map<string, FbUsage>()
  const types: UnresolvedType[] = table.unresolvedTypes()
  for (const type of types) {
    const short = lastSegment(type.name)
    const qualifier = type.name.includes('.') ? type.name.slice(0, type.name.lastIndexOf('.')) : undefined
    if (qualifier !== undefined && builtin.has(caseKey(qualifier, caseSensitive))) continue
    if (session.fbStubs.get(short) !== undefined) continue
    const key = caseKey(short, caseSensitive)
    let usage = byName.get(key)
    if (usage === undefined) {
      usage = { name: short, library: libraryOf(qualifier, opts.libraries ?? []), where: type.uses[0].entry.typeNode, inputs: new Map(), outputs: new Map() }
      byName.set(key, usage)
    }
    const owners = new Map<Pou, Set<string>>()
    for (const use of type.uses) {
      const names = owners.get(use.pou) ?? new Set<string>()
      names.add(caseKey(use.entry.name, caseSensitive))
      owners.set(use.pou, names)
    }
    for (const [pou, names] of owners) inferSignature(usage, pou, names, caseSensitive)
  }
  return [...byName.values()]
}

/** Read the inputs and outputs of the instances `names` of `pou` off the way the POU calls and reads them. */
function inferSignature(usage: FbUsage, pou: Pou, names: Set<string>, caseSensitive: boolean): void {
  const vars = declaredVars(pou, caseSensitive)
  const isInstance = (n: Node | null): boolean => n !== null && n.type === 'identifier' && names.has(caseKey(n.text, caseSensitive))
  const addInput = (name: string, type: string | undefined): void => {
    if (![...usage.inputs.keys()].some((k) => caseKey(k, caseSensitive) === caseKey(name, caseSensitive))) usage.inputs.set(name, type ?? DEFAULT_TYPE)
  }
  const addOutput = (name: string, type: string | undefined): void => {
    if (![...usage.outputs.keys()].some((k) => caseKey(k, caseSensitive) === caseKey(name, caseSensitive))) usage.outputs.set(name, type ?? DEFAULT_TYPE)
  }

  for (const body of bodiesOf(pou)) {
    for (const call of descendants(body, 'call_expression')) {
      if (!isInstance(call.childForFieldName('function'))) continue
      for (const arg of call.childForFieldName('arguments')?.namedChildren ?? []) {
        if (arg.type !== 'named_argument') continue
        const name = arg.childForFieldName('name')?.text
        const value = arg.childForFieldName('value')
        if (name === undefined || value === null) continue
        if (arg.children.some((c) => c.type === '=>')) addOutput(name, exprType(value, vars, caseSensitive))
        else addInput(name, exprType(value, vars, caseSensitive))
      }
    }
    for (const access of descendants(body, 'member_access_expression')) {
      const member = access.childForFieldName('member')?.text
      if (member === undefined || !isInstance(access.childForFieldName('object'))) continue
      const parent = access.parent
      // `fb.Method(...)` is a method call, not a read of an output.
      if (parent?.type === 'call_expression' && parent.childForFieldName('function')?.id === access.id) continue
      if (parent?.type === 'assignment_statement' && parent.childForFieldName('left')?.id === access.id) {
        const right = parent.childForFieldName('right')
        addInput(member, right === null ? undefined : exprType(right, vars, caseSensitive))
      } else {
        addOutput(member, contextType(access, vars, caseSensitive))
      }
    }
  }
}

/** Functions called by name that nothing defines: not a POU, method, action or variable, and not registered on the session. */
function collectFns(table: SymbolTable, session: Session): FnUsage[] {
  const caseSensitive = table.isCaseSensitive
  const pous = table.getPous()
  const known = new Set<string>()
  for (const pou of pous) {
    known.add(caseKey(pou.name, caseSensitive))
    for (const m of pou.methods) known.add(caseKey(m.name, caseSensitive))
    for (const a of pou.actions) known.add(caseKey(a.name, caseSensitive))
    for (const blocks of [pou.varBlocks, ...pou.methods.map((m: Method) => m.varBlocks)]) {
      for (const block of blocks) for (const v of block.vars) known.add(caseKey(v.name, caseSensitive))
    }
  }
  const found = new Map<string, FnUsage>()
  for (const pou of pous) {
    const vars = declaredVars(pou, caseSensitive)
    for (const body of bodiesOf(pou)) {
      for (const call of descendants(body, 'call_expression')) {
        const callee = call.childForFieldName('function')
        if (callee === null || callee.type !== 'identifier') continue
        const key = caseKey(callee.text, caseSensitive)
        if (known.has(key) || session.hostFns.get(callee.text) !== undefined || session.fbStubs.get(callee.text) !== undefined) continue
        const asStatement = call.parent?.type === 'invocation_statement'
        const result = asStatement ? undefined : (contextType(call, vars, caseSensitive) ?? DEFAULT_TYPE)
        const existing = found.get(key)
        if (existing === undefined) found.set(key, { name: callee.text, where: callee, result })
        else existing.result ??= result
      }
    }
  }
  return [...found.values()]
}

function specs(types: Map<string, string>): VarSpec[] {
  return [...types].map(([name, type]) => ({ name, type }))
}

/** The default value of the elementary or STRING type `type`. */
function defaultOf(type: string): IecValue {
  const str = /^(W?STRING)/i.exec(type)
  if (str !== null) return { kind: 'scalar', type: str[1].toUpperCase() === 'WSTRING' ? IecType.WSTRING : IecType.STRING, value: '' }
  const et = elementaryType(type) ?? IecType.LREAL
  return { kind: 'scalar', type: et, value: et === IecType.BOOL ? false : isBigIntType(et) || et === IecType.TIME ? 0n : 0 }
}

function stubDef(usage: FbUsage): FbStubDef {
  const inputs = specs(usage.inputs)
  // A name that is both written and read is an input; its value stays whatever the caller put in.
  const outputs = specs(usage.outputs).filter((o) => !usage.inputs.has(o.name))
  return { name: usage.name, inputs, outputs, call() {} }
}

function fnDef(usage: FnUsage): HostFnDef {
  const result = usage.result === undefined ? undefined : defaultOf(usage.result)
  return { name: usage.name, minArgs: 0, maxArgs: Number.MAX_SAFE_INTEGER, call: () => (result === undefined ? undefined : structuredClone(result)) }
}

/**
 * Stub every function block type and function the project references but nothing defines. Call it after the session's host functions and FB stubs (stdlib, dialect, simulators) are registered, since those count as defined.
 *
 * Non-strict: registers a stub per symbol and emits one `LIBRARY_AUTOSTUBBED` warning each. Strict: throws one `IecError` listing every unresolved symbol and registers nothing.
 */
export function applyAutoStubs(table: SymbolTable, session: Session, opts: AutoStubOptions): void {
  const fbs = collectFbs(table, session, opts)
  const fns = collectFns(table, session)
  const describe = (kind: string, name: string, library: string | undefined, where: Node): string => {
    const at = table.locate(where)
    return `${kind} '${name}'${library === undefined ? '' : ` (library ${library})`} at ${at.file}:${String(at.line)}`
  }

  if (opts.strict) {
    const lines = [
      ...fbs.map((u) => describe('function block', u.name, u.library, u.where)),
      ...fns.map((u) => describe('function', u.name, libraryOf(undefined, opts.libraries ?? []), u.where)),
    ]
    if (lines.length > 0) {
      throw new IecError(`strict_libraries: ${String(lines.length)} unresolved ${lines.length === 1 ? 'symbol' : 'symbols'}, not defined by the project or provided by the dialect: ${lines.join('; ')}`)
    }
    return
  }

  for (const usage of fbs) {
    session.fbStubs.register(stubDef(usage), 'autostub')
    session.warn('LIBRARY_AUTOSTUBBED', `function block '${usage.name}' is not defined${usage.library === undefined ? '' : ` (library ${usage.library})`}; auto-stubbed with ${String(usage.inputs.size)} input(s) and ${String(usage.outputs.size)} output(s) inferred from its usage`, table.locate(usage.where))
  }
  for (const usage of fns) {
    session.hostFns.register(fnDef(usage), 'autostub')
    const library = libraryOf(undefined, opts.libraries ?? [])
    session.warn('LIBRARY_AUTOSTUBBED', `function '${usage.name}' is not defined${library === undefined ? '' : ` (library ${library})`}; auto-stubbed to return ${usage.result === undefined ? 'nothing' : `the default ${usage.result}`}`, table.locate(usage.where))
  }
}
