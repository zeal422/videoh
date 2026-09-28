import {
  GAIN_MAX,
  GAIN_MIN,
  KEYFRAME_PROPERTY_BOUNDS,
  MIN_CLIP_DURATION,
  MIN_SPLIT_HEADROOM,
  FPS_MAX,
  FPS_MIN,
  OPACITY_MAX,
  OPACITY_MIN,
  PROJECT_MAX_H,
  PROJECT_MAX_W,
  PROJECT_MIN_H,
  PROJECT_MIN_W,
  SPEED_MAX,
  SPEED_MIN,
  EQ_DB_MIN,
  EQ_DB_MAX,
  TRANSITION_MAX,
  TRANSITION_MIN,
} from './constants'
import {
  clipFitsTrack,
  docDuration,
  findClip,
  findMedia,
  findTrack,
  nextClipOnTrack,
  uid,
} from './factories'
import { clamp } from './time'
import { isAnimatableProperty, sanitizeKeyframes, splitKeyframeMap } from './keyframes'
import { applyMarkerPatch, reIdMarkers } from './markers'
import { maxTransitionDuration } from './transition'
import type {
  Clip,
  Doc,
  Keyframe,
  KeyframeMap,
  KeyframeProperty,
  Marker,
  MarkerPatch,
  MediaAsset,
  Project,
  TextStyle,
  Track,
  Transition,
  TrackKind,
} from './types'

/**
 * Command layer — the ONLY way state mutates.
 *
 * Every mutation is a named, validated command applied via {@link applyCommand},
 * which clones the doc, applies the change and returns a new doc. The store keeps
 * whole-doc snapshots before each command, giving every command a symmetric
 * `do` (apply) and `undo` (restore snapshot) for free — see `store.ts`.
 */

/** Thrown when a command is invalid (unknown ids, out-of-bounds trims, …). */
export class EditorCommandError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EditorCommandError'
  }
}

export type EditorCommand =
  // media bin
  | { type: 'addMediaAsset'; asset: MediaAsset }
  | { type: 'removeMediaAsset'; mediaId: string }
  | { type: 'relinkMedia'; mediaId: string; patch: Partial<MediaAsset> }
  // tracks
  | { type: 'addTrack'; kind: TrackKind; trackId?: string; atIndex?: number }
  | { type: 'removeTrack'; trackId: string }
  | { type: 'renameTrack'; trackId: string; name: string }
  | { type: 'toggleTrackMute'; trackId: string }
  // clips
  | { type: 'addClip'; clip: Clip; trackId: string }
  | { type: 'moveClip'; clipId: string; trackId: string; start: number }
  | {
      type: 'trimClip'
      clipId: string
      start: number
      inPoint: number
      duration: number
    }
  | { type: 'splitClip'; clipId: string; atTime: number; rightId?: string; rightLinkId?: string }
  | { type: 'deleteClip'; clipId: string }
  | { type: 'unlinkClip'; clipId: string }
  | { type: 'linkClips'; clipIds: string[] }
  | { type: 'setClipGain'; clipId: string; gain: number }
  | { type: 'setClipMuted'; clipId: string; muted: boolean }
  | { type: 'setClipOpacity'; clipId: string; opacity: number }
  // keyframes + speed + transform/color statics (0.5.0)
  | {
      type: 'setClipKeyframes'
      clipId: string
      property: KeyframeProperty
      keyframes: Keyframe[]
    }
  | { type: 'setClipSpeed'; clipId: string; speed: number }
  | { type: 'setClipReverse'; clipId: string; reverse: boolean }
  | { type: 'setClipPan'; clipId: string; pan: number }
  | { type: 'setClipEq'; clipId: string; eq: { low: number; mid: number; high: number } | null }
  | { type: 'setClipCompressor'; clipId: string; enabled: boolean }
  | {
      type: 'setClipAnimStatic'
      clipId: string
      property: Exclude<KeyframeProperty, 'opacity' | 'volume'>
      value: number
    }
  // text
  | { type: 'setTextContent'; clipId: string; text: string }
  | { type: 'setTextStyle'; clipId: string; style: Partial<TextStyle> }
  // transitions
  | { type: 'addTransition'; clipId: string; duration: number }
  | { type: 'removeTransition'; clipId: string }
  // markers (0.5.5)
  | { type: 'addSequenceMarker'; marker: Marker }
  | { type: 'moveSequenceMarker'; markerId: string; time: number }
  | { type: 'updateSequenceMarker'; markerId: string; patch: MarkerPatch }
  | { type: 'deleteSequenceMarker'; markerId: string }
  | { type: 'addClipMarker'; clipId: string; marker: Marker }
  | { type: 'moveClipMarker'; clipId: string; markerId: string; time: number }
  | { type: 'updateClipMarker'; clipId: string; markerId: string; patch: MarkerPatch }
  | { type: 'deleteClipMarker'; clipId: string; markerId: string }
  // project
  | {
      type: 'setProjectSettings'
      patch: Partial<Pick<Project, 'name' | 'width' | 'height' | 'fps'>>
    }

/**
 * Applies a command to a doc and returns a NEW doc (input is never mutated).
 * Throws {@link EditorCommandError} for invalid commands — callers decide whether
 * to surface the message (toasts) or ignore.
 */
export function applyCommand(doc: Doc, command: EditorCommand): Doc {
  const next = structuredClone(doc) as Doc
  mutateDoc(next, command)
  return next
}

/** Applies a sequence of commands as one unit (single clone). */
export function applyCommands(doc: Doc, commands: EditorCommand[]): Doc {
  const next = structuredClone(doc) as Doc
  for (const command of commands) mutateDoc(next, command)
  return next
}

function mutateDoc(doc: Doc, command: EditorCommand): void {
  switch (command.type) {
    case 'addMediaAsset': {
      if (doc.media.some((m) => m.id === command.asset.id)) {
        throw new EditorCommandError(`Media asset ${command.asset.id} already exists`)
      }
      doc.media.push(structuredClone(command.asset))
      return
    }

    case 'removeMediaAsset': {
      const index = doc.media.findIndex((m) => m.id === command.mediaId)
      if (index === -1) throw new EditorCommandError('Unknown media asset')
      doc.media.splice(index, 1)
      // Clips keep their dangling mediaId and render as "missing" — recoverable via relink.
      return
    }

    case 'relinkMedia': {
      const asset = doc.media.find((m) => m.id === command.mediaId)
      if (!asset) throw new EditorCommandError('Unknown media asset')
      Object.assign(asset, command.patch, { missing: false })
      return
    }

    case 'addTrack': {
      const track = newTrackForKind(doc, command.kind)
      if (command.trackId) track.id = command.trackId
      if (command.atIndex !== undefined) {
        // Explicit z-placement (drop-between-tracks): insert exactly where the
        // user pointed. The text→video→audio convention sort is intentionally
        // skipped — explicit layering intent wins over the default ordering.
        const index = Math.max(0, Math.min(command.atIndex, doc.project.tracks.length))
        doc.project.tracks.splice(index, 0, track)
      } else {
        insertTrack(doc, track)
        reorderTracksConvention(doc)
      }
      return
    }

    case 'removeTrack': {
      if (doc.project.tracks.length <= 1) {
        throw new EditorCommandError('Cannot remove the last track')
      }
      const index = doc.project.tracks.findIndex((t) => t.id === command.trackId)
      if (index === -1) throw new EditorCommandError('Unknown track')
      doc.project.tracks.splice(index, 1)
      return
    }

    case 'renameTrack': {
      const track = requireTrack(doc, command.trackId)
      track.name = command.name.trim() || track.name
      return
    }

    case 'toggleTrackMute': {
      const track = requireTrack(doc, command.trackId)
      track.muted = !track.muted
      return
    }

    case 'addClip': {
      const track = requireTrack(doc, command.trackId)
      const clip = structuredClone(command.clip)
      if (!Number.isFinite(clip.duration) || clip.duration < MIN_CLIP_DURATION) {
        throw new EditorCommandError('Clip duration is too short')
      }
      if (clip.start < 0) clip.start = 0
      if (!clipFitsTrack(doc, clip, track)) {
        throw new EditorCommandError(
          `${describeClip(doc, clip)} cannot be placed on a ${track.kind} track`,
        )
      }
      clampClipToMedia(doc, clip)
      track.clips.push(clip)
      track.clips.sort((a, b) => a.start - b.start)
      return
    }

    case 'moveClip': {
      const found = requireClip(doc, command.clipId)
      const target = findTrack(doc, command.trackId)
      if (!target) throw new EditorCommandError('Unknown track')
      if (!clipFitsTrack(doc, found.clip, target)) {
        throw new EditorCommandError(
          `${describeClip(doc, found.clip)} cannot be placed on a ${target.kind} track`,
        )
      }
      found.clip.start = Math.max(0, command.start)
      if (target.id !== found.track.id) {
        found.track.clips = found.track.clips.filter((c) => c.id !== found.clip.id)
        target.clips.push(found.clip)
      }
      target.clips.sort((a, b) => a.start - b.start)
      return
    }

    case 'trimClip': {
      const { clip } = requireClip(doc, command.clipId)
      const asset = findMedia(doc, clip.mediaId)
      let { start, inPoint, duration } = command
      if (duration < MIN_CLIP_DURATION) throw new EditorCommandError('Clip would become too short')
      start = Math.max(0, start)
      if (asset && asset.kind !== 'image') {
        const speed = clip.speed ?? 1
        const sourceSpan = duration * speed
        if (inPoint < 0) throw new EditorCommandError('Trim exceeds the start of the source')
        if (inPoint + sourceSpan > asset.duration + 1e-6) {
          throw new EditorCommandError('Trim exceeds the end of the source')
        }
      } else {
        inPoint = 0
      }
      clip.start = start
      clip.inPoint = inPoint
      clip.duration = duration
      const track = requireTrack(doc, foundTrackId(doc, clip.id))
      track.clips.sort((a, b) => a.start - b.start)
      return
    }

    case 'splitClip': {
      const { clip, track } = requireClip(doc, command.clipId)
      const at = command.atTime
      if (
        at <= clip.start + MIN_SPLIT_HEADROOM ||
        at >= clip.start + clip.duration - MIN_SPLIT_HEADROOM
      ) {
        throw new EditorCommandError('Playhead is too close to the clip edge to split')
      }
      const asset = findMedia(doc, clip.mediaId)
      const leftDuration = at - clip.start
      const rightDuration = clip.duration - leftDuration
      const speed = clip.speed ?? 1
      const isMedia = !!asset && asset.kind !== 'image'
      // Source-span mapping. A forward clip keeps the left half's inPoint and
      // advances the right half by the left duration. A reversed clip reads its
      // span backwards, so the left half owns the span's tail: the right half
      // keeps the original inPoint and the left half moves up by the right
      // duration. Either way both halves keep reading the same source frames.
      const splitInPoint = (offset: number) => clip.inPoint + offset * speed
      const leftInPoint = isMedia && clip.reverse ? splitInPoint(rightDuration) : clip.inPoint
      const [leftKeyframes, rightKeyframes] = splitKeyframeMap(clip.keyframes, leftDuration)
      const right: Clip = {
        ...structuredClone(clip),
        id: command.rightId ?? `clip_${cryptoRandom()}`,
        start: at,
        duration: rightDuration,
        inPoint: isMedia ? (clip.reverse ? clip.inPoint : splitInPoint(leftDuration)) : 0,
        transitionOut: clip.transitionOut,
        keyframes: rightKeyframes,
      }
      // Markers are source-anchored, so both halves still show every cue that
      // falls inside their own span — but the ids must be FRESH on the right
      // half. Shared ids would make delete/edit on one half leave the twin
      // behind (extending the half later resurrects it) and drop the twin
      // from snap exclusion (`excludeMarkerId` matches by id).
      right.markers = reIdMarkers(right.markers)
      // Premiere split semantics: the right half is a SEPARATE link group. The
      // group-split action passes one shared `rightLinkId` so all right halves
      // of an A/V pair re-link with each other; a bare linked split gets a
      // fresh group automatically.
      if (right.linkId !== undefined) {
        right.linkId = command.rightLinkId ?? `link_${cryptoRandom()}`
      }
      clip.duration = leftDuration
      clip.inPoint = leftInPoint
      clip.transitionOut = undefined
      clip.keyframes = leftKeyframes
      track.clips.push(right)
      track.clips.sort((a, b) => a.start - b.start)
      return
    }

    case 'deleteClip': {
      const { track } = requireClip(doc, command.clipId)
      track.clips = track.clips.filter((c) => c.id !== command.clipId)
      return
    }

    case 'unlinkClip': {
      // Break the A/V bond on EVERY member of the group in one command —
      // unlinking is a decision about the pair, not one half of it.
      // NOTE: capture the group id BEFORE mutating — `clip` is itself a group
      // member, so clearing its linkId mid-loop would destroy the anchor and
      // silently skip the twin.
      const { clip } = requireClip(doc, command.clipId)
      const groupId = clip.linkId
      if (!groupId) throw new EditorCommandError('Clip is not linked')
      for (const track of doc.project.tracks) {
        for (const c of track.clips) {
          if (c.linkId === groupId) c.linkId = undefined
        }
      }
      return
    }

    case 'linkClips': {
      // Premiere-style manual link (multi-select via Shift+click, then Link):
      // every selected clip joins ONE shared group. Groups that extend BEYOND
      // the selection merge whole — an unselected partner of a selected clip
      // stays bonded to it (Premiere links merge, never split).
      if (command.clipIds.length < 2) {
        throw new EditorCommandError('Linking needs at least two clips')
      }
      const clips = command.clipIds.map((id) => requireClip(doc, id).clip)
      if (clips.some((c) => c.text !== undefined)) {
        throw new EditorCommandError('Text clips cannot be linked')
      }
      const mergedGroupId = clips.find((c) => c.linkId)?.linkId ?? `link_${cryptoRandom()}`
      const oldGroupIds = new Set(clips.map((c) => c.linkId).filter((x): x is string => !!x))
      for (const track of doc.project.tracks) {
        for (const c of track.clips) {
          if (c.linkId && oldGroupIds.has(c.linkId)) c.linkId = mergedGroupId
        }
      }
      for (const c of clips) c.linkId = mergedGroupId
      return
    }

    case 'setClipGain': {
      const { clip } = requireClip(doc, command.clipId)
      clip.gain = clamp(command.gain, GAIN_MIN, GAIN_MAX)
      return
    }

    case 'setClipMuted': {
      const { clip } = requireClip(doc, command.clipId)
      clip.muted = command.muted
      return
    }

    case 'setClipOpacity': {
      const { clip } = requireClip(doc, command.clipId)
      clip.opacity = clamp(command.opacity, OPACITY_MIN, OPACITY_MAX)
      return
    }

    case 'setClipKeyframes': {
      const { clip } = requireClip(doc, command.clipId)
      if (!isAnimatableProperty(command.property)) {
        throw new EditorCommandError(`Unknown animatable property: ${command.property}`)
      }
      const keyframes = sanitizeKeyframes(command.property, command.keyframes)
      if (!clip.keyframes) clip.keyframes = {}
      if (keyframes.length === 0) {
        // An empty curve clears the animation; the property falls back to its
        // static value. An empty map object is removed entirely.
        delete clip.keyframes[command.property]
        if (Object.keys(clip.keyframes).length === 0) clip.keyframes = undefined
      } else {
        clip.keyframes[command.property] = keyframes
      }
      return
    }

    case 'setClipSpeed': {
      const { clip } = requireClip(doc, command.clipId)
      if (clip.text !== undefined) throw new EditorCommandError('Text clips cannot change speed')
      const speed = clamp(command.speed, SPEED_MIN, SPEED_MAX)
      const asset = findMedia(doc, clip.mediaId)
      if (asset && asset.kind !== 'image') {
        // Keep the timeline duration (and everything cut against it) stable;
        // the source span re-derives from the new rate, clamped so the clip
        // never needs source past the asset's end.
        const maxDuration = Math.max(MIN_CLIP_DURATION, (asset.duration - clip.inPoint) / speed)
        clip.duration = Math.min(clip.duration, maxDuration)
      }
      clip.speed = speed
      return
    }

    case 'setClipReverse': {
      const { clip } = requireClip(doc, command.clipId)
      if (clip.text !== undefined) throw new EditorCommandError('Text clips cannot reverse')
      clip.reverse = command.reverse
      return
    }

    case 'setClipPan': {
      const { clip } = requireClip(doc, command.clipId)
      clip.pan = clamp(command.pan, -1, 1)
      return
    }

    case 'setClipEq': {
      const { clip } = requireClip(doc, command.clipId)
      if (!command.eq) {
        clip.eq = undefined
        return
      }
      const band = (v: number) => clamp(v, EQ_DB_MIN, EQ_DB_MAX)
      clip.eq = {
        low: band(command.eq.low),
        mid: band(command.eq.mid),
        high: band(command.eq.high),
      }
      return
    }

    case 'setClipCompressor': {
      const { clip } = requireClip(doc, command.clipId)
      clip.compressor = command.enabled
      return
    }

    case 'setClipAnimStatic': {
      const { clip } = requireClip(doc, command.clipId)
      const bounds = KEYFRAME_PROPERTY_BOUNDS[command.property]
      if (!clip.animStatics) clip.animStatics = {}
      const clamped = clamp(command.value, bounds.min, bounds.max)
      if (clamped === bounds.default) {
        delete clip.animStatics[command.property]
        if (Object.keys(clip.animStatics).length === 0) clip.animStatics = undefined
      } else {
        clip.animStatics[command.property] = clamped
      }
      return
    }

    case 'setTextContent': {
      const { clip } = requireClip(doc, command.clipId)
      if (clip.text === undefined) throw new EditorCommandError('Not a text clip')
      clip.text = command.text
      return
    }

    case 'setTextStyle': {
      const { clip } = requireClip(doc, command.clipId)
      if (!clip.style) throw new EditorCommandError('Not a text clip')
      clip.style = { ...clip.style, ...command.style }
      return
    }

    case 'addTransition': {
      const { clip: a, track } = requireClip(doc, command.clipId)
      const b = nextClipOnTrack(track, a)
      if (!b) throw new EditorCommandError('No following clip on this track to transition into')
      const requested = clamp(command.duration, TRANSITION_MIN, TRANSITION_MAX)
      const maxDur = maxTransitionDuration(a, b, a.start + a.duration)
      const duration = Math.min(requested, maxDur)
      if (duration < TRANSITION_MIN) {
        throw new EditorCommandError('Not enough room for a transition between these clips')
      }
      // Pull the next clip left so the crossfade has a real overlap.
      b.start = a.start + a.duration - duration
      a.transitionOut = { type: 'crossfade', duration } as Transition
      track.clips.sort((x, y) => x.start - y.start)
      return
    }

    case 'removeTransition': {
      const { clip } = requireClip(doc, command.clipId)
      clip.transitionOut = undefined
      // Note: the next clip keeps its (now transition-less) overlap — harmless,
      // the higher clip simply wins visually. Keeps undo semantics predictable.
      return
    }

    case 'addSequenceMarker': {
      const marker = sanitizeMarker(command.marker)
      const list = doc.project.markers ?? (doc.project.markers = [])
      if (list.some((m) => m.id === marker.id)) {
        throw new EditorCommandError(`Marker ${marker.id} already exists`)
      }
      list.push(marker)
      list.sort((a, b) => a.time - b.time)
      return
    }

    case 'moveSequenceMarker': {
      const marker = requireSequenceMarker(doc, command.markerId)
      marker.time = markerTime(command.time)
      doc.project.markers!.sort((a, b) => a.time - b.time)
      return
    }

    case 'updateSequenceMarker': {
      applyMarkerPatch(requireSequenceMarker(doc, command.markerId), command.patch)
      return
    }

    case 'deleteSequenceMarker': {
      const list = doc.project.markers
      const index = list?.findIndex((m) => m.id === command.markerId) ?? -1
      if (!list || index === -1) throw new EditorCommandError('Unknown marker')
      list.splice(index, 1)
      // Empty arrays are omitted so saved files stay clean.
      if (list.length === 0) doc.project.markers = undefined
      return
    }

    case 'addClipMarker': {
      const { clip } = requireClip(doc, command.clipId)
      const marker = sanitizeMarker(command.marker)
      const list = clip.markers ?? (clip.markers = [])
      if (list.some((m) => m.id === marker.id)) {
        throw new EditorCommandError(`Marker ${marker.id} already exists`)
      }
      list.push(marker)
      list.sort((a, b) => a.time - b.time)
      return
    }

    case 'moveClipMarker': {
      const { clip } = requireClip(doc, command.clipId)
      const marker = requireClipMarker(clip, command.markerId)
      marker.time = markerTime(command.time)
      clip.markers!.sort((a, b) => a.time - b.time)
      return
    }

    case 'updateClipMarker': {
      const { clip } = requireClip(doc, command.clipId)
      applyMarkerPatch(requireClipMarker(clip, command.markerId), command.patch)
      return
    }

    case 'deleteClipMarker': {
      const { clip } = requireClip(doc, command.clipId)
      const list = clip.markers
      const index = list?.findIndex((m) => m.id === command.markerId) ?? -1
      if (!list || index === -1) throw new EditorCommandError('Unknown marker')
      list.splice(index, 1)
      if (list.length === 0) clip.markers = undefined
      return
    }

    case 'setProjectSettings': {
      const p = doc.project
      if (command.patch.name !== undefined) p.name = command.patch.name.trim() || p.name
      if (command.patch.width !== undefined) {
        p.width = clamp(Math.round(command.patch.width), PROJECT_MIN_W, PROJECT_MAX_W)
      }
      if (command.patch.height !== undefined) {
        p.height = clamp(Math.round(command.patch.height), PROJECT_MIN_H, PROJECT_MAX_H)
      }
      if (command.patch.fps !== undefined) {
        p.fps = clamp(Math.round(command.patch.fps), FPS_MIN, FPS_MAX)
      }
      return
    }

    default: {
      const exhaustive: never = command
      throw new EditorCommandError(`Unknown command: ${JSON.stringify(exhaustive)}`)
    }
  }
}

// ————— helpers —————

function requireClip(doc: Doc, clipId: string) {
  const found = findClip(doc, clipId)
  if (!found) throw new EditorCommandError('Unknown clip')
  return found
}

function markerTime(time: number): number {
  if (!Number.isFinite(time) || time < 0) {
    throw new EditorCommandError('Marker time must be a non-negative number')
  }
  return time
}

/** Validated copy of an incoming marker (id required, time finite, patch trimmed). */
function sanitizeMarker(marker: Marker): Marker {
  if (typeof marker.id !== 'string' || !marker.id) {
    throw new EditorCommandError('Marker id is required')
  }
  const next: Marker = { id: marker.id, time: markerTime(marker.time) }
  applyMarkerPatch(next, marker)
  return next
}

function requireSequenceMarker(doc: Doc, markerId: string): Marker {
  const marker = (doc.project.markers ?? []).find((m) => m.id === markerId)
  if (!marker) throw new EditorCommandError('Unknown marker')
  return marker
}

function requireClipMarker(clip: Clip, markerId: string): Marker {
  const marker = clip.markers?.find((m) => m.id === markerId)
  if (!marker) throw new EditorCommandError('Unknown marker')
  return marker
}

function requireTrack(doc: Doc, trackId: string) {
  const track = findTrack(doc, trackId)
  if (!track) throw new EditorCommandError('Unknown track')
  return track
}

function foundTrackId(doc: Doc, clipId: string): string {
  const found = findClip(doc, clipId)
  if (!found) throw new EditorCommandError('Unknown clip')
  return found.track.id
}

function describeClip(doc: Doc, clip: Clip): string {
  if (clip.text !== undefined) return 'Text'
  const asset = findMedia(doc, clip.mediaId)
  return asset ? `“${asset.name}” (${asset.kind})` : 'Clip'
}

/** Clamps a clip's duration against its source media (video/audio only), honoring speed. */
function clampClipToMedia(doc: Doc, clip: Clip): void {
  const asset = findMedia(doc, clip.mediaId)
  if (!asset || asset.kind === 'image') return
  if (clip.inPoint < 0) clip.inPoint = 0
  const speed = clip.speed ?? 1
  const maxDuration = Math.max(MIN_CLIP_DURATION, (asset.duration - clip.inPoint) / speed)
  clip.duration = Math.min(clip.duration, maxDuration)
}

/**
 * The name the next new track of `kind` would get (V2, A3, …) — shared by the
 * command itself and the drop indicator's "+ V2" preview label.
 */
export function previewTrackName(doc: Doc, kind: TrackKind): string {
  const count = doc.project.tracks.filter((t) => t.kind === kind).length
  const prefix = kind === 'video' ? 'V' : kind === 'audio' ? 'A' : 'T'
  return `${prefix}${count + 1}`
}

function newTrackForKind(doc: Doc, kind: TrackKind) {
  return {
    id: `track_${cryptoRandom()}`,
    kind,
    name: previewTrackName(doc, kind),
    clips: [],
  }
}

/**
 * Re-orders tracks to the editor convention: text tracks on top, then video,
 * then audio. Stable (preserves relative order inside each group).
 */
function reorderTracksConvention(doc: Doc): void {
  const rank: Record<TrackKind, number> = { text: 0, video: 1, audio: 2 }
  doc.project.tracks.sort((a, b) => rank[a.kind] - rank[b.kind])
}

/**
 * Inserts a new track at the HEAD of its kind's group — Premiere/Photoshop
 * layering semantics: the newest video track (V2) stacks ABOVE V1 and renders
 * on top, so fresh material lands on the higher layer by default. The
 * stable convention sort afterwards keeps this relative order.
 */
function insertTrack(doc: Doc, track: Track): void {
  const firstOfKind = doc.project.tracks.findIndex((t) => t.kind === track.kind)
  if (firstOfKind === -1) doc.project.tracks.push(track)
  else doc.project.tracks.splice(firstOfKind, 0, track)
}

function cryptoRandom(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** Convenience for UI code: total timeline length (re-exported for ergonomics). */
export { docDuration }
