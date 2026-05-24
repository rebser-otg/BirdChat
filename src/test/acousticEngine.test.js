import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- Web API mocks ---
const mockPort = { onmessage: null, postMessage: vi.fn() }
const mockWorkletNode = { port: mockPort, disconnect: vi.fn() }
const mockSource = { connect: vi.fn() }
const mockTrack = { stop: vi.fn() }
const mockStream = { getTracks: vi.fn(() => [mockTrack]) }
const mockAudioContext = {
  sampleRate: 48000,
  audioWorklet: { addModule: vi.fn(async () => {}) },
  createMediaStreamSource: vi.fn(() => mockSource),
}
global.AudioWorkletNode = vi.fn(function () { return mockWorkletNode })
global.navigator = {
  mediaDevices: { getUserMedia: vi.fn(async () => mockStream) },
}

import { init, encode, startListening, stopListening } from '../lib/acousticEngine.js'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('init', () => {
  it('initializes synchronously without errors', () => {
    expect(() => init()).not.toThrow()
  })

  it('can be awaited (returns undefined)', async () => {
    await expect(Promise.resolve(init())).resolves.toBeUndefined()
  })
})

describe('encode', () => {
  it('returns a Float32Array', () => {
    init()
    expect(encode('{"n":"Robin","t":"hi"}')).toBeInstanceOf(Float32Array)
  })

  it('returns a non-trivial Float32Array (birdCodec produces real audio)', () => {
    init()
    // birdCodec generates preamble + frames — even a short message is thousands of samples
    expect(encode('hi').length).toBeGreaterThan(10000)
  })
})

describe('startListening', () => {
  it('loads the mic worklet module', async () => {
    init()
    await startListening(mockAudioContext, vi.fn())
    expect(mockAudioContext.audioWorklet.addModule).toHaveBeenCalledWith('/mic-worklet.js')
  })

  it('requests microphone access with audio DSP disabled', async () => {
    init()
    await startListening(mockAudioContext, vi.fn())
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    })
  })

  it('calls onMessage when PCM chunks decode to a valid message', async () => {
    // Generate encoded PCM (sets _muteUntil), then reinit to clear the mute window
    // so the worklet handler actually forwards the chunks to the decoder.
    init()
    const payload = '{"n":"Robin","t":"hello"}'
    const pcm = encode(payload)
    init()  // reset _muteUntil = 0

    const onMessage = vi.fn()
    await startListening(mockAudioContext, onMessage)

    // Simulate the AudioWorklet posting PCM chunks
    for (let i = 0; i < pcm.length; i += 1024) {
      const chunk = pcm.slice(i, Math.min(i + 1024, pcm.length))
      mockWorkletNode.port.onmessage({ data: { type: 'pcm', chunk } })
    }

    expect(onMessage).toHaveBeenCalledWith({ name: 'Robin', text: 'hello' })
  })

  it('silently drops garbage PCM without crashing or calling onMessage', async () => {
    init()
    const onMessage = vi.fn()
    await startListening(mockAudioContext, onMessage)

    const noise = new Float32Array(48000)  // 1 second of white noise
    for (let i = 0; i < noise.length; i++) noise[i] = Math.random() * 2 - 1
    for (let i = 0; i < noise.length; i += 1024) {
      const chunk = noise.slice(i, Math.min(i + 1024, noise.length))
      expect(() => mockWorkletNode.port.onmessage({ data: { type: 'pcm', chunk } })).not.toThrow()
    }

    expect(onMessage).not.toHaveBeenCalled()
  })

  it('suppresses decoding during the loopback window after encode', async () => {
    init()
    encode('{"n":"Test","t":"hi"}')  // sets _muteUntil ≈ now + ~1s + 500ms

    const onMessage = vi.fn()
    await startListening(mockAudioContext, onMessage)

    // Even if the decoded audio would be valid, it should be suppressed
    const chunk = new Float32Array(1024)
    mockWorkletNode.port.onmessage({ data: { type: 'pcm', chunk } })
    expect(onMessage).not.toHaveBeenCalled()
  })
})

describe('stopListening', () => {
  it('disconnects the worklet node', async () => {
    init()
    await startListening(mockAudioContext, vi.fn())
    stopListening()
    expect(mockWorkletNode.disconnect).toHaveBeenCalled()
  })

  it('stops all mic tracks', async () => {
    init()
    await startListening(mockAudioContext, vi.fn())
    stopListening()
    expect(mockTrack.stop).toHaveBeenCalled()
  })
})
