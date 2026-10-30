import { lstatSync, realpathSync } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'

export class ConfinementError extends Error {
  readonly code = 'PATH_ESCAPE'
  constructor(readonly requested: string, readonly root: string, detail?: string) {
    super(`Path "${requested}" escapes the project root "${root}"${detail ? ` (${detail})` : ''}`)
    this.name = 'ConfinementError'
  }
}

export class FileTooLargeError extends Error {
  readonly code = 'FILE_TOO_LARGE'
  constructor(readonly file: string, readonly size: number, readonly limit: number) {
    super(`File "${file}" is ${size} bytes, which exceeds the limit of ${limit} bytes`)
    this.name = 'FileTooLargeError'
  }
}

export interface SafeFsOptions {
  /** Maximum size of a file readText will read. Default 16 MiB. */
  maxFileBytes?: number
}

const DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024

// Windows and macOS filesystems are case-insensitive by default.
const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin'

const fold = (p: string): string => (CASE_INSENSITIVE ? p.toLowerCase() : p)

/** Filesystem access confined to a root directory: every path is resolved through symlinks and rejected if it lands outside the root. */
export class SafeFs {
  readonly root: string
  readonly maxFileBytes: number

  constructor(root: string, opts: SafeFsOptions = {}) {
    this.root = realpathSync.native(path.resolve(root))
    this.maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
  }

  /** Resolves a relative path (against `from`, the directory of the referencing file, or the root) or an absolute path to a real path inside the root. */
  resolve(relOrAbs: string, from?: string): string {
    const normalised = relOrAbs.replace(/\\/g, '/')
    const base = from === undefined ? this.root : path.resolve(this.root, from.replace(/\\/g, '/'))
    const real = this.realpathLoose(path.resolve(base, normalised), relOrAbs)
    if (!this.isInside(real)) throw new ConfinementError(relOrAbs, this.root)
    return real
  }

  async readText(file: string): Promise<string> {
    const real = this.resolve(file)
    const { size } = await stat(real)
    if (size > this.maxFileBytes) throw new FileTooLargeError(file, size, this.maxFileBytes)
    let buf = await readFile(real)
    if (buf.length > this.maxFileBytes) throw new FileTooLargeError(file, buf.length, this.maxFileBytes)
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) buf = buf.subarray(3)
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buf)
    } catch {
      return buf.toString('latin1')
    }
  }

  async exists(file: string): Promise<boolean> {
    const real = this.resolve(file)
    try {
      await stat(real)
      return true
    } catch {
      return false
    }
  }

  async list(dir: string): Promise<string[]> {
    return (await readdir(this.resolve(dir))).sort()
  }

  private isInside(real: string): boolean {
    const rel = path.relative(fold(this.root), fold(real))
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
  }

  /** realpath that tolerates not-yet-existing tails by resolving the nearest existing ancestor. */
  private realpathLoose(target: string, requested: string): string {
    const tail: string[] = []
    let current = target
    for (;;) {
      try {
        return path.join(realpathSync.native(current), ...tail.reverse())
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
        // A dangling symlink has an lstat entry but no realpath; its target is unverifiable.
        let dangling = false
        try {
          lstatSync(current)
          dangling = true
        } catch {
          // plain missing entry
        }
        if (dangling) throw new ConfinementError(requested, this.root, 'dangling symlink')
        const parent = path.dirname(current)
        if (parent === current) throw err
        tail.push(path.basename(current))
        current = parent
      }
    }
  }
}
