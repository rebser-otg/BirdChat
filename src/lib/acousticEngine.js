import ggwaveFactory from 'ggwave'
import { unpack } from './messageCodec.js'

const VOLUME = 50
const DEFAULT_SAMPLE_RATE = 48000

let ggwave = null
let instance = null
let workletNode = null
let micStream = null
let _muteUntil = 0
let _sampleRate = DEFAULT_SAMPLE_RATE

/**
 * Initialize ggwave WASM. Must be called once before encode/startListening.
 * Pass the AudioContext's actual sample rate — iOS Safari may give 44100 Hz
 * instead of the requested 48000 Hz, and ggwave must match exactly.
 * @param {number} [sampleRate=48000]
 */
export async function init(sampleRate = DEFAULT_SAMPLE_RATE) {
  ggwave = await ggwaveFactory()
  const params = ggwave.getDefaultParameters()
  params.sampleRateInp = sampleRate
  params.sampleRateOut = sampleRate
  instance = ggwave.init(params)
  _sampleRate = sampleRate
  _muteUntil = 0
}

/**
 * Encode a packed message string into PCM audio samples.
 * @param {string} text — output of messageCodec.pack()
 * @returns {Float32Array} PCM samples at 48 kHz
 */
export function encode(text) {
  if (!ggwave || instance === null) throw new Error('acousticEngine not initialized')
  const raw = ggwave.encode(instance, text, ggwave.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FAST, VOLUME)
  // ggwave returns raw int16 PCM as a byte array (2 bytes per sample).
  // Web Audio API needs normalized Float32 in [-1, 1] — convert here.
  const int16 = new Int16Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength))
  const pcm = Float32Array.from(int16, s => s / 32768.0)
  // Suppress acoustic loopback: mute decode during transmission + 1s buffer for room reverb
  _muteUntil = Date.now() + (pcm.length / _sampleRate) * 1000 + 1000
  return pcm
}

/**
 * Start listening for messages via the microphone.
 * PCM chunks arrive from the AudioWorklet and are decoded on the main thread.
 * @param {AudioContext} audioContext — caller-managed AudioContext
 * @param {(msg: {name: string, text: string}) => void} onMessage
 */
export async function startListening(audioContext, onMessage) {
  if (!ggwave || instance === null) throw new Error('acousticEngine not initialized')

  await audioContext.audioWorklet.addModule(import.meta.env.BASE_URL + 'mic-worklet.js')

  micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
  // iOS Safari suspends the AudioContext when the mic stream starts — resume it.
  if (audioContext.state === 'suspended') await audioContext.resume()
  const source = audioContext.createMediaStreamSource(micStream)

  workletNode = new AudioWorkletNode(audioContext, 'mic-processor')
  workletNode.port.onmessage = (event) => {
    if (event.data.type !== 'pcm') return
    if (Date.now() < _muteUntil) return  // suppress acoustic loopback during transmission
    const result = ggwave.decode(instance, event.data.chunk)
    if (!result || result.length === 0) return
    try {
      const text = new TextDecoder('utf-8').decode(result)
      const msg = unpack(text)
      if (msg) onMessage(msg)
    } catch {
      // malformed bytes — drop silently
    }
  }

  source.connect(workletNode)
}

/**
 * Stop listening and release mic/worklet resources.
 */
export function stopListening() {
  if (workletNode) { workletNode.disconnect(); workletNode = null }
  if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null }
}
