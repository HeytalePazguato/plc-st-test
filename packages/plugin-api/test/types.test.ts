import { describe, expect, it } from 'vitest'
import type { OriginalLocation, Project } from '@plc-st/project-model'
import {
  isCompatible,
  PLUGIN_API_VERSION,
  type AliasTypeInfo,
  type CallArg,
  type DetectCandidate,
  type Dialect,
  type DialectHooks,
  type EnumTypeInfo,
  type FbInstanceRef,
  type FbIo,
  type FbStubDef,
  type HostCallContext,
  type HostFnDef,
  type IecValue,
  type IngestOptions,
  type Ingestor,
  type NodeHandler,
  type PluginModule,
  type Reporter,
  type ReporterIo,
  type ResolvedType,
  type RunResultsV1,
  type SafeFsLike,
  type Simulator,
  type SimulatorSession,
  type Slot,
  type StructTypeInfo,
  type SuiteDescriptor,
  type TestDescriptor,
  type TestStrategyKind,
  type TypeResolver,
  type VarSpec,
} from '../src/index.js'

const loc = { file: 'FB_Conveyor.TcPOU', line: 42, col: 1 } satisfies OriginalLocation

const int = (value: number) => ({ kind: 'scalar', type: 'INT', value }) satisfies IecValue
const values = [
  int(1),
  { kind: 'scalar', type: 'LINT', value: 1n },
  { kind: 'scalar', type: 'BOOL', value: true },
  { kind: 'scalar', type: 'STRING', value: 'abc' },
  { kind: 'array', elemType: 'INT', dims: [[1, 2]], data: [int(0), int(0)] },
  { kind: 'struct', typeName: 'ST_Point', fields: new Map([['x', int(3)]]) },
  { kind: 'enum', typeName: 'E_State', value: 2 },
] satisfies IecValue[]

const enumInfo = { kind: 'enum', typeName: 'E_State', members: [{ name: 'Idle', value: 0 }] } satisfies EnumTypeInfo
const resolver = {
  resolveType: (name: string): ResolvedType | undefined => (name === 'E_State' ? enumInfo : undefined),
} satisfies TypeResolver

const slot = { value: int(5) } satisfies Slot
const arg = { name: 'IN', value: slot.value, slot } satisfies CallArg

const ctx = {
  cycle: 3,
  nowNs: 30_000_000n,
  location: loc,
  resolvePath: (path: string) => (path === 'GVL.n' ? slot : undefined),
  warn: () => {},
} satisfies HostCallContext

const hostFn = {
  name: 'ADD2',
  minArgs: 1,
  maxArgs: 1,
  call: (args: CallArg[]) => {
    const v = args[0]!.value
    return v.kind === 'scalar' && typeof v.value === 'number' ? int(v.value + 2) : undefined
  },
} satisfies HostFnDef

const varSpec = { name: 'IN', type: 'BOOL', init: { kind: 'scalar', type: 'BOOL', value: false } } satisfies VarSpec

const fbStub = {
  name: 'R_TRIG',
  inputs: [{ name: 'CLK', type: 'BOOL' }],
  outputs: [{ name: 'Q', type: 'BOOL' }],
  inOuts: [],
  createState: () => ({ prev: false }),
  call: (state: unknown, io: FbIo) => {
    const s = state as { prev: boolean }
    const clk = io.get('CLK')
    const now = clk.kind === 'scalar' && clk.value === true
    io.set('Q', { kind: 'scalar', type: 'BOOL', value: now && !s.prev })
    s.prev = now
  },
} satisfies FbStubDef

const fs = {
  resolve: (p: string) => `/repo/${p}`,
  readText: async () => '',
  exists: async () => true,
  list: async () => ['Plc.plcproj'],
} satisfies SafeFsLike

const candidate = { ingestorId: 'beckhoff', projectFile: 'Plc.plcproj', label: 'Plc', confidence: 0.9 } satisfies DetectCandidate

const ingestOptions = { root: '/repo', fs, testsFolder: 'Tests', testPattern: 'TEST_*', defines: {} } satisfies IngestOptions

const ingestor = {
  id: 'beckhoff',
  vendor: 'beckhoff',
  apiVersion: PLUGIN_API_VERSION,
  detect: async () => [candidate],
  load: async (): Promise<Project> => {
    throw new Error('not exercised')
  },
} satisfies Ingestor

const strategy = 'method-or-action' satisfies TestStrategyKind
const test = { name: 'TestStartStops', location: loc } satisfies TestDescriptor
const suite = { suite: 'TEST_Conveyor', tests: [test], setUp: 'SetUp', tearDown: 'TearDown', cycle: 'Cycle', kind: 'method', location: loc } satisfies SuiteDescriptor

const handler: NodeHandler = (node) => node
const instance = {
  typeName: 'FB_Motor',
  hasMethod: (name: string) => name === 'FB_init',
  callMethod: () => undefined,
} satisfies FbInstanceRef
const hooks = {
  preprocess: (text: string) => text,
  onInstantiate: (inst: FbInstanceRef) => void inst.callMethod('FB_init', []),
  onDispose: () => {},
} satisfies DialectHooks

const dialect = {
  id: 'beckhoff',
  apiVersion: PLUGIN_API_VERSION,
  grammarWasmPath: () => '/grammars/beckhoff.wasm',
  caseSensitive: false,
  testStrategy: strategy,
  nodeHandlers: { pointer_deref: handler },
  fbStubs: [fbStub],
  hostFns: [hostFn],
  builtinLibraries: ['Tc2_Standard'],
  hooks,
} satisfies Dialect

const session = {
  cycleTimeNs: 10_000_000n,
  onPreCycle: () => {},
  onPostCycle: () => {},
  registerHostFn: () => {},
  registerFbStub: () => {},
  config: { speed: 1 },
} satisfies SimulatorSession

const simulator = {
  id: 'conveyor-sim',
  apiVersion: PLUGIN_API_VERSION,
  attach: (s: SimulatorSession) => s.registerHostFn(hostFn),
} satisfies Simulator

const written: Record<string, string> = {}
const reporterIo = {
  outDir: 'out',
  writeFile: async (name: string, data: string) => {
    written[name] = data
  },
  stdout: () => {},
  env: { CI: 'true' },
} satisfies ReporterIo

const reporter = {
  id: 'json',
  onRunEnd: async (results: RunResultsV1, io: ReporterIo) => io.writeFile('results.json', JSON.stringify(results)),
} satisfies Reporter

const plugin = {
  apiVersion: PLUGIN_API_VERSION,
  ingestors: [ingestor],
  dialects: [dialect],
  simulators: [simulator],
  reporters: [reporter],
} satisfies PluginModule

const structInfo = { kind: 'struct', typeName: 'ST_Point', fields: [] } satisfies StructTypeInfo
const aliasCheck = (a: AliasTypeInfo): ResolvedType => a

describe('isCompatible', () => {
  it('accepts the current major version', () => {
    expect(PLUGIN_API_VERSION).toBe(1)
    expect(isCompatible(1)).toBe(true)
  })

  it('rejects other majors and non-integers', () => {
    expect(isCompatible(2)).toBe(false)
    expect(isCompatible(0)).toBe(false)
    expect(isCompatible(1.5)).toBe(false)
    expect(isCompatible(Number.NaN)).toBe(false)
  })
})

describe('contract object literals', () => {
  it('are usable through their interfaces', async () => {
    expect(values).toHaveLength(7)
    expect(resolver.resolveType('E_State')).toBe(enumInfo)
    expect(structInfo.kind).toBe('struct')
    expect(typeof aliasCheck).toBe('function')
    expect(arg.slot.value).toEqual(int(5))
    expect(ctx.resolvePath('GVL.n')).toBe(slot)
    expect(hostFn.call([arg])).toEqual(int(7))
    expect(varSpec.init.value).toBe(false)

    const state = fbStub.createState()
    const io = new Map<string, IecValue>([['CLK', { kind: 'scalar', type: 'BOOL', value: true }]])
    const fbIo: FbIo = { get: (n) => io.get(n)!, set: (n, v) => void io.set(n, v) }
    fbStub.call(state, fbIo)
    expect(io.get('Q')).toEqual({ kind: 'scalar', type: 'BOOL', value: true })
    fbStub.call(state, fbIo)
    expect(io.get('Q')).toEqual({ kind: 'scalar', type: 'BOOL', value: false })

    expect(await ingestor.detect()).toEqual([candidate])
    expect(ingestOptions.fs.resolve('x')).toBe('/repo/x')
    expect(suite.tests[0]).toBe(test)
    expect(hooks.preprocess('a\nb')).toBe('a\nb')
    expect(instance.hasMethod('FB_init')).toBe(true)
    expect(dialect.nodeHandlers.pointer_deref(1, null)).toBe(1)

    const registered: string[] = []
    simulator.attach({ ...session, registerHostFn: (d) => void registered.push(d.name) })
    expect(registered).toEqual(['ADD2'])

    await reporter.onRunEnd({ schemaVersion: 1 }, reporterIo)
    expect(written['results.json']).toBe('{"schemaVersion":1}')
    expect(plugin.dialects).toHaveLength(1)
  })
})
