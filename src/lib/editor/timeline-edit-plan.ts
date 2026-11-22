import { TIME_EPSILON } from './constants'
import { findClip, findTrackIn, sourceTimeAt } from './factories'
import { linkedClips } from './links'
import { clipGroupTracks, findLockedTrack } from './tracks'
import type { Clip, Doc, EffectEntry, Marker } from './types'

/**
 * Pure planners for the 0.22.0 timeline commands (Close Gaps and Join Clips).
 *
 * Both planners answer the same question the commands themselves must answer,
 * so the menu enablement and the command cannot disagree: the UI calls the
 * planner to decide whether a row is clickable, and the command calls the same
 * planner and throws its reason. Nothing here mutates the doc or reads the
 * store, so it runs in the Node test environment.
 */

export interface TimelineMove {
  clipId: string
  trackId: string
  /** Absolute timeline start after the move (always >= 0). */
  start: number
}

export type CloseGapsPlan = { ok: true; moves: TimelineMove[] } | { ok: false; reason: string }

/**
 * Plans the moves that close every gap on `trackId`, transition-aware.
 *
 * A gap is empty time, so an overlap is never mistaken for one: the running
 * `occupiedEnd` is the highest end seen so far, which means a crossfade
 * overlap reads as no gap and a clip nested inside a longer neighbour still
 * counts as occupied (a naive `previous.end` walk would pull the next clip
 * under it).
 *
 * Link groups move as one unit. Every member of a group must lose the same
 * amount of time; two members that would lose different amounts refuse the
 * whole close, because a partial shift of a pair desyncs picture and sound.
 */
export function planCloseGaps(doc: Doc, trackId: string): CloseGapsPlan {
  const found = findTrackIn(doc, trackId)
  if (!found) return { ok: false, reason: 'Unknown track' }
  const track = found.track
  if (track.clips.length === 0) return { ok: false, reason: 'This track has no clips to close up' }

  const clips = [...track.clips].sort((a, b) => a.start - b.start)

  // 1. Empty time each clip would lose, in ORIGINAL coordinates.
  const deltas = new Map<string, number>()
  let removed = 0
  let occupiedEnd = 0
  for (const clip of clips) {
    if (clip.start - occupiedEnd > TIME_EPSILON) removed += clip.start - occupiedEnd
    deltas.set(clip.id, -removed)
    occupiedEnd = Math.max(occupiedEnd, clip.start + clip.duration)
  }
  if (clips.every((clip) => Math.abs(deltas.get(clip.id) ?? 0) <= TIME_EPSILON)) {
    return { ok: false, reason: 'This track has no gaps to close' }
  }

  // 2. One delta per link group. A group with two members on THIS track that
  // would lose different amounts cannot stay in sync.
  const groupDelta = new Map<string, number>()
  for (const clip of clips) {
    if (!clip.linkId) continue
    const delta = deltas.get(clip.id) ?? 0
    const prior = groupDelta.get(clip.linkId)
    if (prior === undefined) groupDelta.set(clip.linkId, delta)
    else if (Math.abs(prior - delta) > TIME_EPSILON) {
      return { ok: false, reason: 'Linked clips would lose sync' }
    }
  }

  // 3. Every clip that moves, partners included.
  const moves = new Map<string, TimelineMove>()
  const add = (clip: Clip, ownerTrackId: string, delta: number): string | null => {
    const start = clip.start + delta
    const prior = moves.get(clip.id)
    if (prior) {
      return Math.abs(prior.start - start) <= TIME_EPSILON ? null : 'Linked clips would lose sync'
    }
    moves.set(clip.id, { clipId: clip.id, trackId: ownerTrackId, start })
    return null
  }
  for (const clip of clips) {
    const own = deltas.get(clip.id) ?? 0
    const delta = clip.linkId ? (groupDelta.get(clip.linkId) ?? own) : own
    if (Math.abs(delta) <= TIME_EPSILON) continue
    const selfError = add(clip, track.id, delta)
    if (selfError) return { ok: false, reason: selfError }
    for (const member of linkedClips(doc, clip.id)) {
      if (member.id === clip.id) continue
      const owner = findClip(doc, member.id)
      if (!owner) continue
      const partnerError = add(owner.clip, owner.track.id, delta)
      if (partnerError) return { ok: false, reason: partnerError }
    }
  }

  // 4. Never plan a move `moveClip` would silently clamp (a negative start is
  // clamped to zero, which would leave a pair desynced instead of refusing).
  for (const move of moves.values()) {
    if (move.start < -TIME_EPSILON) {
      return { ok: false, reason: 'A linked clip would move before the timeline start' }
    }
  }

  // 5. Preserve every existing overlap on the lanes that move. Closing empty
  // time may not shorten a transition (an overlap that shrinks) or invent a
  // new overlap (two clips colliding on a partner lane).
  const startsByTrack = new Map<string, Map<string, number>>()
  for (const move of moves.values()) {
    const owner = findClip(doc, move.clipId)
    if (!owner) continue
    const starts = startsByTrack.get(owner.track.id) ?? new Map<string, number>()
    starts.set(move.clipId, move.start)
    startsByTrack.set(owner.track.id, starts)
  }
  for (const [id, starts] of startsByTrack) {
    const owner = findTrackIn(doc, id)
    if (!owner) continue
    const lane = owner.track.clips
    for (let i = 0; i < lane.length; i++) {
      for (let j = i + 1; j < lane.length; j++) {
        const a = lane[i]
        const b = lane[j]
        if (!starts.has(a.id) && !starts.has(b.id)) continue
        const [left, right] = a.start <= b.start ? [a, b] : [b, a]
        const before = overlap(left, left.start, right, right.start)
        const after = overlap(
          left,
          starts.get(left.id) ?? left.start,
          right,
          starts.get(right.id) ?? right.start,
        )
        if (after > before + TIME_EPSILON) {
          return { ok: false, reason: 'A linked clip would collide on its track' }
        }
        if (after < before - TIME_EPSILON) {
          return { ok: false, reason: 'A linked clip would shorten a transition' }
        }
      }
    }
  }

  return { ok: true, moves: [...moves.values()] }
}

/** Overlap length of two clips at the given starts (0 when they are apart). */
function overlap(a: Clip, aStart: number, b: Clip, bStart: number): number {
  // The TRUE intersection, measured from both ends. A moved partner can pass a
  // neighbour's start, and measuring only `leftEnd - rightStart` would then
  // report an overlap the clips do not have (a clip that lands exactly against
  // its neighbour reads as a collision).
  const start = Math.max(aStart, bStart)
  const end = Math.min(aStart + a.duration, bStart + b.duration)
  return Math.max(0, end - start)
}

export interface JoinPair {
  previousId: string
  nextId: string
}

export type JoinPlan = { ok: true; pairs: JoinPair[] } | { ok: false; reason: string }

/**
 * Plans a join from a selection. The selection is resolved into link GROUPS
 * (never ids), so clicking one half of an A/V pair selects the whole pair and
 * cannot be joined with itself, while selecting two pairs joins both.
 */
export function planJoinSelection(doc: Doc, clipIds: readonly string[]): JoinPlan {
  const groups = selectionGroups(doc, clipIds)
  if (groups.length !== 2) {
    return { ok: false, reason: 'Select exactly two clips from the same source' }
  }
  const [first, second] = groups
  if (!first || !second) {
    return { ok: false, reason: 'Select exactly two clips from the same source' }
  }
  const startOf = (group: Clip[]) => Math.min(...group.map((clip) => clip.start))
  const [previous, next] = startOf(first) <= startOf(second) ? [first, second] : [second, first]
  return planJoinGroups(doc, previous, next)
}

/**
 * Plans a join from the two clamp ids a command carries. The command expands
 * both groups again, so a linked pair joins as one atomic batch or refuses.
 */
export function planJoinGroup(doc: Doc, clipId: string, nextId: string): JoinPlan {
  const a = findClip(doc, clipId)
  const b = findClip(doc, nextId)
  if (!a || !b) return { ok: false, reason: 'Unknown clip' }
  if (a.clip.linkId && a.clip.linkId === b.clip.linkId) {
    return { ok: false, reason: 'The clips are already linked to each other' }
  }
  const previous = linkedClips(doc, a.clip.id)
  const next = linkedClips(doc, b.clip.id)
  if (previous.length === 0 || next.length === 0) return { ok: false, reason: 'Unknown clip' }
  return planJoinGroups(doc, previous, next)
}

function planJoinGroups(doc: Doc, previousGroup: Clip[], nextGroup: Clip[]): JoinPlan {
  const paired = pairByTrack(doc, previousGroup, nextGroup)
  if (!paired.ok) return paired
  for (const pair of paired.pairs) {
    const previous = findClip(doc, pair.previousId)?.clip
    const next = findClip(doc, pair.nextId)?.clip
    if (!previous || !next) return { ok: false, reason: 'Unknown clip' }
    const reason = joinRefusal(previous, next)
    if (reason) return { ok: false, reason }
  }
  return { ok: true, pairs: paired.pairs }
}

/** One selectable group per `linkId`, or per clip id for an unlinked clip. */
function selectionGroups(doc: Doc, clipIds: readonly string[]): Clip[][] {
  const seen = new Set<string>()
  const groups: Clip[][] = []
  for (const id of clipIds) {
    const members = linkedClips(doc, id)
    if (members.length === 0) continue
    const key =
      members[0]?.linkId ??
      members
        .map((clip) => clip.id)
        .sort()
        .join('|')
    if (seen.has(key)) continue
    seen.add(key)
    groups.push(members)
  }
  return groups
}

/**
 * Pairs the two groups lane by lane. An A/V pair join needs the picture halve
 * with the picture halve and the sound halve with the sound halve, so a group
 * that is missing a lane counterpart refuses the whole batch rather than
 * leaving half of the pair behind.
 */
function pairByTrack(
  doc: Doc,
  previousGroup: Clip[],
  nextGroup: Clip[],
): { ok: true; pairs: JoinPair[] } | { ok: false; reason: string } {
  const lanes = (group: Clip[]): Map<string, Clip> | null => {
    const map = new Map<string, Clip>()
    for (const clip of group) {
      const owner = findClip(doc, clip.id)
      if (!owner) continue
      if (map.has(owner.track.id)) return null
      map.set(owner.track.id, clip)
    }
    return map
  }
  const previousLanes = lanes(previousGroup)
  const nextLanes = lanes(nextGroup)
  const mismatch = { ok: false, reason: 'The joined clips must sit on matching tracks' } as const
  if (!previousLanes || !nextLanes) return mismatch
  if (previousLanes.size !== nextLanes.size) return mismatch
  const pairs: JoinPair[] = []
  // Every lane must pair in the SAME direction. A group whose halves are offset
  // (one lane's pair runs A then B, another's runs B then A) would otherwise
  // survive the join with one lane's clip from each group, mixing the two link
  // groups instead of merging them.
  let direction = 0
  for (const [trackId, previous] of previousLanes) {
    const next = nextLanes.get(trackId)
    if (!next) return mismatch
    // Ties keep the group order; joinRefusal refuses them as an overlap.
    const order = previous.start <= next.start ? -1 : 1
    if (direction === 0) direction = order
    else if (direction !== order) {
      return { ok: false, reason: 'The linked halves are ordered differently' }
    }
    pairs.push(
      order < 0
        ? { previousId: previous.id, nextId: next.id }
        : { previousId: next.id, nextId: previous.id },
    )
  }
  return { ok: true, pairs }
}

/**
 * The strict v1 join contract. Every condition that would silently lose or
 * reinterpret data refuses with a stated reason; nothing here repairs a clip.
 */
function joinRefusal(previous: Clip, next: Clip): string | null {
  if (previous.id === next.id) return 'A clip cannot be joined with itself'
  if (previous.text !== undefined || next.text !== undefined) return 'Text clips cannot be joined'
  if (previous.sequenceId || next.sequenceId) return 'Compound clips cannot be joined'
  if (!previous.mediaId || previous.mediaId !== next.mediaId) {
    return 'The joined clips must share one source'
  }
  const gap = next.start - (previous.start + previous.duration)
  if (gap > TIME_EPSILON) return 'There is a gap between the clips'
  if (gap < -TIME_EPSILON) return 'The clips overlap'
  if (Math.abs((previous.speed ?? 1) - (next.speed ?? 1)) > TIME_EPSILON) {
    return 'The clips must play at the same speed'
  }
  if (!!previous.reverse !== !!next.reverse) return 'The clips must play in the same direction'
  if (Math.abs(sourceTimeAt(previous, previous.duration) - sourceTimeAt(next, 0)) > TIME_EPSILON) {
    return 'The clips must be continuous in the source'
  }
  if (previous.transitionOut || next.transitionOut) {
    return 'A clip with an outgoing transition cannot be joined'
  }
  if (hasCurves(previous) || hasCurves(next)) return 'Keyframed clips cannot be joined'
  for (const field of RETAINED_FIELDS) {
    if (!sameValue(field.read(previous), field.read(next))) {
      return `${field.label} differs between the clips`
    }
  }
  return null
}

/** Any clip-local or effect-local keyframe curve. Keyframe times are clip-local. */
function hasCurves(clip: Clip): boolean {
  const nonEmpty = (curves: Record<string, unknown[] | undefined> | undefined) =>
    !!curves && Object.values(curves).some((curve) => (curve?.length ?? 0) > 0)
  if (nonEmpty(clip.keyframes)) return true
  return (clip.effects ?? []).some((effect) => nonEmpty(effect.keyframes))
}

/**
 * Canonical effect shape for a join comparison (0.28.2): an effect id is
 * bookkeeping, and absent `enabled` reads as true. Everything else, including
 * numeric defaults and effect order, stays exactly as authored.
 */
function normalizeEffectForCompare(effect: EffectEntry): Record<string, unknown> {
  const { id: _id, enabled, ...rest } = effect
  return enabled === false ? { ...rest, enabled: false } : rest
}

/**
 * Properties the joined clip keeps from the PREVIOUS clip. When the next clip
 * differs in any of them the join would silently discard one side's settings,
 * so it refuses instead. `sound` and keyframes have their own rules above.
 */
const RETAINED_FIELDS: { label: string; read: (clip: Clip) => unknown }[] = [
  { label: 'Mute', read: (clip) => clip.muted === true },
  { label: 'Audio-only', read: (clip) => clip.audioOnly === true },
  { label: 'Gain', read: (clip) => clip.gain ?? 1 },
  { label: 'Pan', read: (clip) => clip.pan ?? 0 },
  { label: 'EQ', read: (clip) => (clip.eq ? [clip.eq.low, clip.eq.mid, clip.eq.high] : null) },
  { label: 'Compressor', read: (clip) => clip.compressor === true },
  { label: 'Denoise', read: (clip) => clip.denoise === true },
  { label: 'Opacity', read: (clip) => clip.opacity ?? 1 },
  // Transform (0.24.0) keeps its own fields, outside `Animation`: absent
  // rotation reads as 0 and absent flips as false, so an explicit default on
  // one side still joins. Keyframed clips refuse above, so only statics compare.
  { label: 'Rotation', read: (clip) => clip.rotation ?? 0 },
  { label: 'Stretch', read: (clip) => [clip.stretchX ?? 1, clip.stretchY ?? 1] },
  { label: 'Flip', read: (clip) => [clip.flipX === true, clip.flipY === true] },
  { label: 'Blend mode', read: (clip) => clip.blendMode ?? 'normal' },
  { label: 'Temperature', read: (clip) => clip.temperature ?? 0 },
  { label: 'Tint', read: (clip) => clip.tint ?? 0 },
  { label: 'LUT', read: (clip) => clip.lutId ?? null },
  {
    label: 'Effects',
    read: (clip) => clip.effects?.map(normalizeEffectForCompare) ?? null,
  },
  { label: 'Animation', read: (clip) => clip.animStatics ?? null },
  { label: 'Markers', read: (clip) => markerShape(clip.markers) },
]

/**
 * Marker identity is deliberately ignored: a split gives both halves the same
 * cues with FRESH ids, and the joined clip keeps the previous clip's list, so
 * an id-sensitive compare would refuse every marked split pair.
 */
function markerShape(markers: Marker[] | undefined): unknown {
  return (markers ?? []).map((marker) => [
    marker.time,
    marker.name ?? '',
    marker.color ?? '',
    marker.notes ?? '',
  ])
}

/** Structural equality that treats absent and undefined object fields alike. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || a === undefined || b === undefined) return false
  if (typeof a !== typeof b) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((value, index) => sameValue(value, b[index]))
  }
  if (typeof a === 'object') {
    const keys = (value: object) =>
      Object.keys(value)
        .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
        .sort()
    const aKeys = keys(a)
    const bKeys = keys(b as object)
    if (aKeys.length !== bKeys.length) return false
    return aKeys.every(
      (key, index) =>
        key === bKeys[index] &&
        sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    )
  }
  return false
}

/**
 * Availability of the two menu rows, which is the plan AND the lock gate.
 *
 * `clipGroupTracks` is the same resolver the commands' `LOCK_RULES` entries use
 * (every clip on the lane, plus each one's partners; both groups for a join),
 * so a row can never be enabled for an edit the command would refuse. The
 * planners themselves stay lock-free: locks are a command concern, and the
 * command is still the authority.
 */
export function canCloseGaps(doc: Doc, trackId: string): boolean {
  const found = findTrackIn(doc, trackId)
  if (!found) return false
  if (!planCloseGaps(doc, trackId).ok) return false
  const lanes = clipGroupTracks(
    doc,
    found.track.clips.map((clip) => clip.id),
  )
  return !findLockedTrack(lanes)
}

/** Join Clips availability for a selection: the plan lands and no lane is locked. */
export function canJoinClips(doc: Doc, clipIds: readonly string[]): boolean {
  const plan = planJoinSelection(doc, clipIds)
  if (!plan.ok) return false
  const [first] = plan.pairs
  if (!first) return false
  return !findLockedTrack(clipGroupTracks(doc, [first.previousId, first.nextId]))
}
