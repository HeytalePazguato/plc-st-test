/**
 * `run --watch`: runs once, then watches the project root and reruns only the suites a change can affect.
 *
 * Every rerun goes through `run`, which re-reads the config and re-ingests the project, so a change never sees stale state. The watcher only decides which suites to select: the units whose text changed since the last ingest name the POUs that changed, and every POU that transitively references one of them (variable types, EXTENDS, IMPLEMENTS, calls) is affected through a reverse-dependency map built from the symbol table. A suite is rerun when it is itself affected.
 */

import { basename, resolve, sep } from 'node:path'
import { watch as watchFiles } from 'chokidar'
import type { Pou, SymbolTable } from '@plc-st/core'
import { processIo, run, type CliIo, type RunOptions, type RunSelection } from './run.js'

const DEFAULT_OUT_DIR = 'plc-st-test-results'
const DEFAULT_DEBOUNCE_MS = 200
const CLEAR_SCREEN = '\x1b[2J\x1b[3J\x1b[H'

/** One rerun, as handed to `runRecorder`. */
export interface WatchRun {
  /** Names of the suites that ran; empty when the change affected none or the run stopped on an error. */
  suites: string[]
  exitCode: number
}

export interface WatchOptions extends RunOptions {
  /** Quiet period after the last file event before a rerun starts; defaults to 200 ms. */
  debounceMs?: number
  /** Called after every run, the first one included; tests use it to observe which suites ran. */
  runRecorder?: (run: WatchRun) => void
}

export interface Watcher {
  /** Resolves once `close` has finished. */
  closed: Promise<void>
  /** Stops watching and waits for a run in progress to end. */
  close(): Promise<void>
}

/** The identifiers a POU's code and declarations mention, as normalised POU-name candidates. */
function referencedNames(pou: Pou, table: SymbolTable): Set<string> {
  const names = new Set<string>()
  const add = (text: string): void => {
    for (const part of text.split('.')) names.add(table.normalizeKey(part))
  }
  for (const name of [pou.extendsName, ...pou.implementsNames, ...pou.baseInterfaces]) if (name !== undefined) add(name)
  const roots = [pou.bodyNode, ...pou.actions.flatMap((a) => a.bodyNodes)]
  for (const root of roots) for (const node of root?.descendantsOfType(['identifier', 'qualified_identifier']) ?? []) add(node.text)
  return names
}

/** For every POU name, the POUs that mention it. */
function reverseDependencies(table: SymbolTable): Map<string, Set<string>> {
  const known = new Set(table.getPous().map((p) => table.normalizeKey(p.name)))
  const reverse = new Map<string, Set<string>>()
  for (const pou of table.getPous()) {
    const self = table.normalizeKey(pou.name)
    for (const name of referencedNames(pou, table)) {
      if (!known.has(name) || name === self) continue
      const users = reverse.get(name) ?? new Set<string>()
      users.add(self)
      reverse.set(name, users)
    }
  }
  return reverse
}

/** The POUs declared in each unit; an action unit counts for its owner. */
function pousByUnit(table: SymbolTable): Map<string, Set<string>> {
  const byUnit = new Map<string, Set<string>>()
  const add = (unitId: string, pou: string): void => {
    const set = byUnit.get(unitId) ?? new Set<string>()
    set.add(pou)
    byUnit.set(unitId, set)
  }
  for (const pou of table.getPous()) {
    const name = table.normalizeKey(pou.name)
    add(pou.unitId, name)
    for (const action of pou.actions) add(action.unitId, name)
  }
  return byUnit
}

/** What the last successful ingest looked like. */
interface Snapshot {
  texts: Map<string, string>
  pous: Map<string, Set<string>>
}

/**
 * The suites to rerun for `selection`, given the previous snapshot. A unit that declares no POU (types, globals) can change anything, so it selects every suite.
 */
function affectedSuites({ table, suites }: RunSelection, previous: Snapshot, next: Snapshot): RunSelection['suites'] {
  const changedUnits = [...new Set([...previous.texts.keys(), ...next.texts.keys()])].filter((id) => previous.texts.get(id) !== next.texts.get(id))
  const changed = new Set<string>()
  for (const id of changedUnits) {
    const declared = [...(previous.pous.get(id) ?? []), ...(next.pous.get(id) ?? [])]
    if (declared.length === 0) return suites
    for (const name of declared) changed.add(name)
  }

  const reverse = reverseDependencies(table)
  const affected = new Set(changed)
  const queue = [...changed]
  for (let name = queue.pop(); name !== undefined; name = queue.pop()) {
    for (const user of reverse.get(name) ?? []) {
      if (affected.has(user)) continue
      affected.add(user)
      queue.push(user)
    }
  }
  return suites.filter((s) => affected.has(table.normalizeKey(s.suite)))
}

/** Runs the tests under `path`, then again whenever a file in it changes; resolves once the first run is done and the watcher is ready. */
export async function watchProject(path: string | undefined, opts: WatchOptions = {}, io: CliIo = processIo()): Promise<Watcher> {
  const { debounceMs = DEFAULT_DEBOUNCE_MS, runRecorder, ...runOpts } = opts
  const root = resolve(io.cwd, path ?? '.')
  const outDir = resolve(io.cwd, runOpts.outDir ?? DEFAULT_OUT_DIR)
  const configFile = runOpts.config === undefined ? undefined : resolve(io.cwd, runOpts.config)

  const isIgnored = (file: string): boolean => {
    const absolute = resolve(file)
    if (absolute === outDir || absolute.startsWith(outDir + sep)) return true
    return absolute.split(sep).some((part) => part === 'node_modules' || part === '.git')
  }
  const isConfig = (file: string): boolean => /^plc-st-test\.config\.ya?ml$/.test(basename(file)) || resolve(file) === configFile

  let snapshot: Snapshot | undefined
  let pending = new Set<string>()
  let timer: NodeJS.Timeout | undefined
  let running: Promise<void> = Promise.resolve()
  let closing: Promise<void> | undefined

  const rerun = async (changed: ReadonlySet<string>): Promise<void> => {
    const everything = snapshot === undefined || [...changed].some(isConfig)
    let selected: string[] = []
    const outcome = await run(path, {
      ...runOpts,
      select: (selection) => {
        const next: Snapshot = { texts: new Map(selection.project.units.map((u) => [u.id, u.text])), pous: pousByUnit(selection.table) }
        const chosen = snapshot === undefined || everything ? selection.suites : affectedSuites(selection, snapshot, next)
        snapshot = next
        selected = chosen.map((s) => s.suite)
        if (chosen.length > 0 && io.isTTY === true) io.stdout(CLEAR_SCREEN)
        return chosen
      },
    }, io)
    runRecorder?.({ suites: selected, exitCode: outcome.exitCode })
  }

  const watcher = watchFiles(root, { ignored: isIgnored, ignoreInitial: true })
  watcher.on('error', (error) => void io.stderr(`error: watcher: ${error instanceof Error ? error.message : String(error)}\n`))
  watcher.on('all', (_event, file) => {
    if (closing !== undefined) return
    pending.add(file)
    clearTimeout(timer)
    timer = setTimeout(() => {
      const batch = pending
      pending = new Set()
      running = running.then(() => rerun(batch))
    }, debounceMs)
  })
  // Events from before the first run ends are not lost: the watcher is ready first, and the run after it snapshots whatever is on disk.
  await new Promise<void>((resolveReady) => void watcher.once('ready', resolveReady))
  await rerun(new Set())
  io.stderr(`watching ${root} for changes (Ctrl+C to stop)\n`)

  let markClosed: () => void = () => undefined
  const closed = new Promise<void>((resolveClosed) => {
    markClosed = resolveClosed
  })
  const close = (): Promise<void> => {
    closing ??= (async () => {
      clearTimeout(timer)
      await watcher.close()
      await running
      markClosed()
    })()
    return closing
  }
  return { closed, close }
}
