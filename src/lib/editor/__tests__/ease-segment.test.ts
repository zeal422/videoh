import { describe, expect, it } from 'vitest'
import {
  LINEAR_QUAD,
  areaControls,
  evaluateControls,
  mirrorQuad,
  parameterAtX,
  presetControls,
  rehomeSegmentShapes,
  segmentControls,
  subdivideControls,
  withEasing,
  withQuadHandle,
  withSegmentControls,
  type BezierQuad,
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

describe('rehomeSegmentShapes', () => {
  const kf = (time: number, value: number, rest: Partial<Keyframe> = {}): Keyframe => ({
    time,
    value,
    ...rest,
  })

  it('moves the curve of a swapped pair onto its new start, mirrored and renamed', () => {
    // The pair (1s -> 5s) eases out; the later dot drags to 0.6s, so the pair
    // now runs the other way. easeOut [0, 0, 0.58, 1] read backwards is easeIn.
    const before = [kf(1, 0.2, { interpolation: 'easeOut' }), kf(5, 1)]
    const incoming = [kf(1, 0.2, { interpolation: 'easeOut' }), kf(0.6, 1)]
    expect(rehomeSegmentShapes(before, incoming)).toEqual([
      { time: 0.6, value: 1, interpolation: 'easeIn', easeOut: [0.42, 0, 1, 1] },
      { time: 1, value: 0.2, interpolation: 'linear' },
    ])
  })

  it('is an involution: dragging the pair back restores the original shape', () => {
    const before = [kf(1, 0.2, { interpolation: 'easeOut' }), kf(5, 1)]
    const swapped = rehomeSegmentShapes(before, [
      kf(1, 0.2, { interpolation: 'easeOut' }),
      kf(0.6, 1),
    ])
    const back = rehomeSegmentShapes(swapped, [{ ...swapped[0], time: 5 }, swapped[1]])
    expect(back).toEqual([
      { time: 1, value: 0.2, interpolation: 'easeOut', easeOut: [0, 0, 0.58, 1] },
      { time: 5, value: 1, interpolation: 'linear' },
    ])
  })

  it('leaves a newly adjacent pair linear and drops the stale shape', () => {
    // [A, B, C] with C dragged in front of A: (C, A) never existed, (A, B)
    // survives in the same direction, and B starts nothing now, so its quad
    // must not linger for the next keyframe added after it.
    const q1: BezierQuad = [0.1, 0, 0.9, 1]
    const q2: BezierQuad = [0.2, 0, 0.8, 1]
    const before = [kf(1, 0.2, { easeOut: q1 }), kf(2, 0.4, { easeOut: q2 }), kf(3, 0.6)]
    const incoming = [kf(1, 0.2, { easeOut: q1 }), kf(2, 0.4, { easeOut: q2 }), kf(0.5, 0.6)]
    expect(rehomeSegmentShapes(before, incoming)).toEqual([
      { time: 0.5, value: 0.6, interpolation: 'linear' },
      { time: 1, value: 0.2, interpolation: 'linear', easeOut: q1 },
      { time: 2, value: 0.4, interpolation: 'linear' },
    ])
  })

  it('keeps a hand-made curve under a linear name, mirrored', () => {
    // A quad that matches no preset keeps the drag convention (linear name, no
    // pressed button) after mirroring: mirrorQuad([0.2, 0.1, 0.7, 0.9]). The
    // mirror is plain arithmetic, so the numbers are the mirrored floats.
    const before = [kf(1, 0.2, { easeOut: [0.2, 0.1, 0.7, 0.9] }), kf(5, 1)]
    const incoming = [kf(1, 0.2, { easeOut: [0.2, 0.1, 0.7, 0.9] }), kf(0.5, 1)]
    const out = rehomeSegmentShapes(before, incoming)
    const round9 = (q?: BezierQuad) => q?.map((n) => Number(n.toFixed(9)))
    expect(out[0]).toMatchObject({ time: 0.5, value: 1, interpolation: 'linear' })
    expect(round9(out[0].easeOut)).toEqual([0.3, 0.1, 0.8, 0.9])
    expect(out[1]).toEqual({ time: 1, value: 0.2, interpolation: 'linear' })
  })

  it('does nothing when the write is not a reorder of the same keyframes', () => {
    const before = [kf(1, 0.2, { interpolation: 'easeOut' }), kf(5, 1)]
    // Every non-reorder write comes back exactly as the caller passed it: a
    // normal drag frame (the dot still sits right of its neighbour), a
    // structural write (the slider appended a keyframe), and a value edit.
    const dragging = [kf(1, 0.2, { interpolation: 'easeOut' }), kf(4, 1)]
    expect(rehomeSegmentShapes(before, dragging)).toEqual(dragging)
    const appended = [kf(1, 0.2, { interpolation: 'easeOut' }), kf(5, 1), kf(6, 0.5)]
    expect(rehomeSegmentShapes(before, appended)).toEqual(appended)
    const valueEdit = [kf(1, 0.2, { interpolation: 'easeOut' }), kf(5, 0.75)]
    expect(rehomeSegmentShapes(before, valueEdit)).toEqual(valueEdit)
    // And a malformed one: sanitize drops non-finite times AFTER this helper
    // runs, so a time that sorts around them must not read as a reorder
    // (unguarded, -Infinity sorts first and would mirror the pair's shape).
    const malformed = [kf(1, 0.2, { interpolation: 'easeOut' }), kf(Number.NEGATIVE_INFINITY, 1)]
    expect(rehomeSegmentShapes(before, malformed)).toEqual(malformed)
  })

  it('does not read a re-inserted keyframe as a reorder when the values coincide', () => {
    // The slider's write rebuilds the array as `filter(not at the playhead)`
    // plus a push, so a playhead sitting exactly ON a middle keyframe shifts
    // the tail by one index. On a plateau (identical values, identical shaping)
    // the shifted entries still compare equal index by index, and a test that
    // only checks the value fields would call that a reorder and drop the
    // shapes it finds no preserved pair for. Only ONE keyframe's time moves in
    // a real reorder, which is what the helper must require.
    const before = [kf(0, 0.5, { interpolation: 'easeInOut' }), kf(1, 0.5), kf(2, 0.5)]
    const reinserted = [before[0], before[2], kf(1, 0.5)]
    expect(rehomeSegmentShapes(before, reinserted)).toEqual(reinserted)
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

describe('LINEAR_QUAD', () => {
  it('evaluates to the identity (all four control points sit on y = x)', () => {
    for (const u of [0, 0.25, 0.5, 0.75, 1]) {
      expect(evaluateControls(LINEAR_QUAD, u)).toBeCloseTo(u, 12)
    }
  })
})

describe('mirrorQuad', () => {
  it('maps each control point onto its mirrored position', () => {
    const q = [0.1, 0.9, 0.7, 0.2] as const
    expect(mirrorQuad(q)).toEqual([1 - 0.7, 1 - 0.2, 1 - 0.1, 1 - 0.9])
  })

  it('is an involution to floating-point noise', () => {
    for (const q of [EASING_PRESETS.easeIn, [0.1, 0.9, 0.7, 0.2] as const]) {
      const back = mirrorQuad(mirrorQuad(q))
      for (let i = 0; i < 4; i++) expect(back[i]).toBeCloseTo(q[i], 12)
    }
  })

  it('reads the curve backwards (the parameter-reversal identity)', () => {
    for (const q of [EASING_PRESETS.easeIn, [0.1, 0.9, 0.7, 0.2] as const]) {
      for (const u of [0.1, 0.35, 0.5, 0.8]) {
        expect(evaluateControls(mirrorQuad(q), u)).toBeCloseTo(1 - evaluateControls(q, 1 - u), 9)
      }
    }
  })

  it('easeInOut is its own mirror to floating-point noise (its control points are symmetric)', () => {
    // 1 - 0.58 is 0.42000000000000004, so the identity holds only within a
    // floating-point step, which the assertion's precision allows for.
    const mirrored = mirrorQuad(EASING_PRESETS.easeInOut)
    for (let i = 0; i < 4; i++) {
      expect(mirrored[i]).toBeCloseTo(EASING_PRESETS.easeInOut[i], 12)
    }
  })
})

describe('withQuadHandle', () => {
  it('moves only the requested pair and clamps it to the unit square', () => {
    const q = [0.2, 0.3, 0.6, 0.7] as const
    expect(withQuadHandle(q, 'out', { x: 0.5, y: 0.5 })).toEqual([0.5, 0.5, 0.6, 0.7])
    expect(withQuadHandle(q, 'in', { x: 0.5, y: 0.5 })).toEqual([0.2, 0.3, 0.5, 0.5])
    expect(withQuadHandle(q, 'out', { x: -1, y: 2 })).toEqual([0, 1, 0.6, 0.7])
    expect(withQuadHandle(q, 'in', { x: 2, y: -1 })).toEqual([0.2, 0.3, 1, 0])
  })

  it('leaves the input untouched', () => {
    const q = [0.2, 0.3, 0.6, 0.7] as const
    withQuadHandle(q, 'out', { x: 0.9, y: 0.9 })
    expect(q).toEqual([0.2, 0.3, 0.6, 0.7])
  })
})

describe('withEasing', () => {
  it('stamps the name plus the preset exact quad, and clears everything for linear', () => {
    const kf: Keyframe = { time: 1, value: 0.5 }
    const eased = withEasing(kf, 'easeIn')
    expect(eased).toEqual({
      time: 1,
      value: 0.5,
      interpolation: 'easeIn',
      easeOut: [...EASING_PRESETS.easeIn],
    })
    const linear = withEasing({ ...kf, interpolation: 'easeIn', easeOut: [0.4, 0, 1, 1] }, 'linear')
    expect(linear).toEqual({ time: 1, value: 0.5, interpolation: 'linear' })
    expect('easeOut' in linear).toBe(false)
    // The source keyframe is never mutated (commands clone).
    expect(kf).toEqual({ time: 1, value: 0.5 })
  })
})
