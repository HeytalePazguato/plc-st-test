import type { FbStubDef, HostFnDef } from './hostfn.js'

/** The per-test session a simulator attaches to; registrations are scoped to this session only. */
export interface SimulatorSession {
  readonly cycleTimeNs: bigint
  onPreCycle(fn: (cycle: number) => void): void
  onPostCycle(fn: (cycle: number) => void): void
  registerHostFn(def: HostFnDef): void
  registerFbStub(def: FbStubDef): void
  /** The simulator's section of the user configuration. */
  config: Record<string, unknown>
}

/** Simulates plant/IO behaviour around the program under test. */
export interface Simulator {
  id: string
  apiVersion: number
  attach(s: SimulatorSession): void
}
