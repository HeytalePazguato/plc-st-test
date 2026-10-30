/**
 * TAP version 13 reporter, written to `results.tap`: one plan line, one `ok` / `not ok` line per test and a YAML diagnostics block under each problem.
 *
 * Diagnostic values are JSON strings, which are valid double-quoted YAML scalars.
 */

import type { Reporter, RunResultsV1, TestResultV1 } from '@plc-st/plugin-api'

function description(fullName: string): string {
  return fullName.replace(/\r?\n|\r/g, ' ').replace(/[\\#]/g, (c) => `\\${c}`)
}

function diagnostics(test: TestResultV1): string[] {
  const f = test.failure
  const yaml = ['  ---', `  message: ${JSON.stringify(f?.message ?? test.status)}`, `  severity: ${test.status === 'failed' ? 'fail' : 'error'}`]
  if (f) {
    yaml.push(`  kind: ${f.kind}`)
    if (f.expected !== undefined) yaml.push(`  expected: ${JSON.stringify(f.expected)}`)
    if (f.actual !== undefined) yaml.push(`  actual: ${JSON.stringify(f.actual)}`)
    yaml.push(`  at: ${JSON.stringify(`${f.location.file}:${String(f.location.line)}`)}`)
  }
  yaml.push('  ...')
  return yaml
}

/** Render `results` as TAP 13. */
export function renderTap(results: RunResultsV1): string {
  const tests = results.suites.flatMap((s) => s.tests)
  const lines = ['TAP version 13', `1..${String(tests.length)}`]
  tests.forEach((t, i) => {
    const ok = t.status === 'passed' || t.status === 'skipped'
    lines.push(`${ok ? 'ok' : 'not ok'} ${String(i + 1)} - ${description(t.fullName)}${t.status === 'skipped' ? ' # SKIP' : ''}`)
    if (!ok) lines.push(...diagnostics(t))
  })
  return `${lines.join('\n')}\n`
}

export const tapReporter: Reporter = {
  id: 'tap',
  async onRunEnd(results, io) {
    await io.writeFile('results.tap', renderTap(results))
  },
}
