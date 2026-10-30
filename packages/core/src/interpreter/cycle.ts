import type { Node } from 'web-tree-sitter'
import { IecRuntimeError, IecTimeoutError } from '../errors.js'
import { parseExpressionFragment } from '../parser/fragment.js'
import type { Session } from '../session.js'
import type { SimClock } from './clock.js'
import type { ClockView, EvalContext } from './context.js'
import { evalExpression } from './expressions.js'
import { resetInstanceTemps, type FbInstance } from './pou.js'

/**
 * Drives a test suite instance one scan cycle at a time on a simulated clock. A cycle is: cycle++ → clock advance → session preCycle hooks → the suite's `Cycle` method (if declared) → VAR_TEMP reset of the suite and its nested instances → session postCycle hooks.
 */
export class CycleEngine implements ClockView {
  cycle = 0
  private readonly fragments = new Map<string, Node>()

  constructor(
    private readonly clock: SimClock,
    private readonly cycleTimeNs: bigint,
    private readonly session: Session,
  ) {}

  /** Simulated time, so the engine itself can be passed as `EvalContext.clock`. */
  get nowNs(): bigint {
    return this.clock.nowNs()
  }

  runCycles(n: number, suite: FbInstance, ctx: EvalContext): void {
    for (let i = 0; i < n; i++) this.runOne(suite, ctx)
  }

  /** Runs cycles until `exprSrc` (evaluated in the suite's scope) is TRUE; returns the cycles consumed, or throws `IecTimeoutError` after `max` cycles. */
  runUntil(exprSrc: string, max: number, suite: FbInstance, ctx: EvalContext): number {
    const node = this.fragment(exprSrc, suite)
    for (let used = 1; used <= max; used++) {
      this.runOne(suite, ctx)
      const v = evalExpression(node, { ...ctx, chain: suiteChain(suite, ctx), self: suite })
      if (v.kind !== 'scalar' || typeof v.value !== 'boolean') throw new IecRuntimeError(`RUN_UNTIL(${exprSrc}) is not a BOOL expression`)
      if (v.value) return used
    }
    throw new IecTimeoutError(`RUN_UNTIL(${exprSrc}) not TRUE after ${String(max)} cycles`)
  }

  private fragment(exprSrc: string, suite: FbInstance): Node {
    let node = this.fragments.get(exprSrc)
    if (node === undefined) {
      const anchor = suite.pou.bodyNode
      if (anchor === undefined) throw new IecRuntimeError(`'${suite.typeName}' has no source to evaluate RUN_UNTIL(${exprSrc}) against`)
      node = parseExpressionFragment(anchor.tree.language, exprSrc)
      this.fragments.set(exprSrc, node)
    }
    return node
  }

  private runOne(suite: FbInstance, ctx: EvalContext): void {
    // TODO(3.8): maxCyclesPerTest is enforced here as IecRuntimeError until task 3.8 introduces IecLimitError.
    const max = ctx.limits.maxCyclesPerTest
    if (this.cycle >= max) throw new IecRuntimeError(`cycle budget exceeded: more than ${String(max)} cycles (limits.maxCyclesPerTest)`)
    this.cycle++
    this.clock.advance(this.cycleTimeNs)
    for (const hook of this.session.preCycle) hook(this.cycle)
    if (suite.hasMethod('Cycle')) suite.callMethod('Cycle', [])
    resetInstanceTemps(suite, ctx)
    for (const hook of this.session.postCycle) hook(this.cycle)
  }
}

function suiteChain(suite: FbInstance, ctx: EvalContext): EvalContext['chain'] {
  return { lookup: (name) => suite.scope.get(name) ?? ctx.chain.lookup(name) }
}
