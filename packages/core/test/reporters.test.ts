import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import type { ReporterIo, RunResultsV1, TestResultV1 } from '@plc-st/plugin-api'
import { junitReporter, renderJunit } from '../src/reporters/junit.js'
import { jsonReporter } from '../src/reporters/json.js'
import { tapReporter, renderTap } from '../src/reporters/tap.js'
import { createTerminalReporter } from '../src/reporters/terminal.js'
import { escapeXml } from '../src/reporters/escape.js'

const loc = (line: number) => ({ file: 'Tests/TEST_X.TcPOU', line, col: 1 })

function test(name: string, status: TestResultV1['status'], extra: Partial<TestResultV1> = {}): TestResultV1 {
  return { name, fullName: `TEST_X.${name}`, status, durationMs: 12, location: loc(5), ...extra }
}

function results(tests: TestResultV1[], warnings: RunResultsV1['warnings'] = []): RunResultsV1 {
  const count = (s: TestResultV1['status']) => tests.filter((t) => t.status === s).length
  return {
    schemaVersion: 1,
    tool: { name: 'plc-st-test', version: '0.0.0' },
    project: { vendor: 'generic', dialect: 'standard', name: 'p', projectFile: 'p.xml' },
    startedAt: '2026-01-01T00:00:00.000Z',
    durationMs: 40,
    summary: { total: tests.length, passed: count('passed'), failed: count('failed'), errored: count('errored'), skipped: count('skipped') },
    suites: [{ name: 'TEST_X', location: loc(1), durationMs: 30, tests }],
    warnings,
  }
}

const failing = test('Test_2', 'failed', { failure: { kind: 'assertion', message: 'values differ', expected: '1', actual: '2', location: loc(9) } })
const mixed = results([
  test('Test_1', 'passed'),
  failing,
  test('Test_3', 'errored', { failure: { kind: 'runtime', message: 'division by zero', location: loc(20) } }),
  test('Test_4', 'failed', { failure: { kind: 'timeout', message: 'RUN_UNTIL timed out', location: loc(30) } }),
  test('Test_5', 'skipped'),
])

function io(env: Record<string, string | undefined> = {}) {
  const files = new Map<string, string>()
  const out: string[] = []
  const api: ReporterIo = { outDir: 'out', writeFile: async (n, d) => void files.set(n, d), stdout: (t) => void out.push(t), env }
  return { api, files, out: () => out.join('') }
}

// A minimal XML reader (elements, attributes, text) for generated documents and for the XSD itself.
interface El {
  name: string
  attrs: Record<string, string>
  children: El[]
  text: string
}

function unescape(s: string): string {
  return s.replace(/&(lt|gt|quot|apos|amp);/g, (_, e: string) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[e] as string)
}

function parseXml(xml: string): El {
  const root: El = { name: '#root', attrs: {}, children: [], text: '' }
  const stack = [root]
  const re = /<\?[\s\S]*?\?>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+="[^"]*")*)\s*(\/?)>|([^<]+)/g
  for (const m of xml.matchAll(re)) {
    const top = stack[stack.length - 1] as El
    if (m[5] !== undefined) {
      top.text += unescape(m[5])
    } else if (m[2] !== undefined) {
      if (m[1]) {
        expect(top.name, 'closing tag matches').toBe(m[2])
        stack.pop()
      } else {
        const attrs: Record<string, string> = {}
        for (const a of (m[3] ?? '').matchAll(/([\w:.-]+)="([^"]*)"/g)) attrs[a[1] as string] = unescape(a[2] as string)
        const el: El = { name: m[2], attrs, children: [], text: '' }
        top.children.push(el)
        if (!m[4]) stack.push(el)
      }
    }
  }
  expect(stack, 'all elements closed').toHaveLength(1)
  expect(root.children, 'single root').toHaveLength(1)
  return root.children[0] as El
}

interface ElementRule {
  required: string[]
  allowed: string[]
  children: Map<string, ElementRule>
}

function rulesFromXsd(xsd: El): ElementRule {
  const rule = (element: El): ElementRule => {
    const rules: ElementRule = { required: [], allowed: [], children: new Map() }
    const walk = (el: El): void => {
      for (const c of el.children) {
        if (c.name === 'xs:attribute') {
          rules.allowed.push(c.attrs.name as string)
          if (c.attrs.use === 'required') rules.required.push(c.attrs.name as string)
        } else if (c.name === 'xs:element') rules.children.set(c.attrs.name as string, rule(c))
        else walk(c)
      }
    }
    walk(element)
    return rules
  }
  return rule({ name: 'xs:root', attrs: {}, children: xsd.children, text: '' })
}

function validate(el: El, rule: ElementRule, path = ''): string[] {
  const here = `${path}/${el.name}`
  const errors: string[] = []
  for (const a of rule.required) if (!(a in el.attrs)) errors.push(`${here}: missing @${a}`)
  for (const a of Object.keys(el.attrs)) if (!rule.allowed.includes(a)) errors.push(`${here}: unexpected @${a}`)
  for (const c of el.children) {
    const childRule = rule.children.get(c.name)
    if (childRule) errors.push(...validate(c, childRule, here))
    else errors.push(`${here}: unexpected <${c.name}>`)
  }
  return errors
}

const xsdRules = rulesFromXsd(parseXml(readFileSync(new URL('./fixtures/junit.xsd', import.meta.url), 'utf8')))

function check(xml: string): string[] {
  const root = parseXml(xml)
  const rule = xsdRules.children.get(root.name)
  return rule ? validate(root, rule) : [`unexpected root <${root.name}>`]
}

describe('escapeXml', () => {
  it('drops characters XML 1.0 cannot represent', () => {
    expect(escapeXml('a\u0000b\u001Fc\ud800d￾e\tf')).toBe('abcde\tf')
  })
})

describe('junit reporter', () => {
  it('produces a document that validates against the bundled XSD', () => {
    expect(check(renderJunit(mixed))).toEqual([])
    expect(check(renderJunit(results([])))).toEqual([])
  })

  it('rejects documents that miss required attributes (the check itself works)', () => {
    expect(check('<testsuites><testsuite name="a"/></testsuites>').length).toBeGreaterThan(0)
  })

  it('yields <failure> with a message, expected/actual and location for a failing test', () => {
    const suite = parseXml(renderJunit(mixed)).children[0] as El
    expect(suite.attrs).toMatchObject({ name: 'TEST_X', tests: '5', failures: '2', errors: '1', skipped: '1' })
    const [, failure, error, timeout, skipped] = suite.children
    expect(failure?.attrs).toMatchObject({ name: 'Test_2', classname: 'TEST_X', file: 'Tests/TEST_X.TcPOU', line: '5', time: '0.012' })
    const f = failure?.children[0] as El
    expect(f.name).toBe('failure')
    expect(f.attrs).toEqual({ message: 'values differ', type: 'assertion' })
    expect(f.text).toBe('expected: 1\nactual: 2\nat Tests/TEST_X.TcPOU:9')
    expect(error?.children[0]).toMatchObject({ name: 'error', attrs: { type: 'runtime' } })
    expect(timeout?.children[0]).toMatchObject({ name: 'failure', attrs: { type: 'timeout' } })
    expect(skipped?.children[0]?.name).toBe('skipped')
  })

  it('stays well-formed for a name containing ]]><script>', () => {
    const evil = ']]><script>alert(1)</script>"&\'\u0001'
    const xml = renderJunit(results([test(evil, 'failed', { fullName: evil, failure: { kind: 'assertion', message: evil, expected: evil, location: loc(1) } })]))
    expect(xml).not.toContain('<script')
    expect(xml).not.toContain(']]>')
    expect(check(xml)).toEqual([])
    const tc = (parseXml(xml).children[0] as El).children[0] as El
    expect(tc.attrs.name).toBe(']]><script>alert(1)</script>"&\'')
  })

  it('writes junit.xml', async () => {
    const t = io()
    await junitReporter.onRunEnd(mixed, t.api)
    expect(t.files.get('junit.xml')).toBe(renderJunit(mixed))
  })
})

describe('json reporter', () => {
  it('writes results.json that round-trips', async () => {
    const t = io()
    await jsonReporter.onRunEnd(mixed, t.api)
    expect(JSON.parse(t.files.get('results.json') as string)).toEqual(mixed)
  })

  it('refuses invalid results', async () => {
    const bad = { ...mixed, schemaVersion: 2 } as unknown as RunResultsV1
    await expect(jsonReporter.onRunEnd(bad, io().api)).rejects.toThrow(/results v1 schema/)
  })
})

describe('tap reporter', () => {
  it('has the version line, one plan line and one result line per test', () => {
    const lines = renderTap(mixed).trimEnd().split('\n')
    expect(lines[0]).toBe('TAP version 13')
    expect(lines.filter((l) => /^1\.\.\d+$/.test(l))).toEqual(['1..5'])
    expect(lines.filter((l) => /^(not )?ok /.test(l))).toHaveLength(5)
    expect(lines).toContain('ok 5 - TEST_X.Test_5 # SKIP')
  })

  it('gives each problem a YAML diagnostics block', () => {
    const tap = renderTap(mixed)
    expect(tap).toContain('not ok 2 - TEST_X.Test_2\n  ---\n  message: "values differ"\n  severity: fail\n  kind: assertion\n  expected: "1"\n  actual: "2"\n  at: "Tests/TEST_X.TcPOU:9"\n  ...')
  })

  it('writes results.tap', async () => {
    const t = io()
    await tapReporter.onRunEnd(mixed, t.api)
    expect(t.files.get('results.tap')).toBe(renderTap(mixed))
  })

  it('writes 1..0 for no tests', () => {
    expect(renderTap(results([]))).toBe('TAP version 13\n1..0\n')
  })
})

describe('terminal reporter', () => {
  const warnings = [
    { code: 'LIBRARY_AUTOSTUBBED', message: 'MC_Power stubbed', location: loc(3) },
    { code: 'LIBRARY_AUTOSTUBBED', message: 'MC_Home stubbed' },
    { code: 'OTHER', message: 'something' },
  ]
  const full = results(mixed.suites[0]?.tests ?? [], warnings)

  async function run(isTTY: boolean, env: Record<string, string | undefined> = {}) {
    const t = io(env)
    await createTerminalReporter({ isTTY }).onRunEnd(full, t.api)
    return t.out()
  }

  it('has no ANSI codes when piped', async () => {
    // eslint-disable-next-line no-control-regex
    expect(await run(false)).not.toMatch(/\u001b/)
  })

  it('has no ANSI codes when NO_COLOR is set, even on a TTY', async () => {
    // eslint-disable-next-line no-control-regex
    expect(await run(true, { NO_COLOR: '1' })).not.toMatch(/\u001b/)
  })

  it('uses ANSI codes on a TTY', async () => {
    // eslint-disable-next-line no-control-regex
    expect(await run(true)).toMatch(/\u001b\[/)
  })

  it('prints failures with file:line, grouped warnings and a summary line', async () => {
    const out = await run(false)
    expect(out).toContain('FAIL TEST_X.Test_2  Tests/TEST_X.TcPOU:9\n  values differ\n  expected: 1\n  actual:   2')
    expect(out).toContain('ERROR TEST_X.Test_3  Tests/TEST_X.TcPOU:20')
    expect(out).toContain('  LIBRARY_AUTOSTUBBED (2)\n    MC_Power stubbed  Tests/TEST_X.TcPOU:3\n    MC_Home stubbed\n  OTHER (1)')
    expect(out).toContain('Tests: 1 passed, 2 failed, 1 errored, 1 skipped of 5 (40 ms)')
  })
})
