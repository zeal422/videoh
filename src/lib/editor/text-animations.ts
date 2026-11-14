/**
 * text-animations.ts: the four built-in animated text presets (0.25.0).
 *
 * A preset is a command-side batch of ordinary keyframes: no persisted preset
 * format, no new animation engine. Each builder returns curves relative to the
 * clip start, scaled down when the clip is shorter than the preset's authored
 * length. The command layer refuses to overwrite an existing curve.
 */

import {
  TEXT_ANIMATION_FADE_SECONDS,
  TEXT_ANIMATION_MIN_CLIP_DURATION,
  TEXT_ANIMATION_POP_SECONDS,
  TEXT_ANIMATION_REVEAL_SECONDS,
  TEXT_ANIMATION_SLIDE_SECONDS,
} from './constants'
import type { Keyframe, KeyframeInterpolation, KeyframeProperty } from './types'

export type TextAnimationProperty = Extract<KeyframeProperty, 'opacity' | 'positionY' | 'scale'>

export interface TextAnimationPreset {
  id: string
  name: string
  /** Authored length in seconds; shorter clips scale the curve down. */
  duration: number
  /** One-line description shown beside the apply control. */
  description: string
  properties: Partial<Record<TextAnimationProperty, readonly Keyframe[]>>
}

export interface BuiltTextAnimation {
  preset: TextAnimationPreset
  keyframes: Partial<Record<TextAnimationProperty, Keyframe[]>>
}

const linear = 'linear' satisfies KeyframeInterpolation
const easeOut = 'easeOut' satisfies KeyframeInterpolation
const easeInOut = 'easeInOut' satisfies KeyframeInterpolation

/** Authored presets, in picker order. Curves are cloned per application. */
export const TEXT_ANIMATION_PRESETS: readonly TextAnimationPreset[] = [
  {
    id: 'anim_fade_in',
    name: 'Fade In',
    duration: TEXT_ANIMATION_FADE_SECONDS,
    description: 'Opacity 0 to 100%, ease out.',
    properties: {
      opacity: [
        { time: 0, value: 0, interpolation: easeOut },
        { time: TEXT_ANIMATION_FADE_SECONDS, value: 1, interpolation: linear },
      ],
    },
  },
  {
    id: 'anim_slide_up',
    name: 'Slide Up',
    duration: TEXT_ANIMATION_SLIDE_SECONDS,
    description: 'Slides 120 px up into place, ease out.',
    properties: {
      positionY: [
        { time: 0, value: 120, interpolation: easeOut },
        { time: TEXT_ANIMATION_SLIDE_SECONDS, value: 0, interpolation: linear },
      ],
    },
  },
  {
    id: 'anim_pop',
    name: 'Pop',
    duration: TEXT_ANIMATION_POP_SECONDS,
    description: 'Scale 60% to 106% to 100%, quick overshoot.',
    properties: {
      scale: [
        { time: 0, value: 0.6, interpolation: easeOut },
        { time: TEXT_ANIMATION_POP_SECONDS * 0.7, value: 1.06, interpolation: easeInOut },
        { time: TEXT_ANIMATION_POP_SECONDS, value: 1, interpolation: linear },
      ],
    },
  },
  {
    id: 'anim_slow_reveal',
    name: 'Slow Reveal',
    duration: TEXT_ANIMATION_REVEAL_SECONDS,
    description: 'A slower opacity reveal, ease in and out.',
    properties: {
      opacity: [
        { time: 0, value: 0, interpolation: easeInOut },
        { time: TEXT_ANIMATION_REVEAL_SECONDS, value: 1, interpolation: linear },
      ],
    },
  },
]

export function getTextAnimationPreset(id: string): TextAnimationPreset | undefined {
  return TEXT_ANIMATION_PRESETS.find((preset) => preset.id === id)
}

/**
 * Builds the curves for a clip. `clipDuration` scales every keyframe time
 * proportionally when it is shorter than the authored duration; a clip shorter
 * than the minimum animation window returns null (the command refuses).
 */
export function buildTextAnimation(id: string, clipDuration: number): BuiltTextAnimation | null {
  const preset = getTextAnimationPreset(id)
  if (!preset) return null
  if (!Number.isFinite(clipDuration) || clipDuration < TEXT_ANIMATION_MIN_CLIP_DURATION) return null
  const end = Math.min(preset.duration, clipDuration)
  const scale = end / preset.duration
  const keyframes: Partial<Record<TextAnimationProperty, Keyframe[]>> = {}
  for (const [property, curve] of Object.entries(preset.properties) as [
    TextAnimationProperty,
    readonly Keyframe[],
  ][]) {
    keyframes[property] = curve.map((keyframe) => ({
      ...keyframe,
      time: keyframe.time * scale,
    }))
  }
  return { preset, keyframes }
}

/** Human label for the command's refuse-on-existing-curve message. */
export function textAnimationPropertyLabel(property: TextAnimationProperty): string {
  if (property === 'positionY') return 'Position Y'
  if (property === 'scale') return 'Scale'
  return 'Opacity'
}
