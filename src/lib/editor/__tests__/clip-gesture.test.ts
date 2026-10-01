import { describe, expect, it } from 'vitest'
import {
  decideMove,
  decideRateStretch,
  decideTrimEnd,
  decideTrimStart,
  resolveLaneDrop,
  snapThreshold,
  trimRooms,
  type LaneBox,
} from '../clip-gesture'
import { MIN_CLIP_DURATION, SNAP_THRESHOLD_PX, SPEED_MAX, SPEED_MIN } from '../constants'
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
  // headRoom is the caller's (see trimRooms): a forward clip's head shows its
  // inPoint, so these fixtures hand in exactly that.
  const base = {
    orig: clip({ start: 2, duration: 4 }),
    isUnbounded: false,
    headRoom: 0,
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
      headRoom: 1,
      clientX: 0,
    })
    expect(d.inPoint).toBe(0)
    expect(d.start).toBe(1)
  })

  it('grows the head into the room the caller reports, not into inPoint', () => {
    // A REVERSED clip's head shows the span's HIGH source end, so its room has
    // nothing to do with inPoint: with a room of 3 the head may move 3s left even
    // though inPoint is 0. The decision's own inPoint output is the forward-math
    // artifact the command replaces for a reversed clip.
    const d = decideTrimStart({
      ...base,
      orig: clip({ start: 4, duration: 2, inPoint: 0, reverse: true }),
      headRoom: 3,
      clientX: 60, // -4s raw, clamped to the 3s room
    })
    expect(d.start).toBe(1)
    expect(d.duration).toBe(5)
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
      headRoom: 1,
      clientX: 164, // raw delta 6.4 → clamped to maxDelta 5.9
      snapping: true,
      snapPoints: [6.5],
    })
    expect(d.start).toBeCloseTo(5.9, 10)
    expect(d.snapped).toBeNull()
  })
})

describe('trimRooms', () => {
  // 10s asset, a 3s span starting at source 2: the numbers are deliberately
  // asymmetric so a mirrored room cannot coincidentally equal its forward twin.
  const base = {
    bounded: true,
    reverse: false,
    inPoint: 2,
    duration: 3,
    speed: 1,
    assetDuration: 10,
  }

  it('a forward clip draws on inPoint at the head and the rest of the asset at the tail', () => {
    const rooms = trimRooms(base)
    expect(rooms.head).toBe(2)
    expect(rooms.maxDuration).toBe(8)
  })

  it('mirrors both rooms for a reversed clip, whose head shows the HIGH source end', () => {
    const rooms = trimRooms({ ...base, reverse: true })
    // Head: what the asset holds above the span (10 - 2 - 3). Tail: the source
    // below the low anchor (2), i.e. the span may grow to 3 + 2 seconds.
    expect(rooms.head).toBe(5)
    expect(rooms.maxDuration).toBe(5)
  })

  it('turns source seconds into timeline seconds through the rate', () => {
    // At 2x a timeline second consumes two source seconds, so the mirrored head
    // room halves (10 - 2 - 6) / 2 and the tail room becomes 2 / 2.
    const rooms = trimRooms({ ...base, reverse: true, speed: 2 })
    expect(rooms.head).toBe(1)
    expect(rooms.maxDuration).toBe(4)
  })

  it('scales the forward rooms by the rate too', () => {
    // Forward at 2x: the head room is the source below inPoint in timeline
    // seconds (2 / 2), and the tail room is the source after the span end
    // (10 - 2) divided by the same rate: 4s, not 8.
    const rooms = trimRooms({ ...base, speed: 2 })
    expect(rooms.head).toBe(1)
    expect(rooms.maxDuration).toBe(4)
  })

  it('reports no limit at all for unbounded material', () => {
    expect(trimRooms({ ...base, bounded: false })).toEqual({
      head: Infinity,
      maxDuration: Infinity,
    })
  })

  it('floors the tail room at MIN_CLIP_DURATION even for an exhausted source', () => {
    // A clip sitting on the last sliver of its asset: the maximum duration can
    // never drop below the smallest legal clip.
    const rooms = trimRooms({ ...base, inPoint: 9.95, duration: 0.05, assetDuration: 10 })
    expect(rooms.maxDuration).toBe(MIN_CLIP_DURATION)
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

describe('decideRateStretch (Alt-drag on an edge)', () => {
  const base = {
    mode: 'trim-end' as 'trim-end' | 'trim-start',
    origStart: 2,
    origDuration: 4,
    origInPoint: 1,
    origSpeed: 1,
    startX: 100,
    scale: 10,
    assetDuration: 100,
  }

  it('end edge: source span is fixed, speed re-derives from the new duration', () => {
    // Drag from 4s to 8s at 1x: the same 4s of source now plays over 8s → 0.5x.
    const d = decideRateStretch({ ...base, clientX: 140 })
    expect(d.start).toBe(2)
    expect(d.duration).toBe(8)
    expect(d.speed).toBeCloseTo(0.5, 10)
    expect(d.inPoint).toBe(1)
  })

  it('end edge: shorter duration stretches the source faster', () => {
    const d = decideRateStretch({ ...base, clientX: 80 }) // 4s → 2s
    expect(d.duration).toBe(2)
    expect(d.speed).toBeCloseTo(2, 10)
  })

  it('start edge: the right edge stays anchored, start and duration move', () => {
    // Anchor end = 6. Drag left by 2s: start 0, duration 6, speed 4/6.
    const d = decideRateStretch({ ...base, mode: 'trim-start', clientX: 80 })
    expect(d.start).toBeCloseTo(0, 10)
    expect(d.duration).toBe(6)
    expect(d.speed).toBeCloseTo(4 / 6, 10)
  })

  it('start edge: never pushes the start below 0', () => {
    const d = decideRateStretch({ ...base, mode: 'trim-start', clientX: -1000 })
    expect(d.start).toBeGreaterThanOrEqual(0)
  })

  it('clamps speed into SPEED_MIN..SPEED_MAX and keeps duration/speed consistent', () => {
    const fast = decideRateStretch({ ...base, clientX: -10000 })
    expect(fast.speed).toBe(SPEED_MAX)
    expect(fast.duration).toBeCloseTo((4 * 1) / SPEED_MAX, 10)
    const slow = decideRateStretch({ ...base, clientX: 100000 })
    expect(slow.speed).toBe(SPEED_MIN)
    expect(slow.duration).toBeCloseTo(4 / SPEED_MIN, 10)
  })

  it('a pre-stretched clip stretches relative to its own span, not its duration', () => {
    // 4s at 2x consumed 8s of source; dragging to 4s again (no movement) is a no-op.
    const d = decideRateStretch({ ...base, origSpeed: 2, clientX: 100 })
    expect(d.duration).toBe(4)
    expect(d.speed).toBeCloseTo(2, 10)
  })

  it('clamps an over-consuming window to the asset so the drag still applies', () => {
    // A relink to shorter media replaces the asset and leaves clip windows
    // untouched, so a span can overrun what the asset can still read. Holding
    // that span fixed made every pointer position illegal (the trim's own
    // guard rejected the pair); clamping the span to the readable tail makes
    // the pair satisfiable, and the drag recovers the clip.
    const d = decideRateStretch({
      ...base,
      origInPoint: 8,
      assetDuration: 11, // only 3s of source remain, the span was 4s
      clientX: 140, // raw duration 8
    })
    expect(d.inPoint).toBe(8)
    expect(d.speed).toBeCloseTo(3 / 8, 10)
    expect(d.duration).toBeCloseTo(8, 10)
    expect(d.fits).toBe(true)
    expect(d.inPoint + d.duration * d.speed).toBeLessThanOrEqual(11 + 1e-6)
  })

  it('reports fits false when even the minimum window overruns the asset', () => {
    // Less than MIN_CLIP_DURATION * SPEED_MIN of source remains, so the span
    // floor still overruns: the caller must reject rather than half-apply.
    const d = decideRateStretch({
      ...base,
      origInPoint: 10.99,
      assetDuration: 11,
      clientX: 140,
    })
    expect(d.fits).toBe(false)
  })
})
