/**
 * birdSynth.js — Thin player for birdCodec PCM output.
 *
 * The PCM from birdCodec.encode() already IS bird chirps — no synthesis overlay needed.
 * This module routes the PCM through a short reverb to give it a natural outdoorsy feel,
 * then fires and forgets.
 */

/**
 * Play birdCodec PCM through a light reverb. Fire-and-forget.
 *
 * @param {Float32Array} pcmFloat32 — normalized PCM from birdCodec.encode()
 * @param {AudioContext} audioContext
 */
export function play(pcmFloat32, audioContext) {
  const buf = audioContext.createBuffer(1, pcmFloat32.length, audioContext.sampleRate)
  buf.copyToChannel(pcmFloat32, 0)

  const src = audioContext.createBufferSource()
  src.buffer = buf

  // Light reverb: 150 ms decay gives a natural outdoor feel
  const reverb = audioContext.createConvolver()
  reverb.buffer = _generateImpulse(audioContext, 0.15)
  reverb.connect(audioContext.destination)

  src.connect(reverb)
  src.start(audioContext.currentTime)

  // Optional cleanup — BufferSource stops on its own, but this releases the GainNode ref
  const cleanupMs = (pcmFloat32.length / audioContext.sampleRate + 0.4) * 1000
  setTimeout(() => { try { src.stop() } catch { /* already ended */ } }, cleanupMs)
}

/**
 * Generate a simple procedural impulse response for reverb.
 */
function _generateImpulse(audioContext, decaySeconds) {
  const length  = Math.floor(audioContext.sampleRate * decaySeconds)
  const impulse = audioContext.createBuffer(2, length, audioContext.sampleRate)
  for (let ch = 0; ch < 2; ch++) {
    const data = impulse.getChannelData(ch)
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 2)
    }
  }
  return impulse
}
