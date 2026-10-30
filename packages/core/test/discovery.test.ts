import { describe, it, expect, beforeAll } from 'vitest'
import type { Language } from 'web-tree-sitter'
import { SourceMap, type Project, type SourceUnit } from '@plc-st/project-model'
import { loadGrammar, baseGrammarPath } from '../src/parser/parse.js'
import { buildSymbolTableFromProject } from '../src/symbols/table.js'
import { discoverSuites } from '../src/runner/discovery.js'

let lang: Language

function unit(fields: Partial<SourceUnit> & { id: string; text: string }, file: string): SourceUnit {
  const lines = fields.text.split('\n').length
  return {
    role: 'pou',
    isTest: false,
    map: SourceMap.fromJSON([{ genStartLine: 1, lineCount: lines, file, origStartLine: 1, origStartCol: 1 }]),
    ...fields,
  }
}

function project(units: SourceUnit[]): Project {
  return { vendor: 'standard', dialect: 'standard', name: 'F', root: '/f', projectFile: '/f/p', units, libraries: [], defines: {}, warnings: [] }
}

function fb(name: string, methods: string[]): string {
  return [`FUNCTION_BLOCK ${name}`, ...methods.map((m) => `METHOD ${m}\nEND_METHOD`), 'END_FUNCTION_BLOCK'].join('\n')
}

function action(owner: string, name: string): SourceUnit {
  return unit({ id: `action:${owner}.${name}`, role: 'action', isTest: true, owner, name, text: 'x := 1;' }, `${owner}.st`)
}

function table(units: SourceUnit[], caseSensitive = false) {
  return buildSymbolTableFromProject(project(units), lang, { caseSensitive })
}

describe('discoverSuites', () => {
  beforeAll(async () => {
    lang = await loadGrammar(baseGrammarPath())
  })

  it('discovers method tests with set-up and cycle, ignoring helper FBs and non-test units', () => {
    const t = table([
      unit({ id: 'a', isTest: true, text: fb('TEST_A', ['t1', 't2', 't3', 'SetUp', 'Cycle']) }, 'a.st'),
      unit({ id: 'x', isTest: true, text: fb('FB_X', ['m']) }, 'x.st'),
      unit({ id: 'c', isTest: false, text: fb('TEST_C', ['t1']) }, 'c.st'),
    ])
    const { suites, warnings } = discoverSuites(t, { strategy: 'method', pattern: 'TEST_*' })
    expect(warnings).toEqual([])
    expect(suites).toHaveLength(1)
    expect(suites[0].suite).toBe('TEST_A')
    expect(suites[0].kind).toBe('method')
    expect(suites[0].tests.map((x) => x.name)).toEqual(['t1', 't2', 't3'])
    expect(suites[0].tests[0].location.file).toBe('a.st')
    expect(suites[0].setUp).toBe('SetUp')
    expect(suites[0].cycle).toBe('Cycle')
    expect(suites[0].tearDown).toBeUndefined()
  })

  it('discovers action tests on a PROGRAM under the action strategy', () => {
    const t = table([
      unit({ id: 'b', isTest: true, text: 'PROGRAM TEST_B\nEND_PROGRAM' }, 'b.st'),
      action('TEST_B', 'a1'),
      action('TEST_B', 'a2'),
    ])
    const { suites, warnings } = discoverSuites(t, { strategy: 'action', pattern: 'TEST_*' })
    expect(warnings).toEqual([])
    expect(suites[0].kind).toBe('action')
    expect(suites[0].tests.map((x) => x.name)).toEqual(['a1', 'a2'])
    expect(discoverSuites(t, { strategy: 'method', pattern: 'TEST_*' }).suites).toEqual([])
  })

  it('method-or-action prefers methods, else actions', () => {
    const t = table([
      unit({ id: 'a', isTest: true, text: fb('TEST_A', ['t1']) }, 'a.st'),
      unit({ id: 'b', isTest: true, text: fb('TEST_B', []) }, 'b.st'),
      action('TEST_B', 'act'),
    ])
    const { suites } = discoverSuites(t, { strategy: 'method-or-action', pattern: 'TEST_*' })
    expect(suites.map((s) => [s.suite, s.kind, s.tests.map((x) => x.name)])).toEqual([
      ['TEST_A', 'method', ['t1']],
      ['TEST_B', 'action', ['act']],
    ])
  })

  it('honours the case mode when matching the pattern', () => {
    const units = [unit({ id: 'a', isTest: true, text: fb('Test_A', ['t1']) }, 'a.st')]
    expect(discoverSuites(table(units), { strategy: 'method', pattern: 'TEST_*' }).suites).toHaveLength(1)
    expect(discoverSuites(table(units, true), { strategy: 'method', pattern: 'TEST_*' }).suites).toHaveLength(0)
    expect(discoverSuites(table(units, true), { strategy: 'method', pattern: 'Test_?' }).suites).toHaveLength(1)
  })

  it('warns SUITE_EMPTY for a suite without tests', () => {
    const t = table([unit({ id: 'e', isTest: true, text: fb('TEST_E', ['SetUp']) }, 'e.st')])
    const { suites, warnings } = discoverSuites(t, { strategy: 'method', pattern: 'TEST_*' })
    expect(suites[0].tests).toEqual([])
    expect(warnings.map((w) => w.code)).toEqual(['SUITE_EMPTY'])
  })
})
