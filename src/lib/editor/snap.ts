import type { Doc } from './types'
import { activeTracks, docDuration, findSequence, sequenceDuration } from './factories'
import { clipMarkerTimelineTime } from './markers'

/**
 * Timeline snapping utilities.
 *
 * Snap targets: project start (0), timeline end, the playhead, every clip
 * edge on every track except the ones being dragged, and every reachable
 * marker (sequence markers plus visible clip markers).
 */

export interface SnapOptions {
  /** Clip ids whose edges should NOT act as snap targets (the ones being dragged). */
  excludeClipIds?: string[]
  /** A marker being dragged must not snap to itself. */
  excludeMarkerId?: string
  /** Optional playhead position (seconds) to snap against. */
  playhead?: number
  /** Also snap to the end of the timeline. */
  includeTimelineEnd?: boolean
  /**
   * The active compound sequence path (0.8.1): snap targets come from the open
   * sequence's lanes, and project-level markers only at the root.
   */
  activeSequencePath?: readonly string[]
}

/** Collects all snap-target times (sorted ascending, deduplicated). */
export function computeSnapPoints(doc: Doc, opts: SnapOptions = {}): number[] {
  const points = new Set<number>([0])
  const exclude = new Set(opts.excludeClipIds ?? [])
  const path = opts.activeSequencePath ?? []
  const tracks = activeTracks(doc, path)
  for (const track of tracks) {
    for (const clip of track.clips) {
      if (exclude.has(clip.id)) continue
      points.add(round6(clip.start))
      points.add(round6(clip.start + clip.duration))
    }
  }
  if (path.length === 0) {
    for (const marker of doc.project.markers ?? []) {
      if (marker.id !== opts.excludeMarkerId) points.add(round6(marker.time))
    }
  }
  for (const track of tracks) {
    for (const clip of track.clips) {
      // A dragged clip's own markers keep a constant offset to its edges for
      // the whole move, so one snap would stick permanently: skip them along
      // with the edges (see the edge loop above).
      if (exclude.has(clip.id)) continue
      // The target set is unordered, so read the markers directly instead of
      // visibleClipMarkers (which allocates and sorts an array per clip, and
      // this runs on every pointermove of a drag).
      for (const marker of clip.markers ?? []) {
        if (marker.id === opts.excludeMarkerId) continue
        const timelineTime = clipMarkerTimelineTime(clip, marker)
        if (timelineTime !== null) points.add(round6(timelineTime))
      }
    }
  }
  if (opts.playhead !== undefined) points.add(round6(opts.playhead))
  if (opts.includeTimelineEnd) {
    const id = path[path.length - 1]
    const sequence = id ? findSequence(doc, id) : undefined
    points.add(round6(sequence ? sequenceDuration(sequence) : docDuration(doc)))
  }
  return [...points].sort((a, b) => a - b)
}

/**
 * Snaps `target` to the closest snap point within `thresholdSec`.
 * Returns the (possibly unsnapped) time plus the exact point that matched
 * (`null` when no snap occurred — used to draw the snap guide line).
 */
export function applySnap(
  target: number,
  points: number[],
  thresholdSec: number,
): { time: number; snapped: number | null } {
  let best: number | null = null
  let bestDist = thresholdSec
  for (const p of points) {
    const d = Math.abs(p - target)
    if (d <= bestDist) {
      bestDist = d
      best = p
    }
  }
  return best === null
    ? { time: Math.max(0, target), snapped: null }
    : { time: best, snapped: best }
}

/**
 * Snaps a moving clip edge pair. Tries both edges (`target` and `target + duration`)
 * and returns the shift that produces the best (closest) snap.
 */
export function snapMove(
  start: number,
  duration: number,
  points: number[],
  thresholdSec: number,
): { start: number; snapped: number | null } {
  const head = applySnap(start, points, thresholdSec)
  const tail = applySnap(start + duration, points, thresholdSec)
  if (head.snapped !== null && (tail.snapped === null || head.time !== start)) {
    return { start: head.time, snapped: head.snapped }
  }
  if (tail.snapped !== null) {
    return { start: tail.time - duration, snapped: tail.snapped }
  }
  return { start: Math.max(0, start), snapped: null }
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6
}

/**
 * The snap-guide position for a drag that took the snap `snapped` but then
 * realized (after clamping into a clip's span) at `position`. When clamping
 * moved the marker off the snapped point, the guide would advertise a
 * position the marker never took, so there is no guide.
 */
export function snapGuide(snapped: number | null, position: number): number | null {
  if (snapped === null) return null
  return round6(position) === round6(snapped) ? snapped : null
}
