import { describe, expect, it } from 'vitest'
import {
  areaControls,
  evaluateControls,
  parameterAtX,
  presetControls,
  segmentControls,
  subdivideControls,
  withSegmentControls,
} from '../ease-segment'
import { EASING_PRESETS, cubicBezier, cubicBezierArea } from '../bezier'
import type { Keyframe } from '../types'

describe('segmentControls', () => {
  it('prefers exact data over the name, and resolves the name when data is absent', () => {
    const data = { interpolation: 'easeIn' } as const
    expect(segmentControls(data)).toEqual(EASING_PRESETS.easeIn)
    // Old files: name only.
    const named: Keyframe = { time: 0, value: 1, interpolation: 'easeInOut' }
    expect(segmentControls(named)).toEqual(EASING_PRESETS.easeInOut)
    // Data wins over the name (the picker stamps data; the name is display).
    const both: Keyframe = {
      time: 0,
      value: 1,
      interpolation: 'easeIn',
      easeOut: [0.1, 0.2, 0.3, 0.4],
    }
    expect(segmentControls(both)).toEqual([0.1, 0.2, 0.3, 0.4])
    // Linear: no data, no name.
    expect(segmentControls({})).toBeUndefined()
    expect(presetControls('linear')).toBeUndefined()
    expect(presetControls(undefined)).toBeUndefined()
  })

  it('withSegmentControls stamps exact data and clears it for linear', () => {
    const kf: Keyframe = { time: 0, value: 1, interpolation: 'easeIn' }
    const stamped = withSegmentControls(kf, [0.2, 0, 0.6, 1])
    expect(stamped.easeOut).toEqual([0.2, 0, 0.6, 1])
    // The original is untouched (commands clone).
    expect(kf.easeOut).toBeUndefined()
    expect(withSegmentControls(kf, undefined).easeOut).toBeUndefined()
  })

  it('withSegmentControls REMOVES an existing easeOut when passed undefined', () => {
    // The doc promises `undefined` means linear. The old spread
    // (`{ ...kf, ...(controls ? { easeOut: controls } : {}) }`) left any
    // existing field in place, so a caller asking for linear silently kept the
    // old shape. The test above cannot catch it: its input has no easeOut to
    // leave behind.
    const kf: Keyframe = {
      time: 0,
      value: 1,
      interpolation: 'easeIn',
      easeOut: [0.1, 0.2, 0.3, 0.4],
    }
    const cleared = withSegmentControls(kf, undefined)
    expect(cleared.easeOut).toBeUndefined()
    expect('easeOut' in cleared).toBe(false)
    // The original is untouched (commands clone).
    expect(kf.easeOut).toEqual([0.1, 0.2, 0.3, 0.4])
  })
})

describe('subdivideControls', () => {
  const c = EASING_PRESETS.easeInOut as readonly [number, number, number, number]
  // The curve's x(t) and y(t) as polynomials, the same closed form every
  // solver inverts (an independent oracle: no bezier call re-used here).
  const poly = (a1: number, a2: number) => (t: number) => {
    const A = 1 - 3 * a2 + 3 * a1
    const B = 3 * a2 - 6 * a1
    const C = 3 * a1
    return ((A * t + B) * t + C) * t
  }
  const xPoly = poly(c[0], c[2])
  const yPoly = poly(c[1], c[3])

  it('the halves are valid timing functions: 0->0 and 1->1', () => {
    for (const u of [0.1, 0.35, 0.5, 0.8]) {
      const { left, right } = subdivideControls(c, u)
      expect(evaluateControls(left, 0)).toBeCloseTo(0, 9)
      expect(evaluateControls(left, 1)).toBeCloseTo(1, 9)
      expect(evaluateControls(right, 0)).toBeCloseTo(0, 9)
      expect(evaluateControls(right, 1)).toBeCloseTo(1, 9)
    }
  })

  it('the halves reassemble the original curve exactly (reparameterized)', () => {
    for (const u of [0.2, 0.5, 0.75]) {
      const { left, right } = subdivideControls(c, u)
      // The cut at PARAMETER u lands at curve point (x(u), y(u)): parameter
      // space, no x-solve: de Casteljau splits the polygon at its parameter.
      const qx = xPoly(u)
      const qy = yPoly(u)
      for (let i = 1; i < 10; i++) {
        const s = i / 10
        // The left sub-curve is the original over parameter [0, u],
        // re-timed by x: left(s) = y(t)/qy where x(t) = qx*s.
        const tL = parameterAtX(c, qx * s)
        expect(evaluateControls(left, s)).toBeCloseTo(yPoly(tL) / qy, 7)
        // The right one is the original over [u, 1]:
        // right(s) = (y(t) - qy)/(1-qy) where x(t) = qx + (1-qx)*s.
        const tR = parameterAtX(c, qx + (1 - qx) * s)
        expect(evaluateControls(right, s)).toBeCloseTo((yPoly(tR) - qy) / (1 - qy), 7)
      }
    }
  })

  it('a linear curve subdivides to linear halves', () => {
    const { left, right } = subdivideControls([0, 0, 1, 1], 0.5)
    expect(evaluateControls(left, 0.5)).toBeCloseTo(0.5, 9)
    expect(evaluateControls(right, 0.5)).toBeCloseTo(0.5, 9)
  })
})

describe('parameterAtX', () => {
  it('inverts the x axis of the curve (against the polynomial oracle)', () => {
    const c = EASING_PRESETS.easeIn as readonly [number, number, number, number]
    const [x1, , x2] = c
    const A = 1 - 3 * x2 + 3 * x1
    const B = 3 * x2 - 6 * x1
    const C = 3 * x1
    const xPoly = (t: number) => ((A * t + B) * t + C) * t
    for (const p of [0.05, 0.25, 0.5, 0.9]) {
      const t = parameterAtX(c, p)
      expect(xPoly(t)).toBeCloseTo(p, 8)
    }
    expect(parameterAtX(c, 0)).toBe(0)
    expect(parameterAtX(c, 1)).toBe(1)
  })

  it('falls back to the shared 40-deep bisection when Newton stalls', () => {
    // The degenerate x(t) = t^3 cubic ([0, 0, 0, 1] control points) sends
    // Newton off course, so this solve always reaches the bisection fallback.
    // 40 halvings pin the x-solve to ~9e-13 (the old hand-rolled 32-deep copy
    // landed at ~9e-12 here, which the bound below catches).
    const c = [0, 0, 0, 1] as const
    const t = parameterAtX(c, 0.05)
    const xAt = (t: number) => t * t * t
    expect(Math.abs(xAt(t) - 0.05)).toBeLessThan(5e-13)
  })
})

describe('areaControls', () => {
  it('matches the bezier module for the presets and the endpoints are exact', () => {
    const c = EASING_PRESETS.easeOut as readonly [number, number, number, number]
    const area = areaControls(c)
    const oracle = cubicBezierArea(c[0], c[1], c[2], c[3])
    for (const q of [0.1, 0.5, 0.9]) expect(area(q)).toBeCloseTo(oracle(q), 12)
    expect(area(0)).toBe(0)
    expect(area(1)).toBeCloseTo(oracle(1), 12)
  })
})
