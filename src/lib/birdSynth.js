/**
 * SYNTH_PRESET controls the bird-like character of the audio.
 * All parameters are safe to tune without breaking ggwave decoding.
 *
 * DO NOT add pitch shift — ggwave uses specific carrier frequencies.
 * Changing frequency = broken decoding on receiving devices.
 */
export const SYNTH_PRESET = {
  // Tremolo: amplitude modulation at tremoloRate Hz, depth 0–1
  tremoloRate: 12,   // Hz — fast flutter like a wren's call
  tremoloDepth: 0.4, // 0 = no tremolo, 1 = fully on/off

  // Reverb: simulates outdoor acoustic space
  reverbDecay: 0.25, // seconds — short = tight, long = echoy

  // EQ: high-shelf boost above shelfFreq
  shelfFreq: 3000,   // Hz — boost above this frequency
  shelfGain: 6,      // dB — brightens the sound
}

/**
 * Play ggwave PCM through bird-like audio effects.
 * Fire-and-forget — does not wait for playback to complete.
 *
 * @param {Float32Array} pcmArray — raw PCM from acousticEngine.encode()
 * @param {AudioContext} audioContext
 * @param {typeof SYNTH_PRESET} [preset]
 */
export function play(pcmArray, audioContext, preset = SYNTH_PRESET) {
  // Build AudioBuffer from raw PCM
  const buffer = audioContext.createBuffer(1, pcmArray.length, audioContext.sampleRate)
  buffer.copyToChannel(pcmArray, 0)

  const source = audioContext.createBufferSource()
  source.buffer = buffer

  // === Tremolo (amplitude modulation) ===
  const tremoloLFO = audioContext.createOscillator()
  const tremoloGain = audioContext.createGain()
  const masterGain = audioContext.createGain()

  tremoloLFO.frequency.value = preset.tremoloRate
  tremoloLFO.type = 'sine'
  tremoloGain.gain.value = preset.tremoloDepth / 2  // LFO amplitude
  masterGain.gain.value = 1 - preset.tremoloDepth / 2  // offset so min gain > 0

  tremoloLFO.connect(tremoloGain)
  tremoloGain.connect(masterGain.gain)  // LFO modulates master gain

  // === High-shelf EQ ===
  const shelf = audioContext.createBiquadFilter()
  shelf.type = 'highshelf'
  shelf.frequency.value = preset.shelfFreq
  shelf.gain.value = preset.shelfGain

  // === Reverb ===
  const convolver = audioContext.createConvolver()
  convolver.buffer = _generateImpulse(audioContext, preset.reverbDecay)

  // === Connect graph ===
  // source → masterGain → shelf → convolver → destination
  source.connect(masterGain)
  masterGain.connect(shelf)
  shelf.connect(convolver)
  convolver.connect(audioContext.destination)

  // Start — fire and forget
  tremoloLFO.start()
  source.start()

  // Clean up after playback
  const durationMs = (buffer.duration + preset.reverbDecay + 0.1) * 1000
  setTimeout(() => {
    try { tremoloLFO.stop(); source.stop() } catch { /* already stopped */ }
  }, durationMs)
}

/**
 * Generate a simple procedural impulse response for reverb.
 * No sample files required.
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
