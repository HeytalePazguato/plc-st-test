/**
 * Shared interpreter-core contracts.
 *
 * Tasks 2.1–2.6 are mutually recursive: an expression can call a POU, a POU runs statements, a statement evaluates expressions. To avoid import cycles and keep those tasks consistent, the primitives they all share live here. Later tasks extend `EvalContext` with their own fields (the CycleEngine in 2.5, the host-fn registry in 2.6, results/mocks in the runner/mock phases).
 */
import type { Node } from 'web-tree-sitter'
import type { CallArg, DialectHooks, Slot } from '@plc-st/plugin-api'
import type { IecValue } from './values.js'
import type { Scope } from './scope.js'
import type { FbInstance } from './pou.js'
import type { Pou, SymbolTable } from '../symbols/table.js'
import type { Limits } from '../limits.js'
import type { Session } from '../session.js'

/**
 * `Slot` (a mutable variable cell; VAR_IN_OUT aliasing is two names pointing at the SAME `Slot`) and `CallArg` (a bound call argument carrying its value and, for variables, its `Slot`) are part of the plugin contract and declared in `@plc-st/plugin-api`.
 */
export type { CallArg, Slot } from '@plc-st/plugin-api'

/** Lexical scope lookup. Concrete implementation: task 2.1 (`ScopeChain`). */
export interface ScopeChain {
  /** Innermost-wins lookup of a variable's slot, honoring the case-mode. */
  lookup(name: string): Slot | undefined
}

/** Outcome of executing a statement or body. Concrete handling: task 2.3. */
export type ControlSignal = { type: 'normal' | 'exit' | 'continue' | 'return' }

/** The default "keep going" signal. */
export const NORMAL: ControlSignal = { type: 'normal' }


/**
 * Calls a host function, FUNCTION, FB instance, METHOD or ACTION and returns its result value (or `undefined` for a void call). Implemented by `callPou` in pou.ts and injected into the context so expressions and statements can invoke POUs WITHOUT importing `pou.ts` — that injection is what breaks the recursion cycle. `node` is the call's `function` expression when the call comes from source: it locates errors and lets the dispatcher resolve receivers that are not plain name paths (e.g. `fbs[i]()`).
 */
export type CallPou = (
  callee: string,
  args: CallArg[],
  ctx: EvalContext,
  node?: Node,
) => IecValue | undefined

/**
 * Resolves `<base>.<name>` to the slot of a PROPERTY, or `undefined` when the instance behind `base` has none. `fromBase` is set for `SUPER`, and `node` is the base expression. Implemented in pou.ts and injected for the same reason as `CallPou`.
 */
export type PropertyOf = (base: IecValue, name: string, fromBase: boolean, ctx: EvalContext, node: Node) => Slot | undefined

/** Read-only view of the simulated clock, supplied by the cycle engine. */
export interface ClockView {
  readonly cycle: number
  readonly nowNs: bigint
}

/**
 * The context threaded through every eval/exec call. Tasks add their own fields as they land; the optional fields below are set by the POU dispatcher (`self`, `depth`) or by whoever builds the root context (`hooks`, `globals`, `clock`).
 */
export interface EvalContext {
  symbols: SymbolTable
  chain: ScopeChain
  limits: Limits
  callPou: CallPou
  /** Property access; without it, no member resolves to a property. */
  propertyOf?: PropertyOf
  session: Session
  /** Dialect lifecycle hooks (onInstantiate / onDispose). */
  hooks?: DialectHooks
  /** Scopes visible from every POU body (GVLs, program instances), innermost first; a callee's chain is its own scope(s) followed by these. */
  globals?: Scope[]
  /** Simulated clock exposed to host functions and FB stubs; cycle 0 / 0 ns when absent. */
  clock?: ClockView
  /** The FB/program instance whose body, method or action is running (THIS, bare action/method calls). */
  self?: FbInstance
  /** The POU in `self`'s inheritance chain that declares the running code; `SUPER` starts above it. */
  owner?: Pou
  /** Number of POU activations on the call stack, checked against `limits.maxRecursionDepth`. */
  depth?: number
}
