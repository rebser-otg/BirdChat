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
 * Single FIXED frame timing.
 *
 * Earlier versions derived a per-frame duration from the frame's own data bits
 * (for "natural rhythm").  That made framing fragile: if one frame's symbols
 * were misread, the decoder computed the wrong frame length, advanced its read
 * cursor by the wrong amount, and every subsequent frame desynced — so a single
 * bad frame destroyed the rest of the message.  A fixed length means a misread
 * frame only corrupts itself (caught by the checksum); the stream stays aligned.
 *
 * 400 ms chirps: the matched filter's SNR scales with integration time, so long
 * chirps are far more robust over a real acoustic link (per-band symbol error
 * ~5 % at 160 ms vs ~0.2 % at 400 ms in testing).  Kept as a 1-element array so
 * the rest of the code (and tests) can stay structured the same way.
 */
export const FRAME_PROFILES = [
  { durationMs: 400, gapMs: 40 },
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

// Peak amplitude for transmitted chirps — as loud as possible without clipping.
const TX_PEAK = 0.97

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
  // Normalize to TX_PEAK (the raw chirp's 2nd harmonic can push it past ±1 and clip).
  let mx = 0
  for (const x of chirp) { const a = Math.abs(x); if (a > mx) mx = a }
  const scale = mx > 0 ? TX_PEAK / mx : 1
  for (let i = 0; i < chirpN; i++) out[i] = chirp[i] * scale
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
  // Fixed timing — every frame is the same length (see FRAME_PROFILES).
  const { durationMs, gapMs } = FRAME_PROFILES[0]
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

  // Normalize the chirp portion to TX_PEAK — as loud as possible without clipping,
  // which matters most for the weak link (a phone speaker heard by a laptop mic).
  let maxAmp = 0
  for (let i = 0; i < chirpN; i++) {
    const a = Math.abs(frame[i])
    if (a > maxAmp) maxAmp = a
  }
  if (maxAmp > 0) {
    const scale = TX_PEAK / maxAmp
    for (let i = 0; i < chirpN; i++) frame[i] *= scale
  }

  return frame
}

// ---------------------------------------------------------------------------
// Decoding helpers
// ---------------------------------------------------------------------------

/**
 * Per-symbol frequency trajectories for NON-COHERENT detection.
 *
 * Detection measures how much signal energy follows each candidate chirp's
 * frequency path (via Goertzel over short sub-windows), rather than correlating
 * against a phase-exact reference waveform.  A coherent matched filter collapses
 * with even ~2 ms of timing error, but the preamble is only located to ~30 ms —
 * so coherent detection fails on real (non-sample-exact) acoustic transmission.
 * Energy-along-trajectory is phase-insensitive and tolerant to tens of ms of
 * misalignment.
 *
 * For each band/symbol we precompute the chirp's centre frequency in each of
 * NONCOH_K equal sub-windows of the fixed-length frame.
 *
 * Layout: _trajCache.get(sampleRate) = { tbl[band][symbol] → Float64Array(K), dN, L }
 */
const NONCOH_K = 16   // sub-windows across the frame (sweep tracking vs. freq resolution)
const _trajCache = new Map()

function getSymbolTrajectories(sampleRate) {
  const cached = _trajCache.get(sampleRate)
  if (cached) return cached

  const dN = Math.round(sampleRate * FRAME_PROFILES[0].durationMs / 1000)
  const L  = Math.floor(dN / NONCOH_K)
  const tbl = BANDS.map((band) => {
    const perSymbol = new Array(16)
    for (let s = 0; s < 16; s++) {
      const fi       = (s >> 2) & 0x3
      const mag      = (s >> 1) & 0x1
      const down     = s & 0x1
      const sweepIdx = (down << 1) | mag
      const fStart   = band.startFreqs[fi]
      const fEnd     = fStart * band.sweepRatios[sweepIdx]
      const logR     = Math.log(Math.max(fEnd, 1) / Math.max(fStart, 1))
      const freqs    = new Float64Array(NONCOH_K)
      for (let k = 0; k < NONCOH_K; k++) {
        const tCenter = (k + 0.5) * L
        freqs[k] = fStart * Math.exp(logR * tCenter / dN)
      }
      perSymbol[s] = freqs
    }
    return perSymbol
  })

  const entry = { tbl, dN, L }
  _trajCache.set(sampleRate, entry)
  return entry
}

// Goertzel power at one frequency over a sub-window samples[start, start+len).
function goertzelAt(samples, start, len, freq, sampleRate) {
  const k = Math.round(len * freq / sampleRate)
  const coeff = 2 * Math.cos(2 * Math.PI * k / len)
  let s1 = 0, s2 = 0
  for (let i = 0; i < len; i++) {
    const s0 = samples[start + i] + coeff * s1 - s2
    s2 = s1; s1 = s0
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2
}

/**
 * Detect the four band symbols in a frame window via non-coherent (energy along
 * each chirp's frequency trajectory) detection.  Phase-insensitive and tolerant
 * to timing misalignment, unlike a coherent matched filter.
 *
 * @param {Float32Array} samples  — window ≥ one fixed-length chirp
 * @param {number} sampleRate
 * @param {{score:number,bands:number[]}} [diag]  — filled with the detection score
 * @returns {number[]|null}  [sym0, sym1, sym2, sym3] or null if silent
 */
export function detectFrame(samples, sampleRate, diag = null) {
  if (diag) { diag.score = 0; diag.bands = [0, 0, 0, 0] }
  const SILENCE_N = Math.round(sampleRate * 30 / 1000)

  // True-silence guard (digital silence only — quiet real audio must pass).
  let energy = 0
  for (let i = 0; i < Math.min(SILENCE_N, samples.length); i++) energy += samples[i] * samples[i]
  if (energy < 1e-7) return null

  const { tbl, dN, L } = getSymbolTrajectories(sampleRate)
  if (samples.length < dN) return null

  // Normalize the window to unit RMS so detection is amplitude-independent.
  const win = new Float32Array(dN)
  let sumSq = 0
  for (let i = 0; i < dN; i++) sumSq += samples[i] * samples[i]
  const rms = Math.sqrt(sumSq / dN)
  if (rms < 1e-6) return null
  const inv = 1 / rms
  for (let i = 0; i < dN; i++) win[i] = samples[i] * inv

  // For each band, pick the symbol whose frequency trajectory captures the most
  // energy (summed Goertzel power over the K sub-windows).
  const syms = [], scores = []
  for (let b = 0; b < BANDS.length; b++) {
    const bandTraj = tbl[b]
    let best = -Infinity, bestSym = 0
    for (let s = 0; s < 16; s++) {
      const freqs = bandTraj[s]
      let e = 0
      for (let k = 0; k < NONCOH_K; k++) {
        e += goertzelAt(win, k * L, L, freqs[k], sampleRate)
      }
      if (e > best) { best = e; bestSym = s }
    }
    syms[b] = bestSym
    scores[b] = best
  }

  // Always return the best-match symbols (score reported via diag).  Once locked
  // onto a message, every fixed slot is a frame and is decoded in place.
  const score = scores.reduce((a, c) => a + c, 0)
  if (diag) { diag.score = score; diag.bands = scores.slice() }
  return syms
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
 *   [len frame] [data frames...] [checksum frame] [trailing silence]
 *
 * The trailing silence (one max-length chirp's worth) guarantees the decoder
 * always has a full detection window for the final checksum frame, so encode →
 * decode is self-contained and doesn't depend on extra captured audio after the
 * message.
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

  // Trailing silence: one max-length chirp's worth, so the decoder always has a
  // full detection window for the checksum frame even at end-of-stream.
  segments.push(new Float32Array(Math.round(sampleRate * FRAME_PROFILES[0].durationMs / 1000)))

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
export function createDecoder(sampleRate, onBytes, onEvent = null) {
  // Optional diagnostic hook: emit('preamble' | 'len' | 'frame' | 'decoded' | 'checksum-fail', detail)
  const emit = onEvent ? (name, detail) => onEvent({ name, detail }) : () => {}

  // Timing constants
  const PREAMBLE_SLOT_N = Math.round(sampleRate * (PREAMBLE_DURATION_MS + PREAMBLE_GAP_MS) / 1000)
  const POST_GAP_N      = Math.round(sampleRate * POST_PREAMBLE_GAP_MS / 1000)
  const MAX_CHIRP_N     = Math.round(sampleRate * FRAME_PROFILES[0].durationMs / 1000)  // fixed chirp length
  const ANALYSIS_N      = Math.round(sampleRate * 30 / 1000)  // preamble scan step
  const MAX_PAYLOAD     = 142

  // Preamble detection uses a *normalized* metric: Goertzel power at
  // PREAMBLE_FSTART divided by the window's total energy.  This ratio is
  // amplitude-independent (works on quiet recordings), and is large only when
  // most of the window's energy sits at the preamble frequency.
  //   preamble chirp ≈ 650   ·   noise ≈ 0.7   ·   data frame ≈ 0   ·   silence ≈ 0
  const PREAMBLE_THRESHOLD = 150
  const SILENCE_FLOOR      = 1e-7  // total window energy below this = digital silence

  // Fine-alignment search: the preamble is located only to within ANALYSIS_N, so
  // the frame grid can sit at a variable offset.  Once, at the first frame, we
  // search ±ALIGN_W around the coarse cursor for the offset that maximizes the
  // frame match, then lock the grid there.  Without this, every frame (including
  // the critical length frame) is read at a constant offset → frequent errors.
  const ALIGN_W    = ANALYSIS_N             // ± search range (≈30 ms)
  const ALIGN_STEP = Math.max(1, Math.round(sampleRate * 0.004))  // ≈4 ms resolution

  // State
  let state = 'IDLE'
  let payloadLen = 0
  let decodedBytes = []
  let framesRemaining = 0
  let alignDone = false   // has the frame grid been fine-aligned to this preamble?

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
        // Land ALIGN_W *before* the expected first-frame start so the alignment
        // search below only reads forward (the buffer is trimmed at cursor between
        // pushes, so samples before cursor aren't retained).
        cursor += 2 * PREAMBLE_SLOT_N + POST_GAP_N - ALIGN_W
        state = 'READING_LEN'
        alignDone = false   // coarse-align the grid on the first frame
        emit('preamble')
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
  // Phase 2 — Detection: wait for a full chirp window before detecting.  encode()
  // appends trailing silence so even the final checksum frame reaches a full window.
  function tryFrame() {
    // — Phase 1: drain pending gap —
    if (skipRemaining > 0) {
      const skip = Math.min(available(), skipRemaining)
      cursor       += skip
      skipRemaining -= skip
      if (skipRemaining > 0) return false  // gap not yet fully consumed; wait
      // Fall through: gap fully drained, attempt detection immediately
    }

    // — Phase 2: one-time coarse alignment of the frame grid to the preamble —
    // The preamble is located only to ±ANALYSIS_N, leaving the grid off by up to
    // ~30 ms.  The non-coherent detection score peaks sharply at true alignment
    // (and, unlike a coherent score, is NOT inflated by windows containing
    // silence), so we slide a window forward over [0, 2·ALIGN_W] (cursor was
    // backed up by ALIGN_W at the preamble) and lock to the max-score offset.
    if (!alignDone) {
      if (available() < 2 * ALIGN_W + MAX_CHIRP_N) return false
      let bestOff = 0, bestScore = -Infinity
      for (let off = 0; off <= 2 * ALIGN_W; off += ALIGN_STEP) {
        const d = { score: 0, bands: null }
        detectFrame(buf.subarray(cursor + off, cursor + off + MAX_CHIRP_N), sampleRate, d)
        if (d.score > bestScore) { bestScore = d.score; bestOff = off }
      }
      cursor += bestOff
      alignDone = true
    }

    // — Phase 3: detect the fixed slot, decode it in place, advance a full slot —
    if (available() < MAX_CHIRP_N) return false

    const diag = onEvent ? { score: 0, bands: [0, 0, 0, 0] } : null
    // Always decode (null only on true silence → treat as a garbage frame).  Once
    // locked onto a message, every fixed slot is a frame; decoding in place keeps
    // the grid aligned, so a low-confidence frame can't desync the rest.
    const syms = detectFrame(buf.subarray(cursor, cursor + MAX_CHIRP_N), sampleRate, diag) || [0, 0, 0, 0]
    if (diag) emit('frame-score', { total: Math.round(diag.score), bands: diag.bands.map(Math.round) })

    const chirpN = Math.round(sampleRate * FRAME_PROFILES[0].durationMs / 1000)
    const gapN   = Math.round(sampleRate * FRAME_PROFILES[0].gapMs    / 1000)
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
      emit('len', payloadLen)
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
        emit('decoded', payload.length)
        onBytes(payload)
      } else {
        emit('checksum-fail')
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
    alignDone       = false
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
