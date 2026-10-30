import type { DetectCandidate, Ingestor } from '@plc-st/plugin-api'
import type { Project } from '@plc-st/project-model'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config.js'
import { IngestError, chooseProject, ingest } from '../src/ingest.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'plc-st-ingest-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function fake(id: string, vendor: string, files: Array<[file: string, confidence: number]>): Ingestor {
  return {
    id,
    vendor,
    apiVersion: 1,
    detect: async (): Promise<DetectCandidate[]> => files.map(([projectFile, confidence]) => ({ ingestorId: id, projectFile, label: `${vendor} ${projectFile}`, confidence })),
    load: async (candidate) => ({ vendor, dialect: `${vendor}-dialect`, name: candidate.label, root: dir, projectFile: candidate.projectFile }) as unknown as Project,
  }
}

const config = async (yaml = '') => {
  await writeFile(join(dir, 'plc-st-test.config.yml'), yaml)
  return (await loadConfig(dir)).config
}

describe('chooseProject', () => {
  it('chooses the ingestor that detects the only project', async () => {
    const twincat = fake('twincat', 'twincat', [['A.tsproj', 1]])
    const br = fake('br', 'br', [])
    const chosen = await chooseProject(dir, [br, twincat], await config())
    expect(chosen.ingestor).toBe(twincat)
    expect(chosen.candidate.projectFile).toBe('A.tsproj')
  })

  it('lists both candidates and the hint when two projects tie', async () => {
    const ingestors = [fake('twincat', 'twincat', [['A.tsproj', 1]]), fake('br', 'br', [['B.apj', 1]])]
    const error = await chooseProject(dir, ingestors, await config()).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(IngestError)
    const message = (error as Error).message
    expect(message).toContain('twincat A.tsproj (A.tsproj)')
    expect(message).toContain('br B.apj (B.apj)')
    expect(message).toContain('set "project:" in plc-st-test.config.yml')
  })

  it('resolves the ambiguity with the project override', async () => {
    const br = fake('br', 'br', [['B.apj', 1]])
    const ingestors = [fake('twincat', 'twincat', [['A.tsproj', 1]]), br]
    const chosen = await chooseProject(dir, ingestors, await config('project: ./B.apj\n'))
    expect(chosen.ingestor).toBe(br)
  })

  it('lists the candidates when the project override matches none', async () => {
    const ingestors = [fake('twincat', 'twincat', [['A.tsproj', 1]])]
    await expect(chooseProject(dir, ingestors, await config('project: Z.tsproj\n'))).rejects.toThrow(/Z\.tsproj[^]*A\.tsproj/)
  })

  it('filters by vendor', async () => {
    const br = fake('br', 'br', [['B.apj', 1]])
    const ingestors = [fake('twincat', 'twincat', [['A.tsproj', 1]]), br]
    expect((await chooseProject(dir, ingestors, await config('vendor: br\n'))).ingestor).toBe(br)
  })

  it('prefers the highest confidence', async () => {
    const strong = fake('twincat', 'twincat', [['A.tsproj', 1]])
    const ingestors = [fake('generic', 'generic', [['src', 0.5]]), strong]
    expect((await chooseProject(dir, ingestors, await config())).ingestor).toBe(strong)
  })

  it('names the supported vendors when nothing is found', async () => {
    const ingestors = [fake('twincat', 'twincat', []), fake('br', 'br', [])]
    await expect(chooseProject(dir, ingestors, await config())).rejects.toThrow(/supported vendors: twincat, br[^]*generic ingestor expects/)
  })
})

describe('ingest', () => {
  it('loads with the config options and lets config.dialect win', async () => {
    const twincat = fake('twincat', 'twincat', [['A.tsproj', 1]])
    const load = vi.spyOn(twincat, 'load')
    const cfg = await config('tests_folder: T\nsuite_pattern: X_*\ndefines:\n  FOO: true\n  N: 3\n')
    const result = await ingest(dir, [twincat], cfg)
    expect(result.dialect).toBe('twincat-dialect')
    expect(load.mock.calls[0]![1]).toMatchObject({ testsFolder: 'T', testPattern: 'X_*', defines: { FOO: 'true', N: '3' } })

    const overridden = await ingest(dir, [twincat], await config('dialect: standard\n'))
    expect(overridden.dialect).toBe('standard')
  })
})
