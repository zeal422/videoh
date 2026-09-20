import { describe, expect, it } from 'vitest'
import {
  decideMove,
  decideTrimEnd,
  decideTrimStart,
  resolveLaneDrop,
  snapThreshold,
  type LaneBox,
} from '../clip-gesture'
import { MIN_CLIP_DURATION, SNAP_THRESHOLD_PX } from '../constants'
import type { Clip } from '../types'

const clip = (over: Partial<Clip> = {}): Clip =>
  ({
    id: 'c1',
    trackId: 't1',
    mediaId: 'm1',
    start: 2,
    duration: 4,
    inPoint: 0,
    ...over,
  }) as Clip

const lanes = (over: Partial<LaneBox>[] = []): LaneBox[] => [
  { id: 't1', kind: 'video', top: 0, bottom: 50, ...over[0] },
  { id: 't2', kind: 'video', top: 50, bottom: 100, ...over[1] },
  { id: 'a1', kind: 'audio', top: 100, bottom: 150, ...over[2] },
]

const tracks = [
  { id: 't1', kind: 'video' },
  { id: 't2', kind: 'video' },
  { id: 'a1', kind: 'audio' },
]

describe('snapThreshold', () => {
  it('is SNAP_THRESHOLD_PX divided by the zoom scale', () => {
    expect(snapThreshold(20)).toBe(SNAP_THRESHOLD_PX / 20)
    expect(snapThreshold(10)).toBeGreaterThan(snapThreshold(40))
  })
})

describe('resolveLaneDrop', () => {
  it('finds the lane under the pointer', () => {
    expect(resolveLaneDrop(lanes(), 75, 't1', 'video').laneId).toBe('t2')
  })
  it('returns null when the pointer is over no lane', () => {
    expect(resolveLaneDrop(lanes(), 999, 't1', 'video').laneId).toBeNull()
  })
  it('the original lane is never blocked', () => {
    const r = resolveLaneDrop(lanes(), 25, 't1', 'video')
    expect(r.laneId).toBe('t1')
    expect(r.blocked).toBeNull()
  })
  it('an incompatible lane is reported blocked', () => {
    const r = resolveLaneDrop(lanes(), 125, 't1', 'video')
    expect(r.blocked).toEqual({ id: 'a1', kind: 'audio' })
  })
  it('video clips may land on video lanes only (audio is blocked)', () => {
    expect(resolveLaneDrop(lanes(), 75, 't1', 'video').blocked).toBeNull()
  })
})

describe('decideMove', () => {
  const base = {
    orig: clip(),
    origTrackId: 't1',
    origTrackKind: 'video',
    startX: 100,
    lanes: lanes(),
    tracks,
    scale: 10,
    snapping: false,
    snapPoints: [],
    partners: [],
  }

  it('moves the start by the pointer delta in seconds', () => {
    const d = decideMove({ ...base, clientX: 160, clientY: 25, lanes: lanes() })
    expect(d.start).toBe(8) // 2 + 60px / 10px-per-sec
    expect(d.targetTrackId).toBe('t1')
    expect(d.blockedLane).toBeNull()
  })

  it('never moves before 0', () => {
    const d = decideMove({
      ...base,
      orig: clip({ start: 1 }),
      clientX: 0,
      clientY: 25,
      lanes: lanes(),
    })
    expect(d.start).toBe(0)
  })

  it('moves to a compatible lane under the pointer', () => {
    const d = decideMove({ ...base, clientX: 100, clientY: 75, lanes: lanes() })
    expect(d.targetTrackId).toBe('t2')
  })

  it('reports a blocked lane instead of moving to it', () => {
    const d = decideMove({ ...base, clientX: 100, clientY: 125, lanes: lanes() })
    expect(d.targetTrackId).toBe('t1')
    expect(d.blockedLane).toEqual({ id: 'a1', kind: 'audio' })
  })

  it('drags the whole selection: same time delta, same track-index offset', () => {
    const d = decideMove({
      ...base,
      clientX: 160,
      clientY: 75, // one lane down
      lanes: lanes(),
      partners: [{ id: 'p1', trackIndex: 2, kind: 'audio', origStart: 5 }],
    })
    expect(d.start).toBe(8)
    expect(d.partnerUpdates).toEqual([
      { clipId: 'p1', trackId: 'a1', start: 11 }, // +3s delta, +1 lane offset
    ])
  })

  it('a partner whose shifted lane is missing or a different kind stays put in time only', () => {
    const d = decideMove({
      ...base,
      clientX: 160,
      clientY: 125, // blocked drop: no lane change
      lanes: lanes(),
      partners: [{ id: 'p1', trackIndex: 9, kind: 'audio', origStart: 5 }],
    })
    expect(d.partnerUpdates).toEqual([])
  })

  it('snaps the closer edge (head) onto a snap point', () => {
    const d = decideMove({
      ...base,
      clientX: 158, // raw start 7.8, head close to 8
      clientY: 25,
      lanes: lanes(),
      snapping: true,
      snapPoints: [8],
    })
    expect(d.start).toBe(8)
    expect(d.snapped).toBe(8)
  })

  it('snaps the tail when the tail edge is the closer one', () => {
    const d = decideMove({
      ...base,
      clientX: 185, // raw start 10.5, tail = 14.5 close to 15
      clientY: 25,
      lanes: lanes(),
      snapping: true,
      snapPoints: [15],
    })
    expect(d.start).toBe(11) // 15 - duration 4
    expect(d.snapped).toBe(15)
  })
})

describe('decideTrimStart', () => {
  const base = {
    orig: clip({ start: 2, duration: 4 }),
    isUnbounded: false,
    startX: 100,
    scale: 10,
    snapping: false,
    snapPoints: [],
  }

  it('trims the head: start moves, duration shrinks, inPoint follows', () => {
    const d = decideTrimStart({ ...base, clientX: 130 })
    expect(d.start).toBe(5)
    expect(d.duration).toBe(1)
    expect(d.inPoint).toBe(3)
  })

  it('cannot reveal source before 0 (inPoint floor)', () => {
    const d = decideTrimStart({
      ...base,
      orig: clip({ start: 2, duration: 4, inPoint: 1 }),
      clientX: 0,
    })
    expect(d.inPoint).toBe(0)
    expect(d.start).toBe(1)
  })

  it('cannot shrink below MIN_CLIP_DURATION', () => {
    const d = decideTrimStart({ ...base, clientX: 1000 })
    expect(d.duration).toBeCloseTo(MIN_CLIP_DURATION, 10)
  })

  it('unbounded media (image/text) keeps inPoint 0 and cannot pass the left edge', () => {
    const d = decideTrimStart({
      ...base,
      orig: clip({ start: 1, duration: 4 }),
      isUnbounded: true,
      clientX: 0,
    })
    expect(d.inPoint).toBe(0)
    expect(d.start).toBeGreaterThanOrEqual(0)
    expect(d.duration).toBeGreaterThanOrEqual(MIN_CLIP_DURATION)
  })

  it('snaps the new start onto a snap point', () => {
    const d = decideTrimStart({ ...base, clientX: 128, snapping: true, snapPoints: [4.8] })
    expect(d.start).toBe(4.8)
    expect(d.snapped).toBe(4.8)
  })

  it('rejects a snap point past the clamp bounds (head trim)', () => {
    // Legal start window: [1, 5.9] (inPoint 1 floors the pull, MIN floors the tail).
    // Raw start clamps to 5.9; a snap point at 6.5 sits within the 0.8s threshold
    // of the clamped value but OUTSIDE the legal window: accepting it would push
    // duration below MIN. The clamped position must survive instead.
    const d = decideTrimStart({
      ...base,
      orig: clip({ start: 2, duration: 4, inPoint: 1 }),
      clientX: 164, // raw delta 6.4 → clamped to maxDelta 5.9
      snapping: true,
      snapPoints: [6.5],
    })
    expect(d.start).toBeCloseTo(5.9, 10)
    expect(d.snapped).toBeNull()
  })
})

describe('decideTrimEnd', () => {
  const base = {
    origStart: 2,
    origDuration: 4,
    maxDuration: 20,
    startX: 100,
    scale: 10,
    snapping: false,
    snapPoints: [],
  }

  it('grows and shrinks the duration by the pointer delta', () => {
    expect(decideTrimEnd({ ...base, clientX: 160 }).duration).toBe(10)
    expect(decideTrimEnd({ ...base, clientX: 130 }).duration).toBe(7)
  })

  it('cannot shrink below MIN_CLIP_DURATION', () => {
    expect(decideTrimEnd({ ...base, clientX: -1000 }).duration).toBeCloseTo(MIN_CLIP_DURATION, 10)
  })

  it('bounded media cannot extend past maxDuration', () => {
    expect(decideTrimEnd({ ...base, maxDuration: 6, clientX: 1000 }).duration).toBe(6)
  })

  it('unbounded media (image/text) extends freely', () => {
    expect(decideTrimEnd({ ...base, maxDuration: Infinity, clientX: 1000 }).duration).toBe(94)
  })

  it('snaps the tail onto a snap point', () => {
    const d = decideTrimEnd({
      ...base,
      maxDuration: Infinity,
      clientX: 139, // raw end 2 + 4 + 3.9 = 9.9
      snapping: true,
      snapPoints: [9.9],
    })
    expect(d.duration).toBeCloseTo(7.9, 10)
    expect(d.snapped).toBeCloseTo(9.9, 10)
  })

  it('rejects a snap point past the media boundary (tail trim)', () => {
    // Asset ends at origStart + maxDuration = 8. The raw end clamps to 8; a
    // snap point at 8.5 sits within the 0.8s threshold of the clamped end but
    // past the boundary: accepting it would extend the clip past the asset.
    const d = decideTrimEnd({
      ...base,
      maxDuration: 6,
      clientX: 160, // raw duration 10 → clamped to 6
      snapping: true,
      snapPoints: [8.5],
    })
    expect(d.duration).toBe(6)
    expect(d.snapped).toBeNull()
  })
})
