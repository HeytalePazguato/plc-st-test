import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ConfinementError, FileTooLargeError, SafeFs } from '../src/index.js'

let base: string
let root: string
let outside: string
let fs: SafeFs
let symlinkSkipReason: string | undefined

beforeAll(() => {
  base = mkdtempSync(path.join(tmpdir(), 'safefs-'))
  root = path.join(base, 'root')
  outside = path.join(base, 'outside')
  mkdirSync(path.join(root, 'sub'), { recursive: true })
  mkdirSync(outside)
  writeFileSync(path.join(root, 'sub', 'a.st'), 'hello')
  writeFileSync(path.join(root, 'b.st'), 'world')
  writeFileSync(path.join(outside, 'secret.txt'), 'secret')
  try {
    symlinkSync(outside, path.join(root, 'link'), 'junction')
  } catch (err) {
    symlinkSkipReason = `symlink creation failed (${(err as NodeJS.ErrnoException).code}); likely missing privilege on this platform`
  }
  fs = new SafeFs(root)
})

afterAll(() => rmSync(base, { recursive: true, force: true }))

describe('SafeFs confinement', () => {
  it('rejects backslash traversal', () => {
    expect(() => fs.resolve('..\\..\\etc\\passwd')).toThrow(ConfinementError)
    expect(() => fs.resolve('sub\\..\\..\\outside\\secret.txt')).toThrow(ConfinementError)
  })

  it('rejects absolute paths outside the root', () => {
    const err = (() => {
      try {
        fs.resolve(path.join(outside, 'secret.txt'))
      } catch (e) {
        return e
      }
    })()
    expect(err).toBeInstanceOf(ConfinementError)
    expect((err as ConfinementError).code).toBe('PATH_ESCAPE')
    expect(() => fs.resolve('/proc/self/environ')).not.toThrow(FileTooLargeError)
  })

  it('rejects a symlink inside the root that points outside', (ctx) => {
    if (symlinkSkipReason) ctx.skip(symlinkSkipReason)
    expect(() => fs.resolve('link/secret.txt')).toThrow(ConfinementError)
    expect(() => fs.resolve('link/not-yet.txt')).toThrow(ConfinementError)
  })

  it('resolves paths inside the root, including relative to a referencing directory', () => {
    const real = fs.resolve('sub/a.st')
    expect(real).toBe(path.join(fs.root, 'sub', 'a.st'))
    expect(fs.resolve('sub\\a.st')).toBe(real)
    expect(fs.resolve('../b.st', 'sub')).toBe(path.join(fs.root, 'b.st'))
    expect(fs.resolve(path.join(root, 'b.st'))).toBe(path.join(fs.root, 'b.st'))
    expect(() => fs.resolve('../../x', 'sub')).toThrow(ConfinementError)
  })

  it('resolves not-yet-existing paths inside the root', () => {
    expect(fs.resolve('new/dir/file.st')).toBe(path.join(fs.root, 'new', 'dir', 'file.st'))
  })

  it.runIf(process.platform === 'win32' || process.platform === 'darwin')('compares case-insensitively', () => {
    expect(fs.resolve(path.join(root.toUpperCase(), 'b.st'))).toBe(path.join(fs.root, 'b.st'))
  })
})

describe('SafeFs reading', () => {
  it('exists and list work inside the root', async () => {
    expect(await fs.exists('b.st')).toBe(true)
    expect(await fs.exists('missing.st')).toBe(false)
    expect(await fs.list('.')).toEqual(expect.arrayContaining(['b.st', 'sub']))
    await expect(fs.list('..')).rejects.toThrow(ConfinementError)
  })

  it('throws FileTooLargeError above the limit', async () => {
    writeFileSync(path.join(root, 'big.bin'), Buffer.alloc(17 * 1024 * 1024))
    await expect(fs.readText('big.bin')).rejects.toThrow(FileTooLargeError)
    await expect(new SafeFs(root, { maxFileBytes: 3 }).readText('b.st')).rejects.toThrow(FileTooLargeError)
  })

  it('strips a UTF-8 BOM', async () => {
    writeFileSync(path.join(root, 'bom.st'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('PROGRAM X')]))
    expect(await fs.readText('bom.st')).toBe('PROGRAM X')
  })

  it('decodes valid UTF-8 and falls back to latin1', async () => {
    writeFileSync(path.join(root, 'utf8.st'), 'café °C', 'utf8')
    expect(await fs.readText('utf8.st')).toBe('café °C')
    writeFileSync(path.join(root, 'latin1.st'), Buffer.from([0x63, 0x61, 0x66, 0xe9]))
    expect(await fs.readText('latin1.st')).toBe('café')
  })
})
