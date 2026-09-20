import type { MediaKind } from './types'

/**
 * Timeline drop-target geometry for media drags from the bin.
 *
 * The track-rows region is divided into three kinds of zones (Premiere-style
 * "drop between tracks"):
 * - the MIDDLE of each row → drop ONTO that track (existing behavior)
 * - a thin strip at each row's TOP/BOTTOM edge → INSERT a new track at exactly
 *   that boundary; the app creates the track at that z-position and places the
 *   clip on it (so media can land between, above or below existing layers)
 * - the empty strip below the last row → append a track at the bottom
 *
 * Pure module (no DOM) so the geometry is unit-testable; TimelinePanel converts
 * the pointer position into a content-frame pixel offset and feeds it in along
 * with the per-kind row heights (top→bottom = tracks array order, where index 0
 * is the topmost compositing layer).
 */

/** Width (px) of the edge strips that trigger track insertion. */
export const TRACK_DROP_EDGE_PX = 12

export type TrackDropTarget =
  | { mode: 'lane'; index: number; y: number; height: number }
  | { mode: 'insert'; index: number; y: number }

/**
 * Resolves a pointer offset (px from the top of the first track row) against
 * the row heights to a drop target. `y` is the boundary/row offset within the
 * rows region (for rendering the insertion line). Returns null only when there
 * are no rows at all (cannot happen in practice — at least one track exists).
 */
export function computeTrackDropTarget(yInRows: number, heights: number[]): TrackDropTarget | null {
  let acc = 0
  for (let i = 0; i < heights.length; i++) {
    const h = heights[i]
    if (yInRows < acc + h) {
      const inRow = yInRows - acc
      if (inRow < TRACK_DROP_EDGE_PX) return { mode: 'insert', index: i, y: acc }
      if (inRow > h - TRACK_DROP_EDGE_PX) return { mode: 'insert', index: i + 1, y: acc + h }
      return { mode: 'lane', index: i, y: acc, height: h }
    }
    acc += h
  }
  if (heights.length === 0) return null
  return { mode: 'insert', index: heights.length, y: acc }
}

/**
 * Drag payloads carry the media kind as a dedicated custom TYPE
 * (`application/x-media-kind-<kind>`) because `dataTransfer` VALUES are read
 * protected during `dragover` — but the type list is readable, which is all
 * the drop indicator needs to preview the track that would be created.
 */
export const MEDIA_KIND_DRAG_TYPE_PREFIX = 'application/x-media-kind-'

const MEDIA_KINDS: readonly MediaKind[] = ['video', 'audio', 'image']

/** Extracts the dragged media kind from a drag event, or null for foreign drags. */
export function mediaKindFromDragEvent(e: { dataTransfer: DataTransfer | null }): MediaKind | null {
  const types = e.dataTransfer ? Array.from(e.dataTransfer.types) : []
  for (const kind of MEDIA_KINDS) {
    if (types.includes(MEDIA_KIND_DRAG_TYPE_PREFIX + kind)) return kind
  }
  return null
}
