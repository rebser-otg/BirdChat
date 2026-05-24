import { describe, it, expect } from 'vitest'
import { pack, unpack, MAX_NAME_LENGTH, MAX_TEXT_LENGTH } from '../lib/messageCodec.js'

describe('pack', () => {
  it('produces a JSON string with n and t keys', () => {
    const result = pack({ name: 'Robin', text: 'hello' })
    const parsed = JSON.parse(result)
    expect(parsed.n).toBe('Robin')
    expect(parsed.t).toBe('hello')
  })

  it('truncates name to MAX_NAME_LENGTH', () => {
    const longName = 'A'.repeat(50)
    const result = JSON.parse(pack({ name: longName, text: 'hi' }))
    expect(result.n.length).toBe(MAX_NAME_LENGTH)
  })

  it('truncates text to MAX_TEXT_LENGTH', () => {
    const longText = 'B'.repeat(200)
    const result = JSON.parse(pack({ name: 'Robin', text: longText }))
    expect(result.t.length).toBe(MAX_TEXT_LENGTH)
  })

  it('total byte length stays within 140 bytes', () => {
    const packed = pack({ name: 'A'.repeat(MAX_NAME_LENGTH), text: 'B'.repeat(MAX_TEXT_LENGTH) })
    expect(new TextEncoder().encode(packed).length).toBeLessThanOrEqual(140)
  })
})

describe('unpack', () => {
  it('roundtrips pack correctly', () => {
    const original = { name: 'Wren', text: 'tweet tweet' }
    const result = unpack(pack(original))
    expect(result).toEqual({ name: 'Wren', text: 'tweet tweet' })
  })

  it('returns null for invalid JSON', () => {
    expect(unpack('not json')).toBeNull()
  })

  it('returns null if n or t are missing', () => {
    expect(unpack(JSON.stringify({ n: 'Robin' }))).toBeNull()
    expect(unpack(JSON.stringify({ t: 'hello' }))).toBeNull()
  })

  it('returns null for non-string n or t', () => {
    expect(unpack(JSON.stringify({ n: 42, t: 'hello' }))).toBeNull()
  })
})
