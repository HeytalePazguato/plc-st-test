/**
 * Test strategies: how a test POU maps onto individual tests (METHOD per test, ACTION per test, or either).
 */

import type { Node } from 'web-tree-sitter'
import type { TestStrategyKind } from '@plc-st/plugin-api'
import type { Pou } from '../symbols/table.js'

/** A member of a test POU (method or action) with the node used to locate it. */
export interface StrategyMember {
  name: string
  /** Node whose start is reported as the member's location; absent for an empty action. */
  node?: Node
}

export interface StrategySelection {
  kind: 'method' | 'action'
  /** All members of that kind in declaration order, including SetUp/TearDown/Cycle. */
  members: StrategyMember[]
}

export const SETUP_NAME = 'SetUp'
export const TEARDOWN_NAME = 'TearDown'
export const CYCLE_NAME = 'Cycle'

/** Whether `pou` can host tests under `strategy`: function blocks always, programs only for action-based strategies (classic B&R actions belong to programs). */
export function pouKindAllowed(pou: Pou, strategy: TestStrategyKind): boolean {
  if (pou.kind === 'functionBlock') return true
  return pou.kind === 'program' && strategy !== 'method'
}

function methodMembers(pou: Pou): StrategyMember[] {
  return pou.methods.map((m) => ({ name: m.name, node: m.bodyNode }))
}

function actionMembers(pou: Pou): StrategyMember[] {
  return pou.actions.map((a) => ({ name: a.name, node: a.bodyNodes[0] }))
}

/** Pick which members of `pou` are test-capable under `strategy`. */
export function selectMembers(pou: Pou, strategy: TestStrategyKind): StrategySelection {
  switch (strategy) {
    case 'method':
      return { kind: 'method', members: methodMembers(pou) }
    case 'action':
      return { kind: 'action', members: actionMembers(pou) }
    case 'method-or-action':
      return pou.methods.length > 0
        ? { kind: 'method', members: methodMembers(pou) }
        : { kind: 'action', members: actionMembers(pou) }
  }
}
