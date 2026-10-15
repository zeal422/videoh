import { constantTimeScaleRate, integrateKeyframes } from './keyframes'
import { clamp } from './time'
import type {
  Clip,
  Doc,
  MediaAsset,
  MediaKind,
  Project,
  Sequence,
  TextPreset,
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

/**
 * The Inspector's text size bounds, mirrored here so styles crossing a
 * trust boundary into the preset library collapse into the same ranges
 * the controls enforce (see the Size NumberField in InspectorPanel).
 */
export const TEXT_PRESET_FONT_MIN = 8
export const TEXT_PRESET_FONT_MAX = 400

/**
 * Bounds a text style into the ranges the Inspector enforces (font size
 * 8..400, position 0..1), returning a fresh object. Used wherever a style
 * crosses into the preset library: file loads and preset saves alike, so
 * a wild value can never sit in a preset waiting to be applied.
 */
export function sanitizePresetStyle(style: TextStyle): TextStyle {
  // clamp() propagates NaN (Math.min/Math.max do), so non-finite values
  // fall back to the defaults FIRST: a malformed command payload must not
  // store a NaN the clamp cannot see. Every non-finite input takes the
  // default (Infinity becomes 64 for fontSize, 0.5 for x or y) and never
  // reaches the clamp bounds below.
  const defaults = createDefaultTextStyle()
  const finite = (v: number, fallback: number) => (Number.isFinite(v) ? v : fallback)
  return {
    ...style,
    fontSize: clamp(
      finite(style.fontSize, defaults.fontSize),
      TEXT_PRESET_FONT_MIN,
      TEXT_PRESET_FONT_MAX,
    ),
    x: clamp(finite(style.x, defaults.x), 0, 1),
    y: clamp(finite(style.y, defaults.y), 0, 1),
  }
}

/**
 * The four built-in title presets (0.8.3): stable ids, shown above user
 * presets, never editable or deletable. Returns a fresh list per call so
 * callers cannot mutate the shared set.
 */
export function createBuiltinTextPresets(): TextPreset[] {
  return [
    {
      id: 'preset_builtin_title',
      name: 'Title',
      style: {
        fontSize: 96,
        color: '#ffffff',
        fontFamily: 'Arial, sans-serif',
        bold: true,
        italic: false,
        align: 'center',
        x: 0.5,
        y: 0.38,
        shadow: true,
      },
    },
    {
      id: 'preset_builtin_subtitle',
      name: 'Subtitle',
      style: {
        fontSize: 48,
        color: '#ffffff',
        fontFamily: 'Arial, sans-serif',
        bold: false,
        italic: false,
        align: 'center',
        x: 0.5,
        y: 0.52,
        shadow: false,
      },
    },
    {
      id: 'preset_builtin_lower_third',
      name: 'Lower third',
      style: {
        fontSize: 56,
        color: '#ffffff',
        fontFamily: 'Arial, sans-serif',
        bold: true,
        italic: false,
        align: 'left',
        x: 0.08,
        y: 0.78,
        shadow: true,
      },
    },
    {
      id: 'preset_builtin_caption',
      name: 'Caption',
      style: {
        fontSize: 40,
        color: '#ffffff',
        fontFamily: 'Arial, sans-serif',
        bold: false,
        italic: false,
        align: 'center',
        x: 0.5,
        y: 0.88,
        shadow: true,
      },
    },
  ]
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

/**
 * End of the ROOT timeline: latest clip out-point across the project's root
 * tracks (0 when empty). A compound clip contributes its OWN container span,
 * never a child's end time, so nested content never inflates the root number.
 */
export function docDuration(doc: Doc): number {
  let end = 0
  for (const track of doc.project.tracks) {
    for (const clip of track.clips) {
      end = Math.max(end, clip.start + clip.duration)
    }
  }
  return end
}

/** End of a compound sequence's LOCAL timeline (0 when empty). */
export function sequenceDuration(sequence: Sequence): number {
  let end = 0
  for (const track of sequence.tracks) {
    for (const clip of track.clips) {
      end = Math.max(end, clip.start + clip.duration)
    }
  }
  return end
}

/** Resolves a project-level compound sequence by id. */
export function findSequence(doc: Doc, sequenceId: string | undefined): Sequence | undefined {
  if (!sequenceId) return undefined
  return (doc.project.sequences ?? []).find((s) => s.id === sequenceId)
}

/**
 * The track list an owner sequence contributes: the root tracks when
 * `sequenceId` is undefined, otherwise the referenced sequence's tracks (empty
 * when the id names no sequence). The ONE primitive active-sequence editing,
 * preview and owner-scoped walks resolve through, so they cannot disagree
 * about which lanes exist.
 */
export function sequenceTracks(doc: Doc, sequenceId: string | undefined): Track[] {
  if (!sequenceId) return doc.project.tracks
  return findSequence(doc, sequenceId)?.tracks ?? []
}

/**
 * Resolves the track list the ACTIVE sequence path points at: empty path =
 * the project root, otherwise the last id in the path. UI and preview pass
 * this so gestures, layout and render see only the open sequence's lanes.
 */
export function activeTracks(doc: Doc, activeSequencePath: readonly string[]): Track[] {
  const id = activeSequencePath[activeSequencePath.length - 1]
  return sequenceTracks(doc, id)
}

/** The sequence id the ACTIVE path points at (undefined = root). */
export function activeSequenceId(activeSequencePath: readonly string[]): string | undefined {
  return activeSequencePath[activeSequencePath.length - 1]
}

/**
 * The active sequence's local length (its own ruler), or the root timeline at
 * the root. The single duration helper active-sequence UI reads.
 */
export function activeSequenceDuration(doc: Doc, activeSequencePath: readonly string[]): number {
  const sequence = findSequence(doc, activeSequenceId(activeSequencePath))
  return sequence ? sequenceDuration(sequence) : docDuration(doc)
}

/** Sequence ids referenced by compound clips inside a track list. */
function referencesIn(tracks: readonly Track[]): string[] {
  const ids: string[] = []
  for (const track of tracks) {
    for (const clip of track.clips) {
      if (clip.sequenceId) ids.push(clip.sequenceId)
    }
  }
  return ids
}

/** Sequence ids referenced by compound clips inside one sequence. */
export function sequenceReferences(sequence: Sequence): string[] {
  return referencesIn(sequence.tracks)
}

/** Sequence ids referenced by compound clips on the project's root tracks. */
export function rootReferences(doc: Doc): string[] {
  return referencesIn(doc.project.tracks)
}

/**
 * The compound sequences reachable from the project root through compound
 * references. An orphan sequence (no root-reachable container) is excluded, so
 * root-scoped checks (export, reverse detection) never act on media the export
 * will not render.
 */
export function rootReachableSequences(doc: Doc): Sequence[] {
  const reachable = new Set<string>()
  const stack = [...rootReferences(doc)]
  while (stack.length > 0) {
    const id = stack.pop() as string
    if (reachable.has(id)) continue
    reachable.add(id)
    const sequence = findSequence(doc, id)
    if (sequence) stack.push(...sequenceReferences(sequence))
  }
  return (doc.project.sequences ?? []).filter((s) => reachable.has(s.id))
}

/**
 * Whether `to` is reachable from `from` following compound references,
 * including the trivial case `from === to`. Used by the cycle guard.
 */
export function sequenceReachable(doc: Doc, from: string, to: string): boolean {
  const seen = new Set<string>()
  const stack = [from]
  while (stack.length > 0) {
    const id = stack.pop() as string
    if (id === to) return true
    if (seen.has(id)) continue
    seen.add(id)
    const sequence = findSequence(doc, id)
    if (sequence) stack.push(...sequenceReferences(sequence))
  }
  return false
}

/**
 * The longest chain of compound references from the project root (the number
 * of child edges; a sequence referenced from the root is depth 1, the root
 * itself depth 0). Returns `Number.POSITIVE_INFINITY` when the graph has a
 * cycle, so callers can treat a cycle as "over any limit". Used by the
 * creation guard and v4 hydration.
 */
export function maxSequenceDepth(doc: Doc): number {
  const memo = new Map<string, number>()
  const depthOf = (id: string, stack: Set<string>): number => {
    if (stack.has(id)) return Number.POSITIVE_INFINITY
    const cached = memo.get(id)
    if (cached !== undefined) return cached
    const sequence = findSequence(doc, id)
    if (!sequence) return 0
    stack.add(id)
    let best = 0
    for (const ref of sequenceReferences(sequence)) best = Math.max(best, depthOf(ref, stack))
    stack.delete(id)
    const result = best === Number.POSITIVE_INFINITY ? best : 1 + best
    memo.set(id, result)
    return result
  }
  let max = 0
  for (const ref of rootReferences(doc)) max = Math.max(max, depthOf(ref, new Set()))
  return max
}

/**
 * The source timestamp a clip shows at clip-local time `local` (seconds from
 * the clip's start), honoring speed and reverse. A reversed clip reads its
 * source span mirrored, so local 0 maps to the span's last frame. This is the
 * single mapping the preview, the frame plan and the exporter all share.
 *
 * With a `timeScale` ramp the consumed source time is the curve's INTEGRAL
 * over the elapsed span instead of `local * speed`: the clip's timeline length
 * is unchanged, only how fast it consumes source changes (Premiere's time
 * remapping). The static speed stays the constant-rate fallback.
 */
export function sourceTimeAt(clip: Clip, local: number): number {
  const offset = clip.reverse ? Math.max(0, clip.duration - local) : local
  // A curve (of any shape) overrides the static rate; a flat curve's rate IS
  // its constant value, so this reads the same rate the speed slider shows.
  const ramp = clip.keyframes?.timeScale
  const elapsed =
    ramp && ramp.length > 0
      ? integrateKeyframes(ramp, offset, constantTimeScaleRate(clip) ?? clip.speed ?? 1)
      : offset * (clip.speed ?? 1)
  return clip.inPoint + elapsed
}

/** How close to an asset's end the last readable source instant sits (seconds). */
export const SOURCE_END_MARGIN = 0.01

/**
 * A source timestamp clamped into what the asset can actually deliver. A
 * time-scale ramp can consume more source than the clip has (the command layer
 * accepts such a curve on purpose), so both render paths ask for the last
 * readable frame instead of a frame past the end: the excess freezes.
 */
export function clampSourceTime(sourceTime: number, asset: MediaAsset | undefined): number {
  if (!asset) return Math.max(0, sourceTime)
  return clamp(sourceTime, 0, Math.max(0, asset.duration - SOURCE_END_MARGIN))
}

/**
 * Clip lookup by id across the whole project: root tracks first, then every
 * compound sequence. Ids are globally unique (serialization v4 enforces it),
 * so the first match is the owner. `sequenceId` is the owning sequence
 * (undefined = root), which owner-scoped callers use to stay in one sequence.
 */
export function findClip(
  doc: Doc,
  clipId: string,
): { clip: Clip; track: Track; sequenceId?: string } | undefined {
  for (const track of doc.project.tracks) {
    const clip = track.clips.find((c) => c.id === clipId)
    if (clip) return { clip, track }
  }
  for (const sequence of doc.project.sequences ?? []) {
    for (const track of sequence.tracks) {
      const clip = track.clips.find((c) => c.id === clipId)
      if (clip) return { clip, track, sequenceId: sequence.id }
    }
  }
  return undefined
}

/**
 * Track lookup by id across the whole project, with its owning sequence
 * (`undefined` = root). Owner-aware mutations use this to act on the right
 * sequence's lane list.
 */
export function findTrackIn(
  doc: Doc,
  trackId: string,
): { track: Track; sequenceId?: string } | undefined {
  const root = doc.project.tracks.find((t) => t.id === trackId)
  if (root) return { track: root }
  for (const sequence of doc.project.sequences ?? []) {
    const track = sequence.tracks.find((t) => t.id === trackId)
    if (track) return { track, sequenceId: sequence.id }
  }
  return undefined
}

export function findTrack(doc: Doc, trackId: string): Track | undefined {
  return findTrackIn(doc, trackId)?.track
}

/**
 * Whether an asset can back a media element at all: present, not flagged
 * missing, carrying a URL, and not a still image (images are drawn directly,
 * they never enter the element pool). The ONE asset-playability test shared
 * by the playback engine's element bookkeeping and the link predicate's
 * member filter, so the two cannot drift apart.
 */
export function mediaPlayable(asset: MediaAsset | undefined): asset is MediaAsset {
  return !!asset && !asset.missing && !!asset.url && asset.kind !== 'image'
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
  // A compound clip renders picture and nowhere else. Checked FIRST: it has no
  // `mediaId`, so the `!asset` gate below would otherwise refuse it everywhere.
  if (clip.sequenceId) return track.kind === 'video'
  if (track.kind === 'text') return !!clip.text
  const asset = findMedia(doc, clip.mediaId)
  if (!asset) return false
  if (track.kind === 'video') return asset.kind === 'video' || asset.kind === 'image'
  if (track.kind === 'audio') {
    return asset.kind === 'audio' || (asset.kind === 'video' && !!clip.audioOnly)
  }
  return false
}

/**
 * First track (topmost) that can host the given media kind, if any. Scoped to
 * the owner sequence (`sequenceId` undefined = root).
 */
export function firstCompatibleTrack(
  doc: Doc,
  kind: MediaKind,
  sequenceId?: string,
): Track | undefined {
  return sequenceTracks(doc, sequenceId).find((t) => {
    if (t.kind === 'text') return false
    if (t.kind === 'video') return kind === 'video' || kind === 'image'
    return kind === 'audio'
  })
}

/**
 * First track (topmost) that satisfies `fits` and is not in `untargetedTrackIds`.
 * The one implementation of the targeting rule: paste entries, media
 * placement, the A/V twin lane and text placement all resolve through it, each
 * with its own `fits` predicate (kindFitsEntry, trackFitsAsset, kind checks).
 * Scoped to the owner sequence (`sequenceId` undefined = root).
 */
export function firstTargetedTrack(
  doc: Doc,
  untargetedTrackIds: readonly string[],
  fits: (track: Track) => boolean,
  sequenceId?: string,
): Track | undefined {
  return sequenceTracks(doc, sequenceId).find((t) => !untargetedTrackIds.includes(t.id) && fits(t))
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
