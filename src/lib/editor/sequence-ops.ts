import { MIN_CLIP_DURATION, MIN_SPLIT_HEADROOM } from './constants'
import type { EditorCommand } from './commands'
import { findMedia, uid } from './factories'
import { linkedClips } from './links'
import { clamp } from './time'
import { sourceConsumption } from './trim'
import type { Clip, Doc, MediaAsset } from './types'

/**
 * Insert / overwrite placement planning (Premiere-style sequence edits).
 *
 * Pure module beside `trim.ts` and `tracks.ts`: no React, no browser APIs, so
 * the whole matrix runs in the Node test environment. The planner returns the
 * DISPLACEMENT half of a placement as `EditorCommand[]` (shifts, splits, trims
 * and deletes); the caller appends the actual placement (`addClip`, or the A/V
 * pair through `avPairCommands`) and applies the whole array as ONE history
 * entry.
 *
 * ## Comparison rule (stated once, applied everywhere)
 *
 * Every boundary is a float in seconds, so each comparison takes
 * `EPS = 1e-6`, mirroring the command layer's own closed refusals instead of
 * working around them:
 *
 * - at or after the point: `start >= at - EPS`
 * - straddles the point: `start < at - EPS` AND `end > at + EPS`
 * - a retained side exists: `length > EPS`
 * - a side survives: `length >= MIN_CLIP_DURATION - EPS` (clamped up)
 * - at or under the split headroom: `length <= MIN_SPLIT_HEADROOM + EPS`
 * - a legal placement span: `span >= MIN_CLIP_DURATION - EPS` (clamped up),
 *   checked before planning so nothing is built for a refused placement.
 *
 * A length or span that passes a `- EPS` floor but sits under
 * `MIN_CLIP_DURATION` is rounded UP to the floor before its payload is built:
 * the command layer rejects a duration under the floor strictly (`trimClip`,
 * `addClip`), so the clamp is what keeps a passing comparison representable.
 * The clamp is subject to the source-bound guard below, because raising a
 * length consumes up to `1e-6 s` times the clip's rate of extra source.
 *
 * Ties resolve toward the branch that keeps material (shift a clip rather
 * than leave it, keep a fragment rather than delete it), and the planner never
 * emits a command the command layer would reject.
 *
 * ## Link groups
 *
 * Link groups are always in sync (Invariant 14): the affected-lane set starts
 * from the placement lanes and expands through every group touched by a
 * planned operation to CLOSURE (a worklist), so chains of groups sharing one
 * lane cannot leave a partner behind. On the insert side a clip whose cut
 * cannot respect the split headroom falls back per clip: the clip and its
 * group partners are left untouched and the rest of the batch still commits.
 * On the overwrite side an unrepresentable cut refuses the WHOLE placement
 * (all-or-nothing), because trimming only one half of a pair would desync it.
 */

/** The three placement behaviors of a lane drop / source placement. */
export type PlacementMode = 'place' | 'insert' | 'overwrite'

/** Why a placement cannot be represented; the UI maps each to one toast. */
export type PlacementRefusal = 'span' | 'geometry' | 'source'

/** The single source of the refusal toasts (routes share the wording). */
export function placementRefusalMessage(refusal: PlacementRefusal): string {
  switch (refusal) {
    case 'span':
      return 'Placement span is shorter than the minimum'
    case 'geometry':
      return 'Overwrite would cut a clip shorter than the minimum'
    case 'source':
      return 'Overwrite would trim a clip past the end of its source'
  }
}

/** The displacement commands a placement needs, or the refusal that stops it. */
export type PlacementPlan =
  { commands: EditorCommand[]; refusal?: undefined } | { commands: null; refusal: PlacementRefusal }

const EPS = 1e-6

/** A marked source window (three-point editing): sequence-adjacent in/out. */
export interface SourceRange {
  inPoint: number
  outPoint: number
}

/** One toast for an inverted or sub-floor marked range (keyboard/panel routes). */
export const SOURCE_RANGE_MESSAGE = 'Source range is empty or shorter than the minimum'

/**
 * The effective `[in, out]` window of the marked ends: one-sided marks leave
 * the other end open (in only: `[in, end]`, out only: `[0, out]`), absent
 * marks mean the whole asset (null), and marks clamp into the asset. Images
 * and duration-less assets have no source window at all.
 */
export function sourceRangeFor(
  asset: MediaAsset,
  inMark: number | null,
  outMark: number | null,
): SourceRange | null {
  if (asset.kind === 'image' || asset.duration <= 0) return null
  if (inMark === null && outMark === null) return null
  return {
    inPoint: clamp(inMark ?? 0, 0, asset.duration),
    outPoint: clamp(outMark ?? asset.duration, 0, asset.duration),
  }
}

/** True when the marked range is inverted or under the placement floor. */
export function sourceRangeInvalid(range: SourceRange | null): boolean {
  if (!range) return false
  return range.outPoint <= range.inPoint || range.outPoint - range.inPoint < MIN_CLIP_DURATION - EPS
}

/**
 * The placement span a plan may use: null when it sits under
 * `MIN_CLIP_DURATION - EPS` (unrepresentable, refused as 'span'), otherwise
 * clamped up to the floor when it lands inside the `- EPS` band (at most
 * `1e-6 s` of trim lost, exactly what the comparison rule prescribes).
 */
export function normalizePlacementSpan(span: number): number | null {
  if (!Number.isFinite(span) || span < MIN_CLIP_DURATION - EPS) return null
  return Math.max(span, MIN_CLIP_DURATION)
}

/**
 * Displacement for an INSERT edit at `at`: clips on the affected lanes at or
 * after the point shift right by `span`; clips straddling the point split and
 * their right half shifts. A straddler that cannot respect the split headroom
 * (either side of the cut at or under `MIN_SPLIT_HEADROOM + EPS`) is left
 * alone together with its group partners, and the placement still commits.
 */
export function planInsert(
  doc: Doc,
  laneIds: readonly string[],
  at: number,
  span: number,
): PlacementPlan {
  const width = normalizePlacementSpan(span)
  if (width === null) return { commands: null, refusal: 'span' }

  // Fixed point: lanes grow through link groups of operated clips, while
  // headroom fallbacks exclude their whole group from operating. Both sets
  // only grow, so the loop terminates.
  const affected = new Set(laneIds)
  const excluded = new Set<string>()
  let changed = true
  while (changed) {
    changed = false
    for (const laneId of affected) {
      const track = doc.project.tracks.find((t) => t.id === laneId)
      if (!track) continue
      for (const clip of track.clips) {
        if (excluded.has(groupKey(clip))) continue
        const decision = insertDecision(clip, at)
        if (decision === 'none') continue
        if (decision === 'fallback') {
          excluded.add(groupKey(clip))
          changed = true
          continue
        }
        for (const member of linkedClips(doc, clip.id)) {
          const memberLane = laneIdOf(doc, member.id)
          if (memberLane && !affected.has(memberLane)) {
            affected.add(memberLane)
            changed = true
          }
        }
      }
    }
  }

  const commands: EditorCommand[] = []
  const rightLinkByGroup = new Map<string, string>()
  for (const track of doc.project.tracks) {
    if (!affected.has(track.id)) continue
    for (const clip of track.clips) {
      if (excluded.has(groupKey(clip))) continue
      const decision = insertDecision(clip, at)
      if (decision !== 'shift' && decision !== 'split') continue
      if (decision === 'shift') {
        commands.push({
          type: 'moveClip',
          clipId: clip.id,
          trackId: track.id,
          start: clip.start + width,
        })
        continue
      }
      // Straddler: split at the point (pre-assigned right id, one shared
      // rightLinkId per original group), then shift the right half into the
      // space the placement will occupy.
      const rightId = uid('clip')
      let rightLinkId: string | undefined
      if (clip.linkId) {
        let fresh = rightLinkByGroup.get(clip.linkId)
        if (!fresh) {
          fresh = uid('link')
          rightLinkByGroup.set(clip.linkId, fresh)
        }
        rightLinkId = fresh
      }
      commands.push({
        type: 'splitClip',
        clipId: clip.id,
        atTime: at,
        rightId,
        ...(rightLinkId ? { rightLinkId } : {}),
      })
      commands.push({ type: 'moveClip', clipId: rightId, trackId: track.id, start: at + width })
    }
  }
  return { commands }
}

/**
 * Displacement for an OVERWRITE edit at `[at, at + span)`: fully covered clips
 * are deleted, partial coverage trims the covered edge, interior coverage
 * splits once at `at` and head-trims the right fragment. All-or-nothing: when
 * a retained side cannot be represented (`left <= MIN_SPLIT_HEADROOM + EPS` or
 * `right < MIN_CLIP_DURATION - EPS`) or a trim would read past its source,
 * the WHOLE placement refuses and no command is emitted.
 */
export function planOverwrite(
  doc: Doc,
  laneIds: readonly string[],
  at: number,
  span: number,
): PlacementPlan {
  const width = normalizePlacementSpan(span)
  if (width === null) return { commands: null, refusal: 'span' }
  const end = at + width

  // Affected lanes: the placement lanes plus every lane holding a member of a
  // group whose window overlaps the edit (a trimmed/deleted/split half drags
  // its partners into the batch, so no pair is half-edited).
  const affected = new Set(laneIds)
  let changed = true
  while (changed) {
    changed = false
    for (const laneId of affected) {
      const track = doc.project.tracks.find((t) => t.id === laneId)
      if (!track) continue
      for (const clip of track.clips) {
        if (!overlaps(clip, at, end)) continue
        for (const member of linkedClips(doc, clip.id)) {
          const memberLane = laneIdOf(doc, member.id)
          if (memberLane && !affected.has(memberLane)) {
            affected.add(memberLane)
            changed = true
          }
        }
      }
    }
  }

  const commands: EditorCommand[] = []
  const rightLinkByGroup = new Map<string, string>()
  for (const track of doc.project.tracks) {
    if (!affected.has(track.id)) continue
    for (const clip of track.clips) {
      if (!overlaps(clip, at, end)) continue
      const left = at - clip.start
      const right = clip.start + clip.duration - end

      if (left > EPS && right > EPS) {
        // Interior coverage: one cut at `at`, then head-trim the right
        // fragment to the window's far edge. `span + right > MIN_SPLIT_HEADROOM`
        // follows from the two floors, so splitClip's right-side check holds.
        if (!(left > MIN_SPLIT_HEADROOM + EPS && right >= MIN_CLIP_DURATION - EPS)) {
          return { commands: null, refusal: 'geometry' }
        }
        const duration = Math.max(right, MIN_CLIP_DURATION)
        const anchor =
          clip.inPoint +
          sourceConsumption(clip.keyframes?.timeScale, end - clip.start, clip.speed ?? 1)
        const guarded = guardTrim(doc, clip, anchor, duration)
        if (guarded) return guarded
        const rightId = uid('clip')
        let rightLinkId: string | undefined
        if (clip.linkId) {
          let fresh = rightLinkByGroup.get(clip.linkId)
          if (!fresh) {
            fresh = uid('link')
            rightLinkByGroup.set(clip.linkId, fresh)
          }
          rightLinkId = fresh
        }
        commands.push({
          type: 'splitClip',
          clipId: clip.id,
          atTime: at,
          rightId,
          ...(rightLinkId ? { rightLinkId } : {}),
        })
        commands.push({
          type: 'trimClip',
          clipId: rightId,
          start: end,
          inPoint: anchor,
          duration,
          edge: 'head',
        })
        continue
      }

      if (right <= EPS) {
        // Keep-left only (or fully covered): a surviving left side tail-trims
        // to the window's near edge; a sliver dies with the clip.
        if (left >= MIN_CLIP_DURATION - EPS) {
          const duration = Math.max(left, MIN_CLIP_DURATION)
          const guarded = guardTrim(doc, clip, clip.inPoint, duration)
          if (guarded) return guarded
          commands.push({
            type: 'trimClip',
            clipId: clip.id,
            start: clip.start,
            inPoint: clip.inPoint,
            duration,
            edge: 'tail',
          })
        } else {
          commands.push({ type: 'deleteClip', clipId: clip.id })
        }
        continue
      }

      // Keep-right only: a surviving right side head-trims to the window's far
      // edge (payload anchor on the frames the cut lands on); a sliver dies.
      if (right >= MIN_CLIP_DURATION - EPS) {
        const duration = Math.max(right, MIN_CLIP_DURATION)
        const anchor =
          clip.inPoint +
          sourceConsumption(clip.keyframes?.timeScale, end - clip.start, clip.speed ?? 1)
        const guarded = guardTrim(doc, clip, anchor, duration)
        if (guarded) return guarded
        commands.push({
          type: 'trimClip',
          clipId: clip.id,
          start: end,
          inPoint: anchor,
          duration,
          edge: 'head',
        })
      } else {
        commands.push({ type: 'deleteClip', clipId: clip.id })
      }
    }
  }
  return { commands }
}

/**
 * The source-bound guard, run before a trim payload is emitted. Refuses when
 * the clip's STORED span already reads past its asset (legal only through an
 * over-consuming timeScale ramp, which the command layer would clamp or
 * reject) or when the post-clamp payload would read past it: the floor clamp
 * can add up to `1e-6 s` times the clip's rate of extra source, pushing an
 * edge that sat exactly on the asset's end past the command's own tolerance.
 */
function guardTrim(
  doc: Doc,
  clip: Clip,
  anchor: number,
  duration: number,
): { commands: null; refusal: 'source' } | undefined {
  const asset = boundedAsset(doc, clip)
  if (!asset) return undefined
  const ramp = clip.keyframes?.timeScale
  const stored = clip.inPoint + sourceConsumption(ramp, clip.duration, clip.speed ?? 1)
  if (stored > asset.duration + EPS) return { commands: null, refusal: 'source' }
  const payload = anchor + sourceConsumption(ramp, duration, clip.speed ?? 1)
  if (payload > asset.duration + EPS) return { commands: null, refusal: 'source' }
  return undefined
}

/** The asset a clip's source window is bounded by (images/text have none). */
function boundedAsset(doc: Doc, clip: Clip): MediaAsset | undefined {
  const asset = findMedia(doc, clip.mediaId)
  if (!asset || asset.kind === 'image') return undefined
  return asset
}

function overlaps(clip: Clip, at: number, end: number): boolean {
  return clip.start < end - EPS && clip.start + clip.duration > at + EPS
}

function insertDecision(clip: Clip, at: number): 'shift' | 'split' | 'fallback' | 'none' {
  if (clip.start >= at - EPS) return 'shift'
  const end = clip.start + clip.duration
  if (end > at + EPS) {
    const left = at - clip.start
    const right = end - at
    if (left <= MIN_SPLIT_HEADROOM + EPS || right <= MIN_SPLIT_HEADROOM + EPS) return 'fallback'
    return 'split'
  }
  return 'none'
}

/** Identity of a clip's link group for exclusion bookkeeping (solo = own id). */
function groupKey(clip: Clip): string {
  return clip.linkId ?? `__solo:${clip.id}`
}

/** The id of the lane a clip currently lives on, if any. */
function laneIdOf(doc: Doc, clipId: string): string | undefined {
  for (const track of doc.project.tracks) {
    if (track.clips.some((c) => c.id === clipId)) return track.id
  }
  return undefined
}
