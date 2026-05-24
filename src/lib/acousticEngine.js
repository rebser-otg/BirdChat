import { encode as birdEncode, createDecoder } from './birdCodec.js'
import { unpack } from './messageCodec.js'

const DEFAULT_SAMPLE_RATE = 48000

let workletNode = null
let micStream = null
let _muteUntil = 0
let _sampleRate = DEFAULT_SAMPLE_RATE
let _decoder = null

// Capture-health tracking: compare samples actually delivered by the AudioWorklet
// against elapsed wall-clock time.  A ratio < 1 means the audio pipeline is
// dropping samples (audio-thread glitches / overload), which desyncs the decoder.
let _captureStart = 0
let _samplesReceived = 0

/**
 * Initialize the acoustic engine.  Synchronous — no WASM loading required.
 * Call once before encode/startListening, passing the AudioContext sample rate.
 * iOS Safari may give 44100 Hz instead of the requested 48000 Hz.
 * @param {number} [sampleRate=48000]
 */
export function init(sampleRate = DEFAULT_SAMPLE_RATE) {
  _sampleRate = sampleRate
  _muteUntil  = 0
  // Decoder is (re)created in startListening where audioContext.sampleRate
  // is available, which is the most accurate value on all platforms.
}

/**
 * Encode a packed message string into PCM audio samples using the bird chirp codec.
 * @param {string} text — output of messageCodec.pack()
 * @returns {Float32Array} PCM samples (bird chirps)
 */
export function encode(text) {
  const bytes = new TextEncoder().encode(text)
  const pcm   = birdEncode(bytes, _sampleRate)
  // Suppress acoustic loopback: mute decode during transmission + 0.5 s for reverb tail
  _muteUntil = Date.now() + (pcm.length / _sampleRate) * 1000 + 500
  return pcm
}

/**
 * Start listening for messages via the microphone.
 * PCM chunks arrive from the AudioWorklet and are decoded by the birdCodec decoder.
 * @param {AudioContext} audioContext — caller-managed AudioContext
 * @param {(msg: {name: string, text: string}) => void} onMessage
 */
export async function startListening(audioContext, onMessage, onDiag = null) {
  _decoder = createDecoder(
    audioContext.sampleRate,
    (bytes) => {
      try {
        const text = new TextDecoder('utf-8').decode(bytes)
        const msg  = unpack(text)
        if (msg) onMessage(msg)
      } catch {
        // malformed bytes — drop silently
      }
    },
    onDiag ? (evt) => onDiag({ kind: 'event', ...evt }) : null,
  )

  _captureStart = 0
  _samplesReceived = 0

  await audioContext.audioWorklet.addModule(import.meta.env.BASE_URL + 'mic-worklet.js')

  // Echo cancellation and noise suppression must stay OFF — they filter/strip the
  // chirps (noise suppression treats them as background noise).  Auto-gain is the
  // opposite: it lets the mic use more of its dynamic range, which helps a faint
  // received signal (e.g. a phone speaker heard by a laptop mic), so keep it ON.
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: true,
    },
    video: false,
  })
  // iOS Safari suspends the AudioContext when the mic stream starts — resume it.
  if (audioContext.state === 'suspended') await audioContext.resume()
  const source = audioContext.createMediaStreamSource(micStream)

  workletNode = new AudioWorkletNode(audioContext, 'mic-processor')
  workletNode.port.onmessage = (event) => {
    if (event.data.type !== 'pcm') return
    const chunk = event.data.chunk
    if (onDiag) {
      let s = 0
      for (let i = 0; i < chunk.length; i++) s += chunk[i] * chunk[i]
      // Capture health: samples delivered vs wall-clock elapsed. The AudioWorklet
      // runs on the audio clock, so a sustained ratio < 1 means samples are being
      // dropped (glitches/overload) — which would corrupt frame timing.
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now())
      if (_captureStart === 0) _captureStart = now
      _samplesReceived += chunk.length
      const elapsedSec = (now - _captureStart) / 1000
      const expected   = elapsedSec * audioContext.sampleRate
      const captureRatio = expected > audioContext.sampleRate * 0.3 ? _samplesReceived / expected : 1
      const droppedMs    = Math.max(0, Math.round((expected - _samplesReceived) / audioContext.sampleRate * 1000))
      onDiag({ kind: 'level', rms: Math.sqrt(s / chunk.length), captureRatio, droppedMs })
    }
    if (Date.now() < _muteUntil) return  // suppress acoustic loopback during transmission
    _decoder.push(chunk)
  }

  source.connect(workletNode)
}

/**
 * Stop listening and release mic/worklet resources.
 */
export function stopListening() {
  if (_decoder)     { _decoder.reset(); _decoder = null }
  if (workletNode)  { workletNode.disconnect(); workletNode = null }
  if (micStream)    { micStream.getTracks().forEach(t => t.stop()); micStream = null }
}
