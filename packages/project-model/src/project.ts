import type { OriginalLocation, SourceMap } from './sourcemap.js'

export type Vendor = 'standard' | 'beckhoff' | 'br' | (string & {})

export type UnitRole = 'pou' | 'types' | 'globals' | 'action'

export interface SourceUnit {
  id: string
  role: UnitRole
  isTest: boolean
  /** Generated ST text; use `map` to translate positions back to the original files. */
  text: string
  map: SourceMap
  /** For role 'action': the owning POU name. */
  owner?: string
  /** For role 'action': the action name. */
  name?: string
}

export interface LibraryRef {
  name: string
  version?: string
  kind: 'source' | 'compiled' | 'system' | 'vendor-test-lib'
  resolvedUnits?: string[]
}

export interface ProjectWarning {
  code: string
  message: string
  location?: OriginalLocation
}

export interface Project {
  vendor: Vendor
  dialect: string
  name: string
  root: string
  projectFile: string
  units: SourceUnit[]
  libraries: LibraryRef[]
  defines: Record<string, string>
  warnings: ProjectWarning[]
}
