/**
 * IEC 61131-3 timer function blocks (TON, TOF, TP) as host-implemented stubs. State advances only when the instance is invoked, measuring elapsed time against the simulated clock (`ctx.nowNs`); PT is re-read on every call so it may change while a timer runs, and ET saturates at PT. TIME values are bigint nanoseconds.
 */
import type { FbIo, FbStubDef } from '@plc-st/plugin-api'
import { IecType } from '../numeric.js'
import type { IecValue } from '../values.js'
import { boolValue, readBool } from './signals.js'

function readTime(io: FbIo, name: string): bigint {
  const v = io.get(name)
  if (v.kind !== 'scalar') throw new Error(`stub parameter '${name}' is not a scalar`)
  return BigInt(v.value as bigint | number)
}

function timeValue(value: bigint): IecValue {
  return { kind: 'scalar', type: IecType.TIME, value }
}

const TIMER_INPUTS = [
  { name: 'IN', type: 'BOOL' },
  { name: 'PT', type: 'TIME' },
]
const TIMER_OUTPUTS = [
  { name: 'Q', type: 'BOOL' },
  { name: 'ET', type: 'TIME' },
]

interface TimerState {
  /** Previous IN level (starts FALSE). */
  prev: boolean
  /** Clock reading when the current timing interval started. */
  start: bigint
  /** Whether an interval is currently being timed. */
  running: boolean
}

const createState = (): TimerState => ({ prev: false, start: 0n, running: false })

function publish(io: FbIo, q: boolean, et: bigint): void {
  io.set('Q', boolValue(q))
  io.set('ET', timeValue(et))
}

/** On-delay: Q rises PT after IN rises and falls as soon as IN falls; ET counts while IN is TRUE (saturating at PT) and resets to 0 when IN drops. */
export const TON: FbStubDef = {
  name: 'TON',
  inputs: TIMER_INPUTS,
  outputs: TIMER_OUTPUTS,
  createState,
  call(state, io, ctx) {
    const s = state as TimerState
    const input = readBool(io, 'IN')
    const pt = readTime(io, 'PT')
    if (!input) {
      s.running = false
      publish(io, false, 0n)
    } else {
      if (!s.prev) s.start = ctx.nowNs
      const elapsed = ctx.nowNs - s.start
      const done = elapsed >= pt
      publish(io, done, done ? pt : elapsed)
    }
    s.prev = input
  },
}

/** Off-delay: Q is TRUE while IN is TRUE and stays TRUE for PT after IN falls; ET counts from IN's falling edge, holds PT once expired, and resets to 0 when IN rises again. */
export const TOF: FbStubDef = {
  name: 'TOF',
  inputs: TIMER_INPUTS,
  outputs: TIMER_OUTPUTS,
  createState,
  call(state, io, ctx) {
    const s = state as TimerState
    const input = readBool(io, 'IN')
    const pt = readTime(io, 'PT')
    if (input) {
      s.running = false
      publish(io, true, 0n)
    } else {
      if (s.prev) {
        s.start = ctx.nowNs
        s.running = true
      }
      if (s.running) {
        const elapsed = ctx.nowNs - s.start
        if (elapsed >= pt) {
          s.running = false
          publish(io, false, pt)
        } else {
          publish(io, true, elapsed)
        }
      }
      // Not running and IN FALSE: the outputs are untouched (initially Q FALSE / ET 0, or the expired ET = PT until IN rises).
    }
    s.prev = input
  },
}

/** Pulse: a rising edge of IN while idle starts a pulse of length PT (Q TRUE, ET counting); IN is ignored until the pulse ends. Once it has ended ET holds PT while IN is TRUE and resets to 0 when IN is FALSE. */
export const TP: FbStubDef = {
  name: 'TP',
  inputs: TIMER_INPUTS,
  outputs: TIMER_OUTPUTS,
  createState,
  call(state, io, ctx) {
    const s = state as TimerState
    const input = readBool(io, 'IN')
    const pt = readTime(io, 'PT')
    if (!s.running && input && !s.prev) {
      s.running = true
      s.start = ctx.nowNs
    }
    if (s.running) {
      const elapsed = ctx.nowNs - s.start
      if (elapsed >= pt) {
        s.running = false
        publish(io, false, pt)
      } else {
        publish(io, true, elapsed)
      }
    } else if (!input) {
      publish(io, false, 0n)
    }
    s.prev = input
  },
}

export const TIMER_STUBS: readonly FbStubDef[] = [TON, TOF, TP]
