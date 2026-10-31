import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sax from 'sax'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runCli, scratch, type Scratch } from './helpers.js'

let s: Scratch
let out: string
// Characters that are legal in a Windows/macOS/Linux directory name and hostile in markup.
const HOSTILE_DIR = "p&q'r"
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/

beforeEach(async () => {
  s = await scratch('reports', HOSTILE_DIR)
  out = join(s.dir, 'out')
  // A hostile source file name, with a branch so the coverage report names it.
  await mkdir(join(s.project, 'src'), { recursive: true })
  await writeFile(join(s.project, 'src', "x&y'z.st"), 'FUNCTION_BLOCK FB_Branchy\nVAR_INPUT\n  b : BOOL;\nEND_VAR\nVAR_OUTPUT\n  n : DINT;\nEND_VAR\nIF b THEN\n  n := 1;\nEND_IF\nEND_FUNCTION_BLOCK\n')
  await writeFile(join(s.project, 'plc-st-test.config.yml'), 'coverage: { report: [html] }\n')
})
afterEach(() => s.cleanup())

async function run(): Promise<void> {
  const { code } = await runCli(['run', s.project, '--reporter', 'junit', 'json', 'github', '--coverage', '--out-dir', out], { cwd: s.dir, env: { GITHUB_STEP_SUMMARY: join(s.dir, 'summary.md'), GITHUB_ACTIONS: 'true' } })
  expect(code).toBe(1)
}

describe('JUnit XML', () => {
  it('is well-formed and round-trips the hostile messages', async () => {
    await run()
    const xml = await readFile(join(out, 'junit.xml'), 'utf8')
    const parser = sax.parser(true)
    const failures: string[] = []
    let cdata = false
    parser.onerror = (e) => {
      throw e
    }
    parser.onopencdata = () => void (cdata = true)
    parser.onopentag = (tag) => {
      if (tag.name === 'failure') failures.push(String(tag.attributes['message']))
    }
    expect(() => parser.write(xml).close()).not.toThrow()
    expect(cdata).toBe(false)
    expect(failures).toHaveLength(3)
    expect(failures.some((m) => m.includes(']]> b <![CDATA[ c <script>alert(1)</script> d'))).toBe(true)
    expect(failures.some((m) => m.includes('"q"') && m.includes('&') && m.includes('|'))).toBe(true)
    // Characters XML 1.0 cannot carry were dropped, not emitted raw.
    expect(xml).not.toMatch(CONTROL)
    expect(xml).not.toContain('<script>')
    expect(xml).not.toContain('<![CDATA[')
  })
})

describe('HTML coverage report', () => {
  it('escapes names from the project', async () => {
    await run()
    const html = await readFile(join(out, 'coverage.html'), 'utf8')
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('x&amp;y&#39;z.st')
    expect(html).not.toContain("x&y'z.st")
    expect(html).not.toMatch(/<script/i)
  })
})

describe('Markdown job summary', () => {
  it('has no raw HTML, escapes pipes and backticks, and keeps one row per failed test', async () => {
    await run()
    const md = await readFile(join(s.dir, 'summary.md'), 'utf8')
    expect(md).not.toMatch(/<script|<b>|<!\[CDATA\[/i)
    expect(md).toContain('&lt;script>alert(1)&lt;/script>')
    expect(md).toContain('x \\| y \\| \\`code\\` &amp; &lt;b>bold&lt;/b>')
    const rows = md.split('\n').filter((l) => l.startsWith('| TEST_'))
    expect(rows).toHaveLength(3)
    // An unescaped pipe or newline in a message would change the cell or row count: test | location | message, plus the outer edges.
    for (const row of rows) expect(row.replace(/\\\\/g, '').replace(/\\\|/g, '').split('|')).toHaveLength(5)
    expect(md).not.toMatch(CONTROL)
  })
})
