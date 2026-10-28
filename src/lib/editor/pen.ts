import { animatedValue, clampPropertyValue, staticPropertyValue } from './keyframes'
import { frameToTime } from './time'
import type { Clip, Keyframe, TrackKind } from './types'
import {
  addVolumeKeyframe,
  formatDb,
  gainToUnit,
  moveVolumeKeyframe,
  removeVolumeKeyframe,
  sampleVolumeCurve,
  unitToGain,
} from './volume-automation'

/**
 * Keyframe Pen helpers (0.16.0).
 *
 * The Pen edits ONE automation curve on the selected clip: volume on audio
 * clips, opacity on anything with picture. The property rule is structural
 * (`audio` track or `audioOnly`), not about whether the clip happens to carry
 * sound: a solo video with embedded audio edits opacity, while its Plan 04
 * volume envelope stays directly draggable through its dots.
 *
 * Times are clip-local seconds, values are stored units (linear gain 0..2,
 * opacity 0..1). Every function returns a new sorted array and never mutates
 * the clip; the existing `setClipKeyframes` command still owns validation,
 * history and persistence.
 */

export type AutomationProperty = 'volume' | 'opacity'

/** The property the Pen edits for this clip. */
export function automationPropertyForClip(clip: Clip, trackKind: TrackKind): AutomationProperty {
  return trackKind === 'audio' || clip.audioOnly ? 'volume' : 'opacity'
}

/** The clip's curve for `property`, or an empty array. */
export function automationKeyframes(clip: Clip, property: AutomationProperty): Keyframe[] {
  return clip.keyframes?.[property] ?? []
}

/** Clamp a clip-local time into [0, clip.duration]; hostile input reads 0. */
export function clampAutomationTime(clip: Clip, time: number): number {
  if (!Number.isFinite(time)) return 0
  return Math.min(Math.max(0, time), Math.max(0, clip.duration))
}

/** The curve's value at a clip-local time (static value when unanimated). */
export function automationValueAt(clip: Clip, property: AutomationProperty, local: number): number {
  return animatedValue(clip, property, clampAutomationTime(clip, local))
}

/** One display position for a stored value: dB domain for volume, 0..1 for opacity. */
export function automationUnitForValue(property: AutomationProperty, value: number): number {
  return property === 'volume' ? gainToUnit(value) : Math.min(1, Math.max(0, value))
}

/** A 0..1 display position back to a stored value, clamped to keyframe bounds. */
export function automationValueForUnit(property: AutomationProperty, unit: number): number {
  const u = Math.min(1, Math.max(0, unit))
  return property === 'volume' ? unitToGain(u) : clampPropertyValue('opacity', u)
}

/** The compact readout shown while a dot is dragged. */
export function formatAutomationValue(property: AutomationProperty, value: number): string {
  return property === 'volume' ? formatDb(value) : `${Math.round(value * 100)}%`
}

/** One sampled point on the drawn curve. */
export interface AutomationSample {
  /** Clip-local seconds. */
  time: number
  /** The stored value. */
  value: number
  /** The 0..1 display position (the same one the dots use). */
  unit: number
}

/**
 * Evenly spaced samples across the clip for the timeline overlay. Volume
 * reuses the Plan 04 dB sampler; opacity samples `animatedValue` directly.
 * The last sample is at the clip's duration inclusive.
 */
export function sampleAutomationCurve(
  clip: Clip,
  property: AutomationProperty,
  count: number,
): AutomationSample[] {
  if (property === 'volume') {
    return sampleVolumeCurve(clip, count).map(({ time, gain, unit }) => ({
      time,
      value: gain,
      unit,
    }))
  }
  const n = Math.max(0, Math.floor(count))
  if (n === 0) return []
  const duration = Math.max(0, clip.duration)
  const samples: AutomationSample[] = []
  for (let i = 0; i < n; i++) {
    const time = n === 1 ? 0 : (duration * i) / (n - 1)
    const value = animatedValue(clip, property, time)
    samples.push({ time, value, unit: automationUnitForValue(property, value) })
  }
  return samples
}

/** One frame in seconds, with a hostile fps falling back to exact-time dedupe. */
function frameSpan(fps: number): number {
  return Number.isFinite(fps) && fps > 0 ? frameToTime(1, fps) : 1e-6
}

/** The index of the keyframe nearest `at`, or -1 when none is within one frame. */
function nearestWithinFrame(kfs: Keyframe[], at: number, fps: number): number {
  const span = frameSpan(fps) + 1e-9
  let best = -1
  let bestDistance = span
  for (let i = 0; i < kfs.length; i++) {
    const distance = Math.abs(kfs[i].time - at)
    if (distance <= bestDistance) {
      best = i
      bestDistance = distance
    }
  }
  return best
}

/**
 * The next curve with a point added at `local`. When an existing point sits
 * within one frame of the click, it is REPLACED at its own time instead of
 * stacking a second point on the same frame. New points carry `interpolation`
 * (the project's default easing for the property) and the clamped `value`;
 * the input clip and its array are untouched.
 */
export function addKeyframeAt(
  clip: Clip,
  property: AutomationProperty,
  local: number,
  value: number,
  fps: number,
  interpolation: Keyframe['interpolation'] = 'linear',
): Keyframe[] {
  const at = clampAutomationTime(clip, local)
  // A hostile value (NaN/Infinity) must not reach the command layer's
  // sanitizer as a dropped point: fall back to the clip's static value.
  const nextValue = clampPropertyValue(
    property,
    Number.isFinite(value) ? value : staticPropertyValue(clip, property),
  )
  const kfs = automationKeyframes(clip, property)
  const existing = nearestWithinFrame(kfs, at, fps)
  if (existing >= 0) {
    return kfs.map((k, i) => (i === existing ? { ...k, value: nextValue } : { ...k }))
  }
  if (property === 'volume') {
    const next = addVolumeKeyframe(clip, at, nextValue)
    return next.map((k) => (Math.abs(k.time - at) < 1e-9 ? { ...k, interpolation } : k))
  }
  const added: Keyframe = { time: at, value: nextValue, interpolation }
  if (kfs.length === 0) return [added]
  return [...kfs.map((k) => ({ ...k })), added].sort((a, b) => a.time - b.time)
}

/**
 * The next curve without the point at (or within one frame of) `local`. A
 * missing match returns a copy unchanged, and removing the last point clears
 * the curve so the property falls back to its static value.
 */
export function removeKeyframeAt(
  clip: Clip,
  property: AutomationProperty,
  local: number,
  fps: number,
): Keyframe[] {
  const at = clampAutomationTime(clip, local)
  const kfs = automationKeyframes(clip, property)
  const index = nearestWithinFrame(kfs, at, fps)
  if (index < 0) return kfs.map((k) => ({ ...k }))
  if (property === 'volume') return removeVolumeKeyframe(clip, index)
  return kfs.filter((_, i) => i !== index).map((k) => ({ ...k }))
}

/**
 * Move one point in time and value, clamped to the clip and the property's
 * bounds and re-sorted when it crosses a neighbour. The caller passes the
 * live index, exactly like the shared keyframe graph.
 */
export function nudgeKeyframe(
  clip: Clip,
  property: AutomationProperty,
  index: number,
  timeDelta: number,
  valueDelta: number,
): Keyframe[] {
  const kfs = automationKeyframes(clip, property)
  if (index < 0 || index >= kfs.length) return kfs.map((k) => ({ ...k }))
  const current = kfs[index]
  const at = clampAutomationTime(
    clip,
    Number.isFinite(current.time + timeDelta) ? current.time + timeDelta : current.time,
  )
  const value = clampPropertyValue(
    property,
    Number.isFinite(current.value + valueDelta) ? current.value + valueDelta : current.value,
  )
  if (property === 'volume') return moveVolumeKeyframe(clip, index, at, value)
  return kfs
    .map((k, i) => (i === index ? { ...k, time: at, value } : { ...k }))
    .sort((a, b) => a.time - b.time)
}
