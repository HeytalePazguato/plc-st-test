/**
 * IEC 61131-3 edge detection function blocks (R_TRIG, F_TRIG) as host-implemented stubs. Each keeps the previous CLK level per instance, so Q is TRUE for exactly the one invocation in which the edge is seen; the level starts FALSE.
 */
import type { FbStubDef } from '@plc-st/plugin-api'
import { boolValue, readBool } from './signals.js'

interface EdgeState {
  prev: boolean
}

/** Rising edge: Q is TRUE on the invocation where CLK goes FALSE → TRUE. */
export const R_TRIG: FbStubDef = {
  name: 'R_TRIG',
  inputs: [{ name: 'CLK', type: 'BOOL' }],
  outputs: [{ name: 'Q', type: 'BOOL' }],
  createState: (): EdgeState => ({ prev: false }),
  call(state, io) {
    const edge = state as EdgeState
    const clk = readBool(io, 'CLK')
    io.set('Q', boolValue(clk && !edge.prev))
    edge.prev = clk
  },
}

/** Falling edge: Q is TRUE on the invocation where CLK goes TRUE → FALSE. */
export const F_TRIG: FbStubDef = {
  name: 'F_TRIG',
  inputs: [{ name: 'CLK', type: 'BOOL' }],
  outputs: [{ name: 'Q', type: 'BOOL' }],
  createState: (): EdgeState => ({ prev: false }),
  call(state, io) {
    const edge = state as EdgeState
    const clk = readBool(io, 'CLK')
    io.set('Q', boolValue(!clk && edge.prev))
    edge.prev = clk
  },
}

export const EDGE_STUBS: readonly FbStubDef[] = [R_TRIG, F_TRIG]
