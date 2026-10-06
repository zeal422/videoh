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
import type { Keyframe, KeyframeInterpolation } from './types'

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
 * The straight line's canonical controls: a cubic with all four control
 * points on y = x, so `cubicBezier` returns the identity function. The base
 * for a segment that has no stored quad yet (the handles start here) and the
 * fallback the graph reports when nothing is stored.
 */
export const LINEAR_QUAD: BezierQuad = [1 / 3, 1 / 3, 2 / 3, 2 / 3]

/**
 * The same segment read right-to-left: [(1-x2), (1-y2), (1-x1), (1-y1)].
 * An involution: the same call mirrors a stored quad for a reversed row's
 * drawing and un-mirrors an edited quad on the way back to storage, which is
 * what keeps the mirrored row's draw and drag one rule instead of two.
 */
export function mirrorQuad(controls: BezierQuad): BezierQuad {
  const [x1, y1, x2, y2] = controls
  return [1 - x2, 1 - y2, 1 - x1, 1 - y1]
}

/**
 * `controls` with one handle moved to `at`, both clamped to [0, 1].
 * `out` = (x1, y1), `in` = (x2, y2).
 */
export function withQuadHandle(
  controls: BezierQuad,
  which: 'out' | 'in',
  at: { x: number; y: number },
): BezierQuad {
  const x = Math.max(0, Math.min(1, at.x))
  const y = Math.max(0, Math.min(1, at.y))
  return which === 'out' ? [x, y, controls[2], controls[3]] : [controls[0], controls[1], x, y]
}

/**
 * The picker's stamp rule, extracted from the panel: name plus the preset's
 * exact quad, or name only for linear. The name stays the display shorthand;
 * the quad is what a later split or trim subdivides, so both must be written
 * together.
 */
export function withEasing(kf: Keyframe, interpolation: KeyframeInterpolation): Keyframe {
  const controls = presetControls(interpolation)
  if (!controls) return withSegmentControls({ ...kf, interpolation }, undefined)
  // A fresh array, not the shared preset tuple: the result lands in the doc.
  const copy: BezierQuad = [controls[0], controls[1], controls[2], controls[3]]
  return withSegmentControls({ ...kf, interpolation }, copy)
}

/** True when two quads hold the same four numbers (absent matches absent). */
function sameQuad(a: BezierQuad | undefined, b: BezierQuad | undefined): boolean {
  if (!a || !b) return a === b
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3]
}

/**
 * The preset a quad lands on, with its canonical controls. The comparison is
 * tolerant on purpose: mirroring a preset's numbers arithmetically lands a
 * floating-point step off (1 - 0.58 is not 0.42), and storing that step would
 * stop `displayedInterpolation`'s exact match from naming the segment. A
 * mirrored preset must therefore store the preset's own numbers again.
 */
function presetFor(
  quad: BezierQuad,
): { name: KeyframeInterpolation; controls: BezierQuad } | undefined {
  const names = Object.keys(EASING_PRESETS) as (keyof typeof EASING_PRESETS)[]
  const name = names.find((n) => EASING_PRESETS[n].every((v, i) => Math.abs(v - quad[i]) < 1e-9))
  if (!name) return undefined
  const controls = EASING_PRESETS[name]
  return { name, controls: [controls[0], controls[1], controls[2], controls[3]] }
}

/**
 * Keeps every authored segment shape on the keyframe that STARTS its segment
 * after the caller REORDERS the same keyframes (a dot dragged or nudged past a
 * neighbour). A plain time sort would silently move the curves: the new start
 * of a pair carries no quad, so its segment draws linear, while the old start
 * keeps a quad for a segment that no longer begins there.
 *
 * Only an index-aligned write that moves exactly ONE keyframe's time counts as
 * a reorder, which is exactly the drag and nudge shape; structural writes (a
 * split, a trim, a keyframe added or removed) pass through untouched, and so
 * does a re-insert at the playhead, which shifts the tail by one index (on a
 * plateau, where the values and the shaping all coincide, that shift looks
 * aligned and would otherwise read as a reorder).
 * A pair that stays adjacent keeps its shape, MIRRORED when the pair now runs
 * the other way (reading a curve backwards is its mirror, so easeOut reads as
 * easeIn and easeInOut as itself) and named for the mirrored preset, or left
 * linear when no preset matches. A keyframe that starts no preserved pair
 * starts linear again, name included, so a stale quad cannot resurface on the
 * next keyframe added after it.
 *
 * Returns the keyframes in TIME ORDER: the sort is what the reorder detection
 * needs, and the command sanitizes (and sorts) the result anyway.
 */
export function rehomeSegmentShapes(
  before: readonly Keyframe[],
  incoming: readonly Keyframe[],
): Keyframe[] {
  if (before.length !== incoming.length || before.length < 2) return [...incoming]
  // A malformed write (a non-finite time from a foreign caller) must not read
  // as a reorder: sanitize drops those entries after this runs, and sorting
  // around NaN would shuffle the array underneath that filter.
  if (!incoming.every((k) => Number.isFinite(k.time))) return [...incoming]
  const indexAligned = incoming.every((k, i) => {
    const b = before[i]
    return (
      k.value === b.value &&
      (k.interpolation ?? 'linear') === (b.interpolation ?? 'linear') &&
      sameQuad(k.easeOut, b.easeOut)
    )
  })
  if (!indexAligned) return [...incoming]
  // A reorder moves ONE keyframe in time: the dot drag writes that one time and
  // leaves every other field of every keyframe byte-identical, and the keyboard
  // nudge is the same write. Two or more moved times mean the array was
  // rebuilt (see the doc above), not reordered.
  let movedTimes = 0
  for (let i = 0; i < incoming.length; i++) {
    if (incoming[i].time !== before[i].time) movedTimes++
  }
  if (movedTimes !== 1) return [...incoming]
  const order = incoming.map((_, i) => i).sort((a, b) => incoming[a].time - incoming[b].time)
  // Stored arrays are always sorted: an already sorted write moved nothing.
  if (order.every((index, position) => index === position)) return [...incoming]

  const shape = new Map<number, { quad?: BezierQuad; interpolation: KeyframeInterpolation }>()
  for (let p = 0; p + 1 < order.length; p++) {
    const u = order[p]
    const v = order[p + 1]
    if (v === u + 1) {
      // The same neighbours in the same direction: the quad already sits on u.
      shape.set(u, {
        quad: segmentControls(before[u]),
        interpolation: before[u].interpolation ?? 'linear',
      })
    } else if (u === v + 1) {
      // The pair runs the other way now, and the old start (v) authored it.
      const authored = segmentControls(before[v])
      const mirrored = authored && mirrorQuad(authored)
      const preset = mirrored && presetFor(mirrored)
      shape.set(u, {
        quad: preset ? preset.controls : mirrored,
        interpolation: preset ? preset.name : (before[v].interpolation ?? 'linear'),
      })
    }
    // Any other pair was not adjacent before: it is a NEW segment, so it stays
    // linear (no entry), and its old shape is dropped with it.
  }
  const last = order[order.length - 1]
  return order.map((index) => {
    const outgoing = index === last ? undefined : shape.get(index)
    return withSegmentControls<Keyframe>(
      { ...incoming[index], interpolation: outgoing?.interpolation ?? 'linear' },
      outgoing?.quad,
    )
  })
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
