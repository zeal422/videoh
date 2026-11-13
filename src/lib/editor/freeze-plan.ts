/**
 * freeze-plan.ts: the pure half of Freeze Frame (0.23.0).
 *
 * The command builds no new schema: it adds a still image asset, a new video
 * track at index 0 of the active sequence, and one clip at the playhead, as a
 * single batch. This module decides whether that batch would be meaningful and
 * deterministic-looking, and constructs it. The browser renderer lives in
 * `media/freeze-frame.ts`.
 */

import { FREEZE_FRAME_DURATION } from './constants'
import type { EditorCommand } from './commands'
import { activeSequenceId, createClip, findSequence, sequenceTracks, uid } from './factories'
import { animatedValue } from './keyframes'
import type { Clip, Doc, MediaAsset, Track } from './types'

export type FreezeRefusalReason = 'empty' | 'offline' | 'no-sequence'

/**
 * True when at least one visual clip draws at `time`. Text clips count; a
 * hidden lane, an audio lane, and a compound with no visible child do not.
 * A compound maps its local time straight from the container (the composer's
 * own mapping: `t - clip.start`).
 */
export function hasVisibleFrame(
  doc: Doc,
  tracks: readonly Track[],
  time: number,
  depth = 0,
): boolean {
  if (depth > 8) return false
  for (const track of tracks) {
    if (track.kind === 'audio' || track.visible === false) continue
    for (const clip of track.clips) {
      if (time < clip.start || time >= clip.start + clip.duration) continue
      // The compositor skips a clip whose evaluated opacity is zero, so a
      // fully transparent clip draws nothing and cannot justify a still.
      if (animatedValue(clip, 'opacity', time - clip.start) <= 0) continue
      if (clip.sequenceId) {
        const sequence = findSequence(doc, clip.sequenceId)
        if (sequence && hasVisibleFrame(doc, sequence.tracks, time - clip.start, depth + 1)) {
          return true
        }
        continue
      }
      return true
    }
  }
  return false
}

/** True when a media clip that draws at `time` has no playable source. */
export function hasOfflineVisibleFrame(
  doc: Doc,
  tracks: readonly Track[],
  time: number,
  depth = 0,
): boolean {
  if (depth > 8) return false
  for (const track of tracks) {
    if (track.kind === 'audio' || track.visible === false) continue
    for (const clip of track.clips) {
      if (time < clip.start || time >= clip.start + clip.duration) continue
      // The compositor skips a clip whose evaluated opacity is zero, so an
      // offline source that draws nothing cannot block a still of the footage
      // beneath it.
      if (animatedValue(clip, 'opacity', time - clip.start) <= 0) continue
      if (clip.sequenceId) {
        const sequence = findSequence(doc, clip.sequenceId)
        if (
          sequence &&
          hasOfflineVisibleFrame(doc, sequence.tracks, time - clip.start, depth + 1)
        ) {
          return true
        }
        continue
      }
      // Text draws from its own style, not from a media asset.
      if (clip.text !== undefined) continue
      const asset = doc.media.find((candidate) => candidate.id === clip.mediaId)
      if (!asset || asset.missing || !asset.url || !asset.file) return true
    }
  }
  return false
}

export type FreezePlan = { ok: true } | { ok: false; reason: FreezeRefusalReason }

/**
 * Refuses before any encoding: an empty playhead (nothing to capture), an
 * offline visible source, or an active-sequence path that names no sequence.
 */
export function planFreezeFrame(
  doc: Doc,
  activeSequencePath: readonly string[],
  time: number,
): FreezePlan {
  const sequenceId = activeSequenceId(activeSequencePath)
  if (sequenceId && !findSequence(doc, sequenceId)) return { ok: false, reason: 'no-sequence' }
  const tracks = sequenceTracks(doc, sequenceId)
  if (!Number.isFinite(time) || !hasVisibleFrame(doc, tracks, time)) {
    return { ok: false, reason: 'empty' }
  }
  if (hasOfflineVisibleFrame(doc, tracks, time)) return { ok: false, reason: 'offline' }
  return { ok: true }
}

/** Menu availability, which is exactly the plan. */
export function canFreezeFrame(
  doc: Doc,
  activeSequencePath: readonly string[],
  time: number,
): boolean {
  return planFreezeFrame(doc, activeSequencePath, time).ok
}

export interface FreezeFrameBatch {
  commands: EditorCommand[]
  trackId: string
  clipId: string
}

/**
 * The still asset, the new topmost video lane, and the clip at the playhead as
 * one atomic batch. A new lane means a locked source lane and a clip collision
 * at the playhead cannot block or cover the still.
 */
export function commandsToFreezeFrame(input: {
  activeSequencePath: readonly string[]
  time: number
  asset: MediaAsset
}): FreezeFrameBatch {
  const { time, asset } = input
  const trackId = uid('track')
  const clipId = uid('clip')
  const sequenceId = activeSequenceId(input.activeSequencePath)
  const clip: Clip = createClip({
    id: clipId,
    mediaId: asset.id,
    start: Math.max(0, time),
    duration: FREEZE_FRAME_DURATION,
    inPoint: 0,
  })
  const commands: EditorCommand[] = [
    { type: 'addMediaAsset', asset },
    {
      type: 'addTrack',
      kind: 'video',
      trackId,
      atIndex: 0,
      ...(sequenceId ? { sequenceId } : {}),
    },
    { type: 'addClip', clip, trackId },
  ]
  return { commands, trackId, clipId }
}
