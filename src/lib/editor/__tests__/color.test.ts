import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  COLOR_NEUTRAL,
  LUMA_BUCKETS,
  buildColorFilter,
  buildColorMatrix,
  clipColorValues,
  clipFilter,
  colorFilterId,
  describeColorFilter,
  hasColorGrade,
  sampleLuma,
  sampleRgbBalance,
  scopeSampleSize,
} from '../color'
import { planVideoFrame } from '../export/offline'
import { createClip, createMediaAsset, createTrack } from '../factories'
import type { Clip, Doc } from '../types'

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

const clip = (over: Partial<Clip> = {}) =>
  createClip({ id: 'c1', mediaId: 'm1', start: 0, duration: 4, ...over })

function docWith(clip: Clip): Doc {
  return {
    project: {
      id: 'p',
      name: 'n',
      width: 1920,
      height: 1080,
      fps: 30,
      tracks: [createTrack('video', 1, { id: 'track_1', clips: [clip] })],
    },
    media: [createMediaAsset({ id: 'm1', kind: 'video', duration: 10, name: 'a.mp4' })],
  }
}

describe('buildColorFilter', () => {
  it('is none when every value is neutral', () => {
    expect(buildColorFilter(COLOR_NEUTRAL)).toBe('none')
  })

  it('keeps RAW values, so a real saturation is never rounded away', () => {
    // The de-duplication regression: the preview used to round to 3 decimals,
    // which turned 1.00049 into exactly 1 and silently dropped the effect
    // while the export kept it. Both paths use raw values now.
    expect(buildColorFilter({ ...COLOR_NEUTRAL, saturation: 1.00049 })).toBe('saturate(1.00049)')
    expect(buildColorFilter({ ...COLOR_NEUTRAL, brightness: 0.9999 })).toBe('brightness(0.9999)')
  })

  it('emits the parts in the browser application order', () => {
    expect(
      buildColorFilter({ exposure: 4, contrast: 1.2, saturation: 0.5, brightness: 0.8, hue: 90 }),
    ).toBe('brightness(0.8) contrast(1.2) saturate(0.5) hue-rotate(90deg) brightness(2)')
  })

  it('appends an SVG grade reference last', () => {
    expect(buildColorFilter(COLOR_NEUTRAL, 'url(#grade-1)')).toBe('url(#grade-1)')
    expect(buildColorFilter({ ...COLOR_NEUTRAL, hue: 10 }, 'url(#grade-1)')).toBe(
      'hue-rotate(10deg) url(#grade-1)',
    )
  })
})

describe('clipColorValues + clipFilter', () => {
  it('evaluates the animated color set at local time', () => {
    const c = clip({
      animStatics: { saturation: 1.5 },
      keyframes: {
        hue: [
          { time: 0, value: 0 },
          { time: 4, value: 180 },
        ],
      },
    })
    expect(clipColorValues(c, 2)).toEqual({
      exposure: 1,
      contrast: 1,
      saturation: 1.5,
      brightness: 1,
      hue: 90,
    })
  })

  it('grades a clip through its id-stable SVG reference', () => {
    const neutral = clip()
    expect(hasColorGrade(neutral)).toBe(false)
    expect(describeColorFilter(neutral)).toBe('none')
    expect(clipFilter(neutral, 0)).toBe('none')

    const graded = clip({ temperature: 40, tint: 0 })
    expect(hasColorGrade(graded)).toBe(true)
    expect(colorFilterId(graded)).toBe('clip-grade-c1')
    expect(describeColorFilter(graded)).toBe('url(#clip-grade-c1)')
    expect(clipFilter(graded, 0)).toBe('url(#clip-grade-c1)')
  })

  it('keeps an unsafe clip id out of the CSS url() so the whole color set survives', () => {
    // A hydrated project file can carry any string as a clip id. A raw id with
    // a space makes `filter: url(#clip-grade-a b)` an invalid token, which
    // makes the WHOLE ctx.filter assignment fail (exposure, contrast,
    // saturation, brightness and hue all silently lost), and a `)` can inject
    // extra filter functions. Only url-safe characters may reach the token.
    const unsafe = clip({ id: 'a b)c', temperature: 40 })
    expect(describeColorFilter(unsafe)).toBe(`url(#${colorFilterId(unsafe)})`)
    expect(describeColorFilter(unsafe)).toMatch(/^url\(#[A-Za-z0-9_-]+\)$/)
    // The encoding must stay injective: ids that differ only by a separator are
    // still distinct filters, so two graded clips never share one SVG node.
    expect(colorFilterId(clip({ id: 'a b' }))).not.toBe(colorFilterId(clip({ id: 'a_b' })))
  })
})

describe('buildColorMatrix', () => {
  const parse = (values: string) => values.split(' ').map(Number)

  it('is the identity at 0/0', () => {
    expect(parse(buildColorMatrix(0, 0))).toEqual([
      1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0,
    ])
  })

  it('warms with positive temperature and cools with negative', () => {
    const warm = parse(buildColorMatrix(100, 0))
    const cool = parse(buildColorMatrix(-100, 0))
    expect(warm[0]).toBeGreaterThan(1) // red up
    expect(warm[12]).toBeLessThan(1) // blue down
    expect(cool[0]).toBeLessThan(1)
    expect(cool[12]).toBeGreaterThan(1)
    // Green is untouched by temperature.
    expect(warm[6]).toBe(1)
    expect(cool[6]).toBe(1)
  })

  it('walks tint between green and magenta', () => {
    const green = parse(buildColorMatrix(0, 100))
    const magenta = parse(buildColorMatrix(0, -100))
    expect(green[6]).toBeGreaterThan(1) // green up
    expect(magenta[6]).toBeLessThan(1) // green down
    expect(magenta[0]).toBeGreaterThan(1) // magenta = red and blue up
    expect(magenta[12]).toBeGreaterThan(1)
  })

  it('keeps every gain inside 0.5..1.5 across the legal range', () => {
    for (let v = -100; v <= 100; v += 5) {
      for (const values of [parse(buildColorMatrix(v, 0)), parse(buildColorMatrix(0, v))]) {
        for (const gain of [values[0], values[6], values[12]]) {
          expect(gain).toBeGreaterThan(0.5)
          expect(gain).toBeLessThan(1.5)
        }
        // Alpha passes through untouched.
        expect(values[18]).toBe(1)
      }
    }
  })

  it('pins the corner extremes the axis sweep cannot reach', () => {
    // Temperature and tint SUM into the red and blue rows, so combining the two
    // axes reaches further than either axis alone: the documented reachable
    // range is 0.625..1.375, not the axis bound of 0.75..1.25.
    const warmMagenta = parse(buildColorMatrix(100, -100))
    expect(warmMagenta[0]).toBeCloseTo(1.375, 10)
    expect(warmMagenta[6]).toBeCloseTo(0.75, 10)
    expect(warmMagenta[12]).toBeCloseTo(0.875, 10)
    const coolGreen = parse(buildColorMatrix(-100, 100))
    expect(coolGreen[0]).toBeCloseTo(0.625, 10)
    expect(coolGreen[6]).toBeCloseTo(1.25, 10)
    expect(coolGreen[12]).toBeCloseTo(1.125, 10)
    // No point of the legal square escapes the pair of corner bounds, and the
    // low end never reaches 0 (the matrix stays invertible).
    for (let temp = -100; temp <= 100; temp += 10) {
      for (let tint = -100; tint <= 100; tint += 10) {
        const values = parse(buildColorMatrix(temp, tint))
        for (const gain of [values[0], values[6], values[12]]) {
          expect(gain).toBeGreaterThanOrEqual(0.625 - 1e-12)
          expect(gain).toBeLessThanOrEqual(1.375 + 1e-12)
          expect(gain).toBeGreaterThan(0)
        }
      }
    }
  })

  it('clamps out-of-range input to the legal range', () => {
    expect(buildColorMatrix(500, 0)).toBe(buildColorMatrix(100, 0))
    expect(buildColorMatrix(0, -500)).toBe(buildColorMatrix(0, -100))
  })
})

describe('color flow: one builder for both render paths', () => {
  it('the offline plan carries the builder output verbatim, rounding nothing', () => {
    // A hardcoded expectation, NOT `clipFilter(c, 1)`: the exporter sets this
    // field FROM that helper, so comparing them would be a self-comparison that
    // passes for any output. 1.00049 is the value the de-duplication was about:
    // a rounding builder would emit `saturate(1)` or drop the part entirely.
    const c = clip({
      animStatics: { saturation: 1.00049, hue: 45 },
      temperature: 40,
      tint: -20,
    })
    expect(planVideoFrame(docWith(c), 1).draws[0].filter).toBe(
      'saturate(1.00049) hue-rotate(45deg) url(#clip-grade-c1)',
    )
  })

  it('neither render path hand-builds filter strings any more (static lock)', () => {
    const compositor = read('src/lib/editor/playback/compositor.ts')
    expect(compositor).toMatch(/clipFilter\(clip, local\)/)
    expect(compositor).not.toMatch(/brightness\(\$\{/)
    expect(compositor).not.toMatch(/function buildFilter/)

    const offline = read('src/lib/editor/export/offline.ts')
    expect(offline).toMatch(/clipFilter\(clip, local\)/)
    expect(offline).not.toMatch(/saturate\(\$\{/)
    expect(offline).not.toMatch(/function clipFilter/)
  })

  it('the preview compositor draws graded clips through the shared helper', () => {
    const compositor = read('src/lib/editor/playback/compositor.ts')
    // The draw call receives the shared string; the SVG reference rides inside
    // it (ctx.filter accepts url() next to the filter functions).
    expect(compositor).toMatch(/const filter = clipFilter\(clip, local\)/)
  })
})

describe('scope samplers', () => {
  const pixels = (values: number[][], width = values.length) => ({
    data: new Uint8ClampedArray(values.flat()),
    width,
    height: 1,
  })

  it('bins luma into 256 buckets as fractions that sum to 1', () => {
    const out = sampleLuma(
      pixels([
        [0, 0, 0, 255],
        [255, 255, 255, 255],
        [0, 0, 0, 255],
        [255, 255, 255, 255],
      ]),
    )
    expect(out).toHaveLength(LUMA_BUCKETS)
    expect(out[0]).toBeCloseTo(0.5, 10)
    expect(out[255]).toBeCloseTo(0.5, 10)
    expect(out.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10)
  })

  it('weights luma by the Rec.709 coefficients', () => {
    const out = sampleLuma(pixels([[255, 0, 0, 255]]))
    // 0.2126 * 255 = 54.2 -> bucket 54.
    expect(out[54]).toBeCloseTo(1, 10)
  })

  it('reads channel balance in 0..1', () => {
    expect(sampleRgbBalance(pixels([[255, 0, 0, 255]]))).toEqual({ r: 1, g: 0, b: 0 })
    expect(
      sampleRgbBalance(
        pixels([
          [0, 255, 0, 255],
          [0, 0, 255, 255],
        ]),
      ),
    ).toEqual({ r: 0, g: 0.5, b: 0.5 })
  })

  it('handles an empty buffer without throwing', () => {
    expect(sampleLuma(pixels([])).every((v) => v === 0)).toBe(true)
    expect(sampleRgbBalance(pixels([]))).toEqual({ r: 0, g: 0, b: 0 })
  })

  it('bounds the sample grid to 256x144 and never upscales', () => {
    expect(scopeSampleSize(3840, 2160)).toEqual({ width: 256, height: 144 })
    expect(scopeSampleSize(1920, 1080)).toEqual({ width: 256, height: 144 })
    expect(scopeSampleSize(640, 360)).toEqual({ width: 256, height: 144 })
    expect(scopeSampleSize(128, 72)).toEqual({ width: 128, height: 72 })
    expect(scopeSampleSize(0, 0)).toEqual({ width: 1, height: 1 })
  })
})
