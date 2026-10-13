import type { EditorCommand } from './commands'
import {
  activeTracks,
  clipFitsTrack,
  createClip,
  createTextClip,
  docDuration,
  findClip,
  firstCompatibleTrack,
  firstTargetedTrack,
  sequenceTracks,
  uid,
} from './factories'
import { DEFAULT_IMAGE_DURATION, DEFAULT_TEXT_DURATION, MIN_SPLIT_HEADROOM } from './constants'
import {
  normalizePlacementSpan,
  planInsert,
  planOverwrite,
  type PlacementMode,
  type PlacementRefusal,
  type SourceRange,
} from './sequence-ops'
import { assetHasAudio, canLinkClips, linkedClips, resolveSelectionGroups } from './links'
import {
  createMarker,
  markerFromSelection,
  reIdMarkers,
  sourceTimeForClipMarker,
  type MarkerSelection,
} from './markers'
import { clamp } from './time'
import type { Clip, Doc, MediaAsset, MediaKind, Track, TrackKind } from './types'

/**
 * High-level UI actions that compose MULTIPLE commands into a single undoable
 * step (e.g. "create a track, then drop the clip onto it").
 * Call them with `store.apply(commandsToAddMedia(...))`.
 */

/** Track id the UI pre-generates for a to-be-created track inside a composite action. */
function pendingTrackId(): string {
  return uid('track')
}

/** The track kind that hosts the given media kind (images go on video tracks). */
export function trackKindForMedia(kind: MediaKind): 'video' | 'audio' {
  return kind === 'audio' ? 'audio' : 'video'
}

/** The source window a placement maps onto its clips (ranged source edits). */
interface SourceWindow {
  inPoint: number
  duration: number
}

/** Whole-asset placement duration (images have no intrinsic length). */
function clipDurationFor(asset: MediaAsset): number {
  return asset.kind === 'image' || asset.duration <= 0 ? DEFAULT_IMAGE_DURATION : asset.duration
}

function clipFromAsset(asset: MediaAsset, start: number, sourceWindow?: SourceWindow | null): Clip {
  return createClip({
    mediaId: asset.id,
    start: Math.max(0, start),
    duration: sourceWindow ? sourceWindow.duration : clipDurationFor(asset),
    inPoint: sourceWindow ? sourceWindow.inPoint : 0,
  })
}

/**
 * A video asset with audio becomes a LINKED PAIR (Premiere A/V links): the
 * video part on the resolved video track and an audio-only twin on the first
 * audio track, sharing one `linkId`. The twin is the pair's sole audio
 * carrier (the engine shadows the video part's embedded audio — links.ts),
 * so the user gets independent video/audio lanes they can unlink, cut or
 * delete separately.
 */
function avPairCommands(
  doc: Doc,
  asset: MediaAsset,
  start: number,
  videoTrackId: string,
  /** When the doc has no audio track: the atIndex for the one to create. */
  audioTrackAtIndex?: number,
  /** Lanes the user turned off: the twin avoids them (legacy lane when none fit). */
  untargetedTrackIds: readonly string[] = [],
  /** Ranged source placement: the SAME window on both halves (equal spans). */
  sourceWindow?: SourceWindow | null,
  sequenceId?: string,
): EditorCommand[] {
  const linkId = uid('link')
  const videoClip: Clip = { ...clipFromAsset(asset, start, sourceWindow), linkId }
  const audioClip: Clip = {
    ...clipFromAsset(asset, start, sourceWindow),
    linkId,
    audioOnly: true,
  }
  const commands: EditorCommand[] = []

  const audioTrack = resolveAudioTwinTrack(doc, untargetedTrackIds, sequenceId)
  let audioTrackId: string
  if (audioTrack) {
    audioTrackId = audioTrack.id
  } else {
    // Explicit atIndex (instead of the default head-of-kind insert) avoids
    // the convention re-sort, which would clobber an explicitly layered
    // track order.
    audioTrackId = pendingTrackId()
    commands.push({
      type: 'addTrack',
      kind: 'audio',
      trackId: audioTrackId,
      atIndex: audioTrackAtIndex ?? sequenceTracks(doc, sequenceId).length,
      ...(sequenceId ? { sequenceId } : {}),
    })
  }
  commands.push({ type: 'addClip', trackId: videoTrackId, clip: videoClip })
  commands.push({ type: 'addClip', trackId: audioTrackId, clip: audioClip })
  return commands
}

/**
 * Commands that place a media asset at `start`: on `trackId` when compatible
 * (positional, so targeting does not apply), otherwise on the first TARGETED
 * compatible track, falling back to the first compatible track when nothing of
 * that kind is targeted, otherwise on a newly created track.
 * Returns null for impossible placements.
 *
 * A video asset with a decodable audio track is placed as a LINKED PAIR:
 * video part on the video track + audio-only twin on the audio track
 * (Premiere-style A/V split on insert).
 */
/**
 * The lane a lane-less placement lands on, in the documented order: the
 * pointed lane when it fits, then the first TARGETED compatible lane, then
 * the first compatible lane, then a newly created one. `newTrackId` is set
 * only for the created case (the caller emits the `addTrack` command).
 */
function resolveMediaTarget(
  doc: Doc,
  asset: MediaAsset,
  trackId: string | undefined,
  untargetedTrackIds: readonly string[],
  sequenceId?: string,
): { target: Track; newTrackId: string | null } {
  const requested = trackId
    ? sequenceTracks(doc, sequenceId).find((t) => t.id === trackId)
    : undefined
  let target: Track | undefined =
    requested && trackFitsAsset(requested, asset.kind) ? requested : undefined
  if (!target) {
    target = firstTargetedTrack(
      doc,
      untargetedTrackIds,
      (t) => trackFitsAsset(t, asset.kind),
      sequenceId,
    )
  }
  if (!target) {
    // Nothing targeted of that kind: the legacy order still applies.
    target = firstCompatibleTrack(doc, asset.kind, sequenceId)
  }
  if (!target) {
    const kind = trackKindForMedia(asset.kind)
    const newId = pendingTrackId()
    return { target: { id: newId, kind, name: '', clips: [] }, newTrackId: newId }
  }
  return { target, newTrackId: null }
}

/**
 * The audio lane an A/V pair's twin lands on: the first TARGETED audio lane,
 * else the legacy first audio lane. Shared by the pair builder and the
 * placement planner, so both resolve the same twin lane.
 */
function resolveAudioTwinTrack(
  doc: Doc,
  untargetedTrackIds: readonly string[],
  sequenceId?: string,
): Track | undefined {
  return (
    firstTargetedTrack(doc, untargetedTrackIds, (t) => t.kind === 'audio', sequenceId) ??
    sequenceTracks(doc, sequenceId).find((t) => t.kind === 'audio')
  )
}

export function commandsToAddMedia(
  doc: Doc,
  asset: MediaAsset,
  start: number,
  trackId?: string,
  untargetedTrackIds: readonly string[] = [],
  sequenceId?: string,
): EditorCommand[] | null {
  const { target, newTrackId } = resolveMediaTarget(
    doc,
    asset,
    trackId,
    untargetedTrackIds,
    sequenceId,
  )
  if (!target) return null
  const commands: EditorCommand[] = []
  if (newTrackId) {
    commands.push({
      type: 'addTrack',
      kind: target.kind,
      trackId: newTrackId,
      ...(sequenceId ? { sequenceId } : {}),
    })
  }

  if (asset.kind === 'video' && assetHasAudio(asset)) {
    commands.push(
      ...avPairCommands(
        doc,
        asset,
        start,
        target.id,
        undefined,
        untargetedTrackIds,
        null,
        sequenceId,
      ),
    )
  } else {
    commands.push({ type: 'addClip', trackId: target.id, clip: clipFromAsset(asset, start) })
  }
  return commands
}

/**
 * Commands that drop media into a NEW track created at an exact z-position
 * (`atIndex` into the tracks array — 0 is the topmost compositing layer).
 * Powers the timeline's drop-between-tracks affordance: dragging media onto a
 * row edge (or the empty strip below the tracks) inserts the layer exactly
 * there — above, between or below existing tracks. One undoable batch.
 *
 * Video-with-audio assets place the A/V pair: the video part on the new layer
 * and the audio twin on the first audio track (creating one right BELOW the
 * new video layer when none exists — still an explicit placement, so the
 * convention sort is bypassed for both tracks).
 */
export function commandsToAddMediaInNewTrack(
  doc: Doc,
  asset: MediaAsset,
  start: number,
  atIndex: number,
  untargetedTrackIds: readonly string[] = [],
  sequenceId?: string,
): EditorCommand[] {
  const kind = trackKindForMedia(asset.kind)
  const newId = pendingTrackId()
  const commands: EditorCommand[] = [
    { type: 'addTrack', kind, trackId: newId, atIndex, ...(sequenceId ? { sequenceId } : {}) },
  ]

  if (asset.kind === 'video' && assetHasAudio(asset)) {
    commands.push(
      ...avPairCommands(
        doc,
        asset,
        start,
        newId,
        atIndex + 1,
        untargetedTrackIds,
        null,
        sequenceId,
      ),
    )
  } else {
    commands.push({ type: 'addClip', trackId: newId, clip: clipFromAsset(asset, start) })
  }
  return commands
}

/** Commands that add a text clip at `start`, creating a text track if needed. */
export function commandsToAddText(
  doc: Doc,
  start: number,
  untargetedTrackIds: readonly string[] = [],
  sequenceId?: string,
): EditorCommand[] {
  const commands: EditorCommand[] = []
  let textTrack =
    firstTargetedTrack(doc, untargetedTrackIds, (t) => t.kind === 'text', sequenceId) ??
    sequenceTracks(doc, sequenceId).find((t) => t.kind === 'text')
  if (!textTrack) {
    const newId = pendingTrackId()
    commands.push({
      type: 'addTrack',
      kind: 'text',
      trackId: newId,
      ...(sequenceId ? { sequenceId } : {}),
    })
    textTrack = { id: newId, kind: 'text', name: '', clips: [] }
  }
  const clip = createTextClip({
    start: Math.max(0, start),
    duration: DEFAULT_TEXT_DURATION,
  })
  commands.push({ type: 'addClip', trackId: textTrack.id, clip })
  return commands
}

/** Generates a fresh track id (used by UI actions that create tracks). */
export function newTrackId(): string {
  return uid('track')
}

// ————— A/V link-group operations (one undoable batch per action) —————

/** (Re-exported for backwards compatibility with UI/tests.) */
export { resolveSelectionGroups }

// ————— marker operations (0.5.5) —————

/**
 * Adds a marker at the playhead: a clip marker on the primary selected clip
 * (clamped into the clip's visible source span) when there is a selection,
 * otherwise a sequence marker at the playhead.
 */
export function commandsToAddMarker(
  doc: Doc,
  playhead: number,
  selectedIds: string[],
  activeSequencePath: readonly string[] = [],
): EditorCommand[] | null {
  const primaryId = selectedIds[0]
  const found = primaryId ? findClip(doc, primaryId) : undefined
  if (found) {
    return [
      {
        type: 'addClipMarker',
        clipId: found.clip.id,
        marker: createMarker(sourceTimeForClipMarker(found.clip, playhead)),
      },
    ]
  }
  // A child sequence has no sequence-level markers of its own (0.8.1): adding
  // one there would land at the root, hidden while the child is open.
  if (activeSequencePath.length > 0) return null
  // A sequence marker cannot live past the sequence end (the playhead cannot
  // seek there, so navigation could never reach it).
  return [{ type: 'addSequenceMarker', marker: createMarker(clamp(playhead, 0, docDuration(doc))) }]
}

/** The delete command for a selected marker, or null when it no longer exists. */
export function commandsToDeleteMarker(
  doc: Doc,
  selection: MarkerSelection,
): EditorCommand[] | null {
  const marker = markerFromSelection(doc, selection)
  if (!marker) return null
  return selection.scope === 'sequence'
    ? [{ type: 'deleteSequenceMarker', markerId: marker.id }]
    : [{ type: 'deleteClipMarker', clipId: selection.clipId, markerId: marker.id }]
}

/**
 * Deletes the WHOLE link group of every selected clip. A linked A/V pair dies
 * together until the user explicitly unlinks it (Premiere behavior).
 */
export function commandsToDeleteClips(doc: Doc, clipIds: string[]): EditorCommand[] {
  return resolveSelectionGroups(doc, clipIds).map((clip) => ({
    type: 'deleteClip',
    clipId: clip.id,
  }))
}

/**
 * Deletes the selection AND closes the gap it leaves behind (Premiere
 * Shift+Delete / Ripple Delete): on every affected track, clips that start
 * after the removed material slide left by the removed span (overlap-safe —
 * removed intervals are merged first, as crossfades make clips overlap).
 */
export function commandsToRippleDeleteClips(
  doc: Doc,
  clipIds: string[],
  activeSequencePath: readonly string[] = [],
): EditorCommand[] | null {
  const members = resolveSelectionGroups(doc, clipIds)
  if (members.length === 0) return null
  const memberIds = new Set(members.map((c) => c.id))

  const commands: EditorCommand[] = members.map((clip) => ({
    type: 'deleteClip',
    clipId: clip.id,
  }))

  const EPS = 1e-6
  for (const track of activeTracks(doc, activeSequencePath)) {
    const removed = track.clips.filter((c) => memberIds.has(c.id))
    if (removed.length === 0) continue
    // Merge removed intervals (transitions make same-track clips overlap).
    const intervals: [number, number][] = []
    for (const [s, e] of removed
      .map((c) => [c.start, c.start + c.duration] as [number, number])
      .sort((a, b) => a[0] - b[0])) {
      const last = intervals[intervals.length - 1]
      if (last && s <= last[1] + EPS) last[1] = Math.max(last[1], e)
      else intervals.push([s, e])
    }
    for (const clip of track.clips) {
      if (memberIds.has(clip.id)) continue
      let delta = 0
      for (const [s, e] of intervals) {
        if (e <= clip.start + EPS) delta += e - s
      }
      if (delta > EPS) {
        commands.push({
          type: 'moveClip',
          clipId: clip.id,
          trackId: track.id,
          start: Math.max(0, clip.start - delta),
        })
      }
    }
  }
  return commands
}

/**
 * Splits every member of every selected link group that the playhead crosses;
 * each original group's right halves re-link with ONE fresh link id so split
 * pairs stay paired (left halves keep the original bond).
 * Returns null when the playhead crosses nothing.
 */
export function commandsToSplitClipsAt(
  doc: Doc,
  clipIds: string[],
  atTime: number,
): EditorCommand[] | null {
  return splitGroupMembers(doc, resolveSelectionGroups(doc, clipIds), atTime)
}

/**
 * Premiere "Add Edit" (Ctrl+K) with NO selection: splits every clip on every
 * track that the playhead crosses (link groups treated as units).
 */
export function commandsToSplitAllAt(
  doc: Doc,
  atTime: number,
  activeSequencePath: readonly string[] = [],
): EditorCommand[] | null {
  const all = activeTracks(doc, activeSequencePath).flatMap((t) => t.clips)
  return splitGroupMembers(
    doc,
    resolveSelectionGroups(
      doc,
      all.map((c) => c.id),
    ),
    atTime,
  )
}

function splitGroupMembers(doc: Doc, members: Clip[], atTime: number): EditorCommand[] | null {
  const splittable = members.filter(
    (c) =>
      atTime > c.start + MIN_SPLIT_HEADROOM && atTime < c.start + c.duration - MIN_SPLIT_HEADROOM,
  )
  if (splittable.length === 0) return null
  // One fresh link id per ORIGINAL group — the right halves of each group
  // re-link with each other, never across groups.
  const rightLinkByGroup = new Map<string, string>()
  return splittable.map((clip) => {
    const isLinked = !!clip.linkId
    let rightLinkId: string | undefined
    if (isLinked && clip.linkId) {
      let fresh = rightLinkByGroup.get(clip.linkId)
      if (!fresh) {
        fresh = uid('link')
        rightLinkByGroup.set(clip.linkId, fresh)
      }
      rightLinkId = fresh
    }
    return {
      type: 'splitClip',
      clipId: clip.id,
      atTime,
      ...(rightLinkId ? { rightLinkId } : {}),
    }
  })
}

/**
 * Duplicates the whole selection right after itself (butt-to-tail per
 * member). Each original link group's copies share a FRESH linkId so the
 * duplicate pair is linked independently of the source; unlinked clips stay
 * unlinked.
 */
export function commandsToDuplicateClips(doc: Doc, clipIds: string[]): EditorCommand[] | null {
  const members = resolveSelectionGroups(doc, clipIds)
  if (members.length === 0) return null
  const freshLinkByGroup = new Map<string, string>()
  return members.map((clip) => {
    let linkId: string | undefined
    if (clip.linkId) {
      let fresh = freshLinkByGroup.get(clip.linkId)
      if (!fresh) {
        fresh = uid('link')
        freshLinkByGroup.set(clip.linkId, fresh)
      }
      linkId = fresh
    }
    return {
      type: 'addClip',
      trackId: requireTrackIdOf(doc, clip.id),
      clip: {
        ...structuredClone(clip),
        id: uid('clip'),
        start: clip.start + clip.duration,
        ...(linkId ? { linkId } : {}),
        // Fresh marker ids too: the original keeps its markers, and shared ids
        // would make delete/edit on one copy leave the twin behind and drop
        // the twin from snap exclusion (`excludeMarkerId` matches by id).
        markers: reIdMarkers(clip.markers),
      },
    }
  })
}

/** Unlinks EVERY distinct link group represented in the selection. */
export function commandsToUnlinkClips(doc: Doc, clipIds: string[]): EditorCommand[] | null {
  const members = resolveSelectionGroups(doc, clipIds)
  if (members.length === 0) return null
  // One unlinkClip per DISTINCT group — the command clears the whole group.
  const anchors = new Map<string, string>()
  for (const clip of members) {
    if (clip.linkId && !anchors.has(clip.linkId)) anchors.set(clip.linkId, clip.id)
  }
  if (anchors.size === 0) return null
  return [...anchors.values()].map((clipId) => ({ type: 'unlinkClip', clipId }))
}

/**
 * Links the given selected clips into ONE group (Premiere: Shift+click the
 * video and audio clips, then Ctrl+L / right-click > Link). Returns null
 * when the selection cannot be linked (fewer than 2 clips, text clips, or
 * everything already in a single group).
 */
export function commandsToLinkClips(doc: Doc, clipIds: string[]): EditorCommand[] | null {
  if (!canLinkClips(doc, clipIds)) return null
  return [{ type: 'linkClips', clipIds: [...clipIds] }]
}

function requireTrackIdOf(doc: Doc, clipId: string): string {
  const found = findClip(doc, clipId)
  if (!found) throw new Error(`Clip ${clipId} not found`)
  return found.track.id
}

/**
 * Lane/material compatibility (the same rule `commandsToAddMedia` applies):
 * video/image material goes on video lanes, audio on audio lanes, text clips
 * only on text lanes. Exported for the drop routing's explicit kind check.
 */
export function trackFitsAsset(track: Track, kind: MediaKind): boolean {
  if (track.kind === 'text') return false
  if (track.kind === 'video') return kind === 'video' || kind === 'image'
  return kind === 'audio'
}

/**
 * Outcome of a placement action: a command batch to apply, or the refusal
 * that stopped it (the UI maps each reason to its one toast). `commands` and
 * `refusal` are mutually exclusive; a successful batch carries a null refusal.
 */
export interface PlacementOutcome {
  commands: EditorCommand[] | null
  refusal: PlacementRefusal | null
}

function refused(refusal: PlacementRefusal): PlacementOutcome {
  return { commands: null, refusal }
}

/**
 * A lane-drop placement in insert or overwrite mode: resolve the placement
 * lanes (the pointed/compatible lane plus, for an A/V pair, the same audio
 * twin lane the pair builder uses), plan the displacement through the shared
 * planner, then append the placement itself. One undoable batch.
 * `place` mode delegates to `commandsToAddMedia` (today's behavior,
 * including its silent lane relocation).
 */
export function commandsToPlaceMedia(
  doc: Doc,
  asset: MediaAsset,
  start: number,
  mode: PlacementMode,
  trackId?: string,
  untargetedTrackIds: readonly string[] = [],
  sequenceId?: string,
): PlacementOutcome {
  if (mode === 'place') {
    const commands = commandsToAddMedia(doc, asset, start, trackId, untargetedTrackIds, sequenceId)
    return commands ? { commands, refusal: null } : refused('span')
  }
  // The span pre-check runs before anything is built, so a refused placement
  // never reaches `addClip`'s own floor mid-batch.
  const span = normalizePlacementSpan(clipDurationFor(asset))
  if (span === null) return refused('span')

  const { target, newTrackId } = resolveMediaTarget(
    doc,
    asset,
    trackId,
    untargetedTrackIds,
    sequenceId,
  )
  const paired = asset.kind === 'video' && assetHasAudio(asset)
  const laneIds = [target.id]
  if (paired) {
    const twin = resolveAudioTwinTrack(doc, untargetedTrackIds, sequenceId)
    if (twin) laneIds.push(twin.id)
  }
  const plan =
    mode === 'insert'
      ? planInsert(doc, laneIds, start, span, sequenceId)
      : planOverwrite(doc, laneIds, start, span, sequenceId)
  if (!plan.commands) return refused(plan.refusal)

  const commands: EditorCommand[] = []
  if (newTrackId) {
    commands.push({
      type: 'addTrack',
      kind: trackKindForMedia(asset.kind),
      trackId: newTrackId,
      ...(sequenceId ? { sequenceId } : {}),
    })
  }
  commands.push(...plan.commands)
  if (paired) {
    commands.push(
      ...avPairCommands(
        doc,
        asset,
        start,
        target.id,
        undefined,
        untargetedTrackIds,
        null,
        sequenceId,
      ),
    )
  } else {
    commands.push({ type: 'addClip', trackId: target.id, clip: clipFromAsset(asset, start) })
  }
  return { commands, refusal: null }
}

/**
 * Three-point placement from the Source monitor: the marked source range (or
 * the whole asset) lands at the sequence playhead in insert or overwrite
 * mode. The lane resolution is the targeting rule (no pointed lane on this
 * route); images ignore `range` and take `DEFAULT_IMAGE_DURATION`. Both
 * halves of an A/V pair receive the SAME window, so the pair stays aligned.
 */
export function commandsToPlaceSource(
  doc: Doc,
  asset: MediaAsset,
  start: number,
  mode: PlacementMode,
  range: SourceRange | null,
  untargetedTrackIds: readonly string[] = [],
  sequenceId?: string,
): PlacementOutcome {
  const effective = asset.kind === 'image' || asset.duration <= 0 ? null : range
  const base = effective ? effective.outPoint - effective.inPoint : clipDurationFor(asset)
  const span = normalizePlacementSpan(base)
  if (span === null) return refused('span')
  const sourceWindow: SourceWindow | null = effective
    ? { inPoint: Math.max(0, effective.inPoint), duration: span }
    : null

  const { target, newTrackId } = resolveMediaTarget(
    doc,
    asset,
    undefined,
    untargetedTrackIds,
    sequenceId,
  )
  const paired = asset.kind === 'video' && assetHasAudio(asset)
  const laneIds = [target.id]
  if (paired) {
    const twin = resolveAudioTwinTrack(doc, untargetedTrackIds, sequenceId)
    if (twin) laneIds.push(twin.id)
  }
  const plan =
    mode === 'insert'
      ? planInsert(doc, laneIds, start, span, sequenceId)
      : planOverwrite(doc, laneIds, start, span, sequenceId)
  if (!plan.commands) return refused(plan.refusal)

  const commands: EditorCommand[] = []
  if (newTrackId) {
    commands.push({
      type: 'addTrack',
      kind: trackKindForMedia(asset.kind),
      trackId: newTrackId,
      ...(sequenceId ? { sequenceId } : {}),
    })
  }
  commands.push(...plan.commands)
  if (paired) {
    commands.push(
      ...avPairCommands(
        doc,
        asset,
        start,
        target.id,
        undefined,
        untargetedTrackIds,
        sourceWindow,
        sequenceId,
      ),
    )
  } else {
    commands.push({
      type: 'addClip',
      trackId: target.id,
      clip: clipFromAsset(asset, start, sourceWindow),
    })
  }
  return { commands, refusal: null }
}

/** True when the given clip could be dropped onto the track (UI affordance). */
export function canDropClip(doc: Doc, clip: Clip, track: Track): boolean {
  return clipFitsTrack(doc, clip, track)
}

// ————— compound clips (0.8.1) —————

/**
 * Commands that fold the selected clips into a compound clip (one undoable
 * batch). The container replaces the selection in place on the selected
 * clips' video lane; when the selection was audio or text only it lands on the
 * first video lane. Returns null when the selection is empty, spans more than
 * one sequence, or the owning sequence has no video lane to host the container.
 * The cycle, depth and single-owner guards live in the command itself, so every
 * caller pays them.
 */
export function commandsToCreateCompoundClip(
  doc: Doc,
  clipIds: string[],
  name?: string,
): EditorCommand[] | null {
  const found = clipIds
    .map((id) => findClip(doc, id))
    .filter((f): f is NonNullable<typeof f> => f !== undefined)
  if (found.length === 0) return null
  const owner = found[0].sequenceId
  if (found.some((f) => f.sequenceId !== owner)) return null

  const videoLanes = sequenceTracks(doc, owner).filter((t) => t.kind === 'video')
  if (videoLanes.length === 0) return null
  const selectedIds = new Set(found.map((f) => f.clip.id))
  const sourceVideo = videoLanes.find((t) => t.clips.some((c) => selectedIds.has(c.id)))
  const trackId = (sourceVideo ?? videoLanes[0]).id

  return [
    {
      type: 'createCompoundClip',
      clipIds: found.map((f) => f.clip.id),
      trackId,
      ...(name ? { name } : {}),
    },
  ]
}
