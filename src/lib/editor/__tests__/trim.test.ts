import { describe, expect, it } from 'vitest'
import { MIN_CLIP_DURATION } from '../constants'
import { evaluateKeyframes, integrateKeyframes } from '../keyframes'
import {
  largestFittingDuration,
  rebaseCurveFromCut,
  sourceConsumption,
  truncateCurveAtCut,
} from '../trim'
import type { Keyframe } from '../types'

/** Deep-freezes a keyframe array so a rebase cannot mutate its input. */
function frozen(kfs: Keyframe[]): Keyframe[] {
  for (const k of kfs) Object.freeze(k)
  return Object.freeze(kfs) as Keyframe[]
}

describe('sourceConsumption', () => {
  it('multiplies by the rate when the clip carries no curve', () => {
    expect(sourceConsumption(undefined, 3, 2)).toBe(6)
    expect(sourceConsumption([], 3, 2)).toBe(6)
  })

  it('integrates the curve and ignores the fallback rate', () => {
    expect(sourceConsumption([{ time: 0, value: 2 }], 3, 5)).toBe(6)
  })
})

describe('largestFittingDuration', () => {
  it('bisects to the largest fitting span for a linear consumption rule', () => {
    const consumed = (d: number) => d * 2
    const found = largestFittingDuration(1, consumed, 9, 20)
    expect(1 + consumed(found)).toBeLessThanOrEqual(9 + 1e-6)
    expect(1 + consumed(found + 1e-6)).toBeGreaterThan(9)
    expect(found).toBeCloseTo(4, 5)
  })

  it('caps at the requested span when the whole span fits', () => {
    const found = largestFittingDuration(0, (d) => d, 100, 3)
    expect(found).toBeLessThanOrEqual(3)
    expect(found).toBeCloseTo(3, 5)
  })

  it('never searches below the minimum clip duration', () => {
    expect(largestFittingDuration(100, () => 5, 10, 5)).toBe(MIN_CLIP_DURATION)
  })

  it('fits a ramped consumption through the curve integral', () => {
    const kfs: Keyframe[] = [
      { time: 0, value: 1 },
      { time: 4, value: 2 },
    ]
    const consumed = (d: number) => integrateKeyframes(kfs, d, 1)
    const found = largestFittingDuration(0, consumed, 10, 30)
    expect(consumed(found)).toBeLessThanOrEqual(10 + 1e-6)
    expect(consumed(found + 1e-6)).toBeGreaterThan(10)
    // The curve consumes 6 source seconds in its first 4, then 2 per second.
    expect(found).toBeCloseTo(6, 5)
  })
})

describe('rebaseCurveFromCut', () => {
  it('drops the curve before the cut and shifts survivors onto 0', () => {
    const found = rebaseCurveFromCut(
      [
        { time: 0, value: 1 },
        { time: 4, value: 2 },
      ],
      1,
    )
    expect(found.map((k) => k.time)).toEqual([0, 3])
    expect(found[0].value).toBeCloseTo(1.25, 9)
    expect(found[0].interpolation).toBe('linear')
    // A linear crossing segment subdivides to itself: no quad is pinned.
    expect('easeOut' in found[0]).toBe(false)
    expect(found[1].value).toBe(2)
  })

  it('keeps a keyframe already on the cut without pinning a boundary', () => {
    const found = rebaseCurveFromCut(
      [
        { time: 0, value: 1 },
        { time: 1, value: 2 },
        { time: 4, value: 3 },
      ],
      1,
    )
    expect(found.map((k) => k.time)).toEqual([0, 3])
    expect(found.map((k) => k.value)).toEqual([2, 3])
  })

  it('pins the extended head when the cut precedes the first keyframe', () => {
    const found = rebaseCurveFromCut(
      [
        { time: 2, value: 1 },
        { time: 4, value: 2 },
      ],
      0.5,
    )
    expect(found.map((k) => k.time)).toEqual([0, 1.5, 3.5])
    expect(found[0].value).toBe(1)
    expect(found[0].interpolation).toBe('linear')
  })

  it("carries the crossing eased segment's right piece and keeps every read exact", () => {
    const kfs: Keyframe[] = [
      { time: 0, value: 1, interpolation: 'easeIn' },
      { time: 4, value: 2 },
    ]
    const found = rebaseCurveFromCut(kfs, 2)
    expect(found[0].interpolation).toBe('easeIn')
    expect(found[0].easeOut).toBeDefined()
    for (const t of [0, 0.25, 0.5, 1, 1.5, 2]) {
      expect(evaluateKeyframes(found, t, 0)).toBeCloseTo(evaluateKeyframes(kfs, 2 + t, 0), 9)
    }
  })

  it('does not mutate its input', () => {
    const kfs = frozen([
      { time: 0, value: 1, interpolation: 'easeIn' },
      { time: 4, value: 2 },
    ])
    rebaseCurveFromCut(kfs, 2)
    expect(kfs.map((k) => k.time)).toEqual([0, 4])
    expect(kfs[0].easeOut).toBeUndefined()
  })
})

describe('truncateCurveAtCut', () => {
  it('keeps the curve up to the cut and pins the boundary', () => {
    const kfs: Keyframe[] = [
      { time: 0, value: 1 },
      { time: 4, value: 2 },
    ]
    const found = truncateCurveAtCut(kfs, 2)
    expect(found.map((k) => k.time)).toEqual([0, 2])
    expect(found[1].value).toBeCloseTo(1.5, 9)
    expect(found[1].interpolation).toBe('linear')
    expect('easeOut' in found[1]).toBe(false)
  })

  it('keeps a keyframe already on the cut without appending', () => {
    const found = truncateCurveAtCut(
      [
        { time: 0, value: 1 },
        { time: 2, value: 2 },
        { time: 4, value: 3 },
      ],
      2,
    )
    expect(found.map((k) => k.time)).toEqual([0, 2])
    expect(found.map((k) => k.value)).toEqual([1, 2])
  })

  it("rides the crossing segment's left piece on the last survivor and keeps reads exact", () => {
    const kfs: Keyframe[] = [
      { time: 0, value: 1, interpolation: 'easeIn' },
      { time: 4, value: 2 },
    ]
    const found = truncateCurveAtCut(kfs, 2)
    expect(found).toHaveLength(2)
    expect(found[0].easeOut).toBeDefined()
    expect(found[1].interpolation).toBe('linear')
    for (const t of [0, 0.25, 0.5, 1, 1.5, 2]) {
      expect(evaluateKeyframes(found, t, 0)).toBeCloseTo(evaluateKeyframes(kfs, t, 0), 9)
    }
  })

  it('pins a lone boundary when the cut precedes the curve', () => {
    const found = truncateCurveAtCut([{ time: 2, value: 5 }], 0.5)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ time: 0.5, value: 5, interpolation: 'linear' })
  })

  it('does not mutate its input', () => {
    const kfs = frozen([
      { time: 0, value: 1, interpolation: 'easeIn' },
      { time: 4, value: 2 },
    ])
    truncateCurveAtCut(kfs, 2)
    expect(kfs.map((k) => k.time)).toEqual([0, 4])
    expect(kfs[0].easeOut).toBeUndefined()
  })
})
