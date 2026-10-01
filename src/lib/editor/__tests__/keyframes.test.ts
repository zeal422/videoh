import { describe, expect, it } from 'vitest'
import {
  ANIMATABLE_PROPERTIES,
  KEYFRAME_INTERPOLATIONS,
  animatedValue,
  clampPropertyValue,
  evaluateKeyframes,
  isKeyframeInterpolation,
  sanitizeKeyframes,
  splitKeyframeMap,
  staticPropertyValue,
} from '../keyframes'
import { TIMING_FUNCTIONS } from '../bezier'
import { KEYFRAME_PROPERTY_BOUNDS } from '../constants'
import { createClip } from '../factories'
import type { Clip, Keyframe, KeyframeInterpolation, KeyframeProperty } from '../types'

function clip(overrides: Partial<Clip> = {}): Clip {
  const c = createClip()
  return { ...c, ...overrides }
}

const kf = (time: number, value: number): Keyframe => ({ time, value })

describe('evaluateKeyframes', () => {
  const curve: Keyframe[] = [kf(0, 0), kf(2, 10)]

  it('returns the exact keyframe values at keyframe times', () => {
    expect(evaluateKeyframes(curve, 0, 1)).toBe(0)
    expect(evaluateKeyframes(curve, 2, 1)).toBe(10)
  })

  it('interpolates linearly between keyframes', () => {
    expect(evaluateKeyframes(curve, 1, 1)).toBe(5)
    expect(evaluateKeyframes(curve, 0.5, 1)).toBeCloseTo(2.5, 10)
  })

  it('constant-extends before the first and after the last keyframe', () => {
    expect(evaluateKeyframes(curve, -5, 1)).toBe(0)
    expect(evaluateKeyframes(curve, 99, 1)).toBe(10)
  })

  it('returns the fallback for an empty curve', () => {
    expect(evaluateKeyframes([], 3, 7)).toBe(7)
  })

  it('handles a single keyframe as constant', () => {
    expect(evaluateKeyframes([kf(1, 4)], 0, 1)).toBe(4)
    expect(evaluateKeyframes([kf(1, 4)], 5, 1)).toBe(4)
  })

  it('returns the first value for zero-span duplicate times (sorted order wins)', () => {
    expect(evaluateKeyframes([kf(1, 2), kf(1, 8)], 1, 0)).toBe(2)
  })
})

describe('eased interpolation', () => {
  /** A 0..1 ramp over one second; p is the linear progress through it. */
  const ramp = (interpolation: KeyframeInterpolation): Keyframe[] => [
    { time: 0, value: 0, interpolation },
    { time: 1, value: 1 },
  ]

  // Oracles computed independently (bisection on the parametric bezier form).
  it('eases each named curve at the quarter, midpoint and three-quarter marks', () => {
    expect(evaluateKeyframes(ramp('easeIn'), 0.25, 0)).toBeCloseTo(0.093465, 3)
    expect(evaluateKeyframes(ramp('easeIn'), 0.5, 0)).toBeCloseTo(0.315357, 3)
    expect(evaluateKeyframes(ramp('easeIn'), 0.75, 0)).toBeCloseTo(0.621862, 3)
    expect(evaluateKeyframes(ramp('easeOut'), 0.25, 0)).toBeCloseTo(0.378138, 3)
    expect(evaluateKeyframes(ramp('easeOut'), 0.5, 0)).toBeCloseTo(0.684643, 3)
    expect(evaluateKeyframes(ramp('easeOut'), 0.75, 0)).toBeCloseTo(0.906535, 3)
    expect(evaluateKeyframes(ramp('easeInOut'), 0.25, 0)).toBeCloseTo(0.129162, 3)
    expect(evaluateKeyframes(ramp('easeInOut'), 0.5, 0)).toBeCloseTo(0.5, 6)
    expect(evaluateKeyframes(ramp('easeInOut'), 0.75, 0)).toBeCloseTo(0.870838, 3)
  })

  it('reads an absent or linear interpolation as the old linear math', () => {
    expect(evaluateKeyframes(ramp('linear'), 0.25, 0)).toBe(0.25)
    expect(evaluateKeyframes([kf(0, 0), kf(1, 1)], 0.25, 0)).toBe(0.25)
  })

  it('keeps every segment endpoint exact when eased', () => {
    const kfs = ramp('easeIn')
    expect(evaluateKeyframes(kfs, 0, 0.5)).toBe(0)
    expect(evaluateKeyframes(kfs, 1, 0.5)).toBe(1)
    // Constant extension is unaffected by the easing.
    expect(evaluateKeyframes(kfs, -2, 0.5)).toBe(0)
    expect(evaluateKeyframes(kfs, 9, 0.5)).toBe(1)
  })

  it('uses the OUTGOING keyframe of each segment independently', () => {
    const kfs: Keyframe[] = [
      { time: 0, value: 0, interpolation: 'easeIn' },
      { time: 1, value: 1, interpolation: 'linear' },
      { time: 2, value: 2, interpolation: 'linear' },
    ]
    // First segment eases (0.315357 of the 0..1 span), the second stays linear.
    expect(evaluateKeyframes(kfs, 0.5, 0)).toBeCloseTo(0.315357, 3)
    expect(evaluateKeyframes(kfs, 1.5, 0)).toBeCloseTo(1.5, 6)
  })

  it('normalizes interpolation on sanitize: legal names survive, unknown reads linear', () => {
    for (const name of KEYFRAME_INTERPOLATIONS) {
      const out = sanitizeKeyframes('opacity', [{ time: 0, value: 1, interpolation: name }])
      expect(out[0].interpolation).toBe(name)
    }
    const unknown = sanitizeKeyframes('opacity', [
      { time: 0, value: 1, interpolation: 'wobble' as KeyframeInterpolation },
    ])
    expect(unknown[0].interpolation).toBe('linear')
  })

  it('predicates interpolation names', () => {
    expect(isKeyframeInterpolation('easeInOut')).toBe(true)
    expect(isKeyframeInterpolation('linear')).toBe(true)
    expect(isKeyframeInterpolation('wobble')).toBe(false)
    expect(isKeyframeInterpolation(undefined)).toBe(false)
  })

  it('has a timing function for every interpolation name', () => {
    for (const name of KEYFRAME_INTERPOLATIONS) {
      expect(typeof TIMING_FUNCTIONS[name]).toBe('function')
    }
  })
})

describe('animatedValue and statics', () => {
  it('uses the static value when no keyframes exist', () => {
    const c = clip({ gain: 0.5, animStatics: { scale: 2 } })
    expect(animatedValue(c, 'volume', 5)).toBe(0.5)
    expect(animatedValue(c, 'scale', 5)).toBe(2)
    expect(animatedValue(c, 'opacity', 5)).toBe(1)
    expect(animatedValue(c, 'hue', 5)).toBe(0)
  })

  it('evaluates the curve when keyframes exist', () => {
    const c = clip({ keyframes: { volume: [kf(0, 0), kf(4, 2)] } })
    expect(animatedValue(c, 'volume', 2)).toBe(1)
  })

  it('exposes eleven animatable properties', () => {
    expect(ANIMATABLE_PROPERTIES).toHaveLength(11)
  })
})

describe('sanitizeKeyframes', () => {
  it('drops non-finite and negative times, clamps values, sorts by time', () => {
    const out = sanitizeKeyframes('volume', [
      kf(2, 9), // clamped to GAIN_MAX 2
      kf(-1, 0), // dropped: negative time
      kf(0, NaN), // dropped: non-finite value
      kf(1, 0.5),
    ])
    expect(out.map((k) => [k.time, k.value])).toEqual([
      [1, 0.5],
      [2, 2],
    ])
  })

  it('rejects later keyframes with invalid times too', () => {
    expect(sanitizeKeyframes('scale', [kf(0, 1), kf(Number.POSITIVE_INFINITY, 2)])).toHaveLength(1)
  })

  it('defaults interpolation to linear', () => {
    const out = sanitizeKeyframes('opacity', [kf(0, 1)])
    expect(out[0].interpolation).toBe('linear')
  })
})

describe('clampPropertyValue', () => {
  it('clamps into the property bounds', () => {
    expect(clampPropertyValue('hue', 500)).toBe(180)
    expect(clampPropertyValue('hue', -500)).toBe(-180)
    expect(clampPropertyValue('scale', 0.01)).toBe(0.1)
    expect(clampPropertyValue('saturation', 3)).toBe(2)
  })
})

describe('staticPropertyValue', () => {
  it('reads dedicated fields for opacity and volume', () => {
    expect(staticPropertyValue(clip({ opacity: 0.3 }), 'opacity')).toBe(0.3)
    expect(staticPropertyValue(clip({ gain: 1.5 }), 'volume')).toBe(1.5)
  })

  it('falls back to defaults for absent statics', () => {
    for (const p of [
      'positionX',
      'positionY',
      'scale',
      'exposure',
      'contrast',
      'saturation',
      'brightness',
      'hue',
    ] as KeyframeProperty[]) {
      const bounds = KEYFRAME_PROPERTY_BOUNDS[p]
      expect(staticPropertyValue(clip(), p)).toBe(bounds.default)
    }
  })
})

describe('splitKeyframeMap', () => {
  // The boundary keyframe splitKeyframeMap inserts carries the curve's value
  // at the cut, explicitly linear.
  const bnd = (time: number, value: number): Keyframe => ({ time, value, interpolation: 'linear' })

  it('moves keyframes at or after the split into the right half, shifted', () => {
    const map = { volume: [kf(0, 0), kf(2, 1), kf(4, 2)] }
    const [l, r] = splitKeyframeMap(map, 3)
    expect(l!.volume).toEqual([kf(0, 0), kf(2, 1), bnd(3, 1.5)])
    expect(r!.volume).toEqual([bnd(0, 1.5), kf(1, 2)])
  })

  it('keeps the curve on a half that holds no other keyframes', () => {
    // All keyframes after the cut: the left half used to lose the curve and
    // fall back to the static value.
    const [l, r] = splitKeyframeMap({ opacity: [kf(3, 0.25)] }, 1)
    expect(l!.opacity).toEqual([bnd(1, 0.25)])
    expect(r!.opacity).toEqual([bnd(0, 0.25), kf(2, 0.25)])
    // All keyframes before the cut: same problem on the right half.
    const [l2, r2] = splitKeyframeMap({ opacity: [kf(0, 0.25)] }, 1)
    expect(l2!.opacity).toEqual([kf(0, 0.25), bnd(1, 0.25)])
    expect(r2!.opacity).toEqual([bnd(0, 0.25)])
    // No curve at all stays absent on both halves.
    expect(splitKeyframeMap(undefined, 1)).toEqual([undefined, undefined])
  })

  it('splits multiple properties independently and skips a duplicate boundary', () => {
    const map = { opacity: [kf(1, 0.5)], hue: [kf(2, 90)] }
    const [l, r] = splitKeyframeMap(map, 2)
    expect(l!.opacity).toEqual([kf(1, 0.5), bnd(2, 0.5)])
    expect(l!.hue).toEqual([bnd(2, 90)])
    expect(r!.opacity).toEqual([bnd(0, 0.5)])
    // hue already has a keyframe exactly on the boundary: no extra dot.
    expect(r!.hue).toEqual([kf(0, 90)])
  })
})
