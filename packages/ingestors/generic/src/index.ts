import path from 'node:path'
import type { DetectCandidate, Ingestor, IngestOptions, PluginModule } from '@plc-st/plugin-api'
import { PLUGIN_API_VERSION } from '@plc-st/plugin-api'
import { SourceMap } from '@plc-st/project-model'
import type { Project, SourceUnit } from '@plc-st/project-model'
import { glob } from 'tinyglobby'

export const PACKAGE_NAME = '@plc-st/ingestor-generic'

const IGNORE = ['**/node_modules/**', '**/.git/**']

const VENDOR_PROJECT_FILES = ['**/*.tsproj', '**/*.plcproj', '**/*.apj']

const listFiles = (root: string, patterns: string[]): Promise<string[]> => glob(patterns, { cwd: root, ignore: IGNORE, caseSensitiveMatch: false, dot: false, followSymbolicLinks: false })

const lineCount = (text: string): number => (text === '' ? 1 : text.split(/\r\n|\r|\n/).length)

/** True when `file` sits under a directory named `testsFolder` (case-insensitive; the folder may itself be a nested path such as `src/Tests`). */
function isTestPath(file: string, testsFolder: string): boolean {
  const folder = testsFolder.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '').toLowerCase()
  if (folder === '') return false
  return `/${path.posix.dirname(file).toLowerCase()}/`.includes(`/${folder}/`)
}

/** Fallback ingestor for plain `.st` files: every file becomes one `pou` unit with an identity source map. Yields to any vendor project it can recognise. */
export const genericIngestor: Ingestor = {
  id: 'generic',
  vendor: 'standard',
  apiVersion: PLUGIN_API_VERSION,

  async detect(root: string): Promise<DetectCandidate[]> {
    if ((await listFiles(root, VENDOR_PROJECT_FILES)).length > 0) return []
    const files = await listFiles(root, ['**/*.st'])
    if (files.length === 0) return []
    return [{ ingestorId: 'generic', projectFile: '.', label: `Generic Structured Text (${files.length} ${files.length === 1 ? 'file' : 'files'})`, confidence: 0.3 }]
  },

  async load(candidate: DetectCandidate, opts: IngestOptions): Promise<Project> {
    const files = (await listFiles(opts.root, ['**/*.st'])).sort()
    const units: SourceUnit[] = []
    for (const file of files) {
      const text = await opts.fs.readText(file)
      units.push({ id: file, role: 'pou', isTest: isTestPath(file, opts.testsFolder), text, map: SourceMap.identity(file, lineCount(text)) })
    }
    return {
      vendor: 'standard',
      dialect: 'standard',
      name: path.basename(path.resolve(opts.root)),
      root: opts.root,
      projectFile: candidate.projectFile,
      units,
      libraries: [],
      defines: {},
      warnings: [],
    }
  },
}

const plugin: PluginModule = { apiVersion: PLUGIN_API_VERSION, ingestors: [genericIngestor] }

export default plugin
