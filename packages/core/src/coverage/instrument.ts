/**
 * Branch coverage: `instrument` walks the production POUs once, before anything runs, and gives every branch a stable id; the statement executor then reports the ids it takes to the session's `CoverageSink`.
 *
 * Ids are `<pou>:<origFile>:<line>:<kind>:<n>`, where `<n>` numbers the branches sharing the rest of the id from 0 in source order (`IF a THEN x; ELSIF b THEN y; ELSIF c THEN z; END_IF` on one line has `elsif:0` and `elsif:1`), so the same source always yields the same ids. Lines are original-file lines, through each unit's `SourceMap`.
 *
 * Branches: every IF/ELSIF/ELSE arm and every CASE arm, an IF or CASE without ELSE counting one implicit ELSE at its own line, and FOR and WHILE entered vs skipped, counted once per loop execution rather than per iteration. REPEAT runs its body at least once, so it has only `repeat-entered`: a `repeat-skipped` could never be hit and would cap the POU below 100 %.
 *
 * A branch belongs to the POU declaring it, so a method inherited by another FB counts once, on its base. Test POUs and actions from test units get no ids, which is what keeps them out: `BranchMap.idOf` has nothing to report for their nodes.
 */

import type { Node, Tree } from 'web-tree-sitter'
import type { CoverageSummaryV1 } from '@plc-st/plugin-api'
import type { CoverageSink } from '../session.js'
import type { SymbolTable } from '../symbols/table.js'

export type BranchKind = 'if' | 'elsif' | 'else' | 'implicit-else' | 'case' | 'case-else' | 'case-implicit-else' | 'for-entered' | 'for-skipped' | 'while-entered' | 'while-skipped' | 'repeat-entered'

/** One instrumented branch, located in its original file. */
export interface Branch {
  id: string
  pou: string
  file: string
  line: number
  kind: BranchKind
}

const BRANCHING_STATEMENTS = ['if_statement', 'case_statement', 'for_statement', 'while_statement', 'repeat_statement']

/** Every branch of a project, and the way from a syntax node back to its branch ids. */
export class BranchMap {
  readonly branches: Branch[] = []
  // Keyed like `SymbolTable.origins`: node ids are only unique within their tree.
  private readonly ids = new Map<Tree, Map<string, string>>()
  private readonly used = new Map<string, number>()

  /** @internal Register `kind` on `node`, which locates it, for `pou`. */
  add(pou: string, node: Node, kind: BranchKind, table: SymbolTable): void {
    const { file, line } = table.locate(node)
    const prefix = `${pou}:${file}:${String(line)}:${kind}`
    const n = this.used.get(prefix) ?? 0
    this.used.set(prefix, n + 1)
    const id = `${prefix}:${String(n)}`
    this.branches.push({ id, pou, file, line, kind })
    let ids = this.ids.get(node.tree)
    if (ids === undefined) {
      ids = new Map()
      this.ids.set(node.tree, ids)
    }
    ids.set(`${String(node.id)}:${kind}`, id)
  }

  /** The id of branch `kind` of `node`; undefined for code that is not instrumented. */
  idOf(node: Node, kind: BranchKind): string | undefined {
    return this.ids.get(node.tree)?.get(`${String(node.id)}:${kind}`)
  }
}

function instrumentStatement(pou: string, node: Node, map: BranchMap, table: SymbolTable): void {
  const add = (at: Node, kind: BranchKind): void => {
    map.add(pou, at, kind, table)
  }
  const clauses = (type: string): Node[] => node.namedChildren.filter((c) => c.type === type)
  const otherwise = clauses('else_clause').at(0)
  switch (node.type) {
    case 'if_statement':
      add(node, 'if')
      for (const clause of clauses('elsif_clause')) add(clause, 'elsif')
      if (otherwise === undefined) add(node, 'implicit-else')
      else add(otherwise, 'else')
      break
    case 'case_statement':
      for (const clause of clauses('case_clause')) add(clause, 'case')
      if (otherwise === undefined) add(node, 'case-implicit-else')
      else add(otherwise, 'case-else')
      break
    case 'for_statement':
      add(node, 'for-entered')
      add(node, 'for-skipped')
      break
    case 'while_statement':
      add(node, 'while-entered')
      add(node, 'while-skipped')
      break
    case 'repeat_statement':
      add(node, 'repeat-entered')
      break
  }
}

/** Assign ids to every branch of the production POUs: their bodies, methods, property accessors and production actions. */
export function instrument(table: SymbolTable): BranchMap {
  const map = new BranchMap()
  for (const pou of table.getPous()) {
    if (pou.isTest) continue
    // The declaration node contains the POU's methods and accessors too.
    const roots = [...(pou.bodyNode === undefined ? [] : [pou.bodyNode]), ...pou.actions.filter((a) => !a.isTest).flatMap((a) => a.bodyNodes)]
    for (const root of roots) {
      for (const node of root.descendantsOfType(BRANCHING_STATEMENTS)) instrumentStatement(pou.name, node, map, table)
    }
  }
  return map
}

/** The default sink: a hit count per branch id. */
export class CountingSink implements CoverageSink {
  private readonly counts = new Map<string, number>()

  hit(id: string): void {
    this.counts.set(id, (this.counts.get(id) ?? 0) + 1)
  }

  snapshot(): Map<string, number> {
    return new Map(this.counts)
  }
}

/** What one coverage-enabled run shares between its per-test sessions, so hits add up across tests. */
export interface CoverageRun {
  branches: BranchMap
  sink: CoverageSink
}

export interface CoverageOptions {
  enabled: boolean
  createSink?: () => CoverageSink
}

/** Instrument `table` and build the run's sink, or do neither when coverage is disabled. Pass the result to `defaultSessionFactory`. */
export function startCoverage(table: SymbolTable, { enabled, createSink = () => new CountingSink() }: CoverageOptions): CoverageRun | undefined {
  if (!enabled) return undefined
  return { branches: instrument(table), sink: createSink() }
}

/** Per-POU results of `hits` (from `CoverageSink.snapshot`), in declaration order with `missed` sorted by line. `missed` lines have no file of their own, so a POU with branches in several files (an action in its own file) gets one entry per file; a POU without branches gets none. */
export function summarizeCoverage(map: BranchMap, hits: ReadonlyMap<string, number>): CoverageSummaryV1 {
  const pous = new Map<string, CoverageSummaryV1['pous'][number]>()
  let branchesHit = 0
  for (const branch of map.branches) {
    const key = JSON.stringify([branch.pou, branch.file])
    let pou = pous.get(key)
    if (pou === undefined) {
      pou = { name: branch.pou, file: branch.file, branchesTotal: 0, branchesHit: 0, missed: [] }
      pous.set(key, pou)
    }
    pou.branchesTotal += 1
    if ((hits.get(branch.id) ?? 0) > 0) {
      pou.branchesHit += 1
      branchesHit += 1
    } else {
      pou.missed.push({ line: branch.line, kind: branch.kind })
    }
  }
  for (const pou of pous.values()) pou.missed.sort((a, b) => a.line - b.line)
  return { branchesTotal: map.branches.length, branchesHit, pous: [...pous.values()] }
}
