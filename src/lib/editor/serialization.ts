import type { Clip, Doc, MediaAsset, Project } from './types'

/**
 * Project serialization: `Doc` → JSON file (and back).
 *
 * `MediaAsset.url` (object URLs) can never persist across sessions, so it is
 * stripped on save. On load, assets without a URL are flagged `missing: true`
 * and rendered as "offline" in the UI until the user relinks them.
 */

export const SERIALIZATION_VERSION = 1
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
  if (obj.version !== SERIALIZATION_VERSION) {
    throw new SerializationError(`Unsupported project version: ${String(obj.version)}`)
  }
  const projectRaw = obj.project as Record<string, unknown> | undefined
  if (!projectRaw || !Array.isArray(projectRaw.tracks)) {
    throw new SerializationError('Invalid project file: missing project tracks')
  }

  const media: MediaAsset[] = (Array.isArray(obj.media) ? obj.media : []).map((raw) =>
    hydrateMedia(raw as Record<string, unknown>),
  )

  const project: Project = {
    id: typeof projectRaw.id === 'string' ? projectRaw.id : 'proj_loaded',
    name: typeof projectRaw.name === 'string' ? projectRaw.name : 'Imported Project',
    width: numOr(projectRaw.width, 1920),
    height: numOr(projectRaw.height, 1080),
    fps: numOr(projectRaw.fps, 30),
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
    if (opacity !== 1) clip.opacity = opacity // 1 is the default — keep files clean
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
  return clip
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
