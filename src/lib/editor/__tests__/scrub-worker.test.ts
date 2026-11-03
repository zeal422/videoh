// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The worker's asset lifecycle (0.18.0). `getAsset` opens one mediabunny
 * `Input` per `(assetId, url)`; a `releaseAsset` that lands while the track
 * lookup is still pending must dispose that Input instead of installing it.
 */

const state = vi.hoisted(() => ({
  inputs: [] as { disposed: boolean }[],
  tracks: [] as Promise<unknown>[],
  canvases: [] as Promise<{ canvas: unknown } | undefined>[],
  keys: [] as Promise<unknown>[],
  bitmaps: [] as { close: ReturnType<typeof vi.fn> }[],
}))

vi.mock('mediabunny', () => {
  class Input {
    disposed = false
    private readonly index: number
    constructor() {
      this.index = state.inputs.length
      state.inputs.push(this)
    }
    getPrimaryVideoTrack() {
      return state.tracks[this.index] ?? Promise.resolve({})
    }
    dispose() {
      this.disposed = true
    }
  }
  class CanvasSink {
    getCanvas() {
      return state.canvases.shift() ?? Promise.resolve(undefined)
    }
  }
  class EncodedPacketSink {
    getKeyPacket() {
      return state.keys.shift() ?? Promise.resolve(undefined)
    }
    getFirstKeyPacket() {
      return state.keys.shift() ?? Promise.resolve(undefined)
    }
  }
  return {
    ALL_FORMATS: {},
    Input,
    CanvasSink,
    EncodedPacketSink,
    UrlSource: class {},
  }
})

const posted: unknown[] = []

type WorkerScope = {
  onmessage: ((event: { data: Record<string, unknown> }) => void) | null
}

function send(data: Record<string, unknown>): void {
  ;(self as unknown as WorkerScope).onmessage?.({ data })
}

/** A track lookup the test resolves when it wants the open to finish. */
function deferredTrack(): (value: unknown) => void {
  let resolve!: (value: unknown) => void
  state.tracks.push(
    new Promise<unknown>((res) => {
      resolve = res
    }),
  )
  return resolve
}

/** A CanvasSink.getCanvas the test resolves when it wants the decode to finish. */
function deferredCanvas(): (value: { canvas: unknown } | undefined) => void {
  let resolve!: (value: { canvas: unknown } | undefined) => void
  state.canvases.push(
    new Promise<{ canvas: unknown } | undefined>((res) => {
      resolve = res
    }),
  )
  return resolve
}

const decode = (requestId: number, clipId: string): Record<string, unknown> => ({
  type: 'decode',
  requestId,
  clipId,
  assetId: 'a1',
  url: 'blob:one',
  sourceTime: 1,
  generation: 1,
})

const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

beforeEach(async () => {
  state.inputs.length = 0
  state.tracks.length = 0
  state.canvases.length = 0
  state.keys.length = 0
  state.bitmaps.length = 0
  posted.length = 0
  vi.stubGlobal('createImageBitmap', async () => {
    const bitmap = { close: vi.fn() }
    state.bitmaps.push(bitmap)
    return bitmap
  })
  // Import before spying: the module captures `self`, and `postMessage` is
  // looked up on it at call time.
  await import('../playback/scrub-worker')
  Object.defineProperty(self, 'postMessage', {
    configurable: true,
    value: (message: unknown) => {
      posted.push(message)
    },
  })
  // Clear module-level assets/opening from any prior test.
  send({ type: 'reset' })
})

afterEach(() => {
  send({ type: 'reset' })
  vi.unstubAllGlobals()
})

describe('scrub worker asset lifecycle', () => {
  it('disposes an input released while its track lookup is pending (0.18.0)', async () => {
    const resolveTrack = deferredTrack()

    send({
      type: 'decode',
      requestId: 1,
      clipId: 'c1',
      assetId: 'a1',
      url: 'blob:one',
      sourceTime: 1,
      generation: 1,
    })
    expect(state.inputs).toHaveLength(1)

    // The asset is released while the Input is still opening.
    send({ type: 'releaseAsset', assetId: 'a1', url: 'blob:one' })
    resolveTrack({})

    await vi.waitFor(() => expect(state.inputs[0].disposed).toBe(true))
    // A later request for the same asset must open a fresh Input, not reuse
    // the released one.
    send({
      type: 'decode',
      requestId: 2,
      clipId: 'c1',
      assetId: 'a1',
      url: 'blob:one',
      sourceTime: 1,
      generation: 1,
    })
    await vi.waitFor(() => expect(state.inputs).toHaveLength(2))
    // Let the second decode settle before the test ends; the module-level
    // message handler outlives the test.
    await vi.waitFor(() =>
      expect(posted.some((message) => (message as { requestId?: number }).requestId === 2)).toBe(
        true,
      ),
    )
  })

  it('drops an in-flight frame after the clip is released (0.18.0)', async () => {
    const resolveCanvas = deferredCanvas()
    send(decode(1, 'c1'))
    await vi.waitFor(() => expect(state.canvases).toHaveLength(0))

    send({ type: 'releaseClip', clipId: 'c1' })
    resolveCanvas({ canvas: {} })
    await vi.waitFor(() => expect(state.bitmaps).toHaveLength(1))

    expect(state.bitmaps[0].close).toHaveBeenCalled()
    expect(posted.some((message) => (message as { type?: string }).type === 'frame')).toBe(false)
    expect(posted.some((message) => (message as { type?: string }).type === 'error')).toBe(false)
  })

  it('drops an in-flight frame after the asset is released (0.18.0)', async () => {
    const resolveCanvas = deferredCanvas()
    send(decode(1, 'c1'))
    await vi.waitFor(() => expect(state.canvases).toHaveLength(0))

    send({ type: 'releaseAsset', assetId: 'a1', url: 'blob:one' })
    resolveCanvas({ canvas: {} })
    await vi.waitFor(() => expect(state.bitmaps).toHaveLength(1))

    expect(state.bitmaps[0].close).toHaveBeenCalled()
    expect(posted.some((message) => (message as { type?: string }).type === 'frame')).toBe(false)
    expect(posted.some((message) => (message as { type?: string }).type === 'error')).toBe(false)
  })

  it('drops an in-flight frame after reset (0.18.0)', async () => {
    const resolveCanvas = deferredCanvas()
    send(decode(1, 'c1'))
    await vi.waitFor(() => expect(state.canvases).toHaveLength(0))

    send({ type: 'reset' })
    resolveCanvas({ canvas: {} })
    await vi.waitFor(() => expect(state.bitmaps).toHaveLength(1))

    expect(state.bitmaps[0].close).toHaveBeenCalled()
    expect(posted.some((message) => (message as { type?: string }).type === 'frame')).toBe(false)
  })

  it('lets a released clip process its next request (0.18.0)', async () => {
    const firstCanvas = deferredCanvas()
    send(decode(1, 'c1'))
    await vi.waitFor(() => expect(state.canvases).toHaveLength(0))

    send({ type: 'releaseClip', clipId: 'c1' })
    const secondCanvas = deferredCanvas()
    send(decode(2, 'c1'))
    firstCanvas({ canvas: {} })
    await vi.waitFor(() => expect(state.bitmaps).toHaveLength(1))
    expect(state.bitmaps[0].close).toHaveBeenCalled()

    secondCanvas({ canvas: {} })
    await vi.waitFor(() =>
      expect(
        posted.some(
          (message) =>
            (message as { type?: string; requestId?: number }).type === 'frame' &&
            (message as { requestId?: number }).requestId === 2,
        ),
      ).toBe(true),
    )
    expect(state.bitmaps[1].close).not.toHaveBeenCalled()
  })

  it('bounds a stalled key retry and frees the clip for a replacement URL (0.18.0)', async () => {
    vi.useFakeTimers()
    try {
      // The first frame decode fails, so the attempt enters the key retry and
      // stalls. The second canvas belongs to the replacement URL.
      state.keys.push(new Promise<unknown>(() => undefined))
      state.canvases.push(Promise.resolve(undefined))
      state.canvases.push(Promise.resolve({ canvas: {} }))
      send(decode(1, 'c1'))
      await flush()
      expect(state.inputs).toHaveLength(1)

      // The same clip asks for a replacement URL while the first attempt is
      // stuck in the key lookup. Its request must run after the timeout.
      send({ ...decode(2, 'c1'), url: 'blob:two' })
      await flush()
      expect(state.inputs).toHaveLength(1)

      const { DECODE_TIMEOUT_MS } = await import('../playback/scrub-worker')
      await vi.advanceTimersByTimeAsync(DECODE_TIMEOUT_MS)
      await flush()

      expect(state.inputs).toHaveLength(2)
      // The queued replacement wins, so the stale attempt's error is dropped
      // and request 2 is the one that must settle.
      expect(
        posted.some(
          (message) =>
            (message as { type?: string; requestId?: number }).type === 'frame' &&
            (message as { requestId?: number }).requestId === 2,
        ),
      ).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('times out a hung track lookup and disposes its input (0.18.0)', async () => {
    vi.useFakeTimers()
    try {
      deferredTrack() // never resolves
      send(decode(1, 'c1'))
      expect(state.inputs).toHaveLength(1)

      const { DECODE_TIMEOUT_MS } = await import('../playback/scrub-worker')
      await vi.advanceTimersByTimeAsync(DECODE_TIMEOUT_MS)
      await flush()

      expect(state.inputs[0].disposed).toBe(true)
      expect(posted.some((message) => (message as { type?: string }).type === 'error')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('starts a fresh open after a release instead of sharing the doomed attempt (0.18.0)', async () => {
    const resolveFirst = deferredTrack()
    send({
      type: 'decode',
      requestId: 1,
      clipId: 'c1',
      assetId: 'a1',
      url: 'blob:one',
      sourceTime: 1,
      generation: 1,
    })
    expect(state.inputs).toHaveLength(1)

    // Release while the first track lookup is pending, then request the same
    // asset from a different clip before the first attempt settles.
    send({ type: 'releaseAsset', assetId: 'a1', url: 'blob:one' })
    const resolveSecond = deferredTrack()
    send({
      type: 'decode',
      requestId: 2,
      clipId: 'c2',
      assetId: 'a1',
      url: 'blob:one',
      sourceTime: 1,
      generation: 1,
    })
    // The new request must not join the doomed first promise.
    await vi.waitFor(() => expect(state.inputs).toHaveLength(2))

    resolveFirst({})
    await vi.waitFor(() => expect(state.inputs[0].disposed).toBe(true))
    // The stale attempt must not dispose or replace the new attempt.
    expect(state.inputs[1].disposed).toBe(false)

    resolveSecond({})
    await vi.waitFor(() =>
      expect(posted.some((message) => (message as { requestId?: number }).requestId === 2)).toBe(
        true,
      ),
    )
    // The stale attempt's cleanup must not remove the new attempt's opening
    // entry: a third request reuses the installed asset.
    send({
      type: 'decode',
      requestId: 3,
      clipId: 'c3',
      assetId: 'a1',
      url: 'blob:one',
      sourceTime: 1,
      generation: 1,
    })
    await vi.waitFor(() =>
      expect(posted.some((message) => (message as { requestId?: number }).requestId === 3)).toBe(
        true,
      ),
    )
    expect(state.inputs).toHaveLength(2)
  })
})
