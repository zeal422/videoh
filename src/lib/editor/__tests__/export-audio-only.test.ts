import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { audioChunkRanges, exportTimeline, webCodecsSupported } from '../export/mp4'
import { createClip, createMediaAsset, createTrack } from '../factories'
import type { Clip, Doc, MediaAsset } from '../types'

/**
 * Audio-only export proof. The WAV muxer is the real mediabunny one; only Web
 * Audio is faked. WAV uses PCM, so these tests run with no VideoEncoder and no
 * AudioEncoder (the browser case this release adds).
 */
class FakeAudioBuffer {
  readonly duration: number
  readonly length: number
  readonly numberOfChannels: number
  readonly sampleRate: number
  private readonly channels: Float32Array[]

  constructor(numberOfChannels = 2, length = 48_000, sampleRate = 48_000) {
    this.numberOfChannels = numberOfChannels
    this.length = length
    this.sampleRate = sampleRate
    this.duration = length / sampleRate
    this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length))
  }

  getChannelData(channel: number): Float32Array {
    return this.channels[channel]
  }

  copyFromChannel(destination: Float32Array, channel: number, start = 0): void {
    destination.set(this.channels[channel].subarray(start, start + destination.length))
  }
}

class FakeParam {
  value = 1
  setValueAtTime(): this {
    return this
  }
  linearRampToValueAtTime(): this {
    return this
  }
  setTargetAtTime(): this {
    return this
  }
  cancelScheduledValues(): this {
    return this
  }
}

class FakeOfflineContext {
  destination = { connect: () => undefined }
  sampleRate = 48_000
  currentTime = 0

  createGain() {
    return { gain: new FakeParam(), connect: () => undefined }
  }
  createStereoPanner() {
    return { pan: new FakeParam(), connect: () => undefined }
  }
  createBiquadFilter() {
    return {
      type: '',
      frequency: new FakeParam(),
      Q: new FakeParam(),
      gain: new FakeParam(),
      connect: () => undefined,
    }
  }
  createDynamicsCompressor() {
    return {
      threshold: new FakeParam(),
      knee: new FakeParam(),
      ratio: new FakeParam(),
      attack: new FakeParam(),
      release: new FakeParam(),
      connect: () => undefined,
    }
  }
  createBufferSource() {
    return {
      buffer: null,
      playbackRate: new FakeParam(),
      connect: () => undefined,
      start: () => undefined,
    }
  }
  decodeAudioData(): Promise<FakeAudioBuffer> {
    return Promise.resolve(new FakeAudioBuffer())
  }
  startRendering(): Promise<FakeAudioBuffer> {
    return Promise.resolve(new FakeAudioBuffer())
  }
}

function audioDoc(overrides: Partial<Clip> = {}): Doc {
  const file = new File([new Uint8Array([1, 2, 3])], 'voice.wav', { type: 'audio/wav' })
  const media: MediaAsset = createMediaAsset({
    id: 'ma',
    name: 'voice.wav',
    kind: 'audio',
    duration: 1,
    url: 'blob:voice',
    file,
  })
  const clip = createClip({
    id: 'ca',
    mediaId: 'ma',
    audioOnly: true,
    start: 0,
    duration: 1,
    ...overrides,
  })
  return {
    project: {
      id: 'p',
      name: 'n',
      width: 1920,
      height: 1080,
      fps: 30,
      tracks: [createTrack('audio', 1, { id: 't1', clips: [clip] })],
    },
    media: [media],
  }
}

function sink() {
  const calls: string[] = []
  const chunks: { data: Uint8Array; position: number }[] = []
  return {
    calls,
    chunks,
    write: async (chunk: { data: Uint8Array; position: number }) => {
      calls.push('write')
      chunks.push({ data: new Uint8Array(chunk.data), position: chunk.position })
    },
    close: async () => {
      calls.push('close')
    },
    abort: async () => {
      calls.push('abort')
    },
  }
}

const globalScope = globalThis as { AudioBuffer?: unknown }
let previousAudioBuffer: unknown

beforeEach(() => {
  previousAudioBuffer = globalScope.AudioBuffer
  globalScope.AudioBuffer = FakeAudioBuffer
  vi.stubGlobal('window', {})
  vi.stubGlobal('OfflineAudioContext', FakeOfflineContext)
})

afterEach(() => {
  vi.unstubAllGlobals()
  if (previousAudioBuffer === undefined) delete globalScope.AudioBuffer
  else globalScope.AudioBuffer = previousAudioBuffer
})

describe('audio-only export (0.21.0)', () => {
  it('writes a valid WAV blob with no VideoEncoder or AudioEncoder available', async () => {
    expect(webCodecsSupported()).toBe(false)
    expect('AudioEncoder' in window).toBe(false)
    const result = await exportTimeline(audioDoc(), { container: 'wav' })
    expect(result.kind).toBe('blob')
    if (result.kind !== 'blob') throw new Error('expected a blob result')
    expect(result.mimeType).toBe('audio/wav')
    expect(result.duration).toBe(1)
    const bytes = new Uint8Array(await result.blob.arrayBuffer())
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('RIFF')
    expect(String.fromCharCode(...bytes.slice(8, 12))).toBe('WAVE')
    const view = new DataView(bytes.buffer)
    expect(view.getUint32(24, true)).toBe(48_000)
    expect(view.getUint32(40, true)).toBe(bytes.length - 44)
  })

  it('backfills a streamed WAV header through the file sink', async () => {
    const fileSink = sink()
    const result = await exportTimeline(audioDoc(), {
      container: 'wav',
      fileStream: fileSink,
      fileName: 'voice.wav',
    })
    expect(result.kind).toBe('file')
    if (result.kind !== 'file') throw new Error('expected a file result')
    expect(result.fileName).toBe('voice.wav')
    expect(result.mimeType).toBe('audio/wav')
    expect(fileSink.calls.filter((call) => call === 'write').length).toBeGreaterThan(0)
    expect(fileSink.calls.at(-1)).toBe('close')

    const size = Math.max(...fileSink.chunks.map((chunk) => chunk.position + chunk.data.length))
    const bytes = new Uint8Array(size)
    for (const chunk of fileSink.chunks) bytes.set(chunk.data, chunk.position)
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('RIFF')
    expect(new DataView(bytes.buffer).getUint32(40, true)).toBe(bytes.length - 44)
  })

  it('refuses audio-only export when an audible file is offline', async () => {
    const fileSink = sink()
    const withOffline = audioDoc()
    const offline = createMediaAsset({
      id: 'mb',
      kind: 'audio',
      name: 'missing.mp3',
      duration: 1,
      missing: true,
      url: '',
    })
    withOffline.media.push(offline)
    withOffline.project.tracks[0].clips.push(
      createClip({ id: 'cb', mediaId: 'mb', audioOnly: true, start: 0, duration: 1 }),
    )
    await expect(
      exportTimeline(withOffline, { container: 'wav', fileStream: fileSink }),
    ).rejects.toThrow(/missing\.mp3/)
    expect(fileSink.calls).toEqual(['abort'])
  })

  it('refuses a silent timeline and aborts the sink without writing', async () => {
    const fileSink = sink()
    await expect(
      exportTimeline(audioDoc({ muted: true }), { container: 'wav', fileStream: fileSink }),
    ).rejects.toThrow(/no audible audio/i)
    expect(fileSink.calls).toEqual(['abort'])
  })

  it('refuses M4A when the browser has no AAC encoder', async () => {
    vi.stubGlobal('window', {
      AudioEncoder: class {
        static isConfigSupported = async () => ({ supported: false })
      },
    })
    const fileSink = sink()
    await expect(
      exportTimeline(audioDoc(), { container: 'm4a', fileStream: fileSink }),
    ).rejects.toThrow(/M4A export needs an AAC encoder/)
    expect(fileSink.calls).toEqual(['abort'])
  })

  it('honors cancellation before rendering and aborts the sink', async () => {
    const fileSink = sink()
    await expect(
      exportTimeline(audioDoc(), { container: 'wav', fileStream: fileSink }, { cancelled: true }),
    ).rejects.toThrow('Export cancelled')
    expect(fileSink.calls).toEqual(['abort'])
  })
})

describe('audio chunking for interleaved video export', () => {
  it('splits the mix into one-second sample ranges with a short tail', () => {
    expect(audioChunkRanges(96_100, 48_000)).toEqual([
      { start: 0, end: 48_000 },
      { start: 48_000, end: 96_000 },
      { start: 96_000, end: 96_100 },
    ])
  })

  it('handles an empty mix without producing a range', () => {
    expect(audioChunkRanges(0, 48_000)).toEqual([])
  })
})
