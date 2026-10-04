import { MIN_SPLIT_HEADROOM } from './constants'
import { constantTimeScaleRate, hasTimeScaleRamp } from './keyframes'
import { findMedia, mediaPlayable } from './factories'
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
 * carrier itself (shadowing it would mute the whole pair), and never true for
 * a kind-audio clip: only a VIDEO part has embedded audio to hide, so an
 * audio clip merged into the group by a manual link keeps its own sound (the
 * export mix renders it that way). This is the anti-double-audio rule applied
 * by the playback engine and the exporter.
 *
 * The twin's own playability is deliberately NOT checked: a twin whose media
 * is gone still counts as the carrier, so the pair stays silent until the
 * asset returns. Unmasking the video half instead would play its embedded
 * audio, a different source whenever the group spans two assets, which the
 * export mixer never renders, and preview and export would stop agreeing.
 */
export function hasLinkedAudioTwin(doc: Doc, clip: Clip): boolean {
  if (!clip.linkId || clip.audioOnly) return false
  // Only a video-bearing part has embedded audio to shadow. A kind-audio clip
  // in the group has its own track and keeps its own sound (manual links are
  // never muted), so the preview must not silence it.
  if (findMedia(doc, clip.mediaId)?.kind !== 'video') return false
  return !!linkedAudioTwin(doc, clip)
}

/**
 * True when `clip` contributes its own audio to the mix: a playable
 * kind-audio clip, a playable `audioOnly` carrier, or a playable video part
 * with no linked carrier whose asset carries audio. Mirrors
 * PlaybackCore.computeGain (the video part is shadowed only while a linked
 * twin exists), so preview and export cannot disagree; requiring playability
 * FIRST keeps every offline branch (audio, carrier or solo video) out of the
 * plan, which the mix skips at its `asset.file` gate.
 */
export function clipRendersAudio(doc: Doc, clip: Clip): boolean {
  const asset = findMedia(doc, clip.mediaId)
  if (!asset || !mediaPlayable(asset)) return false
  if (asset.kind === 'audio' || clip.audioOnly) return true
  return asset.kind === 'video' && assetHasAudio(asset) && !hasLinkedAudioTwin(doc, clip)
}

/**
 * True when `clip`'s audio cannot follow its group's timing. Two reasons: a
 * real `timeScale` ramp ON `clip` itself (no constant rate can follow it, so
 * its own audio cannot render), and an A/V pair whose members' effective
 * rates DISAGREE (a ramp anywhere, or a curve constant or plain static speed
 * that leaves one half off the others'). Only a group with an `audioOnly`
 * carrier is an A/V pair: the carrier is the group's designated sound and
 * must follow the picture's rate. The rate rule binds only the group's A/V
 * members (the carriers and the video-bearing parts): a kind-audio clip
 * merged into the group has its own timeline and its own sound, so its
 * static rate is renderable by resampling and neither silences the pair nor
 * gets silenced with it (its own real ramp is the only thing that drops its
 * audio). Clips linked for editing convenience keep their own rates and
 * their own audio, like linked clips in Premiere, Resolve and Final Cut.
 * Members whose media does not resolve are ignored by
 * the rate comparisons (TO_FIX item 11): media that cannot play cannot
 * desync anything. Carrier-ness itself is structural, tested on the whole
 * group, so a carrier whose media is gone still makes the group an A/V pair
 * (a dead twin stays the carrier, the same rule `hasLinkedAudioTwin`
 * follows). The identity seed (flat at 1) and a pair whose halves agree on
 * one rate change nothing, so both keep their audio, and a SOLO clip always
 * keeps its resampled audio (its element follows its own constant). Derived
 * rather than stored, so it cannot go stale.
 */
export function linkGroupChangesRate(doc: Doc, clip: Clip): boolean {
  const group = linkedClips(doc, clip.id)
  const members = group.filter((c) => mediaPlayable(findMedia(doc, c.mediaId)))
  if (members.length === 0) return false
  // A real ramp on THIS clip makes its own audio unrenderable, carrier or not.
  // (Playability matters here too: a dead clip has no audio to drop, item 11.)
  if (mediaPlayable(findMedia(doc, clip.mediaId)) && hasTimeScaleRamp(clip)) return true
  // The rest is A/V pair semantics: only a group with an `audioOnly` carrier
  // has a designated sound that must follow the picture's rate. Carrier-ness
  // is STRUCTURAL, tested on the whole group: a carrier whose media is gone
  // still holds the pair together (the same decision hasLinkedAudioTwin
  // makes), while the playability filter above only narrows the rate
  // comparisons below (a member that cannot play cannot desync anything).
  if (!group.some((c) => c.audioOnly)) return false
  // Pair semantics bind only the A/V members (the carriers and the
  // video-bearing parts). A kind-audio clip has no picture to follow, so its
  // own static rate is renderable by resampling and must not fold into (or
  // be silenced by) the pair's comparison; its own ramp is handled above.
  const isAvMember = !!clip.audioOnly || findMedia(doc, clip.mediaId)?.kind === 'video'
  if (!isAvMember) return false
  const avMembers = members.filter(
    (c) => c.audioOnly || findMedia(doc, c.mediaId)?.kind === 'video',
  )
  if (avMembers.some((c) => hasTimeScaleRamp(c))) return true
  const rates = new Set(avMembers.map((c) => constantTimeScaleRate(c) ?? c.speed ?? 1))
  return rates.size > 1
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
