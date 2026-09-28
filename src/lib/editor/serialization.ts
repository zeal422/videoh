import { EQ_DB_MAX, EQ_DB_MIN, KEYFRAME_PROPERTY_BOUNDS, SPEED_MAX, SPEED_MIN } from './constants'
import { clampPropertyValue, isAnimatableProperty, sanitizeKeyframes } from './keyframes'
import { applyMarkerPatch, isMarkerColor } from './markers'
import { clamp } from './time'
import type {
  Clip,
  Doc,
  Keyframe,
  KeyframeMap,
  KeyframeProperty,
  Marker,
  MediaAsset,
  Project,
} from './types'

/**
 * Project serialization: `Doc` → JSON file (and back).
 *
 * `MediaAsset.url` (object URLs) can never persist across sessions, so it is
 * stripped on save. On load, assets without a URL are flagged `missing: true`
 * and rendered as "offline" in the UI until the user relinks them.
 */

/**
 * v2 added markers (0.5.5). The loader accepts every version from 1 up to the
 * current one, so v1 files and autosaves load with no markers attached; only
 * files from a NEWER app version are refused.
 */
export const SERIALIZATION_VERSION = 2
export const PROJECT_FILE_EXTENSION = '.veproj.json'

export interface SerializedMedia {
  id: string
  name: string
  kind: string
  duration: number
  width: number
  height: number
  thumbnail?: string
  hasAudio?: boolean
  waveformPeaks?: number[]
  missing?: boolean
}

export interface SerializedDoc {
  version: number
  savedAt: string
  project: Project
  media: SerializedMedia[]
}

export class SerializationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SerializationError'
  }
}

/** Strips non-serializable fields (object URLs) from the doc. */
export function serializeDoc(doc: Doc, savedAt = new Date().toISOString()): SerializedDoc {
  return {
    version: SERIALIZATION_VERSION,
    savedAt,
    project: structuredClone(doc.project),
    media: doc.media.map((m) => ({
      id: m.id,
      name: m.name,
      kind: m.kind,
      duration: m.duration,
      width: m.width,
      height: m.height,
      ...(m.thumbnail ? { thumbnail: m.thumbnail } : {}),
      ...(m.hasAudio !== undefined ? { hasAudio: m.hasAudio } : {}),
      ...(m.waveformPeaks ? { waveformPeaks: m.waveformPeaks } : {}),
    })),
  }
}

/** Parses + validates serialized JSON text into a Doc. Throws SerializationError. */
export function parseSerializedDoc(text: string): {
  doc: Doc
  missingMediaIds: string[]
} {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new SerializationError('File is not valid JSON')
  }
  return deserializeDoc(data)
}

/** Validates an unknown parsed value and converts it into a live Doc. */
export function deserializeDoc(data: unknown): {
  doc: Doc
  missingMediaIds: string[]
} {
  if (typeof data !== 'object' || data === null) {
    throw new SerializationError('Invalid project file: root is not an object')
  }
  const obj = data as Record<string, unknown>
  if (
    typeof obj.version !== 'number' ||
    !Number.isInteger(obj.version) ||
    obj.version < 1 ||
    obj.version > SERIALIZATION_VERSION
  ) {
    throw new SerializationError(`Unsupported project version: ${String(obj.version)}`)
  }
  const projectRaw = obj.project as Record<string, unknown> | undefined
  if (!projectRaw || !Array.isArray(projectRaw.tracks)) {
    throw new SerializationError('Invalid project file: missing project tracks')
  }

  const media: MediaAsset[] = (Array.isArray(obj.media) ? obj.media : []).map((raw) =>
    hydrateMedia(raw as Record<string, unknown>),
  )

  const projectMarkers = hydrateMarkers(projectRaw.markers)
  const project: Project = {
    id: typeof projectRaw.id === 'string' ? projectRaw.id : 'proj_loaded',
    name: typeof projectRaw.name === 'string' ? projectRaw.name : 'Imported Project',
    width: numOr(projectRaw.width, 1920),
    height: numOr(projectRaw.height, 1080),
    fps: numOr(projectRaw.fps, 30),
    ...(projectMarkers ? { markers: projectMarkers } : {}),
    tracks: (projectRaw.tracks as Record<string, unknown>[]).map((t) => ({
      id: typeof t.id === 'string' ? t.id : `track_${Math.random().toString(36).slice(2)}`,
      kind: (t.kind === 'audio' || t.kind === 'text'
        ? t.kind
        : 'video') as Project['tracks'][0]['kind'],
      name: typeof t.name === 'string' ? t.name : 'Track',
      muted: !!t.muted,
      clips: (Array.isArray(t.clips) ? (t.clips as Record<string, unknown>[]) : []).map((c) =>
        hydrateClip(c),
      ),
    })),
  }

  const mediaIds = new Set(media.map((m) => m.id))
  const missingMediaIds = media.filter((m) => m.missing).map((m) => m.id)
  // Clips whose media did not survive the round-trip also count as missing refs.
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (clip.mediaId && !mediaIds.has(clip.mediaId)) clip.mediaId = undefined
    }
  }

  return { doc: { project, media }, missingMediaIds }
}

function hydrateMedia(raw: Record<string, unknown>): MediaAsset {
  const kind =
    raw.kind === 'video' || raw.kind === 'audio' || raw.kind === 'image' ? raw.kind : 'video'
  return {
    id: typeof raw.id === 'string' ? raw.id : `media_${Math.random().toString(36).slice(2)}`,
    name: typeof raw.name === 'string' ? raw.name : 'Media',
    kind,
    duration: numOr(raw.duration, 0),
    width: numOr(raw.width, 0),
    height: numOr(raw.height, 0),
    url: '', // object URLs can never persist — asset starts "missing"
    ...(typeof raw.thumbnail === 'string' ? { thumbnail: raw.thumbnail } : {}),
    ...(typeof raw.hasAudio === 'boolean' ? { hasAudio: raw.hasAudio } : {}),
    ...(Array.isArray(raw.waveformPeaks) ? { waveformPeaks: raw.waveformPeaks as number[] } : {}),
    missing: true,
  }
}

function hydrateClip(raw: Record<string, unknown>): Clip {
  const clip: Clip = {
    id: typeof raw.id === 'string' ? raw.id : `clip_${Math.random().toString(36).slice(2)}`,
    start: Math.max(0, numOr(raw.start, 0)),
    duration: Math.max(0.05, numOr(raw.duration, 1)),
    inPoint: Math.max(0, numOr(raw.inPoint, 0)),
  }
  if (typeof raw.mediaId === 'string') clip.mediaId = raw.mediaId
  if (typeof raw.linkId === 'string') clip.linkId = raw.linkId
  if (raw.audioOnly === true) clip.audioOnly = true
  if (typeof raw.gain === 'number') clip.gain = raw.gain
  if (typeof raw.muted === 'boolean') clip.muted = raw.muted
  if (typeof raw.opacity === 'number' && Number.isFinite(raw.opacity)) {
    const opacity = Math.min(1, Math.max(0, raw.opacity))
    if (opacity !== 1) clip.opacity = opacity // 1 is the default, keep files clean
  }
  // 0.5.0 re-timing + audio shaping. Defaults are omitted so files stay clean.
  if (typeof raw.speed === 'number' && Number.isFinite(raw.speed)) {
    const speed = clamp(raw.speed, SPEED_MIN, SPEED_MAX)
    if (speed !== 1) clip.speed = speed
  }
  if (raw.reverse === true) clip.reverse = true
  if (typeof raw.pan === 'number' && Number.isFinite(raw.pan)) {
    const pan = clamp(raw.pan, -1, 1)
    if (pan !== 0) clip.pan = pan
  }
  if (raw.eq && typeof raw.eq === 'object') {
    const rawEq = raw.eq as Record<string, unknown>
    const band = (v: unknown) => clamp(numOr(v, 0), EQ_DB_MIN, EQ_DB_MAX)
    const eq = { low: band(rawEq.low), mid: band(rawEq.mid), high: band(rawEq.high) }
    if (eq.low !== 0 || eq.mid !== 0 || eq.high !== 0) clip.eq = eq
  }
  if (raw.compressor === true) clip.compressor = true
  if (raw.animStatics && typeof raw.animStatics === 'object') {
    const statics: NonNullable<Clip['animStatics']> = {}
    for (const [property, value] of Object.entries(raw.animStatics as Record<string, unknown>)) {
      if (!isAnimStaticProperty(property)) continue
      if (typeof value !== 'number' || !Number.isFinite(value)) continue
      const clamped = clampPropertyValue(property, value)
      if (clamped !== KEYFRAME_PROPERTY_BOUNDS[property].default) statics[property] = clamped
    }
    if (Object.keys(statics).length > 0) clip.animStatics = statics
  }
  if (raw.keyframes && typeof raw.keyframes === 'object') {
    const map: KeyframeMap = {}
    for (const [property, value] of Object.entries(raw.keyframes as Record<string, unknown>)) {
      if (!isAnimatableProperty(property) || !Array.isArray(value)) continue
      const kfs = sanitizeKeyframes(
        property,
        value.map((k) => {
          const raw = (k ?? {}) as Record<string, unknown>
          return {
            time: numOr(raw.time, Number.NaN),
            value: numOr(raw.value, Number.NaN),
          } as Keyframe
        }),
      )
      if (kfs.length > 0) map[property] = kfs
    }
    if (Object.keys(map).length > 0) clip.keyframes = map
  }
  if (typeof raw.text === 'string') {
    clip.text = raw.text
    clip.style = hydrateStyle(raw.style as Record<string, unknown> | undefined)
  }
  if (
    typeof raw.transitionOut === 'object' &&
    raw.transitionOut !== null &&
    typeof (raw.transitionOut as Record<string, unknown>).duration === 'number'
  ) {
    clip.transitionOut = {
      type: 'crossfade',
      duration: (raw.transitionOut as { duration: number }).duration,
    }
  }
  const markers = hydrateMarkers(raw.markers)
  if (markers) clip.markers = markers
  return clip
}

/**
 * Validates a serialized marker array. Malformed entries are dropped, as are
 * negative or non-finite times, unknown colors fall back to the default
 * (absent), duplicate ids in the same scope are dropped, and an empty result
 * stays undefined so hydrated docs (and the files saved from them) stay clean.
 */
function hydrateMarkers(raw: unknown): Marker[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const seen = new Set<string>()
  const markers: Marker[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const rec = entry as Record<string, unknown>
    if (typeof rec.time !== 'number' || !Number.isFinite(rec.time) || rec.time < 0) continue
    const id =
      typeof rec.id === 'string' && rec.id
        ? rec.id
        : `marker_${Math.random().toString(36).slice(2)}`
    if (seen.has(id)) continue
    seen.add(id)
    const marker: Marker = { id, time: rec.time }
    applyMarkerPatch(marker, {
      ...(typeof rec.name === 'string' ? { name: rec.name } : {}),
      ...(isMarkerColor(rec.color) ? { color: rec.color } : {}),
      ...(typeof rec.notes === 'string' ? { notes: rec.notes } : {}),
    })
    markers.push(marker)
  }
  if (markers.length === 0) return undefined
  markers.sort((a, b) => a.time - b.time)
  return markers
}

/** Animatable properties that keep a static field (opacity/volume have their own). */
function isAnimStaticProperty(p: string): p is Exclude<KeyframeProperty, 'opacity' | 'volume'> {
  return isAnimatableProperty(p) && p !== 'opacity' && p !== 'volume'
}

function hydrateStyle(raw: Record<string, unknown> | undefined): Clip['style'] {
  const defaults = {
    fontSize: 64,
    color: '#ffffff',
    fontFamily: 'Arial, sans-serif',
    bold: true,
    italic: false,
    align: 'center' as const,
    x: 0.5,
    y: 0.5,
    shadow: true,
  }
  if (!raw) return defaults
  return {
    fontSize: numOr(raw.fontSize, defaults.fontSize),
    color: typeof raw.color === 'string' ? raw.color : defaults.color,
    fontFamily: typeof raw.fontFamily === 'string' ? raw.fontFamily : defaults.fontFamily,
    bold: typeof raw.bold === 'boolean' ? raw.bold : defaults.bold,
    italic: typeof raw.italic === 'boolean' ? raw.italic : defaults.italic,
    align: raw.align === 'left' || raw.align === 'right' ? raw.align : 'center',
    x: numOr(raw.x, defaults.x),
    y: numOr(raw.y, defaults.y),
    shadow: typeof raw.shadow === 'boolean' ? raw.shadow : defaults.shadow,
  }
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/** Builds a downloadable filename from the project name. */
export function projectFileName(name: string): string {
  const safe =
    name
      .trim()
      .replace(/[^a-z0-9-_ ]/gi, '')
      .replace(/\s+/g, '-') || 'project'
  return `${safe}${PROJECT_FILE_EXTENSION}`
}
