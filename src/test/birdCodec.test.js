import { describe, it, expect } from 'vitest'
import {
  BANDS,
  FRAME_PROFILES,
  PREAMBLE_DURATION_MS,
  PREAMBLE_GAP_MS,
  POST_PREAMBLE_GAP_MS,
  synthesizeChirp,
  synthesizePreamble,
  synthesizeFrame,
  bytePairToSymbols,
  encode,
  goertzel,
} from '../lib/birdCodec.js'

// Helper: slot length in samples for a given symbols array
function slotSamples(syms, sr = SR) {
  const p = FRAME_PROFILES[(syms[0] ^ syms[1] ^ syms[2] ^ syms[3]) & 0x3]
  return Math.round(sr * (p.durationMs + p.gapMs) / 1000)
}

// Helper: chirp-only length (no gap) for a given symbols array
function chirpSamples(syms, sr = SR) {
  const p = FRAME_PROFILES[(syms[0] ^ syms[1] ^ syms[2] ^ syms[3]) & 0x3]
  return Math.round(sr * p.durationMs / 1000)
}

const SR = 48000

// ---------------------------------------------------------------------------
// goertzel
// ---------------------------------------------------------------------------

describe('goertzel', () => {
  it('returns a number', () => {
    const samples = new Float32Array(1440).fill(0)
    expect(typeof goertzel(samples, 1000, SR)).toBe('number')
  })

  it('returns high energy when signal matches target frequency', () => {
    const N = Math.round(SR * 30 / 1000)
    const samples = new Float32Array(N)
    const freq = 1000
    for (let i = 0; i < N; i++) samples[i] = Math.sin(2 * Math.PI * freq * i / SR)
    const energy = goertzel(samples, freq, SR)
    expect(energy).toBeGreaterThan(1000)
  })

  it('returns low energy for silence', () => {
    const samples = new Float32Array(1440).fill(0)
    expect(goertzel(samples, 1000, SR)).toBe(0)
  })

  it('correctly separates two close frequencies', () => {
    const N = Math.round(SR * 30 / 1000)
    const samples = new Float32Array(N)
    const targetFreq = 1000
    for (let i = 0; i < N; i++) samples[i] = Math.sin(2 * Math.PI * targetFreq * i / SR)
    const atTarget  = goertzel(samples, targetFreq, SR)
    const atWrong   = goertzel(samples, 1300, SR)
    expect(atTarget).toBeGreaterThan(atWrong * 5)
  })
})

// ---------------------------------------------------------------------------
// synthesizeFrame
// ---------------------------------------------------------------------------

describe('synthesizeFrame', () => {
  it('returns a Float32Array', () => {
    expect(synthesizeFrame([0, 0, 0, 0], SR)).toBeInstanceOf(Float32Array)
  })

  it('has the correct frame slot length based on timing profile', () => {
    const syms  = [0, 0, 0, 0]     // profile = (0^0^0^0)&3 = 0 → FRAME_PROFILES[0]
    const frame = synthesizeFrame(syms, SR)
    expect(frame.length).toBe(slotSamples(syms))
  })

  it('different symbol sets produce different frame lengths (profile variation)', () => {
    // profile 0 vs profile 3 must differ in length
    const syms0 = [0, 0, 0, 0]    // XOR = 0 → profile 0 (shortest)
    const syms3 = [0, 0, 0, 3]    // XOR = 3 → profile 3 (longest)
    expect(synthesizeFrame(syms0, SR).length).toBeLessThan(synthesizeFrame(syms3, SR).length)
  })

  it('amplitude stays within [-1, 1]', () => {
    // Use a "worst-case" symbol set — all high-energy symbols
    const frame = synthesizeFrame([7, 11, 13, 15], SR)
    for (const s of frame) {
      expect(Math.abs(s)).toBeLessThanOrEqual(1.01)  // 0.01 tolerance for rounding
    }
  })

  it('gap portion (after chirp) is silent', () => {
    const syms   = [0, 0, 0, 0]
    const chirpN = chirpSamples(syms)
    const frame  = synthesizeFrame(syms, SR)
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
    // Wire layout: preamble×2 + post-preamble gap + len frame + 1 data frame + checksum frame
    // Each frame length is profile-dependent: (sym0^sym1^sym2^sym3)&3 picks the profile.
    const bytes       = new Uint8Array([0x48, 0x69])
    const checksum    = bytes[0] ^ bytes[1]
    const preambleLen = Math.round(SR * (PREAMBLE_DURATION_MS + PREAMBLE_GAP_MS) / 1000)
    const gapLen      = Math.round(SR * POST_PREAMBLE_GAP_MS / 1000)
    const lenFrame    = slotSamples(bytePairToSymbols(bytes.length, 0))
    const dataFrame   = slotSamples(bytePairToSymbols(bytes[0], bytes[1]))
    const cksFrame    = slotSamples(bytePairToSymbols(checksum, bytes.length))
    const expected    = 2 * preambleLen + gapLen + lenFrame + dataFrame + cksFrame
    expect(encode(bytes, SR).length).toBe(expected)
  })

  it('has the correct total sample count for a 3-byte payload (odd — zero-padded)', () => {
    const bytes    = new Uint8Array([0x41, 0x42, 0x43])
    const checksum = bytes[0] ^ bytes[1] ^ bytes[2]
    const preambleLen = Math.round(SR * (PREAMBLE_DURATION_MS + PREAMBLE_GAP_MS) / 1000)
    const gapLen      = Math.round(SR * POST_PREAMBLE_GAP_MS / 1000)
    const lenFrame    = slotSamples(bytePairToSymbols(bytes.length, 0))
    const dataFrame1  = slotSamples(bytePairToSymbols(bytes[0], bytes[1]))
    const dataFrame2  = slotSamples(bytePairToSymbols(bytes[2], 0))  // zero-padded
    const cksFrame    = slotSamples(bytePairToSymbols(checksum, bytes.length))
    const expected    = 2 * preambleLen + gapLen + lenFrame + dataFrame1 + dataFrame2 + cksFrame
    expect(encode(bytes, SR).length).toBe(expected)
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
