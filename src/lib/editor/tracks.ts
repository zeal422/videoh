import type { Doc } from './types'

/**
 * Removes the tracks an edit left empty.
 *
 * A track is removed only when THIS edit took its last clip away (it held clips
 * before and holds none now). A track that was already empty is left alone —
 * otherwise "add an empty layer, then fill it" would delete the layer the moment
 * anything else committed. At least one track always survives, because the model
 * is built on the rule that the last track cannot be removed.
 *
 * The store calls this on COMMITTED edits only, never mid-gesture: a transient
 * drag empties the source lane on the first pointermove, and pruning there would
 * delete the lane the pointer is still dragging out of.
 */
export function pruneEmptiedTracks(prev: Doc, next: Doc): Doc {
  const emptied = new Set<string>()
  for (const before of prev.project.tracks) {
    if (before.clips.length === 0) continue
    const after = next.project.tracks.find((t) => t.id === before.id)
    if (after && after.clips.length === 0) emptied.add(before.id)
  }
  if (emptied.size === 0) return next

  const kept = next.project.tracks.filter((t) => !emptied.has(t.id))
  // Everything would go: keep the first lane so the document stays valid.
  const tracks = kept.length > 0 ? kept : next.project.tracks.slice(0, 1)
  if (tracks.length === next.project.tracks.length) return next
  return { ...next, project: { ...next.project, tracks } }
}
