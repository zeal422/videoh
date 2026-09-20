import { describe, expect, it, beforeEach } from 'vitest'

import { commandsToAddMedia } from '../actions'
import { applyCommands } from '../commands'
import {
  clearClipboard,
  commandsToCutClips,
  commandsToPasteClips,
  copyClips,
  hasClipboardContent,
} from '../clipboard'
import { createDoc, createMediaAsset } from '../factories'
import { linkedAudioTwin } from '../links'
import type { MediaAsset } from '../types'

/**
 * In-memory clip clipboard: copy snapshots the link group, cut = copy +
 * group delete (one undo step via the caller), paste places at the playhead
 * with fresh ids and an independent link bond.
 */

function avAsset(partial: Partial<MediaAsset> = {}): MediaAsset {
  return createMediaAsset({
    kind: 'video',
    name: 'movie.mp4',
    duration: 10,
    hasAudio: true,
    ...partial,
  })
}

function docWithPair(start = 0) {
  const doc = createDoc()
  const asset = avAsset()
  doc.media = [asset]
  const next = applyCommands(doc, commandsToAddMedia(doc, asset, start)!)
  return {
    doc: next,
    asset,
    video: next.project.tracks[0].clips[0],
    audio: next.project.tracks[1].clips[0],
  }
}

describe('clipboard copy/cut/paste', () => {
  // The clipboard is session memory (module scope) — reset between tests.
  beforeEach(() => clearClipboard())

  it('copy snapshots the whole link group and enables paste', () => {
    const { doc, video } = docWithPair()
    expect(hasClipboardContent()).toBe(false)
    const copied = copyClips(doc, [video.id])
    expect(copied).toBe(2)
    expect(hasClipboardContent()).toBe(true)
  })

  it('copy is MULTI-selection aware: two clips at once land in one clipboard', () => {
    const { doc, video } = docWithPair()
    const second = avAsset({ name: 'second.mp4', hasAudio: false })
    const withSecond = applyCommands(doc, [
      { type: 'addMediaAsset', asset: second }, // register for clipFitsTrack
      ...commandsToAddMedia(doc, second, 12)!,
    ])
    const solo = withSecond.project.tracks[0].clips[1]

    const copied = copyClips(withSecond, [video.id, solo.id])
    expect(copied).toBe(3) // pair (2) + solo (1), groups deduped

    const commands = commandsToPasteClips(withSecond, 30)!
    const next = applyCommands(withSecond, commands)
    expect(next.project.tracks[0].clips.filter((c) => c.start === 30)).toHaveLength(2)
    expect(next.project.tracks[1].clips.filter((c) => c.start === 30)).toHaveLength(1)
    // The pasted pair keeps its own bond; the solo (identifiable by media) stays unlinked.
    const pastedSolo = next.project.tracks[0].clips.find(
      (c) => c.start === 30 && c.mediaId === second.id,
    )!
    expect(pastedSolo.linkId).toBeUndefined()
  })

  it('cut returns copy + group delete as ONE batch', () => {
    const { doc, video, audio } = docWithPair()
    const commands = commandsToCutClips(doc, [video.id])!
    expect(commands).toHaveLength(2)
    expect(commands.every((c) => c.type === 'deleteClip')).toBe(true)
    expect(commands.some((c) => c.type === 'deleteClip' && c.clipId === audio.id)).toBe(true)

    const next = applyCommands(doc, commands!)
    expect(next.project.tracks[0].clips).toHaveLength(0)
    expect(next.project.tracks[1].clips).toHaveLength(0)
    // ...and the cut content is pasteable afterwards.
    expect(hasClipboardContent()).toBe(true)
  })

  it('cut returns null when the clip is gone', () => {
    expect(commandsToCutClips(createDoc(), ['clip_missing'])).toBeNull()
  })

  it('paste places the pair at the playhead with fresh ids and a fresh bond', () => {
    const { doc, video, audio } = docWithPair(0)
    copyClips(doc, [video.id])

    const commands = commandsToPasteClips(doc, 5)
    expect(commands).toHaveLength(2)
    const next = applyCommands(doc, commands!)

    const newVideo = next.project.tracks[0].clips.find((c) => c.start === 5)!
    const newAudio = next.project.tracks[1].clips.find((c) => c.start === 5)!
    expect(newVideo.id).not.toBe(video.id)
    expect(newAudio.id).not.toBe(audio.id)
    expect(newVideo.linkId).toBe(newAudio.linkId) // pasted pair is linked…
    expect(newVideo.linkId).not.toBe(video.linkId) // …independently
    expect(newAudio.audioOnly).toBe(true)
    expect(newVideo.duration).toBe(10)
    expect(newAudio.duration).toBe(10)
  })

  it('paste prefers the original track, falling back to a compatible lane', () => {
    const { doc, video } = docWithPair(0)
    copyClips(doc, [video.id])

    // The original tracks (V1/A1) still exist → entries land back on them.
    const commands = commandsToPasteClips(doc, 0)
    const next = applyCommands(doc, commands!)
    expect(next.project.tracks[0].clips.some((c) => c.start === 0)).toBe(true)
    expect(next.project.tracks[1].clips.some((c) => c.start === 0)).toBe(true)
  })

  it('paste of an unlinked single clip stays unlinked', () => {
    const doc = createDoc()
    const asset = avAsset({ hasAudio: false })
    doc.media = [asset]
    const withClip = applyCommands(doc, commandsToAddMedia(doc, asset, 0)!)
    const clip = withClip.project.tracks[0].clips[0]

    copyClips(withClip, [clip.id])
    const commands = commandsToPasteClips(withClip, 3)
    const next = applyCommands(withClip, commands!)
    const pasted = next.project.tracks[0].clips.find((c) => c.start === 3)!
    expect(pasted.linkId).toBeUndefined()
    expect(linkedAudioTwin(next, pasted)).toBeUndefined()
  })

  it('paste creates a track when no compatible lane exists', () => {
    const doc = createDoc()
    const asset = avAsset({ hasAudio: false })
    doc.media = [asset]
    const withClip = applyCommands(doc, commandsToAddMedia(doc, asset, 0)!)
    const clip = withClip.project.tracks[0].clips[0]
    copyClips(withClip, [clip.id])

    const stripped = structuredClone(withClip) // remove ALL tracks but audio
    stripped.project.tracks = stripped.project.tracks.filter((t) => t.kind !== 'video')
    const commands = commandsToPasteClips(stripped, 0)
    expect(commands![0].type).toBe('addTrack')

    const next = applyCommands(stripped, commands!)
    expect(next.project.tracks.some((t) => t.kind === 'video' && t.clips.length === 1)).toBe(true)
  })

  it('paste returns null with an empty clipboard', () => {
    expect(commandsToPasteClips(createDoc(), 0)).toBeNull()
  })
})
