/**
 * JUnit XML reporter: `<testsuites>` → `<testsuite>` per suite → `<testcase>` per test, written to `junit.xml`.
 *
 * Every string that comes from the results goes through `escapeXml`, so test names, messages and file names cannot break the document.
 */

import type { Reporter, RunResultsV1, SuiteResultV1, TestResultV1 } from '@plc-st/plugin-api'
import { escapeXml } from './escape.js'

function seconds(ms: number): string {
  return (ms / 1000).toFixed(3)
}

function attrs(pairs: [string, string | number][]): string {
  return pairs.map(([k, v]) => ` ${k}="${escapeXml(String(v))}"`).join('')
}

/** The failure or error element of a test, with expected/actual and the failing location as its text. */
function renderProblem(test: TestResultV1): string {
  const f = test.failure
  const tag = test.status === 'failed' ? 'failure' : 'error'
  const type = f?.kind === 'timeout' ? 'timeout' : test.status === 'failed' ? 'assertion' : (f?.kind ?? 'runtime')
  const message = f?.message ?? test.status
  const body: string[] = []
  if (f?.expected !== undefined) body.push(`expected: ${f.expected}`)
  if (f?.actual !== undefined) body.push(`actual: ${f.actual}`)
  if (f) body.push(`at ${f.location.file}:${String(f.location.line)}`)
  return `      <${tag}${attrs([['message', message], ['type', type]])}>${escapeXml(body.join('\n'))}</${tag}>\n`
}

function renderTestCase(suite: SuiteResultV1, test: TestResultV1): string {
  const open = `    <testcase${attrs([['name', test.name], ['classname', suite.name], ['file', test.location.file], ['line', test.location.line], ['time', seconds(test.durationMs)]])}`
  if (test.status === 'passed') return `${open}/>\n`
  const inner = test.status === 'skipped' ? '      <skipped/>\n' : renderProblem(test)
  return `${open}>\n${inner}    </testcase>\n`
}

function count(tests: TestResultV1[], status: TestResultV1['status']): number {
  return tests.filter((t) => t.status === status).length
}

function renderSuite(suite: SuiteResultV1, timestamp: string): string {
  const { tests } = suite
  const head = attrs([['name', suite.name], ['tests', tests.length], ['failures', count(tests, 'failed')], ['errors', count(tests, 'errored')], ['skipped', count(tests, 'skipped')], ['time', seconds(suite.durationMs)], ['timestamp', timestamp]])
  return `  <testsuite${head}>\n${tests.map((t) => renderTestCase(suite, t)).join('')}  </testsuite>\n`
}

/** Render `results` as a JUnit XML document. */
export function renderJunit(results: RunResultsV1): string {
  const { summary } = results
  const head = attrs([['name', results.project.name], ['tests', summary.total], ['failures', summary.failed], ['errors', summary.errored], ['skipped', summary.skipped], ['time', seconds(results.durationMs)]])
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites${head}>\n${results.suites.map((s) => renderSuite(s, results.startedAt)).join('')}</testsuites>\n`
}

export const junitReporter: Reporter = {
  id: 'junit',
  async onRunEnd(results, io) {
    await io.writeFile('junit.xml', renderJunit(results))
  },
}
