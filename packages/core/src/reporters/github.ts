/**
 * GitHub Actions reporter: `::error` / `::warning` workflow commands on stdout and a Markdown job summary appended to the file named by `GITHUB_STEP_SUMMARY`.
 *
 * Annotation data and properties go through `escapeWorkflowData` / `escapeWorkflowProperty`, so a test message cannot inject further workflow commands (`::add-mask::`, `::set-output`, ...); the summary is never written to stdout.
 */

import { appendFile } from 'node:fs/promises'
import { isAbsolute, relative } from 'node:path'
import type { Reporter, RunResultsV1, TestResultV1 } from '@plc-st/plugin-api'
import { escapeWorkflowData, escapeWorkflowProperty } from './escape.js'

type Location = TestResultV1['location']

/** The file as GitHub wants it: relative to the workspace when it is absolute and inside it, with forward slashes. */
function workspacePath(file: string, workspace: string | undefined): string {
  let path = file
  if (workspace && isAbsolute(file)) {
    const rel = relative(workspace, file)
    if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) path = rel
  }
  return path.replace(/\\/g, '/')
}

function command(kind: 'error' | 'warning', loc: Location | undefined, title: string, message: string, workspace: string | undefined): string {
  const props: string[] = []
  if (loc) props.push(`file=${escapeWorkflowProperty(workspacePath(loc.file, workspace))}`, `line=${String(loc.line)}`, `col=${String(loc.col)}`)
  props.push(`title=${escapeWorkflowProperty(title)}`)
  return `::${kind} ${props.join(',')}::${escapeWorkflowData(message)}`
}

/** Escape `text` for a Markdown table cell: pipes, backticks and `<`, with line breaks flattened. */
function cell(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/`/g, '\\`').replace(/</g, '&lt;').replace(/\r?\n|\r/g, ' ')
}

function link(loc: Location, workspace: string | undefined): string {
  const file = workspacePath(loc.file, workspace)
  const url = `${encodeURI(file).replace(/[()#?]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}#L${String(loc.line)}`
  return `[${cell(`${file}:${String(loc.line)}`)}](${url})`
}

/** The annotation lines for every failed or errored test and every warning in `results`. */
export function renderGithubAnnotations(results: RunResultsV1, workspace?: string): string[] {
  const lines: string[] = []
  for (const test of results.suites.flatMap((s) => s.tests)) {
    if (test.status !== 'failed' && test.status !== 'errored') continue
    const f = test.failure
    lines.push(command('error', f?.location ?? test.location, test.fullName, f?.message ?? test.status, workspace))
  }
  for (const w of results.warnings) lines.push(command('warning', w.location, w.code, w.message, workspace))
  return lines
}

/** The Markdown job summary: totals table, failed tests with links and the coverage percentage. */
export function renderGithubSummary(results: RunResultsV1, workspace?: string): string {
  const { summary } = results
  const out = [
    '## plc-st-test results',
    '',
    '| Total | Passed | Failed | Errored | Skipped |',
    '| ---: | ---: | ---: | ---: | ---: |',
    `| ${String(summary.total)} | ${String(summary.passed)} | ${String(summary.failed)} | ${String(summary.errored)} | ${String(summary.skipped)} |`,
    '',
  ]
  const problems = results.suites.flatMap((s) => s.tests).filter((t) => t.status === 'failed' || t.status === 'errored')
  if (problems.length > 0) {
    out.push('### Failed tests', '', '| Test | Location | Message |', '| --- | --- | --- |')
    for (const t of problems) out.push(`| ${cell(t.fullName)} | ${link(t.failure?.location ?? t.location, workspace)} | ${cell(t.failure?.message ?? t.status)} |`)
    out.push('')
  }
  if (results.coverage) {
    const { branchesHit, branchesTotal } = results.coverage
    const pct = branchesTotal === 0 ? 100 : (branchesHit / branchesTotal) * 100
    out.push(`**Branch coverage:** ${pct.toFixed(1)} % (${String(branchesHit)} of ${String(branchesTotal)} branches)`, '')
  }
  return out.join('\n')
}

export const githubReporter: Reporter = {
  id: 'github',
  async onRunEnd(results, io) {
    const workspace = io.env.GITHUB_WORKSPACE
    for (const line of renderGithubAnnotations(results, workspace)) io.stdout(`${line}\n`)
    const summaryFile = io.env.GITHUB_STEP_SUMMARY
    if (summaryFile) await appendFile(summaryFile, `${renderGithubSummary(results, workspace)}\n`)
  },
}
