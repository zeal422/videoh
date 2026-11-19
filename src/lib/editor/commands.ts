import {
  CHROMA_BLEND_MAX,
  CHROMA_BLEND_MIN,
  CHROMA_CLIP_MAX,
  CHROMA_CLIP_MIN,
  CHROMA_DESPILL_MAX,
  CHROMA_DESPILL_MIN,
  CHROMA_SIMILARITY_MAX,
  CHROMA_SIMILARITY_MIN,
  BRAND_COLORS_MAX,
  BRAND_FONT_FAMILIES_MAX,
  GAIN_MAX,
  GAIN_MIN,
  KEYFRAME_PROPERTY_BOUNDS,
  MAX_SEQUENCE_DEPTH,
  MAX_TIMELINE_SECONDS,
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
  ROTATION_MAX,
  ROTATION_MIN,
  SPEED_MAX,
  SPEED_MIN,
  EQ_DB_MIN,
  EQ_DB_MAX,
  TEMPERATURE_MAX,
  TEMPERATURE_MIN,
  TINT_MAX,
  TINT_MIN,
  TRACK_GROUPS_MAX,
  TRANSITION_MAX,
  TRANSITION_MIN,
} from './constants'
import {
  clipFitsTrack,
  createCaptionStyle,
  createTextClip,
  docDuration,
  findClip,
  findMedia,
  findSequence,
  findTrack,
  findTrackIn,
  laneKindFits,
  maxSequenceDepth,
  nextClipOnTrack,
  sequenceReachable,
  sequenceTracks,
  uid,
  createBuiltinTextPresets,
  sanitizePresetStyle,
} from './factories'
import { compoundClipViolations, shapeClipViolations } from './clip-invariants'
import { resolveInsertIndex, type InsertBoundary } from './clip-gesture'
import { rehomeSegmentShapes } from './ease-segment'
import {
  clampEffectPropertyValue,
  createEffectEntry,
  EffectType,
  findEffect,
  isBlendMode,
  isEffectKeyframable,
  resolveMatteTrack,
  sanitizeEffectKeyframes,
  splitEffectKeyframes,
} from './effects'
import { linkedClips } from './links'
import { lutBudgetMessage, lutLibraryChars } from './lut'
import { planCloseGaps, planJoinGroup } from './timeline-edit-plan'
import { sharesSourceWindow } from './slip'
import { clipGroupTracks, findLockedTrack, trackLockMessage } from './tracks'
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
import { parseKeyColor } from './chroma-key'
import { isValidContentHash, isValidWaveformPeaks, sanitizeThumbnail } from './project-validation'
import { MAX_SRT_TIME_SECONDS } from './srt'
import { maxTransitionDuration, TRANSITION_FEATHER_DEFAULT } from './transition'
import {
  fontFaceFamily,
  fontFamilyTokens,
  primaryFontFamily,
  sanitizeFontFamily,
  sanitizeFontName,
  sanitizeProjectFont,
} from './fonts'
import { sanitizeShape } from './shapes'
import { sanitizeBrandColor, sanitizeBrandColorName } from './brand-kit'
import {
  groupFlagParticipants,
  isValidTrackGroupId,
  normalizeProjectTrackGroups,
  sanitizeTrackGroupName,
  trackGroupById,
  trackGroupMembership,
  tracksShareSequence,
  TRACK_GROUP_FLAGS,
  type TrackGroupFlag,
} from './track-groups'
import { mintTemplateSequence, parseTemplate, validateTemplateForDoc } from './templates'
import type { ProjectTemplate } from './templates'
import {
  buildTextAnimation,
  textAnimationPropertyLabel,
  type TextAnimationProperty,
} from './text-animations'
import {
  largestFittingDuration,
  rebaseCurveFromCut,
  sourceConsumption,
  truncateCurveAtCut,
} from './trim'
import type {
  AnimStaticProperty,
  BlendMode,
  BrandColor,
  Clip,
  Doc,
  EffectEntry,
  Keyframe,
  KeyframeInterpolation,
  KeyframeMap,
  KeyframeProperty,
  Marker,
  MarkerPatch,
  MediaAsset,
  MediaKind,
  Project,
  ProjectFont,
  ProjectLut,
  Sequence,
  ShapeStyle,
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

/** Refusal for a visibility command aimed at an audio lane. */
export const AUDIO_VISIBILITY_REFUSAL = 'Visibility applies to video and text tracks only'

/**
 * Options threaded from the browser-side wiring into the pure command core.
 *
 * `validateRelinkFile` is the only platform-aware check a command needs. The
 * core never names `File` or `Blob` (AGENTS rule 2), so a direct dispatch that
 * does not inject a validator fails closed on a non-undefined file handle.
 */
export interface ApplyCommandOptions {
  validateRelinkFile?: (value: unknown) => boolean
}

/**
 * A command refused because it would edit a locked track (0.14.0). Carries the
 * track id so the store can surface one notice without parsing the message.
 */
export class TrackLockedError extends EditorCommandError {
  readonly trackId: string
  constructor(track: Pick<Track, 'id' | 'name'>) {
    super(trackLockMessage(track))
    this.name = 'TrackLockedError'
    this.trackId = track.id
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

const MEDIA_KINDS: readonly MediaKind[] = ['video', 'audio', 'image']
const TRANSITION_TYPES: readonly Transition['type'][] = [
  'crossfade',
  'dipToBlack',
  'wipe',
  'slide',
  'push',
]

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
  | { type: 'setTrackSolo'; trackId: string; solo: boolean }
  | { type: 'setTrackLocked'; trackId: string; locked: boolean }
  // track groups (0.26.0): one batch command owns each group action
  | { type: 'createTrackGroup'; name: string; trackIds: string[]; groupId?: string }
  | { type: 'renameTrackGroup'; groupId: string; name: string }
  | { type: 'addTrackToGroup'; groupId: string; trackId: string }
  | { type: 'removeTrackFromGroup'; trackId: string }
  | { type: 'removeTrackGroup'; groupId: string }
  | { type: 'setTrackGroupFlag'; groupId: string; flag: TrackGroupFlag; value: boolean }
  // local templates (0.26.0): one command installs a fresh sequence
  | {
      type: 'applyTemplate'
      template: ProjectTemplate
      start: number
      /** Owning sequence of the destination lane; undefined = the project root. */
      sequenceId?: string
      /** Existing destination video lane. Absent creates one when none exists. */
      trackId?: string
    }
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
  // timeline commands (0.22.0): close a track's gaps, join two same-source clips
  | { type: 'closeGaps'; trackId: string }
  | { type: 'joinClips'; clipId: string; nextId: string }
  | { type: 'deleteClip'; clipId: string }
  | { type: 'unlinkClip'; clipId: string }
  | { type: 'linkClips'; clipIds: string[] }
  | { type: 'setClipGain'; clipId: string; gain: number }
  | { type: 'setClipMuted'; clipId: string; muted: boolean }
  | { type: 'setClipOpacity'; clipId: string; opacity: number }
  // transform (0.24.0): static rotation and the explicit flip pair
  | { type: 'setClipRotation'; clipId: string; rotation: number }
  | { type: 'setClipFlip'; clipId: string; flipX: boolean; flipY: boolean }
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
  | { type: 'setClipInPoint'; clipId: string; inPoint: number }
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
  // project font library (0.25.0)
  | { type: 'addProjectFont'; font: ProjectFont }
  | { type: 'removeProjectFont'; fontId: string }
  | { type: 'renameProjectFont'; fontId: string; name: string }
  // brand kit (0.26.0)
  | { type: 'addBrandColor'; color: BrandColor }
  | { type: 'renameBrandColor'; colorId: string; name: string }
  | { type: 'removeBrandColor'; colorId: string }
  | { type: 'addBrandFont'; family: string }
  | { type: 'removeBrandFont'; family: string }
  // shape clips (0.25.0)
  | { type: 'setClipShape'; clipId: string; shape: ShapeStyle }
  // animated text presets (0.25.0)
  | { type: 'applyTextAnimation'; clipId: string; presetId: string }
  // captions (0.8.5)
  | { type: 'importCaptions'; cues: { start: number; duration: number; text: string }[] }
  | { type: 'addCaptionCue'; trackId: string; start: number; text?: string }
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
  // effects (0.8.6)
  | {
      type: 'addEffect'
      clipId: string
      effectType: EffectType
      effectId?: string
      trackId?: string
    }
  | { type: 'removeEffect'; clipId: string; effectId: string }
  | { type: 'setEffectEnabled'; clipId: string; effectId: string; enabled: boolean }
  | { type: 'resetEffect'; clipId: string; effectId: string }
  | {
      type: 'setEffectParams'
      clipId: string
      effectId: string
      params: Record<string, unknown>
    }
  | {
      type: 'setEffectKeyframes'
      clipId: string
      effectId: string
      property: string
      keyframes: Keyframe[]
    }
  | { type: 'setClipBlendMode'; clipId: string; blendMode: BlendMode | null }
  | { type: 'setTrackVisible'; trackId: string; visible: boolean }
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
export function applyCommand(doc: Doc, command: EditorCommand, options?: ApplyCommandOptions): Doc {
  assertCommandAllowed(doc, command)
  const next = structuredClone(doc) as Doc
  mutateDoc(next, command, options)
  return next
}

/** Applies a sequence of commands as one unit (single clone). */
export function applyCommands(
  doc: Doc,
  commands: EditorCommand[],
  options?: ApplyCommandOptions,
): Doc {
  const next = structuredClone(doc) as Doc
  for (const command of commands) {
    // Validate against the state this command will ACTUALLY see. A batch can
    // lock a lane, move a clip, or create a track before a later command, so
    // the pre-batch doc is not enough: [setTrackLocked, addClip] would
    // otherwise pass both guards and leave the clip on a locked lane. The
    // clone is discarded when any command throws, so the caller still sees no
    // partial write and no history entry.
    assertCommandAllowed(next, command)
    mutateDoc(next, command, options)
  }
  return next
}

/**
 * The one lock inventory (0.14.0). `Record<EditorCommand['type'], …>` makes
 * the TypeScript build fail when a command is added without a decision, so a
 * new command can never inherit "allowed" by omission. Resolvers return every
 * track the command would edit (link partners included); the guard refuses the
 * command when any of them is locked.
 */
type CommandOf<K extends EditorCommand['type']> = Extract<EditorCommand, { type: K }>

type LockRule<K extends EditorCommand['type']> =
  | { readonly exempt: true }
  | {
      readonly exempt?: false
      readonly tracks: (doc: Doc, command: CommandOf<K>) => readonly Track[]
    }

type LockRuleMap = { readonly [K in EditorCommand['type']]: LockRule<K> }

function trackRef(doc: Doc, trackId: string): Track[] {
  const found = findTrackIn(doc, trackId)
  return found ? [found.track] : []
}

function clipRef(doc: Doc, clipId: string): Track[] {
  const found = findClip(doc, clipId)
  return found ? [found.track] : []
}

/** Every track holding a clip backed by `mediaId`, across root and sequences. */
function mediaClipTracks(doc: Doc, mediaId: string): Track[] {
  const out: Track[] = []
  const seen = new Set<string>()
  const scan = (tracks: readonly Track[]) => {
    for (const track of tracks) {
      if (seen.has(track.id)) continue
      if (track.clips.some((clip) => clip.mediaId === mediaId)) {
        seen.add(track.id)
        out.push(track)
      }
    }
  }
  scan(doc.project.tracks)
  for (const sequence of doc.project.sequences ?? []) scan(sequence.tracks)
  return out
}

/**
 * Removing a lane edits the lane itself, its clips' link partners (the group
 * would lose a member), and every clip that references it through a
 * `trackMatte` effect: `removeTrack` strips those entries in the same command.
 * A locked lane in any of those roles refuses the whole removal.
 */
function removeTrackTracks(doc: Doc, trackId: string): Track[] {
  const found = findTrackIn(doc, trackId)
  if (!found) return []
  const out: Track[] = []
  const seen = new Set<string>()
  const add = (track: Track | undefined) => {
    if (!track || seen.has(track.id)) return
    seen.add(track.id)
    out.push(track)
  }
  add(found.track)
  for (const track of clipGroupTracks(
    doc,
    found.track.clips.map((clip) => clip.id),
  )) {
    add(track)
  }
  for (const track of sequenceTracks(doc, found.sequenceId)) {
    if (
      track.clips.some((clip) =>
        (clip.effects ?? []).some((e) => e.type === 'trackMatte' && e.trackId === trackId),
      )
    ) {
      add(track)
    }
  }
  return out
}

const LOCK_RULES: LockRuleMap = {
  // Media bin. Adding an asset touches no clip. Removing or relinking one
  // changes every clip that uses it, so any such clip's locked lane refuses.
  addMediaAsset: { exempt: true },
  removeMediaAsset: { tracks: (doc, command) => mediaClipTracks(doc, command.mediaId) },
  relinkMedia: { tracks: (doc, command) => mediaClipTracks(doc, command.mediaId) },

  // Sequences. A sequence definition holds no clips until a compound container
  // is created, which checks its sources and destination below.
  addSequence: { exempt: true },
  // A template installs a NEW sequence, but its container lands on a
  // destination lane: a locked lane refuses before the clone is written.
  applyTemplate: {
    tracks: (doc, command) => {
      if (command.trackId) return trackRef(doc, command.trackId)
      const destination = sequenceTracks(doc, command.sequenceId).find(
        (track) => track.kind === 'video',
      )
      return destination ? [destination] : []
    },
  },
  createCompoundClip: {
    tracks: (doc, command) => [
      ...clipGroupTracks(doc, command.clipIds),
      ...trackRef(doc, command.trackId),
    ],
  },

  // Track controls. Rename/visibility/mute/solo/lock and adding a lane are
  // metadata or controls, never clip edits (the user must be able to unlock).
  addTrack: { exempt: true },
  removeTrack: { tracks: (doc, command) => removeTrackTracks(doc, command.trackId) },
  renameTrack: { exempt: true },
  toggleTrackMute: { exempt: true },
  setTrackSolo: { exempt: true },
  setTrackLocked: { exempt: true },
  setTrackVisible: { exempt: true },
  // Track groups are metadata controls: creating, naming, moving membership,
  // and writing member flags never move or trim a clip, and the user must be
  // able to unlock a group. Clip edits made after a group action still pay the
  // normal per-track lock gate.
  createTrackGroup: { exempt: true },
  renameTrackGroup: { exempt: true },
  addTrackToGroup: { exempt: true },
  removeTrackFromGroup: { exempt: true },
  removeTrackGroup: { exempt: true },
  setTrackGroupFlag: { exempt: true },

  // Clip geometry. Move/trim/split/delete/unlink act on a whole link group, and
  // move also touches its destination lane. Paste/drop/insert/overwrite arrive
  // as addClip, so the destination lane is the one checked.
  addClip: { tracks: (doc, command) => trackRef(doc, command.trackId) },
  moveClip: {
    tracks: (doc, command) => [
      ...clipGroupTracks(doc, [command.clipId]),
      ...trackRef(doc, command.trackId),
    ],
  },
  // Trim edits only the named clip's lane. Move/delete/split/unlink carry the
  // whole link group; trim does not, so a locked partner does not block it.
  trimClip: { tracks: (doc, command) => clipRef(doc, command.clipId) },
  splitClip: { tracks: (doc, command) => clipGroupTracks(doc, [command.clipId]) },
  // Close Gaps moves every clip on the target lane (and each one's link
  // partners), so the lane plus every partner lane refuses as a unit. Join
  // Clips removes the next clip of each pair, so both groups' lanes are checked
  // before any pair is merged.
  closeGaps: {
    tracks: (doc, command) => {
      const found = findTrackIn(doc, command.trackId)
      if (!found) return []
      return clipGroupTracks(
        doc,
        found.track.clips.map((clip) => clip.id),
      )
    },
  },
  joinClips: {
    tracks: (doc, command) => clipGroupTracks(doc, [command.clipId, command.nextId]),
  },
  deleteClip: { tracks: (doc, command) => clipGroupTracks(doc, [command.clipId]) },
  unlinkClip: { tracks: (doc, command) => clipGroupTracks(doc, [command.clipId]) },
  linkClips: { tracks: (doc, command) => clipGroupTracks(doc, command.clipIds) },

  // Clip properties: all are edits of the named clip's own lane. The UI routes
  // audio properties for an A/V pair to the audio twin, so the carrier's lock
  // is the one that refuses.
  setClipGain: { tracks: (doc, command) => clipRef(doc, command.clipId) },
  setClipMuted: { tracks: (doc, command) => clipRef(doc, command.clipId) },
  setClipOpacity: { tracks: (doc, command) => clipRef(doc, command.clipId) },
  setClipRotation: { tracks: (doc, command) => clipRef(doc, command.clipId) },
  setClipFlip: { tracks: (doc, command) => clipRef(doc, command.clipId) },
  setClipKeyframes: { tracks: (doc, command) => clipRef(doc, command.clipId) },
  setClipSpeed: { tracks: (doc, command) => clipRef(doc, command.clipId) },
  // Slip writes the whole linked group that shares the source window, so every
  // member's lane refuses, not only the clicked half.
  setClipInPoint: { tracks: (doc, command) => clipGroupTracks(doc, [command.clipId]) },
  setClipReverse: { tracks: (doc, command) => clipRef(doc, command.clipId) },
  setClipPan: { tracks: (doc, command) => clipRef(doc, command.clipId) },
  setClipEq: { tracks: (doc, command) => clipRef(doc, command.clipId) },
  setClipCompressor: { tracks: (doc, command) => clipRef(doc, command.clipId) },
  setClipDenoise: { tracks: (doc, command) => clipRef(doc, command.clipId) },
  setClipColorParams: { tracks: (doc, command) => clipRef(doc, command.clipId) },
  setClipAnimStatic: { tracks: (doc, command) => clipRef(doc, command.clipId) },
  setClipBlendMode: { tracks: (doc, command) => clipRef(doc, command.clipId) },
  setClipLut: { tracks: (doc, command) => clipRef(doc, command.clipId) },

  // Project preferences and libraries: no clip is edited.
  setKeyframeDefault: { exempt: true },
  importProjectLut: { exempt: true },
  saveTextPreset: { exempt: true },
  renameTextPreset: { exempt: true },
  deleteTextPreset: { exempt: true },
  // The font library is project metadata; no clip lane is edited. The remove
  // command refuses while any text clip or saved preset still references it.
  addProjectFont: { exempt: true },
  removeProjectFont: { exempt: true },
  renameProjectFont: { exempt: true },
  // The brand kit is project metadata; no clip lane is edited.
  addBrandColor: { exempt: true },
  renameBrandColor: { exempt: true },
  removeBrandColor: { exempt: true },
  addBrandFont: { exempt: true },
  removeBrandFont: { exempt: true },

  // Text and captions. Property edits hit the clip's lane; a new cue hits the
  // text lane it names. `importCaptions` always creates a NEW text track, so it
  // cannot touch a locked one and needs no refusal.
  setTextContent: { tracks: (doc, command) => clipRef(doc, command.clipId) },
  setTextStyle: { tracks: (doc, command) => clipRef(doc, command.clipId) },
  // Shape clips and animated text presets edit the clip's lane.
  setClipShape: { tracks: (doc, command) => clipRef(doc, command.clipId) },
  applyTextAnimation: { tracks: (doc, command) => clipRef(doc, command.clipId) },
  importCaptions: { exempt: true },
  addCaptionCue: { tracks: (doc, command) => trackRef(doc, command.trackId) },

  // Transitions and effects: clip edits on the named clip's lane.
  addTransition: { tracks: (doc, command) => clipRef(doc, command.clipId) },
  removeTransition: { tracks: (doc, command) => clipRef(doc, command.clipId) },
  addEffect: { tracks: (doc, command) => clipRef(doc, command.clipId) },
  removeEffect: { tracks: (doc, command) => clipRef(doc, command.clipId) },
  setEffectEnabled: { tracks: (doc, command) => clipRef(doc, command.clipId) },
  resetEffect: { tracks: (doc, command) => clipRef(doc, command.clipId) },
  setEffectParams: { tracks: (doc, command) => clipRef(doc, command.clipId) },
  setEffectKeyframes: { tracks: (doc, command) => clipRef(doc, command.clipId) },

  // Markers: sequence markers are not clip edits; clip markers are.
  addSequenceMarker: { exempt: true },
  moveSequenceMarker: { exempt: true },
  updateSequenceMarker: { exempt: true },
  deleteSequenceMarker: { exempt: true },
  addClipMarker: { tracks: (doc, command) => clipRef(doc, command.clipId) },
  moveClipMarker: { tracks: (doc, command) => clipRef(doc, command.clipId) },
  updateClipMarker: { tracks: (doc, command) => clipRef(doc, command.clipId) },
  deleteClipMarker: { tracks: (doc, command) => clipRef(doc, command.clipId) },

  // Project settings are not an edit to a track.
  setProjectSettings: { exempt: true },
}

/**
 * Refuses a command that would edit a locked track. The single lock gate for
 * committed and transient writes (`applyCommand` / `applyCommands`), so a UI
 * bypass cannot edit a locked track. The cast is the runtime side of the
 * per-key mapped type above: the map key and the command discriminant are the
 * same value, so the entry's resolver accepts this command by construction.
 */
export function assertCommandAllowed(doc: Doc, command: EditorCommand): void {
  const rule = LOCK_RULES[command.type] as LockRule<EditorCommand['type']>
  if (rule.exempt) return
  const resolve = rule.tracks as (doc: Doc, command: EditorCommand) => readonly Track[]
  const locked = findLockedTrack(resolve(doc, command))
  if (locked) throw new TrackLockedError(locked)
}

/**
 * The media details a relink may write. Identity (`id`, `kind`, `name`) is
 * immutable through a relink, and `missing` is the command's own write.
 */
const RELINK_PATCH_KEYS = [
  'url',
  'contentHash',
  'duration',
  'width',
  'height',
  'file',
  'thumbnail',
  'hasAudio',
  'waveformPeaks',
] as const
type RelinkPatchKey = (typeof RELINK_PATCH_KEYS)[number]
const RELINK_PATCH_KEY_SET = new Set<string>(RELINK_PATCH_KEYS)
/** Fields the asset cannot lose: omitting keeps the old value, `undefined` throws. */
const RELINK_REQUIRED_KEYS = new Set<RelinkPatchKey>(['url', 'duration', 'width', 'height'])

function invalidRelinkFile(): EditorCommandError {
  return new EditorCommandError('Invalid relink file')
}

/** Drops a brand kit once it holds neither colors nor font references. */
function pruneEmptyBrandKit(project: Project): void {
  const kit = project.brandKit
  if (!kit) return
  if (kit.colors.length === 0 && (kit.fontFamilies?.length ?? 0) === 0) delete project.brandKit
}

/** Refuses an edit whose clip end the timeline cap cannot represent. */
function assertClipEndWithinTimeline(start: number, duration: number): void {
  const end = start + duration
  // The rest of the command layer compares against source bounds with the
  // same epsilon; an end a rounding step over the cap is still the cap.
  if (!Number.isFinite(end) || end > MAX_TIMELINE_SECONDS + 1e-6) {
    throw new EditorCommandError(
      `Clip end must be within the ${MAX_TIMELINE_SECONDS / 3600}-hour timeline limit`,
    )
  }
}

/**
 * Build the patch a relink is allowed to write. The caller's object is never
 * assigned directly: symbol keys, accessors, identity fields, and `missing`
 * are rejected, the values are validated, and `waveformPeaks` is copied so a
 * later mutation of the payload cannot change document state.
 */
export function sanitizeRelinkPatch(
  asset: MediaAsset,
  patch: unknown,
  options?: ApplyCommandOptions,
): Partial<MediaAsset> {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new EditorCommandError('Invalid relink patch')
  }
  const proto = Object.getPrototypeOf(patch)
  if (proto !== Object.prototype && proto !== null) {
    throw new EditorCommandError('Invalid relink patch')
  }
  const source = patch as Record<PropertyKey, unknown>
  const sanitized: Partial<MediaAsset> = {}
  for (const key of Reflect.ownKeys(source)) {
    if (typeof key !== 'string' || !RELINK_PATCH_KEY_SET.has(key)) {
      throw new EditorCommandError('Invalid relink patch')
    }
    const descriptor = Object.getOwnPropertyDescriptor(source, key)
    if (!descriptor || !('value' in descriptor)) {
      throw new EditorCommandError('Invalid relink patch')
    }
    const value = descriptor.value
    const field = key as RelinkPatchKey
    if (value === undefined) {
      if (RELINK_REQUIRED_KEYS.has(field)) {
        throw new EditorCommandError('Invalid relink patch')
      }
      // `undefined` is the one CLEAR signal for the optional media details.
      // `null` is rejected everywhere.
      ;(sanitized as Record<string, unknown>)[field] = undefined
      continue
    }
    switch (field) {
      case 'url': {
        if (typeof value !== 'string' || value.trim().length === 0) {
          throw new EditorCommandError('Invalid relink patch')
        }
        sanitized.url = value
        break
      }
      case 'duration':
      case 'width':
      case 'height': {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
          throw new EditorCommandError('Invalid relink patch')
        }
        sanitized[field] = value
        break
      }
      case 'thumbnail': {
        const thumbnail = sanitizeThumbnail(value)
        if (thumbnail === undefined) throw new EditorCommandError('Invalid relink patch')
        sanitized.thumbnail = thumbnail
        break
      }
      case 'hasAudio': {
        if (typeof value !== 'boolean') throw new EditorCommandError('Invalid relink patch')
        sanitized.hasAudio = value
        break
      }
      case 'waveformPeaks': {
        if (!isValidWaveformPeaks(value)) throw new EditorCommandError('Invalid relink patch')
        sanitized.waveformPeaks = [...value]
        break
      }
      case 'contentHash': {
        // A relink may attach a stored revision or clear it for a session-only
        // file; anything else would persist a path the store cannot read.
        if (!isValidContentHash(value)) throw new EditorCommandError('Invalid relink patch')
        sanitized.contentHash = value
        break
      }
      case 'file': {
        if (value === null) throw invalidRelinkFile()
        const validate = options?.validateRelinkFile
        let accepted = false
        if (validate) {
          try {
            accepted = validate(value) === true
          } catch {
            throw invalidRelinkFile()
          }
        }
        if (!accepted) throw invalidRelinkFile()
        // A browser handle, not document data: keep the reference.
        sanitized.file = value as MediaAsset['file']
        break
      }
    }
  }
  // A new source without a hash must not inherit the old revision through
  // `Object.assign`: every producer names the replacement hash (or explicit
  // undefined), and a patch that changes the source while omitting the key
  // clears it here instead of keeping bytes the store does not have.
  if (!('contentHash' in sanitized) && ('url' in source || 'file' in source)) {
    sanitized.contentHash = undefined
  }
  // A relink always clears `missing`, so the RESULT must be playable. An
  // offline asset hydrates with an empty URL; omitting url cannot rescue it.
  if (sanitized.url === undefined && !asset.url.trim()) {
    throw new EditorCommandError('Invalid relink patch')
  }
  return sanitized
}

function mutateDoc(doc: Doc, command: EditorCommand, options?: ApplyCommandOptions): void {
  switch (command.type) {
    case 'addMediaAsset': {
      const asset = requireRecord(command.asset, 'Media asset') as unknown as MediaAsset
      if (typeof asset.id !== 'string' || asset.id.trim().length === 0) {
        throw new EditorCommandError('Media asset id must be a non-empty string')
      }
      if (!MEDIA_KINDS.includes(asset.kind)) {
        throw new EditorCommandError(`Unknown media kind: ${String(asset.kind)}`)
      }
      if (typeof asset.name !== 'string') {
        throw new EditorCommandError('Media asset name must be a string')
      }
      if (typeof asset.url !== 'string') {
        throw new EditorCommandError('Media asset url must be a string')
      }
      for (const field of ['duration', 'width', 'height'] as const) {
        if (!Number.isFinite(asset[field]) || asset[field] < 0) {
          throw new EditorCommandError(`Media asset ${field} must be a finite non-negative number`)
        }
      }
      if (doc.media.some((m) => m.id === asset.id)) {
        throw new EditorCommandError(`Media asset ${asset.id} already exists`)
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
      Object.assign(asset, sanitizeRelinkPatch(asset, command.patch, options), { missing: false })
      return
    }

    case 'addSequence': {
      const sequences = doc.project.sequences ?? (doc.project.sequences = [])
      const sequence = structuredClone(command.sequence)
      if (sequence.id === doc.project.id) {
        throw new EditorCommandError('Sequence id collides with the project id')
      }
      // One shared set, matching `assertUniqueIds`: a track or clip id may not
      // repeat another id in the payload or equal the sequence id itself.
      const seen = new Set<string>()
      const claim = (id: string, label: string) => {
        if (id.trim().length === 0) throw new EditorCommandError(`${label} id cannot be empty`)
        if (seen.has(id)) throw new EditorCommandError(`Duplicate ${label} id in sequence: ${id}`)
        seen.add(id)
        assertStructuralIdFree(doc, id, label)
      }
      claim(sequence.id, 'Sequence')
      for (const track of sequence.tracks) {
        claim(track.id, 'Track')
        for (const clip of track.clips) {
          claim(clip.id, 'Clip')
          // The payload crosses the same boundary `addClip` guards: a shape or
          // compound clip carrying incompatible fields would make the installed
          // project fail to serialize and reload.
          assertShapeClipFields(clip)
          if (compoundClipViolations(clip)) {
            throw new EditorCommandError(
              'Compound clips cannot carry media, text or retiming fields',
            )
          }
          // A supplied sequence must survive the hydration lane pass. Use the
          // hydration predicate rather than `clipFitsTrack` so a dangling
          // media id and an empty text clip are still accepted (hydration keeps
          // them), while a real material/lane mismatch is refused here.
          if (!laneKindFits(doc, clip, track)) {
            throw new EditorCommandError(
              `${describeClip(doc, clip)} cannot be placed on a ${track.kind} track`,
            )
          }
        }
      }
      sequences.push(sequence)
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
      if (!Number.isFinite(duration) || duration < MIN_CLIP_DURATION) {
        throw new EditorCommandError('Selection is too short')
      }

      const selectedIds = new Set(members.map((f) => f.clip.id))
      const ownerTracks = sequenceTracks(doc, owner)
      // The new sequence mirrors the owner lanes that hold selected clips,
      // rebasing every clip to local 0.
      const freshTrackByOld = new Map<string, string>()
      for (const track of ownerTracks) {
        if (!track.clips.some((c) => selectedIds.has(c.id))) continue
        freshTrackByOld.set(track.id, uid('track'))
      }
      const seqTracks: Track[] = []
      for (const track of ownerTracks) {
        const clips = track.clips.filter((c) => selectedIds.has(c.id))
        if (clips.length === 0) continue
        const freshId = freshTrackByOld.get(track.id)
        if (!freshId) continue
        seqTracks.push({
          id: freshId,
          kind: track.kind,
          name: track.name,
          clips: clips.map((c) => {
            const copy = { ...structuredClone(c), start: c.start - minStart }
            // Matte refs follow their source into the compound; a ref pointing
            // outside the copied set would go cross-sequence (unresolvable),
            // so it drops here like moveClip's orphaned mattes.
            if (copy.effects) {
              const kept: EffectEntry[] = []
              for (const e of copy.effects) {
                if (e.type !== 'trackMatte') {
                  kept.push(e)
                  continue
                }
                const source = e.trackId ? freshTrackByOld.get(e.trackId) : undefined
                if (source) kept.push({ ...e, trackId: source })
              }
              copy.effects = kept.length > 0 ? kept : undefined
            }
            return copy
          }),
        })
      }
      const sequenceId = uid('seq')
      const sequences = doc.project.sequences ?? (doc.project.sequences = [])
      sequences.push({
        id: sequenceId,
        name: command.name?.trim() || 'Compound Clip',
        tracks: seqTracks,
      })
      // Add the container first so the depth walk SEES the new edge, then check.
      const compound: Clip = {
        id: uid('clip'),
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
      // The kind chooses the lane family every later placement, audibility and
      // renumber rule keys off. A command payload is a trust boundary, so an
      // unknown kind is refused instead of stored and compared as undefined.
      if (command.kind !== 'video' && command.kind !== 'audio' && command.kind !== 'text') {
        throw new EditorCommandError(`Unknown track kind: ${String(command.kind)}`)
      }
      if (command.trackId !== undefined) {
        assertStructuralIdFree(doc, command.trackId, 'Track')
      }
      const owner = command.sequenceId ? findSequence(doc, command.sequenceId) : undefined
      if (command.sequenceId && !owner) throw new EditorCommandError('Unknown sequence')
      const tracks = owner ? owner.tracks : doc.project.tracks
      const track = newTrackForKind(doc, command.kind, command.sequenceId)
      if (command.trackId !== undefined) track.id = command.trackId
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
      // Positional names follow the placement, including an explicit atIndex
      // insertion: the new lane takes its slot and the auto names renumber.
      renumberAutoTracks(tracks, command.kind)
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
      // Matte entries pointing at the removed track die with it, in the same
      // undo step. Only the owning sequence can hold such entries (same-
      // sequence rule), and anything stranger is still render-safe (the
      // renderer skips unresolvable mattes).
      for (const track of tracks) {
        for (const clip of track.clips) {
          if (!clip.effects) continue
          clip.effects = clip.effects.filter(
            (e) => e.type !== 'trackMatte' || e.trackId !== command.trackId,
          )
          if (clip.effects.length === 0) clip.effects = undefined
        }
      }
      // Dropping the lane can leave its group empty: remove the ghost in the
      // same undo step so its name is reusable and it stops counting toward
      // the group limit.
      normalizeProjectTrackGroups(doc.project)
      return
    }

    case 'renameTrack': {
      const track = requireTrack(doc, command.trackId)
      const name = requireString(command.name, 'Track name').trim()
      if (!name) return
      track.name = name
      // An explicit rename makes the name custom: it must survive later
      // positional renumbering, even when it happens to match `A2`.
      track.autoName = false
      return
    }

    case 'toggleTrackMute': {
      const track = requireTrack(doc, command.trackId)
      track.muted = !track.muted
      return
    }

    case 'setTrackSolo': {
      const track = requireTrack(doc, command.trackId)
      if (track.kind !== 'audio') {
        throw new EditorCommandError('Solo is only available on audio tracks')
      }
      if (typeof command.solo !== 'boolean') {
        throw new EditorCommandError('Track solo must be a boolean')
      }
      track.solo = command.solo
      return
    }

    case 'setTrackLocked': {
      const track = requireTrack(doc, command.trackId)
      if (typeof command.locked !== 'boolean') {
        throw new EditorCommandError('Track lock must be a boolean')
      }
      track.locked = command.locked
      return
    }

    case 'createTrackGroup': {
      if (!Array.isArray(command.trackIds) || command.trackIds.length === 0) {
        throw new EditorCommandError('Select at least one track to group')
      }
      const name = sanitizeTrackGroupName(command.name)
      if (!name) throw new EditorCommandError('Group name is invalid')
      const groups = doc.project.trackGroups ?? (doc.project.trackGroups = [])
      if (groups.length >= TRACK_GROUPS_MAX) {
        throw new EditorCommandError(`A project can have at most ${TRACK_GROUPS_MAX} track groups`)
      }
      if (groups.some((group) => group.name.toLowerCase() === name.toLowerCase())) {
        throw new EditorCommandError(`A group named "${name}" already exists`)
      }
      const groupId = command.groupId ?? uid('grp')
      if (!isValidTrackGroupId(groupId)) throw new EditorCommandError('Invalid group id')
      if (groups.some((group) => group.id === groupId)) {
        throw new EditorCommandError(`Group ${groupId} already exists`)
      }
      const ids = [...new Set(command.trackIds)]
      const tracks = ids.map((trackId) => {
        const found = findTrackIn(doc, trackId)
        if (!found) throw new EditorCommandError('Unknown track')
        return found.track
      })
      // A group's members live in one sequence: independent local time origins
      // make a cross-sequence group meaningless, and the UI scopes creation to
      // the open sequence.
      if (!tracksShareSequence(doc, tracks)) {
        throw new EditorCommandError('A group cannot span sequences')
      }
      for (const track of tracks) track.groupId = groupId
      groups.push({ id: groupId, name })
      // Rehoming members can leave a previous group empty: drop it in the same
      // undo step instead of leaving a nameless ghost in the library.
      normalizeProjectTrackGroups(doc.project)
      return
    }

    case 'renameTrackGroup': {
      const group = trackGroupById(doc.project, command.groupId)
      if (!group) throw new EditorCommandError(`Unknown group ${command.groupId}`)
      const name = sanitizeTrackGroupName(command.name)
      if (!name) throw new EditorCommandError('Group name is invalid')
      if (
        (doc.project.trackGroups ?? []).some(
          (entry) => entry.id !== group.id && entry.name.toLowerCase() === name.toLowerCase(),
        )
      ) {
        throw new EditorCommandError(`A group named "${name}" already exists`)
      }
      group.name = name
      return
    }

    case 'addTrackToGroup': {
      const membership = trackGroupMembership(doc, command.groupId)
      if (!membership) throw new EditorCommandError(`Unknown group ${command.groupId}`)
      const found = findTrackIn(doc, command.trackId)
      if (!found) throw new EditorCommandError('Unknown track')
      if (found.sequenceId !== membership.sequenceId) {
        throw new EditorCommandError('A group cannot span sequences')
      }
      found.track.groupId = command.groupId
      normalizeProjectTrackGroups(doc.project)
      return
    }

    case 'removeTrackFromGroup': {
      const found = findTrackIn(doc, command.trackId)
      if (!found) throw new EditorCommandError('Unknown track')
      if (!found.track.groupId) return
      delete found.track.groupId
      normalizeProjectTrackGroups(doc.project)
      return
    }

    case 'removeTrackGroup': {
      const group = trackGroupById(doc.project, command.groupId)
      if (!group) throw new EditorCommandError(`Unknown group ${command.groupId}`)
      for (const track of doc.project.tracks) {
        if (track.groupId === command.groupId) delete track.groupId
      }
      for (const sequence of doc.project.sequences ?? []) {
        for (const track of sequence.tracks) {
          if (track.groupId === command.groupId) delete track.groupId
        }
      }
      doc.project.trackGroups = (doc.project.trackGroups ?? []).filter(
        (entry) => entry.id !== command.groupId,
      )
      if (doc.project.trackGroups.length === 0) delete doc.project.trackGroups
      return
    }

    case 'setTrackGroupFlag': {
      if (!(TRACK_GROUP_FLAGS as readonly string[]).includes(command.flag)) {
        throw new EditorCommandError('Unknown group flag')
      }
      if (typeof command.value !== 'boolean') {
        throw new EditorCommandError('Group flag value must be a boolean')
      }
      const membership = trackGroupMembership(doc, command.groupId)
      if (!membership) throw new EditorCommandError(`Unknown group ${command.groupId}`)
      const participants = groupFlagParticipants(membership.tracks, command.flag)
      if (participants.length === 0) {
        throw new EditorCommandError(
          command.flag === 'hidden'
            ? 'Hide applies to video and text tracks only'
            : 'Solo applies to audio tracks only',
        )
      }
      for (const track of participants) {
        if (command.flag === 'hidden') {
          // `visible` is absent when true: hydration and saves keep the file clean.
          if (command.value) track.visible = false
          else delete track.visible
        } else if (command.flag === 'muted') {
          track.muted = command.value
        } else if (command.flag === 'solo') {
          if (command.value) track.solo = true
          else delete track.solo
        } else {
          track.locked = command.value
        }
      }
      return
    }

    case 'applyTemplate': {
      // The template is external data: re-validate it at this boundary even
      // when the caller parsed it for the gallery.
      const template = parseTemplate(command.template)
      validateTemplateForDoc(template, doc)
      if (!Number.isFinite(command.start)) {
        throw new EditorCommandError('Invalid template position')
      }
      const start = Math.max(0, command.start)
      const { sequence, duration } = mintTemplateSequence(template)
      if (!Number.isFinite(duration) || duration < MIN_CLIP_DURATION) {
        throw new EditorCommandError('Template is too short to place')
      }
      assertClipEndWithinTimeline(start, duration)
      const owner = command.sequenceId ? findSequence(doc, command.sequenceId) : undefined
      if (command.sequenceId && !owner) throw new EditorCommandError('Unknown sequence')
      const tracks = owner ? owner.tracks : doc.project.tracks
      let destination: Track | undefined
      if (command.trackId) {
        destination = tracks.find((track) => track.id === command.trackId)
        if (!destination) throw new EditorCommandError('Unknown template destination track')
      } else {
        destination = tracks.find((track) => track.kind === 'video')
      }
      if (destination && destination.kind !== 'video') {
        throw new EditorCommandError('Templates install on a video track')
      }
      if (!destination) {
        destination = newTrackForKind(doc, 'video', command.sequenceId)
        insertTrack(tracks, destination)
        reorderTracksConvention(tracks)
        renumberAutoTracks(tracks, 'video')
      }
      const sequences = doc.project.sequences ?? (doc.project.sequences = [])
      sequences.push(sequence)
      const container: Clip = {
        id: uid('clip'),
        sequenceId: sequence.id,
        start,
        duration,
        inPoint: 0,
      }
      destination.clips.push(container)
      if (maxSequenceDepth(doc) > MAX_SEQUENCE_DEPTH) {
        sequences.pop()
        destination.clips = destination.clips.filter((clip) => clip.id !== container.id)
        throw new EditorCommandError('Template sequence nesting is too deep')
      }
      destination.clips.sort((a, b) => a.start - b.start)
      return
    }

    case 'addClip': {
      const track = requireTrack(doc, command.trackId)
      const clip = structuredClone(command.clip)
      assertStructuralIdFree(doc, clip.id, 'Clip')
      if (!Number.isFinite(clip.duration) || clip.duration < MIN_CLIP_DURATION) {
        throw new EditorCommandError('Clip duration is too short')
      }
      // Clamp keeps the negative-start convention; non-finite has no
      // position to clamp to, so it lands at zero rather than poisoning
      // sort order and span math with NaN.
      if (!Number.isFinite(clip.start) || clip.start < 0) clip.start = 0
      // Source offset is a clip field for every kind, not just bounded media:
      // `clampClipToMedia` returns early for text and images, so normalize it
      // here or a hostile payload installs a NaN/negative the inspector shows.
      if (!Number.isFinite(clip.inPoint) || clip.inPoint < 0) clip.inPoint = 0
      assertShapeClipFields(clip)
      if (compoundClipViolations(clip)) {
        throw new EditorCommandError('Compound clips cannot carry media, text or retiming fields')
      }
      if (clip.shape) {
        // Sanitize like `setClipShape`: a hostile payload (negative widths,
        // wild radii, unknown kinds) is clamped or refused here, never stored.
        const shape = sanitizeShape(clip.shape)
        if (!shape) throw new EditorCommandError('Invalid shape settings')
        clip.shape = shape
      }
      if (!clipFitsTrack(doc, clip, track)) {
        throw new EditorCommandError(
          `${describeClip(doc, clip)} cannot be placed on a ${track.kind} track`,
        )
      }
      // A compound clip placed on a lane must not close a reference cycle
      // (paste/move are the paths the create-time guard cannot see).
      assertCompoundCycle(doc, clip, findTrackIn(doc, track.id)?.sequenceId)
      clampClipToMedia(doc, clip)
      assertClipEndWithinTimeline(clip.start, clip.duration)
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
      const targetInfo = findTrackIn(doc, command.trackId)
      if (!targetInfo) throw new EditorCommandError('Unknown track')
      const target = targetInfo.track
      if (!clipFitsTrack(doc, found.clip, target)) {
        throw new EditorCommandError(
          `${describeClip(doc, found.clip)} cannot be placed on a ${target.kind} track`,
        )
      }
      const clip = found.clip
      // Link groups are sequence-local, so a cross-sequence move would create
      // an id hydration refuses. Refuse before mutating the start.
      if (clip.linkId !== undefined && found.sequenceId !== targetInfo.sequenceId) {
        throw new EditorCommandError('A linked clip cannot be moved across sequences')
      }
      if (clip.sequenceId) {
        assertCompoundCycle(doc, clip, targetInfo.sequenceId)
      }
      const oldStart = clip.start
      const movedTrack = target.id !== found.track.id
      if (!Number.isFinite(command.start)) {
        throw new EditorCommandError('Invalid clip position')
      }
      const nextStart = Math.max(0, command.start)
      assertClipEndWithinTimeline(nextStart, clip.duration)
      clip.start = nextStart
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
        // A cross-track (or cross-sequence) move can orphan the clip's own
        // matte entries: drop the ones that no longer resolve, in the same
        // undo step (after the rollback above, so a refused move loses
        // nothing). Other clips' mattes point at tracks, never clips, so
        // they cannot break here.
        if (clip.effects) {
          for (const e of clip.effects) {
            if (e.type !== 'trackMatte') continue
            const matte = e as Extract<EffectEntry, { type: 'trackMatte' }>
            if (!resolveMatteTrack(doc, clip.id, matte)) {
              clip.effects = clip.effects.filter((x) => x.id !== matte.id)
            }
          }
          if (clip.effects.length === 0) clip.effects = undefined
        }
      }
      target.clips.sort((a, b) => a.start - b.start)
      return
    }

    case 'trimClip': {
      const { clip } = requireClip(doc, command.clipId)
      if (
        command.edge !== undefined &&
        command.edge !== 'head' &&
        command.edge !== 'tail' &&
        command.edge !== 'span'
      ) {
        throw new EditorCommandError(`Unknown trim edge: ${String(command.edge)}`)
      }
      const asset = findMedia(doc, clip.mediaId)
      let { start, inPoint, duration } = command
      if (!Number.isFinite(duration) || duration < MIN_CLIP_DURATION) {
        throw new EditorCommandError('Clip would become too short')
      }
      if (!Number.isFinite(start) || !Number.isFinite(inPoint)) {
        throw new EditorCommandError('Invalid trim position')
      }
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
      // Only a head that actually MOVED through `start` re-anchors this way.
      // A ripple head trim keeps the start anchored and supplies its own
      // in point, which must survive: rescaling by a zero start delta would
      // silently write the old in point and shorten the clip from its tail.
      const rate = clip.speed ?? 1
      if (
        bounded &&
        isHeadTrim &&
        !clip.reverse &&
        !hasTimeScaleCurve(clip) &&
        rate !== 1 &&
        Math.abs(start - startBefore) > 1e-9
      ) {
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
      assertClipEndWithinTimeline(clip.start, clip.duration)
      track.clips.sort((a, b) => a.start - b.start)
      return
    }

    case 'splitClip': {
      const { clip, track } = requireClip(doc, command.clipId)
      const at = command.atTime
      if (!Number.isFinite(at)) throw new EditorCommandError('Invalid split point')
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
      // Effect curves split like flat curves (front-to-back, never mirrored):
      // each entry's map subdivides at the cut, halves without curves stay
      // curve-less. Trim never touches entry curves (see trimClip: only the
      // timeScale ramp rebases), so split is the only structural curve edit.
      const splitEntryKeyframes = (effects: EffectEntry[] | undefined, side: 'left' | 'right') =>
        effects?.map((e) => {
          // Spread always: the halves must never share entry objects (a
          // later param edit mutates the entry in place on its own clip).
          if (!e.keyframes) return { ...e }
          const [left, right] = splitEffectKeyframes(e.keyframes, leftDuration)
          const kept = side === 'left' ? left : right
          if (!kept) {
            const { keyframes: _dropped, ...rest } = e
            return rest as EffectEntry
          }
          return { ...e, keyframes: kept }
        })
      if (command.rightId !== undefined) {
        assertStructuralIdFree(doc, command.rightId, 'Clip')
      }
      const right: Clip = {
        ...structuredClone(clip),
        id: command.rightId ?? uid('clip'),
        start: at,
        duration: rightDuration,
        inPoint: isMedia ? (clip.reverse ? clip.inPoint : splitInPoint(leftDuration)) : 0,
        transitionOut: clip.transitionOut,
        keyframes: rightKeyframes,
        effects: splitEntryKeyframes(clip.effects, 'right'),
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
        right.linkId = command.rightLinkId ?? uid('link')
      }
      clip.duration = leftDuration
      clip.inPoint = leftInPoint
      clip.transitionOut = undefined
      clip.keyframes = leftKeyframes
      clip.effects = splitEntryKeyframes(clip.effects, 'left')
      if (clip.effects?.length === 0) clip.effects = undefined
      track.clips.push(right)
      track.clips.sort((a, b) => a.start - b.start)
      return
    }

    case 'closeGaps': {
      // The planner owns the geometry (transitions, link groups, collisions);
      // this case only writes the starts it proved safe. A plan is against the
      // same doc this command mutates, so a refusal discards the whole clone.
      const plan = planCloseGaps(doc, command.trackId)
      if (!plan.ok) throw new EditorCommandError(plan.reason)
      for (const move of plan.moves) {
        const { clip } = requireClip(doc, move.clipId)
        clip.start = move.start
      }
      return
    }

    case 'joinClips': {
      // The planner re-expands both link groups and pairs them lane by lane, so
      // a linked pair joins as ONE atomic batch (or refuses before any merge).
      // Each pair keeps the previous clip's id and selection; a reversed pair
      // moves the low anchor to the next clip's, which is what leaves the
      // joined head on the original high source end.
      const plan = planJoinGroup(doc, command.clipId, command.nextId)
      if (!plan.ok) throw new EditorCommandError(plan.reason)
      for (const pair of plan.pairs) {
        const { clip: previous } = requireClip(doc, pair.previousId)
        const { clip: next, track: nextTrack } = requireClip(doc, pair.nextId)
        previous.duration += next.duration
        if (previous.reverse) previous.inPoint = next.inPoint
        nextTrack.clips = nextTrack.clips.filter((clip) => clip.id !== next.id)
      }
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
      if (clips.some((c) => c.shape !== undefined)) {
        throw new EditorCommandError('Shape clips cannot be linked')
      }
      // Sequence-local: independent local time origins mean a cross-sequence
      // link could never be moved safely as a unit, so it is refused.
      const owners = new Set(found.map((f) => f.sequenceId))
      if (owners.size > 1) {
        throw new EditorCommandError('Cannot link clips across sequences')
      }
      const sequenceId = found[0].sequenceId
      const mergedGroupId = clips.find((c) => c.linkId)?.linkId ?? uid('link')
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
      clip.gain = clamp(requireFiniteNumber(command.gain, 'Clip gain'), GAIN_MIN, GAIN_MAX)
      return
    }

    case 'setClipMuted': {
      const { clip } = requireClip(doc, command.clipId)
      clip.muted = requireBoolean(command.muted, 'Clip mute')
      return
    }

    case 'setClipOpacity': {
      const { clip } = requireClip(doc, command.clipId)
      clip.opacity = clamp(
        requireFiniteNumber(command.opacity, 'Clip opacity'),
        OPACITY_MIN,
        OPACITY_MAX,
      )
      return
    }

    case 'setClipRotation': {
      const { clip } = requireClip(doc, command.clipId)
      // Non-finite values refuse instead of clamping: a NaN would render
      // nothing, and this boundary sees payloads from drags and files alike.
      if (!Number.isFinite(command.rotation)) {
        throw new EditorCommandError('Invalid rotation')
      }
      const rotation = clamp(command.rotation, ROTATION_MIN, ROTATION_MAX)
      if (rotation === 0) delete clip.rotation
      else clip.rotation = rotation
      return
    }

    case 'setClipFlip': {
      const { clip } = requireClip(doc, command.clipId)
      if (typeof command.flipX !== 'boolean' || typeof command.flipY !== 'boolean') {
        throw new EditorCommandError('Invalid flip')
      }
      if (command.flipX) clip.flipX = true
      else delete clip.flipX
      if (command.flipY) clip.flipY = true
      else delete clip.flipY
      return
    }

    case 'setClipKeyframes': {
      const { clip } = requireClip(doc, command.clipId)
      if (!Array.isArray(command.keyframes)) {
        throw new EditorCommandError('Clip keyframes must be an array')
      }
      // Checked before sanitizing so a refused payload leaves no curve behind.
      if (
        command.property === 'timeScale' &&
        (clip.shape !== undefined || clip.sequenceId !== undefined)
      ) {
        throw new EditorCommandError('Shape and compound clips cannot be time remapped')
      }
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
      if (clip.shape) throw new EditorCommandError('Shape clips cannot change speed')
      if (clip.text !== undefined) throw new EditorCommandError('Text clips cannot change speed')
      const speed = clamp(requireFiniteNumber(command.speed, 'Clip speed'), SPEED_MIN, SPEED_MAX)
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

    case 'setClipInPoint': {
      const { clip } = requireClip(doc, command.clipId)
      const asset = findMedia(doc, clip.mediaId)
      if (!asset || asset.kind === 'image' || clip.text !== undefined || clip.sequenceId) {
        throw new EditorCommandError('This clip has no source window to slip')
      }
      // The slip planner refuses a time-remapped clip, and the command mirrors
      // it. Without this the group check below would refuse the same clip with
      // a linked-window message that misdescribes the cause.
      if (hasTimeScaleCurve(clip)) {
        throw new EditorCommandError('A time-remapped clip cannot be slipped')
      }
      if (!Number.isFinite(command.inPoint) || command.inPoint < 0) {
        throw new EditorCommandError('Invalid slip position')
      }
      // A linked group slips as one unit: every member must already read the
      // same window, or writing one member's in point would desync the group.
      const group = linkedClips(doc, clip.id)
      if (group.some((member) => !sharesSourceWindow(clip, member))) {
        throw new EditorCommandError(
          'Linked clips do not share the same source window, so slipping would desync them',
        )
      }
      const span = sourceConsumption(clip.keyframes?.timeScale, clip.duration, clip.speed ?? 1)
      if (command.inPoint + span > asset.duration + 1e-6) {
        throw new EditorCommandError('Slip exceeds the end of the source')
      }
      for (const member of group) member.inPoint = command.inPoint
      return
    }

    case 'setClipReverse': {
      const { clip } = requireClip(doc, command.clipId)
      if (clip.sequenceId) throw new EditorCommandError('Compound clips cannot reverse')
      if (clip.shape) throw new EditorCommandError('Shape clips cannot reverse')
      if (clip.text !== undefined) throw new EditorCommandError('Text clips cannot reverse')
      clip.reverse = requireBoolean(command.reverse, 'Clip reverse')
      return
    }

    case 'setClipPan': {
      const { clip } = requireClip(doc, command.clipId)
      clip.pan = clamp(requireFiniteNumber(command.pan, 'Clip pan'), -1, 1)
      return
    }

    case 'setClipEq': {
      const { clip } = requireClip(doc, command.clipId)
      if (command.eq === null) {
        clip.eq = undefined
        return
      }
      const eq = requireRecord(command.eq, 'Clip EQ')
      const band = (v: unknown, what: string) =>
        clamp(requireFiniteNumber(v, what), EQ_DB_MIN, EQ_DB_MAX)
      clip.eq = {
        low: band(eq.low, 'EQ low'),
        mid: band(eq.mid, 'EQ mid'),
        high: band(eq.high, 'EQ high'),
      }
      return
    }

    case 'setClipCompressor': {
      const { clip } = requireClip(doc, command.clipId)
      clip.compressor = requireBoolean(command.enabled, 'Compressor enabled')
      return
    }

    case 'setClipDenoise': {
      const { clip } = requireClip(doc, command.clipId)
      // Same shape as the compressor: a switch that stores its own flag, so an
      // off clip stores `false` and the saved file carries `"denoise": false`
      // (hydration reads only `true`, so absent and false load alike).
      clip.denoise = requireBoolean(command.enabled, 'Denoise enabled')
      return
    }

    case 'setClipColorParams': {
      const { clip } = requireClip(doc, command.clipId)
      // Neutral values collapse to absent so a graded-then-reset clip (and the
      // file it saves) carries no grade at all.
      const temperature = clamp(
        requireFiniteNumber(command.temperature, 'Color temperature'),
        TEMPERATURE_MIN,
        TEMPERATURE_MAX,
      )
      const tint = clamp(requireFiniteNumber(command.tint, 'Color tint'), TINT_MIN, TINT_MAX)
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
      // A shape has no decoded pixels for the 3D pass, and the Inspector hides
      // the LUT row for it. Accepting the reference would render ungraded while
      // the clip still reads as graded, so refuse at the command boundary.
      // Clearing stays allowed: it is a no-op on a clip that cannot hold one.
      if (clip.shape) throw new EditorCommandError('Shape clips do not support 3D LUTs')
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
      if (!isAnimatableProperty(command.property)) {
        throw new EditorCommandError(`Unknown animatable property: ${command.property}`)
      }
      const bounds = KEYFRAME_PROPERTY_BOUNDS[command.property]
      if (!clip.animStatics) clip.animStatics = {}
      const clamped = clamp(
        requireFiniteNumber(command.value, 'Static value'),
        bounds.min,
        bounds.max,
      )
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
      clip.text = requireString(command.text, 'Text content')
      return
    }

    case 'setTextStyle': {
      const { clip } = requireClip(doc, command.clipId)
      if (!clip.style) throw new EditorCommandError('Not a text clip')
      const patch =
        command.style === undefined
          ? ({} as Partial<TextStyle>)
          : ({ ...requireRecord(command.style, 'Text style') } as unknown as Partial<TextStyle>)
      if (patch.fontFamily !== undefined) {
        // The family crosses into a canvas font shorthand. The picker only
        // emits built-ins and generated families, but a command payload is a
        // trust boundary of its own.
        const family = sanitizeFontFamily(patch.fontFamily)
        if (!family) throw new EditorCommandError('Invalid font family')
        patch.fontFamily = family
      }
      // Merge first, then bound the whole style exactly like hydration and the
      // preset library: a command payload is its own trust boundary, and x, y
      // and fontSize reach canvas geometry verbatim otherwise.
      clip.style = sanitizePresetStyle({ ...clip.style, ...patch })
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
      const name = normalizePresetName(requireString(command.name, 'Preset name'))
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

    case 'addProjectFont': {
      const font = sanitizeProjectFont(command.font)
      if (!font) throw new EditorCommandError('Invalid font entry')
      const fonts = doc.project.fonts ?? (doc.project.fonts = [])
      if (fonts.some((entry) => entry.id === font.id)) {
        throw new EditorCommandError(`Font ${font.id} already exists`)
      }
      // CSS family names match ASCII case-insensitively, so generated
      // families that differ only by case would answer the same face.
      if (fonts.some((entry) => entry.family.toLowerCase() === font.family.toLowerCase())) {
        throw new EditorCommandError(`Font family ${font.family} already exists`)
      }
      fonts.push(structuredClone(font))
      return
    }

    case 'removeProjectFont': {
      const fonts = doc.project.fonts ?? []
      const font = fonts.find((entry) => entry.id === command.fontId)
      if (!font) throw new EditorCommandError(`Unknown font ${command.fontId}`)
      const user = referenceToFont(doc, fontFaceFamily(font.id))
      if (user) {
        throw new EditorCommandError(
          `This font is still used by ${user}; change those text clips or presets before removing it.`,
        )
      }
      const index = fonts.indexOf(font)
      fonts.splice(index, 1)
      if (fonts.length === 0) delete doc.project.fonts
      return
    }

    case 'renameProjectFont': {
      const name = sanitizeFontName(command.name)
      if (!name) throw new EditorCommandError('Font name cannot be empty')
      const font = doc.project.fonts?.find((entry) => entry.id === command.fontId)
      if (!font) throw new EditorCommandError(`Unknown font ${command.fontId}`)
      // The generated family is the immutable reference; only the display
      // name changes, so no text clip reroutes.
      font.name = name
      return
    }

    case 'addBrandColor': {
      const color = sanitizeBrandColor(command.color)
      if (!color) throw new EditorCommandError('Invalid brand color')
      const kit = doc.project.brandKit ?? (doc.project.brandKit = { colors: [] })
      if (kit.colors.length >= BRAND_COLORS_MAX) {
        throw new EditorCommandError(`A brand kit can hold at most ${BRAND_COLORS_MAX} colors`)
      }
      if (kit.colors.some((entry) => entry.id === color.id)) {
        throw new EditorCommandError(`Brand color ${color.id} already exists`)
      }
      if (kit.colors.some((entry) => entry.value === color.value)) {
        throw new EditorCommandError('That color is already in the brand kit')
      }
      kit.colors.push(color)
      return
    }

    case 'renameBrandColor': {
      const name = sanitizeBrandColorName(command.name)
      if (!name) throw new EditorCommandError('Brand color name is invalid')
      const color = doc.project.brandKit?.colors.find((entry) => entry.id === command.colorId)
      if (!color) throw new EditorCommandError(`Unknown brand color ${command.colorId}`)
      color.name = name
      return
    }

    case 'removeBrandColor': {
      const kit = doc.project.brandKit
      const index = kit?.colors.findIndex((entry) => entry.id === command.colorId) ?? -1
      if (!kit || index === -1) {
        throw new EditorCommandError(`Unknown brand color ${command.colorId}`)
      }
      kit.colors.splice(index, 1)
      pruneEmptyBrandKit(doc.project)
      return
    }

    case 'addBrandFont': {
      const family = sanitizeFontFamily(command.family)
      if (!family) throw new EditorCommandError('Invalid brand font family')
      const kit = doc.project.brandKit ?? (doc.project.brandKit = { colors: [] })
      const families = kit.fontFamilies ?? (kit.fontFamilies = [])
      if (families.length >= BRAND_FONT_FAMILIES_MAX) {
        throw new EditorCommandError(
          `A brand kit can hold at most ${BRAND_FONT_FAMILIES_MAX} font families`,
        )
      }
      if (families.some((entry) => entry.toLowerCase() === family.toLowerCase())) {
        throw new EditorCommandError('That font family is already in the brand kit')
      }
      families.push(family)
      return
    }

    case 'removeBrandFont': {
      if (typeof command.family !== 'string') {
        throw new EditorCommandError('Unknown brand font')
      }
      const kit = doc.project.brandKit
      const families = kit?.fontFamilies ?? []
      if (!kit) throw new EditorCommandError('This project has no brand kit')
      const index = families.findIndex(
        (entry) => entry.toLowerCase() === command.family.trim().toLowerCase(),
      )
      if (index === -1) throw new EditorCommandError(`Unknown brand font ${command.family}`)
      families.splice(index, 1)
      if (families.length === 0) delete kit.fontFamilies
      pruneEmptyBrandKit(doc.project)
      return
    }

    case 'setClipShape': {
      const { clip } = requireClip(doc, command.clipId)
      if (!clip.shape) throw new EditorCommandError('Not a shape clip')
      const shape = sanitizeShape(command.shape)
      if (!shape) throw new EditorCommandError('Invalid shape settings')
      clip.shape = shape
      return
    }

    case 'applyTextAnimation': {
      const { clip } = requireClip(doc, command.clipId)
      if (clip.text === undefined || !clip.style) {
        throw new EditorCommandError('Text animations apply to text clips only')
      }
      const built = buildTextAnimation(command.presetId, clip.duration)
      if (!built) throw new EditorCommandError('Unknown text animation or clip too short')
      // First version: never merge over an existing curve. Name the first
      // property so the refusal explains itself instead of silently replacing
      // work the user authored.
      for (const [property, curve] of Object.entries(built.keyframes) as [
        TextAnimationProperty,
        Keyframe[],
      ][]) {
        if (clip.keyframes?.[property]?.length) {
          throw new EditorCommandError(
            `This clip already animates ${textAnimationPropertyLabel(property)}. Remove that curve before applying the preset.`,
          )
        }
        clip.keyframes = clip.keyframes ?? {}
        clip.keyframes[property] = curve.map((keyframe) => ({ ...keyframe }))
      }
      return
    }

    case 'importCaptions': {
      // Trust-boundary validation lives HERE: the parser already dropped
      // malformed file data, but this payload is general, and `addClip`
      // clamps negative starts and lets NaN through, so the check must not
      // ride a lower layer. Anything invalid refuses the whole dispatch
      // with EditorCommandError, never a TypeError from a blind dereference.
      if (!Array.isArray(command.cues) || command.cues.length === 0) {
        throw new EditorCommandError('No captions to import')
      }
      const limitMs = MAX_SRT_TIME_SECONDS * 1000
      for (const cue of command.cues) {
        if (
          typeof cue !== 'object' ||
          cue === null ||
          !Number.isFinite(cue.start) ||
          !Number.isFinite(cue.duration) ||
          typeof cue.text !== 'string'
        ) {
          throw new EditorCommandError('Invalid caption cue')
        }
        const startMs = Math.round(cue.start * 1000)
        const durationMs = Math.round(cue.duration * 1000)
        if (
          cue.start < 0 ||
          cue.duration < MIN_CLIP_DURATION ||
          startMs > limitMs ||
          startMs + durationMs > limitMs ||
          cue.text.trim() === ''
        ) {
          throw new EditorCommandError('Invalid caption cue')
        }
        assertClipEndWithinTimeline(cue.start, cue.duration)
      }
      const track = {
        id: uid('track'),
        kind: 'text' as const,
        name: firstFreeCaptionsName(doc),
        clips: [] as Clip[],
      }
      // Straight to the top, with no resort: the array order is user intent
      // (drop-between-tracks allows any z-order), so existing lanes keep
      // their relative stacking while captions take the topmost layer.
      doc.project.tracks.unshift(track)
      for (const cue of command.cues) {
        track.clips.push(
          createTextClip({
            start: cue.start,
            duration: cue.duration,
            text: cue.text.trim(),
            style: createCaptionStyle(),
            isCaption: true,
          }),
        )
      }
      track.clips.sort((a, b) => a.start - b.start)
      return
    }

    case 'addCaptionCue': {
      const track = requireTrack(doc, command.trackId)
      if (track.kind !== 'text') throw new EditorCommandError('Captions need a text track')
      if (!Number.isFinite(command.start) || command.start < 0) {
        throw new EditorCommandError('Invalid caption start')
      }
      if (command.text !== undefined && typeof command.text !== 'string') {
        throw new EditorCommandError('Invalid caption text')
      }
      // Same millisecond bound as importCaptions: the fixed 2 s cue must
      // end inside the supported range, or the export could never
      // represent the clip this creates.
      const limitMs = MAX_SRT_TIME_SECONDS * 1000
      const startMs = Math.round(command.start * 1000)
      if (startMs > limitMs || startMs + 2000 > limitMs) {
        throw new EditorCommandError('Caption is past the supported range')
      }
      assertClipEndWithinTimeline(command.start, 2)
      track.clips.push(
        createTextClip({
          start: command.start,
          duration: 2,
          text: (command.text ?? '').trim(),
          style: createCaptionStyle(),
          isCaption: true,
        }),
      )
      track.clips.sort((a, b) => a.start - b.start)
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
      if (!TRANSITION_TYPES.includes(transitionType)) {
        throw new EditorCommandError(`Unknown transition type: ${String(transitionType)}`)
      }
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

    case 'addEffect': {
      const { clip } = requireClip(doc, command.clipId)
      if (
        command.effectType !== 'crop' &&
        command.effectType !== 'chromaKey' &&
        command.effectType !== 'trackMatte' &&
        command.effectType !== 'motionBlur'
      ) {
        throw new EditorCommandError(`Unknown effect type: ${String(command.effectType)}`)
      }
      const effectId =
        typeof command.effectId === 'string' && command.effectId !== ''
          ? command.effectId
          : uid('fx')
      if (findEffect(clip, effectId)) {
        throw new EditorCommandError(`Effect id already on this clip: ${effectId}`)
      }
      const entry = createEffectEntry(command.effectType)
      entry.id = effectId
      if (command.effectType === 'trackMatte') {
        if (typeof command.trackId !== 'string' || command.trackId === '') {
          throw new EditorCommandError('A track matte needs a source track')
        }
        const matte = entry as Extract<EffectEntry, { type: 'trackMatte' }>
        matte.trackId = command.trackId
        if (!resolveMatteTrack(doc, clip.id, matte)) {
          throw new EditorCommandError(
            'Matte source must be a track above the clip in its sequence',
          )
        }
      }
      if (!clip.effects) clip.effects = []
      clip.effects.push(entry)
      return
    }

    case 'removeEffect': {
      const { clip } = requireClip(doc, command.clipId)
      const index = (clip.effects ?? []).findIndex((e) => e.id === command.effectId)
      if (index === -1) throw new EditorCommandError('Unknown effect')
      clip.effects!.splice(index, 1)
      if (clip.effects!.length === 0) clip.effects = undefined
      return
    }

    case 'setEffectEnabled': {
      const { clip } = requireClip(doc, command.clipId)
      const entry = findEffect(clip, command.effectId)
      if (!entry) throw new EditorCommandError('Unknown effect')
      if (typeof command.enabled !== 'boolean')
        throw new EditorCommandError('Effect enabled must be a boolean')
      entry.enabled = command.enabled
      return
    }

    case 'resetEffect': {
      const { clip } = requireClip(doc, command.clipId)
      const entry = findEffect(clip, command.effectId)
      if (!entry) throw new EditorCommandError('Unknown effect')
      // Params back to defaults; curves are user timing work and stay (clear
      // them explicitly with an empty setEffectKeyframes). Enabled stays too.
      const fresh = createEffectEntry(entry.type)
      if (entry.type === 'crop' && fresh.type === 'crop') {
        entry.left = fresh.left
        entry.right = fresh.right
        entry.top = fresh.top
        entry.bottom = fresh.bottom
        entry.feather = fresh.feather
        entry.zoom = fresh.zoom
      } else if (entry.type === 'chromaKey' && fresh.type === 'chromaKey') {
        entry.key = fresh.key
        entry.similarity = fresh.similarity
        entry.blend = fresh.blend
        entry.clipBlack = fresh.clipBlack
        entry.clipWhite = fresh.clipWhite
        entry.despill = fresh.despill
      } else if (entry.type === 'trackMatte' && fresh.type === 'trackMatte') {
        // The source reference has no default (addEffect refuses without
        // one), so reset keeps it and restores only mode and reverse.
        entry.mode = fresh.mode
        entry.reverse = fresh.reverse
      } else if (entry.type === 'motionBlur' && fresh.type === 'motionBlur') {
        entry.shutter = fresh.shutter
      }
      return
    }

    case 'setEffectParams': {
      const { clip } = requireClip(doc, command.clipId)
      const entry = findEffect(clip, command.effectId)
      if (!entry) throw new EditorCommandError('Unknown effect')
      if (!command.params || typeof command.params !== 'object' || Array.isArray(command.params)) {
        throw new EditorCommandError('Effect params must be an object')
      }
      applyEffectParams(doc, clip, entry, command.params)
      return
    }

    case 'setEffectKeyframes': {
      const { clip } = requireClip(doc, command.clipId)
      const entry = findEffect(clip, command.effectId)
      if (!entry) throw new EditorCommandError('Unknown effect')
      if (!isEffectKeyframable(entry.type, command.property)) {
        throw new EditorCommandError(
          `Property is not animatable on this effect: ${command.property}`,
        )
      }
      if (!Array.isArray(command.keyframes)) {
        throw new EditorCommandError('Effect keyframes must be an array')
      }
      const keyframes = sanitizeEffectKeyframes(command.property, command.keyframes)
      if (!entry.keyframes) entry.keyframes = {}
      if (keyframes.length === 0) {
        delete entry.keyframes[command.property]
        if (Object.keys(entry.keyframes).length === 0) delete entry.keyframes
      } else {
        entry.keyframes[command.property] = keyframes
      }
      return
    }

    case 'setClipBlendMode': {
      const { clip } = requireClip(doc, command.clipId)
      if (command.blendMode === null) {
        clip.blendMode = undefined
        return
      }
      if (!isBlendMode(command.blendMode)) {
        throw new EditorCommandError(`Unknown blend mode: ${String(command.blendMode)}`)
      }
      clip.blendMode = command.blendMode === 'normal' ? undefined : command.blendMode
      return
    }

    case 'setTrackVisible': {
      const track = requireTrack(doc, command.trackId)
      if (typeof command.visible !== 'boolean') {
        throw new EditorCommandError('Track visible must be a boolean')
      }
      // Audio lanes have no eye: mute is their visibility control. The UI
      // never sends this, but a command payload is a trust boundary.
      if (track.kind === 'audio') {
        throw new EditorCommandError(AUDIO_VISIBILITY_REFUSAL)
      }
      track.visible = command.visible
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
      applyMarkerPatch(
        requireSequenceMarker(doc, command.markerId),
        requireMarkerPatch(command.patch),
      )
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
      applyMarkerPatch(requireClipMarker(clip, command.markerId), requireMarkerPatch(command.patch))
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
      const patch = requireRecord(command.patch, 'Project settings')
      if (patch.name !== undefined) {
        p.name = requireString(patch.name, 'Project name').trim() || p.name
      }
      if (patch.width !== undefined) {
        p.width = clamp(
          Math.round(requireFiniteNumber(patch.width, 'Project width')),
          PROJECT_MIN_W,
          PROJECT_MAX_W,
        )
      }
      if (patch.height !== undefined) {
        p.height = clamp(
          Math.round(requireFiniteNumber(patch.height, 'Project height')),
          PROJECT_MIN_H,
          PROJECT_MAX_H,
        )
      }
      if (patch.fps !== undefined) {
        p.fps = clamp(Math.round(requireFiniteNumber(patch.fps, 'Project fps')), FPS_MIN, FPS_MAX)
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

function requireRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new EditorCommandError(`${what} must be an object`)
  }
  // A payload is untrusted: a field inherited from a custom prototype (or a
  // class getter) is not something any UI control sends, so only plain records
  // and null-prototype records may supply patch fields.
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new EditorCommandError(`${what} must be a plain object`)
  }
  return value as Record<string, unknown>
}

function requireFiniteNumber(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new EditorCommandError(`${what} must be a finite number`)
  }
  return value
}

function requireBoolean(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') {
    throw new EditorCommandError(`${what} must be a boolean`)
  }
  return value
}

function requireString(value: unknown, what: string): string {
  if (typeof value !== 'string') {
    throw new EditorCommandError(`${what} must be a string`)
  }
  return value
}

function requireMarkerPatch(value: unknown): MarkerPatch {
  const patch = requireRecord(value, 'Marker patch') as MarkerPatch
  if (patch.name !== undefined) requireString(patch.name, 'Marker name')
  if (patch.notes !== undefined) requireString(patch.notes, 'Marker notes')
  return patch
}

function requireClip(doc: Doc, clipId: string) {
  const found = findClip(doc, clipId)
  if (!found) throw new EditorCommandError('Unknown clip')
  return found
}

/**
 * Refuses a structural id that hydration would refuse: empty or blank, or a
 * track, clip, or sequence id that already exists anywhere in the project.
 * Payload-supplied ids cross this boundary; generated ids never do.
 */
function assertStructuralIdFree(doc: Doc, id: string, label: string): void {
  if (id.trim().length === 0) throw new EditorCommandError(`${label} id cannot be empty`)
  if (
    findTrackIn(doc, id) ||
    findClip(doc, id) ||
    (doc.project.sequences ?? []).some((sequence) => sequence.id === id)
  ) {
    throw new EditorCommandError(`${label} id is already in use: ${id}`)
  }
}

/**
 * Validate + clamp an effect param patch (0.8.6). Known keys validate hard
 * (non-finite numbers and wrong types refuse, finite numbers clamp);
 * unknown keys are ignored, matching hydration's drop-unknown posture.
 */
function applyEffectParams(
  doc: Doc,
  clip: Clip,
  entry: EffectEntry,
  params: Record<string, unknown>,
): void {
  const num = requireFiniteNumber
  const boolean = requireBoolean
  if (entry.type === 'crop') {
    for (const p of ['left', 'right', 'top', 'bottom'] as const) {
      if (params[p] !== undefined) entry[p] = clampEffectPropertyValue(p, num(params[p], p))
    }
    if (params.feather !== undefined) {
      entry.feather = clampEffectPropertyValue('feather', num(params.feather, 'feather'))
    }
    if (params.zoom !== undefined) entry.zoom = boolean(params.zoom, 'zoom')
    return
  }
  if (entry.type === 'chromaKey') {
    if (params.key !== undefined) {
      if (typeof params.key !== 'string' || !parseKeyColor(params.key)) {
        throw new EditorCommandError('Chroma key must be a #rrggbb hex color')
      }
      // parseKeyColor tolerates surrounding whitespace: store the trimmed
      // form so the entry never carries what validation did not see.
      entry.key = params.key.trim()
    }
    const bounds = {
      similarity: { min: CHROMA_SIMILARITY_MIN, max: CHROMA_SIMILARITY_MAX },
      blend: { min: CHROMA_BLEND_MIN, max: CHROMA_BLEND_MAX },
      clipBlack: { min: CHROMA_CLIP_MIN, max: CHROMA_CLIP_MAX },
      clipWhite: { min: CHROMA_CLIP_MIN, max: CHROMA_CLIP_MAX },
      despill: { min: CHROMA_DESPILL_MIN, max: CHROMA_DESPILL_MAX },
    } as const
    for (const p of ['similarity', 'blend', 'clipBlack', 'clipWhite', 'despill'] as const) {
      if (params[p] !== undefined) {
        entry[p] = Math.min(bounds[p].max, Math.max(bounds[p].min, num(params[p], p)))
      }
    }
    const black = entry.clipBlack ?? 0
    const white = entry.clipWhite ?? 1
    if (black > white) throw new EditorCommandError('Chroma clip black cannot exceed clip white')
    return
  }
  if (entry.type === 'trackMatte') {
    if (params.trackId !== undefined) {
      if (typeof params.trackId !== 'string' || params.trackId === '') {
        throw new EditorCommandError('Matte source must be a track id')
      }
      const prev = entry.trackId
      entry.trackId = params.trackId
      if (!resolveMatteTrack(doc, clip.id, entry)) {
        entry.trackId = prev
        throw new EditorCommandError('Matte source must be a track above the clip in its sequence')
      }
    }
    if (params.mode !== undefined) {
      if (params.mode !== 'luma' && params.mode !== 'alpha') {
        throw new EditorCommandError(`Unknown matte mode: ${String(params.mode)}`)
      }
      entry.mode = params.mode
    }
    if (params.reverse !== undefined) entry.reverse = boolean(params.reverse, 'reverse')
    return
  }
  if (params.shutter !== undefined) {
    entry.shutter = clampEffectPropertyValue('shutter', num(params.shutter, 'shutter'))
  }
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

/**
 * The first thing that references a generated font family token, or null.
 * Removal refuses while any text clip (root or nested sequence) or saved title
 * preset still names that family, mirroring the media clean rule: a reachable
 * reference is never silently broken.
 *
 * The comparison parses the CSS stack into tokens and folds case. A reference
 * that keeps the generated family but changes its fallbacks (`token, serif`)
 * still uses the font, and canvas resolves family names case-insensitively.
 * Only the generated token is compared, so a clip on plain `Arial` does not
 * block removing an unrelated project font whose stack also lists Arial.
 */
function fontFamilyReferences(value: string | undefined, token: string): boolean {
  if (!value) return false
  const target = primaryFontFamily(token)
  if (!target) return false
  return fontFamilyTokens(value).includes(target)
}

function referenceToFont(doc: Doc, token: string): string | null {
  const visit = (tracks: Track[]): boolean =>
    tracks.some((track) =>
      track.clips.some((clip) => fontFamilyReferences(clip.style?.fontFamily, token)),
    )
  if (visit(doc.project.tracks)) return 'a text clip'
  if ((doc.project.sequences ?? []).some((sequence) => visit(sequence.tracks))) {
    return 'a text clip in a compound clip'
  }
  if (
    (doc.project.textPresets ?? []).some((preset) =>
      fontFamilyReferences(preset.style.fontFamily, token),
    )
  ) {
    return 'a saved title preset'
  }
  return null
}

function markerTime(time: number): number {
  if (!Number.isFinite(time) || time < 0) {
    throw new EditorCommandError('Marker time must be a non-negative number')
  }
  if (time > MAX_TIMELINE_SECONDS) {
    throw new EditorCommandError(
      `Marker time must be within the ${MAX_TIMELINE_SECONDS / 3600}-hour timeline limit`,
    )
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
  if (clip.shape) return 'Shape'
  if (clip.sequenceId) return 'Compound clip'
  if (clip.text !== undefined) return 'Text'
  const asset = findMedia(doc, clip.mediaId)
  return asset ? `“${asset.name}” (${asset.kind})` : 'Clip'
}

/**
 * A shape clip is a source in itself: it may not also name media, carry text,
 * be a caption or compound, belong to a link group, or be retimed. The add and
 * paste paths call this before lane compatibility, so a malformed command
 * payload is refused rather than stored.
 */
function assertShapeClipFields(clip: Clip): void {
  if (shapeClipViolations(clip)) {
    throw new EditorCommandError(
      'Shape clips cannot carry media, text, compound, linked, LUT or retiming fields',
    )
  }
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
  // Non-finite has no position to clamp to: without this, NaN slips past
  // the comparison below and poisons maxDuration (and the duration) to NaN.
  if (!Number.isFinite(clip.inPoint) || clip.inPoint < 0) clip.inPoint = 0
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
  const tracks = sequenceTracks(doc, sequenceId).filter((t) => t.kind === kind)
  // Text keeps the old count-every-track rule; only audio and video renumber.
  const auto = kind === 'text' ? tracks.length : tracks.filter(isAutoNamedTrack).length
  const prefix = kind === 'video' ? 'V' : kind === 'audio' ? 'A' : 'T'
  return `${prefix}${auto + 1}`
}

/** True when a track's name is editor-generated and may be renumbered. */
export function isAutoNamedTrack(track: Track): boolean {
  if (track.autoName === false) return false
  return /^[VAT]\d+$/.test(track.name)
}

/**
 * Renumbers the auto-named tracks of one kind positionally (0.18.0). Audio
 * counts top-to-bottom (`A1`, `A2`, `A3`), video bottom-to-top (`V1` at the
 * bottom, so the newest top layer gets the highest number). Custom names are
 * skipped and do not consume a number. Text keeps its existing names.
 */
export function renumberAutoTracks(tracks: Track[], kind: TrackKind): void {
  if (kind === 'text') return
  const prefix = kind === 'video' ? 'V' : 'A'
  const owned = tracks.filter((t) => t.kind === kind)
  // Audio numbers in array order; video numbers from the bottom of the group.
  const ordered = kind === 'audio' ? owned : [...owned].reverse()
  let n = 1
  for (const track of ordered) {
    if (!isAutoNamedTrack(track)) continue
    track.name = `${prefix}${n}`
    n += 1
  }
}

/**
 * The name a pending insert would receive after the positional renumber
 * (0.18.0): `+ A2` between A1 and A2, `+ V2` between V1 and V2. The index
 * comes from the boundary so a custom name never consumes a number.
 */
export function previewInsertTrackName(
  doc: Doc,
  kind: TrackKind,
  boundary: InsertBoundary,
  sequenceId?: string,
): string {
  const tracks = sequenceTracks(doc, sequenceId)
  const index = resolveInsertIndex(tracks, boundary)
  const autoOfKind = (slice: Track[]) =>
    slice.filter((t) => t.kind === kind && isAutoNamedTrack(t)).length
  const prefix = kind === 'video' ? 'V' : kind === 'audio' ? 'A' : 'T'
  // Video numbers bottom-to-top, so the new track's number is the count of
  // auto tracks at or below its insertion point. Audio numbers top-to-bottom.
  const n =
    kind === 'video' ? autoOfKind(tracks.slice(index)) + 1 : autoOfKind(tracks.slice(0, index)) + 1
  return `${prefix}${n}`
}

/**
 * First free captions track name (`Captions`, `Captions 2`, …) — shared by
 * the `importCaptions` command and the panel's fresh-track batch, so both
 * number the same way.
 */
export function firstFreeCaptionsName(doc: Doc): string {
  const taken = new Set(doc.project.tracks.map((t) => t.name))
  if (!taken.has('Captions')) return 'Captions'
  let n = 2
  while (taken.has(`Captions ${n}`)) n += 1
  return `Captions ${n}`
}

function newTrackForKind(doc: Doc, kind: TrackKind, sequenceId?: string) {
  return {
    id: uid('track'),
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
  // Audio appends below the last audio track (Adobe order); video and text
  // still prepend inside their kind group.
  if (track.kind === 'audio') {
    const lastOfKind = tracks.map((t) => t.kind).lastIndexOf('audio')
    if (lastOfKind === -1) tracks.push(track)
    else tracks.splice(lastOfKind + 1, 0, track)
    return
  }
  const firstOfKind = tracks.findIndex((t) => t.kind === track.kind)
  if (firstOfKind === -1) tracks.push(track)
  else tracks.splice(firstOfKind, 0, track)
}

/** Convenience for UI code: total timeline length (re-exported for ergonomics). */
export { docDuration }
