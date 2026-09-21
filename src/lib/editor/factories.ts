import type {
  Clip,
  Doc,
  MediaAsset,
  MediaKind,
  Project,
  TextStyle,
  Track,
  TrackKind,
} from './types'

/** Collision-safe unique id (crypto.randomUUID with fallback for old runtimes). */
export function uid(prefix = 'id'): string {
  const raw =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  return `${prefix}_${raw}`
}

export function createDefaultTextStyle(): TextStyle {
  return {
    fontSize: 64,
    color: '#ffffff',
    fontFamily: 'Arial, sans-serif',
    bold: true,
    italic: false,
    align: 'center',
    x: 0.5,
    y: 0.5,
    shadow: true,
  }
}

export function createTextClip(partial: Partial<Clip> = {}): Clip {
  return {
    id: uid('clip'),
    start: 0,
    duration: 4,
    inPoint: 0,
    text: 'Your text here',
    style: createDefaultTextStyle(),
    ...partial,
  }
}

export function createClip(partial: Partial<Clip> = {}): Clip {
  return {
    id: uid('clip'),
    start: 0,
    duration: 4,
    inPoint: 0,
    ...partial,
  }
}

export function createTrack(kind: TrackKind, index = 1, partial: Partial<Track> = {}): Track {
  const prefix = kind === 'video' ? 'V' : kind === 'audio' ? 'A' : 'T'
  return {
    id: uid('track'),
    kind,
    name: `${prefix}${index}`,
    clips: [],
    ...partial,
  }
}

/**
 * Creates the default empty project: one video track (V1) and one audio track (A1).
 * Track index 0 (V1) is the topmost compositing layer.
 * Defaults to Full HD (1920×1080 @ 30fps).
 */
export function createProject(): Project {
  return {
    id: uid('proj'),
    name: 'Untitled Project',
    width: 1920,
    height: 1080,
    fps: 30,
    tracks: [createTrack('video', 1), createTrack('audio', 1)],
  }
}

export function createDoc(): Doc {
  return { project: createProject(), media: [] }
}

/** Convenience constructor for in-memory media assets (e.g. tests). */
export function createMediaAsset(partial: Partial<MediaAsset> & { kind: MediaKind }): MediaAsset {
  return {
    id: uid('media'),
    name: 'asset',
    duration: 0,
    width: 0,
    height: 0,
    url: '',
    ...partial,
  }
}

/** End of the timeline: latest clip out-point across all tracks (0 when empty). */
export function docDuration(doc: Doc): number {
  let end = 0
  for (const track of doc.project.tracks) {
    for (const clip of track.clips) {
      end = Math.max(end, clip.start + clip.duration)
    }
  }
  return end
}

/**
 * The source timestamp a clip shows at clip-local time `local` (seconds from
 * the clip's start), honoring speed and reverse. A reversed clip reads its
 * source span mirrored, so local 0 maps to the span's last frame. This is the
 * single mapping the preview, the frame plan and the exporter all share.
 */
export function sourceTimeAt(clip: Clip, local: number): number {
  const speed = clip.speed ?? 1
  const offset = clip.reverse ? Math.max(0, clip.duration - local) : local
  return clip.inPoint + offset * speed
}

export function findClip(doc: Doc, clipId: string): { clip: Clip; track: Track } | undefined {
  for (const track of doc.project.tracks) {
    const clip = track.clips.find((c) => c.id === clipId)
    if (clip) return { clip, track }
  }
  return undefined
}

export function findTrack(doc: Doc, trackId: string): Track | undefined {
  return doc.project.tracks.find((t) => t.id === trackId)
}

export function findMedia(doc: Doc, mediaId: string | undefined): MediaAsset | undefined {
  if (!mediaId) return undefined
  return doc.media.find((m) => m.id === mediaId)
}

/** Clip lookup by id across all tracks (without the owning track). */
export function getClip(doc: Doc, clipId: string): Clip | undefined {
  return findClip(doc, clipId)?.clip
}

/**
 * Compatibility rules for placing material on tracks:
 * - video/image material → `video` tracks
 * - audio material       → `audio` tracks
 * - text clips           → `text` tracks
 * - `audioOnly` occurrences of a video asset (the A/V pair's audio part) →
 *   `audio` tracks — they carry sound but never picture (links.ts).
 */
export function clipFitsTrack(doc: Doc, clip: Clip, track: Track): boolean {
  if (track.kind === 'text') return !!clip.text
  const asset = findMedia(doc, clip.mediaId)
  if (!asset) return false
  if (track.kind === 'video') return asset.kind === 'video' || asset.kind === 'image'
  if (track.kind === 'audio') {
    return asset.kind === 'audio' || (asset.kind === 'video' && !!clip.audioOnly)
  }
  return false
}

/** First track (topmost) that can host the given media kind, if any. */
export function firstCompatibleTrack(doc: Doc, kind: MediaKind): Track | undefined {
  return doc.project.tracks.find((t) => {
    if (t.kind === 'text') return false
    if (t.kind === 'video') return kind === 'video' || kind === 'image'
    return kind === 'audio'
  })
}

/**
 * Next clip on the same track by start position (used for transitions).
 * Returns the clip whose start is the smallest among those strictly after `clip.start`.
 */
export function nextClipOnTrack(track: Track, clip: Clip): Clip | undefined {
  let best: Clip | undefined
  for (const c of track.clips) {
    if (c.id === clip.id) continue
    if (c.start > clip.start && (!best || c.start < best.start)) best = c
  }
  return best
}

export function trackIndexOf(doc: Doc, trackId: string): number {
  return doc.project.tracks.findIndex((t) => t.id === trackId)
}
