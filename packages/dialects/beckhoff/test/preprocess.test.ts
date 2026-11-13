import { describe, expect, it } from 'vitest'
import { PREPROCESS_UNSUPPORTED, beckhoffDialect, preprocess, type PreprocessWarning } from '../src/index.js'

const lines = (...l: string[]): string => l.join('\n')
const nonEmpty = (text: string): string[] => text.split('\n').filter(Boolean)

describe('preprocess', () => {
  it('keeps an {IF defined} region when the define is listed and blanks it otherwise', () => {
    const src = lines('a', '{IF defined (bSim)}', 'b', '{END_IF}', 'c')
    expect(preprocess(src, { bSim: '' })).toBe(lines('a', '', 'b', '', 'c'))
    expect(preprocess(src, {})).toBe(lines('a', '', '', '', 'c'))
    expect(preprocess(src, { BSIM: '1' })).toBe(lines('a', '', 'b', '', 'c'))
  })

  it('treats defined (variable: x) as FALSE unless x is listed', () => {
    const src = lines('{IF defined (variable: x)}', 'k', '{END_IF}')
    expect(preprocess(src, {})).toBe('\n\n')
    expect(preprocess(src, { x: '' })).toBe('\nk\n')
  })

  it('picks the first true branch of ELSIF chains, including nested ones', () => {
    const src = lines('{IF defined (a)}', 'A', '{ELSIF defined (b)}', 'B', '{ELSIF defined (c)}', 'C', '{ELSE}', 'E', '{END_IF}')
    expect(nonEmpty(preprocess(src, { b: '', c: '' }))).toEqual(['B'])
    expect(nonEmpty(preprocess(src, { c: '' }))).toEqual(['C'])
    expect(nonEmpty(preprocess(src, {}))).toEqual(['E'])
    const nested = lines('{IF defined (o)}', '{IF defined (i)}', 'oi', '{ELSIF defined (j)}', 'oj', '{ELSE}', 'oe', '{END_IF}', '{ELSE}', 'out', '{IF TRUE}', 'never', '{END_IF}', '{END_IF}')
    expect(nonEmpty(preprocess(nested, { o: '', j: '' }))).toEqual(['oj'])
    expect(nonEmpty(preprocess(nested, { o: '' }))).toEqual(['oe'])
    expect(nonEmpty(preprocess(nested, {}))).toEqual(['out', 'never'])
  })

  it('supports AND, OR, NOT and parentheses', () => {
    const run = (cond: string, defs: Record<string, string>): boolean => preprocess(`{IF ${cond}}\nx\n{END_IF}`, defs).includes('x')
    expect(run('defined (a) AND defined (b)', { a: '', b: '' })).toBe(true)
    expect(run('defined (a) AND defined (b)', { a: '' })).toBe(false)
    expect(run('defined (a) OR defined (b)', { b: '' })).toBe(true)
    expect(run('NOT defined (a)', {})).toBe(true)
    expect(run('defined (a) AND NOT defined (b)', { a: '', b: '' })).toBe(false)
    expect(run('(defined (a) OR defined (b)) AND NOT (defined (c))', { b: '' })).toBe(true)
    expect(run('defined (a) OR defined (b) AND defined (c)', { a: '' })).toBe(true)
  })

  it('handles {define} and {undefine}, ignoring them in excluded regions', () => {
    const src = lines('{define foo}', '{IF defined (foo)}', 'x', '{END_IF}', '{undefine foo}', '{IF defined (foo)}', 'y', '{END_IF}', '{IF FALSE}', '{define bar}', '{END_IF}', '{IF defined (bar)}', 'z', '{END_IF}')
    expect(nonEmpty(preprocess(src, {}))).toEqual(['x'])
  })

  it('evaluates hasattribute / hastype / hasvalue as FALSE and warns with the line', () => {
    const warnings: PreprocessWarning[] = []
    const src = lines('ok', "{IF hasattribute (pou: P, 'a')}", 'x', '{ELSIF hastype (variable: v, INT)}', 'y', '{ELSIF hasvalue (variable: v, 1)}', 'z', '{ELSE}', 'e', '{END_IF}')
    expect(nonEmpty(preprocess(src, {}, (w) => warnings.push(w)))).toEqual(['ok', 'e'])
    expect(warnings.map((w) => [w.code, w.line])).toEqual([[PREPROCESS_UNSUPPORTED, 2], [PREPROCESS_UNSUPPORTED, 4], [PREPROCESS_UNSUPPORTED, 6]])
  })

  it('leaves pragmas that are not conditional directives alone', () => {
    expect(preprocess("{attribute 'hide'}\nx", {})).toBe("{attribute 'hide'}\nx")
  })

  it('preserves CRLF and CR terminators', () => {
    expect(preprocess('a\r\n{IF defined (q)}\r\nb\r\n{END_IF}\r\nc\rd', {})).toBe('a\r\n\r\n\r\n\r\nc\rd')
  })

  it('warns about stray directives without throwing', () => {
    const warnings: PreprocessWarning[] = []
    expect(preprocess('{END_IF}\n{ELSE}\nx', {}, (w) => warnings.push(w))).toBe('\n\nx')
    expect(warnings).toHaveLength(2)
  })

  it('is registered as the dialect preprocess hook', () => {
    expect(beckhoffDialect.hooks?.preprocess).toBe(preprocess)
  })

  it('keeps the line count over 200 seeded random nestings', () => {
    let seed = 20240607
    const rnd = (): number => {
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const names = ['a', 'b', 'c']
    const pick = (): string => names[Math.floor(rnd() * 3)]!
    const gen = (depth: number, out: string[]): void => {
      const n = 1 + Math.floor(rnd() * 4)
      for (let i = 0; i < n; i++) {
        if (depth < 4 && rnd() < 0.4) {
          out.push(`{IF ${rnd() < 0.2 ? 'hasattribute (x)' : `${rnd() < 0.3 ? 'NOT ' : ''}defined (${pick()})`}}`)
          gen(depth + 1, out)
          while (rnd() < 0.5) {
            out.push(`{ELSIF defined (${pick()})}`)
            gen(depth + 1, out)
          }
          if (rnd() < 0.5) {
            out.push('{ELSE}')
            gen(depth + 1, out)
          }
          out.push('{END_IF}')
        } else {
          out.push(`stmt${String(out.length)};`)
        }
      }
    }
    const count = (t: string): number => t.split(/\r\n|\n|\r/).length
    for (let i = 0; i < 200; i++) {
      const body: string[] = []
      gen(0, body)
      const eol = rnd() < 0.5 ? '\r\n' : '\n'
      const src = body.join(eol) + (rnd() < 0.5 ? eol : '')
      const defs = Object.fromEntries(names.filter(() => rnd() < 0.5).map((n) => [n, '']))
      const out = preprocess(src, defs)
      expect(count(out)).toBe(count(src))
      expect(out.split(eol).length).toBe(src.split(eol).length)
    }
  })
})
