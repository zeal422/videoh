import { clampPropertyValue, type KeyframeProperty } from './keyframes'
import { clamp } from './time'
import { gainToUnit, unitToGain } from './volume-automation'

/**
 * Pure drag math for the keyframe graph dots (0.20.0), split out of
 * `EffectControlsPanel.tsx` so the geometry can be unit-tested without a DOM.
 * The panel owns the rendering and pointer wiring; the hook owns the gesture
 * lifetime and applies the result.
 */

export interface KeyframeDotDragInput {
  /** The graph strip's client rect (left edge, width, height). */
  rect: { left: number; width: number; height: number }
  clientX: number
  clientY: number
  /** The pointerdown origin: only the vertical delta moves the value. */
  start: { y: number; value: number }
  duration: number
  property: KeyframeProperty
  /** Property bounds, in stored-value space. */
  bounds: { min: number; max: number }
  /** Y-axis presentation: stored values by default, dB for volume. */
  scale: 'linear' | 'db'
  /** True for a reversed clip's timeScale row: the time axis is flipped. */
  mirrored: boolean
}

export interface KeyframeDotPosition {
  time: number
  value: number
}

/** The time/value one pointer frame maps to. Time is absolute; value is a delta. */
export function dragKeyframeDot(input: KeyframeDotDragInput): KeyframeDotPosition {
  const { rect, clientX, clientY, start, duration, property, bounds, scale, mirrored } = input
  const width = Math.max(1e-6, rect.width)
  const height = Math.max(1e-6, rect.height)
  const screen = clamp(((clientX - rect.left) / width) * duration, 0, duration)
  const time = mirrored ? duration - screen : screen

  const nextValue =
    scale === 'db'
      ? unitToGain(clamp(gainToUnit(start.value) + (start.y - clientY) / height, 0, 1))
      : start.value + ((start.y - clientY) / height) * Math.max(1e-6, bounds.max - bounds.min)

  return { time, value: clampPropertyValue(property, nextValue) }
}

export interface KeyframeNudgeInput {
  time: number
  duration: number
  /** Screen-space step (positive moves the dot right on screen). */
  delta: number
  mirrored: boolean
}

/** One keyboard step, clamped to the clip in AXIS space, then stored. */
export function nudgeKeyframeTime(input: KeyframeNudgeInput): number {
  const { time, duration, delta, mirrored } = input
  const screen = mirrored ? duration - time : time
  const next = clamp(screen + delta, 0, duration)
  return mirrored ? duration - next : next
}
