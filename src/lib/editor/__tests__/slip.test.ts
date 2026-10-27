import { describe, expect, it } from 'vitest'

import { applyCommand, TrackLockedError } from '../commands'
import { createClip, createMediaAsset, createTrack, sourceTimeAt } from '../factories'
import { planSlip } from '../slip'
import type { Clip, Doc, MediaAsset, Track } from '../types'

/**
 * Slip (0.15.0): change only `inPoint`, never the timeline position or the
 * duration. The command layer writes the whole linked group that reads the
 * same source window, so a pair cannot land half-slipped.
 */

function project(tracks: Track[], media: MediaAsset[] = []): Doc {
  return {
    project: { tracks, id: 'p_slip', name: 'slip', width: 1920, height: 1080, fps: 30 },
    media,
  }
}

function asset(duration = 30): MediaAsset {
  return createMediaAsset({ id: 'mv', kind: 'video', name: 'demo.mp4', duration })
}

function clip(
  id: string,
  start: number,
  duration: number,
  inPoint: number,
  extra: Partial<Clip> = {},
): Clip {
  return createClip({ id, mediaId: 'mv', start, duration, inPoint, ...extra })
}

function oneClip(
  partial: Partial<Clip> = {},
  duration = 30,
): { doc: Doc; clip: Clip; track: Track } {
  const track = createTrack('video', 1, { id: 'v1' })
  const c = clip('c', 2, 4, 4, partial)
  track.clips = [c]
  return { doc: project([track], [asset(duration)]), clip: c, track }
}

describe('planSlip bounds', () => {
  it('moves the in point by the proposed source delta', () => {
    const { doc, clip: c } = oneClip()
    const plan = planSlip({ clip: c, assetDuration: 30, delta: 2 })
    expect(plan).toEqual({
      status: 'ok',
      inPoint: 6,
      delta: 2,
      commands: [{ type: 'setClipInPoint', clipId: 'c', inPoint: 6 }],
    })
  })

  it('clamps at the start and at the end of the source', () => {
    const { clip: c } = oneClip()
    expect(planSlip({ clip: c, assetDuration: 30, delta: -10 })).toMatchObject({
      status: 'ok',
      inPoint: 0,
      delta: -4,
    })
    expect(planSlip({ clip: c, assetDuration: 30, delta: 100 })).toMatchObject({
      status: 'ok',
      inPoint: 26,
      delta: 22,
    })
  })

  it('uses the source span (duration times speed), not timeline seconds', () => {
    const { clip: c } = oneClip({ duration: 2, speed: 2, inPoint: 4 })
    // Readable window 4..8, so the largest in point is 30 - 4 = 26.
    expect(planSlip({ clip: c, assetDuration: 30, delta: 100 })).toMatchObject({
      status: 'ok',
      inPoint: 26,
    })
  })

  it('returns noop for a zero delta and for a clamp that changes nothing', () => {
    const { clip: c } = oneClip({ inPoint: 0 })
    expect(planSlip({ clip: c, assetDuration: 30, delta: 0 })).toEqual({ status: 'noop' })
    expect(planSlip({ clip: c, assetDuration: 30, delta: -2 })).toEqual({ status: 'noop' })
  })

  it('keeps a reversed clip inside the same source window', () => {
    const { clip: c } = oneClip({ reverse: true })
    const plan = planSlip({ clip: c, assetDuration: 30, delta: 2 })
    expect(plan.status).toBe('ok')
    if (plan.status !== 'ok') return
    const doc = oneClip({ reverse: true }).doc
    const next = applyCommand(doc, plan.commands[0])
    const nextClip = next.project.tracks[0].clips[0]
    expect(nextClip.inPoint).toBe(6)
    // A reversed clip shows the HIGH source end at local 0.
    expect(sourceTimeAt(nextClip, 0)).toBeCloseTo(10, 6)
  })
})

describe('planSlip refusals', () => {
  it('refuses an image, a text clip, and a compound clip', () => {
    const { clip: c } = oneClip()
    expect(planSlip({ clip: c, assetDuration: undefined, delta: 1 }).status).toBe('refused')
    expect(planSlip({ clip: { ...c, text: 'hi' }, assetDuration: 30, delta: 1 }).status).toBe(
      'refused',
    )
    expect(planSlip({ clip: { ...c, sequenceId: 's1' }, assetDuration: 30, delta: 1 }).status).toBe(
      'refused',
    )
  })

  it('refuses a time-remapped clip', () => {
    const { clip: c } = oneClip({
      keyframes: {
        timeScale: [
          { time: 0, value: 1 },
          { time: 2, value: 2 },
        ],
      },
    })
    const plan = planSlip({ clip: c, assetDuration: 30, delta: 1 })
    expect(plan.status).toBe('refused')
    if (plan.status === 'refused') expect(plan.message).toMatch(/time-remapped/)
  })

  it('refuses a linked group whose members read different windows', () => {
    const { clip: c } = oneClip()
    const other = { ...c, id: 'other', duration: 3 }
    const plan = planSlip({ clip: c, group: [c, other], assetDuration: 30, delta: 1 })
    expect(plan.status).toBe('refused')
    if (plan.status === 'refused') expect(plan.message).toMatch(/desync/)
  })
})

describe('linked slip', () => {
  function pair(): { doc: Doc; video: Clip; audio: Clip } {
    const videoTrack = createTrack('video', 1, { id: 'v1' })
    const audioTrack = createTrack('audio', 1, { id: 'a1' })
    const video = clip('v', 2, 4, 4, { linkId: 'lnk' })
    const audio = createClip({
      id: 'a',
      mediaId: 'mv',
      audioOnly: true,
      linkId: 'lnk',
      start: 2,
      duration: 4,
      inPoint: 4,
    })
    videoTrack.clips = [video]
    audioTrack.clips = [audio]
    return { doc: project([videoTrack, audioTrack], [asset()]), video, audio }
  }

  it('shares the source delta with the linked half', () => {
    const { doc, video, audio } = pair()
    const plan = planSlip({ clip: video, group: [video, audio], assetDuration: 30, delta: 2 })
    expect(plan.status).toBe('ok')
    if (plan.status !== 'ok') return
    const next = applyCommand(doc, plan.commands[0])
    expect(next.project.tracks[0].clips[0].inPoint).toBe(6)
    expect(next.project.tracks[1].clips[0].inPoint).toBe(6)
    // Neither start nor duration moves.
    expect(next.project.tracks[0].clips[0]).toMatchObject({ start: 2, duration: 4 })
    expect(next.project.tracks[1].clips[0]).toMatchObject({ start: 2, duration: 4 })
  })

  it('refuses a mixed-asset linked group at the command layer', () => {
    const { doc, video, audio } = pair()
    // A hostile direct command cannot slip one half of a group whose windows
    // already disagree.
    doc.project.tracks[1].clips[0] = { ...audio, inPoint: 5 }
    expect(() =>
      applyCommand(doc, { type: 'setClipInPoint', clipId: video.id, inPoint: 6 }),
    ).toThrow(/desync/)
  })

  it('refuses the command when a linked member lane is locked', () => {
    const { doc, video } = pair()
    doc.project.tracks[1].locked = true
    expect(() =>
      applyCommand(doc, { type: 'setClipInPoint', clipId: video.id, inPoint: 6 }),
    ).toThrow(TrackLockedError)
  })
})

describe('the setClipInPoint command', () => {
  it('round-trips without touching start or duration', () => {
    const { doc } = oneClip()
    const next = applyCommand(doc, { type: 'setClipInPoint', clipId: 'c', inPoint: 9 })
    expect(next.project.tracks[0].clips[0]).toMatchObject({
      start: 2,
      duration: 4,
      inPoint: 9,
    })
  })

  it('refuses an out-of-bounds window and hostile values', () => {
    const { doc } = oneClip()
    expect(() => applyCommand(doc, { type: 'setClipInPoint', clipId: 'c', inPoint: 27 })).toThrow(
      /end of the source/,
    )
    expect(() => applyCommand(doc, { type: 'setClipInPoint', clipId: 'c', inPoint: -1 })).toThrow(
      /Invalid slip position/,
    )
    expect(() =>
      applyCommand(doc, { type: 'setClipInPoint', clipId: 'c', inPoint: Number.NaN }),
    ).toThrow(/Invalid slip position/)
  })

  it('refuses an image, text, compound, or missing-media clip', () => {
    const image = createMediaAsset({ id: 'mi', kind: 'image', name: 'still.png', duration: 5 })
    const track = createTrack('video', 1, { id: 'v1' })
    track.clips = [
      createClip({ id: 'img', mediaId: 'mi', start: 0, duration: 5 }),
      createClip({ id: 'txt', text: 'hi', start: 0, duration: 5 }),
      createClip({ id: 'comp', sequenceId: 's1', start: 0, duration: 5 }),
      createClip({ id: 'gone', mediaId: 'missing', start: 0, duration: 5 }),
    ]
    const doc = project([track], [image])
    for (const clipId of ['img', 'txt', 'comp', 'gone']) {
      expect(() => applyCommand(doc, { type: 'setClipInPoint', clipId, inPoint: 1 })).toThrow(
        /no source window/,
      )
    }
  })
})
