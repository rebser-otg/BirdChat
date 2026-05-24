import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- ggwave mock (must be before the import of the module under test) ---
const mockInstance = 1
const mockProtocolId = { GGWAVE_PROTOCOL_AUDIBLE_FAST: 2 }
const mockGgwave = {
  getDefaultParameters: vi.fn(() => ({ sampleRateInp: 0, sampleRateOut: 0 })),
  init: vi.fn(() => mockInstance),
  encode: vi.fn(() => new Float32Array([0.1, 0.2, 0.3])),
  decode: vi.fn(() => null),
  ProtocolId: mockProtocolId,
}
vi.mock('ggwave', () => ({ default: vi.fn(async () => mockGgwave) }))

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
  mediaDevices: { getUserMedia: vi.fn(async () => mockStream) }
}

import { init, encode, startListening, stopListening } from '../lib/acousticEngine.js'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('init', () => {
  it('initializes ggwave with 48000 sample rate', async () => {
    await init()
    expect(mockGgwave.getDefaultParameters).toHaveBeenCalled()
    expect(mockGgwave.init).toHaveBeenCalledWith(
      expect.objectContaining({ sampleRateInp: 48000, sampleRateOut: 48000 })
    )
  })
})

describe('encode', () => {
  it('returns a Float32Array', async () => {
    await init()
    const result = encode('{"n":"Robin","t":"hi"}')
    expect(result).toBeInstanceOf(Float32Array)
  })

  it('calls ggwave.encode with AUDIBLE_FAST protocol', async () => {
    await init()
    encode('test')
    expect(mockGgwave.encode).toHaveBeenCalledWith(
      mockInstance,
      'test',
      mockProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FAST,
      10
    )
  })
})

describe('startListening', () => {
  it('loads the mic worklet module', async () => {
    await init()
    await startListening(mockAudioContext, vi.fn())
    expect(mockAudioContext.audioWorklet.addModule).toHaveBeenCalledWith('/mic-worklet.js')
  })

  it('requests microphone access', async () => {
    await init()
    await startListening(mockAudioContext, vi.fn())
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true, video: false })
  })

  it('calls onMessage when ggwave decodes a valid packet', async () => {
    await init()
    const encoded = new TextEncoder().encode('{"n":"Robin","t":"hello"}')
    mockGgwave.decode.mockReturnValueOnce(encoded)

    const onMessage = vi.fn()
    await startListening(mockAudioContext, onMessage)

    // Simulate AudioWorklet posting a PCM chunk
    const chunk = new Float32Array(1024)
    mockWorkletNode.port.onmessage({ data: { type: 'pcm', chunk } })

    expect(onMessage).toHaveBeenCalledWith({ name: 'Robin', text: 'hello' })
  })

  it('silently drops garbage decode results', async () => {
    await init()
    mockGgwave.decode.mockReturnValueOnce(new TextEncoder().encode('not json at all!!!'))

    const onMessage = vi.fn()
    await startListening(mockAudioContext, onMessage)

    const chunk = new Float32Array(1024)
    mockWorkletNode.port.onmessage({ data: { type: 'pcm', chunk } })

    expect(onMessage).not.toHaveBeenCalled()
  })

  it('suppresses decoding during the loopback window after encode', async () => {
    await init()
    // encode() sets _muteUntil; the decode handler should be suppressed while within the window
    encode('{"n":"Test","t":"hi"}')  // sets _muteUntil = now + ~1001ms
    const encoded = new TextEncoder().encode('{"n":"Robin","t":"hello"}')
    mockGgwave.decode.mockReturnValueOnce(encoded)

    const onMessage = vi.fn()
    await startListening(mockAudioContext, onMessage)
    const chunk = new Float32Array(1024)
    mockWorkletNode.port.onmessage({ data: { type: 'pcm', chunk } })
    expect(onMessage).not.toHaveBeenCalled()  // suppressed within mute window
  })
})

describe('stopListening', () => {
  it('disconnects the worklet node', async () => {
    await init()
    await startListening(mockAudioContext, vi.fn())
    stopListening()
    expect(mockWorkletNode.disconnect).toHaveBeenCalled()
  })

  it('stops all mic tracks', async () => {
    await init()
    await startListening(mockAudioContext, vi.fn())
    stopListening()
    expect(mockTrack.stop).toHaveBeenCalled()
  })
})
