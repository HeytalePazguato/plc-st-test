import { createRequire } from 'node:module'
import type { Dialect, PluginModule } from '@plc-st/plugin-api'

export const PACKAGE_NAME = '@plc-st/dialect-standard'

/** The vendor-neutral IEC 61131-3 ST flavour: the base grammar, case-insensitive identifiers, one METHOD per test and no node handlers. Core registers the stdlib, assertions, cycle functions and mocks for every dialect, so none are declared here. */
export const standardDialect: Dialect = {
  id: 'standard',
  apiVersion: 1,
  grammarWasmPath: () => createRequire(import.meta.url).resolve('tree-sitter-iec61131-3-st/tree-sitter-iec61131_3_st.wasm'),
  caseSensitive: false,
  testStrategy: 'method',
}

const plugin: PluginModule = { apiVersion: 1, dialects: [standardDialect] }

export default plugin
