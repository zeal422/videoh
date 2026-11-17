import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resolveDuration } from '../media/probe'
import { RECORDING_MAX_BYTES, RECORDING_SOFT_MAX_BYTES } from '../constants'
import {
  createLevelMeter,
  listRecordingDevices,
  pickMimeType,
  readRecordingDuration,
  recorderCapabilities,
  recordingFileName,
  recordingLimitState,
  requestScreenStream,
  resolveRecordingMime,
  StreamRecorder,
  type RecordingKind,
} from '../media/recorder'

class FakeTrack {
  stop = vi.fn()
  readyState: 'live' | 'ended' = 'live'
  constructor(readonly kind: 'audio' | 'video') {}
}

function fakeStream(tracks: FakeTrack[] = [new FakeTrack('video'), new FakeTrack('audio')]) {
  return {
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((track) => track.kind === 'audio'),
    getVideoTracks: () => tracks.filter((track) => track.kind === 'video'),
  } as unknown as MediaStream
}

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = []
  static isTypeSupported = (type: string) => type.includes('webm')
  state: 'inactive' | 'recording' = 'inactive'
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  onerror: (() => void) | null = null
  stopCalls = 0
  /** A browser that switches state without ever firing stop. */
  static neverStop = false
  /** A recorder whose stop throws instead of stopping. */
  static failStop = false
  /** Data the real recorder emits before stop, after the final slice. */
  trailingChunk: Blob | null = null

  constructor(
    readonly stream: MediaStream,
    readonly options: MediaRecorderOptions,
  ) {
    FakeMediaRecorder.instances.push(this)
  }

  start(): void {
    this.state = 'recording'
  }

  stop(): void {
    this.stopCalls += 1
    if (this.state === 'inactive') return
    this.state = 'inactive'
    if (FakeMediaRecorder.failStop) throw new Error('media recorder stop failed')
    if (FakeMediaRecorder.neverStop) return
    if (this.trailingChunk) this.ondataavailable?.({ data: this.trailingChunk })
    this.onstop?.()
  }

  emit(blob: Blob): void {
    this.ondataavailable?.({ data: blob })
  }
}

function lastRecorder(): FakeMediaRecorder {
  const recorder = FakeMediaRecorder.instances.at(-1)
  if (!recorder) throw new Error('No recorder constructed')
  return recorder
}

class FakeVideo {
  duration = Number.POSITIVE_INFINITY
  preload = ''
  muted = false
  src = ''
  private localTime = 0
  private listeners = new Map<string, Set<() => void>>()

  constructor(private readonly behavior: 'repair' | 'error' | 'finite') {
    if (behavior === 'finite') this.duration = 4.5
  }

  addEventListener(event: string, listener: () => void): void {
    const set = this.listeners.get(event) ?? new Set()
    set.add(listener)
    this.listeners.set(event, set)
  }

  removeEventListener(event: string, listener: () => void): void {
    this.listeners.get(event)?.delete(listener)
  }

  emit(event: string): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener()
  }

  get currentTime(): number {
    return this.localTime
  }

  set currentTime(value: number) {
    this.localTime = value
    if (this.behavior === 'finite') return
    if (this.behavior === 'error') {
      queueMicrotask(() => this.emit('error'))
      return
    }
    if (value > 1e100) {
      this.duration = 12.5
      queueMicrotask(() => this.emit('timeupdate'))
    }
  }

  load(): void {}
}

describe('recorder helpers (0.27.0)', () => {
  beforeEach(() => {
    FakeMediaRecorder.instances = []
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('reports capabilities and refuses a kind without its API', () => {
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn(),
        getDisplayMedia: vi.fn(),
        enumerateDevices: vi.fn(),
      },
    })
    const all = recorderCapabilities('screen')
    expect(all.recorder).toBe(true)
    expect(all.microphone).toBe(true)
    expect(all.screen).toBe(true)
    expect(all.mimeType).toBe('video/webm;codecs=vp9,opus')

    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn() } })
    expect(recorderCapabilities('screen').screen).toBe(false)
    expect(recorderCapabilities('voiceover').microphone).toBe(true)

    vi.stubGlobal('MediaRecorder', undefined)
    expect(recorderCapabilities('camera').recorder).toBe(false)
    expect(recorderCapabilities('camera').mimeType).toBeNull()
  })

  it('returns empty device lists when enumeration is denied', async () => {
    vi.stubGlobal('navigator', {
      mediaDevices: {
        enumerateDevices: vi.fn(async () => {
          throw new Error('NotAllowedError')
        }),
      },
    })
    await expect(listRecordingDevices()).resolves.toEqual({ microphones: [], cameras: [] })
  })

  it('picks the first supported MIME type for the kind', () => {
    const support = (supported: string[]) => (type: string) => supported.includes(type)
    expect(pickMimeType('voiceover', support(['audio/webm']))).toBe('audio/webm')
    expect(pickMimeType('screen', support(['video/webm', 'video/webm;codecs=vp8,opus']))).toBe(
      'video/webm;codecs=vp8,opus',
    )
    expect(pickMimeType('camera', support(['video/mp4']))).toBe('video/mp4')
    expect(pickMimeType('camera', support([]))).toBeNull()
    // Audio kinds never take a video container.
    expect(pickMimeType('voiceover', support(['video/webm']))).toBeNull()
  })

  it('drops the audio codec for a video-only stream', () => {
    const support = (supported: string[]) => (type: string) => supported.includes(type)
    // Firefox never emits data for a muxed codec on a video-only stream.
    expect(
      resolveRecordingMime('video/webm;codecs=vp8,opus', false, support(['video/webm;codecs=vp8'])),
    ).toBe('video/webm;codecs=vp8')
    expect(
      resolveRecordingMime('video/webm;codecs=vp9,opus', false, support(['video/webm;codecs=vp9'])),
    ).toBe('video/webm;codecs=vp9')
    // A stream with audio keeps the muxed request untouched.
    expect(resolveRecordingMime('video/webm;codecs=vp9,opus', true, support([]))).toBe(
      'video/webm;codecs=vp9,opus',
    )
    // An mp4 request stays in its container.
    expect(
      resolveRecordingMime('video/mp4', false, support(['video/mp4;codecs=avc1', 'video/webm'])),
    ).toBe('video/mp4;codecs=avc1')
    // No supported video-only form leaves the request as it was.
    expect(resolveRecordingMime('video/webm;codecs=vp8,opus', false, support([]))).toBe(
      'video/webm;codecs=vp8,opus',
    )
    // An audio kind never turns into a video container.
    expect(resolveRecordingMime('audio/webm;codecs=opus', false, support(['video/webm']))).toBe(
      'audio/webm;codecs=opus',
    )
  })

  it('records a video-only stream with a video-only MIME type', () => {
    const stream = fakeStream([new FakeTrack('video')])
    new StreamRecorder(stream, 'screen', 'video/webm;codecs=vp8,opus')
    const mimeType = lastRecorder().options.mimeType ?? ''
    expect(mimeType.startsWith('video/webm')).toBe(true)
    expect(mimeType).not.toContain('opus')
  })

  it('names a recording from the local clock and the container', () => {
    const now = new Date(2026, 10, 14, 9, 5, 7)
    expect(recordingFileName('voiceover', 'audio/webm;codecs=opus', now)).toBe(
      'Voiceover 2026-11-14 09-05-07.webm',
    )
    expect(recordingFileName('screen', 'video/mp4', now)).toBe(
      'Screen recording 2026-11-14 09-05-07.mp4',
    )
  })

  it('warns at 80 percent and stops at either cap', () => {
    expect(recordingLimitState(10, 1024)).toBe('ok')
    expect(recordingLimitState(480, 1024)).toBe('warning')
    expect(recordingLimitState(10, 512 * 1024 * 1024 * 0.8)).toBe('warning')
    expect(recordingLimitState(600, 1024)).toBe('limit')
    expect(recordingLimitState(10, 512 * 1024 * 1024)).toBe('limit')
  })

  it('stops once, saves the chunks, and stops every track', async () => {
    const stream = fakeStream()
    const recorder = new StreamRecorder(stream, 'screen', 'video/webm;codecs=vp9,opus')
    recorder.start()
    lastRecorder().emit(new Blob(['hello'], { type: 'video/webm' }))
    const first = await recorder.stop()
    const second = await recorder.stop()

    expect(first).toBe(second)
    expect(first).toBeInstanceOf(File)
    expect(await first!.text()).toBe('hello')
    expect(first!.name?.endsWith('.webm')).toBe(true)
    expect(lastRecorder().stopCalls).toBe(1)
    for (const track of stream.getTracks()) expect(track.stop).toHaveBeenCalledTimes(1)
  })

  it('cancels without producing a file and still cleans up', async () => {
    const stream = fakeStream()
    const recorder = new StreamRecorder(stream, 'voiceover', 'audio/webm;codecs=opus')
    recorder.start()
    lastRecorder().emit(new Blob(['discard']))
    recorder.cancel()
    await expect(recorder.stop()).resolves.toBeNull()
    for (const track of stream.getTracks()) expect(track.stop).toHaveBeenCalledTimes(1)
  })

  it('stops at the soft byte cap and keeps the crossing and trailing chunks', async () => {
    const stream = fakeStream()
    const recorder = new StreamRecorder(stream, 'screen', 'video/webm')
    recorder.start()
    const instance = lastRecorder()
    instance.emit(new Blob(['head']))
    instance.trailingChunk = new Blob(['tail'])
    const nearCap = new Blob(['cap'])
    Object.defineProperty(nearCap, 'size', { value: RECORDING_SOFT_MAX_BYTES })
    instance.emit(nearCap)
    // The crossing chunk and the stop-triggered trailing chunk complete the stream.
    expect(instance.state).toBe('inactive')
    const file = await recorder.stop()
    expect(await file!.text()).toBe('headcaptail')
    expect(recorder.bufferedBytes).toBe(0)
  })

  it('drops the trailing chunk after a recorder error', async () => {
    const stream = fakeStream()
    const onError = vi.fn()
    const recorder = new StreamRecorder(stream, 'screen', 'video/webm', { onError })
    recorder.start()
    const instance = lastRecorder()
    instance.emit(new Blob(['head']))
    instance.trailingChunk = new Blob(['tail'])
    instance.onerror?.()
    expect(onError).toHaveBeenCalledTimes(1)
    await expect(recorder.stop()).resolves.toBeNull()
  })

  it('still tears down when the error handler throws', async () => {
    const stream = fakeStream()
    const recorder = new StreamRecorder(stream, 'screen', 'video/webm', {
      onError: () => {
        throw new Error('handler failed')
      },
    })
    recorder.start()
    const instance = lastRecorder()
    instance.emit(new Blob(['head']))
    expect(() => instance.onerror?.()).toThrow('handler failed')
    expect(recorder.bufferedBytes).toBe(0)
    await expect(recorder.stop()).resolves.toBeNull()
  })

  it('ignores a chunk that arrives after finalize', async () => {
    const stream = fakeStream()
    const recorder = new StreamRecorder(stream, 'voiceover', 'audio/webm;codecs=opus')
    recorder.start()
    lastRecorder().emit(new Blob(['take']))
    const file = await recorder.stop()
    expect(await file!.text()).toBe('take')
    lastRecorder().emit(new Blob(['late']))
    expect(recorder.bufferedBytes).toBe(0)
  })

  it('keeps the time limit on a monotonic clock', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 10, 14, 9, 0, 0))
    const recorder = new StreamRecorder(fakeStream(), 'camera', 'video/webm')
    recorder.start()
    vi.advanceTimersByTime(1000)
    expect(recorder.elapsedSeconds).toBeCloseTo(1, 1)
    // A wall-clock jump must not look like a long take.
    vi.setSystemTime(new Date(2026, 10, 14, 10, 0, 0))
    expect(recorder.elapsedSeconds).toBeCloseTo(1, 1)
    await recorder.stop()
  })

  it('stops itself at the time cap and reports the finished file', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 10, 14, 9, 0, 0))
    const stream = fakeStream()
    const onTick = vi.fn()
    const onFinished = vi.fn()
    const recorder = new StreamRecorder(stream, 'camera', 'video/webm', { onTick, onFinished })
    recorder.start()
    lastRecorder().emit(new Blob(['take']))
    vi.advanceTimersByTime(600_500)
    // The cap stops the take from inside the tick, before the caller asks.
    expect(lastRecorder().state).toBe('inactive')
    expect(onFinished).toHaveBeenCalledWith(expect.any(File))
    const file = await recorder.stop()
    expect(file).toBeInstanceOf(File)
    expect(onTick).toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('resolves the file when the browser stops the recorder on its own', async () => {
    const stream = fakeStream()
    const onFinished = vi.fn()
    const recorder = new StreamRecorder(stream, 'voiceover', 'audio/webm;codecs=opus', {
      onFinished,
    })
    recorder.start()
    lastRecorder().emit(new Blob(['late take']))
    // No recorder.stop(): this is the browser ending the take, as when the
    // microphone track ends.
    lastRecorder().stop()
    const outcome = await Promise.race([
      recorder.stop(),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 50)),
    ])
    expect(outcome).toBeInstanceOf(File)
    expect(await (outcome as File).text()).toBe('late take')
    expect(onFinished).toHaveBeenCalledWith(expect.any(File))
  })

  it('finalizes the take when the browser never fires stop', async () => {
    vi.useFakeTimers()
    FakeMediaRecorder.neverStop = true
    try {
      const stream = fakeStream([new FakeTrack('video')])
      const recorder = new StreamRecorder(stream, 'screen', 'video/webm;codecs=vp8')
      recorder.start()
      lastRecorder().emit(new Blob(['slow take']))
      const pending = recorder.stop()
      await vi.advanceTimersByTimeAsync(19_000)
      // Still waiting inside the grace window.
      expect(recorder.bufferedBytes).toBeGreaterThan(0)
      await vi.advanceTimersByTimeAsync(2_000)
      const file = await pending
      expect(file).toBeInstanceOf(File)
      expect(await file!.text()).toBe('slow take')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      FakeMediaRecorder.neverStop = false
      vi.useRealTimers()
    }
  })

  it('finalizes the buffered take when stop throws', async () => {
    FakeMediaRecorder.failStop = true
    try {
      const stream = fakeStream([new FakeTrack('video')])
      const recorder = new StreamRecorder(stream, 'camera', 'video/webm;codecs=vp8')
      recorder.start()
      lastRecorder().emit(new Blob(['thrown take']))
      const file = await recorder.stop()
      expect(file).toBeInstanceOf(File)
      expect(await file!.text()).toBe('thrown take')
    } finally {
      FakeMediaRecorder.failStop = false
    }
  })

  it('drops a chunk that would cross the hard ceiling and saves the earlier take', async () => {
    vi.useFakeTimers()
    FakeMediaRecorder.neverStop = true
    try {
      const stream = fakeStream([new FakeTrack('video')])
      const recorder = new StreamRecorder(stream, 'screen', 'video/webm;codecs=vp8')
      recorder.start()
      const instance = lastRecorder()
      instance.emit(new Blob(['head']))
      const nearCap = new Blob(['x'])
      Object.defineProperty(nearCap, 'size', { value: RECORDING_SOFT_MAX_BYTES })
      instance.emit(nearCap)
      // The recorder is stopping; this final chunk would push the buffer past
      // 512 MiB, so it is dropped and the take ends with the chunks before it.
      const crossing = new Blob(['y'])
      Object.defineProperty(crossing, 'size', {
        value: RECORDING_MAX_BYTES - RECORDING_SOFT_MAX_BYTES + 1,
      })
      instance.emit(crossing)
      expect(recorder.reachedByteLimit).toBe(true)
      expect(recorder.bufferedBytes).toBe(0)
      const file = await recorder.stop()
      expect(await file!.text()).toBe('headx')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      FakeMediaRecorder.neverStop = false
      vi.useRealTimers()
    }
  })

  it('repairs an infinite container duration by seeking past the end', async () => {
    const element = new FakeVideo('repair')
    queueMicrotask(() => element.emit('loadedmetadata'))
    await expect(
      readRecordingDuration(new Blob(['x']), () => element as unknown as HTMLVideoElement),
    ).resolves.toBe(12.5)
  })

  it('keeps a finite duration and refuses an unreadable one', async () => {
    const finite = new FakeVideo('finite')
    queueMicrotask(() => finite.emit('loadedmetadata'))
    await expect(
      readRecordingDuration(new Blob(['x']), () => finite as unknown as HTMLVideoElement),
    ).resolves.toBe(4.5)

    const broken = new FakeVideo('error')
    queueMicrotask(() => broken.emit('loadedmetadata'))
    await expect(
      readRecordingDuration(new Blob(['x']), () => broken as unknown as HTMLVideoElement),
    ).resolves.toBeNull()
  })
})

describe('screen audio source (0.27.0)', () => {
  class FakeStream {
    constructor(private readonly tracks: FakeTrack[]) {}
    getTracks() {
      return this.tracks
    }
    getAudioTracks() {
      return this.tracks.filter((track) => track.kind === 'audio')
    }
    getVideoTracks() {
      return this.tracks.filter((track) => track.kind === 'video')
    }
  }

  beforeEach(() => {
    vi.stubGlobal('MediaStream', FakeStream)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('records system audio without ever asking for the microphone', async () => {
    const display = new FakeStream([new FakeTrack('video'), new FakeTrack('audio')])
    const getUserMedia = vi.fn()
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getDisplayMedia: vi.fn(async () => display),
        getUserMedia,
      },
    })
    const { stream, warnings } = await requestScreenStream('system')
    expect(stream).toBe(display as unknown as MediaStream)
    expect(warnings).toEqual([])
    expect(getUserMedia).not.toHaveBeenCalled()
  })

  it('adds a microphone track to the display video without mixing', async () => {
    const display = new FakeStream([new FakeTrack('video')])
    const microphone = new FakeStream([new FakeTrack('audio')])
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getDisplayMedia: vi.fn(async () => display),
        getUserMedia: vi.fn(async () => microphone),
      },
    })
    const { stream, warnings } = await requestScreenStream('microphone')
    expect(warnings).toEqual([])
    expect(stream.getVideoTracks()).toHaveLength(1)
    expect(stream.getAudioTracks()).toHaveLength(1)
    // One audio track, straight from the microphone: no Web Audio mix.
    expect(stream.getAudioTracks()[0]).toBe(microphone.getAudioTracks()[0])
  })

  it('stops a display stream that arrives after cancellation', async () => {
    const displayTrack = new FakeTrack('video')
    const display = new FakeStream([displayTrack])
    const getUserMedia = vi.fn()
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getDisplayMedia: vi.fn(async () => display),
        getUserMedia,
      },
    })
    await expect(requestScreenStream('system', undefined, () => true)).rejects.toThrow(/cancelled/)
    expect(displayTrack.stop).toHaveBeenCalledTimes(1)
    expect(getUserMedia).not.toHaveBeenCalled()
  })

  it('stops both streams when cancelled after the microphone arrives', async () => {
    const displayTrack = new FakeTrack('video')
    const display = new FakeStream([displayTrack])
    const microphoneTrack = new FakeTrack('audio')
    const microphone = new FakeStream([microphoneTrack])
    let cancelled = false
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getDisplayMedia: vi.fn(async () => display),
        getUserMedia: vi.fn(async () => {
          cancelled = true
          return microphone
        }),
      },
    })
    await expect(requestScreenStream('microphone', undefined, () => cancelled)).rejects.toThrow(
      /cancelled/,
    )
    expect(displayTrack.stop).toHaveBeenCalledTimes(1)
    expect(microphoneTrack.stop).toHaveBeenCalledTimes(1)
  })

  it('aborts when sharing ends while the microphone prompt is open', async () => {
    const displayTrack = new FakeTrack('video')
    const display = new FakeStream([displayTrack])
    const microphoneTrack = new FakeTrack('audio')
    const microphone = new FakeStream([microphoneTrack])
    let resolveMicrophone: (value: MediaStream) => void = () => {}
    const pending = new Promise<MediaStream>((resolve) => {
      resolveMicrophone = resolve
    })
    let requested: () => void = () => {}
    const requestedMicrophone = new Promise<void>((resolve) => {
      requested = resolve
    })
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getDisplayMedia: vi.fn(async () => display),
        getUserMedia: vi.fn(() => {
          requested()
          return pending
        }),
      },
    })
    const request = requestScreenStream('microphone')
    await requestedMicrophone
    // The display is live when the prompt opens, then sharing ends.
    displayTrack.readyState = 'ended'
    resolveMicrophone(microphone as unknown as MediaStream)
    await expect(request).rejects.toThrow(/sharing ended/)
    expect(displayTrack.stop).toHaveBeenCalledTimes(1)
    expect(microphoneTrack.stop).toHaveBeenCalledTimes(1)
  })

  it('stops the display when a denied microphone take is cancelled', async () => {
    const displayTrack = new FakeTrack('video')
    const display = new FakeStream([displayTrack])
    let cancelled = false
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getDisplayMedia: vi.fn(async () => display),
        getUserMedia: vi.fn(async () => {
          cancelled = true
          throw new Error('NotAllowedError')
        }),
      },
    })
    await expect(requestScreenStream('microphone', undefined, () => cancelled)).rejects.toThrow(
      /cancelled/,
    )
    expect(displayTrack.stop).toHaveBeenCalledTimes(1)
  })

  it('aborts a denied microphone take when the shared display has ended', async () => {
    const displayTrack = new FakeTrack('video')
    displayTrack.readyState = 'ended'
    const display = new FakeStream([displayTrack])
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getDisplayMedia: vi.fn(async () => display),
        getUserMedia: vi.fn(async () => {
          throw new Error('NotAllowedError')
        }),
      },
    })
    await expect(requestScreenStream('microphone')).rejects.toThrow(/sharing ended/)
    expect(displayTrack.stop).toHaveBeenCalledTimes(1)
  })

  it('stops the display as soon as a pending microphone request is aborted', async () => {
    const displayTrack = new FakeTrack('video')
    const display = new FakeStream([displayTrack])
    const microphoneTrack = new FakeTrack('audio')
    const microphone = new FakeStream([microphoneTrack])
    let resolveMicrophone: (value: MediaStream) => void = () => {}
    const pending = new Promise<MediaStream>((resolve) => {
      resolveMicrophone = resolve
    })
    let requested: () => void = () => {}
    const requestedMicrophone = new Promise<void>((resolve) => {
      requested = resolve
    })
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getDisplayMedia: vi.fn(async () => display),
        getUserMedia: vi.fn(() => {
          requested()
          return pending
        }),
      },
    })
    const controller = new AbortController()
    const request = requestScreenStream('microphone', undefined, undefined, controller.signal)
    await requestedMicrophone
    expect(displayTrack.stop).not.toHaveBeenCalled()
    controller.abort()
    // The display is released before the prompt settles.
    expect(displayTrack.stop).toHaveBeenCalledTimes(1)
    resolveMicrophone(microphone as unknown as MediaStream)
    await expect(request).rejects.toThrow(/cancelled/)
    expect(microphoneTrack.stop).toHaveBeenCalledTimes(1)
    expect(displayTrack.stop).toHaveBeenCalledTimes(1)
  })

  it('closes the meter context when analyser setup fails', () => {
    const contexts: { close: ReturnType<typeof vi.fn> }[] = []
    class FakeAudioContext {
      close = vi.fn(async () => undefined)
      resume = vi.fn(async () => undefined)
      createMediaStreamSource = vi.fn(() => {
        throw new Error('bad stream')
      })
      createAnalyser = vi.fn()
      constructor() {
        contexts.push(this)
      }
    }
    vi.stubGlobal('AudioContext', FakeAudioContext)
    expect(createLevelMeter(fakeStream())).toBeNull()
    expect(contexts).toHaveLength(1)
    expect(contexts[0].close).toHaveBeenCalledTimes(1)
  })

  it('refuses an already-ended display with system audio', async () => {
    const displayTrack = new FakeTrack('video')
    displayTrack.readyState = 'ended'
    const audioTrack = new FakeTrack('audio')
    const display = new FakeStream([displayTrack, audioTrack])
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getDisplayMedia: vi.fn(async () => display),
        getUserMedia: vi.fn(),
      },
    })
    await expect(requestScreenStream('system')).rejects.toThrow(/sharing ended/)
    expect(displayTrack.stop).toHaveBeenCalledTimes(1)
    expect(audioTrack.stop).toHaveBeenCalledTimes(1)
  })

  it('falls back to video only when the microphone is denied', async () => {
    const display = new FakeStream([new FakeTrack('video')])
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getDisplayMedia: vi.fn(async () => display),
        getUserMedia: vi.fn(async () => {
          throw new Error('NotAllowedError')
        }),
      },
    })
    const { stream, warnings } = await requestScreenStream('microphone')
    expect(stream).toBe(display as unknown as MediaStream)
    expect(warnings.join(' ')).toMatch(/video only/)
  })
})

describe('probe duration hint (0.27.0)', () => {
  it('keeps a finite probe duration, otherwise uses the hint', () => {
    expect(resolveDuration(4.2, 9)).toBe(4.2)
    expect(resolveDuration(Number.POSITIVE_INFINITY, 9)).toBe(9)
    expect(resolveDuration(0, 9)).toBe(9)
    expect(resolveDuration(Number.NaN, 3.5)).toBe(3.5)
    expect(resolveDuration(Number.POSITIVE_INFINITY, Number.NaN)).toBe(0)
    expect(resolveDuration(0, -4)).toBe(0)
  })

  it('maps every recording kind to a browser-bound capability report', () => {
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn(), getDisplayMedia: vi.fn() },
    })
    const kinds: RecordingKind[] = ['voiceover', 'screen', 'camera']
    for (const kind of kinds) expect(recorderCapabilities(kind).recorder).toBe(true)
    vi.unstubAllGlobals()
  })
})
