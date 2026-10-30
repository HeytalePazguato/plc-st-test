import { describe, it, expect } from 'vitest'
import { validateResultsV1, type CoverageSummaryV1, type RunResultsV1 } from '@plc-st/plugin-api'
import { checkThreshold, coverageToJson, renderCoverageHtml, renderCoverageTerminal } from '../src/coverage/report.js'
import { escapeHtml, escapeXml } from '../src/reporters/escape.js'

const EVIL = '<img src=x onerror=alert(1)>'

function summary(): CoverageSummaryV1 {
  return {
    branchesTotal: 8,
    branchesHit: 4,
    pous: [
      { name: 'FB_Good', file: 'POUs/FB_Good.TcPOU', branchesTotal: 4, branchesHit: 4, missed: [] },
      { name: EVIL, file: 'POUs/FB_Evil.TcPOU', branchesTotal: 4, branchesHit: 0, missed: [{ line: 12, kind: 'if' }, { line: 14, kind: 'implicit-else' }] },
    ],
  }
}

function results(coverage: CoverageSummaryV1): RunResultsV1 {
  return {
    schemaVersion: 1,
    tool: { name: 'plc-st-test', version: '0.0.0' },
    project: { vendor: 'generic', dialect: 'standard', name: 'p', projectFile: 'p.xml' },
    startedAt: '2026-01-01T00:00:00.000Z',
    durationMs: 1,
    summary: { total: 0, passed: 0, failed: 0, errored: 0, skipped: 0 },
    suites: [],
    warnings: [],
    coverage,
  }
}

describe('checkThreshold', () => {
  it('never fails with threshold 0', () => {
    expect(checkThreshold({ branchesTotal: 4, branchesHit: 0, pous: [] }, 0)).toEqual({ ok: true, worst: [] })
  })

  it('fails 50 % against 80 and names the worst POUs, lowest first', () => {
    const r = checkThreshold(summary(), 80)
    expect(r.ok).toBe(false)
    expect(r.worst).toEqual([`${EVIL} (POUs/FB_Evil.TcPOU) 0.0%`])
  })

  it('passes when the total reaches the threshold', () => {
    expect(checkThreshold(summary(), 50).ok).toBe(true)
  })

  it('treats a summary without branches as fully covered', () => {
    expect(checkThreshold({ branchesTotal: 0, branchesHit: 0, pous: [] }, 100).ok).toBe(true)
  })
})

describe('coverageToJson', () => {
  it('is a copy that validates against the results contract', () => {
    const s = summary()
    const json = coverageToJson(s)
    expect(json).toEqual(s)
    expect(json).not.toBe(s)
    expect(json.pous[1]?.missed).not.toBe(s.pous[1]?.missed)
    expect(validateResultsV1(results(json))).toEqual([])
  })
})

describe('renderCoverageTerminal', () => {
  it('lists POUs, missed branches and the total without ANSI codes', () => {
    const out = renderCoverageTerminal(summary())
    expect(out).toContain('FB_Good')
    expect(out).toContain('100.0%')
    expect(out).toContain('missed: 12 (if), 14 (implicit-else)')
    expect(out).toContain('Total: 50.0% (4/8 branches)')
    expect(out).not.toContain('\u001b')
  })
})

describe('renderCoverageHtml', () => {
  const html = renderCoverageHtml(summary())

  it('is a single file with the CSP and no script', () => {
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`)
    expect(html).toContain('<style>')
    expect(html.toLowerCase()).not.toContain('<script')
  })

  it('escapes a hostile POU name', () => {
    expect(html).not.toContain(EVIL)
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })
})

describe('escape', () => {
  it('escapes HTML metacharacters', () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;')
  })

  it('escapes XML and drops characters XML cannot hold', () => {
    expect(escapeXml(`a<b>&"'\u0000\u0008￾\uD800z\tq`)).toBe('a&lt;b&gt;&amp;&quot;&apos;z\tq')
  })
})
