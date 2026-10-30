import type { CallArg, FbStubDef, HostCallContext, HostFnDef } from './hostfn.js'
import type { TestStrategyKind } from './strategy.js'
import type { IecValue } from './values.js'

/** Evaluates a dialect-specific grammar node. `node` is a web-tree-sitter `Node`; `ctx` is the core evaluation context (opaque to plugins). */
export type NodeHandler = (node: unknown, ctx: unknown) => unknown

/** A live FUNCTION_BLOCK instance as seen by dialect lifecycle hooks (e.g. TwinCAT FB_init/FB_exit). */
export interface FbInstanceRef {
  typeName: string
  hasMethod(name: string): boolean
  callMethod(name: string, args: CallArg[]): IecValue | undefined
}

export interface DialectHooks {
  /** Source-level preprocessing (e.g. conditional pragmas). MUST preserve the line count so source maps stay valid. */
  preprocess?(text: string, defines: Record<string, string>): string
  onInstantiate?(inst: FbInstanceRef, ctx: HostCallContext): void
  onDispose?(inst: FbInstanceRef, ctx: HostCallContext): void
}

/** A vendor flavour of ST: its grammar, rules, test strategy, and built-in library stubs. */
export interface Dialect {
  id: string
  apiVersion: number
  grammarWasmPath(): string
  caseSensitive: boolean
  testStrategy: TestStrategyKind
  nodeHandlers?: Record<string, NodeHandler>
  fbStubs?: FbStubDef[]
  hostFns?: HostFnDef[]
  builtinLibraries?: string[]
  hooks?: DialectHooks
}
