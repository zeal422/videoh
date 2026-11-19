// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { PreviewPanel } from '@/components/editor/PreviewPanel'
import { installBrowserMocks, type MockHarness } from './mocks/browser-mocks'
import { useEditorStore } from '../store'
import { createTextClip, createTrack } from '../factories'
import type { Clip, Doc } from '../types'

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

function docWithSelectedTextClip(partial: Partial<Clip> = {}): { doc: Doc; clipId: string } {
  const clip = createTextClip({ id: 'clip_text', start: 0, duration: 4, ...partial })
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

function styleXOf(clipId: string): number | undefined {
  return useEditorStore.getState().doc.project.tracks[0].clips.find((clip) => clip.id === clipId)
    ?.style?.x
}

function docWithTwoTextClips(): { firstId: string; secondId: string } {
  const first = createTextClip({ id: 'clip_text', start: 0, duration: 4 })
  const second = createTextClip({ id: 'clip_second', start: 0, duration: 4 })
  const track = createTrack('text', 1, { clips: [first, second] })
  const doc: Doc = {
    project: { tracks: [track], id: 'p_test', name: 'test', width: 1920, height: 1080, fps: 30 },
    media: [],
  }
  useEditorStore.setState({
    doc,
    selection: first.id,
    selections: [first.id],
    playhead: 1,
  })
  return { firstId: first.id, secondId: second.id }
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

  it('moves scaled text at pointer speed, not scale speed', () => {
    docWithSelectedTextClip({ animStatics: { scale: 2 } })
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

    fireEvent.pointerDown(canvas, { button: 0, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(canvas, { clientX: 150, clientY: 100 })
    // 50 client px on a 400 px canvas, halved by the captured scale 2.
    expect(textStyleX()).toBeCloseTo(0.5 + 50 / 400 / 2, 5)
    fireEvent.pointerUp(canvas)
  })

  it('cancels the drag when the selection switches to another text clip', () => {
    const { firstId, secondId } = docWithTwoTextClips()
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

    fireEvent.pointerDown(canvas, { button: 0, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(canvas, { clientX: 150, clientY: 100 })
    expect(styleXOf(firstId)).toBeCloseTo(0.625, 5)

    useEditorStore.getState().select(secondId)
    fireEvent.pointerMove(canvas, { clientX: 200, clientY: 100 })

    // The captured clip lost the selection: the gesture cancels instead of
    // writing the second clip, and the first clip's preview frame rolls back.
    expect(styleXOf(secondId)).toBeCloseTo(0.5, 5)
    expect(styleXOf(firstId)).toBeCloseTo(0.5, 5)
    fireEvent.pointerUp(canvas)
  })

  it('cancels the drag when the playhead leaves the captured clip', () => {
    const { clipId } = docWithSelectedTextClip()
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

    fireEvent.pointerDown(canvas, { button: 0, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(canvas, { clientX: 150, clientY: 100 })
    expect(styleXOf(clipId)).toBeCloseTo(0.625, 5)

    // The clip is 4 s long; playback carried the playhead past its end.
    useEditorStore.getState().setPlayhead(5)
    fireEvent.pointerMove(canvas, { clientX: 200, clientY: 100 })

    expect(styleXOf(clipId)).toBeCloseTo(0.5, 5)
    fireEvent.pointerUp(canvas)
  })

  it('cancels on release when the selection switched without another move', () => {
    const { firstId, secondId } = docWithTwoTextClips()
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
    fireEvent.pointerMove(canvas, { clientX: 150, clientY: 100 })
    expect(styleXOf(firstId)).toBeCloseTo(0.625, 5)

    // The selection moved after the last frame. A release with no further move
    // must cancel the preview instead of committing it to the captured clip.
    useEditorStore.getState().select(secondId)
    fireEvent.pointerUp(canvas)

    expect(styleXOf(firstId)).toBeCloseTo(0.5, 5)
    expect(styleXOf(secondId)).toBeCloseTo(0.5, 5)
    expect(useEditorStore.getState().past.length).toBe(pastBefore)
  })

  it('cancels on release when the playhead left without another move', () => {
    const { clipId } = docWithSelectedTextClip()
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
    fireEvent.pointerMove(canvas, { clientX: 150, clientY: 100 })
    expect(styleXOf(clipId)).toBeCloseTo(0.625, 5)

    // The playhead left the clip after the last frame. The release must cancel.
    useEditorStore.getState().setPlayhead(5)
    fireEvent.pointerUp(canvas)

    expect(styleXOf(clipId)).toBeCloseTo(0.5, 5)
    expect(useEditorStore.getState().past.length).toBe(pastBefore)
  })
})
