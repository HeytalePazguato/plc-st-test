import type { FbStubDef, HostFnDef } from '@plc-st/plugin-api'
import type { Session } from '../../session.js'
import { COUNTER_STUBS } from './counters.js'
import { EDGE_STUBS } from './edge.js'
import { BISTABLE_STUBS } from './bistable.js'
import { STRING_FNS } from './strings.js'
import { MATH_FNS } from './math.js'
import { SELECTION_FNS } from './selection.js'
import { CONVERSION_FNS } from './conversion.js'

/** The stdlib function-block modules, each contributing its FB stubs. Timers (4.5) add their list here. */
const FB_MODULES: readonly (readonly FbStubDef[])[] = [COUNTER_STUBS, EDGE_STUBS, BISTABLE_STUBS]

/** The stdlib function modules, each contributing host functions. */
const FN_MODULES: readonly (readonly HostFnDef[])[] = [STRING_FNS, MATH_FNS, SELECTION_FNS, CONVERSION_FNS]

/** Registers every standard library module into `session` (source `stdlib`; a user POU of the same name still takes precedence for FBs). */
export function registerStdlib(session: Session): void {
  for (const module of FB_MODULES) {
    for (const def of module) session.fbStubs.register(def, 'stdlib')
  }
  for (const module of FN_MODULES) {
    for (const def of module) session.hostFns.register(def, 'stdlib')
  }
}
