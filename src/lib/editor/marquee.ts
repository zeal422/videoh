/**
 * Marquee (box) selection geometry and resolution, pure so it can be tested in
 * Node like the rest of the state core.
 *
 * The timeline's box gesture drags a rectangle over the track rows. The rect is
 * expressed in LANE coordinates: x = 0 is the timeline origin (the left edge of
 * the lanes, after the sticky header column) and y = 0 is the top of the first
 * row (after the ruler strip). The component maps pointer positions into this
 * frame; nothing here touches the DOM.
 *
 * Selection semantics (Premiere-style):
 * - `replace`: the hit clips' link groups become the whole selection.
 * - `add` (Shift): the groups are added to the current selection.
 * - `toggle` (Ctrl/Cmd): a group is removed when EVERY member is selected,
 *   otherwise its missing members are added. Groups are never split: an A/V
 *   pair selects, toggles and deselects as one unit (`links.ts`).
 */
import { linkedClips } from './links'
import type { Clip, Doc } from './types'

/** Rectangle in lane coordinates (px). */
export interface MarqueeRect {
  left: number
  top: number
  right: number
  bottom: number
}

/** One track row's vertical span in lane coordinates. */
export interface MarqueeLane {
  trackId: string
  top: number
  height: number
}

/** How a marquee commit combines with the existing selection. */
export type MarqueeMode = 'replace' | 'add' | 'toggle'

/** Normalizes a drag from `(ax, ay)` to `(bx, by)` into a rect in any direction. */
export function normalizeMarquee(ax: number, ay: number, bx: number, by: number): MarqueeRect {
  return {
    left: Math.min(ax, bx),
    top: Math.min(ay, by),
    right: Math.max(ax, bx),
    bottom: Math.max(ay, by),
  }
}

/**
 * Every clip whose box the marquee overlaps, in track order then clip order.
 * Touching an edge does not select. A rect with NO extent at all (a click that
 * never became a drag) selects nothing, but a one-dimensional drag still does:
 * users drag boxes horizontally, and such a rect is a line through the rows it
 * crosses, so the row (or clip) under that line is a hit.
 */
export function marqueeHitClipIds(
  doc: Doc,
  lanes: MarqueeLane[],
  rect: MarqueeRect,
  pxPerSec: number,
): string[] {
  if (rect.right <= rect.left && rect.bottom <= rect.top) return []
  const byTrack = new Map(lanes.map((lane) => [lane.trackId, lane]))
  const hits: string[] = []
  for (const track of doc.project.tracks) {
    const lane = byTrack.get(track.id)
    if (!lane) continue
    // Row span. A rect with area needs STRICT overlap (touching an edge does
    // not select). A one-dimensional drag is a horizontal LINE at
    // y = rect.top (=== rect.bottom): it belongs to the row holding it under
    // the half-open rule lane.top <= y < lane.top + height, so a line exactly
    // on a boundary selects the row below instead of nothing.
    if (rect.top === rect.bottom) {
      if (rect.top < lane.top || rect.top >= lane.top + lane.height) continue
    } else if (rect.bottom <= lane.top || rect.top >= lane.top + lane.height) {
      continue
    }
    for (const clip of track.clips) {
      const left = clip.start * pxPerSec
      const right = (clip.start + clip.duration) * pxPerSec
      if (rect.right > left && rect.left < right) hits.push(clip.id)
    }
  }
  return hits
}

/**
 * Resolves the hit clips into the id list the store should hold for `mode`.
 * Hit clips are deduped into link groups, so an A/V pair counts once and both
 * halves end up selected. The current selection keeps its order (and its
 * primary id) wherever it survives.
 */
export function resolveMarqueeSelection(
  doc: Doc,
  hitIds: string[],
  currentSelections: string[],
  mode: MarqueeMode,
): string[] {
  const groups = linkGroupsFor(doc, hitIds)
  if (mode === 'replace') return groupMembers(groups)
  if (mode === 'add') {
    const out = [...currentSelections]
    for (const id of groupMembers(groups)) {
      if (!out.includes(id)) out.push(id)
    }
    return out
  }
  // toggle: flip each hit group as a unit (all-in removes, otherwise adds).
  let out = [...currentSelections]
  for (const group of groups) {
    const members = group.map((clip) => clip.id)
    const allIn = members.every((id) => out.includes(id))
    out = allIn
      ? out.filter((id) => !members.includes(id))
      : [...out, ...members.filter((id) => !out.includes(id))]
  }
  return out
}

/** The distinct link groups behind the hit ids, in first-hit order. */
function linkGroupsFor(doc: Doc, hitIds: string[]): Clip[][] {
  const seen = new Set<string>()
  const groups: Clip[][] = []
  for (const id of hitIds) {
    const group = linkedClips(doc, id)
    if (group.length === 0) continue
    const key = group[0].linkId ?? group[0].id
    if (seen.has(key)) continue
    seen.add(key)
    groups.push(group)
  }
  return groups
}

function groupMembers(groups: Clip[][]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const group of groups) {
    for (const clip of group) {
      if (seen.has(clip.id)) continue
      seen.add(clip.id)
      out.push(clip.id)
    }
  }
  return out
}
