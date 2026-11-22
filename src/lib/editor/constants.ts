/** Global tuning constants for the editor. */
import type { KeyframeProperty } from './types'

/** Clips can never become shorter than this (seconds). */
export const MIN_CLIP_DURATION = 0.1

/**
 * Upper bound for a clip end and a marker time (seconds). A loaded project
 * above this has over-cap clip ends clamped and over-cap markers dropped, both
 * with a warning; new clip and marker edits are refused. Marker drag handlers
 * also clamp to the sequence or clip end.
 */
export const MAX_TIMELINE_SECONDS = 86_400

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

/** Effect-stack bounds (0.8.6). */
export const MAX_BLUR_SAMPLES = 8
export const CROP_MIN = 0
export const CROP_MAX = 100
export const CROP_FEATHER_MIN = 0
export const CROP_FEATHER_MAX = 100
export const CHROMA_SIMILARITY_MIN = 0
export const CHROMA_SIMILARITY_MAX = 1
export const CHROMA_BLEND_MIN = 0
export const CHROMA_BLEND_MAX = 1
export const CHROMA_CLIP_MIN = 0
export const CHROMA_CLIP_MAX = 1
export const CHROMA_DESPILL_MIN = 0
export const CHROMA_DESPILL_MAX = 1
export const BLUR_SHUTTER_MIN = 0
export const BLUR_SHUTTER_MAX = 360
/** Chroma plane maximum: (Cb,Cr) each span 0..255, so the euclidean max is 255*sqrt(2). */
export const CHROMA_PLANE_MAX = 255 * Math.sqrt(2)
/** Local epsilon for degenerate keyer intervals (hard-step fallback). */
export const CHROMA_EPS = 1e-6

/** Number of waveform peak buckets stored per media asset. */
export const WAVEFORM_BUCKETS = 1000

/** Upper bound for the preview's keyframe lookup (milliseconds). */
export const KEYFRAME_TIMEOUT_MS = 3_000

/** Default timeline duration assigned to image clips (seconds). */
export const DEFAULT_IMAGE_DURATION = 4

/** Duration of the still clip Freeze Frame creates (seconds). */
export const FREEZE_FRAME_DURATION = 2

/** Default timeline duration assigned to new text clips (seconds). */
export const DEFAULT_TEXT_DURATION = 4

/** Default timeline duration assigned to new shape clips (seconds). */
export const DEFAULT_SHAPE_DURATION = 5

/** Shape bounds (0.25.0). Colors are validated separately as `#rrggbb`. */
export const SHAPE_STROKE_MAX = 40
export const SHAPE_RADIUS_MAX = 400
export const SHAPE_POINTS_MIN = 3
export const SHAPE_POINTS_MAX = 12
export const SHAPE_POINTS_DEFAULT = 5
export const SHAPE_FILL_DEFAULT = '#ffffff'
export const SHAPE_STROKE_DEFAULT = '#000000'
export const SHAPE_STROKE_WIDTH_DEFAULT = 4
/** The shape path box is centered and covers this fraction of each frame axis. */
export const SHAPE_FRAME_SCALE = 0.8

/** Largest accepted custom font file (bytes). */
export const FONT_FILE_MAX_BYTES = 8 * 1024 * 1024
/** Largest display name for a project font (characters). */
export const FONT_NAME_MAX = 64
export const FONT_WEIGHT_MIN = 100
export const FONT_WEIGHT_MAX = 900
export const FONT_WEIGHT_DEFAULT = 400

/** Track groups (0.26.0). One group per track; groups are shortcuts over member flags. */
export const TRACK_GROUP_NAME_MAX = 64
export const TRACK_GROUPS_MAX = 32

/** Brand kit (0.26.0): saved hex colors and font family references. */
export const BRAND_COLOR_NAME_MAX = 48
export const BRAND_COLORS_MAX = 24
export const BRAND_FONT_FAMILIES_MAX = 16

/** Local templates (0.26.0): deterministic sequence descriptions, never media. */
export const TEMPLATE_VERSION = 1
export const TEMPLATE_NAME_MAX = 64
export const TEMPLATE_DESCRIPTION_MAX = 200
export const TEMPLATE_MAX_TRACKS = 24
export const TEMPLATE_MAX_CLIPS = 200
export const TEMPLATE_MAX_TEXT_LENGTH = 500
/** Longest local timeline a template may describe (seconds). */
export const TEMPLATE_MAX_DURATION = 3600

/** Built-in animated text preset timings (seconds). */
export const TEXT_ANIMATION_FADE_SECONDS = 0.6
export const TEXT_ANIMATION_SLIDE_SECONDS = 0.6
export const TEXT_ANIMATION_POP_SECONDS = 0.5
export const TEXT_ANIMATION_REVEAL_SECONDS = 1.5
/** Shortest clip a built-in animation preset will animate (seconds). */
export const TEXT_ANIMATION_MIN_CLIP_DURATION = 0.2

/** Timeline zoom limits (pixels per second). */
export const PPS_MIN = 1
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
export const TRACK_HEADER_WIDTH = 168

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

/** EQ band centres (Hz) for the three-band biquad stack (low shelf, mid peak, high shelf). */
export const EQ_LOW_HZ = 200
export const EQ_MID_HZ = 1000
export const EQ_HIGH_HZ = 4000

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
/** Rotation limits in degrees (0.24.0): ten turns each way, authored value kept. */
export const ROTATION_MIN = -3600
export const ROTATION_MAX = 3600
/** Monitor rotation snapping (0.29.5): nearest 15-degree step within 3 degrees. */
export const ROTATION_SNAP_STEP = 15
export const ROTATION_SNAP_THRESHOLD = 3

/** Legal value bounds + neutral defaults per animatable property. */
export const KEYFRAME_PROPERTY_BOUNDS: Record<
  KeyframeProperty,
  { min: number; max: number; default: number }
> = {
  opacity: { min: OPACITY_MIN, max: OPACITY_MAX, default: 1 },
  positionX: { min: POSITION_MIN, max: POSITION_MAX, default: 0 },
  positionY: { min: POSITION_MIN, max: POSITION_MAX, default: 0 },
  scale: { min: SCALE_MIN, max: SCALE_MAX, default: 1 },
  rotation: { min: ROTATION_MIN, max: ROTATION_MAX, default: 0 },
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

/**
 * Recording limits (0.27.0). MediaRecorder buffers every chunk in memory until
 * stop, so a cap is what keeps a long take from crashing the tab and losing the
 * recording. At the explicit bitrates below, ten minutes stays under the byte
 * cap and the time cap binds first.
 */
export const RECORDING_MAX_SECONDS = 600
/** The hard ceiling: a chunk that would cross it is dropped from the take. */
export const RECORDING_MAX_BYTES = 512 * 1024 * 1024
/** The stop trigger leaves room for the last buffered chunks under the ceiling. */
export const RECORDING_CAP_HEADROOM_BYTES = 32 * 1024 * 1024
export const RECORDING_SOFT_MAX_BYTES = RECORDING_MAX_BYTES - RECORDING_CAP_HEADROOM_BYTES
export const RECORDING_WARN_RATIO = 0.8
export const RECORDING_VIDEO_BITS_PER_SECOND = 6_000_000
export const RECORDING_AUDIO_BITS_PER_SECOND = 128_000
