/**
 * Parameterized tests: `FOR_EACH_ROW('aTestData')` re-runs the rest of a test body once per row of a suite-level array of structs, and `ROW()` returns the current row.
 *
 * The first call (the probe run) throws a `RowExpansion` carrying the table name and row count; the runner catches it, finds the statement after the call and runs the test again per row, each time on a fresh suite instance, resuming the body after `FOR_EACH_ROW` with `Session.params` set.
 */
import type { IecValue } from '@plc-st/plugin-api'
import type { Node } from 'web-tree-sitter'
import { IecRuntimeError } from '../errors.js'
import { cloneValue } from '../interpreter/values.js'
import type { Session } from '../session.js'
import { runtimeOf, stringArg } from './cyclefns.js'

/** Every host function the parameterized-test layer registers, for the editor tooling to list. */
export const PARAM_NAMES: readonly string[] = ['FOR_EACH_ROW', 'ROW']

/** The row run in progress: which test body to resume (by body node id), after which statement, and which row of which table. */
export interface RowContext {
  /** `id` of the body node the test starts from (the method's declaration, or an action's first statement). */
  bodyId: number
  /** Index of the first statement to run in the test body. */
  from: number
  table: string
  index: number
}

/** Internal signal thrown by the first `FOR_EACH_ROW` call; never reaches a result, the runner turns it into one sub-test per row. */
export class RowExpansion extends Error {
  constructor(
    readonly table: string,
    readonly count: number,
  ) {
    super(`FOR_EACH_ROW('${table}') expands into ${String(count)} rows`)
  }
}

/** The statements a test body runs: all of them, or only those after `FOR_EACH_ROW` while its row run is the one in progress. */
export function resumeStatements(session: Session, bodyId: number | undefined, statements: Node[]): Node[] {
  const params = session.params
  return params !== undefined && params.bodyId === bodyId ? statements.slice(params.from) : statements
}

/** Index of the first top-level `FOR_EACH_ROW(...)` statement, or -1. */
export function findForEachRow(statements: readonly Node[]): number {
  return statements.findIndex((s) => s.type === 'invocation_statement' && /^FOR_EACH_ROW\s*\(/i.test(s.text))
}

/** Registers `FOR_EACH_ROW(table: STRING)` and `ROW()` on `session`. */
export function registerParams(session: Session): void {
  const tableOf = (name: string, hcPath: (p: string) => { value: IecValue } | undefined): Extract<IecValue, { kind: 'array' }> => {
    const slot = hcPath(name)
    if (slot === undefined) throw new IecRuntimeError(`FOR_EACH_ROW: unknown variable '${name}'`)
    const v = slot.value
    if (v.kind !== 'array' || !v.data.every((e) => e.kind === 'struct')) throw new IecRuntimeError(`FOR_EACH_ROW: '${name}' must be an ARRAY OF STRUCT`)
    return v
  }

  session.hostFns.register(
    {
      name: 'FOR_EACH_ROW',
      minArgs: 1,
      maxArgs: 1,
      call(args, hc) {
        runtimeOf(session, 'FOR_EACH_ROW')
        const name = stringArg('FOR_EACH_ROW', 'table', args[0])
        const table = tableOf(name, hc.resolvePath)
        // Inside a row run the body already resumes after this call, so reaching it again is a no-op.
        if (session.params === undefined) throw new RowExpansion(name, table.data.length)
        return undefined
      },
    },
    'params',
  )

  session.hostFns.register(
    {
      name: 'ROW',
      minArgs: 0,
      maxArgs: 0,
      call(_args, hc) {
        const params = session.params
        if (params === undefined) throw new IecRuntimeError('ROW can only be used after FOR_EACH_ROW')
        const row = tableOf(params.table, hc.resolvePath).data[params.index]
        return cloneValue(row)
      },
    },
    'params',
  )
}
