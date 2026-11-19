// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const recorderMock = vi.hoisted(() => ({ readRecordingDuration: vi.fn() }))
vi.mock('../media/recorder', () => recorderMock)

import { importFile, computePeaks } from '../media/probe'

/**
 * A media element stand-in. `src` announces metadata on the next microtask, and
 * `currentTime` announces the seek the probe waits for, so the real
 * `waitForEvent` / `seekTo` helpers run unchanged.
 */
class FakeMediaElement {
  duration = Number.POSITIVE_INFINITY
  videoWidth = 0
  videoHeight = 0
  preload = ''
  muted = false
  private source = ''
  private time = 0
  private listeners = new Map<string, Set<() => void>>()

  get src(): string {
    return this.source
  }

  set src(value: string) {
    this.source = value
    if (value) queueMicrotask(() => this.emit('loadedmetadata'))
  }

  get currentTime(): number {
    return this.time
  }

  set currentTime(value: number) {
    this.time = value
    queueMicrotask(() => this.emit('seeked'))
  }

  addEventListener(event: string, listener: () => void): void {
    const set = this.listeners.get(event) ?? new Set()
    set.add(listener)
    this.listeners.set(event, set)
  }

  removeEventListener(event: string, listener: () => void): void {
    this.listeners.get(event)?.delete(listener)
  }

  load(): void {}

  emit(event: string): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener()
  }
}

let element: FakeMediaElement
let originalCreateElement: typeof document.createElement
let originalCreateObjectUrl: typeof URL.createObjectURL
let originalRevokeObjectUrl: typeof URL.revokeObjectURL

function webm(name = 'take.webm', type = 'video/webm'): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type })
}

/** A decodable audio track stand-in: `decodeAudioData` knows the real length. */
function stubDecodedAudio(durationSeconds: number): void {
  const buffer = {
    duration: durationSeconds,
    length: 4800,
    numberOfChannels: 1,
    sampleRate: 48000,
    getChannelData: () => new Float32Array(4800).fill(0.5),
  }
  class FakeAudioContext {
    decodeAudioData = vi.fn(async () => buffer)
    close = vi.fn(async () => undefined)
  }
  vi.stubGlobal('AudioContext', FakeAudioContext)
}

beforeEach(() => {
  element = new FakeMediaElement()
  originalCreateElement = document.createElement.bind(document)
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    if (tag === 'video' || tag === 'audio') return element as unknown as HTMLElement
    return originalCreateElement(tag)
  }) as typeof document.createElement)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  originalCreateObjectUrl = URL.createObjectURL
  originalRevokeObjectUrl = URL.revokeObjectURL
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:probe'),
  })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
  recorderMock.readRecordingDuration.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: originalCreateObjectUrl,
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: originalRevokeObjectUrl,
  })
})

describe('WebM duration repair on the generic import path (0.27.0)', () => {
  it('repairs an infinite video duration without a recording hint', async () => {
    element.videoWidth = 1920
    element.videoHeight = 1080
    recorderMock.readRecordingDuration.mockResolvedValue(12.5)

    const asset = await importFile(webm())

    expect(asset.kind).toBe('video')
    expect(asset.duration).toBe(12.5)
    expect(recorderMock.readRecordingDuration).toHaveBeenCalledTimes(1)
  })

  it('repairs an infinite audio duration without a recording hint', async () => {
    recorderMock.readRecordingDuration.mockResolvedValue(6)

    const asset = await importFile(webm('Voiceover.webm', 'audio/webm'))

    expect(asset.kind).toBe('audio')
    expect(asset.duration).toBe(6)
    expect(recorderMock.readRecordingDuration).toHaveBeenCalledTimes(1)
  })

  it('reclassifies an audio-only WebM reported as video', async () => {
    recorderMock.readRecordingDuration.mockResolvedValue(8)

    const asset = await importFile(webm('Voiceover.webm', 'video/webm'))

    expect(asset.kind).toBe('audio')
    expect(asset.duration).toBe(8)
    expect(asset.width).toBe(0)
    expect(asset.height).toBe(0)
    expect(asset.hasAudio).toBe(true)
  })

  it('keeps a finite duration without a repair read', async () => {
    element.duration = 4.5
    element.videoWidth = 640
    element.videoHeight = 360

    const asset = await importFile(webm())

    expect(asset.duration).toBe(4.5)
    expect(recorderMock.readRecordingDuration).not.toHaveBeenCalled()
  })

  it('uses the decoded audio length when Firefox cannot read the container', async () => {
    // A downloaded voiceover re-imported with no hint: the container reports
    // Infinity and the seek repair returns null, but the audio decodes.
    recorderMock.readRecordingDuration.mockResolvedValue(null)
    stubDecodedAudio(3.0135)

    const asset = await importFile(webm('Voiceover.webm', 'audio/webm'))

    expect(asset.kind).toBe('audio')
    expect(asset.duration).toBeCloseTo(3.0135, 3)
    expect(asset.waveformPeaks?.length).toBeGreaterThan(0)
  })

  it('keeps the decoded length for an audio-only WebM reported as video', async () => {
    recorderMock.readRecordingDuration.mockResolvedValue(null)
    stubDecodedAudio(2.5)

    const asset = await importFile(webm('Voiceover.webm', 'video/webm'))

    expect(asset.kind).toBe('audio')
    expect(asset.duration).toBeCloseTo(2.5, 3)
    expect(asset.hasAudio).toBe(true)
  })

  it('prefers a repaired container duration over the decoded audio length', async () => {
    recorderMock.readRecordingDuration.mockResolvedValue(6)
    stubDecodedAudio(5.8)

    const asset = await importFile(webm('Voiceover.webm', 'audio/webm'))

    expect(asset.duration).toBe(6)
  })
})

describe('computePeaks bucket coverage', () => {
  it('covers the trailing samples of a length not divisible by the bucket count', () => {
    const length = 4800
    const data = new Float32Array(length)
    // A spike in the last 17 percent: the old fixed-width buckets stopped at
    // index 3999, so this sample was never read.
    data[4700] = 1
    const buffer = {
      length,
      numberOfChannels: 1,
      getChannelData: () => data,
    } as unknown as AudioBuffer
    const peaks = computePeaks(buffer, 1000)
    expect(peaks[979]).toBe(1)
    expect(peaks.filter((value) => value > 0)).toHaveLength(1)
  })
})
