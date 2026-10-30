import type { FbStubDef } from '@plc-st/plugin-api'
import type { Session } from '../../session.js'
import { COUNTER_STUBS } from './counters.js'
import { EDGE_STUBS } from './edge.js'
import { BISTABLE_STUBS } from './bistable.js'

/** The stdlib modules, each contributing its FB stubs. Timers (4.5) and functions (4.7) add their lists here. */
const MODULES: readonly (readonly FbStubDef[])[] = [COUNTER_STUBS, EDGE_STUBS, BISTABLE_STUBS]

/** Registers every standard library module into `session` (source `stdlib`; a user FUNCTION_BLOCK of the same name still takes precedence). */
export function registerStdlib(session: Session): void {
  for (const module of MODULES) {
    for (const def of module) session.fbStubs.register(def, 'stdlib')
  }
}
