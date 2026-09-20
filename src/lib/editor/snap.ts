import type { Doc } from './types'
import { docDuration } from './factories'

/**
 * Timeline snapping utilities.
 *
 * Snap targets: project start (0), timeline end, the playhead and every clip
 * edge on every track except the ones being dragged.
 */

export interface SnapOptions {
  /** Clip ids whose edges should NOT act as snap targets (the ones being dragged). */
  excludeClipIds?: string[]
  /** Optional playhead position (seconds) to snap against. */
  playhead?: number
  /** Also snap to the end of the timeline. */
  includeTimelineEnd?: boolean
}

/** Collects all snap-target times (sorted ascending, deduplicated). */
export function computeSnapPoints(doc: Doc, opts: SnapOptions = {}): number[] {
  const points = new Set<number>([0])
  const exclude = new Set(opts.excludeClipIds ?? [])
  for (const track of doc.project.tracks) {
    for (const clip of track.clips) {
      if (exclude.has(clip.id)) continue
      points.add(round6(clip.start))
      points.add(round6(clip.start + clip.duration))
    }
  }
  if (opts.playhead !== undefined) points.add(round6(opts.playhead))
  if (opts.includeTimelineEnd) points.add(round6(docDuration(doc)))
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
