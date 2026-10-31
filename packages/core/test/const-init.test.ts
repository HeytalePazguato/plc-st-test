import { describe, it, expect, beforeAll } from 'vitest'
import type { Language } from 'web-tree-sitter'
import { SourceMap, type Project, type SourceUnit } from '@plc-st/project-model'
import { loadGrammar, baseGrammarPath } from '../src/parser/parse.js'
import { buildSymbolTableFromProject } from '../src/symbols/table.js'
import type { IecValue } from '../src/interpreter/values.js'
import { createEvalContext, instantiateFb, type FbInstance } from '../src/interpreter/pou.js'
import { Session } from '../src/session.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import { IecRuntimeError } from '../src/errors.js'

let lang: Language

const TYPES = `
TYPE E_Color : (Red, Green := 5, Blue); END_TYPE
TYPE ST_P : STRUCT a : INT := -3; b : INT; END_STRUCT; END_TYPE
FUNCTION F_One : INT
F_One := 1;
END_FUNCTION
`

/** Instantiate PROGRAM Main with the given VAR declarations (initializers are evaluated at instantiation). */
function load(decls: string[], constants: string[] = []): FbInstance {
  const text = ['PROGRAM Main', 'VAR CONSTANT', ...constants, 'END_VAR', 'VAR', ...decls, 'END_VAR', 'END_PROGRAM'].join('\n')
  const unit = (id: string, src: string): SourceUnit => ({ id, role: 'pou', isTest: false, text: src, map: SourceMap.fromJSON([{ genStartLine: 1, lineCount: src.split('\n').length, file: `${id}.TcPOU`, origStartLine: 1, origStartCol: 1 }]) })
  const project: Project = { vendor: 'beckhoff', dialect: 'beckhoff', name: 'Fixture', root: '/fixture', projectFile: '/fixture/Fixture.plcproj', units: [unit('Types', TYPES), unit('Main', text)], libraries: [], defines: {}, warnings: [] }
  const symbols = buildSymbolTableFromProject(project, lang, { caseSensitive: false })
  expect(symbols.diagnostics).toEqual([])
  const session = new Session({ caseSensitive: false, limits: { ...DEFAULT_LIMITS } })
  return instantiateFb('Main', createEvalContext({ symbols, session }))
}

function get(inst: FbInstance, name: string): IecValue {
  if (inst.value.kind !== 'struct') throw new Error('instance is not a struct')
  const v = [...inst.value.fields.entries()].find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1]
  if (v === undefined) throw new Error(`${name} not found`)
  return v
}

function plain(v: IecValue): unknown {
  if (v.kind === 'scalar') return v.value
  if (v.kind === 'enum') return v.value
  if (v.kind === 'array') return v.data.map(plain)
  return Object.fromEntries([...v.fields].map(([k, f]) => [k, plain(f)]))
}

const value = (decl: string, name = 'x'): unknown => plain(get(load([decl]), name))

describe('constant-expression initializers', () => {
  beforeAll(async () => {
    lang = await loadGrammar(baseGrammarPath())
  })

  it('evaluates a negative scalar literal', () => {
    expect(value('x : INT := -5;')).toBe(-5)
    expect(value('x : LINT := -5;')).toBe(-5n)
    expect(value('x : REAL := -1.5;')).toBe(-1.5)
  })

  it('evaluates negative array elements', () => {
    expect(value('x : ARRAY[1..2] OF INT := [-1, 2];')).toEqual([-1, 2])
  })

  it('evaluates typed literals', () => {
    expect(value('x : INT := INT#-3;')).toBe(-3)
    expect(value('x : REAL := REAL#1.5;')).toBe(1.5)
    expect(value('x : TIME := T#1s500ms;')).toBe(1_500_000_000n)
    expect(value('x : BYTE := BYTE#16#F0;')).toBe(240)
  })

  it('evaluates based literals, parentheses and NOT', () => {
    expect(value('x : INT := 16#FF;')).toBe(255)
    expect(value('x : INT := (1 + 2) * 3;')).toBe(9)
    expect(value('x : BOOL := NOT FALSE;')).toBe(true)
  })

  it('evaluates arithmetic on constants', () => {
    expect(value('x : INT := 2 * 10 + 1;')).toBe(21)
  })

  it('references a VAR CONSTANT declared earlier', () => {
    const inst = load(['x : INT := cMax + 2;', 'y : ARRAY[1..2] OF INT := [cMax, -cMax];'], ['cMax : INT := 40;'])
    expect(plain(get(inst, 'x'))).toBe(42)
    expect(plain(get(inst, 'y'))).toEqual([40, -40])
  })

  it('resolves enum members, qualified and bare', () => {
    expect(value('x : E_Color := E_Color.Blue;')).toBe(6)
    expect(value('x : E_Color := Green;')).toBe(5)
  })

  it('applies initializers to structure fields', () => {
    expect(value('x : ST_P;')).toEqual({ a: -3, b: 0 })
    expect(value('x : ST_P := (a := -7, b := 2 * 3);')).toEqual({ a: -7, b: 6 })
  })

  it('rejects an out-of-range constant instead of wrapping it', () => {
    expect(() => value('sTiny : SINT := -129;')).toThrow(IecRuntimeError)
    expect(() => value('sTiny : SINT := -129;')).toThrow(/sTiny/)
    expect(() => value('u : UINT := -1;', 'u')).toThrow(/out of range/)
    expect(value('x : SINT := -128;')).toBe(-128)
  })

  it('rejects a function call, naming the variable and the location', () => {
    const attempt = (): unknown => value('nBad : INT := F_One();', 'nBad')
    expect(attempt).toThrow(IecRuntimeError)
    expect(attempt).toThrow(/initializer must be a constant expression/)
    expect(attempt).toThrow(/nBad/)
    expect(attempt).toThrow(/Main\.TcPOU:\d+/)
  })

  it('still charges the allocation limit for initialized arrays', () => {
    const text = 'PROGRAM Main VAR x : ARRAY[1..100] OF INT := [-1, 2]; END_VAR END_PROGRAM'
    const unit: SourceUnit = { id: 'Main', role: 'pou', isTest: false, text, map: SourceMap.fromJSON([{ genStartLine: 1, lineCount: 1, file: 'Main.TcPOU', origStartLine: 1, origStartCol: 1 }]) }
    const project: Project = { vendor: 'beckhoff', dialect: 'beckhoff', name: 'F', root: '/f', projectFile: '/f/F.plcproj', units: [unit], libraries: [], defines: {}, warnings: [] }
    const symbols = buildSymbolTableFromProject(project, lang, { caseSensitive: false })
    const session = new Session({ caseSensitive: false, limits: { ...DEFAULT_LIMITS, maxAllocatedElements: 50 } })
    expect(() => instantiateFb('Main', createEvalContext({ symbols, session }))).toThrow(/allocation limit/)
  })
})
