import { describe, expect, it } from 'vitest'
import { XmlParseError, XmlSecurityError, child, children, firstCdata, parseXml, textOf } from '../src/index.js'

const tcpou = ['<?xml version="1.0" encoding="utf-8"?>', '<TcPlcObject>', '  <POU Name="X">', '      <Declaration><![CDATA[FUNCTION_BLOCK X', 'VAR', 'END_VAR]]></Declaration>', '  </POU>', '</TcPlcObject>'].join('\n')

describe('parseXml', () => {
  it('reports the 1-based position of the first CDATA content character', () => {
    const doc = parseXml(tcpou, 'X.TcPOU')
    const decl = child(child(doc, 'POU')!, 'Declaration')!
    // 6 spaces + '<Declaration>' (13) + '<![CDATA[' (9) = 28 columns precede the content on line 4.
    expect(decl.cdata[0]).toMatchObject({ line: 4, col: 29 })
    expect(firstCdata(decl)?.value).toBe('FUNCTION_BLOCK X\nVAR\nEND_VAR')
  })

  it('places CDATA at line 4 col 22 when 21 columns precede it', () => {
    const doc = parseXml(`<a>\n<b>\n<c>\n${' '.repeat(6)}<Body><![CDATA[FUNCTION_BLOCK X\r\nEND_FUNCTION_BLOCK]]></Body></c></b></a>`, 'f')
    const body = doc.children[0]!.children[0]!.children[0]!
    expect(body.cdata[0]).toMatchObject({ line: 4, col: 22, value: 'FUNCTION_BLOCK X\r\nEND_FUNCTION_BLOCK' })
  })

  it('preserves CRLF inside CDATA', () => {
    const doc = parseXml('<a>\r\n<D><![CDATA[A\r\nB\r\n]]></D>\r\n</a>', 'f')
    expect(child(doc, 'D')!.cdata[0]!.value).toBe('A\r\nB\r\n')
    expect(child(doc, 'D')!.cdata[0]).toMatchObject({ line: 2, col: 13 })
  })

  it('provides helpers', () => {
    const doc = parseXml('<a x="1"><b>t<![CDATA[c]]></b><b/><c/></a>', 'f')
    expect(doc.attrs).toEqual({ x: '1' })
    expect(children(doc, 'b')).toHaveLength(2)
    expect(textOf(child(doc, 'b')!)).toBe('tc')
    expect(child(doc, 'zzz')).toBeUndefined()
  })

  it('rejects DOCTYPE including billion laughs', () => {
    const bomb = '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]><lolz>&lol2;</lolz>'
    expect(() => parseXml(bomb, 'bomb.xml')).toThrow(XmlSecurityError)
    expect(() => parseXml(bomb, 'bomb.xml')).toThrow('DOCTYPE not allowed in bomb.xml')
  })

  it('rejects ENTITY declarations without a DOCTYPE', () => {
    expect(() => parseXml('<a><!ENTITY x "y"></a>', 'e.xml')).toThrow(XmlSecurityError)
  })

  it('caps nesting depth at 256', () => {
    const deep = (n: number) => '<a>'.repeat(n) + '</a>'.repeat(n)
    expect(() => parseXml(deep(256), 'd.xml')).not.toThrow()
    expect(() => parseXml(deep(300), 'd.xml')).toThrow(XmlSecurityError)
  })

  it('caps total element count', () => {
    expect(() => parseXml(`<a>${'<b/>'.repeat(200_000)}</a>`, 'w.xml')).toThrow(XmlSecurityError)
  })

  it('surfaces parse errors with file and line', () => {
    try {
      parseXml('<a>\n<b></a>', 'bad.xml')
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(XmlParseError)
      expect((error as XmlParseError).file).toBe('bad.xml')
      expect((error as XmlParseError).line).toBe(2)
      expect((error as Error).message).toContain('bad.xml:2:')
    }
  })
})
