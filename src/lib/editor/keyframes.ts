import { easingArea, easingFunction } from './bezier'
import { KEYFRAME_PROPERTY_BOUNDS } from './constants'
import {
  areaControls,
  evaluateControls,
  parameterAtX,
  segmentControls,
  subdivideControls,
  withSegmentControls,
  type BezierQuad,
} from './ease-segment'
import type {
  Clip,
  Keyframe,
  KeyframeDefaults,
  KeyframeInterpolation,
  KeyframeMap,
  KeyframeProperty,
} from './types'

/**
 * Keyframe engine, per-property animation for clips.
 *
 * Model: `clip.keyframes[property]` is a time-sorted array of keyframes. Times
 * are CLIP-LOCAL timeline seconds (0 = clip start), so moves/duplicates carry
 * their animation along for free and `splitClip` redistributes the arrays.
 * Evaluation constant-extends before the first and after the last keyframe.
 * Each segment eases with the OUTGOING keyframe's interpolation (linear when
 * the field is absent), the same convention Premiere uses.
 */

export type { Keyframe, KeyframeMap, KeyframeProperty }

/** Every legal interpolation name, in menu order. */
export const KEYFRAME_INTERPOLATIONS: readonly KeyframeInterpolation[] = [
  'linear',
  'easeIn',
  'easeOut',
  'easeInOut',
]

/** Narrows an untrusted value (a hydrated file) to a legal interpolation. */
export function isKeyframeInterpolation(v: unknown): v is KeyframeInterpolation {
  return typeof v === 'string' && (KEYFRAME_INTERPOLATIONS as readonly string[]).includes(v)
}

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
  'timeScale',
]

export function isAnimatableProperty(p: string): p is KeyframeProperty {
  return (ANIMATABLE_PROPERTIES as readonly string[]).includes(p)
}

/**
 * The property's default easing for NEW keyframes; absent reads as linear.
 * Both authoring sites (the diamond seed and a slider write on an animated
 * property) stamp this, so a project can carry its own curve style.
 */
export function keyframeDefaultEasing(
  defaults: KeyframeDefaults | undefined,
  property: KeyframeProperty,
): KeyframeInterpolation {
  return defaults?.[property] ?? 'linear'
}

/** The property's static (non-animated) value on a clip, or the default. */
export function staticPropertyValue(clip: Clip, property: KeyframeProperty): number {
  switch (property) {
    case 'opacity':
      return clip.opacity ?? 1
    case 'volume':
      return clip.gain ?? 1
    // The clip's constant rate is the ramp's fallback and its static control.
    case 'timeScale':
      return clip.speed ?? 1
    default:
      return clip.animStatics?.[property] ?? KEYFRAME_PROPERTY_BOUNDS[property].default
  }
}

/**
 * True when the clip carries a `timeScale` curve AT ALL (even the identity
 * seed or a flat constant): such a curve OWNS the clip's source consumption
 * (`sourceTimeAt` reads the curve, the static speed is only its fallback), so
 * the command layer must not re-derive durations from the static rate and the
 * speed controls have nothing to edit. Audio and playback policy use the
 * narrower `hasTimeScaleRamp` instead: a constant curve is resamplable.
 */
export function hasTimeScaleCurve(clip: Clip): boolean {
  return (clip.keyframes?.timeScale?.length ?? 0) > 0
}

/**
 * The rate a CONSTANT `timeScale` curve prescribes, undefined for a real ramp
 * (or no curve). A curve whose keyframes all carry the same value retimes the
 * picture at exactly that constant rate, and a constant rate can be followed
 * by an element's `playbackRate`: it needs neither stepped playback nor a
 * dropped audio track. The curve still overrides `clip.speed` (see
 * `sourceTimeAt`), so consumers must use this rate, not the static field.
 */
export function constantTimeScaleRate(clip: Clip): number | undefined {
  const kfs = clip.keyframes?.timeScale
  if (!kfs || kfs.length === 0) return undefined
  const first = kfs[0].value
  return kfs.every((k) => k.value === first) ? first : undefined
}

/**
 * True when a clip carries a real time-remapping curve: one whose rate
 * actually changes, so no constant playbackRate can follow it and its audio
 * must be dropped (both render paths). Such a clip's rate is the curve (its
 * static speed is only the no-curve fallback), so the speed sliders and
 * Alt-drag rate stretch have nothing to change on it. An IDENTITY curve (the
 * diamond's first click seeds the current static value, typically `[{0, 1}]`)
 * and any other flat curve are NOT ramps: the retiming they describe is
 * exactly expressible as a constant rate, so muting them would only destroy
 * audio the engines can still play.
 */
export function hasTimeScaleRamp(clip: Clip): boolean {
  return hasTimeScaleCurve(clip) && constantTimeScaleRate(clip) === undefined
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

/**
 * Interpolation over a sorted keyframe array (constant-extended). Each segment
 * eases with its outgoing keyframe's interpolation; the endpoints of a segment
 * are always the exact keyframe values.
 */
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
      const controls = segmentControls(a)
      return (
        a.value +
        (b.value - a.value) *
          (controls ? evaluateControls(controls, p) : easingFunction(a.interpolation)(p))
      )
    }
  }
  return fallback
}

/**
 * Integral of one segment's curve over `span` seconds from the segment start:
 * the exact analytic form, so a long ramp does not accumulate quadrature drift.
 * `a.value * span` is the base and the second term is the curve's shape.
 */
function integrateSegment(a: Keyframe, b: Keyframe, span: number): number {
  const full = b.time - a.time
  if (full <= 1e-9) return a.value * span
  const q = Math.min(1, Math.max(0, span / full))
  const controls = segmentControls(a)
  const area = controls ? areaControls(controls) : easingArea(a.interpolation)
  return a.value * span + (b.value - a.value) * full * area(q)
}

/**
 * The curve's integral from 0 to `upTo`, in value-seconds. For a `timeScale`
 * ramp this is the SOURCE seconds a clip consumes over that much timeline, so
 * the clip's own length and the export's frame count never change: a ramp only
 * re-times which source material each timeline second shows. Constant-extended
 * before the first and after the last keyframe, exactly like
 * `evaluateKeyframes`, and assumes the array is sorted (sanitize guarantees it).
 */
export function integrateKeyframes(kfs: Keyframe[], upTo: number, fallback: number): number {
  if (kfs.length === 0) return upTo * fallback
  if (upTo <= 0) return 0
  const first = kfs[0]
  const last = kfs[kfs.length - 1]
  if (upTo <= first.time) return upTo * first.value
  let total = first.time * first.value
  let cursor = first.time
  for (let i = 0; i < kfs.length - 1 && cursor < upTo; i++) {
    const a = kfs[i]
    const b = kfs[i + 1]
    const end = Math.min(upTo, b.time)
    if (end > cursor) {
      total += integrateSegment(a, b, end - cursor)
      cursor = end
    }
  }
  if (cursor < upTo) total += (upTo - cursor) * last.value
  return total
}

/** Clamps a value into the property's legal range. */
export function clampPropertyValue(property: KeyframeProperty, value: number): number {
  const { min, max } = KEYFRAME_PROPERTY_BOUNDS[property]
  return Math.min(max, Math.max(min, value))
}

/**
 * Validates + sorts a keyframe array for a property; clamps values into bounds
 * and normalizes the interpolation (absent or unknown reads as linear).
 */
export function sanitizeKeyframes(property: KeyframeProperty, keyframes: Keyframe[]): Keyframe[] {
  return keyframes
    .filter((k) => Number.isFinite(k.time) && k.time >= 0 && Number.isFinite(k.value))
    .map((k) => ({
      time: k.time,
      value: clampPropertyValue(property, k.value),
      interpolation: isKeyframeInterpolation(k.interpolation) ? k.interpolation : 'linear',
      // A malformed (or foreign) control quad falls back to the preset name;
      // a valid one rides along.
      ...(isValidQuad(k.easeOut) ? { easeOut: k.easeOut } : {}),
    }))
    .sort((a, b) => a.time - b.time)
}

/** A valid easeOut quad: four finite numbers inside the unit square. */
function isValidQuad(q: unknown): q is [number, number, number, number] {
  return (
    Array.isArray(q) &&
    q.length === 4 &&
    q.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1)
  )
}

/**
 * Easing of the segment a cut at `at` falls inside (linear outside the curve).
 * Shared by `splitKeyframeMap` and the trimClip ramp rebase, which both pin a
 * boundary keyframe at the cut and need it to carry the cut segment's easing.
 */
export function cutInterpolation(kfs: Keyframe[], at: number): KeyframeInterpolation {
  const nextIndex = kfs.findIndex((k) => k.time >= at)
  return nextIndex > 0 ? (kfs[nextIndex - 1].interpolation ?? 'linear') : 'linear'
}

/**
 * Subdivides the segment that spans `cut` inside a sorted keyframe array.
 * Returns the de Casteljau pieces of that segment's shape (`left` drives the
 * part before the cut, `right` the part after), or undefined when nothing
 * eased crosses the cut: the cut sits outside the keyframed range (where the
 * curve constant-extends, so both pieces are linear) or the crossing segment
 * is linear (a linear segment subdivides to itself). The CALLERS place the
 * data: the last keyframe at or before the cut carries `left` (its outgoing
 * segment became the left sub-curve), and the boundary keyframe appended at
 * the cut carries `right` (its outgoing segment is the right sub-curve).
 */
export function subdivideSegmentAt(
  kfs: Keyframe[],
  cut: number,
): { left: BezierQuad; right: BezierQuad } | undefined {
  const startKf = kfs[0]
  const endKf = kfs[kfs.length - 1]
  if (!startKf || !endKf || kfs.length < 2) return undefined
  if (cut <= startKf.time || cut >= endKf.time) return undefined
  const segIndex = kfs.findIndex((k) => k.time >= cut)
  if (segIndex <= 0) return undefined
  const a = kfs[segIndex - 1]
  const b = kfs[segIndex]
  // A cut exactly on a keyframe crosses no segment interior.
  if (b.time === cut) return undefined
  const controls = segmentControls(a)
  if (!controls) return undefined
  const span = b.time - a.time
  if (span <= 1e-9) return undefined
  const u = parameterAtX(controls, (cut - a.time) / span)
  if (u <= 1e-9 || u >= 1 - 1e-9) return undefined
  return subdivideControls(controls, u)
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
 * that value), and the boundary inherits the easing of the segment it splits so
 * an eased segment does not snap to linear at the cut. Returns [leftMap,
 * rightMap] (either may be undefined when empty).
 *
 * `opts.reverse` with `opts.duration` (the clip's length BEFORE the cut) flips
 * which piece of a `timeScale` ramp each half takes: a reversed clip reads its
 * ramp through the MIRRORED offset (`sourceTimeAt` integrates from the source
 * side), so the right half keeps the curve's source-side head and the left half
 * takes the tail shifted into its own frame. Every other property is a function
 * of plain local time and always splits front-to-back. A reversed constant-rate
 * clip is unaffected either way (every piece of a flat curve is the same),
 * which is why the constant-speed reverse split never needed this.
 */
export function splitKeyframeMap(
  map: KeyframeMap | undefined,
  at: number,
  opts: { reverse?: boolean; duration?: number } = {},
): [KeyframeMap | undefined, KeyframeMap | undefined] {
  if (!map) return [undefined, undefined]
  const left: KeyframeMap = {}
  const right: KeyframeMap = {}
  let anyLeft = false
  let anyRight = false
  for (const property of Object.keys(map) as KeyframeProperty[]) {
    const kfs = map[property]
    if (!kfs || kfs.length === 0) continue
    const mirrored = !!opts.reverse && property === 'timeScale' && opts.duration !== undefined
    if (mirrored) {
      // The cut in SOURCE-side local time: the right half owns the first
      // `duration - at` seconds of the curve, the left half the rest.
      const cut = Math.max(0, opts.duration! - at)
      const boundary = evaluateKeyframes(kfs, cut, kfs[0].value)
      const easing = cutInterpolation(kfs, cut)
      const pieces = subdivideSegmentAt(kfs, cut)
      const l = kfs.filter((k) => k.time >= cut).map((k) => ({ ...k, time: k.time - cut }))
      if (l.length === 0 || l[0].time > 0) {
        // The left half starts at the boundary and eases with the boundary's
        // OUTGOING interpolation, which is the crossing segment's right piece.
        l.unshift({
          time: 0,
          value: boundary,
          interpolation: easing,
          ...(pieces ? { easeOut: pieces.right } : {}),
        })
      }
      const r = kfs.filter((k) => k.time <= cut)
      if (r.length === 0 || r[r.length - 1].time < cut) {
        // The right half's appended boundary reads linear (the curve ENDS
        // here for the right half); the crossing segment's left piece rides
        // on the last keyframe BEFORE the cut, whose outgoing side is the
        // pre-cut tail.
        if (pieces && r.length > 0) {
          const lastR = r[r.length - 1]
          r[r.length - 1] = withSegmentControls(lastR, pieces.left)
        }
        r.push({ time: cut, value: boundary, interpolation: 'linear' })
      }
      left[property] = l
      right[property] = r
      anyLeft = true
      anyRight = true
      continue
    }
    const boundary = evaluateKeyframes(kfs, at, kfs[0].value)
    // The boundary keyframe inherits the easing of the segment the cut falls
    // inside, so the right half's first segment keeps the curve's shape (a cut
    // before or at the first keyframe is the constant extension: linear).
    const easing = cutInterpolation(kfs, at)
    // An eased segment crossing the cut SUBDIVIDES: the exact left piece
    // rides on the left half's last keyframe (its outgoing segment became the
    // pre-cut tail), the right piece on the boundary keyframe the right half
    // starts with. Both halves then re-time the original exactly instead of
    // re-applying the preset name over a shortened span.
    const pieces = subdivideSegmentAt(kfs, at)
    const l = kfs.filter((k) => k.time < at)
    if (pieces && l.length > 0) {
      const lastLeft = l[l.length - 1]
      l[l.length - 1] = withSegmentControls(lastLeft, pieces.left)
    }
    const r = kfs.filter((k) => k.time >= at).map((k) => ({ ...k, time: k.time - at }))
    l.push({
      time: at,
      value: boundary,
      interpolation: easing,
      ...(pieces ? { easeOut: pieces.right } : {}),
    })
    if (r.length === 0 || r[0].time > 0) {
      r.unshift({
        time: 0,
        value: boundary,
        interpolation: easing,
        ...(pieces ? { easeOut: pieces.right } : {}),
      })
    }
    left[property] = l
    right[property] = r
    anyLeft = true
    anyRight = true
  }
  return [anyLeft ? left : undefined, anyRight ? right : undefined]
}
