/**
 * Isolation runner: every test runs against a brand-new session, clock, cycle engine and suite instance, so no state (instance VARs, timers, mocks, warnings, budgets) can leak from one test into the next.
 */

import type { DialectHooks, SuiteDescriptor, SuiteResultV1, TestDescriptor, TestResultV1 } from '@plc-st/plugin-api'
import type { OriginalLocation } from '@plc-st/project-model'
import type { Node } from 'web-tree-sitter'
import { registerAssertions } from '../assertions.js'
import type { CoverageRun } from '../coverage/instrument.js'
import { AssertionFailure, IecError, IecLimitError, IecTimeoutError } from '../errors.js'
import { SimClock } from '../interpreter/clock.js'
import { CycleEngine } from '../interpreter/cycle.js'
import { bodyStatements, createEvalContext, disposeFb, instantiateFb } from '../interpreter/pou.js'
import { registerStdlib } from '../interpreter/stdlib/index.js'
import { registerCycleFns } from './cyclefns.js'
import { findForEachRow, registerParams, RowExpansion, type RowContext } from './params.js'
import type { Limits } from '../limits.js'
import { registerMockExpectations } from '../mock/expect.js'
import { registerMock } from '../mock/mock.js'
import { registerMockReturns } from '../mock/returns.js'
import { Session } from '../session.js'
import type { SymbolTable } from '../symbols/table.js'

export interface RunEnv {
  table: SymbolTable
  /** Builds a fresh session per test; use `defaultSessionFactory` for assertions + stdlib and add dialect/simulator registrations on top. */
  sessionFactory: () => Session
  cycleTimeNs: bigint
  hooks?: DialectHooks
  project?: { vendor: string; dialect: string; name: string; projectFile: string }
}

export interface DefaultSessionOptions {
  table: SymbolTable
  limits?: Limits
  /** From `startCoverage`; undefined leaves coverage off. */
  coverage?: CoverageRun
}

/** A session factory registering the assertions (enum names resolved through the table), the IEC standard library, RUN_CYCLES / RUN_UNTIL, MOCK / MOCK_RETURNS, the EXPECT_* call expectations and FOR_EACH_ROW / ROW, and attaching the run's coverage to every session when there is one. */
export function defaultSessionFactory(opts: DefaultSessionOptions): () => Session {
  return () => {
    const session = new Session({ caseSensitive: opts.table.isCaseSensitive, limits: opts.limits })
    registerAssertions(session, opts.table)
    registerStdlib(session)
    registerCycleFns(session)
    registerMock(session)
    registerMockReturns(session)
    registerMockExpectations(session)
    registerParams(session)
    if (opts.coverage !== undefined) {
      session.coverage = opts.coverage.sink
      session.branches = opts.coverage.branches
    }
    return session
  }
}

type Failure = NonNullable<TestResultV1['failure']>

/** Assertion and timeout failures are `failed`; limit, runtime and internal problems are `errored`. */
interface Outcome {
  status: 'failed' | 'errored'
  failure: Failure
}

function classify(e: unknown, testLocation: OriginalLocation): Outcome {
  if (e instanceof AssertionFailure) {
    return { status: 'failed', failure: { kind: 'assertion', message: e.message, expected: e.expected, actual: e.actual, location: e.location } }
  }
  if (e instanceof IecTimeoutError) return { status: 'failed', failure: { kind: 'timeout', message: e.message, location: testLocation } }
  if (e instanceof IecLimitError) return { status: 'errored', failure: { kind: 'limit', message: e.message, location: testLocation } }
  if (e instanceof IecError) return { status: 'errored', failure: { kind: 'runtime', message: e.message, location: testLocation } }
  const message = e instanceof Error ? e.message : String(e)
  return { status: 'errored', failure: { kind: 'runtime', message: `internal error: ${message}`, location: testLocation } }
}

/** Runs `step`, returning the classified failure instead of throwing. */
function attempt(step: () => void, location: OriginalLocation): Outcome | undefined {
  try {
    step()
    return undefined
  } catch (e) {
    return classify(e, location)
  }
}

interface TestRun {
  result: TestResultV1
  session: Session
  /** Set when the test called `FOR_EACH_ROW` on a probe run; `result` is then meaningless. */
  expansion?: RowExpansion
}

/** The test's body statements as `invokeMethod`/`invokeAction` run them, with the id that identifies the body. */
function testBody(desc: SuiteDescriptor, test: TestDescriptor, env: RunEnv): { bodyId: number | undefined; statements: Node[] } {
  const pou = env.table.getPou(desc.suite)
  const key = env.table.normalizeKey(test.name)
  if (desc.kind === 'method') {
    const node = pou?.methods.find((m) => env.table.normalizeKey(m.name) === key)?.bodyNode
    return { bodyId: node?.id, statements: bodyStatements(node) }
  }
  const nodes = pou?.actions.find((a) => env.table.normalizeKey(a.name) === key)?.bodyNodes ?? []
  return { bodyId: nodes[0]?.id, statements: nodes }
}

/** Runs one test; with `row`, the sub-test for that row of a `FOR_EACH_ROW` table. */
function runTest(desc: SuiteDescriptor, test: TestDescriptor, env: RunEnv, row?: RowContext): TestRun {
  const started = performance.now()
  const session = env.sessionFactory()
  const ctx = createEvalContext({ symbols: env.table, session, hooks: env.hooks })
  const engine = new CycleEngine(new SimClock(), env.cycleTimeNs, session)
  ctx.clock = engine

  let expansion: RowExpansion | undefined
  let outcome = attempt(() => {
    session.startDeadline()
    const suite = instantiateFb(desc.suite, ctx)
    session.runtime = { engine, suite, ctx: { ...ctx, self: suite } }
  }, test.location)

  const runtime = session.runtime
  if (runtime !== undefined) {
    // Methods and actions are both reached by bare name with `self` set to the suite, so one path serves both kinds.
    const call = (name: string): void => {
      runtime.ctx.callPou(name, [], runtime.ctx)
    }
    if (desc.setUp !== undefined) {
      const setUp = desc.setUp
      outcome = attempt(() => call(setUp), test.location)
    }
    if (outcome === undefined) {
      session.params = row
      try {
        call(test.name)
      } catch (e) {
        if (e instanceof RowExpansion) expansion = e
        else outcome = classify(e, test.location)
      }
    }
    if (desc.tearDown !== undefined) {
      const tearDown = desc.tearDown
      // Evaluated eagerly: TearDown must run even when the test already failed.
      const tornDown = attempt(() => call(tearDown), test.location)
      outcome ??= tornDown
    }
    const disposed = attempt(() => disposeFb(runtime.suite, runtime.ctx), test.location)
    outcome ??= disposed
  }

  const name = row === undefined ? test.name : `${test.name}[${String(row.index)}]`
  const result: TestResultV1 = {
    name,
    fullName: `${desc.suite}.${name}`,
    status: outcome === undefined ? 'passed' : outcome.status,
    durationMs: performance.now() - started,
    location: test.location,
  }
  if (outcome !== undefined) result.failure = outcome.failure
  return { result, session, expansion }
}

/** Runs a test once, or once per row when it calls `FOR_EACH_ROW`; every row gets a fresh suite instance and reports as `Method[i]`. */
function runWithRows(desc: SuiteDescriptor, test: TestDescriptor, env: RunEnv): TestRun[] {
  const probe = runTest(desc, test, env)
  const expansion = probe.expansion
  if (expansion === undefined) return [probe]

  const { bodyId, statements } = testBody(desc, test, env)
  const at = findForEachRow(statements)
  if (bodyId === undefined || at < 0) {
    const message = 'FOR_EACH_ROW must be a top-level statement of the test'
    return [{ ...probe, result: { ...probe.result, status: 'errored', failure: { kind: 'runtime', message, location: test.location } } }]
  }
  if (expansion.count === 0) {
    const message = `FOR_EACH_ROW: '${expansion.table}' has no rows`
    return [{ ...probe, result: { ...probe.result, status: 'errored', failure: { kind: 'runtime', message, location: test.location } } }]
  }
  return Array.from({ length: expansion.count }, (_, index) => runTest(desc, test, env, { bodyId, from: at + 1, table: expansion.table, index }))
}

export interface SuiteRun {
  result: SuiteResultV1
  sessions: Session[]
}

/** Runs every test of `desc` in isolation and also returns the per-test sessions (for their warnings). */
export function runSuiteDetailed(desc: SuiteDescriptor, env: RunEnv): SuiteRun {
  const started = performance.now()
  const runs = desc.tests.flatMap((t) => runWithRows(desc, t, env))
  return {
    result: { name: desc.suite, location: desc.location, durationMs: performance.now() - started, tests: runs.map((r) => r.result) },
    sessions: runs.map((r) => r.session),
  }
}

export function runSuite(desc: SuiteDescriptor, env: RunEnv): SuiteResultV1 {
  return runSuiteDetailed(desc, env).result
}
