import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { validateResultsV1, type RunResultsV1 } from '../src/index.js'

const schema = JSON.parse(readFileSync(new URL('../schema/results-v1.schema.json', import.meta.url), 'utf8')) as Record<string, unknown>

const loc = { file: 'Tests/TEST_Foo.st', line: 3, col: 1 }

/** Fully populated sample: every optional property is present so the key-set comparison covers the whole type. */
function sample(): RunResultsV1 {
  return {
    schemaVersion: 1,
    tool: { name: 'plc-st-test', version: '0.0.0' },
    project: { vendor: 'codesys', dialect: 'codesys', name: 'Demo', projectFile: 'Demo.project' },
    startedAt: '2026-01-01T00:00:00.000Z',
    durationMs: 12,
    summary: { total: 1, passed: 0, failed: 1, errored: 0, skipped: 0 },
    suites: [
      {
        name: 'TEST_Foo',
        location: loc,
        durationMs: 5,
        tests: [
          {
            name: 'Bar',
            fullName: 'TEST_Foo.Bar',
            status: 'failed',
            durationMs: 2,
            location: loc,
            failure: { kind: 'assertion', message: 'not equal', expected: '1', actual: '2', location: loc },
          },
        ],
      },
    ],
    warnings: [{ code: 'W001', message: 'careful', location: loc }],
    coverage: {
      branchesTotal: 4,
      branchesHit: 3,
      pous: [{ name: 'Foo', file: 'Foo.st', branchesTotal: 4, branchesHit: 3, missed: [{ line: 7, kind: 'if-else' }] }],
    },
  }
}

type Json = Record<string, unknown>

function resolve(node: Json, root: Json): Json {
  const ref = node.$ref
  if (typeof ref !== 'string') return node
  return ref
    .replace(/^#\//, '')
    .split('/')
    .reduce<Json>((acc, k) => acc[k] as Json, root)
}

/** Collects `path -> sorted property names` for every object in the sample, walking arrays by their element. */
function sampleKeys(value: unknown, path: string, out: Map<string, string[]>): void {
  if (Array.isArray(value)) {
    for (const v of value) sampleKeys(v, `${path}[]`, out)
  } else if (typeof value === 'object' && value !== null) {
    out.set(path, Object.keys(value).sort())
    for (const [k, v] of Object.entries(value)) sampleKeys(v, `${path}.${k}`, out)
  }
}

function schemaKeys(node: Json, root: Json, path: string, out: Map<string, string[]>): void {
  const n = resolve(node, root)
  if (n.type === 'array') {
    schemaKeys(n.items as Json, root, `${path}[]`, out)
  } else if (n.properties) {
    const props = n.properties as Record<string, Json>
    out.set(path, Object.keys(props).sort())
    for (const [k, v] of Object.entries(props)) schemaKeys(v, root, `${path}.${k}`, out)
  }
}

describe('results schema v1', () => {
  it('uses the fixed schema id and draft 2020-12', () => {
    expect(schema.$id).toBe('https://plc-st.dev/schemas/results-v1.json')
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
  })

  it('validates a fully populated fixture', () => {
    expect(validateResultsV1(sample())).toEqual([])
  })

  it('validates a minimal fixture without optional properties', () => {
    const r = sample()
    delete r.coverage
    r.warnings = [{ code: 'W', message: 'm' }]
    delete r.suites[0]!.tests[0]!.failure
    r.suites[0]!.tests[0]!.status = 'passed'
    expect(validateResultsV1(r)).toEqual([])
  })

  it('reports a missing summary', () => {
    const r = sample() as Partial<RunResultsV1>
    delete r.summary
    const errors = validateResultsV1(r)
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.some((e) => e.includes('summary'))).toBe(true)
  })

  it('reports an invalid status enum with its path', () => {
    const r = sample() as unknown as { suites: { tests: { status: string }[] }[] }
    r.suites[0]!.tests[0]!.status = 'weird'
    expect(validateResultsV1(r)).toEqual([expect.stringContaining('/suites/0/tests/0/status')])
  })

  it('reports an invalid failure kind, unknown properties and non-objects', () => {
    const r = sample() as unknown as { suites: { tests: { failure: { kind: string } }[] }[]; extra?: number }
    r.suites[0]!.tests[0]!.failure.kind = 'nope'
    r.extra = 1
    const errors = validateResultsV1(r)
    expect(errors.some((e) => e.includes('/suites/0/tests/0/failure/kind'))).toBe(true)
    expect(errors.some((e) => e.includes('/extra'))).toBe(true)
    expect(validateResultsV1(null)).not.toEqual([])
    expect(validateResultsV1([])).not.toEqual([])
  })

  it('reports a wrong schemaVersion', () => {
    expect(validateResultsV1({ ...sample(), schemaVersion: 2 })).toContain('/schemaVersion: expected 1')
  })

  it('has the same property key sets as a fully populated sample, recursively', () => {
    const fromSample = new Map<string, string[]>()
    sampleKeys(sample(), '$', fromSample)
    const fromSchema = new Map<string, string[]>()
    schemaKeys(schema, schema, '$', fromSchema)
    expect(Object.fromEntries(fromSchema)).toEqual(Object.fromEntries(fromSample))
  })

  it('requires every non-optional property in both the schema and the validator', () => {
    const optional = new Set(['coverage'])
    const required = new Set(schema.required as string[])
    for (const k of Object.keys(schema.properties as Json)) expect(required.has(k)).toBe(!optional.has(k))
  })
})
