/** Global tuning constants for the editor. */
import type { KeyframeProperty } from './types'

/** Clips can never become shorter than this (seconds). */
export const MIN_CLIP_DURATION = 0.1

/** Minimum gap left when splitting a clip (seconds from each side). */
export const MIN_SPLIT_HEADROOM = 0.1

/** Audio gain limits (linear). 1 = unity, 2 = +6 dB. */
export const GAIN_MIN = 0
export const GAIN_MAX = 2

/** Clip visual opacity limits. 1 = fully opaque, 0 = invisible. */
export const OPACITY_MIN = 0
export const OPACITY_MAX = 1

/** Cross-dissolve duration limits (seconds). */
export const TRANSITION_MIN = 0.1
export const TRANSITION_MAX = 4

/** Number of waveform peak buckets stored per media asset. */
export const WAVEFORM_BUCKETS = 1000

/** Default timeline duration assigned to image clips (seconds). */
export const DEFAULT_IMAGE_DURATION = 4

/** Default timeline duration assigned to new text clips (seconds). */
export const DEFAULT_TEXT_DURATION = 4

/** Timeline zoom limits (pixels per second). */
export const PPS_MIN = 10
export const PPS_MAX = 400
export const PPS_DEFAULT = 80

/** Snap threshold in on-screen pixels (converted to seconds via pxPerSec). */
export const SNAP_THRESHOLD_PX = 8

/** Upper bound of the undo stack (whole-Doc snapshots — cheap at JSON scale). */
export const HISTORY_LIMIT = 100

/**
 * Maximum compound-clip nesting depth (child edges), with the project root at
 * depth 0 (0.8.1). Creation refuses a compound that would exceed it and v4
 * hydration rejects a file that does; the same limit bounds the render
 * recursion and the group-composite scratch stack.
 */
export const MAX_SEQUENCE_DEPTH = 8

/** Project setting limits. */
export const PROJECT_MIN_W = 64
export const PROJECT_MAX_W = 3840
export const PROJECT_MIN_H = 64
export const PROJECT_MAX_H = 2160
export const FPS_MIN = 1
export const FPS_MAX = 60

/** Sticky track-header column width in the timeline (px). */
export const TRACK_HEADER_WIDTH = 160

/** Frames stepped by Shift+← / Shift+→ (Premiere default). */
export const FRAME_STEPS = 5

/** Clip speed limits (linear multiplier, 1 = normal). */
export const SPEED_MIN = 0.25
export const SPEED_MAX = 4

/** Color filter parameter bounds (ctx.filter semantics). */
export const EXPOSURE_MIN = 0.25
export const EXPOSURE_MAX = 4
export const CONTRAST_MIN = 0
export const CONTRAST_MAX = 2
export const SATURATION_MIN = 0
export const SATURATION_MAX = 2
export const BRIGHTNESS_MIN = 0
export const BRIGHTNESS_MAX = 2
/** Hue rotation in degrees (-180..180). */
export const HUE_MIN = -180
export const HUE_MAX = 180

/** Temperature/tint grading bounds (relative units, 0 = neutral). */
export const TEMPERATURE_MIN = -100
export const TEMPERATURE_MAX = 100
export const TINT_MIN = -100
export const TINT_MAX = 100

/** EQ band gain limits (dB) for the three-band biquad stack. */
export const EQ_DB_MIN = -24
export const EQ_DB_MAX = 24

/**
 * Noise-reduction chain (0.6.0), shared by the preview mixer and the export
 * mix so the two stay identical: a rumble high-pass, a hiss low-pass and a
 * gentle narrow cut over the hiss band. Deliberately fixed (no user tuning).
 */
export const DENOISE_HIGHPASS_HZ = 80
export const DENOISE_LOWPASS_HZ = 12000
export const DENOISE_HISS_HZ = 6000
export const DENOISE_HISS_DB = -6
export const DENOISE_HISS_Q = 1

/**
 * The high-pass/low-pass corner Q, in DECIBELS. Web Audio reads Q as dB for
 * lowpass/highpass (linear for every other type), so 0.7 dB is really a linear
 * Q of 1.084, which rings the passband +1.7 dB over the voice fundamental.
 * -3.0103 dB is the Butterworth corner (linear 1/sqrt(2)): flat up to the
 * corner, so the denoiser never boosts what it is meant to clean.
 */
export const DENOISE_CORNER_Q_DB = 20 * Math.log10(1 / Math.SQRT2)

/** Crossfade/automation epsilon for time comparisons. */
export const TIME_EPSILON = 1e-6

/** Visual transform limits (position in project-px offsets, scale multiplier). */
export const POSITION_MIN = -2000
export const POSITION_MAX = 2000
export const SCALE_MIN = 0.1
export const SCALE_MAX = 4

/** Legal value bounds + neutral defaults per animatable property. */
export const KEYFRAME_PROPERTY_BOUNDS: Record<
  KeyframeProperty,
  { min: number; max: number; default: number }
> = {
  opacity: { min: OPACITY_MIN, max: OPACITY_MAX, default: 1 },
  positionX: { min: POSITION_MIN, max: POSITION_MAX, default: 0 },
  positionY: { min: POSITION_MIN, max: POSITION_MAX, default: 0 },
  scale: { min: SCALE_MIN, max: SCALE_MAX, default: 1 },
  volume: { min: GAIN_MIN, max: GAIN_MAX, default: 1 },
  exposure: { min: EXPOSURE_MIN, max: EXPOSURE_MAX, default: 1 },
  contrast: { min: CONTRAST_MIN, max: CONTRAST_MAX, default: 1 },
  saturation: { min: SATURATION_MIN, max: SATURATION_MAX, default: 1 },
  brightness: { min: BRIGHTNESS_MIN, max: BRIGHTNESS_MAX, default: 1 },
  hue: { min: HUE_MIN, max: HUE_MAX, default: 0 },
  // A time-remap ramp: the curve is in speed multipliers (1 = normal).
  timeScale: { min: SPEED_MIN, max: SPEED_MAX, default: 1 },
}

/** Keyboard nudge for one easing handle, in normalized curve coordinates. */
export const EASE_HANDLE_KEYBOARD_STEP = 0.02
