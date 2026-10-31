import { describe, it, expect, beforeAll } from 'vitest'
import type { Language } from 'web-tree-sitter'
import { SourceMap, type Project, type SourceUnit } from '@plc-st/project-model'
import { loadGrammar, baseGrammarPath } from '../src/parser/parse.js'
import { buildSymbolTableFromProject } from '../src/symbols/table.js'
import { IecError } from '../src/errors.js'

let lang: Language

function project(units: SourceUnit[]): Project {
  return {
    vendor: 'beckhoff',
    dialect: 'beckhoff',
    name: 'Fixture',
    root: '/fixture',
    projectFile: '/fixture/Fixture.plcproj',
    units,
    libraries: [],
    defines: {},
    warnings: [],
  }
}

/** A unit whose generated line 1 is `origStartLine` of `file`. */
function unit(fields: Partial<SourceUnit> & { id: string; text: string }, file: string, origStartLine = 1): SourceUnit {
  const lines = fields.text.split('\n').length
  return {
    role: 'pou',
    isTest: false,
    map: SourceMap.fromJSON([{ genStartLine: 1, lineCount: lines, file, origStartLine, origStartCol: 1 }]),
    ...fields,
  }
}

const FB_CONVEYOR = [
  'FUNCTION_BLOCK FB_Conveyor',
  'VAR',
  '  bRunning : BOOL;',
  '  nCount : INT;',
  'END_VAR',
  'nCount := nCount + 1;',
  'END_FUNCTION_BLOCK',
].join('\n')

const RESET_ACTION = ['bRunning := FALSE;', 'nCount := 0;'].join('\n')

const TEST_CONVEYOR = [
  'FUNCTION_BLOCK TEST_Conveyor',
  'VAR',
  '  fb : FB_Conveyor;',
  'END_VAR',
  'END_FUNCTION_BLOCK',
].join('\n')

function conveyorProject(): Project {
  return project([
    unit({ id: 'pou:FB_Conveyor', text: FB_CONVEYOR }, 'POUs/FB_Conveyor.TcPOU', 10),
    unit({ id: 'action:FB_Conveyor.Reset', role: 'action', owner: 'FB_Conveyor', name: 'Reset', text: RESET_ACTION }, 'POUs/FB_Conveyor.TcPOU', 30),
    unit({ id: 'pou:TEST_Conveyor', text: TEST_CONVEYOR, isTest: true }, 'Tests/TEST_Conveyor.TcPOU', 5),
  ])
}

describe('buildSymbolTableFromProject', () => {
  beforeAll(async () => {
    lang = await loadGrammar(baseGrammarPath())
  })

  it('attaches actions to their owner and records isTest / unitId', () => {
    const table = buildSymbolTableFromProject(conveyorProject(), lang, { caseSensitive: false })
    expect(table.diagnostics).toEqual([])

    const fb = table.getPou('FB_Conveyor')
    expect(fb?.actions.map((a) => a.name)).toEqual(['Reset'])
    expect(fb?.actions[0].unitId).toBe('action:FB_Conveyor.Reset')
    expect(fb?.actions[0].bodyNodes.map((n) => n.text)).toEqual(['bRunning := FALSE;', 'nCount := 0;'])
    expect(fb?.isTest).toBe(false)
    expect(fb?.unitId).toBe('pou:FB_Conveyor')
    expect(fb?.file).toBe('POUs/FB_Conveyor.TcPOU')

    const test = table.getPou('TEST_Conveyor')
    expect(test?.isTest).toBe(true)
    expect(test?.file).toBe('Tests/TEST_Conveyor.TcPOU')

    // FB instances resolve across units.
    const inst = test?.varBlocks[0].vars.find((v) => v.name === 'fb')
    expect(inst?.instanceOf).toBe('FB_Conveyor')
  })

  it('locates nodes in POU units and inside action fragments', () => {
    const table = buildSymbolTableFromProject(conveyorProject(), lang, { caseSensitive: false })
    const fb = table.getPou('FB_Conveyor')
    expect(fb?.bodyNode).toBeDefined()
    if (fb?.bodyNode === undefined) return
    expect(table.locate(fb.bodyNode)).toEqual({ file: 'POUs/FB_Conveyor.TcPOU', line: 10, col: 1 })

    // Second action statement is generated line 2 → original line 31 (the wrapper's line is subtracted).
    const second = fb.actions[0].bodyNodes[1]
    expect(table.locate(second)).toEqual({ file: 'POUs/FB_Conveyor.TcPOU', line: 31, col: 1 })
    // A freshly obtained wrapper of a nested node still resolves (identity is by tree, not by Node object).
    const lhs = second.childForFieldName('left') ?? second.namedChildren[0]
    expect(table.locate(lhs).line).toBe(31)
  })

  it('maps syntax errors through the unit source map', () => {
    const broken = ['FUNCTION_BLOCK FB_X', 'x := ;', 'END_FUNCTION_BLOCK'].join('\n')
    const table = buildSymbolTableFromProject(
      project([unit({ id: 'pou:FB_X', text: broken }, 'FB_X.TcPOU', 39)]),
      lang,
      { caseSensitive: false },
    )
    expect(table.diagnostics.length).toBeGreaterThanOrEqual(1)
    expect(table.diagnostics[0].location.file).toBe('FB_X.TcPOU')
    expect(table.diagnostics[0].location.line).toBe(40)
  })

  it('maps syntax errors inside an action unit', () => {
    const p = conveyorProject()
    p.units[1] = { ...p.units[1], text: 'bRunning := FALSE;\nnCount := ;' }
    const table = buildSymbolTableFromProject(p, lang, { caseSensitive: false })
    expect(table.getPou('FB_Conveyor')?.actions).toEqual([])
    expect(table.diagnostics.length).toBeGreaterThanOrEqual(1)
    expect(table.diagnostics[0].location).toMatchObject({ file: 'POUs/FB_Conveyor.TcPOU', line: 31 })
  })

  it('reports a missing action owner at the unit start', () => {
    const p = project([
      unit({ id: 'action:FB_Missing.Reset', role: 'action', owner: 'FB_Missing', name: 'Reset', text: RESET_ACTION }, 'POUs/FB_Missing.TcPOU', 12),
    ])
    const table = buildSymbolTableFromProject(p, lang, { caseSensitive: false })
    expect(table.diagnostics).toEqual([
      { location: { file: 'POUs/FB_Missing.TcPOU', line: 12, col: 1 }, message: "action owner 'FB_Missing' not found" },
    ])
  })

  it('resolves the action owner per case mode', () => {
    const lower = () => {
      const p = conveyorProject()
      p.units[1] = { ...p.units[1], owner: 'fb_conveyor' }
      return p
    }
    expect(buildSymbolTableFromProject(lower(), lang, { caseSensitive: false }).getPou('FB_Conveyor')?.actions).toHaveLength(1)
    const strict = buildSymbolTableFromProject(lower(), lang, { caseSensitive: true })
    expect(strict.getPou('FB_Conveyor')?.actions).toEqual([])
    expect(strict.diagnostics.map((d) => d.message)).toEqual(["action owner 'fb_conveyor' not found"])
  })

  it('case-sensitive mode keeps myVar and MyVar distinct', () => {
    const p = project([
      unit({ id: 'a', text: 'FUNCTION_BLOCK myVar VAR x : INT; END_VAR END_FUNCTION_BLOCK' }, 'a.st'),
      unit({ id: 'b', text: 'FUNCTION_BLOCK MyVar VAR y : INT; END_VAR END_FUNCTION_BLOCK' }, 'b.st'),
    ])
    const sensitive = buildSymbolTableFromProject(p, lang, { caseSensitive: true })
    expect(sensitive.diagnostics).toEqual([])
    expect(sensitive.getPou('myVar')?.unitId).toBe('a')
    expect(sensitive.getPou('MyVar')?.unitId).toBe('b')
    expect(sensitive.getPou('MYVAR')).toBeUndefined()

    const insensitive = buildSymbolTableFromProject(p, lang, { caseSensitive: false })
    expect(insensitive.diagnostics.map((d) => d.location.file)).toEqual(['b.st'])
  })

  it('applies preprocess and rejects one that changes the line count', () => {
    const p = conveyorProject()
    const table = buildSymbolTableFromProject(p, lang, {
      caseSensitive: false,
      preprocess: (t) => t.replace('nCount := 0;', 'nCount := 5;'),
    })
    expect(table.getPou('FB_Conveyor')?.actions[0].bodyNodes[1].text).toBe('nCount := 5;')

    expect(() =>
      buildSymbolTableFromProject(p, lang, { caseSensitive: false, preprocess: (t) => `${t}\n` }),
    ).toThrow(IecError)
    expect(() =>
      buildSymbolTableFromProject(p, lang, { caseSensitive: false, preprocess: (t) => `${t}\n` }),
    ).toThrow(/preprocess changed line count/)
  })

  it('throws when locating a node from a foreign tree', () => {
    const a = buildSymbolTableFromProject(conveyorProject(), lang, { caseSensitive: false })
    const b = buildSymbolTableFromProject(conveyorProject(), lang, { caseSensitive: false })
    const node = a.getPou('FB_Conveyor')?.bodyNode
    expect(node).toBeDefined()
    if (node !== undefined) expect(() => b.locate(node)).toThrow(IecError)
  })
})
