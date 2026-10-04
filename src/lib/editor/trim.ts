/**
 * Pure trim and split arithmetic for the command layer: the source-fitting
 * bisection and the `timeScale` curve rebases a trim applies, plus the
 * source-consumption rule the trim and split engines share. Commands keep the
 * policy (which edge pins what, when a window clamps instead of throwing);
 * everything here takes plain values and returns new values, so it can be
 * unit tested without a doc or a store. Browser-free by design.
 */
import { MIN_CLIP_DURATION } from './constants'
import { withSegmentControls } from './ease-segment'
import {
  cutInterpolation,
  evaluateKeyframes,
  integrateKeyframes,
  subdivideSegmentAt,
} from './keyframes'
import type { Keyframe } from './types'

/**
 * Source seconds a clip-local span consumes: the `timeScale` curve's integral
 * when the clip carries one, else `offset * rate`. The one conversion the
 * trim guard, the trim recovery and the split span mapping all share (a ramp's
 * static rate is only its fallback).
 */
export function sourceConsumption(
  keyframes: Keyframe[] | undefined,
  offset: number,
  rate: number,
): number {
  return keyframes && keyframes.length > 0
    ? integrateKeyframes(keyframes, offset, rate)
    : offset * rate
}

/**
 * The largest duration in `[MIN_CLIP_DURATION, upper]` whose consumption from
 * `anchor` still fits `assetDuration`: the boundary the trim command clamps to
 * when a window over-consumes its source and a shorter span is the legal fix.
 * 32 bisection steps halve the range that many times, far below one frame at
 * any FPS. The caller guarantees a fitting span exists at or above
 * MIN_CLIP_DURATION (it checks the minimum before calling), so the search
 * always has a floor to stand on.
 */
export function largestFittingDuration(
  anchor: number,
  consumed: (duration: number) => number,
  assetDuration: number,
  upper: number,
): number {
  let below = MIN_CLIP_DURATION
  let above = upper
  for (let i = 0; i < 32; i++) {
    const mid = (below + above) / 2
    if (anchor + consumed(mid) <= assetDuration) below = mid
    else above = mid
  }
  return below
}

/**
 * The curve as read from a NEW origin `cut` seconds in: keyframes before the
 * cut fall off, survivors shift down onto 0. When the cut lands between
 * keyframes, a boundary keyframe is pinned at 0 carrying the segment's value
 * at the cut and the crossing segment's RIGHT de Casteljau piece (linear
 * outside the keyframed range, where nothing eased crosses), so the rebased
 * curve re-times the original exactly. Shared by a forward head shrink (the
 * head consumed the curve's start) and a reversed tail trim (the tail gave up
 * the curve's low end).
 */
export function rebaseCurveFromCut(keyframes: Keyframe[], cut: number): Keyframe[] {
  const kept = keyframes.filter((k) => k.time >= cut).map((k) => ({ ...k, time: k.time - cut }))
  // The boundary lands at local 0, so the pin test looks at the array START
  // it prepends to.
  if (kept.length === 0 || kept[0].time > 1e-9) {
    const pieces = subdivideSegmentAt(keyframes, cut)
    kept.unshift({
      time: 0,
      value: evaluateKeyframes(keyframes, cut, keyframes[0].value),
      interpolation: cutInterpolation(keyframes, cut),
      ...(pieces ? { easeOut: pieces.right } : {}),
    })
  }
  return kept
}

/**
 * The curve kept up to `cut`: keyframes past the cut fall off, so the result
 * reads as the source-side `[0, cut]` of the original. The boundary is
 * appended as a LINEAR keyframe (nothing starts at it in this frame), and when
 * the cut lands inside an eased segment the last survivor takes the crossing
 * segment's LEFT de Casteljau piece, so the truncated curve spans the kept
 * range exactly. A reversed head trim uses this: its head edge reads the
 * curve's HIGH end, so a shrink drops the top and re-pins the rate at the cut.
 */
export function truncateCurveAtCut(keyframes: Keyframe[], cut: number): Keyframe[] {
  const kept = keyframes.filter((k) => k.time <= cut).map((k) => ({ ...k }))
  // The boundary lands at `cut`, so the pin test looks at the array END it
  // appends to. Testing the wrong end skipped the pin whenever a surviving
  // keyframe's time equaled `cut` (in the reversed head case, whenever the
  // curve's last keyframe sat at exactly 2 * cut), flattening the kept span
  // to that keyframe's rate.
  if (kept.length === 0 || kept[kept.length - 1].time < cut - 1e-9) {
    const pieces = subdivideSegmentAt(keyframes, cut)
    if (pieces && kept.length > 0) {
      kept[kept.length - 1] = withSegmentControls(kept[kept.length - 1], pieces.left)
    }
    kept.push({
      time: cut,
      value: evaluateKeyframes(keyframes, cut, keyframes[0].value),
      interpolation: 'linear',
    })
  }
  return kept
}
