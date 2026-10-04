/**
 * Per-segment easing DATA: the model that lets an eased segment be rebuilt on a
 * shortened span, which a preset name alone cannot express.
 *
 * The presets of `bezier.ts` are canonical cubic-beziers. A segment's shape is
 * stored on the keyframe that STARTS it as `easeOut` (a cubic-bezier control
 * quadruple); a keyframe whose outgoing side is linear stores none. A
 * keyframe's `interpolation` stays the display name for the UI; every reader
 * derives the SEGMENT's controls from `easeOut ?? EASING_PRESETS[interpolation]`,
 * so old files (no data, name only) and new files read identically through
 * `segmentControls`.
 *
 * Splitting or rebasing a span then SUBDIVIDES the segment at the cut with de
 * Casteljau (exact, no re-approximation), which is what the split and trim
 * rebase paths needed: a preset name cannot be re-scaled onto a shortened
 * span, but a bezier can be cut exactly at any parameter.
 */

import { EASING_PRESETS, cubicBezier, cubicBezierArea, makeSolveT } from './bezier'
import type { KeyframeInterpolation } from './types'

/** Control quadruple of one side of a segment: cubic-bezier(x1, y1, x2, y2). */
export type BezierQuad = readonly [number, number, number, number]

/** The preset controls for a named interpolation, undefined for linear. */
export function presetControls(
  interpolation: KeyframeInterpolation | undefined,
): BezierQuad | undefined {
  if (!interpolation || interpolation === 'linear') return undefined
  return EASING_PRESETS[interpolation]
}

/**
 * The controls of the segment that STARTS at `kf` (its outgoing side): the
 * keyframe's own `easeOut` when it carries one, else the preset its
 * `interpolation` names, else linear (undefined).
 */
export function segmentControls(kf: {
  interpolation?: KeyframeInterpolation
  easeOut?: BezierQuad
}): BezierQuad | undefined {
  return kf.easeOut ?? presetControls(kf.interpolation)
}

/**
 * Returns a copy of `kf` whose outgoing side is `controls` (undefined = linear).
 * Passing `undefined` CLEARS any existing `easeOut`, so the copy really is
 * linear rather than silently keeping the shape it had.
 */
export function withSegmentControls<K>(kf: K, controls: BezierQuad | undefined): K {
  const next = { ...kf } as K & { easeOut?: BezierQuad }
  if (controls) next.easeOut = controls
  else delete next.easeOut
  return next
}

/**
 * Subdivides one timing curve at progress `u` and returns BOTH halves' control
 * quads: `left` drives the segment's first `u` of progress, `right` the
 * remainder. Exact de Casteljau on the (x, y) control polygon; the halves
 * join the original curve seamlessly and keep its endpoints' slopes. Each
 * half is renormalized into the unit square (its own 0..1 progress against
 * its own 0..1 value), so both are valid timing functions.
 */
export function subdivideControls(
  controls: BezierQuad,
  u: number,
): { left: BezierQuad; right: BezierQuad } {
  const [x1, y1, x2, y2] = controls
  // de Casteljau: P0=(0,0), P1=(x1,y1), P2=(x2,y2), P3=(1,1).
  const lerp = (a: number, b: number) => a + (b - a) * u
  // First level.
  const p01x = lerp(0, x1)
  const p01y = lerp(0, y1)
  const p12x = lerp(x1, x2)
  const p12y = lerp(y1, y2)
  const p23x = lerp(x2, 1)
  const p23y = lerp(y2, 1)
  // Second level.
  const p012x = lerp(p01x, p12x)
  const p012y = lerp(p01y, p12y)
  const p123x = lerp(p12x, p23x)
  const p123y = lerp(p12y, p23y)
  // Third level: the point Q on the curve at parameter u.
  const qx = lerp(p012x, p123x)
  const qy = lerp(p012y, p123y)
  const wx = 1 - qx
  const wy = 1 - qy
  return {
    // Left half: P0 -> P01 -> P012 -> Q, translated (already at the origin)
    // and normalized by Q so it is a timing function over its own unit box.
    left: [p01x / qx, p01y / qy, p012x / qx, p012y / qy],
    // Right half: Q -> P123 -> P23 -> P3, translated by Q and normalized.
    right: [(p123x - qx) / wx, (p123y - qy) / wy, (p23x - qx) / wx, (p23y - qy) / wy],
  }
}

/**
 * The bezier PARAMETER at which the curve's x (time progress) reaches `p`.
 * A TIME cut at progress p subdivides at this parameter (de Casteljau is
 * parameter-space), solved by the SAME solver the presets use (`makeSolveT`
 * in bezier.ts), whose 1e-9 epsilon is what the subdivision data it produces
 * needs: the halves re-time through it.
 */
export function parameterAtX(controls: BezierQuad, p: number): number {
  if (p <= 0) return 0
  if (p >= 1) return 1
  const [x1, , x2] = controls
  return makeSolveT(x1, x2)(p)
}

/** Evaluates a segment's shape at progress `u` (matches `easingFunction`). */
export function evaluateControls(controls: BezierQuad, u: number): number {
  return cubicBezier(controls[0], controls[1], controls[2], controls[3])(u)
}

/** The area function of a segment's shape: ∫₀^q of the timing curve. */
export function areaControls(controls: BezierQuad): (q: number) => number {
  return cubicBezierArea(controls[0], controls[1], controls[2], controls[3])
}
