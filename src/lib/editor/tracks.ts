import { rootReferences, sequenceReferences } from './factories'
import type { Doc, Track } from './types'

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
 *
 * Compound sequences (0.8.1) are pruned per OWNER: the root track list and each
 * sequence's track list are compared against their own before-state, so an edit
 * inside a compound empties a lane there and never touches a root lane.
 */
export function pruneEmptiedTracks(prev: Doc, next: Doc): Doc {
  const pruneList = (before: readonly Track[], after: Track[]): Track[] => {
    const emptied = new Set<string>()
    for (const b of before) {
      if (b.clips.length === 0) continue
      const a = after.find((t) => t.id === b.id)
      if (a && a.clips.length === 0) emptied.add(b.id)
    }
    if (emptied.size === 0) return after
    const kept = after.filter((t) => !emptied.has(t.id))
    // Everything would go: keep the first lane so the sequence stays valid.
    const result = kept.length > 0 ? kept : after.slice(0, 1)
    // The last-lane guard can leave the list unchanged; keep the identity so
    // the caller can tell "nothing pruned" without a deep compare.
    return result.length === after.length ? after : result
  }

  const root = pruneList(prev.project.tracks, next.project.tracks)
  const rootChanged = root !== next.project.tracks

  let sequences = next.project.sequences
  let sequencesChanged = false
  if (sequences) {
    const prevSeqs = prev.project.sequences ?? []
    sequences = sequences.map((s) => {
      const before = prevSeqs.find((p) => p.id === s.id)
      const tracks = pruneList(before?.tracks ?? s.tracks, s.tracks)
      if (tracks === s.tracks) return s
      sequencesChanged = true
      return { ...s, tracks }
    })
  }
  if (!rootChanged && !sequencesChanged) return next
  return {
    ...next,
    project: {
      ...next.project,
      tracks: root,
      ...(sequences ? { sequences } : {}),
    },
  }
}

/**
 * Removes compound sequences no longer reachable from a root compound
 * reference, plus any descendants made unreachable by that removal. Runs on
 * committed edits so undo restores it (same history entry). An empty result is
 * stored as `undefined` so a project that never had a compound stays clean.
 */
export function pruneOrphanSequences(next: Doc): Doc {
  const sequences = next.project.sequences
  if (!sequences || sequences.length === 0) return next
  const reachable = new Set<string>()
  const stack = [...rootReferences(next)]
  while (stack.length > 0) {
    const id = stack.pop() as string
    if (reachable.has(id)) continue
    reachable.add(id)
    const sequence = sequences.find((s) => s.id === id)
    if (sequence) stack.push(...sequenceReferences(sequence))
  }
  const kept = sequences.filter((s) => reachable.has(s.id))
  if (kept.length === sequences.length) return next
  return { ...next, project: { ...next.project, sequences: kept.length > 0 ? kept : undefined } }
}
