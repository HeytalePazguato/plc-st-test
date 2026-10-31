import { spawnSync } from 'node:child_process'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runCli, scratch, type Scratch } from './helpers.js'

let s: Scratch
beforeEach(async () => void (s = await scratch('plugins')))
afterEach(() => s.cleanup())

/** Preloaded into the CLI: records every process spawn and every socket/DNS/HTTP/fetch attempt to the file named by PLC_ST_SPY_LOG. */
const SPY = `
const fs = require('node:fs')
const log = (what) => fs.appendFileSync(process.env.PLC_ST_SPY_LOG, what + '\\n')
const cp = require('node:child_process')
for (const fn of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  const orig = cp[fn]
  cp[fn] = function (...args) { log('child_process.' + fn + ' ' + String(args[0])); return orig.apply(this, args) }
}
const net = require('node:net')
const connect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (...args) { log('net.connect'); return connect.apply(this, args) }
const dns = require('node:dns')
for (const fn of ['lookup', 'resolve', 'resolve4', 'resolve6']) {
  const orig = dns[fn]
  dns[fn] = function (...args) { log('dns.' + fn + ' ' + String(args[0])); return orig.apply(this, args) }
}
for (const mod of ['node:http', 'node:https']) {
  const m = require(mod)
  for (const fn of ['request', 'get']) {
    const orig = m[fn]
    m[fn] = function (...args) { log(mod + '.' + fn); return orig.apply(this, args) }
  }
}
const g = globalThis.fetch
globalThis.fetch = function (...args) { log('fetch ' + String(args[0])); return g.apply(this, args) }
`

async function withSpy(): Promise<{ hook: string; spyLog: string }> {
  const hook = join(s.dir, 'spy.cjs')
  const spyLog = join(s.dir, 'spy.log')
  await writeFile(hook, SPY)
  await writeFile(spyLog, '')
  return { hook, spyLog }
}

describe('plugin that is not installed', () => {
  it('the spy detects a process spawn and a network attempt (positive control)', async () => {
    const { hook, spyLog } = await withSpy()
    const probe = "require('node:child_process').spawnSync(process.execPath, ['-v']); fetch('http://127.0.0.1:1/').catch(() => {})"
    spawnSync(process.execPath, ['--require', hook, '-e', probe], { env: { ...process.env, PLC_ST_SPY_LOG: spyLog } })
    const log = await readFile(spyLog, 'utf8')
    expect(log).toContain('child_process.spawnSync')
    expect(log).toContain('fetch http://127.0.0.1:1/')
  })

  it('exits 2 with the install hint and spawns nothing and touches no network', async () => {
    const { hook, spyLog } = await withSpy()
    const result = await runCli(['run', s.project, '--reporter', 'terminal'], { cwd: s.dir, nodeArgs: ['--require', hook], env: { PLC_ST_SPY_LOG: spyLog } })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('plugin plc-st-test-plugin-does-not-exist not installed')
    expect(result.stderr).toContain('npm i -D plc-st-test-plugin-does-not-exist')
    expect(result.stdout).not.toMatch(/passed|failed/)
    expect(await readFile(spyLog, 'utf8')).toBe('')
  })

  it('does not install anything: discover fails the same way and leaves the project untouched', async () => {
    const { hook, spyLog } = await withSpy()
    const result = await runCli(['discover', s.project], { cwd: s.dir, nodeArgs: ['--require', hook], env: { PLC_ST_SPY_LOG: spyLog } })
    expect(result.code).toBe(2)
    expect(await readFile(spyLog, 'utf8')).toBe('')
    expect((await readdir(s.project)).sort()).toEqual(['Tests', 'plc-st-test.config.yml', 'src'])
  })
})
