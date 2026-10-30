/**
 * ripple-trim.ts, the pure core of the Ripple Trim tool (0.15.0).
 *
 * A ripple trim changes one clip's edge and shifts every LATER clip on the
 * same track by the same end delta, closing or opening the gap behind it. The
 * edited clip's start stays anchored: a head trim changes its in point and
 * duration, a tail trim changes only its duration. Later clips move as one run,
 * so their mutual spacing and any transition overlap are preserved exactly.
 *
 * Scope is deliberately same-track. This is the recorded exception to
 * `sequence-ops.ts` Invariant 14: a linked partner on another track does not
 * shift, and the edited clip's twin is not trimmed. All-track or link-closure
 * ripple is a separate plan.
 *
 * The module stays browser-free so the planner, its bounds, and its collision
 * rules run in Node.
 */

import { applyCommand, type EditorCommand } from './commands'
import { trimRooms } from './clip-gesture'
import { MIN_CLIP_DURATION } from './constants'
import { activeTracks, findMedia } from './factories'
import { firstLockedTrackForClips, lockedTrackForClip, trackLockMessage } from './tracks'
import type { Clip, Doc, Track } from './types'

const EPS = 1e-6

/** A ripple-trim proposal, a no-op, or a refusal with the message the UI shows. */
export type RippleTrimPlan =
  | { status: 'ok'; commands: EditorCommand[]; endDelta: number }
  | { status: 'noop' }
  | { status: 'refused'; message: string }

/** The shift half of a ripple trim, shared with the Alt rate-stretch variant. */
export type RippleShiftPlan =
  | { status: 'ok'; commands: EditorCommand[] }
  | { status: 'noop' }
  | { status: 'refused'; message: string }

function refused(message: string): { status: 'refused'; message: string } {
  return { status: 'refused', message }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function clipOnTrack(
  doc: Doc,
  clipId: string,
  activeSequencePath: readonly string[],
): { track: Track; clip: Clip } | undefined {
  const track = activeTracks(doc, activeSequencePath).find((candidate) =>
    candidate.clips.some((clip) => clip.id === clipId),
  )
  const clip = track?.clips.find((candidate) => candidate.id === clipId)
  return track && clip ? { track, clip } : undefined
}

function displayName(doc: Doc, clip: Clip): string {
  const asset = findMedia(doc, clip.mediaId)
  if (asset) return asset.name
  if (clip.text !== undefined) return clip.text || 'text clip'
  return 'the next clip'
}

/**
 * Build the moves for every clip that follows the edited clip on its track.
 * `endDelta` is the change in the edited clip's END, measured on the PRE-trim
 * document, because the whole run moves by that one delta.
 */
export function planRippleShift(args: {
  doc: Doc
  clipId: string
  endDelta: number
  activeSequencePath?: readonly string[]
}): RippleShiftPlan {
  const sequencePath = args.activeSequencePath ?? []
  const found = clipOnTrack(args.doc, args.clipId, sequencePath)
  if (!found) return refused('Unknown clip')
  if (!Number.isFinite(args.endDelta)) return refused('Invalid trim position')
  if (Math.abs(args.endDelta) <= EPS) return { status: 'noop' }

  const { track, clip } = found
  const oldEnd = clip.start + clip.duration
  // Every clip after the edited one in start order follows it, gap or not. A
  // clip at the SAME start is included and handled by the collision rule
  // below; a clip that starts earlier (a transition into this clip) stays.
  const later = track.clips
    .filter((candidate) => candidate.id !== clip.id && candidate.start >= clip.start - EPS)
    .sort((a, b) => a.start - b.start)

  const first = later[0]
  if (first && first.start < oldEnd - EPS) {
    // The only legal overlap is the transition this clip already owns: the
    // partner is the immediate next clip and both move by the same delta, so
    // the overlap and the transition span are unchanged. Any other overlap,
    // or a second clip inside the same span, refuses.
    const extraOverlaps = later.slice(1).some((candidate) => candidate.start < oldEnd - EPS)
    if (!clip.transitionOut || extraOverlaps) {
      return refused(`The trim would overlap "${displayName(args.doc, first)}"`)
    }
  }

  const commands: EditorCommand[] = []
  for (const candidate of later) {
    const nextStart = candidate.start + args.endDelta
    if (nextStart < -EPS) {
      return refused('The trim would move a later clip before the start of the timeline')
    }
    // `moveClip`'s lock rule includes the clip's link group and its destination
    // lane, so a locked partner refuses the command. Preflight it here: a
    // transient batch swallows command errors, and a silent no-op would look like
    // a broken gesture.
    const locked = firstLockedTrackForClips(args.doc, [candidate.id])
    if (locked) return refused(trackLockMessage(locked))
    commands.push({
      type: 'moveClip',
      clipId: candidate.id,
      trackId: track.id,
      start: Math.max(0, nextStart),
    })
  }

  return commands.length > 0 ? { status: 'ok', commands } : { status: 'noop' }
}

/**
 * Plan a ripple trim from a normal trim proposal (`decideTrimStart` or
 * `decideTrimEnd`). The start is always anchored; the proposal's start only
 * supplies how far a head trim would have moved the edge.
 */
export function planRippleTrim(args: {
  doc: Doc
  clipId: string
  edge: 'head' | 'tail'
  proposal: { start: number; inPoint: number; duration: number }
  activeSequencePath?: readonly string[]
}): RippleTrimPlan {
  const sequencePath = args.activeSequencePath ?? []
  const found = clipOnTrack(args.doc, args.clipId, sequencePath)
  if (!found) return refused('Unknown clip')
  const { track, clip } = found

  const locked = lockedTrackForClip(args.doc, clip.id)
  if (locked) return refused(trackLockMessage(locked))

  const asset = findMedia(args.doc, clip.mediaId)
  const bounded = !!asset && asset.kind !== 'image' && track.kind !== 'text'
  const speed = clip.speed ?? 1
  const rooms = trimRooms({
    bounded,
    reverse: !!clip.reverse,
    inPoint: clip.inPoint,
    duration: clip.duration,
    speed,
    assetDuration: asset?.duration ?? 0,
  })

  let trimCommand: EditorCommand
  if (args.edge === 'head') {
    // The select-trim decision moved the head by this much. Ripple keeps the
    // start where it is and turns that distance into a source/duration change.
    const moved = Math.min(
      Math.max(args.proposal.start - clip.start, -rooms.head),
      clip.duration - MIN_CLIP_DURATION,
    )
    // A reversed clip's head shows the span's HIGH end, so its LOW anchor
    // stays put and the duration carries the change. A ramped clip's exact
    // anchor is rebased by the command; this static estimate is only the
    // bound-check input.
    const inPoint = clip.reverse ? clip.inPoint : clip.inPoint + moved * speed
    trimCommand = {
      type: 'trimClip',
      clipId: clip.id,
      start: clip.start,
      inPoint,
      duration: clip.duration - moved,
      edge: 'head',
    }
  } else {
    const duration = Math.min(
      Math.max(args.proposal.duration, MIN_CLIP_DURATION),
      rooms.maxDuration,
    )
    trimCommand = {
      type: 'trimClip',
      clipId: clip.id,
      start: clip.start,
      inPoint: clip.inPoint,
      duration,
      edge: 'tail',
    }
  }

  // Validate the trim alone first. The command may clamp the duration or
  // rebase a ramp, and the shift delta must come from what it ACTUALLY wrote,
  // never from the raw pointer proposal.
  let trimmed: Clip
  try {
    const next = applyCommand(args.doc, trimCommand)
    const nextFound = clipOnTrack(next, clip.id, sequencePath)
    if (!nextFound) return refused('Unknown clip')
    trimmed = nextFound.clip
  } catch (error) {
    return refused(messageOf(error))
  }

  const changed =
    Math.abs(trimmed.start - clip.start) > EPS ||
    Math.abs(trimmed.inPoint - clip.inPoint) > EPS ||
    Math.abs(trimmed.duration - clip.duration) > EPS
  if (!changed) return { status: 'noop' }

  const endDelta = trimmed.start + trimmed.duration - (clip.start + clip.duration)
  const shift = planRippleShift({
    doc: args.doc,
    clipId: clip.id,
    endDelta,
    activeSequencePath: sequencePath,
  })
  if (shift.status === 'refused') return shift

  return {
    status: 'ok',
    commands: [trimCommand, ...(shift.status === 'ok' ? shift.commands : [])],
    endDelta,
  }
}
