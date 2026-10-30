import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CliIo } from '../src/run.js'
import { watchProject, type Watcher, type WatchRun } from '../src/watch.js'

const WAIT_MS = 20_000

const fb = (name: string, uses?: string): string => `FUNCTION_BLOCK ${name}
VAR_INPUT
  bEnable : BOOL;
END_VAR
VAR_OUTPUT
  nCount : DINT;
END_VAR
${uses === undefined ? '' : `VAR\n  inner : ${uses};\nEND_VAR\n`}IF bEnable THEN
  nCount := nCount + 1;
END_IF
END_FUNCTION_BLOCK
`

const suite = (name: string, uut: string, expected = 1): string => `FUNCTION_BLOCK ${name}
VAR
  uut : ${uut};
END_VAR
METHOD Test_Counts
  uut(bEnable := TRUE);
  ASSERT_EQUAL_DINT(uut.nCount, ${String(expected)});
END_METHOD
END_FUNCTION_BLOCK
`

let cwd: string
let root: string
let watcher: Watcher | undefined
let runs: WatchRun[]
let stderr: string
let stdout: string
let waiters: (() => void)[]

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'plc-st-test-watch-'))
  root = join(cwd, 'project')
  runs = []
  waiters = []
  stderr = ''
  stdout = ''
  await write({
    // FB_A uses FB_Base, so a change to FB_Base reaches TEST_A but not TEST_B.
    'src/FB_Base.st': fb('FB_Base'),
    'src/FB_A.st': fb('FB_A', 'FB_Base'),
    'src/FB_B.st': fb('FB_B'),
    'Tests/TEST_A.st': suite('TEST_A', 'FB_A'),
    'Tests/TEST_B.st': suite('TEST_B', 'FB_B'),
  })
})

afterEach(async () => {
  await watcher?.close()
  watcher = undefined
  await rm(cwd, { recursive: true, force: true })
})

async function write(files: Record<string, string>): Promise<void> {
  for (const [file, text] of Object.entries(files)) {
    await mkdir(join(root, file, '..'), { recursive: true })
    await writeFile(join(root, file), text)
  }
}

function start(isTTY = false): Promise<Watcher> {
  const io: CliIo = {
    cwd,
    env: {},
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
    isTTY,
  }
  return watchProject(
    'project',
    {
      reporters: ['terminal', 'junit'],
      debounceMs: 50,
      runRecorder: (run) => {
        runs.push(run)
        for (const wake of waiters) wake()
      },
    },
    io,
  )
}

/** Waits (bounded) for a run after the first that ran at least one suite; an empty run, such as the one for a repeated write event, never matches. */
function nextRunWithSuites(): Promise<WatchRun> {
  const seen = runs.length
  return new Promise<WatchRun>((resolve, reject) => {
    const check = (): boolean => {
      const found = runs.slice(seen).find((run) => run.suites.length > 0)
      if (found !== undefined) resolve(found)
      return found !== undefined
    }
    const timeout = setTimeout(() => reject(new Error(`no suite ran within ${String(WAIT_MS)} ms; runs: ${JSON.stringify(runs.slice(seen))}`)), WAIT_MS)
    const wake = (): void => {
      if (check()) {
        clearTimeout(timeout)
        waiters = waiters.filter((w) => w !== wake)
      }
    }
    waiters.push(wake)
  })
}

describe('watchProject', () => {
  it('runs every suite once at start', async () => {
    watcher = await start()
    expect(runs).toEqual([{ suites: ['TEST_A', 'TEST_B'], exitCode: 0 }])
    expect(stderr).toContain('watching')
  })

  it('reruns only the suite that uses a changed source unit', async () => {
    watcher = await start()
    const next = nextRunWithSuites()
    await write({ 'src/FB_B.st': fb('FB_B').replace('nCount + 1', 'nCount + 2') })
    // FB_B now counts by 2, so TEST_B fails; that proves the new text ran.
    expect(await next).toEqual({ suites: ['TEST_B'], exitCode: 1 })
  })

  it('reruns the suites that reach a changed unit through another POU', async () => {
    watcher = await start()
    const next = nextRunWithSuites()
    await write({ 'src/FB_Base.st': fb('FB_Base').replace('nCount + 1', 'nCount + 3') })
    expect(await next).toEqual({ suites: ['TEST_A'], exitCode: 0 })
  })

  it('reruns only the suite of a changed test file', async () => {
    watcher = await start()
    const next = nextRunWithSuites()
    await write({ 'Tests/TEST_A.st': suite('TEST_A', 'FB_A', 5) })
    expect(await next).toEqual({ suites: ['TEST_A'], exitCode: 1 })
  })

  it('runs no suite for a change that touches no unit', async () => {
    watcher = await start()
    await write({ 'notes.md': 'hello' })
    await expect.poll(() => runs.length, { timeout: WAIT_MS }).toBeGreaterThan(1)
    expect(runs.slice(1).every((run) => run.suites.length === 0)).toBe(true)
  })

  it('clears the screen before a run only on a TTY', async () => {
    watcher = await start(true)
    expect(stdout.startsWith('\x1b[2J')).toBe(true)
    await watcher.close()
    watcher = undefined
    stdout = ''
    watcher = await start(false)
    expect(stdout).not.toContain('\x1b[2J')
  })
})
