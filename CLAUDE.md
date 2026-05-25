# BirdChat

A mobile-first web app where group chat communication runs exclusively over audio, with messages encoded in bird voices/sounds.

## Project Vision

BirdChat is like a WhatsApp group chat — but instead of text, every message is a bird sound. Users record or type messages that get encoded into synthesized bird vocalizations. Recipients hear bird audio that decodes back to speech/text. The name is a literal play on "Twitter" — birds tweeting to each other.

## Superpowers

This project uses the [Superpowers](https://github.com/claude-plugins-official/superpowers) skill system. If you have superpowers loaded:

- **Always brainstorm before building** — invoke `superpowers:brainstorming` before implementing any feature
- **Always use TDD** — invoke `superpowers:test-driven-development` before writing implementation code  
- **Debug systematically** — invoke `superpowers:systematic-debugging` before proposing fixes
- **Write plans before coding** — invoke `superpowers:writing-plans` for any multi-step task
- **Verify before claiming done** — invoke `superpowers:verification-before-completion` before marking anything complete

## Design Decisions

See **[docs/DESIGN_DECISIONS.md](docs/DESIGN_DECISIONS.md)** for the rationale behind
the acoustic codec — including the dead-ends that cost the most debugging time (the
desync cascade from data-derived frame timing, and the coherent matched filter that
collapsed on small timing errors). **Read it before changing the codec, detection, or
mic/audio setup.** Two lessons in particular:

- Detection is **non-coherent** (energy along each chirp's frequency trajectory) +
  coarse grid alignment. A coherent matched filter is too timing/phase-sensitive for
  real acoustic transmission. Do not "optimize" it back into a phase-exact correlator.
- Channel **simulations must model timing/phase jitter, attenuation, low-pass, and
  noise** — sample-exact PCM hides the bugs that actually break real transmission.

## Tech Stack

- **Svelte 5** + **Vite** SPA, deployed to **GitHub Pages** (push to `main`
  auto-deploys via `.github/workflows/deploy.yml`).
- **PWA** (vite-plugin-pwa, autoUpdate service worker).
- **Vitest** for unit tests.
- Audio: Web Audio API + an **AudioWorklet** (`public/mic-worklet.js`) for mic capture.
- **No backend / no network for messaging** — transmission is purely acoustic
  (device speaker → other device mic), so two devices in the same room "chat" with no
  server. (The original WebSocket group-room idea was dropped in favor of pure audio.)

## Key Concepts

- **Acoustic codec** (`src/lib/birdCodec.js`): text ⇄ synthesized bird-chirp PCM.
  Chirp-FSK with 4 simultaneous frequency bands (OFDM-style), 16 bits/frame.
- **Encode/decode path** (`src/lib/acousticEngine.js`): `init`, `encode`,
  `startListening`, `stopListening` — the stable public API the UI depends on.
- **Message packing** (`src/lib/messageCodec.js`): `{name,text}` ⇄ compact JSON,
  ≤142 UTF-8 bytes.
- **Mobile-first, PWA-ready**: optimized for iOS/Android browsers.
- **On-device diagnostics**: mic level, per-band signal, capture %, decode events,
  and a build-version (git SHA) badge — used to debug real-world reception.

## Development

```bash
npm install
npm run dev      # local dev server
npm test         # run the Vitest suite
npm run build    # production build (also what CI deploys)
```

Push to `main` to deploy to GitHub Pages. Confirm a device is on the latest build via
the git-SHA badge at the bottom of the app (bust PWA cache with a private tab or
`?v=`). Verify codec/audio changes on **real hardware** (two devices in a room), not
just tests — see the diagnostics panel and [docs/DESIGN_DECISIONS.md](docs/DESIGN_DECISIONS.md).
