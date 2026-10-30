/**
 * Plugin host: resolves plugin packages that are already installed and merges what they contribute into the runner's registries.
 *
 * Plugins are never downloaded or installed here; a name that does not resolve from the project (or from the CLI's own install location) is an error that tells the user how to install it.
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { isCompatible, PLUGIN_API_VERSION } from '@plc-st/plugin-api'
import type { Dialect, FbStubDef, HostFnDef, Ingestor, PluginModule, Reporter, Simulator, SimulatorSession } from '@plc-st/plugin-api'
import { PluginError } from '../errors.js'
import type { Session } from '../session.js'

/** Name-keyed collections the plugin contributions are merged into; later registrations replace earlier ones with a `registry-collision` warning on the session. */
export interface PluginRegistries {
  ingestors: Map<string, Ingestor>
  dialects: Map<string, Dialect>
  simulators: Map<string, Simulator>
  reporters: Map<string, Reporter>
}

export interface ApplyPluginsOptions {
  /** Cycle time handed to simulators; default 10 ms. */
  cycleTimeNs?: bigint
  /** The `simulators` section of the user configuration, keyed by simulator id. */
  simulatorConfig?: Record<string, Record<string, unknown>>
}

const DEFAULT_CYCLE_TIME_NS = 10_000_000n

export function createPluginRegistries(): PluginRegistries {
  return { ingestors: new Map(), dialects: new Map(), simulators: new Map(), reporters: new Map() }
}

function resolvePlugin(name: string, projectRoot: string): string {
  const fromProject = createRequire(path.join(projectRoot, 'package.json'))
  const fromHost = createRequire(import.meta.url)
  for (const req of [fromProject, fromHost]) {
    try {
      return req.resolve(name)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw new PluginError(`plugin ${name} could not be resolved: ${(err as Error).message}`)
    }
  }
  throw new PluginError(`plugin ${name} not installed — run: npm i -D ${name}`)
}

function isPluginModule(x: unknown): x is PluginModule {
  return typeof x === 'object' && x !== null && 'apiVersion' in x
}

/** Resolves each plugin from the project's installed packages (then the CLI's own), imports it and checks its `apiVersion`; the module must export a `PluginModule` as `default` or `plugin`. */
export async function loadPlugins(names: string[], projectRoot: string): Promise<PluginModule[]> {
  const mods: PluginModule[] = []
  for (const name of names) {
    const resolved = resolvePlugin(name, projectRoot)
    let ns: Record<string, unknown>
    try {
      ns = (await import(pathToFileURL(resolved).href)) as Record<string, unknown>
    } catch (err) {
      throw new PluginError(`plugin ${name} failed to load: ${(err as Error).message}`)
    }
    const candidate = ns['default'] ?? ns['plugin']
    if (!isPluginModule(candidate)) throw new PluginError(`plugin ${name} does not export a PluginModule as 'default' or 'plugin'`)
    if (!isCompatible(candidate.apiVersion)) {
      throw new PluginError(`plugin ${name} targets plugin-api v${String(candidate.apiVersion)}, this runner supports v${String(PLUGIN_API_VERSION)}`)
    }
    mods.push(candidate)
  }
  return mods
}

function merge<T extends { id: string }>(kind: string, items: T[] | undefined, into: Map<string, T>, session: Session): void {
  for (const item of items ?? []) {
    if (into.has(item.id)) session.warn('registry-collision', `${kind} '${item.id}' registered by a plugin replaces an existing one`)
    into.set(item.id, item)
  }
}

/** Exposes `session` to one simulator; every registration is scoped to that session and attributed to the simulator's id. */
function simulatorSession(sim: Simulator, session: Session, opts: ApplyPluginsOptions): SimulatorSession {
  return {
    cycleTimeNs: opts.cycleTimeNs ?? DEFAULT_CYCLE_TIME_NS,
    onPreCycle: (fn) => void session.preCycle.push(fn),
    onPostCycle: (fn) => void session.postCycle.push(fn),
    registerHostFn: (def: HostFnDef) => session.hostFns.register(def, `simulator ${sim.id}`),
    registerFbStub: (def: FbStubDef) => session.fbStubs.register(def, `simulator ${sim.id}`),
    config: opts.simulatorConfig?.[sim.id] ?? {},
  }
}

/** Merges the plugins' ingestors, dialects, simulators and reporters into `registries` (collisions warn on the session) and attaches every simulator to `session`. */
export function applyPlugins(mods: PluginModule[], session: Session, registries: PluginRegistries, opts: ApplyPluginsOptions = {}): void {
  for (const mod of mods) {
    merge('ingestor', mod.ingestors, registries.ingestors, session)
    merge('dialect', mod.dialects, registries.dialects, session)
    merge('simulator', mod.simulators, registries.simulators, session)
    merge('reporter', mod.reporters, registries.reporters, session)
    for (const sim of mod.simulators ?? []) sim.attach(simulatorSession(sim, session, opts))
  }
}
