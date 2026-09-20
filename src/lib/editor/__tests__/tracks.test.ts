/**
 * Tests for pruneEmptiedTracks — the rule behind "an empty layer does not
 * linger": the edit that takes a lane's last clip takes the lane with it.
 *
 * The three things that must never happen: removing a lane that was already
 * empty (that would eat the lane you just added), removing the last lane (the
 * model requires one), and removing anything when nothing was emptied.
 */
import { describe, expect, it } from 'vitest'
import { pruneEmptiedTracks } from '../tracks'
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
