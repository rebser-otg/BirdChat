/**
 * AudioWorklet processor for BirdChat.
 * Collects mic PCM into 1024-sample chunks and posts them to the main thread.
 * Runs in the audio rendering thread — no DOM, no imports, no ES modules.
 */
class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this._buffer = []
    this._chunkSize = 1024
  }

  process(inputs) {
    const input = inputs[0]
    if (!input || !input[0]) return true

    const channel = input[0] // Float32Array of current frame (128 samples)
    for (let i = 0; i < channel.length; i++) {
      this._buffer.push(channel[i])
    }

    while (this._buffer.length >= this._chunkSize) {
      const chunk = new Float32Array(this._buffer.splice(0, this._chunkSize))
      // Transfer the buffer to avoid copying — chunk.buffer is now owned by main thread
      this.port.postMessage({ type: 'pcm', chunk }, [chunk.buffer])
    }

    return true // keep processor alive
  }
}

registerProcessor('mic-processor', MicProcessor)
