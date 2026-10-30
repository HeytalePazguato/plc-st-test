import type { OriginalLocation } from '@plc-st/project-model'
import type { IecValue } from './values.js'

/** A mutable variable cell. VAR_IN_OUT aliasing is two names pointing at the SAME `Slot`, so a write through one is visible to the other (and to the caller). */
export interface Slot {
  value: IecValue
}

/** A bound call argument: named (`a := x`) or positional, carrying the evaluated value and — when the argument is a variable — its `Slot` (so a VAR_IN_OUT parameter can alias the caller's storage). */
export interface CallArg {
  name?: string
  value: IecValue
  slot?: Slot
}

/** What a host function or FB stub can see of the running session at the call site. */
export interface HostCallContext {
  /** Current PLC cycle number. */
  readonly cycle: number
  /** Simulated clock, in nanoseconds. */
  readonly nowNs: bigint
  /** Original (vendor-file) location of the call. */
  readonly location: OriginalLocation
  /** Resolve a dotted variable path (e.g. `GVL.bStart`, `fbConveyor.nState`) to its slot. */
  resolvePath(path: string): Slot | undefined
  /** Emit a run warning attributed to the call site. */
  warn(code: string, message: string): void
}

/** A FUNCTION implemented on the host (TypeScript) side, e.g. a vendor library function. */
export interface HostFnDef {
  name: string
  minArgs: number
  maxArgs: number
  /** Returns the function result, or `undefined` for a function without a return value. */
  call(args: CallArg[], ctx: HostCallContext): IecValue | undefined
}

/** A variable declared on a host-implemented FUNCTION_BLOCK; `type` is the ST type name (e.g. `BOOL`, `TIME`, `STRING(80)`). */
export interface VarSpec {
  name: string
  type: string
  init?: IecValue
}

/** Access to one FB instance's inputs/outputs/in-outs while its stub body runs. */
export interface FbIo {
  get(name: string): IecValue
  set(name: string, v: IecValue): void
}

/** A FUNCTION_BLOCK implemented on the host side (e.g. TON, R_TRIG, vendor library FBs). */
export interface FbStubDef {
  name: string
  inputs: VarSpec[]
  outputs: VarSpec[]
  inOuts?: VarSpec[]
  /** Creates per-instance private state; called once per instance. */
  createState?(): unknown
  /** One invocation of the FB body for an instance. */
  call(state: unknown, io: FbIo, ctx: HostCallContext): void
}
