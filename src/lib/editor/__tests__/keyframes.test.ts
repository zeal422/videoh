import { describe, expect, it } from 'vitest'
import {
  ANIMATABLE_PROPERTIES,
  animatedValue,
  clampPropertyValue,
  evaluateKeyframes,
  sanitizeKeyframes,
  splitKeyframeMap,
  staticPropertyValue,
} from '../keyframes'
import { KEYFRAME_PROPERTY_BOUNDS } from '../constants'
import { createClip } from '../factories'
import type { Clip, Keyframe, KeyframeProperty } from '../types'

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

  it('exposes ten animatable properties', () => {
    expect(ANIMATABLE_PROPERTIES).toHaveLength(10)
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
  it('moves keyframes at or after the split into the right half, shifted', () => {
    const map = { volume: [kf(0, 0), kf(2, 1), kf(4, 2)] }
    const [l, r] = splitKeyframeMap(map, 3)
    expect(l!.volume).toEqual([kf(0, 0), kf(2, 1)])
    expect(r!.volume).toEqual([kf(1, 2)])
  })

  it('returns undefined only when a half has no keyframes at all', () => {
    // keyframes strictly before the split go left; none remain right
    const [l, r] = splitKeyframeMap({ opacity: [kf(0, 1)] }, 1)
    expect(l).toEqual({ opacity: [kf(0, 1)] })
    expect(r).toBeUndefined()
    const [l2, r2] = splitKeyframeMap(undefined, 1)
    expect(l2).toBeUndefined()
    expect(r2).toBeUndefined()
  })

  it('splits multiple properties independently', () => {
    const map = { opacity: [kf(1, 0.5)], hue: [kf(2, 90)] }
    const [l, r] = splitKeyframeMap(map, 2)
    expect(l!.opacity).toEqual([kf(1, 0.5)])
    expect(l!.hue).toBeUndefined()
    expect(r!.hue).toEqual([kf(0, 90)])
  })
})
