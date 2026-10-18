import {
  EQ_DB_MAX,
  EQ_DB_MIN,
  FPS_MAX,
  FPS_MIN,
  KEYFRAME_PROPERTY_BOUNDS,
  MAX_SEQUENCE_DEPTH,
  PROJECT_MAX_H,
  PROJECT_MAX_W,
  PROJECT_MIN_H,
  PROJECT_MIN_W,
  SPEED_MAX,
  SPEED_MIN,
  TEMPERATURE_MAX,
  TEMPERATURE_MIN,
  TINT_MAX,
  TINT_MIN,
} from './constants'
import {
  clampPropertyValue,
  isAnimatableProperty,
  isKeyframeInterpolation,
  sanitizeKeyframes,
} from './keyframes'
import {
  LUT_LIBRARY_MAX_CHARS,
  LUT_MAX_SIZE_1D,
  LUT_MAX_SIZE_3D,
  base64ToBytes,
  lutGridByteLength,
} from './lut'
import { applyMarkerPatch, isMarkerColor } from './markers'
import { createBuiltinTextPresets, createDefaultTextStyle, sanitizePresetStyle } from './factories'
import { clamp } from './time'
import type {
  AnimStaticProperty,
  Clip,
  Doc,
  Keyframe,
  KeyframeDefaults,
  KeyframeMap,
  KeyframeProperty,
  LutKind,
  Marker,
  MediaAsset,
  Project,
  ProjectLut,
  Sequence,
  TextPreset,
  Track,
  TrackKind,
} from './types'

/**
 * Project serialization: `Doc` → JSON file (and back).
 *
 * `MediaAsset.url` (object URLs) can never persist across sessions, so it is
 * stripped on save. On load, assets without a URL are flagged `missing: true`
 * and rendered as "offline" in the UI until the user relinks them.
 */

/**
 * v2 added markers (0.5.5); v3 added the LUT library (0.7.0); v4 added
 * compound-clip sequences (0.8.1). The loader accepts every version from 1 up
 * to the current one, so older files load with the newer features absent; only
 * files from a NEWER app version are refused.
 */
export const SERIALIZATION_VERSION = 4
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
  const projectDefaults = hydrateKeyframeDefaults(projectRaw.keyframeDefaults)
  const projectLuts = hydrateLuts(projectRaw.luts)
  const projectSequences = hydrateSequences(projectRaw.sequences, media)
  const projectPresets = hydrateTextPresets(projectRaw.textPresets)
  const project: Project = {
    id: typeof projectRaw.id === 'string' ? projectRaw.id : 'proj_loaded',
    name: typeof projectRaw.name === 'string' ? projectRaw.name : 'Imported Project',
    // The same clamps `setProjectSettings` applies: a hand-edited file cannot
    // install a value the UI would reject. Without them a hostile fps makes
    // the export frame count Infinity (the render loop never terminates) and a
    // hostile width lands on canvas.width unchecked.
    width: clamp(Math.round(numOr(projectRaw.width, 1920)), PROJECT_MIN_W, PROJECT_MAX_W),
    height: clamp(Math.round(numOr(projectRaw.height, 1080)), PROJECT_MIN_H, PROJECT_MAX_H),
    fps: clamp(Math.round(numOr(projectRaw.fps, 30)), FPS_MIN, FPS_MAX),
    ...(projectMarkers ? { markers: projectMarkers } : {}),
    ...(projectDefaults ? { keyframeDefaults: projectDefaults } : {}),
    ...(projectLuts ? { luts: projectLuts } : {}),
    ...(projectSequences ? { sequences: projectSequences } : {}),
    ...(projectPresets ? { textPresets: projectPresets } : {}),
    tracks: hydrateTracks(projectRaw.tracks, media),
  }

  // Identity is the invariant the recursive lookups rest on: a repeated track,
  // clip or sequence id would resolve the wrong object, so the file is refused
  // (no regeneration, which would silently repoint references).
  assertUniqueIds(project)
  // A compound clip's shape is mutually exclusive with media, text and
  // retiming: a file that carries both is malformed and refused.
  assertCompoundShapes(project)
  // Link groups are sequence-local: a link id shared across sequences has no
  // safe move semantics and is refused.
  assertLinkScopes(project)
  // The graph the render, duration and id walks traverse must be acyclic and
  // within the nesting limit; both are refused rather than trusted.
  assertSequenceGraph(project)

  const mediaIds = new Set(media.map((m) => m.id))
  const lutIds = new Set((project.luts ?? []).map((l) => l.id))
  const sequenceIds = new Set((project.sequences ?? []).map((s) => s.id))
  const missingMediaIds = media.filter((m) => m.missing).map((m) => m.id)
  // Clips whose media did not survive the round-trip also count as missing refs
  // (and the same for a lutId naming no library entry: a dangling reference
  // must hydrate to nothing, never to a url() that names no mounted node). A
  // compound clip naming no sequence is dropped with one warning, matching the
  // LUT-hydration policy.
  let droppedCompound = false
  const sweep = (tracks: Track[]) => {
    for (const track of tracks) {
      track.clips = track.clips.filter((clip) => {
        if (clip.mediaId && !mediaIds.has(clip.mediaId)) clip.mediaId = undefined
        if (clip.lutId !== undefined && !lutIds.has(clip.lutId)) clip.lutId = undefined
        if (clip.sequenceId && !sequenceIds.has(clip.sequenceId)) {
          droppedCompound = true
          return false
        }
        return true
      })
    }
  }
  sweep(project.tracks)
  for (const sequence of project.sequences ?? []) sweep(sequence.tracks)
  if (droppedCompound) {
    console.warn('[serialization] dropped a compound clip whose referenced sequence is missing')
  }

  return { doc: { project, media }, missingMediaIds }
}

/** Hydrates a track list (root or a compound sequence). */
function hydrateTracks(rawTracks: unknown, media: MediaAsset[]): Track[] {
  return (Array.isArray(rawTracks) ? (rawTracks as Record<string, unknown>[]) : []).map((t) => ({
    id: typeof t.id === 'string' ? t.id : `track_${Math.random().toString(36).slice(2)}`,
    kind: (t.kind === 'audio' || t.kind === 'text' ? t.kind : 'video') as TrackKind,
    name: typeof t.name === 'string' ? t.name : 'Track',
    muted: !!t.muted,
    clips: (Array.isArray(t.clips) ? (t.clips as Record<string, unknown>[]) : []).map((c) =>
      hydrateClip(c, media),
    ),
  }))
}

/** Hydrates the project's compound sequences, dropping non-object entries. */
function hydrateSequences(raw: unknown, media: MediaAsset[]): Sequence[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const sequences: Sequence[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const s = entry as Record<string, unknown>
    sequences.push({
      id: typeof s.id === 'string' && s.id ? s.id : `seq_${Math.random().toString(36).slice(2)}`,
      name: typeof s.name === 'string' && s.name ? s.name : 'Compound Clip',
      tracks: hydrateTracks(s.tracks, media),
    })
  }
  return sequences.length > 0 ? sequences : undefined
}

/** Rejects a project where a track, clip or sequence id repeats anywhere. */
function assertUniqueIds(project: Project): void {
  const seen = new Set<string>()
  const add = (id: string, what: string) => {
    if (seen.has(id)) throw new SerializationError(`Duplicate ${what} id: ${id}`)
    seen.add(id)
  }
  const visit = (tracks: Track[]) => {
    for (const track of tracks) {
      add(track.id, 'track')
      for (const clip of track.clips) add(clip.id, 'clip')
    }
  }
  visit(project.tracks)
  for (const sequence of project.sequences ?? []) {
    add(sequence.id, 'sequence')
    visit(sequence.tracks)
  }
}

/**
 * Rejects a file where one link id is shared across sequences (0.8.1): link
 * groups are sequence-local, so a cross-sequence id could never be moved as a
 * unit and the command layer refuses to create one.
 */
function assertLinkScopes(project: Project): void {
  const owner = new Map<string, string>()
  const visit = (tracks: Track[], sequenceId?: string): void => {
    const key = sequenceId ?? '__root__'
    for (const track of tracks) {
      for (const clip of track.clips) {
        if (!clip.linkId) continue
        const previous = owner.get(clip.linkId)
        if (previous !== undefined && previous !== key) {
          throw new SerializationError('A link id is shared across sequences')
        }
        owner.set(clip.linkId, key)
      }
    }
  }
  visit(project.tracks)
  for (const sequence of project.sequences ?? []) visit(sequence.tracks, sequence.id)
}

/** Rejects a compound clip that also carries media, text or retiming fields. */
function assertCompoundShapes(project: Project): void {
  const check = (tracks: Track[]) => {
    for (const track of tracks) {
      for (const clip of track.clips) {
        if (!clip.sequenceId) continue
        if (
          clip.mediaId !== undefined ||
          clip.text !== undefined ||
          clip.audioOnly === true ||
          clip.speed !== undefined ||
          clip.reverse ||
          clip.keyframes?.timeScale !== undefined
        ) {
          throw new SerializationError(
            'Compound clip carries incompatible media, text or retiming fields',
          )
        }
      }
    }
  }
  check(project.tracks)
  for (const sequence of project.sequences ?? []) check(sequence.tracks)
}

/**
 * Rejects a cyclic sequence graph and one deeper than {@link MAX_SEQUENCE_DEPTH}.
 * A cycle bypasses the command-time guard and would recurse forever in the
 * render, duration and id walks, so it is refused at the trust boundary.
 */
function assertSequenceGraph(project: Project): void {
  const sequences = project.sequences
  if (!sequences || sequences.length === 0) return
  const byId = new Map(sequences.map((s) => [s.id, s]))
  const state = new Map<string, 1 | 2>()
  const height = new Map<string, number>()
  const visit = (id: string): number => {
    const st = state.get(id)
    if (st === 1) throw new SerializationError('Compound sequence graph contains a cycle')
    if (st === 2) return height.get(id) ?? 0
    const sequence = byId.get(id)
    if (!sequence) return 0
    state.set(id, 1)
    let best = 0
    for (const track of sequence.tracks) {
      for (const clip of track.clips) {
        if (clip.sequenceId) best = Math.max(best, visit(clip.sequenceId))
      }
    }
    state.set(id, 2)
    height.set(id, best + 1)
    return best + 1
  }
  let maxDepth = 0
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (clip.sequenceId) maxDepth = Math.max(maxDepth, visit(clip.sequenceId))
    }
  }
  // Any sequence the cycle walk has not finished is a cycle in an unreachable
  // component; `visit` throws on re-entry, so a stray cycle is still caught.
  for (const sequence of sequences) visit(sequence.id)
  if (maxDepth > MAX_SEQUENCE_DEPTH) {
    throw new SerializationError('Compound sequence nesting is too deep')
  }
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

function hydrateClip(raw: Record<string, unknown>, media: MediaAsset[]): Clip {
  const clip: Clip = {
    id: typeof raw.id === 'string' ? raw.id : `clip_${Math.random().toString(36).slice(2)}`,
    start: Math.max(0, numOr(raw.start, 0)),
    duration: Math.max(0.05, numOr(raw.duration, 1)),
    inPoint: Math.max(0, numOr(raw.inPoint, 0)),
  }
  if (typeof raw.mediaId === 'string') clip.mediaId = raw.mediaId
  if (typeof raw.linkId === 'string') clip.linkId = raw.linkId
  if (raw.audioOnly === true) clip.audioOnly = true
  // Caption flag (0.8.5): true stays true, anything else stays absent.
  if (raw.isCaption === true) clip.isCaption = true
  // Compound clip reference (0.8.1). Kept only when it names a hydrated
  // sequence; the caller drops a dangling one after the whole project is built.
  if (typeof raw.sequenceId === 'string' && raw.sequenceId) clip.sequenceId = raw.sequenceId
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
  if (raw.denoise === true) clip.denoise = true
  if (typeof raw.temperature === 'number' && Number.isFinite(raw.temperature)) {
    const temperature = clamp(raw.temperature, TEMPERATURE_MIN, TEMPERATURE_MAX)
    if (temperature !== 0) clip.temperature = temperature
  }
  if (typeof raw.tint === 'number' && Number.isFinite(raw.tint)) {
    const tint = clamp(raw.tint, TINT_MIN, TINT_MAX)
    if (tint !== 0) clip.tint = tint
  }
  // Kept only when it names a hydrated library entry: the caller clears a
  // dangling reference once the whole project is built.
  if (typeof raw.lutId === 'string' && raw.lutId) clip.lutId = raw.lutId
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
          const keyframe: Keyframe = {
            time: numOr(raw.time, Number.NaN),
            value: numOr(raw.value, Number.NaN),
          }
          // Eased segments survive a save/load round-trip; an unknown name from
          // a future build falls back to linear in sanitizeKeyframes.
          if (isKeyframeInterpolation(raw.interpolation)) keyframe.interpolation = raw.interpolation
          // Subdivided easing data (an exact bezier quad) rides along; a
          // malformed one is dropped here and sanitizeKeyframes re-derives
          // the shape from the name.
          if (
            Array.isArray(raw.easeOut) &&
            raw.easeOut.length === 4 &&
            raw.easeOut.every((n) => typeof n === 'number' && Number.isFinite(n))
          ) {
            keyframe.easeOut = raw.easeOut as [number, number, number, number]
          }
          return keyframe
        }),
      )
      if (kfs.length > 0) map[property] = kfs
    }
    if (Object.keys(map).length > 0) clip.keyframes = map
  }
  // A timeScale curve is picture-only: the Effect Controls rows that could
  // edit it hide on a clip without picture, while both render paths drop a
  // link group's audio when its rate changes (a ramp, or rates the halves
  // cannot agree on), and a solo clip's curve would retime its sound with no
  // row to edit or clear it. A hand-edited or foreign file could install such
  // a curve, so hydration drops it. Both signals count: the A/V
  // twin carries `audioOnly`, an audio-asset clip carries no flag but
  // resolves to an audio kind. A dangling mediaId keeps the curve: without
  // the asset kind there is nothing to say the clip is picture-less.
  if (clip.keyframes?.timeScale) {
    const asset = media.find((m) => m.id === clip.mediaId)
    if (clip.audioOnly === true || asset?.kind === 'audio') {
      delete clip.keyframes.timeScale
      if (Object.keys(clip.keyframes).length === 0) clip.keyframes = undefined
    }
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
    const rawTransition = raw.transitionOut as Record<string, unknown>
    const rawType = rawTransition.type
    const rawDirection = rawTransition.direction
    const rawEdge = rawTransition.edge
    clip.transitionOut = {
      type:
        rawType === 'dipToBlack' || rawType === 'wipe' || rawType === 'slide' || rawType === 'push'
          ? rawType
          : 'crossfade',
      duration: (raw.transitionOut as { duration: number }).duration,
    }
    // Spatial fields stay absent when absent: readers default direction to
    // left, edge to hard and feather to 0.1. Present-but-unknown values
    // are dropped so they degrade the same way.
    if (
      rawDirection === 'left' ||
      rawDirection === 'right' ||
      rawDirection === 'up' ||
      rawDirection === 'down'
    ) {
      clip.transitionOut.direction = rawDirection
    }
    if (rawEdge === 'hard' || rawEdge === 'feathered') {
      clip.transitionOut.edge = rawEdge
    }
    if ('feather' in rawTransition) {
      const rawFeather = rawTransition.feather
      clip.transitionOut.feather =
        typeof rawFeather === 'number' && Number.isFinite(rawFeather)
          ? Math.min(0.5, Math.max(0, rawFeather))
          : 0.1
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

/**
 * The LUT library from a file, every entry gated: a non-object entry, a
 * duplicate or empty id, an unknown kind, a size outside the supported bounds,
 * a payload over the per-entry cap, a payload that is not base64 or does not
 * decode to the grid its kind and size promise, and any entry past the
 * library's total budget are all DROPPED rather than trusted. A hand-edited
 * file must not be able to inject a multi-megabyte string (or a thousand
 * entries) that every render pass then decodes. Throwing is never an option on
 * this path, so when at least one entry is dropped the load logs ONE warning
 * naming the count instead of shrinking the library silently.
 */
function hydrateLuts(raw: unknown): ProjectLut[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const seen = new Set<string>()
  const luts: ProjectLut[] = []
  let total = 0
  let dropped = 0
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      dropped += 1
      continue
    }
    const rec = entry as Record<string, unknown>
    const id = typeof rec.id === 'string' && rec.id ? rec.id : undefined
    if (!id || seen.has(id)) {
      dropped += 1
      continue
    }
    const kind: LutKind | undefined = rec.kind === '1d' || rec.kind === '3d' ? rec.kind : undefined
    if (!kind) {
      dropped += 1
      continue
    }
    const size = rec.size
    if (typeof size !== 'number' || !Number.isInteger(size) || size < 2) {
      dropped += 1
      continue
    }
    if (size > (kind === '1d' ? LUT_MAX_SIZE_1D : LUT_MAX_SIZE_3D)) {
      dropped += 1
      continue
    }
    const data = rec.data
    if (typeof data !== 'string' || data.length > LUT_LIBRARY_MAX_CHARS) {
      dropped += 1
      continue
    }
    const bytes = base64ToBytes(data)
    if (!bytes || bytes.length !== lutGridByteLength(kind, size)) {
      dropped += 1
      continue
    }
    if (total + data.length > LUT_LIBRARY_MAX_CHARS) {
      dropped += 1
      continue
    }
    total += data.length
    seen.add(id)
    luts.push({
      id,
      name: typeof rec.name === 'string' && rec.name ? rec.name : 'LUT',
      kind,
      size,
      data,
    })
  }
  if (dropped > 0) {
    console.warn(
      `[serialization] dropped ${dropped} LUT library ${dropped === 1 ? 'entry' : 'entries'} ` +
        'while loading (malformed, oversized or over budget)',
    )
  }
  return luts.length === 0 ? undefined : luts
}

/**
 * Per-property easing defaults from a file: unknown property keys and unknown
 * names are dropped (the same trust boundary every hydrated field uses), and a
 * map with nothing left is absent rather than empty.
 */
function hydrateKeyframeDefaults(raw: unknown): KeyframeDefaults | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const defaults: KeyframeDefaults = {}
  for (const [property, name] of Object.entries(raw as Record<string, unknown>)) {
    if (!isAnimatableProperty(property)) continue
    if (!isKeyframeInterpolation(name)) continue
    defaults[property] = name
  }
  return Object.keys(defaults).length === 0 ? undefined : defaults
}

/**
 * Animatable properties that keep a static field (opacity/volume have their
 * own fields, timeScale reads the clip's speed).
 */
function isAnimStaticProperty(p: string): p is AnimStaticProperty {
  return isAnimatableProperty(p) && p !== 'opacity' && p !== 'volume' && p !== 'timeScale'
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

/**
 * Hydrates the project's user title presets (0.8.3), dropping broken
 * entries. Preset ids live in their own namespace (`preset_`), so dupes
 * are dropped here with one warning instead of refusing the file in
 * `assertUniqueIds`. A corrupt style field falls back per-field through
 * `hydrateStyle` and the entry is kept; only unusable entries are dropped.
 */
function hydrateTextPresets(raw: unknown): TextPreset[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const presets: TextPreset[] = []
  const seen = new Set<string>()
  // Built-in ids are reserved: a user entry reusing one would lose every
  // lookup to the built-in (the UI resolves built-ins first). Built-in
  // names are reserved the same way, so a loaded " Title " cannot sit
  // beside the built-in Title and bypass the save/rename guards.
  const builtins = createBuiltinTextPresets()
  const builtinIds = new Set(builtins.map((p) => p.id))
  const seenNames = new Set(builtins.map((p) => p.name.toLowerCase()))
  let dropped = false
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      dropped = true
      continue
    }
    const p = entry as Record<string, unknown>
    // Names hydrate trimmed, so a loaded " Opener " can neither display
    // oddly nor slip past the save/rename duplicate guards.
    const name = typeof p.name === 'string' ? p.name.trim() : ''
    if (typeof p.id !== 'string' || !p.id || !name) {
      dropped = true
      continue
    }
    if (seen.has(p.id) || builtinIds.has(p.id)) {
      dropped = true
      continue
    }
    if (seenNames.has(name.toLowerCase())) {
      dropped = true
      continue
    }
    seen.add(p.id)
    seenNames.add(name.toLowerCase())
    // hydrateStyle types as Clip['style'] (optional); at runtime it always
    // returns the full defaulted object, and the fallback below only guards
    // the type, reusing the one default style both call sites share.
    const style = hydrateStyle(p.style as Record<string, unknown> | undefined)
    // One shared bounds helper with the save path (see factories.ts), so a
    // finite-but-wild file value collapses instead of reaching the canvas.
    const full = sanitizePresetStyle(style ?? createDefaultTextStyle())
    presets.push({ id: p.id, name, style: full })
  }
  if (dropped) {
    console.warn('[serialization] dropped a broken title preset entry')
  }
  return presets.length > 0 ? presets : undefined
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
