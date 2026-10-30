/**
 * The commander program behind the `plc-st-test` bin. It lives apart from `cli.ts`, which runs on import, so tests can drive it in-process.
 */

import { readFileSync } from 'node:fs'
import { Command, CommanderError } from 'commander'
import { VERSION as CORE_VERSION } from '@plc-st/core'
import { PLUGIN_API_VERSION } from '@plc-st/plugin-api'
import { discover, EXIT_ERROR, processIo, run, type CliIo } from './run.js'

// `package.json` sits outside this package's `rootDir`, so it is read at load time rather than imported; it resolves from both `src/` and `dist/`.
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }

interface CliRunOptions {
  config?: string
  project?: string
  reporter?: string[]
  outDir?: string
  suite?: string
  test?: string
  coverage?: boolean
  strictLibraries?: boolean
  watch?: boolean
  verbose?: boolean
}

interface CliDiscoverOptions {
  config?: string
  project?: string
  json?: boolean
  verbose?: boolean
}

/** Copies the defined fields of `options`, since `run` and `discover` tell an unset option from a falsy one. */
function defined<T extends object>(options: T): T {
  return Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) as T
}

function createProgram(io: CliIo, setExitCode: (code: number) => void): Command {
  // Both settings are inherited by the commands created below.
  const program = new Command('plc-st-test')
    .description('Unit test runner for IEC 61131-3 Structured Text.')
    .version(`plc-st-test ${pkg.version} (core ${CORE_VERSION}, plugin-api v${String(PLUGIN_API_VERSION)})`)
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr })
    .exitOverride()

  program
    .command('run [path]', { isDefault: true })
    .description('run the tests of the project at path (default: the working directory)')
    .option('--config <file>', 'config file')
    .option('--project <file>', 'project file to use, relative to path')
    .option('--reporter <name...>', 'reporters: junit, json, tap, terminal, github (default: terminal and junit, plus github when GITHUB_ACTIONS=true)')
    .option('--out-dir <dir>', 'directory for report files (default: plc-st-test-results)')
    .option('--suite <glob>', 'only suites whose name matches')
    .option('--test <glob>', 'only tests whose name matches')
    .option('--coverage', 'collect branch coverage')
    .option('--strict-libraries', 'fail on unresolved library symbols instead of auto-stubbing them')
    .option('--watch', 'rerun on change')
    .option('--verbose', 'print the chosen config and project, and stack traces on errors')
    .action(async (path: string | undefined, options: CliRunOptions) => {
      const { reporter, watch, ...rest } = options
      if (watch === true) {
        io.stderr('error: --watch is not implemented yet\n')
        setExitCode(EXIT_ERROR)
        return
      }
      const outcome = await run(path, defined({ ...rest, reporters: reporter }), io)
      setExitCode(outcome.exitCode)
    })

  program
    .command('discover [path]')
    .description('list the suites and tests of the project at path without running them')
    .option('--config <file>', 'config file')
    .option('--project <file>', 'project file to use, relative to path')
    .option('--json', 'print JSON instead of text')
    .option('--verbose', 'print the chosen config and project, and stack traces on errors')
    .action(async (path: string | undefined, options: CliDiscoverOptions) => {
      setExitCode(await discover(path, defined(options), io))
    })

  return program
}

/** Parses `argv` (without the node and script entries), runs the command and returns the exit code; a usage error is exit 2, like any other error that stops tests from running. */
export async function main(argv: readonly string[], io: CliIo = processIo()): Promise<number> {
  let exitCode = 0
  const program = createProgram(io, (code) => {
    exitCode = code
  })
  try {
    await program.parseAsync([...argv], { from: 'user' })
    return exitCode
  } catch (error) {
    // `--help` and `--version` also end in a CommanderError, with exit code 0.
    if (error instanceof CommanderError) return error.exitCode === 0 ? 0 : EXIT_ERROR
    throw error
  }
}
