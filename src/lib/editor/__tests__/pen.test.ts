import { describe, expect, it } from 'vitest'

import {
  addKeyframeAt,
  automationKeyframes,
  automationPropertyForClip,
  automationUnitForValue,
  automationValueAt,
  automationValueForUnit,
  clampAutomationTime,
  formatAutomationValue,
  nudgeKeyframe,
  removeKeyframeAt,
  sampleAutomationCurve,
} from '../pen'
import { createClip } from '../factories'
import type { Clip } from '../types'

/**
 * The Pen's pure contract (0.16.0): which property a clip exposes, value
 * sampling, and add/remove/nudge on a sorted keyframe array. The component and
 * the command layer are separate proofs.
 */

function clipWith(partial: Partial<Clip> = {}): Clip {
  return createClip({ id: 'c', duration: 4, ...partial })
}

const VOLUME_CURVE = [
  { time: 0, value: 1, interpolation: 'linear' as const },
  { time: 2, value: 0.5, interpolation: 'linear' as const },
  { time: 4, value: 1, interpolation: 'linear' as const },
]

const OPACITY_CURVE = [
  { time: 0, value: 1, interpolation: 'linear' as const },
  { time: 4, value: 0.25, interpolation: 'linear' as const },
]

describe('automation property selection', () => {
  it('exposes volume on audio lanes and audio-only clips', () => {
    expect(automationPropertyForClip(clipWith(), 'audio')).toBe('volume')
    expect(automationPropertyForClip(clipWith({ audioOnly: true }), 'video')).toBe('volume')
  })

  it('exposes opacity on picture, including a solo video and a compound', () => {
    expect(automationPropertyForClip(clipWith(), 'video')).toBe('opacity')
    expect(automationPropertyForClip(clipWith(), 'text')).toBe('opacity')
    expect(automationPropertyForClip(clipWith({ sequenceId: 'seq' }), 'video')).toBe('opacity')
    expect(automationPropertyForClip(clipWith({ mediaId: 'm' }), 'video')).toBe('opacity')
  })
})

describe('sampling and display mapping', () => {
  it('reads the curve through animatedValue and falls back to the static value', () => {
    const animated = clipWith({ gain: 0.25, keyframes: { volume: VOLUME_CURVE } })
    expect(automationValueAt(animated, 'volume', 2)).toBe(0.5)
    const staticClip = clipWith({ opacity: 0.4 })
    expect(automationValueAt(staticClip, 'opacity', 1)).toBe(0.4)
    expect(automationValueAt(staticClip, 'opacity', 99)).toBe(0.4)
    expect(automationValueAt(staticClip, 'opacity', Number.NaN)).toBe(0.4)
  })

  it('clamps local time to the clip and treats hostile times as zero', () => {
    const clip = clipWith({ duration: 4 })
    expect(clampAutomationTime(clip, -2)).toBe(0)
    expect(clampAutomationTime(clip, 9)).toBe(4)
    expect(clampAutomationTime(clip, Number.NaN)).toBe(0)
    expect(clampAutomationTime(clip, Number.POSITIVE_INFINITY)).toBe(0)
  })

  it('maps volume through the dB display domain and opacity through 0..1', () => {
    expect(automationUnitForValue('volume', 1)).toBeCloseTo(0.909, 2)
    expect(automationUnitForValue('volume', 0)).toBe(0)
    expect(automationValueForUnit('volume', 0)).toBe(0)
    expect(automationValueForUnit('volume', 1)).toBeCloseTo(1.995, 2)
    expect(automationUnitForValue('opacity', 0.5)).toBe(0.5)
    expect(automationValueForUnit('opacity', 0.25)).toBe(0.25)
    // Hostile positions clamp instead of producing out-of-range values.
    expect(automationValueForUnit('opacity', -3)).toBe(0)
    expect(automationValueForUnit('opacity', 3)).toBe(1)
  })

  it('formats dB for volume and a percentage for opacity', () => {
    expect(formatAutomationValue('volume', 0.5)).toBe('-6.0 dB')
    expect(formatAutomationValue('opacity', 0.5)).toBe('50%')
    expect(formatAutomationValue('opacity', 0.123)).toBe('12%')
  })

  it('samples both properties across the clip inclusive of the duration', () => {
    const volume = sampleAutomationCurve(
      clipWith({ keyframes: { volume: VOLUME_CURVE } }),
      'volume',
      5,
    )
    expect(volume).toHaveLength(5)
    expect(volume[0].time).toBe(0)
    expect(volume[4].time).toBe(4)
    expect(volume[2].value).toBe(0.5)

    const opacity = sampleAutomationCurve(
      clipWith({ keyframes: { opacity: OPACITY_CURVE } }),
      'opacity',
      3,
    )
    expect(opacity.map((s) => s.time)).toEqual([0, 2, 4])
    expect(opacity[1].value).toBeCloseTo(0.625, 6)
    expect(opacity[1].unit).toBeCloseTo(0.625, 6)
    expect(sampleAutomationCurve(clipWith(), 'opacity', 0)).toEqual([])
  })
})

describe('adding keyframes', () => {
  it('seeds the first point with the clicked value and default easing', () => {
    const next = addKeyframeAt(clipWith({ opacity: 0.5 }), 'opacity', 1.5, 0.5, 30, 'easeIn')
    expect(next).toEqual([{ time: 1.5, value: 0.5, interpolation: 'easeIn' }])
  })

  it('inserts a sorted point without mutating the input', () => {
    const clip = clipWith({ keyframes: { opacity: OPACITY_CURVE } })
    const before = structuredClone(clip)
    const next = addKeyframeAt(clip, 'opacity', 1, 0.8, 30)
    expect(next.map((k) => k.time)).toEqual([0, 1, 4])
    expect(clip).toEqual(before)
    expect(automationKeyframes(clip, 'opacity')).toHaveLength(2)
  })

  it('replaces a point within one frame at its own time instead of stacking it', () => {
    const clip = clipWith({ keyframes: { opacity: OPACITY_CURVE } })
    const next = addKeyframeAt(clip, 'opacity', 4 - 1 / 60, 0.4, 30)
    expect(next).toHaveLength(2)
    expect(next[1]).toMatchObject({ time: 4, value: 0.4 })
  })

  it('does not replace a point outside one frame', () => {
    const clip = clipWith({ keyframes: { opacity: OPACITY_CURVE } })
    const next = addKeyframeAt(clip, 'opacity', 3.9, 0.4, 30)
    expect(next).toHaveLength(3)
  })

  it('clamps time and value at hostile inputs', () => {
    const clip = clipWith({ duration: 4, keyframes: { opacity: OPACITY_CURVE } })
    expect(addKeyframeAt(clip, 'opacity', -1, -5, 30)[0]).toMatchObject({ time: 0, value: 0 })
    expect(addKeyframeAt(clip, 'opacity', 99, 5, 30).at(-1)).toMatchObject({
      time: 4,
      value: 1,
    })
    expect(addKeyframeAt(clip, 'opacity', Number.NaN, Number.NaN, 30)).toHaveLength(2)
    expect(addKeyframeAt(clip, 'opacity', 2, 0.5, Number.NaN)).toHaveLength(3)
    expect(addKeyframeAt(clip, 'opacity', 2, 0.5, 0)).toHaveLength(3)
  })

  it('keeps volume values inside the gain bounds and reuses the volume add path', () => {
    const clip = clipWith({ gain: 0.5, keyframes: { volume: VOLUME_CURVE } })
    const next = addKeyframeAt(clip, 'volume', 1, 9, 30)
    expect(next.map((k) => k.time)).toEqual([0, 1, 2, 4])
    expect(next[1].value).toBe(2)
    const first = addKeyframeAt(clipWith({ gain: 0.5 }), 'volume', 2, 0.5, 30)
    expect(first).toEqual([{ time: 2, value: 0.5, interpolation: 'linear' }])
  })
})

describe('removing keyframes', () => {
  it('removes the nearest point within one frame', () => {
    const clip = clipWith({ keyframes: { opacity: OPACITY_CURVE } })
    const next = removeKeyframeAt(clip, 'opacity', 4 - 1 / 60, 30)
    expect(next).toEqual([OPACITY_CURVE[0]])
  })

  it('leaves an unmatched removal unchanged and never mutates the input', () => {
    const clip = clipWith({ keyframes: { opacity: OPACITY_CURVE } })
    const before = structuredClone(clip)
    const next = removeKeyframeAt(clip, 'opacity', 2, 30)
    expect(next).toEqual(OPACITY_CURVE)
    expect(clip).toEqual(before)
  })

  it('removes the last point and reuses the volume helper', () => {
    const one = clipWith({
      keyframes: { volume: [{ time: 2, value: 0.5, interpolation: 'linear' }] },
    })
    expect(removeKeyframeAt(one, 'volume', 2, 30)).toEqual([])
    expect(removeKeyframeAt(clipWith(), 'volume', 2, 30)).toEqual([])
  })
})

describe('nudging keyframes', () => {
  it('moves time and value, clamping both and re-sorting a crossing', () => {
    const clip = clipWith({ keyframes: { opacity: OPACITY_CURVE } })
    const crossed = nudgeKeyframe(clip, 'opacity', 0, 5, 0)
    expect(crossed.map((k) => k.time)).toEqual([4, 4])
    expect(crossed[0].value).toBe(1)

    const clamped = nudgeKeyframe(clip, 'opacity', 1, -99, -9)
    expect(clamped[1]).toMatchObject({ time: 0, value: 0 })
  })

  it('ignores an out-of-range index and hostile deltas', () => {
    const clip = clipWith({ keyframes: { opacity: OPACITY_CURVE } })
    expect(nudgeKeyframe(clip, 'opacity', -1, 1, 1)).toEqual(OPACITY_CURVE)
    expect(nudgeKeyframe(clip, 'opacity', 9, 1, 1)).toEqual(OPACITY_CURVE)
    const next = nudgeKeyframe(clip, 'opacity', 0, Number.NaN, Number.NaN)
    expect(next).toEqual(OPACITY_CURVE)
  })

  it('reuses the volume move helper', () => {
    const clip = clipWith({ keyframes: { volume: VOLUME_CURVE } })
    const next = nudgeKeyframe(clip, 'volume', 1, 0, 0.5)
    expect(next[1].value).toBe(1)
    expect(next.map((k) => k.time)).toEqual([0, 2, 4])
  })
})
