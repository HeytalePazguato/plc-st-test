import { describe, it, expect, beforeAll } from 'vitest'
import type { Language } from 'web-tree-sitter'
import { loadGrammar, baseGrammarPath } from '../src/parser/parse.js'
import { parseExpressionFragment, parseStatementFragment } from '../src/parser/fragment.js'
import { IecError } from '../src/errors.js'

describe('fragments', () => {
  let lang: Language
  beforeAll(async () => {
    lang = await loadGrammar(baseGrammarPath())
  })

  it('parses an expression to its inner node', () => {
    const n = parseExpressionFragment(lang, 'eState = E_S.DONE')
    expect(n.type).toBe('binary_expression')
    expect(n.text).toBe('eState = E_S.DONE')
  })

  it('throws naming the fragment on a bad expression', () => {
    expect(() => parseExpressionFragment(lang, 'a +')).toThrow(IecError)
    expect(() => parseExpressionFragment(lang, 'a +')).toThrow('invalid fragment: a +')
  })

  it('parses statements', () => {
    const stmts = parseStatementFragment(lang, 'x := 1;\ny := 2;')
    expect(stmts.map((s) => s.type)).toEqual(['assignment_statement', 'assignment_statement'])
    expect(stmts[1]?.text).toBe('y := 2;')
  })

  it('reports statement error position relative to the fragment', () => {
    expect(() => parseStatementFragment(lang, 'x := 1;\ny := ;')).toThrow('at line 2, col 5')
  })
})
