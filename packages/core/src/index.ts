/**
 * plc-st-test — vendor-neutral unit test runner for IEC 61131-3 Structured Text.
 *
 * Public entry point. Individual subsystems (parser, interpreter, runner, reporters) are added across the implementation phases.
 */

import { readFileSync } from 'node:fs'

// `package.json` sits outside this package's `rootDir`, so it is read at load time rather than imported; it resolves from both `src/` and `dist/`.
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }

/** Package version, read from `@plc-st/core`'s own `package.json` (Changesets is the single source of truth). */
export const VERSION: string = pkg.version

export { parseTimeLiteral } from './interpreter/time.js'
export { PluginError } from './errors.js'
export { applyPlugins, createPluginRegistries, loadPlugins, type ApplyPluginsOptions, type PluginRegistries } from './plugins/host.js'
