import { MIN_SPLIT_HEADROOM } from './constants'
import type { Clip, Doc, MediaAsset } from './types'

/**
 * A/V link semantics (Premiere-style linked clips).
 *
 * A video asset that has audio is placed as a LINKED PAIR: the video part on a
 * `video` track and an audio-only twin on an `audio` track, both sharing a
 * `linkId`. Until the user unlinks them, the pair behaves as one clip:
 * selected, moved, split and deleted together. The video part never plays
 * sound while its twin exists (the twin is the sole audio carrier — see
 * `PlaybackCore.computeGain`), which is what prevents double audio.
 *
 * Pure helpers only — every operation that MUTATES the doc lives in
 * `actions.ts` as command batches so undo/autosave/serialization keep working.
 */

/**
 * Whether the asset carries audible sound. `hasAudio` is probed at import;
 * legacy saves (field absent) fall back to the waveform-peaks heuristic —
 * peaks exist exactly when audio could be decoded.
 */
export function assetHasAudio(asset: MediaAsset): boolean {
  if (asset.kind === 'audio') return true
  if (asset.hasAudio !== undefined) return asset.hasAudio
  return asset.waveformPeaks !== undefined
}

/** All clips sharing `clipId`'s link group, ordered by (track order, start). */
export function linkedClips(doc: Doc, clipId: string): Clip[] {
  const found = findClipLocally(doc, clipId)
  if (!found) return []
  const { clip } = found
  if (!clip.linkId) return [clip]
  const group: Clip[] = []
  for (const track of doc.project.tracks) {
    for (const c of track.clips) {
      if (c.linkId === clip.linkId) group.push(c)
    }
  }
  return group
}

/**
 * The audio carrier of `clip`'s link group: the group member marked
 * `audioOnly`. May be the clip ITSELF when called on the audio side (it is
 * then already the carrier — `audibleClipId` relies on that). Undefined for
 * unlinked clips and groups without an audio part.
 */
export function linkedAudioTwin(doc: Doc, clip: Clip): Clip | undefined {
  if (!clip.linkId) return undefined
  for (const track of doc.project.tracks) {
    for (const c of track.clips) {
      if (c.linkId === clip.linkId && c.audioOnly) return c
    }
  }
  return undefined
}

/**
 * True when `clip` (a video-bearing occurrence) must stay SILENT because its
 * linked audio twin carries the group's sound. Never true for the audio
 * carrier itself — shadowing it would mute the whole pair. This is the
 * anti-double-audio rule applied by the playback engine and the exporter.
 */
export function hasLinkedAudioTwin(doc: Doc, clip: Clip): boolean {
  if (!clip.linkId || clip.audioOnly) return false
  return !!linkedAudioTwin(doc, clip)
}

/**
 * The clip id that owns the AUDIBLE side of the selection: for an A/V pair,
 * gain/mute edits always target the audio twin no matter which half is
 * selected (muting the video half would otherwise unmask its embedded audio
 * and double-play against the twin).
 */
export function audibleClipId(doc: Doc, clipId: string): string {
  const found = findClipLocally(doc, clipId)
  if (!found) return clipId
  return linkedAudioTwin(doc, found.clip)?.id ?? clipId
}

/**
 * The link group counts as "selected" when the store selection is any member.
 * Single-selection wrapper around {@link clipIsSelected} (kept for tests and
 * legacy callers).
 */
export function groupSelected(doc: Doc, selection: string | null, clip: Clip): boolean {
  return clipIsSelected(doc, selection ? [selection] : [], clip)
}

/** The link-group ids represented by the given selected clips (solo = own id). */
export function selectedLinkGroups(doc: Doc, selections: string[]): Set<string> {
  const groups = new Set<string>()
  for (const id of selections) {
    const clip = findClipLocally(doc, id)?.clip
    if (clip) groups.add(clip.linkId ?? `__solo:${clip.id}`)
  }
  return groups
}

/**
 * Multi-selection aware highlight: a clip is selected when its id is in
 * `selections` OR any selected clip belongs to the same link group
 * (selecting one half of an A/V pair highlights and drags BOTH).
 */
export function clipIsSelected(doc: Doc, selections: string[], clip: Clip): boolean {
  if (selections.includes(clip.id)) return true
  if (!clip.linkId) return false
  const groups = selectedLinkGroups(doc, selections)
  return groups.has(clip.linkId)
}

/** Number of DISTINCT link groups among the given clips (unlinked = own group). */
export function distinctLinkGroupCount(doc: Doc, clipIds: string[]): number {
  return selectedLinkGroups(
    doc,
    clipIds.filter((id) => !!findClipLocally(doc, id)),
  ).size
}

/**
 * Whether "Link" makes sense for the given selection (Premiere Ctrl+L):
 * at least two EXISTING non-text clips that are not all already in one group.
 */
export function canLinkClips(doc: Doc, clipIds: string[]): boolean {
  if (clipIds.length < 2) return false
  const clips = clipIds.map((id) => findClipLocally(doc, id)?.clip)
  if (clips.some((c) => !c)) return false
  if (clips.some((c) => c!.text !== undefined)) return false
  return distinctLinkGroupCount(doc, clipIds) >= 2
}

/** True when ANY selected clip belongs to a link group with more than one member. */
export function anySelectionLinked(doc: Doc, clipIds: string[]): boolean {
  return clipIds.some((id) => {
    const clip = findClipLocally(doc, id)?.clip
    return !!clip?.linkId && linkedClips(doc, id).length > 1
  })
}

/** True when the playhead sits strictly inside at least one group member. */
export function canSplitGroupAt(doc: Doc, clipId: string, at: number): boolean {
  return linkedClips(doc, clipId).some(
    (c) => at > c.start + MIN_SPLIT_HEADROOM && at < c.start + c.duration - MIN_SPLIT_HEADROOM,
  )
}

/** True when the playhead crosses at least one member of ANY selected group. */
export function canSplitAnySelectedAt(doc: Doc, clipIds: string[], at: number): boolean {
  return clipIds.some((id) => canSplitGroupAt(doc, id, at))
}

/**
 * Union of the link groups of every given clip (Premiere: operations act on
 * whole groups), deduped in doc order. Single source for every
 * multi-selection operation in `actions.ts` / `clipboard.ts`.
 */
export function resolveSelectionGroups(doc: Doc, clipIds: string[]): Clip[] {
  const seen = new Set<string>()
  const out: Clip[] = []
  for (const id of clipIds) {
    for (const clip of linkedClips(doc, id)) {
      if (!seen.has(clip.id)) {
        seen.add(clip.id)
        out.push(clip)
      }
    }
  }
  return out
}

function findClipLocally(doc: Doc, clipId: string): { clip: Clip } | undefined {
  for (const track of doc.project.tracks) {
    const clip = track.clips.find((c) => c.id === clipId)
    if (clip) return { clip }
  }
  return undefined
}
