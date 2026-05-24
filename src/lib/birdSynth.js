/**
 * birdSynth.js — Thin player for birdCodec PCM output.
 *
 * The PCM from birdCodec.encode() already IS bird chirps — no synthesis overlay
 * needed.  It is played back DRY (no reverb): a reverb tail smears each chirp into
 * the next and degrades the receiver's matched-filter detection, which matters far
 * more than any cosmetic "outdoor" feel.
 */

/**
 * Play birdCodec PCM out the speaker, dry. Fire-and-forget.
 *
 * @param {Float32Array} pcmFloat32 — normalized PCM from birdCodec.encode()
 * @param {AudioContext} audioContext
 */
export function play(pcmFloat32, audioContext) {
  const buf = audioContext.createBuffer(1, pcmFloat32.length, audioContext.sampleRate)
  buf.copyToChannel(pcmFloat32, 0)

  const src = audioContext.createBufferSource()
  src.buffer = buf
  src.connect(audioContext.destination)
  src.start(audioContext.currentTime)

  // BufferSource stops on its own; this just releases the node reference.
  const cleanupMs = (pcmFloat32.length / audioContext.sampleRate + 0.4) * 1000
  setTimeout(() => { try { src.stop() } catch { /* already ended */ } }, cleanupMs)
}
