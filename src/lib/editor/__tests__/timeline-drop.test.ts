import { describe, expect, it } from 'vitest'

import { TRACK_DROP_EDGE_PX, computeTrackDropTarget } from '../timeline-drop'

/**
 * Drop-between-tracks geometry: the middle of a row drops ONTO that track,
 * a thin edge strip at each row boundary INSERTS a new track at that exact
 * z-position, and the empty strip below the last row appends one.
 * Row heights mirror the timeline defaults: video 64, audio 56.
 */
const HEIGHTS = [64, 56] // e.g. [V1, A1]

describe('computeTrackDropTarget', () => {
  it('middle of a row targets that track (lane drop)', () => {
    expect(computeTrackDropTarget(32, HEIGHTS)).toEqual({
      mode: 'lane',
      index: 0,
      y: 0,
      height: 64,
    })
    expect(computeTrackDropTarget(64 + 28, HEIGHTS)).toEqual({
      mode: 'lane',
      index: 1,
      y: 64,
      height: 56,
    })
  })

  it('top edge strip inserts a track above the row', () => {
    expect(computeTrackDropTarget(0, HEIGHTS)).toEqual({ mode: 'insert', index: 0, y: 0 })
    expect(computeTrackDropTarget(TRACK_DROP_EDGE_PX - 1, HEIGHTS)).toEqual({
      mode: 'insert',
      index: 0,
      y: 0,
    })
    // the first pixel of row 2 is its top edge → insert between row 1 and row 2
    expect(computeTrackDropTarget(64, HEIGHTS)).toEqual({ mode: 'insert', index: 1, y: 64 })
  })

  it('bottom edge strip inserts a track below the row', () => {
    expect(computeTrackDropTarget(63, HEIGHTS)).toEqual({ mode: 'insert', index: 1, y: 64 })
    expect(computeTrackDropTarget(64 + 56 - 1, HEIGHTS)).toEqual({
      mode: 'insert',
      index: 2,
      y: 120,
    })
  })

  it('below the last row appends a track at the end', () => {
    expect(computeTrackDropTarget(200, HEIGHTS)).toEqual({ mode: 'insert', index: 2, y: 120 })
    expect(computeTrackDropTarget(999, [44])).toEqual({ mode: 'insert', index: 1, y: 44 })
  })

  it('edge strips stay narrow: the middle lane zone spans the rest of the row', () => {
    // first middle pixel of row 1 (12 is the first non-edge offset)
    expect(computeTrackDropTarget(TRACK_DROP_EDGE_PX, HEIGHTS)).toEqual({
      mode: 'lane',
      index: 0,
      y: 0,
      height: 64,
    })
    // last middle pixel of row 1 (64 - 12 = 52)
    expect(computeTrackDropTarget(52, HEIGHTS)).toEqual({
      mode: 'lane',
      index: 0,
      y: 0,
      height: 64,
    })
  })

  it('no rows at all → null (cannot happen in practice, defined anyway)', () => {
    expect(computeTrackDropTarget(10, [])).toBeNull()
  })
})
