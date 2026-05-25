# BirdChat — Design Decisions

This document records the significant design decisions behind BirdChat's acoustic
codec, why they were made, and the dead-ends that shaped them. It is meant to save
a future contributor (human or agent) from re-deriving hard-won lessons —
especially the ones that cost the most debugging time.

## 1. Custom chirp codec instead of ggwave

**Decision:** Replace the ggwave WASM modem with a custom "bird chirp" codec
(`src/lib/birdCodec.js`). ggwave was removed entirely (dependency, the
`optimizeDeps.exclude` in `vite.config.js`, all mock-based tests).

**Why:** The product premise is that the *information-carrying signal itself*
should sound like birds. ggwave produces FSK modem tones; layering chirps on top
doesn't change their character. A bespoke codec lets each transmitted symbol be an
actual synthesized bird chirp.

**Trade-off:** We own the modem now (synthesis, detection, framing, timing) — more
code and more failure modes, but full control over the sound and the physics.

## 2. Chirp-FSK with simultaneous bands (OFDM-style)

**Decision:** Each frame plays **4 chirps simultaneously**, one per frequency band;
each chirp encodes a 4-bit symbol (16 chirp types per band) → 16 bits = **2 bytes
per frame**. Symbol bit layout: bits[3:2] = start-frequency index, bit[1] = sweep
magnitude, bit[0] = sweep direction.

**Why:** Parallel bands hit the throughput target without needing very short
symbols, and overlapping multi-band calls sound more bird-like than sequential
single notes.

## 3. Frequency bands live in ~850–3860 Hz

**Decision:** All four data bands sit between ~850 Hz and ~3860 Hz
(see `BANDS` in `birdCodec.js`). The preamble sweeps 450→680 Hz, below all data
bands. Original bands ran up to 7900 Hz.

**Why:** The first real recording (laptop speaker → phone mic → voice recorder)
showed everything above ~1.2 kHz rolled off into noise. We moved bands down into the
range consumer speakers/mics reliably reproduce.

**Caveat / lesson:** We *over-attributed* failures to this frequency rolloff. Later
on-device per-band diagnostics showed all four bands were actually surviving fine —
the real failure was elsewhere (see §8). The compressed band layout is still a
reasonable, conservative choice, but "high bands are dead" turned out to be a red
herring for the main bug.

## 4. Wire format

```
[preamble A] [gap] [preamble B] [gap] [post-preamble gap]
[LEN frame] [DATA frames…] [CHECKSUM frame] [trailing silence]
```

- **Preamble ×2** (450→680 Hz, 200 ms + 100 ms gap each): transmission marker,
  detected by a normalized Goertzel energy ratio at 450 Hz. Two chirps reduce false
  triggers.
- **LEN frame**: 1 byte = payload length.
- **DATA frames**: 2 bytes each (high byte → bands 0+1, low byte → bands 2+3).
- **CHECKSUM frame**: XOR checksum + length echo, both must match.
- **Trailing silence** (one full chirp length): guarantees the decoder always has a
  full detection window for the final checksum frame, so encode→decode is
  self-contained and chunk-boundary-safe.

`messageCodec.js` packs `{name,text}` to compact JSON, capped at 142 UTF-8 bytes
(the codec's payload capacity); `MAX_TEXT_LENGTH = 100` chars.

## 5. Amplitude-independent detection

**Decision:** Normalize every analysis window (RMS for frames, energy-ratio for the
preamble) before detection. No absolute amplitude thresholds.

**Why:** Real recordings arrive ~10× quieter than synthesized PCM. Absolute
thresholds tuned on clean audio reject quiet-but-valid signals. Normalized metrics
are amplitude-independent and decode down to ~100× attenuation in simulation.

## 6. Performance: cached references + strided correlation

**Decision:** Precompute per-symbol detection data once per sample rate and cache
it; sample the correlation/energy sums with a stride (`CORR_STRIDE = 4`, ≈12 kHz
effective, well above the chirps' <4 kHz content).

**Why:** The detector originally re-synthesized all reference chirps on every call —
hundreds of times/second, thousands of `sin`/`exp` each. On an older MacBook this
saturated the main thread, lagged the mic meter by seconds, and starved the decoder
(symptom the user spotted: "bad frames rushing in after the transmission ended, like
scrubbing a dirty cache"). Caching + striding brought a full message decode to ~1%
of real-time.

## 7. Fixed-length frames (no data-derived timing)

**Decision:** Every frame is a single fixed length (`FRAME_PROFILES` is now a
1-element array: 400 ms chirp + 40 ms gap). An earlier version derived each frame's
duration from its own data bits for "natural rhythm."

**Why:** Data-derived timing made framing fragile: if one frame's symbols were
misread, the decoder computed the wrong frame length, advanced its read cursor by the
wrong amount, and **every subsequent frame desynced** — one bad frame destroyed the
whole message. (Symptom: receiver decoded the same "Test" message as lengths 24, 18,
30, 126 on different runs, and usually never reached a checksum.) Fixed length means a
misread frame only corrupts itself; the stream stays aligned and the checksum catches
it.

## 8. Non-coherent detection + grid alignment — THE key fix

**Decision:** Detect symbols by measuring **energy along each candidate chirp's
frequency trajectory** (Goertzel over `NONCOH_K = 16` sub-windows of the frame),
not by correlating against a phase-exact reference waveform. Then **coarsely align**
the frame grid to the preamble by sliding the detection window and locking to the
max-score offset.

**Why (the root cause of nearly all field failures):** The original detector was a
**coherent** matched filter — phase-exact dot product against a reference chirp. It
collapses with even ~2 ms of timing error. But the preamble is only located to within
~30 ms (`ANALYSIS_N`), so in the real world the frame grid almost always sat at an
offset the coherent filter couldn't tolerate → garbage symbols → failed checksum.

**Why simulations missed it for so long:** Early channel sims fed *sample-exact* PCM,
so coherent detection always looked perfect. The bug only appeared once we simulated a
**leading offset**: decode dropped to 0/10 for any offset between ~2 ms and ~28 ms,
and snapped back to 10/10 at exactly 0 or one full scan-step. That experiment pinned
it.

Non-coherent detection is phase-insensitive and tolerant to tens of ms of
misalignment; its score also peaks sharply at true alignment (and, unlike the coherent
score, is **not** inflated by windows containing silence), so it doubles as the
alignment metric. After this change, every leading offset 0–30 ms decoded 10/10 and
moderate realistic channels (offset + low-pass + noise + attenuation, single and
chunked push) decoded 25/25. This is the change that made real phone↔Mac decoding
"rock solid."

**Implication:** The earlier 400 ms chirp lengthening (done to "improve SNR") was
treating the wrong problem. The chirps can likely be shortened substantially now that
timing — not integration time — was the real issue. (Open follow-up; see §11.)

## 9. Microphone capture settings

**Decision:** Request the mic with `echoCancellation: false`,
`noiseSuppression: false`, **`autoGainControl: true`**. If the constrained request is
rejected, fall back to a plain `{ audio: true }` request.

**Why:** Echo cancellation and noise suppression are voice-call DSP that filter/strip
the chirps (noise suppression treats them as background noise) — they must stay off.
Auto-gain is the opposite: it lets a mic use more of its dynamic range, which *helps*
a faint received signal (the weak direction is Mac→phone, where the phone mic captures
faintly). The plain-request fallback exists because some setups reject the constraint
object outright (as Meet/Slack avoid by using simple requests).

**Also:** Playback is **dry** (no reverb) — a reverb tail smears each chirp into the
next and degrades the receiver's detection. Transmitted chirps and the preamble are
normalized to `TX_PEAK = 0.97` (as loud as possible without clipping) to help the
weak direction.

## 10. Audio pipeline robustness

- **Native sample rate:** Do **not** force `AudioContext` to 48000 Hz. Forcing a rate
  can wedge the audio device on some Linux PulseAudio/PipeWire configs so the mic
  can't open. The codec is defined in Hz and works at any sample rate; both ends adapt
  to their own `AudioContext.sampleRate`.
- **Mic starts independently of sending:** A "🎧 Tap to listen" button starts capture
  (browsers need a user gesture); a device no longer has to send a message before it
  can receive.
- **`NotFoundError` is handled gracefully:** "No microphone found — this device can
  still send, but can't receive." (Confirmed real cause once: a machine with a
  dead/absent built-in mic; USB headphones fixed it. Not an app bug.)

## 11. Diagnostics & dev ergonomics

On-device diagnostics were essential to finding the real bugs, since simulations
misled us. The app surfaces (collapsible panel, off by default so chat bubbles show):

- **mic level** meter,
- **per-band signal** strength `[B0 B1 B2 B3]` per decoded frame (revealed the bands
  were fine — overturning the rolloff theory),
- **audio captured %** / dropped-ms (drop detector; confirmed 100% capture, ruling out
  the pipeline),
- **decode events** (preamble / length / frame / decoded / checksum-fail).

A **build version** (git short SHA + UTC build time, injected via Vite `define`) shows
at the bottom of the app, so a device can confirm it's running the latest deploy
(PWA/service-worker caches aggressively — use a private tab or `?v=` to bust).

**Workflow:** every change is committed, pushed to `main` (auto-deploys to GitHub
Pages, ~35 s), and retested on real hardware against the displayed SHA. Channel
simulations must model timing/phase jitter, attenuation, low-pass, and noise — never
just sample-exact PCM, or they will hide timing bugs (see §8).

### Open follow-ups
- **Shorten chirps for speed.** 400 ms was chosen for SNR before we knew timing was
  the real issue. Testing showed 250 ms (~1.5× faster, ~4.8 s for a short message)
  holds reliability at moderate channels; the real link has headroom. Pending
  confirmation that both directions are solid first.
- **Confirm Mac→phone** end-to-end after the auto-gain + louder-transmit changes
  (phone→Mac is already solid).
