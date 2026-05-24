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
  detectFrame,
  createDecoder,
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

// ---------------------------------------------------------------------------
// detectFrame
// ---------------------------------------------------------------------------

describe('detectFrame', () => {
  it('returns null for silence', () => {
    const silence = new Float32Array(Math.round(SR * 0.2))  // 200 ms silence
    expect(detectFrame(silence, SR)).toBeNull()
  })

  it('decodes a synthesized frame correctly', () => {
    const syms  = [4, 8, 6, 9]
    const frame = synthesizeFrame(syms, SR)
    // Pass enough samples for the longest profile
    const maxChirpN = Math.round(SR * FRAME_PROFILES[3].durationMs / 1000)
    const window    = frame.length >= maxChirpN
      ? frame.slice(0, maxChirpN)
      : (() => { const w = new Float32Array(maxChirpN); w.set(frame); return w })()
    const decoded = detectFrame(window, SR)
    expect(decoded).not.toBeNull()
    expect(decoded).toEqual(syms)
  })

  it('correctly decodes [0, 0, 0, 0]', () => {
    const syms   = [0, 0, 0, 0]
    const frame  = synthesizeFrame(syms, SR)
    const maxN   = Math.round(SR * FRAME_PROFILES[3].durationMs / 1000)
    const window = frame.length >= maxN ? frame.slice(0, maxN) : (() => { const w = new Float32Array(maxN); w.set(frame); return w })()
    expect(detectFrame(window, SR)).toEqual(syms)
  })

  it('correctly decodes [15, 15, 15, 15]', () => {
    const syms   = [15, 15, 15, 15]
    const frame  = synthesizeFrame(syms, SR)
    const maxN   = Math.round(SR * FRAME_PROFILES[3].durationMs / 1000)
    const window = frame.length >= maxN ? frame.slice(0, maxN) : (() => { const w = new Float32Array(maxN); w.set(frame); return w })()
    expect(detectFrame(window, SR)).toEqual(syms)
  })
})

// ---------------------------------------------------------------------------
// createDecoder
// ---------------------------------------------------------------------------

describe('createDecoder', () => {
  it('decodes a full encode() output into the original bytes', () => {
    const input = new Uint8Array([0x48, 0x69])
    const pcm   = encode(input, SR)
    let received = null
    const dec   = createDecoder(SR, (bytes) => { received = bytes })
    dec.push(pcm)
    expect(received).not.toBeNull()
    expect(Array.from(received)).toEqual(Array.from(input))
  })

  it('decodes correctly when PCM is pushed in 1024-sample chunks', () => {
    const input = new Uint8Array([0x48, 0x69])
    const pcm   = encode(input, SR)
    let received = null
    const dec   = createDecoder(SR, (bytes) => { received = bytes })
    for (let i = 0; i < pcm.length; i += 1024) {
      dec.push(pcm.slice(i, Math.min(i + 1024, pcm.length)))
    }
    expect(received).not.toBeNull()
    expect(Array.from(received)).toEqual(Array.from(input))
  })

  it('does not call onBytes when checksum is corrupted', () => {
    const input = new Uint8Array([0x48, 0x69])
    const pcm   = encode(input, SR)
    // Locate the checksum chirp and silence it entirely.
    // (The last section of the PCM is [checksum chirp][checksum gap].
    //  Zeroing only the gap — which is already silent — would not corrupt anything.)
    const checksum  = input[0] ^ input[1]
    const cksSyms   = bytePairToSymbols(checksum, input.length)
    const cksProf   = FRAME_PROFILES[(cksSyms[0] ^ cksSyms[1] ^ cksSyms[2] ^ cksSyms[3]) & 0x3]
    const cksGapN   = Math.round(SR * cksProf.gapMs   / 1000)
    const cksChirpN = Math.round(SR * cksProf.durationMs / 1000)
    const chirpStart = pcm.length - cksGapN - cksChirpN
    for (let i = chirpStart; i < chirpStart + cksChirpN; i++) pcm[i] = 0
    let called = false
    const dec  = createDecoder(SR, () => { called = true })
    dec.push(pcm)
    expect(called).toBe(false)
  })

  it('does not call onBytes for 5 seconds of white noise', () => {
    const noise = new Float32Array(SR * 5)
    for (let i = 0; i < noise.length; i++) noise[i] = Math.random() * 2 - 1
    let called = false
    const dec  = createDecoder(SR, () => { called = true })
    expect(() => dec.push(noise)).not.toThrow()
    expect(called).toBe(false)
  })

  it('returns to IDLE after reset() and decodes correctly on next push', () => {
    const input = new Uint8Array([0x41])
    const pcm   = encode(input, SR)
    let received = null
    const dec   = createDecoder(SR, (bytes) => { received = bytes })
    // Push partial PCM then reset
    dec.push(pcm.slice(0, Math.floor(pcm.length / 2)))
    dec.reset()
    received = null
    // Full push after reset should decode cleanly
    dec.push(pcm)
    expect(received).not.toBeNull()
    expect(Array.from(received)).toEqual(Array.from(input))
  })

  it('decodes a 3-byte payload (odd-length, zero-padded last frame)', () => {
    const input = new Uint8Array([0x41, 0x42, 0x43])
    const pcm   = encode(input, SR)
    let received = null
    const dec   = createDecoder(SR, (bytes) => { received = bytes })
    dec.push(pcm)
    expect(received).not.toBeNull()
    expect(Array.from(received)).toEqual(Array.from(input))
  })

  it('decodes audio attenuated 20× (real recordings are much quieter than synthesized PCM)', () => {
    const input = new Uint8Array([0x48, 0x69])
    const pcm   = encode(input, SR)
    // Scale down to 5% amplitude — quieter than the ~9× attenuation seen in a
    // real laptop-speaker → phone-mic recording.  Detection is RMS-normalized,
    // so it must still decode.
    const quiet = new Float32Array(pcm.length)
    for (let i = 0; i < pcm.length; i++) quiet[i] = pcm[i] * 0.05
    let received = null
    const dec = createDecoder(SR, (bytes) => { received = bytes })
    dec.push(quiet)
    expect(received).not.toBeNull()
    expect(Array.from(received)).toEqual(Array.from(input))
  })
})
