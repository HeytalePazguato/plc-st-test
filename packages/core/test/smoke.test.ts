import { describe, it, expect } from 'vitest'
import { VERSION } from '../src/index.js'

describe('skeleton', () => {
  it('exposes a version string', () => {
    expect(typeof VERSION).toBe('string')
  })
})
