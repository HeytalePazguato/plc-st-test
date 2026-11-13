/** A problem the preprocessor reports without failing: `line` is 1-based in the text it was given, which is also the original file line because the line count never changes. */
export interface PreprocessWarning {
  code: string
  message: string
  line: number
}

/** The code of every warning the Beckhoff preprocessor raises (a condition it cannot evaluate, or a stray directive). */
export const PREPROCESS_UNSUPPORTED = 'PREPROCESS_UNSUPPORTED'

interface Token {
  kind: 'word' | 'string' | 'punct'
  text: string
}

const DIRECTIVE = /^\s*\{\s*(if|elsif|else|end_if|define|undefine)\b(.*?)\}\s*$/is

function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]!
    if (/\s/.test(ch)) {
      i++
    } else if (ch === "'") {
      const end = text.indexOf("'", i + 1)
      const stop = end === -1 ? text.length : end + 1
      tokens.push({ kind: 'string', text: text.slice(i, stop) })
      i = stop
    } else if (/[A-Za-z0-9_.]/.test(ch)) {
      let j = i
      while (j < text.length && /[A-Za-z0-9_.]/.test(text[j]!)) j++
      tokens.push({ kind: 'word', text: text.slice(i, j) })
      i = j
    } else {
      tokens.push({ kind: 'punct', text: ch })
      i++
    }
  }
  return tokens
}

/** Evaluates a condition such as `defined (a) AND NOT defined (variable: b)`; anything it cannot evaluate is FALSE and reported through `unsupported`. */
function evaluateCondition(text: string, isDefined: (name: string) => boolean, unsupported: (what: string) => void): boolean {
  const tokens = tokenize(text)
  let pos = 0
  const peekWord = (): string | undefined => (tokens[pos]?.kind === 'word' ? tokens[pos]!.text.toLowerCase() : undefined)
  const isPunct = (p: string): boolean => tokens[pos]?.kind === 'punct' && tokens[pos]!.text === p

  /** Positioned on '(': returns the tokens strictly inside the matching parentheses and moves past the ')'. */
  const takeArguments = (): Token[] => {
    const inner: Token[] = []
    let depth = 0
    while (pos < tokens.length) {
      const t = tokens[pos++]!
      if (t.kind === 'punct' && t.text === '(') depth++
      else if (t.kind === 'punct' && t.text === ')') depth--
      if (depth === 0) break
      if (!(depth === 1 && t.kind === 'punct' && t.text === '(' && inner.length === 0)) inner.push(t)
    }
    return inner
  }

  const parseOr = (): boolean => {
    let value = parseAnd()
    while (peekWord() === 'or') {
      pos++
      const rhs = parseAnd()
      value = value || rhs
    }
    return value
  }
  const parseAnd = (): boolean => {
    let value = parseNot()
    while (peekWord() === 'and') {
      pos++
      const rhs = parseNot()
      value = value && rhs
    }
    return value
  }
  const parseNot = (): boolean => {
    if (peekWord() === 'not') {
      pos++
      return !parseNot()
    }
    return parsePrimary()
  }
  const parsePrimary = (): boolean => {
    if (isPunct('(')) {
      pos++
      const value = parseOr()
      if (isPunct(')')) pos++
      return value
    }
    const word = peekWord()
    if (word === undefined) {
      unsupported(text.trim())
      pos = tokens.length
      return false
    }
    pos++
    if (word === 'true') return true
    if (word === 'false') return false
    if (isPunct('(')) {
      const args = takeArguments()
      if (word === 'defined') {
        // `defined (x)` or `defined (variable: x)`: the name is the last word, a scope word before ':' is not part of it.
        const names = args.filter((t) => t.kind === 'word')
        const last = names[names.length - 1]
        return last !== undefined && isDefined(last.text)
      }
      unsupported(`${word}(...)`)
      return false
    }
    // A bare identifier counts as `defined`; anything else after it (a comparison, say) is beyond what simulation can answer.
    if (pos < tokens.length && !isPunct(')') && peekWord() !== 'and' && peekWord() !== 'or') {
      unsupported(text.trim())
      pos = tokens.length
      return false
    }
    return isDefined(word)
  }

  const result = parseOr()
  if (pos < tokens.length && !isPunct(')')) unsupported(text.trim())
  return result
}

interface Frame {
  parentActive: boolean
  taken: boolean
  active: boolean
}

/**
 * Evaluates TwinCAT conditional compilation (`{IF defined (x)}`, `{ELSIF ...}`, `{ELSE}`, `{END_IF}`, `{define x}`, `{undefine x}`) and returns the text with the same number of lines: directive lines and the lines of every excluded branch become empty, and each line's own terminator (LF, CRLF or CR) is kept, so original line numbers stay valid.
 *
 * `defined (name)` and `defined (variable: name)` are TRUE only for a name present in `defines` (or set by `{define}`), compared case-insensitively. `hasattribute`, `hastype`, `hasvalue` and the like cannot be answered without a compiler, so they are FALSE and reported through `warn` as `PREPROCESS_UNSUPPORTED`. `AND`, `OR`, `NOT` and parentheses combine conditions.
 */
export function preprocess(text: string, defines: Record<string, string> = {}, warn?: (warning: PreprocessWarning) => void): string {
  const known = new Set(Object.keys(defines).map((k) => k.toLowerCase()))
  const isDefined = (name: string): boolean => known.has(name.toLowerCase())
  const parts = text.split(/(\r\n|\n|\r)/)
  const stack: Frame[] = []
  let out = ''
  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i]!
    const terminator = parts[i + 1] ?? ''
    const lineNo = i / 2 + 1
    const directive = DIRECTIVE.exec(line)
    const active = stack.length === 0 || stack[stack.length - 1]!.active
    if (directive === null) {
      out += (active ? line : '') + terminator
      continue
    }
    const report = (what: string): void => warn?.({ code: PREPROCESS_UNSUPPORTED, message: `condition '${what}' is not supported in simulation and evaluates to FALSE`, line: lineNo })
    const stray = (name: string): void => warn?.({ code: PREPROCESS_UNSUPPORTED, message: `{${name}} without a matching {IF}`, line: lineNo })
    const keyword = directive[1]!.toLowerCase()
    const rest = directive[2]!
    const frame = stack[stack.length - 1]
    const name = (/^\s*([A-Za-z0-9_.]+)/.exec(rest)?.[1] ?? '').toLowerCase()
    if (keyword === 'if') {
      const value = active && evaluateCondition(rest, isDefined, report)
      stack.push({ parentActive: active, taken: value, active: value })
    } else if (keyword === 'elsif') {
      if (frame === undefined) stray('ELSIF')
      else {
        const value = frame.parentActive && !frame.taken && evaluateCondition(rest, isDefined, report)
        frame.active = value
        frame.taken ||= value
      }
    } else if (keyword === 'else') {
      if (frame === undefined) stray('ELSE')
      else {
        frame.active = frame.parentActive && !frame.taken
        frame.taken = true
      }
    } else if (keyword === 'end_if') {
      if (stack.pop() === undefined) stray('END_IF')
    } else if (active && name !== '') {
      if (keyword === 'define') known.add(name)
      else known.delete(name)
    }
    out += terminator
  }
  return out
}
