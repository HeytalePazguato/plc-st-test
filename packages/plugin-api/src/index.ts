/**
 * Public plugin contracts for plc-st-test: ingestors, dialects, simulators, and reporters. Everything except `version.ts` is type-only.
 */

import type { Dialect } from './dialect.js'
import type { Ingestor } from './ingestor.js'
import type { Reporter } from './reporter.js'
import type { Simulator } from './simulator.js'

export * from './version.js'
export type * from './values.js'
export type * from './hostfn.js'
export type * from './ingestor.js'
export type * from './strategy.js'
export type * from './dialect.js'
export type * from './simulator.js'
export type * from './reporter.js'
export type * from './results.js'

/** The default export shape of a plugin package. */
export interface PluginModule {
  apiVersion: number
  ingestors?: Ingestor[]
  dialects?: Dialect[]
  simulators?: Simulator[]
  reporters?: Reporter[]
}
