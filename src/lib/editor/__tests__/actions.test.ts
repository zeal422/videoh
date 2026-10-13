import { describe, expect, it } from 'vitest'

import {
  commandsToAddMarker,
  commandsToAddMedia,
  commandsToAddMediaInNewTrack,
  commandsToAddText,
  commandsToDeleteMarker,
  commandsToPlaceMedia,
  commandsToPlaceSource,
  trackKindForMedia,
} from '../actions'
import { applyCommand, applyCommands, type EditorCommand } from '../commands'
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
    const inside = commandsToAddMarker(doc, 4, ['c1'])!
    expect(inside[0].type).toBe('addClipMarker')
    if (inside[0].type === 'addClipMarker') expect(inside[0].marker.time).toBe(3)

    const before = commandsToAddMarker(doc, 0, ['c1'])!
    expect(before[0].type).toBe('addClipMarker')
    if (before[0].type === 'addClipMarker') expect(before[0].marker.time).toBe(1)

    const after = commandsToAddMarker(doc, 99, ['c1'])!
    expect(after[0].type).toBe('addClipMarker')
    if (after[0].type === 'addClipMarker') expect(after[0].marker.time).toBe(5)
  })

  it('falls back to a sequence marker (clamped at 0) without a live selection', () => {
    const { doc } = docWithClip()
    const noSelection = commandsToAddMarker(doc, 3, [])!
    expect(noSelection[0].type).toBe('addSequenceMarker')
    if (noSelection[0].type === 'addSequenceMarker') expect(noSelection[0].marker.time).toBe(3)

    const negative = commandsToAddMarker(doc, -5, [])!
    expect(negative[0].type).toBe('addSequenceMarker')
    if (negative[0].type === 'addSequenceMarker') expect(negative[0].marker.time).toBe(0)

    // Past the sequence end (clip 2..6): the playhead cannot seek there, so a
    // marker created there would be unreachable by Shift+M.
    const pastEnd = commandsToAddMarker(doc, 99, [])!
    expect(pastEnd[0].type).toBe('addSequenceMarker')
    if (pastEnd[0].type === 'addSequenceMarker') expect(pastEnd[0].marker.time).toBe(6)

    const stale = commandsToAddMarker(doc, 3, ['ghost'])!
    expect(stale[0].type).toBe('addSequenceMarker')
  })

  it('refuses a sequence marker inside a child sequence', () => {
    const { doc } = docWithClip()
    // A child sequence has no sequence-level markers of its own (0.8.1).
    expect(commandsToAddMarker(doc, 3, [], ['seq1'])).toBeNull()
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

/**
 * Insert/overwrite placement actions: the displacement planner is composed
 * with the actual placement into ONE batch, `place` mode stays the old path,
 * and a refusal returns null commands with its reason (the routes toast it).
 */
describe('commandsToPlaceMedia / commandsToPlaceSource', () => {
  function laneDoc(clips: { id: string; start: number; duration: number }[], assetDuration = 30) {
    const asset = createMediaAsset({ kind: 'video', name: 'a.mp4', duration: assetDuration })
    const track = createTrack('video', 1)
    track.clips = clips.map((c) =>
      createClip({ id: c.id, mediaId: asset.id, start: c.start, duration: c.duration }),
    )
    const doc = createDoc()
    doc.project.tracks = [track]
    doc.media = [asset]
    return { doc, asset, track }
  }

  function pairLaneDoc(assetDuration = 10) {
    const asset = createMediaAsset({
      kind: 'video',
      name: 'pair.mp4',
      duration: assetDuration,
      hasAudio: true,
    })
    const video = createTrack('video', 1)
    const audio = createTrack('audio', 1)
    const doc = createDoc()
    doc.project.tracks = [video, audio]
    doc.media = [asset]
    return { doc, asset, video, audio }
  }

  it('an insert lane drop shifts downstream clips, then places at the drop point', () => {
    const { doc, asset, track } = laneDoc([{ id: 'c1', start: 4, duration: 3 }], 3)
    const outcome = commandsToPlaceMedia(doc, asset, 1, 'insert', track.id)
    expect(outcome.refusal).toBeNull()
    const commands = outcome.commands!
    expect(commands[0]).toEqual({ type: 'moveClip', clipId: 'c1', trackId: track.id, start: 7 })
    expect(commands[1]).toMatchObject({ type: 'addClip', trackId: track.id })
    const next = applyCommands(doc, commands)
    expect(next.project.tracks[0].clips.map((c) => [c.id, c.start])).toEqual([
      [expect.any(String), 1],
      ['c1', 7],
    ])
  })

  it('an overwrite lane drop replaces the covered span before placing', () => {
    const { doc, asset, track } = laneDoc(
      [
        { id: 'c1', start: 0, duration: 2 },
        { id: 'c2', start: 6, duration: 2 },
      ],
      3,
    )
    const outcome = commandsToPlaceMedia(doc, asset, 1, 'overwrite', track.id)
    const commands = outcome.commands!
    expect(commands.map((c) => c.type)).toEqual(['trimClip', 'addClip'])
    // A 3s overwrite at 1s: c1's tail trims to 1s; c2 (6..8) is outside the window.
    const next = applyCommands(doc, commands)
    const c1 = next.project.tracks[0].clips.find((c) => c.id === 'c1')!
    expect(c1.start + c1.duration).toBeCloseTo(1, 6)
    expect(next.project.tracks[0].clips.find((c) => c.id === 'c2')).toBeTruthy()
  })

  it('place mode keeps the plain drop (command composition unchanged)', () => {
    const { doc, asset, track } = laneDoc([{ id: 'c1', start: 4, duration: 3 }])
    const outcome = commandsToPlaceMedia(doc, asset, 1, 'place', track.id)
    expect(outcome.refusal).toBeNull()
    // Each call mints its own clip id, so normalize before comparing the rest.
    const normalize = (commands: EditorCommand[] | null) =>
      (commands ?? []).map((c) =>
        c.type === 'addClip' ? { ...c, clip: { ...c.clip, id: 'x' } } : c,
      )
    expect(normalize(outcome.commands)).toEqual(
      normalize(commandsToAddMedia(doc, asset, 1, track.id)),
    )
  })

  it('resolves the lane through targeting when no lane is pointed', () => {
    const asset = createMediaAsset({ kind: 'video', name: 'a.mp4', duration: 4 })
    const untargeted = createTrack('video', 1)
    const targeted = createTrack('video', 1)
    const doc = createDoc()
    doc.project.tracks = [untargeted, targeted]
    doc.media = [asset]

    const outcome = commandsToPlaceSource(doc, asset, 0, 'insert', null, [untargeted.id])
    const placement = outcome.commands![outcome.commands!.length - 1]
    expect(placement).toMatchObject({ type: 'addClip', trackId: targeted.id })
  })

  it('an insert of a video-with-audio asset shifts the twin audio lane in the SAME batch', () => {
    const { doc, asset, video, audio } = pairLaneDoc(5)
    video.clips = [createClip({ id: 'v2', mediaId: asset.id, start: 4, duration: 2 })]
    audio.clips = [
      createClip({ id: 'a2', mediaId: asset.id, start: 4, duration: 2, audioOnly: true }),
    ]

    const outcome = commandsToPlaceMedia(doc, asset, 0, 'insert', video.id)
    const commands = outcome.commands!
    expect(commands.filter((c) => c.type === 'moveClip')).toEqual([
      { type: 'moveClip', clipId: 'v2', trackId: video.id, start: 9 },
      { type: 'moveClip', clipId: 'a2', trackId: audio.id, start: 9 },
    ])
    // One batch: both lanes shifted and the pair landed.
    const next = applyCommands(doc, commands)
    expect(next.project.tracks[0].clips.find((c) => c.id === 'v2')!.start).toBe(9)
    expect(next.project.tracks[1].clips.find((c) => c.id === 'a2')!.start).toBe(9)
    expect(next.project.tracks[0].clips.filter((c) => c.linkId)).toHaveLength(1)
  })

  it('places an A/V pair on both lanes with one shared linkId', () => {
    const { doc, asset, video, audio } = pairLaneDoc(5)
    const outcome = commandsToPlaceSource(doc, asset, 2, 'insert', null)
    const next = applyCommands(doc, outcome.commands!)
    const placedVideo = next.project.tracks[0].clips[0]
    const placedAudio = next.project.tracks[1].clips[0]
    expect(placedVideo.start).toBe(2)
    expect(placedAudio.audioOnly).toBe(true)
    expect(placedVideo.linkId).toBeTruthy()
    expect(placedAudio.linkId).toBe(placedVideo.linkId)
    expect(video.clips).toHaveLength(0) // input doc untouched
    expect(audio.clips).toHaveLength(0)
  })

  it('maps a source range onto a single placed clip (inPoint + duration)', () => {
    const { doc, asset } = laneDoc([], 20)
    const next = applyCommands(
      doc,
      commandsToPlaceSource(doc, asset, 1, 'insert', { inPoint: 2, outPoint: 5 }).commands!,
    )
    const placed = next.project.tracks[0].clips[0]
    expect(placed).toMatchObject({ start: 1, inPoint: 2, duration: 3 })
  })

  it('maps the SAME range onto both halves of a pair (equal spans, shared link)', () => {
    const { doc, asset } = pairLaneDoc(20)
    const next = applyCommands(
      doc,
      commandsToPlaceSource(doc, asset, 0, 'insert', { inPoint: 4, outPoint: 9 }).commands!,
    )
    const [video, audio] = [next.project.tracks[0].clips[0], next.project.tracks[1].clips[0]]
    expect(video).toMatchObject({ inPoint: 4, duration: 5 })
    expect(audio).toMatchObject({ inPoint: 4, duration: 5 })
    expect(audio.linkId).toBe(video.linkId)
  })

  it('a span inside the -EPS floor band is clamped up, so addClip never throws', () => {
    const { doc, asset } = laneDoc([], 20)
    const outcome = commandsToPlaceSource(doc, asset, 0, 'insert', {
      inPoint: 0,
      outPoint: 0.1 - 5e-7,
    })
    const next = applyCommands(doc, outcome.commands!)
    expect(next.project.tracks[0].clips[0].duration).toBeCloseTo(0.1, 6)
  })

  it('a sub-floor placement span refuses atomically in insert and overwrite', () => {
    const { doc, asset, track } = laneDoc([], 0.05)
    for (const mode of ['insert', 'overwrite'] as const) {
      const outcome = commandsToPlaceMedia(doc, asset, 0, mode, track.id)
      expect(outcome.commands).toBeNull()
      expect(outcome.refusal).toBe('span')
    }
    const source = commandsToPlaceSource(doc, asset, 0, 'insert', null)
    expect(source.commands).toBeNull()
    expect(source.refusal).toBe('span')
  })

  it('an incompatible pointed lane still relocates inside the ACTION (the drop route refuses first)', () => {
    // The wrong-kind refusal in insert/overwrite is a ROUTE decision: given an
    // explicit lane that does not fit, `commandsToPlaceMedia` resolves it
    // through the documented fallback instead of refusing. Pinned here so the
    // policy cannot move into (or out of) this function unnoticed; the route's
    // refusal itself is locked in timeline-panel-ui.test.tsx.
    const { doc, track } = laneDoc([], 5) // a video lane
    const audioTrack = createTrack('audio', 1)
    doc.project.tracks.push(audioTrack)
    const audioAsset = createMediaAsset({ kind: 'audio', name: 'a.wav', duration: 3 })
    doc.media.push(audioAsset)

    const outcome = commandsToPlaceMedia(doc, audioAsset, 1, 'insert', track.id)

    expect(outcome.refusal).toBeNull()
    const next = applyCommands(doc, outcome.commands!)
    expect(next.project.tracks[0].clips).toHaveLength(0) // pointed video lane stayed empty
    expect(next.project.tracks[1].clips).toHaveLength(1) // relocated onto the audio lane
  })

  it('an unrepresentable overwrite refuses the whole placement (nothing written)', () => {
    // The cut lands 0.05s into the clip: both sides are retained, but the left
    // side sits under the split headroom, so no representable edit exists.
    const media = createMediaAsset({ kind: 'video', name: 'm.mp4', duration: 10 })
    const track = createTrack('video', 1)
    track.clips = [createClip({ id: 'c1', mediaId: media.id, start: 0, duration: 4 })]
    const doc = createDoc()
    doc.project.tracks = [track]
    doc.media = [media]
    const incoming = createMediaAsset({ kind: 'video', name: 'b.mp4', duration: 3 })

    const outcome = commandsToPlaceMedia(doc, incoming, 0.05, 'overwrite', track.id)
    expect(outcome.commands).toBeNull()
    expect(outcome.refusal).toBe('geometry')
    // Nothing written: the input doc is untouched (the batch never exists).
    expect(doc.project.tracks[0].clips[0].duration).toBe(4)
  })
})
