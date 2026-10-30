import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import type { HostFnDef } from '@plc-st/plugin-api'
import { SourceMap, type LibraryRef, type Project, type SourceUnit } from '@plc-st/project-model'
import type { Language } from 'web-tree-sitter'
import { ASSERTION_NAMES } from '../src/assertions.js'
import { registerStdlib } from '../src/interpreter/stdlib/index.js'
import { applyAutoStubs } from '../src/mock/autostub.js'
import { MOCK_NAMES } from '../src/mock/expect.js'
import { baseGrammarPath, loadGrammar } from '../src/parser/parse.js'
import { PARAM_NAMES } from '../src/runner/params.js'
import { defaultSessionFactory } from '../src/runner/isolation.js'
import { Session } from '../src/session.js'
import { buildSymbolTableFromProject, type SymbolTable } from '../src/symbols/table.js'
import { isVendorTestLib } from '../src/vendorlib.js'

interface ManifestParam {
  name: string
  type: string
  optional: boolean
}

interface ManifestFn {
  name: string
  description: string
  parameters: ManifestParam[]
  returns: string | null
  vendorNotes?: Record<string, string>
}

const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../../../integrations/vendor-libs/manifest.json', import.meta.url)), 'utf8')) as { library: string; functions: ManifestFn[] }

let lang: Language

beforeAll(async () => {
  lang = await loadGrammar(baseGrammarPath())
})

function unit(id: string, text: string, extra: Partial<SourceUnit> = {}): SourceUnit {
  const lines = text.split('\n').length
  return { id, text, role: 'pou', isTest: false, map: SourceMap.fromJSON([{ genStartLine: 1, lineCount: lines, file: `${id}.st`, origStartLine: 1, origStartCol: 1 }]), ...extra }
}

function tableOf(units: SourceUnit[], libraries: LibraryRef[] = []): SymbolTable {
  const project: Project = { vendor: 'standard', dialect: 'standard', name: 'F', root: '/f', projectFile: '/f/p', units, libraries, defines: {}, warnings: [] }
  return buildSymbolTableFromProject(project, lang, { caseSensitive: false })
}

/** Every host function a default session registers except the IEC standard library, which the vendors provide themselves. */
function testFacingFns(): HostFnDef[] {
  const bare = new Session({ caseSensitive: false })
  registerStdlib(bare)
  const stdlib = new Set(bare.hostFns.list().map((f) => f.name.toUpperCase()))
  return defaultSessionFactory({ table: tableOf([]) })()
    .hostFns.list()
    .filter((f) => !stdlib.has(f.name.toUpperCase()))
}

const required = (fn: ManifestFn): number => fn.parameters.filter((p) => !p.optional).length

describe('PlcStTest manifest conformance', () => {
  it('is named PlcStTest and has unique entries', () => {
    expect(manifest.library).toBe('PlcStTest')
    const names = manifest.functions.map((f) => f.name.toUpperCase())
    expect(new Set(names).size).toBe(names.length)
  })

  it('gives every entry well-formed parameters and a return type', () => {
    for (const fn of manifest.functions) {
      expect(fn.description, fn.name).not.toBe('')
      let sawOptional = false
      for (const p of fn.parameters) {
        expect(p.name, fn.name).toMatch(/^[a-z][A-Za-z0-9]*$/)
        expect(p.type, `${fn.name}.${p.name}`).not.toBe('')
        expect(typeof p.optional, `${fn.name}.${p.name}`).toBe('boolean')
        if (sawOptional) expect(p.optional, `${fn.name}.${p.name} follows an optional parameter`).toBe(true)
        sawOptional ||= p.optional
      }
      expect(fn.returns === null || fn.returns.length > 0, fn.name).toBe(true)
    }
  })

  it('has a registered host function with compatible argument counts for every entry', () => {
    const registered = new Map(testFacingFns().map((f) => [f.name.toUpperCase(), f]))
    for (const fn of manifest.functions) {
      const host = registered.get(fn.name.toUpperCase())
      expect(host, `${fn.name} is in the manifest but no host function is registered`).toBeDefined()
      expect({ name: fn.name, min: host?.minArgs, max: host?.maxArgs }).toEqual({ name: fn.name, min: required(fn), max: fn.parameters.length })
    }
  })

  it('lists every registered test-facing host function', () => {
    const listed = new Set(manifest.functions.map((f) => f.name.toUpperCase()))
    const missing = testFacingFns()
      .map((f) => f.name)
      .filter((n) => !listed.has(n.toUpperCase()))
    expect(missing).toEqual([])
  })

  it('covers every exported name list', () => {
    const listed = new Set(manifest.functions.map((f) => f.name))
    for (const name of [...ASSERTION_NAMES, ...MOCK_NAMES, ...PARAM_NAMES, 'RUN_CYCLES', 'RUN_UNTIL']) expect(listed.has(name), name).toBe(true)
  })

  it('does not list IEC standard library functions', () => {
    const listed = new Set(manifest.functions.map((f) => f.name.toUpperCase()))
    for (const name of ['CONCAT', 'SHL', 'TON', 'ABS', 'LEN']) expect(listed.has(name), name).toBe(false)
  })

  it('notes how vendors without ANY declare the generic parameters', () => {
    const generic = manifest.functions.filter((f) => f.parameters.some((p) => p.type === 'ANY' || p.type === 'ANY_REAL'))
    expect(generic.length).toBeGreaterThan(0)
    for (const fn of generic) expect(fn.vendorNotes?.br, fn.name).toBeDefined()
  })
})

describe('isVendorTestLib', () => {
  it('matches PlcStTest at any version and kind', () => {
    expect(isVendorTestLib({ name: 'PlcStTest', kind: 'vendor-test-lib' })).toBe(true)
    expect(isVendorTestLib({ name: 'PlcStTest', version: '1.2.3', kind: 'compiled' })).toBe(true)
    expect(isVendorTestLib({ name: 'plcsttest', version: '*', kind: 'source' })).toBe(true)
  })

  it('does not match other libraries', () => {
    expect(isVendorTestLib({ name: 'Tc2_MC2', kind: 'compiled' })).toBe(false)
    expect(isVendorTestLib({ name: 'PlcStTestExtras', kind: 'compiled' })).toBe(false)
  })
})

describe('PlcStTest references', () => {
  const DUT = `FUNCTION_BLOCK FB_A
VAR
  n : DINT;
END_VAR
n := n + 1;
END_FUNCTION_BLOCK`

  const lib = (kind: LibraryRef['kind'], resolvedUnits?: string[]): LibraryRef => ({ name: 'PlcStTest', version: '1.0.0', kind, resolvedUnits })

  it('produces no LIBRARY_AUTOSTUBBED warnings for its functions', () => {
    const table = tableOf([unit('dut', DUT)], [lib('vendor-test-lib')])
    const session = defaultSessionFactory({ table })()
    applyAutoStubs(table, session, { strict: false, libraries: [lib('vendor-test-lib')] })
    expect(session.warnings.filter((w) => w.code === 'LIBRARY_AUTOSTUBBED')).toEqual([])
  })

  it('never stubs a symbol qualified with the library name', () => {
    const src = `FUNCTION_BLOCK TEST_A
VAR
  fb : PlcStTest.FB_Anything;
END_VAR
END_FUNCTION_BLOCK`
    const table = tableOf([unit('suite', src)])
    const session = defaultSessionFactory({ table })()
    applyAutoStubs(table, session, { strict: true, libraries: [lib('compiled')] })
    expect(session.fbStubs.get('FB_Anything')).toBeUndefined()
  })

  it('ignores the declarations of the library when they are ingested as source', () => {
    const decl = `FUNCTION ASSERT_TRUE : BOOL
VAR_INPUT
  condition : BOOL;
END_VAR
END_FUNCTION`
    const withLib = tableOf([unit('dut', DUT), unit('lib', decl)], [lib('source', ['lib'])])
    expect(withLib.getPous().map((p) => p.name)).toEqual(['FB_A'])
    const without = tableOf([unit('dut', DUT), unit('lib', decl)])
    expect(without.getPous().map((p) => p.name)).toContain('ASSERT_TRUE')
  })
})
