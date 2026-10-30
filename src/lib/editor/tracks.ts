import { findClip, rootReferences, sequenceReferences } from './factories'
import { linkedClips } from './links'
import type { Doc, Track } from './types'

// ————— Audibility (0.14.0) —————

/**
 * True when at least one AUDIO track in the list is soloed. Solo is an audio
 * monitoring feature: a `solo` flag on a video or text lane can never arm it
 * (hydration drops one, and `setTrackSolo` refuses to create one).
 */
export function anySoloFor(tracks: readonly Track[]): boolean {
  return tracks.some((track) => track.kind === 'audio' && track.solo === true)
}

/**
 * The track ids a sequence may be heard from at this moment. With no solo, it
 * is every non-muted track (the pre-0.14.0 rule). With any solo, it is ONLY
 * the soloed audio tracks that are also not muted: a video lane is excluded,
 * so a solo video's embedded audio is silent while an audio track is soloed,
 * and a soloed track that is itself muted stays silent. The preview mixer, the
 * offline plan and the shipped MP4 mix all read this one set, so they cannot
 * disagree about what is audible.
 */
export function audibleTrackIds(tracks: readonly Track[]): Set<string> {
  const solo = anySoloFor(tracks)
  const ids = new Set<string>()
  for (const track of tracks) {
    if (track.muted) continue
    if (solo && (track.kind !== 'audio' || track.solo !== true)) continue
    ids.add(track.id)
  }
  return ids
}

// ————— Lock (0.14.0) —————

/** The first locked track in the list, or undefined when every lane is open. */
export function findLockedTrack(tracks: readonly Track[]): Track | undefined {
  return tracks.find((track) => track.locked === true)
}

/** The one user-facing lock message, shared by the command layer and the UI. */
export function trackLockMessage(track: Pick<Track, 'id' | 'name'>): string {
  return `Track ${track.name} is locked. Unlock it to edit its clips.`
}

/**
 * Every track an edit of the given clips can touch: the clips' own lanes plus
 * every member of their link groups (a linked group is one editing unit, so a
 * locked partner refuses the whole operation). Deduped by track id, doc order
 * preserved. Unknown clip ids contribute nothing; the command itself reports
 * them.
 */
export function clipGroupTracks(doc: Doc, clipIds: readonly string[]): Track[] {
  const out: Track[] = []
  const seen = new Set<string>()
  const add = (track: Track | undefined) => {
    if (!track || seen.has(track.id)) return
    seen.add(track.id)
    out.push(track)
  }
  for (const clipId of clipIds) {
    add(findClip(doc, clipId)?.track)
    for (const member of linkedClips(doc, clipId)) add(findClip(doc, member.id)?.track)
  }
  return out
}

/**
 * The first locked track an edit of these clips would touch, own lane or link
 * partner. The UI gesture gates read this BEFORE beginning a transient, so a
 * refused drag or trim never writes a frame.
 */
export function firstLockedTrackForClips(doc: Doc, clipIds: readonly string[]): Track | undefined {
  return findLockedTrack(clipGroupTracks(doc, clipIds))
}

/** Lock check for a single clip edit (its lane, not its link partners). */
export function lockedTrackForClip(doc: Doc, clipId: string): Track | undefined {
  const track = findClip(doc, clipId)?.track
  return track?.locked ? track : undefined
}

/** Lock check for a clip edit that carries its link group (move/trim/split). */
export function lockedTrackForClipGroup(doc: Doc, clipId: string): Track | undefined {
  return firstLockedTrackForClips(doc, [clipId])
}

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
