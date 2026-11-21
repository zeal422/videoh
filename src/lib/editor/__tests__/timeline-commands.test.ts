import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { applyCommand, TrackLockedError, type EditorCommand } from '../commands'
import { commandsToJoinClips } from '../actions'
import { EditorCommandError } from '../commands'
import { createClip, createDoc, createMediaAsset, createTrack } from '../factories'
import { useEditorStore } from '../store'
import {
  canCloseGaps,
  canJoinClips,
  planCloseGaps,
  planJoinGroup,
  planJoinSelection,
} from '../timeline-edit-plan'
import type { Clip, Doc, EffectEntry, MediaAsset, Track, TrackKind } from '../types'

/**
 * 0.22.0 timeline commands: Close Gaps and Join Clips.
 *
 * Both commands decide with a pure planner in `timeline-edit-plan.ts`; the
 * planner is what the menu enablement reads, so every case here is also a
 * statement about which menu rows are clickable.
 */

const M1: MediaAsset = createMediaAsset({
  id: 'm1',
  kind: 'video',
  name: 'a.mp4',
  duration: 60,
  url: 'blob:m1',
  hasAudio: true,
})
const M2: MediaAsset = createMediaAsset({
  id: 'm2',
  kind: 'video',
  name: 'b.mp4',
  duration: 60,
  url: 'blob:m2',
  hasAudio: true,
})

function lane(kind: TrackKind, id: string, clips: Clip[], extra: Partial<Track> = {}): Track {
  return createTrack(kind, 1, { id, clips, ...extra })
}

function docOf(tracks: Track[], media: MediaAsset[] = [M1]): Doc {
  const doc = createDoc()
  return { project: { ...doc.project, tracks }, media }
}

/** A clip with an explicit source window (inPoint defaults to its start). */
function clip(id: string, start: number, duration: number, extra: Partial<Clip> = {}): Clip {
  return createClip({ id, start, duration, inPoint: start, ...extra })
}

const crossfade = { type: 'crossfade' as const, duration: 1 }

describe('planCloseGaps', () => {
  it('closes a leading gap and every interior gap in one pass', () => {
    const doc = docOf([lane('video', 'v1', [clip('a', 5, 4), clip('b', 12, 2), clip('c', 20, 3)])])
    const plan = planCloseGaps(doc, 'v1')
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.moves.map((m) => [m.clipId, m.start])).toEqual([
      ['a', 0],
      ['b', 4],
      ['c', 6],
    ])
  })

  it('treats a crossfade overlap as occupied time, never as a negative gap', () => {
    const doc = docOf([
      lane('video', 'v1', [
        { ...clip('a', 0, 4), transitionOut: crossfade },
        clip('b', 3, 4),
        clip('c', 10, 3),
      ]),
    ])
    const plan = planCloseGaps(doc, 'v1')
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    // a and b keep their 1s overlap; only the 3s gap after b closes.
    expect(plan.moves.map((m) => [m.clipId, m.start])).toEqual([['c', 7]])
  })

  it('keeps a clip ordered after a shorter crossfade partner, not after its own tail', () => {
    // b overlaps a's tail but ends BEFORE a does. Walking only the previous
    // clip's end would pull c to 9 and lay it under a's last second; the
    // occupied end stays at a's 10.
    const doc = docOf([
      lane('video', 'v1', [
        { ...clip('a', 0, 10), transitionOut: { type: 'crossfade', duration: 1 } },
        clip('b', 8, 1),
        clip('c', 15, 3),
      ]),
    ])
    const plan = planCloseGaps(doc, 'v1')
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.moves.map((m) => [m.clipId, m.start])).toEqual([['c', 10]])
  })

  it('refuses a gapless track, an empty track, and an unknown track', () => {
    expect(
      planCloseGaps(docOf([lane('video', 'v1', [clip('a', 0, 4), clip('b', 4, 4)])]), 'v1'),
    ).toEqual({ ok: false, reason: 'This track has no gaps to close' })
    expect(planCloseGaps(docOf([lane('video', 'v1', [])]), 'v1')).toEqual({
      ok: false,
      reason: 'This track has no clips to close up',
    })
    expect(planCloseGaps(docOf([lane('video', 'v1', [clip('a', 1, 4)])]), 'nope')).toEqual({
      ok: false,
      reason: 'Unknown track',
    })
  })

  it('moves a linked partner by the same delta so the pair stays in sync', () => {
    const doc = docOf([
      lane('video', 'v1', [clip('v', 4, 3, { mediaId: 'm1', linkId: 'L' })]),
      lane('audio', 'a1', [clip('s', 4, 3, { mediaId: 'm1', linkId: 'L', audioOnly: true })]),
    ])
    const plan = planCloseGaps(doc, 'v1')
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.moves).toEqual([
      { clipId: 'v', trackId: 'v1', start: 0 },
      { clipId: 's', trackId: 'a1', start: 0 },
    ])
  })

  it('refuses two members of one group on the SAME lane that would lose different amounts', () => {
    const doc = docOf([
      lane('video', 'v1', [
        clip('a', 0, 4, { mediaId: 'm1', linkId: 'L' }),
        clip('b', 6, 4, { mediaId: 'm1', linkId: 'L' }),
      ]),
    ])
    expect(planCloseGaps(doc, 'v1')).toEqual({ ok: false, reason: 'Linked clips would lose sync' })
  })

  it('refuses a partner that would move before the timeline start', () => {
    const doc = docOf([
      lane('video', 'v1', [clip('v', 4, 3, { mediaId: 'm1', linkId: 'L' })]),
      lane('audio', 'a1', [clip('s', 1, 3, { mediaId: 'm1', linkId: 'L', audioOnly: true })]),
    ])
    expect(planCloseGaps(doc, 'v1')).toEqual({
      ok: false,
      reason: 'A linked clip would move before the timeline start',
    })
  })

  it('refuses a partner move that would invent an overlap on its lane', () => {
    const doc = docOf([
      lane('video', 'v1', [clip('v', 5, 4, { mediaId: 'm1', linkId: 'L' })]),
      lane('audio', 'a1', [
        clip('r', 0, 4, { mediaId: 'm1' }),
        clip('s', 5, 4, { mediaId: 'm1', linkId: 'L', audioOnly: true }),
      ]),
    ])
    expect(planCloseGaps(doc, 'v1')).toEqual({
      ok: false,
      reason: 'A linked clip would collide on its track',
    })
  })

  it('refuses a partner move that would shorten an existing transition', () => {
    const doc = docOf([
      lane('video', 'v1', [clip('v', 5, 4, { mediaId: 'm1', linkId: 'L' })]),
      lane('audio', 'a1', [
        {
          ...clip('p', 5, 4, { mediaId: 'm1', linkId: 'L', audioOnly: true }),
          transitionOut: crossfade,
        },
        clip('q', 8, 4, { mediaId: 'm2', audioOnly: true }),
      ]),
    ])
    expect(planCloseGaps(doc, 'v1')).toEqual({
      ok: false,
      reason: 'A linked clip would shorten a transition',
    })
  })

  it('does not report a collision when a partner lands exactly against its neighbour', () => {
    // P moves from 12 to 8 and ends at 10, exactly where L starts. The clips
    // do NOT overlap; measuring only `left end - right start` would read 4.
    const doc = docOf([
      lane('video', 'v1', [
        clip('a', 0, 2, { mediaId: 'm1' }),
        clip('b', 6, 2, { mediaId: 'm1', inPoint: 6, linkId: 'L' }),
      ]),
      lane('audio', 'a1', [
        clip('l', 10, 2, { mediaId: 'm1', inPoint: 10 }),
        clip('p', 12, 2, { mediaId: 'm1', inPoint: 12, linkId: 'L', audioOnly: true }),
      ]),
    ])
    const plan = planCloseGaps(doc, 'v1')
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.moves).toEqual([
      { clipId: 'b', trackId: 'v1', start: 2 },
      { clipId: 'p', trackId: 'a1', start: 8 },
    ])
  })

  it('leaves sequence markers at their absolute times', () => {
    const doc = docOf([lane('video', 'v1', [clip('a', 5, 4)])])
    doc.project.markers = [{ id: 'mk1', time: 2, name: 'Cue' }]
    const next = applyCommand(doc, { type: 'closeGaps', trackId: 'v1' })
    expect(next.project.tracks[0].clips[0].start).toBe(0)
    expect(next.project.markers).toEqual([{ id: 'mk1', time: 2, name: 'Cue' }])
    expect(doc.project.tracks[0].clips[0].start).toBe(5)
  })
})

describe('closeGaps command', () => {
  beforeEach(() => {
    useEditorStore.setState({
      doc: createDoc(),
      past: [],
      future: [],
      selections: [],
      selection: null,
      selectedMarker: null,
      untargetedTracks: [],
      activeSequencePath: [],
      playhead: 0,
    })
  })

  it('applies every move as ONE history entry and undo restores all of them', () => {
    const doc = docOf([
      lane('video', 'v1', [clip('a', 5, 4), clip('b', 12, 2), clip('c', 20, 3)]),
      lane('audio', 'a1', [clip('s', 5, 4, { mediaId: 'm1', linkId: 'L' })]),
    ])
    doc.project.tracks[0].clips[0].linkId = 'L'
    useEditorStore.getState().replaceDoc(doc)
    const before = useEditorStore.getState().past.length

    expect(useEditorStore.getState().apply({ type: 'closeGaps', trackId: 'v1' })).toBe(true)
    const starts = () =>
      useEditorStore
        .getState()
        .doc.project.tracks.flatMap((track) => track.clips.map((c) => [c.id, c.start]))
    expect(starts()).toEqual([
      ['a', 0],
      ['b', 4],
      ['c', 6],
      ['s', 0],
    ])
    expect(useEditorStore.getState().past.length).toBe(before + 1)

    useEditorStore.getState().undo()
    expect(starts()).toEqual([
      ['a', 5],
      ['b', 12],
      ['c', 20],
      ['s', 5],
    ])
  })

  it('refuses a locked target lane', () => {
    const doc = docOf([lane('video', 'v1', [clip('a', 5, 4)], { locked: true })])
    expect(() => applyCommand(doc, { type: 'closeGaps', trackId: 'v1' })).toThrow(TrackLockedError)
  })

  it('refuses the whole batch when a partner lane is locked', () => {
    const doc = docOf([
      lane('video', 'v1', [clip('v', 4, 3, { mediaId: 'm1', linkId: 'L' })]),
      lane('audio', 'a1', [clip('s', 4, 3, { mediaId: 'm1', linkId: 'L', audioOnly: true })], {
        locked: true,
      }),
    ])
    expect(() => applyCommand(doc, { type: 'closeGaps', trackId: 'v1' })).toThrow(TrackLockedError)
  })

  it('refuses an unknown lane and a gapless lane instead of writing a no-op', () => {
    const doc = docOf([lane('video', 'v1', [clip('a', 0, 4)])])
    expect(() => applyCommand(doc, { type: 'closeGaps', trackId: 'nope' })).toThrow(
      EditorCommandError,
    )
    expect(() => applyCommand(doc, { type: 'closeGaps', trackId: 'v1' })).toThrow(
      'This track has no gaps to close',
    )
  })
})

describe('planJoinSelection / planJoinGroup', () => {
  const pair = () =>
    docOf([
      lane('video', 'v1', [
        clip('p', 0, 4, { mediaId: 'm1' }),
        clip('n', 4, 4, { mediaId: 'm1', inPoint: 4 }),
      ]),
    ])

  it('accepts an adjacent same-source pair', () => {
    expect(planJoinSelection(pair(), ['p', 'n'])).toEqual({
      ok: true,
      pairs: [{ previousId: 'p', nextId: 'n' }],
    })
  })

  it('refuses a gap, an overlap, a different source, and the same clip twice', () => {
    const gap = docOf([
      lane('video', 'v1', [
        clip('p', 0, 4, { mediaId: 'm1' }),
        clip('n', 5, 4, { mediaId: 'm1', inPoint: 5 }),
      ]),
    ])
    expect(planJoinSelection(gap, ['p', 'n'])).toEqual({
      ok: false,
      reason: 'There is a gap between the clips',
    })

    const overlap = docOf([
      lane('video', 'v1', [
        clip('p', 0, 4, { mediaId: 'm1' }),
        clip('n', 3, 4, { mediaId: 'm1', inPoint: 3 }),
      ]),
    ])
    expect(planJoinSelection(overlap, ['p', 'n'])).toEqual({
      ok: false,
      reason: 'The clips overlap',
    })

    const other = docOf([
      lane('video', 'v1', [clip('p', 0, 4, { mediaId: 'm1' }), clip('n', 4, 4, { mediaId: 'm2' })]),
    ])
    expect(planJoinSelection(other, ['p', 'n'])).toEqual({
      ok: false,
      reason: 'The joined clips must share one source',
    })

    expect(planJoinSelection(pair(), ['p', 'p'])).toEqual({
      ok: false,
      reason: 'Select exactly two clips from the same source',
    })
    expect(planJoinGroup(pair(), 'p', 'p')).toEqual({
      ok: false,
      reason: 'A clip cannot be joined with itself',
    })
    expect(planJoinGroup(pair(), 'p', 'missing')).toEqual({ ok: false, reason: 'Unknown clip' })
  })

  it('refuses a speed mismatch, a direction mismatch, and a source discontinuity', () => {
    const speed = docOf([
      lane('video', 'v1', [
        clip('p', 0, 4, { mediaId: 'm1', speed: 1 }),
        clip('n', 4, 4, { mediaId: 'm1', speed: 2, inPoint: 8 }),
      ]),
    ])
    expect(planJoinSelection(speed, ['p', 'n'])).toEqual({
      ok: false,
      reason: 'The clips must play at the same speed',
    })

    const direction = docOf([
      lane('video', 'v1', [
        clip('p', 0, 4, { mediaId: 'm1' }),
        clip('n', 4, 4, { mediaId: 'm1', reverse: true, inPoint: 4 }),
      ]),
    ])
    expect(planJoinSelection(direction, ['p', 'n'])).toEqual({
      ok: false,
      reason: 'The clips must play in the same direction',
    })

    const jump = docOf([
      lane('video', 'v1', [
        clip('p', 0, 4, { mediaId: 'm1' }),
        clip('n', 4, 4, { mediaId: 'm1', inPoint: 9 }),
      ]),
    ])
    expect(planJoinSelection(jump, ['p', 'n'])).toEqual({
      ok: false,
      reason: 'The clips must be continuous in the source',
    })
  })

  it('refuses an outgoing transition on either clip', () => {
    const onPrevious = pair()
    onPrevious.project.tracks[0].clips[0].transitionOut = crossfade
    expect(planJoinSelection(onPrevious, ['p', 'n'])).toEqual({
      ok: false,
      reason: 'A clip with an outgoing transition cannot be joined',
    })

    const onNext = pair()
    onNext.project.tracks[0].clips[1].transitionOut = crossfade
    expect(planJoinSelection(onNext, ['p', 'n'])).toEqual({
      ok: false,
      reason: 'A clip with an outgoing transition cannot be joined',
    })
  })

  it('refuses keyframes on the clip and on an effect', () => {
    const onClip = pair()
    onClip.project.tracks[0].clips[1].keyframes = { opacity: [{ time: 0, value: 1 }] }
    expect(planJoinSelection(onClip, ['p', 'n'])).toEqual({
      ok: false,
      reason: 'Keyframed clips cannot be joined',
    })

    const onEffect = pair()
    onEffect.project.tracks[0].clips[0].effects = [
      { id: 'fx', type: 'crop', keyframes: { left: [{ time: 0, value: 10 }] } },
    ]
    onEffect.project.tracks[0].clips[1].effects = [
      { id: 'fx', type: 'crop', keyframes: { left: [{ time: 0, value: 10 }] } },
    ]
    expect(planJoinSelection(onEffect, ['p', 'n'])).toEqual({
      ok: false,
      reason: 'Keyframed clips cannot be joined',
    })
  })

  it('refuses a retained-field mismatch and names the field', () => {
    const muted = pair()
    muted.project.tracks[0].clips[1].muted = true
    expect(planJoinSelection(muted, ['p', 'n'])).toEqual({
      ok: false,
      reason: 'Mute differs between the clips',
    })

    const graded = pair()
    graded.project.tracks[0].clips[1].lutId = 'lut-1'
    expect(planJoinSelection(graded, ['p', 'n'])).toEqual({
      ok: false,
      reason: 'LUT differs between the clips',
    })

    const effects = pair()
    effects.project.tracks[0].clips[1].effects = [{ id: 'fx', type: 'crop', left: 10 }]
    expect(planJoinSelection(effects, ['p', 'n'])).toEqual({
      ok: false,
      reason: 'Effects differs between the clips',
    })
  })

  it('refuses a transform mismatch and accepts matching or default transforms', () => {
    const rotated = pair()
    rotated.project.tracks[0].clips[1].rotation = 90
    expect(planJoinSelection(rotated, ['p', 'n'])).toEqual({
      ok: false,
      reason: 'Rotation differs between the clips',
    })

    const flipped = pair()
    flipped.project.tracks[0].clips[1].flipX = true
    expect(planJoinSelection(flipped, ['p', 'n'])).toEqual({
      ok: false,
      reason: 'Flip differs between the clips',
    })

    // Absent rotation reads as 0 and absent flips as false, so explicit
    // defaults still join; the join keeps the previous clip's transform.
    const defaults = pair()
    defaults.project.tracks[0].clips[0].rotation = 0
    defaults.project.tracks[0].clips[1].flipX = false
    defaults.project.tracks[0].clips[1].flipY = false
    expect(planJoinSelection(defaults, ['p', 'n']).ok).toBe(true)
  })

  it('refuses text and compound clips', () => {
    const text = docOf([lane('text', 't1', [clip('p', 0, 4), clip('n', 4, 4)])])
    text.project.tracks[0].clips[0].text = 'a'
    text.project.tracks[0].clips[1].text = 'b'
    expect(planJoinSelection(text, ['p', 'n'])).toEqual({
      ok: false,
      reason: 'Text clips cannot be joined',
    })

    const compound = docOf([lane('video', 'v1', [clip('p', 0, 4), clip('n', 4, 4)])])
    compound.project.tracks[0].clips[1].sequenceId = 'seq-1'
    expect(planJoinSelection(compound, ['p', 'n'])).toEqual({
      ok: false,
      reason: 'Compound clips cannot be joined',
    })
  })

  it('refuses differing markers but accepts the re-ided markers a split leaves', () => {
    const differing = pair()
    differing.project.tracks[0].clips[0].markers = [{ id: 'mk1', time: 1, name: 'Cue' }]
    expect(planJoinSelection(differing, ['p', 'n'])).toEqual({
      ok: false,
      reason: 'Markers differs between the clips',
    })

    // A split gives both halves the same cues with FRESH ids; the join keeps
    // the previous clip's list, so ids must not be compared.
    const split = pair()
    split.project.tracks[0].clips[0].markers = [{ id: 'mk1', time: 1, name: 'Cue' }]
    split.project.tracks[0].clips[1].markers = [{ id: 'mk2', time: 1, name: 'Cue' }]
    expect(planJoinSelection(split, ['p', 'n']).ok).toBe(true)
  })

  it('refuses a group with two members on the same lane', () => {
    // A manual Link can put two clips of one group on one lane; there is then
    // no way to pair them lane by lane with the other group.
    const doc = docOf([
      lane('video', 'v1', [
        clip('a1', 0, 4, { mediaId: 'm1', linkId: 'LA' }),
        clip('b1', 4, 4, { mediaId: 'm1', linkId: 'LB', inPoint: 4 }),
        clip('a2', 8, 4, { mediaId: 'm1', linkId: 'LA', inPoint: 8 }),
        clip('b2', 12, 4, { mediaId: 'm1', linkId: 'LB', inPoint: 12 }),
      ]),
    ])
    expect(planJoinSelection(doc, ['a1', 'b1'])).toEqual({
      ok: false,
      reason: 'The joined clips must sit on matching tracks',
    })
  })

  it('accepts identical nested effect stacks and anim statics', () => {
    const doc = pair()
    const effects = [{ id: 'fx', type: 'crop' as const, left: 10, zoom: true }]
    for (const target of doc.project.tracks[0].clips) {
      target.effects = effects.map((e) => ({ ...e }))
      target.animStatics = { positionX: 0.25, scale: 1.5 }
    }
    expect(planJoinSelection(doc, ['p', 'n']).ok).toBe(true)
  })

  it('refuses groups whose lanes pair in opposite directions', () => {
    // The video pair runs v1 -> v2 while the audio pair would run s2 -> s1. A
    // join would then keep v1 (group L1) and s2 (group L2), mixing the two
    // groups instead of merging them.
    const doc = docOf([
      lane('video', 'v1', [
        clip('v1', 0, 4, { mediaId: 'm1', linkId: 'L1' }),
        clip('v2', 4, 4, { mediaId: 'm1', linkId: 'L2', inPoint: 4 }),
      ]),
      lane('audio', 'a1', [
        clip('s1', 10, 4, { mediaId: 'm1', linkId: 'L1', audioOnly: true, inPoint: 4 }),
        clip('s2', 6, 4, { mediaId: 'm1', linkId: 'L2', audioOnly: true }),
      ]),
    ])
    expect(planJoinSelection(doc, ['v1', 'v2'])).toEqual({
      ok: false,
      reason: 'The linked halves are ordered differently',
    })
  })

  it('pairs two A/V groups lane by lane', () => {
    const doc = docOf([
      lane('video', 'v1', [
        clip('v1', 0, 4, { mediaId: 'm1', linkId: 'L1' }),
        clip('v2', 4, 4, { mediaId: 'm1', linkId: 'L2', inPoint: 4 }),
      ]),
      lane('audio', 'a1', [
        clip('s1', 0, 4, { mediaId: 'm1', linkId: 'L1', audioOnly: true }),
        clip('s2', 4, 4, { mediaId: 'm1', linkId: 'L2', audioOnly: true, inPoint: 4 }),
      ]),
    ])
    expect(planJoinSelection(doc, ['v1', 'v2'])).toEqual({
      ok: true,
      pairs: [
        { previousId: 'v1', nextId: 'v2' },
        { previousId: 's1', nextId: 's2' },
      ],
    })
    // Clicking ONE half already resolves to its whole group, so that selection
    // is a single group and cannot be joined with itself.
    expect(planJoinSelection(doc, ['v1']).ok).toBe(false)
  })

  it('refuses a group whose counterpart is missing', () => {
    const doc = docOf([
      lane('video', 'v1', [
        clip('v1', 0, 4, { mediaId: 'm1', linkId: 'L1' }),
        clip('v2', 4, 4, { mediaId: 'm1', inPoint: 4 }),
      ]),
      lane('audio', 'a1', [clip('s1', 0, 4, { mediaId: 'm1', linkId: 'L1', audioOnly: true })]),
    ])
    expect(planJoinSelection(doc, ['v1', 'v2'])).toEqual({
      ok: false,
      reason: 'The joined clips must sit on matching tracks',
    })
  })
})

describe('joinClips command', () => {
  const pairDoc = () =>
    docOf([
      lane('video', 'v1', [
        clip('p', 0, 4, { mediaId: 'm1' }),
        clip('n', 4, 4, { mediaId: 'm1', inPoint: 4 }),
      ]),
    ])

  it('extends the previous clip in place and removes the next one', () => {
    const doc = pairDoc()
    const next = applyCommand(doc, { type: 'joinClips', clipId: 'p', nextId: 'n' })
    expect(next.project.tracks[0].clips).toHaveLength(1)
    expect(next.project.tracks[0].clips[0]).toMatchObject({
      id: 'p',
      start: 0,
      duration: 8,
      inPoint: 0,
    })
    // Source window unchanged for the caller's doc.
    expect(doc.project.tracks[0].clips).toHaveLength(2)
  })

  it('joins a reversed split pair back to the original source window', () => {
    // A reversed 4s clip reading source 0..4, split at local 2: the left half
    // covers source 2..4 (inPoint 2) and the right half source 0..2.
    const doc = docOf([
      lane('video', 'v1', [
        clip('left', 0, 2, { mediaId: 'm1', inPoint: 2, reverse: true }),
        clip('right', 2, 2, { mediaId: 'm1', inPoint: 0, reverse: true }),
      ]),
    ])
    const joined = applyCommand(doc, { type: 'joinClips', clipId: 'left', nextId: 'right' })
    const only = joined.project.tracks[0].clips[0]
    expect(only).toMatchObject({ id: 'left', duration: 4, inPoint: 0, reverse: true })
  })

  it('joins an A/V pair as one batch, removing both next clips', () => {
    const doc = docOf([
      lane('video', 'v1', [
        clip('v1', 0, 4, { mediaId: 'm1', linkId: 'L1' }),
        clip('v2', 4, 4, { mediaId: 'm1', linkId: 'L2', inPoint: 4 }),
      ]),
      lane('audio', 'a1', [
        clip('s1', 0, 4, { mediaId: 'm1', linkId: 'L1', audioOnly: true }),
        clip('s2', 4, 4, { mediaId: 'm1', linkId: 'L2', audioOnly: true, inPoint: 4 }),
      ]),
    ])
    const next = applyCommand(doc, { type: 'joinClips', clipId: 'v1', nextId: 'v2' })
    expect(next.project.tracks[0].clips.map((c) => [c.id, c.duration, c.linkId])).toEqual([
      ['v1', 8, 'L1'],
    ])
    expect(next.project.tracks[1].clips.map((c) => [c.id, c.duration, c.linkId])).toEqual([
      ['s1', 8, 'L1'],
    ])
  })

  it('refuses a locked partner lane before merging anything', () => {
    const doc = docOf([
      lane('video', 'v1', [
        clip('v1', 0, 4, { mediaId: 'm1', linkId: 'L1' }),
        clip('v2', 4, 4, { mediaId: 'm1', linkId: 'L2', inPoint: 4 }),
      ]),
      lane(
        'audio',
        'a1',
        [
          clip('s1', 0, 4, { mediaId: 'm1', linkId: 'L1', audioOnly: true }),
          clip('s2', 4, 4, { mediaId: 'm1', linkId: 'L2', audioOnly: true, inPoint: 4 }),
        ],
        { locked: true },
      ),
    ])
    expect(() => applyCommand(doc, { type: 'joinClips', clipId: 'v1', nextId: 'v2' })).toThrow(
      TrackLockedError,
    )
    expect(doc.project.tracks[0].clips).toHaveLength(2)
  })

  it('reports a refused join as an EditorCommandError, never a partial merge', () => {
    const doc = docOf([
      lane('video', 'v1', [
        clip('p', 0, 4, { mediaId: 'm1' }),
        clip('n', 4, 4, { mediaId: 'm1', inPoint: 4, muted: true }),
      ]),
    ])
    expect(() => applyCommand(doc, { type: 'joinClips', clipId: 'p', nextId: 'n' })).toThrow(
      'Mute differs between the clips',
    )
    expect(doc.project.tracks[0].clips).toHaveLength(2)
  })
})

describe('joinClips through the store', () => {
  beforeEach(() => {
    useEditorStore.setState({
      doc: createDoc(),
      past: [],
      future: [],
      selections: [],
      selection: null,
      selectedMarker: null,
      untargetedTracks: [],
      activeSequencePath: [],
      playhead: 0,
    })
  })

  it('keeps the previous id and selection, and one undo restores every clip', () => {
    const doc = docOf([
      lane('video', 'v1', [
        clip('v1', 0, 4, { mediaId: 'm1', linkId: 'L1' }),
        clip('v2', 4, 4, { mediaId: 'm1', linkId: 'L2', inPoint: 4 }),
      ]),
      lane('audio', 'a1', [
        clip('s1', 0, 4, { mediaId: 'm1', linkId: 'L1', audioOnly: true }),
        clip('s2', 4, 4, { mediaId: 'm1', linkId: 'L2', audioOnly: true, inPoint: 4 }),
      ]),
    ])
    useEditorStore.getState().replaceDoc(doc)
    useEditorStore.getState().setSelections(['v1', 'v2', 's1', 's2'])
    const before = useEditorStore.getState().past.length

    expect(useEditorStore.getState().apply({ type: 'joinClips', clipId: 'v1', nextId: 'v2' })).toBe(
      true,
    )
    const state = useEditorStore.getState()
    expect(state.past.length).toBe(before + 1)
    // The removed ids leave the selection; the surviving joined clips stay.
    expect(state.selections).toEqual(['v1', 's1'])
    expect(state.selection).toBe('v1')

    state.undo()
    expect(useEditorStore.getState().doc.project.tracks[0].clips).toHaveLength(2)
    expect(useEditorStore.getState().doc.project.tracks[1].clips).toHaveLength(2)
  })
})

describe('commandsToJoinClips', () => {
  it('returns one command for a joinable selection and null otherwise', () => {
    const doc = docOf([
      lane('video', 'v1', [
        clip('p', 0, 4, { mediaId: 'm1' }),
        clip('n', 4, 4, { mediaId: 'm1', inPoint: 4 }),
        clip('z', 20, 4, { mediaId: 'm1', inPoint: 20 }),
      ]),
    ])
    expect(commandsToJoinClips(doc, ['p', 'n'])).toEqual([
      { type: 'joinClips', clipId: 'p', nextId: 'n' } satisfies EditorCommand,
    ])
    expect(commandsToJoinClips(doc, ['p', 'z'])).toBeNull()
    expect(commandsToJoinClips(doc, ['p'])).toBeNull()
    expect(commandsToJoinClips(doc, [])).toBeNull()
  })
})

describe('menu availability (plan plus lock gate)', () => {
  const gapped = (locked = false) =>
    docOf([lane('video', 'v1', [clip('a', 5, 2), clip('b', 9, 2)], { locked })])

  it('Close Gaps is unavailable on a locked lane, even though the plan lands', () => {
    const doc = gapped(true)
    expect(planCloseGaps(doc, 'v1').ok).toBe(true)
    expect(canCloseGaps(doc, 'v1')).toBe(false)
    expect(canCloseGaps(gapped(false), 'v1')).toBe(true)
    expect(canCloseGaps(doc, 'missing')).toBe(false)
    expect(canCloseGaps(docOf([lane('video', 'v1', [clip('a', 0, 2)])]), 'v1')).toBe(false)
  })

  it('Close Gaps is unavailable when a LINK PARTNER lane is locked', () => {
    const doc = docOf([
      lane('video', 'v1', [clip('v', 4, 3, { mediaId: 'm1', linkId: 'L' })]),
      lane('audio', 'a1', [clip('s', 4, 3, { mediaId: 'm1', linkId: 'L', audioOnly: true })], {
        locked: true,
      }),
    ])
    // The plan itself is fine; only the command's lock rule refuses it.
    expect(planCloseGaps(doc, 'v1').ok).toBe(true)
    expect(canCloseGaps(doc, 'v1')).toBe(false)
  })

  it('Join Clips is unavailable on a locked lane or with a locked partner lane', () => {
    const plain = docOf([
      lane('video', 'v1', [
        clip('p', 0, 4, { mediaId: 'm1' }),
        clip('n', 4, 4, { mediaId: 'm1', inPoint: 4 }),
      ]),
    ])
    expect(canJoinClips(plain, ['p', 'n'])).toBe(true)
    plain.project.tracks[0].locked = true
    expect(planJoinSelection(plain, ['p', 'n']).ok).toBe(true)
    expect(canJoinClips(plain, ['p', 'n'])).toBe(false)

    const pairDoc = docOf([
      lane('video', 'v1', [
        clip('v1', 0, 4, { mediaId: 'm1', linkId: 'L1' }),
        clip('v2', 4, 4, { mediaId: 'm1', linkId: 'L2', inPoint: 4 }),
      ]),
      lane('audio', 'a1', [
        clip('s1', 0, 4, { mediaId: 'm1', linkId: 'L1', audioOnly: true }),
        clip('s2', 4, 4, { mediaId: 'm1', linkId: 'L2', audioOnly: true, inPoint: 4 }),
      ]),
    ])
    expect(canJoinClips(pairDoc, ['v1', 'v2'])).toBe(true)
    pairDoc.project.tracks[1].locked = true
    expect(canJoinClips(pairDoc, ['v1', 'v2'])).toBe(false)
  })
})

describe('timeline command UI locks (static)', () => {
  const read = (path: string) => readFileSync(resolve(__dirname, '../../../..', path), 'utf8')

  it('the clip context menu dispatches the shared commands, not inline mutations', () => {
    const view = read('src/components/editor/timeline/ClipView.tsx')
    expect(view).toMatch(/commandsToJoinClips/)
    expect(view).toMatch(/type: 'closeGaps'/)
    expect(view).toMatch(/canCloseGaps\(doc, track\.id\)/)
    expect(view).toMatch(/canJoinClips\(doc, selIds\)/)
    // Planning runs at menu OPEN, never in the component body: every clip
    // mounts its own menu, so a body-level plan ran once per clip per frame.
    expect(view).not.toMatch(/const canCloseGapsHere/)
    expect(view).not.toMatch(/const canJoinHere/)
    expect(view).toMatch(/data-testid="menu-close-gaps"/)
    expect(view).toMatch(/data-testid="menu-join-clips"/)
  })

  it('the track context menu closes gaps on its own lane through the same planner', () => {
    const panel = read('src/components/editor/timeline/TimelinePanel.tsx')
    expect(panel).toMatch(/track-menu-close-gaps/)
    expect(panel).toMatch(/canCloseGaps\(doc, track\.id\)/)
    expect(panel).toMatch(/type: 'closeGaps', trackId: track\.id/)
  })

  it('the menu bar delegates both rows to the shared executor', () => {
    const bar = read('src/components/editor/MenuBar.tsx')
    const executor = read('src/lib/editor/action-executor.ts')
    expect(bar).toMatch(/canCloseGaps\(doc, selectedTrackId\)/)
    expect(bar).toMatch(/canJoinClips\(doc, selections\)/)
    expect(executor).toMatch(/case 'clip\.closeGaps'/)
    expect(executor).toMatch(/case 'clip\.joinClips'/)
    // The command layer owns the geometry; neither UI file may write starts.
    expect(bar).not.toMatch(/type: 'joinClips'/)
    expect(bar).not.toMatch(/clip\.start\s*=/)
  })
})

describe('joinClips effect comparison (0.28.2)', () => {
  function pairWith(leftEffects: EffectEntry[], rightEffects: EffectEntry[]): Doc {
    return docOf([
      lane('video', 'v1', [
        clip('p', 0, 4, { mediaId: 'm1', effects: leftEffects }),
        clip('n', 4, 4, { mediaId: 'm1', inPoint: 4, effects: rightEffects }),
      ]),
    ])
  }

  it('joins effects that differ only by their internal ids', () => {
    const doc = pairWith(
      [{ id: 'fx_left', type: 'crop', left: 10 }],
      [{ id: 'fx_right', type: 'crop', left: 10 }],
    )
    const next = applyCommand(doc, { type: 'joinClips', clipId: 'p', nextId: 'n' })
    expect(next.project.tracks[0].clips).toHaveLength(1)
  })

  it('joins absent enabled versus an explicit true', () => {
    const doc = pairWith(
      [{ id: 'fx', type: 'crop', left: 10 }],
      [{ id: 'fx', type: 'crop', left: 10, enabled: true }],
    )
    const next = applyCommand(doc, { type: 'joinClips', clipId: 'p', nextId: 'n' })
    expect(next.project.tracks[0].clips).toHaveLength(1)
  })

  it('still refuses a disabled effect against an absent one', () => {
    const doc = pairWith(
      [{ id: 'fx', type: 'crop', left: 10 }],
      [{ id: 'fx', type: 'crop', left: 10, enabled: false }],
    )
    expect(() => applyCommand(doc, { type: 'joinClips', clipId: 'p', nextId: 'n' })).toThrow(
      'Effects differs between the clips',
    )
  })

  it('still refuses a real parameter difference', () => {
    const doc = pairWith(
      [{ id: 'fx', type: 'crop', left: 10 }],
      [{ id: 'fx', type: 'crop', left: 20 }],
    )
    expect(() => applyCommand(doc, { type: 'joinClips', clipId: 'p', nextId: 'n' })).toThrow(
      'Effects differs between the clips',
    )
  })

  it('still refuses a different effect order', () => {
    const doc = pairWith(
      [
        { id: 'a', type: 'crop', left: 10 },
        { id: 'b', type: 'chromaKey', key: '#00ff00' },
      ],
      [
        { id: 'b', type: 'chromaKey', key: '#00ff00' },
        { id: 'a', type: 'crop', left: 10 },
      ],
    )
    expect(() => applyCommand(doc, { type: 'joinClips', clipId: 'p', nextId: 'n' })).toThrow(
      'Effects differs between the clips',
    )
  })

  it('still refuses a different matte track reference', () => {
    const doc = pairWith(
      [{ id: 'fx', type: 'trackMatte', trackId: 't1' }],
      [{ id: 'fx', type: 'trackMatte', trackId: 't2' }],
    )
    expect(() => applyCommand(doc, { type: 'joinClips', clipId: 'p', nextId: 'n' })).toThrow(
      'Effects differs between the clips',
    )
  })

  it('still refuses chroma, crop zoom, and matte setting differences', () => {
    const cases: [EffectEntry, EffectEntry][] = [
      [
        { id: 'fx', type: 'chromaKey', key: '#00ff00', similarity: 0.2 },
        { id: 'fx', type: 'chromaKey', key: '#00ff00', similarity: 0.6 },
      ],
      [
        { id: 'fx', type: 'crop', left: 10, zoom: true },
        { id: 'fx', type: 'crop', left: 10, zoom: false },
      ],
      [
        { id: 'fx', type: 'trackMatte', trackId: 't1', mode: 'luma' },
        { id: 'fx', type: 'trackMatte', trackId: 't1', mode: 'alpha' },
      ],
      [
        { id: 'fx', type: 'trackMatte', trackId: 't1', reverse: true },
        { id: 'fx', type: 'trackMatte', trackId: 't1', reverse: false },
      ],
    ]
    for (const [left, right] of cases) {
      const doc = pairWith([left], [right])
      expect(() => applyCommand(doc, { type: 'joinClips', clipId: 'p', nextId: 'n' })).toThrow(
        'Effects differs between the clips',
      )
    }
  })

  it('still refuses an explicit numeric or enum default versus an absent one', () => {
    const cases: [EffectEntry, EffectEntry][] = [
      [
        { id: 'fx', type: 'chromaKey', key: '#00ff00', similarity: 0 },
        { id: 'fx', type: 'chromaKey', key: '#00ff00' },
      ],
      [
        { id: 'fx', type: 'crop', left: 10, zoom: false },
        { id: 'fx', type: 'crop', left: 10 },
      ],
      [
        { id: 'fx', type: 'trackMatte', trackId: 't1', mode: 'luma' },
        { id: 'fx', type: 'trackMatte', trackId: 't1' },
      ],
      [
        { id: 'fx', type: 'trackMatte', trackId: 't1', reverse: false },
        { id: 'fx', type: 'trackMatte', trackId: 't1' },
      ],
    ]
    for (const [left, right] of cases) {
      const doc = pairWith([left], [right])
      expect(() => applyCommand(doc, { type: 'joinClips', clipId: 'p', nextId: 'n' })).toThrow(
        'Effects differs between the clips',
      )
    }
  })
})

describe('timeline planners: remaining branch matrix (0.29.0)', () => {
  it('plans equal-offset linked members on one lane without a duplicate move', () => {
    const a = clip('a', 2, 2, { linkId: 'l1' })
    const b = clip('b', 4, 2, { linkId: 'l1' })
    const doc = docOf([lane('video', 'v1', [a, b])])
    const plan = planCloseGaps(doc, 'v1')
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.moves).toEqual([
      { clipId: 'a', trackId: 'v1', start: 0 },
      { clipId: 'b', trackId: 'v1', start: 2 },
    ])
  })

  it('sorts a lane whose array order is later-first before measuring overlap', () => {
    const late = clip('late', 6, 2)
    const early = clip('early', 0, 2)
    const doc = docOf([lane('video', 'v1', [late, early])])
    const plan = planCloseGaps(doc, 'v1')
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    // The already-placed clip stays at 0 and is not moved; only late moves.
    expect(plan.moves).toEqual([{ clipId: 'late', trackId: 'v1', start: 2 }])
    expect(doc.project.tracks[0]!.clips.find((item) => item.id === 'early')!.start).toBe(0)
  })

  it('pairs a reversed selection and a reversed explicit group by start time', () => {
    const first = clip('first', 0, 2, { mediaId: 'm1' })
    const second = clip('second', 2, 2, { mediaId: 'm1', inPoint: 2 })
    const doc = docOf([lane('video', 'v1', [first, second])])
    // Selection order is not timeline order: the planner swaps both groups.
    const selection = planJoinSelection(doc, ['second', 'first'])
    expect(selection).toMatchObject({ ok: true })
    if (!selection.ok) return
    expect(selection.pairs).toEqual([{ previousId: 'first', nextId: 'second' }])
    const explicit = planJoinGroup(doc, 'second', 'first')
    expect(explicit).toMatchObject({ ok: true })
    if (!explicit.ok) return
    expect(explicit.pairs).toEqual([{ previousId: 'first', nextId: 'second' }])
    expect(planJoinGroup(doc, 'first', 'first')).toMatchObject({ ok: false })
  })

  it('refuses a join of two clips already linked to each other', () => {
    const first = clip('first', 0, 2, { linkId: 'l1' })
    const second = clip('second', 2, 2, { linkId: 'l1' })
    const doc = docOf([lane('video', 'v1', [first, second])])
    expect(planJoinGroup(doc, 'first', 'second')).toEqual({
      ok: false,
      reason: 'The clips are already linked to each other',
    })
  })

  it('ignores unknown selection ids and refuses a cross-track pair', () => {
    const a = clip('a', 0, 2)
    const b = clip('b', 0, 2)
    const doc = docOf([lane('video', 'v1', [a]), lane('video', 'v2', [b])])
    expect(planJoinSelection(doc, ['a', 'b'])).toEqual({
      ok: false,
      reason: 'The joined clips must sit on matching tracks',
    })
    expect(planJoinSelection(doc, ['a', 'ghost'])).toMatchObject({ ok: false })
  })

  it('accepts joinable clips with an undefined curve slot, equal EQ, and unnamed markers', () => {
    const keyframes = { opacity: undefined } as unknown as Clip['keyframes']
    const markers = [{ id: 'm1', time: 0 }]
    const first = clip('first', 0, 2, {
      mediaId: 'm1',
      keyframes,
      eq: { low: 1, mid: 0, high: -1 },
      markers,
    })
    const second = clip('second', 2, 2, {
      mediaId: 'm1',
      inPoint: 2,
      keyframes: { opacity: undefined } as unknown as Clip['keyframes'],
      eq: { low: 1, mid: 0, high: -1 },
      markers: [{ id: 'm2', time: 0 }],
    })
    const doc = docOf([lane('video', 'v1', [first, second])])
    expect(planJoinSelection(doc, ['first', 'second'])).toMatchObject({ ok: true })
  })

  it('refuses a retained field whose runtime type differs', () => {
    const first = clip('first', 0, 2, { mediaId: 'm1', opacity: 1 })
    const second = clip('second', 2, 2, {
      mediaId: 'm1',
      inPoint: 2,
      opacity: '1' as unknown as number,
    })
    const doc = docOf([lane('video', 'v1', [first, second])])
    expect(planJoinSelection(doc, ['first', 'second'])).toEqual({
      ok: false,
      reason: 'Opacity differs between the clips',
    })
  })
})

describe('canJoinClips refusals (0.29.0)', () => {
  it('is unavailable when the selection does not plan', () => {
    const doc = docOf([lane('video', 'v1', [clip('a', 0, 2, { mediaId: 'm1' })])])
    expect(canJoinClips(doc, ['a'])).toBe(false)
    expect(canJoinClips(doc, ['a', 'ghost'])).toBe(false)
  })
})
