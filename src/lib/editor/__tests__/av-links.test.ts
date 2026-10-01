import { describe, expect, it } from 'vitest'

import {
  commandsToAddMedia,
  commandsToAddMediaInNewTrack,
  commandsToDeleteClips,
  commandsToDuplicateClips,
  commandsToLinkClips,
  commandsToRippleDeleteClips,
  commandsToSplitClipsAt,
  commandsToUnlinkClips,
} from '../actions'
import { applyCommands, applyCommand, EditorCommandError } from '../commands'
import { clipFitsTrack, createClip, createDoc, createMediaAsset } from '../factories'
import {
  assetHasAudio,
  audibleClipId,
  canLinkClips,
  canSplitGroupAt,
  clipIsSelected,
  distinctLinkGroupCount,
  groupSelected,
  hasLinkedAudioTwin,
  linkGroupHasRamp,
  linkedAudioTwin,
  linkedClips,
} from '../links'
import type { Clip, Doc, MediaAsset } from '../types'

/**
 * A/V link semantics (Premiere-style): a video asset WITH audio is placed as
 * a linked pair (video part + audio-only twin sharing one linkId), the pair
 * dies/moves/splits together until unlinked, and the audio twin is the sole
 * sound carrier (the engine shadows the video part's embedded audio).
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

function clipById(doc: Doc, id: string): { clip: Clip; trackKind: string } | undefined {
  for (const track of doc.project.tracks) {
    const clip = track.clips.find((c) => c.id === id)
    if (clip) return { clip, trackKind: track.kind }
  }
  return undefined
}

describe('assetHasAudio', () => {
  it('audio assets always carry sound', () => {
    expect(assetHasAudio(createMediaAsset({ kind: 'audio' }))).toBe(true)
  })

  it('uses the probed hasAudio flag when present', () => {
    expect(assetHasAudio(avAsset({ hasAudio: true }))).toBe(true)
    expect(assetHasAudio(avAsset({ hasAudio: false, waveformPeaks: [0.5] }))).toBe(false)
  })

  it('falls back to the waveform-peaks heuristic for legacy saves', () => {
    expect(assetHasAudio(avAsset({ hasAudio: undefined, waveformPeaks: [0.5] }))).toBe(true)
    expect(assetHasAudio(avAsset({ hasAudio: undefined }))).toBe(false)
  })
})

describe('commandsToAddMedia — A/V split on insert', () => {
  it('places a linked pair: video part on the video track, audio twin on A1', () => {
    const doc = createDoc() // [V1, A1]
    const asset = avAsset()
    doc.media = [asset]

    const commands = commandsToAddMedia(doc, asset, 2, doc.project.tracks[0].id)
    expect(commands).toHaveLength(2) // two addClips, no track creation

    const next = applyCommands(doc, commands!)
    expect(next.project.tracks[0].kind).toBe('video')
    expect(next.project.tracks[1].kind).toBe('audio')

    const v = next.project.tracks[0].clips[0]
    const a = next.project.tracks[1].clips[0]
    expect(v.linkId).toBe(a.linkId) // the bond
    expect(v.audioOnly).toBeUndefined()
    expect(a.audioOnly).toBe(true)
    expect(v.start).toBe(2)
    expect(a.start).toBe(2)
    expect(v.duration).toBe(10)
    expect(a.duration).toBe(10)
    expect(v.inPoint).toBe(0)
    expect(a.inPoint).toBe(0)
    expect(v.mediaId).toBe(asset.id)
    expect(a.mediaId).toBe(asset.id)
  })

  it('video WITHOUT audio stays a single unlinked clip', () => {
    const doc = createDoc()
    const asset = avAsset({ hasAudio: false })
    doc.media = [asset]

    const commands = commandsToAddMedia(doc, asset, 0)
    expect(commands).toHaveLength(1)
    const next = applyCommands(doc, commands!)
    const clip = next.project.tracks[0].clips[0]
    expect(clip.linkId).toBeUndefined()
    expect(clip.audioOnly).toBeUndefined()
    expect(next.project.tracks[1].clips).toHaveLength(0)
  })

  it('creates the audio lane at the bottom when the doc has none', () => {
    const doc = createDoc()
    doc.project.tracks = doc.project.tracks.filter((t) => t.kind !== 'audio') // [V1]
    const asset = avAsset()
    doc.media = [asset]

    const commands = commandsToAddMedia(doc, asset, 0)
    expect(commands).toHaveLength(3)
    expect(commands![0]).toMatchObject({ type: 'addTrack', kind: 'audio', atIndex: 1 })

    const next = applyCommands(doc, commands!)
    expect(next.project.tracks.map((t) => t.kind)).toEqual(['video', 'audio'])
    expect(next.project.tracks[1].clips[0].audioOnly).toBe(true)
  })

  it('audio and image media never split', () => {
    const doc = createDoc()
    const song = createMediaAsset({ kind: 'audio', duration: 5 })
    const pic = createMediaAsset({ kind: 'image', duration: 0 })
    doc.media = [song, pic]

    const songCommands = commandsToAddMedia(doc, song, 0)!
    expect(songCommands).toHaveLength(1)
    const picCommands = commandsToAddMedia(doc, pic, 0)!
    expect(picCommands).toHaveLength(1)
  })
})

describe('commandsToAddMediaInNewTrack — A/V split with explicit z-placement', () => {
  it('video part on the new layer, audio twin on the existing A1', () => {
    const doc = createDoc() // [V1, A1]
    const asset = avAsset()
    doc.media = [asset]

    const next = applyCommands(doc, commandsToAddMediaInNewTrack(doc, asset, 0, 0))
    expect(next.project.tracks.map((t) => t.kind)).toEqual(['video', 'video', 'audio'])
    const newTrack = next.project.tracks[0]
    expect(newTrack.clips).toHaveLength(1)
    const v = newTrack.clips[0]
    const a = next.project.tracks[2].clips[0]
    expect(v.linkId).toBe(a.linkId)
    expect(a.audioOnly).toBe(true)
  })

  it('creates the audio lane right below the new video layer when none exists', () => {
    const doc = createDoc()
    doc.project.tracks = doc.project.tracks.filter((t) => t.kind !== 'audio') // [V1]
    const asset = avAsset()
    doc.media = [asset]

    const commands = commandsToAddMediaInNewTrack(doc, asset, 0, 0)
    expect(commands[0]).toMatchObject({ type: 'addTrack', kind: 'video', atIndex: 0 })
    expect(commands[1]).toMatchObject({ type: 'addTrack', kind: 'audio', atIndex: 1 })

    const next = applyCommands(doc, commands)
    expect(next.project.tracks.map((t) => t.kind)).toEqual(['video', 'audio', 'video'])
    const v = next.project.tracks[0].clips[0]
    const a = next.project.tracks[1].clips[0]
    expect(v.linkId).toBe(a.linkId)
  })
})

describe('link-group operations', () => {
  function docWithPair() {
    const doc = createDoc()
    const asset = avAsset()
    doc.media = [asset]
    const next = applyCommands(doc, commandsToAddMedia(doc, asset, 0)!)
    const video = next.project.tracks[0].clips[0]
    const audio = next.project.tracks[1].clips[0]
    return { doc: next, asset, video, audio }
  }

  it('linkedClips groups the pair; the audio carrier is discoverable from both sides', () => {
    const { doc, video, audio } = docWithPair()
    expect(
      linkedClips(doc, video.id)
        .map((c) => c.id)
        .sort(),
    ).toEqual([video.id, audio.id].sort())
    expect(linkedAudioTwin(doc, video)?.id).toBe(audio.id)
    expect(hasLinkedAudioTwin(doc, video)).toBe(true)
    // From the audio side, the carrier IS the clip itself (audibleClipId
    // relies on that) — but the engine's shadow rule never applies to it.
    expect(linkedAudioTwin(doc, audio)?.id).toBe(audio.id)
    expect(hasLinkedAudioTwin(doc, audio)).toBe(false)
  })

  it('linkGroupHasRamp sees a REAL ramp on either member, and only timeScale', () => {
    const { doc, video, audio } = docWithPair()
    expect(linkGroupHasRamp(doc, video)).toBe(false)

    // An IDENTITY seed is not a ramp: the flat curve is resamplable at a
    // constant rate, so the group keeps its audio (the diamond's first click
    // used to mute the pair for nothing).
    video.keyframes = { timeScale: [{ time: 0, value: 1 }] }
    expect(linkGroupHasRamp(doc, video)).toBe(false)

    // A real ramp on the VIDEO half makes the whole group ramped, so the
    // twin's audio goes silent with it (the derived predicate is the reason).
    video.keyframes = {
      timeScale: [
        { time: 0, value: 1 },
        { time: 4, value: 2 },
      ],
    }
    expect(linkGroupHasRamp(doc, video)).toBe(true)
    expect(linkGroupHasRamp(doc, audio)).toBe(true)

    // Other curves are not ramps.
    video.keyframes = { opacity: [{ time: 0, value: 1 }] }
    expect(linkGroupHasRamp(doc, video)).toBe(false)

    // An unlinked clip is its own group.
    const solo = createClip({ id: 'solo', duration: 4 })
    doc.project.tracks[0].clips.push(solo)
    expect(linkGroupHasRamp(doc, solo)).toBe(false)
    solo.keyframes = {
      timeScale: [
        { time: 0, value: 1 },
        { time: 4, value: 2 },
      ],
    }
    expect(linkGroupHasRamp(doc, solo)).toBe(true)
  })

  it('audibleClipId routes audio edits to the twin from either side', () => {
    const { doc, video, audio } = docWithPair()
    expect(audibleClipId(doc, video.id)).toBe(audio.id)
    expect(audibleClipId(doc, audio.id)).toBe(audio.id)
  })

  it('groupSelected highlights both halves from one store selection', () => {
    const { doc, video, audio } = docWithPair()
    expect(groupSelected(doc, video.id, video)).toBe(true)
    expect(groupSelected(doc, video.id, audio)).toBe(true)
    expect(groupSelected(doc, audio.id, video)).toBe(true)
    expect(groupSelected(doc, null, video)).toBe(false)
    // Unlinked clips never light up for each other.
    const bare = createDoc()
    const a = createClip({ start: 0, duration: 2 })
    const b = createClip({ start: 3, duration: 2 })
    bare.project.tracks[0].clips.push(a, b)
    expect(groupSelected(bare, a.id, b)).toBe(false)
  })

  it('clipIsSelected works over the MULTI-selection list (any member lights the group)', () => {
    const { doc, video, audio } = docWithPair()
    expect(clipIsSelected(doc, [video.id], audio)).toBe(true)
    expect(clipIsSelected(doc, [video.id], video)).toBe(true)
    expect(clipIsSelected(doc, [], video)).toBe(false)
    // Selecting a clip from ANOTHER group keeps this group dark.
    const bare = createDoc()
    const c = createClip({ start: 0, duration: 2 })
    bare.project.tracks[0].clips.push(c)
    expect(clipIsSelected(doc, [c.id], video)).toBe(false)
  })

  it('delete removes the WHOLE pair in one undoable batch', () => {
    const { doc, video } = docWithPair()
    const next = applyCommands(doc, commandsToDeleteClips(doc, [video.id]))
    expect(next.project.tracks[0].clips).toHaveLength(0)
    expect(next.project.tracks[1].clips).toHaveLength(0)
  })

  it('split re-links the right halves into a fresh group', () => {
    const { doc, video, audio } = docWithPair()
    const commands = commandsToSplitClipsAt(doc, [video.id], 4)
    expect(commands).toHaveLength(2)
    expect(commands!.every((c) => c.type === 'splitClip')).toBe(true)

    const next = applyCommands(doc, commands!)
    const vLeft = clipById(next, video.id)!.clip
    const aLeft = clipById(next, audio.id)!.clip
    const vRight = next.project.tracks[0].clips.find((c) => c.id !== video.id)!
    const aRight = next.project.tracks[1].clips.find((c) => c.id !== audio.id)!

    // Left halves keep the original bond.
    expect(vLeft.linkId).toBe(audio.linkId)
    expect(aLeft.linkId).toBe(audio.linkId)
    // Right halves share a NEW bond (independent of the left pair).
    expect(vRight.linkId).toBeDefined()
    expect(vRight.linkId).toBe(aRight.linkId)
    expect(vRight.linkId).not.toBe(audio.linkId)
    // Split geometry.
    expect(vLeft.duration).toBe(4)
    expect(vRight.start).toBe(4)
    expect(aRight.start).toBe(4)
    expect(aRight.audioOnly).toBe(true)
  })

  it('split of an unlinked clip leaves both halves unlinked', () => {
    const doc = createDoc()
    const asset = avAsset({ hasAudio: false })
    doc.media = [asset]
    const withClip = applyCommands(doc, commandsToAddMedia(doc, asset, 0)!)
    const clip = withClip.project.tracks[0].clips[0]

    const next = applyCommands(withClip, commandsToSplitClipsAt(withClip, [clip.id], 2)!)
    expect(next.project.tracks[0].clips).toHaveLength(2)
    for (const c of next.project.tracks[0].clips) expect(c.linkId).toBeUndefined()
  })

  it('split returns null when the playhead is not strictly inside any member', () => {
    const { doc, video } = docWithPair()
    expect(commandsToSplitClipsAt(doc, [video.id], 0)).toBeNull()
    expect(commandsToSplitClipsAt(doc, [video.id], 10)).toBeNull()
    expect(commandsToSplitClipsAt(doc, [video.id], 0.05)).toBeNull()
    expect(canSplitGroupAt(doc, video.id, 4)).toBe(true)
    expect(canSplitGroupAt(doc, video.id, 0)).toBe(false)
  })

  it('duplicate copies the whole pair with an independent fresh bond', () => {
    const { doc, video, audio } = docWithPair()
    const next = applyCommands(doc, commandsToDuplicateClips(doc, [video.id])!)

    const vCopy = next.project.tracks[0].clips.find((c) => c.id !== video.id)!
    const aCopy = next.project.tracks[1].clips.find((c) => c.id !== audio.id)!
    expect(vCopy.start).toBe(10) // butt after the 10s original
    expect(aCopy.start).toBe(10)
    expect(vCopy.linkId).toBe(aCopy.linkId) // copies stay linked to each other…
    expect(vCopy.linkId).not.toBe(video.linkId) // …and independent of the source
    expect(aCopy.audioOnly).toBe(true)
    // Originals untouched.
    expect(next.project.tracks[0].clips).toHaveLength(2)
    expect(next.project.tracks[1].clips).toHaveLength(2)
  })

  it('duplicate of an unlinked clip stays unlinked', () => {
    const doc = createDoc()
    const asset = avAsset({ hasAudio: false })
    doc.media = [asset]
    const withClip = applyCommands(doc, commandsToAddMedia(doc, asset, 0)!)
    const clip = withClip.project.tracks[0].clips[0]
    const next = applyCommands(withClip, commandsToDuplicateClips(withClip, [clip.id])!)
    expect(next.project.tracks[0].clips).toHaveLength(2)
    for (const c of next.project.tracks[0].clips) expect(c.linkId).toBeUndefined()
  })

  it('unlink breaks the bond in one command; the pair keeps playing its own sides', () => {
    const { doc, video, audio } = docWithPair()
    const unlinkCommands = commandsToUnlinkClips(doc, [video.id])
    expect(unlinkCommands).toEqual([{ type: 'unlinkClip', clipId: video.id }])

    const next = applyCommand(doc, unlinkCommands![0])
    expect(clipById(next, video.id)!.clip.linkId).toBeUndefined()
    expect(clipById(next, audio.id)!.clip.linkId).toBeUndefined()
    // Both clips stay in place.
    expect(next.project.tracks[0].clips).toHaveLength(1)
    expect(next.project.tracks[1].clips).toHaveLength(1)
  })

  it('unlink is a no-op (null) for unlinked clips', () => {
    const doc = createDoc()
    const asset = avAsset({ hasAudio: false })
    doc.media = [asset]
    const withClip = applyCommands(doc, commandsToAddMedia(doc, asset, 0)!)
    expect(commandsToUnlinkClips(withClip, [withClip.project.tracks[0].clips[0].id])).toBeNull()
  })

  it('unlinkClip command throws for a clip without a link', () => {
    const doc = createDoc()
    const asset = avAsset({ hasAudio: false })
    doc.media = [asset]
    const withClip = applyCommands(doc, commandsToAddMedia(doc, asset, 0)!)
    const id = withClip.project.tracks[0].clips[0].id
    expect(() => applyCommand(withClip, { type: 'unlinkClip', clipId: id })).toThrow(
      EditorCommandError,
    )
  })
})

describe('manual linking (Premiere shift+select > Link)', () => {
  function docWithTwoSolos() {
    const doc = createDoc() // [V1, A1]
    const videoAsset = avAsset({ hasAudio: false })
    const song = createMediaAsset({ kind: 'audio', name: 'song.mp3', duration: 6 })
    doc.media = [videoAsset, song]
    const next = applyCommands(doc, [
      ...commandsToAddMedia(doc, videoAsset, 0)!, // one clip on V1
      ...commandsToAddMedia(doc, song, 0)!, // one clip on A1
    ])
    return {
      doc: next,
      videoClip: next.project.tracks[0].clips[0],
      songClip: next.project.tracks[1].clips[0],
    }
  }

  it('commandsToLinkClips bonds two unlinked clips into ONE new group', () => {
    const { doc, videoClip, songClip } = docWithTwoSolos()
    expect(canLinkClips(doc, [videoClip.id, songClip.id])).toBe(true)
    expect(distinctLinkGroupCount(doc, [videoClip.id, songClip.id])).toBe(2)

    const commands = commandsToLinkClips(doc, [videoClip.id, songClip.id])
    expect(commands).toEqual([{ type: 'linkClips', clipIds: [videoClip.id, songClip.id] }])

    const next = applyCommands(doc, commands!)
    const v = clipById(next, videoClip.id)!.clip
    const s = clipById(next, songClip.id)!.clip
    expect(v.linkId).toBe(s.linkId)
    expect(linkedClips(next, videoClip.id)).toHaveLength(2)
  })

  it('linking a clip that already has a partner MERGES the whole group (partner stays bonded)', () => {
    const { doc, videoClip, songClip } = docWithTwoSolos()
    // Link video to its own audio twin first (three clips total).
    const song2 = createMediaAsset({ kind: 'audio', name: 'song2.mp3', duration: 6 })
    const withSong2 = applyCommands(doc, [
      { type: 'addMediaAsset', asset: song2 }, // register for clipFitsTrack
      ...commandsToAddMedia(doc, song2, 20)!,
    ])
    const song2Clip = withSong2.project.tracks[1].clips[1]

    // Pair videoClip+songClip, then link that pair with song2Clip:
    const step1 = applyCommands(
      withSong2,
      commandsToLinkClips(withSong2, [videoClip.id, songClip.id])!,
    )
    const mergedGroup = clipById(step1, videoClip.id)!.clip.linkId!
    const step2 = applyCommands(step1, commandsToLinkClips(step1, [videoClip.id, song2Clip.id])!)
    const v = clipById(step2, videoClip.id)!.clip
    const s = clipById(step2, songClip.id)!.clip
    const s2 = clipById(step2, song2Clip.id)!.clip
    expect(v.linkId).toBe(s.linkId)
    expect(v.linkId).toBe(s2.linkId)
    // The first bond id SURVIVES the merge (external partners never break).
    expect(v.linkId).toBe(mergedGroup)
  })

  it('link is rejected for <2 clips, unknown ids, text clips, or one shared group', () => {
    const { doc, videoClip, songClip } = docWithTwoSolos()
    expect(commandsToLinkClips(doc, [videoClip.id])).toBeNull()
    expect(commandsToLinkClips(doc, ['ghost', videoClip.id])).toBeNull()
    expect(canLinkClips(doc, [videoClip.id, 'ghost'])).toBe(false)
    // One intact pair cannot be "linked" again.
    const paired = applyCommands(doc, commandsToLinkClips(doc, [videoClip.id, songClip.id])!)
    expect(commandsToLinkClips(paired, [videoClip.id, songClip.id])).toBeNull()
  })

  it('linkClips command throws on text clips (no A/V semantics)', () => {
    const { doc, videoClip } = docWithTwoSolos()
    const text = createClip({ start: 0, duration: 2, text: 'hi' })
    const withText = applyCommands(doc, [
      { type: 'addTrack', kind: 'text', trackId: 'track_text_test' },
      { type: 'addClip', trackId: 'track_text_test', clip: text },
    ])
    expect(() =>
      applyCommand(withText, { type: 'linkClips', clipIds: [videoClip.id, text.id] }),
    ).toThrow(EditorCommandError)
  })

  it('unlinked-after-manual-link: unlink releases the whole merged group', () => {
    const { doc, videoClip, songClip } = docWithTwoSolos()
    const linked = applyCommands(doc, commandsToLinkClips(doc, [videoClip.id, songClip.id])!)
    const next = applyCommands(linked, commandsToUnlinkClips(linked, [videoClip.id])!)
    expect(clipById(next, videoClip.id)!.clip.linkId).toBeUndefined()
    expect(clipById(next, songClip.id)!.clip.linkId).toBeUndefined()
  })

  it('delete after manual link removes BOTH clips; ripple closes the gap', () => {
    const { doc, videoClip, songClip } = docWithTwoSolos()
    const linked = applyCommands(doc, commandsToLinkClips(doc, [videoClip.id, songClip.id])!)
    expect(applyCommands(linked, commandsToDeleteClips(linked, [videoClip.id]))).toMatchObject({
      project: { tracks: [{ clips: [] }, { clips: [] }] },
    })
  })
})

describe('ripple delete (Premiere Shift+Delete)', () => {
  it('deletes the clip and slides later same-track clips left', () => {
    const doc = createDoc()
    const asset = avAsset({ hasAudio: false })
    doc.media = [asset]
    const withClips = applyCommands(doc, [
      ...commandsToAddMedia(doc, asset, 0)!, // 0-10 on V1
      ...commandsToAddMedia(doc, asset, 12)!, // 12-22 on V1
    ])
    const first = withClips.project.tracks[0].clips[0]
    const second = withClips.project.tracks[0].clips[1]

    const commands = commandsToRippleDeleteClips(withClips, [first.id])
    expect(commands).not.toBeNull()
    const next = applyCommands(withClips, commands!)
    const moved = clipById(next, second.id)!.clip
    expect(moved.start).toBe(2) // 12 - 10s gap closed
    expect(clipById(next, first.id)).toBeUndefined()
  })

  it('ripple deletes a linked PAIR and closes gaps on BOTH tracks', () => {
    const doc = createDoc()
    const asset = avAsset()
    doc.media = [asset]
    const withPair = applyCommands(doc, commandsToAddMedia(doc, asset, 0)!)
    const pair2 = applyCommands(withPair, commandsToAddMedia(withPair, asset, 12)!)
    const v2 = pair2.project.tracks[0].clips[1]
    const a1 = pair2.project.tracks[1].clips[0]

    const commands = commandsToRippleDeleteClips(pair2, [a1.id]) // ripple the FIRST pair via its audio half
    const next = applyCommands(pair2, commands!)
    // Both members of pair 1 are gone; pair 2 slides left by the removed 10s
    // (its own 2s gap between 10s and 12s stays — ripple only closes what
    // the deleted clips occupied).
    expect(next.project.tracks[0].clips).toHaveLength(1)
    expect(next.project.tracks[1].clips).toHaveLength(1)
    expect(clipById(next, v2.id)!.clip.start).toBe(2)
  })

  it('returns null for an empty selection', () => {
    const doc = createDoc()
    expect(commandsToRippleDeleteClips(doc, [])).toBeNull()
  })
})

describe('clipFitsTrack — audioOnly occurrences of video assets', () => {
  it('the audio twin fits audio tracks; plain video material does not', () => {
    const doc = createDoc()
    const asset = avAsset()
    doc.media = [asset]
    const twin = createClip({ mediaId: asset.id, start: 0, duration: 5, audioOnly: true })
    const plain = createClip({ mediaId: asset.id, start: 0, duration: 5 })
    const audioTrack = doc.project.tracks[1]

    expect(clipFitsTrack(doc, twin, audioTrack)).toBe(true)
    expect(clipFitsTrack(doc, plain, audioTrack)).toBe(false)
    expect(clipFitsTrack(doc, plain, doc.project.tracks[0])).toBe(true)
    expect(clipFitsTrack(doc, twin, doc.project.tracks[0])).toBe(true)
  })
})
