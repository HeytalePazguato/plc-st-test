import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadGrammar, baseGrammarPath, parseSource } from '../src/parser/parse.js'

describe('grammar compatibility', () => {
  it('base grammar parses the compat sample with zero diagnostics', async () => {
    const lang = await loadGrammar(baseGrammarPath())
    expect(lang.abiVersion).toBeGreaterThanOrEqual(14)
    const file = fileURLToPath(new URL('./testdata/compat/sample.st', import.meta.url))
    const parsed = parseSource(lang, readFileSync(file, 'utf8'), 'sample.st')
    expect(parsed.diagnostics).toEqual([])
  })

  it('loading the same wasm twice returns the identical Language', async () => {
    const a = await loadGrammar(baseGrammarPath())
    const b = await loadGrammar(baseGrammarPath())
    expect(b).toBe(a)
  })
})
