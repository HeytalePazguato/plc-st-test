/**
 * Lexical scopes and the scope chain used by the interpreter to resolve variable names to their storage `Slot`.
 *
 * A `Scope` holds the variables of one POU activation (or FB instance), keyed under the session's case mode. A `ScopeChainImpl` stacks scopes innermost first; lookups return the innermost match, so inner declarations shadow outer ones.
 *
 * VAR_IN_OUT binding is aliasing: the callee declares the caller's `Slot` object itself (not a copy) under the parameter name, so a write through either name is visible through the other. Nothing in this module ever replaces a declared `Slot` object — only its `value` — so aliases stay valid for the lifetime of the scope.
 */

import type { Node } from 'web-tree-sitter'
import type { Slot } from '@plc-st/plugin-api'
import type { ScopeChain } from './context.js'
import { defaultValue, type ConstEvaluator, type TypeResolver } from './values.js'
import type { VarKind } from '../symbols/table.js'
import { IecError } from '../errors.js'
import { caseKey } from '../case.js'

interface ScopeEntry {
  name: string
  slot: Slot
  kind: VarKind
}

/** The variables of one POU activation or FB instance. */
export class Scope {
  private readonly vars = new Map<string, ScopeEntry>()

  constructor(private readonly caseSensitive: boolean) {}

  /**
   * Declare `name` bound to `slot`. For VAR_IN_OUT pass the caller's own `Slot` object to alias it. Redeclaring a name (under the case mode) in the same scope throws `IecError`.
   */
  declare(name: string, slot: Slot, kind: VarKind): void {
    const k = caseKey(name, this.caseSensitive)
    const existing = this.vars.get(k)
    if (existing !== undefined) {
      throw new IecError(`Variable '${name}' is already declared in this scope (as '${existing.name}')`)
    }
    this.vars.set(k, { name, slot, kind })
  }

  /** The slot declared under `name` in this scope only, honouring the case mode. */
  get(name: string): Slot | undefined {
    return this.vars.get(caseKey(name, this.caseSensitive))?.slot
  }

  /** All declarations in declaration order, with their original spelling. */
  entries(): [string, Slot, VarKind][] {
    return [...this.vars.values()].map((e) => [e.name, e.slot, e.kind])
  }
}

/** Immutable stack of scopes, innermost first. */
export class ScopeChainImpl implements ScopeChain {
  private readonly scopes: readonly Scope[]

  constructor(scopes: Scope[]) {
    this.scopes = [...scopes]
  }

  /** Innermost-wins lookup; each scope applies its own case mode. */
  lookup(name: string): Slot | undefined {
    for (const scope of this.scopes) {
      const slot = scope.get(name)
      if (slot !== undefined) return slot
    }
    return undefined
  }

  /** A new chain with `scope` as the innermost scope; this chain is unchanged. */
  push(scope: Scope): ScopeChainImpl {
    return new ScopeChainImpl([scope, ...this.scopes])
  }
}

/**
 * Reinitialise every VAR_TEMP entry of `scope` to its declared default, evaluating initializers through `constEval` exactly as instantiation does (called at the start of each body invocation). Other kinds — notably VAR, which persists across invocations — are untouched. The existing `Slot` object is kept and only its `value` replaced, so any alias to it stays valid.
 */
export function resetTemps(
  scope: Scope,
  typeOf: (name: string) => Node,
  resolver: TypeResolver,
  constEval: ConstEvaluator,
): void {
  for (const [name, slot, kind] of scope.entries()) {
    if (kind !== 'temp') continue
    slot.value = defaultValue(typeOf(name), resolver, constEval)
  }
}
