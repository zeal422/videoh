import type { Clip } from './types'

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
  /** Opacity of the outgoing clip at time t (1 → 0 across the span). */
  aAlpha: number
  /** Opacity of the incoming clip at time t (0 → 1 across the span). */
  bAlpha: number
}

/** Linear crossfade alphas at absolute time `t`. Outside the span both are 1. */
export function transitionAlphas(span: TransitionSpan, t: number): TransitionAlphas {
  if (t <= span.start) return { aAlpha: 1, bAlpha: 0 }
  if (t >= span.end) return { aAlpha: 0, bAlpha: 1 }
  const p = (t - span.start) / Math.max(1e-9, span.duration)
  return { aAlpha: 1 - p, bAlpha: p }
}

/** Highest transition duration that both clips can physically host. */
export function maxTransitionDuration(a: Clip, b: Clip, aEnd: number): number {
  return Math.max(0, Math.min(a.duration, b.duration, aEnd))
}
