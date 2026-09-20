// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import { TimelinePanel } from '@/components/editor/timeline/TimelinePanel'
import { installBrowserMocks, type MockHarness } from './mocks/browser-mocks'
import { editorStore, useEditorStore } from '../store'
import { createDoc, createMediaAsset, createTrack } from '../factories'
import type { Clip, Doc, MediaAsset, Track } from '../types'

/**
 * First React-render tests in the gate (jsdom + Testing Library): the timeline
 * renders its lanes from the store, and the drag commit path (transient
 * gesture begin/apply/commit) leaves one undo entry with the moved clip. This
 * closes part of the "green gate, broken UI" hole; the full UI remains covered
 * by the E2E battery.
 */

let h: MockHarness

beforeEach(() => {
  h = installBrowserMocks()
  document.body.innerHTML = ''
  // A fresh doc per test: the store is module-global, tests must not share state.
  useEditorStore.setState(useEditorStore.getInitialState())
})

afterEach(() => {
  cleanup()
  h.uninstall()
})

function docWithClips(): { doc: Doc; asset: MediaAsset; trackId: string } {
  const asset = createMediaAsset({ kind: 'video', duration: 30, name: 'demo.mp4' })
  const track = createTrack('video', 1)
  return {
    doc: {
      project: { tracks: [track], id: 'p_test', name: 'test', width: 1920, height: 1080, fps: 30 },
      media: [asset],
    },
    asset,
    trackId: track.id,
  }
}

describe('TimelinePanel render', () => {
  it('renders one lane per track with its header', () => {
    const { doc, trackId } = docWithClips()
    useEditorStore.setState({ doc })
    render(<TimelinePanel />)
    expect(screen.getByTestId(`track-header-${trackId}`)).toBeInTheDocument()
    expect(document.querySelectorAll('[data-lane-id]').length).toBe(1)
  })

  it('renders a clip inside its lane and an aria label with its span', () => {
    const { doc, asset, trackId } = docWithClips()
    doc.project.tracks[0].clips = [
      {
        id: 'clip_x',
        trackId,
        mediaId: asset.id,
        start: 1,
        duration: 5,
        inPoint: 0,
      } as Clip,
    ]
    useEditorStore.setState({ doc })
    render(<TimelinePanel />)
    const clipEl = screen.getByTestId('clip-clip_x')
    expect(clipEl).toBeInTheDocument()
    expect(clipEl.getAttribute('aria-label')).toContain('from 1.00 to 6.00 seconds')
  })

  it('an empty doc renders zero lanes only after tracks exist (starter lanes render)', () => {
    useEditorStore.setState({ doc: createDoc() })
    render(<TimelinePanel />)
    // createDoc ships starter lanes; they must be visible without any clips.
    expect(document.querySelectorAll('[data-lane-id]').length).toBeGreaterThan(0)
  })
})

describe('drag commit path (transient gesture -> one undo entry)', () => {
  it('commitTransient lands the moved clip and exactly one history entry', () => {
    const { doc, asset, trackId } = docWithClips()
    doc.project.tracks[0].clips = [
      { id: 'clip_x', trackId, mediaId: asset.id, start: 1, duration: 5, inPoint: 0 } as Clip,
    ]
    useEditorStore.setState({ doc })
    const before = editorStore.getState().past.length

    // The gesture lifecycle ClipView drives: begin, transient moves, commit.
    editorStore.getState().beginTransient()
    editorStore.getState().applyTransient({ type: 'moveClip', clipId: 'clip_x', trackId, start: 4 })
    editorStore.getState().commitTransient()

    const after = editorStore.getState()
    expect(after.past.length).toBe(before + 1) // ONE undo entry per gesture
    const clip = after.doc.project.tracks[0].clips[0]
    expect(clip.start).toBe(4)
  })

  it('cancelTransient restores the base doc (refused drop)', () => {
    const { doc, asset, trackId } = docWithClips()
    doc.project.tracks[0].clips = [
      { id: 'clip_x', trackId, mediaId: asset.id, start: 1, duration: 5, inPoint: 0 } as Clip,
    ]
    useEditorStore.setState({ doc })
    const before = editorStore.getState().past.length

    editorStore.getState().beginTransient()
    editorStore.getState().applyTransient({ type: 'moveClip', clipId: 'clip_x', trackId, start: 9 })
    editorStore.getState().cancelTransient()

    const after = editorStore.getState()
    expect(after.past.length).toBe(before) // no history entry for a refused drop
    expect(after.doc.project.tracks[0].clips[0].start).toBe(1)
  })

  it('dragging via applyTransient does NOT push history until commit', () => {
    const { doc, asset, trackId } = docWithClips()
    doc.project.tracks[0].clips = [
      { id: 'clip_x', trackId, mediaId: asset.id, start: 1, duration: 5, inPoint: 0 } as Clip,
    ]
    useEditorStore.setState({ doc })
    const before = editorStore.getState().past.length

    editorStore.getState().beginTransient()
    for (const start of [2, 3, 4, 5]) {
      editorStore.getState().applyTransient({ type: 'moveClip', clipId: 'clip_x', trackId, start })
    }
    expect(editorStore.getState().past.length).toBe(before) // still nothing
    editorStore.getState().commitTransient()
    expect(editorStore.getState().past.length).toBe(before + 1)
  })
})
