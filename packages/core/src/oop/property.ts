/**
 * PROPERTY: a slot whose reads run GET and whose writes run SET.
 *
 * Assignment needs the target's declared type before it stores, and for a variable that is the stored value. Reading a property to learn its type would run GET on every assignment (and fail outright on a SET-only property), so `declaredValue` is the one way to ask a slot for its type. The accessors themselves are injected by `pou.ts`, which keeps this module free of the dispatcher.
 */

import type { IecValue, Slot } from '@plc-st/plugin-api'

export interface PropertyAccess {
  /** Run GET. */
  read(): IecValue
  /** Run SET. */
  write(value: IecValue): void
  /** A default value of the declared type; runs no accessor. */
  declared(): IecValue
}

export class PropertySlot implements Slot {
  constructor(private readonly access: PropertyAccess) {}

  get value(): IecValue {
    return this.access.read()
  }

  set value(v: IecValue) {
    this.access.write(v)
  }

  get declared(): IecValue {
    return this.access.declared()
  }
}

/** A value carrying `slot`'s declared type, without running a property accessor. */
export function declaredValue(slot: Slot): IecValue {
  return slot instanceof PropertySlot ? slot.declared : slot.value
}
