/**
 * Tests for the store's history semantics: command commit → undo → redo,
 * transient (drag) commits, and doc replacement.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  activeTransientPointerId,
  currentTransientToken,
  isTransientActive,
  useEditorStore,
} from '../store'
import { createClip, createDoc, createMediaAsset, createTrack } from '../factories'
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
    selectedMarker: null,
    untargetedTracks: [],
    activeTool: 'select',
    dropMode: 'place',
    sourceAssetId: null,
    sourceIn: null,
    sourceOut: null,
    sourcePlayhead: 0,
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

  it('setKeyframeDefault is one history entry and undo restores the previous default', () => {
    // The defaults map lives inside the Doc, so this is the generic history
    // path; the test pins that the command really goes through it (one entry
    // per press, no stray mutation of the snapshot).
    const store = useEditorStore.getState()
    store.apply({ type: 'setKeyframeDefault', property: 'opacity', interpolation: 'easeIn' })
    expect(useEditorStore.getState().doc.project.keyframeDefaults).toEqual({ opacity: 'easeIn' })
    expect(useEditorStore.getState().past).toHaveLength(1)

    useEditorStore
      .getState()
      .apply({ type: 'setKeyframeDefault', property: 'opacity', interpolation: 'easeOut' })
    expect(useEditorStore.getState().doc.project.keyframeDefaults).toEqual({ opacity: 'easeOut' })
    expect(useEditorStore.getState().past).toHaveLength(2)

    useEditorStore.getState().undo()
    expect(useEditorStore.getState().doc.project.keyframeDefaults).toEqual({ opacity: 'easeIn' })
    useEditorStore.getState().redo()
    expect(useEditorStore.getState().doc.project.keyframeDefaults).toEqual({ opacity: 'easeOut' })
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
  /** A doc with one clip AND one sequence marker, for the marker-transient tests. */
  function docWithMarkerAndClipLocal(): { clipId: string; markerId: string } {
    const doc = createDoc()
    const asset = createMediaAsset({ kind: 'video', name: 'a.mp4', duration: 10 })
    doc.media = [asset]
    const track = doc.project.tracks.find((t) => t.kind === 'video')!
    track.clips = [createClip({ id: 'clip_sel', mediaId: asset.id, start: 0, duration: 4 })]
    useEditorStore.setState({ doc })
    useEditorStore.getState().apply({
      type: 'addSequenceMarker',
      marker: { id: 'marker_sel', time: 1 },
    })
    return { clipId: 'clip_sel', markerId: 'marker_sel' }
  }

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

  it('commitTransient drops a marker selection the gesture deleted', () => {
    const { markerId } = docWithMarkerAndClipLocal()
    useEditorStore.getState().selectMarker({ scope: 'sequence', markerId })
    const store = useEditorStore.getState()
    store.beginTransient()
    store.applyTransient({ type: 'deleteSequenceMarker', markerId })
    expect(useEditorStore.getState().selectedMarker).toEqual({
      scope: 'sequence',
      markerId,
    }) // still selected mid-gesture
    store.commitTransient()
    expect(useEditorStore.getState().doc.project.markers).toBeUndefined()
    expect(useEditorStore.getState().selectedMarker).toBeNull()
  })

  it('cancelTransient drops a marker selection that does not exist in the BASE doc', () => {
    docWithMarkerAndClipLocal()
    const store = useEditorStore.getState()
    store.beginTransient()
    // The gesture adds a marker and selects it; the base doc never had it.
    store.applyTransient({ type: 'addSequenceMarker', marker: { id: 'm2', time: 8 } })
    useEditorStore.getState().selectMarker({ scope: 'sequence', markerId: 'm2' })
    store.cancelTransient()
    // The base doc had ONLY marker_sel, so m2 is gone and with it the selection.
    expect(useEditorStore.getState().doc.project.markers).toHaveLength(1)
    expect(useEditorStore.getState().doc.project.markers![0].id).toBe('marker_sel')
    expect(useEditorStore.getState().selectedMarker).toBeNull()
  })

  it('cancelTransient keeps a marker selection that the user held through the gesture', () => {
    const { markerId } = docWithMarkerAndClipLocal()
    useEditorStore.getState().selectMarker({ scope: 'sequence', markerId })
    const store = useEditorStore.getState()
    store.beginTransient()
    store.applyTransient({ type: 'moveSequenceMarker', markerId, time: 9 })
    store.cancelTransient()
    // The selection was never touched mid-gesture and still resolves in the
    // restored base, so it survives the cancel.
    expect(useEditorStore.getState().selectedMarker).toEqual({
      scope: 'sequence',
      markerId,
    })
  })

  it('cancelTransient does NOT resurrect a marker selection the user cleared mid-gesture', () => {
    const { markerId } = docWithMarkerAndClipLocal()
    useEditorStore.getState().selectMarker({ scope: 'sequence', markerId })
    const store = useEditorStore.getState()
    store.beginTransient()
    // A mid-gesture clip selection clears the marker selection...
    useEditorStore.getState().select(store.doc.project.tracks[0].clips[0].id)
    expect(useEditorStore.getState().selectedMarker).toBeNull()
    store.cancelTransient()
    // ...and cancel restores only the DOC: the marker exists in the base but
    // the cleared selection stays cleared (cancel never resurrects).
    expect(useEditorStore.getState().doc.project.markers).toHaveLength(1)
    expect(useEditorStore.getState().selectedMarker).toBeNull()
    expect(useEditorStore.getState().selections).toHaveLength(1)
  })

  it('commitTransient without changes records nothing', () => {
    addTestClip()
    const store = useEditorStore.getState()
    store.beginTransient()
    store.commitTransient()
    expect(useEditorStore.getState().past).toHaveLength(1)
  })

  it('a foreign apply during a drag rolls the drag back BEFORE the history snapshot', () => {
    // The delete's undo entry must capture the doc WITHOUT the drag's
    // in-flight frames: undo used to restore a mid-drag doc no user ever
    // committed to.
    addTestClip()
    const store = useEditorStore.getState()
    const clipId = store.doc.project.tracks.flatMap((t) => t.clips)[0].id
    const trackId = videoTrackId(store.doc)

    store.beginTransient()
    store.applyTransient({ type: 'moveClip', clipId, trackId, start: 2.5 })
    expect(useEditorStore.getState().doc.project.tracks.flatMap((t) => t.clips)[0].start).toBe(2.5)

    // Foreign commit while the drag is live.
    useEditorStore.getState().apply({ type: 'setProjectSettings', patch: { name: 'X' } })

    // The snapshot pushed for the delete describes the BASE doc (clip still
    // at 0), not the mid-drag doc; undo must walk back to exactly that.
    expect(useEditorStore.getState().past).toHaveLength(2)
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().doc.project.name).toBe('Untitled Project')
    expect(useEditorStore.getState().doc.project.tracks.flatMap((t) => t.clips)[0].start).toBe(0)
  })

  it('applyTransient stays permissive without a gesture slot (slider previews)', () => {
    // Sliders (InspectorPanel, EffectControls) preview via applyTransient with
    // NO base and commit once via onValueCommit → apply. The store therefore
    // cannot refuse baseless frames; DRAG sites guard their own frames by
    // token (see the markers-timeline-ui dead-frame test).
    addTestClip()
    const store = useEditorStore.getState()
    const clipId = store.doc.project.tracks.flatMap((t) => t.clips)[0].id
    const trackId = videoTrackId(store.doc)
    expect(isTransientActive()).toBe(false)

    store.applyTransient({ type: 'moveClip', clipId, trackId, start: 2 })
    expect(useEditorStore.getState().doc.project.tracks.flatMap((t) => t.clips)[0].start).toBe(2)
    // A baseless commit is inert.
    store.commitTransient()
    expect(useEditorStore.getState().past).toHaveLength(1)
  })

  it('undo and redo resolve a live gesture by rolling back to the base first', () => {
    addTestClip()
    const store = useEditorStore.getState()
    const clipId = store.doc.project.tracks.flatMap((t) => t.clips)[0].id
    const trackId = videoTrackId(store.doc)

    // A committed step the drag will roll onto, then a live drag.
    useEditorStore.getState().apply({ type: 'setProjectSettings', patch: { name: 'A' } })
    store.beginTransient()
    store.applyTransient({ type: 'moveClip', clipId, trackId, start: 2 })

    useEditorStore.getState().undo()
    expect(useEditorStore.getState().doc.project.name).toBe('Untitled Project')
    // Rolled back BEFORE the undo: the clip never moved in the restored doc.
    expect(useEditorStore.getState().doc.project.tracks.flatMap((t) => t.clips)[0].start).toBe(0)
    expect(isTransientActive()).toBe(false)
    // Redo is symmetric.
    useEditorStore.getState().redo()
    expect(useEditorStore.getState().doc.project.name).toBe('A')
    expect(useEditorStore.getState().doc.project.tracks.flatMap((t) => t.clips)[0].start).toBe(0)
  })

  it('beginTransient returns a token; ending the slot bumps it and forgets the pointer', () => {
    addTestClip()
    const store = useEditorStore.getState()
    expect(activeTransientPointerId()).toBeNull()

    const token = store.beginTransient(7)
    expect(activeTransientPointerId()).toBe(7)
    expect(currentTransientToken()).toBe(token)

    store.commitTransient()
    expect(currentTransientToken()).toBe(token + 1)
    expect(activeTransientPointerId()).toBeNull()

    // Same for a cancel, and for begin-without-pointer (tokenless consumers).
    const token2 = store.beginTransient()
    expect(activeTransientPointerId()).toBeNull()
    store.cancelTransient()
    expect(currentTransientToken()).toBe(token2 + 1)
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

  it('ends a live transient, so a gesture cleanup cannot revert the installed doc', () => {
    // Same invariant as apply/undo/redo: replaceDoc installs a NEW project;
    // a drag base predating the install must not survive it, or the unmount
    // cleanup's cancelTransient would restore the pre-install doc over it.
    addTestClip()
    useEditorStore.getState().beginTransient()
    expect(isTransientActive()).toBe(true)

    useEditorStore.getState().replaceDoc(createDoc())
    expect(isTransientActive()).toBe(false)
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

  it('setSelections installs a whole list (marquee commit), dropping dangling ids', () => {
    addTestClip()
    addTestClip()
    const clips = useEditorStore.getState().doc.project.tracks[0].clips
    useEditorStore.getState().setSelections([clips[1].id, clips[0].id, clips[1].id, 'ghost'])
    expect(useEditorStore.getState().selections).toEqual([clips[1].id, clips[0].id])
    expect(useEditorStore.getState().selection).toBe(clips[1].id)

    useEditorStore.getState().setSelections([])
    expect(useEditorStore.getState().selections).toEqual([])
    expect(useEditorStore.getState().selection).toBeNull()
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

describe('an emptied lane is pruned when the edit commits', () => {
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

  /** Default doc (V1 + A1) with one video clip on V1. */
  function clipOnV1() {
    const doc = useEditorStore.getState().doc
    const asset = createMediaAsset({
      kind: 'video',
      name: 'a.mp4',
      duration: 10,
      url: 'blob:a',
    })
    const v1 = doc.project.tracks.filter((t) => t.kind === 'video')[0]
    useEditorStore.getState().apply([
      { type: 'addMediaAsset', asset },
      { type: 'addClip', trackId: v1.id, clip: createClip({ mediaId: asset.id, duration: 4 }) },
    ])
    const lane = useEditorStore.getState().doc.project.tracks.find((t) => t.id === v1.id)
    return { v1Id: v1.id, clipId: lane?.clips[0]?.id ?? '' }
  }

  it("deleting a lane's last clip removes the lane as ONE undoable step", () => {
    const { v1Id, clipId } = clipOnV1()
    useEditorStore.getState().apply({ type: 'deleteClip', clipId })

    const after = useEditorStore.getState().doc
    expect(after.project.tracks.some((t) => t.id === v1Id)).toBe(false)
    expect(after.project.tracks).toHaveLength(1) // the audio lane survives

    useEditorStore.getState().undo()
    const restored = useEditorStore.getState().doc
    expect(restored.project.tracks).toHaveLength(2)
    expect(restored.project.tracks.find((t) => t.id === v1Id)?.clips).toHaveLength(1)
  })

  it('does NOT prune mid-drag — only the committed gesture removes the lane', () => {
    const { v1Id, clipId } = clipOnV1()
    useEditorStore.getState().apply({ type: 'addTrack', kind: 'video' })
    const empty = useEditorStore
      .getState()
      .doc.project.tracks.filter((t) => t.kind === 'video' && t.clips.length === 0)[0]

    const store = useEditorStore.getState()
    store.beginTransient()
    store.applyTransient({ type: 'moveClip', clipId, trackId: empty.id, start: 0 })
    // Mid-gesture the source lane IS empty for a frame; deleting it here would
    // remove the lane the pointer is still dragging out of.
    expect(useEditorStore.getState().doc.project.tracks.some((t) => t.id === v1Id)).toBe(true)

    useEditorStore.getState().commitTransient()
    const committed = useEditorStore.getState().doc
    expect(committed.project.tracks.some((t) => t.id === v1Id)).toBe(false)
    expect(committed.project.tracks.find((t) => t.id === empty.id)?.clips).toHaveLength(1)

    // The move AND the prune are one history entry.
    useEditorStore.getState().undo()
    const restored = useEditorStore.getState().doc
    expect(restored.project.tracks.some((t) => t.id === v1Id)).toBe(true)
    expect(restored.project.tracks.find((t) => t.id === empty.id)?.clips).toHaveLength(0)
  })

  it('leaves an already-empty lane alone on an unrelated edit', () => {
    const { clipId } = clipOnV1()
    useEditorStore.getState().apply({ type: 'addTrack', kind: 'video' })
    const emptyId = useEditorStore
      .getState()
      .doc.project.tracks.filter((t) => t.clips.length === 0)[0].id

    useEditorStore.getState().apply({ type: 'setClipMuted', clipId, muted: true })
    expect(useEditorStore.getState().doc.project.tracks.some((t) => t.id === emptyId)).toBe(true)
  })
})

describe('marker selection (store-only, exclusive with clips)', () => {
  function docWithMarkerAndClip(): { clipId: string; markerId: string } {
    const doc = createDoc()
    const asset = createMediaAsset({ kind: 'video', name: 'a.mp4', duration: 10 })
    doc.media = [asset]
    const track = doc.project.tracks.find((t) => t.kind === 'video')!
    track.clips = [createClip({ id: 'clip_sel', mediaId: asset.id, start: 0, duration: 4 })]
    useEditorStore.setState({ doc })
    useEditorStore.getState().apply({
      type: 'addSequenceMarker',
      marker: { id: 'marker_sel', time: 1 },
    })
    return { clipId: 'clip_sel', markerId: 'marker_sel' }
  }

  it('selecting a marker clears the clip selection; selecting a clip clears the marker', () => {
    const { clipId, markerId } = docWithMarkerAndClip()
    useEditorStore.getState().select(clipId)
    useEditorStore.getState().selectMarker({ scope: 'sequence', markerId })
    expect(useEditorStore.getState().selectedMarker).toEqual({ scope: 'sequence', markerId })
    expect(useEditorStore.getState().selections).toEqual([])

    useEditorStore.getState().select(clipId)
    expect(useEditorStore.getState().selectedMarker).toBeNull()
    expect(useEditorStore.getState().selections).toEqual([clipId])
    expect(useEditorStore.getState().selection).toBe(clipId)
  })

  it('a delete command drops the marker selection', () => {
    const { markerId } = docWithMarkerAndClip()
    useEditorStore.getState().selectMarker({ scope: 'sequence', markerId })
    useEditorStore.getState().apply({ type: 'deleteSequenceMarker', markerId })
    expect(useEditorStore.getState().selectedMarker).toBeNull()
  })

  it('undo drops the selection when the marker disappears', () => {
    const { markerId } = docWithMarkerAndClip()
    useEditorStore.getState().selectMarker({ scope: 'sequence', markerId })
    useEditorStore.getState().undo() // back to the doc without the marker
    expect(useEditorStore.getState().doc.project.markers).toBeUndefined()
    expect(useEditorStore.getState().selectedMarker).toBeNull()
  })

  it('setSelections / selectAll / deselectAll all clear the marker selection', () => {
    const { clipId, markerId } = docWithMarkerAndClip()
    const clipActions = [
      () => useEditorStore.getState().setSelections([clipId]),
      () => useEditorStore.getState().selectAll(),
      () => useEditorStore.getState().deselectAll(),
    ]
    for (const act of clipActions) {
      useEditorStore.getState().selectMarker({ scope: 'sequence', markerId })
      act()
      expect(useEditorStore.getState().selectedMarker).toBeNull()
    }
  })

  it('replaceDoc clears it', () => {
    const { markerId } = docWithMarkerAndClip()
    useEditorStore.getState().selectMarker({ scope: 'sequence', markerId })
    useEditorStore.getState().replaceDoc(createDoc())
    expect(useEditorStore.getState().selectedMarker).toBeNull()
  })
})

describe('track targeting', () => {
  it('defaults to every track targeted and leaves history alone', () => {
    const trackId = videoTrackId(useEditorStore.getState().doc)
    expect(useEditorStore.getState().untargetedTracks).toEqual([])
    const past = useEditorStore.getState().past.length

    useEditorStore.getState().setTrackTargeted(trackId, false)
    expect(useEditorStore.getState().untargetedTracks).toEqual([trackId])
    expect(useEditorStore.getState().past).toHaveLength(past)

    useEditorStore.getState().setTrackTargeted(trackId, true)
    expect(useEditorStore.getState().untargetedTracks).toEqual([])
  })

  it('replaceDoc clears the list', () => {
    const trackId = videoTrackId(useEditorStore.getState().doc)
    useEditorStore.getState().setTrackTargeted(trackId, false)
    useEditorStore.getState().replaceDoc(createDoc())
    expect(useEditorStore.getState().untargetedTracks).toEqual([])
  })

  it('a dangling id stays inert, and undo restores the untargeted posture', () => {
    const trackId = videoTrackId(useEditorStore.getState().doc)
    useEditorStore.getState().setTrackTargeted(trackId, false)

    useEditorStore.getState().apply({ type: 'removeTrack', trackId })
    expect(useEditorStore.getState().doc.project.tracks.some((t) => t.id === trackId)).toBe(false)
    expect(useEditorStore.getState().untargetedTracks).toContain(trackId)

    useEditorStore.getState().undo()
    expect(useEditorStore.getState().doc.project.tracks.some((t) => t.id === trackId)).toBe(true)
    expect(useEditorStore.getState().untargetedTracks).toContain(trackId)
  })

  it('selectTrackClips takes the lane in order and expands a cross-lane twin', () => {
    const asset = createMediaAsset({ kind: 'video', duration: 4, name: 'pair.mp4' })
    const videoTrack = createTrack('video', 1)
    const audioTrack = createTrack('audio', 1)
    const video = createClip({
      id: 'sel_v',
      linkId: 'link_sel',
      mediaId: asset.id,
      start: 0,
      duration: 2,
      inPoint: 0,
    })
    const twin = createClip({
      id: 'sel_a',
      linkId: 'link_sel',
      mediaId: asset.id,
      start: 0,
      duration: 2,
      inPoint: 0,
      audioOnly: true,
    })
    videoTrack.clips = [video]
    audioTrack.clips = [twin]
    useEditorStore.setState({
      doc: {
        project: { ...useEditorStore.getState().doc.project, tracks: [videoTrack, audioTrack] },
        media: [asset],
      },
    })
    useEditorStore.getState().selectMarker({ scope: 'sequence', markerId: 'm_any' })

    useEditorStore.getState().selectTrackClips(videoTrack.id)
    expect(useEditorStore.getState().selections).toEqual([video.id, twin.id])
    expect(useEditorStore.getState().selectedMarker).toBeNull()

    useEditorStore.getState().selectTrackClips(audioTrack.id)
    expect(useEditorStore.getState().selections).toEqual([twin.id, video.id])
  })
})

describe('placement and source session fields (0.7.2)', () => {
  it('defaults to place mode with no source selection', () => {
    const s = useEditorStore.getState()
    expect(s.dropMode).toBe('place')
    expect(s.sourceAssetId).toBeNull()
    expect(s.sourceIn).toBeNull()
    expect(s.sourceOut).toBeNull()
    expect(s.sourcePlayhead).toBe(0)
  })

  it('setDropMode is session-only: no history entry', () => {
    const past = useEditorStore.getState().past.length
    useEditorStore.getState().setDropMode('overwrite')
    expect(useEditorStore.getState().dropMode).toBe('overwrite')
    expect(useEditorStore.getState().past).toHaveLength(past)

    useEditorStore.getState().setDropMode('insert')
    expect(useEditorStore.getState().dropMode).toBe('insert')
    expect(useEditorStore.getState().past).toHaveLength(past)
  })

  it('replaceDoc clears the source fields but KEEPS dropMode', () => {
    const asset = createMediaAsset({ kind: 'video', name: 'a.mp4', duration: 10, url: 'blob:a' })
    useEditorStore.setState({ doc: { ...createDoc(), media: [asset] } })
    useEditorStore.getState().setSourceAsset(asset.id)
    useEditorStore.getState().setSourcePlayhead(4)
    useEditorStore.getState().markSourceIn()
    useEditorStore.getState().setDropMode('insert')

    useEditorStore.getState().replaceDoc(createDoc())
    const s = useEditorStore.getState()
    expect(s.sourceAssetId).toBeNull()
    expect(s.sourceIn).toBeNull()
    expect(s.sourceOut).toBeNull()
    expect(s.sourcePlayhead).toBe(0)
    expect(s.dropMode).toBe('insert') // tool posture survives, like activeTool
  })

  it('changing the source selection clears both marks and the time together', () => {
    const a = createMediaAsset({ kind: 'video', name: 'a.mp4', duration: 10, url: 'blob:a' })
    const b = createMediaAsset({ kind: 'video', name: 'b.mp4', duration: 8, url: 'blob:b' })
    useEditorStore.setState({ doc: { ...createDoc(), media: [a, b] } })

    useEditorStore.getState().setSourceAsset(a.id)
    useEditorStore.getState().setSourcePlayhead(3)
    useEditorStore.getState().markSourceIn()
    useEditorStore.getState().setSourcePlayhead(7)
    useEditorStore.getState().markSourceOut()
    expect(useEditorStore.getState().sourceIn).toBe(3)
    expect(useEditorStore.getState().sourceOut).toBe(7)

    useEditorStore.getState().setSourceAsset(b.id)
    const s = useEditorStore.getState()
    expect(s.sourceAssetId).toBe(b.id)
    expect(s.sourceIn).toBeNull()
    expect(s.sourceOut).toBeNull()
    expect(s.sourcePlayhead).toBe(0)

    // Re-selecting the SAME asset is a no-op (marks survive a re-click).
    useEditorStore.getState().setSourcePlayhead(2)
    useEditorStore.getState().markSourceIn()
    useEditorStore.getState().setSourceAsset(b.id)
    expect(useEditorStore.getState().sourceIn).toBe(2)
  })

  it('removing the selected asset normalizes the source state', () => {
    const a = createMediaAsset({ kind: 'video', name: 'a.mp4', duration: 10, url: 'blob:a' })
    useEditorStore.setState({ doc: { ...createDoc(), media: [a] } })
    useEditorStore.getState().setSourceAsset(a.id)
    useEditorStore.getState().setSourcePlayhead(5)
    useEditorStore.getState().markSourceIn()

    const doc = useEditorStore.getState().doc
    useEditorStore.getState().apply({ type: 'removeMediaAsset', mediaId: a.id })
    const s = useEditorStore.getState()
    expect(s.doc.media).toHaveLength(0)
    expect(s.sourceAssetId).toBeNull()
    expect(s.sourceIn).toBeNull()
    expect(s.sourceOut).toBeNull()
    expect(s.sourcePlayhead).toBe(0)
    expect(doc.media).toHaveLength(1) // input untouched (commands clone)
  })

  it('marks record the source playhead and clamp to the asset window', () => {
    const a = createMediaAsset({ kind: 'video', name: 'a.mp4', duration: 6, url: 'blob:a' })
    useEditorStore.setState({ doc: { ...createDoc(), media: [a] } })
    useEditorStore.getState().setSourceAsset(a.id)

    useEditorStore.getState().setSourcePlayhead(2.5)
    useEditorStore.getState().markSourceIn()
    useEditorStore.getState().setSourcePlayhead(4)
    useEditorStore.getState().markSourceOut()
    expect(useEditorStore.getState().sourceIn).toBe(2.5)
    expect(useEditorStore.getState().sourceOut).toBe(4)

    // The playhead clamps into [0, duration]; marks clamp with it.
    useEditorStore.getState().setSourcePlayhead(99)
    expect(useEditorStore.getState().sourcePlayhead).toBe(6)
    useEditorStore.getState().markSourceOut()
    expect(useEditorStore.getState().sourceOut).toBe(6)
    useEditorStore.getState().setSourcePlayhead(-1)
    expect(useEditorStore.getState().sourcePlayhead).toBe(0)

    useEditorStore.getState().clearSourceMarks()
    expect(useEditorStore.getState().sourceIn).toBeNull()
    expect(useEditorStore.getState().sourceOut).toBeNull()
  })

  it('images have no source window: marks are a no-op', () => {
    const img = createMediaAsset({ kind: 'image', name: 'a.png', duration: 0 })
    useEditorStore.setState({ doc: { ...createDoc(), media: [img] } })
    useEditorStore.getState().setSourceAsset(img.id)
    useEditorStore.getState().setSourcePlayhead(2)
    useEditorStore.getState().markSourceIn()
    useEditorStore.getState().markSourceOut()
    expect(useEditorStore.getState().sourceIn).toBeNull()
    expect(useEditorStore.getState().sourceOut).toBeNull()
  })
})
