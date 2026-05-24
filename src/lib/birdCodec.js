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

// All bands sit inside ~560–5000 Hz — the range consumer laptop speakers and
// phone microphones reproduce reliably.  (Earlier the bands ran up to 7900 Hz,
// but real laptop-speaker → phone-mic transmission rolled everything above
// ~1.2 kHz off to noise, so the high bands carried no recoverable signal.)
// Matched-filter detection separates the four simultaneous chirps by their full
// frequency trajectory, so the per-band sweep ranges may overlap.
export const BANDS = [
  // Band 0 — low warble
  { startFreqs: [850,  950,  1060, 1180], sweepRatios: [1.25, 1.50, 1/1.25, 1/1.50] },

  // Band 1 — mid call
  { startFreqs: [1350, 1500, 1670, 1860], sweepRatios: [1.22, 1.45, 1/1.22, 1/1.45] },

  // Band 2 — upper whistle
  { startFreqs: [2050, 2270, 2510, 2780], sweepRatios: [1.20, 1.40, 1/1.20, 1/1.40] },

  // Band 3 — top trill
  { startFreqs: [3050, 3300, 3570, 3860], sweepRatios: [1.15, 1.30, 1/1.15, 1/1.30] },
]

// Preamble chirp — below all data bands, acts as transmission marker.
// Two identical "cuckoo" sweeps (450→680 Hz) separated by a gap.  Detection
// keys on 450 Hz, which is clear of band 0's lowest down-sweep (~567 Hz).
export const PREAMBLE_FSTART    = 450
export const PREAMBLE_FEND      = 680
export const PREAMBLE_DURATION_MS = 200
export const PREAMBLE_GAP_MS      = 100   // silence between preamble chirps
export const POST_PREAMBLE_GAP_MS = 100   // silence before first data frame

// ---------------------------------------------------------------------------
// Frequency analysis
// ---------------------------------------------------------------------------

/**
 * Goertzel algorithm — compute power at a single target frequency.
 *
 * @param {Float32Array} samples
 * @param {number} targetFreq  Hz
 * @param {number} sampleRate
 * @returns {number}  Power (unnormalized energy)
 */
export function goertzel(samples, targetFreq, sampleRate) {
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
// Decoding helpers
// ---------------------------------------------------------------------------

/**
 * Detect symbols in a frame window using matched-filter (dot-product) detection.
 *
 * For each possible profile, tries all 16 symbols per band by correlating the received
 * frame against synthesized reference chirps. This is robust against cross-band
 * interference — simultaneous chirps from other bands have different phase trajectories
 * and thus low correlation with the reference for each band.
 *
 * Self-consistency check: computed profileIdx (from XOR of detected symbols) must equal
 * the profile that was tried. Exactly one profile satisfies this for clean audio.
 *
 * @param {Float32Array} samples  — window >= max chirp duration (160 ms = 7680 samples at 48 kHz)
 * @param {number} sampleRate
 * @returns {number[]|null}  [sym0, sym1, sym2, sym3] or null if unresolvable / silent
 */
export function detectFrame(samples, sampleRate) {
  const SILENCE_N = Math.round(sampleRate * 30 / 1000)  // 30 ms for silence check

  // True-silence guard: only reject windows that are essentially digital silence.
  // Real (quiet) recordings can be ~10× lower amplitude than synthesized PCM, so
  // we must NOT reject on absolute amplitude here — the RMS-normalized matched
  // filter below is what actually distinguishes signal from noise.
  let energy = 0
  for (let i = 0; i < Math.min(SILENCE_N, samples.length); i++) energy += samples[i] * samples[i]
  if (energy < 1e-7) return null

  // Minimum RMS-normalized matched-filter score for a valid detection.
  // Because the frame window is normalized to unit RMS before correlation, the
  // score is amplitude-independent: a clean 4-band frame scores ~10000, a noise
  // window ~450.  3000 leaves wide margin above noise while tolerating real-world
  // degradation, and rejects wrong-profile hits on truncated windows.
  const MIN_FRAME_SCORE = 3000

  // Try each of the 4 timing profiles; keep the highest-scoring self-consistent candidate.
  // (Shorter profiles can accidentally satisfy the XOR check with wrong symbols;
  // the correct profile always has a much higher total dot-product score.)
  let bestScore = -Infinity, bestSyms = null

  for (let p = 0; p < FRAME_PROFILES.length; p++) {
    const prof = FRAME_PROFILES[p]
    const dN = Math.round(sampleRate * prof.durationMs / 1000)
    if (samples.length < dN) continue  // window too short for this profile

    // Normalize the frame window to unit RMS so detection is amplitude-independent.
    const frameWin = new Float32Array(dN)
    let sumSq = 0
    for (let i = 0; i < dN; i++) sumSq += samples[i] * samples[i]
    const rms = Math.sqrt(sumSq / dN)
    if (rms < 1e-6) continue  // silent for this profile length
    const inv = 1 / rms
    for (let i = 0; i < dN; i++) frameWin[i] = samples[i] * inv

    // For each band, find the symbol (0-15) whose reference chirp best matches
    // the received frame — matched filter via dot product.
    const syms = [], scores = []
    for (let b = 0; b < 4; b++) {
      const band = BANDS[b]
      let bestDot = -Infinity, bestSym = 0

      for (let s = 0; s < 16; s++) {
        const fi       = (s >> 2) & 0x3              // startFreqIdx
        const mag      = (s >> 1) & 0x1              // magnitude bit
        const down     = s & 0x1                     // direction bit
        const sweepIdx = (down << 1) | mag           // → sweepRatios index
        const fStart   = band.startFreqs[fi]
        const fEnd     = fStart * band.sweepRatios[sweepIdx]
        const variation = (s * 3 + b * 7) & 0xF     // same seed used by encoder

        const ref = synthesizeChirp(fStart, fEnd, prof.durationMs, sampleRate, variation)
        let dot = 0
        for (let i = 0; i < dN; i++) dot += frameWin[i] * ref[i]
        if (dot > bestDot) { bestDot = dot; bestSym = s }
      }

      syms[b] = bestSym
      scores[b] = bestDot
    }

    // Self-consistency check: profile derived from symbols must match the tried profile.
    const computedProfile = (syms[0] ^ syms[1] ^ syms[2] ^ syms[3]) & 0x3
    if (computedProfile === p) {
      const score = scores[0] + scores[1] + scores[2] + scores[3]
      if (score > bestScore) { bestScore = score; bestSyms = syms.slice() }
    }
  }

  if (bestScore < MIN_FRAME_SCORE) return null
  return bestSyms
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

// ---------------------------------------------------------------------------
// Streaming decoder
// ---------------------------------------------------------------------------

/**
 * Create a streaming decoder for birdCodec audio.
 *
 * Feed raw PCM chunks via push(); decoded payloads are delivered to onBytes.
 * Call reset() to discard any buffered state and return to IDLE.
 *
 * State machine:
 *   IDLE → scan for preamble (500 Hz Goertzel energy threshold)
 *   READING_LEN → decode length frame (1 byte)
 *   READING_DATA → decode ⌈N/2⌉ data frames (2 bytes each)
 *   READING_CHECKSUM → decode checksum frame, verify, call onBytes if valid
 *
 * @param {number}   sampleRate
 * @param {(bytes: Uint8Array) => void} onBytes
 * @returns {{ push(chunk: Float32Array): void, reset(): void }}
 */
export function createDecoder(sampleRate, onBytes) {
  // Timing constants
  const PREAMBLE_SLOT_N = Math.round(sampleRate * (PREAMBLE_DURATION_MS + PREAMBLE_GAP_MS) / 1000)
  const POST_GAP_N      = Math.round(sampleRate * POST_PREAMBLE_GAP_MS / 1000)
  const MAX_CHIRP_N     = Math.round(sampleRate * FRAME_PROFILES[3].durationMs / 1000)
  const MIN_CHIRP_N     = Math.round(sampleRate * FRAME_PROFILES[0].durationMs / 1000)
  const ANALYSIS_N      = Math.round(sampleRate * 30 / 1000)  // preamble scan step
  const MAX_PAYLOAD     = 142

  // Preamble detection uses a *normalized* metric: Goertzel power at
  // PREAMBLE_FSTART divided by the window's total energy.  This ratio is
  // amplitude-independent (works on quiet recordings), and is large only when
  // most of the window's energy sits at the preamble frequency.
  //   preamble chirp ≈ 650   ·   noise ≈ 0.7   ·   data frame ≈ 0   ·   silence ≈ 0
  const PREAMBLE_THRESHOLD = 150
  const SILENCE_FLOOR      = 1e-7  // total window energy below this = digital silence

  // State
  let state = 'IDLE'
  let payloadLen = 0
  let decodedBytes = []
  let framesRemaining = 0

  // Linear buffer (grows as chunks arrive; trimmed after each push)
  let buf = new Float32Array(0)
  let cursor = 0

  // Inter-frame gap to drain before the next detection attempt.
  // After each chirp is consumed we set this to gapMs-worth of samples and drain
  // it incrementally so cursor never overshoots buf.length.  An overshoot would
  // corrupt the buffer alignment: the next push() chunk would land at the wrong
  // PCM position and subsequent frame detections would see the wrong audio.
  let skipRemaining = 0

  function available() { return buf.length - cursor }

  function processBuffer() {
    let progress = true
    while (progress) {
      progress = false
      if      (state === 'IDLE')             { if (tryIdle())     progress = true }
      else if (state === 'READING_LEN')      { if (tryFrame())    progress = true }
      else if (state === 'READING_DATA')     { if (tryFrame())    progress = true }
      else if (state === 'READING_CHECKSUM') { if (tryFrame())    progress = true }
    }
  }

  // Normalized preamble metric: Goertzel power at PREAMBLE_FSTART relative to the
  // window's total energy.  Amplitude-independent — high only when most of the
  // window's energy is concentrated at the preamble frequency.
  function preambleRatio(start) {
    const win = buf.slice(start, start + ANALYSIS_N)
    let total = 0
    for (let i = 0; i < win.length; i++) total += win[i] * win[i]
    if (total < SILENCE_FLOOR) return 0
    return goertzel(win, PREAMBLE_FSTART, sampleRate) / total
  }

  // IDLE: slide a 30 ms window looking for preamble energy at PREAMBLE_FSTART.
  // When two consecutive preamble chirps are confirmed, advance past both and
  // the post-preamble gap, then switch to READING_LEN.
  function tryIdle() {
    // Need at least two full preamble slots + post-gap before we can confirm
    if (available() < 2 * PREAMBLE_SLOT_N + POST_GAP_N) return false

    if (preambleRatio(cursor) > PREAMBLE_THRESHOLD) {
      // Verify second preamble at expected offset
      if (preambleRatio(cursor + PREAMBLE_SLOT_N) > PREAMBLE_THRESHOLD) {
        cursor += 2 * PREAMBLE_SLOT_N + POST_GAP_N
        state = 'READING_LEN'
        return true
      }
    }
    // No preamble here — advance by one step and try again
    cursor += ANALYSIS_N
    return true  // keep scanning
  }

  // READING_LEN / READING_DATA / READING_CHECKSUM: detect the next frame.
  //
  // Phase 1 — Gap drain: consume pending inter-frame silence from the previous
  // frame before attempting detection.  This keeps cursor from overshooting
  // buf.length; an overshoot would empty the buffer and cause the next push()
  // chunk to land at the wrong PCM position, corrupting all subsequent decodes.
  //
  // Phase 2 — Detection: for LEN/DATA frames, wait for a full MAX_CHIRP_N
  // window before detecting (prevents false self-consistent hits from shorter
  // profiles on truncated windows).  For READING_CHECKSUM (last frame in the
  // stream, nothing follows) allow any window >= MIN_CHIRP_N so it can still
  // be decoded.
  function tryFrame() {
    // — Phase 1: drain pending gap —
    if (skipRemaining > 0) {
      const skip = Math.min(available(), skipRemaining)
      cursor       += skip
      skipRemaining -= skip
      if (skipRemaining > 0) return false  // gap not yet fully consumed; wait
      // Fall through: gap fully drained, attempt detection immediately
    }

    // — Phase 2: detection —
    const minNeeded = (state === 'READING_CHECKSUM') ? MIN_CHIRP_N : MAX_CHIRP_N
    if (available() < minNeeded) return false

    const windowN = Math.min(available(), MAX_CHIRP_N)
    const window  = buf.slice(cursor, cursor + windowN)
    const syms    = detectFrame(window, sampleRate)

    if (!syms) {
      if (windowN >= MAX_CHIRP_N) {
        // Full window but no detection: unexpected noise or corrupted frame.
        // Advance past it to avoid getting stuck.
        cursor += ANALYSIS_N
        return true
      }
      // Partial window and no detection — wait for more data.
      return false
    }

    // Frame detected — consume the chirp portion and queue the gap for later.
    const profileIdx = (syms[0] ^ syms[1] ^ syms[2] ^ syms[3]) & 0x3
    const prof       = FRAME_PROFILES[profileIdx]
    const chirpN     = Math.round(sampleRate * prof.durationMs / 1000)
    const gapN       = Math.round(sampleRate * prof.gapMs    / 1000)
    const b0 = (syms[0] << 4) | syms[1]
    const b1 = (syms[2] << 4) | syms[3]

    cursor       += chirpN
    skipRemaining = gapN   // will be drained at the top of the next tryFrame call

    if (state === 'READING_LEN') {
      payloadLen = b0  // length byte; b1 is 0 per wire format
      if (payloadLen === 0 || payloadLen > MAX_PAYLOAD) {
        _reset()
        return true
      }
      decodedBytes    = []
      framesRemaining = Math.ceil(payloadLen / 2)
      state           = 'READING_DATA'
      return true
    }

    if (state === 'READING_DATA') {
      decodedBytes.push(b0, b1)
      framesRemaining--
      if (framesRemaining === 0) state = 'READING_CHECKSUM'
      return true
    }

    if (state === 'READING_CHECKSUM') {
      const rxChecksum = b0
      const rxLenEcho  = b1
      const payload = new Uint8Array(decodedBytes.slice(0, payloadLen))
      let xorCheck = 0
      for (const byte of payload) xorCheck ^= byte
      if (xorCheck === rxChecksum && rxLenEcho === payloadLen) {
        onBytes(payload)
      }
      _reset()
      return true
    }

    return false
  }

  function _reset() {
    buf           = new Float32Array(0)
    cursor        = 0
    state         = 'IDLE'
    payloadLen    = 0
    decodedBytes  = []
    framesRemaining = 0
    skipRemaining   = 0
  }

  return {
    push(chunk) {
      // Append chunk, run state machine, trim consumed portion
      const newBuf = new Float32Array(buf.length - cursor + chunk.length)
      newBuf.set(buf.subarray(cursor))
      newBuf.set(chunk, buf.length - cursor)
      buf    = newBuf
      cursor = 0
      processBuffer()
      // Trim: keep only unconsumed samples
      if (cursor > 0) {
        buf    = buf.subarray(cursor)
        cursor = 0
      }
    },
    reset: _reset,
  }
}
