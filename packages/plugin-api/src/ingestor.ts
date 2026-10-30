import type { Project } from '@plc-st/project-model'

/** The subset of the host's root-confined file system (`SafeFs` in `@plc-st/project-model`) that ingestors rely on. Declared structurally so the contract does not depend on a concrete implementation; the host resolves every path and confines it to the project root. */
export interface SafeFsLike {
  /** Resolve `p` (relative to `from`, or to the root) to a confined absolute path; throws when it escapes the root. */
  resolve(p: string, from?: string): string
  readText(p: string): Promise<string>
  exists(p: string): Promise<boolean>
  list(dir: string): Promise<string[]>
}

/** One project an ingestor recognised under a repository root. */
export interface DetectCandidate {
  ingestorId: string
  projectFile: string
  label: string
  /** 0..1 */
  confidence: number
}

export interface IngestOptions {
  root: string
  fs: SafeFsLike
  /** Default `'Tests'`. */
  testsFolder: string
  /** Default `'TEST_*'`. */
  testPattern: string
  defines: Record<string, string>
}

/** Turns a vendor project on disk into a vendor-neutral `Project`. */
export interface Ingestor {
  id: string
  vendor: string
  apiVersion: number
  detect(root: string, fs: SafeFsLike): Promise<DetectCandidate[]>
  load(candidate: DetectCandidate, opts: IngestOptions): Promise<Project>
}
