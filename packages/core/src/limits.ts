/**
 * Execution limits that guard the interpreter against runaway code.
 *
 * These defaults are used until the config loader (task 4.5) parses `plc-st-test.config.yml` and supplies real values; 4.5 produces this same `Limits` shape. Values mirror the `limits:` block in the spec's config example.
 */
export interface Limits {
  maxRecursionDepth: number
  maxLoopIterations: number
  maxCyclesPerTest: number
  maxExecutionTimeMs: number
  /** Scalar slots (every scalar, enum or opaque struct counts 1) one test may allocate across all variables and instances. */
  maxAllocatedElements: number
  /** Longest STRING/WSTRING capacity a declaration may request. */
  maxStringLength: number
}

export const DEFAULT_LIMITS: Limits = {
  maxRecursionDepth: 100,
  maxLoopIterations: 1_000_000,
  maxCyclesPerTest: 100_000,
  maxExecutionTimeMs: 30_000,
  maxAllocatedElements: 10_000_000,
  maxStringLength: 65_535,
}
