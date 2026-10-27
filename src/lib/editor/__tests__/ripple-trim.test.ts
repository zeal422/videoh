import { describe, expect, it } from 'vitest'

import { applyCommands } from '../commands'
import { createClip, createMediaAsset, createTrack } from '../factories'
import { planRippleShift, planRippleTrim, type RippleTrimPlan } from '../ripple-trim'
import type { Clip, Doc, MediaAsset, Track } from '../types'

/**
 * Ripple Trim (0.15.0): one track, one shared end delta.
 *
 * The planner owns the risky rules: the start stays anchored, later clips move
 * by the delta the command ACTUALLY wrote, an existing transition overlap is
 * preserved, any other overlap refuses, and a left shift that would cross 0
 * refuses instead of clamping. These tests apply the returned batch, so a
 * command-layer refusal cannot hide behind a green planner assertion.
 */

function project(tracks: Track[], media: MediaAsset[] = []): Doc {
  return {
    project: { tracks, id: 'p_ripple', name: 'ripple', width: 1920, height: 1080, fps: 30 },
    media,
  }
}

function videoAsset(duration = 30, id = 'mv'): MediaAsset {
  return createMediaAsset({ id, kind: 'video', name: 'demo.mp4', duration })
}

function clip(id: string, start: number, duration: number, extra: Partial<Clip> = {}): Clip {
  return createClip({ id, mediaId: 'mv', start, duration, inPoint: 0, ...extra })
}

function threeClips(): { doc: Doc; track: Track; a: Clip; b: Clip; c: Clip } {
  const track = createTrack('video', 1, { id: 'v1' })
  const a = clip('a', 0, 2)
  const b = clip('b', 3, 2)
  const c = clip('c', 6, 2)
  track.clips = [a, b, c]
  return { doc: project([track], [videoAsset()]), track, a, b, c }
}

function applied(doc: Doc, plan: RippleTrimPlan): Doc {
  if (plan.status !== 'ok') throw new Error(`expected ok, got ${plan.status}`)
  return applyCommands(doc, plan.commands)
}

function trackIn(doc: Doc, id = 'v1'): Track {
  const track = doc.project.tracks.find((candidate) => candidate.id === id)
  if (!track) throw new Error('track not found')
  return track
}

function clipIn(doc: Doc, id: string): Clip {
  for (const track of doc.project.tracks) {
    const found = track.clips.find((candidate) => candidate.id === id)
    if (found) return found
  }
  throw new Error(`clip ${id} not found`)
}

describe('planRippleTrim results', () => {
  it('returns noop when the proposal leaves the clip unchanged', () => {
    const { doc, a } = threeClips()
    const plan = planRippleTrim({
      doc,
      clipId: a.id,
      edge: 'tail',
      proposal: { start: a.start, inPoint: a.inPoint, duration: a.duration },
    })
    expect(plan).toEqual({ status: 'noop' })
  })

  it('never mutates the input doc', () => {
    const { doc, a } = threeClips()
    const before = structuredClone(doc)
    planRippleTrim({
      doc,
      clipId: a.id,
      edge: 'tail',
      proposal: { start: a.start, inPoint: a.inPoint, duration: 3 },
    })
    expect(doc).toEqual(before)
  })

  it('refuses an unknown clip and a locked lane', () => {
    const { doc, a } = threeClips()
    expect(
      planRippleTrim({
        doc,
        clipId: 'nope',
        edge: 'tail',
        proposal: { start: 0, inPoint: 0, duration: 1 },
      }),
    ).toEqual({
      status: 'refused',
      message: 'Unknown clip',
    })
    trackIn(doc).locked = true
    const plan = planRippleTrim({
      doc,
      clipId: a.id,
      edge: 'tail',
      proposal: { start: a.start, inPoint: a.inPoint, duration: 3 },
    })
    expect(plan.status).toBe('refused')
    if (plan.status === 'refused') expect(plan.message).toMatch(/locked/)
  })
})

describe('tail ripple', () => {
  it('extends the clip and shifts every later clip by the end delta', () => {
    const { doc, a, b, c } = threeClips()
    const plan = planRippleTrim({
      doc,
      clipId: a.id,
      edge: 'tail',
      proposal: { start: a.start, inPoint: a.inPoint, duration: 3 },
    })
    expect(plan.status).toBe('ok')
    if (plan.status !== 'ok') return
    expect(plan.endDelta).toBe(1)
    expect(plan.commands).toHaveLength(3)
    const next = applied(doc, plan)
    expect(clipIn(next, 'a')).toMatchObject({ start: 0, duration: 3, inPoint: 0 })
    expect(clipIn(next, 'b').start).toBe(4)
    expect(clipIn(next, 'c').start).toBe(7)
  })

  it('shrinks the clip and pulls every later clip left by the same delta', () => {
    const { doc, a, b, c } = threeClips()
    const plan = planRippleTrim({
      doc,
      clipId: a.id,
      edge: 'tail',
      proposal: { start: a.start, inPoint: a.inPoint, duration: 1.5 },
    })
    expect(plan.status).toBe('ok')
    if (plan.status !== 'ok') return
    expect(plan.endDelta).toBe(-0.5)
    const next = applied(doc, plan)
    expect(clipIn(next, 'a').duration).toBe(1.5)
    expect(clipIn(next, 'b').start).toBe(2.5)
    expect(clipIn(next, 'c').start).toBe(5.5)
  })

  it('keeps a transition overlap and its span unchanged', () => {
    const track = createTrack('video', 1, { id: 'v1' })
    const a = clip('a', 0, 2, { transitionOut: { type: 'crossfade', duration: 1 } })
    const b = clip('b', 1, 2)
    track.clips = [a, b]
    const doc = project([track], [videoAsset()])
    const plan = planRippleTrim({
      doc,
      clipId: a.id,
      edge: 'tail',
      proposal: { start: a.start, inPoint: a.inPoint, duration: 3 },
    })
    expect(plan.status).toBe('ok')
    if (plan.status !== 'ok') return
    const next = applied(doc, plan)
    const nextA = clipIn(next, 'a')
    const nextB = clipIn(next, 'b')
    expect(nextA.duration).toBe(3)
    expect(nextB.start).toBe(2)
    expect(nextA.start + nextA.duration - nextB.start).toBe(1)
    expect(nextA.transitionOut?.duration).toBe(1)
  })

  it('refuses an overlap that no transition explains', () => {
    const track = createTrack('video', 1, { id: 'v1' })
    track.clips = [clip('a', 0, 2), clip('b', 1.5, 2)]
    const doc = project([track], [videoAsset()])
    const plan = planRippleTrim({
      doc,
      clipId: 'a',
      edge: 'tail',
      proposal: { start: 0, inPoint: 0, duration: 3 },
    })
    expect(plan.status).toBe('refused')
    if (plan.status === 'refused') expect(plan.message).toContain('overlap')
  })

  it('refuses a left shift that would cross 0 instead of clamping it', () => {
    // A transition-backed overlap lets the later clip start before the edited
    // clip's end; a shrink larger than that start then crosses 0.
    const track = createTrack('video', 1, { id: 'v1' })
    const a = clip('a', 0, 2, { transitionOut: { type: 'crossfade', duration: 1 } })
    const b = clip('b', 1, 2)
    track.clips = [a, b]
    const doc = project([track], [videoAsset()])
    const plan = planRippleShift({ doc, clipId: 'a', endDelta: -2 })
    expect(plan).toEqual({
      status: 'refused',
      message: 'The trim would move a later clip before the start of the timeline',
    })
  })

  it('refuses when a later clip carries a locked link partner', () => {
    const video = createTrack('video', 1, { id: 'v1' })
    const audio = createTrack('audio', 1, { id: 'a1', locked: true })
    const a = clip('a', 0, 2)
    const b = clip('b', 3, 2, { linkId: 'lnk' })
    const bAudio = createClip({
      id: 'ba',
      mediaId: 'mv',
      audioOnly: true,
      linkId: 'lnk',
      start: 3,
      duration: 2,
      inPoint: 0,
    })
    video.clips = [a, b]
    audio.clips = [bAudio]
    const doc = project([video, audio], [videoAsset()])
    const plan = planRippleTrim({
      doc,
      clipId: 'a',
      edge: 'tail',
      proposal: { start: 0, inPoint: 0, duration: 3 },
    })
    expect(plan.status).toBe('refused')
    if (plan.status === 'refused') expect(plan.message).toMatch(/locked/)
  })
})

describe('head ripple', () => {
  it('keeps the start anchored and advances the in point while shrinking', () => {
    const track = createTrack('video', 1, { id: 'v1' })
    const a = clip('a', 2, 4, { inPoint: 2 })
    const b = clip('b', 6, 2)
    track.clips = [a, b]
    const doc = project([track], [videoAsset()])
    const plan = planRippleTrim({
      doc,
      clipId: 'a',
      edge: 'head',
      proposal: { start: 3, inPoint: 3, duration: 3 },
    })
    expect(plan.status).toBe('ok')
    if (plan.status !== 'ok') return
    expect(plan.endDelta).toBe(-1)
    const next = applied(doc, plan)
    expect(clipIn(next, 'a')).toMatchObject({ start: 2, inPoint: 3, duration: 3 })
    expect(clipIn(next, 'b').start).toBe(5)
  })

  it('extends the head source and pushes later clips right', () => {
    const track = createTrack('video', 1, { id: 'v1' })
    const a = clip('a', 2, 4, { inPoint: 2 })
    const b = clip('b', 6, 2)
    track.clips = [a, b]
    const doc = project([track], [videoAsset()])
    const plan = planRippleTrim({
      doc,
      clipId: 'a',
      edge: 'head',
      proposal: { start: 1, inPoint: 1, duration: 5 },
    })
    expect(plan.status).toBe('ok')
    if (plan.status !== 'ok') return
    expect(plan.endDelta).toBe(1)
    const next = applied(doc, plan)
    expect(clipIn(next, 'a')).toMatchObject({ start: 2, inPoint: 1, duration: 5 })
    expect(clipIn(next, 'b').start).toBe(7)
  })

  it('scales the in-point delta by speed, not by timeline seconds', () => {
    // Regression for the command gate: a start-anchored head trim used to have
    // its provided inPoint overwritten by the constant-rate rebase, because
    // that rebase assumed `start` carried the head move.
    const track = createTrack('video', 1, { id: 'v1' })
    const a = clip('a', 2, 4, { inPoint: 4, speed: 2 })
    const b = clip('b', 6, 2)
    track.clips = [a, b]
    const doc = project([track], [videoAsset()])
    const plan = planRippleTrim({
      doc,
      clipId: 'a',
      edge: 'head',
      proposal: { start: 3, inPoint: 5, duration: 3 },
    })
    expect(plan.status).toBe('ok')
    if (plan.status !== 'ok') return
    const next = applied(doc, plan)
    expect(clipIn(next, 'a')).toMatchObject({ start: 2, inPoint: 6, duration: 3, speed: 2 })
  })

  it('handles a reversed head without moving the low source anchor', () => {
    const track = createTrack('video', 1, { id: 'v1' })
    const a = clip('a', 2, 4, { inPoint: 4, reverse: true })
    const b = clip('b', 6, 2)
    track.clips = [a, b]
    const doc = project([track], [videoAsset()])
    const plan = planRippleTrim({
      doc,
      clipId: 'a',
      edge: 'head',
      proposal: { start: 3, inPoint: 5, duration: 3 },
    })
    expect(plan.status).toBe('ok')
    if (plan.status !== 'ok') return
    const next = applied(doc, plan)
    expect(clipIn(next, 'a')).toMatchObject({ start: 2, inPoint: 4, duration: 3, reverse: true })
    expect(clipIn(next, 'b').start).toBe(5)
  })

  it('handles a reversed tail by moving the low anchor and the end delta', () => {
    const track = createTrack('video', 1, { id: 'v1' })
    const a = clip('a', 2, 4, { inPoint: 4, reverse: true })
    const b = clip('b', 6, 2)
    track.clips = [a, b]
    const doc = project([track], [videoAsset()])
    const plan = planRippleTrim({
      doc,
      clipId: 'a',
      edge: 'tail',
      proposal: { start: 2, inPoint: 4, duration: 3 },
    })
    expect(plan.status).toBe('ok')
    if (plan.status !== 'ok') return
    const next = applied(doc, plan)
    expect(clipIn(next, 'a')).toMatchObject({ start: 2, inPoint: 5, duration: 3, reverse: true })
    expect(clipIn(next, 'b').start).toBe(5)
  })

  it('preserves markers, keyframes, and link ids through the trim', () => {
    const track = createTrack('video', 1, { id: 'v1' })
    const a = clip('a', 2, 4, {
      inPoint: 2,
      linkId: 'lnk',
      markers: [{ id: 'm1', time: 2.5 }],
      keyframes: { volume: [{ time: 1, value: 0.5 }] },
    })
    track.clips = [a]
    const doc = project([track], [videoAsset()])
    const plan = planRippleTrim({
      doc,
      clipId: 'a',
      edge: 'head',
      proposal: { start: 3, inPoint: 3, duration: 3 },
    })
    expect(plan.status).toBe('ok')
    if (plan.status !== 'ok') return
    const next = clipIn(applied(doc, plan), 'a')
    expect(next.linkId).toBe('lnk')
    expect(next.markers).toEqual([{ id: 'm1', time: 2.5 }])
    // A forward constant-rate head trim anchors the source window, so volume
    // keyframes keep their local offsets.
    expect(next.keyframes?.volume).toEqual([{ time: 1, value: 0.5 }])
  })

  it('follows a time-remap curve through the command rebase', () => {
    const track = createTrack('video', 1, { id: 'v1' })
    const a = clip('a', 2, 4, {
      inPoint: 2,
      keyframes: {
        timeScale: [
          { time: 0, value: 1 },
          { time: 4, value: 2 },
        ],
      },
    })
    const b = clip('b', 6, 2)
    track.clips = [a, b]
    const doc = project([track], [videoAsset()])
    const plan = planRippleTrim({
      doc,
      clipId: 'a',
      edge: 'head',
      proposal: { start: 3, inPoint: 3, duration: 3 },
    })
    expect(plan.status).toBe('ok')
    if (plan.status !== 'ok') return
    const next = applied(doc, plan)
    const nextA = clipIn(next, 'a')
    expect(nextA.start).toBe(2)
    expect(nextA.duration).toBe(3)
    // The shift follows the actual end, not the raw proposal.
    expect(clipIn(next, 'b').start).toBe(5)
    expect(nextA.keyframes?.timeScale?.length).toBeGreaterThan(0)
  })
})

describe('the same-track link exception', () => {
  it('shifts only the edited track and leaves linked partners elsewhere put', () => {
    const video = createTrack('video', 1, { id: 'v1' })
    const audio = createTrack('audio', 1, { id: 'a1' })
    const a = clip('a', 0, 2, { linkId: 'lnkA' })
    const b = clip('b', 3, 2, { linkId: 'lnkB' })
    const bAudio = createClip({
      id: 'ba',
      mediaId: 'mv',
      audioOnly: true,
      linkId: 'lnkB',
      start: 3,
      duration: 2,
      inPoint: 0,
    })
    video.clips = [a, b]
    audio.clips = [bAudio]
    const doc = project([video, audio], [videoAsset()])
    const plan = planRippleTrim({
      doc,
      clipId: 'a',
      edge: 'tail',
      proposal: { start: 0, inPoint: 0, duration: 3 },
    })
    expect(plan.status).toBe('ok')
    if (plan.status !== 'ok') return
    const next = applied(doc, plan)
    expect(clipIn(next, 'b').start).toBe(4)
    expect(clipIn(next, 'ba').start).toBe(3)
    expect(clipIn(next, 'b').linkId).toBe('lnkB')
    expect(clipIn(next, 'ba').linkId).toBe('lnkB')
    // The halves now disagree on start. This is the recorded 0.15.0
    // exception, asserted so it cannot be mistaken for link-group sync.
    expect(clipIn(next, 'b').start).not.toBe(clipIn(next, 'ba').start)
  })
})
