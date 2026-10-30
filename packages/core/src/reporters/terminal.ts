/**
 * Terminal reporter: failures with `file:line`, warnings grouped by code, the coverage table when there is one and a summary line, written through `io.stdout`.
 *
 * Colour comes from `util.styleText` and is used only when stdout is a TTY and `NO_COLOR` is unset; the TTY flag is an option and the environment comes from `io.env`, so both are testable.
 */

import { styleText } from 'node:util'
import type { Reporter, RunResultsV1, TestResultV1 } from '@plc-st/plugin-api'
import { renderCoverageTerminal } from '../coverage/report.js'

type Format = Parameters<typeof styleText>[0]

export interface TerminalReporterOptions {
  /** Whether stdout is a terminal; defaults to `process.stdout.isTTY`. */
  isTTY?: boolean
}

function where(loc: TestResultV1['location']): string {
  return `${loc.file}:${String(loc.line)}`
}

/** Render `results` as terminal text, with ANSI styling when `color` is set. */
export function renderTerminal(results: RunResultsV1, color: boolean): string {
  const paint = (format: Format, text: string): string => (color ? styleText(format, text, { validateStream: false }) : text)
  const lines: string[] = []

  for (const test of results.suites.flatMap((s) => s.tests)) {
    if (test.status !== 'failed' && test.status !== 'errored') continue
    const f = test.failure
    lines.push(`${paint(['red', 'bold'], test.status === 'failed' ? 'FAIL' : 'ERROR')} ${test.fullName}  ${paint('dim', where(f?.location ?? test.location))}`)
    if (f) {
      lines.push(`  ${f.message}`)
      if (f.expected !== undefined) lines.push(`  expected: ${f.expected}`)
      if (f.actual !== undefined) lines.push(`  actual:   ${f.actual}`)
    }
  }

  if (results.warnings.length > 0) {
    const groups = new Map<string, RunResultsV1['warnings']>()
    for (const w of results.warnings) groups.set(w.code, [...(groups.get(w.code) ?? []), w])
    lines.push('', paint('yellow', 'Warnings'))
    for (const [code, items] of groups) {
      lines.push(`  ${paint('yellow', code)} (${String(items.length)})`)
      for (const w of items) lines.push(`    ${w.message}${w.location ? `  ${paint('dim', where(w.location))}` : ''}`)
    }
  }

  if (results.coverage) lines.push('', renderCoverageTerminal(results.coverage))

  const { summary } = results
  const parts = [
    summary.passed > 0 ? paint('green', `${String(summary.passed)} passed`) : undefined,
    summary.failed > 0 ? paint('red', `${String(summary.failed)} failed`) : undefined,
    summary.errored > 0 ? paint('red', `${String(summary.errored)} errored`) : undefined,
    summary.skipped > 0 ? paint('yellow', `${String(summary.skipped)} skipped`) : undefined,
  ].filter((p) => p !== undefined)
  const detail = parts.length > 0 ? `${parts.join(', ')} of ${String(summary.total)}` : '0 tests'
  lines.push('', `Tests: ${detail} (${String(Math.round(results.durationMs))} ms)`)
  return `${lines.join('\n')}\n`
}

export function createTerminalReporter(options: TerminalReporterOptions = {}): Reporter {
  return {
    id: 'terminal',
    async onRunEnd(results, io) {
      const isTTY = options.isTTY ?? process.stdout.isTTY
      io.stdout(renderTerminal(results, isTTY && !io.env.NO_COLOR))
    },
  }
}

export const terminalReporter: Reporter = createTerminalReporter()
