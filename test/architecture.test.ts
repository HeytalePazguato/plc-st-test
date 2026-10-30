import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')
const packagesDir = join(root, 'packages')

interface Pkg {
  dir: string
  name: string
  deps: string[]
  files: string[]
}

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

const findPackages = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue
    const full = join(dir, entry)
    if (!statSync(full).isDirectory()) continue
    if (statSync(join(full, 'package.json'), { throwIfNoEntry: false })?.isFile()) out.push(full)
    else findPackages(full, out)
  }
  return out
}

const packages: Pkg[] = findPackages(packagesDir).map((dir) => {
  const json = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<string, Record<string, string> | string>
  const deps = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap((k) => Object.keys((json[k] as Record<string, string> | undefined) ?? {}))
  const files = walk(dir).filter((f) => /\.(ts|tsx|js|mjs|cjs)$/.test(f) && !f.endsWith('.d.ts'))
  return { dir: relative(root, dir).split(sep).join('/'), name: json.name as string, deps, files }
})

const isWorkspace = (n: string) => n.startsWith('@plc-st/') || n === 'plc-st-test'
const pkgOf = (spec: string) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!)

/** Returns a reason when `pkg` may not depend on / import `dep`, else null. */
const violation = (pkg: Pkg, dep: string): string | null => {
  if (!isWorkspace(dep)) return null
  if (pkg.dir === 'packages/project-model') return 'project-model must not depend on any workspace package'
  if (pkg.dir === 'packages/plugin-api') return dep === '@plc-st/project-model' ? null : 'plugin-api may only depend on @plc-st/project-model'
  if (pkg.dir.startsWith('packages/ingestors/')) {
    if (dep === '@plc-st/core' || dep === 'plc-st-test' || dep.startsWith('@plc-st/dialect-')) return 'ingestors must not depend on core, the CLI, or dialects'
  }
  if (pkg.dir.startsWith('packages/dialects/')) {
    if (dep === '@plc-st/core' || dep === 'plc-st-test' || dep.startsWith('@plc-st/ingestor-')) return 'dialects must not depend on core, the CLI, or ingestors'
  }
  return null
}

const importRe = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g

describe('dependency boundaries', () => {
  it('discovers all ten packages', () => {
    expect(packages.map((p) => p.name).sort()).toEqual([
      '@plc-st/core', '@plc-st/dialect-br', '@plc-st/dialect-standard', '@plc-st/dialect-twincat',
      '@plc-st/ingestor-br', '@plc-st/ingestor-generic', '@plc-st/ingestor-twincat',
      '@plc-st/plugin-api', '@plc-st/project-model', 'plc-st-test',
    ])
  })

  for (const pkg of packages) {
    it(`${pkg.name}: package.json dependencies respect the boundaries`, () => {
      const bad = pkg.deps.map((d) => ({ d, why: violation(pkg, d) })).filter((x) => x.why)
      expect(bad).toEqual([])
    })

    it(`${pkg.name}: source imports respect the boundaries`, () => {
      const bad: string[] = []
      for (const file of pkg.files) {
        const text = readFileSync(file, 'utf8')
        for (const m of text.matchAll(importRe)) {
          const why = violation(pkg, pkgOf(m[1]!))
          if (why) bad.push(`${relative(root, file)}: ${m[1]} (${why})`)
        }
      }
      expect(bad).toEqual([])
    })
  }
})
