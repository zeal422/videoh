import { afterEach, describe, expect, it, vi } from 'vitest'

const toastMock = vi.hoisted(() => vi.fn())
const renderMock = vi.hoisted(() => vi.fn())
const probeMock = vi.hoisted(() => vi.fn())
const storeMock = vi.hoisted(() => vi.fn())

vi.mock('@/hooks/use-toast', () => ({ toast: toastMock }))
vi.mock('@/lib/editor/media/freeze-frame', () => ({
  renderFreezeFrame: renderMock,
  FreezeFrameError: class FreezeFrameError extends Error {},
}))
vi.mock('@/lib/editor/media/probe', () => ({ importFile: probeMock }))
vi.mock('@/lib/editor/media/persist', () => ({ storeMediaAsset: storeMock }))

import { freezeFrameAtPlayhead } from '@/hooks/editor/action-context'
import { applyCommands } from '../commands'
import {
  canFreezeFrame,
  commandsToFreezeFrame,
  hasOfflineVisibleFrame,
  hasVisibleFrame,
  planFreezeFrame,
} from '../freeze-plan'
import { createClip, createDoc, createMediaAsset, createShapeClip, createTrack } from '../factories'
import { useEditorStore } from '../store'
import { FREEZE_FRAME_DURATION } from '../constants'
import type { Clip, Doc, MediaAsset } from '../types'

const HASH = 'a'.repeat(64)

function stillAsset(partial: Partial<MediaAsset> = {}): MediaAsset {
  return createMediaAsset({
    id: 'media_source',
    kind: 'image',
    name: 'source.png',
    width: 640,
    height: 360,
    url: 'blob:source',
    file: new File(['source'], 'source.png', { type: 'image/png' }),
    ...partial,
  })
}

function docWithImage(partial: Partial<MediaAsset> = {}, trackExtra = {}): Doc {
  const doc = createDoc()
  doc.media = [stillAsset(partial)]
  const video = doc.project.tracks.find((track) => track.kind === 'video')!
  video.clips = [createClip({ id: 'clip_source', mediaId: 'media_source', start: 0, duration: 4 })]
  Object.assign(video, trackExtra)
  return doc
}

function resetStore(doc: Doc) {
  useEditorStore.setState({
    doc,
    past: [],
    future: [],
    selections: [],
    selection: null,
    playhead: 1,
    activeSequencePath: [],
    mediaCleanBlockReason: null,
  })
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('freeze plan', () => {
  it('accepts a visible clip at the playhead', () => {
    const doc = docWithImage()
    expect(planFreezeFrame(doc, [], 1)).toEqual({ ok: true })
    expect(canFreezeFrame(doc, [], 1)).toBe(true)
  })

  it('refuses an empty playhead, a hidden lane, and an audio-only lane', () => {
    const doc = docWithImage()
    expect(planFreezeFrame(doc, [], 5)).toEqual({ ok: false, reason: 'empty' })
    expect(planFreezeFrame(doc, [], Number.NaN)).toEqual({ ok: false, reason: 'empty' })

    const hidden = docWithImage({}, { visible: false })
    expect(planFreezeFrame(hidden, [], 1)).toEqual({ ok: false, reason: 'empty' })

    const audioOnly = createDoc()
    audioOnly.project.tracks = [createTrack('audio', 1)]
    audioOnly.project.tracks[0].clips = [
      createClip({ id: 'c', mediaId: 'm', start: 0, duration: 4 }),
    ]
    expect(planFreezeFrame(audioOnly, [], 1)).toEqual({ ok: false, reason: 'empty' })
  })

  it('counts a text clip as visible content', () => {
    const doc = createDoc()
    doc.project.tracks[0].clips = [
      createClip({ id: 'text', start: 0, duration: 4, text: 'Hello', style: {} as never }),
    ]
    expect(planFreezeFrame(doc, [], 1)).toEqual({ ok: true })
  })

  it('refuses an offline or absent visible source', () => {
    const offline = docWithImage({ missing: true })
    expect(planFreezeFrame(offline, [], 1)).toEqual({ ok: false, reason: 'offline' })
    expect(hasOfflineVisibleFrame(offline, offline.project.tracks, 1)).toBe(true)

    const empty = docWithImage({ url: '' })
    expect(planFreezeFrame(empty, [], 1)).toEqual({ ok: false, reason: 'offline' })

    const noAsset = docWithImage()
    noAsset.media = []
    expect(planFreezeFrame(noAsset, [], 1)).toEqual({ ok: false, reason: 'offline' })
  })

  it('ignores an offline clip that draws nothing at the playhead', () => {
    // A fully transparent offline clip contributes no pixels (the compositor
    // skips it), so the visible footage beneath it still freezes.
    const doc = docWithImage()
    doc.media.push(stillAsset({ id: 'media_gone', missing: true }))
    const video = doc.project.tracks.find((track) => track.kind === 'video')!
    video.clips.push(
      createClip({ id: 'clip_gone', mediaId: 'media_gone', start: 0, duration: 4, opacity: 0 }),
    )
    expect(planFreezeFrame(doc, [], 1)).toEqual({ ok: true })
    expect(hasOfflineVisibleFrame(doc, doc.project.tracks, 1)).toBe(false)
  })

  it('still refuses an offline clip that is even partly visible', () => {
    const doc = docWithImage()
    doc.media.push(stillAsset({ id: 'media_gone', missing: true }))
    const video = doc.project.tracks.find((track) => track.kind === 'video')!
    video.clips.push(
      createClip({ id: 'clip_gone', mediaId: 'media_gone', start: 0, duration: 4, opacity: 0.5 }),
    )
    expect(planFreezeFrame(doc, [], 1)).toEqual({ ok: false, reason: 'offline' })
  })

  it('refuses when the only clip at the playhead is fully transparent', () => {
    // The compositor skips a zero-opacity clip, so the render would encode the
    // black background as a still.
    const doc = docWithImage()
    doc.project.tracks[0].clips = [
      createClip({ id: 'clip_source', mediaId: 'media_source', start: 0, duration: 4, opacity: 0 }),
    ]
    expect(hasVisibleFrame(doc, doc.project.tracks, 1)).toBe(false)
    expect(planFreezeFrame(doc, [], 1)).toEqual({ ok: false, reason: 'empty' })
  })

  it('refuses when animated opacity reaches zero at the playhead', () => {
    const doc = docWithImage()
    doc.project.tracks[0].clips = [
      createClip({
        id: 'clip_source',
        mediaId: 'media_source',
        start: 0,
        duration: 4,
        keyframes: {
          opacity: [
            { time: 0, value: 1, interpolation: 'linear' },
            { time: 1, value: 0, interpolation: 'linear' },
          ],
        },
      }),
    ]
    expect(hasVisibleFrame(doc, doc.project.tracks, 1)).toBe(false)
    expect(planFreezeFrame(doc, [], 1)).toEqual({ ok: false, reason: 'empty' })
  })

  it('refuses an active-sequence path that names no sequence', () => {
    const doc = docWithImage()
    expect(planFreezeFrame(doc, ['missing_sequence'], 1)).toEqual({
      ok: false,
      reason: 'no-sequence',
    })
  })

  it('walks into a compound clip and checks its own local time', () => {
    const doc = createDoc()
    doc.media = [stillAsset()]
    doc.project.sequences = [
      {
        id: 'seq_child',
        name: 'Inside',
        tracks: [
          createTrack('video', 1, {
            id: 'child_v',
            clips: [
              createClip({ id: 'child_clip', mediaId: 'media_source', start: 2, duration: 2 }),
            ],
          }),
        ],
      },
    ]
    const root = doc.project.tracks.find((track) => track.kind === 'video')!
    root.clips = [createClip({ id: 'compound', sequenceId: 'seq_child', start: 10, duration: 4 })]
    // Container time 12 maps to child time 2.
    expect(hasVisibleFrame(doc, doc.project.tracks, 12)).toBe(true)
    expect(hasVisibleFrame(doc, doc.project.tracks, 11)).toBe(false)
    expect(planFreezeFrame(doc, [], 12)).toEqual({ ok: true })

    doc.media = []
    expect(planFreezeFrame(doc, [], 12)).toEqual({ ok: false, reason: 'offline' })
  })

  it('builds one batch: the asset, a new topmost video lane, and the still clip', () => {
    const doc = docWithImage()
    const asset = stillAsset({ id: 'media_still', url: 'blob:still' })
    const batch = commandsToFreezeFrame({ activeSequencePath: [], time: 1.5, asset })
    expect(batch.commands).toEqual([
      { type: 'addMediaAsset', asset },
      { type: 'addTrack', kind: 'video', trackId: batch.trackId, atIndex: 0 },
      {
        type: 'addClip',
        trackId: batch.trackId,
        clip: expect.objectContaining({
          id: batch.clipId,
          mediaId: 'media_still',
          start: 1.5,
          duration: FREEZE_FRAME_DURATION,
          inPoint: 0,
        }),
      },
    ])
    // The still lands on its own new lane even when the source lane is locked:
    // execute the batch against a doc whose source track is locked and check
    // the still is on the new track while the source clip is untouched.
    const locked = docWithImage()
    locked.project.tracks[0].locked = true
    const applied = applyCommands(locked, batch.commands)
    expect(applied.project.tracks).toHaveLength(3)
    expect(applied.project.tracks[0].clips).toHaveLength(1)
    expect(applied.project.tracks[0].clips[0].mediaId).toBe('media_still')
    expect(applied.project.tracks[1].locked).toBe(true)
    expect(applied.project.tracks[1].clips[0].id).toBe('clip_source')
  })

  it('adds the required sequence id when a compound sequence is open', () => {
    const doc = docWithImage()
    doc.project.sequences = [{ id: 'seq_child', name: 'Inside', tracks: [createTrack('video')] }]
    const batch = commandsToFreezeFrame({
      activeSequencePath: ['seq_child'],
      time: 1,
      asset: stillAsset(),
    })
    expect(batch.commands[1]).toEqual({
      type: 'addTrack',
      kind: 'video',
      trackId: batch.trackId,
      atIndex: 0,
      sequenceId: 'seq_child',
    })
  })
})

describe('freeze action', () => {
  it('refuses before rendering when nothing is visible', async () => {
    resetStore(docWithImage())
    useEditorStore.setState({ playhead: 9 })
    await freezeFrameAtPlayhead()
    expect(renderMock).not.toHaveBeenCalled()
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Freeze Frame is unavailable' }),
    )
  })

  it('adds the still on a new top track, selects it, and undoes as one batch', async () => {
    const doc = docWithImage()
    resetStore(doc)
    const still = stillAsset({ id: 'media_still', name: 'Freeze Frame.png', contentHash: HASH })
    renderMock.mockResolvedValue(new File(['png'], 'Freeze Frame.png', { type: 'image/png' }))
    probeMock.mockResolvedValue(still)
    storeMock.mockResolvedValue({ asset: still, stored: true })

    await freezeFrameAtPlayhead()

    const state = useEditorStore.getState()
    expect(state.doc.media.map((asset) => asset.id)).toEqual(['media_source', 'media_still'])
    expect(state.doc.project.tracks).toHaveLength(3)
    expect(state.doc.project.tracks[0].kind).toBe('video')
    expect(state.doc.project.tracks[0].clips).toHaveLength(1)
    const clip = state.doc.project.tracks[0].clips[0]
    expect(clip.start).toBe(1)
    expect(clip.duration).toBe(FREEZE_FRAME_DURATION)
    expect(clip.mediaId).toBe('media_still')
    expect(state.selections).toEqual([clip.id])
    expect(state.playhead).toBe(1)
    // The source lane still holds the original clip.
    expect(state.doc.project.tracks[1].clips[0].id).toBe('clip_source')

    useEditorStore.getState().undo()
    const undone = useEditorStore.getState().doc
    expect(undone.media.map((asset) => asset.id)).toEqual(['media_source'])
    expect(undone.project.tracks).toHaveLength(2)
  })

  it('places the still at the captured time even if the playhead moves during the render', async () => {
    resetStore(docWithImage())
    let release!: (file: File) => void
    renderMock.mockReturnValue(
      new Promise<File>((resolve) => {
        release = resolve
      }),
    )
    const still = stillAsset({ id: 'media_still', contentHash: HASH })
    probeMock.mockResolvedValue(still)
    storeMock.mockResolvedValue({ asset: still, stored: true })

    const pending = freezeFrameAtPlayhead()
    useEditorStore.setState({ playhead: 3 })
    release(new File(['png'], 'Freeze Frame.png', { type: 'image/png' }))
    await pending

    const clip = useEditorStore.getState().doc.project.tracks[0].clips[0]
    expect(clip.start).toBe(1)
    expect(useEditorStore.getState().playhead).toBe(3)
  })

  it('adds nothing when the active sequence changed during the render', async () => {
    const doc = docWithImage()
    doc.project.sequences = [{ id: 'seq_other', name: 'Other', tracks: [createTrack('video')] }]
    resetStore(doc)
    let release!: (file: File) => void
    renderMock.mockReturnValue(
      new Promise<File>((resolve) => {
        release = resolve
      }),
    )
    const pending = freezeFrameAtPlayhead()
    useEditorStore.setState({ activeSequencePath: ['seq_other'] })
    release(new File(['png'], 'Freeze Frame.png', { type: 'image/png' }))
    await pending
    expect(useEditorStore.getState().doc.media).toHaveLength(1)
    expect(probeMock).not.toHaveBeenCalled()
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ description: expect.stringContaining('active sequence changed') }),
    )
  })

  it('adds nothing when the project changed during the render', async () => {
    resetStore(docWithImage())
    let release!: (file: File) => void
    renderMock.mockReturnValue(
      new Promise<File>((resolve) => {
        release = resolve
      }),
    )
    const pending = freezeFrameAtPlayhead()
    const replacement = createDoc()
    useEditorStore.setState({
      doc: replacement,
      projectEpoch: useEditorStore.getState().projectEpoch + 1,
    })
    release(new File(['png'], 'Freeze Frame.png', { type: 'image/png' }))
    await pending

    expect(useEditorStore.getState().doc).toBe(replacement)
    expect(useEditorStore.getState().doc.media).toEqual([])
    expect(probeMock).not.toHaveBeenCalled()
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ description: expect.stringContaining('project changed') }),
    )
  })

  it('reports a render failure and adds nothing', async () => {
    const doc = docWithImage()
    resetStore(doc)
    renderMock.mockRejectedValue(new Error('decode failed'))
    await freezeFrameAtPlayhead()
    expect(useEditorStore.getState().doc).toBe(doc)
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Freeze Frame failed', variant: 'destructive' }),
    )
  })

  it('revokes the still URL when the batch is refused', async () => {
    resetStore(docWithImage())
    renderMock.mockResolvedValue(new File(['png'], 'Freeze Frame.png', { type: 'image/png' }))
    const still = stillAsset({ id: 'media_still', url: 'blob:still' })
    probeMock.mockResolvedValue({ ...still, contentHash: HASH })
    storeMock.mockResolvedValue({ asset: still, stored: true })
    const revoke = vi.fn()
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke })
    const apply = vi.spyOn(useEditorStore.getState(), 'apply').mockReturnValue(false)

    await freezeFrameAtPlayhead()

    expect(revoke).toHaveBeenCalledWith('blob:still')
    apply.mockRestore()
  })

  it('adds a session-only still with a warning when the store write fails', async () => {
    resetStore(docWithImage())
    renderMock.mockResolvedValue(new File(['png'], 'Freeze Frame.png', { type: 'image/png' }))
    const still = stillAsset({ id: 'media_still' })
    probeMock.mockResolvedValue({ ...still, contentHash: HASH })
    storeMock.mockResolvedValue({ asset: still, stored: false, warning: 'Could not store' })

    await freezeFrameAtPlayhead()

    expect(useEditorStore.getState().doc.media[1].contentHash).toBeUndefined()
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Media is session-only' }),
    )
  })
})

describe('shapes in the Freeze Frame offline scan (0.28.2)', () => {
  function docWithShape(partial: Partial<Clip> = {}): Doc {
    const doc = createDoc()
    const video = doc.project.tracks.find((track) => track.kind === 'video')!
    video.clips = [createShapeClip({ id: 'shape_top', start: 0, duration: 4, ...partial })]
    return doc
  }

  it('a visible shape is not offline', () => {
    const doc = docWithShape()
    expect(hasOfflineVisibleFrame(doc, doc.project.tracks, 1)).toBe(false)
    expect(planFreezeFrame(doc, [], 1)).toEqual({ ok: true })
  })

  it('a shape inside a compound is not offline', () => {
    const doc = createDoc()
    doc.project.sequences = [
      {
        id: 'seq_shape',
        name: 'Shapes',
        tracks: [
          createTrack('video', 1, {
            id: 'shape_track',
            clips: [createShapeClip({ id: 'shape_child', start: 0, duration: 2 })],
          }),
        ],
      },
    ]
    const root = doc.project.tracks.find((track) => track.kind === 'video')!
    root.clips = [createClip({ id: 'compound', sequenceId: 'seq_shape', start: 0, duration: 4 })]
    expect(hasOfflineVisibleFrame(doc, doc.project.tracks, 1)).toBe(false)
    expect(planFreezeFrame(doc, [], 1)).toEqual({ ok: true })
  })

  it('a zero-opacity shape is not a visible frame', () => {
    const doc = docWithShape({ opacity: 0 })
    expect(hasVisibleFrame(doc, doc.project.tracks, 1)).toBe(false)
    expect(planFreezeFrame(doc, [], 1)).toEqual({ ok: false, reason: 'empty' })
  })

  it('a missing-media clip is still offline', () => {
    const doc = docWithImage()
    doc.media[0].missing = true
    expect(hasOfflineVisibleFrame(doc, doc.project.tracks, 1)).toBe(true)
    expect(planFreezeFrame(doc, [], 1)).toEqual({ ok: false, reason: 'offline' })
  })
})
