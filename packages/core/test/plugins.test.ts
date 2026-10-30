import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PluginError } from '../src/errors.js'
import { applyPlugins, createPluginRegistries, loadPlugins } from '../src/plugins/host.js'
import { DEFAULT_LIMITS } from '../src/limits.js'
import { Session } from '../src/session.js'

let root: string

const install = (name: string, source: string): void => {
  const dir = join(root, 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0', type: 'module', main: 'index.js' }))
  writeFileSync(join(dir, 'index.js'), source)
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'plc-st-plugins-'))
  writeFileSync(join(root, 'package.json'), '{"name":"project","private":true}')
  mkdirSync(join(root, 'node_modules'), { recursive: true })
  cpSync(join(import.meta.dirname, 'fixtures', 'fake-plugin'), join(root, 'node_modules', 'fake-plugin'), { recursive: true })
  install('future-plugin', 'export default { apiVersion: 2 }')
  install('named-plugin', 'export const plugin = { apiVersion: 1, reporters: [{ id: "named", onRunEnd: async () => {} }] }')
  install('shapeless-plugin', 'export const other = 1')
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('loadPlugins', () => {
  it('loads an installed plugin from its default export', async () => {
    const [mod] = await loadPlugins(['fake-plugin'], root)
    expect(mod?.apiVersion).toBe(1)
  })

  it('accepts the named `plugin` export', async () => {
    const [mod] = await loadPlugins(['named-plugin'], root)
    expect(mod?.reporters?.[0]?.id).toBe('named')
  })

  it('rejects an incompatible apiVersion with the exact message', async () => {
    await expect(loadPlugins(['future-plugin'], root)).rejects.toThrow(new PluginError('plugin future-plugin targets plugin-api v2, this runner supports v1'))
  })

  it('tells the user how to install a missing plugin', async () => {
    await expect(loadPlugins(['no-such-plugin'], root)).rejects.toThrow('plugin no-such-plugin not installed — run: npm i -D no-such-plugin')
  })

  it('rejects a module without a PluginModule export', async () => {
    await expect(loadPlugins(['shapeless-plugin'], root)).rejects.toThrow(/does not export a PluginModule/)
  })
})

describe('applyPlugins', () => {
  it('makes the ingestor, dialect, simulator, reporter and host fn reachable and fires the cycle hooks', async () => {
    const mods = await loadPlugins(['fake-plugin'], root)
    const session = new Session({ limits: DEFAULT_LIMITS, caseSensitive: false })
    const registries = createPluginRegistries()
    const log: string[] = []
    ;(globalThis as { __fakeSimLog?: string[] }).__fakeSimLog = log

    applyPlugins(mods, session, registries)

    expect(registries.ingestors.has('fake-ingestor')).toBe(true)
    expect(registries.dialects.has('fake-dialect')).toBe(true)
    expect(registries.simulators.has('fake-sim')).toBe(true)
    expect(registries.reporters.has('fake-reporter')).toBe(true)
    expect(session.hostFns.get('FAKE_FN')).toBeDefined()
    for (const h of session.preCycle) h(1)
    for (const h of session.postCycle) h(1)
    expect(log).toEqual(['pre1', 'post1'])
    expect(session.warnings).toEqual([])
  })

  it('warns when a second application collides with an existing registration', async () => {
    const mods = await loadPlugins(['fake-plugin'], root)
    const session = new Session({ limits: DEFAULT_LIMITS, caseSensitive: false })
    const registries = createPluginRegistries()
    applyPlugins(mods, session, registries)
    applyPlugins(mods, session, registries)
    const codes = session.warnings.map((w) => w.code)
    expect(codes).toContain('registry-collision')
    expect(session.warnings.some((w) => w.message.includes("ingestor 'fake-ingestor'"))).toBe(true)
    expect(session.warnings.some((w) => w.message.includes("host function 'FAKE_FN'"))).toBe(true)
  })
})
