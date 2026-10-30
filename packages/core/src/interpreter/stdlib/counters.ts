/**
 * IEC 61131-3 counter function blocks (CTU, CTD, CTUD) as host-implemented stubs. CU/CD are edge-detected internally (a count happens on the rising edge only); R and LD take priority over counting; CV is INT and saturates at the INT limits instead of wrapping.
 */
import type { FbStubDef } from '@plc-st/plugin-api'
import { boolValue, clampInt, intValue, readBool, readInt } from './signals.js'

/** Previous level of the counted input, for rising-edge detection. */
interface EdgeState {
  prev: boolean
}

interface CtudState {
  prevCu: boolean
  prevCd: boolean
}

/** Up counter: R resets CV to 0; otherwise CV counts up on each rising edge of CU. Q = CV >= PV. */
export const CTU: FbStubDef = {
  name: 'CTU',
  inputs: [
    { name: 'CU', type: 'BOOL' },
    { name: 'R', type: 'BOOL' },
    { name: 'PV', type: 'INT' },
  ],
  outputs: [
    { name: 'Q', type: 'BOOL' },
    { name: 'CV', type: 'INT' },
  ],
  createState: (): EdgeState => ({ prev: false }),
  call(state, io) {
    const edge = state as EdgeState
    const cu = readBool(io, 'CU')
    const rising = cu && !edge.prev
    edge.prev = cu
    let cv = readInt(io, 'CV')
    if (readBool(io, 'R')) cv = 0
    else if (rising) cv = clampInt(cv + 1)
    io.set('CV', intValue(cv))
    io.set('Q', boolValue(cv >= readInt(io, 'PV')))
  },
}

/** Down counter: LD loads CV with PV; otherwise CV counts down on each rising edge of CD. Q = CV <= 0. */
export const CTD: FbStubDef = {
  name: 'CTD',
  inputs: [
    { name: 'CD', type: 'BOOL' },
    { name: 'LD', type: 'BOOL' },
    { name: 'PV', type: 'INT' },
  ],
  outputs: [
    { name: 'Q', type: 'BOOL' },
    { name: 'CV', type: 'INT' },
  ],
  createState: (): EdgeState => ({ prev: false }),
  call(state, io) {
    const edge = state as EdgeState
    const cd = readBool(io, 'CD')
    const rising = cd && !edge.prev
    edge.prev = cd
    let cv = readInt(io, 'CV')
    if (readBool(io, 'LD')) cv = readInt(io, 'PV')
    else if (rising) cv = clampInt(cv - 1)
    io.set('CV', intValue(cv))
    io.set('Q', boolValue(cv <= 0))
  },
}

/**
 * Up/down counter: R resets CV to 0, LD loads CV with PV, otherwise a rising edge on CU counts up and (only when CU did not rise on the same call) a rising edge on CD counts down. QU = CV >= PV, QD = CV <= 0.
 */
export const CTUD: FbStubDef = {
  name: 'CTUD',
  inputs: [
    { name: 'CU', type: 'BOOL' },
    { name: 'CD', type: 'BOOL' },
    { name: 'R', type: 'BOOL' },
    { name: 'LD', type: 'BOOL' },
    { name: 'PV', type: 'INT' },
  ],
  outputs: [
    { name: 'QU', type: 'BOOL' },
    { name: 'QD', type: 'BOOL' },
    { name: 'CV', type: 'INT' },
  ],
  createState: (): CtudState => ({ prevCu: false, prevCd: false }),
  call(state, io) {
    const edge = state as CtudState
    const cu = readBool(io, 'CU')
    const cd = readBool(io, 'CD')
    const upEdge = cu && !edge.prevCu
    const downEdge = cd && !edge.prevCd
    edge.prevCu = cu
    edge.prevCd = cd
    let cv = readInt(io, 'CV')
    if (readBool(io, 'R')) cv = 0
    else if (readBool(io, 'LD')) cv = readInt(io, 'PV')
    else if (upEdge) cv = clampInt(cv + 1)
    else if (downEdge) cv = clampInt(cv - 1)
    io.set('CV', intValue(cv))
    io.set('QU', boolValue(cv >= readInt(io, 'PV')))
    io.set('QD', boolValue(cv <= 0))
  },
}

export const COUNTER_STUBS: readonly FbStubDef[] = [CTU, CTD, CTUD]
