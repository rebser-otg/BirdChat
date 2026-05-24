/**
 * SYNTH_PRESET — tune these to change the bird character.
 *
 * Strategy: the ggwave signal plays at high gain (dataVolume) so the
 * receiving device can always decode it. Short synthetic chirps (oscillators
 * with exponential frequency sweeps) play simultaneously at lower gain to
 * give the bird aesthetic. Together they sound like a chattery wren rather
 * than a raw modem.
 *
 * DO NOT pitch-shift the data layer — ggwave uses specific carrier
 * frequencies; shifting them breaks decoding on receiving devices.
 */
export const SYNTH_PRESET = {
  // Bird chirp layer
  chirpRate:     6,      // chirps per second during transmission
  chirpFreqLo:   3200,   // Hz — lowest sweep start frequency
  chirpFreqHi:   7500,   // Hz — highest frequency reached in a sweep
  chirpDuration: 0.08,   // seconds per chirp (short = staccato)
  chirpJitter:   0.05,   // seconds of random timing scatter per chirp
  chirpVolume:   0.28,   // 0–1 — keep below dataVolume for reliable decoding

  // ggwave data layer
  dataVolume:    0.88,   // 0–1 — near-full for reliable acoustic decode

  // Reverb (applied to both layers)
  reverbDecay:   0.15,   // seconds — short = outdoors, long = room/cave
}

/**
 * Play ggwave PCM with a synthetic bird chirp layer on top.
 * Fire-and-forget — does not wait for playback to complete.
 *
 * @param {Float32Array} pcmFloat32 — normalized PCM from acousticEngine.encode()
 * @param {AudioContext} audioContext
 * @param {typeof SYNTH_PRESET} [preset]
 */
export function play(pcmFloat32, audioContext, preset = SYNTH_PRESET) {
  const now = audioContext.currentTime
  const duration = pcmFloat32.length / audioContext.sampleRate

  // Shared reverb bus
  const reverb = audioContext.createConvolver()
  reverb.buffer = _generateImpulse(audioContext, preset.reverbDecay)
  reverb.connect(audioContext.destination)

  // ggwave data layer — no tremolo (amplitude modulation degrades SNR)
  const dataBuffer = audioContext.createBuffer(1, pcmFloat32.length, audioContext.sampleRate)
  dataBuffer.copyToChannel(pcmFloat32, 0)
  const dataSrc = audioContext.createBufferSource()
  dataSrc.buffer = dataBuffer
  const dataGain = audioContext.createGain()
  dataGain.gain.value = preset.dataVolume
  dataSrc.connect(dataGain)
  dataGain.connect(reverb)
  dataSrc.start(now)

  // Bird chirp layer — spread evenly across the transmission with jitter
  const numChirps = Math.max(2, Math.round(duration * preset.chirpRate))
  for (let i = 0; i < numChirps; i++) {
    const t = now + (i / numChirps) * duration + (Math.random() - 0.5) * preset.chirpJitter
    _playChirp(audioContext, Math.max(now, t), preset, reverb)
  }

  // Clean up source node after audio ends
  const cleanupMs = (duration + preset.reverbDecay + 0.3) * 1000
  setTimeout(() => { try { dataSrc.stop() } catch { /* already ended */ } }, cleanupMs)
}

/**
 * Play one synthetic bird chirp: a short oscillator burst with an
 * exponential frequency sweep and sharp attack/decay envelope.
 */
function _playChirp(audioContext, startTime, preset, destination) {
  const osc = audioContext.createOscillator()
  const env = audioContext.createGain()

  // Starting frequency in the lower half of the range
  const spread = preset.chirpFreqHi - preset.chirpFreqLo
  const f0 = preset.chirpFreqLo + Math.random() * spread * 0.45

  // 70% upward sweeps (like a wren or robin), 30% downward
  const sweepUp = Math.random() > 0.3
  const f1 = sweepUp
    ? Math.min(preset.chirpFreqHi, f0 * (1.5 + Math.random() * 0.8))
    : Math.max(200, f0 * (0.45 + Math.random() * 0.25))

  const chirpDur = preset.chirpDuration * (0.6 + Math.random() * 0.8)

  osc.type = 'sine'
  osc.frequency.setValueAtTime(f0, startTime)
  osc.frequency.exponentialRampToValueAtTime(Math.max(50, f1), startTime + chirpDur)

  // Sharp attack (6 ms) → fast exponential decay
  env.gain.setValueAtTime(0.0001, startTime)
  env.gain.linearRampToValueAtTime(preset.chirpVolume, startTime + 0.006)
  env.gain.exponentialRampToValueAtTime(0.0001, startTime + chirpDur)

  osc.connect(env)
  env.connect(destination)
  osc.start(startTime)
  osc.stop(startTime + chirpDur + 0.02)
}

/**
 * Generate a simple procedural impulse response for reverb.
 */
function _generateImpulse(audioContext, decaySeconds) {
  const length = Math.floor(audioContext.sampleRate * decaySeconds)
  const impulse = audioContext.createBuffer(2, length, audioContext.sampleRate)
  for (let ch = 0; ch < 2; ch++) {
    const data = impulse.getChannelData(ch)
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 2)
    }
  }
  return impulse
}
