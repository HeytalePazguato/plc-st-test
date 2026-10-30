/**
 * Suite discovery: find test POUs (declared in test units) matching a name glob and turn them into suite descriptors according to the test strategy.
 */

import type { SuiteDescriptor, TestDescriptor, TestStrategyKind } from '@plc-st/plugin-api'
import type { OriginalLocation, ProjectWarning } from '@plc-st/project-model'
import type { SymbolTable } from '../symbols/table.js'
import { CYCLE_NAME, SETUP_NAME, TEARDOWN_NAME, pouKindAllowed, selectMembers } from './strategies.js'

export interface DiscoverOptions {
  strategy: TestStrategyKind
  /** Glob over POU names; `*` and `?` are wildcards. Defaults to `TEST_*`. */
  pattern?: string
}

export interface DiscoveryResult {
  suites: SuiteDescriptor[]
  warnings: ProjectWarning[]
}

export const DEFAULT_PATTERN = 'TEST_*'

/** Compile a `*` / `?` glob into an anchored regex; case-insensitive unless the table is case-sensitive. */
function globToRegExp(glob: string, caseSensitive: boolean): RegExp {
  const source = [...glob]
    .map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('')
  return new RegExp(`^${source}$`, caseSensitive ? '' : 'i')
}

export function discoverSuites(table: SymbolTable, opts: DiscoverOptions): DiscoveryResult {
  const matcher = globToRegExp(opts.pattern ?? DEFAULT_PATTERN, table.isCaseSensitive)
  const reserved = new Map([SETUP_NAME, TEARDOWN_NAME, CYCLE_NAME].map((n) => [table.normalizeKey(n), n]))
  const suites: SuiteDescriptor[] = []
  const warnings: ProjectWarning[] = []

  for (const pou of table.getPous()) {
    if (!pou.isTest || !pouKindAllowed(pou, opts.strategy) || !matcher.test(pou.name)) continue

    const pouLocation: OriginalLocation = pou.bodyNode !== undefined ? table.locate(pou.bodyNode) : { file: pou.file, line: 1, col: 1 }
    const { kind, members } = selectMembers(pou, opts.strategy)

    const tests: TestDescriptor[] = []
    const special: { setUp?: string; tearDown?: string; cycle?: string } = {}
    for (const m of members) {
      const reservedName = reserved.get(table.normalizeKey(m.name))
      if (reservedName === SETUP_NAME) special.setUp = m.name
      else if (reservedName === TEARDOWN_NAME) special.tearDown = m.name
      else if (reservedName === CYCLE_NAME) special.cycle = m.name
      else tests.push({ name: m.name, location: m.node !== undefined ? table.locate(m.node) : pouLocation })
    }

    suites.push({ suite: pou.name, tests, ...special, kind, location: pouLocation })
    if (tests.length === 0) {
      warnings.push({ code: 'SUITE_EMPTY', message: `Test suite '${pou.name}' contains no tests`, location: pouLocation })
    }
  }

  return { suites, warnings }
}
