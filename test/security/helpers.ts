import { spawn } from 'node:child_process'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dirname, '..', '..')

/** The built CLI entry point; `pnpm build` must have run (CI and `pnpm test` order guarantee it). */
export const CLI = join(REPO, 'packages', 'cli', 'dist', 'cli.js')

export const fixture = (name: string): string => join(import.meta.dirname, 'fixtures', name)

export interface CliResult {
  code: number | null
  stdout: string
  stderr: string
  wallMs: number
}

export interface CliOptions {
  cwd: string
  env?: Record<string, string>
  /** Extra `node` arguments, e.g. `--require <hook>`. */
  nodeArgs?: string[]
}

/** Spawns the built CLI as a real child process, so the real reporters, exit codes and process boundaries are exercised. */
export function runCli(args: string[], opts: CliOptions): Promise<CliResult> {
  const start = Date.now()
  return new Promise((resolvePromise, reject) => {
    const env = { ...process.env }
    // The ambient CI environment must not change which reporters run or where summaries go.
    delete env['GITHUB_ACTIONS']
    delete env['GITHUB_STEP_SUMMARY']
    delete env['GITHUB_WORKSPACE']
    Object.assign(env, opts.env)
    const child = spawn(process.execPath, [...(opts.nodeArgs ?? []), CLI, ...args], { cwd: opts.cwd, env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => void (stdout += d.toString('utf8')))
    child.stderr.on('data', (d: Buffer) => void (stderr += d.toString('utf8')))
    child.on('error', reject)
    child.on('close', (code) => resolvePromise({ code, stdout, stderr, wallMs: Date.now() - start }))
  })
}

export interface Scratch {
  dir: string
  project: string
  cleanup: () => Promise<void>
}

/** A throw-away directory, optionally pre-populated with a copy of a fixture project (under `subdir`). */
export async function scratch(copyOf?: string, subdir = 'project'): Promise<Scratch> {
  const dir = await mkdtemp(join(tmpdir(), 'plc-st-test-security-'))
  const project = join(dir, subdir)
  if (copyOf) await cp(fixture(copyOf), project, { recursive: true })
  return { dir, project, cleanup: () => rm(dir, { recursive: true, force: true }) }
}
