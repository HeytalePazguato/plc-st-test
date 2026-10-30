import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import type { ReporterIo, RunResultsV1, TestResultV1 } from '@plc-st/plugin-api'
import { githubReporter, renderGithubSummary } from '../src/reporters/github.js'
import { escapeWorkflowData, escapeWorkflowProperty } from '../src/reporters/escape.js'

const loc = (line: number, file = 'Tests/TEST_X.TcPOU') => ({ file, line, col: 3 })

function test(name: string, status: TestResultV1['status'], extra: Partial<TestResultV1> = {}): TestResultV1 {
  return { name, fullName: `TEST_X.${name}`, status, durationMs: 1, location: loc(5), ...extra }
}

function results(tests: TestResultV1[], extra: Partial<RunResultsV1> = {}): RunResultsV1 {
  const count = (s: TestResultV1['status']) => tests.filter((t) => t.status === s).length
  return {
    schemaVersion: 1,
    tool: { name: 'plc-st-test', version: '0.0.0' },
    project: { vendor: 'generic', dialect: 'standard', name: 'p', projectFile: 'p.xml' },
    startedAt: '2026-01-01T00:00:00.000Z',
    durationMs: 40,
    summary: { total: tests.length, passed: count('passed'), failed: count('failed'), errored: count('errored'), skipped: count('skipped') },
    suites: [{ name: 'TEST_X', location: loc(1), durationMs: 3, tests }],
    warnings: [],
    ...extra,
  }
}

async function run(res: RunResultsV1, env: Record<string, string | undefined> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'gh-reporter-'))
  const summary = join(dir, 'summary.md')
  const out: string[] = []
  const io: ReporterIo = { outDir: dir, writeFile: async () => undefined, stdout: (t) => void out.push(t), env: { GITHUB_STEP_SUMMARY: summary, ...env } }
  try {
    await githubReporter.onRunEnd(res, io)
    const text = await readFile(summary, 'utf8').catch(() => undefined)
    return { stdout: out.join(''), summary: text }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('workflow escaping', () => {
  it('escapes data', () => expect(escapeWorkflowData('100%\r\nx:y,z')).toBe('100%25%0D%0Ax:y,z'))
  it('escapes properties additionally for : and ,', () => expect(escapeWorkflowProperty('a:b,c%\n')).toBe('a%3Ab%2Cc%25%0A'))
})

describe('github reporter', () => {
  it('writes one ::error per failure and cannot be used to inject commands', async () => {
    const failed = test('Test_1', 'failed', { failure: { kind: 'assertion', message: 'x\n::add-mask::secret', location: loc(9) } })
    const { stdout } = await run(results([failed]))
    const lines = stdout.split('\n').filter(Boolean)
    expect(lines).toEqual(['::error file=Tests/TEST_X.TcPOU,line=9,col=3,title=TEST_X.Test_1::x%0A::add-mask::secret'])
  })

  it('escapes property values and makes paths workspace-relative with forward slashes', async () => {
    const t = test('T,1', 'errored', { fullName: 'S.T,1: a', failure: { kind: 'runtime', message: 'boom', location: loc(2, 'C:\\ws\\Tests\\a,b.st') } })
    const { stdout } = await run(results([t]), { GITHUB_WORKSPACE: 'C:\\ws' })
    if (process.platform === 'win32') expect(stdout).toBe('::error file=Tests/a%2Cb.st,line=2,col=3,title=S.T%2C1%3A a::boom\n')
    else expect(stdout).toContain('title=S.T%2C1%3A a::boom')
  })

  it('reports warnings as ::warning', async () => {
    const { stdout } = await run(results([], { warnings: [{ code: 'LIBRARY_AUTOSTUBBED', message: 'stubbed', location: loc(4) }] }))
    expect(stdout).toBe('::warning file=Tests/TEST_X.TcPOU,line=4,col=3,title=LIBRARY_AUTOSTUBBED::stubbed\n')
  })

  it('appends the summary to GITHUB_STEP_SUMMARY and keeps it off stdout', async () => {
    const failed = test('Test_1', 'failed', { failure: { kind: 'assertion', message: 'a | `b` <i>', location: loc(9) } })
    const cov = { branchesTotal: 4, branchesHit: 3, pous: [] }
    const { stdout, summary } = await run(results([test('Test_0', 'passed'), failed], { coverage: cov }))
    expect(stdout).not.toContain('Branch coverage')
    expect(stdout).not.toContain('| Total')
    expect(summary).toContain('| 2 | 1 | 1 | 0 | 0 |')
    expect(summary).toContain('[Tests/TEST_X.TcPOU:9](Tests/TEST_X.TcPOU#L9)')
    expect(summary).toContain('a \\| \\`b\\` &lt;i>')
    expect(summary).toContain('75.0 %')
  })

  it('writes no summary without GITHUB_STEP_SUMMARY', async () => {
    const { summary } = await run(results([]), { GITHUB_STEP_SUMMARY: undefined })
    expect(summary).toBeUndefined()
  })

  it('omits the failed table when everything passed', () => {
    expect(renderGithubSummary(results([test('a', 'passed')]))).not.toContain('Failed tests')
  })
})
