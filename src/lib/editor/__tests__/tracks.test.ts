/**
 * Tests for pruneEmptiedTracks — the rule behind "an empty layer does not
 * linger": the edit that takes a lane's last clip takes the lane with it.
 *
 * The three things that must never happen: removing a lane that was already
 * empty (that would eat the lane you just added), removing the last lane (the
 * model requires one), and removing anything when nothing was emptied.
 */
import { describe, expect, it } from 'vitest'
import { pruneEmptiedTracks, pruneOrphanSequences } from '../tracks'
import { createClip, createDoc } from '../factories'
import type { Doc, TrackKind } from '../types'

/** Structural doc: a list of [kind, clipCount] lanes, ids t0..tN. */
function docWith(lanes: [TrackKind, number][]): Doc {
  const base = createDoc()
  return {
    ...base,
    project: {
      ...base.project,
      tracks: lanes.map(([kind, count], i) => ({
        id: `t${i}`,
        kind,
        name: `${kind}${i}`,
        clips: Array.from({ length: count }, (_, c) => createClip({ mediaId: `m${i}-${c}` })),
      })),
    },
  }
}

describe('pruneEmptiedTracks', () => {
  it('removes the lane this edit emptied', () => {
    const prev = docWith([
      ['video', 1],
      ['audio', 1],
    ])
    const next = docWith([
      ['video', 0],
      ['audio', 1],
    ])
    const pruned = pruneEmptiedTracks(prev, next)
    expect(pruned.project.tracks.map((t) => t.id)).toEqual(['t1'])
  })

  it('keeps a lane that was ALREADY empty (add-a-lane-then-fill-it survives)', () => {
    const prev = docWith([
      ['video', 1],
      ['audio', 0],
    ])
    const next = docWith([
      ['video', 1],
      ['audio', 0],
    ])
    expect(pruneEmptiedTracks(prev, next)).toBe(next)
  })

  it('never removes the last lane', () => {
    const prev = docWith([['video', 1]])
    const next = docWith([['video', 0]])
    const pruned = pruneEmptiedTracks(prev, next)
    expect(pruned.project.tracks).toHaveLength(1)
    expect(pruned).toBe(next)
  })

  it('keeps one lane when a single edit emptied every lane', () => {
    const prev = docWith([
      ['video', 1],
      ['audio', 2],
    ])
    const next = docWith([
      ['video', 0],
      ['audio', 0],
    ])
    const pruned = pruneEmptiedTracks(prev, next)
    expect(pruned.project.tracks.map((t) => t.id)).toEqual(['t0'])
  })

  it('removes only the emptied lane, preserving order and the other lanes', () => {
    const prev = docWith([
      ['text', 2],
      ['video', 1],
      ['audio', 3],
    ])
    const next = docWith([
      ['text', 2],
      ['video', 0],
      ['audio', 3],
    ])
    const pruned = pruneEmptiedTracks(prev, next)
    expect(pruned.project.tracks.map((t) => t.id)).toEqual(['t0', 't2'])
    expect(pruned.project.tracks[0].clips).toHaveLength(2)
    expect(pruned.project.tracks[1].clips).toHaveLength(3)
  })

  it('is a no-op for a lane added by the same edit (empty, never had clips)', () => {
    const prev = docWith([['video', 1]])
    const next = docWith([
      ['video', 1],
      ['video', 0],
    ])
    const pruned = pruneEmptiedTracks(prev, next)
    expect(pruned.project.tracks.map((t) => t.id)).toEqual(['t0', 't1'])
    expect(pruned).toBe(next)
  })
})

describe('pruneOrphanSequences and unchanged roots (0.29.0)', () => {
  it('returns the same doc when a root lane is unchanged and no sequences exist', () => {
    const prev = docWith([['video', 1]])
    expect(pruneEmptiedTracks(prev, prev)).toBe(prev)
  })

  it('drops every unreachable sequence and keeps a reachable cycle once', () => {
    const doc = docWith([['video', 0]])
    doc.project.sequences = [
      { id: 'a', name: 'A', tracks: [] },
      { id: 'b', name: 'B', tracks: [] },
    ] as never
    // No root compound references: both are orphaned and disappear.
    const pruned = pruneOrphanSequences(doc)
    expect(pruned.project.sequences).toBeUndefined()
  })
})

describe('reachable sequence cycles (0.29.0)', () => {
  it('keeps a reachable cycle and drops an orphan in the same pass', () => {
    const doc = docWith([['video', 0]])
    doc.project.tracks[0]!.clips = [
      createClip({ id: 'root', start: 0, duration: 1, sequenceId: 'a' }),
    ]
    doc.project.sequences = [
      {
        id: 'a',
        name: 'A',
        tracks: [
          {
            id: 'ta',
            kind: 'video',
            name: 'V',
            clips: [{ id: 'ca', start: 0, duration: 1, sequenceId: 'b' }],
          },
        ],
      },
      {
        id: 'b',
        name: 'B',
        tracks: [
          {
            id: 'tb',
            kind: 'video',
            name: 'V',
            clips: [{ id: 'cb', start: 0, duration: 1, sequenceId: 'a' }],
          },
        ],
      },
      { id: 'orphan', name: 'O', tracks: [] },
    ] as never
    const pruned = pruneOrphanSequences(doc)
    expect(pruned.project.sequences!.map((s) => s.id)).toEqual(['a', 'b'])
  })
})
