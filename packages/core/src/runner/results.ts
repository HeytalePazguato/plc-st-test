/**
 * Builds the versioned results document (schema v1) from a full run.
 */

import type { RunResultsV1, SuiteDescriptor } from '@plc-st/plugin-api'
import { VERSION } from '../index.js'
import { runSuiteDetailed, type RunEnv } from './isolation.js'

type Warning = RunResultsV1['warnings'][number]

export function runAll(suites: SuiteDescriptor[], env: RunEnv): RunResultsV1 {
  const startedAt = new Date().toISOString()
  const started = performance.now()

  const runs = suites.map((s) => runSuiteDetailed(s, env))
  const results = runs.map((r) => r.result)

  const summary = { total: 0, passed: 0, failed: 0, errored: 0, skipped: 0 }
  for (const t of results.flatMap((s) => s.tests)) {
    summary.total++
    summary[t.status]++
  }

  // Every test has its own session, so a collision warning repeats once per test; keep one copy of identical warnings.
  const warnings: Warning[] = []
  const seen = new Set<string>()
  const add = (w: Warning): void => {
    const key = JSON.stringify([w.code, w.message, w.location])
    if (seen.has(key)) return
    seen.add(key)
    warnings.push(w)
  }
  for (const d of env.table.diagnostics) add({ code: 'SYNTAX', message: d.message, location: d.location })
  for (const w of runs.flatMap((r) => r.sessions.flatMap((s) => s.warnings))) add(w)

  return {
    schemaVersion: 1,
    tool: { name: 'plc-st-test', version: VERSION },
    project: env.project ?? { vendor: 'unknown', dialect: 'unknown', name: 'unknown', projectFile: '' },
    startedAt,
    durationMs: performance.now() - started,
    summary,
    suites: results,
    warnings,
  }
}
