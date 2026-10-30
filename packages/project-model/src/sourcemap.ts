/** A 1-based position in an original source file. */
export interface OriginalLocation {
  file: string
  line: number
  col: number
}

/** Maps a run of `lineCount` generated lines (starting at `genStartLine`) onto original lines starting at `origStartLine`/`origStartCol`. */
export interface SourceMapSegment {
  genStartLine: number
  lineCount: number
  file: string
  origStartLine: number
  origStartCol: number
}

export const GENERATED_FILE = '<generated>'

function assertPositiveInt(value: number, what: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${what} must be an integer >= 1, got ${String(value)}`)
  }
}

/** Maps generated (concatenated) line/column positions back to original files; all positions are 1-based. */
export class SourceMap {
  private segments: SourceMapSegment[] = []

  /** A map where generated line N is line N of `file`, with no column offset. */
  static identity(file: string, lineCount: number): SourceMap {
    const map = new SourceMap()
    map.add({ genStartLine: 1, lineCount, file, origStartLine: 1, origStartCol: 1 })
    return map
  }

  static fromJSON(json: readonly SourceMapSegment[]): SourceMap {
    const map = new SourceMap()
    for (const segment of json) map.add(segment)
    return map
  }

  /** Adds a segment; throws if it is invalid or overlaps an existing segment in generated space. */
  add(segment: SourceMapSegment): void {
    assertPositiveInt(segment.genStartLine, 'genStartLine')
    assertPositiveInt(segment.lineCount, 'lineCount')
    assertPositiveInt(segment.origStartLine, 'origStartLine')
    assertPositiveInt(segment.origStartCol, 'origStartCol')
    const start = segment.genStartLine
    const end = start + segment.lineCount - 1
    for (const existing of this.segments) {
      const existingEnd = existing.genStartLine + existing.lineCount - 1
      if (start <= existingEnd && existing.genStartLine <= end) {
        throw new Error(
          `source map segment at generated lines ${String(start)}-${String(end)} overlaps existing segment at ${String(existing.genStartLine)}-${String(existingEnd)}`,
        )
      }
    }
    this.segments.push({ ...segment })
    this.segments.sort((a, b) => a.genStartLine - b.genStartLine)
  }

  /** Resolves a generated position; the column offset applies only to the first line of a segment. Unmapped lines return `<generated>`. */
  map(genLine: number, genCol: number): OriginalLocation {
    for (const s of this.segments) {
      if (genLine < s.genStartLine) break
      const offset = genLine - s.genStartLine
      if (offset < s.lineCount) {
        return {
          file: s.file,
          line: s.origStartLine + offset,
          col: offset === 0 ? s.origStartCol + genCol - 1 : genCol,
        }
      }
    }
    return { file: GENERATED_FILE, line: genLine, col: genCol }
  }

  toJSON(): SourceMapSegment[] {
    return this.segments.map((s) => ({ ...s }))
  }
}
