import { existsSync, readFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { VERSION as CORE_VERSION } from '@plc-st/core'
import { main } from '../src/program.js'
import type { CliIo } from '../src/run.js'

const fixture = (name: string): string => join(import.meta.dirname, 'fixtures', name)

let cwd: string

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'plc-st-test-cli-'))
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

interface Result {
  code: number
  stdout: string
  stderr: string
}

async function cli(args: string[], env: CliIo['env'] = {}): Promise<Result> {
  let stdout = ''
  let stderr = ''
  const io: CliIo = {
    cwd,
    env,
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  }
  return { code: await main(args, io), stdout, stderr }
}

/** Writes `files` under a project folder in the temporary working directory and returns its path. */
async function project(files: Record<string, string>): Promise<string> {
  const root = join(cwd, 'project')
  for (const [file, text] of Object.entries(files)) {
    await mkdir(join(root, file, '..'), { recursive: true })
    await writeFile(join(root, file), text)
  }
  return root
}

describe('run', () => {
  it('exits 0 on a passing project, prints the terminal report and writes junit.xml', async () => {
    const { code, stdout } = await cli(['run', fixture('passing')])
    expect(code).toBe(0)
    expect(stdout).toContain('2 passed')
    expect(readFileSync(join(cwd, 'plc-st-test-results', 'junit.xml'), 'utf8')).toContain('<testcase name="Test_CountsWhenEnabled"')
  })

  it('is the default command', async () => {
    const { code, stdout } = await cli([fixture('passing'), '--reporter', 'terminal'])
    expect(code).toBe(0)
    expect(stdout).toContain('2 passed')
  })

  it('exits 1 when a test fails', async () => {
    const { code, stdout } = await cli(['run', fixture('failing')])
    expect(code).toBe(1)
    expect(stdout).toContain('1 failed')
    expect(stdout).toContain('Test_WrongExpectation')
  })

  it('exits 2 listing the candidates of an ambiguous project', async () => {
    const { code, stderr } = await cli(['run', fixture('ambiguous')])
    expect(code).toBe(2)
    expect(stderr).toContain('found 2 PLC projects')
    expect(stderr).toContain('Generic Structured Text (1 file) (.)')
    expect(stderr).toContain('Second project (second.proj)')
    expect(stderr).toContain('set "project:" in plc-st-test.config.yml')
  })

  it('resolves the ambiguity with --project', async () => {
    const { code, stdout } = await cli(['run', fixture('ambiguous'), '--project', '.', '--reporter', 'terminal'])
    expect(code).toBe(0)
    expect(stdout).toContain('1 passed')
  })

  it('exits 2 with the config validation message', async () => {
    const { code, stderr } = await cli(['run', fixture('badconfig')])
    expect(code).toBe(2)
    expect(stderr).toContain('cycle_time: must be a TIME literal like T#10ms')
  })

  it('exits 2 for a missing explicit config, resolved from the working directory', async () => {
    const { code, stderr } = await cli(['run', fixture('passing'), '--config', 'nope.yml'])
    expect(code).toBe(2)
    expect(stderr).toContain(`${join(cwd, 'nope.yml')}: config file not found`)
  })

  it('exits 2 naming the installed dialects for an unknown one', async () => {
    const root = await project({ 'plc-st-test.config.yml': 'dialect: twincat\n', 'Tests/TEST_A.st': readFileSync(join(fixture('badconfig'), 'Tests', 'TEST_Any.st'), 'utf8') })
    const { code, stderr } = await cli(['run', root])
    expect(code).toBe(2)
    expect(stderr).toContain("unknown dialect 'twincat'; installed dialects: standard")
  })

  it('exits 2 listing syntax errors with their location', async () => {
    const root = await project({ 'src/Broken.st': 'FUNCTION_BLOCK Broken\nVAR\n  x : ;\nEND_VAR\nEND_FUNCTION_BLOCK\n' })
    const { code, stderr } = await cli(['run', root])
    expect(code).toBe(2)
    expect(stderr).toMatch(/syntax errors?:/)
    expect(stderr).toContain('src/Broken.st:3:')
  })

  it('exits 2 for a plugin that is not installed', async () => {
    const root = await project({ 'plc-st-test.config.yml': 'plugins: [plc-st-no-such-plugin]\n', 'a.st': '' })
    const { code, stderr } = await cli(['run', root])
    expect(code).toBe(2)
    expect(stderr).toContain('plugin plc-st-no-such-plugin not installed')
  })

  it('exits 2 for an unknown reporter, naming the installed ones', async () => {
    const { code, stderr } = await cli(['run', fixture('passing'), '--reporter', 'xml'])
    expect(code).toBe(2)
    expect(stderr).toContain("unknown reporter 'xml'; installed reporters: terminal, junit, json, tap, github")
  })

  it('exits 2 for an unknown option', async () => {
    const { code, stderr } = await cli(['run', fixture('passing'), '--nope'])
    expect(code).toBe(2)
    expect(stderr).toContain('--nope')
  })

  it('writes the selected reporters to --out-dir, relative to the working directory', async () => {
    const { code, stdout } = await cli(['run', fixture('passing'), '--reporter', 'json', 'tap', '--out-dir', 'out'])
    expect(code).toBe(0)
    expect(stdout).toBe('')
    expect(JSON.parse(readFileSync(join(cwd, 'out', 'results.json'), 'utf8'))).toMatchObject({ summary: { total: 2, passed: 2 }, project: { dialect: 'standard' } })
    expect(existsSync(join(cwd, 'out', 'results.tap'))).toBe(true)
    expect(existsSync(join(cwd, 'out', 'junit.xml'))).toBe(false)
  })

  it('takes the reporters from the config when --reporter is absent', async () => {
    const root = join(cwd, 'copy')
    await cp(fixture('passing'), root, { recursive: true })
    await writeFile(join(root, 'plc-st-test.config.yml'), 'reporters: [tap]\n')
    await cli(['run', root])
    expect(existsSync(join(cwd, 'plc-st-test-results', 'results.tap'))).toBe(true)
    expect(existsSync(join(cwd, 'plc-st-test-results', 'junit.xml'))).toBe(false)
  })

  it('adds the github reporter by default under GitHub Actions', async () => {
    const { code, stdout } = await cli(['run', fixture('failing')], { GITHUB_ACTIONS: 'true' })
    expect(code).toBe(1)
    expect(stdout).toContain('::error ')
  })

  it('filters with --suite and --test', async () => {
    const { code, stdout } = await cli(['run', fixture('failing'), '--suite', 'test_c*', '--test', 'Test_Counts*', '--reporter', 'terminal'])
    expect(code).toBe(0)
    expect(stdout).toContain('1 passed')
    expect(stdout).not.toContain('failed')
  })

  it('exits 2 when the filters match nothing', async () => {
    const { code, stderr } = await cli(['run', fixture('passing'), '--test', 'Nope*'])
    expect(code).toBe(2)
    expect(stderr).toContain('no test matches --test Nope*')
  })

  it('reports coverage in the results and the configured files', async () => {
    const root = join(cwd, 'copy')
    await cp(fixture('passing'), root, { recursive: true })
    await writeFile(join(root, 'plc-st-test.config.yml'), 'coverage: { report: [json, html] }\n')
    const { code, stdout } = await cli(['run', root, '--coverage', '--reporter', 'terminal', 'json'])
    expect(code).toBe(0)
    expect(stdout).toContain('Coverage (branches)')
    const results = JSON.parse(readFileSync(join(cwd, 'plc-st-test-results', 'results.json'), 'utf8')) as { coverage: { branchesTotal: number; branchesHit: number } }
    expect(results.coverage).toMatchObject({ branchesTotal: 2, branchesHit: 2 })
    expect(JSON.parse(readFileSync(join(cwd, 'plc-st-test-results', 'coverage.json'), 'utf8'))).toEqual(results.coverage)
    expect(readFileSync(join(cwd, 'plc-st-test-results', 'coverage.html'), 'utf8')).toContain('<!DOCTYPE html>')
  })

  it('exits 1 when coverage is below the threshold, naming the POU', async () => {
    const root = join(cwd, 'copy')
    await cp(fixture('passing'), root, { recursive: true })
    await writeFile(join(root, 'Tests', 'TEST_Counter.st'), 'FUNCTION_BLOCK TEST_Counter\nVAR\n  uut : FB_Counter;\nEND_VAR\nMETHOD Test_Disabled\n  uut(bEnable := FALSE);\n  ASSERT_EQUAL_DINT(uut.nCount, 0);\nEND_METHOD\nEND_FUNCTION_BLOCK\n')
    await writeFile(join(root, 'plc-st-test.config.yml'), 'coverage: { enabled: true, threshold: 80 }\n')
    const { code, stderr } = await cli(['run', root, '--reporter', 'terminal'])
    expect(code).toBe(1)
    expect(stderr).toContain('below the 80% threshold')
    expect(stderr).toContain('FB_Counter')
  })

  const usesLibrary = {
    'Tests/TEST_Lib.st': 'FUNCTION_BLOCK TEST_Lib\nVAR\n  fb : FB_FromLibrary;\nEND_VAR\nMETHOD Test_Stubbed\n  fb(nIn := 1);\n  ASSERT_TRUE(TRUE);\nEND_METHOD\nMETHOD Test_StubbedAgain\n  fb(nIn := 2);\n  ASSERT_TRUE(TRUE);\nEND_METHOD\nEND_FUNCTION_BLOCK\n',
  }

  it('auto-stubs unresolved library symbols for every test, warning once', async () => {
    const { code, stdout } = await cli(['run', await project(usesLibrary), '--reporter', 'terminal', 'json'])
    expect(code).toBe(0)
    expect(stdout).toContain('2 passed')
    const { warnings } = JSON.parse(readFileSync(join(cwd, 'plc-st-test-results', 'results.json'), 'utf8')) as { warnings: { code: string; message: string }[] }
    expect(warnings.filter((w) => w.code === 'LIBRARY_AUTOSTUBBED')).toHaveLength(1)
  })

  it('exits 2 with --strict-libraries before running a test', async () => {
    const { code, stdout, stderr } = await cli(['run', await project(usesLibrary), '--strict-libraries'])
    expect(code).toBe(2)
    expect(stderr).toContain("function block 'FB_FromLibrary'")
    expect(stdout).toBe('')
  })

  it('reports unknown config keys as warnings', async () => {
    const root = join(cwd, 'copy')
    await cp(fixture('passing'), root, { recursive: true })
    await writeFile(join(root, 'plc-st-test.config.yml'), 'foo: 1\n')
    const { code, stdout } = await cli(['run', root, '--reporter', 'terminal'])
    expect(code).toBe(0)
    expect(stdout).toContain("unknown config key 'foo' ignored")
  })
})

describe('discover', () => {
  it('lists suites and tests as text', async () => {
    const { code, stdout } = await cli(['discover', fixture('passing')])
    expect(code).toBe(0)
    expect(stdout).toContain('TEST_Counter (Tests/TEST_Counter.st:')
    expect(stdout).toContain('  Test_HoldsWhenDisabled')
    expect(stdout).toContain('1 suite, 2 tests')
    expect(existsSync(join(cwd, 'plc-st-test-results'))).toBe(false)
  })

  it('prints parseable JSON with --json', async () => {
    const { code, stdout } = await cli(['discover', fixture('passing'), '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(stdout) as { project: { dialect: string }; suites: { suite: string; tests: { name: string }[] }[] }
    expect(parsed.project.dialect).toBe('standard')
    expect(parsed.suites.map((s) => s.suite)).toEqual(['TEST_Counter'])
    expect(parsed.suites[0]?.tests.map((t) => t.name)).toEqual(['Test_CountsWhenEnabled', 'Test_HoldsWhenDisabled'])
  })

  it('exits 2 on a config error', async () => {
    const { code, stderr } = await cli(['discover', fixture('badconfig')])
    expect(code).toBe(2)
    expect(stderr).toContain('cycle_time: must be a TIME literal like T#10ms')
  })
})

describe('--version', () => {
  it('prints the CLI, core and plugin-api versions', async () => {
    const { code, stdout } = await cli(['--version'])
    expect(code).toBe(0)
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version: string }
    expect(stdout.trim()).toBe(`plc-st-test ${pkg.version} (core ${CORE_VERSION}, plugin-api v1)`)
  })
})
