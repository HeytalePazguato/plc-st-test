/**
 * Per-run state for the interpreter: registries, hooks, warnings, coverage and mocks.
 *
 * Everything that could be tempting to keep as a module-level mutable registry lives on a `Session` instead, so two sessions in one process (e.g. parallel test files, or an LSP serving several projects) never see each other's host functions, stubs or warnings.
 */
import type { FbStubDef, HostFnDef, NodeHandler } from '@plc-st/plugin-api'
import type { OriginalLocation, ProjectWarning } from '@plc-st/project-model'
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
  readonly mocks: MockStore = new EmptyMockStore()

  constructor({ limits = DEFAULT_LIMITS, caseSensitive }: SessionOptions) {
    this.limits = limits
    this.caseSensitive = caseSensitive
    const onWarn = (code: string, message: string): void => this.warn(code, message)
    this.hostFns = new Registry<HostFnDef>('host function', caseSensitive, onWarn)
    this.fbStubs = new Registry<FbStubDef>('function block stub', caseSensitive, onWarn)
  }

  warn(code: string, message: string, location?: OriginalLocation): void {
    this.warnings.push(location ? { code, message, location } : { code, message })
  }
}
