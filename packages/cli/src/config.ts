/**
 * Loads and validates `plc-st-test.config.yml` (or `.yaml`).
 *
 * A missing or empty file yields the full defaults. Unknown keys are reported as warnings so a newer config still runs on an older CLI; invalid values throw a `ConfigError` whose message lists one `path: message` line per problem (the CLI maps it to exit 2).
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'
import { parseTimeLiteral } from '@plc-st/core'

/** Names tried, in order, when no explicit config path is given. */
export const CONFIG_FILE_NAMES = ['plc-st-test.config.yml', 'plc-st-test.config.yaml'] as const

/** Raised for an unreadable, unparsable or invalid config; `issues` holds the individual `path: message` lines. */
export class ConfigError extends Error {
  readonly issues: string[]

  constructor(issues: string[]) {
    super(issues.join('\n'))
    this.name = 'ConfigError'
    this.issues = issues
  }
}

const positiveInt = z.number().int().positive()

/** `cycle_time` as a TIME literal string, converted to nanoseconds; absent means `T#10ms`. */
const cycleTime = z.unknown().transform((value, ctx): bigint => {
  const ns = typeof value === 'string' ? parseTimeLiteral(value) : undefined
  if (ns === undefined || ns <= 0n) {
    ctx.addIssue({ code: 'custom', message: 'must be a TIME literal like T#10ms' })
    return z.NEVER
  }
  return ns
})

const limitsSchema = z.object({
  max_recursion_depth: positiveInt.default(100),
  max_loop_iterations: positiveInt.default(1_000_000),
  max_cycles_per_test: positiveInt.default(100_000),
  max_execution_time_ms: positiveInt.default(30_000),
  max_allocated_elements: positiveInt.default(10_000_000),
})

const coverageSchema = z.object({
  enabled: z.boolean().default(false),
  report: z.array(z.enum(['terminal', 'json', 'html'])).default(['terminal', 'json']),
  threshold: z.number().min(0).max(100).default(0),
})

const hardwareSchema = z.object({
  bridge: z.enum(['ads', 'opcua']),
  target: z.record(z.string(), z.unknown()),
})

const configSchema = z.object({
  project: z.string().optional(),
  vendor: z.string().optional(),
  dialect: z.string().optional(),
  cycle_time: cycleTime.prefault('T#10ms'),
  tests_folder: z.string().default('Tests'),
  suite_pattern: z.string().default('TEST_*'),
  defines: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  strict_libraries: z.boolean().default(false),
  limits: limitsSchema.prefault({}),
  coverage: coverageSchema.prefault({}),
  reporters: z.array(z.string()).default([]),
  plugins: z.array(z.string()).default([]),
  mode: z.enum(['simulation', 'hardware']).default('simulation'),
  hardware: hardwareSchema.optional(),
  simulators: z.record(z.string(), z.unknown()).default({}),
})

/** The validated configuration; `cycle_time` is in nanoseconds. */
export type Config = z.output<typeof configSchema>

export interface LoadedConfig {
  config: Config
  warnings: string[]
  /** Absolute path of the file that was read; absent when none exists and the defaults apply. */
  path?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The declared keys of the nested objects whose own keys are checked for typos; `hardware.target` and `simulators` are opaque. */
const NESTED_SHAPES: Record<string, Record<string, unknown>> = {
  limits: limitsSchema.shape,
  coverage: coverageSchema.shape,
  hardware: hardwareSchema.shape,
}

/** Dotted paths of the keys in `raw` that the schema does not declare. */
function unknownKeys(raw: Record<string, unknown>): string[] {
  const found: string[] = []
  for (const [key, value] of Object.entries(raw)) {
    if (!(key in configSchema.shape)) found.push(key)
    else if (key in NESTED_SHAPES && isRecord(value)) {
      for (const inner of Object.keys(value)) if (!(inner in NESTED_SHAPES[key])) found.push(`${key}.${inner}`)
    }
  }
  return found
}

async function readIfPresent(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new ConfigError([`${file}: ${(error as Error).message}`])
  }
}

/**
 * Reads the config from `explicitPath` (relative to `cwd`) or, when absent, `plc-st-test.config.yml` / `.yaml` in `cwd`. An explicit path that does not exist is an error; a missing default file is not.
 */
export async function loadConfig(cwd: string, explicitPath?: string): Promise<LoadedConfig> {
  const warnings: string[] = []
  let path: string | undefined
  let text: string | undefined

  if (explicitPath !== undefined) {
    path = resolve(cwd, explicitPath)
    text = await readIfPresent(path)
    if (text === undefined) throw new ConfigError([`${path}: config file not found`])
  } else {
    for (const name of CONFIG_FILE_NAMES) {
      const candidate = resolve(cwd, name)
      const content = await readIfPresent(candidate)
      if (content === undefined) continue
      if (text === undefined) {
        path = candidate
        text = content
      } else {
        warnings.push(`both ${CONFIG_FILE_NAMES[0]} and ${CONFIG_FILE_NAMES[1]} exist; using ${CONFIG_FILE_NAMES[0]}`)
      }
    }
  }

  let raw: unknown = {}
  if (text !== undefined) {
    try {
      raw = parse(text) ?? {}
    } catch (error) {
      throw new ConfigError([`${path}: ${(error as Error).message}`])
    }
    if (!isRecord(raw)) throw new ConfigError([`${path}: the config must be a mapping of keys to values`])
    for (const key of unknownKeys(raw)) warnings.push(`unknown config key '${key}' ignored`)
  }

  const result = configSchema.safeParse(raw)
  if (!result.success) {
    throw new ConfigError(result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`))
  }
  return path === undefined ? { config: result.data, warnings } : { config: result.data, warnings, path }
}
