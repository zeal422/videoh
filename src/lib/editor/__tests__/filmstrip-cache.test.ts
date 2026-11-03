// @vitest-environment jsdom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createClip, createDoc, createMediaAsset, createTrack } from '../factories'
import { filmstripPlan, MAX_STRIP_PIXELS } from '../filmstrip'
import {
  FILMSTRIP_CACHE_ENTRIES,
  FILMSTRIP_CACHE_PIXELS,
  disposeAll,
  disposeEntry,
  filmstripEntryCount,
  filmstripsReady,
  hasFilmstrip,
  filmstripProgressSnapshot,
  releaseFilmstrip,
  requestFilmstrip,
  setFilmstripImageLoader,
  setFilmstripThumbnailCache,
  subscribeFilmstripReadiness,
  syncFilmstrips,
  type FilmstripEntry,
} from '../media/filmstrip-cache'
import { THUMBNAIL_DECODE_TIMEOUT_MS, ThumbnailCache } from '../media/thumbnail-cache'
import { serializeDoc } from '../serialization'
import type { Clip, MediaAsset } from '../types'
import { installBrowserMocks, type MockHarness } from './mocks/browser-mocks'

const h: MockHarness = installBrowserMocks()

afterAll(() => h.uninstall())

function videoAsset(partial: Partial<MediaAsset> = {}): MediaAsset {
  return createMediaAsset({
    id: 'media-v',
    kind: 'video',
    duration: 10,
    width: 1920,
    height: 1080,
    url: 'blob:video',
    ...partial,
  })
}

function videoClip(partial: Partial<Clip> = {}): Clip {
  return createClip({ id: 'clip-a', mediaId: 'media-v', duration: 4, inPoint: 0, ...partial })
}

function imageAsset(id: string, partial: Partial<MediaAsset> = {}): MediaAsset {
  return createMediaAsset({
    id,
    kind: 'image',
    duration: 0,
    width: 800,
    height: 600,
    url: `blob:${id}`,
    ...partial,
  })
}

function planFor(clip: Clip, asset: MediaAsset, width = 500, height = 44) {
  const plan = filmstripPlan(clip, asset, width, height)
  if (!plan) throw new Error('expected a filmstrip plan')
  return plan
}

function callsOf(source: CanvasImageSource) {
  return (
    source as HTMLCanvasElement & { __fakeCtx?: { calls: { op: string; args: unknown[] }[] } }
  ).__fakeCtx?.calls
}

async function settle(max = 4000): Promise<void> {
  for (let i = 0; i < max; i++) {
    if (filmstripsReady()) return
    await Promise.resolve()
  }
  throw new Error('filmstrips did not settle')
}

/** Wraps the harness's currentTime setter to record every seek. */
function recordSeeks() {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime')
  if (!descriptor?.set || !descriptor.get) throw new Error('media mock missing currentTime')
  const seeks: number[] = []
  Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
    configurable: true,
    get: descriptor.get,
    set(this: HTMLMediaElement, value: number) {
      seeks.push(value)
      descriptor.set!.call(this, value)
    },
  })
  return {
    seeks,
    restore: () => Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', descriptor),
  }
}

beforeEach(() => {
  disposeAll()
  syncFilmstrips([], 'project-test')
  setFilmstripImageLoader(null)
})

afterEach(() => {
  disposeAll()
  document.body.innerHTML = ''
})

describe('filmstrip cache generation', () => {
  it('draws one cell per planned frame and installs one strip', async () => {
    const asset = videoAsset()
    const clip = videoClip()
    const plan = planFor(clip, asset, 500, 44)
    const onSettle = vi.fn()
    const seeks = recordSeeks()
    try {
      requestFilmstrip({ clipId: clip.id, plan, asset }, onSettle)
      expect(filmstripsReady()).toBe(false)
      await settle()
    } finally {
      seeks.restore()
    }

    expect(onSettle).toHaveBeenCalledTimes(1)
    const source = onSettle.mock.calls[0][0] as HTMLCanvasElement
    expect(source).toBeTruthy()
    const drawCalls = callsOf(source)?.filter((call) => call.op === 'drawImage') ?? []
    expect(drawCalls).toHaveLength(plan.frames.length)
    expect(seeks.seeks).toEqual(plan.frames.map((frame) => frame.sourceTime))
    expect(callsOf(source)?.length).toBeGreaterThan(0)
    expect(source.width).toBe(plan.widthBucket)
    expect(source.height).toBe(plan.heightBucket)
    expect(hasFilmstrip(plan.key)).toBe(true)
    expect(filmstripEntryCount()).toBe(1)
    expect(filmstripsReady()).toBe(true)
  })

  it('shares one job between two requests for the same key', async () => {
    const asset = videoAsset()
    const plan = planFor(videoClip(), asset, 500, 44)
    const first = vi.fn()
    const second = vi.fn()
    requestFilmstrip({ clipId: 'clip-a', plan, asset }, first)
    requestFilmstrip({ clipId: 'clip-b', plan, asset }, second)
    await settle()

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    expect(first.mock.calls[0][0]).toBe(second.mock.calls[0][0])
    expect(filmstripEntryCount()).toBe(1)
  })

  it('settles two distinct clips in turn and superseding one does not cancel the other', async () => {
    const asset = videoAsset()
    const planA = planFor(videoClip({ id: 'clip-a' }), asset, 500, 44)
    const planB = planFor(videoClip({ id: 'clip-b', inPoint: 1 }), asset, 900, 44)
    const planA2 = planFor(videoClip({ id: 'clip-a', inPoint: 1 }), asset, 500, 44)
    const a = vi.fn()
    const a2 = vi.fn()
    const b = vi.fn()
    const order: string[] = []
    a.mockImplementation(() => order.push('a'))
    a2.mockImplementation(() => order.push('a2'))
    b.mockImplementation(() => order.push('b'))

    requestFilmstrip({ clipId: 'clip-a', plan: planA, asset }, a)
    requestFilmstrip({ clipId: 'clip-b', plan: planB, asset }, b)
    requestFilmstrip({ clipId: 'clip-a', plan: planA2, asset }, a2)
    await settle()

    expect(b).toHaveBeenCalledTimes(1)
    expect(a2).toHaveBeenCalledTimes(1)
    expect(a).not.toHaveBeenCalled()
    expect(order).toEqual(['b', 'a2'])
    expect(hasFilmstrip(planA.key)).toBe(false)
    expect(hasFilmstrip(planA2.key)).toBe(true)
    expect(hasFilmstrip(planB.key)).toBe(true)
    expect(filmstripEntryCount()).toBe(2)
  })

  it('drops a queued retarget when the new bucket is already cached', async () => {
    const asset = videoAsset()
    const planA = planFor(videoClip({ id: 'clip-a' }), asset, 500, 44)
    const planA2 = planFor(videoClip({ id: 'clip-a', inPoint: 1 }), asset, 900, 44)
    const otherAsset = videoAsset({ id: 'media-b', url: 'blob:video-b' })
    const planB = planFor(videoClip({ id: 'clip-b', mediaId: 'media-b' }), otherAsset, 500, 44)
    const planB2 = planFor(videoClip({ id: 'clip-b', mediaId: 'media-b' }), otherAsset, 900, 44)
    const onA = vi.fn()
    const onA2 = vi.fn()
    const onA3 = vi.fn()

    requestFilmstrip({ clipId: 'clip-b', plan: planB, asset: otherAsset }, vi.fn())
    requestFilmstrip({ clipId: 'clip-a', plan: planA, asset }, onA)
    await settle()
    expect(hasFilmstrip(planA.key)).toBe(true)
    await settle()

    requestFilmstrip({ clipId: 'clip-b', plan: planB2, asset: otherAsset }, vi.fn())
    requestFilmstrip({ clipId: 'clip-a', plan: planA2, asset }, onA2)
    requestFilmstrip({ clipId: 'clip-a', plan: planA, asset }, onA3)
    const cachedCall = onA3.mock.calls[0]?.[0]
    expect(cachedCall).toBeTruthy()
    await settle()

    expect(onA2).not.toHaveBeenCalled()
    expect(onA3).toHaveBeenCalledTimes(1)
    expect(onA3.mock.calls[0][0]).toBe(cachedCall)
    expect(filmstripEntryCount()).toBe(3)
    expect(hasFilmstrip(planA.key)).toBe(true)
    expect(hasFilmstrip(planA2.key)).toBe(false)
  })

  it('cancels an active job when its clip is superseded', async () => {
    const asset = videoAsset()
    const firstPlan = planFor(videoClip({ id: 'clip-a' }), asset, 500, 44)
    const nextPlan = planFor(videoClip({ id: 'clip-a', inPoint: 1 }), asset, 500, 44)
    const first = vi.fn()
    const next = vi.fn()
    requestFilmstrip({ clipId: 'clip-a', plan: firstPlan, asset }, first)
    requestFilmstrip({ clipId: 'clip-a', plan: nextPlan, asset }, next)
    await settle()

    expect(first).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledTimes(1)
    expect(hasFilmstrip(firstPlan.key)).toBe(false)
    expect(hasFilmstrip(nextPlan.key)).toBe(true)
    expect(filmstripEntryCount()).toBe(1)
  })

  it('drains the queue FIFO and retargets a queued same-clip key in place', async () => {
    const asset = videoAsset()
    const planA = planFor(videoClip({ id: 'clip-a' }), asset, 500, 44)
    const planB = planFor(videoClip({ id: 'clip-b', inPoint: 0.5 }), asset, 700, 44)
    const planB2 = planFor(videoClip({ id: 'clip-b', inPoint: 1 }), asset, 900, 44)
    const planC = planFor(videoClip({ id: 'clip-c', inPoint: 2 }), asset, 1100, 44)
    const order: string[] = []
    const a = vi.fn(() => order.push('a'))
    const b = vi.fn(() => order.push('b'))
    const b2 = vi.fn(() => order.push('b2'))
    const c = vi.fn(() => order.push('c'))

    requestFilmstrip({ clipId: 'clip-a', plan: planA, asset }, a)
    requestFilmstrip({ clipId: 'clip-b', plan: planB, asset }, b)
    requestFilmstrip({ clipId: 'clip-c', plan: planC, asset }, c)
    requestFilmstrip({ clipId: 'clip-b', plan: planB2, asset }, b2)
    await settle()

    expect(b).not.toHaveBeenCalled()
    expect(order).toEqual(['a', 'b2', 'c'])
    expect(hasFilmstrip(planB.key)).toBe(false)
    expect(hasFilmstrip(planB2.key)).toBe(true)
    expect(hasFilmstrip(planC.key)).toBe(true)
  })

  it('clears the root marker on a new request and sets it after the strip settles', async () => {
    const asset = videoAsset()
    const plan = planFor(videoClip(), asset, 500, 44)
    const onSettle = vi.fn()
    const readiness = vi.fn()
    syncFilmstrips([asset], 'project-test')
    const unsubscribe = subscribeFilmstripReadiness(readiness)
    try {
      expect(filmstripsReady()).toBe(true)
      requestFilmstrip({ clipId: 'clip-a', plan, asset }, onSettle)
      expect(filmstripsReady()).toBe(false)
      await settle()
      expect(filmstripsReady()).toBe(true)
      expect(readiness.mock.calls.length).toBeGreaterThanOrEqual(2)
    } finally {
      unsubscribe()
    }
  })

  it('drops a cancelled job from the progress snapshot (0.18.0)', async () => {
    const asset = videoAsset()
    const plan = planFor(videoClip(), asset, 500, 44)
    const onSettle = vi.fn()
    requestFilmstrip({ clipId: 'clip-a', plan, asset }, onSettle)
    expect(filmstripProgressSnapshot().some((entry) => entry.key === plan.key)).toBe(true)
    releaseFilmstrip('clip-a')
    expect(filmstripProgressSnapshot().some((entry) => entry.key === plan.key)).toBe(false)
    await settle()
    expect(onSettle).not.toHaveBeenCalled()
  })

  it('ignores progress reported by a released job (0.18.0)', async () => {
    const asset = videoAsset()
    const plan = planFor(videoClip(), asset, 500, 44)
    let emit: ((progress: { completed: number; total: number }) => void) | undefined
    let finish: (() => void) | undefined
    const fake = {
      available: true,
      ensure: vi.fn(
        (
          _assetId: string,
          _url: string,
          _times: readonly number[],
          _tolerance: number,
          onProgress?: (progress: { completed: number; total: number }) => void,
        ) => {
          emit = onProgress
          return new Promise<void>((resolve) => {
            finish = resolve
          })
        },
      ),
      nearest: vi.fn(() => undefined),
      dropAsset: vi.fn(),
      reset: vi.fn(),
      dispose: vi.fn(),
    }
    setFilmstripThumbnailCache(fake as unknown as Parameters<typeof setFilmstripThumbnailCache>[0])
    try {
      requestFilmstrip({ clipId: 'clip-a', plan, asset }, vi.fn())
      expect(emit).toBeDefined()
      releaseFilmstrip('clip-a')
      expect(filmstripProgressSnapshot().some((entry) => entry.key === plan.key)).toBe(false)
      // The decode was already in flight. Its late progress must not put the
      // cleared bar back in the snapshot.
      emit?.({ completed: 1, total: 2 })
      expect(filmstripProgressSnapshot().some((entry) => entry.key === plan.key)).toBe(false)
      finish?.()
      await Promise.resolve()
    } finally {
      setFilmstripThumbnailCache(null)
    }
  })

  it('drops a completed image job from the progress snapshot (0.18.0)', async () => {
    const image = document.createElement('canvas')
    image.width = 800
    image.height = 600
    setFilmstripImageLoader(async () => image)
    const asset = imageAsset('media-progress-image')
    const plan = planFor(videoClip({ id: 'clip-progress', mediaId: asset.id }), asset, 500, 44)
    requestFilmstrip({ clipId: 'clip-progress', plan, asset }, vi.fn())
    await settle()
    expect(filmstripProgressSnapshot().some((entry) => entry.key === plan.key)).toBe(false)
  })

  it('falls back to element seeks when the thumbnail cache throws (0.18.0)', async () => {
    const asset = videoAsset()
    const plan = planFor(videoClip(), asset, 500, 44)
    const fake = {
      available: true,
      ensure: vi.fn(async () => {
        throw new Error('decode failed')
      }),
      nearest: vi.fn(() => undefined),
      dropAsset: vi.fn(),
      reset: vi.fn(),
      dispose: vi.fn(),
    }
    setFilmstripThumbnailCache(fake as unknown as Parameters<typeof setFilmstripThumbnailCache>[0])
    const onSettle = vi.fn()
    try {
      requestFilmstrip({ clipId: 'clip-a', plan, asset }, onSettle)
      await settle()
    } finally {
      setFilmstripThumbnailCache(null)
    }
    expect(fake.ensure).toHaveBeenCalled()
    expect(onSettle).toHaveBeenCalledTimes(1)
    expect(onSettle.mock.calls[0][0]).toBeTruthy()
    expect(document.querySelectorAll('video')).toHaveLength(1)
  })

  it('does not let a stalled thumbnail decode block the next filmstrip job (0.18.0)', async () => {
    vi.useFakeTimers()
    try {
      const assetA = videoAsset({ id: 'media-a', url: 'blob:a' })
      const assetB = videoAsset({ id: 'media-b', url: 'blob:b' })
      const planA = planFor(videoClip({ id: 'clip-a', mediaId: 'media-a' }), assetA, 500, 44)
      const planB = planFor(videoClip({ id: 'clip-b', mediaId: 'media-b' }), assetB, 500, 44)
      const canvas = document.createElement('canvas')
      canvas.width = 10
      canvas.height = 10
      const decode = vi.fn(
        (
          _assetId: string,
          url: string,
          times: readonly number[],
        ): Promise<
          {
            sourceTime: number
            frame: CanvasImageSource
            width: number
            height: number
            pixels: number
          }[]
        > => {
          if (url === 'blob:a') return new Promise(() => undefined)
          return Promise.resolve(
            times.map((time) => ({
              sourceTime: time,
              frame: canvas,
              width: 10,
              height: 10,
              pixels: 100,
            })),
          )
        },
      )
      setFilmstripThumbnailCache(new ThumbnailCache(decode, true))
      const first = vi.fn()
      const second = vi.fn()
      requestFilmstrip({ clipId: 'clip-a', plan: planA, asset: assetA }, first)
      requestFilmstrip({ clipId: 'clip-b', plan: planB, asset: assetB }, second)
      expect(decode).toHaveBeenCalledTimes(1)

      // The first asset's decode never settles. Its timeout must release the
      // job lane so the queued strip still runs.
      await vi.advanceTimersByTimeAsync(THUMBNAIL_DECODE_TIMEOUT_MS)
      await settle()

      expect(first).toHaveBeenCalledTimes(1)
      expect(second).toHaveBeenCalledTimes(1)
      expect(decode.mock.calls.some((call) => call[1] === 'blob:b')).toBe(true)
    } finally {
      setFilmstripThumbnailCache(null)
      vi.useRealTimers()
    }
  })

  it('treats an invalid backing size as settled without allocating a canvas', () => {
    const asset = videoAsset()
    const plan = { ...planFor(videoClip(), asset, 500, 44), widthBucket: 4097, heightBucket: 64 }
    const onSettle = vi.fn()
    requestFilmstrip({ clipId: 'clip-a', plan, asset }, onSettle)
    expect(onSettle).toHaveBeenCalledWith(null)
    expect(filmstripsReady()).toBe(true)
    expect(filmstripEntryCount()).toBe(0)
    expect(document.querySelectorAll('video')).toHaveLength(0)
  })

  it('rejects offline media without creating a hidden element', () => {
    const asset = videoAsset({ url: '', missing: true })
    const plan = planFor(videoClip(), videoAsset(), 500, 44)
    const onSettle = vi.fn()
    requestFilmstrip({ clipId: 'clip-a', plan, asset }, onSettle)
    expect(onSettle).toHaveBeenCalledWith(null)
    expect(filmstripsReady()).toBe(true)
    expect(document.querySelectorAll('video')).toHaveLength(0)
    expect(filmstripEntryCount()).toBe(0)
  })

  it('falls back to the poster when a seek fails, without throwing', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime')
    if (!descriptor?.get) throw new Error('media mock missing currentTime')
    Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
      configurable: true,
      get: descriptor.get,
      set() {
        throw new Error('seek failed')
      },
    })
    const onSettle = vi.fn()
    try {
      const asset = videoAsset()
      const plan = planFor(videoClip(), asset, 500, 44)
      requestFilmstrip({ clipId: 'clip-a', plan, asset }, onSettle)
      await settle()
      expect(onSettle).toHaveBeenCalledWith(null)
      expect(filmstripsReady()).toBe(true)
      expect(hasFilmstrip(plan.key)).toBe(false)
      expect(filmstripEntryCount()).toBe(0)
    } finally {
      Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', descriptor)
    }
  })

  it('cancels a queued job when its clip unmounts', async () => {
    const asset = videoAsset()
    const planA = planFor(videoClip({ id: 'clip-a' }), asset, 500, 44)
    const planB = planFor(videoClip({ id: 'clip-b', inPoint: 1 }), asset, 900, 44)
    const a = vi.fn()
    const b = vi.fn()
    requestFilmstrip({ clipId: 'clip-a', plan: planA, asset }, a)
    requestFilmstrip({ clipId: 'clip-b', plan: planB, asset }, b)
    releaseFilmstrip('clip-b')
    await settle()

    expect(a).toHaveBeenCalledTimes(1)
    expect(b).not.toHaveBeenCalled()
    expect(hasFilmstrip(planB.key)).toBe(false)
  })

  it('settles a re-request after releasing an active job', async () => {
    const asset = videoAsset()
    const clip = videoClip()
    const plan = planFor(clip, asset, 500, 44)
    const first = vi.fn()
    const second = vi.fn()
    requestFilmstrip({ clipId: clip.id, plan, asset }, first)
    releaseFilmstrip(clip.id)
    requestFilmstrip({ clipId: clip.id, plan, asset }, second)
    await settle()

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
    expect(second.mock.calls[0][0]).toBeTruthy()
    expect(hasFilmstrip(plan.key)).toBe(true)
    expect(filmstripsReady()).toBe(true)
  })

  it('cancels an active job when its clip unmounts', async () => {
    const asset = videoAsset()
    const plan = planFor(videoClip(), asset, 500, 44)
    const onSettle = vi.fn()
    requestFilmstrip({ clipId: 'clip-a', plan, asset }, onSettle)
    releaseFilmstrip('clip-a')
    expect(filmstripsReady()).toBe(true)
    await settle()
    expect(onSettle).not.toHaveBeenCalled()
    expect(hasFilmstrip(plan.key)).toBe(false)
  })
})

describe('filmstrip cache invalidation and memory', () => {
  it('disposes the old entry and hidden element on relink', async () => {
    const asset = videoAsset()
    const plan = planFor(videoClip(), asset, 500, 44)
    syncFilmstrips([asset], 'project-relink')
    const first = vi.fn()
    requestFilmstrip({ clipId: 'clip-a', plan, asset }, first)
    await settle()
    const oldCanvas = first.mock.calls[0][0] as HTMLCanvasElement
    expect(document.querySelectorAll('video')).toHaveLength(1)

    const relinked = videoAsset({ url: 'blob:video-v2' })
    const second = vi.fn()
    requestFilmstrip({ clipId: 'clip-a', plan, asset: relinked }, second)
    await settle()

    expect(oldCanvas.width).toBe(0)
    expect(oldCanvas.height).toBe(0)
    expect(second).toHaveBeenCalledTimes(1)
    const newCanvas = second.mock.calls[0][0] as HTMLCanvasElement
    expect(newCanvas).not.toBe(oldCanvas)
    expect(newCanvas.width).toBe(plan.widthBucket)
    expect(filmstripEntryCount()).toBe(1)
    expect(document.querySelectorAll('video')).toHaveLength(1)
  })

  it('drops the old source, not the incoming one, when a clip changes asset', async () => {
    const assetA = videoAsset({ id: 'media-a', url: 'blob:a' })
    const assetC = videoAsset({ id: 'media-c', url: 'blob:c' })
    const planA = planFor(videoClip({ id: 'clip-a', mediaId: 'media-a' }), assetA, 500, 44)
    const planC = planFor(videoClip({ id: 'clip-c', mediaId: 'media-c' }), assetC, 500, 44)
    syncFilmstrips([assetA, assetC], 'project-source-change')
    const first = vi.fn()
    const shared = vi.fn()
    requestFilmstrip({ clipId: 'clip-a', plan: planA, asset: assetA }, first)
    requestFilmstrip({ clipId: 'clip-c', plan: planC, asset: assetC }, shared)
    await settle()
    const oldCanvas = first.mock.calls[0][0] as HTMLCanvasElement
    const sharedCanvas = shared.mock.calls[0][0] as HTMLCanvasElement

    const changedPlan = planFor(videoClip({ id: 'clip-a', mediaId: 'media-c' }), assetC, 500, 44)
    const changed = vi.fn()
    requestFilmstrip({ clipId: 'clip-a', plan: changedPlan, asset: assetC }, changed)
    await settle()

    // The old asset's strip is gone; the incoming asset's strip for another
    // clip is untouched, and the changed clip generates its own new strip.
    expect(oldCanvas.width).toBe(0)
    expect(sharedCanvas.width).toBe(planC.widthBucket)
    // The changed clip shares the incoming asset's cached strip; it must not
    // dispose and regenerate that strip.
    expect(changed.mock.calls[0][0]).toBe(sharedCanvas)
    expect(filmstripEntryCount()).toBe(1)
    expect(document.querySelectorAll('video')).toHaveLength(1)
  })

  it('keeps another clip on the old source when one clip changes asset', async () => {
    const assetA = videoAsset({ id: 'media-a', url: 'blob:a' })
    const assetC = videoAsset({ id: 'media-c', url: 'blob:c' })
    const planA1 = planFor(videoClip({ id: 'clip-a1', mediaId: 'media-a' }), assetA, 500, 44)
    const planA2 = planFor(videoClip({ id: 'clip-a2', mediaId: 'media-a' }), assetA, 500, 44)
    syncFilmstrips([assetA, assetC], 'project-shared-source')
    const first = vi.fn()
    const other = vi.fn()
    requestFilmstrip({ clipId: 'clip-a1', plan: planA1, asset: assetA }, first)
    requestFilmstrip({ clipId: 'clip-a2', plan: planA2, asset: assetA }, other)
    await settle()
    const otherCanvas = other.mock.calls[0][0] as HTMLCanvasElement

    const changedPlan = planFor(videoClip({ id: 'clip-a1', mediaId: 'media-c' }), assetC, 500, 44)
    requestFilmstrip({ clipId: 'clip-a1', plan: changedPlan, asset: assetC }, vi.fn())
    await settle()

    // clip-a2 still uses the old asset: its strip and the shared element stay.
    expect(otherCanvas.width).toBe(planA2.widthBucket)
    expect(hasFilmstrip(planA2.key)).toBe(true)
    expect(document.querySelectorAll('video')).toHaveLength(2)
  })

  it('retries a failed strip after a relink', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime')
    if (!descriptor?.get) throw new Error('media mock missing currentTime')
    Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
      configurable: true,
      get: descriptor.get,
      set() {
        throw new Error('seek failed')
      },
    })
    const first = vi.fn()
    const asset = videoAsset()
    const plan = planFor(videoClip(), asset, 500, 44)
    try {
      requestFilmstrip({ clipId: 'clip-a', plan, asset }, first)
      await settle()
      expect(first).toHaveBeenCalledWith(null)
      expect(hasFilmstrip(plan.key)).toBe(false)
    } finally {
      Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', descriptor)
    }

    const relinked = videoAsset({ url: 'blob:video-v2' })
    const second = vi.fn()
    requestFilmstrip({ clipId: 'clip-a', plan, asset: relinked }, second)
    await settle()
    expect(second.mock.calls[0][0]).toBeTruthy()
    expect(hasFilmstrip(plan.key)).toBe(true)
  })

  it('removes an asset: entries, hidden element, and a null settle', async () => {
    const asset = videoAsset()
    const plan = planFor(videoClip(), asset, 500, 44)
    syncFilmstrips([asset], 'project-remove')
    const onSettle = vi.fn()
    requestFilmstrip({ clipId: 'clip-a', plan, asset }, onSettle)
    await settle()
    expect(filmstripEntryCount()).toBe(1)
    expect(document.querySelectorAll('video')).toHaveLength(1)

    syncFilmstrips([], 'project-remove')
    expect(filmstripEntryCount()).toBe(0)
    expect(document.querySelectorAll('video')).toHaveLength(0)
    expect(onSettle.mock.calls[onSettle.mock.calls.length - 1]).toEqual([null])
    expect(filmstripsReady()).toBe(true)
  })

  it('project replacement clears entries, cancels jobs, and disposes hidden elements', async () => {
    const asset = videoAsset()
    const plan = planFor(videoClip(), asset, 500, 44)
    syncFilmstrips([asset], 'project-old')
    const first = vi.fn()
    const pending = vi.fn()
    requestFilmstrip({ clipId: 'clip-a', plan, asset }, first)
    await settle()
    const pendingPlan = planFor(videoClip({ id: 'clip-b', inPoint: 1 }), asset, 900, 44)
    requestFilmstrip({ clipId: 'clip-b', plan: pendingPlan, asset }, pending)
    expect(filmstripEntryCount()).toBe(1)

    syncFilmstrips([], 'project-new')
    expect(filmstripEntryCount()).toBe(0)
    expect(document.querySelectorAll('video')).toHaveLength(0)
    expect(pending).toHaveBeenCalledWith(null)
    expect(filmstripsReady()).toBe(true)
    await settle()
    expect(hasFilmstrip(pendingPlan.key)).toBe(false)
  })

  it('evicts the least recently used entry at the cap and disposes it', async () => {
    const image = document.createElement('canvas')
    image.width = 800
    image.height = 600
    setFilmstripImageLoader(async () => image)
    const plans = Array.from({ length: FILMSTRIP_CACHE_ENTRIES + 1 }, (_, index) => {
      const asset = imageAsset(`media-i-${index}`)
      return {
        asset,
        plan: planFor(videoClip({ id: `clip-${index}`, mediaId: asset.id }), asset, 4096, 64),
      }
    })
    const firstCallbacks: ReturnType<typeof vi.fn>[] = []
    for (let index = 0; index < FILMSTRIP_CACHE_ENTRIES; index++) {
      const onSettle = vi.fn()
      firstCallbacks.push(onSettle)
      requestFilmstrip(
        { clipId: `clip-${index}`, plan: plans[index].plan, asset: plans[index].asset },
        onSettle,
      )
    }
    await settle()
    expect(filmstripEntryCount()).toBe(FILMSTRIP_CACHE_ENTRIES)
    expect(hasFilmstrip(plans[0].plan.key)).toBe(true)

    const last = vi.fn()
    requestFilmstrip(
      {
        clipId: `clip-${FILMSTRIP_CACHE_ENTRIES}`,
        plan: plans[FILMSTRIP_CACHE_ENTRIES].plan,
        asset: plans[FILMSTRIP_CACHE_ENTRIES].asset,
      },
      last,
    )
    await settle()
    expect(filmstripEntryCount()).toBe(FILMSTRIP_CACHE_ENTRIES)
    expect(hasFilmstrip(plans[0].plan.key)).toBe(false)
    expect(hasFilmstrip(plans[FILMSTRIP_CACHE_ENTRIES].plan.key)).toBe(true)
    const evicted = firstCallbacks[0].mock.calls[0][0] as HTMLCanvasElement
    expect(evicted.width).toBe(0)
    expect(evicted.height).toBe(0)
  })

  it('keeps forty max-size 4096x64 strips inside the 16MP budget', () => {
    expect(FILMSTRIP_CACHE_ENTRIES * 4096 * 44).toBeLessThan(FILMSTRIP_CACHE_PIXELS)
    expect(FILMSTRIP_CACHE_ENTRIES * 4096 * 64).toBeLessThan(FILMSTRIP_CACHE_PIXELS)
    expect(4096 * 64).toBe(MAX_STRIP_PIXELS)
  })

  it('disposeEntry closes a bitmap and zeroes a canvas', () => {
    const close = vi.fn()
    const bitmap: FilmstripEntry = {
      key: 'bitmap',
      assetId: 'a',
      sourceKind: 'bitmap',
      source: { close } as unknown as ImageBitmap,
      width: 4,
      height: 4,
      pixels: 16,
    }
    disposeEntry(bitmap)
    expect(close).toHaveBeenCalledTimes(1)

    const canvas = document.createElement('canvas')
    canvas.width = 10
    canvas.height = 10
    disposeEntry({
      key: 'canvas',
      assetId: 'a',
      sourceKind: 'canvas',
      source: canvas,
      width: 10,
      height: 10,
      pixels: 100,
    })
    expect(canvas.width).toBe(0)
    expect(canvas.height).toBe(0)
  })

  it('caps a one-hour clip at a 4096px backing canvas', async () => {
    const asset = videoAsset({ duration: 3600 })
    const clip = videoClip({ duration: 3600 })
    const plan = planFor(clip, asset, 1_440_000, 44)
    expect(plan.widthBucket).toBe(4096)
    const onSettle = vi.fn()
    requestFilmstrip({ clipId: clip.id, plan, asset }, onSettle)
    await settle()
    const canvas = onSettle.mock.calls[0][0] as HTMLCanvasElement
    expect(canvas.width).toBe(4096)
    expect(canvas.width * canvas.height).toBeLessThanOrEqual(MAX_STRIP_PIXELS)
  })
})

describe('image strips', () => {
  it('draws once, never seeks, and reuses the same image key across clip edits', async () => {
    const image = document.createElement('canvas')
    image.width = 800
    image.height = 600
    const loader = vi.fn(async () => image)
    setFilmstripImageLoader(loader)
    const asset = imageAsset('media-image')
    const firstClip = videoClip({ id: 'clip-a', mediaId: asset.id, inPoint: 0, duration: 4 })
    const secondClip = videoClip({
      id: 'clip-b',
      mediaId: asset.id,
      inPoint: 3,
      duration: 1,
      speed: 2,
      reverse: true,
      keyframes: { timeScale: [{ time: 0, value: 2 }] },
    })
    const firstPlan = planFor(firstClip, asset, 500, 44)
    const secondPlan = planFor(secondClip, asset, 500, 44)
    expect(secondPlan.key).toBe(firstPlan.key)
    const seeks = recordSeeks()
    const onSettle = vi.fn()
    try {
      requestFilmstrip({ clipId: firstClip.id, plan: firstPlan, asset }, onSettle)
      await settle()
    } finally {
      seeks.restore()
    }
    expect(loader).toHaveBeenCalledTimes(1)
    expect(seeks.seeks).toEqual([])
    const canvas = onSettle.mock.calls[0][0] as HTMLCanvasElement
    const draws = callsOf(canvas)?.filter((call) => call.op === 'drawImage') ?? []
    expect(draws).toHaveLength(1)
    expect(document.querySelectorAll('video')).toHaveLength(0)

    const second = vi.fn()
    requestFilmstrip({ clipId: secondClip.id, plan: secondPlan, asset }, second)
    expect(second).toHaveBeenCalledTimes(1)
    expect(second.mock.calls[0][0]).toBe(canvas)
    expect(loader).toHaveBeenCalledTimes(1)
    expect(filmstripEntryCount()).toBe(1)
  })

  it('falls back when the image loader rejects', async () => {
    setFilmstripImageLoader(async () => {
      throw new Error('decode failed')
    })
    const asset = imageAsset('media-bad')
    const clip = videoClip({ id: 'clip-bad', mediaId: asset.id })
    const plan = planFor(clip, asset, 500, 44)
    const onSettle = vi.fn()
    requestFilmstrip({ clipId: clip.id, plan, asset }, onSettle)
    await settle()
    expect(onSettle).toHaveBeenCalledWith(null)
    expect(hasFilmstrip(plan.key)).toBe(false)
    expect(filmstripsReady()).toBe(true)
  })
})

describe('runtime-only guarantee', () => {
  it('leaves the serialized doc byte-identical after a strip installs', async () => {
    const asset = videoAsset()
    const clip = videoClip()
    const doc = createDoc()
    doc.media = [asset]
    doc.project.tracks = [createTrack('video', 1, { clips: [clip] })]
    const savedAt = '2026-10-27T00:00:00.000Z'
    const before = JSON.stringify(serializeDoc(doc, savedAt))
    const plan = planFor(clip, asset, 500, 44)
    requestFilmstrip({ clipId: clip.id, plan, asset }, vi.fn())
    await settle()
    expect(JSON.stringify(serializeDoc(doc, savedAt))).toBe(before)
    expect(before.toLowerCase()).not.toContain('filmstrip')
  })
})
