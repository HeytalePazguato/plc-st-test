/**
 * Renderers for the `CoverageSummaryV1` that `summarizeCoverage` builds: terminal text, the results-contract JSON, a self-contained HTML page and the `--coverage-threshold` check.
 *
 * Percentages are branch coverage, `branchesHit / branchesTotal`; a summary without branches counts as 100 %, since nothing is left uncovered.
 */

import type { CoverageSummaryV1 } from '@plc-st/plugin-api'
import { escapeHtml } from '../reporters/escape.js'

type PouCoverage = CoverageSummaryV1['pous'][number]

function percent(hit: number, total: number): number {
  return total === 0 ? 100 : (hit / total) * 100
}

function formatPercent(hit: number, total: number): string {
  return `${percent(hit, total).toFixed(1)}%`
}

function formatMissed(pou: PouCoverage): string {
  return pou.missed.map((m) => `${String(m.line)} (${m.kind})`).join(', ')
}

/** Plain-text table, one line per POU plus the total; the missed branches follow their POU. No ANSI codes, so the caller decides on colour. */
export function renderCoverageTerminal(summary: CoverageSummaryV1): string {
  const lines = ['Coverage (branches)']
  const width = Math.max(0, ...summary.pous.map((p) => p.name.length))
  for (const pou of summary.pous) {
    lines.push(`  ${pou.name.padEnd(width)}  ${formatPercent(pou.branchesHit, pou.branchesTotal).padStart(6)}  ${String(pou.branchesHit)}/${String(pou.branchesTotal)}  ${pou.file}`)
    if (pou.missed.length > 0) lines.push(`    missed: ${formatMissed(pou)}`)
  }
  lines.push(`Total: ${formatPercent(summary.branchesHit, summary.branchesTotal)} (${String(summary.branchesHit)}/${String(summary.branchesTotal)} branches)`)
  return lines.join('\n')
}

/** A deep copy of `summary` in the results contract's shape, for `RunResultsV1.coverage`; only the contract's fields are kept. */
export function coverageToJson(summary: CoverageSummaryV1): CoverageSummaryV1 {
  return {
    branchesTotal: summary.branchesTotal,
    branchesHit: summary.branchesHit,
    pous: summary.pous.map((p) => ({
      name: p.name,
      file: p.file,
      branchesTotal: p.branchesTotal,
      branchesHit: p.branchesHit,
      missed: p.missed.map((m) => ({ line: m.line, kind: m.kind })),
    })),
  }
}

const HTML_STYLE = 'body{font-family:sans-serif;margin:2em}table{border-collapse:collapse}th,td{border:1px solid #ccc;padding:.3em .8em;text-align:left}th{background:#f4f4f4}.bar{display:inline-block;width:8em;height:.8em;background:#f8d0d0;vertical-align:middle}.fill{display:block;height:100%;background:#6c6}.pct{text-align:right}'

// The width comes from a number, never from the input text.
function htmlBar(hit: number, total: number): string {
  return `<span class="bar"><span class="fill" style="width:${percent(hit, total).toFixed(1)}%"></span></span>`
}

/** One self-contained page: inline CSS, no script, and a CSP that forbids everything but that CSS. Every string from the summary is escaped. */
export function renderCoverageHtml(summary: CoverageSummaryV1): string {
  const rows = summary.pous.map(
    (p) =>
      `<tr><td>${escapeHtml(p.name)}</td><td>${escapeHtml(p.file)}</td><td class="pct">${formatPercent(p.branchesHit, p.branchesTotal)}</td><td>${htmlBar(p.branchesHit, p.branchesTotal)}</td><td>${String(p.branchesHit)}/${String(p.branchesTotal)}</td><td>${escapeHtml(formatMissed(p))}</td></tr>`,
  )
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`,
    '<title>Branch coverage</title>',
    `<style>${HTML_STYLE}</style>`,
    '</head>',
    '<body>',
    '<h1>Branch coverage</h1>',
    `<p>Total: ${formatPercent(summary.branchesHit, summary.branchesTotal)} (${String(summary.branchesHit)}/${String(summary.branchesTotal)} branches)</p>`,
    '<table>',
    '<thead><tr><th>POU</th><th>File</th><th>Coverage</th><th></th><th>Branches</th><th>Missed (line, kind)</th></tr></thead>',
    `<tbody>${rows.join('')}</tbody>`,
    '</table>',
    '</body>',
    '</html>',
    '',
  ].join('\n')
}

/** Whether the total branch coverage reaches `threshold` percent. `worst` names the POUs below it, lowest first, as `name (file) pct`; threshold 0 is always ok. */
export function checkThreshold(summary: CoverageSummaryV1, threshold: number): { ok: boolean; worst: string[] } {
  if (threshold <= 0 || percent(summary.branchesHit, summary.branchesTotal) >= threshold) return { ok: true, worst: [] }
  const worst = summary.pous
    .map((pou) => ({ pou, pct: percent(pou.branchesHit, pou.branchesTotal) }))
    .filter((e) => e.pct < threshold)
    .sort((a, b) => a.pct - b.pct)
    .map(({ pou, pct }) => `${pou.name} (${pou.file}) ${pct.toFixed(1)}%`)
  return { ok: false, worst }
}
