import { describe, expect, it } from 'vitest'
import { SourceMap, type Project, type SourceUnit } from '../src/index.js'

describe('Project model types', () => {
  it('accepts a representative project and keeps unit maps usable', () => {
    const map = new SourceMap()
    map.add({ genStartLine: 1, lineCount: 3, file: 'FB_A.TcPOU', origStartLine: 10, origStartCol: 5 })
    map.add({ genStartLine: 4, lineCount: 2, file: 'FB_A.TcPOU', origStartLine: 20, origStartCol: 1 })
    const pou: SourceUnit = { id: 'FB_A', role: 'pou', isTest: false, text: 'a\nb\nc\nd\ne', map }
    const action: SourceUnit = {
      id: 'FB_A.Reset',
      role: 'action',
      isTest: false,
      text: 'x := 0;',
      map: SourceMap.identity('FB_A.TcPOU', 1),
      owner: 'FB_A',
      name: 'Reset',
    }
    const project = {
      vendor: 'twincat',
      dialect: 'twincat',
      name: 'Demo',
      root: '/proj',
      projectFile: 'Demo.plcproj',
      units: [pou, action],
      libraries: [{ name: 'Tc2_Standard', kind: 'system' }],
      defines: { DEBUG: '1' },
      warnings: [{ code: 'W001', message: 'x', location: { file: 'a', line: 1, col: 1 } }],
    } satisfies Project

    expect(project.units[0]!.map.map(4, 1)).toEqual({ file: 'FB_A.TcPOU', line: 20, col: 1 })
    expect(project.units[1]!.owner).toBe('FB_A')
  })

  it('allows custom vendor strings', () => {
    const vendor: Project['vendor'] = 'codesys'
    expect(vendor).toBe('codesys')
  })
})
