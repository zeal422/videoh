/**
 * Tests for the store's history semantics: command commit → undo → redo,
 * transient (drag) commits, and doc replacement.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { useEditorStore } from '../store'
import { createClip, createDoc, createMediaAsset } from '../factories'
import type { Doc } from '../types'

function videoTrackId(doc: Doc): string {
  return doc.project.tracks.filter((t) => t.kind === 'video')[0].id
}
function addTestClip() {
  const doc = useEditorStore.getState().doc
  const asset = createMediaAsset({
    kind: 'video',
    name: 'a.mp4',
    duration: 10,
    url: 'blob:a',
  })
  useEditorStore.getState().apply([
    { type: 'addMediaAsset', asset },
    {
      type: 'addClip',
      trackId: videoTrackId(doc),
      clip: createClip({ mediaId: asset.id, duration: 4 }),
    },
  ])
}

beforeEach(() => {
  useEditorStore.setState({
    doc: createDoc(),
    past: [],
    future: [],
    selections: [],
    selection: null,
    activeTool: 'select',
  })
})

describe('history', () => {
  it('apply pushes a snapshot; undo restores; redo re-applies', () => {
    const store = useEditorStore.getState()
    const empty = store.doc
    addTestClip()
    const withClip = useEditorStore.getState().doc
    expect(withClip.media).toHaveLength(1)
    expect(useEditorStore.getState().past).toHaveLength(1)

    useEditorStore.getState().undo()
    expect(useEditorStore.getState().doc).toEqual(empty)
    expect(useEditorStore.getState().future).toHaveLength(1)

    useEditorStore.getState().redo()
    expect(useEditorStore.getState().doc).toEqual(withClip)
  })

  it('multiple applies build a stack; undo unwinds in order', () => {
    addTestClip()
    useEditorStore.getState().apply({ type: 'setProjectSettings', patch: { name: 'A' } })
    useEditorStore.getState().apply({ type: 'setProjectSettings', patch: { name: 'B' } })
    expect(useEditorStore.getState().past).toHaveLength(3)
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().doc.project.name).toBe('A')
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().doc.project.name).toBe('Untitled Project')
    expect(useEditorStore.getState().doc.media).toHaveLength(1) // clip step still present
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().doc.media).toHaveLength(0)
    expect(useEditorStore.getState().past).toHaveLength(0)
  })

  it('a new apply clears the redo stack', () => {
    addTestClip()
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().future.length).toBeGreaterThan(0)
    useEditorStore.getState().apply({ type: 'setProjectSettings', patch: { name: 'X' } })
    expect(useEditorStore.getState().future).toHaveLength(0)
  })

  it('undo clears selection when the clip disappears', () => {
    addTestClip()
    const clipId =
      useEditorStore.getState().doc.project.tracks.flatMap((t) => t.clips)[0]?.id ?? null
    useEditorStore.getState().select(clipId)
    expect(useEditorStore.getState().selection).toBe(clipId)
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().selection).toBeNull()
  })
})

describe('transient gestures', () => {
  it('commitTransient creates exactly ONE history entry for a whole drag', () => {
    addTestClip()
    const store = useEditorStore.getState()
    const clipId = store.doc.project.tracks.flatMap((t) => t.clips)[0].id
    const trackId = videoTrackId(store.doc)

    store.beginTransient()
    store.applyTransient({ type: 'moveClip', clipId, trackId, start: 1 })
    store.applyTransient({ type: 'moveClip', clipId, trackId, start: 2 })
    store.applyTransient({ type: 'moveClip', clipId, trackId, start: 3 })
    expect(useEditorStore.getState().past).toHaveLength(1) // from addTestClip
    store.commitTransient()
    expect(useEditorStore.getState().past).toHaveLength(2)
    expect(useEditorStore.getState().doc.project.tracks.flatMap((t) => t.clips)[0].start).toBe(3)

    useEditorStore.getState().undo()
    expect(useEditorStore.getState().doc.project.tracks.flatMap((t) => t.clips)[0].start).toBe(0)
  })

  it('cancelTransient restores the base without history', () => {
    addTestClip()
    const store = useEditorStore.getState()
    const clipId = store.doc.project.tracks.flatMap((t) => t.clips)[0].id
    const trackId = videoTrackId(store.doc)
    store.beginTransient()
    store.applyTransient({ type: 'moveClip', clipId, trackId, start: 5 })
    store.cancelTransient()
    expect(useEditorStore.getState().doc.project.tracks.flatMap((t) => t.clips)[0].start).toBe(0)
    expect(useEditorStore.getState().past).toHaveLength(1)
  })

  it('commitTransient without changes records nothing', () => {
    addTestClip()
    const store = useEditorStore.getState()
    store.beginTransient()
    store.commitTransient()
    expect(useEditorStore.getState().past).toHaveLength(1)
  })
})

describe('replaceDoc', () => {
  it('swaps the doc as one undoable step and resets the playhead', () => {
    addTestClip()
    useEditorStore.getState().setPlayhead(2.5)
    const fresh = createDoc()
    const asset = createMediaAsset({
      kind: 'audio',
      name: 'x.mp3',
      duration: 5,
      url: 'blob:x',
    })
    fresh.media = [asset]
    useEditorStore.getState().replaceDoc(fresh)
    expect(useEditorStore.getState().doc.media[0].name).toBe('x.mp3')
    expect(useEditorStore.getState().playhead).toBe(0)
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().doc.project.name).toBe('Untitled Project')
  })
})

describe('multi-selection (Premiere shift/ctrl click)', () => {
  it('select sets ONE primary; selection mirrors selections[0]', () => {
    addTestClip()
    addTestClip()
    const clips = useEditorStore.getState().doc.project.tracks[0].clips
    useEditorStore.getState().select(clips[0].id)
    expect(useEditorStore.getState().selections).toEqual([clips[0].id])
    expect(useEditorStore.getState().selection).toBe(clips[0].id)
  })

  it('addSelection appends; toggleSelection removes when fully selected', () => {
    addTestClip()
    addTestClip()
    const clips = useEditorStore.getState().doc.project.tracks[0].clips
    const s = useEditorStore.getState()

    s.select(clips[0].id)
    useEditorStore.getState().addSelection(clips[1].id)
    expect(useEditorStore.getState().selections).toEqual([clips[0].id, clips[1].id])

    useEditorStore.getState().toggleSelection(clips[0].id)
    expect(useEditorStore.getState().selections).toEqual([clips[1].id])

    useEditorStore.getState().toggleSelection(clips[1].id)
    expect(useEditorStore.getState().selections).toEqual([])
  })

  it('selectAll selects every clip; deselectAll clears both fields', () => {
    addTestClip()
    addTestClip()
    useEditorStore.getState().selectAll()
    expect(useEditorStore.getState().selections).toHaveLength(2)
    expect(useEditorStore.getState().selection).toBe(useEditorStore.getState().selections[0])

    useEditorStore.getState().deselectAll()
    expect(useEditorStore.getState().selections).toEqual([])
    expect(useEditorStore.getState().selection).toBeNull()
  })

  it('undo drops only the selection members that vanished', () => {
    addTestClip()
    addTestClip()
    const clips = useEditorStore.getState().doc.project.tracks[0].clips
    useEditorStore.getState().selectAll()

    useEditorStore.getState().apply({ type: 'deleteClip', clipId: clips[0].id })
    expect(useEditorStore.getState().selections).toEqual([clips[1].id])

    useEditorStore.getState().undo()
    // clips[0] is back in the doc, but the restore only kept still-valid ids
    // at UNDO time — the pre-undo state had dropped it.
    expect(useEditorStore.getState().selections).toEqual([clips[1].id])
  })

  it('activeTool toggles between select and razor without touching history', () => {
    expect(useEditorStore.getState().activeTool).toBe('select')
    useEditorStore.getState().setActiveTool('razor')
    expect(useEditorStore.getState().activeTool).toBe('razor')
    expect(useEditorStore.getState().past).toHaveLength(0)
    useEditorStore.getState().setActiveTool('select')
    expect(useEditorStore.getState().activeTool).toBe('select')
  })
})
