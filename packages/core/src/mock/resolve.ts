/**
 * Mock target paths: dotted instance paths relative to the suite (`uut.fbCommsClient`), resolved under the dialect's case mode, with a "did you mean" suggestion for typos.
 */
import { caseKey } from '../case.js'
import { IecError } from '../errors.js'
import { fbInstanceOf, type FbInstance } from '../interpreter/pou.js'
import type { SymbolTable } from '../symbols/table.js'

/** The furthest a sibling name may be from an unknown segment and still be suggested. */
const MAX_SUGGESTION_DISTANCE = 3

export interface MockTarget {
  owner: FbInstance
  /** The target's field in `owner`, in its declared spelling. */
  member: string
}

/** Edit distance between `a` and `b` (insertions, deletions and substitutions). */
export function levenshtein(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    previous = current
  }
  return previous[b.length]
}

/** The `IecError` for `segment` of `path` not being one of `siblings`, suggesting the closest name (the first declared on a tie) within `MAX_SUGGESTION_DISTANCE`. */
export function unknownMockTarget(path: string, segment: string, siblings: readonly string[], caseSensitive: boolean): IecError {
  const wanted = caseKey(segment, caseSensitive)
  let best: string | undefined
  let bestDistance = MAX_SUGGESTION_DISTANCE + 1
  for (const name of siblings) {
    const distance = levenshtein(wanted, caseKey(name, caseSensitive))
    if (distance < bestDistance) {
      best = name
      bestDistance = distance
    }
  }
  return new IecError(`unknown mock target '${path}'${best === undefined ? '' : ` — did you mean '${best}'?`}`)
}

function memberOf(owner: FbInstance, segment: string, path: string, caseSensitive: boolean): string {
  const wanted = caseKey(segment, caseSensitive)
  const names = [...owner.value.fields.keys()]
  const member = names.find((name) => caseKey(name, caseSensitive) === wanted)
  if (member === undefined) throw unknownMockTarget(path, segment, names, caseSensitive)
  return member
}

/** Walks `path` from `suite` through nested instances to the instance that owns its last segment. The last segment only has to exist; it need not be an instance. */
export function resolveMockTarget(path: string, suite: FbInstance, table: SymbolTable): MockTarget {
  const caseSensitive = table.isCaseSensitive
  const segments = path.split('.')
  let owner = suite
  for (const segment of segments.slice(0, -1)) {
    const member = memberOf(owner, segment, path, caseSensitive)
    const next = fbInstanceOf(owner.value.fields.get(member))
    if (next === undefined) throw new IecError(`unknown mock target '${path}' — '${member}' is not a function block instance`)
    owner = next
  }
  return { owner, member: memberOf(owner, segments[segments.length - 1], path, caseSensitive) }
}
