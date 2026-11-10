import { describe, expect, it } from 'vitest'

import { dragKeyframeDot, nudgeKeyframeTime } from '../keyframe-graph-gesture'
import { gainToUnit, unitToGain } from '../volume-automation'

/**
 * Pure geometry for the keyframe graph dot drag (0.20.0): the panel renders,
 * the hook owns the pointer lifetime, and these functions own the mapping.
 */

const rect = { left: 100, width: 200, height: 100 }
const bounds = { min: 0, max: 2 }

function drag(partial: Partial<Parameters<typeof dragKeyframeDot>[0]> = {}) {
  return dragKeyframeDot({
    rect,
    clientX: 200,
    clientY: 50,
    start: { y: 50, value: 1 },
    duration: 8,
    property: 'volume',
    bounds,
    scale: 'linear',
    mirrored: false,
    ...partial,
  })
}

describe('dragKeyframeDot — time axis', () => {
  it('maps the pointer X to clip time and clamps at both edges', () => {
    expect(drag({ clientX: 150 }).time).toBe(2)
    expect(drag({ clientX: 300 }).time).toBe(8)
    expect(drag({ clientX: 0 }).time).toBe(0)
    expect(drag({ clientX: 999 }).time).toBe(8)
  })

  it('flips a mirrored row around the clip duration', () => {
    expect(drag({ clientX: 150, mirrored: true }).time).toBe(6)
    expect(drag({ clientX: 300, mirrored: true }).time).toBe(0)
    expect(drag({ clientX: 0, mirrored: true }).time).toBe(8)
  })
})

describe('dragKeyframeDot — value axis', () => {
  it('uses the vertical delta from the press, so an off-center press cannot jump', () => {
    expect(drag({ clientY: 50 }).value).toBe(1)
    // Up 25% of the strip is +25% of the 0..2 range.
    expect(drag({ clientY: 25 }).value).toBeCloseTo(1.5, 12)
    expect(drag({ clientY: 75 }).value).toBeCloseTo(0.5, 12)
  })

  it('clamps at the property bounds', () => {
    expect(drag({ clientY: -1000 }).value).toBe(2)
    expect(drag({ clientY: 1000 }).value).toBe(0)
  })

  it('round-trips the dB display domain for volume rows', () => {
    // Down half the strip: the display unit drops by 0.5 from unity, then
    // converts back to gain.
    const result = drag({ scale: 'db', clientY: 100 })
    expect(result.value).toBeCloseTo(unitToGain(gainToUnit(1) - 0.5), 12)
  })

  it('keeps a zero-height rect safe instead of producing NaN', () => {
    const result = drag({ rect: { ...rect, height: 0 }, clientY: 100 })
    expect(Number.isFinite(result.value)).toBe(true)
    expect(Number.isFinite(result.time)).toBe(true)
  })

  it('maps a zero-duration clip to time 0 on both axes', () => {
    expect(drag({ duration: 0 }).time).toBe(0)
    expect(drag({ duration: 0, mirrored: true }).time).toBe(0)
  })
})

describe('nudgeKeyframeTime', () => {
  it('steps one screen-space unit and stays inside the clip', () => {
    expect(nudgeKeyframeTime({ time: 2, duration: 8, delta: 1, mirrored: false })).toBe(3)
    expect(nudgeKeyframeTime({ time: 0, duration: 8, delta: -1, mirrored: false })).toBe(0)
    expect(nudgeKeyframeTime({ time: 8, duration: 8, delta: 1, mirrored: false })).toBe(8)
  })

  it('moves a mirrored row the same way on screen while stored time runs opposite', () => {
    // Screen position for stored 2 on an 8s mirrored row is 6; +1 screen -> 7, stored -> 1.
    expect(nudgeKeyframeTime({ time: 2, duration: 8, delta: 1, mirrored: true })).toBe(1)
    // Stored 0 sits at the screen's right edge; one step left lands at stored 1.
    expect(nudgeKeyframeTime({ time: 0, duration: 8, delta: -1, mirrored: true })).toBe(1)
    // Stored 8 sits at the left edge; stepping further left clamps there.
    expect(nudgeKeyframeTime({ time: 8, duration: 8, delta: -1, mirrored: true })).toBe(8)
  })

  it('pulls a stored time from outside the clip back to the edge', () => {
    expect(nudgeKeyframeTime({ time: -5, duration: 8, delta: 1, mirrored: false })).toBe(0)
    expect(nudgeKeyframeTime({ time: 12, duration: 8, delta: -1, mirrored: false })).toBe(8)
    expect(nudgeKeyframeTime({ time: -5, duration: 8, delta: 1, mirrored: true })).toBe(0)
    expect(nudgeKeyframeTime({ time: 12, duration: 8, delta: -1, mirrored: true })).toBe(8)
  })
})
