/**
 * Ingest orchestration: asks every ingestor what it finds under the repository root, chooses one project and loads it.
 *
 * Failures are reported as `IngestError` (the CLI maps it to exit 2).
 */

import type { DetectCandidate, Ingestor } from '@plc-st/plugin-api'
import { SafeFs } from '@plc-st/project-model'
import type { Project } from '@plc-st/project-model'
import type { Config } from './config.js'

/** Raised when no single project can be chosen; the message is ready to print. */
export class IngestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IngestError'
  }
}

export interface ChosenProject {
  ingestor: Ingestor
  candidate: DetectCandidate
}

export interface IngestResult extends ChosenProject {
  project: Project
  /** `config.dialect` when set, else the dialect the ingestor reported. */
  dialect: string
}

type ChooseConfig = Pick<Config, 'project' | 'vendor'>

const list = (candidates: DetectCandidate[]): string => candidates.map((c) => `  ${c.label} (${c.projectFile})`).join('\n')

/** Runs every ingestor's `detect` in parallel and picks the one project to load: the `project` override first, then the `vendor` filter, then the highest confidence. */
export async function chooseProject(root: string, ingestors: Ingestor[], config: ChooseConfig, fs: SafeFs = new SafeFs(root)): Promise<ChosenProject> {
  const detected = await Promise.all(ingestors.map(async (ingestor) => (await ingestor.detect(root, fs)).map((candidate) => ({ ingestor, candidate }))))
  let found = detected.flat()

  if (config.project !== undefined) {
    let wanted: string
    try {
      wanted = fs.resolve(config.project)
    } catch (error) {
      throw new IngestError(`project '${config.project}': ${(error as Error).message}`)
    }
    const match = found.filter((f) => fs.resolve(f.candidate.projectFile) === wanted)
    if (match.length === 0) {
      const available = found.length === 0 ? '  (none found)' : list(found.map((f) => f.candidate))
      throw new IngestError(`project '${config.project}' matches none of the detected projects:\n${available}`)
    }
    found = match
  }

  if (config.vendor !== undefined) found = found.filter((f) => f.ingestor.vendor === config.vendor)

  const best = Math.max(0, ...found.map((f) => f.candidate.confidence))
  const top = found.filter((f) => f.candidate.confidence === best)

  if (top.length === 1) return top[0]!
  if (top.length > 1) {
    throw new IngestError(`found ${top.length} PLC projects:\n${list(top.map((f) => f.candidate))}\nset "project:" in plc-st-test.config.yml`)
  }

  const vendors = [...new Set(ingestors.map((i) => i.vendor))].join(', ') || 'none installed'
  const filter = config.vendor === undefined ? '' : ` for vendor '${config.vendor}'`
  throw new IngestError(`no PLC project found${filter} under ${root}; supported vendors: ${vendors}. The generic ingestor expects a folder of plain .st files, with the project root as the folder to test`)
}

/** Chooses a project and loads it through a `SafeFs` confined to `root`. */
export async function ingest(root: string, ingestors: Ingestor[], config: Config): Promise<IngestResult> {
  const fs = new SafeFs(root)
  const chosen = await chooseProject(root, ingestors, config, fs)
  const defines = Object.fromEntries(Object.entries(config.defines).map(([key, value]) => [key, String(value)]))
  const project = await chosen.ingestor.load(chosen.candidate, { root, fs, testsFolder: config.tests_folder, testPattern: config.suite_pattern, defines })
  return { ...chosen, project, dialect: config.dialect ?? project.dialect }
}
