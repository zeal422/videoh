import {
  GAIN_MAX,
  GAIN_MIN,
  KEYFRAME_PROPERTY_BOUNDS,
  MAX_SEQUENCE_DEPTH,
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
  TEMPERATURE_MAX,
  TEMPERATURE_MIN,
  TINT_MAX,
  TINT_MIN,
  TRANSITION_MAX,
  TRANSITION_MIN,
} from './constants'
import {
  clipFitsTrack,
  docDuration,
  findClip,
  findMedia,
  findSequence,
  findTrack,
  findTrackIn,
  maxSequenceDepth,
  nextClipOnTrack,
  sequenceReachable,
  sequenceTracks,
  uid,
  createBuiltinTextPresets,
  sanitizePresetStyle,
} from './factories'
import { rehomeSegmentShapes } from './ease-segment'
import { linkedClips } from './links'
import { lutBudgetMessage, lutLibraryChars } from './lut'
import { clamp } from './time'
import {
  hasTimeScaleCurve,
  integrateKeyframes,
  isAnimatableProperty,
  isKeyframeInterpolation,
  sanitizeKeyframes,
  splitKeyframeMap,
} from './keyframes'
import { applyMarkerPatch, reIdMarkers } from './markers'
import { maxTransitionDuration, TRANSITION_FEATHER_DEFAULT } from './transition'
import {
  largestFittingDuration,
  rebaseCurveFromCut,
  sourceConsumption,
  truncateCurveAtCut,
} from './trim'
import type {
  AnimStaticProperty,
  Clip,
  Doc,
  Keyframe,
  KeyframeInterpolation,
  KeyframeMap,
  KeyframeProperty,
  Marker,
  MarkerPatch,
  MediaAsset,
  Project,
  ProjectLut,
  Sequence,
  TextPreset,
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

/**
 * Which part of a clip a `trimClip` call moves.
 *
 * `'head'`/`'tail'` name the EDGE the caller dragged for a plain trim: the
 * caller's `inPoint` tracks that move (a forward head trim carries
 * `inPoint + delta`), which is what lets the command validate the source it
 * consumes. `'span'` says the caller re-timed the clip while holding its SOURCE
 * SPAN fixed (Alt-drag rate stretch), so no source anchor moves at all.
 *
 * The edge is required rather than inferred from `inPoint`, because a REVERSED
 * clip's edges are mirrored: its head shows the span's HIGH source end and its
 * tail the LOW one, and a reversed tail move changes `inPoint` while a reversed
 * head move does not, which is the opposite of the forward shape.
 */
export type TrimEdge = 'head' | 'tail' | 'span'

export type EditorCommand =
  // media bin
  | { type: 'addMediaAsset'; asset: MediaAsset }
  | { type: 'removeMediaAsset'; mediaId: string }
  | { type: 'relinkMedia'; mediaId: string; patch: Partial<MediaAsset> }
  // sequences (compound clips, 0.8.1)
  | { type: 'addSequence'; sequence: Sequence }
  | {
      type: 'createCompoundClip'
      /** The clips to fold into the compound (all in one sequence). */
      clipIds: string[]
      /** The video lane in the SAME sequence the container clip lands on. */
      trackId: string
      name?: string
    }
  // tracks
  | {
      type: 'addTrack'
      kind: TrackKind
      trackId?: string
      atIndex?: number
      /** Owning compound sequence; undefined = the project root. */
      sequenceId?: string
    }
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
      /** See {@link TrimEdge}: which edge (or fixed span) the caller moved. */
      edge: TrimEdge
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
  | {
      type: 'setKeyframeDefault'
      property: KeyframeProperty
      interpolation: KeyframeInterpolation
    }
  | { type: 'setClipSpeed'; clipId: string; speed: number }
  | { type: 'setClipReverse'; clipId: string; reverse: boolean }
  | { type: 'setClipPan'; clipId: string; pan: number }
  | { type: 'setClipEq'; clipId: string; eq: { low: number; mid: number; high: number } | null }
  | { type: 'setClipCompressor'; clipId: string; enabled: boolean }
  | { type: 'setClipDenoise'; clipId: string; enabled: boolean }
  | {
      type: 'setClipColorParams'
      clipId: string
      temperature: number
      tint: number
    }
  // LUT library (0.7.0)
  | { type: 'importProjectLut'; lut: ProjectLut }
  | { type: 'setClipLut'; clipId: string; lutId: string | null }
  | {
      type: 'setClipAnimStatic'
      clipId: string
      property: AnimStaticProperty
      value: number
    }
  // text
  | { type: 'setTextContent'; clipId: string; text: string }
  | { type: 'setTextStyle'; clipId: string; style: Partial<TextStyle> }
  // title presets (0.8.3)
  | { type: 'saveTextPreset'; preset: TextPreset }
  | { type: 'renameTextPreset'; presetId: string; name: string }
  | { type: 'deleteTextPreset'; presetId: string }
  // transitions
  | {
      type: 'addTransition'
      clipId: string
      duration: number
      transitionType?: Transition['type']
      direction?: Transition['direction']
      edge?: Transition['edge']
      feather?: Transition['feather']
    }
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
      // Clips keep their dangling mediaId and render blank; undo restores the asset (relink
      // needs an asset to exist), and the export gate refuses while it is gone.
      return
    }

    case 'relinkMedia': {
      const asset = doc.media.find((m) => m.id === command.mediaId)
      if (!asset) throw new EditorCommandError('Unknown media asset')
      Object.assign(asset, command.patch, { missing: false })
      return
    }

    case 'addSequence': {
      const sequences = doc.project.sequences ?? (doc.project.sequences = [])
      if (sequences.some((s) => s.id === command.sequence.id)) {
        throw new EditorCommandError(`Sequence ${command.sequence.id} already exists`)
      }
      if (sequences.some((s) => s.id === doc.project.id)) {
        throw new EditorCommandError('Sequence id collides with the project id')
      }
      sequences.push(structuredClone(command.sequence))
      return
    }

    case 'createCompoundClip': {
      if (command.clipIds.length === 0) throw new EditorCommandError('Select at least one clip')
      const found = command.clipIds.map((id) => requireClip(doc, id))
      // Expand through link groups: a link group is one unit, so the compound
      // must take every member or it would split the group, which the
      // sequence-local link policy forbids.
      const byId = new Map<string, ReturnType<typeof requireClip>>()
      for (const f of found) {
        for (const member of linkedClips(doc, f.clip.id)) {
          const m = findClip(doc, member.id)
          if (m) byId.set(m.clip.id, m)
        }
      }
      const members = [...byId.values()]
      // The whole selection must live in ONE sequence (independent local time
      // origins make a cross-sequence container meaningless).
      const owner = members[0].sequenceId
      if (members.some((f) => f.sequenceId !== owner)) {
        throw new EditorCommandError('Cannot combine clips across sequences')
      }
      const dest = findTrackIn(doc, command.trackId)
      if (!dest) throw new EditorCommandError('Unknown track')
      if (dest.sequenceId !== owner) {
        throw new EditorCommandError('Destination track is in another sequence')
      }
      if (dest.track.kind !== 'video') {
        throw new EditorCommandError('Compound clips live on video tracks')
      }
      // Cycle guard: refuse when the owner is reachable from a selected
      // compound's referenced sequence (the new edge would close a loop).
      if (owner) {
        for (const f of members) {
          if (f.clip.sequenceId && sequenceReachable(doc, f.clip.sequenceId, owner)) {
            throw new EditorCommandError('This compound would create a cycle')
          }
        }
      }
      const minStart = Math.min(...members.map((f) => f.clip.start))
      const maxEnd = Math.max(...members.map((f) => f.clip.start + f.clip.duration))
      const duration = maxEnd - minStart
      if (duration < MIN_CLIP_DURATION) throw new EditorCommandError('Selection is too short')

      const selectedIds = new Set(members.map((f) => f.clip.id))
      const ownerTracks = sequenceTracks(doc, owner)
      // The new sequence mirrors the owner lanes that hold selected clips,
      // rebasing every clip to local 0.
      const seqTracks: Track[] = []
      for (const track of ownerTracks) {
        const clips = track.clips.filter((c) => selectedIds.has(c.id))
        if (clips.length === 0) continue
        seqTracks.push({
          id: `track_${cryptoRandom()}`,
          kind: track.kind,
          name: track.name,
          clips: clips.map((c) => ({ ...structuredClone(c), start: c.start - minStart })),
        })
      }
      const sequenceId = `seq_${cryptoRandom()}`
      const sequences = doc.project.sequences ?? (doc.project.sequences = [])
      sequences.push({
        id: sequenceId,
        name: command.name?.trim() || 'Compound Clip',
        tracks: seqTracks,
      })
      // Add the container first so the depth walk SEES the new edge, then check.
      const compound: Clip = {
        id: `clip_${cryptoRandom()}`,
        sequenceId,
        start: minStart,
        duration,
        inPoint: 0,
      }
      dest.track.clips.push(compound)
      // Depth guard on the prospective graph (also catches a cycle that slipped
      // past the per-clip check, since the walk returns Infinity on a loop).
      if (maxSequenceDepth(doc) > MAX_SEQUENCE_DEPTH) {
        sequences.pop()
        dest.track.clips = dest.track.clips.filter((c) => c.id !== compound.id)
        throw new EditorCommandError('Compound clip nesting is too deep')
      }
      // Remove the originals from the owner's lanes now that the container is in.
      for (const track of ownerTracks) {
        track.clips = track.clips.filter((c) => !selectedIds.has(c.id))
      }
      dest.track.clips.sort((a, b) => a.start - b.start)
      return
    }

    case 'addTrack': {
      const owner = command.sequenceId ? findSequence(doc, command.sequenceId) : undefined
      if (command.sequenceId && !owner) throw new EditorCommandError('Unknown sequence')
      const tracks = owner ? owner.tracks : doc.project.tracks
      const track = newTrackForKind(doc, command.kind, command.sequenceId)
      if (command.trackId) track.id = command.trackId
      if (command.atIndex !== undefined) {
        // Explicit z-placement (drop-between-tracks): insert exactly where the
        // user pointed. The text→video→audio convention sort is intentionally
        // skipped — explicit layering intent wins over the default ordering.
        const index = Math.max(0, Math.min(command.atIndex, tracks.length))
        tracks.splice(index, 0, track)
      } else {
        insertTrack(tracks, track)
        reorderTracksConvention(tracks)
      }
      return
    }

    case 'removeTrack': {
      const found = findTrackIn(doc, command.trackId)
      if (!found) throw new EditorCommandError('Unknown track')
      const tracks = found.sequenceId
        ? (findSequence(doc, found.sequenceId)?.tracks ?? [])
        : doc.project.tracks
      if (tracks.length <= 1) {
        throw new EditorCommandError('Cannot remove the last track')
      }
      const index = tracks.findIndex((t) => t.id === command.trackId)
      if (index === -1) throw new EditorCommandError('Unknown track')
      tracks.splice(index, 1)
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
      // A compound clip placed on a lane must not close a reference cycle
      // (paste/move are the paths the create-time guard cannot see).
      assertCompoundCycle(doc, clip, findTrackIn(doc, track.id)?.sequenceId)
      clampClipToMedia(doc, clip)
      track.clips.push(clip)
      if (clip.sequenceId && maxSequenceDepth(doc) > MAX_SEQUENCE_DEPTH) {
        track.clips = track.clips.filter((c) => c.id !== clip.id)
        throw new EditorCommandError('Compound clip nesting is too deep')
      }
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
      const clip = found.clip
      if (clip.sequenceId) {
        assertCompoundCycle(doc, clip, findTrackIn(doc, target.id)?.sequenceId)
      }
      const oldStart = clip.start
      const movedTrack = target.id !== found.track.id
      clip.start = Math.max(0, command.start)
      if (movedTrack) {
        found.track.clips = found.track.clips.filter((c) => c.id !== clip.id)
        target.clips.push(clip)
        if (clip.sequenceId && maxSequenceDepth(doc) > MAX_SEQUENCE_DEPTH) {
          target.clips = target.clips.filter((c) => c.id !== clip.id)
          clip.start = oldStart
          found.track.clips.push(clip)
          found.track.clips.sort((a, b) => a.start - b.start)
          throw new EditorCommandError('Compound clip nesting is too deep')
        }
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
      if (inPoint < 0) throw new EditorCommandError('Trim exceeds the start of the source')
      const inPointBefore = clip.inPoint
      const durationBefore = clip.duration
      const startBefore = clip.start
      const isHeadTrim = command.edge === 'head'
      // Source-bounded material (an image or text clip has no source window).
      const bounded = !!asset && asset.kind !== 'image'
      // A REVERSED clip's head edge shows the span's HIGH end, so a head move
      // removes source from the top: the LOW anchor (inPoint, shown at the
      // clip's tail) stays where it was and the duration carries the change.
      // The caller's delta is timeline-local, so applying it to inPoint would
      // re-cut the kept span one head-length up the source. A forward clip is
      // the mirror image and corrects inPoint below instead.
      if (clip.reverse && isHeadTrim) inPoint = inPointBefore
      // A constant-rate head move carries the source anchor at the clip's own
      // rate: one timeline second of head move consumes (or reveals) `speed`
      // source seconds, so the caller's raw delta (a timeline length, what the
      // gesture passes) must be scaled or the kept span re-cuts by
      // (speed - 1) * delta. Speed 1 needs no correction and a ramped clip
      // rebases from its curve below, so both keep the caller's anchor as-is.
      const rate = clip.speed ?? 1
      if (bounded && isHeadTrim && !clip.reverse && !hasTimeScaleCurve(clip) && rate !== 1) {
        const rebased = inPointBefore + (start - startBefore) * rate
        if (rebased < 0) {
          throw new EditorCommandError('Trim exceeds the start of the source')
        }
        inPoint = rebased
      }
      // A REVERSED clip's TAIL edge is its LOW source end, so a tail move has to
      // hold the HIGH end pinned and re-derive the low anchor instead: exactly
      // the shape of a FORWARD head move, mirrored. The caller cannot do this
      // itself: a ramped span's low end moves by the curve integral of the
      // timeline the tail gave up (or revealed), which only the command layer
      // has.
      const tailMirror = bounded && clip.reverse && command.edge === 'tail'
      // The window a move has to fit is the one it PINS. A reversed tail move
      // pins the HIGH end (inPointBefore + the OLD span's consumption) and
      // re-anchors the low end below, so validating the caller's inPoint at the
      // requested duration checked a window that is never produced and rejected
      // legal reveals whenever the pinned end sat on the asset's end. Every
      // other move keeps the caller's anchor and validates as before.
      const boundAnchor = tailMirror ? inPointBefore : inPoint
      const boundDuration = tailMirror ? clip.duration : duration
      if (bounded) {
        // A time-remap ramp changes how much source the kept span consumes, so
        // the guard integrates the curve instead of assuming `duration * speed`.
        const ramp = clip.keyframes?.timeScale
        if (ramp && ramp.length > 0) {
          // An over-consuming ramp (accepted on add, frozen on the last readable
          // frame at render) is a legal saved state, and clamping it here instead
          // of throwing is what keeps such a clip trimmable: the bisection
          // converges to the largest length whose integral still fits the asset.
          const consumed = (d: number) => sourceConsumption(ramp, d, clip.speed ?? 1)
          if (boundAnchor + consumed(clip.duration) > asset.duration + 1e-6) {
            // Even the minimum length cannot fit: no trim can make this state
            // valid, so reject instead of clamping to a clip that still
            // over-consumes (a frozen 0.1s stub helps nobody).
            if (boundAnchor + consumed(MIN_CLIP_DURATION) > asset.duration + 1e-6) {
              throw new EditorCommandError('Trim exceeds the end of the source')
            }
            duration = Math.min(
              duration,
              largestFittingDuration(boundAnchor, consumed, asset.duration, clip.duration),
            )
            // A head trim whose duration was clamped keeps its right edge:
            // start slides so start + duration lands where the drag anchored
            // it (command.start + command.duration).
            if (start > clip.start) {
              start = Math.max(0, start + command.duration - duration)
            }
          } else if (!tailMirror && boundAnchor + consumed(duration) > asset.duration + 1e-6) {
            throw new EditorCommandError('Trim exceeds the end of the source')
          }
        } else if (
          boundAnchor + sourceConsumption(ramp, boundDuration, clip.speed ?? 1) >
          asset.duration + 1e-6
        ) {
          throw new EditorCommandError('Trim exceeds the end of the source')
        }
      } else {
        inPoint = 0
      }
      if (tailMirror) {
        const removed = durationBefore - duration
        const tailRate = clip.keyframes?.timeScale?.length
          ? clip.keyframes.timeScale[0].value
          : (clip.speed ?? 1)
        inPoint =
          inPointBefore +
          (removed < 0
            ? removed * tailRate
            : integrateKeyframes(clip.keyframes?.timeScale ?? [], removed, clip.speed ?? 1))
        if (inPoint < 0) throw new EditorCommandError('Trim exceeds the start of the source')
      }
      clip.start = start
      clip.inPoint = inPoint
      clip.duration = duration
      // A FORWARD head trim moves local 0 onto a different part of a
      // `timeScale` curve, so the ramp must be REBASED or the kept span
      // re-times itself. Two coupled corrections:
      //
      // 1. inPoint. The caller's `inPoint` counts RAW source seconds, but a
      //    ramped head of `h` timeline seconds consumes integral(ramp, h)
      //    SOURCE seconds (a 1s head of a 1x->2x ramp consumes 1.125s).
      //    Advancing inPoint by only `h` starts the kept span short of the
      //    frame the cut landed on, so the anchor is inPoint + integral - h:
      //    local 0 keeps reading the frame the untrimmed clip showed there.
      // 2. Keyframes. The rate at the cut is pinned as a keyframe at local 0
      //    (the same pattern splitKeyframeMap uses) and keyframes past the cut
      //    keep their remaining offsets. The boundary carries the crossing
      //    segment's subdivided shape (`easeOut`, de Casteljau), so the rebased
      //    curve is exact for linear and eased ramps alike.
      //
      // A REVERSED ramped clip reads the curve through the MIRRORED offset
      // (source-side local time), so its head consumes the curve's tail in
      // that frame. The rebase keeps keyframes at or before the cut and pins
      // the boundary RATE at the cut: without it, a curve whose last keyframe
      // sits past the cut would collapse to its first keyframe's constant
      // extension. The mirrored read then integrates the kept array over
      // exactly the kept span, which is exact for linear ramps, and the anchor
      // above already kept inPoint on the low end (the reversed head-move rule,
      // which the constant-rate path shares).
      //
      // A FORWARD TAIL trim touches nothing: local 0 stays on the same frame and
      // the curve's constant extension covers a shorter span. A reversed tail
      // trim is not that case, and is rebased below.
      const spanDelta = durationBefore - duration
      const rampBefore = clip.keyframes?.timeScale
      // The rebase corrects a head that MOVED onto a different part of the
      // curve. The over-consume clamp above can also shorten `duration` (a
      // window that already read past the asset had to fit it) without the head
      // moving, and `spanDelta` would then report that clamp amount as a head
      // shrink: for a curve slower than 1x the rebased anchor `integral - span`
      // goes negative. Gate the rebase on the caller actually moving the head.
      const headMoved =
        Math.abs(command.start - startBefore) > 1e-9 ||
        Math.abs(command.inPoint - inPointBefore) > 1e-9
      // A HEAD trim moves the span's source anchor (the caller's inPoint moved
      // with the head edge), which is what puts local 0 on a different part of
      // the curve. A SHRINK (`spanDelta > 0`) drops the curve's head and pins
      // the cut's rate; an EXTENSION (`spanDelta < 0`) shifts the curve right
      // by the revealed head, whose old head rate constant-extends (no pin
      // keyframe) across the reveal. Without the extension rebase the
      // caller's raw inPoint (timeline seconds, not the source the reveal
      // consumes) re-cut the kept span. A REVERSED head extension needs no
      // rebase: the low anchor is pinned and the mirrored read integrates the
      // longer span by itself, which already covers the reveal exactly.
      if (
        rampBefore &&
        rampBefore.length > 0 &&
        Math.abs(spanDelta) > 1e-9 &&
        isHeadTrim &&
        headMoved
      ) {
        const kfs = rampBefore
        if (clip.reverse) {
          if (spanDelta > 1e-9) {
            assignTimeScale(clip, truncateCurveAtCut(kfs, durationBefore - spanDelta))
          }
        } else if (spanDelta > 1e-9) {
          // The anchor advances by the source THIS frame's cut consumed:
          // inPointBefore + integral(ramp, spanDelta). The caller's inPoint
          // cannot be the base: ClipView derives it from the gesture's frozen
          // origin on every pointermove, so after the first frame it already
          // contains every prior delta, and re-adding them drifted the kept
          // span by the previous frame's (integral - spanDelta), i.e. by how
          // many moves the drag happened to produce. The live anchor plus
          // each move's consumed span composes back to the one-shot result.
          const consumed = sourceConsumption(kfs, spanDelta, clip.speed ?? 1)
          // Unbounded material (an image, a text clip, or a clip whose asset
          // is gone) has no source window: the guard above pins its inPoint at
          // 0 and the rebased anchor must not touch it.
          if (bounded) clip.inPoint = inPointBefore + consumed
          assignTimeScale(clip, rebaseCurveFromCut(kfs, spanDelta))
        } else {
          // Extension: the head revealed `h` timeline seconds of source that
          // plays at the curve's OLD head rate. Shifting every keyframe right
          // by `h` keeps each segment's span exact (no easing re-scaling), the
          // old head rate constant-extends across the reveal (no explicit pin
          // is needed, see below), and the anchor keeps the frame the old head
          // showed minus that rate's consumption of the head: the caller's raw
          // delta is timeline, not source, seconds.
          const h = -spanDelta
          const headRate = kfs[0].value
          // The reveal plays at the OLD head rate, so the rebased anchor can
          // undershoot source 0 when that rate is faster than the static rate
          // the gesture's room assumed (a 2x head extended 1s from inPoint 1
          // lands at -1). The command is the exact check: reject instead of
          // writing a negative source window, and the transient dispatch leaves
          // the head at its last legal position. Unbounded material has no
          // source window: its inPoint is pinned at 0 by the guard above, so
          // the rebase must not touch it and no anchor can be a source error.
          if (bounded) {
            const rebasedInPoint = inPointBefore - headRate * h
            if (rebasedInPoint < 0) {
              throw new EditorCommandError('Trim exceeds the start of the source')
            }
            clip.inPoint = rebasedInPoint
          }
          const kept = kfs.map((k) => ({ ...k, time: k.time + h }))
          // No explicit pin at local 0: every reader constant-extends the curve
          // BEFORE its first keyframe, so the shifted curve already plays the
          // old head rate across the reveal. Unshifting a duplicate point there
          // changed no rendered value but added a keyframe per pointermove, so
          // one drag grew the curve without bound and every `sourceTimeAt`
          // call scanned more segments.
          assignTimeScale(clip, kept)
        }
      }
      // A REVERSED TAIL move is the mirror of that. Its curve origin is the LOW
      // source end (offset 0 is what the clip's tail reads), so the offsets the
      // tail gave up fall off the bottom of the curve and everything above them
      // shifts down onto the new origin. Dropping them and pinning the rate at
      // the cut as a keyframe at 0 (with the crossing segment's subdivided
      // shape) is the same boundary pattern, mirrored, exact for eased too.
      if (tailMirror && rampBefore && rampBefore.length > 0 && Math.abs(spanDelta) > 1e-9) {
        assignTimeScale(clip, rebaseCurveFromCut(rampBefore, spanDelta))
      }
      // The rebase rules above can RAISE the anchor (a head cut lands on a
      // faster part of the curve than local 0 read), so a window the guard
      // validated against the PRE-TRIM state can still over-consume once the
      // rebase is done, and a head move cannot heal a window that already
      // over-consumed (a relink leaves windows untouched): the rebase pins
      // local 0 by continuity, so no head position fixes the read end.
      // Recovery, in priority order: hold the rebased anchor (the dragged
      // edge keeps the frame the cut landed on) and shrink the span to fit;
      // when even the minimum span cannot fit from that anchor, the cut fell
      // inside the frozen region, so slide the whole window onto the asset's
      // readable tail instead (the content shifts by the over-consumed
      // amount). The guard's clamp cannot do any of this: it ran before the
      // rebase, on the old anchor and the old curve.
      if (bounded && rampBefore && rampBefore.length > 0 && clip.keyframes?.timeScale) {
        const curve = clip.keyframes.timeScale
        const consumed = (d: number) => sourceConsumption(curve, d, clip.speed ?? 1)
        if (clip.inPoint + consumed(clip.duration) > asset.duration + 1e-6) {
          const anchorHostsMinSpan =
            clip.inPoint <= asset.duration + 1e-6 &&
            clip.inPoint + consumed(MIN_CLIP_DURATION) <= asset.duration + 1e-6
          if (anchorHostsMinSpan) {
            clip.duration = largestFittingDuration(
              clip.inPoint,
              consumed,
              asset.duration,
              clip.duration,
            )
          } else {
            // The anchor is unreadable (or cannot host the minimum span):
            // end the window at the asset's last readable instant.
            if (consumed(clip.duration) > asset.duration + 1e-6) {
              if (consumed(MIN_CLIP_DURATION) > asset.duration + 1e-6) {
                throw new EditorCommandError('Trim exceeds the end of the source')
              }
              clip.duration = largestFittingDuration(0, consumed, asset.duration, clip.duration)
            }
            clip.inPoint = asset.duration - consumed(clip.duration)
          }
          // A head drag anchored its right edge at start + command.duration
          // (the same rule the guard's clamp applies); a tail move keeps its
          // start and gives up span at the dragged edge instead.
          if (command.edge === 'head' && command.start > startBefore) {
            clip.start = Math.max(0, command.start + command.duration - clip.duration)
          }
        }
      }
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
      const ramp = clip.keyframes?.timeScale
      const isMedia = !!asset && asset.kind !== 'image'
      // Source-span mapping. A forward clip keeps the left half's inPoint and
      // advances the right half by the left duration. A reversed clip reads its
      // span backwards, so the left half owns the span's tail: the right half
      // keeps the original inPoint and the left half moves up by the right
      // duration. Either way both halves keep reading the same source frames.
      //
      // A timeScale ramp replaces each offset with its curve integral, which is
      // what makes a cut inside a ramp land on the same source frame: the
      // carried-over keyframe map re-integrates from the half's own inPoint.
      // For the reversed case the left half owns the span's tail, so it moves
      // up by the RIGHT half's source consumption (exact at the cut for any
      // curve, and the same value the constant-rate rule produces).
      const consumed = (offset: number) => sourceConsumption(ramp, offset, speed)
      const splitInPoint = (offset: number) => clip.inPoint + consumed(offset)
      const leftInPoint = isMedia && clip.reverse ? splitInPoint(rightDuration) : clip.inPoint
      const [leftKeyframes, rightKeyframes] = splitKeyframeMap(clip.keyframes, leftDuration, {
        reverse: !!clip.reverse,
        duration: clip.duration,
      })
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
      const { clip, sequenceId } = requireClip(doc, command.clipId)
      const groupId = clip.linkId
      if (!groupId) throw new EditorCommandError('Clip is not linked')
      // Sequence-local: a link group lives in ONE sequence, so the walk is
      // scoped to the clip's owner.
      for (const track of sequenceTracks(doc, sequenceId)) {
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
      const found = command.clipIds.map((id) => requireClip(doc, id))
      const clips = found.map((f) => f.clip)
      if (clips.some((c) => c.text !== undefined)) {
        throw new EditorCommandError('Text clips cannot be linked')
      }
      // Sequence-local: independent local time origins mean a cross-sequence
      // link could never be moved safely as a unit, so it is refused.
      const owners = new Set(found.map((f) => f.sequenceId))
      if (owners.size > 1) {
        throw new EditorCommandError('Cannot link clips across sequences')
      }
      const sequenceId = found[0].sequenceId
      const mergedGroupId = clips.find((c) => c.linkId)?.linkId ?? `link_${cryptoRandom()}`
      const oldGroupIds = new Set(clips.map((c) => c.linkId).filter((x): x is string => !!x))
      for (const track of sequenceTracks(doc, sequenceId)) {
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
      // A write that reorders the same keyframes (a dot dragged or nudged past
      // a neighbour) must keep each authored curve on the pair it belongs to;
      // a structural write passes through untouched (see the helper).
      const keyframes = sanitizeKeyframes(
        command.property,
        rehomeSegmentShapes(clip.keyframes?.[command.property] ?? [], command.keyframes),
      )
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

    case 'setKeyframeDefault': {
      if (!isAnimatableProperty(command.property)) {
        throw new EditorCommandError(`Unknown animatable property: ${command.property}`)
      }
      if (!isKeyframeInterpolation(command.interpolation)) {
        throw new EditorCommandError(`Unknown interpolation: ${String(command.interpolation)}`)
      }
      const p = doc.project
      if (command.interpolation === 'linear') {
        // Absent reads as linear, so a linear press DELETES the entry and an
        // emptied map disappears entirely (the keyframes convention).
        if (p.keyframeDefaults) {
          delete p.keyframeDefaults[command.property]
          if (Object.keys(p.keyframeDefaults).length === 0) p.keyframeDefaults = undefined
        }
      } else {
        p.keyframeDefaults = { ...p.keyframeDefaults, [command.property]: command.interpolation }
      }
      return
    }

    case 'setClipSpeed': {
      const { clip } = requireClip(doc, command.clipId)
      if (clip.sequenceId) throw new EditorCommandError('Compound clips cannot change speed')
      if (clip.text !== undefined) throw new EditorCommandError('Text clips cannot change speed')
      const speed = clamp(command.speed, SPEED_MIN, SPEED_MAX)
      const asset = findMedia(doc, clip.mediaId)
      if (asset && asset.kind !== 'image' && !hasTimeScaleCurve(clip)) {
        // Keep the timeline duration (and everything cut against it) stable;
        // the source span re-derives from the new rate, clamped so the clip
        // never needs source past the asset's end. With a `timeScale` ramp the
        // curve alone decides consumption (this rate is only the no-curve
        // fallback), so re-deriving from it would truncate the clip for nothing.
        const maxDuration = Math.max(MIN_CLIP_DURATION, (asset.duration - clip.inPoint) / speed)
        clip.duration = Math.min(clip.duration, maxDuration)
      }
      clip.speed = speed
      return
    }

    case 'setClipReverse': {
      const { clip } = requireClip(doc, command.clipId)
      if (clip.sequenceId) throw new EditorCommandError('Compound clips cannot reverse')
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

    case 'setClipDenoise': {
      const { clip } = requireClip(doc, command.clipId)
      // Same shape as the compressor: a switch that stores its own flag, so an
      // off clip stores `false` and the saved file carries `"denoise": false`
      // (hydration reads only `true`, so absent and false load alike).
      clip.denoise = command.enabled
      return
    }

    case 'setClipColorParams': {
      const { clip } = requireClip(doc, command.clipId)
      // Neutral values collapse to absent so a graded-then-reset clip (and the
      // file it saves) carries no grade at all.
      const temperature = clamp(command.temperature, TEMPERATURE_MIN, TEMPERATURE_MAX)
      const tint = clamp(command.tint, TINT_MIN, TINT_MAX)
      clip.temperature = temperature === 0 ? undefined : temperature
      clip.tint = tint === 0 ? undefined : tint
      return
    }

    case 'importProjectLut': {
      // The guard lives HERE, not in the Inspector: every path into the
      // library (the file picker today, a future drop or paste tomorrow) pays
      // the same check, and the refusal is a normal command error a caller can
      // surface. The budget is a total on the library, so the message names the
      // current and the projected size, never just "too big".
      const luts = doc.project.luts ?? (doc.project.luts = [])
      if (luts.some((l) => l.id === command.lut.id)) {
        throw new EditorCommandError(`LUT ${command.lut.id} already exists`)
      }
      const message = lutBudgetMessage(lutLibraryChars(luts), command.lut.data.length)
      if (message) throw new EditorCommandError(message)
      luts.push(structuredClone(command.lut))
      return
    }

    case 'setClipLut': {
      const { clip } = requireClip(doc, command.clipId)
      if (command.lutId === null) {
        clip.lutId = undefined
        return
      }
      // A reference to no entry would render as nothing while the clip still
      // reads as graded, so the command is the one place that can refuse it.
      if (!doc.project.luts?.some((l) => l.id === command.lutId)) {
        throw new EditorCommandError(`Unknown LUT ${command.lutId}`)
      }
      clip.lutId = command.lutId
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

    case 'saveTextPreset': {
      // The guard lives HERE, not in the Inspector: every path into the
      // library pays the same check, and the refusal is a normal command
      // error a caller can surface.
      const name = normalizePresetName(command.preset.name)
      if (!name) throw new EditorCommandError('Preset name cannot be empty')
      if (name.length > TEXT_PRESET_NAME_MAX) {
        throw new EditorCommandError(
          `Preset name is too long (max ${TEXT_PRESET_NAME_MAX} characters)`,
        )
      }
      const presets = doc.project.textPresets ?? (doc.project.textPresets = [])
      if (presets.some((p) => p.id === command.preset.id)) {
        throw new EditorCommandError(`Preset ${command.preset.id} already exists`)
      }
      // Built-in ids are reserved: a user entry reusing one would lose
      // every lookup to the built-in (the UI resolves built-ins first).
      if (createBuiltinTextPresets().some((p) => p.id === command.preset.id)) {
        throw new EditorCommandError(`Preset id ${command.preset.id} is reserved`)
      }
      if (presetNameTaken(doc, name)) {
        throw new EditorCommandError(`A preset named "${name}" already exists`)
      }
      // The style is normalized, not refused: it may come from a clip a
      // file loaded with finite-but-wild values, and the preset library
      // only ever holds appliable styles.
      presets.push(
        structuredClone({
          ...command.preset,
          name,
          style: sanitizePresetStyle(command.preset.style),
        }),
      )
      return
    }

    case 'renameTextPreset': {
      const name = normalizePresetName(command.name)
      if (!name) throw new EditorCommandError('Preset name cannot be empty')
      if (name.length > TEXT_PRESET_NAME_MAX) {
        throw new EditorCommandError(
          `Preset name is too long (max ${TEXT_PRESET_NAME_MAX} characters)`,
        )
      }
      // Built-in ids never reach the store (the UI only manages user
      // presets), so an unknown id here covers both missing and built-in.
      const preset = doc.project.textPresets?.find((p) => p.id === command.presetId)
      if (!preset) throw new EditorCommandError(`Unknown preset ${command.presetId}`)
      if (presetNameTaken(doc, name, preset.id)) {
        throw new EditorCommandError(`A preset named "${name}" already exists`)
      }
      preset.name = name
      return
    }

    case 'deleteTextPreset': {
      const presets = doc.project.textPresets ?? []
      const index = presets.findIndex((p) => p.id === command.presetId)
      if (index === -1) throw new EditorCommandError(`Unknown preset ${command.presetId}`)
      presets.splice(index, 1)
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
      // Pull the next clip left so the transition has a real overlap —
      // unless this re-dispatch changes nothing about the geometry. With
      // an existing transition and an unchanged duration (a type switch),
      // the clips stay where the user put them and only the type restamps.
      // Duration-only re-dispatches (slider drags) keep the clip's
      // existing type instead of resetting it to crossfade.
      const transitionType = command.transitionType ?? a.transitionOut?.type ?? 'crossfade'
      const direction = command.direction ?? a.transitionOut?.direction ?? 'left'
      if (
        direction !== 'left' &&
        direction !== 'right' &&
        direction !== 'up' &&
        direction !== 'down'
      ) {
        throw new EditorCommandError(`Unknown transition direction: ${String(direction)}`)
      }
      const edge = command.edge ?? a.transitionOut?.edge ?? 'hard'
      if (edge !== 'hard' && edge !== 'feathered') {
        throw new EditorCommandError(`Unknown wipe edge: ${String(edge)}`)
      }
      const rawFeather = command.feather ?? a.transitionOut?.feather ?? TRANSITION_FEATHER_DEFAULT
      if (!Number.isFinite(rawFeather)) {
        throw new EditorCommandError('Transition feather must be a finite number')
      }
      const feather = Math.min(0.5, Math.max(0, rawFeather))
      if (!a.transitionOut || command.duration !== a.transitionOut.duration) {
        b.start = a.start + a.duration - duration
        a.transitionOut = { type: transitionType, duration, direction, edge, feather }
      } else {
        a.transitionOut = {
          type: transitionType,
          duration: a.transitionOut.duration,
          direction,
          edge,
          feather,
        }
      }
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

/** Longest title preset name the save/rename commands accept. */
export const TEXT_PRESET_NAME_MAX = 60

/** Trims a preset name; emptiness is refused by the commands, not here. */
export function normalizePresetName(name: string): string {
  return name.trim()
}

/**
 * True when a user preset (other than `exceptId`) or a built-in already
 * carries `name`, so a user preset can never shadow a built-in name either.
 */
function presetNameTaken(doc: Doc, name: string, exceptId?: string): boolean {
  const lowered = name.toLowerCase()
  if (createBuiltinTextPresets().some((p) => p.name.toLowerCase() === lowered)) return true
  return (doc.project.textPresets ?? []).some(
    (p) => p.id !== exceptId && p.name.toLowerCase() === lowered,
  )
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
  if (clip.sequenceId) return 'Compound clip'
  if (clip.text !== undefined) return 'Text'
  const asset = findMedia(doc, clip.mediaId)
  return asset ? `“${asset.name}” (${asset.kind})` : 'Clip'
}

/**
 * Refuses placing a compound clip where it would close a reference cycle: the
 * destination lane's owner must not be reachable from the referenced sequence.
 * Shared by every insert/move path (addClip, moveClip) so paste and drag pay
 * the same guard the create-time command enforces. Depth is checked separately
 * after the mutation, because it depends on the placement.
 */
function assertCompoundCycle(doc: Doc, clip: Clip, owner: string | undefined): void {
  if (!clip.sequenceId) return
  if (!findSequence(doc, clip.sequenceId)) {
    throw new EditorCommandError('Unknown sequence')
  }
  if (owner && sequenceReachable(doc, clip.sequenceId, owner)) {
    throw new EditorCommandError('This compound would create a cycle')
  }
}

/**
 * Writes a rebased `timeScale` curve onto the clip, seeding the keyframe map
 * when the clip has none.
 */
function assignTimeScale(clip: Clip, keyframes: Keyframe[]): void {
  if (clip.keyframes) clip.keyframes.timeScale = keyframes
  else clip.keyframes = { timeScale: keyframes }
}

/**
 * Clamps a clip's duration against its source media (video/audio only), honoring
 * speed. A `timeScale` ramp decides source consumption on its own and may
 * legally over-consume (the renderer clamps, the command does not), so the
 * constant-rate rule applies only to an unramped clip; this is the same
 * condition `setClipSpeed` uses, so adding a clip and re-rating it agree.
 */
function clampClipToMedia(doc: Doc, clip: Clip): void {
  const asset = findMedia(doc, clip.mediaId)
  if (!asset || asset.kind === 'image') return
  if (clip.inPoint < 0) clip.inPoint = 0
  if (hasTimeScaleCurve(clip)) return
  const speed = clip.speed ?? 1
  const maxDuration = Math.max(MIN_CLIP_DURATION, (asset.duration - clip.inPoint) / speed)
  clip.duration = Math.min(clip.duration, maxDuration)
}

/**
 * The name the next new track of `kind` would get (V2, A3, …) — shared by the
 * command itself and the drop indicator's "+ V2" preview label.
 */
export function previewTrackName(doc: Doc, kind: TrackKind, sequenceId?: string): string {
  const count = sequenceTracks(doc, sequenceId).filter((t) => t.kind === kind).length
  const prefix = kind === 'video' ? 'V' : kind === 'audio' ? 'A' : 'T'
  return `${prefix}${count + 1}`
}

function newTrackForKind(doc: Doc, kind: TrackKind, sequenceId?: string) {
  return {
    id: `track_${cryptoRandom()}`,
    kind,
    name: previewTrackName(doc, kind, sequenceId),
    clips: [],
  }
}

/**
 * Re-orders a sequence's tracks to the editor convention: text tracks on top,
 * then video, then audio. Stable (preserves relative order inside each group).
 */
function reorderTracksConvention(tracks: Track[]): void {
  const rank: Record<TrackKind, number> = { text: 0, video: 1, audio: 2 }
  tracks.sort((a, b) => rank[a.kind] - rank[b.kind])
}

/**
 * Inserts a new track at the HEAD of its kind's group — Premiere/Photoshop
 * layering semantics: the newest video track (V2) stacks ABOVE V1 and renders
 * on top, so fresh material lands on the higher layer by default. The
 * stable convention sort afterwards keeps this relative order.
 */
function insertTrack(tracks: Track[], track: Track): void {
  const firstOfKind = tracks.findIndex((t) => t.kind === track.kind)
  if (firstOfKind === -1) tracks.push(track)
  else tracks.splice(firstOfKind, 0, track)
}

function cryptoRandom(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** Convenience for UI code: total timeline length (re-exported for ergonomics). */
export { docDuration }
