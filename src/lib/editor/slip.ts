/**
 * slip.ts, the pure core of the Slip tool (0.15.0).
 *
 * Slip changes WHICH part of a source a clip shows without moving the clip on
 * the timeline or changing its duration. The clip's `start` and `duration`
 * stay fixed; only `inPoint` moves. A linked A/V pair slips both halves by the
 * same source delta when they read the same window, because slipping one half
 * alone would desync the pair. A group that cannot share the delta refuses.
 *
 * The module stays browser-free so the planner and its bounds run in Node.
 */

import type { EditorCommand } from './commands'
import { hasTimeScaleCurve } from './keyframes'
import { clamp } from './time'
import type { Clip } from './types'

const EPS = 1e-6

/** A slip proposal, a no-op, or a refusal with the message the UI shows. */
export type SlipPlan =
  | { status: 'ok'; inPoint: number; delta: number; commands: EditorCommand[] }
  | { status: 'noop' }
  | { status: 'refused'; message: string }

/**
 * True when two linked clips read the SAME source window: the same asset, the
 * same duration and speed, the same direction, and the same in point. The
 * audio half differs from its video twin only in `audioOnly`, so that flag is
 * deliberately ignored. Timeline `start` is not part of the window: a ripple
 * trim can leave the halves at different starts while their source stays one
 * window.
 */
export function sharesSourceWindow(a: Clip, b: Clip): boolean {
  if (a.mediaId !== b.mediaId) return false
  if (a.text !== undefined || b.text !== undefined) return false
  if (a.sequenceId !== b.sequenceId) return false
  if (!!a.reverse !== !!b.reverse) return false
  if (Math.abs(a.duration - b.duration) > EPS) return false
  if (Math.abs((a.speed ?? 1) - (b.speed ?? 1)) > EPS) return false
  if (Math.abs(a.inPoint - b.inPoint) > EPS) return false
  if (hasTimeScaleCurve(a) || hasTimeScaleCurve(b)) return false
  return true
}

/**
 * Plan a slip. `delta` is a SOURCE-seconds delta; the caller maps the pointer
 * and inverts it for a reversed clip. `assetDuration` is undefined for a clip
 * with no source window (an image, a text clip, or missing media).
 */
export function planSlip(args: {
  clip: Clip
  /** The sequence-local link group, including `clip`. */
  group?: readonly Clip[]
  assetDuration?: number
  delta: number
}): SlipPlan {
  const { clip, delta } = args
  const group = args.group && args.group.length > 0 ? args.group : [clip]

  if (clip.text !== undefined) {
    return { status: 'refused', message: 'Text clips have no source window to slip' }
  }
  if (clip.sequenceId) {
    return { status: 'refused', message: 'Compound clips have no source window to slip' }
  }
  if (!clip.mediaId) {
    return { status: 'refused', message: 'This clip has no source window to slip' }
  }
  if (hasTimeScaleCurve(clip)) {
    return { status: 'refused', message: 'A time-remapped clip cannot be slipped' }
  }
  if (args.assetDuration === undefined || !Number.isFinite(args.assetDuration)) {
    return { status: 'refused', message: 'This clip has no source window to slip' }
  }
  if (!Number.isFinite(delta)) {
    return { status: 'refused', message: 'Invalid slip position' }
  }

  // A linked group slips as one unit or not at all: a member that reads a
  // different window cannot share the delta without desyncing the group.
  const linked = group.filter((member) => member.id !== clip.id)
  if (linked.some((member) => !sharesSourceWindow(clip, member))) {
    return {
      status: 'refused',
      message: 'Linked clips do not share the same source window, so slipping would desync them',
    }
  }

  const speed = clip.speed ?? 1
  const span = clip.duration * speed
  if (span > args.assetDuration + EPS) {
    return { status: 'refused', message: 'This clip already reads past the end of its source' }
  }
  const maxInPoint = Math.max(0, args.assetDuration - span)
  const inPoint = clamp(clip.inPoint + delta, 0, maxInPoint)
  const actual = inPoint - clip.inPoint
  if (Math.abs(actual) <= EPS) return { status: 'noop' }

  return {
    status: 'ok',
    inPoint,
    delta: actual,
    // One command: `setClipInPoint` writes the whole linked group that shares
    // this window, so the pair cannot land half-slipped.
    commands: [{ type: 'setClipInPoint', clipId: clip.id, inPoint }],
  }
}
