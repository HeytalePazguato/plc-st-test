/**
 * `MOCK(path)`: replaces an instance with a `MockInstance` for the rest of the test. The mock has the instance's declared inputs, in-outs and outputs but none of its VARs; calling it, or any of its methods and actions, runs no real code and records the invocation on `session.mocks`.
 */
import type { IecValue } from '@plc-st/plugin-api'
import { IecError } from '../errors.js'
import type { EvalContext } from '../interpreter/context.js'
import { FbInstance, fbInstanceOf, mockTwin, store, type Param } from '../interpreter/pou.js'
import { cloneValue } from '../interpreter/values.js'
import { runtimeOf, stringArg } from '../runner/cyclefns.js'
import type { Session, TestRuntime } from '../session.js'
import { resolveMockTarget } from './resolve.js'

export class MockInstance extends FbInstance {
  /** Output values set by MOCK_RETURNS, restored on every call so they persist whatever else writes to the output. */
  private readonly returns = new Map<Param, IecValue>()

  constructor(
    readonly path: string,
    real: FbInstance,
    ctx: EvalContext,
  ) {
    const { frame, value } = mockTwin(real, ctx)
    super(real.pou, frame, value, ctx)
  }

  /** Records the call under `path`, or `path.member` for a method or action. Method results stay at their defaults. */
  override intercept(member: string | undefined, args: Record<string, IecValue>): void {
    this.ctx.session.mocks.record(member === undefined ? this.path : `${this.path}.${member}`, { args, cycle: this.ctx.clock?.cycle ?? 0 })
    if (member === undefined) for (const [output, value] of this.returns) output.slot.value = cloneValue(value)
  }

  /** Sets `output` to `value`, converted to its declared type (errors located at the suite, since a host call has no source node), from now on. */
  setOutput(output: Param, value: IecValue, rt: TestRuntime): void {
    store(output.slot, value, this.ctx, rt.suite.pou.bodyNode)
    this.returns.set(output, cloneValue(output.slot.value))
  }
}

/** The mock at `path`, replacing the real instance there on first use. */
export function mockAt(path: string, rt: TestRuntime): MockInstance {
  const { owner, member } = resolveMockTarget(path, rt.suite, rt.ctx.symbols)
  const current = fbInstanceOf(owner.value.fields.get(member))
  if (current === undefined) throw new IecError(`mock target '${path}' is not a function block instance`)
  if (current instanceof MockInstance) return current
  const mock = new MockInstance(path, current, rt.ctx)
  owner.replaceMember(member, mock)
  return mock
}

/** Registers `MOCK(path: STRING)` on `session`. */
export function registerMock(session: Session): void {
  session.hostFns.register(
    {
      name: 'MOCK',
      minArgs: 1,
      maxArgs: 1,
      call(args) {
        mockAt(stringArg('MOCK', 'path', args[0]), runtimeOf(session, 'MOCK'))
        return undefined
      },
    },
    'mock',
  )
}
