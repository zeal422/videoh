/**
 * Core data model for the Web Video Editor.
 *
 * ## Conventions (non-negotiable)
 * - **All time values are seconds (floats).** Timeline positions use `start` / `duration`;
 *   source-relative positions use `inPoint`.
 * - **Single source of truth:** the entire edit is one serializable {@link Doc} object.
 *   The UI is a view of it; every mutation goes through a named command (`commands.ts`).
 * - **Track order defines compositing z-order:** `tracks[0]` is the *topmost* layer.
 *   The compositor draws tracks from last to first.
 * - Media assets live beside the project in {@link Doc.media}; `MediaAsset.url` is an
 *   in-memory object URL and is **never serialized** (see `serialization.ts`).
 */

export type TrackKind = 'video' | 'audio' | 'text'
export type MediaKind = 'video' | 'audio' | 'image'

/** Marker colors (content data, not theme tokens). Green is the default. */
export type MarkerColor =
  'green' | 'red' | 'orange' | 'yellow' | 'blue' | 'cyan' | 'purple' | 'magenta'

/**
 * A timeline or clip marker. `time` is in seconds, and its basis depends on
 * the owner: sequence markers (`Project.markers`) use timeline seconds, clip
 * markers (`Clip.markers`) use SOURCE seconds, the same basis as
 * `Clip.inPoint`, so they stay pinned to the media through trims, speed
 * changes and reversal. Both are point positions.
 */
export interface Marker {
  id: string
  time: number
  name?: string
  color?: MarkerColor
  notes?: string
}

/** Fields a marker update command may patch. */
export type MarkerPatch = Partial<Pick<Marker, 'name' | 'color' | 'notes'>>

/** Styling options for a text clip. Font size is expressed in project-space pixels. */
export interface TextStyle {
  /** Font size in project-space pixels (e.g. 64 at 1080p). */
  fontSize: number
  color: string
  fontFamily: string
  bold: boolean
  italic: boolean
  align: 'left' | 'center' | 'right'
  /** Horizontal anchor, 0..1 relative to project width. */
  x: number
  /** Vertical anchor, 0..1 relative to project height. */
  y: number
  shadow: boolean
}

/** Only cross-dissolve is supported in 0.5.0. */
export interface Transition {
  type: 'crossfade'
  duration: number
}

/** Interpolation between two keyframes. Only linear ships in 0.5.0; the field exists so eased curves can be added without a schema break. */
export type KeyframeInterpolation = 'linear'

/** One keyframe: clip-local time (seconds from clip start) and clamped value. */
export interface Keyframe {
  time: number
  value: number
  interpolation?: KeyframeInterpolation
}

/**
 * The animatable per-clip properties (0.5.0): opacity, position, scale,
 * volume and the ctx.filter color set. A property is animated when its
 * keyframe array exists and is non-empty; otherwise the static value wins.
 */
export type KeyframeProperty =
  | 'opacity'
  | 'positionX'
  | 'positionY'
  | 'scale'
  | 'volume'
  | 'exposure'
  | 'contrast'
  | 'saturation'
  | 'brightness'
  | 'hue'

/**
 * A clip is an occurrence of media (or text) on a track.
 * `duration` may differ from the source length: trimming changes
 * `inPoint` (left edge) and/or `duration` (right edge). With `speed` set,
 * the source span consumed is `duration × speed`.
 */
export interface Clip {
  id: string
  /** Reference into `Doc.media`. Undefined for text clips. */
  mediaId?: string
  /**
   * Links the video part and the audio part of the same source occurrence
   * (Premiere-style A/V linked clips). All clips sharing a `linkId` behave as
   * one: selected/moved/deleted/split together until unlinked.
   */
  linkId?: string
  /**
   * True for the audio part of an A/V pair (or any audio-only occurrence of a
   * video asset): the clip carries sound but never picture, which is what
   * allows it to live on `audio` tracks despite referencing a video asset.
   */
  audioOnly?: boolean
  /** Timeline start in seconds. Always >= 0. */
  start: number
  /** Timeline duration in seconds. Always > MIN_CLIP_DURATION. */
  duration: number
  /** Source time (seconds) where playback starts. >= 0 for media clips. */
  inPoint: number
  /**
   * Playback rate multiplier (0.25..4, default 1): timeline duration = source
   * span / speed. Absent means 1. Text clips cannot be re-timed.
   */
  speed?: number
  /**
   * Play this clip backwards (video clips only, 0.5.0). Export decodes the
   * source span backwards; preview shows a stepped approximation and the
   * clip's audio is dropped (Premiere drops it too).
   */
  reverse?: boolean
  /** Linear audio gain, 0..GAIN_MAX (default 1). Static source for the volume property. */
  gain?: number
  /** Stereo pan, -1 (left) .. 1 (right), default 0. Static (not animatable in 0.5.0). */
  pan?: number
  /**
   * Three-band EQ, dB gains -24..24 (low shelf 200 Hz, mid peak 1 kHz,
   * high shelf 4 kHz). Undefined = flat/off.
   */
  eq?: { low: number; mid: number; high: number }
  /** DynamicsCompressor with fixed musical defaults (threshold -24 dB, ratio 4). */
  compressor?: boolean
  muted?: boolean
  /**
   * Visual opacity, 0..1 (default 1). Multiplies into every draw of this clip
   * (video/image/text) and stacks with crossfade alphas — how higher tracks
   * see-through to lower ones (layering, Premiere/Photoshop style).
   */
  opacity?: number
  /** Text content — present for text clips only. */
  text?: string
  style?: TextStyle
  /** Cross-dissolve into the next clip on the same track. */
  transitionOut?: Transition
  /** Clip markers, `time` in source seconds (see {@link Marker}). */
  markers?: Marker[]
  /**
   * Static values for animatable properties without keyframes (position,
   * scale, the color set). Absent fields mean neutral defaults. opacity and
   * volume keep their dedicated fields as the static source.
   */
  animStatics?: Partial<Record<Exclude<KeyframeProperty, 'opacity' | 'volume'>, number>>
  /** Per-property keyframe curves, when animated. See keyframes.ts. */
  keyframes?: KeyframeMap
}

export interface Track {
  id: string
  kind: TrackKind
  name: string
  /** Mutes the whole track (audio only; video frames still render). */
  muted?: boolean
  clips: Clip[]
}

export interface Project {
  id: string
  name: string
  width: number
  height: number
  fps: number
  /** Sequence markers, `time` in timeline seconds (see {@link Marker}). */
  markers?: Marker[]
  /** Index 0 = topmost layer. Conventional order: text tracks, video tracks, audio tracks. */
  tracks: Track[]
}

export interface MediaAsset {
  id: string
  name: string
  kind: MediaKind
  /** Source duration in seconds. Images report 0 (they have intrinsic unlimited length). */
  duration: number
  width: number
  height: number
  /** Object URL — in-memory only, never serialized. */
  url: string
  /**
   * The source File handle for this session (never serialized). The WebCodecs
   * export pipeline reads frames/audio straight from it (MediaAsset only
   * carries the object URL, which cannot be decoded frame-accurately).
   */
  file?: File
  /** Small JPEG dataURL used by the media bin. */
  thumbnail?: string
  /**
   * True when the file has a decodable audio track (probed at import).
   * Audio assets are implicitly `true`; `undefined` on legacy saves means
   * "unknown" — `assetHasAudio()` falls back to the waveform-peaks heuristic.
   */
  hasAudio?: boolean
  /**
   * Normalized waveform peaks (0..1), `WAVEFORM_BUCKETS` buckets spanning the
   * full source duration. Optional — missing when audio could not be decoded.
   */
  waveformPeaks?: number[]
  /** True when the project was loaded from disk and this asset has no `url` yet. */
  missing?: boolean
}

/**
 * The complete editable document — the unit of undo/redo, autosave and
 * project serialization. Everything the editor renders derives from this.
 */
export interface Doc {
  project: Project
  media: MediaAsset[]
}

/** Playback-time view of a media asset resolved for a specific clip. */
export interface ResolvedMediaRef {
  asset: MediaAsset
  /** Video element (per-clip) for video assets; image element for images. */
  el?: HTMLVideoElement | HTMLImageElement
}

/** Per-property keyframe arrays, time-sorted, clip-local times. */
export type KeyframeMap = Partial<Record<KeyframeProperty, Keyframe[]>>
