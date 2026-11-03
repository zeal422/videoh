import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  THUMBNAIL_ASSET_FRAMES,
  THUMBNAIL_CACHE_PIXELS,
  THUMBNAIL_DECODE_TIMEOUT_MS,
  ThumbnailCache,
  type ThumbnailFrame,
} from '../media/thumbnail-cache'

/**
 * The default decoder's Input ownership (0.18.0). A track lookup is awaited
 * before the Input is registered in the shared map, so the run that created
 * it must own it across that await.
 */
const media = vi.hoisted(() => ({
  inputs: [] as { disposed: boolean; source: unknown; index: number }[],
  tracks: [] as Promise<unknown>[],
}))

vi.mock('mediabunny', () => {
  class Input {
    disposed = false
    source: unknown
    index: number
    constructor(options: { source?: unknown } = {}) {
      this.index = media.inputs.length
      this.source = options.source
      media.inputs.push(this)
    }
    getPrimaryVideoTrack() {
      return media.tracks[this.index] ?? Promise.resolve({})
    }
    dispose(): void {
      this.disposed = true
    }
  }
  class CanvasSink {
    constructor(_track: unknown, _options?: unknown) {}
    async *canvasesAtTimestamps(_times: readonly number[]): AsyncGenerator<never> {}
  }
  class UrlSource {
    constructor(readonly url: string) {}
  }
  return { ALL_FORMATS: {}, CanvasSink, Input, UrlSource }
})

/**
 * The per-asset source-time thumbnail cache (0.18.0): a split reuses decoded
 * frames, missing times are decoded in contiguous runs, and a relink drops the
 * old asset's frames.
 */

class FakeBitmap {
  closed = false
  width = 10
  height = 10
  close(): void {
    this.closed = true
  }
}

function frame(sourceTime: number, bitmap = new FakeBitmap()): ThumbnailFrame {
  return {
    sourceTime,
    frame: bitmap as unknown as CanvasImageSource,
    width: bitmap.width,
    height: bitmap.height,
    pixels: bitmap.width * bitmap.height,
  }
}

beforeEach(() => {
  media.inputs.length = 0
  media.tracks.length = 0
  vi.stubGlobal('ImageBitmap', FakeBitmap)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ThumbnailCache', () => {
  it('decodes missing times once and reports progress', async () => {
    const decode = vi.fn(async (_assetId: string, _url: string, times: readonly number[]) =>
      times.map((time) => frame(time)),
    )
    const cache = new ThumbnailCache(decode, true)
    const progress = vi.fn()

    await cache.ensure('a1', 'blob:one', [1, 2, 3], 0.01, progress)
    expect(decode).toHaveBeenCalledTimes(1)
    expect(decode.mock.calls[0][2]).toEqual([1, 2, 3])
    expect(progress).toHaveBeenLastCalledWith({ completed: 3, total: 3 })
    expect(cache.nearest('a1', 'blob:one', 2, 0.01)?.sourceTime).toBe(2)

    // A second split asks for the same source times: nothing decodes.
    await cache.ensure('a1', 'blob:one', [1, 2, 3], 0.01)
    expect(decode).toHaveBeenCalledTimes(1)
  })

  it('groups missing times into contiguous runs', async () => {
    const decode = vi.fn(async (_assetId: string, _url: string, times: readonly number[]) =>
      times.map((time) => frame(time)),
    )
    const cache = new ThumbnailCache(decode, true)
    await cache.ensure('a1', 'blob:one', [0, 0.5, 5, 5.5], 0.01)
    expect(decode).toHaveBeenCalledTimes(2)
    expect(decode.mock.calls[0][2]).toEqual([0, 0.5])
    expect(decode.mock.calls[1][2]).toEqual([5, 5.5])
  })

  it('returns the nearest frame only within tolerance', async () => {
    const decode = async (_assetId: string, _url: string, times: readonly number[]) =>
      times.map((time) => frame(time))
    const cache = new ThumbnailCache(decode, true)
    await cache.ensure('a1', 'blob:one', [2], 0.01)
    expect(cache.nearest('a1', 'blob:one', 2.005, 0.01)?.sourceTime).toBe(2)
    expect(cache.nearest('a1', 'blob:one', 2.5, 0.01)).toBeUndefined()
    expect(cache.nearest('a1', 'blob:two', 2, 0.01)).toBeUndefined()
  })

  it('reuses the left half for a split whose right grid lands within half a cell', async () => {
    const decode = vi.fn(async (_assetId: string, _url: string, times: readonly number[]) =>
      times.map((time) => frame(time)),
    )
    const cache = new ThumbnailCache(decode, true)
    // First generation: 25 cells over the 0..245s visible tile.
    const first = Array.from({ length: 25 }, (_, i) => (i + 0.5) * 10)
    await cache.ensure('a1', 'blob:one', first, 0.01)
    const firstCalls = decode.mock.calls.length
    expect(firstCalls).toBeGreaterThan(0)

    // A split at 10s re-phases the right half's 24 cells to 15, 25, ... 245.
    // Every one lands within half a cell of a cached frame: no decode.
    const right = Array.from({ length: 24 }, (_, i) => 15 + i * 10)
    await cache.ensure('a1', 'blob:one', right, 5.5, undefined, { start: 10, end: 903 })
    expect(decode).toHaveBeenCalledTimes(firstCalls)

    // The left half's window is 0..10s, so it can reuse the frame at 5 but
    // never one beyond its own cut.
    const head = [0.5, 2.5, 5, 9.5]
    await cache.ensure('a1', 'blob:one', head, 1.25, undefined, { start: 0, end: 10 })
    const decodedHead = decode.mock.calls.slice(firstCalls).flatMap((call) => call[2])
    expect(decodedHead).toEqual([0.5, 2.5, 9.5])
  })

  it('never reuses a frame outside the clip source window', async () => {
    const decode = vi.fn(async (_assetId: string, _url: string, times: readonly number[]) =>
      times.map((time) => frame(time)),
    )
    const cache = new ThumbnailCache(decode, true)
    await cache.ensure('a1', 'blob:one', [99.5], 0.01)
    // A clip trimmed to start at 100 must not borrow the frame at 99.5,
    // even though it is well inside the tolerance.
    await cache.ensure('a1', 'blob:one', [100], 1, undefined, { start: 100, end: 200 })
    expect(decode).toHaveBeenCalledTimes(2)
    expect(decode.mock.calls[1][2]).toEqual([100])
  })

  it('drops a relinked asset and closes its frames', async () => {
    const bitmap = new FakeBitmap()
    const decode = async (_assetId: string, _url: string, times: readonly number[]) =>
      times.map((time) => frame(time, bitmap))
    const cache = new ThumbnailCache(decode, true)
    await cache.ensure('a1', 'blob:one', [1], 0.01)
    cache.dropAsset('a1')
    expect(bitmap.closed).toBe(true)
    expect(cache.nearest('a1', 'blob:one', 1, 0.01)).toBeUndefined()
  })

  it('times out a stalled decode and closes its late frames', async () => {
    vi.useFakeTimers()
    try {
      const bitmap = new FakeBitmap()
      let finish!: () => void
      const decode = vi.fn(
        (_assetId: string, _url: string, times: readonly number[]) =>
          new Promise<ThumbnailFrame[]>((resolve) => {
            finish = () => resolve(times.map((time) => frame(time, bitmap)))
          }),
      )
      const cache = new ThumbnailCache(decode, true)
      const pending = cache.ensure('a1', 'blob:one', [1], 0.01)
      const rejection = expect(pending).rejects.toThrow('Thumbnail decode timed out')
      await vi.advanceTimersByTimeAsync(THUMBNAIL_DECODE_TIMEOUT_MS)
      await rejection

      // The decoder settles after the timeout: its frame must be closed, not
      // inserted into a cache that already moved on.
      finish()
      await Promise.resolve()
      await Promise.resolve()
      expect(bitmap.closed).toBe(true)
      expect(cache.nearest('a1', 'blob:one', 1, 0.01)).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('disposes the Input a timed-out lookup created and never registers it (0.18.0)', async () => {
    vi.useFakeTimers()
    try {
      let resolveTrack!: (value: unknown) => void
      media.tracks.push(
        new Promise<unknown>((resolve) => {
          resolveTrack = resolve
        }),
      )
      const cache = new ThumbnailCache(undefined, true)
      const pending = cache.ensure('a1', 'blob:one', [1], 0.01)
      const rejection = expect(pending).rejects.toThrow('Thumbnail decode timed out')
      await vi.advanceTimersByTimeAsync(THUMBNAIL_DECODE_TIMEOUT_MS)
      await rejection

      expect(media.inputs).toHaveLength(1)
      expect(media.inputs[0].disposed).toBe(true)

      // The lookup lands after the timeout. Its Input is already disposed and
      // must not be installed in the shared map.
      resolveTrack({})
      for (let i = 0; i < 8; i++) await Promise.resolve()
      expect((cache as unknown as { inputs: Map<string, unknown> }).inputs.size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('resolves a reset decode silently while disposing its Input (0.18.0)', async () => {
    let resolveTrack!: (value: unknown) => void
    media.tracks.push(
      new Promise<unknown>((resolve) => {
        resolveTrack = resolve
      }),
    )
    const cache = new ThumbnailCache(undefined, true)
    const pending = cache.ensure('a1', 'blob:one', [1], 0.01)
    cache.reset()
    expect(media.inputs).toHaveLength(1)
    expect(media.inputs[0].disposed).toBe(true)

    resolveTrack({})
    for (let i = 0; i < 8; i++) await Promise.resolve()
    await expect(pending).resolves.toBeUndefined()
    expect((cache as unknown as { inputs: Map<string, unknown> }).inputs.size).toBe(0)
  })

  it('resolves a dropped decode silently while disposing its Input (0.18.0)', async () => {
    let resolveTrack!: (value: unknown) => void
    media.tracks.push(
      new Promise<unknown>((resolve) => {
        resolveTrack = resolve
      }),
    )
    const cache = new ThumbnailCache(undefined, true)
    const pending = cache.ensure('a1', 'blob:one', [1], 0.01)
    cache.dropAsset('a1')
    expect(media.inputs).toHaveLength(1)
    expect(media.inputs[0].disposed).toBe(true)

    resolveTrack({})
    for (let i = 0; i < 8; i++) await Promise.resolve()
    await expect(pending).resolves.toBeUndefined()
    expect((cache as unknown as { inputs: Map<string, unknown> }).inputs.size).toBe(0)
  })

  it('still rejects a genuine decode failure (0.18.0)', async () => {
    media.tracks.push(Promise.resolve(null))
    const cache = new ThumbnailCache(undefined, true)
    await expect(cache.ensure('a1', 'blob:one', [1], 0.01)).rejects.toThrow('No video track')
  })

  it('clears per-asset bookkeeping on reset', async () => {
    const decode = async (_assetId: string, _url: string, times: readonly number[]) =>
      times.map((time) => frame(time))
    const cache = new ThumbnailCache(decode, true)
    await cache.ensure('a1', 'blob:one', [1], 0.01)
    cache.dropAsset('a1')
    const internals = cache as unknown as {
      assetEpochs: Map<string, number>
      latestRun: Map<string, number>
    }
    expect(internals.assetEpochs.size).toBe(1)
    expect(internals.latestRun.size).toBe(1)

    cache.reset()
    expect(internals.assetEpochs.size).toBe(0)
    expect(internals.latestRun.size).toBe(0)
  })

  it('drops frames that finish after the asset was dropped', async () => {
    const bitmap = new FakeBitmap()
    let finish!: () => void
    const decode = vi.fn(
      (_assetId: string, _url: string, times: readonly number[]) =>
        new Promise<ThumbnailFrame[]>((resolve) => {
          finish = () => resolve(times.map((time) => frame(time, bitmap)))
        }),
    )
    const cache = new ThumbnailCache(decode, true)

    const pending = cache.ensure('a1', 'blob:one', [1], 0.01)
    expect(decode).toHaveBeenCalledTimes(1)
    cache.dropAsset('a1')
    finish()
    await pending

    expect(bitmap.closed).toBe(true)
    expect(cache.nearest('a1', 'blob:one', 1, 0.01)).toBeUndefined()
  })

  it('does not let an old decode evict the new URL cache after a relink', async () => {
    const oldBitmap = new FakeBitmap()
    const newBitmap = new FakeBitmap()
    let finishOld!: () => void
    const decode = vi.fn((_assetId: string, url: string, times: readonly number[]) => {
      if (url === 'blob:old') {
        return new Promise<ThumbnailFrame[]>((resolve) => {
          finishOld = () => resolve(times.map((time) => frame(time, oldBitmap)))
        })
      }
      return Promise.resolve(times.map((time) => frame(time, newBitmap)))
    })
    const cache = new ThumbnailCache(decode, true)

    const oldRun = cache.ensure('a1', 'blob:old', [1], 0.01)
    cache.dropAsset('a1')
    await cache.ensure('a1', 'blob:new', [1], 0.01)
    finishOld()
    await oldRun

    expect(cache.nearest('a1', 'blob:new', 1, 0.01)?.frame).toBe(newBitmap)
    expect(cache.nearest('a1', 'blob:old', 1, 0.01)).toBeUndefined()
    expect(oldBitmap.closed).toBe(true)
    expect(newBitmap.closed).toBe(false)
  })

  it('evicts the frame farthest from the newly inserted one at the asset cap (0.18.0)', async () => {
    const decode = async (_assetId: string, _url: string, times: readonly number[]) =>
      times.map((time) => frame(time))
    const cache = new ThumbnailCache(decode, true)
    // Fill the cap with a high range, then insert a frame at the head. The
    // farthest frame is the high end, not the lowest source time.
    const high = Array.from({ length: THUMBNAIL_ASSET_FRAMES }, (_, i) => 1000 + i)
    await cache.ensure('a1', 'blob:one', high, 0.01)
    await cache.ensure('a1', 'blob:one', [0], 0.01)
    expect(cache.nearest('a1', 'blob:one', 0, 0.01)?.sourceTime).toBe(0)
    expect(cache.nearest('a1', 'blob:one', 1000, 0.01)?.sourceTime).toBe(1000)
    expect(cache.nearest('a1', 'blob:one', 1511, 0.01)).toBeUndefined()
  })

  it('bounds the cache by pixels', async () => {
    const big = new FakeBitmap()
    big.width = 4096
    big.height = 4096
    const decode = async (_assetId: string, _url: string, times: readonly number[]) =>
      times.map((time) => frame(time, big))
    const cache = new ThumbnailCache(decode, true)
    await cache.ensure('a1', 'blob:one', [1, 2], 0.01)
    // One 16MP frame already exceeds the 8MP budget, so the cache evicts.
    expect(cache.nearest('a1', 'blob:one', 1, 0.01)).toBeUndefined()
    expect(THUMBNAIL_CACHE_PIXELS).toBe(8_000_000)
  })
})
