// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { startTransition } from 'react'

import { PreviewPanel } from '@/components/editor/PreviewPanel'
import { InspectorPanel } from '@/components/editor/InspectorPanel'
import { toast } from '@/hooks/use-toast'
import { installBrowserMocks, type MockHarness } from './mocks/browser-mocks'
import { isTransientActive, useEditorStore } from '../store'
import { playbackRef } from '../playback/engine-ref'

// Only `toast` is mocked: the lock tests assert the refusal notice, and no
// test in this file renders the Toaster.
vi.mock('@/hooks/use-toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-toast')>()
  return { ...actual, toast: vi.fn() }
})
import {
  createClip,
  createMediaAsset,
  createShapeClip,
  createTextClip,
  createTrack,
} from '../factories'
import type { Doc, MediaAsset, Track } from '../types'

/**
 * Monitor interaction (0.29.5): click-to-select reads the same transformed box
 * the gizmo draws, a monitor move snaps to frame and clip lines with amber
 * guides, and a Play press or playhead move cancels a live transform gesture.
 */

let h: MockHarness

beforeEach(() => {
  h = installBrowserMocks()
  document.body.innerHTML = ''
  vi.mocked(toast).mockClear()
  useEditorStore.setState(useEditorStore.getInitialState())
})

afterEach(() => {
  if (isTransientActive()) useEditorStore.getState().cancelTransient()
  cleanup()
  h.uninstall()
  playbackRef.current = null
})

function imageAsset(partial: Partial<MediaAsset> = {}): MediaAsset {
  return createMediaAsset({
    id: 'media_img',
    kind: 'image',
    name: 'still.png',
    duration: 10,
    width: 640,
    height: 180,
    url: 'blob:still',
    ...partial,
  })
}

function docWith(tracks: Track[], media: MediaAsset[] = []): Doc {
  return {
    project: { tracks, id: 'p_test', name: 'test', width: 1920, height: 1080, fps: 30 },
    media,
  }
}

function canvasRect(canvas: HTMLElement) {
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
}

function gizmoParts() {
  const gizmo = screen.getByTestId('transform-gizmo')
  return {
    gizmo,
    move: gizmo.querySelector('[data-gizmo="move"]') as Element,
    scale: gizmo.querySelector('[data-gizmo="scale"]') as Element,
    rotate: gizmo.querySelector('[data-gizmo="rotate"]') as Element,
  }
}

/**
 * Renders a selected clip on a track that is still unlocked, so the gizmo is
 * drawn. The returned `lock` function locks the track just before the press,
 * reproducing the stale overlay the lock gate exists for.
 */
function staleLockedGizmo(withTopClip: boolean) {
  const asset = imageAsset()
  const locked = createClip({ id: 'clip_locked', mediaId: asset.id, start: 0, duration: 4 })
  const top = createClip({ id: 'clip_top', mediaId: asset.id, start: 0, duration: 4 })
  const tracks = [createTrack('video', 1, { id: 'track_locked', clips: [locked] })]
  if (withTopClip) {
    tracks.unshift(createTrack('video', 1, { clips: [top] }))
  }
  useEditorStore.setState({
    doc: docWith(tracks, [asset]),
    selection: locked.id,
    selections: [locked.id],
    playhead: 1,
    playing: true,
  })
  render(<PreviewPanel />)
  const canvas = screen.getByTestId('preview-canvas')
  canvasRect(canvas)
  return {
    parts: gizmoParts(),
    topId: top.id,
    lock: () => {
      useEditorStore.getState().apply({
        type: 'setTrackLocked',
        trackId: 'track_locked',
        locked: true,
      })
    },
  }
}

/** Client coordinates for a project point on the 400x225 test canvas. */
function client(projectX: number, projectY: number) {
  return { clientX: (projectX / 1920) * 400, clientY: (projectY / 1080) * 225 }
}

describe('monitor click-to-select', () => {
  it('selects a sticker under the pointer', () => {
    const asset = imageAsset()
    const clip = createClip({ id: 'clip_img', mediaId: asset.id, start: 0, duration: 4 })
    useEditorStore.setState({ doc: docWith([createTrack('video', 1, { clips: [clip] })], [asset]) })
    render(<PreviewPanel />)
    const canvas = screen.getByTestId('preview-canvas')
    canvasRect(canvas)

    fireEvent.pointerDown(canvas, { button: 0, ...client(960, 540) })
    expect(useEditorStore.getState().selection).toBe(clip.id)
  })

  it('selects a text clip and a shape by their transformed boxes', () => {
    const text = createTextClip({ id: 'clip_text', start: 0, duration: 4 })
    const { rerender } = render(<PreviewPanel />)
    useEditorStore.setState({
      doc: docWith([createTrack('text', 1, { clips: [text] })]),
      playhead: 1,
    })
    rerender(<PreviewPanel />)
    const canvas = screen.getByTestId('preview-canvas')
    canvasRect(canvas)
    fireEvent.pointerDown(canvas, { button: 0, ...client(960, 540) })
    expect(useEditorStore.getState().selection).toBe(text.id)

    const shape = createShapeClip({ id: 'clip_shape', start: 0, duration: 4 })
    useEditorStore.setState({
      doc: docWith([createTrack('video', 1, { clips: [shape] })]),
      selection: null,
      selections: [],
    })
    rerender(<PreviewPanel />)
    // Inside the 50%-frame rectangle's transparent corner: the box selects.
    fireEvent.pointerDown(canvas, { button: 0, ...client(600, 350) })
    expect(useEditorStore.getState().selection).toBe(shape.id)
  })

  it('a top clip inside the selected box wins the press over the gizmo move', () => {
    const asset = imageAsset()
    const bottom = createClip({ id: 'clip_bottom', mediaId: asset.id, start: 0, duration: 4 })
    const top = createClip({ id: 'clip_top', mediaId: asset.id, start: 0, duration: 4 })
    const doc = docWith(
      [createTrack('video', 1, { clips: [top] }), createTrack('video', 2, { clips: [bottom] })],
      [asset],
    )
    useEditorStore.setState({
      doc,
      selection: bottom.id,
      selections: [bottom.id],
      playhead: 1,
    })
    render(<PreviewPanel />)
    const canvas = screen.getByTestId('preview-canvas')
    canvasRect(canvas)
    const parts = gizmoParts()

    fireEvent.pointerDown(parts.move, { button: 0, pointerId: 9, ...client(960, 540) })
    expect(useEditorStore.getState().selection).toBe(top.id)
    // The press selected instead of starting a move on the lower clip.
    expect(useEditorStore.getState().past).toHaveLength(0)
  })

  it('clears an empty click when no selected text drag owns the surface', () => {
    const asset = imageAsset()
    const clip = createClip({ id: 'clip_img', mediaId: asset.id, start: 0, duration: 4 })
    useEditorStore.setState({
      doc: docWith([createTrack('video', 1, { clips: [clip] })], [asset]),
      selection: clip.id,
      selections: [clip.id],
    })
    render(<PreviewPanel />)
    const canvas = screen.getByTestId('preview-canvas')
    canvasRect(canvas)

    // The image box is 1920x540 centered: project y=48 is outside it.
    fireEvent.pointerDown(canvas, { button: 0, ...client(48, 48) })
    expect(useEditorStore.getState().selection).toBeNull()
  })

  it('Shift adds and Ctrl toggles a clicked clip', () => {
    const asset = imageAsset()
    const bottom = createClip({ id: 'clip_bottom', mediaId: asset.id, start: 0, duration: 4 })
    const top = createClip({ id: 'clip_top', mediaId: asset.id, start: 0, duration: 4 })
    const doc = docWith(
      [createTrack('video', 1, { clips: [top] }), createTrack('video', 2, { clips: [bottom] })],
      [asset],
    )
    useEditorStore.setState({
      doc,
      selection: bottom.id,
      selections: [bottom.id],
      playhead: 1,
    })
    render(<PreviewPanel />)
    const canvas = screen.getByTestId('preview-canvas')
    canvasRect(canvas)

    fireEvent.pointerDown(canvas, { button: 0, shiftKey: true, ...client(960, 540) })
    expect(useEditorStore.getState().selections).toEqual([bottom.id, top.id])

    fireEvent.pointerDown(canvas, { button: 0, ctrlKey: true, ...client(960, 540) })
    expect(useEditorStore.getState().selections).toEqual([bottom.id])
  })

  it('a first click on an unselected text only selects; the next press drags', () => {
    const first = createTextClip({ id: 'clip_first', start: 0, duration: 4 })
    first.style = { ...first.style!, x: 0.3 }
    const second = createTextClip({ id: 'clip_second', start: 0, duration: 4 })
    second.style = { ...second.style!, x: 0.7 }
    const doc = docWith([createTrack('text', 1, { clips: [first, second] })])
    useEditorStore.setState({
      doc,
      selection: first.id,
      selections: [first.id],
      playhead: 1,
    })
    render(<PreviewPanel />)
    const canvas = screen.getByTestId('preview-canvas')
    canvasRect(canvas)

    fireEvent.pointerDown(canvas, { button: 0, ...client(0.7 * 1920, 540) })
    expect(useEditorStore.getState().selection).toBe(second.id)
    expect(useEditorStore.getState().doc.project.tracks[0].clips[1].style?.x).toBe(0.7)

    fireEvent.pointerDown(canvas, { button: 0, ...client(0.7 * 1920, 540) })
    fireEvent.pointerMove(canvas, { ...client(0.7 * 1920 + 240, 540) })
    const moved = useEditorStore.getState().doc.project.tracks[0].clips[1]
    expect(moved.style?.x).toBeCloseTo(0.7 + 240 / 1920, 5)
    fireEvent.pointerUp(canvas)
  })
})

describe('monitor canvas snapping', () => {
  function snapDoc() {
    const asset = imageAsset({ width: 200, height: 200 })
    const clip = createClip({ id: 'clip_snap', mediaId: asset.id, start: 0, duration: 4 })
    const doc = docWith([createTrack('video', 1, { clips: [clip] })], [asset])
    useEditorStore.setState({
      doc,
      selection: clip.id,
      selections: [clip.id],
      playhead: 1,
      snapEnabled: true,
    })
    return clip
  }

  it('snaps a move near the frame center and shows the amber guide', () => {
    snapDoc()
    render(<PreviewPanel />)
    const canvas = screen.getByTestId('preview-canvas')
    canvasRect(canvas)
    const parts = gizmoParts()

    fireEvent.pointerDown(parts.move, { button: 0, pointerId: 11, ...client(960, 540) })
    // One client pixel is 4.8 project pixels; well inside the 8 CSS px threshold.
    fireEvent.pointerMove(parts.gizmo, { pointerId: 11, clientX: 201, clientY: 112.5 })

    expect(
      useEditorStore.getState().doc.project.tracks[0].clips[0].animStatics?.positionX,
    ).toBeUndefined()
    expect(screen.getByTestId('canvas-snap-guide-x')).toHaveAttribute('x1', '960')

    // A move outside the threshold is unsnapped and draws no vertical guide.
    fireEvent.pointerMove(parts.gizmo, { pointerId: 11, clientX: 240, clientY: 112.5 })
    expect(
      useEditorStore.getState().doc.project.tracks[0].clips[0].animStatics?.positionX,
    ).toBeCloseTo(192, 5)
    expect(screen.queryByTestId('canvas-snap-guide-x')).not.toBeInTheDocument()
    fireEvent.pointerUp(parts.gizmo, { pointerId: 11 })
  })

  it('snaps a text move to the frame center with the anchor conversion', () => {
    const text = createTextClip({ id: 'clip_text', start: 0, duration: 4 })
    text.style = { ...text.style!, x: 0.6 }
    const doc = docWith([createTrack('text', 1, { clips: [text] })])
    useEditorStore.setState({
      doc,
      selection: text.id,
      selections: [text.id],
      playhead: 1,
      snapEnabled: true,
    })
    render(<PreviewPanel />)
    const canvas = screen.getByTestId('preview-canvas')
    canvasRect(canvas)
    const parts = gizmoParts()

    // The measured box includes the 10px shadow pad each side: [1093, 1211].
    // Moving 236 project px left puts the right edge at 975, 15px from the
    // frame center target at 960.
    fireEvent.pointerDown(parts.move, { button: 0, pointerId: 12, ...client(1152, 540) })
    fireEvent.pointerMove(parts.gizmo, { pointerId: 12, ...client(1152 - 236, 540) })

    const moved = useEditorStore.getState().doc.project.tracks[0].clips[0]
    expect(moved.style?.x).toBeCloseTo(0.6 - 251 / 1920, 6)
    expect(screen.getByTestId('canvas-snap-guide-x')).toHaveAttribute('x1', '960')
    fireEvent.pointerUp(parts.gizmo, { pointerId: 12 })
  })

  it('does not snap when snapping is off', () => {
    snapDoc()
    useEditorStore.setState({ snapEnabled: false })
    render(<PreviewPanel />)
    const canvas = screen.getByTestId('preview-canvas')
    canvasRect(canvas)
    const parts = gizmoParts()

    fireEvent.pointerDown(parts.move, { button: 0, pointerId: 13, ...client(960, 540) })
    fireEvent.pointerMove(parts.gizmo, { pointerId: 13, clientX: 201, clientY: 112.5 })
    expect(
      useEditorStore.getState().doc.project.tracks[0].clips[0].animStatics?.positionX,
    ).toBeCloseTo(4.8, 5)
    expect(screen.queryByTestId('canvas-snap-guide-x')).not.toBeInTheDocument()
    fireEvent.pointerUp(parts.gizmo, { pointerId: 13 })
  })

  it('pressing Play mid-drag cancels the gesture and clears the guides', () => {
    snapDoc()
    render(<PreviewPanel />)
    const canvas = screen.getByTestId('preview-canvas')
    canvasRect(canvas)
    const parts = gizmoParts()

    fireEvent.pointerDown(parts.move, { button: 0, pointerId: 14, ...client(960, 540) })
    fireEvent.pointerMove(parts.gizmo, { pointerId: 14, clientX: 201, clientY: 112.5 })
    expect(screen.getByTestId('canvas-snap-guide-x')).toBeInTheDocument()

    act(() => useEditorStore.getState().setPlaying(true))
    expect(screen.queryByTestId('canvas-snap-guide-x')).not.toBeInTheDocument()
    fireEvent.pointerMove(parts.gizmo, { pointerId: 14, clientX: 240, clientY: 112.5 })
    expect(
      useEditorStore.getState().doc.project.tracks[0].clips[0].animStatics?.positionX,
    ).toBeUndefined()
    fireEvent.pointerUp(parts.gizmo, { pointerId: 14 })
  })

  it('a paused playhead step mid-drag also cancels', () => {
    snapDoc()
    render(<PreviewPanel />)
    const canvas = screen.getByTestId('preview-canvas')
    canvasRect(canvas)
    const parts = gizmoParts()

    fireEvent.pointerDown(parts.move, { button: 0, pointerId: 15, ...client(960, 540) })
    act(() => useEditorStore.getState().setPlayhead(2))
    fireEvent.pointerMove(parts.gizmo, { pointerId: 15, clientX: 240, clientY: 112.5 })
    expect(
      useEditorStore.getState().doc.project.tracks[0].clips[0].animStatics?.positionX,
    ).toBeUndefined()
    fireEvent.pointerUp(parts.gizmo, { pointerId: 15 })
  })
})

describe('Inspector snapping control (0.29.5)', () => {
  it('binds the shared snap flag and explains timeline or monitor selection', () => {
    const asset = imageAsset()
    const clip = createClip({ id: 'clip_img', mediaId: asset.id, start: 0, duration: 4 })
    useEditorStore.setState({
      doc: docWith([createTrack('video', 1, { clips: [clip] })], [asset]),
      selection: clip.id,
      selections: [clip.id],
      playhead: 1,
    })
    render(<InspectorPanel />)

    const snapping = screen.getByLabelText('Snapping')
    expect(snapping).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(snapping)
    expect(useEditorStore.getState().snapEnabled).toBe(false)

    expect(screen.getByText(/Select a clip in the timeline or monitor/)).toBeInTheDocument()
  })
})

describe('monitor gesture start (0.29.6)', () => {
  function pauseTo(playhead: number) {
    playbackRef.current = {
      pause: () => {
        const store = useEditorStore.getState()
        store.setPlaying(false)
        store.setPlayhead(playhead)
      },
    } as unknown as typeof playbackRef.current
  }

  function movingClip() {
    const asset = imageAsset({ width: 200, height: 200 })
    const clip = createClip({
      id: 'clip_moving',
      mediaId: asset.id,
      start: 0,
      duration: 4,
      keyframes: {
        positionX: [
          { time: 0, value: 0 },
          { time: 3, value: 300 },
        ],
      },
    })
    useEditorStore.setState({
      doc: docWith([createTrack('video', 1, { clips: [clip] })], [asset]),
      selection: clip.id,
      selections: [clip.id],
      playhead: 1,
      playing: true,
    })
    return clip
  }

  it('consumes the press when the pause moves the playhead, then writes from the paused frame', () => {
    movingClip()
    render(<PreviewPanel />)
    const canvas = screen.getByTestId('preview-canvas')
    canvasRect(canvas)
    const parts = gizmoParts()
    pauseTo(2)

    fireEvent.pointerDown(parts.move, { button: 0, pointerId: 21, ...client(960, 540) })
    expect(isTransientActive()).toBe(false)
    expect(useEditorStore.getState().past).toHaveLength(0)

    fireEvent.pointerDown(parts.move, { button: 0, pointerId: 21, ...client(960, 540) })
    fireEvent.pointerMove(parts.gizmo, { pointerId: 21, ...client(960 + 48, 540) })
    const kfs = useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.positionX
    expect(kfs?.find((keyframe) => Math.abs(keyframe.time - 2) < 1e-6)?.value).toBeCloseTo(248, 5)
    fireEvent.pointerUp(parts.gizmo, { pointerId: 21 })
    expect(useEditorStore.getState().past).toHaveLength(1)
  })

  it('refuses the press when playing has no controller to pause', () => {
    movingClip()
    playbackRef.current = null
    render(<PreviewPanel />)
    const canvas = screen.getByTestId('preview-canvas')
    canvasRect(canvas)
    const parts = gizmoParts()

    fireEvent.pointerDown(parts.move, { button: 0, pointerId: 22, ...client(960, 540) })
    expect(isTransientActive()).toBe(false)
    expect(useEditorStore.getState().playing).toBe(true)
    expect(useEditorStore.getState().past).toHaveLength(0)
  })

  it('consumes a press that lands on a stale overlay after a playhead jump', () => {
    movingClip()
    useEditorStore.setState({ playing: false })
    render(<PreviewPanel />)
    const canvas = screen.getByTestId('preview-canvas')
    canvasRect(canvas)
    const parts = gizmoParts()

    act(() => {
      startTransition(() => useEditorStore.getState().setPlayhead(2))
      fireEvent.pointerDown(parts.move, { button: 0, pointerId: 23, ...client(960, 540) })
    })
    expect(isTransientActive()).toBe(false)
    expect(useEditorStore.getState().past).toHaveLength(0)
  })

  it('still selects another clip while the store leads the render', () => {
    const asset = imageAsset({ width: 200, height: 200 })
    const bottom = createClip({ id: 'clip_bottom', mediaId: asset.id, start: 0, duration: 4 })
    const top = createClip({ id: 'clip_top', mediaId: asset.id, start: 0, duration: 4 })
    useEditorStore.setState({
      doc: docWith(
        [createTrack('video', 1, { clips: [top] }), createTrack('video', 2, { clips: [bottom] })],
        [asset],
      ),
      selection: bottom.id,
      selections: [bottom.id],
      playhead: 1,
    })
    render(<PreviewPanel />)
    const canvas = screen.getByTestId('preview-canvas')
    canvasRect(canvas)
    const parts = gizmoParts()

    act(() => {
      startTransition(() => useEditorStore.getState().setPlayhead(2))
      fireEvent.pointerDown(parts.move, { button: 0, pointerId: 24, ...client(960, 540) })
    })
    expect(useEditorStore.getState().selection).toBe(top.id)
    expect(isTransientActive()).toBe(false)
  })

  it('selects another clip while playing without pausing', () => {
    const asset = imageAsset({ width: 200, height: 200 })
    const bottom = createClip({ id: 'clip_bottom', mediaId: asset.id, start: 0, duration: 4 })
    const top = createClip({ id: 'clip_top', mediaId: asset.id, start: 0, duration: 4 })
    useEditorStore.setState({
      doc: docWith(
        [createTrack('video', 1, { clips: [top] }), createTrack('video', 2, { clips: [bottom] })],
        [asset],
      ),
      selection: bottom.id,
      selections: [bottom.id],
      playhead: 1,
      playing: true,
    })
    let paused = false
    playbackRef.current = {
      pause: () => {
        paused = true
      },
    } as unknown as typeof playbackRef.current
    render(<PreviewPanel />)
    const canvas = screen.getByTestId('preview-canvas')
    canvasRect(canvas)

    fireEvent.pointerDown(canvas, { button: 0, ...client(960, 540) })
    expect(useEditorStore.getState().selection).toBe(top.id)
    expect(paused).toBe(false)
    expect(useEditorStore.getState().playing).toBe(true)
  })

  it('consumes the press when the overlay still shows the previous selection', () => {
    const asset = imageAsset({ width: 200, height: 200 })
    const first = createClip({ id: 'clip_first', mediaId: asset.id, start: 0, duration: 4 })
    const second = createClip({ id: 'clip_second', mediaId: asset.id, start: 0, duration: 4 })
    useEditorStore.setState({
      doc: docWith(
        [createTrack('video', 1, { clips: [first] }), createTrack('video', 2, { clips: [second] })],
        [asset],
      ),
      selection: first.id,
      selections: [first.id],
      playhead: 1,
    })
    render(<PreviewPanel />)
    const canvas = screen.getByTestId('preview-canvas')
    canvasRect(canvas)
    const parts = gizmoParts()

    act(() => {
      startTransition(() => useEditorStore.getState().select(second.id))
      fireEvent.pointerDown(parts.move, { button: 0, pointerId: 25, ...client(960, 540) })
    })
    expect(isTransientActive()).toBe(false)
    expect(useEditorStore.getState().past).toHaveLength(0)
  })
})

describe('locked monitor tracks (0.29.6)', () => {
  it('selects a top clip inside a stale locked gizmo before the lock toast', () => {
    const { parts, topId, lock } = staleLockedGizmo(true)
    let paused = false
    playbackRef.current = {
      pause: () => {
        paused = true
      },
    } as unknown as typeof playbackRef.current

    act(() => {
      startTransition(lock)
      fireEvent.pointerDown(parts.move, { button: 0, pointerId: 41, ...client(960, 540) })
    })

    expect(useEditorStore.getState().selection).toBe(topId)
    expect(toast).not.toHaveBeenCalled()
    expect(paused).toBe(false)
    expect(isTransientActive()).toBe(false)
  })

  it('shows the lock toast for a stale locked clip move', () => {
    const { parts, lock } = staleLockedGizmo(false)
    let paused = false
    playbackRef.current = {
      pause: () => {
        paused = true
      },
    } as unknown as typeof playbackRef.current

    act(() => {
      startTransition(lock)
      fireEvent.pointerDown(parts.move, { button: 0, pointerId: 42, ...client(960, 540) })
    })

    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Track locked',
        description: 'Track V1 is locked. Unlock it to edit its clips.',
      }),
    )
    expect(paused).toBe(false)
    expect(isTransientActive()).toBe(false)
  })

  it('shows the lock toast for a stale locked scale handle', () => {
    const { parts, lock } = staleLockedGizmo(false)

    act(() => {
      startTransition(lock)
      fireEvent.pointerDown(parts.scale, { button: 0, pointerId: 43, ...client(960, 540) })
    })

    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Track locked' }))
    expect(isTransientActive()).toBe(false)
  })

  it('shows the lock toast for a stale locked rotate handle', () => {
    const { parts, lock } = staleLockedGizmo(false)

    act(() => {
      startTransition(lock)
      fireEvent.pointerDown(parts.rotate, { button: 0, pointerId: 44, ...client(960, 540) })
    })

    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Track locked' }))
    expect(isTransientActive()).toBe(false)
  })
})
