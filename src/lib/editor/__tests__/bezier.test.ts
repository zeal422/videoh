import { describe, expect, it } from 'vitest'
import {
  EASING_PRESETS,
  TIMING_AREAS,
  TIMING_FUNCTIONS,
  cubicBezier,
  cubicBezierArea,
  easingArea,
  easingFunction,
} from '../bezier'

/**
 * Oracle table: computed independently (bisection on the parametric form of
 * cubic-bezier(x1, y1, x2, y2)), not read back from the implementation.
 */
const ORACLES: Record<keyof typeof EASING_PRESETS, [progress: number, expected: number][]> = {
  easeIn: [
    [0.25, 0.093465],
    [0.5, 0.315357],
    [0.75, 0.621862],
  ],
  easeOut: [
    [0.25, 0.378138],
    [0.5, 0.684643],
    [0.75, 0.906535],
  ],
  easeInOut: [
    [0.25, 0.129162],
    [0.5, 0.5],
    [0.75, 0.870838],
  ],
}

const NAMES = Object.keys(EASING_PRESETS) as (keyof typeof EASING_PRESETS)[]

describe('cubicBezier', () => {
  it('pins the endpoints exactly for every preset', () => {
    for (const name of NAMES) {
      const fn = TIMING_FUNCTIONS[name]
      expect(fn(0)).toBe(0)
      expect(fn(1)).toBe(1)
    }
  })

  it('clamps outside the unit interval', () => {
    const fn = TIMING_FUNCTIONS.easeIn
    expect(fn(-0.5)).toBe(0)
    expect(fn(1.5)).toBe(1)
    expect(fn(-Infinity)).toBe(0)
    expect(fn(Infinity)).toBe(1)
  })

  it('matches the computed oracle midpoints within 1e-3', () => {
    for (const name of NAMES) {
      for (const [p, expected] of ORACLES[name]) {
        expect(TIMING_FUNCTIONS[name](p)).toBeCloseTo(expected, 3)
      }
    }
  })

  it('is monotonic in p for every preset', () => {
    for (const name of NAMES) {
      const fn = TIMING_FUNCTIONS[name]
      let prev = -Infinity
      for (let i = 0; i <= 100; i++) {
        const y = fn(i / 100)
        expect(y).toBeGreaterThanOrEqual(prev)
        prev = y
      }
    }
  })

  it('solves a curve with a flat x slope (x1 = 0) through bisection', () => {
    // easeOut is exactly that case: Newton divides by a zero slope at t = 0.
    expect(TIMING_FUNCTIONS.easeOut(0.01)).toBeCloseTo(0.01691, 3)
  })

  it('falls back to bisection when Newton cannot invert a flat x slope', () => {
    // cubic-bezier(0, 0.5, 0, 1): x is flat at t = 0, so Newton's first step
    // divides by a near-zero slope and the solver must bisect instead.
    // Oracle computed independently (200-step bisection on the parametric form).
    expect(cubicBezier(0, 0.5, 0, 1)(0.0005)).toBeCloseTo(0.1188051, 5)
  })

  it('collapses a curve whose x and y controls match to the identity', () => {
    const linear = cubicBezier(0.25, 0.25, 0.75, 0.75)
    expect(linear(0.3)).toBe(0.3)
    expect(linear(0.5)).toBe(0.5)
  })
})

describe('cubicBezierArea', () => {
  /** Oracles computed independently (400k-step quadrature on the parametric form). */
  const AREAS: Record<keyof typeof EASING_PRESETS, [q: number, expected: number][]> = {
    easeIn: [
      [0.25, 0.008214187],
      [0.5, 0.057249032],
    ],
    easeOut: [
      [0.25, 0.048875607],
      [0.5, 0.183249032],
    ],
    easeInOut: [
      [0.25, 0.010579403],
      [0.5, 0.085625],
    ],
  }

  it('matches the computed oracle at partial spans', () => {
    for (const name of NAMES) {
      for (const [q, expected] of AREAS[name]) {
        expect(TIMING_AREAS[name](q)).toBeCloseTo(expected, 6)
      }
    }
  })

  it('integrates the whole curve to its exact mean', () => {
    // ∫₀¹ y dp = 0.5 + 0.3*((y1 - x1) + (y2 - x2)) for any cubic bezier.
    expect(TIMING_AREAS.easeIn(1)).toBeCloseTo(0.374, 9)
    expect(TIMING_AREAS.easeOut(1)).toBeCloseTo(0.626, 9)
    expect(TIMING_AREAS.easeInOut(1)).toBeCloseTo(0.5, 9)
  })

  it('is zero at zero and clamps outside the unit interval', () => {
    const area = TIMING_AREAS.easeIn
    expect(area(0)).toBe(0)
    expect(area(-1)).toBe(0)
    expect(area(2)).toBeCloseTo(area(1), 12)
  })

  it('integrates the identity curve to q²/2', () => {
    const area = cubicBezierArea(0.25, 0.25, 0.75, 0.75)
    expect(area(0.5)).toBeCloseTo(0.125, 9)
    expect(area(1)).toBeCloseTo(0.5, 9)
  })

  it('reads an unknown interpolation as the linear area', () => {
    expect(easingArea(undefined)(0.4)).toBeCloseTo(0.08, 12)
    expect(easingArea('wobble')(0.4)).toBeCloseTo(0.08, 12)
  })
})

describe('easingFunction', () => {
  it('reads absent interpolation as linear', () => {
    expect(easingFunction(undefined)(0.42)).toBe(0.42)
  })

  it('reads an unknown interpolation as linear', () => {
    expect(easingFunction('wobble')(0.42)).toBe(0.42)
  })

  it('resolves the named presets', () => {
    expect(easingFunction('linear')(0.5)).toBe(0.5)
    expect(easingFunction('easeInOut')(0.5)).toBeCloseTo(0.5, 6)
    expect(easingFunction('easeIn')(0.5)).not.toBeCloseTo(0.5, 2)
    expect(easingFunction('easeOut')(0.5)).not.toBeCloseTo(0.5, 2)
  })

  it('exposes exactly the four interpolation names', () => {
    expect(Object.keys(TIMING_FUNCTIONS).sort()).toEqual([
      'easeIn',
      'easeInOut',
      'easeOut',
      'linear',
    ])
  })
})
