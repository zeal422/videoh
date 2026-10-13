import { TIME_EPSILON } from './constants'
import {
  activeTracks,
  docDuration,
  findClip,
  findSequence,
  sequenceDuration,
  sourceTimeAt,
  uid,
} from './factories'
import { clamp, formatTime } from './time'
import type { Clip, Doc, Marker, MarkerColor, MarkerPatch, Project } from './types'

/**
 * Marker engine: pure math for timeline and clip markers.
 *
 * Model (0.5.5): a marker is a POINT at `time` seconds with an optional name,
 * one of {@link MARKER_COLORS} and free-text notes. Sequence markers
 * (`Project.markers`) live in timeline seconds. Clip markers (`Clip.markers`)
 * live in SOURCE seconds, the same basis as `Clip.inPoint`, so trimming,
 * speed changes and reversal move them with the media instead of the clip
 * offset; they render only while their source time is inside the clip's
 * visible span, and hidden ones are kept in the data (extending the clip
 * brings them back).
 *
 * `clipMarkerLocalTime` is the inverse of `sourceTimeAt`: the one mapping the
 * renderer, the drag gesture and navigation all share.
 */

/** Premiere-style palette. Content data, deliberately not theme tokens. */
export const MARKER_COLORS: readonly MarkerColor[] = [
  'green',
  'red',
  'orange',
  'yellow',
  'blue',
  'cyan',
  'purple',
  'magenta',
]

export const DEFAULT_MARKER_COLOR: MarkerColor = 'green'

/** Swatch values for the palette (Tailwind 500-family hues). */
export const MARKER_COLOR_VALUES: Record<MarkerColor, string> = {
  green: '#22c55e',
  red: '#ef4444',
  orange: '#f97316',
  yellow: '#eab308',
  blue: '#3b82f6',
  cyan: '#06b6d4',
  purple: '#a855f7',
  magenta: '#ec4899',
}

export function isMarkerColor(value: unknown): value is MarkerColor {
  return typeof value === 'string' && (MARKER_COLORS as readonly string[]).includes(value)
}

/** The swatch value for a color, defaulting to green. */
export function markerColorValue(color?: MarkerColor): string {
  return MARKER_COLOR_VALUES[color ?? DEFAULT_MARKER_COLOR]
}

/** A new marker at `time` (finite, clamped at 0; NaN and infinities clamp to 0). */
export function createMarker(time: number, patch: MarkerPatch = {}): Marker {
  const marker: Marker = {
    id: uid('marker'),
    time: Number.isFinite(time) ? Math.max(0, time) : 0,
  }
  applyMarkerPatch(marker, patch)
  return marker
}

/**
 * Copies a clip's markers with FRESH ids (times and patches unchanged), for
 * every clone that coexists with its source: split halves, duplicates and
 * pastes. Shared ids would make delete/edit on one copy leave the twin
 * behind, and snap exclusion (`excludeMarkerId`) matches by id alone.
 */
export function reIdMarkers(markers: readonly Marker[] | undefined): Marker[] | undefined {
  if (!markers?.length) return markers ? [] : undefined
  return markers.map((m) => ({ ...m, id: uid('marker') }))
}

/**
 * Writes a patch onto a marker in place: name/notes are trimmed and cleared
 * when empty, `color` 'green' collapses to the default (absent field), and an
 * unknown color is ignored. Shared by the command layer and hydration.
 */
export function applyMarkerPatch(marker: Marker, patch: MarkerPatch): void {
  if (patch.name !== undefined) {
    const name = patch.name.trim()
    if (name) marker.name = name
    else delete marker.name
  }
  if (patch.color !== undefined) {
    if (isMarkerColor(patch.color)) {
      if (patch.color === DEFAULT_MARKER_COLOR) delete marker.color
      else marker.color = patch.color
    }
  }
  if (patch.notes !== undefined) {
    const notes = patch.notes.trim()
    if (notes) marker.notes = notes
    else delete marker.notes
  }
}

/**
 * The inverse of `sourceTimeAt`: the clip-local timeline offset (seconds from
 * the clip's start) where a source time renders, or null when it falls outside
 * the clip's visible span. A constant rate scales the offset and reverse
 * mirrors it; a `timeScale` ramp has no closed form once `sourceTimeAt`
 * integrates the curve, so it is inverted by bisection. Marker times on the
 * exact boundary clamp inside it.
 */
export function clipMarkerLocalTime(clip: Clip, sourceTime: number): number | null {
  // A compound clip (0.8.1) has no source window: its markers are container-local
  // seconds, so the time is used as-is and only the container span clamps it.
  if (clip.sequenceId) {
    if (sourceTime < -TIME_EPSILON || sourceTime > clip.duration + TIME_EPSILON) return null
    return clamp(sourceTime, 0, clip.duration)
  }
  const ramp = clip.keyframes?.timeScale
  if (!ramp || ramp.length === 0) {
    const speed = clip.speed ?? 1
    const offset = (sourceTime - clip.inPoint) / speed
    if (offset < -TIME_EPSILON || offset > clip.duration + TIME_EPSILON) return null
    const local = clip.reverse ? clip.duration - offset : offset
    return clamp(local, 0, clip.duration)
  }
  // Ramped clip: dividing by the static speed would misplace the marker (the
  // curve decides how much source each timeline second consumes) and drop any
  // marker past `duration * speed` of source. `sourceTimeAt` is monotone here
  // (timeScale values are positive), so bisect for the local time that maps
  // back to `sourceTime`; reverse is already folded into `sourceTimeAt`.
  const atStart = sourceTimeAt(clip, 0)
  const atEnd = sourceTimeAt(clip, clip.duration)
  if (
    sourceTime < Math.min(atStart, atEnd) - TIME_EPSILON ||
    sourceTime > Math.max(atStart, atEnd) + TIME_EPSILON
  ) {
    return null
  }
  const rising = atEnd >= atStart
  let below = 0
  let above = clip.duration
  for (let i = 0; i < 32; i++) {
    const mid = (below + above) / 2
    const value = sourceTimeAt(clip, mid)
    if (rising ? value < sourceTime : value > sourceTime) below = mid
    else above = mid
  }
  return clamp((below + above) / 2, 0, clip.duration)
}

/** Timeline seconds for a clip marker, or null when it is outside the span. */
export function clipMarkerTimelineTime(clip: Clip, marker: Marker): number | null {
  const local = clipMarkerLocalTime(clip, marker.time)
  return local === null ? null : clip.start + local
}

export interface VisibleClipMarker {
  marker: Marker
  timelineTime: number
}

/** The clip's markers that currently render, sorted by timeline position. */
export function visibleClipMarkers(clip: Clip): VisibleClipMarker[] {
  const out: VisibleClipMarker[] = []
  for (const marker of clip.markers ?? []) {
    const timelineTime = clipMarkerTimelineTime(clip, marker)
    if (timelineTime !== null) out.push({ marker, timelineTime })
  }
  return out.sort((a, b) => a.timelineTime - b.timelineTime)
}

/** Sequence markers, sorted by time. */
export function sequenceMarkers(project: Project): Marker[] {
  return [...(project.markers ?? [])].sort((a, b) => a.time - b.time)
}

/** The end of the last sequence marker (0 when none) for scrollable width. */
export function markersEnd(project: Project): number {
  let end = 0
  for (const marker of project.markers ?? []) end = Math.max(end, marker.time)
  return end
}

/** One navigable marker resolved to timeline coordinates. */
export interface TimelineMarkerRef {
  scope: 'sequence' | 'clip'
  marker: Marker
  /** Timeline seconds (always finite; hidden clip markers are excluded). */
  timelineTime: number
  /** Present for clip markers. */
  clipId?: string
}

/**
 * Every reachable marker (sequence + visible clip) sorted by timeline time,
 * scoped to the ACTIVE sequence (0.8.1): project-level markers appear only at
 * the root, and only clips in the open sequence contribute.
 */
export function allMarkersOnTimeline(
  doc: Doc,
  activeSequencePath: readonly string[] = [],
): TimelineMarkerRef[] {
  const out: TimelineMarkerRef[] = []
  if (activeSequencePath.length === 0) {
    for (const marker of doc.project.markers ?? []) {
      out.push({ scope: 'sequence', marker, timelineTime: marker.time })
    }
  }
  for (const track of activeTracks(doc, activeSequencePath)) {
    for (const clip of track.clips) {
      for (const { marker, timelineTime } of visibleClipMarkers(clip)) {
        out.push({ scope: 'clip', marker, timelineTime, clipId: clip.id })
      }
    }
  }
  return out.sort((a, b) => a.timelineTime - b.timelineTime || (a.marker.id < b.marker.id ? -1 : 1))
}

/** The active sequence's local length, or the root timeline at the root. */
function activeDuration(doc: Doc, activeSequencePath: readonly string[]): number {
  const id = activeSequencePath[activeSequencePath.length - 1]
  if (!id) return docDuration(doc)
  const sequence = findSequence(doc, id)
  return sequence ? sequenceDuration(sequence) : docDuration(doc)
}

/**
 * The markers marker navigation can actually seek to: `allMarkersOnTimeline`
 * minus the ones past the sequence end. The playhead clamps to the sequence, so
 * seeking to a marker beyond it would pin navigation at the end (the same marker
 * on every press, forever). Such a marker still renders on the ruler and stays
 * editable; it is only excluded as a seek target. The UI that offers navigation
 * (the Marker menu) uses this same predicate, so it never advertises a jump that
 * cannot happen.
 */
export function navigableMarkers(
  doc: Doc,
  activeSequencePath: readonly string[] = [],
): TimelineMarkerRef[] {
  const limit = activeDuration(doc, activeSequencePath) + TIME_EPSILON
  return allMarkersOnTimeline(doc, activeSequencePath).filter((ref) => ref.timelineTime <= limit)
}

/** True while at least one marker is reachable by marker navigation. */
export function hasNavigableMarkers(doc: Doc, activeSequencePath: readonly string[] = []): boolean {
  return navigableMarkers(doc, activeSequencePath).length > 0
}

/**
 * The nearest marker strictly after/before `time` (Premiere Shift+M navigation).
 * Ties resolve in timeline order; markers past the sequence end are not targets
 * (see {@link navigableMarkers}).
 */
export function neighborMarker(
  doc: Doc,
  time: number,
  dir: 'next' | 'prev',
  activeSequencePath: readonly string[] = [],
): TimelineMarkerRef | null {
  const marked = navigableMarkers(doc, activeSequencePath)
  if (dir === 'next') {
    for (const ref of marked) {
      if (ref.timelineTime > time + TIME_EPSILON) return ref
    }
    return null
  }
  for (let i = marked.length - 1; i >= 0; i--) {
    if (marked[i].timelineTime < time - TIME_EPSILON) return marked[i]
  }
  return null
}

/**
 * The source time a clip marker lands on for a playhead position: the playhead
 * mapped through `sourceTimeAt`, clamped to the clip's visible span so the new
 * marker is always on screen.
 */
export function sourceTimeForClipMarker(clip: Clip, playhead: number): number {
  // A compound clip's markers are container-local, so the playhead maps to the
  // container's own clock instead of a source window.
  if (clip.sequenceId) return clamp(playhead - clip.start, 0, clip.duration)
  return sourceTimeAt(clip, clamp(playhead - clip.start, 0, clip.duration))
}

/** A selected marker, in store state only (never part of the Doc). */
export type MarkerSelection =
  { scope: 'sequence'; markerId: string } | { scope: 'clip'; clipId: string; markerId: string }

/** The marker a selection points at, or undefined when it no longer exists. */
export function markerFromSelection(doc: Doc, selection: MarkerSelection): Marker | undefined {
  if (selection.scope === 'sequence') {
    return (doc.project.markers ?? []).find((m) => m.id === selection.markerId)
  }
  const clip = findClip(doc, selection.clipId)?.clip
  return clip?.markers?.find((m) => m.id === selection.markerId)
}

/** True while the selection still resolves (store normalization on undo, etc.). */
export function markerSelectionExists(doc: Doc, selection: MarkerSelection): boolean {
  return markerFromSelection(doc, selection) !== undefined
}

/**
 * Visual x positions (px) for markers at the given times (seconds, sorted).
 * Tabs closer than `minGapPx` get pushed right so every one stays clickable;
 * the push is visual only, the marker keeps its true time.
 */
export function staggerMarkerPositions(times: number[], pxPerSec: number, minGapPx = 12): number[] {
  const out: number[] = []
  let lastX = Number.NEGATIVE_INFINITY
  for (const time of times) {
    let x = time * pxPerSec
    if (x - lastX < minGapPx) x = lastX + minGapPx
    out.push(x)
    lastX = x
  }
  return out
}

/** Tooltip text: name (or the timecode), the timecode, then the notes. */
export function markerTooltip(marker: Marker, timelineTime: number): string {
  const time = formatTime(timelineTime)
  const parts = marker.name ? [marker.name, time] : [time]
  if (marker.notes) parts.push(marker.notes)
  return parts.join(' · ')
}
