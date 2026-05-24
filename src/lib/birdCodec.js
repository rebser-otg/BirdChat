/**
 * birdCodec.js — Custom bird-chirp acoustic codec
 *
 * Each byte of data is encoded as two simultaneous 4-note "chords":
 * four chirps play at the same time, one in each frequency band,
 * each encoding 4 bits (one nibble). That's 16 bits = 2 bytes per frame.
 *
 * Sound: stacked simultaneous frequency sweeps across 4 octave bands.
 * Think: a flock of four birds all calling at once, each in their own pitch range.
 *
 * Wire format:
 *   [PREAMBLE ×2] [LEN frame] [DATA frames...] [CHECKSUM frame]
 *
 * Each frame uses one of four timing profiles chosen from the frame's own data bits
 * (see FRAME_PROFILES). Average slot ≈ 143 ms → ~14.0 bytes/sec.
 * 100-byte message ≈ 7–8 seconds + 0.7 s preamble.
 */

// ---------------------------------------------------------------------------
// Timing — four profiles create natural rhythm (staccato snaps → held notes)
// ---------------------------------------------------------------------------

/**
 * Four timing profiles for data frames.
 *
 * Profile index = (sym0 ^ sym1 ^ sym2 ^ sym3) & 0x3 — derived entirely from
 * the frame's own data bits, so the timing variation is deterministic and the
 * decoder doesn't need to track it (it re-derives the profile from frequency
 * content it already decoded). This gives free rhythm variation: messages
 * sound like phrases of short snaps and held whistles, not a metronome.
 *
 * Average slot across equally-likely profiles: (95+125+155+195)/4 = 142.5 ms
 */
export const FRAME_PROFILES = [
  { durationMs:  80, gapMs: 15 },  // 0 — staccato snap
  { durationMs: 105, gapMs: 20 },  // 1 — short call
  { durationMs: 130, gapMs: 25 },  // 2 — natural note
  { durationMs: 160, gapMs: 35 },  // 3 — held note
]

// ---------------------------------------------------------------------------
// Band definitions
// 4 bands, each with 4 start-frequencies × 4 sweep profiles = 16 symbols (4 bits).
//
// Symbol bit layout (4 bits):
//   bits [3:2] — startFreqIdx  (which of the 4 start pitches)
//   bit  [1]   — magnitude     (0 = small sweep, 1 = big sweep)
//   bit  [0]   — direction     (0 = upward sweep,  1 = downward sweep)
//
// Bit 0 (direction) is uniformly distributed for any real data, so every frame
// has ~50 % upward chirps and ~50 % downward chirps regardless of message content.
// sweepRatios index: 0 = smallUP, 1 = bigUP, 2 = smallDOWN, 3 = bigDOWN
//
// Bands are non-overlapping so 4 simultaneous chirps don't confuse the decoder.
// ---------------------------------------------------------------------------

export const BANDS = [
  // Band 0 — "chest voice" (860–1600 Hz start)
  // Upward and downward sweeps, like a robin or blackbird
  { startFreqs: [860,  1060, 1300, 1600], sweepRatios: [1.50, 2.00, 1/1.50, 1/2.00] },

  // Band 1 — "flute register" (1900–3700 Hz start)
  // Full up/down sweeps, like a thrush
  { startFreqs: [1900, 2400, 3000, 3700], sweepRatios: [1.50, 2.00, 1/1.50, 1/2.00] },

  // Band 2 — "wren register" (3800–6500 Hz start)
  // Narrower sweeps at higher frequencies
  { startFreqs: [3800, 4600, 5500, 6500], sweepRatios: [1.40, 1.80, 1/1.40, 1/1.80] },

  // Band 3 — "ultrasonic trill" (6200–7900 Hz start)
  // Small sweeps; sounds like a high-pitched wren or kinglet
  { startFreqs: [6200, 6800, 7400, 7900], sweepRatios: [1.20, 1.35, 1/1.20, 1/1.35] },
]

// Preamble chirp — below all data bands, acts as transmission marker
// Two identical "cuckoo" sweeps (500→800 Hz) separated by a gap.
export const PREAMBLE_FSTART    = 500
export const PREAMBLE_FEND      = 800
export const PREAMBLE_DURATION_MS = 200
export const PREAMBLE_GAP_MS      = 100   // silence between preamble chirps
export const POST_PREAMBLE_GAP_MS = 100   // silence before first data frame

// ---------------------------------------------------------------------------
// Synthesis helpers
// ---------------------------------------------------------------------------

/**
 * Synthesize a single chirp sweeping exponentially from fStart to fEnd.
 *
 * @param {number} fStart      Starting frequency in Hz
 * @param {number} fEnd        Ending frequency in Hz
 * @param {number} durationMs
 * @param {number} sampleRate
 * @param {number} [variation=0]  0–15: deterministic seed for organic envelope variation.
 *   Varies attack (6–12 ms), decay (18–33 ms), and 2nd-harmonic amplitude (10–27 %)
 *   so no two chirp types sound identical. Pass 0 for a canonical, reproducible chirp.
 * @returns {Float32Array}
 */
export function synthesizeChirp(fStart, fEnd, durationMs, sampleRate, variation = 0) {
  const n = Math.round(sampleRate * durationMs / 1000)

  // Organic variation: attack 6–12 ms, decay 18–33 ms, harmonic 10–27 %
  const attackN  = Math.round(sampleRate * (0.006 + ( variation       & 0x3) * 0.002))
  const decayN   = Math.round(sampleRate * (0.018 + ((variation >> 2) & 0x3) * 0.005))
  const harmAmp  = 0.10 + ((variation >> 1) & 0x7) * 0.025

  const logRatio = Math.log(Math.max(fEnd, 1) / Math.max(fStart, 1))
  const pcm = new Float32Array(n)
  let phase1 = 0  // fundamental
  let phase2 = 0  // 2nd harmonic

  for (let i = 0; i < n; i++) {
    const freq   = fStart * Math.exp(logRatio * i / n)
    const dPhase = 2 * Math.PI * freq / sampleRate
    phase1 = (phase1 + dPhase) % (2 * Math.PI)
    phase2 = (phase2 + dPhase * 2) % (2 * Math.PI)

    // Amplitude envelope: linear attack → sustain → exponential decay
    let amp
    const fromEnd = n - 1 - i
    if (i < attackN) {
      amp = i / attackN
    } else if (fromEnd < decayN) {
      amp = Math.exp(-4 * (1 - fromEnd / decayN))
    } else {
      amp = 1.0
    }

    pcm[i] = (Math.sin(phase1) + Math.sin(phase2) * harmAmp) * amp
  }

  return pcm
}

/**
 * Synthesize one preamble chirp + trailing silence gap.
 * @param {number} sampleRate
 * @returns {Float32Array}
 */
export function synthesizePreamble(sampleRate) {
  const chirpN = Math.round(sampleRate * PREAMBLE_DURATION_MS / 1000)
  const gapN   = Math.round(sampleRate * PREAMBLE_GAP_MS / 1000)
  const out    = new Float32Array(chirpN + gapN)  // gap stays zero
  const chirp  = synthesizeChirp(PREAMBLE_FSTART, PREAMBLE_FEND, PREAMBLE_DURATION_MS, sampleRate)
  out.set(chirp)
  return out
}

/**
 * Synthesize one frame: 4 simultaneous chirps (one per band) + gap.
 *
 * @param {number[]} symbols  Four values in [0, 15], one per band
 * @param {number}   sampleRate
 * @returns {Float32Array}  Length = FRAME_SLOT_MS * sampleRate / 1000 samples
 */
export function synthesizeFrame(symbols, sampleRate) {
  // Timing profile: derived from XOR of all four symbols — no extra decoder work needed.
  const profileIdx   = (symbols[0] ^ symbols[1] ^ symbols[2] ^ symbols[3]) & 0x3
  const { durationMs, gapMs } = FRAME_PROFILES[profileIdx]
  const chirpN = Math.round(sampleRate * durationMs / 1000)
  const gapN   = Math.round(sampleRate * gapMs   / 1000)
  const frame  = new Float32Array(chirpN + gapN)  // gap portion stays zero

  for (let b = 0; b < 4; b++) {
    const sym          = symbols[b] & 0xF           // clamp to 4 bits
    const startFreqIdx = (sym >> 2) & 0x3           // bits [3:2]: start pitch
    const magnitude    = (sym >> 1) & 0x1           // bit  [1]:   0=small, 1=big
    const isDown       = sym & 0x1                  // bit  [0]:   0=upward, 1=downward
    const sweepIdx     = (isDown << 1) | magnitude  // → 0=smallUP 1=bigUP 2=smallDOWN 3=bigDOWN
    const band         = BANDS[b]
    const fStart       = band.startFreqs[startFreqIdx]
    const fEnd         = fStart * band.sweepRatios[sweepIdx]
    // Deterministic per-chirp variation: makes each of the 64 (4 bands × 16 symbols) chirps
    // have a slightly different envelope/harmonic character — no two chirps sound identical.
    const variation    = (sym * 3 + b * 7) & 0xF
    const chirp        = synthesizeChirp(fStart, fEnd, durationMs, sampleRate, variation)

    for (let i = 0; i < chirpN; i++) frame[i] += chirp[i]
  }

  // Normalize the chirp portion to prevent clipping from 4 summed chirps
  let maxAmp = 0
  for (let i = 0; i < chirpN; i++) {
    const a = Math.abs(frame[i])
    if (a > maxAmp) maxAmp = a
  }
  if (maxAmp > 0.88) {
    const scale = 0.88 / maxAmp
    for (let i = 0; i < chirpN; i++) frame[i] *= scale
  }

  return frame
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/**
 * Convert 2 bytes into [band0sym, band1sym, band2sym, band3sym].
 * byte0 → band 0 (high nibble) + band 1 (low nibble)
 * byte1 → band 2 (high nibble) + band 3 (low nibble)
 */
export function bytePairToSymbols(b0, b1) {
  return [
    (b0 >> 4) & 0xF,   // band 0
     b0       & 0xF,   // band 1
    (b1 >> 4) & 0xF,   // band 2
     b1       & 0xF,   // band 3
  ]
}

/**
 * Encode a Uint8Array of bytes into a Float32Array of PCM audio.
 *
 * Wire format:
 *   [preamble A (300ms)] [preamble B (300ms)] [post-preamble gap]
 *   [len frame] [data frames...] [checksum frame]
 *
 * @param {Uint8Array} bytes
 * @param {number}     sampleRate
 * @returns {Float32Array}
 */
export function encode(bytes, sampleRate) {
  // Build list of Float32Array segments to concatenate
  const segments = []

  // Preamble × 2
  const preamble = synthesizePreamble(sampleRate)
  segments.push(preamble, preamble)

  // Post-preamble gap
  segments.push(new Float32Array(Math.round(sampleRate * POST_PREAMBLE_GAP_MS / 1000)))

  // Checksum = XOR of all payload bytes
  let checksum = 0
  for (const b of bytes) checksum ^= b

  // Length frame: encodes payload byte count (bands 0+1 = length byte, bands 2+3 = 0)
  segments.push(synthesizeFrame(bytePairToSymbols(bytes.length & 0xFF, 0), sampleRate))

  // Data frames: 2 bytes per frame
  for (let i = 0; i < bytes.length; i += 2) {
    const b0 = bytes[i]
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0  // zero-pad if odd length
    segments.push(synthesizeFrame(bytePairToSymbols(b0, b1), sampleRate))
  }

  // Checksum frame: (checksum byte, length echo) for validation
  segments.push(synthesizeFrame(bytePairToSymbols(checksum, bytes.length & 0xFF), sampleRate))

  // Concatenate all segments
  const totalLen = segments.reduce((sum, s) => sum + s.length, 0)
  const out = new Float32Array(totalLen)
  let offset = 0
  for (const seg of segments) { out.set(seg, offset); offset += seg.length }
  return out
}
