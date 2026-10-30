/**
 * INTERFACE: instance links, interface-typed variables and the IMPLEMENTS check.
 *
 * A variable of an interface type holds an immutable struct value named after the interface, empty until assigned. It carries its target in a hidden property, like the hidden link from an instance's struct value to its `FbInstance`. Assigning makes a new value rather than storing the instance itself, because a slot holding an instance copies members into it on write, which would overwrite the old target instead of rebinding the variable. Being immutable, the value can be shared by `cloneValue`, so the binding survives argument passing and return values.
 *
 * This module sits below the interpreter (it has no runtime imports from it), so the value model, the statement executor and the symbol table can all use it.
 */

import type { IecValue } from '@plc-st/plugin-api'
import type { FbInstance } from '../interpreter/pou.js'
import type { Pou, SymbolTable } from '../symbols/table.js'
import { findProperty, lineage } from './inherit.js'

type StructValue = Extract<IecValue, { kind: 'struct' }>

/** Hidden back-reference from an instance's struct value to its `FbInstance`. */
const INSTANCE = Symbol('plc-st.fbInstance')

/** Hidden target of an interface-typed value. */
const TARGET = Symbol('plc-st.interfaceTarget')

/** Warning code of a diagnostic for a function block that lacks a member of an interface it implements. */
export const INTERFACE_NOT_IMPLEMENTED = 'INTERFACE_NOT_IMPLEMENTED'

/** Make `value` the struct value of `inst`, so `fbInstanceOf` finds it. */
export function linkInstance(value: StructValue, inst: FbInstance): void {
  Object.defineProperty(value, INSTANCE, { value: inst })
}

/** The `FbInstance` behind an instance's struct value, or `undefined` for any other value (including copies of an instance). */
export function fbInstanceOf(value: IecValue | undefined): FbInstance | undefined {
  if (value?.kind !== 'struct') return undefined
  return (value as StructValue & { [INSTANCE]?: FbInstance })[INSTANCE]
}

/** The instance an interface-typed value is bound to, if any. */
export function interfaceTarget(value: IecValue | undefined): FbInstance | undefined {
  if (value?.kind !== 'struct') return undefined
  return (value as StructValue & { [TARGET]?: FbInstance })[TARGET]
}

/** The instance that member access on `value` reaches: the instance itself, or an interface-typed value's target. */
export function boundInstance(value: IecValue | undefined): FbInstance | undefined {
  return fbInstanceOf(value) ?? interfaceTarget(value)
}

/** The INTERFACE named `name`; a namespace-qualified name falls back to its last segment. */
function getInterface(name: string, symbols: SymbolTable): Pou | undefined {
  const pou = symbols.getPou(name) ?? symbols.getPou(name.slice(name.lastIndexOf('.') + 1))
  return pou?.kind === 'interface' ? pou : undefined
}

/** True when `value` has an interface type, assigned or not. */
export function isInterfaceValue(value: IecValue, symbols: SymbolTable): boolean {
  return value.kind === 'struct' && getInterface(value.typeName, symbols) !== undefined
}

/** `iface` and everything it EXTENDS, without repeats. */
function interfaceLineage(iface: Pou, symbols: SymbolTable): Pou[] {
  const seen = new Set<Pou>()
  const visit = (pou: Pou | undefined): void => {
    if (pou === undefined || seen.has(pou)) return
    seen.add(pou)
    for (const base of pou.baseInterfaces) visit(getInterface(base, symbols))
  }
  visit(iface)
  return [...seen]
}

/** The interfaces that `names` declare, with the ones they extend. */
function contracts(names: string[], symbols: SymbolTable): Pou[] {
  const declared = names.flatMap((name) => getInterface(name, symbols) ?? [])
  return [...new Set(declared.flatMap((iface) => interfaceLineage(iface, symbols)))]
}

/** The value of an interface-typed variable like `target` after assigning `value` (an instance or another interface value), or `undefined` when `value` cannot be assigned: it is neither, or its instance does not implement the interface. */
export function bindInterface(target: StructValue, value: IecValue, symbols: SymbolTable): StructValue | undefined {
  const empty: StructValue = { kind: 'struct', typeName: target.typeName, fields: new Map() }
  if (isInterfaceValue(value, symbols) && interfaceTarget(value) === undefined) return empty
  const inst = boundInstance(value)
  const iface = getInterface(target.typeName, symbols)
  if (inst === undefined || iface === undefined) return undefined
  const names = lineage(inst.pou, symbols).flatMap((p) => p.implementsNames)
  if (!contracts(names, symbols).includes(iface)) return undefined
  Object.defineProperty(empty, TARGET, { value: inst })
  return empty
}

/** Report each METHOD and PROPERTY that a concrete FUNCTION_BLOCK's interfaces require and its inheritance chain does not provide. An ABSTRACT block may leave them to its descendants, so its interfaces are checked against those instead, and an abstract method counts as missing. Interfaces no unit declares (from a library) cannot be checked and are skipped. */
export function verifyImplements(table: SymbolTable): void {
  const key = (name: string): string => table.normalizeKey(name)
  for (const pou of table.getPous()) {
    if (pou.kind !== 'functionBlock' || pou.isAbstract) continue
    const chain = lineage(pou, table)
    const names = chain.filter((p) => p === pou || p.isAbstract).flatMap((p) => p.implementsNames)
    const missing = (what: string, name: string, iface: Pou): void => {
      const location = pou.bodyNode !== undefined ? table.locate(pou.bodyNode) : { file: pou.file, line: 1, col: 1 }
      table.addDiagnostic(location, `Function block '${pou.name}' does not implement ${what} '${name}' of interface '${iface.name}'`, INTERFACE_NOT_IMPLEMENTED)
    }
    for (const iface of contracts(names, table)) {
      for (const method of iface.methods) {
        const provided = chain.some((p) => p.methods.some((m) => key(m.name) === key(method.name) && !m.isAbstract))
        if (!provided) missing('method', method.name, iface)
      }
      for (const property of iface.properties) {
        if (findProperty(chain, property.name, table) === undefined) missing('property', property.name, iface)
      }
    }
  }
}
