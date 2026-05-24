# BirdChat — Design Spec

**Date:** 2026-05-24  
**Status:** Approved

---

## What We're Building

A mobile-first PWA where group communication runs exclusively over acoustic air transmission. Users type text → it gets encoded into bird-sounding audio → plays through the speaker → nearby phones with the app open hear it through their microphone → decode back to a text chat bubble. No server, no internet, no accounts. Fully ephemeral and local.

The concept is a literal "Twitter": birds tweeting to each other in a room.

---

## Architecture

Three clean, decoupled layers:

```
┌─────────────────────────────────────┐
│           UI Layer (Svelte)         │  Chat bubbles, input, bird name
├─────────────────────────────────────┤
│       Acoustic Engine (JS)          │  Wraps ggwave WASM — encode/decode
├─────────────────────────────────────┤
│    Bird Synthesis Layer (Web Audio) │  Makes ggwave tones sound like chirps
└─────────────────────────────────────┘
         ↑ mic input / ↓ speaker out
```

- **UI Layer** calls `send(name, text)` and listens for `onMessage({name, text})`. Knows nothing about audio.
- **Acoustic Engine** is the only module that touches ggwave. Exposes `encode(bytes)→PCM`, `startListening(cb)`, `stopListening()`.
- **Bird Synthesis Layer** is a pure audio transform — applies to the send path only. Decoder reads raw PCM before any bird processing. Swapping the bird sound = changing one module.

---

## Stack

| Concern | Choice | Reason |
|---------|--------|--------|
| Framework | Vite + Svelte 5 | Lightweight, no router/state lib needed |
| Acoustic codec | ggwave-web (WASM) | Battle-tested data-over-sound, audible protocols, error correction |
| Audio processing | Web Audio API | Bird synthesis, AudioWorklet mic processing |
| PWA | vite-plugin-pwa | Service worker, manifest, offline |

---

## Files

| File | Responsibility |
|------|----------------|
| `src/lib/acousticEngine.js` | Init ggwave WASM, `encode(bytes)→PCM`, `startListening(onMessage)`, `stopListening()` |
| `src/lib/birdSynth.js` | PCM AudioBuffer in → chirpy AudioBuffer out |
| `src/lib/messageCodec.js` | `pack({name, text})→Uint8Array`, `unpack(Uint8Array)→{name, text}` |
| `src/lib/chatStore.js` | Svelte store — `{name, text, ts, mine}[]` |
| `src/lib/micWorklet.js` | AudioWorklet processor — collects PCM, postMessages to main thread |
| `src/App.svelte` | Input form, scrollable bubble list, wires everything together |
| `src/app.css` | Mobile-first styles, dark green bird theme |

---

## Message Format

Compact JSON, max ~80 chars of text (ggwave `AUDIBLE_FAST` caps at ~140 bytes payload):

```json
{"n":"Robin","t":"hello world"}
```

- `n` — sender name, max 16 chars, silently truncated
- `t` — message text, remaining payload space after name overhead
- Failed `unpack()` → silently dropped. Ambient noise produces garbage bytes constantly — this is expected.

---

## Data Flow

**Send:**
```
user taps "Tweet"
  → messageCodec.pack({name, text})        → Uint8Array
  → acousticEngine.encode(bytes)            → Float32Array PCM
  → birdSynth.transform(pcmBuffer)          → chirpy AudioBuffer
  → Web Audio plays to speaker
  → chatStore.push({...msg, mine: true})    → bubble appears (optimistic)
```

**Receive:**
```
mic stream → AudioWorklet (micWorklet.js)
  → postMessage(Float32Array chunk) → main thread
  → acousticEngine feeds chunk to ggwave.decode()
  → on success: bytes → messageCodec.unpack()
  → chatStore.push({...msg, mine: false})   → bubble appears
```

> **Note:** AudioWorklets can't call ggwave directly (separate audio rendering thread). The worklet collects PCM and postMessages back to the main thread where ggwave decodes. Slight latency, correct architecture.

---

## Bird Synthesis

Four Web Audio transforms in sequence on the send path only:

```
raw ggwave PCM
  → [1] Playback rate 1.6×           pitch up ~8 semitones (bird range)
  → [2] Chirp envelope (GainNode)    sharp attack 8ms, decay 80ms per tone burst
  → [3] Vibrato (LFO → detune)       ±15 cents at 12 Hz — natural warble
  → [4] Reverb (ConvolverNode)       small room IR, procedurally generated
  → speaker
```

All parameters live in a `SYNTH_PRESET` object exported from `birdSynth.js`. Changing bird character = changing the preset. The decoder always reads raw pre-synthesis PCM so the synthesis layer cannot corrupt decoding.

---

## ggwave Protocol

Use `GGWAVE_PROTOCOL_AUDIBLE_FAST` — audible frequency range (~1–16 kHz), ~3 seconds per message. Chosen over ultrasound variants because the audible chirps are the whole aesthetic.

---

## PWA

- `vite-plugin-pwa` — manifest + service worker auto-generated
- Theme color `#3d7a3d`, `display: standalone`
- Microphone permission requested on first "Tweet" tap, not on load
- Fully offline after first load (WASM bundled, no CDN calls)

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Mic permission denied | Persistent error banner; send still works |
| Message too long | Inline warning; send blocked until within limit |
| ggwave decode garbage | Silently drop |
| ggwave WASM load failure | Blocking error with reload CTA |

---

## Testing Strategy

- **Unit:** messageCodec roundtrip, name truncation, malformed input; chatStore push/ordering
- **Integration:** acousticEngine encode → decode loopback (inject encoded PCM back into decoder in test)
- **Manual:** Bird synthesis tuning (does it sound like a bird?); verify decoder survives synthesis
- **Device test:** Two phones in same room — Tweet from one, bubble on other
- **PWA test:** Install to home screen iOS + Android; offline load

---

## Non-Goals

- No server, no user accounts, no message history
- No text displayed in the chat stream while audio is playing (audio IS the message)
- No support for sending files, images, or reactions
- No push notifications (ephemeral by design)
