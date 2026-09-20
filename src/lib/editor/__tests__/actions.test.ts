import { describe, expect, it } from 'vitest'

import { commandsToAddMediaInNewTrack, trackKindForMedia } from '../actions'
import { applyCommands } from '../commands'
import { createDoc, createMediaAsset } from '../factories'

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
