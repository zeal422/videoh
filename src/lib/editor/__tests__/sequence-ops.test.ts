import { describe, expect, it } from 'vitest'

import { applyCommands } from '../commands'
import { createClip, createDoc, createMediaAsset, createTrack, sourceTimeAt } from '../factories'
import { MIN_CLIP_DURATION, MIN_SPLIT_HEADROOM } from '../constants'
import { planInsert, planOverwrite } from '../sequence-ops'
import { pruneEmptiedTracks } from '../tracks'
import type { Clip, Doc, MediaAsset, Track, TrackKind } from '../types'

/**
 * Red-first matrix for the insert/overwrite planner (sequence-ops.ts).
 *
 * The planner is pure, so every case is asserted twice: the command batch it
 * returns (payload shape: ids, trims, link ids) and the doc that batch
 * produces through `applyCommands` (the same function the store uses). The
 * input doc is never mutated.
 */

const EPS = 1e-6

function r(n: number): number {
  return Math.round(n * 1e6) / 1e6
}

function asset(duration = 10, over: Partial<MediaAsset> = {}): MediaAsset {
  return createMediaAsset({ kind: 'video', name: 'a.mp4', duration, url: 'blob:a', ...over })
}

function clip(over: Partial<Clip> & { id: string }): Clip {
  return createClip({ mediaId: A.id, start: 0, duration: 1, inPoint: 0, ...over })
}

function lane(kind: TrackKind, id: string, clips: Clip[] = []): Track {
  return { ...createTrack(kind, 1), id, clips }
}

function doc(tracks: Track[], media: MediaAsset[]): Doc {
  const base = createDoc()
  return { project: { ...base.project, tracks }, media }
}

interface Span {
  id: string
  lane: string
  start: number
  duration: number
  inPoint: number
  linkId?: string
  transitionOut?: string
}

/** Flat, comparable clip layout of a doc (order within a lane = doc order). */
function layout(d: Doc): Span[] {
  const out: Span[] = []
  for (const t of d.project.tracks) {
    for (const c of t.clips) {
      out.push({
        id: c.id,
        lane: t.id,
        start: r(c.start),
        duration: r(c.duration),
        inPoint: r(c.inPoint),
        ...(c.linkId ? { linkId: c.linkId } : {}),
        ...(c.transitionOut ? { transitionOut: c.transitionOut.type } : {}),
      })
    }
  }
  return out
}

function commandsOf(plan: ReturnType<typeof planInsert>) {
  if (!plan.commands) throw new Error(`expected commands, got refusal ${plan.refusal}`)
  return plan.commands
}

const A = asset(30)

describe('planInsert', () => {
  it('shifts every clip at or after the point on the affected lane', () => {
    const d = doc(
      [
        lane('video', 'V1', [
          clip({ id: 'a', start: 0, duration: 2 }),
          clip({ id: 'b', start: 2, duration: 2 }),
        ]),
      ],
      [A],
    )
    const plan = planInsert(d, ['V1'], 2, 1)
    expect(commandsOf(plan)).toEqual([{ type: 'moveClip', clipId: 'b', trackId: 'V1', start: 3 }])
    expect(layout(applyCommands(d, commandsOf(plan)))).toEqual([
      { id: 'a', lane: 'V1', start: 0, duration: 2, inPoint: 0 },
      { id: 'b', lane: 'V1', start: 3, duration: 2, inPoint: 0 },
    ])
    // input untouched
    expect(layout(d)[1].start).toBe(2)
  })

  it('splits a straddler at the point and shifts the right half', () => {
    const d = doc([lane('video', 'V1', [clip({ id: 'a', start: 0, duration: 4 })])], [A])
    const commands = commandsOf(planInsert(d, ['V1'], 2, 1))
    expect(commands).toHaveLength(2)
    expect(commands[0]).toMatchObject({ type: 'splitClip', clipId: 'a', atTime: 2 })
    const rightId = (commands[0] as { rightId: string }).rightId
    expect(rightId).toBeTruthy()
    expect(commands[1]).toEqual({ type: 'moveClip', clipId: rightId, trackId: 'V1', start: 3 })
    const next = layout(applyCommands(d, commands))
    expect(next.map((s) => [s.start, s.duration, s.inPoint])).toEqual([
      [0, 2, 0],
      [3, 2, 2], // the right half reads source from the cut
    ])
  })

  it('splits a straddling pair with ONE shared rightLinkId; both halves shift', () => {
    const d = doc(
      [
        lane('video', 'V1', [clip({ id: 'v', start: 0, duration: 4, linkId: 'L' })]),
        lane('audio', 'A1', [
          clip({ id: 'a', start: 0, duration: 4, linkId: 'L', audioOnly: true }),
        ]),
      ],
      [A],
    )
    const commands = commandsOf(planInsert(d, ['V1', 'A1'], 2, 1))
    const splits = commands.filter((c) => c.type === 'splitClip')
    expect(splits).toHaveLength(2)
    const rightLinks = splits.map((c) => (c as { rightLinkId?: string }).rightLinkId)
    expect(rightLinks[0]).toBeTruthy()
    expect(rightLinks[0]).toBe(rightLinks[1])
    expect(rightLinks[0]).not.toBe('L')
    const next = layout(applyCommands(d, commands))
    expect(next.map((s) => [s.start, s.linkId])).toEqual([
      [0, 'L'],
      [3, rightLinks[0]],
      [0, 'L'],
      [3, rightLinks[0]],
    ])
  })

  it('a partner wholly after the point keeps its ORIGINAL linkId while it shifts', () => {
    // The cut crosses only the first member (group-split semantics: Ctrl+K at
    // the same point would leave the partner bonded to the left halves).
    const d = doc(
      [
        lane('video', 'V1', [clip({ id: 'v', start: 0, duration: 4, linkId: 'L' })]),
        lane('video', 'V2', [clip({ id: 'p', start: 6, duration: 2, linkId: 'L' })]),
      ],
      [A],
    )
    const commands = commandsOf(planInsert(d, ['V1'], 2, 1))
    const split = commands.find((c) => c.type === 'splitClip') as { rightLinkId: string }
    expect(split.rightLinkId).not.toBe('L')
    const next = layout(applyCommands(d, commands))
    expect(next).toEqual([
      { id: 'v', lane: 'V1', start: 0, duration: 2, inPoint: 0, linkId: 'L' },
      {
        id: expect.any(String),
        lane: 'V1',
        start: 3,
        duration: 2,
        inPoint: 2,
        linkId: split.rightLinkId,
      },
      { id: 'p', lane: 'V2', start: 7, duration: 2, inPoint: 0, linkId: 'L' },
    ])
  })

  it('headroom fallback: the clip and its partners stay, the rest of the lane commits', () => {
    const d = doc(
      [
        lane('video', 'V1', [
          clip({ id: 'v', start: 0, duration: 4, linkId: 'L' }),
          clip({ id: 'after', start: 6, duration: 2 }),
        ]),
        lane('video', 'V2', [clip({ id: 'p', start: 6, duration: 2, linkId: 'L' })]),
      ],
      [A],
    )
    // The cut at 0.05 leaves a 0.05s left side, under the split headroom: the
    // straddler and its group partner stay, while the lane's later clip shifts.
    const plan = planInsert(d, ['V1'], 0.05, 1)
    const next = layout(applyCommands(d, commandsOf(plan)))
    expect(next).toEqual([
      { id: 'v', lane: 'V1', start: 0, duration: 4, inPoint: 0, linkId: 'L' },
      { id: 'after', lane: 'V1', start: 7, duration: 2, inPoint: 0 },
      { id: 'p', lane: 'V2', start: 6, duration: 2, inPoint: 0, linkId: 'L' },
    ])
  })

  it('a left side inside the (headroom, headroom + EPS] band also falls back', () => {
    const d = doc([lane('video', 'V1', [clip({ id: 'v', start: 0, duration: 4 })])], [A])
    const left = MIN_SPLIT_HEADROOM + 5e-7
    const next = layout(applyCommands(d, commandsOf(planInsert(d, ['V1'], left, 1))))
    expect(next).toHaveLength(1)
    expect(next[0]).toMatchObject({ id: 'v', start: 0, duration: 4 })
  })

  it('insert past the last clip is a pure append (no displacement)', () => {
    const d = doc([lane('video', 'V1', [clip({ id: 'a', start: 0, duration: 2 })])], [A])
    expect(planInsert(d, ['V1'], 10, 1)).toEqual({ commands: [] })
  })

  it('pins a straddling crossfade onto the split right fragment', () => {
    const d = doc(
      [
        lane('video', 'V1', [
          clip({
            id: 'a',
            start: 0,
            duration: 4,
            transitionOut: { type: 'crossfade', duration: 0.5 },
          }),
        ]),
      ],
      [A],
    )
    const next = layout(applyCommands(d, commandsOf(planInsert(d, ['V1'], 2, 1))))
    expect(next[0].transitionOut).toBeUndefined()
    expect(next[1].transitionOut).toBe('crossfade')
  })

  it('expands chained groups through a shared lane to closure', () => {
    // v (LA) on V1, y (LA + LB) on V2, z (LB) on V3: the chain must reach V3.
    const d = doc(
      [
        lane('video', 'V1', [clip({ id: 'v', start: 0, duration: 4, linkId: 'LA' })]),
        lane('video', 'V2', [
          clip({ id: 'y', start: 0, duration: 4, linkId: 'LA' }),
          clip({ id: 'w', start: 0, duration: 4, linkId: 'LB' }),
        ]),
        lane('video', 'V3', [clip({ id: 'z', start: 0, duration: 4, linkId: 'LB' })]),
      ],
      [A],
    )
    const next = layout(applyCommands(d, commandsOf(planInsert(d, ['V1'], 2, 1))))
    expect(
      next
        .filter((s) => s.lane === 'V3')
        .map((s) => s.start)
        .sort((a, b) => a - b),
    ).toEqual([0, 3])
  })

  it('a sub-floor span refuses before building anything', () => {
    const d = doc([lane('video', 'V1', [clip({ id: 'a', start: 0, duration: 2 })])], [A])
    expect(planInsert(d, ['V1'], 0, MIN_CLIP_DURATION - 5e-5)).toEqual({
      commands: null,
      refusal: 'span',
    })
  })
})

describe('planOverwrite', () => {
  it('trims a partial head and a partial tail', () => {
    const d = doc(
      [
        lane('video', 'V1', [
          clip({ id: 'a', start: 0, duration: 3 }),
          clip({ id: 'b', start: 3, duration: 4 }),
        ]),
      ],
      [A],
    )
    const commands = commandsOf(planOverwrite(d, ['V1'], 2, 2))
    expect(commands).toEqual([
      { type: 'trimClip', clipId: 'a', start: 0, inPoint: 0, duration: 2, edge: 'tail' },
      { type: 'trimClip', clipId: 'b', start: 4, inPoint: 1, duration: 3, edge: 'head' },
    ])
    expect(layout(applyCommands(d, commands))).toEqual([
      { id: 'a', lane: 'V1', start: 0, duration: 2, inPoint: 0 },
      { id: 'b', lane: 'V1', start: 4, duration: 3, inPoint: 1 },
    ])
  })

  it('splits interior coverage once and head-trims the right fragment', () => {
    const d = doc([lane('video', 'V1', [clip({ id: 'a', start: 0, duration: 6 })])], [A])
    const commands = commandsOf(planOverwrite(d, ['V1'], 2, 2))
    expect(commands.map((c) => c.type)).toEqual(['splitClip', 'trimClip'])
    // The stored anchor is the POST-move one (source 4), not the split point (2).
    expect(commands[1]).toMatchObject({ start: 4, inPoint: 4, duration: 2, edge: 'head' })
    const next = layout(applyCommands(d, commands))
    expect(next.map((s) => [s.start, s.duration, s.inPoint])).toEqual([
      [0, 2, 0],
      [4, 2, 4],
    ])
  })

  it('deletes a sub-floor remnant and a fully covered clip', () => {
    const remnant = doc(
      [lane('video', 'V1', [clip({ id: 'r', start: 3.98, duration: 0.06 })])],
      [A],
    )
    const remnantCommands = commandsOf(planOverwrite(remnant, ['V1'], 2, 2))
    expect(remnantCommands).toEqual([{ type: 'deleteClip', clipId: 'r' }])

    const covered = doc(
      [
        lane('video', 'V1', [clip({ id: 'c', start: 2.5, duration: 1 })]),
        lane('video', 'V2', [clip({ id: 'keep', start: 0, duration: 1 })]),
      ],
      [A],
    )
    const coveredNext = applyCommands(covered, commandsOf(planOverwrite(covered, ['V1'], 2, 2)))
    expect(coveredNext.project.tracks[0].clips).toHaveLength(0)
    // Invariant 17: a lane whose last clip this edit removed goes with it.
    expect(pruneEmptiedTracks(covered, coveredNext).project.tracks.map((t) => t.id)).toEqual(['V2'])
  })

  it('no-ops on empty space', () => {
    const d = doc([lane('video', 'V1', [clip({ id: 'a', start: 8, duration: 2 })])], [A])
    expect(planOverwrite(d, ['V1'], 2, 2)).toEqual({ commands: [] })
  })

  it('a span of exactly 0.1s overwrites through one cut plus a head-trim', () => {
    const d = doc([lane('video', 'V1', [clip({ id: 'a', start: 0, duration: 1 })])], [A])
    const commands = commandsOf(planOverwrite(d, ['V1'], 0.2, MIN_CLIP_DURATION))
    expect(commands.map((c) => c.type)).toEqual(['splitClip', 'trimClip'])
    expect(layout(applyCommands(d, commands)).map((s) => [s.start, s.duration])).toEqual([
      [0, 0.2],
      [0.3, 0.7],
    ])
  })

  it('a clip head exactly at the point is kept whole and head-trimmed', () => {
    const d = doc([lane('video', 'V1', [clip({ id: 'a', start: 2, duration: 2 })])], [A])
    const commands = commandsOf(planOverwrite(d, ['V1'], 2, 1))
    expect(commands).toEqual([
      { type: 'trimClip', clipId: 'a', start: 3, inPoint: 1, duration: 1, edge: 'head' },
    ])
  })

  it('a clip end exactly at the far edge is kept whole and tail-trimmed', () => {
    const d = doc([lane('video', 'V1', [clip({ id: 'a', start: 0, duration: 3 })])], [A])
    const commands = commandsOf(planOverwrite(d, ['V1'], 2, 1))
    expect(commands).toEqual([
      { type: 'trimClip', clipId: 'a', start: 0, inPoint: 0, duration: 2, edge: 'tail' },
    ])
  })

  it('a remnant computing to exactly the floor survives; one in the band is clamped up', () => {
    const exact = doc([lane('video', 'V1', [clip({ id: 'a', start: 1.9, duration: 0.2 })])], [A])
    const exactCommand = commandsOf(planOverwrite(exact, ['V1'], 2, 1))[0]
    expect(exactCommand).toMatchObject({ type: 'trimClip', edge: 'tail' })
    expect((exactCommand as { duration: number }).duration).toBeCloseTo(MIN_CLIP_DURATION, 6)

    // left lands 5e-7 UNDER the floor: inside the band the comparison rule
    // passes, so the payload clamps up to exactly MIN_CLIP_DURATION.
    const band = doc(
      [
        lane('video', 'V1', [
          clip({ id: 'a', start: 2 - (MIN_CLIP_DURATION - 5e-7), duration: 0.2 }),
        ]),
      ],
      [A],
    )
    const commands = commandsOf(planOverwrite(band, ['V1'], 2, 1))
    expect(commands[0]).toMatchObject({ type: 'trimClip', edge: 'tail' })
    expect((commands[0] as { duration: number }).duration).toBe(MIN_CLIP_DURATION)
  })

  it('refuses the WHOLE placement when a retained side cannot be represented', () => {
    const d = doc(
      [
        lane('video', 'V1', [clip({ id: 'a', start: 0, duration: 4 })]),
        lane('video', 'V2', [clip({ id: 'clean', start: 0, duration: 2 })]),
      ],
      [A],
    )
    // left = 0.05 (inside the headroom band): the interior cut is unrepresentable.
    expect(planOverwrite(d, ['V1', 'V2'], 0.05, 1)).toEqual({
      commands: null,
      refusal: 'geometry',
    })
    // A left side sitting exactly ON the headroom is refused by the shared rule.
    expect(planOverwrite(d, ['V1', 'V2'], MIN_SPLIT_HEADROOM, 1)).toEqual({
      commands: null,
      refusal: 'geometry',
    })
    // right = 0.05: under the fragment floor, interior coverage only.
    expect(planOverwrite(d, ['V1', 'V2'], 3, 0.95)).toEqual({ commands: null, refusal: 'geometry' })
  })

  it('refuses through the source-bound guard on a stored over-consuming ramp', () => {
    const rampAsset = asset(4)
    const d = doc(
      [
        lane('video', 'V1', [
          clip({
            id: 'a',
            mediaId: rampAsset.id,
            start: 0,
            duration: 4,
            keyframes: { timeScale: [{ time: 0, value: 2 }] },
          }),
        ]),
      ],
      [rampAsset],
    )
    // The ramp consumes 8s of a 4s asset: legal on add (frozen at render), but
    // a trim the command layer would clamp/reject, so the plan refuses first.
    expect(planOverwrite(d, ['V1'], 1, 1)).toEqual({ commands: null, refusal: 'source' })
  })

  it('refuses when the floor clamp would push the payload past the asset end', () => {
    // 4x clip ending exactly on its 6s asset's end; the right fragment lands
    // 5e-7 under the floor, so the clamp spends 2e-6s past the end.
    const fastAsset = asset(6)
    const d = doc(
      [
        lane('video', 'V1', [
          clip({ id: 'a', mediaId: fastAsset.id, start: 0, duration: 1.5, speed: 4 }),
        ]),
      ],
      [fastAsset],
    )
    expect(planOverwrite(d, ['V1'], 0.5, 0.9000005)).toEqual({
      commands: null,
      refusal: 'source',
    })
  })

  it('an overwrite of one half of an existing pair edits the twin lane too', () => {
    const d = doc(
      [
        lane('video', 'V1', [clip({ id: 'v', start: 0, duration: 2, linkId: 'L' })]),
        lane('audio', 'A1', [
          clip({ id: 'a', start: 0, duration: 2, linkId: 'L', audioOnly: true }),
        ]),
      ],
      [A],
    )
    const commands = commandsOf(planOverwrite(d, ['V1'], 0, 1))
    expect(commands.map((c) => ('clipId' in c ? c.clipId : null))).toEqual(['v', 'a'])
    expect(layout(applyCommands(d, commands))).toEqual([
      { id: 'v', lane: 'V1', start: 1, duration: 1, inPoint: 1, linkId: 'L' },
      { id: 'a', lane: 'A1', start: 1, duration: 1, inPoint: 1, linkId: 'L' },
    ])
  })

  it('an interior overwrite across an aligned pair re-pairs BOTH right fragments', () => {
    const d = doc(
      [
        lane('video', 'V1', [clip({ id: 'v', start: 0, duration: 4, linkId: 'L' })]),
        lane('audio', 'A1', [
          clip({ id: 'a', start: 0, duration: 4, linkId: 'L', audioOnly: true }),
        ]),
      ],
      [A],
    )
    const commands = commandsOf(planOverwrite(d, ['V1', 'A1'], 1, 2))
    const splits = commands.filter((c) => c.type === 'splitClip')
    const links = splits.map((c) => (c as { rightLinkId: string }).rightLinkId)
    expect(links[0]).toBe(links[1])
    expect(links[0]).not.toBe('L')
    const next = layout(applyCommands(d, commands))
    expect(next.map((s) => [s.id, s.start, s.linkId])).toEqual([
      ['v', 0, 'L'],
      [expect.any(String), 3, links[0]],
      ['a', 0, 'L'],
      [expect.any(String), 3, links[0]],
    ])
  })

  it('a linked member outside the window is left untouched', () => {
    const d = doc(
      [
        lane('video', 'V1', [clip({ id: 'v', start: 0, duration: 2, linkId: 'L' })]),
        lane('audio', 'A1', [
          clip({ id: 'a', start: 5, duration: 2, linkId: 'L', audioOnly: true }),
        ]),
      ],
      [A],
    )
    const next = layout(applyCommands(d, commandsOf(planOverwrite(d, ['V1'], 0, 1))))
    expect(next.find((s) => s.id === 'a')).toMatchObject({ start: 5, duration: 2 })
  })

  it('a trim on a REVERSED clip keeps the frames the cut landed on', () => {
    const revAsset = asset(30)
    const d = doc(
      [
        lane('video', 'V1', [
          clip({ id: 'a', mediaId: revAsset.id, start: 0, duration: 4, reverse: true }),
        ]),
      ],
      [revAsset],
    )
    const before = d.project.tracks[0].clips[0]
    const after = applyCommands(d, commandsOf(planOverwrite(d, ['V1'], 2, 1))).project.tracks[0]
      .clips[1]
    expect(after.start).toBeCloseTo(3, 6)
    for (const local of [0, 0.5, 1]) {
      expect(sourceTimeAt(after, local)).toBeCloseTo(sourceTimeAt(before, local + 3), 6)
    }
  })

  it('a trim on a 2x clip lands on the frames trimClip derives', () => {
    const fastAsset = asset(30)
    const d = doc(
      [
        lane('video', 'V1', [
          clip({ id: 'a', mediaId: fastAsset.id, start: 0, duration: 4, speed: 2 }),
        ]),
      ],
      [fastAsset],
    )
    const before = d.project.tracks[0].clips[0]
    const commands = commandsOf(planOverwrite(d, ['V1'], 1, 1))
    expect(commands[1]).toMatchObject({ inPoint: 4, start: 2, duration: 2, edge: 'head' })
    const after = applyCommands(d, commands).project.tracks[0].clips[1]
    for (const local of [0, 0.5, 1, 2]) {
      expect(sourceTimeAt(after, local)).toBeCloseTo(sourceTimeAt(before, local + 2), 6)
    }
  })

  it('a trim on a time-remapped clip rebases the curve onto the cut', () => {
    const rampAsset = asset(30)
    const d = doc(
      [
        lane('video', 'V1', [
          clip({
            id: 'a',
            mediaId: rampAsset.id,
            start: 0,
            duration: 4,
            keyframes: {
              timeScale: [
                { time: 0, value: 1 },
                { time: 4, value: 2 },
              ],
            },
          }),
        ]),
      ],
      [rampAsset],
    )
    const before = d.project.tracks[0].clips[0]
    const after = applyCommands(d, commandsOf(planOverwrite(d, ['V1'], 1, 1))).project.tracks[0]
      .clips[1]
    expect(after.start).toBeCloseTo(2, 6)
    for (const local of [0, 0.25, 0.5, 1, 2]) {
      expect(sourceTimeAt(after, local)).toBeCloseTo(sourceTimeAt(before, local + 2), 5)
    }
  })
})

describe('placement span guard', () => {
  it('a span inside the -EPS band is clamped up to the floor', () => {
    const d = doc([lane('video', 'V1', [clip({ id: 'a', start: 0, duration: 4 })])], [A])
    const commands = commandsOf(planOverwrite(d, ['V1'], 0, MIN_CLIP_DURATION - 5e-7))
    expect(commands.length).toBeGreaterThan(0)
  })

  it('a span under the floor band refuses in both modes', () => {
    const d = doc([lane('video', 'V1', [])], [A])
    for (const plan of [planInsert(d, ['V1'], 0, 0.05), planOverwrite(d, ['V1'], 0, 0.05)]) {
      expect(plan).toEqual({ commands: null, refusal: 'span' })
    }
  })
})
