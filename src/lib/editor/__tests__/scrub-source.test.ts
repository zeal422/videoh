import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createScrubFrameSource,
  SCRUB_DECODE_TIMEOUT_MS,
  ScrubFrameCacheSource,
  type ScrubDecoder,
  type ScrubFrameRequest,
} from '../playback/scrub-source'

/**
 * The per-clip scrub queue (0.18.0): one decode in flight, latest target wins,
 * last good frame retained, generations invalidate a stale frame, and failed
 * assets fall back to `<video>`.
 */

class FakeBitmap {
  closed = false
  close(): void {
    this.closed = true
  }
}

class FakeDecoder implements ScrubDecoder {
  requests: ScrubFrameRequest[] = []
  private pending: {
    resolve: (frame: CanvasImageSource) => void
    reject: (error: Error) => void
  }[] = []
  disposed = false
  releasedAssets: string[] = []
  releasedClips: string[] = []

  decode(request: ScrubFrameRequest): Promise<CanvasImageSource> {
    this.requests.push(request)
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject })
    })
  }

  resolveNext(frame: CanvasImageSource): void {
    this.pending.shift()?.resolve(frame)
  }

  rejectNext(error = new Error('decode failed')): void {
    this.pending.shift()?.reject(error)
  }

  releaseClip(clipId: string): void {
    this.releasedClips.push(clipId)
  }

  releaseAsset(assetId: string, effectiveUrl: string): void {
    this.releasedAssets.push(`${assetId}:${effectiveUrl}`)
  }

  reset(): void {}

  dispose(): void {
    this.disposed = true
  }
}

const request = (over: Partial<ScrubFrameRequest> = {}): ScrubFrameRequest => ({
  clipId: 'c1',
  assetId: 'a1',
  effectiveUrl: 'blob:one',
  sourceTime: 1,
  generation: 1,
  ...over,
})

const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

beforeEach(() => {
  vi.stubGlobal('ImageBitmap', FakeBitmap)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ScrubFrameCacheSource', () => {
  it('keeps the last good frame and returns it for the same generation', async () => {
    const decoder = new FakeDecoder()
    const source = new ScrubFrameCacheSource(decoder)
    const frame = new FakeBitmap() as unknown as CanvasImageSource
    const onFrame = vi.fn()

    expect(source.peek('c1', 1, 1)).toBeUndefined()
    source.request(request(), onFrame)
    decoder.resolveNext(frame)
    await flush()

    expect(onFrame).toHaveBeenCalledWith({ clipId: 'c1', frame, sourceTime: 1, generation: 1 })
    expect(source.peek('c1', 99, 1)).toBe(frame)
    expect(source.peek('c1', 99, 2)).toBeUndefined()

    source.releaseCachedFrame('c1')
    expect(source.peek('c1', 1, 1)).toBeUndefined()
  })

  it('drops an in-flight frame when a newer target arrives', async () => {
    const decoder = new FakeDecoder()
    const source = new ScrubFrameCacheSource(decoder)
    const first = new FakeBitmap()
    const second = new FakeBitmap()
    const firstCallback = vi.fn()
    const secondCallback = vi.fn()

    source.request(request({ sourceTime: 1 }), firstCallback)
    source.request(request({ sourceTime: 2 }), secondCallback)
    expect(decoder.requests).toHaveLength(1)

    decoder.resolveNext(first as unknown as CanvasImageSource)
    await flush()
    // The stale frame is closed and never delivered; the latest target decodes.
    expect(first.closed).toBe(true)
    expect(firstCallback).not.toHaveBeenCalled()
    expect(decoder.requests).toHaveLength(2)
    expect(decoder.requests[1].sourceTime).toBe(2)

    decoder.resolveNext(second as unknown as CanvasImageSource)
    await flush()
    expect(secondCallback).toHaveBeenCalledWith({
      clipId: 'c1',
      frame: second,
      sourceTime: 2,
      generation: 1,
    })
    expect(second.closed).toBe(false)
  })

  it('keeps two clips on the same asset independent', async () => {
    const decoder = new FakeDecoder()
    const source = new ScrubFrameCacheSource(decoder)
    const one = new FakeBitmap()
    const two = new FakeBitmap()

    source.request(request({ clipId: 'c1', sourceTime: 1 }), vi.fn())
    source.request(request({ clipId: 'c2', sourceTime: 1 }), vi.fn())
    expect(decoder.requests).toHaveLength(2)

    decoder.resolveNext(one as unknown as CanvasImageSource)
    decoder.resolveNext(two as unknown as CanvasImageSource)
    await flush()

    expect(source.peek('c1', 1, 1)).toBe(one)
    expect(source.peek('c2', 1, 1)).toBe(two)
  })

  it('releases the decoder asset when a decode times out', async () => {
    vi.useFakeTimers()
    try {
      const decoder = new FakeDecoder()
      const source = new ScrubFrameCacheSource(decoder)
      const fallback = vi.fn()
      source.onFallback(fallback)
      const onFrame = vi.fn()

      source.request(request(), onFrame)
      expect(decoder.requests).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(SCRUB_DECODE_TIMEOUT_MS)

      expect(decoder.releasedAssets).toEqual(['a1:blob:one'])
      expect(source.hasSink('a1', 'blob:one')).toBe(false)
      expect(fallback).toHaveBeenCalledWith('a1', 'blob:one')
      expect(onFrame).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('marks an asset failed and notifies the fallback listener', async () => {
    const decoder = new FakeDecoder()
    const source = new ScrubFrameCacheSource(decoder)
    const fallback = vi.fn()
    source.onFallback(fallback)

    source.request(request(), vi.fn())
    decoder.rejectNext()
    await flush()

    expect(source.hasSink('a1', 'blob:one')).toBe(false)
    expect(fallback).toHaveBeenCalledWith('a1', 'blob:one')
    // A different URL is a different source and is not failed.
    expect(source.hasSink('a1', 'blob:two')).toBe(true)
  })

  it('releases a clip cache and an asset Input', async () => {
    const decoder = new FakeDecoder()
    const source = new ScrubFrameCacheSource(decoder)
    const frame = new FakeBitmap()
    source.request(request(), vi.fn())
    decoder.resolveNext(frame as unknown as CanvasImageSource)
    await flush()

    source.releaseClip('c1')
    expect(frame.closed).toBe(true)
    expect(source.peek('c1', 1, 1)).toBeUndefined()
    expect(decoder.releasedClips).toEqual(['c1'])

    source.releaseAsset('a1', 'blob:one')
    expect(decoder.releasedAssets).toEqual(['a1:blob:one'])
  })

  it('keeps a queued request for another URL when the active URL is released', async () => {
    const decoder = new FakeDecoder()
    const source = new ScrubFrameCacheSource(decoder)
    const frameA = new FakeBitmap()
    const frameB = new FakeBitmap()
    const onA = vi.fn()
    const onB = vi.fn()

    source.request(request({ effectiveUrl: 'blob:a', sourceTime: 1 }), onA)
    source.request(request({ effectiveUrl: 'blob:b', sourceTime: 2 }), onB)
    expect(decoder.requests).toHaveLength(1)

    // Releasing A bumps the clip epoch while B is still queued behind A.
    source.releaseAsset('a1', 'blob:a')
    decoder.resolveNext(frameA as unknown as CanvasImageSource)
    await flush()

    expect(frameA.closed).toBe(true)
    expect(onA).not.toHaveBeenCalled()
    // B must decode, not inherit A's release as a stale stamp.
    expect(decoder.requests).toHaveLength(2)
    expect(decoder.requests[1].effectiveUrl).toBe('blob:b')

    decoder.resolveNext(frameB as unknown as CanvasImageSource)
    await flush()
    expect(onB).toHaveBeenCalledWith({
      clipId: 'c1',
      frame: frameB,
      sourceTime: 2,
      generation: 1,
    })
    expect(frameB.closed).toBe(false)
  })

  it('drops an in-flight frame after a clip release or a cache-only drop', async () => {
    const decoder = new FakeDecoder()
    const source = new ScrubFrameCacheSource(decoder)
    const frame = new FakeBitmap()
    const onFrame = vi.fn()

    source.request(request(), onFrame)
    source.releaseClip('c1')
    decoder.resolveNext(frame as unknown as CanvasImageSource)
    await flush()

    expect(frame.closed).toBe(true)
    expect(onFrame).not.toHaveBeenCalled()
    expect(source.peek('c1', 1, 1)).toBeUndefined()

    const decoder2 = new FakeDecoder()
    const source2 = new ScrubFrameCacheSource(decoder2)
    const frame2 = new FakeBitmap()
    const onFrame2 = vi.fn()

    source2.request(request(), onFrame2)
    source2.releaseCachedFrame('c1')
    decoder2.resolveNext(frame2 as unknown as CanvasImageSource)
    await flush()

    expect(frame2.closed).toBe(true)
    expect(onFrame2).not.toHaveBeenCalled()
    expect(source2.peek('c1', 1, 1)).toBeUndefined()
    expect(decoder2.releasedClips).toEqual([])

    const frame3 = new FakeBitmap()
    const onFrame3 = vi.fn()
    source2.request(request({ sourceTime: 2 }), onFrame3)
    decoder2.resolveNext(frame3 as unknown as CanvasImageSource)
    await flush()

    expect(onFrame3).toHaveBeenCalled()
    expect(source2.peek('c1', 2, 1)).toBe(frame3)
  })

  it('drops an in-flight frame or failure after the asset is released', async () => {
    const decoder = new FakeDecoder()
    const source = new ScrubFrameCacheSource(decoder)
    const fallback = vi.fn()
    source.onFallback(fallback)
    const frame = new FakeBitmap()
    const onFrame = vi.fn()

    source.request(request(), onFrame)
    source.releaseAsset('a1', 'blob:one')
    decoder.resolveNext(frame as unknown as CanvasImageSource)
    await flush()

    expect(frame.closed).toBe(true)
    expect(onFrame).not.toHaveBeenCalled()
    expect(source.hasSink('a1', 'blob:one')).toBe(true)
    expect(fallback).not.toHaveBeenCalled()

    // A failed decode from the released URL must not mark it failed either.
    const secondOnFrame = vi.fn()
    source.request(request({ sourceTime: 2 }), secondOnFrame)
    source.releaseAsset('a1', 'blob:one')
    decoder.rejectNext()
    await flush()

    expect(source.hasSink('a1', 'blob:one')).toBe(true)
    expect(fallback).not.toHaveBeenCalled()
    expect(secondOnFrame).not.toHaveBeenCalled()
  })

  it('drops an in-flight frame after reset', async () => {
    const decoder = new FakeDecoder()
    const source = new ScrubFrameCacheSource(decoder)
    const frame = new FakeBitmap()
    const onFrame = vi.fn()

    source.request(request(), onFrame)
    source.reset()
    decoder.resolveNext(frame as unknown as CanvasImageSource)
    await flush()

    expect(frame.closed).toBe(true)
    expect(onFrame).not.toHaveBeenCalled()
  })

  it('processes a new request after a released clip frame is dropped', async () => {
    const decoder = new FakeDecoder()
    const source = new ScrubFrameCacheSource(decoder)
    const first = new FakeBitmap()
    const second = new FakeBitmap()
    const firstCallback = vi.fn()
    const secondCallback = vi.fn()

    source.request(request({ sourceTime: 1 }), firstCallback)
    source.releaseClip('c1')
    source.request(request({ sourceTime: 2 }), secondCallback)
    decoder.resolveNext(first as unknown as CanvasImageSource)
    await flush()

    expect(first.closed).toBe(true)
    expect(firstCallback).not.toHaveBeenCalled()
    expect(decoder.requests).toHaveLength(2)

    decoder.resolveNext(second as unknown as CanvasImageSource)
    await flush()
    expect(secondCallback).toHaveBeenCalledWith({
      clipId: 'c1',
      frame: second,
      sourceTime: 2,
      generation: 1,
    })
  })

  it('closes cached frames and disposes the decoder', async () => {
    const decoder = new FakeDecoder()
    const source = new ScrubFrameCacheSource(decoder)
    const frame = new FakeBitmap()
    source.request(request(), vi.fn())
    decoder.resolveNext(frame as unknown as CanvasImageSource)
    await flush()

    source.dispose()
    expect(frame.closed).toBe(true)
    expect(decoder.disposed).toBe(true)
  })
})

describe('createScrubFrameSource worker transport', () => {
  class FakeWorker {
    static instances: FakeWorker[] = []
    onmessage: ((event: MessageEvent) => void) | null = null
    onerror: (() => void) | null = null
    messages: Record<string, unknown>[] = []
    terminated = false

    constructor() {
      FakeWorker.instances.push(this)
    }

    postMessage(message: Record<string, unknown>): void {
      this.messages.push(message)
    }

    terminate(): void {
      this.terminated = true
      this.onmessage = null
    }
  }

  function transport() {
    vi.stubGlobal('window', {})
    vi.stubGlobal('VideoDecoder', class {})
    vi.stubGlobal('OffscreenCanvas', class {})
    vi.stubGlobal('Worker', FakeWorker)
    FakeWorker.instances = []
    const source = createScrubFrameSource()
    expect(source).not.toBeNull()
    return { source: source!, worker: FakeWorker.instances[0] }
  }

  function lateFrame(worker: FakeWorker, bitmap: { close: ReturnType<typeof vi.fn> }): void {
    worker.onmessage?.({
      data: {
        type: 'frame',
        requestId: 1,
        clipId: 'c1',
        sourceTime: 1,
        generation: 1,
        bitmap,
      },
    } as MessageEvent)
  }

  it('rejects a released clip decode and closes its late frame', () => {
    const { source, worker } = transport()
    const onFrame = vi.fn()
    source.request(request(), onFrame)
    expect(worker.messages[0]).toMatchObject({ type: 'decode', requestId: 1 })

    source.releaseClip('c1')
    const bitmap = { close: vi.fn() }
    lateFrame(worker, bitmap)

    expect(bitmap.close).toHaveBeenCalledOnce()
    expect(onFrame).not.toHaveBeenCalled()
    source.dispose()
  })

  it('rejects a released asset decode and closes its late frame', () => {
    const { source, worker } = transport()
    const onFrame = vi.fn()
    source.request(request(), onFrame)
    expect(worker.messages[0]).toMatchObject({ type: 'decode', requestId: 1 })

    source.releaseAsset('a1', 'blob:one')
    const bitmap = { close: vi.fn() }
    lateFrame(worker, bitmap)

    expect(bitmap.close).toHaveBeenCalledOnce()
    expect(onFrame).not.toHaveBeenCalled()
    source.dispose()
  })
})
