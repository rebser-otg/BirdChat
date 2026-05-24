import ggwaveFactory from 'ggwave'
import { unpack } from './messageCodec.js'

const VOLUME = 10
const SAMPLE_RATE = 48000

let ggwave = null
let instance = null
let workletNode = null
let micStream = null
let _muteUntil = 0

/**
 * Initialize ggwave WASM. Must be called once before encode/startListening.
 */
export async function init() {
  ggwave = await ggwaveFactory()
  const params = ggwave.getDefaultParameters()
  params.sampleRateInp = SAMPLE_RATE
  params.sampleRateOut = SAMPLE_RATE
  instance = ggwave.init(params)
  _muteUntil = 0
}

/**
 * Encode a packed message string into PCM audio samples.
 * @param {string} text — output of messageCodec.pack()
 * @returns {Float32Array} PCM samples at 48 kHz
 */
export function encode(text) {
  if (!ggwave || instance === null) throw new Error('acousticEngine not initialized')
  const pcm = ggwave.encode(instance, text, ggwave.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FAST, VOLUME)
  // Suppress acoustic loopback: mute decode during transmission + 1s buffer for room reverb
  _muteUntil = Date.now() + (pcm.length / SAMPLE_RATE) * 1000 + 1000
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

  await audioContext.audioWorklet.addModule('/mic-worklet.js')

  micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
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
