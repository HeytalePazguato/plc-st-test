/**
 * IEC 61131-3 bistable function blocks (SR, RS) as host-implemented stubs. Q1 is the output field itself, so it is held between invocations without private state.
 */
import type { FbStubDef } from '@plc-st/plugin-api'
import { boolValue, readBool } from './signals.js'

/** Set-dominant latch: Q1 := S1 OR (NOT R AND Q1). When S1 and R are both TRUE, Q1 is TRUE. */
export const SR: FbStubDef = {
  name: 'SR',
  inputs: [
    { name: 'S1', type: 'BOOL' },
    { name: 'R', type: 'BOOL' },
  ],
  outputs: [{ name: 'Q1', type: 'BOOL' }],
  call(_state, io) {
    io.set('Q1', boolValue(readBool(io, 'S1') || (!readBool(io, 'R') && readBool(io, 'Q1'))))
  },
}

/** Reset-dominant latch: Q1 := NOT R1 AND (S OR Q1). When S and R1 are both TRUE, Q1 is FALSE. */
export const RS: FbStubDef = {
  name: 'RS',
  inputs: [
    { name: 'S', type: 'BOOL' },
    { name: 'R1', type: 'BOOL' },
  ],
  outputs: [{ name: 'Q1', type: 'BOOL' }],
  call(_state, io) {
    io.set('Q1', boolValue(!readBool(io, 'R1') && (readBool(io, 'S') || readBool(io, 'Q1'))))
  },
}

export const BISTABLE_STUBS: readonly FbStubDef[] = [SR, RS]
