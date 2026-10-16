import type { Clip, Track, TransitionDirection, WipeEdge } from './types'

/**
 * Cross-dissolve math (pure functions, shared by the compositor and the audio mixer).
 *
 * Model: a transition lives on the *outgoing* clip (`transitionOut`). The following
 * clip on the same track is expected to overlap the outgoing clip's tail — the
 * `addTransition` command creates that overlap by pulling the next clip left.
 * The *effective* transition duration is clamped at render time to whatever
 * overlap actually exists, so moving/trimming clips never corrupts playback.
 */

export interface TransitionSpan {
  /** Outgoing clip (holds the `transitionOut` property). */
  a: Clip
  /** Incoming clip (overlapping a's tail). */
  b: Clip
  /** Absolute start of the crossfade region (== b.start). */
  start: number
  /** Absolute end of the crossfade region (<= a.end). */
  end: number
  /** Effective duration (end - start), already clamped to the actual overlap. */
  duration: number
}

/**
 * Computes the crossfade span between clip `a` (with a transitionOut) and the
 * overlapping next clip `b`. Returns null when there is no transition or no overlap.
 */
export function getTransitionSpan(a: Clip, b: Clip): TransitionSpan | null {
  const requested = a.transitionOut?.duration ?? 0
  if (requested <= 0) return null
  const overlap = a.start + a.duration - b.start
  if (overlap <= 0) return null
  const duration = Math.min(requested, overlap)
  if (duration <= 0) return null
  return { a, b, start: b.start, end: b.start + duration, duration }
}

export interface TransitionAlphas {
  /** Outgoing clip's share at time t (crossfade: 1 → 0 across the span; dip: 1 → 0 across the first half). */
  aAlpha: number
  /** Incoming clip's share at time t (crossfade: 0 → 1 across the span; dip: 0 → 1 across the second half). */
  bAlpha: number
}

/**
 * Transition alphas at absolute time `t`. Outside the span both are 1.
 * Crossfade ramps linearly across the whole span; dip-to-black fades the
 * outgoing clip out over the first half and the incoming clip in over the
 * second half, so both are 0 at the midpoint (track-pair black: lower
 * tracks show through, exactly as under any transparency).
 */
export function transitionAlphas(span: TransitionSpan, t: number): TransitionAlphas {
  if (t <= span.start) return { aAlpha: 1, bAlpha: 0 }
  if (t >= span.end) return { aAlpha: 0, bAlpha: 1 }
  const p = (t - span.start) / Math.max(1e-9, span.duration)
  if (span.a.transitionOut?.type === 'dipToBlack') {
    if (p < 0.5) return { aAlpha: 1 - 2 * p, bAlpha: 0 }
    return { aAlpha: 0, bAlpha: 2 * p - 1 }
  }
  return { aAlpha: 1 - p, bAlpha: p }
}

/** Default feather width: fraction of the motion-axis frame dimension. */
export const TRANSITION_FEATHER_DEFAULT = 0.1
/** Widest feather: half the motion-axis frame dimension. */
export const TRANSITION_FEATHER_MAX = 0.5

export interface TransitionGeometry {
  /** Outgoing clip offset in pixels ({x:0,y:0} except push). */
  aOffset: { x: number; y: number }
  /** Incoming clip offset in pixels ({x:0,y:0} for wipe). */
  bOffset: { x: number; y: number }
  /** Revealed incoming region in pixels (wipe only, null otherwise). */
  wipeRect: { x: number; y: number; w: number; h: number } | null
  /** Feather band width in pixels (feathered wipes only, else 0). */
  featherPx: number
  /** Echo of the transition direction, so draw sites place gradients without re-deriving the axis. */
  direction: TransitionDirection
  /** Feather band region in frame pixels (feathered wipes with width > 0, else null). */
  featherBand: { x: number; y: number; w: number; h: number } | null
}

/**
 * Spatial geometry of a wipe, slide or push at absolute time `t`.
 * Returns null for the alpha-only types (their draw path is unchanged).
 * Shared by the preview compositor and the export planner, so regions and
 * offsets match by construction. Progress is linear across the span and
 * clamped to [0, 1]: past span.end the pictures sit at rest, so the
 * [span.end, a.end) window never exposes background.
 */
export function transitionGeometry(
  span: TransitionSpan,
  t: number,
  width: number,
  height: number,
): TransitionGeometry | null {
  const out = span.a.transitionOut
  const type = out?.type
  if (type !== 'wipe' && type !== 'slide' && type !== 'push') return null
  const direction: TransitionDirection = out?.direction ?? 'left'
  const edge: WipeEdge = out?.edge ?? 'hard'
  // Commands and hydration validate, but both render paths read doc state
  // directly: a non-finite feather must still resolve to the default here,
  // never NaN into the gradient math.
  const rawFeather = out?.feather ?? TRANSITION_FEATHER_DEFAULT
  const feather = Number.isFinite(rawFeather)
    ? Math.min(TRANSITION_FEATHER_MAX, Math.max(0, rawFeather))
    : TRANSITION_FEATHER_DEFAULT
  const p = Math.min(1, Math.max(0, (t - span.start) / Math.max(1e-9, span.duration)))
  const horizontal = direction === 'left' || direction === 'right'
  const sign = direction === 'left' || direction === 'up' ? 1 : -1
  const dim = horizontal ? width : height
  const travel = p * dim
  // Normalize -0 to +0: at rest (p = 1) the incoming offset multiplies
  // out to negative zero, which is pixel-identical but breaks exact tests.
  const nz = (v: number) => v + 0
  if (type === 'wipe') {
    const f = edge === 'feathered' ? feather * dim : 0
    // The boundary travels dim + f so the band clears the frame exactly at
    // p = 1: with the band inside the revealed region, a completed wipe
    // would keep a permanent blend strip of the outgoing picture.
    const boundary = p * (dim + f)
    const revealed = Math.min(boundary, dim)
    const wipeRect =
      direction === 'left'
        ? { x: 0, y: 0, w: revealed, h: height }
        : direction === 'right'
          ? { x: width - revealed, y: 0, w: revealed, h: height }
          : direction === 'up'
            ? { x: 0, y: 0, w: width, h: revealed }
            : { x: 0, y: height - revealed, w: width, h: revealed }
    // Band sits at the wipe boundary, positioned by the unclamped travel;
    // null once it no longer overlaps the frame (before the start, past
    // the end), so a finished wipe draws the incoming picture pure.
    const bandOutside = f <= 0 || boundary <= 0 || boundary - f >= dim
    const featherBand = bandOutside
      ? null
      : direction === 'left'
        ? { x: boundary - f, y: 0, w: f, h: height }
        : direction === 'right'
          ? { x: width - boundary, y: 0, w: f, h: height }
          : direction === 'up'
            ? { x: 0, y: boundary - f, w: width, h: f }
            : { x: 0, y: height - boundary, w: width, h: f }
    return {
      aOffset: { x: 0, y: 0 },
      bOffset: { x: 0, y: 0 },
      wipeRect,
      featherPx: f,
      direction,
      featherBand,
    }
  }
  const off = (1 - p) * dim
  if (type === 'slide') {
    return {
      aOffset: { x: 0, y: 0 },
      bOffset: horizontal ? { x: nz(-sign * off), y: 0 } : { x: 0, y: nz(-sign * off) },
      wipeRect: null,
      featherPx: 0,
      direction,
      featherBand: null,
    }
  }
  return {
    aOffset: horizontal ? { x: nz(sign * travel), y: 0 } : { x: 0, y: nz(sign * travel) },
    bOffset: horizontal ? { x: nz(-sign * off), y: 0 } : { x: 0, y: nz(-sign * off) },
    wipeRect: null,
    featherPx: 0,
    direction,
    featherBand: null,
  }
}

/** Highest transition duration that both clips can physically host. */
export function maxTransitionDuration(a: Clip, b: Clip, aEnd: number): number {
  return Math.max(0, Math.min(a.duration, b.duration, aEnd))
}

/**
 * Gradient placement for a feathered wipe's mask: endpoints span the
 * revealed region from its inner edge to the wipe boundary, and `stops`
 * pins the opacity along it. The stops derive from the intersection of the
 * feather band with the revealed region, so a band clipped by a frame edge
 * starts or ends partway faded instead of fully opaque or transparent.
 * Pure numbers for both render paths, so the band placement is unit-pinned;
 * the canvas blending itself is visual-only. Returns null without a band.
 */
export function featherGradient(geo: TransitionGeometry): {
  x0: number
  y0: number
  x1: number
  y1: number
  stops: { at: number; opacity: number }[]
} | null {
  const rect = geo.wipeRect
  const band = geo.featherBand
  if (!rect || !band) return null
  const horizontal = geo.direction === 'left' || geo.direction === 'right'
  const R = horizontal ? rect.w : rect.h
  const f = horizontal ? band.w : band.h
  if (!(R > 0) || !(f > 0)) return null
  // Inner and boundary ends in absolute axis coords, and the sign from the
  // inner edge toward the boundary.
  // Inner and boundary ends in absolute axis coords, and the sign from the
  // inner edge toward the boundary. The boundary comes from the band, not
  // the revealed rect: past a frame edge the two differ, and the edge pixel
  // takes the band's partial opacity instead of dropping to zero.
  const I =
    geo.direction === 'left' || geo.direction === 'up'
      ? horizontal
        ? rect.x
        : rect.y
      : horizontal
        ? rect.x + rect.w
        : rect.y + rect.h
  const B =
    geo.direction === 'left'
      ? band.x + band.w
      : geo.direction === 'right'
        ? band.x
        : geo.direction === 'up'
          ? band.y + band.h
          : band.y
  const dir = B >= I ? 1 : -1
  const lo = Math.min(I, B)
  const hi = Math.max(I, B)
  // Opacity at an absolute position: 1 outside the band on the inner side,
  // linear across it, 0 at and past the boundary.
  const op = (a: number) => Math.min(1, Math.max(0, ((B - a) * dir) / f))
  const frac = (a: number) => ((a - I) * dir) / R
  const s = Math.min(Math.max(B - dir * f, lo), hi)
  const stops = [{ at: 0, opacity: op(I) }]
  // Strictly inside: at either end the band edge coincides with a gradient
  // end, which already carries that endpoint's opacity. A clamped band start
  // at the inner end would otherwise duplicate the start stop as solid.
  const sFrac = frac(s)
  if (sFrac > 0 && sFrac < 1) stops.push({ at: sFrac, opacity: 1 })
  // Evaluated at the gradient end, not the boundary: past the frame edge
  // the two differ, and the edge pixel takes the band's partial opacity.
  stops.push({ at: 1, opacity: op(I + dir * R) })
  const [x0, y0, x1, y1] =
    geo.direction === 'left'
      ? [rect.x, 0, rect.x + rect.w, 0]
      : geo.direction === 'right'
        ? [rect.x + rect.w, 0, rect.x, 0]
        : geo.direction === 'up'
          ? [0, rect.y, 0, rect.y + rect.h]
          : [0, rect.y + rect.h, 0, rect.y]
  return { x0, y0, x1, y1, stops }
}

/**
 * The crossfade gain factor a clip carries on its own track at sequence-local
 * time `seqT`: the outgoing clip ramps 1→0 across its `transitionOut` span, the
 * incoming one 0→1. Shared by the preview mixer and the export plan/mix, so a
 * clip's own crossfade AND an enclosing compound container's crossfade ramp the
 * audio identically in both render paths.
 */
export function crossfadeFactor(track: Track, clip: Clip, seqT: number): number {
  let factor = 1
  const clips = [...track.clips].sort((a, b) => a.start - b.start)
  for (let i = 0; i < clips.length - 1; i++) {
    const a = clips[i]
    const b = clips[i + 1]
    if (!a.transitionOut) continue
    const span = getTransitionSpan(a, b)
    if (!span || seqT < span.start || seqT > span.end) continue
    const p = (seqT - span.start) / Math.max(1e-9, span.duration)
    if (clip.id === a.id) factor *= 1 - p
    else if (clip.id === b.id) factor *= p
  }
  return factor
}
