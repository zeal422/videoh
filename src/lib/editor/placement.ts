import type { EditorCommand } from './commands'
import { DEFAULT_IMAGE_DURATION } from './constants'
import {
  createClip,
  firstCompatibleTrack,
  firstTargetedTrack,
  sequenceTracks,
  trackFitsAsset,
  trackKindForMedia,
  uid,
} from './factories'
import { assetHasAudio } from './links'
import {
  normalizePlacementSpan,
  planInsert,
  planOverwrite,
  type PlacementRefusal,
  type SourceRange,
} from './sequence-ops'
import type { Clip, Doc, MediaAsset, Track } from './types'

/**
 * Unified media placement planning (0.20.0).
 *
 * A lane drop (`commandsToPlaceMedia`) and a Source-monitor placement
 * (`commandsToPlaceSource`) build the same batch: an optional new track, the
 * displacement commands from `sequence-ops.ts`, then the placed clip or linked
 * A/V pair. Only the inputs differ (a pointed lane and a whole asset versus the
 * targeting rule and a marked source window). This module owns that shared
 * assembly; the two public routes in `actions.ts` are thin adapters.
 *
 * Pure: no React, no browser APIs. Returns a batch, never applies it.
 */

/** The source window a placement maps onto its clips (ranged source edits). */
export interface SourceWindow {
  inPoint: number
  duration: number
}

/** Track id the UI pre-generates for a to-be-created track inside a composite action. */
export function pendingTrackId(): string {
  return uid('track')
}

/** Whole-asset placement duration (images have no intrinsic length). */
export function clipDurationFor(asset: MediaAsset): number {
  return asset.kind === 'image' || asset.duration <= 0 ? DEFAULT_IMAGE_DURATION : asset.duration
}

export function clipFromAsset(
  asset: MediaAsset,
  start: number,
  sourceWindow?: SourceWindow | null,
): Clip {
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
export function avPairCommands(
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
 * The lane a lane-less placement lands on, in the documented order: the
 * pointed lane when it fits, then the first TARGETED compatible lane, then
 * the first compatible lane, then a newly created one. `newTrackId` is set
 * only for the created case (the caller emits the `addTrack` command).
 */
export function resolveMediaTarget(
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
export function resolveAudioTwinTrack(
  doc: Doc,
  untargetedTrackIds: readonly string[],
  sequenceId?: string,
): Track | undefined {
  return (
    firstTargetedTrack(doc, untargetedTrackIds, (t) => t.kind === 'audio', sequenceId) ??
    sequenceTracks(doc, sequenceId).find((t) => t.kind === 'audio')
  )
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

export interface MediaPlacementOptions {
  /** A pointed lane (lane drops only); ignored when it does not fit. */
  trackId?: string
  /** Marked source window (Source-monitor route); images ignore it. */
  range?: SourceRange | null
  untargetedTrackIds?: readonly string[]
  sequenceId?: string
}

function refused(refusal: PlacementRefusal): PlacementOutcome {
  return { commands: null, refusal }
}

/**
 * The complete insert/overwrite batch for a media placement: the effective
 * source window, the resolved destination lanes, the displacement plan, and
 * the placed clip or A/V pair. One undoable batch. The caller applies it.
 */
export function planMediaPlacement(
  doc: Doc,
  asset: MediaAsset,
  start: number,
  mode: 'insert' | 'overwrite',
  opts: MediaPlacementOptions = {},
): PlacementOutcome {
  // A non-finite time has no position to plan at. `addClip` would clamp it to
  // 0, but the planner must refuse instead of returning a batch that lies
  // about where the clip lands (and skips every displacement comparison).
  if (!Number.isFinite(start)) return refused('time')
  const untargetedTrackIds = opts.untargetedTrackIds ?? []
  const { sequenceId } = opts
  // The span pre-check runs before anything is built, so a refused placement
  // never reaches `addClip`'s own floor mid-batch.
  const effective = asset.kind === 'image' || asset.duration <= 0 ? null : (opts.range ?? null)
  // Finite source marks clamp into the asset BEFORE the span is computed.
  // `addClip` clamps the placed clip's own inPoint and duration, but the
  // displacement plan needs the same span the clip will actually occupy.
  // Non-finite marks stay as-is so `normalizePlacementSpan` refuses them.
  const normalized = effective
    ? {
        inPoint: Number.isFinite(effective.inPoint)
          ? Math.min(asset.duration, Math.max(0, effective.inPoint))
          : effective.inPoint,
        outPoint: Number.isFinite(effective.outPoint)
          ? Math.min(asset.duration, Math.max(0, effective.outPoint))
          : effective.outPoint,
      }
    : null
  const base = normalized ? normalized.outPoint - normalized.inPoint : clipDurationFor(asset)
  const span = normalizePlacementSpan(base)
  if (span === null) return refused('span')
  const sourceWindow: SourceWindow | null = normalized
    ? { inPoint: normalized.inPoint, duration: span }
    : null

  const { target, newTrackId } = resolveMediaTarget(
    doc,
    asset,
    opts.trackId,
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
