/**
 * Shared interpreter-core contracts.
 *
 * Tasks 2.1–2.6 are mutually recursive: an expression can call a POU, a POU runs statements, a statement evaluates expressions. To avoid import cycles and keep those tasks consistent, the primitives they all share live here. Later tasks extend `EvalContext` with their own fields (the CycleEngine in 2.5, the host-fn registry in 2.6, results/mocks in the runner/mock phases).
 */
import type { IecValue } from './values.js'
import type { SymbolTable } from '../symbols/table.js'
import type { Limits } from '../limits.js'

/**
 * A mutable variable cell. A scope maps a name to a `Slot`; VAR_IN_OUT aliasing is two names pointing at the SAME `Slot`, so a write through one is visible to the other (and to the caller).
 */
export interface Slot {
  value: IecValue
}

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
 * A bound call argument: named (`a := x`) or positional, carrying the evaluated value and — when the argument is a variable — its `Slot` (required so a VAR_IN_OUT parameter can alias the caller's storage).
 */
export interface CallArg {
  name?: string
  value: IecValue
  slot?: Slot
}

/**
 * Calls a FUNCTION / FUNCTION_BLOCK / METHOD and returns its result value (or `undefined` for a void call). Implemented in task 2.4 and injected into the context so expressions (2.2) and statements (2.3) can invoke POUs WITHOUT importing `pou.ts` — that injection is what breaks the recursion cycle. The exact receiver/argument shape is finalized in 2.4.
 */
export type CallPou = (
  callee: string,
  args: CallArg[],
  ctx: EvalContext,
) => IecValue | undefined

/**
 * The context threaded through every eval/exec call. Tasks add their own fields as they land: 2.5 → `engine`, 2.6 → `hostFns`, runner/mock phases → `results` / `mocks`.
 */
export interface EvalContext {
  symbols: SymbolTable
  chain: ScopeChain
  limits: Limits
  callPou: CallPou
}
