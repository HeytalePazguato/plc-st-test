/**
 * `RUN_CYCLES` / `RUN_UNTIL` host functions: drive the current test's cycle engine against its suite instance (see `Session.runtime`).
 */
import type { CallArg, IecValue } from '@plc-st/plugin-api'
import { IecRuntimeError } from '../errors.js'
import type { Session, TestRuntime } from '../session.js'

export function runtimeOf(session: Session, name: string): TestRuntime {
  if (session.runtime === undefined) throw new IecRuntimeError(`${name} can only be used inside a test`)
  return session.runtime
}

function intArg(name: string, what: string, arg: CallArg): number {
  const v: IecValue = arg.value
  if (v.kind !== 'scalar' || typeof v.value === 'boolean' || typeof v.value === 'string' || (typeof v.value === 'number' && !Number.isInteger(v.value))) {
    throw new IecRuntimeError(`${name}: ${what} must be an integer`)
  }
  return Number(v.value)
}

export function stringArg(name: string, what: string, arg: CallArg): string {
  const v = arg.value
  if (v.kind !== 'scalar' || (v.type !== 'STRING' && v.type !== 'WSTRING')) throw new IecRuntimeError(`${name}: ${what} must be a STRING`)
  return String(v.value)
}

/** Registers `RUN_CYCLES(n: DINT)` and `RUN_UNTIL(expr: STRING, maxCycles: DINT): DINT` on `session`. */
export function registerCycleFns(session: Session): void {
  session.hostFns.register(
    {
      name: 'RUN_CYCLES',
      minArgs: 1,
      maxArgs: 1,
      call(args) {
        const rt = runtimeOf(session, 'RUN_CYCLES')
        const n = intArg('RUN_CYCLES', 'n', args[0])
        if (n < 0) throw new IecRuntimeError(`RUN_CYCLES: n must not be negative, got ${String(n)}`)
        rt.engine.runCycles(n, rt.suite, rt.ctx)
        return undefined
      },
    },
    'cyclefns',
  )
  session.hostFns.register(
    {
      name: 'RUN_UNTIL',
      minArgs: 2,
      maxArgs: 2,
      call(args) {
        const rt = runtimeOf(session, 'RUN_UNTIL')
        const expr = stringArg('RUN_UNTIL', 'expression', args[0])
        const max = intArg('RUN_UNTIL', 'maxCycles', args[1])
        if (max < 0) throw new IecRuntimeError(`RUN_UNTIL: maxCycles must not be negative, got ${String(max)}`)
        return { kind: 'scalar', type: 'DINT', value: rt.engine.runUntil(expr, max, rt.suite, rt.ctx) }
      },
    },
    'cyclefns',
  )
}
