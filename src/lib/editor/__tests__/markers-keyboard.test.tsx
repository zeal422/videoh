// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { useEditorKeyboard } from '@/hooks/editor/useEditorKeyboard'
import { MarkerDialog } from '@/components/editor/timeline/MarkerDialog'
import { playbackRef } from '@/lib/editor/playback/engine-ref'
import { installBrowserMocks, type MockHarness } from './mocks/browser-mocks'
import { useEditorStore } from '../store'
import { createClip, createDoc, createMediaAsset } from '../factories'
import type { Doc } from '../types'

/**
 * Keyboard-map locks for the 0.5.5 marker keys (useEditorKeyboard.ts):
 * M adds (clip vs sequence), Shift+M / Ctrl+Shift+M navigate, Shift+E mutes,
 * Delete prefers the selected marker, Escape clears the marker selection.
 * These run through the real window listener, not the store directly.
 */

let h: MockHarness
let seek: ReturnType<typeof vi.fn>

function Harness() {
  useEditorKeyboard(() => {})
  return null
}

function docWithClip(): Doc {
  const doc = createDoc()
  const asset = createMediaAsset({ kind: 'video', name: 'a.mp4', duration: 30 })
  const track = doc.project.tracks.find((t) => t.kind === 'video')!
  track.clips = [createClip({ id: 'c1', mediaId: asset.id, start: 2, duration: 4, inPoint: 1 })]
  doc.media = [asset]
  return doc
}

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

describe('marker keyboard map (0.5.5)', () => {
  it('M adds a sequence marker at the playhead when nothing is selected', () => {
    useEditorStore.setState({ doc: docWithClip(), playhead: 3 })
    render(<Harness />)
    fireEvent.keyDown(window, { key: 'm' })
    const markers = useEditorStore.getState().doc.project.markers ?? []
    expect(markers).toHaveLength(1)
    expect(markers[0].time).toBe(3)
    expect(useEditorStore.getState().past).toHaveLength(1)
  })

  it('M adds a clamped clip marker on the selected clip and keeps the selection', () => {
    useEditorStore.setState({ doc: docWithClip(), playhead: 99 })
    useEditorStore.getState().select('c1')
    render(<Harness />)
    fireEvent.keyDown(window, { key: 'm' })
    const clip = useEditorStore.getState().doc.project.tracks[0].clips[0]
    expect(clip.markers).toHaveLength(1)
    // Playhead past the clip clamps to the last visible source frame (1 + 4).
    expect(clip.markers![0].time).toBe(5)
    expect(useEditorStore.getState().selections).toEqual(['c1'])
  })

  it('Shift+M and Ctrl+Shift+M seek to the next/previous marker', () => {
    const doc = docWithClip()
    doc.project.markers = [
      { id: 'm1', time: 1 },
      { id: 'm2', time: 5 },
    ]
    useEditorStore.setState({ doc, playhead: 3 })
    render(<Harness />)

    fireEvent.keyDown(window, { key: 'M', shiftKey: true })
    expect(seek).toHaveBeenCalledWith(5)

    seek.mockClear()
    fireEvent.keyDown(window, { key: 'M', shiftKey: true, ctrlKey: true })
    expect(seek).toHaveBeenCalledWith(1)
  })

  it('a marker past the sequence end is not a seek target (navigation cannot loop)', () => {
    const doc = docWithClip() // 2..6s: the sequence ends at 6
    doc.project.markers = [{ id: 'm1', time: 20 }]
    useEditorStore.setState({ doc, playhead: 6 })
    render(<Harness />)

    // The playhead cannot pass the sequence end, so seeking to the marker would
    // clamp back to 6 and the same marker would return on every press.
    fireEvent.keyDown(window, { key: 'M', shiftKey: true })
    expect(seek).not.toHaveBeenCalled()
  })

  it('Shift+E mutes the selected clip; plain E does nothing', () => {
    useEditorStore.setState({ doc: docWithClip() })
    useEditorStore.getState().select('c1')
    render(<Harness />)

    fireEvent.keyDown(window, { key: 'E' })
    expect(useEditorStore.getState().doc.project.tracks[0].clips[0].muted).toBeUndefined()

    fireEvent.keyDown(window, { key: 'E', shiftKey: true })
    expect(useEditorStore.getState().doc.project.tracks[0].clips[0].muted).toBe(true)
  })

  it('Delete removes the selected marker instead of the clip', () => {
    const doc = docWithClip()
    doc.project.markers = [{ id: 'm1', time: 1 }]
    useEditorStore.setState({ doc })
    useEditorStore.getState().select('c1')
    useEditorStore.getState().selectMarker({ scope: 'sequence', markerId: 'm1' })
    render(<Harness />)

    fireEvent.keyDown(window, { key: 'Delete' })
    expect(useEditorStore.getState().doc.project.markers).toBeUndefined()
    expect(useEditorStore.getState().doc.project.tracks[0].clips).toHaveLength(1)
    expect(useEditorStore.getState().selectedMarker).toBeNull()
  })

  it('a STALE marker selection is dropped and Delete falls through to the clips', () => {
    const doc = docWithClip()
    doc.project.markers = [{ id: 'm1', time: 1 }]
    useEditorStore.setState({ doc })
    // Out-of-band state surgery: the marker is gone from the doc, yet a marker
    // selection still points at it AND a clip selection is live (a state the
    // public setters cannot produce, which is exactly why the guard exists).
    useEditorStore.setState({
      doc: { ...doc, project: { ...doc.project, markers: undefined } },
      selections: ['c1'],
      selection: 'c1',
      selectedMarker: { scope: 'sequence', markerId: 'm1' },
    })
    render(<Harness />)

    fireEvent.keyDown(window, { key: 'Delete' })
    // The stale marker selection was dropped, the clip path ran.
    expect(useEditorStore.getState().selectedMarker).toBeNull()
    expect(useEditorStore.getState().doc.project.tracks[0].clips).toHaveLength(0)
  })

  it('arrow keys in the marker dialog color swatches do not drive the playhead', () => {
    const doc = docWithClip()
    doc.project.markers = [{ id: 'm1', time: 3 }]
    useEditorStore.setState({ doc, playhead: 3 })
    useEditorStore.getState().selectMarker({ scope: 'sequence', markerId: 'm1' })
    const stepFrames = vi.fn()
    playbackRef.current = { seek, stepFrames } as unknown as typeof playbackRef.current
    render(
      <>
        <Harness />
        <MarkerDialog />
      </>,
    )
    fireEvent(window, new Event('editor:marker-edit'))

    const swatch = screen.getByTestId('marker-color-green')
    swatch.focus()
    fireEvent.keyDown(swatch, { key: 'ArrowRight', bubbles: true })

    // The swatch moved its own selection but the editor's frame stepping did
    // not run: a focused control that consumed the key owns it.
    expect(screen.getByTestId('marker-color-red')).toHaveAttribute('aria-checked', 'true')
    expect(stepFrames).not.toHaveBeenCalled()
    expect(seek).not.toHaveBeenCalled()
  })

  it('Escape clears the marker selection', () => {
    const doc = docWithClip()
    doc.project.markers = [{ id: 'm1', time: 1 }]
    useEditorStore.setState({ doc })
    useEditorStore.getState().selectMarker({ scope: 'sequence', markerId: 'm1' })
    render(<Harness />)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useEditorStore.getState().selectedMarker).toBeNull()
  })
})
