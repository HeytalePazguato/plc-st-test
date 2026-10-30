/**
 * `MOCK_RETURNS('path.output', value)`: gives an output of a mocked instance a persistent value. An instance that is not mocked yet is mocked first, since the real body would overwrite the output on its next call.
 */
import { caseKey } from '../case.js'
import { IecError } from '../errors.js'
import { runtimeOf, stringArg } from '../runner/cyclefns.js'
import type { Session } from '../session.js'
import { mockAt } from './mock.js'
import { unknownMockTarget } from './resolve.js'

/** Registers `MOCK_RETURNS(path: STRING, value)` on `session`. */
export function registerMockReturns(session: Session): void {
  session.hostFns.register(
    {
      name: 'MOCK_RETURNS',
      minArgs: 2,
      maxArgs: 2,
      call(args) {
        const rt = runtimeOf(session, 'MOCK_RETURNS')
        const path = stringArg('MOCK_RETURNS', 'path', args[0])
        const dot = path.lastIndexOf('.')
        if (dot < 0) throw new IecError(`MOCK_RETURNS: '${path}' must name an output as '<instance path>.<output>'`)
        const mock = mockAt(path.slice(0, dot), rt)
        const name = path.slice(dot + 1)
        const outputs = mock.params.filter((p) => p.kind === 'output')
        const output = outputs.find((p) => caseKey(p.name, session.caseSensitive) === caseKey(name, session.caseSensitive))
        if (output === undefined) {
          throw unknownMockTarget(
            path,
            name,
            outputs.map((p) => p.name),
            session.caseSensitive,
          )
        }
        mock.setOutput(output, args[1].value, rt)
        return undefined
      },
    },
    'mock',
  )
}
