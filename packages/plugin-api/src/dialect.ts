import type { CallArg, FbStubDef, HostCallContext, HostFnDef, Slot } from './hostfn.js'
import type { TestStrategyKind } from './strategy.js'
import type { IecValue } from './values.js'

/** Core's interpreter as seen by a node handler, so a dialect can evaluate the children of its own constructs without importing core. Every method takes a web-tree-sitter `Node` (the handler's node or one of its descendants) and the `ctx` the handler received, passed through unchanged. */
export interface NodeEvaluator {
  /** Evaluate an expression node to its value (variables are returned as stored, so clone before keeping one). */
  evaluate(node: unknown, ctx: unknown): IecValue
  /** Resolve an assignable expression (variable, member, array element) to its live storage slot. */
  lvalue(node: unknown, ctx: unknown): Slot
  /** Store `value` into `slot`, converted to the slot's declared type exactly like `:=` does; `node` locates conversion errors. */
  store(slot: Slot, value: IecValue, node: unknown, ctx: unknown): void
  /** A runtime error whose message ends with `at <file>:<line>` of `node` in the original source; the handler throws it. */
  error(node: unknown, ctx: unknown, message: string): Error
  /** Like `lvalue`, but a `REFERENCE TO` variable resolves to its own slot (holding the reference) instead of the variable it refers to; used to re-bind a reference. */
  rawLvalue(node: unknown, ctx: unknown): Slot
  /** The handle the session's slot table issues for `slot` (the same slot always gets the same handle; handles start at 1, `0` is NULL). */
  handleOf(slot: Slot, ctx: unknown): number
  /** The slot behind `handle`, or `undefined` for NULL or an unknown handle. */
  slotOf(handle: number, ctx: unknown): Slot | undefined
}

/** Resolves a dialect-specific assignable node (e.g. a dereference `p^`) to its live storage slot, so it can be the target of `:=` and of call output bindings. */
export type LvalueHandler = (node: unknown, ctx: unknown, evaluator: NodeEvaluator) => Slot

/** Evaluates a dialect-specific grammar node. `node` is a web-tree-sitter `Node`; `ctx` is the core evaluation context (opaque to plugins); `evaluator` evaluates child nodes through core. In expression position the result is the node's `IecValue`; in statement position a returned control signal (`{ type: 'exit' | 'continue' | 'return' | 'normal' }`) is honoured and anything else counts as normal completion. */
export type NodeHandler = (node: unknown, ctx: unknown, evaluator: NodeEvaluator) => unknown

/** A live FUNCTION_BLOCK instance as seen by dialect lifecycle hooks (e.g. TwinCAT FB_init/FB_exit). */
export interface FbInstanceRef {
  typeName: string
  hasMethod(name: string): boolean
  callMethod(name: string, args: CallArg[]): IecValue | undefined
}

/** A non-fatal problem a `preprocess` hook reports; `line` is 1-based in the text, which is the original file line because preprocessing keeps the line count. */
export interface PreprocessWarning {
  code: string
  message: string
  line: number
}

export interface DialectHooks {
  /** Source-level preprocessing (e.g. conditional pragmas). MUST preserve the line count so source maps stay valid. */
  preprocess?(text: string, defines: Record<string, string>, warn?: (warning: PreprocessWarning) => void): string
  onInstantiate?(inst: FbInstanceRef, ctx: HostCallContext): void
  onDispose?(inst: FbInstanceRef, ctx: HostCallContext): void
}

/** A vendor flavour of ST: its grammar, rules, test strategy, and built-in library stubs. */
export interface Dialect {
  id: string
  apiVersion: number
  grammarWasmPath(): string
  caseSensitive: boolean
  testStrategy: TestStrategyKind
  nodeHandlers?: Record<string, NodeHandler>
  lvalueHandlers?: Record<string, LvalueHandler>
  fbStubs?: FbStubDef[]
  hostFns?: HostFnDef[]
  builtinLibraries?: string[]
  hooks?: DialectHooks
}
