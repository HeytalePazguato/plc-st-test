/**
 * Per-run state for the interpreter: registries, hooks, warnings, coverage and mocks.
 *
 * Everything that could be tempting to keep as a module-level mutable registry lives on a `Session` instead, so two sessions in one process (e.g. parallel test files, or an LSP serving several projects) never see each other's host functions, stubs or warnings.
 */
import type { FbStubDef, HostFnDef, NodeHandler } from '@plc-st/plugin-api'
import type { OriginalLocation, ProjectWarning } from '@plc-st/project-model'
import { IecLimitError } from './errors.js'
import type { EvalContext } from './interpreter/context.js'
import type { CycleEngine } from './interpreter/cycle.js'
import type { FbInstance } from './interpreter/pou.js'
import { DEFAULT_LIMITS, type Limits } from './limits.js'

/** Receives a hit for each covered statement/branch id. */
export interface CoverageSink {
  hit(id: string): void
  snapshot(): Map<string, number>
}

/** Minimal mock store; task 5.2 supplies the real behavior. */
export interface MockStore {
  clear(): void
}

class EmptyMockStore implements MockStore {
  clear(): void {}
}

/** Name-keyed registry; later registrations replace earlier ones and report the collision through `onWarn`. */
export class Registry<T extends { name: string }> {
  private readonly entries = new Map<string, { def: T; source: string }>()

  constructor(
    private readonly kind: string,
    private readonly caseSensitive: boolean,
    private readonly onWarn: (code: string, message: string) => void = () => {},
  ) {}

  private key(name: string): string {
    return this.caseSensitive ? name : name.toLowerCase()
  }

  register(def: T, source: string): void {
    const k = this.key(def.name)
    const previous = this.entries.get(k)
    if (previous) {
      this.onWarn(
        'registry-collision',
        `${this.kind} '${def.name}' registered by '${source}' replaces the one registered by '${previous.source}'`,
      )
    }
    this.entries.set(k, { def, source })
  }

  get(name: string): T | undefined {
    return this.entries.get(this.key(name))?.def
  }

  list(): T[] {
    return [...this.entries.values()].map((e) => e.def)
  }
}

export interface SessionOptions {
  limits?: Limits
  caseSensitive: boolean
}

/** What the running test exposes to host functions such as RUN_CYCLES / RUN_UNTIL: the test's own cycle engine, its suite instance and an eval context whose `self` is that suite. Set by the isolation runner for each test. */
export interface TestRuntime {
  engine: CycleEngine
  suite: FbInstance
  ctx: EvalContext
}

/** Called by the cycle engine with the number of the cycle being run. */
export type SessionHook = (cycle: number) => void

export class Session {
  readonly limits: Limits
  readonly caseSensitive: boolean
  readonly hostFns: Registry<HostFnDef>
  readonly fbStubs: Registry<FbStubDef>
  readonly nodeHandlers = new Map<string, NodeHandler>()
  readonly warnings: ProjectWarning[] = []
  readonly preCycle: SessionHook[] = []
  readonly postCycle: SessionHook[] = []
  coverage?: CoverageSink
  /** The currently running test's engine, suite and context; undefined outside a test. */
  runtime?: TestRuntime
  readonly mocks: MockStore = new EmptyMockStore()
  /** Scalar slots allocated by the current test so far (see `limits.maxAllocatedElements`). */
  allocation = 0
  /** Wall-clock deadline of the current test as a `Date.now()` timestamp; `Infinity` until `startDeadline` is called. */
  deadline = Infinity

  constructor({ limits = DEFAULT_LIMITS, caseSensitive }: SessionOptions) {
    this.limits = limits
    this.caseSensitive = caseSensitive
    const onWarn = (code: string, message: string): void => this.warn(code, message)
    this.hostFns = new Registry<HostFnDef>('host function', caseSensitive, onWarn)
    this.fbStubs = new Registry<FbStubDef>('function block stub', caseSensitive, onWarn)
  }

  /** Starts a test's budgets: the deadline becomes `nowMs + limits.maxExecutionTimeMs` and the allocation counter is reset. */
  startDeadline(nowMs: number = Date.now()): void {
    this.deadline = nowMs + this.limits.maxExecutionTimeMs
    this.allocation = 0
  }

  /** Throws `IecLimitError` once the deadline has passed. */
  checkDeadline(nowMs: number = Date.now()): void {
    if (nowMs > this.deadline) throw new IecLimitError(`test exceeded max_execution_time_ms=${String(this.limits.maxExecutionTimeMs)}`)
  }

  warn(code: string, message: string, location?: OriginalLocation): void {
    this.warnings.push(location ? { code, message, location } : { code, message })
  }
}
