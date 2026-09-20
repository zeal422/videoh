/** Global tuning constants for the editor. */

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
