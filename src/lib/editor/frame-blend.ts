import { sourceTimeAt } from './factories'
import { clamp } from './time'
import type { Clip, MediaAsset } from './types'

/**
 * Sub-frame-rate frame blending: the math BOTH render paths share.
 *
 * A clip playing below realtime reads its source slower than the source's own
 * frame rate, so one source frame covers more than one output frame. Step
 * reading shows each source frame for two output frames; blending instead
 * combines the source frame with the next one, weighted by how far the read has
 * moved between them.
 *
 * The decision of WHICH frame pairs with which, and the weight between them, is
 * the same on both sides:
 * - the offline export plan (offline.ts) carries the partner source time per
 *   frame and the decoder's own sample timestamps decide the weight;
 * - the playback engine parks one extra muted element on that partner time, and
 *   the presented-frame timestamps its elements report decide the weight.
 *
 * Neither side needs a nominal source frame rate, which is why the pair carries
 * its timestamps rather than a fraction of a frame duration.
 */

/**
 * The blend weight of the frame a decoder returned for `sourceTime` between two
 * snapped samples, with no nominal frame rate involved: the pair carries its own
 * timestamps. 0 means "no blend" for a pair the decoder did not advance (or a
 * backwards one), and the result is clamped for a read outside the pair (a
 * clamped source edge).
 */
export function blendWeight(sourceTime: number, aTimestamp: number, bTimestamp: number): number {
  if (!(bTimestamp > aTimestamp)) return 0
  return clamp((sourceTime - aTimestamp) / (bTimestamp - aTimestamp), 0, 1)
}

/**
 * The pair partner for frame blending, or undefined when the clip needs none.
 *
 * One output frame's worth of source time is `sourceTimeAt(clip, local + 1/fps)`,
 * so the whole condition is expressible through the shared source mapping and
 * needs no new curve maths (and no nominal source frame rate: the decoder's own
 * sample timestamps decide the weight later). Strictly sub-frame-rate reads only:
 * at 1x the partner is the next frame and the weight is 0 anyway, and a faster
 * clip keeps the stepped read it has today.
 */
export function blendPartnerTime(
  clip: Clip,
  local: number,
  asset: MediaAsset | undefined,
  fps: number,
): number | undefined {
  if (asset?.kind !== 'video') return undefined
  if (clip.reverse) return undefined
  const step = 1 / Math.max(1, fps)
  const now = sourceTimeAt(clip, local)
  const next = sourceTimeAt(clip, local + step)
  if (!(next - now > 1e-9) || next - now >= step - 1e-9) return undefined
  return next
}
