// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { PreviewPanel } from '@/components/editor/PreviewPanel'
import { installBrowserMocks, type MockHarness } from './mocks/browser-mocks'
import { useEditorStore } from '../store'
import { createTextClip, createTrack } from '../factories'
import type { Doc } from '../types'

/**
 * jsdom render test for the monitor's drag-to-position gesture: a text clip
 * selected and live at the playhead turns the canvas into a positioning
 * surface. The drag is a transient gesture (one undo step on release), so a
 * foreign commit landing mid-drag must roll the gesture back and the stale
 * pointer must not keep writing frames with no undo entry behind them.
 */

let h: MockHarness

beforeEach(() => {
  h = installBrowserMocks()
  document.body.innerHTML = ''
  useEditorStore.setState(useEditorStore.getInitialState())
})

afterEach(() => {
  cleanup()
  h.uninstall()
})

function docWithSelectedTextClip(): { doc: Doc; clipId: string } {
  const clip = createTextClip({ id: 'clip_text', start: 0, duration: 4 })
  const track = createTrack('text', 1, { clips: [clip] })
  const doc: Doc = {
    project: { tracks: [track], id: 'p_test', name: 'test', width: 1920, height: 1080, fps: 30 },
    media: [],
  }
  useEditorStore.setState({ doc, selection: clip.id, selections: [clip.id], playhead: 1 })
  return { doc, clipId: clip.id }
}

function textStyleX(): number | undefined {
  return useEditorStore.getState().doc.project.tracks[0].clips[0].style?.x
}

describe('preview text drag', () => {
  it('a foreign commit mid-drag rolls the move back and refuses later frames', () => {
    const { clipId } = docWithSelectedTextClip()
    render(<PreviewPanel />)

    // jsdom reports a zero-size rect; the pointer math needs a real canvas box.
    const canvas = screen.getByTestId('preview-canvas')
    canvas.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        right: 400,
        bottom: 225,
        width: 400,
        height: 225,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect

    const pastBefore = useEditorStore.getState().past.length
    fireEvent.pointerDown(canvas, { button: 0, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(canvas, { clientX: 150, clientY: 100 })
    expect(textStyleX()).toBeCloseTo(0.625, 5) // 0.5 + 50/400

    // A foreign commit (keyboard delete, menu action, ...) resolves the gesture
    // first: the in-flight frame rolls back before the history snapshot.
    useEditorStore.getState().apply({ type: 'setClipMuted', clipId, muted: true })
    expect(useEditorStore.getState().past.length).toBe(pastBefore + 1)
    expect(textStyleX()).toBe(0.5)

    // The stale pointer's next frame must be refused, or it would mutate the
    // doc with no undo entry behind it.
    fireEvent.pointerMove(canvas, { clientX: 250, clientY: 100 }) // would be 0.875
    expect(textStyleX()).toBe(0.5)
    expect(useEditorStore.getState().past.length).toBe(pastBefore + 1)
    fireEvent.pointerUp(canvas)
  })

  it('a completed drag commits one undo step and positions the text', () => {
    docWithSelectedTextClip()
    render(<PreviewPanel />)
    const canvas = screen.getByTestId('preview-canvas')
    canvas.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        right: 400,
        bottom: 225,
        width: 400,
        height: 225,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect

    const pastBefore = useEditorStore.getState().past.length
    fireEvent.pointerDown(canvas, { button: 0, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(canvas, { clientX: 140, clientY: 100 })
    fireEvent.pointerUp(canvas)

    expect(textStyleX()).toBeCloseTo(0.6, 5)
    expect(useEditorStore.getState().past.length).toBe(pastBefore + 1)
  })
})
