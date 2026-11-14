/**
 * track-groups.ts: pure membership and batch-flag planning for track groups
 * (0.26.0).
 *
 * A group is a shortcut, not an override layer. Its controls write the member
 * tracks' own `muted`/`solo`/`visible`/`locked` flags, so member state stays the
 * single source of truth and a member edited after a group action simply shows
 * a mixed state. No precedence table exists or is needed.
 */

import { TRACK_GROUP_NAME_MAX, TRACK_GROUPS_MAX } from './constants'
import type { Doc, Project, Track, TrackGroup } from './types'

/** The four member flags a group control can write. */
export type TrackGroupFlag = 'muted' | 'solo' | 'hidden' | 'locked'

export const TRACK_GROUP_FLAGS: readonly TrackGroupFlag[] = ['muted', 'solo', 'hidden', 'locked']

/** Group ids are opaque project-scoped keys. */
export function isValidTrackGroupId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 96 &&
    /^[A-Za-z0-9_-]+$/.test(value)
  )
}

/**
 * A display name from any trust boundary: trimmed, bounded, and free of control
 * characters. Returns undefined when the entry is unusable.
 */
export function sanitizeTrackGroupName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const name = raw.trim()
  if (!name || name.length > TRACK_GROUP_NAME_MAX) return undefined
  if (/[\u0000-\u001f\u007f]/.test(name)) return undefined
  return name
}

/** Validates one serialized or command-payload group entry. */
export function sanitizeTrackGroup(raw: unknown): TrackGroup | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const entry = raw as Record<string, unknown>
  if (!isValidTrackGroupId(entry.id)) return undefined
  const name = sanitizeTrackGroupName(entry.name)
  if (!name) return undefined
  return { id: entry.id, name }
}

/** The next available generated name ("Group 1", "Group 2", ...). */
export function nextTrackGroupName(groups: readonly TrackGroup[]): string {
  const taken = new Set(groups.map((group) => group.name.toLowerCase()))
  let index = 1
  while (taken.has(`group ${index}`)) index += 1
  return `Group ${index}`
}

export function trackGroupById(
  project: Project,
  groupId: string | undefined,
): TrackGroup | undefined {
  if (!groupId) return undefined
  return (project.trackGroups ?? []).find((group) => group.id === groupId)
}

/** Every track carrying `groupId` in one owner track list. */
export function groupTracks(tracks: readonly Track[], groupId: string): Track[] {
  return tracks.filter((track) => track.groupId === groupId)
}

export interface TrackGroupMembership {
  group: TrackGroup
  /** Owning sequence, undefined for the project root. */
  sequenceId?: string
  tracks: Track[]
}

/**
 * Resolves a group with its members and owning sequence. The first member in
 * doc order names the owner; a malformed mixed-sequence group returns only that
 * owner's members. Commands refuse a mixed group before writing, and hydration
 * clears the foreign members.
 */
export function trackGroupMembership(doc: Doc, groupId: string): TrackGroupMembership | undefined {
  const group = trackGroupById(doc.project, groupId)
  if (!group) return undefined
  const owners: Array<{ sequenceId?: string; tracks: readonly Track[] }> = [
    { tracks: doc.project.tracks },
    ...(doc.project.sequences ?? []).map((sequence) => ({
      sequenceId: sequence.id,
      tracks: sequence.tracks,
    })),
  ]
  for (const owner of owners) {
    const members = groupTracks(owner.tracks, groupId)
    if (members.length > 0) return { group, sequenceId: owner.sequenceId, tracks: members }
  }
  return undefined
}

/** The owner sequence of a group, or undefined when the group has no members. */
export function trackGroupOwner(doc: Doc, groupId: string): string | undefined {
  return trackGroupMembership(doc, groupId)?.sequenceId
}

/** IDs of every track carrying a group id, in doc order. */
export function groupedTrackIds(tracks: readonly Track[]): Set<string> {
  return new Set(tracks.filter((track) => track.groupId).map((track) => track.id))
}

/**
 * The member flags a group control actually owns. Solo is an audio-monitoring
 * feature, so it has no meaning on video or text lanes and targets audio
 * members only; hide targets picture lanes only (audio has no eyeball and
 * audibility ignores visibility), so an audio-only group has no hide
 * participants; mute and lock apply to every kind.
 */
export function groupFlagParticipants(tracks: readonly Track[], flag: TrackGroupFlag): Track[] {
  if (flag === 'solo') return tracks.filter((track) => track.kind === 'audio')
  if (flag === 'hidden') return tracks.filter((track) => track.kind !== 'audio')
  return [...tracks]
}

/** One member's current value for a flag. `hidden` is the inverse of visible. */
export function trackGroupFlagState(track: Track, flag: TrackGroupFlag): boolean {
  switch (flag) {
    case 'muted':
      return track.muted === true
    case 'solo':
      return track.solo === true
    case 'hidden':
      return track.visible === false
    case 'locked':
      return track.locked === true
  }
}

/**
 * The next value for a group control. If every participant already has the flag
 * on, the next toggle turns them all off; otherwise it turns them all on. An
 * empty participant set (solo on an all-video group, hide on an audio-only
 * group) has no meaningful next value and returns undefined so the UI can
 * hide or disable the control.
 */
export function planGroupFlag(tracks: readonly Track[], flag: TrackGroupFlag): boolean | undefined {
  const participants = groupFlagParticipants(tracks, flag)
  if (participants.length === 0) return undefined
  return !participants.every((track) => trackGroupFlagState(track, flag))
}

/** UI state for a group control: on, off, or mixed across members. */
export function groupFlagDisplay(
  tracks: readonly Track[],
  flag: TrackGroupFlag,
): 'on' | 'off' | 'mixed' {
  const participants = groupFlagParticipants(tracks, flag)
  if (participants.length === 0) return 'off'
  const on = participants.filter((track) => trackGroupFlagState(track, flag)).length
  if (on === 0) return 'off'
  return on === participants.length ? 'on' : 'mixed'
}

/**
 * Clears dangling group ids, resolves a group whose members span sequences by
 * keeping the first owner's members and clearing the rest, and drops groups
 * left with no members. Mutates the assembled project in place; the caller
 * either just hydrated it or is running a committed normalization.
 */
export function normalizeProjectTrackGroups(project: Project): void {
  const groups = project.trackGroups ?? []
  const known = new Set(groups.map((group) => group.id))
  const owners = new Map<string, string | undefined>()
  const lists: Array<{ sequenceId?: string; tracks: Track[] }> = [
    { tracks: project.tracks },
    ...(project.sequences ?? []).map((sequence) => ({
      sequenceId: sequence.id,
      tracks: sequence.tracks,
    })),
  ]
  for (const list of lists) {
    for (const track of list.tracks) {
      if (!track.groupId) continue
      if (!known.has(track.groupId)) {
        delete track.groupId
        continue
      }
      if (!owners.has(track.groupId)) owners.set(track.groupId, list.sequenceId)
    }
  }
  for (const list of lists) {
    for (const track of list.tracks) {
      if (!track.groupId) continue
      if (owners.get(track.groupId) !== list.sequenceId) delete track.groupId
    }
  }
  const used = new Set<string>()
  for (const list of lists) {
    for (const track of list.tracks) if (track.groupId) used.add(track.groupId)
  }
  const kept = groups.filter((group) => used.has(group.id))
  if (kept.length === 0) delete project.trackGroups
  else project.trackGroups = kept
}

/** True when two tracks share one owning sequence. */
export function tracksShareSequence(doc: Doc, tracks: readonly Track[]): boolean {
  const owner = new Map<string, string | undefined>()
  for (const track of tracks) {
    owner.set(track.id, findOwner(doc, track.id))
  }
  const values = [...owner.values()]
  return values.every((value) => value === values[0])
}

function findOwner(doc: Doc, trackId: string): string | undefined {
  if (doc.project.tracks.some((track) => track.id === trackId)) return undefined
  for (const sequence of doc.project.sequences ?? []) {
    if (sequence.tracks.some((track) => track.id === trackId)) return sequence.id
  }
  return undefined
}

/** Bounds on the number of groups a project may carry. */
export function trackGroupLimitReached(groups: readonly TrackGroup[]): boolean {
  return groups.length >= TRACK_GROUPS_MAX
}
