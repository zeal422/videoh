/**
 * clip-gesture.ts — the pure decision core of the timeline clip gestures.
 *
 * Extracted from ClipView so the riskiest timeline logic (lane hit-testing,
 * cross-lane compatibility, snap head/tail choice, trim clamping, selection
 * partner shifting) runs in Node tests with injected geometry instead of
 * hiding inside an 800-line component. ClipView keeps the DOM wiring: window
 * listeners, the auto-scroll loop, lane element reading, store dispatch.
 *
 * All functions are pure: they take the gesture's frozen origin (the clip as
 * it was at pointer-down), the live geometry, and the pointer position, and
 * return what SHOULD be applied. They never touch the store or the DOM.
 */

import { MIN_CLIP_DURATION, SNAP_THRESHOLD_PX } from './constants'
import { applySnap } from './snap'
import type { Clip } from './types'

/** A timeline lane's live box in viewport coordinates (read by ClipView). */
export interface LaneBox {
  id: string
  kind: string
  top: number
  bottom: number
}

/** A minimal track view: the only fields the gesture math needs. */
export interface TrackView {
  id: string
  kind: string
}

/** Another selected clip that follows the dragged clip (whole link groups). */
export interface GesturePartner {
  id: string
  trackIndex: number
  kind: string
  origStart: number
}

/** What a MOVE gesture wants applied for the dragged clip and its partners. */
export interface MoveDecision {
  targetTrackId: string
  /** The lane under the pointer that cannot host this clip, if any. */
  blockedLane: { id: string; kind: string } | null
  start: number
  /** The snap guide time to show, or null. */
  snapped: number | null
  partnerUpdates: { clipId: string; trackId: string; start: number }[]
}

/**
 * Resolve which lane the pointer is over and whether it may host the clip.
 * A lane only hosts a clip of the same kind family (video/image on video
 * lanes, audio on audio lanes, text on text lanes). Returns the original
 * track and the blocked lane when the drop would be refused.
 */
export function resolveLaneDrop(
  lanes: LaneBox[],
  clientY: number,
  origTrackId: string,
  origTrackKind: string,
): { laneId: string | null; blocked: { id: string; kind: string } | null } {
  const lane = lanes.find((l) => clientY >= l.top && clientY <= l.bottom)
  if (!lane) return { laneId: null, blocked: null }
  if (lane.id === origTrackId) return { laneId: origTrackId, blocked: null }
  const sameFamily = (a: string, b: string) =>
    a === b || (a === 'image' && b === 'video') || (b === 'image' && a === 'video')
  if (sameFamily(lane.kind, origTrackKind)) return { laneId: lane.id, blocked: null }
  return { laneId: null, blocked: { id: lane.id, kind: lane.kind } }
}

/**
 * Snap a move's start time: prefer the edge (head or tail) that lands closest
 * to a snap point, exactly like Premiere nudging either edge onto a cut.
 */
function snapMove(
  orig: Clip,
  rawStart: number,
  snapPoints: number[],
  thr: number,
): { start: number; snapped: number | null } {
  const head = applySnap(rawStart, snapPoints, thr)
  const tail = applySnap(rawStart + orig.duration, snapPoints, thr)
  if (
    head.snapped !== null &&
    (tail.snapped === null ||
      Math.abs(head.time - rawStart) <= Math.abs(tail.time - (rawStart + orig.duration)))
  ) {
    return { start: head.time, snapped: head.snapped }
  }
  if (tail.snapped !== null) {
    return { start: Math.max(0, tail.time - orig.duration), snapped: tail.snapped }
  }
  return { start: rawStart, snapped: null }
}

/**
 * The full MOVE decision: lane drop, snapped time, and the partner shifts.
 * `rawStart` is `orig.start + dxSec` clamped to 0 by the caller? No — this
 * function owns that clamp too, so the component cannot forget it.
 */
export function decideMove(args: {
  orig: Clip
  origTrackId: string
  origTrackKind: string
  clientX: number
  clientY: number
  startX: number
  lanes: LaneBox[]
  tracks: TrackView[]
  scale: number
  snapping: boolean
  snapPoints: number[]
  partners: GesturePartner[]
}): MoveDecision {
  const {
    orig,
    origTrackId,
    origTrackKind,
    clientX,
    clientY,
    startX,
    lanes,
    tracks,
    scale,
    snapping,
    snapPoints,
    partners,
  } = args
  const dxSec = (clientX - startX) / scale

  // Lane under the pointer (compatible kinds only; anything else is blocked).
  let targetTrackId = origTrackId
  let blockedLane: MoveDecision['blockedLane'] = null
  const drop = resolveLaneDrop(lanes, clientY, origTrackId, origTrackKind)
  if (drop.laneId && drop.laneId !== origTrackId) targetTrackId = drop.laneId
  if (drop.blocked) blockedLane = drop.blocked

  // Time: never before 0, snapped to either edge when snapping is on.
  const rawStart = Math.max(0, orig.start + dxSec)
  const thr = snapping ? snapThreshold(scale) : 0
  const { start, snapped } = snapping
    ? snapMove(orig, rawStart, snapPoints, thr)
    : { start: rawStart, snapped: null }

  // The whole selection follows: same time delta; when the dragged clip
  // changed lane, partners shift by the SAME track-index offset (skipped
  // when the destination lane is missing or a different kind).
  const delta = start - orig.start
  const dIndex =
    tracks.findIndex((t) => t.id === targetTrackId) - tracks.findIndex((t) => t.id === origTrackId)
  const partnerUpdates: MoveDecision['partnerUpdates'] = []
  for (const p of partners) {
    let partnerTrackId = tracks[p.trackIndex]?.id
    if (dIndex !== 0) {
      const candidate = tracks[p.trackIndex + dIndex]
      if (candidate && candidate.kind === p.kind) partnerTrackId = candidate.id
    }
    if (!partnerTrackId) continue
    partnerUpdates.push({
      clipId: p.id,
      trackId: partnerTrackId,
      start: Math.max(0, p.origStart + delta),
    })
  }

  return { targetTrackId, blockedLane, start, snapped, partnerUpdates }
}

/**
 * The TRIM-START decision. Bounded media (audio/video) cannot reveal source
 * before 0 (inPoint floors the pull) and cannot shrink below MIN_CLIP_DURATION.
 * Images and text are unbounded: inPoint stays 0, the clip just shrinks or
 * grows from the left, and cannot push its start below 0.
 */
export function decideTrimStart(args: {
  orig: Clip
  isUnbounded: boolean
  clientX: number
  startX: number
  scale: number
  snapping: boolean
  snapPoints: number[]
}): { start: number; inPoint: number; duration: number; snapped: number | null } {
  const { orig, isUnbounded, clientX, startX, scale, snapping, snapPoints } = args
  const dxSec = (clientX - startX) / scale
  const thr = snapping ? snapThreshold(scale) : 0

  let delta = dxSec
  const minDelta = -orig.inPoint // media cannot reveal source before 0
  const maxDelta = orig.duration - MIN_CLIP_DURATION
  delta = Math.min(
    Math.max(delta, isUnbounded ? -(orig.start + orig.duration - MIN_CLIP_DURATION) : minDelta),
    maxDelta,
  )
  let newStart = Math.max(0, orig.start + delta)
  let newIn = isUnbounded ? 0 : Math.max(0, orig.inPoint + (newStart - orig.start))
  let newDuration = orig.start + orig.duration - newStart
  let snapped: number | null = null
  if (snapping) {
    const s = applySnap(newStart, snapPoints, thr)
    // Legal start window after the same clamps the raw path went through:
    // the head cannot reveal source before 0 (bounded media), start cannot
    // go below 0, and duration cannot shrink below MIN_CLIP_DURATION. A snap
    // point outside this window is rejected so the clamped values survive.
    const minStart = isUnbounded ? 0 : Math.max(0, orig.start - orig.inPoint)
    const maxStart = orig.start + orig.duration - MIN_CLIP_DURATION
    const snappedIn = isUnbounded ? 0 : Math.max(0, orig.inPoint + (s.time - orig.start))
    const snappedDuration = Math.max(MIN_CLIP_DURATION, orig.start + orig.duration - s.time)
    if (
      s.snapped !== null &&
      s.time >= minStart &&
      s.time <= maxStart &&
      snappedDuration >= MIN_CLIP_DURATION
    ) {
      newStart = s.time
      newIn = snappedIn
      newDuration = snappedDuration
      snapped = s.snapped
    }
  }
  return { start: newStart, inPoint: newIn, duration: newDuration, snapped }
}

/**
 * The TRIM-END decision. Bounded media cannot extend past the asset's end
 * (`maxDuration` comes from the caller: asset.duration - inPoint, floored at
 * MIN_CLIP_DURATION); images and text extend freely (Infinity).
 */
export function decideTrimEnd(args: {
  origStart: number
  origDuration: number
  maxDuration: number
  clientX: number
  startX: number
  scale: number
  snapping: boolean
  snapPoints: number[]
}): { duration: number; snapped: number | null } {
  const { origStart, origDuration, maxDuration, clientX, startX, scale, snapping, snapPoints } =
    args
  const dxSec = (clientX - startX) / scale
  const thr = snapping ? snapThreshold(scale) : 0

  let newDuration = origDuration + dxSec
  newDuration = Math.min(Math.max(newDuration, MIN_CLIP_DURATION), maxDuration)
  let snapped: number | null = null
  if (snapping) {
    const end = origStart + newDuration
    const s = applySnap(end, snapPoints, thr)
    // Accept the snap only while it stays inside the media boundary: a snap
    // point past origStart + maxDuration would otherwise extend the clip past
    // the asset's end (the pre-snap clamp cannot help, it ran on the raw time).
    const snappedDuration = Math.max(MIN_CLIP_DURATION, s.time - origStart)
    if (s.snapped !== null && snappedDuration <= maxDuration) {
      newDuration = snappedDuration
      snapped = s.snapped
    }
  }
  return { duration: newDuration, snapped }
}

/** The snap threshold in seconds for the current zoom (SNAP_THRESHOLD_PX / scale). */
export function snapThreshold(scale: number): number {
  return SNAP_THRESHOLD_PX / scale
}
