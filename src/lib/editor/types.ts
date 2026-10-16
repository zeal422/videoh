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

/** A saved text style (0.8.3), applied via `setTextStyle`, never touches text. */
export interface TextPreset {
  id: string
  name: string
  style: TextStyle
}

/** Cross-dissolve, dip-to-black, or a spatial move into the next clip (0.8.4 adds the spatial types). */
export type TransitionType = 'crossfade' | 'dipToBlack' | 'wipe' | 'slide' | 'push'

/** Edge the incoming picture enters from for wipe/slide/push. Defaults to 'left'. */
export type TransitionDirection = 'left' | 'right' | 'up' | 'down'

/** Wipe boundary look. Read by wipe only. Defaults to 'hard'. */
export type WipeEdge = 'hard' | 'feathered'

export interface Transition {
  type: TransitionType
  duration: number
  /** Edge the incoming picture enters from. Read by wipe/slide/push. Defaults to 'left'. */
  direction?: TransitionDirection
  /** Wipe boundary look. Read by wipe only. Defaults to 'hard'. */
  edge?: WipeEdge
  /** Feather width as a fraction of the motion-axis frame dimension, 0..0.5. Read by feathered wipes. Defaults to 0.1. */
  feather?: number
}

/**
 * Interpolation of the segment that STARTS at a keyframe (the curve runs from
 * this keyframe to the next one). The named easings are Premiere's defaults;
 * see bezier.ts for their control points. Unknown values read as 'linear'.
 */
export type KeyframeInterpolation = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut'

/** One keyframe: clip-local time (seconds from clip start) and clamped value. */
export interface Keyframe {
  time: number
  value: number
  interpolation?: KeyframeInterpolation
  /**
   * Exact shape of the segment that STARTS here, as cubic-bezier(x1, y1,
   * x2, y2) control data (see `ease-segment.ts`). Absent means the preset
   * `interpolation` names (linear when that is absent too), so files written
   * before the field existed read identically. Written by the split and trim
   * rebases, which subdivide an eased segment at the cut instead of
   * re-approximating it from the preset name.
   */
  easeOut?: readonly [number, number, number, number]
}

/**
 * The animatable per-clip properties (0.5.0): opacity, position, scale,
 * volume and the ctx.filter color set. A property is animated when its
 * keyframe array exists and is non-empty; otherwise the static value wins.
 *
 * `timeScale` (0.6.0) is the odd one out: its curve is a time-remap ramp, so
 * it is read through `sourceTimeAt`'s integral rather than as a per-frame
 * value, and its static source is the clip's `speed` field.
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
  | 'timeScale'

/**
 * Per-property default easing for newly authored keyframes (0.6.4). Absent
 * entries read as linear, and a linear default is never STORED (the command
 * deletes it), so an absent field and a linear default are the same thing.
 */
export type KeyframeDefaults = Partial<Record<KeyframeProperty, KeyframeInterpolation>>

/**
 * Animatable properties that keep a static value in `clip.animStatics`.
 * opacity and volume have dedicated fields and timeScale's static source is
 * `clip.speed`, so none of the three belongs here.
 */
export type AnimStaticProperty = Exclude<KeyframeProperty, 'opacity' | 'volume' | 'timeScale'>

/** Cube LUT kinds: a 1D shaper (three per-channel tables) or a 3D cube. */
export type LutKind = '1d' | '3d'

/**
 * One project-level LUT library entry (0.7.0), parsed from a `.cube` file.
 *
 * The grid is stored as base64 of 8-bit RGB bytes, which is what keeps a
 * project file small: a 33-cube is about 144 KB here instead of roughly 1 MB of
 * JSON decimals. `size` is the entries per axis (`LUT_1D_SIZE` / `LUT_3D_SIZE`),
 * so `data` decodes to `size * 3` bytes for a shaper and `size^3 * 3` for a
 * cube, red varying fastest (the `.cube` row order). 8 bits costs nothing
 * visible because the render pass runs on a `Uint8ClampedArray` canvas buffer.
 *
 * A library entry is shared: many clips can hold the same `lutId`, and the
 * library holds one copy per unique import.
 */
export interface ProjectLut {
  id: string
  name: string
  kind: LutKind
  size: number
  /** base64 of the 8-bit RGB grid (see the interface doc for the byte count). */
  data: string
}

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
  /**
   * Broadband noise reduction (0.6.0): a rumble high-pass, a hiss low-pass and
   * a narrow cut in the hiss band, all fixed Web Audio biquads. Undefined = off.
   * Both render paths build the same chain from the DENOISE_* constants.
   */
  denoise?: boolean
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
  animStatics?: Partial<Record<AnimStaticProperty, number>>
  /** Per-property keyframe curves, when animated. See keyframes.ts. */
  keyframes?: KeyframeMap
  /**
   * White-balance grade, -100 (cool/blue) .. 100 (warm/orange), 0 = neutral
   * (0.6.0). Static, and not part of the ctx.filter chain: it compiles to an
   * SVG feColorMatrix (`color.ts`) that both render paths reference by id.
   */
  temperature?: number
  /**
   * Green/magenta grade, -100 (magenta) .. 100 (green), 0 = neutral (0.6.0).
   * Static, same SVG matrix path as `temperature`.
   */
  tint?: number
  /**
   * Reference into `Project.luts` (0.7.0): the `.cube` this clip grades
   * through. Undefined = no LUT. A `1d` entry rides the shared SVG filter
   * string as per-channel shapers; a `3d` entry runs a per-frame pixel pass
   * (see `lut.ts`). A `lutId` naming no library entry hydrates to nothing, so a
   * set id always resolves.
   */
  lutId?: string
  /**
   * Reference into `Project.sequences` (0.8.1): this clip is a COMPOUND that
   * composites the referenced sequence at container-local time. Mutually
   * exclusive with `mediaId`, `text` and `audioOnly`; it renders picture, so
   * it lives on a video track. Its own visual/audio container properties
   * (opacity, transform, grade, gain, mute, volume curve) apply to the
   * composited nested result as a group.
   */
  sequenceId?: string
}

export interface Track {
  id: string
  kind: TrackKind
  name: string
  /** Mutes the whole track (audio only; video frames still render). */
  muted?: boolean
  clips: Clip[]
}

/**
 * A compound clip's referenced sequence (0.8.1). Lives on `Project.sequences`
 * and is SHARED by every compound clip that references it, so editing the
 * sequence propagates to all of its containers (the roadmap's "reusable unit").
 * `tracks[0]` is the topmost layer, the same convention as `Project.tracks`.
 */
export interface Sequence {
  id: string
  name: string
  tracks: Track[]
}

export interface Project {
  id: string
  name: string
  width: number
  height: number
  fps: number
  /** Sequence markers, `time` in timeline seconds (see {@link Marker}). */
  markers?: Marker[]
  /**
   * Per-property default easing for newly authored keyframes; an absent entry
   * reads as linear (see {@link KeyframeDefaults}).
   */
  keyframeDefaults?: KeyframeDefaults
  /**
   * The project's LUT library (0.7.0): one entry per unique imported `.cube`,
   * referenced by `Clip.lutId`. Lives on the project (not on `Doc`) so it
   * travels with the edit and hydrates beside `keyframeDefaults`.
   */
  luts?: ProjectLut[]
  /**
   * Compound clip sequences (0.8.1), referenced by `Clip.sequenceId`. Shared
   * by every container that references one, and pruned when the last reference
   * is removed. Absent for a project with no compound clips.
   */
  sequences?: Sequence[]
  /**
   * The project's title preset library (0.8.3): user-saved text styles.
   * Lives on the project (not on `Doc`) so it travels with the edit,
   * like `luts`. Absent for a project with no saved presets.
   */
  textPresets?: TextPreset[]
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
