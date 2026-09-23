import { KEYFRAME_PROPERTY_BOUNDS } from './constants'
import type { Clip, Keyframe, KeyframeMap, KeyframeProperty } from './types'

/**
 * Keyframe engine, per-property linear animation for clips.
 *
 * Model: `clip.keyframes[property]` is a time-sorted array of keyframes. Times
 * are CLIP-LOCAL timeline seconds (0 = clip start), so moves/duplicates carry
 * their animation along for free and `splitClip` redistributes the arrays.
 * Evaluation constant-extends before the first and after the last keyframe.
 * Interpolation is linear; the `interpolation` field exists so eased curves
 * can be added later without a schema break.
 */

export type { Keyframe, KeyframeMap, KeyframeProperty }

/** All animatable properties with their value bounds and static fallbacks. */
export const ANIMATABLE_PROPERTIES: readonly KeyframeProperty[] = [
  'opacity',
  'positionX',
  'positionY',
  'scale',
  'volume',
  'exposure',
  'contrast',
  'saturation',
  'brightness',
  'hue',
]

export function isAnimatableProperty(p: string): p is KeyframeProperty {
  return (ANIMATABLE_PROPERTIES as readonly string[]).includes(p)
}

/** The property's static (non-animated) value on a clip, or the default. */
export function staticPropertyValue(clip: Clip, property: KeyframeProperty): number {
  switch (property) {
    case 'opacity':
      return clip.opacity ?? 1
    case 'volume':
      return clip.gain ?? 1
    default:
      return clip.animStatics?.[property] ?? KEYFRAME_PROPERTY_BOUNDS[property].default
  }
}

/**
 * The effective property value at clip-local time `t` (seconds from clip
 * start): the keyframe curve when keyframes exist, otherwise the static value.
 */
export function animatedValue(clip: Clip, property: KeyframeProperty, t: number): number {
  const kfs = clip.keyframes?.[property]
  if (!kfs || kfs.length === 0) return staticPropertyValue(clip, property)
  return evaluateKeyframes(kfs, t, staticPropertyValue(clip, property))
}

/** Linear interpolation over a sorted keyframe array (constant-extended). */
export function evaluateKeyframes(kfs: Keyframe[], t: number, fallback: number): number {
  if (kfs.length === 0) return fallback
  if (t <= kfs[0].time) return kfs[0].value
  const last = kfs[kfs.length - 1]
  if (t >= last.time) return last.value
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i]
    const b = kfs[i + 1]
    if (t >= a.time && t <= b.time) {
      const span = b.time - a.time
      if (span <= 1e-9) return b.value
      const p = (t - a.time) / span
      return a.value + (b.value - a.value) * p
    }
  }
  return fallback
}

/** Clamps a value into the property's legal range. */
export function clampPropertyValue(property: KeyframeProperty, value: number): number {
  const { min, max } = KEYFRAME_PROPERTY_BOUNDS[property]
  return Math.min(max, Math.max(min, value))
}

/** Validates + sorts a keyframe array for a property; clamps values into bounds. */
export function sanitizeKeyframes(property: KeyframeProperty, keyframes: Keyframe[]): Keyframe[] {
  return keyframes
    .filter((k) => Number.isFinite(k.time) && k.time >= 0 && Number.isFinite(k.value))
    .map((k) => ({
      time: k.time,
      value: clampPropertyValue(property, k.value),
      interpolation: k.interpolation ?? 'linear',
    }))
    .sort((a, b) => a.time - b.time)
}

/**
 * Redistributes a clip's keyframe map across a split at clip-local time `at`:
 * keyframes at `>= at` move to the right half shifted by `at`.
 *
 * The halves are standalone clips once the cut is made, so every property with
 * a curve also gets the curve's value at `at` as a boundary keyframe on BOTH
 * halves. Without it the left half would freeze on its last keyframe (or fall
 * back to the static value when it has none) and the right half would do the
 * same from local 0, so any ramp crossing the cut would be destroyed even
 * though both halves together still cover the original span. A keyframe
 * already sitting exactly on the boundary is left alone (it already carries
 * that value). Returns [leftMap, rightMap] (either may be undefined when
 * empty).
 */
export function splitKeyframeMap(
  map: KeyframeMap | undefined,
  at: number,
): [KeyframeMap | undefined, KeyframeMap | undefined] {
  if (!map) return [undefined, undefined]
  const left: KeyframeMap = {}
  const right: KeyframeMap = {}
  let anyLeft = false
  let anyRight = false
  for (const property of Object.keys(map) as KeyframeProperty[]) {
    const kfs = map[property]
    if (!kfs || kfs.length === 0) continue
    const boundary = evaluateKeyframes(kfs, at, kfs[0].value)
    const l = kfs.filter((k) => k.time < at)
    const r = kfs.filter((k) => k.time >= at).map((k) => ({ ...k, time: k.time - at }))
    l.push({ time: at, value: boundary, interpolation: 'linear' })
    if (r.length === 0 || r[0].time > 0) {
      r.unshift({ time: 0, value: boundary, interpolation: 'linear' })
    }
    left[property] = l
    right[property] = r
    anyLeft = true
    anyRight = true
  }
  return [anyLeft ? left : undefined, anyRight ? right : undefined]
}
