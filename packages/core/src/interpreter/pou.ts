/**
 * POU dispatch: host functions, user FUNCTIONs, FUNCTION_BLOCK / PROGRAM instances, METHODs, ACTIONs and host-implemented FB stubs, plus instance lifecycle (dialect `onInstantiate` / `onDispose` hooks).
 *
 * Instance representation: an FB (or program) instance is an `FbInstance` whose `value` is an ordinary struct `IecValue`. Its `fields` map is the single storage of the instance's VAR_INPUT, VAR_OUTPUT and VAR members (nested FB members hold the nested instance's own `value`), so `fb.Q`, `fb.inner.x` and assignments to `fb.IN` go through the expression evaluator's normal struct-member path. The instance `scope` declares those same members as live views over the map (plus VAR_TEMP slots, reset on every body invocation, and VAR_IN_OUT forwarding slots re-bound to the caller's variable on each call), so the body sees them by name. The struct value carries a hidden, non-enumerable back-reference to its `FbInstance` (`fbInstanceOf`), which is how a call such as `fb()` / `fb.M()` / `fbs[i]()` finds the instance from the value the evaluator resolves; copies made by `cloneValue` are plain structs without it.
 *
 * Resolution order of `callPou(callee, …)`: (1) a session host function, (2) a user FUNCTION, (3) an FB/program instance named by the callee (user or stub FB), (4) a METHOD `inst.M()` (also `THIS^.M()`, `SUPER^.M()` and a bare `M()` inside the owner), (5) an ACTION `inst.A()` or a bare `A()` inside the owner. `SUPER^()` runs the base's body on the running instance. Methods, actions and properties dispatch virtually from the instance's own POU (see `oop/inherit.ts`), and an interface-typed receiver forwards to its target (see `oop/interface.ts`). A host function that shadows a user POU wins and records one `HOSTFN_SHADOWS_POU` warning per name on the session.
 *
 * Properties are not fields: `fb.P` resolves through `EvalContext.propertyOf` and a bare `P` inside the instance through a scope of property slots built per activation, behind the instance's variables, so accessors count against the activation's depth. GET runs as a method whose result variable is the property, SET as a method whose input is.
 *
 * Arguments bind by name or positionally over the VAR_INPUT / VAR_IN_OUT parameters in declaration order (inherited parameters first); a named argument for a VAR_OUTPUT is an output binding (`Q => target`) copied back after the call. VAR_IN_OUT needs a variable argument. Every POU activation counts against `limits.maxRecursionDepth`.
 */

import type { Node } from 'web-tree-sitter'
import type { CallArg, DialectHooks, FbIo, FbInstanceRef, FbStubDef, HostCallContext, HostFnDef, Slot, VarSpec } from '@plc-st/plugin-api'
import type { OriginalLocation } from '@plc-st/project-model'
import type { ClockView, EvalContext } from './context.js'
import { Scope, ScopeChainImpl } from './scope.js'
import { evalExpression, fail, isSuper, isThis } from './expressions.js'
import { execBody, storeValue } from './statements.js'
import { chargeAllocation, cloneValue, defaultValue, elementaryType, type ConstEvaluator, type IecValue } from './values.js'
import { IecType, isBigIntType } from './numeric.js'
import type { Action, Method, Pou, Property, SymbolTable, VarEntry } from '../symbols/table.js'
import type { Session } from '../session.js'
import type { Limits } from '../limits.js'
import { IecError, IecLimitError, IecRuntimeError } from '../errors.js'
import { caseKey } from '../case.js'
import { findAction, findMethod, findProperty, lineage, type Owned } from '../oop/inherit.js'
import { boundInstance, fbInstanceOf, isInterfaceValue, linkInstance } from '../oop/interface.js'
import { PropertySlot } from '../oop/property.js'

export { fbInstanceOf }

type StructValue = Extract<IecValue, { kind: 'struct' }>

/** Warning code recorded when a host function hides a user POU of the same name. */
export const HOSTFN_SHADOWS_POU = 'HOSTFN_SHADOWS_POU'

// ---------------------------------------------------------------------------
// Frames and instances.
// ---------------------------------------------------------------------------

/** A formal parameter of a POU activation, in declaration order. */
export interface Param {
  name: string
  kind: 'input' | 'output' | 'inout'
  slot: Slot
}

/** A VAR_TEMP slot and its declared type, re-initialised on every body invocation. */
export interface Temp {
  slot: Slot
  typeNode: Node
}

/** The variables of one POU activation or instance. */
export interface Frame {
  scope: Scope
  params: Param[]
  temps: Temp[]
  /** FB instances created for FB-typed members, in declaration order. */
  children: FbInstance[]
}

/** VAR_IN_OUT parameter: forwards to the caller's slot bound by the most recent call. */
class InOutSlot implements Slot {
  target?: Slot

  constructor(private readonly name: string) {}

  get value(): IecValue {
    if (this.target === undefined) throw new IecRuntimeError(`VAR_IN_OUT '${this.name}' is not bound to a variable`)
    return this.target.value
  }

  set value(v: IecValue) {
    if (this.target === undefined) throw new IecRuntimeError(`VAR_IN_OUT '${this.name}' is not bound to a variable`)
    this.target.value = v
  }
}

/** A live FUNCTION_BLOCK or PROGRAM instance (user-defined, or host-implemented when `stub` is set). */
export class FbInstance implements FbInstanceRef {
  readonly scope: Scope
  readonly children: readonly FbInstance[]
  /** @internal */
  readonly params: readonly Param[]
  /** @internal */
  readonly temps: readonly Temp[]
  /** @internal Set once `onDispose` has run. */
  disposed = false
  private readonly nested: FbInstance[]

  constructor(
    readonly pou: Pou,
    frame: Frame,
    /** The instance's struct value; its fields are the instance's inputs, outputs and VARs. */
    readonly value: StructValue,
    protected readonly ctx: EvalContext,
    readonly stub?: { def: FbStubDef; state: unknown },
  ) {
    this.scope = frame.scope
    this.children = frame.children
    this.nested = frame.children
    this.params = frame.params
    this.temps = frame.temps
    linkInstance(value, this)
  }

  /** @internal When defined (on a mock), replaces the body of every call on this instance: `member` is the METHOD or ACTION called, or `undefined` for a call of the instance itself. Arguments are bound first and output bindings copied back afterwards, as for a real call. */
  intercept?(member: string | undefined, args: Record<string, IecValue>): void

  /** @internal Swap the nested instance stored in field `member` for `replacement`. The scope needs no update: its slots are live views over the field map. */
  replaceMember(member: string, replacement: FbInstance): void {
    const index = this.nested.findIndex((c) => c.value === this.value.fields.get(member))
    if (index >= 0) this.nested[index] = replacement
    this.value.fields.set(member, replacement.value)
  }

  get typeName(): string {
    return this.pou.name
  }

  hasMethod(name: string): boolean {
    return findMethod(lineage(this.pou, this.ctx.symbols), name, this.ctx.symbols) !== undefined
  }

  callMethod(name: string, args: CallArg[]): IecValue | undefined {
    const found = findMethod(lineage(this.pou, this.ctx.symbols), name, this.ctx.symbols)
    if (found === undefined) throw new IecRuntimeError(`function block '${this.typeName}' has no method '${name}'`)
    return invokeMethod(this, found, args, this.ctx)
  }
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

export interface EvalContextOptions {
  symbols: SymbolTable
  session: Session
  limits?: Limits
  hooks?: DialectHooks
  globals?: Scope[]
  clock?: ClockView
}

/** A root evaluation context wired to `callPou`; its chain is the global scopes. Limits default to the session's. */
export function createEvalContext(opts: EvalContextOptions): EvalContext {
  const globals = opts.globals ?? []
  return {
    symbols: opts.symbols,
    session: opts.session,
    limits: opts.limits ?? opts.session.limits,
    callPou,
    propertyOf,
    chain: new ScopeChainImpl(globals),
    hooks: opts.hooks,
    globals,
    clock: opts.clock,
  }
}

/** Create an instance of the FUNCTION_BLOCK / PROGRAM `typeName` (a user POU, else a session FB stub). FB-typed members (and arrays of them) become nested instances; `onInstantiate` runs for every instance, nested ones first. */
export function instantiateFb(typeName: string, ctx: EvalContext): FbInstance {
  return instantiate(typeName, ctx, (ctx.depth ?? 0) + 1)
}

/** Run `onDispose` for `inst` and its nested instances, depth-first (children before their parent); each instance is disposed at most once. */
export function disposeFb(inst: FbInstance, ctx: EvalContext): void {
  if (inst.disposed) return
  for (const child of inst.children) disposeFb(child, ctx)
  inst.disposed = true
  ctx.hooks?.onDispose?.(inst, hostContext(ctx, inst.pou.bodyNode))
}

/** Call `callee` with already-evaluated `args`; `undefined` for a call without a result. `node` is the call's function expression when the call comes from source. */
export function callPou(callee: string, args: CallArg[], ctx: EvalContext, node?: Node): IecValue | undefined {
  const host = ctx.session.hostFns.get(callee)
  if (host !== undefined) return callHost(host, callee, args, ctx, node)

  const pou = ctx.symbols.getPou(callee)
  if (pou?.kind === 'function') return callFunction(pou, args, ctx, node)

  const target = resolveTarget(callee, ctx, node)
  switch (target?.kind) {
    case 'instance':
      return callInstance(target.inst, args, ctx, node)
    case 'method':
      return invokeMethod(target.inst, target.method, args, ctx, node)
    case 'action':
      return invokeAction(target.inst, target.action, args, ctx, node)
    case 'base':
      return callInstance(target.inst, args, ctx, node, target.pou)
    default:
      throw error(ctx, node, `'${callee}' is not a function, function block instance, method or action`)
  }
}

/** Invoke an instance's body (or its stub's `call`, or its mock interception) with `args`: bind inputs/in-outs, reset VAR_TEMP, run, copy output bindings back. Used for `fb(...)` and by the cycle engine for program instances. `body` is the POU whose body to run: a base of `inst.pou` for `SUPER^()`, which resets only that base's VAR_TEMPs, as the caller's are still in use. */
export function callInstance(inst: FbInstance, args: CallArg[], ctx: EvalContext, node?: Node, body: Pou = inst.pou): undefined {
  const depth = enter(ctx, node, inst.typeName)
  const locNode = node ?? inst.pou.bodyNode
  const outputs = bindArgs(inst.params, args, ctx, node, locNode, inst.typeName)
  if (inst.intercept !== undefined) {
    inst.intercept(undefined, recordedArgs(inst.params))
  } else if (inst.stub !== undefined) {
    inst.stub.def.call(inst.stub.state, fbIo(inst, ctx, locNode), hostContext(ctx, node))
  } else {
    const inner = instanceContext(inst, ctx, depth, undefined, body)
    const own = new Set(instanceVars(body, ctx).map((v) => v.typeNode))
    for (const t of inst.temps) if (own.has(t.typeNode)) t.slot.value = initialValue(t.typeNode, inner, depth, [])
    runBody(bodyStatements(body.bodyNode), inner, body.bodyNode)
  }
  copyOutputs(outputs, ctx, locNode)
  return undefined
}

/** The frame and struct value of a mock twin of `inst`: only its declared inputs, in-outs and outputs (inherited ones included), at their declared defaults. Initializers still see `inst`'s own constants through its scope. */
export function mockTwin(inst: FbInstance, ctx: EvalContext): { frame: Frame; value: StructValue } {
  const depth = (ctx.depth ?? 0) + 1
  const fields = new Map<string, IecValue>()
  const initCtx: EvalContext = { ...ctx, globals: [inst.scope, ...(ctx.globals ?? [])] }
  const frame =
    inst.stub !== undefined
      ? stubFrame(inst.stub.def, ctx, depth, fields)
      : buildFrame(
          instanceVars(inst.pou, ctx).filter((v) => v.kind === 'input' || v.kind === 'output' || v.kind === 'inout'),
          initCtx,
          depth,
          fields,
        )
  return { frame, value: { kind: 'struct', typeName: inst.typeName, fields } }
}

/** Reinitialise every VAR_TEMP slot of `inst` and of its nested instances to the declared default (the cycle engine calls this at the end of each cycle). */
export function resetInstanceTemps(inst: FbInstance, ctx: EvalContext): void {
  const depth = (ctx.depth ?? 0) + 1
  const inner = instanceContext(inst, ctx, depth)
  for (const t of inst.temps) t.slot.value = initialValue(t.typeNode, inner, depth, [])
  for (const child of inst.children) resetInstanceTemps(child, ctx)
}

// ---------------------------------------------------------------------------
// Errors, locations, host call context.
// ---------------------------------------------------------------------------

function error(ctx: EvalContext, node: Node | undefined, message: string): IecRuntimeError {
  return node === undefined ? new IecRuntimeError(message) : fail(node, ctx, message)
}

const UNKNOWN_LOCATION: OriginalLocation = { file: '<unknown>', line: 0, col: 0 }

function locationOf(node: Node | undefined, ctx: EvalContext): OriginalLocation {
  if (node === undefined) return UNKNOWN_LOCATION
  try {
    return ctx.symbols.locate(node)
  } catch (err) {
    if (!(err instanceof IecError)) throw err
    return UNKNOWN_LOCATION
  }
}

function hostContext(ctx: EvalContext, node: Node | undefined): HostCallContext {
  const location = locationOf(node, ctx)
  return {
    get cycle(): number {
      return ctx.clock?.cycle ?? 0
    },
    get nowNs(): bigint {
      return ctx.clock?.nowNs ?? 0n
    },
    location,
    resolvePath: (path) => resolvePath(path, ctx),
    warn: (code, message) => {
      ctx.session.warn(code, message, location)
    },
  }
}

/** Enter a POU activation: the callee's depth, or a located `IecLimitError` (the test errors with kind `limit`) when it exceeds `limits.maxRecursionDepth`. */
function enter(ctx: EvalContext, node: Node | undefined, what: string): number {
  const depth = (ctx.depth ?? 0) + 1
  const max = ctx.limits.maxRecursionDepth
  if (depth > max) throw new IecLimitError(error(ctx, node, `call depth exceeded the maximum of ${String(max)} (limits.maxRecursionDepth) calling '${what}'`).message)
  return depth
}

// ---------------------------------------------------------------------------
// Names and paths.
// ---------------------------------------------------------------------------

function sameKey(a: string, b: string, ctx: EvalContext): boolean {
  return caseKey(a, ctx.session.caseSensitive) === caseKey(b, ctx.session.caseSensitive)
}

function fieldKey(s: StructValue, name: string, ctx: EvalContext): string | undefined {
  if (s.fields.has(name)) return name
  for (const key of s.fields.keys()) if (sameKey(key, name, ctx)) return key
  return undefined
}

function isSelfText(head: string): boolean {
  return /^(THIS|SUPER)\^?$/i.test(head)
}

function isSuperText(head: string): boolean {
  return /^SUPER\^?$/i.test(head)
}

/** Value denoted by a dotted path (`fb`, `fb.inner`, `THIS^.inner`, `GVL.x`), or `undefined` when any segment is missing. */
function valueAtPath(parts: string[], ctx: EvalContext): IecValue | undefined {
  const [head, ...rest] = parts
  let v = isSelfText(head) ? ctx.self?.value : ctx.chain.lookup(head)?.value
  for (const part of rest) {
    if (v?.kind !== 'struct') return undefined
    const key = fieldKey(v, part, ctx)
    v = key === undefined ? undefined : v.fields.get(key)
  }
  return v
}

/** Value denoted by a callee expression node, or `undefined` when it does not name stored data. Array indices are evaluated (and bounds-checked). */
function valueAtNode(node: Node, ctx: EvalContext): IecValue | undefined {
  switch (node.type) {
    case 'identifier':
      return ctx.chain.lookup(node.text)?.value
    case 'parenthesized_expression': {
      const inner = node.namedChildren.find((c) => c.type !== 'comment')
      return inner === undefined ? undefined : valueAtNode(inner, ctx)
    }
    case 'member_access_expression': {
      const object = node.childForFieldName('object')
      const member = node.childForFieldName('member')
      if (object === null || member === null) return undefined
      return memberValue(valueAtNode(object, ctx), member.text, object, ctx)
    }
    case 'index_expression':
      return evalExpression(node, ctx)
    default:
      return isThis(node) || isSuper(node) ? ctx.self?.value : undefined
  }
}

/** Value of member `name` of `base` (the value of `object`): a field, else a property, whose GET runs. */
function memberValue(base: IecValue | undefined, name: string, object: Node, ctx: EvalContext): IecValue | undefined {
  if (base?.kind !== 'struct') return undefined
  const key = fieldKey(base, name, ctx)
  return key === undefined ? propertyOf(base, name, isSuper(object), ctx, object)?.value : base.fields.get(key)
}

/** `HostCallContext.resolvePath`: the slot of a dotted variable path; member slots are live views. */
function resolvePath(path: string, ctx: EvalContext): Slot | undefined {
  const parts = path.split('.').map((p) => p.trim())
  if (parts.length === 1) return ctx.chain.lookup(parts[0])
  const parent = valueAtPath(parts.slice(0, -1), ctx)
  if (parent?.kind !== 'struct') return undefined
  const key = fieldKey(parent, parts[parts.length - 1], ctx)
  return key === undefined ? undefined : fieldSlot(parent.fields, key)
}

type Target = { kind: 'instance'; inst: FbInstance } | { kind: 'method'; inst: FbInstance; method: Owned<Method> } | { kind: 'action'; inst: FbInstance; action: Owned<Action> } | { kind: 'base'; inst: FbInstance; pou: Pou }

/** Where member lookup on `receiver` starts: its own POU, or for `SUPER` the base of the POU declaring the running code. */
function dispatchChain(receiver: FbInstance, fromBase: boolean, ctx: EvalContext): Pou[] {
  return fromBase ? lineage(ctx.owner ?? receiver.pou, ctx.symbols).slice(1) : lineage(receiver.pou, ctx.symbols)
}

function resolveTarget(callee: string, ctx: EvalContext, node: Node | undefined): Target | undefined {
  if (ctx.self !== undefined && (node === undefined ? isSuperText(callee.trim()) : isSuper(node))) {
    const pou = dispatchChain(ctx.self, true, ctx).at(0)
    return pou === undefined ? undefined : { kind: 'base', inst: ctx.self, pou }
  }

  const parts = callee.split('.').map((p) => p.trim())
  // `<receiver>.<member>` names a nested instance, a method or an action; a bare name is an instance, or a method or action of the running instance.
  let receiver: FbInstance | undefined
  let member: string
  let fromBase = false
  if (node !== undefined && node.type === 'member_access_expression') {
    const object = node.childForFieldName('object')
    const memberNode = node.childForFieldName('member')
    if (object === null || memberNode === null) return undefined
    const base = valueAtNode(object, ctx)
    const whole = fbInstanceOf(memberValue(base, memberNode.text, object, ctx))
    if (whole !== undefined) return { kind: 'instance', inst: whole }
    receiver = boundInstance(base)
    member = memberNode.text
    fromBase = isSuper(object)
  } else {
    const whole = fbInstanceOf(node === undefined ? valueAtPath(parts, ctx) : valueAtNode(node, ctx))
    if (whole !== undefined) return { kind: 'instance', inst: whole }
    if (node === undefined && parts.length > 1) {
      member = parts[parts.length - 1]
      receiver = boundInstance(valueAtPath(parts.slice(0, -1), ctx))
      fromBase = parts.length === 2 && isSuperText(parts[0])
    } else if (node === undefined || node.type === 'identifier') {
      receiver = ctx.self
      member = callee
    } else {
      return undefined
    }
  }
  if (receiver === undefined) return undefined

  const chain = dispatchChain(receiver, fromBase, ctx)
  const method = findMethod(chain, member, ctx.symbols)
  if (method !== undefined) return { kind: 'method', inst: receiver, method }
  const action = findAction(chain, member, ctx.symbols)
  if (action !== undefined) return { kind: 'action', inst: receiver, action }
  return undefined
}

// ---------------------------------------------------------------------------
// Properties.
// ---------------------------------------------------------------------------

/** The slot of property `found` on `inst`. Accessors run from `ctx`, so they count against its depth; `node` locates their errors, else the declaration does. */
function propertySlot(inst: FbInstance, found: Owned<Property>, ctx: EvalContext, node: Node | undefined): PropertySlot {
  const { member: property, owner } = found
  const accessor = (method: Method | undefined, name: string): Owned<Method> => {
    if (method === undefined) throw error(ctx, node ?? property.bodyNode, `property '${inst.typeName}.${property.name}' has no ${name} accessor`)
    return { member: method, owner }
  }
  return new PropertySlot({
    read: () => invokeMethod(inst, accessor(property.get, 'GET'), [], ctx, node) as IecValue,
    write: (value) => {
      invokeMethod(inst, accessor(property.set, 'SET'), [{ value }], ctx, node)
    },
    declared: () => initialValue(property.typeNode, ctx, ctx.depth ?? 0, []),
  })
}

/** `EvalContext.propertyOf`. The instance behind `base` may be a mock, whose accessors record the access instead of running. */
function propertyOf(base: IecValue, name: string, fromBase: boolean, ctx: EvalContext, node: Node): Slot | undefined {
  const inst = boundInstance(base)
  if (inst === undefined) {
    if (isInterfaceValue(base, ctx.symbols)) throw error(ctx, node, `interface variable '${node.text}' is not assigned`)
    return undefined
  }
  const found = findProperty(dispatchChain(inst, fromBase, ctx), name, ctx.symbols)
  return found === undefined ? undefined : propertySlot(inst, found, ctx, node)
}

/** A scope declaring the properties in `chain` by bare name, most derived first. */
function propertyScope(inst: FbInstance, chain: Pou[], ctx: EvalContext): Scope {
  const scope = new Scope(ctx.session.caseSensitive)
  for (const owner of chain) {
    for (const member of owner.properties) {
      if (scope.get(member.name) === undefined) scope.declare(member.name, propertySlot(inst, { member, owner }, ctx, undefined), 'local')
    }
  }
  return scope
}

// ---------------------------------------------------------------------------
// Variables.
// ---------------------------------------------------------------------------

/** A slot that reads and writes `fields[name]`. Writing a struct into a member holding an FB instance copies its members into that instance, so the instance link survives `fbA := fbB`. */
function fieldSlot(fields: Map<string, IecValue>, name: string): Slot {
  return {
    get value(): IecValue {
      return fields.get(name) as IecValue
    },
    set value(v: IecValue) {
      const inst = fbInstanceOf(fields.get(name))
      if (inst !== undefined && v.kind === 'struct') assignMembers(inst.value, v)
      else fields.set(name, v)
    },
  }
}

function assignMembers(target: StructValue, source: StructValue): void {
  for (const [key, v] of source.fields) {
    const current = target.fields.get(key)
    if (current === undefined) continue
    const nested = fbInstanceOf(current)
    if (nested !== undefined && v.kind === 'struct') assignMembers(nested.value, v)
    else target.fields.set(key, cloneValue(v))
  }
}

/** FB type named by a type specifier (a user FUNCTION_BLOCK or a session stub), if any. */
function fbTypeOf(typeNode: Node, ctx: EvalContext): string | undefined {
  if (typeNode.type !== 'identifier' && typeNode.type !== 'qualified_identifier') return undefined
  return isFbType(typeNode.text, ctx) ? typeNode.text : undefined
}

function isFbType(name: string, ctx: EvalContext): boolean {
  return ctx.symbols.getPou(name)?.kind === 'functionBlock' || stubFor(name, ctx) !== undefined
}

/** A session FB stub by name; a namespace-qualified name (`Tc2_Standard.TON`) falls back to its last segment. */
function stubFor(name: string, ctx: EvalContext): FbStubDef | undefined {
  const direct = ctx.session.fbStubs.get(name)
  if (direct !== undefined || !name.includes('.')) return direct
  return ctx.session.fbStubs.get(name.slice(name.lastIndexOf('.') + 1))
}

/** Evaluates VAR initializers as constant expressions in `ctx` (its chain sees earlier VAR CONSTANTs and the globals); `defaultValue` rejects function calls before delegating here. */
function constEvaluator(ctx: EvalContext): ConstEvaluator {
  const initCtx: EvalContext = { ...ctx, self: undefined }
  return { evaluate: (node, enumHint) => evalExpression(node, initCtx, enumHint), error: (node, message) => fail(node, initCtx, message) }
}

/** Initial value of a variable of type `typeNode`: a new nested instance for FB types (and arrays of them), else the declared default with its initializer (`-5`, `T#5s`, `2 * 10`, a constant, an enum member, …) evaluated as a constant expression. `scope` is the frame being built, so initializers can name constants declared before them. */
function initialValue(typeNode: Node, ctx: EvalContext, depth: number, children: FbInstance[], scope?: Scope): IecValue {
  if (scope !== undefined) ctx = { ...ctx, chain: chainOf([scope], ctx) }
  const fbType = fbTypeOf(typeNode, ctx)
  if (fbType !== undefined) {
    const inst = instantiate(fbType, ctx, depth + 1)
    children.push(inst)
    return inst.value
  }
  const value = defaultValue(typeNode, ctx.symbols, constEvaluator(ctx), ctx.session)
  if (typeNode.type === 'array_type' && value.kind === 'array') {
    const elemNode = typeNode.childForFieldName('element_type')
    const elemFb = elemNode === null ? undefined : fbTypeOf(elemNode, ctx)
    if (elemFb !== undefined) {
      for (let i = 0; i < value.data.length; i++) {
        const inst = instantiate(elemFb, ctx, depth + 1)
        children.push(inst)
        value.data[i] = inst.value
      }
    }
    return value
  }
  return value
}

/** True when `v` is an FB instance or an array of them (such VAR_TEMPs are created once, not re-created per call). */
function holdsInstance(v: IecValue): boolean {
  return fbInstanceOf(v) !== undefined || (v.kind === 'array' && fbInstanceOf(v.data[0]) !== undefined)
}

/** Declare `vars` in a new scope. With `fields`, inputs/outputs/VARs are stored in that map (an instance) and the scope holds views; otherwise they are plain slots (a function or method activation). */
function buildFrame(vars: VarEntry[], ctx: EvalContext, depth: number, fields?: Map<string, IecValue>): Frame {
  const frame: Frame = { scope: new Scope(ctx.session.caseSensitive), params: [], temps: [], children: [] }
  for (const v of vars) {
    let slot: Slot
    if (v.kind === 'inout') {
      slot = new InOutSlot(v.name)
    } else {
      const value = initialValue(v.typeNode, ctx, depth, frame.children, frame.scope)
      if (v.kind === 'temp' || fields === undefined) {
        slot = { value }
      } else {
        fields.set(v.name, value)
        slot = fieldSlot(fields, v.name)
      }
      if (v.kind === 'temp' && !holdsInstance(value)) frame.temps.push({ slot, typeNode: v.typeNode })
    }
    frame.scope.declare(v.name, slot, v.kind)
    if (v.kind === 'input' || v.kind === 'output' || v.kind === 'inout') frame.params.push({ name: v.name, kind: v.kind, slot })
  }
  return frame
}

/** Every variable of `pou`, inherited ones (from the root base) first. */
function instanceVars(pou: Pou, ctx: EvalContext): VarEntry[] {
  return lineage(pou, ctx.symbols)
    .reverse()
    .flatMap((p) => p.varBlocks.flatMap((b) => b.vars))
}

/** Default value of a stub variable from its `VarSpec` type string (`BOOL`, `TIME`, `STRING(80)`, an enum, a nested FB type). */
function specValue(spec: VarSpec, ctx: EvalContext, depth: number, children: FbInstance[]): IecValue {
  if (spec.init !== undefined) return cloneValue(spec.init)
  chargeAllocation(ctx.session, 1)
  const t = spec.type.trim()
  const str = /^(W?STRING)\s*(?:[([]\s*(\d+)\s*[)\]])?$/i.exec(t)
  if (str !== null) {
    const type = str[1].toUpperCase() === 'WSTRING' ? IecType.WSTRING : IecType.STRING
    if (str[2] !== undefined && Number(str[2]) > ctx.limits.maxStringLength) throw new IecLimitError(`string length ${str[2]} exceeds max_string_length=${String(ctx.limits.maxStringLength)} (${t})`)
    return str[2] === undefined ? { kind: 'scalar', type, value: '' } : { kind: 'scalar', type, value: '', maxLength: Number(str[2]) }
  }
  const et = elementaryType(t)
  if (et !== undefined) {
    const value = et === IecType.BOOL ? false : isBigIntType(et) || et === IecType.TIME ? 0n : 0
    return { kind: 'scalar', type: et, value }
  }
  const en = ctx.symbols.getEnum(t)
  if (en !== undefined) return { kind: 'enum', typeName: en.typeName, value: en.members[0]?.value ?? 0 }
  if (isFbType(t, ctx)) {
    const inst = instantiate(t, ctx, depth + 1)
    children.push(inst)
    return inst.value
  }
  return { kind: 'struct', typeName: t, fields: new Map() }
}

function stubFrame(def: FbStubDef, ctx: EvalContext, depth: number, fields: Map<string, IecValue>): Frame {
  const frame: Frame = { scope: new Scope(ctx.session.caseSensitive), params: [], temps: [], children: [] }
  const groups: [VarSpec[], Param['kind']][] = [
    [def.inputs, 'input'],
    [def.inOuts ?? [], 'inout'],
    [def.outputs, 'output'],
  ]
  for (const [specs, kind] of groups) {
    for (const spec of specs) {
      let slot: Slot
      if (kind === 'inout') {
        slot = new InOutSlot(spec.name)
      } else {
        fields.set(spec.name, specValue(spec, ctx, depth, frame.children))
        slot = fieldSlot(fields, spec.name)
      }
      frame.scope.declare(spec.name, slot, kind)
      frame.params.push({ name: spec.name, kind, slot })
    }
  }
  return frame
}

/** The `Pou` record standing in for a host-implemented FB. */
function stubPou(def: FbStubDef): Pou {
  return { name: def.name, kind: 'functionBlock', methods: [], properties: [], varBlocks: [], implementsNames: [], baseInterfaces: [], isAbstract: false, file: '<host>', unitId: '<host>', isTest: false, actions: [] }
}

function instantiate(typeName: string, ctx: EvalContext, depth: number): FbInstance {
  const max = ctx.limits.maxRecursionDepth
  if (depth > max) throw new IecRuntimeError(`instantiating '${typeName}' exceeded the maximum nesting depth of ${String(max)} (limits.maxRecursionDepth)`)
  const fields = new Map<string, IecValue>()
  const pou = ctx.symbols.getPou(typeName)
  let inst: FbInstance
  if (pou !== undefined && (pou.kind === 'functionBlock' || pou.kind === 'program')) {
    const frame = buildFrame(instanceVars(pou, ctx), ctx, depth, fields)
    inst = new FbInstance(pou, frame, { kind: 'struct', typeName: pou.name, fields }, ctx)
  } else {
    const def = stubFor(typeName, ctx)
    if (def === undefined) throw new IecRuntimeError(`unknown function block type '${typeName}'`)
    const frame = stubFrame(def, ctx, depth, fields)
    inst = new FbInstance(stubPou(def), frame, { kind: 'struct', typeName: def.name, fields }, ctx, { def, state: def.createState?.() })
  }
  ctx.hooks?.onInstantiate?.(inst, hostContext(ctx, pou?.bodyNode))
  return inst
}

// ---------------------------------------------------------------------------
// Argument binding and body execution.
// ---------------------------------------------------------------------------

interface OutputBinding {
  from: Slot
  to: Slot
}

/** Store with the declared-type conversion of `storeValue` (located at `locNode`), or a plain copy when there is no node to locate errors with. */
export function store(slot: Slot, value: IecValue, ctx: EvalContext, locNode: Node | undefined): void {
  if (locNode === undefined) slot.value = cloneValue(value)
  else storeValue(slot, value, locNode, ctx)
}

function bindArgs(params: readonly Param[], args: CallArg[], ctx: EvalContext, node: Node | undefined, locNode: Node | undefined, owner: string): OutputBinding[] {
  const positional = params.filter((p) => p.kind !== 'output')
  const outputs: OutputBinding[] = []
  let next = 0
  for (const arg of args) {
    let param: Param | undefined
    if (arg.name === undefined) {
      param = positional[next]
      next += 1
      if (param === undefined) throw error(ctx, node, `too many arguments for '${owner}' (it takes ${String(positional.length)} input/in-out parameter(s))`)
    } else {
      const name = arg.name
      param = params.find((p) => sameKey(p.name, name, ctx))
      if (param === undefined) throw error(ctx, node, `'${owner}' has no input, output or in-out parameter '${name}'`)
    }
    switch (param.kind) {
      case 'input':
        store(param.slot, arg.value, ctx, locNode)
        break
      case 'inout':
        if (arg.slot === undefined) throw error(ctx, node, `VAR_IN_OUT '${param.name}' of '${owner}' needs a variable argument, not an expression`)
        ;(param.slot as InOutSlot).target = arg.slot
        break
      case 'output':
        if (arg.slot === undefined) throw error(ctx, node, `output '${param.name}' of '${owner}' must be bound to a variable (${param.name} => <variable>)`)
        outputs.push({ from: param.slot, to: arg.slot })
        break
    }
  }
  return outputs
}

function copyOutputs(outputs: OutputBinding[], ctx: EvalContext, locNode: Node | undefined): void {
  for (const { from, to } of outputs) store(to, from.value, ctx, locNode)
}

/** Copies of the current input and bound in-out values by declared name. Inputs keep their value between calls, so this is what the callee would see, not just what the call site passed. */
function recordedArgs(params: readonly Param[]): Record<string, IecValue> {
  const bound = params.filter((p) => p.kind === 'input' || (p.kind === 'inout' && (p.slot as InOutSlot).target !== undefined))
  return Object.fromEntries(bound.map((p) => [p.name, cloneValue(p.slot.value)]))
}

function bodyStatements(node: Node | undefined): Node[] {
  return node === undefined ? [] : node.childrenForFieldName('body').filter((c) => c.isNamed && c.type !== 'comment')
}

/** Run a POU body; RETURN is normal completion, EXIT/CONTINUE outside a loop is an error. */
function runBody(nodes: Node[], ctx: EvalContext, owner: Node | undefined): void {
  const signal = execBody(nodes, ctx)
  if (signal.type === 'exit' || signal.type === 'continue') throw error(ctx, owner, `${signal.type.toUpperCase()} outside a loop`)
}

function chainOf(scopes: Scope[], ctx: EvalContext): ScopeChainImpl {
  return new ScopeChainImpl([...scopes, ...(ctx.globals ?? [])])
}

/** The context running code of `owner` (a POU in `inst`'s chain) on `inst`, with `local` in front of the instance scope. */
function instanceContext(inst: FbInstance, ctx: EvalContext, depth: number, local?: Scope, owner: Pou = inst.pou): EvalContext {
  const scopes = local === undefined ? [inst.scope] : [local, inst.scope]
  const inner: EvalContext = { ...ctx, chain: chainOf(scopes, ctx), self: inst, owner, depth }
  const chain = lineage(inst.pou, ctx.symbols)
  if (chain.some((p) => p.properties.length > 0)) inner.chain = chainOf([...scopes, propertyScope(inst, chain, inner)], ctx)
  return inner
}

/** Declare the result variable named after the function/method; `undefined` when it has no return type. */
function declareResult(frame: Frame, name: string, typeNode: Node | undefined, ctx: EvalContext, depth: number): Slot | undefined {
  if (typeNode === undefined) return undefined
  const slot: Slot = { value: initialValue(typeNode, ctx, depth, frame.children, frame.scope) }
  frame.scope.declare(name, slot, 'local')
  return slot
}

function disposeAll(children: readonly FbInstance[], ctx: EvalContext): void {
  for (const child of children) disposeFb(child, ctx)
}

// ---------------------------------------------------------------------------
// Callees.
// ---------------------------------------------------------------------------

function callHost(def: HostFnDef, callee: string, args: CallArg[], ctx: EvalContext, node: Node | undefined): IecValue | undefined {
  const shadowed = ctx.symbols.getPou(callee)
  if (shadowed !== undefined) {
    const prefix = `host function '${def.name}' `
    if (!ctx.session.warnings.some((w) => w.code === HOSTFN_SHADOWS_POU && w.message.startsWith(prefix))) {
      ctx.session.warn(HOSTFN_SHADOWS_POU, `${prefix}shadows the user POU '${shadowed.name}' declared in ${shadowed.file}; calls resolve to the host function`, locationOf(node ?? shadowed.bodyNode, ctx))
    }
  }
  if (args.length < def.minArgs || args.length > def.maxArgs) {
    const expected = def.minArgs === def.maxArgs ? String(def.minArgs) : `${String(def.minArgs)}..${String(def.maxArgs)}`
    throw error(ctx, node, `'${def.name}' takes ${expected} argument(s), got ${String(args.length)}`)
  }
  return def.call(args, hostContext(ctx, node))
}

/** A user FUNCTION: fresh variables on every call, result returned through the function-name variable. */
function callFunction(pou: Pou, args: CallArg[], ctx: EvalContext, node: Node | undefined): IecValue | undefined {
  const depth = enter(ctx, node, pou.name)
  const locNode = node ?? pou.bodyNode
  const frame = buildFrame(pou.varBlocks.flatMap((b) => b.vars), ctx, depth)
  const result = declareResult(frame, pou.name, pou.bodyNode?.childForFieldName('return_type') ?? undefined, ctx, depth)
  try {
    const outputs = bindArgs(frame.params, args, ctx, node, locNode, pou.name)
    runBody(bodyStatements(pou.bodyNode), { ...ctx, chain: chainOf([frame.scope], ctx), self: undefined, depth }, pou.bodyNode)
    copyOutputs(outputs, ctx, locNode)
  } finally {
    disposeAll(frame.children, ctx)
  }
  return result === undefined ? undefined : cloneValue(result.value)
}

/** A METHOD of `inst`: fresh method variables in front of the instance scope, `THIS` bound to `inst`. */
function invokeMethod(inst: FbInstance, found: Owned<Method>, args: CallArg[], ctx: EvalContext, node?: Node): IecValue | undefined {
  const { member: method, owner } = found
  const what = `${inst.typeName}.${method.name}`
  const depth = enter(ctx, node, what)
  const locNode = node ?? method.bodyNode
  const frame = buildFrame(method.varBlocks.flatMap((b) => b.vars), ctx, depth)
  const result = declareResult(frame, method.name, method.returnTypeNode, ctx, depth)
  try {
    const outputs = bindArgs(frame.params, args, ctx, node, locNode, what)
    if (inst.intercept !== undefined) inst.intercept(method.name, recordedArgs(frame.params))
    else runBody(bodyStatements(method.bodyNode), instanceContext(inst, ctx, depth, frame.scope, owner), method.bodyNode)
    copyOutputs(outputs, ctx, locNode)
  } finally {
    disposeAll(frame.children, ctx)
  }
  return result === undefined ? undefined : cloneValue(result.value)
}

/** An ACTION of `inst`: its body runs directly in the instance scope. */
function invokeAction(inst: FbInstance, found: Owned<Action>, args: CallArg[], ctx: EvalContext, node: Node | undefined): undefined {
  const { member: action, owner } = found
  const what = `${inst.typeName}.${action.name}`
  if (args.length > 0) throw error(ctx, node, `action '${what}' takes no arguments`)
  const depth = enter(ctx, node, what)
  if (inst.intercept !== undefined) inst.intercept(action.name, {})
  else runBody(action.bodyNodes, instanceContext(inst, ctx, depth, undefined, owner), action.bodyNodes[0] as Node | undefined)
  return undefined
}

/** `FbIo` over a stub instance's inputs, outputs and in-outs. */
function fbIo(inst: FbInstance, ctx: EvalContext, locNode: Node | undefined): FbIo {
  const slotOf = (name: string): Slot => {
    const slot = inst.scope.get(name)
    if (slot === undefined) throw new IecRuntimeError(`function block '${inst.typeName}' has no variable '${name}'`)
    return slot
  }
  return {
    get: (name) => slotOf(name).value,
    set: (name, v) => {
      store(slotOf(name), v, ctx, locNode)
    },
  }
}
