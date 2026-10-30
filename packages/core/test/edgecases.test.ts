import { describe, it, expect, beforeAll } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Language } from 'web-tree-sitter'
import { SourceMap, type Project, type SourceUnit } from '@plc-st/project-model'
import { loadGrammar, baseGrammarPath } from '../src/parser/parse.js'
import { buildSymbolTableFromProject } from '../src/symbols/table.js'
import { discoverSuites } from '../src/runner/discovery.js'
import { defaultSessionFactory, runSuite, type RunEnv } from '../src/runner/isolation.js'

const dir = join(dirname(fileURLToPath(import.meta.url)), 'testdata', 'interpreter')
const files = readdirSync(dir).filter((f) => f.endsWith('.st')).sort()

/** Tests expected not to pass: `<file>:<test>` -> expected status, failure kind and a message fragment. Every other test must pass. */
const EXPECTED_FAILURES: Record<string, { status: 'failed' | 'errored'; kind: string; message: string }> = {
  'division.st:Test_IntDivByZeroErrors': { status: 'errored', kind: 'runtime', message: 'division by zero' },
  'division.st:Test_RealDivByZeroErrors': { status: 'errored', kind: 'runtime', message: 'division by zero' },
  'division.st:Test_LrealDivByZeroErrors': { status: 'errored', kind: 'runtime', message: 'division by zero' },
  'division.st:Test_ModByZeroErrors': { status: 'errored', kind: 'runtime', message: 'division by zero' },
  'arrays.st:Test_IndexBelowLowerBoundErrors': { status: 'errored', kind: 'runtime', message: 'out of' },
  'arrays.st:Test_IndexAboveUpperBoundErrors': { status: 'errored', kind: 'runtime', message: 'out of' },
  'recursion.st:Test_RunawayRecursionHitsLimit': { status: 'errored', kind: 'limit', message: 'maxRecursionDepth' },
}

let lang: Language

function unit(id: string, text: string, file: string): SourceUnit {
  const lines = text.split('\n').length
  return { id, text, role: 'pou', isTest: true, map: SourceMap.fromJSON([{ genStartLine: 1, lineCount: lines, file, origStartLine: 1, origStartCol: 1 }]) }
}

function project(units: SourceUnit[]): Project {
  return { vendor: 'standard', dialect: 'standard', name: 'F', root: '/f', projectFile: '/f/p', units, libraries: [], defines: {}, warnings: [] }
}

function runFixture(file: string) {
  const text = readFileSync(join(dir, file), 'utf8')
  const table = buildSymbolTableFromProject(project([unit(file, text, file)]), lang, { caseSensitive: false })
  const env: RunEnv = { table, sessionFactory: defaultSessionFactory({ table }), cycleTimeNs: 10_000_000n }
  const { suites } = discoverSuites(table, { strategy: 'method' })
  return { text, diagnostics: table.diagnostics, tests: suites.flatMap((s) => runSuite(s, env).tests) }
}

describe('interpreter edge-case battery', () => {
  beforeAll(async () => {
    lang = await loadGrammar(baseGrammarPath())
  })

  it('has the fixtures', () => {
    expect(files.length).toBeGreaterThanOrEqual(20)
  })

  let totalAsserts = 0
  for (const file of files) {
    it(`${file}: header comment, parses cleanly, every test behaves as expected`, () => {
      const { text, diagnostics, tests } = runFixture(file)
      expect(text.trimStart().startsWith('(*') || text.trimStart().startsWith('//')).toBe(true)
      expect(text.split('\n').slice(0, 6).join('\n')).toContain('IEC 61131-3')
      expect(diagnostics).toEqual([])
      expect(tests.length).toBeGreaterThan(0)
      totalAsserts += (text.match(/\bASSERT_\w+\s*\(/g) ?? []).length
      for (const t of tests) {
        const expected = EXPECTED_FAILURES[`${file}:${t.name}`]
        if (expected === undefined) {
          expect(t.failure, `${file}:${t.name}`).toBeUndefined()
          expect(t.status, `${file}:${t.name}`).toBe('passed')
        } else {
          expect(t.status, `${file}:${t.name}`).toBe(expected.status)
          expect(t.failure?.kind, `${file}:${t.name}`).toBe(expected.kind)
          expect(t.failure?.message, `${file}:${t.name}`).toContain(expected.message)
        }
      }
    })
  }

  it('the battery has at least 100 assertions', () => {
    let n = 0
    for (const f of files) n += (readFileSync(join(dir, f), 'utf8').match(/\bASSERT_\w+\s*\(/g) ?? []).length
    expect(n).toBeGreaterThanOrEqual(100)
    expect(totalAsserts).toBeLessThanOrEqual(n)
  })

  it('every expected failure refers to an existing fixture test', () => {
    for (const key of Object.keys(EXPECTED_FAILURES)) {
      const [file, name] = key.split(':')
      expect(files, key).toContain(file)
      expect(readFileSync(join(dir, file), 'utf8'), key).toContain(name)
    }
  })
})
