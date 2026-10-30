import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isCompatible, type PluginModule } from '@plc-st/plugin-api'
import plugin, { standardDialect } from '../src/index.js'

describe('standardDialect', () => {
  it('declares the standard flavour', () => {
    expect(standardDialect).toMatchObject({
      id: 'standard',
      apiVersion: 1,
      caseSensitive: false,
      testStrategy: 'method',
    })
    expect(standardDialect.nodeHandlers).toBeUndefined()
  })

  it('resolves the bundled base grammar wasm', () => {
    const wasmPath = standardDialect.grammarWasmPath()
    expect(wasmPath).toMatch(/tree-sitter-iec61131_3_st\.wasm$/)
    expect(existsSync(wasmPath)).toBe(true)
  })
})

describe('default plugin export', () => {
  it('satisfies PluginModule and exposes the dialect', () => {
    const mod: PluginModule = plugin
    expect(isCompatible(mod.apiVersion)).toBe(true)
    expect(mod.dialects).toEqual([standardDialect])
  })
})
