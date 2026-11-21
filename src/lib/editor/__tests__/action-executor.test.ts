import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { executeAction, type ActionContext } from '../action-executor'
import { clearClipboard, copyClips } from '../clipboard'
import { createClip, createDoc, createMediaAsset, createTrack } from '../factories'

/**
 * The policy-free executor (0.20.0): one dispatch surface for the menu,
 * toolbar, and keyboard. The pure branch is tested with mock mutators and
 * callbacks; callers own applying a returned command batch.
 */

function makeContext(
  overrides: Partial<Omit<ActionContext, 'state'>> & {
    state?: Partial<ActionContext['state']>
  } = {},
): ActionContext {
  const base: ActionContext = {
    state: {
      doc: createDoc(),
      selections: [],
      selection: null,
      selectedMarker: null,
      playhead: 1,
      activeSequencePath: [],
      untargetedTracks: [],
      pxPerSec: 80,
      proxiesEnabled: false,
    },
    undo: vi.fn(),
    redo: vi.fn(),
    selectAll: vi.fn(),
    deselectAll: vi.fn(),
    selectMarker: vi.fn(),
    setPxPerSec: vi.fn(),
    toggleSnap: vi.fn(),
    setProxiesEnabled: vi.fn(),
    saveProject: vi.fn(),
    newProject: vi.fn(),
    openProject: vi.fn(),
    openBundle: vi.fn(),
    importMedia: vi.fn(),
    exportBundle: vi.fn(),
    openExport: vi.fn(),
    openGain: vi.fn(),
    freezeFrame: vi.fn(),
    editMarker: vi.fn(),
    seek: vi.fn(),
    zoomToFit: vi.fn(),
    notify: vi.fn(),
  }
  return { ...base, ...overrides, state: { ...base.state, ...(overrides.state ?? {}) } }
}

function clipDoc() {
  const media = createMediaAsset({ kind: 'video', name: 'v.mp4', duration: 10 })
  const track = createTrack('video', 1, {
    clips: [createClip({ id: 'c1', mediaId: media.id, start: 0, duration: 4 })],
  })
  const doc = createDoc()
  doc.project.tracks = [track]
  doc.media = [media]
  return { doc, media, track }
}

function audioDoc() {
  const media = createMediaAsset({ kind: 'audio', name: 'a.mp3', duration: 10 })
  const track = createTrack('audio', 1, {
    clips: [createClip({ id: 'a1', mediaId: media.id, start: 0, duration: 4 })],
  })
  const doc = createDoc()
  doc.project.tracks = [track]
  doc.media = [media]
  return { doc, media, track }
}

beforeEach(() => clearClipboard())

describe('executeAction — store-only and callback actions', () => {
  it('calls the injected store mutators for undo/redo/select/snap/proxies/zoom', () => {
    const ctx = makeContext()
    for (const action of [
      'edit.undo',
      'edit.redo',
      'edit.selectAll',
      'edit.deselectAll',
      'view.toggleSnap',
      'view.useProxies',
      'view.zoomIn',
      'view.zoomOut',
      'view.zoomFit',
    ] as const) {
      expect(executeAction(action, ctx).handled).toBe(true)
    }
    expect(ctx.undo).toHaveBeenCalled()
    expect(ctx.redo).toHaveBeenCalled()
    expect(ctx.selectAll).toHaveBeenCalled()
    expect(ctx.deselectAll).toHaveBeenCalled()
    expect(ctx.toggleSnap).toHaveBeenCalled()
    expect(ctx.setProxiesEnabled).toHaveBeenCalledWith(true)
    expect(ctx.setPxPerSec).toHaveBeenCalledTimes(2)
    expect(ctx.zoomToFit).toHaveBeenCalled()
  })

  it('calls the side-effect callbacks for file, gain, and marker-edit actions', () => {
    const ctx = makeContext()
    for (const action of [
      'file.saveProject',
      'file.newProject',
      'file.openProject',
      'file.importMedia',
      'file.exportMedia',
      'clip.audioGain',
      'marker.edit',
    ] as const) {
      expect(executeAction(action, ctx).handled).toBe(true)
    }
    expect(ctx.saveProject).toHaveBeenCalled()
    expect(ctx.newProject).toHaveBeenCalled()
    expect(ctx.openProject).toHaveBeenCalled()
    expect(ctx.importMedia).toHaveBeenCalled()
    expect(ctx.openExport).toHaveBeenCalled()
    expect(ctx.openGain).toHaveBeenCalled()
    expect(ctx.editMarker).toHaveBeenCalled()
  })

  it('leaves UI-owned actions to the caller', () => {
    const ctx = makeContext()
    for (const action of [
      'window.toggleMedia',
      'window.resetLayout',
      'help.shortcuts',
      'view.appearance',
      'sequence.settings',
    ] as const) {
      expect(executeAction(action, ctx)).toEqual({ handled: false, commands: null })
    }
  })
})

describe('executeAction — clip command batches', () => {
  it('splits the selection, or all tracks with no selection', () => {
    const { doc } = clipDoc()
    const selected = makeContext({
      state: { doc, selections: ['c1'], selection: 'c1', playhead: 2 },
    })
    expect(executeAction('clip.split', selected).commands).toEqual([
      { type: 'splitClip', clipId: 'c1', atTime: 2 },
    ])

    const all = makeContext({ state: { doc, selections: [], selection: null, playhead: 2 } })
    expect(executeAction('clip.split', all).commands).toEqual([
      { type: 'splitClip', clipId: 'c1', atTime: 2 },
    ])
  })

  it('builds duplicate/delete/ripple/cut batches', () => {
    const { doc } = clipDoc()
    const state = { doc, selections: ['c1'], selection: 'c1' }

    expect(executeAction('clip.duplicate', makeContext({ state })).commands).toEqual([
      expect.objectContaining({ type: 'addClip' }),
    ])
    expect(executeAction('clip.delete', makeContext({ state })).commands).toEqual([
      { type: 'deleteClip', clipId: 'c1' },
    ])
    expect(executeAction('clip.cut', makeContext({ state })).commands).toEqual([
      { type: 'deleteClip', clipId: 'c1' },
    ])

    const rippleDoc = clipDoc()
    rippleDoc.track.clips.push(
      createClip({ id: 'c2', mediaId: rippleDoc.media.id, start: 6, duration: 2 }),
    )
    const ripple = executeAction(
      'clip.rippleDelete',
      makeContext({
        state: {
          doc: rippleDoc.doc,
          selections: ['c1'],
          selection: 'c1',
          activeSequencePath: [],
        },
      }),
    )
    expect(ripple.commands).toContainEqual({ type: 'deleteClip', clipId: 'c1' })
    expect(ripple.commands).toContainEqual({
      type: 'moveClip',
      clipId: 'c2',
      trackId: rippleDoc.track.id,
      start: 2,
    })
  })

  it('links distinct groups and unlinks an existing group, with menu success toasts', () => {
    const { doc, media } = clipDoc()
    doc.project.tracks[0].clips.push(
      createClip({ id: 'c2', mediaId: media.id, start: 5, duration: 2 }),
    )
    const linked = executeAction(
      'clip.link',
      makeContext({ state: { doc, selections: ['c1', 'c2'], selection: 'c1' } }),
    )
    expect(linked.commands).toEqual([{ type: 'linkClips', clipIds: ['c1', 'c2'] }])
    expect(linked.successToast).toBe('Clips linked')

    const pair = clipDoc()
    pair.track.clips[0].linkId = 'link1'
    pair.track.clips.push(
      createClip({
        id: 'c2',
        mediaId: pair.media.id,
        start: 0,
        duration: 4,
        linkId: 'link1',
        audioOnly: true,
      }),
      createClip({ id: 'c3', mediaId: pair.media.id, start: 8, duration: 2 }),
    )
    const unlinked = executeAction(
      'clip.unlink',
      makeContext({ state: { doc: pair.doc, selections: ['c1'], selection: 'c1' } }),
    )
    expect(unlinked.commands).toEqual([{ type: 'unlinkClip', clipId: 'c1' }])
    expect(unlinked.successToast).toBe('Audio and video unlinked')

    // The menu's Link row never unlinks, even for a mixed selection that
    // contains an existing pair.
    const menuLinkedPair = executeAction(
      'clip.link',
      makeContext({ state: { doc: pair.doc, selections: ['c1'], selection: 'c1' } }),
    )
    expect(menuLinkedPair.commands).toBeNull()
    const menuMixed = executeAction(
      'clip.link',
      makeContext({ state: { doc: pair.doc, selections: ['c1', 'c3'], selection: 'c1' } }),
    )
    expect(menuMixed.commands).toEqual([{ type: 'linkClips', clipIds: ['c1', 'c3'] }])
    expect(menuMixed.successToast).toBe('Clips linked')

    // The keyboard's Ctrl+L is the toggle: the same linked selection unlinks.
    const toggled = executeAction(
      'keyboard.linkToggle',
      makeContext({ state: { doc: pair.doc, selections: ['c1'], selection: 'c1' } }),
    )
    expect(toggled.commands).toEqual([{ type: 'unlinkClip', clipId: 'c1' }])
    // Ctrl+L stays silent; the menu rows above are the ones that toast.
    expect(toggled.successToast).toBeUndefined()
  })

  it('copies to the clipboard, pastes back, and reports the copy', () => {
    const { doc } = clipDoc()
    const copyCtx = makeContext({ state: { doc, selections: ['c1'], selection: 'c1' } })
    const copied = executeAction('clip.copy', copyCtx)
    expect(copied.commands).toBeNull()
    expect(copied.handled).toBe(true)
    expect(copyCtx.notify).toHaveBeenCalledWith({ title: 'Copied 1 clip' })

    const pasteCtx = makeContext({
      state: { doc, playhead: 5, selections: [], selection: null },
    })
    const pasted = executeAction('clip.paste', pasteCtx)
    expect(pasted.commands).toEqual([expect.objectContaining({ type: 'addClip' })])
    clearClipboard()
  })

  it('toggles mute on the audio twin and ignores a stale selection', () => {
    const { doc } = audioDoc()
    const outcome = executeAction(
      'clip.toggleMute',
      makeContext({ state: { doc, selections: ['a1'], selection: 'a1' } }),
    )
    expect(outcome.commands).toEqual([{ type: 'setClipMuted', clipId: 'a1', muted: true }])

    const stale = makeContext({
      state: { doc, selections: ['missing'], selection: 'missing' },
    })
    expect(executeAction('clip.toggleMute', stale)).toEqual({ handled: true, commands: null })
  })

  it('builds add-text and add-track batches with the active sequence', () => {
    const text = executeAction('graphics.newText', makeContext({ state: { playhead: 2 } }))
    expect(text.commands?.map((c) => c.type)).toEqual(['addTrack', 'addClip'])

    const track = executeAction(
      'sequence.addVideoTrack',
      makeContext({ state: { activeSequencePath: ['seq1'] } }),
    )
    expect(track.commands).toEqual([
      expect.objectContaining({ type: 'addTrack', kind: 'video', sequenceId: 'seq1' }),
    ])
  })

  it('refuses a compound without clips with the existing toast', () => {
    const ctx = makeContext()
    const outcome = executeAction('sequence.createCompound', ctx)
    expect(outcome).toEqual({ handled: true, commands: null })
    expect(ctx.notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Cannot create a compound clip' }),
    )
  })
})

describe('executeAction — markers and keyboard Delete', () => {
  it('adds, deletes, and navigates markers', () => {
    const { doc } = clipDoc()
    doc.project.markers = [
      { id: 'm1', time: 2 },
      { id: 'm2', time: 8 },
    ]
    const add = executeAction(
      'marker.add',
      makeContext({ state: { doc, playhead: 3, selections: [], selection: null } }),
    )
    expect(add.commands).toEqual([expect.objectContaining({ type: 'addSequenceMarker' })])

    const del = executeAction(
      'marker.delete',
      makeContext({
        state: {
          doc,
          selectedMarker: { scope: 'sequence', markerId: 'm1' },
        },
      }),
    )
    expect(del.commands).toEqual([{ type: 'deleteSequenceMarker', markerId: 'm1' }])

    const next = makeContext({ state: { doc, playhead: 1 } })
    executeAction('marker.next', next)
    expect(next.seek).toHaveBeenCalledWith(2)
    const previous = makeContext({ state: { doc, playhead: 7 } })
    executeAction('marker.previous', previous)
    expect(previous.seek).toHaveBeenCalledWith(2)
  })

  it('keyboard Delete prefers a live marker, drops a stale one, then clips', () => {
    const { doc } = clipDoc()
    doc.project.markers = [{ id: 'm1', time: 2 }]
    const marker = makeContext({
      state: { doc, selectedMarker: { scope: 'sequence', markerId: 'm1' } },
    })
    expect(executeAction('keyboard.delete', marker).commands).toEqual([
      { type: 'deleteSequenceMarker', markerId: 'm1' },
    ])

    const stale = makeContext({
      state: {
        doc,
        selections: ['c1'],
        selection: 'c1',
        selectedMarker: { scope: 'sequence', markerId: 'gone' },
      },
    })
    expect(executeAction('keyboard.delete', stale).commands).toEqual([
      { type: 'deleteClip', clipId: 'c1' },
    ])
    expect(stale.selectMarker).toHaveBeenCalledWith(null)

    const clips = executeAction(
      'keyboard.delete',
      makeContext({ state: { doc, selections: ['c1'], selection: 'c1' } }),
    )
    expect(clips.commands).toEqual([{ type: 'deleteClip', clipId: 'c1' }])
  })
})

describe('executeAction: remaining branch matrix (0.29.0)', () => {
  it('dispatches every file callback exactly once', () => {
    const pairs = [
      ['file.newProject', 'newProject'],
      ['file.openProject', 'openProject'],
      ['file.openBundle', 'openBundle'],
      ['file.importMedia', 'importMedia'],
      ['file.saveProject', 'saveProject'],
      ['file.exportBundle', 'exportBundle'],
      ['file.exportMedia', 'openExport'],
    ] as const
    for (const [action, callback] of pairs) {
      const ctx = makeContext()
      expect(executeAction(action, ctx).handled).toBe(true)
      expect(ctx[callback]).toHaveBeenCalledTimes(1)
      for (const [, other] of pairs) {
        if (other !== callback) expect(ctx[other]).not.toHaveBeenCalled()
      }
    }
  })

  it('prefers the multi-selection, then the single selection, then nothing', () => {
    const { doc, media } = clipDoc()
    doc.project.tracks[0].clips.push(
      createClip({ id: 'c2', mediaId: media.id, start: 5, duration: 2 }),
    )
    const multi = executeAction(
      'clip.delete',
      makeContext({ state: { doc, selections: ['c1', 'c2'], selection: null } }),
    )
    expect(multi.commands?.map((command) => command.type)).toEqual(['deleteClip', 'deleteClip'])
    const single = executeAction(
      'clip.delete',
      makeContext({ state: { doc, selections: [], selection: 'c1' } }),
    )
    expect(single.commands).toEqual([{ type: 'deleteClip', clipId: 'c1' }])
    const none = executeAction(
      'clip.delete',
      makeContext({ state: { doc, selections: [], selection: null } }),
    )
    expect(none.commands).toBeNull()
  })

  it('adds a track without an active sequence', () => {
    const track = executeAction(
      'sequence.addAudioTrack',
      makeContext({ state: { activeSequencePath: [] } }),
    )
    expect(track.commands).toEqual([expect.objectContaining({ type: 'addTrack', kind: 'audio' })])
    expect(track.commands?.[0]).not.toHaveProperty('sequenceId')
  })

  it('handles empty clip selections across every batch action', () => {
    const ctx = makeContext()
    for (const action of [
      'clip.duplicate',
      'clip.rippleDelete',
      'clip.cut',
      'clip.copy',
      'clip.link',
      'clip.unlink',
      'keyboard.linkToggle',
      'clip.toggleMute',
    ] as const) {
      expect(executeAction(action, ctx)).toEqual({ handled: true, commands: null })
    }
  })

  it('refuses closeGaps without a primary, on an unknown clip, and on a locked lane', () => {
    const { doc, track } = clipDoc()
    expect(executeAction('clip.closeGaps', makeContext({ state: { doc } })).commands).toBeNull()
    expect(
      executeAction('clip.closeGaps', makeContext({ state: { doc, selections: ['gone'] } }))
        .commands,
    ).toBeNull()
    track.locked = true
    expect(
      executeAction('clip.closeGaps', makeContext({ state: { doc, selections: ['c1'] } })).commands,
    ).toBeNull()
  })

  it('closes gaps on the primary selection lane', () => {
    const { doc, media, track } = clipDoc()
    track.clips.push(createClip({ id: 'c2', mediaId: media.id, start: 6, duration: 2 }))
    expect(
      executeAction('clip.closeGaps', makeContext({ state: { doc, selections: ['c1'] } })).commands,
    ).toEqual([{ type: 'closeGaps', trackId: track.id }])
  })

  it('toasts the plural copy count for two clips', () => {
    const { doc, media } = clipDoc()
    doc.project.tracks[0].clips.push(
      createClip({ id: 'c2', mediaId: media.id, start: 5, duration: 2 }),
    )
    const ctx = makeContext({ state: { doc, selections: ['c1', 'c2'] } })
    executeAction('clip.copy', ctx)
    expect(ctx.notify).toHaveBeenCalledWith({ title: 'Copied 2 clips' })
  })

  it('creates a compound from a video selection', () => {
    const { doc } = clipDoc()
    const compound = executeAction(
      'sequence.createCompound',
      makeContext({ state: { doc, selections: ['c1'] } }),
    )
    expect(compound.handled).toBe(true)
    expect(compound.commands).not.toBeNull()
  })

  it('groups two distinct tracks and refuses a single-clip selection', () => {
    const media = createMediaAsset({ kind: 'video', name: 'v.mp4', duration: 10 })
    const first = createTrack('video', 1, {
      clips: [createClip({ id: 'g1', mediaId: media.id, start: 0, duration: 2 })],
    })
    const second = createTrack('video', 1, {
      clips: [createClip({ id: 'g2', mediaId: media.id, start: 0, duration: 2 })],
    })
    const doc = createDoc()
    doc.project.tracks = [first, second]
    doc.media = [media]
    // Duplicate and unknown ids must not produce extra lanes or crash.
    const grouped = executeAction(
      'sequence.groupTracks',
      makeContext({ state: { doc, selections: ['g1', 'g1', 'gone', 'g2'] } }),
    )
    expect(grouped.commands).toEqual([
      expect.objectContaining({
        type: 'createTrackGroup',
        name: 'Group 1',
        trackIds: [first.id, second.id],
      }),
    ])

    const thin = makeContext({ state: { doc, selections: ['g1'] } })
    expect(executeAction('sequence.groupTracks', thin).commands).toBeNull()
    expect(thin.notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Cannot group tracks' }),
    )
  })

  it('names a new track group after the ones already taken', () => {
    const media = createMediaAsset({ kind: 'video', name: 'v.mp4', duration: 10 })
    const first = createTrack('video', 1, {
      clips: [createClip({ id: 'n1', mediaId: media.id, start: 0, duration: 2 })],
    })
    const second = createTrack('video', 1, {
      clips: [createClip({ id: 'n2', mediaId: media.id, start: 0, duration: 2 })],
    })
    const doc = createDoc()
    doc.project.tracks = [first, second]
    doc.media = [media]
    doc.project.trackGroups = [{ id: 'tg1', name: 'Group 1' }]
    const grouped = executeAction(
      'sequence.groupTracks',
      makeContext({ state: { doc, selections: ['n1', 'n2'] } }),
    )
    expect(grouped.commands).toEqual([
      expect.objectContaining({ type: 'createTrackGroup', name: 'Group 2' }),
    ])
  })

  it('deletes a marker only when one is selected', () => {
    expect(executeAction('marker.delete', makeContext()).commands).toBeNull()
  })

  it('adds every shape kind', () => {
    const shapes = [
      ['graphics.addShape.rectangle', 'rectangle'],
      ['graphics.addShape.ellipse', 'ellipse'],
      ['graphics.addShape.triangle', 'triangle'],
      ['graphics.addShape.star', 'star'],
      ['graphics.addShape.polygon', 'polygon'],
      ['graphics.addShape.heart', 'heart'],
    ] as const
    for (const [action, kind] of shapes) {
      const outcome = executeAction(action, makeContext({ state: { playhead: 1 } }))
      expect(outcome.handled).toBe(true)
      expect(outcome.commands).not.toBeNull()
      expect(outcome.commands).toContainEqual(
        expect.objectContaining({
          type: 'addClip',
          clip: expect.objectContaining({ shape: expect.objectContaining({ kind }) }),
        }),
      )
    }
  })

  it('deletes keyboard clips from the single selection and as a no-op with none', () => {
    const { doc } = clipDoc()
    const single = executeAction(
      'keyboard.delete',
      makeContext({ state: { doc, selections: [], selection: 'c1' } }),
    )
    expect(single.commands).toEqual([{ type: 'deleteClip', clipId: 'c1' }])
    const none = executeAction(
      'keyboard.delete',
      makeContext({ state: { doc, selections: [], selection: null } }),
    )
    expect(none.commands).toBeNull()
  })

  it('joins clips, captures a freeze frame, and adds a text track', () => {
    const { doc, media } = clipDoc()
    doc.project.tracks[0].clips = [
      createClip({ id: 'j1', mediaId: media.id, start: 0, duration: 2, inPoint: 0 }),
      createClip({ id: 'j2', mediaId: media.id, start: 2, duration: 2, inPoint: 2 }),
    ]
    const joined = executeAction(
      'clip.joinClips',
      makeContext({ state: { doc, selections: ['j1', 'j2'] } }),
    )
    expect(joined.handled).toBe(true)
    expect(joined.commands).toEqual([{ type: 'joinClips', clipId: 'j1', nextId: 'j2' }])
    const freeze = makeContext()
    expect(executeAction('clip.freezeFrame', freeze).handled).toBe(true)
    expect(freeze.freezeFrame).toHaveBeenCalledTimes(1)
    expect(
      executeAction('sequence.addTextTrack', makeContext({ state: { activeSequencePath: ['s'] } }))
        .commands,
    ).toEqual([expect.objectContaining({ type: 'addTrack', kind: 'text', sequenceId: 's' })])
  })

  it('copies nothing for unknown ids and links separate keyboard selections', () => {
    const { doc, media } = clipDoc()
    doc.project.tracks[0].clips.push(
      createClip({ id: 'c2', mediaId: media.id, start: 5, duration: 2 }),
    )
    const unknown = makeContext({ state: { doc, selections: ['gone'] } })
    executeAction('clip.copy', unknown)
    expect(unknown.notify).not.toHaveBeenCalled()

    const separate = executeAction(
      'keyboard.linkToggle',
      makeContext({ state: { doc, selections: ['c1', 'c2'] } }),
    )
    expect(separate.commands).toEqual([{ type: 'linkClips', clipIds: ['c1', 'c2'] }])
    const single = executeAction(
      'keyboard.linkToggle',
      makeContext({ state: { doc, selections: ['c1'] } }),
    )
    expect(single.commands).toBeNull()
  })

  it('does not seek when there is no next marker', () => {
    const { doc } = clipDoc()
    const ctx = makeContext({ state: { doc, playhead: 0, selections: [] } })
    expect(executeAction('marker.next', ctx).handled).toBe(true)
    expect(ctx.seek).not.toHaveBeenCalled()
  })
})

describe('executor static locks', () => {
  const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

  it('the menu, toolbar, and keyboard all dispatch through the executor', () => {
    for (const path of [
      'src/components/editor/MenuBar.tsx',
      'src/components/editor/Toolbar.tsx',
      'src/hooks/editor/useEditorKeyboard.ts',
    ]) {
      const source = read(path)
      expect(source).toMatch(/executeAction/)
      expect(source).toMatch(/createActionContext/)
    }
  })

  it('no surface rebuilds the moved command batches inline', () => {
    for (const path of [
      'src/components/editor/MenuBar.tsx',
      'src/components/editor/Toolbar.tsx',
      'src/hooks/editor/useEditorKeyboard.ts',
    ]) {
      const source = read(path)
      for (const command of [
        'commandsToDeleteClips',
        'commandsToDuplicateClips',
        'commandsToSplitClipsAt',
        'commandsToSplitAllAt',
        'commandsToRippleDeleteClips',
        'commandsToCutClips',
        'commandsToPasteClips',
      ]) {
        expect(source, `${path} must not call ${command}`).not.toContain(command)
      }
    }
  })
})
