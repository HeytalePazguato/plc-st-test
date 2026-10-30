import type { OriginalLocation } from '@plc-st/project-model'

/** Versioned JSON results contract (schema id `https://plc-st.dev/schemas/results-v1.json`); changes within v1 are additive only. */
export interface RunResultsV1 {
  schemaVersion: 1
  tool: { name: string; version: string }
  project: { vendor: string; dialect: string; name: string; projectFile: string }
  /** ISO 8601 timestamp. */
  startedAt: string
  durationMs: number
  summary: { total: number; passed: number; failed: number; errored: number; skipped: number }
  suites: SuiteResultV1[]
  warnings: { code: string; message: string; location?: OriginalLocation }[]
  coverage?: CoverageSummaryV1
}

export interface SuiteResultV1 {
  name: string
  location: OriginalLocation
  durationMs: number
  tests: TestResultV1[]
}

export type TestStatusV1 = 'passed' | 'failed' | 'errored' | 'skipped'

export type FailureKindV1 = 'assertion' | 'runtime' | 'timeout' | 'limit'

export interface TestResultV1 {
  name: string
  /** `Suite.Test` or `Suite.Test[row_i]`. */
  fullName: string
  status: TestStatusV1
  durationMs: number
  location: OriginalLocation
  failure?: {
    kind: FailureKindV1
    message: string
    expected?: string
    actual?: string
    location: OriginalLocation
  }
}

export interface CoverageSummaryV1 {
  branchesTotal: number
  branchesHit: number
  pous: { name: string; file: string; branchesTotal: number; branchesHit: number; missed: { line: number; kind: string }[] }[]
}

const STATUSES: readonly string[] = ['passed', 'failed', 'errored', 'skipped']
const FAILURE_KINDS: readonly string[] = ['assertion', 'runtime', 'timeout', 'limit']

type Obj = Record<string, unknown>

function isObj(x: unknown): x is Obj {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

/** Checks `x` is an object with exactly the given required/optional keys; returns the object when it is one, so callers can validate its members. */
function checkObject(x: unknown, path: string, required: string[], optional: string[], errors: string[]): Obj | undefined {
  if (!isObj(x)) {
    errors.push(`${path || '/'}: expected object`)
    return undefined
  }
  for (const k of required) if (!(k in x) || x[k] === undefined) errors.push(`${path}/${k}: missing required property`)
  for (const k of Object.keys(x)) if (!required.includes(k) && !optional.includes(k)) errors.push(`${path}/${k}: unknown property`)
  return x
}

function checkString(x: unknown, path: string, errors: string[]): void {
  if (typeof x !== 'string') errors.push(`${path}: expected string`)
}

function checkNumber(x: unknown, path: string, errors: string[], integer = false): void {
  if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || (integer && !Number.isInteger(x))) {
    errors.push(`${path}: expected non-negative ${integer ? 'integer' : 'number'}`)
  }
}

function checkLocation(x: unknown, path: string, errors: string[]): void {
  const o = checkObject(x, path, ['file', 'line', 'col'], [], errors)
  if (!o) return
  if ('file' in o) checkString(o.file, `${path}/file`, errors)
  if ('line' in o) checkNumber(o.line, `${path}/line`, errors, true)
  if ('col' in o) checkNumber(o.col, `${path}/col`, errors, true)
}

function checkArray(x: unknown, path: string, errors: string[], each: (item: unknown, itemPath: string) => void): void {
  if (!Array.isArray(x)) {
    errors.push(`${path}: expected array`)
    return
  }
  x.forEach((item, i) => each(item, `${path}/${i}`))
}

function checkTest(x: unknown, path: string, errors: string[]): void {
  const o = checkObject(x, path, ['name', 'fullName', 'status', 'durationMs', 'location'], ['failure'], errors)
  if (!o) return
  if ('name' in o) checkString(o.name, `${path}/name`, errors)
  if ('fullName' in o) checkString(o.fullName, `${path}/fullName`, errors)
  if ('status' in o && (typeof o.status !== 'string' || !STATUSES.includes(o.status))) errors.push(`${path}/status: expected one of ${STATUSES.join(', ')}`)
  if ('durationMs' in o) checkNumber(o.durationMs, `${path}/durationMs`, errors)
  if ('location' in o) checkLocation(o.location, `${path}/location`, errors)
  if (o.failure !== undefined) {
    const f = checkObject(o.failure, `${path}/failure`, ['kind', 'message', 'location'], ['expected', 'actual'], errors)
    if (f) {
      if ('kind' in f && (typeof f.kind !== 'string' || !FAILURE_KINDS.includes(f.kind))) errors.push(`${path}/failure/kind: expected one of ${FAILURE_KINDS.join(', ')}`)
      if ('message' in f) checkString(f.message, `${path}/failure/message`, errors)
      if (f.expected !== undefined) checkString(f.expected, `${path}/failure/expected`, errors)
      if (f.actual !== undefined) checkString(f.actual, `${path}/failure/actual`, errors)
      if ('location' in f) checkLocation(f.location, `${path}/failure/location`, errors)
    }
  }
}

function checkSuite(x: unknown, path: string, errors: string[]): void {
  const o = checkObject(x, path, ['name', 'location', 'durationMs', 'tests'], [], errors)
  if (!o) return
  if ('name' in o) checkString(o.name, `${path}/name`, errors)
  if ('location' in o) checkLocation(o.location, `${path}/location`, errors)
  if ('durationMs' in o) checkNumber(o.durationMs, `${path}/durationMs`, errors)
  if ('tests' in o) checkArray(o.tests, `${path}/tests`, errors, (t, p) => checkTest(t, p, errors))
}

function checkCoverage(x: unknown, path: string, errors: string[]): void {
  const o = checkObject(x, path, ['branchesTotal', 'branchesHit', 'pous'], [], errors)
  if (!o) return
  if ('branchesTotal' in o) checkNumber(o.branchesTotal, `${path}/branchesTotal`, errors, true)
  if ('branchesHit' in o) checkNumber(o.branchesHit, `${path}/branchesHit`, errors, true)
  if ('pous' in o) {
    checkArray(o.pous, `${path}/pous`, errors, (p, pp) => {
      const pou = checkObject(p, pp, ['name', 'file', 'branchesTotal', 'branchesHit', 'missed'], [], errors)
      if (!pou) return
      if ('name' in pou) checkString(pou.name, `${pp}/name`, errors)
      if ('file' in pou) checkString(pou.file, `${pp}/file`, errors)
      if ('branchesTotal' in pou) checkNumber(pou.branchesTotal, `${pp}/branchesTotal`, errors, true)
      if ('branchesHit' in pou) checkNumber(pou.branchesHit, `${pp}/branchesHit`, errors, true)
      if ('missed' in pou) {
        checkArray(pou.missed, `${pp}/missed`, errors, (m, mp) => {
          const miss = checkObject(m, mp, ['line', 'kind'], [], errors)
          if (!miss) return
          if ('line' in miss) checkNumber(miss.line, `${mp}/line`, errors, true)
          if ('kind' in miss) checkString(miss.kind, `${mp}/kind`, errors)
        })
      }
    })
  }
}

/** Structurally validates a results document against schema v1; returns JSON-pointer-like error paths (empty when valid). */
export function validateResultsV1(x: unknown): string[] {
  const errors: string[] = []
  const o = checkObject(x, '', ['schemaVersion', 'tool', 'project', 'startedAt', 'durationMs', 'summary', 'suites', 'warnings'], ['coverage'], errors)
  if (!o) return errors
  if ('schemaVersion' in o && o.schemaVersion !== 1) errors.push('/schemaVersion: expected 1')
  if ('tool' in o) {
    const t = checkObject(o.tool, '/tool', ['name', 'version'], [], errors)
    if (t) {
      if ('name' in t) checkString(t.name, '/tool/name', errors)
      if ('version' in t) checkString(t.version, '/tool/version', errors)
    }
  }
  if ('project' in o) {
    const p = checkObject(o.project, '/project', ['vendor', 'dialect', 'name', 'projectFile'], [], errors)
    if (p) for (const k of ['vendor', 'dialect', 'name', 'projectFile']) if (k in p) checkString(p[k], `/project/${k}`, errors)
  }
  if ('startedAt' in o) {
    if (typeof o.startedAt !== 'string' || Number.isNaN(Date.parse(o.startedAt))) errors.push('/startedAt: expected ISO 8601 date-time string')
  }
  if ('durationMs' in o) checkNumber(o.durationMs, '/durationMs', errors)
  if ('summary' in o) {
    const keys = ['total', 'passed', 'failed', 'errored', 'skipped']
    const s = checkObject(o.summary, '/summary', keys, [], errors)
    if (s) for (const k of keys) if (k in s) checkNumber(s[k], `/summary/${k}`, errors, true)
  }
  if ('suites' in o) checkArray(o.suites, '/suites', errors, (s, p) => checkSuite(s, p, errors))
  if ('warnings' in o) {
    checkArray(o.warnings, '/warnings', errors, (w, p) => {
      const warn = checkObject(w, p, ['code', 'message'], ['location'], errors)
      if (!warn) return
      if ('code' in warn) checkString(warn.code, `${p}/code`, errors)
      if ('message' in warn) checkString(warn.message, `${p}/message`, errors)
      if (warn.location !== undefined) checkLocation(warn.location, `${p}/location`, errors)
    })
  }
  if (o.coverage !== undefined) checkCoverage(o.coverage, '/coverage', errors)
  return errors
}
