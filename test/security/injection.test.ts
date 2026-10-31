import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runCli, scratch, type Scratch } from './helpers.js'

let s: Scratch
beforeEach(async () => void (s = await scratch('injection')))
afterEach(() => s.cleanup())

/** Every workflow command GitHub would act on: a line starting with `::name` (the runner also honours the legacy `##[name]` form). */
const COMMAND_LINE = /^(::[A-Za-z-]+|##\[)/

const github = (): ReturnType<typeof runCli> => runCli(['run', s.project, '--reporter', 'github'], { cwd: s.dir, env: { GITHUB_ACTIONS: 'true' } })

describe('GitHub reporter: workflow-command injection', () => {
  it('only emits the ::error annotations it intends to', async () => {
    const { code, stdout } = await github()
    expect(code).toBe(1)

    const lines = stdout.split('\n').filter((l) => l !== '')
    expect(lines).toHaveLength(3)
    for (const line of lines) expect(line).toMatch(/^::error file=Tests\/TEST_Inject\.st,line=\d+,col=\d+,title=TEST_Inject\.Test_[A-Za-z]+::/)
    expect(lines.filter((l) => COMMAND_LINE.test(l) && !l.startsWith('::error file='))).toEqual([])
    expect(stdout).not.toMatch(/^::(add-mask|stop-commands|set-output|warning)/m)
    expect(stdout).not.toContain('\r')
  })

  it('escapes % \\r \\n in the data, so raw newlines become %0A and pre-encoded sequences are escaped again', async () => {
    const { stdout } = await github()
    const byTest = (name: string): string => stdout.split('\n').find((l) => l.includes(`.${name}::`)) ?? ''

    expect(byTest('Test_RawNewlines')).toContain('before%0A::add-mask::x%0A::stop-commands::y%0A::error::z')
    // A literal "%0A" typed by the test author must not decode to a newline: the % itself is escaped.
    const encoded = byTest('Test_EncodedNewlines')
    expect(encoded).toContain('%250A::add-mask::x%250D%250A::stop-commands::y%250A::error::z%2525')
    expect(encoded).not.toMatch(/[^%]%0[AD]/)
    expect(byTest('Test_CarriageReturnAndProperty')).toContain('cr%0D::set-output name=a::b%0D%0A::warning file=a,line=1::c')
  })

  it('keeps ":" and "," out of the property values, so they only appear as separators', async () => {
    const { stdout } = await github()
    for (const line of stdout.split('\n').filter((l) => l !== '')) {
      const props = line.slice('::error '.length, line.indexOf('::', '::error '.length))
      expect(props.split(',')).toHaveLength(3 + 1)
      expect(props).not.toContain(':')
    }
  })
})
