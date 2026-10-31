import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  state: {
    url: '',
    blob: null as Blob | null,
    videoTrack: {} as unknown,
    keyPacket: null as unknown,
    firstPacket: null as unknown,
    nextPacket: null as unknown,
    keyError: null as Error | null,
    nextError: null as Error | null,
    disposed: 0,
    keyCalls: 0,
    nextCalls: 0,
    trackGate: null as Promise<void> | null,
  },
}))

vi.mock('mediabunny', () => {
  class UrlSource {
    constructor(url: string) {
      mocks.state.url = url
    }
  }
  class BlobSource {
    constructor(blob: Blob) {
      mocks.state.blob = blob
    }
  }
  class Input {
    async getPrimaryVideoTrack() {
      if (mocks.state.trackGate) await mocks.state.trackGate
      return mocks.state.videoTrack
    }
    dispose() {
      mocks.state.disposed++
    }
  }
  class EncodedPacketSink {
    async getKeyPacket() {
      mocks.state.keyCalls++
      if (mocks.state.keyError) throw mocks.state.keyError
      return mocks.state.keyPacket
    }
    async getFirstKeyPacket() {
      return mocks.state.firstPacket
    }
    async getNextKeyPacket() {
      mocks.state.nextCalls++
      if (mocks.state.nextError) throw mocks.state.nextError
      return mocks.state.nextPacket
    }
  }
  return { ALL_FORMATS: [], BlobSource, Input, EncodedPacketSink, UrlSource }
})

import { nextVideoKeyframe } from '../media/keyframes'

const EPSILON = 1e-4

beforeEach(() => {
  mocks.state.url = ''
  mocks.state.blob = null
  mocks.state.videoTrack = {}
  mocks.state.keyPacket = null
  mocks.state.firstPacket = null
  mocks.state.nextPacket = null
  mocks.state.keyError = null
  mocks.state.nextError = null
  mocks.state.disposed = 0
  mocks.state.keyCalls = 0
  mocks.state.nextCalls = 0
  mocks.state.trackGate = null
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('nextVideoKeyframe', () => {
  it('returns the next verified keyframe plus epsilon and disposes its input', async () => {
    mocks.state.keyPacket = { timestamp: 118.433 }
    mocks.state.nextPacket = { timestamp: 124.333 }

    const result = await nextVideoKeyframe('https://media.example/proxy.mp4', 118.466, 100)

    expect(result).toBeCloseTo(124.333 + EPSILON, 9)
    expect(mocks.state.url).toBe('https://media.example/proxy.mp4')
    expect(mocks.state.nextCalls).toBe(1)
    expect(mocks.state.disposed).toBe(1)
  })

  it('uses the first keyframe when the source time precedes it', async () => {
    mocks.state.keyPacket = null
    mocks.state.firstPacket = { timestamp: 1 }

    const result = await nextVideoKeyframe('https://media.example/video.mp4', 0.5, 100)

    expect(result).toBeCloseTo(1 + EPSILON, 9)
    expect(mocks.state.nextCalls).toBe(0)
    expect(mocks.state.disposed).toBe(1)
  })

  it('returns undefined when there is no later keyframe', async () => {
    mocks.state.keyPacket = { timestamp: 1 }
    mocks.state.nextPacket = null

    expect(await nextVideoKeyframe('https://media.example/video.mp4', 1, 100)).toBeUndefined()
    expect(mocks.state.disposed).toBe(1)
  })

  it('returns undefined for a non-video source', async () => {
    mocks.state.videoTrack = null

    expect(await nextVideoKeyframe('https://media.example/video.mp4', 1, 100)).toBeUndefined()
    expect(mocks.state.disposed).toBe(1)
  })

  it('returns undefined on rejection and disposes its input', async () => {
    mocks.state.keyError = new Error('unreadable')

    expect(await nextVideoKeyframe('https://media.example/video.mp4', 1, 100)).toBeUndefined()
    expect(mocks.state.disposed).toBe(1)
  })

  it('uses BlobSource for a blob URL', async () => {
    mocks.state.keyPacket = { timestamp: 1 }
    mocks.state.nextPacket = { timestamp: 2 }
    const blob = new Blob([new Uint8Array([1, 2, 3])])
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(blob))
    vi.stubGlobal('fetch', fetchMock)

    const result = await nextVideoKeyframe('blob:video', 1, 100)

    expect(result).toBeCloseTo(2 + EPSILON, 9)
    expect(fetchMock).toHaveBeenCalledWith(
      'blob:video',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(false)
    expect(mocks.state.blob).toBeInstanceOf(Blob)
    expect(mocks.state.blob?.size).toBe(3)
    expect(mocks.state.disposed).toBe(1)
  })

  it('rejects a non-ok blob fetch without reading it as media', async () => {
    const fetchMock = vi.fn(async () => new Response('missing', { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)

    expect(await nextVideoKeyframe('blob:video', 1, 100)).toBeUndefined()
    expect(mocks.state.blob).toBeNull()
    expect(mocks.state.disposed).toBe(0)
  })

  it('returns undefined on timeout, disposes its input, and does not continue', async () => {
    mocks.state.keyPacket = new Promise(() => undefined)

    expect(await nextVideoKeyframe('https://media.example/video.mp4', 1, 10)).toBeUndefined()
    expect(mocks.state.nextCalls).toBe(0)
    expect(mocks.state.disposed).toBe(1)
  })

  it('stops after the timeout when the video track resolves late', async () => {
    let resolveTrack!: () => void
    mocks.state.trackGate = new Promise<void>((resolve) => {
      resolveTrack = resolve
    })
    mocks.state.keyPacket = { timestamp: 1 }
    mocks.state.nextPacket = { timestamp: 2 }

    expect(await nextVideoKeyframe('https://media.example/video.mp4', 1, 10)).toBeUndefined()
    resolveTrack()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await Promise.resolve()

    expect(mocks.state.keyCalls).toBe(0)
    expect(mocks.state.nextCalls).toBe(0)
    expect(mocks.state.disposed).toBe(1)
  })

  it('bounds a slow blob fetch and aborts it without reading it', async () => {
    let resolveFetch!: (response: Response) => void
    let signal: AbortSignal | null | undefined
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          signal = init?.signal
          resolveFetch = resolve
        }),
    )
    vi.stubGlobal('fetch', fetchMock)

    expect(await nextVideoKeyframe('blob:video', 1, 10)).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledWith(
      'blob:video',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(signal?.aborted).toBe(true)
    expect(mocks.state.disposed).toBe(0)

    resolveFetch(new Response(new Blob([new Uint8Array([1])])))
    await new Promise((resolve) => setTimeout(resolve, 0))
    await Promise.resolve()
    await Promise.resolve()

    expect(mocks.state.blob).toBeNull()
    expect(mocks.state.disposed).toBe(0)
    expect(mocks.state.nextCalls).toBe(0)
  })
})
