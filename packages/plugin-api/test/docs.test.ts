import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))
const srcDir = path.resolve(here, '../src')
const docPath = path.resolve(here, '../../../docs/plugin-api.md')

/** Names declared with `export` in one source file, e.g. `export interface Foo`, `export type Bar`, `export const Baz`. */
const DECLARATION = /^export\s+(?:declare\s+)?(?:interface|type|const|function|class|let)\s+(\w+)/gm

/** Re-export targets of one source file: `export * from './x.js'` and `export type * from './x.js'`. */
const REEXPORT = /^export\s+(?:type\s+)?\*\s+from\s+'\.\/([\w-]+)\.js'/gm

function exportedNames(file: string): string[] {
  const text = readFileSync(file, 'utf8')
  const names = [...text.matchAll(DECLARATION)].map((m) => m[1]!)
  for (const m of text.matchAll(REEXPORT)) names.push(...exportedNames(path.join(path.dirname(file), `${m[1]}.ts`)))
  return names
}

describe('docs/plugin-api.md', () => {
  const entry = path.join(srcDir, 'index.ts')
  const names = [...new Set(exportedNames(entry))].sort()
  const doc = readFileSync(docPath, 'utf8')

  it('collects the public surface from index.ts and its re-exported modules', () => {
    // Sanity check on the collector itself: it must reach into re-exported modules and see both types and values.
    expect(names).toEqual(expect.arrayContaining(['PluginModule', 'Ingestor', 'RunResultsV1', 'PLUGIN_API_VERSION', 'validateResultsV1', 'isCompatible']))
  })

  it.each(names)('documents exported name %s', (name) => {
    expect(new RegExp(`\\b${name}\\b`).test(doc), `docs/plugin-api.md does not mention ${name}`).toBe(true)
  })
})
