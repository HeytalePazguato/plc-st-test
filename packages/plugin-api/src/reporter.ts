import type { RunResultsV1 } from './results.js'

/** Output facilities handed to a reporter, so reporters never touch `process` or the file system directly. */
export interface ReporterIo {
  outDir: string
  writeFile(name: string, data: string): Promise<void>
  stdout(text: string): void
  env: Record<string, string | undefined>
}

export interface Reporter {
  id: string
  onRunEnd(results: RunResultsV1, io: ReporterIo): Promise<void>
}
