import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  initParser,
  parseSource,
  type ParsedFile,
} from '../src/parser/parse.js'
import { buildSymbolTable } from '../src/symbols/table.js'

function fixture(name: string): ParsedFile {
  const url = new URL(`./fixtures/${name}`, import.meta.url)
  const src = readFileSync(fileURLToPath(url), 'utf8')
  return parseSource(src, name)
}

describe('symbol table', () => {
  beforeAll(async () => {
    await initParser()
  })

  it('resolves enum members and the FB-instance type across files', () => {
    const table = buildSymbolTable([fixture('types.st'), fixture('fb.st')])

    // Enum members (with explicit and auto-incremented values) from types.st.
    const ecolor = table.getEnum('EColor')
    expect(ecolor).toBeDefined()
    expect(ecolor?.members).toEqual([
      { name: 'Red', value: 0 },
      { name: 'Green', value: 3 },
      { name: 'Blue', value: 4 },
    ])

    // Struct from types.st is resolvable.
    const tpoint = table.resolveType('TPoint')
    expect(tpoint?.kind).toBe('struct')

    // FB-instance: helper : FB_Helper inside FB_Main (cross-declaration).
    const fbMain = table.getPou('FB_Main')
    expect(fbMain).toBeDefined()
    const locals = fbMain?.varBlocks.find((b) => b.kind === 'local')
    const helper = locals?.vars.find((v) => v.name === 'helper')
    expect(helper?.instanceOf).toBe('FB_Helper')

    // A non-FB named type is NOT marked as an instance.
    const pick = locals?.vars.find((v) => v.name === 'pick')
    expect(pick?.instanceOf).toBeUndefined()

    // Method and its VAR_INPUT are collected.
    const step = fbMain?.methods.find((m) => m.name === 'Step')
    expect(step).toBeDefined()
    const stepInput = step?.varBlocks.find((b) => b.kind === 'input')
    expect(stepInput?.vars.map((v) => v.name)).toEqual(['delta'])

    // VAR_INPUT/VAR_TEMP block kinds map correctly.
    expect(fbMain?.varBlocks.map((b) => b.kind).sort()).toEqual([
      'input',
      'local',
      'temp',
    ])

    expect(table.diagnostics).toEqual([])
  })

  it('case-insensitive (default) resolves fb_helper to FB_Helper', () => {
    const table = buildSymbolTable([fixture('types.st'), fixture('fb.st')])
    expect(table.getPou('fb_helper')?.name).toBe('FB_Helper')
    expect(table.getPou('FB_HELPER')?.name).toBe('FB_Helper')
    expect(table.getEnum('ecolor')?.typeName).toBe('EColor')
    expect(table.resolveType('tpoint')?.typeName).toBe('TPoint')
  })

  it('caseSensitive: true makes myVar and MyVar distinct keys', () => {
    const src =
      'FUNCTION_BLOCK myVar VAR x : INT; END_VAR END_FUNCTION_BLOCK\n' +
      'FUNCTION_BLOCK MyVar VAR y : INT; END_VAR END_FUNCTION_BLOCK'
    const file = parseSource(src, 'case.st')

    const sensitive = buildSymbolTable([file], { caseSensitive: true })
    expect(sensitive.diagnostics).toEqual([])
    expect(sensitive.getPou('myVar')?.name).toBe('myVar')
    expect(sensitive.getPou('MyVar')?.name).toBe('MyVar')
    // A differently-cased lookup does not hit either entry.
    expect(sensitive.getPou('MYVAR')).toBeUndefined()

    // Case-insensitive collapses them into one (and reports a duplicate).
    const insensitive = buildSymbolTable([file])
    expect(insensitive.diagnostics.length).toBe(1)
  })

  it('duplicate POU name across files yields a diagnostic', () => {
    const table = buildSymbolTable([fixture('dup_a.st'), fixture('dup_b.st')])
    expect(table.diagnostics.length).toBe(1)
    expect(table.diagnostics[0].message).toMatch(/Duplicate POU 'FB_Dup'/)
    // The first declaration wins.
    expect(table.getPou('FB_Dup')?.file).toBe('dup_a.st')
  })
})
