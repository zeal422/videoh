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

/** Only cross-dissolve is supported in the MVP. */
export interface Transition {
  type: 'crossfade'
  duration: number
}

/**
 * A clip is an occurrence of media (or text) on a track.
 * `duration` may differ from the source length: trimming changes
 * `inPoint` (left edge) and/or `duration` (right edge).
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
  /** Linear audio gain, 0..GAIN_MAX (default 1). */
  gain?: number
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
