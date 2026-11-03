import { describe, expect, it } from 'vitest'

import { createClip, createMediaAsset, sourceTimeAt } from '../factories'
import {
  MAX_STRIP_HEIGHT,
  MAX_STRIP_PIXELS,
  MAX_STRIP_WIDTH,
  filmstripBuckets,
  filmstripCacheKey,
  filmstripCanvasFits,
  filmstripFrameCount,
  filmstripPlan,
  filmstripPrefetchTimes,
  filmstripSamples,
} from '../filmstrip'
import type { Clip, MediaAsset } from '../types'

function videoAsset(partial: Partial<MediaAsset> = {}): MediaAsset {
  return createMediaAsset({
    kind: 'video',
    duration: 10,
    width: 1920,
    height: 1080,
    url: 'blob:video',
    ...partial,
  })
}

function videoClip(partial: Partial<Clip> = {}): Clip {
  return createClip({ mediaId: 'media-v', duration: 4, inPoint: 0, ...partial })
}

describe('filmstripFrameCount', () => {
  it.each([
    [0, 0],
    [23, 0],
    [24, 4],
    [25, 4],
    [100, 4],
    [500, 8],
    [2000, 24],
    [5000, 24],
    [1_440_000, 24],
  ])('uses %s layout pixels for %s cells', (width, count) => {
    expect(filmstripFrameCount(width)).toBe(count)
  })

  it('treats a non-finite width as no strip', () => {
    expect(filmstripFrameCount(Number.NaN)).toBe(0)
    expect(filmstripFrameCount(Number.POSITIVE_INFINITY)).toBe(0)
  })
})

describe('filmstripBuckets', () => {
  it('rounds width to 64px steps and height to whole pixels', () => {
    expect(filmstripBuckets(100, 44)).toEqual({ widthBucket: 128, heightBucket: 44 })
    expect(filmstripBuckets(500, 44)).toEqual({ widthBucket: 512, heightBucket: 44 })
  })

  it('caps both dimensions at the strip maximum', () => {
    expect(filmstripBuckets(5000, 100)).toEqual({
      widthBucket: MAX_STRIP_WIDTH,
      heightBucket: MAX_STRIP_HEIGHT,
    })
  })

  it('returns null below 24px or for a non-finite dimension', () => {
    expect(filmstripBuckets(23, 44)).toBeNull()
    expect(filmstripBuckets(100, Number.NaN)).toBeNull()
    expect(filmstripBuckets(Number.POSITIVE_INFINITY, 44)).toBeNull()
  })
})

describe('filmstripCanvasFits', () => {
  it('accepts the maximum strip and rejects anything over it', () => {
    expect(filmstripCanvasFits(MAX_STRIP_WIDTH, MAX_STRIP_HEIGHT)).toBe(true)
    expect(filmstripCanvasFits(4096, 44)).toBe(true)
    expect(filmstripCanvasFits(4097, 64)).toBe(false)
    expect(filmstripCanvasFits(4096, 65)).toBe(false)
    expect(filmstripCanvasFits(0, 44)).toBe(false)
    expect(filmstripCanvasFits(Number.NaN, 44)).toBe(false)
    expect(filmstripCanvasFits(Number.POSITIVE_INFINITY, 44)).toBe(false)
    expect(MAX_STRIP_PIXELS).toBe(MAX_STRIP_WIDTH * MAX_STRIP_HEIGHT)
  })
})

describe('filmstripSamples', () => {
  const asset = videoAsset()

  it('rejects a missing asset, audio, image, text, and compound clips', () => {
    expect(filmstripSamples(videoClip(), undefined, 100, 44)).toBeNull()
    expect(
      filmstripSamples(videoClip(), videoAsset({ kind: 'audio', missing: undefined }), 100, 44),
    ).toBeNull()
    expect(
      filmstripSamples(videoClip(), videoAsset({ kind: 'image', missing: undefined }), 100, 44),
    ).toBeNull()
    expect(filmstripSamples(videoClip({ text: 'Title' }), asset, 100, 44)).toBeNull()
    expect(filmstripSamples(videoClip({ sequenceId: 'seq-1' }), asset, 100, 44)).toBeNull()
    expect(filmstripSamples(videoClip({ audioOnly: true }), asset, 100, 44)).toBeNull()
    expect(filmstripSamples(videoClip(), videoAsset({ missing: true }), 100, 44)).toBeNull()
    expect(filmstripSamples(videoClip({ duration: 0 }), asset, 100, 44)).toBeNull()
    expect(filmstripSamples(videoClip(), asset, 23, 44)).toBeNull()
  })

  it('samples cell centers and spaces normalized x evenly', () => {
    const samples = filmstripSamples(videoClip(), asset, 500, 44)
    expect(samples).not.toBeNull()
    const frames = samples!.frames
    expect(frames).toHaveLength(8)
    expect(frames.map((f) => f.x)).toEqual([
      0.0625, 0.1875, 0.3125, 0.4375, 0.5625, 0.6875, 0.8125, 0.9375,
    ])
    expect(frames[0].local).toBeCloseTo(0.25, 6)
    expect(frames[frames.length - 1].local).toBeCloseTo(3.75, 6)
  })

  it('reads a forward clip through sourceTimeAt', () => {
    const clip = videoClip({ inPoint: 0.5, duration: 4, speed: 1 })
    const samples = filmstripSamples(clip, asset, 500, 44)!
    for (const frame of samples.frames) {
      expect(frame.sourceTime).toBeCloseTo(sourceTimeAt(clip, frame.local), 6)
      expect(frame.sourceTime).toBeCloseTo(clip.inPoint + frame.local, 6)
    }
  })

  it('starts a trimmed clip at its new in point', () => {
    const clip = videoClip({ inPoint: 1.5, duration: 2 })
    const samples = filmstripSamples(clip, asset, 500, 44)!
    expect(samples.frames[0].sourceTime).toBeGreaterThanOrEqual(1.5)
    expect(samples.frames[samples.frames.length - 1].sourceTime).toBeLessThanOrEqual(3.5)
  })

  it('descends on a reversed clip', () => {
    const clip = videoClip({ inPoint: 1, duration: 2, reverse: true })
    const samples = filmstripSamples(clip, asset, 500, 44)!
    for (let i = 1; i < samples.frames.length; i++) {
      expect(samples.frames[i].sourceTime).toBeLessThan(samples.frames[i - 1].sourceTime)
      expect(samples.frames[i].sourceTime).toBeCloseTo(
        sourceTimeAt(clip, samples.frames[i].local),
        6,
      )
    }
  })

  it('consumes the source span at half and double speed', () => {
    const half = filmstripSamples(videoClip({ speed: 0.5 }), asset, 500, 44)!
    const double = filmstripSamples(videoClip({ speed: 2 }), asset, 500, 44)!
    expect(half.frames[half.frames.length - 1].sourceTime).toBeCloseTo(3.75 * 0.5, 6)
    expect(double.frames[double.frames.length - 1].sourceTime).toBeCloseTo(3.75 * 2, 6)
  })

  it('follows a time-remap curve', () => {
    const clip = videoClip({
      keyframes: {
        timeScale: [
          { time: 0, value: 1 },
          { time: 4, value: 2 },
        ],
      },
    })
    const samples = filmstripSamples(clip, asset, 500, 44)!
    for (const frame of samples.frames) {
      expect(frame.sourceTime).toBeCloseTo(sourceTimeAt(clip, frame.local), 6)
    }
  })

  it('clamps at the asset end and never returns a negative upper bound', () => {
    const end = filmstripSamples(videoClip({ duration: 4 }), videoAsset({ duration: 2 }), 500, 44)!
    for (const frame of end.frames) {
      expect(frame.sourceTime).toBeLessThanOrEqual(2 - 0.01 + 1e-9)
    }
    const short = filmstripSamples(
      videoClip({ duration: 4 }),
      videoAsset({ duration: 0.005 }),
      500,
      44,
    )!
    for (const frame of short.frames) expect(frame.sourceTime).toBe(0)
  })

  it('never returns NaN, negative, or past-end source times', () => {
    const cases = [
      videoClip(),
      videoClip({ inPoint: 1, duration: 2, reverse: true }),
      videoClip({ speed: 2 }),
      videoClip({
        keyframes: {
          timeScale: [
            { time: 0, value: 2 },
            { time: 4, value: 0.5 },
          ],
        },
      }),
    ]
    for (const clip of cases) {
      const samples = filmstripSamples(clip, asset, 2000, 64)!
      for (const frame of samples.frames) {
        expect(Number.isFinite(frame.sourceTime)).toBe(true)
        expect(frame.sourceTime).toBeGreaterThanOrEqual(0)
        expect(frame.sourceTime).toBeLessThanOrEqual(asset.duration - 0.01 + 1e-9)
      }
    }
  })

  it('gives a split half a cell of reuse tolerance and bounds it to the clip window', () => {
    const long = videoAsset({ duration: 900 })
    const clip = videoClip({ duration: 900 })
    const tile = filmstripSamples(clip, long, 10_000, 44, { startPx: 0, widthPx: 1_000 })!
    expect(tile.sourceStart).toBe(0)
    expect(tile.sourceEnd).toBeCloseTo(900, 1)
    expect(tile.cacheTolerance).toBeGreaterThan(1 / 30)

    // A trimmed clip's window follows its in point: reuse cannot reach the
    // material its head cut away.
    const trimmed = filmstripSamples(videoClip({ inPoint: 100, duration: 100 }), long, 10_000, 44)!
    expect(trimmed.sourceStart).toBeCloseTo(100, 6)
    expect(trimmed.sourceEnd).toBeCloseTo(200, 6)

    // A reversed clip reads the same window backwards; the window stays ordered.
    const reversed = filmstripSamples(
      videoClip({ inPoint: 100, duration: 100, reverse: true }),
      long,
      10_000,
      44,
    )!
    expect(reversed.sourceStart).toBeCloseTo(100, 6)
    expect(reversed.sourceEnd).toBeCloseTo(200, 6)
  })
})

describe('filmstripPrefetchTimes (0.18.0)', () => {
  const long = videoAsset({ duration: 900 })
  const longClip = videoClip({ duration: 900 })

  it('extends the visible grid one tile forward', () => {
    const plan = filmstripPlan(longClip, long, 10_000, 44, { startPx: 0, widthPx: 1_000 })!
    const prefetch = filmstripPrefetchTimes(plan)
    expect(prefetch).toHaveLength(plan.frames.length)
    expect(prefetch[0]).toBeGreaterThan(plan.frames.at(-1)!.sourceTime)
    expect(prefetch.at(-1)!).toBeLessThanOrEqual(plan.sourceEnd)
  })

  it('returns nothing when the whole clip is already visible', () => {
    const plan = filmstripPlan(videoClip(), videoAsset(), 500, 44)!
    expect(filmstripPrefetchTimes(plan)).toEqual([])
  })

  it('extends a reversed clip downward and stops at its in point', () => {
    const reversed = videoClip({ inPoint: 100, duration: 800, reverse: true })
    const plan = filmstripPlan(reversed, long, 10_000, 44, { startPx: 0, widthPx: 1_000 })!
    const prefetch = filmstripPrefetchTimes(plan)
    expect(prefetch[0]).toBeLessThan(plan.frames.at(-1)!.sourceTime)
    expect(prefetch.at(-1)!).toBeGreaterThanOrEqual(plan.sourceStart)
  })
})

describe('filmstrip viewport tiles (0.18.0)', () => {
  const asset = videoAsset()
  const clip = videoClip({ duration: 9 })

  it('samples only the visible range at layout density', () => {
    const full = filmstripSamples(clip, asset, 10_000, 44)!
    const tile = filmstripSamples(clip, asset, 10_000, 44, { startPx: 5_000, widthPx: 1_000 })!
    expect(tile.tileStartPx).toBe(5_000)
    expect(tile.tileWidthPx).toBe(1_000)
    expect(tile.widthBucket).toBe(1024)
    expect(tile.frames.length).toBe(filmstripFrameCount(1_000))
    // The tile's first cell is around the middle of the source, not the head.
    expect(tile.frames[0].sourceTime).toBeGreaterThan(full.frames[0].sourceTime)
    expect(tile.frames.at(-1)!.sourceTime).toBeLessThan(full.frames.at(-1)!.sourceTime)
  })

  it('clamps a viewport that runs past the clip edge', () => {
    const tile = filmstripSamples(clip, asset, 1_000, 44, { startPx: 900, widthPx: 500 })!
    expect(tile.tileStartPx).toBe(900)
    expect(tile.tileWidthPx).toBe(100)
  })

  it('keys a scrolled tile differently from the full strip', () => {
    const head = filmstripSamples(clip, asset, 10_000, 44, { startPx: 0, widthPx: 1_000 })!
    const middle = filmstripSamples(clip, asset, 10_000, 44, { startPx: 5_000, widthPx: 1_000 })!
    expect(
      filmstripCacheKey(
        clip,
        asset,
        middle.widthBucket,
        middle.heightBucket,
        middle.tileStartPx,
        middle.tileWidthPx,
      ),
    ).not.toBe(
      filmstripCacheKey(
        clip,
        asset,
        head.widthBucket,
        head.heightBucket,
        head.tileStartPx,
        head.tileWidthPx,
      ),
    )
  })
})

describe('filmstripPlan key (0.18.0)', () => {
  it('uses the untiled base key when no viewport is present', () => {
    const asset = videoAsset()
    const a = filmstripPlan(videoClip(), asset, 500, 44)!
    const b = filmstripPlan(videoClip(), asset, 520, 44)!
    // Both layout widths bucket to 512: the untiled plan must share the base
    // key instead of embedding each raw width.
    expect(a.key).toBe(b.key)
    expect(a.key.endsWith(':512x44')).toBe(true)
  })

  it('keeps the tile start and raw tile width when a viewport is present', () => {
    const asset = videoAsset()
    const clip = videoClip({ duration: 9 })
    const tiled = filmstripPlan(clip, asset, 10_000, 44, { startPx: 0, widthPx: 1_000 })!
    expect(tiled.key.endsWith(':0:1000')).toBe(true)
    const head = filmstripPlan(clip, asset, 10_000, 44, { startPx: 0, widthPx: 1_000 })!
    expect(tiled.key).toBe(head.key)
  })
})

describe('filmstripCacheKey', () => {
  const asset = videoAsset()
  const base = videoClip()
  const key = (clip: Clip = base, width = 128, height = 44, a: MediaAsset = asset) =>
    filmstripCacheKey(clip, a, width, height)

  it('changes on trim, speed, reverse, and the time-scale curve', () => {
    expect(key(base, 128, 44)).not.toBe(key(videoClip({ inPoint: 1 }), 128, 44))
    expect(key(base, 128, 44)).not.toBe(key(videoClip({ duration: 3 }), 128, 44))
    expect(key(base, 128, 44)).not.toBe(key(videoClip({ speed: 2 }), 128, 44))
    expect(key(base, 128, 44)).not.toBe(key(videoClip({ reverse: true }), 128, 44))
    const curved = videoClip({ keyframes: { timeScale: [{ time: 0, value: 1 }] } })
    expect(key(base, 128, 44)).not.toBe(key(curved, 128, 44))
    expect(key(curved, 128, 44)).not.toBe(
      key(
        videoClip({
          keyframes: {
            timeScale: [
              { time: 0, value: 1 },
              { time: 4, value: 2 },
            ],
          },
        }),
        128,
        44,
      ),
    )
  })

  it('changes with the capped width and height buckets', () => {
    expect(key(base, 128, 44)).not.toBe(key(base, 192, 44))
    expect(key(base, 128, 44)).not.toBe(key(base, 128, 40))
  })

  it('does not change on a move or a zoom inside one bucket', () => {
    expect(key(base, 128, 44)).toBe(key(videoClip({ start: 12 }), 128, 44))
    expect(key(base, 100, 44)).toBe(key(base, 120, 44))
  })

  it('shares the max-width bucket above the cap', () => {
    expect(key(base, 5000, 44)).toBe(key(base, 6000, 44))
  })

  it('ignores trim, speed, reverse, and curves for an image', () => {
    const image = createMediaAsset({
      id: 'media-i',
      kind: 'image',
      duration: 0,
      width: 800,
      height: 600,
      url: 'blob:image',
    })
    const plain = videoClip({ mediaId: 'media-i' })
    const changed = videoClip({
      mediaId: 'media-i',
      inPoint: 3,
      duration: 1,
      speed: 2,
      reverse: true,
      keyframes: { timeScale: [{ time: 0, value: 2 }] },
    })
    expect(filmstripCacheKey(plain, image, 128, 44)).toBe(
      filmstripCacheKey(changed, image, 128, 44),
    )
    expect(filmstripCacheKey(plain, image, 128, 44)).toBe('image:media-i:128x44')
    expect(filmstripCacheKey(plain, image, 192, 44)).not.toBe(
      filmstripCacheKey(plain, image, 128, 44),
    )
  })
})
