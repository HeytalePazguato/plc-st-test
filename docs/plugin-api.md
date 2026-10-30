# Plugin API

`@plc-st/plugin-api` is the public contract between the plc-st-test runner (`@plc-st/core`) and third-party plugins. A plugin package exports a `PluginModule` object that bundles ingestors, dialects, simulators, and reporters. Everything in this package is type-only except three runtime exports: `PACKAGE_NAME`, `PLUGIN_API_VERSION`, and `isCompatible` (from `version.ts`), plus the `validateResultsV1` function (from `results.ts`). The runtime implementations of the value helpers (`defaultValue`, `cloneValue`, `valueEquals`) live in `@plc-st/core`, not here.

The contract types reference `OriginalLocation`, `SourceMap`, `Project`, and `SafeFs`-shaped helpers from `@plc-st/project-model`. Plugins never import `@plc-st/core`; they receive everything they need through the objects core hands them.

## apiVersion policy

Every plugin-facing object carries an `apiVersion: number` field (`PluginModule`, `Ingestor`, `Dialect`, `Simulator`). The current major version is `PLUGIN_API_VERSION = 1`.

`isCompatible(apiVersion)` returns `true` only when `apiVersion` is an integer equal to `PLUGIN_API_VERSION`. A plugin built against a different major version is refused. When the loader is implemented, a major mismatch produces this message, naming the plugin and the version it targets:

`plugin <name> targets plugin-api v<N>, this runner supports v1`

Only the major number is checked. Within a major version, contracts change additively; see the [results schema stability promise](results-schema.md) for the same rule applied to run results.

## Plugin discovery

Plugins are resolved only from packages that are already installed in the project's `node_modules`. The runner never installs a plugin on its own: no network fetch and no implicit `npm install`. A plugin that is not installed is not loaded. Discovery and the `apiVersion` check are implemented by the plugin host in `@plc-st/core` (task 6.2 of the product plan); this page describes the contract that host enforces.

## Dialect grammars: an honest scope note

A `Dialect` declares `grammarWasmPath()`, which points at a compiled tree-sitter grammar. `NodeHandler` receives web-tree-sitter `Node` objects, so a dialect's node names must match the node types of the grammar core parses with. In practice a dialect grammar realistically has to extend `tree-sitter-iec61131-3-st` (grammar extension, not a from-scratch grammar), because the core interpreter expects the standard IEC 61131-3 Structured Text node types and only adds vendor-specific ones on top. A dialect that ships an unrelated grammar will parse, but its node handlers will not be reached for the constructs core already evaluates. Plan dialect work accordingly.

## Module: version.ts

### `PACKAGE_NAME`

The string `'@plc-st/plugin-api'`. Runtime constant.

### `PLUGIN_API_VERSION`

The major version of these contracts, currently `1`. Runtime constant.

### `isCompatible(apiVersion: number): boolean`

Returns `true` when `apiVersion` is an integer equal to `PLUGIN_API_VERSION`. Runtime function.

## Module: values.ts

Runtime value model shared by core and plugins. These are types only.

### `IecType`

Union of the elementary IEC 61131-3 type names modelled by the interpreter: `BOOL`, `BYTE`, `WORD`, `DWORD`, `LWORD`, `SINT`, `USINT`, `INT`, `UINT`, `DINT`, `UDINT`, `LINT`, `ULINT`, `REAL`, `LREAL`, `TIME`, `STRING`, `WSTRING`. Core exposes a runtime constant with the same name whose values are exactly these strings.

### `IecValue`

A runtime value. It is a discriminated union on `kind`:

- `{ kind: 'scalar'; type: IecType; value: number | bigint | boolean | string }`. Types up to 32 bits use `number`; `LINT`, `ULINT`, and `LWORD` use `bigint`.
- `{ kind: 'array'; elemType: IecType | string; dims: [number, number][]; data: IecValue[] }`. `dims` holds one `[lower, upper]` pair per dimension.
- `{ kind: 'struct'; typeName: string; fields: Map<string, IecValue> }`.
- `{ kind: 'enum'; typeName: string; value: number }`.

### `StructTypeInfo`

A user-defined structure type. Fields:

- `kind: 'struct'`
- `typeName: string`
- `fields: { name: string; typeNode: Node; initNode?: Node }[]`. `typeNode` and `initNode` are web-tree-sitter `Node`s from the source.

### `EnumTypeInfo`

A user-defined enumeration. Fields:

- `kind: 'enum'`
- `typeName: string`
- `members: { name: string; value: number }[]`

### `AliasTypeInfo`

A user-defined alias type. Fields:

- `kind: 'alias'`
- `typeName: string`
- `typeNode: Node`
- `initNode?: Node`

### `ResolvedType`

Union `StructTypeInfo | EnumTypeInfo | AliasTypeInfo`.

### `TypeResolver`

Interface with one method, `resolveType(name: string): ResolvedType | undefined`. It resolves a named user-defined type. Core's cross-file symbol table implements it; plugins receive it without depending on core.

## Module: hostfn.ts

Host-side functions and function blocks, plus the variable cell model they use.

### `Slot`

A mutable variable cell. Field: `value: IecValue`. VAR_IN_OUT aliasing means two names point at the same `Slot`, so a write through one is visible through the other and to the caller.

### `CallArg`

A bound call argument. Fields:

- `name?: string`, set for named arguments (`a := x`).
- `value: IecValue`, the evaluated argument.
- `slot?: Slot`, set when the argument is a variable, so a VAR_IN_OUT parameter can alias the caller's storage.

### `HostCallContext`

What a host function or FB stub can see of the running session at the call site. Members:

- `readonly cycle: number`, the current PLC cycle number.
- `readonly nowNs: bigint`, the simulated clock in nanoseconds.
- `readonly location: OriginalLocation`, the original vendor-file location of the call.
- `resolvePath(path: string): Slot | undefined`, resolves a dotted path such as `GVL.bStart` or `fbConveyor.nState` to its slot.
- `warn(code: string, message: string): void`, emits a run warning attributed to the call site.

### `HostFnDef`

A FUNCTION implemented in TypeScript. Fields:

- `name: string`
- `minArgs: number`
- `maxArgs: number`
- `call(args: CallArg[], ctx: HostCallContext): IecValue | undefined`. Returns the function result, or `undefined` for a function with no return value.

### `VarSpec`

A variable declared on a host FUNCTION_BLOCK. Fields:

- `name: string`
- `type: string`, an ST type name such as `BOOL`, `TIME`, or `STRING(80)`.
- `init?: IecValue`

### `FbIo`

Access to one FB instance's inputs, outputs, and in-outs while its stub body runs. Methods:

- `get(name: string): IecValue`
- `set(name: string, v: IecValue): void`

### `FbStubDef`

A FUNCTION_BLOCK implemented on the host side (for example TON, R_TRIG, or a vendor library block). Fields:

- `name: string`
- `inputs: VarSpec[]`
- `outputs: VarSpec[]`
- `inOuts?: VarSpec[]`
- `createState?(): unknown`, creates per-instance private state; called once per instance.
- `call(state: unknown, io: FbIo, ctx: HostCallContext): void`, one invocation of the block body for an instance.

## Module: ingestor.ts

### `SafeFsLike`

The subset of the host's root-confined file system that ingestors use. It is declared structurally so the contract does not depend on a concrete class. The concrete implementation is `SafeFs` in `@plc-st/project-model`. Methods:

- `resolve(p: string, from?: string): string`. Resolves `p` relative to `from` (or the root) to a confined absolute path. Throws when the result escapes the root.
- `readText(p: string): Promise<string>`
- `exists(p: string): Promise<boolean>`
- `list(dir: string): Promise<string[]>`

### `DetectCandidate`

One project an ingestor recognised under a repository root. Fields:

- `ingestorId: string`
- `projectFile: string`
- `label: string`, a human-readable name for the candidate.
- `confidence: number`, from 0 to 1. See the [ingestor contract](ingestor-contract.md) for the scale.

### `IngestOptions`

Options passed to `load`. Fields:

- `root: string`
- `fs: SafeFsLike`
- `testsFolder: string`, default `'Tests'`.
- `testPattern: string`, default `'TEST_*'`.
- `defines: Record<string, string>`

### `Ingestor`

Turns a vendor project on disk into a vendor-neutral `Project`. Fields and methods:

- `id: string`
- `vendor: string`
- `apiVersion: number`
- `detect(root: string, fs: SafeFsLike): Promise<DetectCandidate[]>`
- `load(candidate: DetectCandidate, opts: IngestOptions): Promise<Project>`

## Module: strategy.ts

### `TestStrategyKind`

Union `'method' | 'action' | 'method-or-action'`. It states how a dialect maps tests onto POUs: one METHOD per test, one ACTION per test (classic B&R), or either.

### `TestDescriptor`

One test. Fields:

- `name: string`
- `location: OriginalLocation`

### `SuiteDescriptor`

A discovered test suite and its tests. Fields:

- `suite: string`
- `tests: TestDescriptor[]`
- `setUp?: string`, the name of the set-up member.
- `tearDown?: string`, the name of the tear-down member.
- `cycle?: string`, the name of an optional cycle member.
- `kind: 'method' | 'action'`
- `location: OriginalLocation`

## Module: dialect.ts

### `NodeHandler`

Type `(node: unknown, ctx: unknown) => unknown`. Evaluates a dialect-specific grammar node. `node` is a web-tree-sitter `Node`. `ctx` is the core evaluation context, which is opaque to plugins.

### `FbInstanceRef`

A live FUNCTION_BLOCK instance as seen by lifecycle hooks. Fields and methods:

- `typeName: string`
- `hasMethod(name: string): boolean`
- `callMethod(name: string, args: CallArg[]): IecValue | undefined`

### `DialectHooks`

Optional hooks a dialect can implement. Members:

- `preprocess?(text: string, defines: Record<string, string>): string`. Source-level preprocessing, for example conditional pragmas. It MUST preserve the line count so source maps stay valid.
- `onInstantiate?(inst: FbInstanceRef, ctx: HostCallContext): void`, for example TwinCAT `FB_init`.
- `onDispose?(inst: FbInstanceRef, ctx: HostCallContext): void`, for example TwinCAT `FB_exit`.

### `Dialect`

A vendor flavour of ST: its grammar, rules, test strategy, and built-in library stubs. Fields:

- `id: string`
- `apiVersion: number`
- `grammarWasmPath(): string`. See the honest-scope note above about extending `tree-sitter-iec61131-3-st`.
- `caseSensitive: boolean`
- `testStrategy: TestStrategyKind`
- `nodeHandlers?: Record<string, NodeHandler>`
- `fbStubs?: FbStubDef[]`
- `hostFns?: HostFnDef[]`
- `builtinLibraries?: string[]`
- `hooks?: DialectHooks`

## Module: simulator.ts

### `SimulatorSession`

The per-test session a simulator attaches to. Registrations are scoped to this session only. Members:

- `readonly cycleTimeNs: bigint`
- `onPreCycle(fn: (cycle: number) => void): void`
- `onPostCycle(fn: (cycle: number) => void): void`
- `registerHostFn(def: HostFnDef): void`
- `registerFbStub(def: FbStubDef): void`
- `config: Record<string, unknown>`, the simulator's section of the user configuration.

### `Simulator`

Simulates plant or IO behaviour around the program under test. Fields and methods:

- `id: string`
- `apiVersion: number`
- `attach(s: SimulatorSession): void`

## Module: reporter.ts

### `ReporterIo`

Output facilities handed to a reporter, so reporters never touch `process` or the file system directly. Members:

- `outDir: string`
- `writeFile(name: string, data: string): Promise<void>`
- `stdout(text: string): void`
- `env: Record<string, string | undefined>`

### `Reporter`

Fields and methods:

- `id: string`
- `onRunEnd(results: RunResultsV1, io: ReporterIo): Promise<void>`, called once with the finished [results document](results-schema.md).

## Module: results.ts

The versioned JSON results contract. The full field reference is in [results-schema.md](results-schema.md). Types exported here:

- `RunResultsV1`, the top-level document with `schemaVersion: 1`.
- `SuiteResultV1`, one suite with its `tests: TestResultV1[]`.
- `TestStatusV1`, union `'passed' | 'failed' | 'errored' | 'skipped'`.
- `FailureKindV1`, union `'assertion' | 'runtime' | 'timeout' | 'limit'`.
- `TestResultV1`, one test result, with an optional `failure` object.
- `CoverageSummaryV1`, the optional branch-coverage summary.

Runtime function:

### `validateResultsV1(x: unknown): string[]`

Structurally validates a value against schema v1 and returns JSON-pointer-like error paths (for example `/summary/total: expected non-negative integer`). It returns an empty array when the value is valid. It is a hand-written validator with no ajv dependency, and it rejects unknown properties.

## Module: index.ts

### `PluginModule`

The default export shape of a plugin package. Fields:

- `apiVersion: number`, the major contract version the plugin was built against.
- `ingestors?: Ingestor[]`
- `dialects?: Dialect[]`
- `simulators?: Simulator[]`
- `reporters?: Reporter[]`

Example:

```ts
import type { PluginModule } from '@plc-st/plugin-api'

const plugin: PluginModule = {
  apiVersion: 1,
  reporters: [{ id: 'my-reporter', onRunEnd: async (results, io) => { await io.writeFile('results.txt', String(results.summary.total)) } }],
}

export default plugin
```
