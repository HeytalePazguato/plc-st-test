import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from '../src/config.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'plc-st-config-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const write = (name: string, text: string) => writeFile(join(dir, name), text)

const DEFAULTS = {
  cycle_time: 10_000_000n,
  tests_folder: 'Tests',
  suite_pattern: 'TEST_*',
  defines: {},
  strict_libraries: false,
  limits: { max_recursion_depth: 100, max_loop_iterations: 1_000_000, max_cycles_per_test: 100_000, max_execution_time_ms: 30_000, max_allocated_elements: 10_000_000 },
  coverage: { enabled: false, report: ['terminal', 'json'], threshold: 0 },
  reporters: [],
  plugins: [],
  mode: 'simulation',
  simulators: {},
}

describe('loadConfig', () => {
  it('returns the full defaults when no file exists', async () => {
    const loaded = await loadConfig(dir)
    expect(loaded.config).toEqual(DEFAULTS)
    expect(loaded.warnings).toEqual([])
    expect(loaded.path).toBeUndefined()
  })

  it('returns the full defaults for an empty file', async () => {
    await write('plc-st-test.config.yml', '')
    const loaded = await loadConfig(dir)
    expect(loaded.config).toEqual(DEFAULTS)
    expect(loaded.path).toBe(join(dir, 'plc-st-test.config.yml'))
  })

  it('reads the .yaml spelling', async () => {
    await write('plc-st-test.config.yaml', 'project: Plant\n')
    expect((await loadConfig(dir)).config.project).toBe('Plant')
  })

  it('prefers .yml and warns when both exist', async () => {
    await write('plc-st-test.config.yml', 'project: A\n')
    await write('plc-st-test.config.yaml', 'project: B\n')
    const loaded = await loadConfig(dir)
    expect(loaded.config.project).toBe('A')
    expect(loaded.warnings).toHaveLength(1)
  })

  it('reads an explicit path relative to cwd and fails when it is missing', async () => {
    await write('custom.yml', 'tests_folder: T\n')
    expect((await loadConfig(dir, 'custom.yml')).config.tests_folder).toBe('T')
    await expect(loadConfig(dir, 'nope.yml')).rejects.toBeInstanceOf(ConfigError)
  })

  it('parses cycle_time to nanoseconds', async () => {
    await write('plc-st-test.config.yml', 'cycle_time: T#1ms\n')
    expect((await loadConfig(dir)).config.cycle_time).toBe(1_000_000n)
  })

  it('rejects a cycle_time that is not a TIME literal', async () => {
    await write('plc-st-test.config.yml', 'cycle_time: 10\n')
    await expect(loadConfig(dir)).rejects.toThrow('cycle_time: must be a TIME literal like T#10ms')
  })

  it('rejects a zero or malformed cycle_time', async () => {
    for (const value of ['T#0ms', 'T#', '10ms', 'T#abc']) {
      await write('plc-st-test.config.yml', `cycle_time: ${value}\n`)
      await expect(loadConfig(dir)).rejects.toThrow('cycle_time: must be a TIME literal')
    }
  })

  it('warns about unknown keys, including nested ones, without failing', async () => {
    await write('plc-st-test.config.yml', 'foo: 1\nlimits:\n  bar: 2\n')
    const loaded = await loadConfig(dir)
    expect(loaded.warnings).toEqual(["unknown config key 'foo' ignored", "unknown config key 'limits.bar' ignored"])
    expect(loaded.config.limits.max_recursion_depth).toBe(100)
  })

  it('rejects an unknown hardware bridge', async () => {
    await write('plc-st-test.config.yml', 'mode: hardware\nhardware:\n  bridge: modbus\n  target: {}\n')
    await expect(loadConfig(dir)).rejects.toThrow(/^hardware\.bridge: /)
  })

  it('passes hardware.target and simulators through opaquely', async () => {
    await write('plc-st-test.config.yml', 'hardware:\n  bridge: ads\n  target:\n    host: 1.2.3.4\n    port: 851\nsimulators:\n  x:\n    any: [1, 2]\n')
    const { config, warnings } = await loadConfig(dir)
    expect(config.hardware).toEqual({ bridge: 'ads', target: { host: '1.2.3.4', port: 851 } })
    expect(config.simulators).toEqual({ x: { any: [1, 2] } })
    expect(warnings).toEqual([])
  })

  it('lists every problem as a path: message line', async () => {
    await write('plc-st-test.config.yml', 'limits:\n  max_recursion_depth: 0\ncoverage:\n  threshold: 150\nstrict_libraries: maybe\n')
    const error = await loadConfig(dir).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ConfigError)
    const paths = (error as ConfigError).issues.map((line) => line.split(': ')[0])
    expect(paths).toEqual(['strict_libraries', 'limits.max_recursion_depth', 'coverage.threshold'])
  })

  it('wraps YAML syntax errors and non-mapping roots in ConfigError', async () => {
    await write('plc-st-test.config.yml', 'a: [unclosed\n')
    await expect(loadConfig(dir)).rejects.toBeInstanceOf(ConfigError)
    await write('plc-st-test.config.yml', '- a\n- b\n')
    await expect(loadConfig(dir)).rejects.toThrow('must be a mapping')
  })
})
