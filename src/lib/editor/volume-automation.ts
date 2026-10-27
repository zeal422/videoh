import { MAX_SEQUENCE_DEPTH } from './constants'
import { findMedia, findSequence } from './factories'
import { animatedValue, clampPropertyValue } from './keyframes'
import { assetHasAudio, hasLinkedAudioTwin } from './links'
import type { Clip, Doc, Keyframe } from './types'

/**
 * Volume automation display and editing helpers (0.13.0).
 *
 * Volume is stored LINEAR (`Clip.gain`, 0..2, and the keyframe values), because
 * the preview and export engines multiply it straight into a Web Audio gain.
 * The UI presents it in dB, which is what an editor expects: unity is 0 dB,
 * half gain is about -6 dB, and silence is negative infinity. One mapping
 * (`gainToDb` / `dbToGain`) serves the Clip tab, the Effect Controls row, the
 * timeline envelope and the shared keyframe graph, so a value can never read
 * differently in two places. Nothing here writes rounded dB back into the doc.
 *
 * The pure keyframe helpers return NEW arrays and never mutate the clip; the
 * command layer still owns validation, history and persistence.
 */

/** The bottom of the dB display domain. At or below it the graph reads -inf. */
export const DB_FLOOR = -60

/** The top of the dB display domain. A gain of 2 is about +6.02 dB. */
export const DB_CEIL = 6

/** Linear gain to dB. Gain 1 is 0 dB; gain 0 (or a non-positive value) is -Infinity. */
export function gainToDb(gain: number): number {
  if (!(gain > 0)) return -Infinity
  return 20 * Math.log10(gain)
}

/** dB to linear gain, clamped to the keyframe bounds (0..2). */
export function dbToGain(db: number): number {
  if (db === -Infinity) return 0
  if (db === Infinity) return clampPropertyValue('volume', Infinity)
  if (Number.isNaN(db)) return 0
  return clampPropertyValue('volume', 10 ** (db / 20))
}

/** One compact dB readout: `0.0 dB`, `-6.0 dB`, `-inf dB` below the floor. */
export function formatDb(gain: number): string {
  const db = gainToDb(gain)
  if (!Number.isFinite(db) || db <= DB_FLOOR) return '-inf dB'
  // Avoid a cosmetic "-0.0 dB" for a gain just above unity.
  const rounded = Math.abs(db) < 0.05 ? 0 : db
  return `${rounded.toFixed(1)} dB`
}

/** A dB value to a 0..1 position in the display domain (the floor is 0). */
export function dbToUnit(db: number): number {
  if (db === Infinity) return 1
  if (!Number.isFinite(db)) return 0
  return Math.min(1, Math.max(0, (db - DB_FLOOR) / (DB_CEIL - DB_FLOOR)))
}

/** A 0..1 display position back to dB (clamped to the domain). */
export function unitToDb(unit: number): number {
  const u = Math.min(1, Math.max(0, unit))
  return DB_FLOOR + u * (DB_CEIL - DB_FLOOR)
}

/** Linear gain to a 0..1 display position. A gain at/below the floor plots at 0. */
export function gainToUnit(gain: number): number {
  return dbToUnit(gainToDb(gain))
}

/**
 * A 0..1 display position back to linear gain (clamped to 0..2). The very
 * bottom is silence, not the formula's -60 dB gain of 0.001: a drag held at
 * the floor must be able to reach a true zero.
 */
export function unitToGain(unit: number): number {
  const u = Math.min(1, Math.max(0, unit))
  if (u <= 0) return 0
  return dbToGain(unitToDb(u))
}

/** One sampled point on the volume curve. */
export interface VolumeSample {
  /** Clip-local seconds from the clip start. */
  time: number
  /** Linear gain, the stored value. */
  gain: number
  /** The same value in dB (-Infinity at silence). */
  db: number
  /** The dB position in the display domain, 0..1. */
  unit: number
}

/**
 * Evenly spaced samples across the clip for the timeline overlay. The first
 * sample is at local 0 and the last at the clip's duration inclusive, so a
 * keyframe at exactly `clip.duration` is drawn on the curve. Sampling through
 * `animatedValue` makes eased segments draw their real shape.
 */
export function sampleVolumeCurve(clip: Clip, count: number): VolumeSample[] {
  const n = Math.max(0, Math.floor(count))
  if (n === 0) return []
  const duration = Math.max(0, clip.duration)
  const samples: VolumeSample[] = []
  for (let i = 0; i < n; i++) {
    const time = n === 1 ? 0 : (duration * i) / (n - 1)
    const gain = animatedValue(clip, 'volume', time)
    samples.push({ time, gain, db: gainToDb(gain), unit: gainToUnit(gain) })
  }
  return samples
}

/** The clip's volume keyframes, or an empty array. */
function volumeKeyframes(clip: Clip): Keyframe[] {
  return clip.keyframes?.volume ?? []
}

/** Clamp a clip-local time into [0, clip.duration], exactly at the edge. */
export function clampVolumeTime(clip: Clip, time: number): number {
  if (!Number.isFinite(time)) return 0
  return Math.min(Math.max(0, time), Math.max(0, clip.duration))
}

/**
 * The next volume curve with a point added at `time`. With no curve yet, the
 * point seeds the array at the click time with the static gain (the curve is
 * then constant until a second point exists). With a curve, the added point
 * takes the curve's interpolated value unless `value` is supplied. The input
 * clip and its array are untouched.
 */
export function addVolumeKeyframe(clip: Clip, time: number, value?: number): Keyframe[] {
  const at = clampVolumeTime(clip, time)
  const gain = clampPropertyValue('volume', value ?? animatedValue(clip, 'volume', at))
  const kfs = volumeKeyframes(clip)
  if (kfs.length === 0) {
    return [{ time: at, value: gain, interpolation: 'linear' }]
  }
  const exact = kfs.find((k) => Math.abs(k.time - at) < 1e-6)
  if (exact) {
    return kfs.map((k) => ({ ...k, value: k === exact ? gain : k.value }))
  }
  const added: Keyframe = { time: at, value: gain, interpolation: 'linear' }
  return [...kfs.map((k) => ({ ...k })), added].sort((a, b) => a.time - b.time)
}

/** The next volume curve without the point at `index`; removing the last clears it. */
export function removeVolumeKeyframe(clip: Clip, index: number): Keyframe[] {
  const kfs = volumeKeyframes(clip)
  if (index < 0 || index >= kfs.length) return kfs.map((k) => ({ ...k }))
  return kfs.filter((_, i) => i !== index).map((k) => ({ ...k }))
}

/**
 * Move one point in time and value, clamping both to their legal ranges and
 * re-sorting when it crosses a neighbour. A time at exactly `clip.duration`
 * is kept exactly (no epsilon subtraction). The grabbed point keeps its own
 * value through a crossing because callers pass the index of the live array.
 */
export function moveVolumeKeyframe(
  clip: Clip,
  index: number,
  time: number,
  value: number,
): Keyframe[] {
  const kfs = volumeKeyframes(clip)
  if (index < 0 || index >= kfs.length) return kfs.map((k) => ({ ...k }))
  const at = clampVolumeTime(clip, time)
  const gain = clampPropertyValue('volume', value)
  return kfs
    .map((k, i) => (i === index ? { ...k, time: at, value: gain } : { ...k }))
    .sort((a, b) => a.time - b.time)
}

/**
 * True when this clip is the one that actually carries the group's sound, so
 * the volume envelope belongs on it. A linked video half is silent (its twin
 * carries the pair), a text or image clip has no sound, and a compound is
 * checked through its referenced sequence. A muted clip still carries its
 * curve (the envelope dims but stays editable), and a missing media asset is
 * not treated as a sound source.
 */
export function clipCarriesSound(doc: Doc, clip: Clip, depth = 0): boolean {
  if (clip.text !== undefined) return false
  if (clip.sequenceId) {
    if (depth >= MAX_SEQUENCE_DEPTH) return false
    const sequence = findSequence(doc, clip.sequenceId)
    return (
      !!sequence &&
      sequence.tracks.some(
        (track) =>
          track.kind !== 'text' &&
          track.clips.some((child) => clipCarriesSound(doc, child, depth + 1)),
      )
    )
  }
  // The audio part of an A/V pair is the carrier even when its asset metadata
  // is missing: the structural flag is the truth.
  if (clip.audioOnly) return true
  const asset = findMedia(doc, clip.mediaId)
  if (!asset || asset.kind === 'image') return false
  if (asset.kind === 'audio') return true
  // A video half that has a linked audio twin is shadowed by it; a solo video
  // carries its own embedded sound when the import probe says it has any.
  if (hasLinkedAudioTwin(doc, clip)) return false
  return assetHasAudio(asset)
}
