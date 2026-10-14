import type { Clip, Track } from './types'

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

/** Highest transition duration that both clips can physically host. */
export function maxTransitionDuration(a: Clip, b: Clip, aEnd: number): number {
  return Math.max(0, Math.min(a.duration, b.duration, aEnd))
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
