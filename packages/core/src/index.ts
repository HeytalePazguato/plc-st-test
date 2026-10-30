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
export { IecError, PluginError } from './errors.js'
export { DEFAULT_LIMITS, type Limits } from './limits.js'
export { loadGrammar } from './parser/parse.js'
export { buildSymbolTableFromProject, SymbolTable, type ProjectBuildOptions, type SymbolDiagnostic } from './symbols/table.js'
export { Session } from './session.js'
export { applyAutoStubs, type AutoStubOptions } from './mock/autostub.js'
export { startCoverage, summarizeCoverage, type CoverageOptions, type CoverageRun } from './coverage/instrument.js'
export { checkThreshold, coverageToJson, renderCoverageHtml, renderCoverageTerminal } from './coverage/report.js'
export { discoverSuites, globToRegExp, type DiscoverOptions, type DiscoveryResult } from './runner/discovery.js'
export { defaultSessionFactory, type DefaultSessionOptions, type RunEnv } from './runner/isolation.js'
export { runAll } from './runner/results.js'
export { applyPlugins, createPluginRegistries, loadPlugins, type ApplyPluginsOptions, type PluginRegistries } from './plugins/host.js'
export { junitReporter, renderJunit } from './reporters/junit.js'
export { jsonReporter, renderJson } from './reporters/json.js'
export { tapReporter, renderTap } from './reporters/tap.js'
export { createTerminalReporter, renderTerminal, terminalReporter, type TerminalReporterOptions } from './reporters/terminal.js'
export { githubReporter, renderGithubAnnotations, renderGithubSummary } from './reporters/github.js'
