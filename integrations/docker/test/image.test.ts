import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const dir = new URL('..', import.meta.url)
const dockerfile = readFileSync(new URL('Dockerfile', dir), 'utf8')
// Instruction lines only: comments dropped, backslash continuations joined.
const instructions = dockerfile
  .replace(/\\r?\n/g, ' ')
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l !== '' && !l.startsWith('#'))
const fromLines = instructions.filter((l) => /^FROM\s/i.test(l))

describe('docker image (static checks)', () => {
  it('has a builder and a runtime stage', () => {
    expect(fromLines).toHaveLength(2)
  })

  it('pins every FROM by sha256 digest', () => {
    for (const l of fromLines) expect(l).toMatch(/^FROM\s+\S+@sha256:[0-9a-f]{64}(\s|$)/i)
  })

  it('uses no latest tag', () => {
    for (const l of fromLines) expect(l).not.toMatch(/:latest\b/i)
    expect(instructions.join('\n')).not.toMatch(/:latest\b/i)
  })

  it('ends as a non-root user', () => {
    const users = instructions.filter((l) => /^USER\s/i.test(l))
    expect(users.length).toBeGreaterThan(0)
    const last = users[users.length - 1]!.split(/\s+/)[1]!
    expect(['root', '0']).not.toContain(last.split(':')[0])
  })

  it('does not ADD remote URLs', () => {
    for (const l of instructions.filter((l) => /^ADD\s/i.test(l))) expect(l).not.toMatch(/https?:\/\//i)
  })

  it('has ENTRYPOINT plc-st-test', () => {
    expect(instructions).toContain('ENTRYPOINT ["plc-st-test"]')
  })

  it('keeps .dockerignore and Dockerfile.dockerignore identical and excluding host artefacts', () => {
    const plain = readFileSync(new URL('.dockerignore', dir), 'utf8')
    expect(readFileSync(new URL('Dockerfile.dockerignore', dir), 'utf8')).toBe(plain)
    const entries = plain.split(/\r?\n/).filter((l) => l !== '' && !l.startsWith('#'))
    for (const want of ['**/node_modules', '.git', '/docs/secret', '/_site', '/coverage', '**/dist']) expect(entries).toContain(want)
  })
})
