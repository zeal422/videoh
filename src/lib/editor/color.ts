/**
 * Color grading, pure and shared by BOTH render paths (0.6.0).
 *
 * `clipFilter` is the one ctx.filter builder: the preview compositor and the
 * offline export planner each call it per draw, so a graded clip cannot look
 * different in the export. It replaces two hand-rolled near-duplicates
 * (`buildFilter` in compositor.ts and `clipFilter` in export/offline.ts) whose
 * part ORDER was byte-identical but whose values were not: one rounded to 3
 * decimals, the other kept raw floats. That was not cosmetic, because the
 * preview rounded saturation 1.00049 to exactly 1 and silently dropped the
 * effect while the export kept it. Raw values are the single behavior now.
 *
 * Temperature/tint cannot ride `ctx.filter` (there is no such primitive), so
 * they compile to an SVG `feColorMatrix` referenced by id (`url(#...)`), which
 * composes into the same filter string and works in both paths.
 */

import { TEMPERATURE_MAX, TEMPERATURE_MIN, TINT_MAX, TINT_MIN } from './constants'
import { animatedValue } from './keyframes'
import { clamp } from './time'
import type { Clip } from './types'

/** The color set's neutral values: a neutral clip skips the filter pass. */
export const COLOR_NEUTRAL = {
  exposure: 1,
  contrast: 1,
  saturation: 1,
  brightness: 1,
  hue: 0,
}

/** One clip's color-set values (its ctx.filter parameters). */
export interface ColorValues {
  exposure: number
  contrast: number
  saturation: number
  brightness: number
  hue: number
}

/**
 * The ctx.filter chain for a clip's color values, in the order the browser
 * applies them (brightness, contrast, saturation, hue, exposure as a gamma).
 * `colorRef` is an optional SVG filter reference (`url(#id)`) appended last;
 * the whole string is 'none' when nothing would change, so a neutral clip
 * costs no filter pass at all.
 */
export function buildColorFilter(values: ColorValues, colorRef = 'none'): string {
  const parts: string[] = []
  if (values.brightness !== 1) parts.push(`brightness(${values.brightness})`)
  if (values.contrast !== 1) parts.push(`contrast(${values.contrast})`)
  if (values.saturation !== 1) parts.push(`saturate(${values.saturation})`)
  if (values.hue !== 0) parts.push(`hue-rotate(${values.hue}deg)`)
  if (values.exposure !== 1) parts.push(`brightness(${Math.pow(values.exposure, 0.5)})`)
  if (colorRef !== 'none') parts.push(colorRef)
  return parts.length === 0 ? 'none' : parts.join(' ')
}

/** A clip's color-set values at clip-local time `local` (animated or static). */
export function clipColorValues(clip: Clip, local: number): ColorValues {
  return {
    exposure: animatedValue(clip, 'exposure', local),
    contrast: animatedValue(clip, 'contrast', local),
    saturation: animatedValue(clip, 'saturation', local),
    brightness: animatedValue(clip, 'brightness', local),
    hue: animatedValue(clip, 'hue', local),
  }
}

/**
 * The SVG filter id a clip's temperature/tint grade runs through (stable).
 *
 * A clip id can come from an imported file and hold characters a CSS `url()`
 * fragment cannot: a space makes the whole `ctx.filter` string invalid (the
 * clip would silently lose its entire color set, not just the grade), and a
 * `)` can inject extra filter functions. Encode every character outside the
 * url-safe set as `_<code point hex>_`, with `_` itself encoded, so the id is
 * injective and safe to drop straight into `url(#...)`.
 */
export function colorFilterId(clip: Clip): string {
  let safe = ''
  for (const ch of clip.id) {
    safe += /^[A-Za-z0-9-]$/.test(ch) ? ch : `_${(ch.codePointAt(0) ?? 0).toString(16)}_`
  }
  return `clip-grade-${safe}`
}

/** True when a clip carries a non-neutral temperature/tint grade. */
export function hasColorGrade(clip: Clip): boolean {
  // -0 reads as 0 (no grade), and a missing field is neutral.
  return (clip.temperature ?? 0) !== 0 || (clip.tint ?? 0) !== 0
}

/** 'none', or the `url(#id)` form of the clip's SVG grade. */
export function describeColorFilter(clip: Clip): string {
  return hasColorGrade(clip) ? `url(#${colorFilterId(clip)})` : 'none'
}

/**
 * The SVG `feColorMatrix` values for a temperature/tint grade, as the 20
 * numbers of a 4x5 matrix (rows R, G, B, A; the fifth column is an offset).
 *
 * Temperature is a white-balance shift: warm pushes red up and blue down, cool
 * does the reverse. Tint walks green against magenta: positive adds green,
 * negative adds magenta (and pulls green). Both are neutral at 0. Each AXIS is
 * bounded by 0.75..1.25, but temperature and tint SUM into the red and blue
 * rows, so the legal square reaches 0.625..1.375 at its corners (temp +100 with
 * tint -100 puts red at 1.375; temp -100 with tint +100 puts it at 0.625).
 * Every gain stays positive and inside 0.625..1.375, so the matrix is
 * invertible and never drives a channel negative.
 */
export function buildColorMatrix(temperature: number, tint: number): string {
  const warm = clamp(temperature, TEMPERATURE_MIN, TEMPERATURE_MAX) / TEMPERATURE_MAX
  const green = clamp(tint, TINT_MIN, TINT_MAX) / TINT_MAX
  const r = 1 + 0.25 * warm - 0.125 * green
  const g = 1 + 0.25 * green
  const b = 1 - 0.25 * warm - 0.125 * green
  return [r, 0, 0, 0, 0, 0, g, 0, 0, 0, 0, 0, b, 0, 0, 0, 0, 0, 1, 0].join(' ')
}

/** The full ctx.filter string a clip renders with at clip-local `local`. */
export function clipFilter(clip: Clip, local: number): string {
  return buildColorFilter(clipColorValues(clip, local), describeColorFilter(clip))
}

/** Pixel buffer the scope samplers read (a canvas ImageData, kept structural). */
export interface RgbaPixels {
  data: Uint8ClampedArray
  width: number
  height: number
}

/** Longest edge of the downsample grid a monitor read draws into. */
export const SCOPES_MAX_WIDTH = 256
export const SCOPES_MAX_HEIGHT = 144

/** The bounded sample grid a monitor read uses, never the full frame buffer. */
export function scopeSampleSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(
    1,
    SCOPES_MAX_WIDTH / Math.max(1, width),
    SCOPES_MAX_HEIGHT / Math.max(1, height),
  )
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

/** Luma histogram buckets (8-bit). */
export const LUMA_BUCKETS = 256

/** Rec.709 luma of one RGBA pixel, 0..255. */
function lumaAt(data: Uint8ClampedArray, i: number): number {
  return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
}

/**
 * Luma histogram of a sampled buffer: `LUMA_BUCKETS` buckets, each holding the
 * FRACTION of sampled pixels in that bucket (so the meter scales with any
 * sample size, and the values sum to 1).
 */
export function sampleLuma(pixels: RgbaPixels): number[] {
  const buckets = new Array<number>(LUMA_BUCKETS).fill(0)
  const total = pixels.data.length / 4
  if (total === 0) return buckets
  for (let i = 0; i < pixels.data.length; i += 4) {
    buckets[Math.min(LUMA_BUCKETS - 1, Math.max(0, Math.round(lumaAt(pixels.data, i))))] += 1
  }
  for (let b = 0; b < LUMA_BUCKETS; b++) buckets[b] /= total
  return buckets
}

/** Mean channel levels (0..1) of a sampled buffer: the RGB balance meters. */
export function sampleRgbBalance(pixels: RgbaPixels): { r: number; g: number; b: number } {
  const total = pixels.data.length / 4
  if (total === 0) return { r: 0, g: 0, b: 0 }
  let r = 0
  let g = 0
  let b = 0
  for (let i = 0; i < pixels.data.length; i += 4) {
    r += pixels.data[i]
    g += pixels.data[i + 1]
    b += pixels.data[i + 2]
  }
  return { r: r / total / 255, g: g / total / 255, b: b / total / 255 }
}
