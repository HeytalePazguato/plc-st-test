/** JSON reporter: writes the results contract to `results.json`, refusing to write anything that does not validate. */

import { validateResultsV1, type Reporter, type RunResultsV1 } from '@plc-st/plugin-api'

/** Serialise `results` after checking it against the results v1 schema; throws listing the problems otherwise. */
export function renderJson(results: RunResultsV1): string {
  const errors = validateResultsV1(results)
  if (errors.length > 0) throw new Error(`results do not match the results v1 schema: ${errors.join('; ')}`)
  return `${JSON.stringify(results, null, 2)}\n`
}

export const jsonReporter: Reporter = {
  id: 'json',
  async onRunEnd(results, io) {
    await io.writeFile('results.json', renderJson(results))
  },
}
