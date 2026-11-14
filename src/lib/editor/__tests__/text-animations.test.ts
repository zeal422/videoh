import { describe, expect, it } from 'vitest'

import {
  TEXT_ANIMATION_PRESETS,
  buildTextAnimation,
  getTextAnimationPreset,
  textAnimationPropertyLabel,
} from '../text-animations'
import { clipTransform } from '../export/offline'
import { createTextClip } from '../factories'
import {
  TEXT_ANIMATION_FADE_SECONDS,
  TEXT_ANIMATION_MIN_CLIP_DURATION,
  TEXT_ANIMATION_POP_SECONDS,
  TEXT_ANIMATION_REVEAL_SECONDS,
  TEXT_ANIMATION_SLIDE_SECONDS,
} from '../constants'

describe('built-in animated text presets (0.25.0)', () => {
  it('ships four distinct presets in picker order', () => {
    expect(TEXT_ANIMATION_PRESETS.map((preset) => preset.name)).toEqual([
      'Fade In',
      'Slide Up',
      'Pop',
      'Slow Reveal',
    ])
    expect(new Set(TEXT_ANIMATION_PRESETS.map((preset) => preset.id)).size).toBe(4)
    expect(getTextAnimationPreset('anim_pop')?.duration).toBe(TEXT_ANIMATION_POP_SECONDS)
    expect(getTextAnimationPreset('missing')).toBeUndefined()
  })

  it('builds the fade-in opacity curve with the documented easing', () => {
    const built = buildTextAnimation('anim_fade_in', 4)!
    expect(built.keyframes.opacity).toEqual([
      { time: 0, value: 0, interpolation: 'easeOut' },
      { time: TEXT_ANIMATION_FADE_SECONDS, value: 1, interpolation: 'linear' },
    ])
  })

  it('builds the slide-up position curve', () => {
    const built = buildTextAnimation('anim_slide_up', 4)!
    expect(built.keyframes.positionY).toEqual([
      { time: 0, value: 120, interpolation: 'easeOut' },
      { time: TEXT_ANIMATION_SLIDE_SECONDS, value: 0, interpolation: 'linear' },
    ])
  })

  it('builds the pop overshoot with three keyframes', () => {
    const built = buildTextAnimation('anim_pop', 4)!
    expect(built.keyframes.scale).toEqual([
      { time: 0, value: 0.6, interpolation: 'easeOut' },
      { time: TEXT_ANIMATION_POP_SECONDS * 0.7, value: 1.06, interpolation: 'easeInOut' },
      { time: TEXT_ANIMATION_POP_SECONDS, value: 1, interpolation: 'linear' },
    ])
  })

  it('builds the slow reveal with ease in and out', () => {
    const built = buildTextAnimation('anim_slow_reveal', 4)!
    expect(built.keyframes.opacity).toEqual([
      { time: 0, value: 0, interpolation: 'easeInOut' },
      { time: TEXT_ANIMATION_REVEAL_SECONDS, value: 1, interpolation: 'linear' },
    ])
  })

  it('scales every keyframe time into a shorter clip', () => {
    const built = buildTextAnimation('anim_pop', 0.25)!
    expect(built.keyframes.scale?.map((keyframe) => keyframe.time)).toEqual([0, 0.25 * 0.7, 0.25])
    expect(buildTextAnimation('anim_fade_in', TEXT_ANIMATION_MIN_CLIP_DURATION - 0.01)).toBeNull()
    expect(buildTextAnimation('anim_fade_in', Number.NaN)).toBeNull()
  })

  it('does not mutate the authored preset curves', () => {
    const built = buildTextAnimation('anim_pop', 4)!
    built.keyframes.scale![0].value = 3
    const fresh = buildTextAnimation('anim_pop', 4)!
    expect(fresh.keyframes.scale![0].value).toBe(0.6)
  })

  it('names the property in the command refusal', () => {
    expect(textAnimationPropertyLabel('opacity')).toBe('Opacity')
    expect(textAnimationPropertyLabel('positionY')).toBe('Position Y')
    expect(textAnimationPropertyLabel('scale')).toBe('Scale')
  })

  it('resolves the slide through the shared clip transform both render paths use', () => {
    const clip = createTextClip({ duration: 4 })
    clip.keyframes = buildTextAnimation('anim_slide_up', 4)!.keyframes
    expect(clipTransform(clip, 0)?.posY).toBe(120)
    // At the end the transform is neutral, so the shared helper returns null
    // (both render paths treat that as the identity).
    expect(clipTransform(clip, 0.6)).toBeNull()
    const midway = clipTransform(clip, 0.3)?.posY ?? 0
    expect(midway).toBeGreaterThan(0)
    expect(midway).toBeLessThan(120)
  })
})
