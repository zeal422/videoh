/**
 * Effect-stack helpers (0.8.6): the ordered per-clip stack of crop, chroma
 * key, track matte and motion blur entries. Blend mode is NOT here (it is a
 * fixed `Clip.blendMode` field). Pure TypeScript, no browser APIs.
 *
 * Order rule: entries apply top-first in stored order, except motion blur,
 * which always evaluates last regardless of list position. Duplicates are
 * allowed; each entry has its own id and its own curves.
 */
import {
  BLUR_SHUTTER_MAX,
  BLUR_SHUTTER_MIN,
  CHROMA_BLEND_MAX,
  CHROMA_BLEND_MIN,
  CHROMA_CLIP_MAX,
  CHROMA_CLIP_MIN,
  CHROMA_DESPILL_MAX,
  CHROMA_DESPILL_MIN,
  CHROMA_SIMILARITY_MAX,
  CHROMA_SIMILARITY_MIN,
  CROP_FEATHER_MAX,
  CROP_FEATHER_MIN,
  CROP_MAX,
  CROP_MIN,
  MAX_BLUR_SAMPLES,
} from './constants'
import { findClip, findTrackIn, sequenceTracks, uid } from './factories'
import { evaluateKeyframes, isKeyframeInterpolation, splitKeyframeMap } from './keyframes'
import type {
  BlendMode,
  Clip,
  Doc,
  EffectEntry,
  EffectKeyframeMap,
  EffectKeyframeProperty,
  Keyframe,
  KeyframeMap,
  Track,
} from './types'

/** The canvas-supported blend set, in UI order. Absent on a clip means 'normal'. */
export const BLEND_MODES: readonly BlendMode[] = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'softLight',
  'hardLight',
  'darken',
  'lighten',
  'colorDodge',
  'colorBurn',
  'linearDodge',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
] as const

/** Whether a value names a supported blend mode. */
export function isBlendMode(v: unknown): v is BlendMode {
  return typeof v === 'string' && (BLEND_MODES as readonly string[]).includes(v)
}

/**
 * Canvas composite operation for a blend mode. Both render paths are canvas,
 * so the same strings drive the preview and the export. Returns a plain
 * string union (not the DOM's GlobalCompositeOperation): this module stays
 * browser-free per the state-core rule, and the union assigns cleanly where
 * a canvas context expects the DOM type.
 */
export type BlendCompositeOperation =
  | 'source-over'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'soft-light'
  | 'hard-light'
  | 'darken'
  | 'lighten'
  | 'color-dodge'
  | 'color-burn'
  | 'lighter'
  | 'difference'
  | 'exclusion'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity'

/** Canvas operation per non-normal blend mode (exhaustive: the compiler rejects a missing mode). */
const BLEND_TO_OPERATION: Record<Exclude<BlendMode, 'normal'>, BlendCompositeOperation> = {
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',
  softLight: 'soft-light',
  hardLight: 'hard-light',
  darken: 'darken',
  lighten: 'lighten',
  colorDodge: 'color-dodge',
  colorBurn: 'color-burn',
  linearDodge: 'lighter',
  difference: 'difference',
  exclusion: 'exclusion',
  hue: 'hue',
  saturation: 'saturation',
  color: 'color',
  luminosity: 'luminosity',
}

export function blendCompositeOperation(mode: BlendMode | undefined): BlendCompositeOperation {
  if (mode === undefined || mode === 'normal') return 'source-over'
  return BLEND_TO_OPERATION[mode]
}

/** Legal value bounds + defaults per effect-keyframable property. */
export const EFFECT_KEYFRAME_BOUNDS: Record<
  EffectKeyframeProperty,
  { min: number; max: number; default: number }
> = {
  left: { min: CROP_MIN, max: CROP_MAX, default: 0 },
  right: { min: CROP_MIN, max: CROP_MAX, default: 0 },
  top: { min: CROP_MIN, max: CROP_MAX, default: 0 },
  bottom: { min: CROP_MIN, max: CROP_MAX, default: 0 },
  feather: { min: CROP_FEATHER_MIN, max: CROP_FEATHER_MAX, default: 0 },
  shutter: { min: BLUR_SHUTTER_MIN, max: BLUR_SHUTTER_MAX, default: 180 },
}

/** Properties each effect type may animate. Everything else is static. */
const KEYFRAMABLE_BY_TYPE: Record<EffectEntry['type'], EffectKeyframeProperty[]> = {
  crop: ['left', 'right', 'top', 'bottom', 'feather'],
  chromaKey: [],
  trackMatte: [],
  motionBlur: ['shutter'],
}

/** Enabled entries in stored order (absent stack reads as empty). */
export function enabledEffects(clip: Clip): EffectEntry[] {
  return (clip.effects ?? []).filter((e) => e.enabled !== false)
}

/** Stack entry by id, or undefined. */
export function findEffect(clip: Clip, effectId: string): EffectEntry | undefined {
  return (clip.effects ?? []).find((e) => e.id === effectId)
}

/** Whether a property of an entry type may carry a curve. */
export function isEffectKeyframable(
  type: EffectEntry['type'],
  property: string,
): property is EffectKeyframeProperty {
  return (KEYFRAMABLE_BY_TYPE[type] as string[]).includes(property)
}

/** Default value of an effect-keyframable property. */
export function effectPropertyDefault(property: EffectKeyframeProperty): number {
  return EFFECT_KEYFRAME_BOUNDS[property].default
}

/**
 * Clamp an effect-keyframable value into bounds. Non-finite reads as the
 * default (same posture as the flat clamp path: hostile input becomes
 * neutral, never NaN).
 */
export function clampEffectPropertyValue(property: EffectKeyframeProperty, value: number): number {
  const { min, max, default: fallback } = EFFECT_KEYFRAME_BOUNDS[property]
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/**
 * Validate + sort an effect keyframe array. Mirrors `sanitizeKeyframes`
 * (which cannot be reused: it takes a flat `KeyframeProperty`), with the
 * effect bounds above. Untrusted input safe: a non-array reads as empty,
 * and nulls, primitives, or entries without finite numeric time/value drop
 * instead of throwing mid-map.
 */
export function sanitizeEffectKeyframes(
  property: EffectKeyframeProperty,
  keyframes: Keyframe[],
): Keyframe[] {
  if (!Array.isArray(keyframes)) return []
  return keyframes
    .filter(
      (k): k is Keyframe =>
        typeof k === 'object' &&
        k !== null &&
        Number.isFinite((k as Keyframe).time) &&
        (k as Keyframe).time >= 0 &&
        Number.isFinite((k as Keyframe).value),
    )
    .map((k) => ({
      time: k.time,
      value: clampEffectPropertyValue(property, k.value),
      interpolation: isKeyframeInterpolation(k.interpolation) ? k.interpolation : 'linear',
      ...(k.easeOut &&
      Array.isArray(k.easeOut) &&
      k.easeOut.length === 4 &&
      k.easeOut.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1)
        ? { easeOut: k.easeOut as [number, number, number, number] }
        : {}),
    }))
    .sort((a, b) => a.time - b.time)
}

/** Evaluate an effect property at clip-local time (curve wins, else static param, else default). */
export function effectKeyframeValue(
  entry: EffectEntry,
  property: EffectKeyframeProperty,
  t: number,
): number {
  const kfs = entry.keyframes?.[property]
  // The static source lives on the entry itself; a non-number there (or a
  // property this entry type does not carry) reads as the default.
  const raw = (entry as unknown as Record<string, unknown>)[property]
  const fallback =
    typeof raw === 'number'
      ? clampEffectPropertyValue(property, raw)
      : effectPropertyDefault(property)
  if (!kfs || kfs.length === 0) return fallback
  return evaluateKeyframes(kfs, t, fallback)
}

/**
 * Split an effect keyframe map at a cut. Delegates to `splitKeyframeMap`,
 * whose generic path handles any key set; the mirror branch can never fire
 * (it requires property 'timeScale', which effect maps never contain), so
 * effect curves always split front-to-back with no reverse mirroring.
 */
export function splitEffectKeyframes(
  map: EffectKeyframeMap | undefined,
  at: number,
): [EffectKeyframeMap | undefined, EffectKeyframeMap | undefined] {
  const [left, right] = splitKeyframeMap(map as unknown as KeyframeMap | undefined, at)
  return [
    left as unknown as EffectKeyframeMap | undefined,
    right as unknown as EffectKeyframeMap | undefined,
  ]
}

/**
 * Samples for a shutter angle: none at zero (zero-cost bypass), otherwise at
 * least one, capped at MAX_BLUR_SAMPLES. Non-finite reads as zero.
 */
export function effectSamples(shutter: number): number {
  if (!Number.isFinite(shutter) || shutter <= 0) return 0
  return Math.min(MAX_BLUR_SAMPLES, Math.max(1, Math.ceil(shutter / 45)))
}

/**
 * Shutter window in seconds: the angle as a fraction of one frame interval.
 * Non-finite or non-positive shutters (and non-finite fps) yield zero.
 */
export function blurWindowSeconds(shutter: number, fps: number): number {
  if (!Number.isFinite(shutter) || shutter <= 0) return 0
  if (!Number.isFinite(fps) || fps <= 0) return 0
  return shutter / 360 / fps
}

/**
 * Sub-frame sample times for a frame at `t`: trailing, inclusive of frame
 * time, evenly spaced across the window, uniform weights (Premiere Transform
 * sampling is uniform, not gaussian). Empty when the window is zero.
 */
export function blurSampleTimes(t: number, shutter: number, fps: number): number[] {
  const window = blurWindowSeconds(shutter, fps)
  const n = effectSamples(shutter)
  if (window <= 0 || n === 0) return []
  const times: number[] = []
  for (let i = 0; i < n; i++) times.push(t - window + ((i + 1) * window) / n)
  return times
}

/** Crop rect in frame pixels from params at clip-local time `t`. */
export function cropRect(
  entry: Extract<EffectEntry, { type: 'crop' }>,
  t: number,
  frameW: number,
  frameH: number,
): { x: number; y: number; w: number; h: number } {
  const left = (effectKeyframeValue(entry, 'left', t) / 100) * frameW
  const right = (effectKeyframeValue(entry, 'right', t) / 100) * frameW
  const top = (effectKeyframeValue(entry, 'top', t) / 100) * frameH
  const bottom = (effectKeyframeValue(entry, 'bottom', t) / 100) * frameH
  return {
    x: left,
    y: top,
    w: Math.max(0, frameW - left - right),
    h: Math.max(0, frameH - top - bottom),
  }
}

/** Whether a crop consumes the whole frame (the clip draw is skipped). */
export function isCropConsumed(entry: Extract<EffectEntry, { type: 'crop' }>, t: number): boolean {
  const left = effectKeyframeValue(entry, 'left', t)
  const right = effectKeyframeValue(entry, 'right', t)
  const top = effectKeyframeValue(entry, 'top', t)
  const bottom = effectKeyframeValue(entry, 'bottom', t)
  return left + right >= 100 || top + bottom >= 100
}

/**
 * Feather band width in pixels: percent of the smaller frame dimension,
 * clamped per side so the band never inverts the cropped rect.
 */
export function cropFeatherPx(
  entry: Extract<EffectEntry, { type: 'crop' }>,
  t: number,
  frameW: number,
  frameH: number,
): number {
  const feather = effectKeyframeValue(entry, 'feather', t)
  const rect = cropRect(entry, t, frameW, frameH)
  const px = (feather / 100) * Math.min(frameW, frameH)
  return Math.max(0, Math.min(px, rect.w / 2, rect.h / 2))
}

export type EffectType = EffectEntry['type']

/** Fresh stack entry with defaults. Matte callers fill `trackId` after (validated by commands). */
export function createEffectEntry(type: EffectType): EffectEntry {
  const id = uid('fx')
  switch (type) {
    case 'crop':
      return { id, type, enabled: true }
    case 'chromaKey':
      return { id, type, enabled: true, key: '#00ff00' }
    case 'trackMatte':
      return { id, type, enabled: true }
    case 'motionBlur':
      return { id, type, enabled: true }
  }
}

/**
 * Resolve a matte entry to its source track: the `trackId` must name a track
 * in the clip's OWNING sequence (found via `findClip`) that sits ABOVE the
 * clip's track (lower index; `tracks[0]` is topmost). Anything else is
 * unresolvable; renderers skip the effect, never crash.
 */
export function resolveMatteTrack(
  doc: Doc,
  clipId: string,
  entry: Extract<EffectEntry, { type: 'trackMatte' }>,
): Track | undefined {
  if (typeof entry.trackId !== 'string' || entry.trackId === '') return undefined
  const owner = findClip(doc, clipId)
  if (!owner) return undefined
  const tracks = sequenceTracks(doc, owner.sequenceId)
  const clipIndex = tracks.findIndex((t) => t.id === owner.track.id)
  const source = findTrackIn(doc, entry.trackId)
  if (!source || source.sequenceId !== owner.sequenceId) return undefined
  // Audio lanes carry no picture: a matte pointing at one would mask
  // everything with an empty surface (the UI offers video/text only, and the
  // trust boundary re-validates that here for command/file input).
  if (source.track.kind !== 'video' && source.track.kind !== 'text') return undefined
  const sourceIndex = tracks.findIndex((t) => t.id === entry.trackId)
  if (clipIndex === -1 || sourceIndex === -1 || sourceIndex >= clipIndex) return undefined
  return source.track
}

/** Chroma similarity bounds (re-exported for the keyer UI; bounds live in constants). */ export const CHROMA_BOUNDS =
  {
    similarity: { min: CHROMA_SIMILARITY_MIN, max: CHROMA_SIMILARITY_MAX },
    blend: { min: CHROMA_BLEND_MIN, max: CHROMA_BLEND_MAX },
    clip: { min: CHROMA_CLIP_MIN, max: CHROMA_CLIP_MAX },
    despill: { min: CHROMA_DESPILL_MIN, max: CHROMA_DESPILL_MAX },
  } as const
