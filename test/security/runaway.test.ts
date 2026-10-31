import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runCli, scratch, type Scratch } from './helpers.js'

let s: Scratch
beforeEach(async () => void (s = await scratch('runaway')))
afterEach(() => s.cleanup())

interface Results {
  suites: { tests: { name: string; status: string; failure?: { kind: string; message: string } }[] }[]
}

/** The fixture sets max_execution_time_ms: 5000; a runaway test must stop well inside a generous multiple of that, on slow CI runners too. */
const CEILING_MS = 60_000

const readResults = async (): Promise<Results> => JSON.parse(await readFile(join(s.dir, 'out', 'results.json'), 'utf8')) as Results

describe('runaway code', () => {
  it('errors every runaway test with the limit kind and exits 1 instead of crashing or hanging', async () => {
    const { code, wallMs, stderr } = await runCli(['run', s.project, '--reporter', 'json', '--out-dir', join(s.dir, 'out')], { cwd: s.dir })
    expect(code).toBe(1)
    expect(stderr).not.toMatch(/RangeError|Maximum call stack|heap out of memory|FATAL ERROR/)
    expect(wallMs).toBeLessThan(CEILING_MS)

    const tests = Object.fromEntries((await readResults()).suites.flatMap((x) => x.tests).map((t) => [t.name, t]))
    expect(Object.keys(tests).sort()).toEqual(['Test_DeepRecursion', 'Test_HugeArray', 'Test_InfiniteLoop'])
    for (const t of Object.values(tests)) {
      expect(t.status).toBe('errored')
      expect(t.failure?.kind).toBe('limit')
    }
    expect(tests['Test_InfiniteLoop']?.failure?.message).toMatch(/limits\.maxLoopIterations|max_execution_time_ms/)
    expect(tests['Test_HugeArray']?.failure?.message).toMatch(/max_allocated_elements/)
    expect(tests['Test_DeepRecursion']?.failure?.message).toMatch(/limits\.maxRecursionDepth/)
  })

  it('stops a loop that would outlive the iteration cap at the configured time budget', async () => {
    await writeFile(join(s.project, 'plc-st-test.config.yml'), 'limits:\n  max_execution_time_ms: 1000\n  max_loop_iterations: 2000000000\n')
    const { code, wallMs } = await runCli(['run', s.project, '--test', 'Test_InfiniteLoop', '--reporter', 'json', '--out-dir', join(s.dir, 'out')], { cwd: s.dir })
    expect(code).toBe(1)
    expect(wallMs).toBeLessThan(CEILING_MS)
    const t = (await readResults()).suites.flatMap((x) => x.tests)[0]
    expect(t?.failure?.kind).toBe('limit')
    expect(t?.failure?.message).toContain('max_execution_time_ms=1000')
  })
})
