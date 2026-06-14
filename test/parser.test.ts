import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  initParser,
  parseSource,
  walk,
  type Diagnostic,
} from '../src/parser/parse.js'
import type { Node } from 'web-tree-sitter'

function fixture(name: string): string {
  const url = new URL(`./fixtures/${name}`, import.meta.url)
  return readFileSync(fileURLToPath(url), 'utf8')
}

const VALID_INLINE =
  'FUNCTION_BLOCK FB_A VAR x : INT; END_VAR x := 1; END_FUNCTION_BLOCK'

describe('parser', () => {
  beforeAll(async () => {
    await initParser()
  })

  it('initParser is idempotent and parseSource works afterwards', async () => {
    // Calling init again must resolve and must NOT re-initialise (the impl
    // caches a single promise). We can only observe that subsequent awaits
    // resolve and that parsing still works.
    await initParser()
    await initParser()
    const parsed = parseSource(VALID_INLINE, 'inline.st')
    expect(parsed.filePath).toBe('inline.st')
    expect(parsed.tree).toBeDefined()
    expect(parsed.diagnostics).toEqual([])
  })

  it('parses a valid FB fixture with zero diagnostics', () => {
    const src = fixture('valid_fb.st')
    const parsed = parseSource(src, 'valid_fb.st')
    expect(parsed.diagnostics).toEqual([])
    expect(parsed.source).toBe(src)
    expect(parsed.filePath).toBe('valid_fb.st')
  })

  it('reports a diagnostic for a missing END_IF', () => {
    const src = fixture('missing_endif.st')
    const parsed = parseSource(src, 'missing_endif.st')
    expect(parsed.diagnostics.length).toBeGreaterThanOrEqual(1)
    // This grammar recovers from a missing END_IF coarsely: it wraps the whole
    // function block in a single top-level ERROR node that starts at the FB
    // declaration (line 1, col 1). So the "correct" reported line is 1 here.
    const first = parsed.diagnostics[0]
    expect(first.file).toBe('missing_endif.st')
    expect(first.line).toBe(1)
    expect(first.col).toBe(1)
    expect(first.message).toMatch(/Syntax error/)
    for (const d of parsed.diagnostics) {
      expect(d.line).toBeGreaterThanOrEqual(1)
      expect(d.col).toBeGreaterThanOrEqual(1)
    }
  })

  it('reports a MISSING-node diagnostic with a precise 1-based line/col', () => {
    const src = fixture('missing_semicolon.st')
    const parsed = parseSource(src, 'missing_semicolon.st')
    expect(parsed.diagnostics.length).toBeGreaterThanOrEqual(1)
    const missing = parsed.diagnostics.find((d: Diagnostic) =>
      d.message.startsWith('Missing'),
    )
    expect(missing).toBeDefined()
    // The semicolon is omitted after `x := x + 1` on line 6; the parser flags
    // the missing ';' at end of that statement.
    expect(missing?.line).toBe(6)
    expect(missing?.col).toBe(19)
    expect(missing?.message).toBe('Missing ;')
    expect(missing?.file).toBe('missing_semicolon.st')
  })

  it('walk visits every named node exactly once', () => {
    const parsed = parseSource(VALID_INLINE, 'inline.st')
    const visited: Node[] = []
    walk(parsed.tree.rootNode, (n) => visited.push(n))

    // Only named nodes are visited.
    expect(visited.every((n) => n.isNamed)).toBe(true)

    // Each node is visited exactly once (unique ids, no duplicates).
    const ids = visited.map((n) => n.id)
    expect(new Set(ids).size).toBe(ids.length)

    // The start node (named root) is included and there is a real subtree.
    expect(visited[0].id).toBe(parsed.tree.rootNode.id)
    expect(visited.length).toBeGreaterThan(3)

    // Expected node types from a FB-with-assignment appear.
    const types = new Set(visited.map((n) => n.type))
    expect(types.has('source_file')).toBe(true)
    expect(types.has('function_block_declaration')).toBe(true)
    expect(types.has('assignment_statement')).toBe(true)
  })
})
