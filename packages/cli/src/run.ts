/**
 * The `run` and `discover` pipelines: config → plugins → project → dialect → grammar → symbol table → syntax diagnostics, then auto-stub → discover → filters → run → reporters → coverage threshold for `run`.
 *
 * Both return an exit code instead of throwing: 0 all passed, 1 a test failed or errored (or coverage is below the threshold), 2 a config, ingest, parse or plugin error.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  applyAutoStubs,
  applyPlugins,
  buildSymbolTableFromProject,
  checkThreshold,
  coverageToJson,
  createPluginRegistries,
  DEFAULT_LIMITS,
  defaultSessionFactory,
  discoverSuites,
  globToRegExp,
  loadGrammar,
  loadPlugins,
  renderCoverageHtml,
  runAll,
  Session,
  startCoverage,
  summarizeCoverage,
} from '@plc-st/core'
import type { CoverageRun, Limits, PluginRegistries, SymbolTable } from '@plc-st/core'
import type { Dialect, PluginModule, Reporter, ReporterIo, RunResultsV1, SuiteDescriptor } from '@plc-st/plugin-api'
import type { Project, ProjectWarning } from '@plc-st/project-model'
import { BUILTIN_MODULES } from './builtins.js'
import { ConfigError, loadConfig, type Config } from './config.js'
import { ingest, IngestError } from './ingest.js'

export const EXIT_PASSED = 0
export const EXIT_FAILED = 1
export const EXIT_ERROR = 2

/** Everything the pipelines touch outside the project, so the CLI can run in-process. */
export interface CliIo {
  cwd: string
  env: Record<string, string | undefined>
  stdout(text: string): void
  stderr(text: string): void
}

export const processIo = (): CliIo => ({
  cwd: process.cwd(),
  env: process.env,
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
})

interface ProjectOptions {
  /** Config file, relative to the working directory. */
  config?: string
  /** Project file, relative to the project root; overrides `project:` in the config. */
  project?: string
  verbose?: boolean
}

export interface RunOptions extends ProjectOptions {
  /** Reporter ids; overrides `reporters:` in the config. */
  reporters?: string[]
  /** Output directory, relative to the working directory; defaults to `plc-st-test-results`. */
  outDir?: string
  /** Glob over suite names. */
  suite?: string
  /** Glob over test names. */
  test?: string
  coverage?: boolean
  strictLibraries?: boolean
}

export type DiscoverOptions = ProjectOptions

export interface RunOutcome {
  exitCode: number
  /** Absent when the run stopped before any test ran. */
  results?: RunResultsV1
}

const DEFAULT_OUT_DIR = 'plc-st-test-results'

interface Prepared {
  config: Config
  modules: PluginModule[]
  registries: PluginRegistries
  project: Project
  dialect: Dialect
  table: SymbolTable
  warnings: ProjectWarning[]
}

const pluginOptions = (config: Config): Parameters<typeof applyPlugins>[3] => ({ cycleTimeNs: config.cycle_time, simulatorConfig: config.simulators as Record<string, Record<string, unknown>> })

const toLimits = ({ limits }: Config): Limits => ({
  ...DEFAULT_LIMITS,
  maxRecursionDepth: limits.max_recursion_depth,
  maxLoopIterations: limits.max_loop_iterations,
  maxCyclesPerTest: limits.max_cycles_per_test,
  maxExecutionTimeMs: limits.max_execution_time_ms,
  maxAllocatedElements: limits.max_allocated_elements,
})

/** The steps `run` and `discover` share, up to a symbol table free of syntax errors. */
async function prepare(path: string | undefined, opts: ProjectOptions, io: CliIo): Promise<Prepared> {
  const root = resolve(io.cwd, path ?? '.')
  const loaded = await loadConfig(root, opts.config === undefined ? undefined : resolve(io.cwd, opts.config))
  const config = opts.project === undefined ? loaded.config : { ...loaded.config, project: opts.project }
  if (opts.verbose === true) io.stderr(`config: ${loaded.path ?? '(defaults)'}\n`)

  const modules = [...BUILTIN_MODULES, ...(await loadPlugins(config.plugins, root))]
  const registries = createPluginRegistries()
  // This also attaches every simulator once, so one that rejects its config stops here instead of erroring every test.
  applyPlugins(modules, new Session({ caseSensitive: false }), registries, pluginOptions(config))

  const { project, candidate, dialect: dialectId } = await ingest(root, [...registries.ingestors.values()], config)
  if (opts.verbose === true) io.stderr(`project: ${candidate.label} (${candidate.projectFile}), dialect ${dialectId}\n`)
  const dialect = registries.dialects.get(dialectId)
  if (dialect === undefined) throw new IngestError(`unknown dialect '${dialectId}'; installed dialects: ${[...registries.dialects.keys()].join(', ')}`)

  const language = await loadGrammar(dialect.grammarWasmPath())
  const defines = { ...project.defines, ...Object.fromEntries(Object.entries(config.defines).map(([key, value]) => [key, String(value)])) }
  const hooks = dialect.hooks
  const table = buildSymbolTableFromProject(project, language, {
    caseSensitive: dialect.caseSensitive,
    ...(hooks?.preprocess === undefined ? {} : { preprocess: (text: string) => hooks.preprocess!(text, defines) }),
  })

  // Diagnostics with a code (a missing interface member, say) are warnings in the results; those without one mean the source did not parse.
  const syntax = table.diagnostics.filter((d) => d.code === undefined)
  if (syntax.length > 0) {
    const lines = syntax.map((d) => `  ${d.location.file}:${String(d.location.line)}:${String(d.location.col)}: ${d.message}`)
    throw new IngestError(`${String(syntax.length)} syntax ${syntax.length === 1 ? 'error' : 'errors'}:\n${lines.join('\n')}`)
  }

  const warnings = [...loaded.warnings.map((message) => ({ code: 'CONFIG', message })), ...project.warnings]
  return { config, modules, registries, project, dialect, table, warnings }
}

/**
 * The per-test session factory: core's registrations, the dialect's, the plugins', then the auto-stubs.
 *
 * Inferring the stubs walks every POU, so it runs once here on a probe session and the factory re-registers the result. In strict mode the probe throws before any test runs.
 */
function createSessionFactory({ config, modules, project, dialect, table }: Prepared, strict: boolean, coverage: CoverageRun | undefined): { factory: () => Session; warnings: ProjectWarning[] } {
  const core = defaultSessionFactory({ table, limits: toLimits(config), ...(coverage === undefined ? {} : { coverage }) })
  const source = `dialect ${dialect.id}`
  const base = (): Session => {
    const session = core()
    for (const def of dialect.fbStubs ?? []) session.fbStubs.register(def, source)
    for (const def of dialect.hostFns ?? []) session.hostFns.register(def, source)
    for (const [type, handler] of Object.entries(dialect.nodeHandlers ?? {})) session.nodeHandlers.set(type, handler)
    applyPlugins(modules, session, createPluginRegistries(), pluginOptions(config))
    return session
  }

  const probe = base()
  const fbsBefore = new Set(probe.fbStubs.list())
  const fnsBefore = new Set(probe.hostFns.list())
  const warningsBefore = probe.warnings.length
  applyAutoStubs(table, probe, { strict, libraries: project.libraries, ...(dialect.builtinLibraries === undefined ? {} : { builtinLibraries: dialect.builtinLibraries }) })
  const fbStubs = probe.fbStubs.list().filter((def) => !fbsBefore.has(def))
  const hostFns = probe.hostFns.list().filter((def) => !fnsBefore.has(def))

  const factory = (): Session => {
    const session = base()
    for (const def of fbStubs) session.fbStubs.register(def, 'autostub')
    for (const def of hostFns) session.hostFns.register(def, 'autostub')
    return session
  }
  return { factory, warnings: probe.warnings.slice(warningsBefore) }
}

function filterSuites(suites: SuiteDescriptor[], table: SymbolTable, opts: RunOptions): SuiteDescriptor[] {
  if (opts.suite === undefined && opts.test === undefined) return suites
  const suiteMatch = globToRegExp(opts.suite ?? '*', table.isCaseSensitive)
  const testMatch = globToRegExp(opts.test ?? '*', table.isCaseSensitive)
  const kept = suites
    .filter((s) => suiteMatch.test(s.suite))
    .map((s) => ({ ...s, tests: s.tests.filter((t) => testMatch.test(t.name)) }))
    .filter((s) => s.tests.length > 0)
  // A typo in a filter must not read as a green run.
  if (kept.length === 0) throw new ConfigError([`no test matches${opts.suite === undefined ? '' : ` --suite ${opts.suite}`}${opts.test === undefined ? '' : ` --test ${opts.test}`}`])
  return kept
}

function chooseReporters(opts: RunOptions, { config, registries }: Prepared, io: CliIo): Reporter[] {
  const defaults = io.env.GITHUB_ACTIONS === 'true' ? ['terminal', 'junit', 'github'] : ['terminal', 'junit']
  const ids = opts.reporters ?? (config.reporters.length > 0 ? config.reporters : defaults)
  return ids.map((id) => {
    const reporter = registries.reporters.get(id)
    if (reporter === undefined) throw new ConfigError([`unknown reporter '${id}'; installed reporters: ${[...registries.reporters.keys()].join(', ')}`])
    return reporter
  })
}

/** Writes the coverage files `coverage.report` asks for; the terminal table comes with the terminal reporter. */
async function writeCoverage(results: RunResultsV1, config: Config, io: ReporterIo): Promise<void> {
  if (results.coverage === undefined) return
  if (config.coverage.report.includes('json')) await io.writeFile('coverage.json', `${JSON.stringify(coverageToJson(results.coverage), null, 2)}\n`)
  if (config.coverage.report.includes('html')) await io.writeFile('coverage.html', renderCoverageHtml(results.coverage))
}

async function runPipeline(path: string | undefined, opts: RunOptions, io: CliIo): Promise<RunOutcome> {
  const prepared = await prepare(path, opts, io)
  const { config, project, dialect, table } = prepared
  const reporters = chooseReporters(opts, prepared, io)
  const coverageEnabled = opts.coverage === true || config.coverage.enabled
  const coverage = startCoverage(table, { enabled: coverageEnabled })

  const { factory, warnings: stubWarnings } = createSessionFactory(prepared, opts.strictLibraries === true || config.strict_libraries, coverage)
  const discovery = discoverSuites(table, { strategy: dialect.testStrategy, pattern: config.suite_pattern })
  const suites = filterSuites(discovery.suites, table, opts)

  const results = runAll(suites, {
    table,
    sessionFactory: factory,
    cycleTimeNs: config.cycle_time,
    ...(dialect.hooks === undefined ? {} : { hooks: dialect.hooks }),
    project: { vendor: project.vendor, dialect: dialect.id, name: project.name, projectFile: project.projectFile },
  })
  results.warnings.unshift(...prepared.warnings, ...stubWarnings, ...discovery.warnings)
  if (coverage !== undefined) results.coverage = summarizeCoverage(coverage.branches, coverage.sink.snapshot())

  const outDir = resolve(io.cwd, opts.outDir ?? DEFAULT_OUT_DIR)
  const reporterIo: ReporterIo = {
    outDir,
    writeFile: async (name, data) => {
      await mkdir(outDir, { recursive: true })
      await writeFile(join(outDir, name), data, 'utf8')
    },
    stdout: io.stdout,
    env: io.env,
  }
  for (const reporter of reporters) await reporter.onRunEnd(results, reporterIo)
  await writeCoverage(results, config, reporterIo)

  if (results.summary.failed + results.summary.errored > 0) return { exitCode: EXIT_FAILED, results }
  if (results.coverage !== undefined) {
    const { ok, worst } = checkThreshold(results.coverage, config.coverage.threshold)
    if (!ok) {
      io.stderr(`error: branch coverage is below the ${String(config.coverage.threshold)}% threshold${worst.length === 0 ? '' : `: ${worst.join(', ')}`}\n`)
      return { exitCode: EXIT_FAILED, results }
    }
  }
  return { exitCode: EXIT_PASSED, results }
}

/** Any failure before the tests ran, whatever its type, is exit 2; the message is written to be read, so the stack only shows with `--verbose`. */
function reportError(error: unknown, opts: ProjectOptions, io: CliIo): void {
  const message = error instanceof Error ? error.message : String(error)
  io.stderr(`error: ${message}\n`)
  if (opts.verbose === true && error instanceof Error && error.stack !== undefined) io.stderr(`${error.stack}\n`)
}

/** Runs the tests under `path` (default: the working directory). */
export async function run(path: string | undefined, opts: RunOptions = {}, io: CliIo = processIo()): Promise<RunOutcome> {
  try {
    return await runPipeline(path, opts, io)
  } catch (error) {
    reportError(error, opts, io)
    return { exitCode: EXIT_ERROR }
  }
}

function renderDiscovery(suites: SuiteDescriptor[]): string {
  const lines = suites.flatMap((s) => [`${s.suite} (${s.location.file}:${String(s.location.line)})`, ...s.tests.map((t) => `  ${t.name}`)])
  const total = suites.reduce((sum, s) => sum + s.tests.length, 0)
  return `${[...lines, `${String(suites.length)} ${suites.length === 1 ? 'suite' : 'suites'}, ${String(total)} ${total === 1 ? 'test' : 'tests'}`].join('\n')}\n`
}

/** Lists the suites and tests under `path` without running them, as text or as one JSON document on stdout. */
export async function discover(path: string | undefined, opts: DiscoverOptions & { json?: boolean } = {}, io: CliIo = processIo()): Promise<number> {
  try {
    const { project, dialect, table, warnings: projectWarnings, config } = await prepare(path, opts, io)
    const { suites, warnings: suiteWarnings } = discoverSuites(table, { strategy: dialect.testStrategy, pattern: config.suite_pattern })
    const warnings = [...projectWarnings, ...suiteWarnings]
    if (opts.json === true) {
      const info = { vendor: project.vendor, dialect: dialect.id, name: project.name, projectFile: project.projectFile }
      io.stdout(`${JSON.stringify({ project: info, suites, warnings }, null, 2)}\n`)
    } else {
      for (const w of warnings) io.stderr(`warning: ${w.message}\n`)
      io.stdout(renderDiscovery(suites))
    }
    return EXIT_PASSED
  } catch (error) {
    reportError(error, opts, io)
    return EXIT_ERROR
  }
}
