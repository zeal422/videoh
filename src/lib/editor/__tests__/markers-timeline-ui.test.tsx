// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { TimelinePanel } from '@/components/editor/timeline/TimelinePanel'
import { MarkerDialog } from '@/components/editor/timeline/MarkerDialog'
import { playbackRef } from '@/lib/editor/playback/engine-ref'
import { installBrowserMocks, type MockHarness } from './mocks/browser-mocks'
import { isTransientActive, useEditorStore } from '../store'
import { createClip, createDoc, createMediaAsset } from '../factories'
import type { Doc } from '../types'

/**
 * Marker UI proof (jsdom): sequence tabs render at their time and stagger,
 * clip tabs render only while visible, click selects + seeks, drag commits one
 * undo step, and the dialog edits name/color/notes and deletes through the
 * real store. Static-source locks pin the stacking and mount points that jsdom
 * cannot see.
 */

let h: MockHarness
let seek: ReturnType<typeof vi.fn>

beforeEach(() => {
  h = installBrowserMocks()
  document.body.innerHTML = ''
  useEditorStore.setState(useEditorStore.getInitialState())
  seek = vi.fn()
  playbackRef.current = { seek } as unknown as typeof playbackRef.current
})

afterEach(() => {
  cleanup()
  h.uninstall()
  playbackRef.current = null
})

/** One video clip: 2..6s on the timeline, reading source 1..5. */
function docWithClip(): Doc {
  const doc = createDoc()
  const asset = createMediaAsset({ kind: 'video', name: 'a.mp4', duration: 30 })
  const track = doc.project.tracks.find((t) => t.kind === 'video')!
  track.clips = [createClip({ id: 'c1', mediaId: asset.id, start: 2, duration: 4, inPoint: 1 })]
  doc.media = [asset]
  return doc
}

describe('sequence markers rendering', () => {
  it('renders one tab per marker at its time and staggers close ones', () => {
    const doc = docWithClip()
    doc.project.markers = [
      { id: 'm1', time: 2 },
      { id: 'm2', time: 2.01 },
    ]
    useEditorStore.setState({ doc })
    render(<TimelinePanel />)

    const tabs = screen.getAllByTestId('sequence-marker')
    expect(tabs).toHaveLength(2)
    expect(tabs[0].getAttribute('data-marker-time')).toBe('2')
    expect(tabs[0].style.backgroundColor).not.toBe('')
    // 2s at the default 80 px/s, the second tab pushed right to stay clickable.
    expect(Number.parseFloat(tabs[0].style.left)).toBe(160)
    expect(Number.parseFloat(tabs[1].style.left)).toBeGreaterThan(
      Number.parseFloat(tabs[0].style.left),
    )
  })

  it('marker tabs mount inside the ruler row', () => {
    const doc = docWithClip()
    doc.project.markers = [{ id: 'm1', time: 3 }]
    useEditorStore.setState({ doc })
    render(<TimelinePanel />)

    expect(screen.getByTestId('sequence-marker').closest('[data-ruler]')).not.toBeNull()
  })

  it('clicking a tab selects the marker and seeks to it', () => {
    const doc = docWithClip()
    doc.project.markers = [{ id: 'm1', time: 3 }]
    useEditorStore.setState({ doc })
    useEditorStore.getState().select('c1')
    render(<TimelinePanel />)

    fireEvent.pointerDown(screen.getByTestId('sequence-marker'), {
      button: 0,
      clientX: 240,
      clientY: 10,
    })
    fireEvent.pointerUp(window)

    expect(seek).toHaveBeenCalledWith(3)
    expect(useEditorStore.getState().selectedMarker).toEqual({
      scope: 'sequence',
      markerId: 'm1',
    })
    expect(useEditorStore.getState().selections).toEqual([])
  })

  it('dragging a tab moves the marker and commits exactly one undo entry', () => {
    const doc = docWithClip()
    doc.project.markers = [{ id: 'm1', time: 3 }]
    useEditorStore.setState({ doc })
    render(<TimelinePanel />)
    const pastBefore = useEditorStore.getState().past.length

    const tab = screen.getByTestId('sequence-marker')
    fireEvent.pointerDown(tab, { button: 0, clientX: 240, clientY: 10 })
    fireEvent.pointerMove(window, { clientX: 320, clientY: 10 }) // +80px = +1s
    fireEvent.pointerUp(window)

    expect(useEditorStore.getState().doc.project.markers![0].time).toBe(4)
    expect(useEditorStore.getState().past.length).toBe(pastBefore + 1)
  })

  it('a tab dragged past the sequence end clamps to the end', () => {
    const doc = docWithClip() // 2..6s: the sequence ends at 6
    doc.project.markers = [{ id: 'm1', time: 3 }]
    useEditorStore.setState({ doc })
    render(<TimelinePanel />)
    const pastBefore = useEditorStore.getState().past.length

    const tab = screen.getByTestId('sequence-marker')
    fireEvent.pointerDown(tab, { button: 0, clientX: 240, clientY: 10 })
    fireEvent.pointerMove(window, { clientX: 240 + 17 * 80, clientY: 10 }) // toward 20s
    fireEvent.pointerUp(window)

    // A marker parked past the end could never be sought to, so the drag stops
    // at the sequence end.
    expect(useEditorStore.getState().doc.project.markers![0].time).toBe(6)
    expect(useEditorStore.getState().past.length).toBe(pastBefore + 1)
  })

  it('a replaced drag ignores the prior pointer and the replacement is not ended by it', () => {
    // Pointer A starts a drag; pointer B's pointerdown abandons it and starts
    // the replacement. A's lingering events must neither drive nor end the
    // replacement drag: the shell's dangling-commit net used to commit the
    // replacement the moment A lifted.
    const doc = docWithClip()
    doc.project.markers = [{ id: 'm1', time: 3 }]
    useEditorStore.setState({ doc })
    render(<TimelinePanel />)
    const tab = screen.getByTestId('sequence-marker')

    // Pointer A (id 5): down + a real move (transient begins).
    fireEvent.pointerDown(tab, { button: 0, clientX: 240, clientY: 10, pointerId: 5 })
    fireEvent.pointerMove(window, { clientX: 320, clientY: 10, pointerId: 5 })
    expect(isTransientActive()).toBe(true)

    // Pointer B (id 9) takes over: its pointerdown cancels A's drag, and its
    // own move starts a fresh gesture.
    fireEvent.pointerDown(tab, { button: 0, clientX: 240, clientY: 10, pointerId: 9 })
    fireEvent.pointerMove(window, { clientX: 360, clientY: 10, pointerId: 9 })
    expect(isTransientActive()).toBe(true)

    // A's stale events arrive after B owns the drag: none may move the marker
    // or end B's gesture.
    fireEvent.pointerMove(window, { clientX: 600, clientY: 10, pointerId: 5 })
    expect(isTransientActive()).toBe(true)
    fireEvent.pointerUp(window, { pointerId: 5 })
    expect(isTransientActive()).toBe(true) // the net must not have committed B's drag

    // B ends its own drag: one committed step, from B's own fresh start. The
    // marker moves 3 + 1.5s (B's +120px from B's pointerdown). Had the
    // abandoned delta leaked in, B would have started from A's mid-drag 4s
    // and landed at 5.5.
    fireEvent.pointerUp(window, { pointerId: 9 })
    expect(isTransientActive()).toBe(false)
    expect(useEditorStore.getState().doc.project.markers![0].time).toBe(4.5)
  })

  it('drag frames after a foreign commit are refused instead of mutating the doc', () => {
    // A keyboard delete during a live drag closes the gesture slot; the
    // drag's later pointermove frames used to apply anyway, mutating the doc
    // with no undo entry behind them.
    const doc = docWithClip()
    doc.project.markers = [{ id: 'm1', time: 3 }]
    useEditorStore.setState({ doc })
    render(<TimelinePanel />)
    const pastBefore = useEditorStore.getState().past.length

    fireEvent.pointerDown(screen.getByTestId('sequence-marker'), {
      button: 0,
      clientX: 240,
      clientY: 10,
    })
    fireEvent.pointerMove(window, { clientX: 320, clientY: 10 }) // transient begins
    expect(isTransientActive()).toBe(true)

    // Foreign commit while the drag is live.
    useEditorStore.getState().apply({ type: 'setProjectSettings', patch: { name: 'X' } })
    expect(isTransientActive()).toBe(false)

    // The drag's next frame (pointer still down, listeners still attached).
    fireEvent.pointerMove(window, { clientX: 500, clientY: 10 })
    // Refused: no rogue state, and the undo entry is the delete alone.
    expect(useEditorStore.getState().doc.project.markers![0].time).toBe(3)
    expect(useEditorStore.getState().doc.project.name).toBe('X')
    expect(useEditorStore.getState().past.length).toBe(pastBefore + 1)
  })

  it('a drag interrupted by an unmount cancels its transient instead of stranding it', () => {
    // A mid-drag unmount (e.g. the owning clip deleted under a live tab drag)
    // used to leave transientBase set forever: the move never reached history
    // and initAutosave skipped every later change while it was active.
    const doc = docWithClip()
    doc.project.markers = [{ id: 'm1', time: 3 }]
    useEditorStore.setState({ doc })
    const { unmount } = render(<TimelinePanel />)
    const pastBefore = useEditorStore.getState().past.length

    fireEvent.pointerDown(screen.getByTestId('sequence-marker'), {
      button: 0,
      clientX: 240,
      clientY: 10,
    })
    fireEvent.pointerMove(window, { clientX: 320, clientY: 10 }) // transient begins
    expect(isTransientActive()).toBe(true)

    unmount()

    // The move is rolled back (doc = base, no history entry) and the store is
    // free again: autosave resumes on the next committed change.
    expect(isTransientActive()).toBe(false)
    expect(useEditorStore.getState().doc.project.markers![0].time).toBe(3)
    expect(useEditorStore.getState().past.length).toBe(pastBefore)
  })

  it('a committed delete during a drag survives the tab unmount (no stale-base revert)', () => {
    // The store ends a live transient when a foreign commit lands (apply/undo/
    // redo), so the unmount cleanup's cancelTransient cannot restore a base
    // that predates the commit: that used to resurrect the deleted clip while
    // `past` held the without-clip doc, corrupting the next undo.
    const doc = docWithClip()
    doc.project.markers = [{ id: 'm1', time: 3 }]
    useEditorStore.setState({ doc })
    const { unmount } = render(<TimelinePanel />)

    fireEvent.pointerDown(screen.getByTestId('sequence-marker'), {
      button: 0,
      clientX: 240,
      clientY: 10,
    })
    fireEvent.pointerMove(window, { clientX: 320, clientY: 10 }) // transient begins
    expect(isTransientActive()).toBe(true)

    // A committed change DURING the drag: the delete of the only clip.
    useEditorStore.getState().apply({ type: 'deleteClip', clipId: 'c1' })
    expect(useEditorStore.getState().doc.project.tracks[0].clips).toHaveLength(0)

    // The tab unmounts with the clip; the cleanup must NOT revert the delete.
    // The in-flight marker move was ROLLED BACK before the delete committed
    // (drag frames never leak into history), so the marker sits at its
    // original time, exactly as `past` records it.
    unmount()
    expect(isTransientActive()).toBe(false)
    expect(useEditorStore.getState().doc.project.tracks[0].clips).toHaveLength(0)
    expect(useEditorStore.getState().doc.project.markers![0].time).toBe(3)
  })

  it('an undo during a drag is not reverted by the drag cleanup', () => {
    // Undo mid-gesture installs an older doc; the cleanup's cancelTransient
    // used to overwrite it with transientBase, which corresponds to no
    // history entry at all (a lost undo step and a phantom redo state).
    const doc = docWithClip()
    doc.project.markers = [{ id: 'm1', time: 3 }]
    useEditorStore.setState({ doc })
    render(<TimelinePanel />)

    // One committed change to undo: a marker move.
    useEditorStore.getState().apply({ type: 'moveSequenceMarker', markerId: 'm1', time: 5 })
    expect(useEditorStore.getState().doc.project.markers![0].time).toBe(5)

    fireEvent.pointerDown(screen.getByTestId('sequence-marker'), {
      button: 0,
      clientX: 240,
      clientY: 10,
    })
    fireEvent.pointerMove(window, { clientX: 320, clientY: 10 }) // transient begins
    expect(isTransientActive()).toBe(true)

    useEditorStore.getState().undo()
    expect(useEditorStore.getState().doc.project.markers![0].time).toBe(3)

    // A later unmount (the pointer is still down in a real session) must not
    // restore the pre-undo base.
    cleanup()
    expect(isTransientActive()).toBe(false)
    expect(useEditorStore.getState().doc.project.markers![0].time).toBe(3)
    expect(useEditorStore.getState().future).toHaveLength(1)
  })
})

describe('clip markers rendering', () => {
  it('renders only visible clip markers, anchored inside the clip', () => {
    const doc = docWithClip()
    doc.project.tracks[0].clips[0].markers = [
      { id: 'cm_visible', time: 3 }, // local 2s -> 160px into the clip
      { id: 'cm_hidden', time: 99 }, // outside the source span
    ]
    useEditorStore.setState({ doc })
    render(<TimelinePanel />)

    const tabs = screen.getAllByTestId('clip-marker')
    expect(tabs).toHaveLength(1)
    expect(tabs[0].getAttribute('data-marker-id')).toBe('cm_visible')
    expect(Number.parseFloat(tabs[0].style.left)).toBe(160)
  })

  it('clicking a clip marker selects it and seeks to its timeline time', () => {
    const doc = docWithClip()
    doc.project.tracks[0].clips[0].markers = [{ id: 'cm1', time: 3 }]
    useEditorStore.setState({ doc })
    render(<TimelinePanel />)

    fireEvent.pointerDown(screen.getByTestId('clip-marker'), {
      button: 0,
      clientX: 240,
      clientY: 40,
    })
    fireEvent.pointerUp(window)

    expect(seek).toHaveBeenCalledWith(4) // clip start 2 + local 2
    expect(useEditorStore.getState().selectedMarker).toEqual({
      scope: 'clip',
      clipId: 'c1',
      markerId: 'cm1',
    })
  })
})

describe('marker dialog', () => {
  it('edits name, color and notes, then deletes the marker', () => {
    const doc = docWithClip()
    doc.project.markers = [{ id: 'm1', time: 1 }]
    useEditorStore.setState({ doc })
    useEditorStore.getState().selectMarker({ scope: 'sequence', markerId: 'm1' })
    render(<MarkerDialog />)

    fireEvent(window, new Event('editor:marker-edit'))
    fireEvent.change(screen.getByTestId('marker-name-input'), { target: { value: 'Cue' } })
    fireEvent.click(screen.getByTestId('marker-color-red'))
    fireEvent.change(screen.getByTestId('marker-notes-input'), { target: { value: 'fix audio' } })
    fireEvent.click(screen.getByTestId('marker-save'))

    expect(useEditorStore.getState().doc.project.markers![0]).toMatchObject({
      name: 'Cue',
      color: 'red',
      notes: 'fix audio',
    })

    fireEvent(window, new Event('editor:marker-edit'))
    fireEvent.click(screen.getByTestId('marker-delete'))
    expect(useEditorStore.getState().doc.project.markers).toBeUndefined()
    expect(useEditorStore.getState().selectedMarker).toBeNull()
  })

  it('undo while open closes the dialog and redo does NOT reopen it', () => {
    // Radix never fires onOpenChange for a controlled `open` flip, so the edit
    // state must clear itself when the marker stops resolving — or a redo that
    // brings the marker back pops the stale dialog open again.
    const doc = docWithClip()
    useEditorStore.setState({ doc })
    // A committed add, so there is a history entry whose undo removes the marker.
    useEditorStore.getState().apply({ type: 'addSequenceMarker', marker: { id: 'm1', time: 1 } })
    useEditorStore.getState().selectMarker({ scope: 'sequence', markerId: 'm1' })
    render(<MarkerDialog />)

    fireEvent(window, new Event('editor:marker-edit'))
    expect(screen.getByTestId('marker-dialog')).toBeInTheDocument()

    // Undo removes the marker, closing the dialog; the edit state used to
    // survive that close. (act flushes the store-driven re-render and the
    // cleanup effect before the assertion.)
    act(() => useEditorStore.getState().undo())
    expect(screen.queryByTestId('marker-dialog')).not.toBeInTheDocument()

    // Redo brings the marker back: the dialog must stay closed.
    act(() => useEditorStore.getState().redo())
    expect(useEditorStore.getState().doc.project.markers).toHaveLength(1)
    expect(screen.queryByTestId('marker-dialog')).not.toBeInTheDocument()
  })
})

/**
 * Code-shape locks: stacking and mount points are exactly the kind of thing a
 * runtime render cannot prove in jsdom (zero-size rects, no paint), so the
 * sources are asserted directly. These deliberately read the real files.
 */
describe('static-source locks (stacking, mount points)', () => {
  const ROOT = resolve(__dirname, '..', '..', '..', '..')
  const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8')

  const sequenceMarkers = read('src/components/editor/timeline/SequenceMarkers.tsx')
  const clipMarkers = read('src/components/editor/timeline/ClipMarkers.tsx')
  const clipView = read('src/components/editor/timeline/ClipView.tsx')
  const serialization = read('src/lib/editor/serialization.ts')
  const markerDialog = read('src/components/editor/timeline/MarkerDialog.tsx')

  it('the sequence overlay is pointer-events-none at z-20 (the scale jsdom cannot see)', () => {
    expect(sequenceMarkers).toContain('pointer-events-none absolute inset-0 z-20')
    // The mount point (the ruler row) is asserted through the rendered DOM in
    // the rendering suite instead of an unanchored source regex.
  })

  it('clip marker tabs sit on the clip bottom strip (above the trim handles)', () => {
    // z-[11] > the trim handles' z-10: M with the playhead past the clip end
    // parks a marker on the end handle, so the tab must win the hit test.
    expect(clipMarkers).toContain('absolute bottom-0 z-[11]')
    expect(clipView).toContain('<ClipMarkers clip={clip} pxPerSec={pxPerSec} />')
  })

  // The keyboard map (M adds, Shift+M navigates, Shift+E mutes, Delete prefers
  // a live marker selection, Escape clears) is locked BEHAVIORALLY in
  // markers-keyboard.test.tsx through the real window listener; a static
  // string check here would pass against a wrong mapping, so there is none.

  it('the schema is v4 and hydrates marker arrays', () => {
    // v4 added compound-clip sequences (0.8.1); the literal is pinned on
    // purpose, so a silent version change is noticed instead of restated.
    expect(serialization).toContain('SERIALIZATION_VERSION = 4')
    expect(serialization).toContain('function hydrateMarkers')
  })

  it('the color swatches follow the radiogroup contract (roving tabIndex + arrow keys)', () => {
    // Only the checked radio may sit in the tab order; the arrows move the
    // selection. Tab-through-every-swatch breaks the ARIA radiogroup contract.
    expect(markerDialog).toContain('role="radiogroup"')
    expect(markerDialog).toContain('tabIndex={color === c ? 0 : -1}')
    expect(markerDialog).toContain("e.key !== 'ArrowRight'")
  })
})
