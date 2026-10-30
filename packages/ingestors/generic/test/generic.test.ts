import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SafeFs } from '@plc-st/project-model'
import { describe, expect, it } from 'vitest'
import plugin, { genericIngestor } from '../src/index.js'

const fixture = (name: string): string => path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', name)

const options = (root: string) => ({ root, fs: new SafeFs(root), testsFolder: 'Tests', testPattern: 'TEST_*', defines: {} })

describe('genericIngestor', () => {
  it('detects a folder of .st files with confidence 0.3', async () => {
    const root = fixture('plain')
    const found = await genericIngestor.detect(root, new SafeFs(root))
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ ingestorId: 'generic', confidence: 0.3 })
  })

  it('yields no candidate when a vendor project file is present', async () => {
    const root = fixture('with-tsproj')
    expect(await genericIngestor.detect(root, new SafeFs(root))).toEqual([])
  })

  it('yields no candidate without .st files', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'generic-empty-'))
    try {
      expect(await genericIngestor.detect(root, new SafeFs(root))).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('loads one pou unit per file and flags the Tests folder', async () => {
    const root = fixture('plain')
    const [candidate] = await genericIngestor.detect(root, new SafeFs(root))
    const project = await genericIngestor.load(candidate!, options(root))
    expect(project).toMatchObject({ vendor: 'standard', dialect: 'standard', defines: {}, name: 'plain' })
    expect(project.units.map((u) => [u.id, u.role, u.isTest])).toEqual([
      ['Tests/TEST_A.st', 'pou', true],
      ['src/FB_A.st', 'pou', false],
    ])
    const unit = project.units.find((u) => u.id === 'src/FB_A.st')!
    expect(unit.text).toContain('FUNCTION_BLOCK FB_A')
    expect(unit.map.map(3, 1)).toMatchObject({ file: 'src/FB_A.st', line: 3 })
  })

  it('matches the tests folder case-insensitively', async () => {
    const root = fixture('plain')
    const [candidate] = await genericIngestor.detect(root, new SafeFs(root))
    const project = await genericIngestor.load(candidate!, { ...options(root), testsFolder: 'tests' })
    expect(project.units.filter((u) => u.isTest).map((u) => u.id)).toEqual(['Tests/TEST_A.st'])
  })

  it('is exported as a plugin module', () => {
    expect(plugin).toEqual({ apiVersion: 1, ingestors: [genericIngestor] })
  })
})
