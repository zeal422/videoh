import { describe, expect, it } from 'vitest'

import {
  commandsToAddMarker,
  commandsToAddMedia,
  commandsToAddMediaInNewTrack,
  commandsToAddText,
  commandsToDeleteMarker,
  trackKindForMedia,
} from '../actions'
import { applyCommand, applyCommands } from '../commands'
import { commandsToDuplicateClips } from '../actions'
import { createClip, createDoc, createMediaAsset, createTrack } from '../factories'

/**
 * commandsToAddMediaInNewTrack powers the timeline's drop-between-tracks
 * affordance: media dropped on a row edge (or below the last row) must create
 * a track at that EXACT z-position and place the clip on it — one undoable
 * command batch, input doc never mutated.
 */
describe('commandsToAddMediaInNewTrack', () => {
  it('creates a video track at the exact index and places the clip on it', () => {
    const doc = createDoc() // [V1, A1]
    const asset = createMediaAsset({ kind: 'video', name: 'b.mp4', duration: 5 })
    doc.media = [asset]
    const commands = commandsToAddMediaInNewTrack(doc, asset, 2, 1)

    expect(commands).toHaveLength(2)
    expect(commands[0]).toMatchObject({ type: 'addTrack', kind: 'video', atIndex: 1 })

    const next = applyCommands(doc, commands)
    expect(next.project.tracks.map((t) => t.kind)).toEqual(['video', 'video', 'audio'])
    const created = next.project.tracks[1]
    expect(created.clips).toHaveLength(1)
    expect(created.clips[0]).toMatchObject({ mediaId: asset.id, start: 2, duration: 5 })
    // untouched original
    expect(doc.project.tracks).toHaveLength(2)
  })

  it('inserts at the very top (atIndex 0) and at the bottom (atIndex = length)', () => {
    const doc = createDoc()
    const asset = createMediaAsset({ kind: 'video', duration: 3 })
    doc.media = [asset]

    const onTop = applyCommands(doc, commandsToAddMediaInNewTrack(doc, asset, 0, 0))
    expect(onTop.project.tracks[0].kind).toBe('video')
    expect(onTop.project.tracks.map((t) => t.name)).toEqual(['V2', 'V1', 'A1'])

    const atBottom = applyCommands(doc, commandsToAddMediaInNewTrack(doc, asset, 0, 2))
    expect(atBottom.project.tracks[atBottom.project.tracks.length - 1].kind).toBe('video')
  })

  it('audio media creates an audio track; image media a video track', () => {
    const doc = createDoc()
    const song = createMediaAsset({ kind: 'audio', duration: 20 })
    const poster = createMediaAsset({ kind: 'image', duration: 0 })
    doc.media = [song, poster]

    const withSong = applyCommands(doc, commandsToAddMediaInNewTrack(doc, song, 0, 1))
    expect(withSong.project.tracks[1].kind).toBe('audio')
    expect(withSong.project.tracks[1].clips[0].duration).toBe(20)

    const withPoster = applyCommands(withSong, commandsToAddMediaInNewTrack(withSong, poster, 0, 0))
    expect(withPoster.project.tracks[0].kind).toBe('video')
    expect(withPoster.project.tracks[0].clips[0].mediaId).toBe(poster.id)
    // image default duration applies
    expect(withPoster.project.tracks[0].clips[0].duration).toBe(4)
  })

  it('audio between two video tracks is honored verbatim (explicit intent wins)', () => {
    // The convention sort (text→video→audio) must NOT run for explicit placement.
    const doc = createDoc() // [V1, A1]
    const song = createMediaAsset({ kind: 'audio', duration: 10 })
    doc.media = [song]
    const next = applyCommands(doc, commandsToAddMediaInNewTrack(doc, song, 0, 1))
    expect(next.project.tracks.map((t) => t.kind)).toEqual(['video', 'audio', 'audio'])
  })
})

describe('trackKindForMedia', () => {
  it('maps media kinds to host track kinds', () => {
    expect(trackKindForMedia('video')).toBe('video')
    expect(trackKindForMedia('image')).toBe('video')
    expect(trackKindForMedia('audio')).toBe('audio')
  })
})

/**
 * Marker actions: commandsToAddMarker resolves clip-vs-sequence and clamps the
 * playhead into the clip's visible span; commandsToDeleteMarker builds the
 * matching delete, or null once the marker no longer exists.
 */
describe('commandsToAddMarker / commandsToDeleteMarker', () => {
  function docWithClip() {
    const doc = createDoc()
    const asset = createMediaAsset({ kind: 'video', name: 'a.mp4', duration: 30 })
    const track = doc.project.tracks.find((t) => t.kind === 'video')!
    track.clips = [createClip({ id: 'c1', mediaId: asset.id, start: 2, duration: 4, inPoint: 1 })]
    doc.media = [asset]
    return { doc }
  }

  it('targets the primary selected clip with a clamped source time', () => {
    const { doc } = docWithClip()
    const inside = commandsToAddMarker(doc, 4, ['c1'])
    expect(inside[0].type).toBe('addClipMarker')
    if (inside[0].type === 'addClipMarker') expect(inside[0].marker.time).toBe(3)

    const before = commandsToAddMarker(doc, 0, ['c1'])
    expect(before[0].type).toBe('addClipMarker')
    if (before[0].type === 'addClipMarker') expect(before[0].marker.time).toBe(1)

    const after = commandsToAddMarker(doc, 99, ['c1'])
    expect(after[0].type).toBe('addClipMarker')
    if (after[0].type === 'addClipMarker') expect(after[0].marker.time).toBe(5)
  })

  it('falls back to a sequence marker (clamped at 0) without a live selection', () => {
    const { doc } = docWithClip()
    const noSelection = commandsToAddMarker(doc, 3, [])
    expect(noSelection[0].type).toBe('addSequenceMarker')
    if (noSelection[0].type === 'addSequenceMarker') expect(noSelection[0].marker.time).toBe(3)

    const negative = commandsToAddMarker(doc, -5, [])
    expect(negative[0].type).toBe('addSequenceMarker')
    if (negative[0].type === 'addSequenceMarker') expect(negative[0].marker.time).toBe(0)

    // Past the sequence end (clip 2..6): the playhead cannot seek there, so a
    // marker created there would be unreachable by Shift+M.
    const pastEnd = commandsToAddMarker(doc, 99, [])
    expect(pastEnd[0].type).toBe('addSequenceMarker')
    if (pastEnd[0].type === 'addSequenceMarker') expect(pastEnd[0].marker.time).toBe(6)

    const stale = commandsToAddMarker(doc, 3, ['ghost'])
    expect(stale[0].type).toBe('addSequenceMarker')
  })

  it('builds the matching delete, or null when the marker no longer exists', () => {
    const { doc } = docWithClip()
    const withMarkers = applyCommands(doc, [
      { type: 'addSequenceMarker', marker: { id: 'm_seq', time: 1 } },
      { type: 'addClipMarker', clipId: 'c1', marker: { id: 'm_clip', time: 3 } },
    ])
    expect(commandsToDeleteMarker(withMarkers, { scope: 'sequence', markerId: 'm_seq' })).toEqual([
      { type: 'deleteSequenceMarker', markerId: 'm_seq' },
    ])
    expect(
      commandsToDeleteMarker(withMarkers, { scope: 'clip', clipId: 'c1', markerId: 'm_clip' }),
    ).toEqual([{ type: 'deleteClipMarker', clipId: 'c1', markerId: 'm_clip' }])
    expect(commandsToDeleteMarker(withMarkers, { scope: 'sequence', markerId: 'gone' })).toBeNull()
    expect(
      commandsToDeleteMarker(withMarkers, { scope: 'clip', clipId: 'c1', markerId: 'gone' }),
    ).toBeNull()
  })

  it('duplicating a clip gives its markers FRESH ids', () => {
    const { doc } = docWithClip()
    const withMarkers = applyCommand(doc, {
      type: 'addClipMarker',
      clipId: 'c1',
      marker: { id: 'cm1', time: 3 },
    })
    const commands = commandsToDuplicateClips(withMarkers, ['c1'])
    expect(commands).not.toBeNull()
    if (!commands) return
    const next = applyCommands(withMarkers, commands)
    const video = next.project.tracks.find((t) => t.kind === 'video')!
    const [original, duplicate] = video.clips
    // The duplicate carries the marker, but not the ORIGINAL's id: the two
    // clips coexist, and shared ids would make a delete/edit on one leave the
    // twin behind while snap exclusion matches by id alone.
    expect(duplicate.markers).toHaveLength(1)
    expect(duplicate.markers![0].id).not.toBe('cm1')
    expect(original.markers!.map((m) => m.id)).toEqual(['cm1'])
  })
})

describe('targeting in lane-less placements', () => {
  function avAsset() {
    return createMediaAsset({ kind: 'video', name: 't.mp4', duration: 5, hasAudio: true })
  }

  it('add text lands on the targeted text lane', () => {
    const doc = createDoc()
    const first = createTrack('text', 1)
    const second = createTrack('text', 1)
    doc.project.tracks = [first, second]

    const next = applyCommands(doc, commandsToAddText(doc, 0, [first.id]))
    expect(next.project.tracks[0].clips).toHaveLength(0)
    expect(next.project.tracks[1].clips).toHaveLength(1)
  })

  it('add text with every text lane targeted keeps the legacy first lane', () => {
    const doc = createDoc()
    const first = createTrack('text', 1)
    const second = createTrack('text', 1)
    doc.project.tracks = [first, second]

    const next = applyCommands(doc, commandsToAddText(doc, 0))
    expect(next.project.tracks[0].clips).toHaveLength(1)
  })

  it('a drop into a new track routes only the audio twin through targeting', () => {
    const asset = avAsset()
    const video = createTrack('video', 1)
    const audio1 = createTrack('audio', 1)
    const audio2 = createTrack('audio', 1)
    const doc = createDoc()
    doc.project.tracks = [video, audio1, audio2]
    doc.media = [asset]

    const next = applyCommands(doc, commandsToAddMediaInNewTrack(doc, asset, 0, 0, [audio1.id]))
    expect(next.project.tracks[0].kind).toBe('video')
    expect(next.project.tracks[0].clips[0].audioOnly).toBeUndefined()
    expect(next.project.tracks[2].clips).toHaveLength(0)
    expect(next.project.tracks[3].clips[0].audioOnly).toBe(true)
  })

  it('an explicitly pointed, fitting lane wins even while untargeted', () => {
    const asset = avAsset()
    const video = createTrack('video', 1)
    const audio = createTrack('audio', 1)
    const doc = createDoc()
    doc.project.tracks = [video, audio]
    doc.media = [asset]

    const commands = commandsToAddMedia(doc, asset, 0, video.id, [video.id])!
    const next = applyCommands(doc, commands)
    expect(next.project.tracks[0].clips[0].audioOnly).toBeUndefined()
    expect(next.project.tracks[1].clips[0].audioOnly).toBe(true)
  })
})
