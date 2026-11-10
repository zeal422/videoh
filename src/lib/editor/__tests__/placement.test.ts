import { describe, expect, it } from 'vitest'

import { applyCommands } from '../commands'
import { createClip, createDoc, createMediaAsset, createTrack } from '../factories'
import { planMediaPlacement } from '../placement'
import { placementRefusalMessage } from '../sequence-ops'
import type { Doc, MediaAsset } from '../types'

/**
 * The shared placement planner (0.20.0): one batch for lane drops and
 * Source-monitor placements. These tests target the planner directly; the
 * public adapters in `actions.ts` keep their own behavior coverage there.
 */

function videoAsset(partial: Partial<MediaAsset> = {}): MediaAsset {
  return createMediaAsset({ kind: 'video', name: 'clip.mp4', duration: 4, ...partial })
}

function docWithLane(clips: { id: string; start: number; duration: number }[], duration = 30) {
  const asset = videoAsset({ duration })
  const track = createTrack('video', 1)
  track.clips = clips.map((c) =>
    createClip({ id: c.id, mediaId: asset.id, start: c.start, duration: c.duration }),
  )
  const doc = createDoc()
  doc.project.tracks = [track]
  doc.media = [asset]
  return { doc, asset, track }
}

describe('planMediaPlacement — displacement', () => {
  it('insert shifts downstream clips, then places at the drop point', () => {
    const { doc, asset, track } = docWithLane([{ id: 'c1', start: 4, duration: 3 }], 3)
    const outcome = planMediaPlacement(doc, asset, 1, 'insert', { trackId: track.id })

    expect(outcome.refusal).toBeNull()
    expect(outcome.commands![0]).toEqual({
      type: 'moveClip',
      clipId: 'c1',
      trackId: track.id,
      start: 7,
    })
    const next = applyCommands(doc, outcome.commands!)
    expect(next.project.tracks[0].clips.map((c) => [c.id, c.start])).toEqual([
      [expect.any(String), 1],
      ['c1', 7],
    ])
  })

  it('overwrite trims the covered span before placing', () => {
    const { doc, asset, track } = docWithLane(
      [
        { id: 'c1', start: 0, duration: 2 },
        { id: 'c2', start: 6, duration: 2 },
      ],
      3,
    )
    const outcome = planMediaPlacement(doc, asset, 1, 'overwrite', { trackId: track.id })

    expect(outcome.commands!.map((c) => c.type)).toEqual(['trimClip', 'addClip'])
    const next = applyCommands(doc, outcome.commands!)
    const c1 = next.project.tracks[0].clips.find((c) => c.id === 'c1')!
    expect(c1.start + c1.duration).toBeCloseTo(1, 6)
    expect(next.project.tracks[0].clips.find((c) => c.id === 'c2')).toBeTruthy()
  })
})

describe('planMediaPlacement — lane resolution', () => {
  it('uses the pointed lane when it fits, ignoring targeting', () => {
    const { doc, asset, track } = docWithLane([], 4)
    const untargeted = createTrack('video', 1)
    doc.project.tracks.unshift(untargeted)

    const outcome = planMediaPlacement(doc, asset, 0, 'insert', {
      trackId: track.id,
      untargetedTrackIds: [track.id],
    })
    const placement = outcome.commands!.at(-1)!
    expect(placement).toMatchObject({ type: 'addClip', trackId: track.id })
  })

  it('falls back to the first targeted compatible lane', () => {
    const asset = videoAsset({ duration: 4 })
    const untargeted = createTrack('video', 1)
    const targeted = createTrack('video', 1)
    const doc = createDoc()
    doc.project.tracks = [untargeted, targeted]
    doc.media = [asset]

    const outcome = planMediaPlacement(doc, asset, 0, 'insert', {
      untargetedTrackIds: [untargeted.id],
    })
    expect(outcome.commands!.at(-1)).toMatchObject({ type: 'addClip', trackId: targeted.id })
  })

  it('creates a new track first when no compatible lane exists', () => {
    const asset = videoAsset({ duration: 4 })
    const doc = createDoc()
    doc.project.tracks = [createTrack('audio', 1), createTrack('text', 1)]
    doc.media = [asset]

    const outcome = planMediaPlacement(doc, asset, 0, 'insert')
    const [first, second] = outcome.commands!
    expect(first).toMatchObject({ type: 'addTrack', kind: 'video' })
    expect(second).toMatchObject({
      type: 'addClip',
      trackId: (first as Extract<typeof first, { type: 'addTrack' }>).trackId,
    })
    const next = applyCommands(doc, outcome.commands!)
    const created = next.project.tracks.find(
      (t) => t.id === (first as Extract<typeof first, { type: 'addTrack' }>).trackId,
    )!
    expect(created.kind).toBe('video')
    expect(created.clips).toHaveLength(1)
  })

  it('resolves lanes inside the requested sequence only', () => {
    const asset = videoAsset({ duration: 4 })
    const rootTrack = createTrack('video', 1)
    const sequenceTrack = createTrack('video', 1)
    const doc = createDoc()
    doc.project.tracks = [rootTrack]
    doc.project.sequences = [{ id: 'seq1', name: 'S', tracks: [sequenceTrack] }]
    doc.media = [asset]

    const outcome = planMediaPlacement(doc, asset, 0, 'insert', { sequenceId: 'seq1' })
    expect(outcome.commands!.at(-1)).toMatchObject({
      type: 'addClip',
      trackId: sequenceTrack.id,
    })
    const next = applyCommands(doc, outcome.commands!)
    expect(next.project.tracks[0].clips).toHaveLength(0)
    expect(next.project.sequences![0].tracks[0].clips).toHaveLength(1)
  })
})

describe('planMediaPlacement — A/V pairs and source windows', () => {
  function pairDoc(assetDuration = 10) {
    const asset = videoAsset({ duration: assetDuration, hasAudio: true })
    const video = createTrack('video', 1)
    const audio = createTrack('audio', 1)
    const doc = createDoc()
    doc.project.tracks = [video, audio]
    doc.media = [asset]
    return { doc, asset, video, audio }
  }

  it('places a pair on both lanes with one shared linkId', () => {
    const { doc, asset, video, audio } = pairDoc(5)
    const outcome = planMediaPlacement(doc, asset, 2, 'insert')
    const next = applyCommands(doc, outcome.commands!)
    const placedVideo = next.project.tracks[0].clips[0]
    const placedAudio = next.project.tracks[1].clips[0]

    expect(placedVideo.start).toBe(2)
    expect(placedAudio.audioOnly).toBe(true)
    expect(placedVideo.linkId).toBeTruthy()
    expect(placedAudio.linkId).toBe(placedVideo.linkId)
    expect(video.clips).toHaveLength(0)
    expect(audio.clips).toHaveLength(0)
  })

  it('creates an audio twin lane when the doc has none', () => {
    const asset = videoAsset({ duration: 5, hasAudio: true })
    const video = createTrack('video', 1)
    const doc = createDoc()
    doc.project.tracks = [video]
    doc.media = [asset]

    const outcome = planMediaPlacement(doc, asset, 0, 'insert', { trackId: video.id })
    const trackAdds = outcome.commands!.filter((c) => c.type === 'addTrack')
    expect(trackAdds).toHaveLength(1)
    expect(trackAdds[0]).toMatchObject({ type: 'addTrack', kind: 'audio' })
    const next = applyCommands(doc, outcome.commands!)
    expect(next.project.tracks.map((t) => t.kind)).toEqual(['video', 'audio'])
  })

  it('maps one source range onto both pair halves (equal spans)', () => {
    const { doc, asset } = pairDoc(20)
    const outcome = planMediaPlacement(doc, asset, 0, 'insert', {
      range: { inPoint: 4, outPoint: 9 },
    })
    const next = applyCommands(doc, outcome.commands!)
    const [video, audio] = [next.project.tracks[0].clips[0], next.project.tracks[1].clips[0]]

    expect(video).toMatchObject({ inPoint: 4, duration: 5 })
    expect(audio).toMatchObject({ inPoint: 4, duration: 5 })
    expect(audio.linkId).toBe(video.linkId)
  })

  it('ignores a source range for images and uses the default duration', () => {
    const image = createMediaAsset({ kind: 'image', name: 'still.png', duration: 0 })
    const doc = createDoc()
    doc.media = [image]

    const outcome = planMediaPlacement(doc, image, 0, 'insert', {
      range: { inPoint: 1, outPoint: 99 },
    })
    const next = applyCommands(doc, outcome.commands!)
    expect(next.project.tracks[0].clips[0]).toMatchObject({ inPoint: 0, duration: 4 })
  })

  it('clamps finite source ranges into the asset before computing the span', () => {
    const asset = videoAsset({ duration: 20 })
    const cases = [
      { range: { inPoint: -2, outPoint: 9 }, placed: { inPoint: 0, duration: 9 }, tailStart: 19 },
      { range: { inPoint: 4, outPoint: 25 }, placed: { inPoint: 4, duration: 16 }, tailStart: 26 },
    ]
    for (const c of cases) {
      const track = createTrack('video', 1)
      track.clips = [createClip({ id: 'tail', mediaId: asset.id, start: 10, duration: 2 })]
      const doc = createDoc()
      doc.project.tracks = [track]
      doc.media = [asset]
      const outcome = planMediaPlacement(doc, asset, 0, 'insert', {
        trackId: track.id,
        range: c.range,
      })
      const next = applyCommands(doc, outcome.commands!)
      const placed = next.project.tracks[0].clips.find((clip) => clip.id !== 'tail')!
      expect(placed).toMatchObject(c.placed)
      expect(placed.inPoint + placed.duration).toBeLessThanOrEqual(asset.duration)
      expect(next.project.tracks[0].clips.find((clip) => clip.id === 'tail')!.start).toBe(
        c.tailStart,
      )
    }
  })
})

describe('planMediaPlacement — refusals', () => {
  it('refuses an unrepresentable span before building a batch', () => {
    const { doc, asset, track } = docWithLane([], 0.05)
    const outcome = planMediaPlacement(doc, asset, 0, 'insert', { trackId: track.id })
    expect(outcome).toEqual({ commands: null, refusal: 'span' })
    expect(doc.project.tracks[0].clips).toHaveLength(0)
  })

  it('refuses hostile source ranges without writing', () => {
    const { doc, asset } = docWithLane([{ id: 'c1', start: 2, duration: 2 }], 10)
    const before = structuredClone(doc.project.tracks[0].clips)
    for (const range of [
      { inPoint: 5, outPoint: 5 },
      { inPoint: 6, outPoint: 2 },
      { inPoint: Number.NaN, outPoint: 4 },
      { inPoint: 0, outPoint: Number.POSITIVE_INFINITY },
    ]) {
      expect(planMediaPlacement(doc, asset, 0, 'insert', { range }).refusal).toBe('span')
    }
    expect(doc.project.tracks[0].clips).toEqual(before)
  })

  it('refuses a non-finite start instead of returning a batch that lands at 0', () => {
    const { doc, asset, track } = docWithLane([], 10)
    for (const mode of ['insert', 'overwrite'] as const) {
      expect(planMediaPlacement(doc, asset, Number.NaN, mode, { trackId: track.id })).toEqual({
        commands: null,
        refusal: 'time',
      })
    }
    expect(placementRefusalMessage('time')).toBe('Placement time is invalid')
  })

  it('refuses an unrepresentable overwrite atomically', () => {
    const media = videoAsset({ duration: 10 })
    const track = createTrack('video', 1)
    track.clips = [createClip({ id: 'c1', mediaId: media.id, start: 0, duration: 4 })]
    const doc = createDoc()
    doc.project.tracks = [track]
    doc.media = [media]
    const incoming = videoAsset({ name: 'b.mp4', duration: 3 })

    const outcome = planMediaPlacement(doc, incoming, 0.05, 'overwrite', { trackId: track.id })
    expect(outcome).toEqual({ commands: null, refusal: 'geometry' })
    expect(track.clips[0].duration).toBe(4)
  })
})
