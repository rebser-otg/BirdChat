import { describe, it, expect } from 'vitest'
import {
  BANDS,
  SYMBOL_DURATION_MS,
  SYMBOL_GAP_MS,
  PREAMBLE_DURATION_MS,
  PREAMBLE_GAP_MS,
  POST_PREAMBLE_GAP_MS,
  synthesizeChirp,
  synthesizePreamble,
  synthesizeFrame,
  bytePairToSymbols,
  encode,
} from '../lib/birdCodec.js'

const SR = 48000

// ---------------------------------------------------------------------------
// Goertzel helper — copied inline so tests have no external dep on the decoder
// ---------------------------------------------------------------------------
function goertzel(samples, targetFreq, sampleRate) {
  const k = Math.round(samples.length * targetFreq / sampleRate)
  const coeff = 2 * Math.cos(2 * Math.PI * k / samples.length)
  let s1 = 0, s2 = 0
  for (const x of samples) {
    const s0 = x + coeff * s1 - s2
    s2 = s1; s1 = s0
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2
}

// ---------------------------------------------------------------------------
// synthesizeFrame
// ---------------------------------------------------------------------------

describe('synthesizeFrame', () => {
  it('returns a Float32Array', () => {
    expect(synthesizeFrame([0, 0, 0, 0], SR)).toBeInstanceOf(Float32Array)
  })

  it('has the correct frame slot length (chirp + gap)', () => {
    const frame    = synthesizeFrame([0, 0, 0, 0], SR)
    const expected = Math.round(SR * (SYMBOL_DURATION_MS + SYMBOL_GAP_MS) / 1000)
    expect(frame.length).toBe(expected)
  })

  it('amplitude stays within [-1, 1]', () => {
    // Use a "worst-case" symbol set — all high-energy symbols
    const frame = synthesizeFrame([7, 11, 13, 15], SR)
    for (const s of frame) {
      expect(Math.abs(s)).toBeLessThanOrEqual(1.01)  // 0.01 tolerance for rounding
    }
  })

  it('gap portion (after chirp) is silent', () => {
    const chirpN = Math.round(SR * SYMBOL_DURATION_MS / 1000)
    const frame  = synthesizeFrame([0, 0, 0, 0], SR)
    for (let i = chirpN; i < frame.length; i++) {
      expect(frame[i]).toBe(0)
    }
  })
})

// ---------------------------------------------------------------------------
// synthesizePreamble
// ---------------------------------------------------------------------------

describe('synthesizePreamble', () => {
  it('returns a Float32Array', () => {
    expect(synthesizePreamble(SR)).toBeInstanceOf(Float32Array)
  })

  it('has the correct length (preamble chirp + preamble gap)', () => {
    const expected = Math.round(SR * (PREAMBLE_DURATION_MS + PREAMBLE_GAP_MS) / 1000)
    expect(synthesizePreamble(SR).length).toBe(expected)
  })
})

// ---------------------------------------------------------------------------
// synthesizeChirp — frequency separability
// ---------------------------------------------------------------------------

describe('synthesizeChirp — frequency separability', () => {
  it('band 0: symbol 0 (startFreq[0]) beats symbol 4 (startFreq[1]) in the first-30ms window', () => {
    // Band 0, symbol 0: startFreqIdx=0 → BANDS[0].startFreqs[0]
    // Band 0, symbol 4: startFreqIdx=1 → BANDS[0].startFreqs[1]
    const frame_sym0 = synthesizeFrame([0, 0, 0, 0], SR)   // band 0 symbol = 0
    const frame_sym4 = synthesizeFrame([4, 0, 0, 0], SR)   // band 0 symbol = 4
    const analysisN  = Math.round(SR * 30 / 1000)          // first 30 ms
    const first30_s0 = frame_sym0.slice(0, analysisN)
    const first30_s4 = frame_sym4.slice(0, analysisN)
    const f0 = BANDS[0].startFreqs[0]
    const f1 = BANDS[0].startFreqs[1]

    // Symbol 0 should have more energy at f0 than at f1
    expect(goertzel(first30_s0, f0, SR)).toBeGreaterThan(goertzel(first30_s0, f1, SR))
    // Symbol 4 should have more energy at f1 than at f0
    expect(goertzel(first30_s4, f1, SR)).toBeGreaterThan(goertzel(first30_s4, f0, SR))
  })

  it('all 4 start-frequencies in band 0 are individually distinguishable', () => {
    // Each of the 4 startFreqIdx values (symbols 0, 4, 8, 12) should win at its own f_start
    for (let startIdx = 0; startIdx < 4; startIdx++) {
      const sym    = startIdx << 2   // e.g. 0, 4, 8, 12
      const frame  = synthesizeFrame([sym, 0, 0, 0], SR)
      const N      = Math.round(SR * 30 / 1000)
      const window = frame.slice(0, N)
      const fOwn   = BANDS[0].startFreqs[startIdx]
      const ownEnergy = goertzel(window, fOwn, SR)

      for (let other = 0; other < 4; other++) {
        if (other === startIdx) continue
        const fOther = BANDS[0].startFreqs[other]
        expect(ownEnergy).toBeGreaterThan(goertzel(window, fOther, SR))
      }
    }
  })
})

// ---------------------------------------------------------------------------
// bytePairToSymbols
// ---------------------------------------------------------------------------

describe('bytePairToSymbols', () => {
  it('splits two bytes into four nibbles', () => {
    expect(bytePairToSymbols(0xAB, 0xCD)).toEqual([0xA, 0xB, 0xC, 0xD])
  })

  it('handles zero bytes', () => {
    expect(bytePairToSymbols(0, 0)).toEqual([0, 0, 0, 0])
  })

  it('handles 0xFF bytes', () => {
    expect(bytePairToSymbols(0xFF, 0xFF)).toEqual([0xF, 0xF, 0xF, 0xF])
  })
})

// ---------------------------------------------------------------------------
// encode
// ---------------------------------------------------------------------------

describe('encode', () => {
  it('returns a Float32Array', () => {
    expect(encode(new Uint8Array([0x48, 0x69]), SR)).toBeInstanceOf(Float32Array)
  })

  it('has the correct total sample count for a 2-byte payload', () => {
    // Wire layout: preamble×2 + post-preamble-gap + len frame + 1 data frame + checksum frame
    const preambleLen = Math.round(SR * (PREAMBLE_DURATION_MS + PREAMBLE_GAP_MS) / 1000)
    const frameLen    = Math.round(SR * (SYMBOL_DURATION_MS  + SYMBOL_GAP_MS)     / 1000)
    const gapLen      = Math.round(SR * POST_PREAMBLE_GAP_MS / 1000)
    const expected    = 2 * preambleLen + gapLen + 3 * frameLen  // len + 1 data + checksum
    expect(encode(new Uint8Array([0x48, 0x69]), SR).length).toBe(expected)
  })

  it('has the correct total sample count for a 3-byte payload (odd — zero-padded)', () => {
    // 3 bytes → 2 data frames (zero-padded to even)
    const preambleLen = Math.round(SR * (PREAMBLE_DURATION_MS + PREAMBLE_GAP_MS) / 1000)
    const frameLen    = Math.round(SR * (SYMBOL_DURATION_MS  + SYMBOL_GAP_MS)     / 1000)
    const gapLen      = Math.round(SR * POST_PREAMBLE_GAP_MS / 1000)
    const expected    = 2 * preambleLen + gapLen + 4 * frameLen  // len + 2 data + checksum
    expect(encode(new Uint8Array([0x41, 0x42, 0x43]), SR).length).toBe(expected)
  })

  it('starts with the preamble signal', () => {
    const preamble = synthesizePreamble(SR)
    const encoded  = encode(new Uint8Array([0x41]), SR)
    for (let i = 0; i < preamble.length; i++) {
      expect(encoded[i]).toBeCloseTo(preamble[i], 5)
    }
  })

  it('handles empty payload without throwing', () => {
    expect(() => encode(new Uint8Array([]), SR)).not.toThrow()
  })

  it('encodes the same input deterministically', () => {
    const a = encode(new Uint8Array([0x42]), SR)
    const b = encode(new Uint8Array([0x42]), SR)
    expect(Array.from(a)).toEqual(Array.from(b))
  })
})
