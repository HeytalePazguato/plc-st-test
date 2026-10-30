import { describe, expect, it } from 'vitest'
import { PACKAGE_NAME } from '../src/index.js'

describe('@plc-st/dialect-br', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@plc-st/dialect-br')
  })
})
