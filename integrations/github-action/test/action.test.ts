import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

interface Step {
  id?: string
  if?: string
  uses?: string
  shell?: string
  run?: string
  env?: Record<string, string>
  with?: Record<string, string>
}

interface Action {
  branding: { icon: string; color: string }
  inputs: Record<string, { description: string; default: string }>
  outputs: Record<string, { description: string; value: string }>
  runs: { using: string; steps: Step[] }
}

const raw = readFileSync(join(import.meta.dirname, '..', '..', '..', 'action.yml'), 'utf8')
const action = parse(raw) as Action
const steps = action.runs.steps

describe('action.yml', () => {
  it('is a composite action with the Marketplace branding', () => {
    expect(action.runs.using).toBe('composite')
    expect(action.branding).toEqual({ icon: 'check-circle', color: 'blue' })
  })

  it('declares the inputs with their defaults', () => {
    const defaults = Object.fromEntries(Object.entries(action.inputs).map(([name, input]) => [name, input.default]))
    expect(defaults).toEqual({
      path: '.',
      config: '',
      project: '',
      reporters: 'github,junit,terminal',
      'out-dir': 'plc-st-test-results',
      coverage: 'false',
      'node-version': '26',
      'upload-artifact': 'true',
      'artifact-name': '',
    })
    for (const input of Object.values(action.inputs)) expect(input.description).not.toBe('')
  })

  it('declares the outputs read from results.json and the CLI exit code', () => {
    expect(Object.keys(action.outputs).sort()).toEqual(['exit-code', 'failed', 'passed', 'total'])
    expect(action.outputs.passed?.value).toBe('${{ steps.outputs.outputs.passed }}')
    expect(action.outputs['exit-code']?.value).toBe('${{ steps.run.outputs.exit-code }}')
  })

  it('never interpolates an expression inside a run block', () => {
    const scripts = steps.filter((step) => step.run !== undefined)
    expect(scripts.length).toBeGreaterThan(0)
    for (const step of scripts) expect(step.run).not.toContain('${{')
  })

  it('pins every uses to a 40-hex commit SHA with a version comment', () => {
    const uses = steps.filter((step) => step.uses !== undefined)
    expect(uses.length).toBeGreaterThan(0)
    for (const step of uses) expect(step.uses).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/)
    for (const line of raw.split('\n').filter((l) => /^\s*- uses:|^\s*uses:/.test(l))) expect(line).toMatch(/@[0-9a-f]{40} # v\d+\.\d+\.\d+$/)
  })

  it('gives every run step an explicit bash shell, as composite actions require', () => {
    for (const step of steps.filter((s) => s.run !== undefined)) expect(step.shell).toBe('bash')
  })

  it('passes all inputs to the run step through env', () => {
    const run = steps.find((step) => step.id === 'run')
    expect(run?.env).toEqual({
      ACTION_PATH: '${{ github.action_path }}',
      INPUT_PATH: '${{ inputs.path }}',
      INPUT_CONFIG: '${{ inputs.config }}',
      INPUT_PROJECT: '${{ inputs.project }}',
      INPUT_REPORTERS: '${{ inputs.reporters }}',
      INPUT_OUT_DIR: '${{ inputs.out-dir }}',
      INPUT_COVERAGE: '${{ inputs.coverage }}',
    })
  })

  it('runs the CLI at the version of this checkout, quoted, and propagates its exit code', () => {
    const script = steps.find((step) => step.id === 'run')?.run ?? ''
    expect(script).toContain(`require(process.env.ACTION_PATH + '/packages/cli/package.json').version`)
    expect(script).toContain('npx --yes "plc-st-test@$VERSION" run "${args[@]}" -- "$INPUT_PATH"')
    expect(script).toContain('PLC_ST_TEST_LOCAL_CLI')
    expect(script).toContain('exit "$code"')
  })

  it('always adds the json reporter, because the outputs are read from results.json', () => {
    expect(steps.find((step) => step.id === 'run')?.run).toContain('args+=(--reporter json)')
  })

  it('reads the outputs even after a failure and tolerates a missing results.json', () => {
    const step = steps.find((s) => s.id === 'outputs')
    expect(step?.if).toBe('always()')
    expect(step?.run).toContain('results.json')
    expect(step?.run).toMatch(/catch \(error\)/)
    expect(step?.run?.trimEnd()).toMatch(/\|\| true$/)
  })

  it('uploads the report directory last and only when asked', () => {
    const upload = steps.at(-1)
    expect(upload?.uses).toMatch(/^actions\/upload-artifact@/)
    expect(upload?.if).toBe("always() && inputs.upload-artifact == 'true'")
    expect(upload?.with?.path).toBe('${{ inputs.out-dir }}')
  })
})
