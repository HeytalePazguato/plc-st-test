import sax from 'sax'

export class XmlSecurityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'XmlSecurityError'
  }
}

export class XmlParseError extends Error {
  constructor(
    message: string,
    readonly file: string,
    readonly line: number,
    readonly col: number,
  ) {
    super(`${file}:${line}:${col}: ${message}`)
    this.name = 'XmlParseError'
  }
}

export interface XmlText {
  value: string
  line: number
  col: number
}

export interface XmlElement {
  name: string
  attrs: Record<string, string>
  children: XmlElement[]
  text: string
  cdata: XmlText[]
  line: number
  col: number
}

export const MAX_XML_DEPTH = 256
export const MAX_XML_ELEMENTS = 200_000

/** Parses `text` into an element tree with 1-based positions; DOCTYPE/ENTITY are rejected and depth/element counts are capped. */
export function parseXml(text: string, file: string): XmlElement {
  const parser = sax.parser(true, { position: true, trim: false })
  const stack: XmlElement[] = []
  let root: XmlElement | undefined
  let count = 0
  let cdataStart = { line: 0, col: 0 }

  parser.ondoctype = () => {
    throw new XmlSecurityError(`DOCTYPE not allowed in ${file}`)
  }
  parser.onsgmldeclaration = (decl) => {
    if (/^\s*ENTITY/i.test(decl)) throw new XmlSecurityError(`ENTITY declarations not allowed in ${file}`)
  }
  parser.onerror = (err) => {
    throw err
  }
  parser.onopentag = (tag) => {
    if (stack.length >= MAX_XML_DEPTH) throw new XmlSecurityError(`XML nesting deeper than ${MAX_XML_DEPTH} in ${file}`)
    if (++count > MAX_XML_ELEMENTS) throw new XmlSecurityError(`More than ${MAX_XML_ELEMENTS} XML elements in ${file}`)
    // sax reports the position just after the tag's closing '>' (0-based); good enough as an element anchor.
    const el: XmlElement = { name: tag.name, attrs: { ...(tag.attributes as Record<string, string>) }, children: [], text: '', cdata: [], line: parser.line + 1, col: parser.column + 1 }
    const parent = stack[stack.length - 1]
    if (parent) parent.children.push(el)
    else root = el
    stack.push(el)
  }
  parser.onclosetag = () => {
    stack.pop()
  }
  parser.ontext = (value) => {
    const top = stack[stack.length - 1]
    if (top) top.text += value
  }
  parser.onopencdata = () => {
    // At this event sax is positioned on the first content character after '<![CDATA[' (0-based).
    cdataStart = { line: parser.line + 1, col: parser.column + 1 }
  }
  parser.oncdata = (value) => {
    const top = stack[stack.length - 1]
    if (top) top.cdata.push({ value, ...cdataStart })
  }
  try {
    parser.write(text).close()
  } catch (error) {
    if (error instanceof XmlSecurityError) throw error
    // Strict sax rejects entity declarations outside a DOCTYPE as a plain parse error; classify those as security violations.
    if (/<!ENTITY/i.test(text)) throw new XmlSecurityError(`ENTITY declarations not allowed in ${file}`)
    const message = error instanceof Error ? (error.message.split('\n')[0] ?? 'XML parse error') : 'XML parse error'
    throw new XmlParseError(message, file, parser.line + 1, parser.column + 1)
  }
  if (!root) throw new XmlParseError('No root element', file, 1, 1)
  return root
}

export function children(el: XmlElement, name: string): XmlElement[] {
  return el.children.filter((c) => c.name === name)
}

export function child(el: XmlElement, name: string): XmlElement | undefined {
  return el.children.find((c) => c.name === name)
}

/** Concatenated character data and CDATA content of `el` (not its descendants). */
export function textOf(el: XmlElement): string {
  return el.text + el.cdata.map((c) => c.value).join('')
}

export function firstCdata(el: XmlElement): XmlText | undefined {
  return el.cdata[0]
}
