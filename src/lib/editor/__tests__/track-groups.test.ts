import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { applyCommand, applyCommands, EditorCommandError, TrackLockedError } from '../commands'
import { createDoc, createTextClip, createTrack } from '../factories'
import {
  groupFlagDisplay,
  groupFlagParticipants,
  groupTracks,
  nextTrackGroupName,
  planGroupFlag,
  sanitizeTrackGroupName,
  tracksShareSequence,
} from '../track-groups'
import { pruneEmptiedTracks } from '../tracks'
import { useEditorStore } from '../store'
import type { Doc, Track } from '../types'

function docWithTracks(): Doc {
  const doc = createDoc()
  doc.project.tracks = [
    createTrack('text', 1, { id: 'track_t1' }),
    createTrack('video', 1, { id: 'track_v1' }),
    createTrack('audio', 1, { id: 'track_a1' }),
  ]
  return doc
}

function groupCommand(trackIds: string[] = ['track_t1', 'track_v1'], name = 'Hero') {
  return { type: 'createTrackGroup' as const, name, trackIds }
}

describe('track group model (0.26.0)', () => {
  it('trims and bounds group names', () => {
    expect(sanitizeTrackGroupName('  Hero  ')).toBe('Hero')
    expect(sanitizeTrackGroupName('')).toBeUndefined()
    expect(sanitizeTrackGroupName('x'.repeat(65))).toBeUndefined()
    expect(sanitizeTrackGroupName('bad\u0000name')).toBeUndefined()
    expect(sanitizeTrackGroupName(12)).toBeUndefined()
  })

  it('generates the next free group name', () => {
    expect(nextTrackGroupName([])).toBe('Group 1')
    expect(nextTrackGroupName([{ id: 'grp_a', name: 'Group 1' }])).toBe('Group 2')
  })

  it('plans a mixed flag with the documented toggle rule', () => {
    const tracks: Track[] = [
      createTrack('video', 1, { id: 'a', muted: true }),
      createTrack('video', 2, { id: 'b' }),
    ]
    // One on, one off: turn all on.
    expect(planGroupFlag(tracks, 'muted')).toBe(true)
    expect(groupFlagDisplay(tracks, 'muted')).toBe('mixed')
    // All on: turn all off.
    tracks[1].muted = true
    expect(planGroupFlag(tracks, 'muted')).toBe(false)
    expect(groupFlagDisplay(tracks, 'muted')).toBe('on')
    // All off: turn all on.
    tracks[0].muted = false
    tracks[1].muted = false
    expect(planGroupFlag(tracks, 'muted')).toBe(true)
    expect(groupFlagDisplay(tracks, 'muted')).toBe('off')
  })

  it('solo has no participants on an all-video group', () => {
    const tracks = [createTrack('video', 1), createTrack('text', 1)]
    expect(planGroupFlag(tracks, 'solo')).toBeUndefined()
    expect(planGroupFlag(tracks, 'solo')).toBeUndefined()
    expect(tracksShareSequence(docWithTracks(), tracks)).toBe(true)
  })

  it('creates a group and assigns every member in one command', () => {
    const next = applyCommand(docWithTracks(), groupCommand(['track_t1', 'track_v1']))
    expect(next.project.trackGroups).toHaveLength(1)
    const group = next.project.trackGroups![0]
    expect(group.name).toBe('Hero')
    expect(group.id).toMatch(/^grp_/)
    expect(next.project.tracks.find((t) => t.id === 'track_t1')!.groupId).toBe(group.id)
    expect(next.project.tracks.find((t) => t.id === 'track_v1')!.groupId).toBe(group.id)
    expect(next.project.tracks.find((t) => t.id === 'track_a1')!.groupId).toBeUndefined()
    // Input is untouched.
    expect(docWithTracks().project.trackGroups).toBeUndefined()
  })

  it('refuses a duplicate name and a group spanning sequences', () => {
    const first = applyCommand(docWithTracks(), groupCommand())
    expect(() => applyCommand(first, groupCommand(['track_a1'], 'Hero'))).toThrow(/already exists/)
    const span = docWithTracks()
    span.project.sequences = [
      { id: 'seq_a', name: 'A', tracks: [createTrack('video', 3, { id: 'track_child' })] },
    ]
    expect(() => applyCommand(span, groupCommand(['track_v1', 'track_child']))).toThrow(
      /span sequences/,
    )
  })

  it('renames a group and refuses a collision', () => {
    const first = applyCommand(docWithTracks(), groupCommand())
    const group = first.project.trackGroups![0]
    const renamed = applyCommand(first, {
      type: 'renameTrackGroup',
      groupId: group.id,
      name: ' Intro ',
    })
    expect(renamed.project.trackGroups![0].name).toBe('Intro')
    const second = applyCommand(renamed, groupCommand(['track_a1'], 'Other'))
    const other = second.project.trackGroups!.find((g) => g.name === 'Other')!
    expect(() =>
      applyCommand(second, { type: 'renameTrackGroup', groupId: other.id, name: 'Intro' }),
    ).toThrow(/already exists/)
  })

  it('moves a track between groups and drops a group left empty', () => {
    const first = applyCommand(docWithTracks(), groupCommand(['track_t1']))
    const hero = first.project.trackGroups![0]
    const second = applyCommand(first, groupCommand(['track_a1'], 'Audio'))
    const audio = second.project.trackGroups!.find((g) => g.name === 'Audio')!
    const moved = applyCommand(second, {
      type: 'addTrackToGroup',
      groupId: audio.id,
      trackId: 'track_t1',
    })
    expect(moved.project.tracks.find((t) => t.id === 'track_t1')!.groupId).toBe(audio.id)
    // Hero lost its only remaining member and disappears.
    expect(moved.project.trackGroups!.map((g) => g.name)).toEqual(['Audio'])
    expect(hero.id).not.toBe(audio.id)
  })

  it('removes a track from a group, dropping the group when it empties', () => {
    const first = applyCommand(docWithTracks(), groupCommand(['track_t1']))
    const removed = applyCommand(first, { type: 'removeTrackFromGroup', trackId: 'track_t1' })
    expect(removed.project.tracks[0].groupId).toBeUndefined()
    expect(removed.project.trackGroups).toBeUndefined()
  })

  it('removing every member track drops the empty group', () => {
    const first = applyCommand(docWithTracks(), groupCommand(['track_v1', 'track_a1'], 'Hero'))
    const group = first.project.trackGroups![0]
    expect(group.name).toBe('Hero')
    const afterOne = applyCommand(first, { type: 'removeTrack', trackId: 'track_v1' })
    expect(afterOne.project.trackGroups).toHaveLength(1)
    const afterBoth = applyCommand(afterOne, { type: 'removeTrack', trackId: 'track_a1' })
    expect(afterBoth.project.trackGroups).toBeUndefined()
    expect(afterBoth.project.tracks.every((track) => track.groupId === undefined)).toBe(true)
    // The freed name is reusable immediately.
    const regrouped = applyCommand(afterBoth, {
      type: 'createTrackGroup',
      name: 'Hero',
      trackIds: [afterBoth.project.tracks[0].id],
    })
    expect(regrouped.project.trackGroups).toHaveLength(1)
    expect(regrouped.project.trackGroups![0].name).toBe('Hero')
  })

  it('pruning an emptied member track drops the empty group', () => {
    const base = docWithTracks()
    base.project.tracks.find((t) => t.id === 'track_v1')!.clips = [
      { id: 'clip_v', start: 0, duration: 1, inPoint: 0 },
    ]
    const grouped = applyCommand(base, groupCommand(['track_v1'], 'Solo Lane'))
    expect(grouped.project.trackGroups).toHaveLength(1)
    const emptied: Doc = {
      ...grouped,
      project: {
        ...grouped.project,
        tracks: grouped.project.tracks.map((track) =>
          track.id === 'track_v1' ? { ...track, clips: [] } : track,
        ),
      },
    }
    const pruned = pruneEmptiedTracks(grouped, emptied)
    expect(pruned.project.tracks.some((track) => track.id === 'track_v1')).toBe(false)
    expect(pruned.project.trackGroups).toBeUndefined()
  })

  it('hidden has no participants on an audio-only group', () => {
    const audio = [createTrack('audio', 1, { id: 'a1' }), createTrack('audio', 2, { id: 'a2' })]
    expect(groupFlagParticipants(audio, 'hidden')).toHaveLength(0)
    expect(planGroupFlag(audio, 'hidden')).toBeUndefined()
    expect(groupFlagDisplay(audio, 'hidden')).toBe('off')
    // Mixed groups hide video and text only; audio lanes keep no visible flag.
    const mixed = [createTrack('video', 1, { id: 'v1' }), createTrack('audio', 1, { id: 'a1' })]
    expect(groupFlagParticipants(mixed, 'hidden').map((t) => t.id)).toEqual(['v1'])
    const first = applyCommand(docWithTracks(), groupCommand(['track_v1', 'track_a1'], 'Mix'))
    const group = first.project.trackGroups![0]
    const next = applyCommand(first, {
      type: 'setTrackGroupFlag',
      groupId: group.id,
      flag: 'hidden',
      value: true,
    })
    expect(next.project.tracks.find((t) => t.id === 'track_v1')!.visible).toBe(false)
    expect(next.project.tracks.find((t) => t.id === 'track_a1')!.visible).toBeUndefined()
  })

  it('refuses hide on a group with no video or text members', () => {
    const first = applyCommand(docWithTracks(), groupCommand(['track_a1'], 'Audio'))
    const group = first.project.trackGroups![0]
    expect(() =>
      applyCommand(first, {
        type: 'setTrackGroupFlag',
        groupId: group.id,
        flag: 'hidden',
        value: true,
      }),
    ).toThrow(/video.*text|Hide applies/)
  })

  it('validates hostile group command payloads', () => {
    // Duplicate track ids collapse to one membership, never two.
    const dup = applyCommand(docWithTracks(), {
      type: 'createTrackGroup',
      name: 'Dup',
      trackIds: ['track_v1', 'track_v1'],
    })
    expect(groupTracks(dup.project.tracks, dup.project.trackGroups![0].id)).toHaveLength(1)

    expect(() =>
      applyCommand(docWithTracks(), { type: 'createTrackGroup', name: 'Empty', trackIds: [] }),
    ).toThrow(/at least one track/)
    const first = applyCommand(docWithTracks(), groupCommand())
    expect(() => applyCommand(first, groupCommand(['track_a1'], 'hero'))).toThrow(/already exists/)
    expect(() =>
      applyCommand(docWithTracks(), {
        type: 'createTrackGroup',
        name: 'x'.repeat(65),
        trackIds: ['track_v1'],
      }),
    ).toThrow(/invalid/)
    expect(() =>
      applyCommand(docWithTracks(), {
        type: 'createTrackGroup',
        name: 'bad\u0000name',
        trackIds: ['track_v1'],
      }),
    ).toThrow(/invalid/)
    expect(() =>
      applyCommand(first, { type: 'addTrackToGroup', groupId: 'grp_missing', trackId: 'track_a1' }),
    ).toThrow(/Unknown group/)
    expect(() => applyCommand(first, { type: 'removeTrackGroup', groupId: 'grp_missing' })).toThrow(
      /Unknown group/,
    )
  })

  it('removing a group leaves tracks and clips intact', () => {
    const doc = docWithTracks()
    doc.project.tracks[0].clips = [createTextClip({ id: 'clip_text', text: 'Hello' })]
    const first = applyCommand(doc, groupCommand())
    const group = first.project.trackGroups![0]
    const removed = applyCommand(first, { type: 'removeTrackGroup', groupId: group.id })
    expect(removed.project.trackGroups).toBeUndefined()
    expect(removed.project.tracks).toHaveLength(3)
    expect(removed.project.tracks[0].clips).toHaveLength(1)
    expect(removed.project.tracks.every((track) => track.groupId === undefined)).toBe(true)
  })

  it('writes mute, hide, lock, and audio-only solo to every participant', () => {
    const first = applyCommand(docWithTracks(), groupCommand(['track_v1', 'track_a1'], 'Mix'))
    const group = first.project.trackGroups![0]
    let next = applyCommand(first, {
      type: 'setTrackGroupFlag',
      groupId: group.id,
      flag: 'muted',
      value: true,
    })
    expect(next.project.tracks.find((t) => t.id === 'track_v1')!.muted).toBe(true)
    expect(next.project.tracks.find((t) => t.id === 'track_a1')!.muted).toBe(true)

    next = applyCommand(next, {
      type: 'setTrackGroupFlag',
      groupId: group.id,
      flag: 'hidden',
      value: true,
    })
    expect(next.project.tracks.find((t) => t.id === 'track_v1')!.visible).toBe(false)
    // Audio has no eyeball and audibility ignores visibility: hide skips it.
    expect(next.project.tracks.find((t) => t.id === 'track_a1')!.visible).toBeUndefined()

    next = applyCommand(next, {
      type: 'setTrackGroupFlag',
      groupId: group.id,
      flag: 'locked',
      value: true,
    })
    expect(
      next.project.tracks
        .filter((track) => track.id === 'track_v1' || track.id === 'track_a1')
        .every((track) => track.locked === true),
    ).toBe(true)

    next = applyCommand(next, {
      type: 'setTrackGroupFlag',
      groupId: group.id,
      flag: 'solo',
      value: true,
    })
    expect(next.project.tracks.find((t) => t.id === 'track_a1')!.solo).toBe(true)
    expect(next.project.tracks.find((t) => t.id === 'track_v1')!.solo).toBeUndefined()
  })

  it('refuses solo on a group with no audio members', () => {
    const first = applyCommand(docWithTracks(), groupCommand(['track_t1', 'track_v1']))
    const group = first.project.trackGroups![0]
    expect(() =>
      applyCommand(first, {
        type: 'setTrackGroupFlag',
        groupId: group.id,
        flag: 'solo',
        value: true,
      }),
    ).toThrow(/audio/)
  })

  it('allows grouping and unlocking a locked track', () => {
    const doc = docWithTracks()
    doc.project.tracks[1].locked = true
    const first = applyCommand(doc, groupCommand(['track_v1', 'track_a1']))
    const group = first.project.trackGroups![0]
    const unlocked = applyCommand(first, {
      type: 'setTrackGroupFlag',
      groupId: group.id,
      flag: 'locked',
      value: false,
    })
    expect(unlocked.project.tracks.every((track) => track.locked !== true)).toBe(true)
  })

  it('refuses a group command it cannot resolve', () => {
    expect(() =>
      applyCommand(docWithTracks(), groupCommand(['track_missing', 'track_v1'])),
    ).toThrow(EditorCommandError)
    const first = applyCommand(docWithTracks(), groupCommand())
    expect(() =>
      applyCommand(first, { type: 'renameTrackGroup', groupId: 'grp_missing', name: 'X' }),
    ).toThrow(/Unknown group/)
    const group = first.project.trackGroups![0]
    expect(() =>
      applyCommand(first, {
        type: 'setTrackGroupFlag',
        groupId: group.id,
        flag: 'bogus' as never,
        value: true,
      }),
    ).toThrow(/Unknown group flag/)
  })

  it('selects every clip on every member track, expanding links', () => {
    const doc = docWithTracks()
    doc.project.tracks[0].clips = [createTextClip({ id: 'clip_text', text: 'Hello' })]
    doc.project.tracks[1].clips = [{ id: 'clip_v', start: 0, duration: 1, inPoint: 0 }]
    const first = applyCommand(doc, groupCommand())
    const group = first.project.trackGroups![0]
    useEditorStore.getState().replaceDoc(first)
    useEditorStore.getState().selectTrackGroup(group.id)
    expect(useEditorStore.getState().selections.sort()).toEqual(['clip_text', 'clip_v'])
  })

  it('compound creation leaves its new sequence tracks ungrouped', () => {
    const doc = docWithTracks()
    doc.project.tracks[0].clips = [createTextClip({ id: 'clip_text', text: 'Hello' })]
    const first = applyCommand(doc, groupCommand(['track_t1', 'track_v1']))
    const next = applyCommand(first, {
      type: 'createCompoundClip',
      clipIds: ['clip_text'],
      trackId: 'track_v1',
      name: 'Nested',
    })
    expect(next.project.sequences).toHaveLength(1)
    expect(next.project.sequences![0].tracks.every((track) => track.groupId === undefined)).toBe(
      true,
    )
  })

  it('keeps clip edits on a locked group member behind the normal lock gate', () => {
    const doc = docWithTracks()
    doc.project.tracks[0].clips = [createTextClip({ id: 'clip_text', text: 'Hello' })]
    doc.project.tracks[0].locked = true
    const first = applyCommand(doc, groupCommand(['track_t1', 'track_v1', 'track_a1']))
    const group = first.project.trackGroups![0]
    // Group metadata is control, not a clip edit.
    expect(first.project.tracks.every((t) => t.groupId === group.id)).toBe(true)
    expect(() =>
      applyCommand(first, { type: 'setTextContent', clipId: 'clip_text', text: 'Changed' }),
    ).toThrow(TrackLockedError)
  })

  it('locks the UI to the batch flag command and the group selection action', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/components/editor/timeline/TimelinePanel.tsx'),
      'utf8',
    )
    expect(source).toContain("type: 'setTrackGroupFlag'")
    expect(source).toContain("type: 'addTrackToGroup'")
    expect(source).toContain("type: 'removeTrackFromGroup'")
    expect(source).toContain('selectTrackGroup(group.id)')
    // No ad hoc flag writes in the header: group controls go through commands.
    expect(source).not.toMatch(/track\.(muted|locked|visible)\s*=(?!=)/)
  })

  it('finds member tracks by id in one owner list', () => {
    const doc = docWithTracks()
    const first = applyCommand(doc, groupCommand())
    const group = first.project.trackGroups![0]
    expect(groupTracks(first.project.tracks, group.id)).toHaveLength(2)
  })
})
