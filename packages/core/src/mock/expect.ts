/**
 * `EXPECT_CALLS`, `EXPECT_CALLED_WITH` and `EXPECT_NOT_CALLED`: assertions over the invocations `session.mocks` has recorded for a mocked instance, method or action at the moment they run.
 */
import type { CallArg, HostCallContext } from '@plc-st/plugin-api'
import { caseKey } from '../case.js'
import { AssertionFailure, IecRuntimeError } from '../errors.js'
import { formatValue } from '../format.js'
import { valueEquals } from '../interpreter/values.js'
import { stringArg } from '../runner/cyclefns.js'
import type { MockCall, Session } from '../session.js'

/** Every host function the mock layer registers, for the editor tooling to list. */
export const MOCK_NAMES: readonly string[] = ['MOCK', 'MOCK_RETURNS', 'EXPECT_CALLS', 'EXPECT_CALLED_WITH', 'EXPECT_NOT_CALLED']

/** `3 calls at cycles 1, 4, 7`, `1 call at cycle 4` or `0 calls`. */
function describeCalls(calls: readonly MockCall[]): string {
  if (calls.length === 0) return '0 calls'
  const noun = calls.length === 1 ? 'call' : 'calls'
  const cycles = calls.map((c) => String(c.cycle))
  return `${String(calls.length)} ${noun} at ${calls.length === 1 ? 'cycle' : 'cycles'} ${cycles.join(', ')}`
}

function countArg(arg: CallArg): number {
  const v = arg.value
  if (v.kind !== 'scalar' || typeof v.value === 'boolean' || typeof v.value === 'string' || (typeof v.value === 'number' && !Number.isInteger(v.value))) {
    throw new IecRuntimeError('EXPECT_CALLS: n must be an integer')
  }
  const n = Number(v.value)
  if (n < 0) throw new IecRuntimeError(`EXPECT_CALLS: n must not be negative, got ${String(n)}`)
  return n
}

/** Registers `EXPECT_CALLS(path, n)`, `EXPECT_CALLED_WITH(path, input, value)` and `EXPECT_NOT_CALLED(path)` on `session`. */
export function registerMockExpectations(session: Session): void {
  const fail = (name: string, message: string, expected: string, actual: string, hc: HostCallContext): never => {
    throw new AssertionFailure(`${name} failed: ${message}`, expected, actual, hc.location)
  }

  session.hostFns.register(
    {
      name: 'EXPECT_CALLS',
      minArgs: 2,
      maxArgs: 2,
      call(args, hc) {
        const path = stringArg('EXPECT_CALLS', 'path', args[0])
        const expected = countArg(args[1])
        const calls = session.mocks.calls(path)
        if (calls.length !== expected) {
          fail('EXPECT_CALLS', `'${path}' expected ${String(expected)} ${expected === 1 ? 'call' : 'calls'}, actual ${describeCalls(calls)}`, String(expected), describeCalls(calls), hc)
        }
        return undefined
      },
    },
    'mock',
  )

  session.hostFns.register(
    {
      name: 'EXPECT_CALLED_WITH',
      minArgs: 3,
      maxArgs: 3,
      call(args, hc) {
        const path = stringArg('EXPECT_CALLED_WITH', 'path', args[0])
        const input = stringArg('EXPECT_CALLED_WITH', 'input name', args[1])
        const wanted = args[2].value
        const key = caseKey(input, session.caseSensitive)
        const calls = session.mocks.calls(path)
        const seen: string[] = []
        for (const call of calls) {
          const name = Object.keys(call.args).find((n) => caseKey(n, session.caseSensitive) === key)
          if (name === undefined) continue
          if (valueEquals(call.args[name], wanted)) return undefined
          seen.push(formatValue(call.args[name]))
        }
        const expected = `${input} := ${formatValue(wanted)}`
        if (calls.length === 0) fail('EXPECT_CALLED_WITH', `'${path}' was never called`, expected, '0 calls', hc)
        const names = new Set(calls.flatMap((c) => Object.keys(c.args)))
        if (seen.length === 0) fail('EXPECT_CALLED_WITH', `'${path}' has no input '${input}' (recorded inputs: ${[...names].join(', ') || 'none'})`, expected, describeCalls(calls), hc)
        fail('EXPECT_CALLED_WITH', `'${path}' was never called with ${expected}; ${input} was ${seen.join(', ')} (${describeCalls(calls)})`, expected, seen.join(', '), hc)
      },
    },
    'mock',
  )

  session.hostFns.register(
    {
      name: 'EXPECT_NOT_CALLED',
      minArgs: 1,
      maxArgs: 1,
      call(args, hc) {
        const path = stringArg('EXPECT_NOT_CALLED', 'path', args[0])
        const calls = session.mocks.calls(path)
        if (calls.length > 0) fail('EXPECT_NOT_CALLED', `'${path}' expected no calls, actual ${describeCalls(calls)}`, '0 calls', describeCalls(calls), hc)
        return undefined
      },
    },
    'mock',
  )
}
