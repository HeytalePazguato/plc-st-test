import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { HostFnDef } from '@plc-st/plugin-api'
import { DEFAULT_LIMITS } from '../src/limits.js'
import { Registry, Session } from '../src/session.js'

const fn = (name: string): HostFnDef => ({ name, minArgs: 0, maxArgs: 0, call: () => undefined })

describe('Session registries', () => {
  it('keeps host functions isolated between sessions', () => {
    const a = new Session({ limits: DEFAULT_LIMITS, caseSensitive: true })
    const b = new Session({ limits: DEFAULT_LIMITS, caseSensitive: true })
    a.hostFns.register(fn('DOUBLE_A'), 'a')
    b.hostFns.register(fn('DOUBLE_B'), 'b')
    expect(a.hostFns.get('DOUBLE_A')).toBeDefined()
    expect(a.hostFns.get('DOUBLE_B')).toBeUndefined()
    expect(b.hostFns.get('DOUBLE_B')).toBeDefined()
    expect(b.hostFns.get('DOUBLE_A')).toBeUndefined()
  })

  it('resolves names case-insensitively when the session is case-insensitive', () => {
    const s = new Session({ limits: DEFAULT_LIMITS, caseSensitive: false })
    s.hostFns.register(fn('DOUBLE'), 'lib')
    expect(s.hostFns.get('double')).toBeDefined()
    const strict = new Session({ limits: DEFAULT_LIMITS, caseSensitive: true })
    strict.hostFns.register(fn('DOUBLE'), 'lib')
    expect(strict.hostFns.get('double')).toBeUndefined()
  })

  it('lets the later registration win and emits exactly one warning naming both sources', () => {
    const s = new Session({ limits: DEFAULT_LIMITS, caseSensitive: false })
    const first = fn('DOUBLE')
    const second = fn('double')
    s.hostFns.register(first, 'pluginA')
    s.hostFns.register(second, 'pluginB')
    expect(s.hostFns.get('DOUBLE')).toBe(second)
    expect(s.hostFns.list()).toEqual([second])
    expect(s.warnings).toHaveLength(1)
    expect(s.warnings[0]!.message).toContain('pluginA')
    expect(s.warnings[0]!.message).toContain('pluginB')
  })

  it('records warnings with an optional location', () => {
    const s = new Session({ limits: DEFAULT_LIMITS, caseSensitive: true })
    s.warn('x', 'plain')
    s.warn('y', 'located', { file: 'f.st', line: 1, col: 2 })
    expect(s.warnings).toEqual([
      { code: 'x', message: 'plain' },
      { code: 'y', message: 'located', location: { file: 'f.st', line: 1, col: 2 } },
    ])
  })

  it('works standalone without a warning sink', () => {
    const r = new Registry<HostFnDef>('host function', true)
    r.register(fn('F'), 'a')
    r.register(fn('F'), 'b')
    expect(r.list()).toHaveLength(1)
  })
})

/**
 * Allow-list for module-level mutable state in `packages/core/src` (path relative to src, forward slashes). `parser/parse.ts` holds the web-tree-sitter init promise and the grammar cache: loading a WASM grammar is expensive and the loaded `Language` is immutable and session-independent, so sharing it process-wide is deliberate.
 */
const ALLOWED_MODULE_STATE = new Set(['parser/parse.ts'])

function listTs(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry)
    return statSync(p).isDirectory() ? listTs(p) : p.endsWith('.ts') ? [p] : []
  })
}

describe('no module-level mutable state', () => {
  it('has no top-level let / new Map / new Set outside the allow-list', () => {
    const srcDir = fileURLToPath(new URL('../src', import.meta.url))
    const offenders: string[] = []
    for (const file of listTs(srcDir)) {
      const rel = relative(srcDir, file).replace(/\\/g, '/')
      if (ALLOWED_MODULE_STATE.has(rel)) continue
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          // Top-level means no indentation: functions, classes and blocks indent their bodies.
          if (/^(export\s+)?let\s/.test(line) || /^(export\s+)?(const|var)\s.*=\s*new\s+(Map|Set)\s*[<(]/.test(line)) {
            offenders.push(`${rel}:${i + 1}: ${line.trim()}`)
          }
        })
    }
    expect(offenders).toEqual([])
  })
})
