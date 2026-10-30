/**
 * EXTENDS: member lookup along the inheritance chain.
 *
 * A chain runs from the POU itself up to its root base, so the most derived declaration wins and overriding is just lookup order. Virtual dispatch starts at the instance's own POU; `SUPER` starts one step above the POU that declares the running code, not above the instance's POU, or a method that calls `SUPER^.M()` from the middle of a three-level chain would find itself again.
 */

import type { Action, Method, Pou, Property, SymbolTable } from '../symbols/table.js'

/** A member and the POU in the chain that declares it. */
export interface Owned<T> {
  member: T
  owner: Pou
}

/** The inheritance chain of `pou`: itself, then its EXTENDS base, and so on. An unknown base ends the chain; a cycle stops at the first repeat. */
export function lineage(pou: Pou, symbols: SymbolTable): Pou[] {
  const chain: Pou[] = []
  for (let p: Pou | undefined = pou; p !== undefined && !chain.includes(p); p = p.extendsName === undefined ? undefined : symbols.getPou(p.extendsName)) {
    chain.push(p)
  }
  return chain
}

function find<T extends { name: string }>(chain: Pou[], name: string, symbols: SymbolTable, members: (pou: Pou) => T[]): Owned<T> | undefined {
  const key = symbols.normalizeKey(name)
  for (const owner of chain) {
    const member = members(owner).find((m) => symbols.normalizeKey(m.name) === key)
    if (member !== undefined) return { member, owner }
  }
  return undefined
}

export function findMethod(chain: Pou[], name: string, symbols: SymbolTable): Owned<Method> | undefined {
  return find(chain, name, symbols, (pou) => pou.methods.filter((m) => m.bodyNode?.type === 'method_declaration'))
}

export function findAction(chain: Pou[], name: string, symbols: SymbolTable): Owned<Action> | undefined {
  return find(chain, name, symbols, (pou) => pou.actions)
}

export function findProperty(chain: Pou[], name: string, symbols: SymbolTable): Owned<Property> | undefined {
  return find(chain, name, symbols, (pou) => pou.properties)
}
