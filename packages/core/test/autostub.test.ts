import { describe, it, expect, beforeAll } from 'vitest'
import type { SuiteResultV1 } from '@plc-st/plugin-api'
import type { Language } from 'web-tree-sitter'
import { SourceMap, type LibraryRef, type Project, type SourceUnit } from '@plc-st/project-model'
import { IecError } from '../src/errors.js'
import { applyAutoStubs } from '../src/mock/autostub.js'
import { baseGrammarPath, loadGrammar } from '../src/parser/parse.js'
import { discoverSuites } from '../src/runner/discovery.js'
import { defaultSessionFactory, runSuiteDetailed, type SuiteRun } from '../src/runner/isolation.js'
import type { Session } from '../src/session.js'
import { buildSymbolTableFromProject, type SymbolTable } from '../src/symbols/table.js'

let lang: Language

function unit(id: string, text: string, file: string, extra: Partial<SourceUnit> = {}): SourceUnit {
  const lines = text.split('\n').length
  return { id, text, role: 'pou', isTest: true, map: SourceMap.fromJSON([{ genStartLine: 1, lineCount: lines, file, origStartLine: 1, origStartCol: 1 }]), ...extra }
}

function tableOf(units: SourceUnit[]): SymbolTable {
  const project: Project = { vendor: 'standard', dialect: 'standard', name: 'F', root: '/f', projectFile: '/f/p', units, libraries: [], defines: {}, warnings: [] }
  return buildSymbolTableFromProject(project, lang, { caseSensitive: false })
}

const DUT = `FUNCTION_BLOCK FB_Axis
VAR
  fbPower : MC_Power;
  bPowered : BOOL;
  rPos : LREAL;
  nCount : DINT;
END_VAR
fbPower(Enable := TRUE, Axis := 3, Velocity => rPos);
bPowered := fbPower.Status;
IF fbPower.Error THEN
  nCount := nCount + 1;
END_IF
nCount := Clamp(nCount, 0, 10);
END_FUNCTION_BLOCK`

function suiteOf(body: string): string {
  return `FUNCTION_BLOCK TEST_Axis
VAR
  uut : FB_Axis;
END_VAR
METHOD Cycle
  uut();
END_METHOD
${body}
END_FUNCTION_BLOCK`
}

const LIB: LibraryRef = { name: 'Tc2_MC2', kind: 'compiled' }

function run(body: string, strict = false): { result: SuiteRun; session: Session } {
  const table = tableOf([unit('dut', DUT, 'dut.st'), unit('suite', suiteOf(body), 'suite.st')])
  expect(table.diagnostics).toEqual([])
  const base = defaultSessionFactory({ table })
  let last: Session | undefined
  const sessionFactory = (): Session => {
    const session = base()
    applyAutoStubs(table, session, { strict, libraries: [LIB] })
    last = session
    return session
  }
  const [desc] = discoverSuites(table, { strategy: 'method' }).suites
  const result = runSuiteDetailed(desc, { table, sessionFactory, cycleTimeNs: 10_000_000n })
  return { result, session: last as Session }
}

const statusOf = (r: SuiteResultV1): string[] => r.tests.map((t) => `${t.name}:${t.status}${t.failure === undefined ? '' : `:${t.failure.message}`}`)

beforeAll(async () => {
  lang = await loadGrammar(baseGrammarPath())
})

describe('table.unresolvedTypes', () => {
  it('lists named types that no unit defines, with their declarations', () => {
    const types = tableOf([unit('dut', DUT, 'dut.st'), unit('suite', suiteOf(''), 'suite.st')]).unresolvedTypes()
    expect(types.map((t) => t.name)).toEqual(['MC_Power'])
    expect(types[0].uses.map((u) => u.entry.name)).toEqual(['fbPower'])
  })

  it('ignores types defined as FB, enum, struct or alias, and elementary types', () => {
    const src = `TYPE E : (a, b); END_TYPE
TYPE S : STRUCT x : INT; END_STRUCT END_TYPE
FUNCTION_BLOCK FB_Own
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_User
VAR
  o : FB_Own;
  e : E;
  s : S;
  n : INT;
END_VAR
END_FUNCTION_BLOCK`
    expect(tableOf([unit('u', src, 'u.st')]).unresolvedTypes()).toEqual([])
  })
})

describe('applyAutoStubs (non-strict)', () => {
  it('runs a project calling an unknown FB, with one warning per symbol naming the library', () => {
    const { result, session } = run('METHOD TEST_Power\nCycle();\nEND_METHOD')
    expect(statusOf(result.result)).toEqual(['TEST_Power:passed'])
    const warnings = session.warnings.filter((w) => w.code === 'LIBRARY_AUTOSTUBBED')
    expect(warnings.map((w) => w.message)).toEqual([
      expect.stringContaining("function block 'MC_Power' is not defined (library Tc2_MC2)"),
      expect.stringContaining("function 'Clamp' is not defined (library Tc2_MC2)"),
    ])
    expect(warnings[0].location?.file).toBe('dut.st')
  })

  it('infers inputs from named arguments and outputs from member reads and => bindings, typed from context', () => {
    const { session } = run('METHOD TEST_Power\nCycle();\nEND_METHOD')
    const def = session.fbStubs.get('MC_Power')
    expect(def?.inputs).toEqual([
      { name: 'Enable', type: 'BOOL' },
      { name: 'Axis', type: 'DINT' },
    ])
    expect(def?.outputs).toEqual([
      { name: 'Velocity', type: 'LREAL' },
      { name: 'Status', type: 'BOOL' },
      { name: 'Error', type: 'BOOL' },
    ])
  })

  it('makes the stubbed instance addressable by MOCK_RETURNS and the expectations', () => {
    const body = `METHOD TEST_Power
MOCK_RETURNS('uut.fbPower.Status', TRUE);
MOCK_RETURNS('uut.fbPower.Velocity', 2.5);
Cycle();
EXPECT_CALLS('uut.fbPower', 1);
EXPECT_CALLED_WITH('uut.fbPower', 'Axis', 3);
ASSERT_TRUE(uut.bPowered);
ASSERT_EQ(uut.rPos, 2.5);
END_METHOD`
    expect(statusOf(run(body).result.result)).toEqual(['TEST_Power:passed'])
  })

  it('returns the default of the assignment target for an unknown function, and nothing for a statement call', () => {
    const src = `FUNCTION_BLOCK FB_F
VAR
  n : DINT;
  r : REAL;
  s : STRING;
END_VAR
n := Mystery(1);
r := Other();
s := Text();
Fire();
END_FUNCTION_BLOCK`
    const table = tableOf([unit('f', src, 'f.st')])
    const session = defaultSessionFactory({ table })()
    applyAutoStubs(table, session, { strict: false })
    const call = (name: string): unknown => session.hostFns.get(name)?.call([], undefined as never)
    expect(call('Mystery')).toMatchObject({ value: 0 })
    expect(call('Other')).toMatchObject({ value: 0 })
    expect(call('Text')).toMatchObject({ value: '' })
    expect(call('Fire')).toBeUndefined()
  })

  it('never stubs a type or function the project defines, a registered stub, or a builtin library symbol', () => {
    const src = `FUNCTION_BLOCK FB_Mine
END_FUNCTION_BLOCK
FUNCTION Helper : DINT
Helper := 1;
END_FUNCTION
FUNCTION_BLOCK FB_Caller
VAR
  m : FB_Mine;
  t : TON;
  q : Tc2_Standard.TOF;
  x : DINT;
END_VAR
m();
t(IN := TRUE, PT := T#1s);
x := Helper();
x := ABS(x);
END_FUNCTION_BLOCK`
    const table = tableOf([unit('c', src, 'c.st')])
    const session = defaultSessionFactory({ table })()
    session.fbStubs.register({ name: 'TON', inputs: [], outputs: [], call() {} }, 'test')
    applyAutoStubs(table, session, { strict: false, builtinLibraries: ['Tc2_Standard'] })
    expect(session.warnings.filter((w) => w.code === 'LIBRARY_AUTOSTUBBED')).toEqual([])
    expect(session.fbStubs.get('FB_Mine')).toBeUndefined()
  })
})

describe('applyAutoStubs (strict)', () => {
  it('fails listing every unresolved symbol and registers nothing', () => {
    const table = tableOf([unit('dut', DUT, 'dut.st'), unit('suite', suiteOf(''), 'suite.st')])
    const session = defaultSessionFactory({ table })()
    let error: unknown
    try {
      applyAutoStubs(table, session, { strict: true, libraries: [LIB] })
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(IecError)
    const message = (error as IecError).message
    expect(message).toContain("function block 'MC_Power' (library Tc2_MC2) at dut.st:3")
    expect(message).toContain("function 'Clamp'")
    expect(message).toContain('2 unresolved symbols')
    expect(session.fbStubs.get('MC_Power')).toBeUndefined()
    expect(session.warnings).toEqual([])
  })

  it('passes when everything resolves', () => {
    const table = tableOf([unit('own', 'FUNCTION_BLOCK FB_Own\nEND_FUNCTION_BLOCK', 'own.st')])
    expect(() => applyAutoStubs(table, defaultSessionFactory({ table })(), { strict: true })).not.toThrow()
  })
})
