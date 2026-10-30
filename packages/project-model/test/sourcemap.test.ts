import { describe, expect, it } from 'vitest'
import { SourceMap } from '../src/index.js'

function twoSegmentMap(): SourceMap {
  const map = new SourceMap()
  map.add({ genStartLine: 1, lineCount: 3, file: 'FB_A.TcPOU', origStartLine: 10, origStartCol: 5 })
  map.add({ genStartLine: 4, lineCount: 2, file: 'FB_A.TcPOU', origStartLine: 20, origStartCol: 1 })
  return map
}

describe('SourceMap', () => {
  it('maps segments with the column offset on the first line only', () => {
    const map = twoSegmentMap()
    expect(map.map(1, 1)).toEqual({ file: 'FB_A.TcPOU', line: 10, col: 5 })
    expect(map.map(2, 3)).toEqual({ file: 'FB_A.TcPOU', line: 11, col: 3 })
    expect(map.map(3, 1)).toEqual({ file: 'FB_A.TcPOU', line: 12, col: 1 })
    expect(map.map(4, 2).line).toBe(20)
    expect(map.map(5, 1).line).toBe(21)
  })

  it('adds the column offset relative to the generated column on the first line', () => {
    expect(twoSegmentMap().map(1, 4)).toEqual({ file: 'FB_A.TcPOU', line: 10, col: 8 })
  })

  it('maps lines outside any segment to <generated>', () => {
    const map = twoSegmentMap()
    expect(map.map(6, 7)).toEqual({ file: '<generated>', line: 6, col: 7 })
    expect(map.map(0, 1)).toEqual({ file: '<generated>', line: 0, col: 1 })
    expect(new SourceMap().map(1, 1)).toEqual({ file: '<generated>', line: 1, col: 1 })
  })

  it('builds identity maps', () => {
    const map = SourceMap.identity('a.st', 3)
    expect(map.map(1, 1)).toEqual({ file: 'a.st', line: 1, col: 1 })
    expect(map.map(3, 9)).toEqual({ file: 'a.st', line: 3, col: 9 })
    expect(map.map(4, 1).file).toBe('<generated>')
  })

  it('is insensitive to insertion order', () => {
    const map = new SourceMap()
    map.add({ genStartLine: 4, lineCount: 2, file: 'b', origStartLine: 20, origStartCol: 1 })
    map.add({ genStartLine: 1, lineCount: 3, file: 'a', origStartLine: 10, origStartCol: 5 })
    expect(map.map(2, 1).file).toBe('a')
    expect(map.map(5, 1)).toEqual({ file: 'b', line: 21, col: 1 })
    expect(map.toJSON().map((s) => s.genStartLine)).toEqual([1, 4])
  })

  it('throws on overlapping segments', () => {
    const map = twoSegmentMap()
    expect(() => map.add({ genStartLine: 3, lineCount: 2, file: 'x', origStartLine: 1, origStartCol: 1 })).toThrow(/overlaps/)
    expect(() => map.add({ genStartLine: 1, lineCount: 10, file: 'x', origStartLine: 1, origStartCol: 1 })).toThrow(/overlaps/)
    expect(() => map.add({ genStartLine: 5, lineCount: 1, file: 'x', origStartLine: 1, origStartCol: 1 })).toThrow(/overlaps/)
    expect(() => map.add({ genStartLine: 6, lineCount: 1, file: 'x', origStartLine: 1, origStartCol: 1 })).not.toThrow()
  })

  it('rejects invalid input', () => {
    const base = { genStartLine: 1, lineCount: 1, file: 'x', origStartLine: 1, origStartCol: 1 }
    const map = new SourceMap()
    expect(() => map.add({ ...base, lineCount: 0 })).toThrow(RangeError)
    expect(() => map.add({ ...base, genStartLine: 0 })).toThrow(RangeError)
    expect(() => map.add({ ...base, origStartLine: 0 })).toThrow(RangeError)
    expect(() => map.add({ ...base, origStartCol: 0 })).toThrow(RangeError)
    expect(() => map.add({ ...base, lineCount: 1.5 })).toThrow(RangeError)
    expect(() => SourceMap.identity('x', 0)).toThrow(RangeError)
  })

  it('round-trips through JSON', () => {
    const map = twoSegmentMap()
    const copy = SourceMap.fromJSON(JSON.parse(JSON.stringify(map)) as ReturnType<SourceMap['toJSON']>)
    expect(copy.toJSON()).toEqual(map.toJSON())
    for (const [line, col] of [[1, 1], [2, 3], [4, 1], [5, 2], [9, 9]] as const) {
      expect(copy.map(line, col)).toEqual(map.map(line, col))
    }
  })

  it('does not alias segments passed in or returned', () => {
    const seg = { genStartLine: 1, lineCount: 1, file: 'x', origStartLine: 1, origStartCol: 1 }
    const map = new SourceMap()
    map.add(seg)
    seg.file = 'mutated'
    map.toJSON()[0]!.file = 'mutated'
    expect(map.map(1, 1).file).toBe('x')
  })
})
