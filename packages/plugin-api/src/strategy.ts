import type { OriginalLocation } from '@plc-st/project-model'

/** How a dialect maps tests onto POUs: one METHOD per test, one ACTION per test (classic B&R), or either. */
export type TestStrategyKind = 'method' | 'action' | 'method-or-action'

export interface TestDescriptor {
  name: string
  location: OriginalLocation
}

/** A discovered test suite and its tests, plus optional set-up/tear-down/cycle members. */
export interface SuiteDescriptor {
  suite: string
  tests: TestDescriptor[]
  setUp?: string
  tearDown?: string
  cycle?: string
  kind: 'method' | 'action'
  location: OriginalLocation
}
