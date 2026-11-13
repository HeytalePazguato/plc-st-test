import { createRequire } from 'node:module'
import type { Dialect, PluginModule } from '@plc-st/plugin-api'
import { beckhoffNodeHandlers } from './handlers.js'
import { preprocess } from './preprocess.js'

export const PACKAGE_NAME = '@plc-st/dialect-beckhoff'

export { PREPROCESS_UNSUPPORTED, preprocess, type PreprocessWarning } from './preprocess.js'
export { beckhoffNodeHandlers, noOp, setResetAssignmentStatement, shortCircuitExpression } from './handlers.js'

/** The Beckhoff TwinCAT 3 flavour: the `tree-sitter-iec61131-3-st-beckhoff` grammar (the base grammar plus TwinCAT syntax), case-insensitive identifiers, one METHOD per test, node handlers for `AND_THEN` / `OR_ELSE`, `S=` / `R=` and pragmas, and the TwinCAT libraries every project references, so they are never auto-stubbed or reported as unresolved. */
export const beckhoffDialect: Dialect = {
  id: 'beckhoff',
  apiVersion: 1,
  grammarWasmPath: () => createRequire(import.meta.url).resolve('tree-sitter-iec61131-3-st-beckhoff/tree-sitter-iec61131_3_st_beckhoff.wasm'),
  caseSensitive: false,
  testStrategy: 'method',
  nodeHandlers: beckhoffNodeHandlers,
  hooks: { preprocess },
  builtinLibraries: ['Tc2_Standard', 'Tc2_System', 'Tc3_Module', 'PlcStTest'],
}

const plugin: PluginModule = { apiVersion: 1, dialects: [beckhoffDialect] }

export default plugin
