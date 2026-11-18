// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import { PreviewPanel } from '@/components/editor/PreviewPanel'
import { installBrowserMocks, type MockHarness } from './mocks/browser-mocks'
import { useEditorStore } from '../store'
import { createClip, createMediaAsset, createTextClip, createTrack } from '../factories'
import type { Doc, MediaAsset } from '../types'

/**
 * Monitor transform gizmo (0.24.0): a selected visual clip exposes a rotated
 * box, corner scale handles, and a rotation handle. Drags are transient
 * gestures (one undo entry on release), and an animated rotation gets a
 * keyframe at the playhead instead of the static fallback.
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

function imageAsset(): MediaAsset {
  return createMediaAsset({
    id: 'media_img',
    kind: 'image',
    name: 'still.png',
    duration: 10,
    width: 640,
    height: 180,
    url: 'blob:still',
  })
}

function docWithSelectedClip(partial: Parameters<typeof createClip>[0] = {}): {
  doc: Doc
  clipId: string
} {
  const asset = imageAsset()
  const clip = createClip({
    id: 'clip_v',
    mediaId: asset.id,
    start: 0,
    duration: 4,
    inPoint: 0,
    ...partial,
  })
  const track = createTrack('video', 1, { clips: [clip] })
  const doc: Doc = {
    project: { tracks: [track], id: 'p_test', name: 'test', width: 1920, height: 1080, fps: 30 },
    media: [asset],
  }
  useEditorStore.setState({ doc, selection: clip.id, selections: [clip.id], playhead: 1 })
  return { doc, clipId: clip.id }
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
    corners: [...gizmo.querySelectorAll('[data-gizmo="scale"]')] as Element[],
    rotate: gizmo.querySelector('[data-gizmo="rotate"]') as Element,
  }
}

describe('monitor transform gizmo', () => {
  it('shows for a selected visual clip and hides for a locked lane or an audio clip', () => {
    docWithSelectedClip()
    const { rerender } = render(<PreviewPanel />)
    expect(screen.getByTestId('transform-gizmo')).toBeInTheDocument()

    const doc = useEditorStore.getState().doc
    doc.project.tracks[0].locked = true
    useEditorStore.setState({ doc: { ...doc } })
    rerender(<PreviewPanel />)
    expect(screen.queryByTestId('transform-gizmo')).not.toBeInTheDocument()

    doc.project.tracks[0].locked = false
    doc.project.tracks[0].kind = 'audio'
    useEditorStore.setState({ doc: { ...doc } })
    rerender(<PreviewPanel />)
    expect(screen.queryByTestId('transform-gizmo')).not.toBeInTheDocument()
  })

  it('moves with one undo entry per drag', () => {
    docWithSelectedClip()
    render(<PreviewPanel />)
    const canvas = screen.getByTestId('preview-canvas')
    canvasRect(canvas)
    const parts = gizmoParts()
    const before = useEditorStore.getState().past.length

    fireEvent.pointerDown(parts.move, { button: 0, pointerId: 1, clientX: 200, clientY: 112.5 })
    fireEvent.pointerMove(parts.gizmo, { pointerId: 1, clientX: 248, clientY: 112.5 })
    expect(
      useEditorStore.getState().doc.project.tracks[0].clips[0].animStatics?.positionX,
    ).toBeCloseTo(230.4, 4)
    fireEvent.pointerUp(parts.gizmo, { pointerId: 1 })

    expect(useEditorStore.getState().past.length).toBe(before + 1)
    expect(
      useEditorStore.getState().doc.project.tracks[0].clips[0].animStatics?.positionX,
    ).toBeCloseTo(230.4, 4)
  })

  it('scales from a corner handle', () => {
    docWithSelectedClip()
    render(<PreviewPanel />)
    const canvas = screen.getByTestId('preview-canvas')
    canvasRect(canvas)
    const parts = gizmoParts()
    const corner = parts.corners[2]

    // The image box is 1920x540 centered: the bottom-right corner sits at
    // project (1920, 810) = client (400, 168.75). Drag it outward.
    fireEvent.pointerDown(corner, { button: 0, pointerId: 2, clientX: 400, clientY: 168.75 })
    fireEvent.pointerMove(parts.gizmo, { pointerId: 2, clientX: 420, clientY: 177 })
    const statics = useEditorStore.getState().doc.project.tracks[0].clips[0].animStatics
    expect(statics?.scale).toBeGreaterThan(1)
    fireEvent.pointerUp(parts.gizmo, { pointerId: 2 })
    expect(useEditorStore.getState().past.length).toBe(1)
  })

  it('writes a rotation keyframe at the playhead when a curve exists', () => {
    docWithSelectedClip({
      keyframes: {
        rotation: [{ time: 0, value: 0, interpolation: 'linear' }],
      },
    })
    render(<PreviewPanel />)
    const canvas = screen.getByTestId('preview-canvas')
    canvasRect(canvas)
    const parts = gizmoParts()

    // Handle starts above the box center (project 960, 540): client (200, 42.75).
    fireEvent.pointerDown(parts.rotate, { button: 0, pointerId: 3, clientX: 200, clientY: 42.75 })
    // Drag to the right of the center at the same distance: a +90 degree turn.
    fireEvent.pointerMove(parts.gizmo, { pointerId: 3, clientX: 269.7, clientY: 112.5 })
    fireEvent.pointerUp(parts.gizmo, { pointerId: 3 })

    const clip = useEditorStore.getState().doc.project.tracks[0].clips[0]
    expect(clip.rotation).toBeUndefined()
    expect(clip.keyframes?.rotation?.find((k) => Math.abs(k.time - 1) < 1e-6)?.value).toBeCloseTo(
      90,
      3,
    )
  })

  it('writes the keyframe at the drag-start time when the playhead moves mid-drag', () => {
    docWithSelectedClip({
      keyframes: {
        rotation: [{ time: 0, value: 0, interpolation: 'linear' }],
      },
    })
    render(<PreviewPanel />)
    const canvas = screen.getByTestId('preview-canvas')
    canvasRect(canvas)
    const parts = gizmoParts()

    fireEvent.pointerDown(parts.rotate, { button: 0, pointerId: 6, clientX: 200, clientY: 42.75 })
    // Playback or a scrub lands mid-drag: the write must stay at the captured time.
    useEditorStore.setState({ playhead: 3 })
    const gizmo = screen.getByTestId('transform-gizmo')
    fireEvent.pointerMove(gizmo, { pointerId: 6, clientX: 269.7, clientY: 112.5 })
    fireEvent.pointerUp(gizmo, { pointerId: 6 })

    const clip = useEditorStore.getState().doc.project.tracks[0].clips[0]
    expect(clip.keyframes?.rotation?.find((k) => Math.abs(k.time - 1) < 1e-6)?.value).toBeCloseTo(
      90,
      3,
    )
    expect(clip.keyframes?.rotation?.some((k) => Math.abs(k.time - 3) < 1e-6)).toBe(false)
  })

  it('moves a text clip through its style fields and keeps the old canvas drag', () => {
    const clip = createTextClip({ id: 'clip_t', start: 0, duration: 4 })
    const track = createTrack('text', 1, { clips: [clip] })
    const doc: Doc = {
      project: { tracks: [track], id: 'p_test', name: 'test', width: 1920, height: 1080, fps: 30 },
      media: [],
    }
    useEditorStore.setState({ doc, selection: clip.id, selections: [clip.id], playhead: 1 })
    render(<PreviewPanel />)
    const canvas = screen.getByTestId('preview-canvas')
    canvasRect(canvas)
    const parts = gizmoParts()
    const startX = clip.style!.x

    fireEvent.pointerDown(parts.move, { button: 0, pointerId: 5, clientX: 200, clientY: 112.5 })
    fireEvent.pointerMove(parts.gizmo, { pointerId: 5, clientX: 248, clientY: 112.5 })
    fireEvent.pointerUp(parts.gizmo, { pointerId: 5 })

    const moved = useEditorStore.getState().doc.project.tracks[0].clips[0]
    expect(moved.style!.x).toBeCloseTo(startX + 48 / 400, 4)
    expect(moved.animStatics?.positionX).toBeUndefined()
  })

  it('writes static rotation when no curve exists', () => {
    docWithSelectedClip()
    render(<PreviewPanel />)
    const canvas = screen.getByTestId('preview-canvas')
    canvasRect(canvas)
    const parts = gizmoParts()

    fireEvent.pointerDown(parts.rotate, { button: 0, pointerId: 4, clientX: 200, clientY: 42.75 })
    fireEvent.pointerMove(parts.gizmo, { pointerId: 4, clientX: 269.7, clientY: 112.5 })
    fireEvent.pointerUp(parts.gizmo, { pointerId: 4 })

    const clip = useEditorStore.getState().doc.project.tracks[0].clips[0]
    expect(clip.rotation).toBeCloseTo(90, 3)
    expect(clip.keyframes?.rotation).toBeUndefined()
  })

  it('hides the gizmo while the eyedropper is armed', () => {
    const { clipId } = docWithSelectedClip()
    render(<PreviewPanel />)
    expect(screen.getByTestId('transform-gizmo')).toBeInTheDocument()

    // The overlay swallows canvas clicks, so it must yield while sampling.
    act(() => {
      useEditorStore.getState().setEyedropper({ clipId, effectId: 'fx' })
    })
    expect(screen.queryByTestId('transform-gizmo')).not.toBeInTheDocument()

    act(() => {
      useEditorStore.getState().setEyedropper(null)
    })
    expect(screen.getByTestId('transform-gizmo')).toBeInTheDocument()
  })

  it('keeps the rotation handle inside the frame for a full-frame clip', () => {
    const asset = createMediaAsset({
      id: 'media_full',
      kind: 'image',
      name: 'wide.png',
      duration: 10,
      width: 640,
      height: 360,
      url: 'blob:full',
    })
    const clip = createClip({ id: 'clip_f', mediaId: asset.id, start: 0, duration: 4, inPoint: 0 })
    const track = createTrack('video', 1, { clips: [clip] })
    const doc: Doc = {
      project: { tracks: [track], id: 'p_test', name: 'test', width: 1920, height: 1080, fps: 30 },
      media: [asset],
    }
    useEditorStore.setState({ doc, selection: clip.id, selections: [clip.id], playhead: 1 })
    render(<PreviewPanel />)

    // A 16:9 source contain-fits the 16:9 frame exactly, so the outward handle
    // would sit above the viewport; it must fall back inward instead.
    const rotate = screen
      .getByTestId('transform-gizmo')
      .querySelector('[data-gizmo="rotate"]') as Element
    const cy = Number(rotate.getAttribute('cy'))
    expect(cy).toBeGreaterThanOrEqual(0)
    expect(cy).toBeLessThanOrEqual(1080)
  })

  it('moves scaled text at pointer speed, not scale speed', () => {
    const clip = createTextClip({
      id: 'clip_ts',
      start: 0,
      duration: 4,
      animStatics: { scale: 2 },
    })
    const track = createTrack('text', 1, { clips: [clip] })
    const doc: Doc = {
      project: { tracks: [track], id: 'p_test', name: 'test', width: 1920, height: 1080, fps: 30 },
      media: [],
    }
    useEditorStore.setState({ doc, selection: clip.id, selections: [clip.id], playhead: 1 })
    render(<PreviewPanel />)
    const canvas = screen.getByTestId('preview-canvas')
    canvasRect(canvas)
    const parts = gizmoParts()
    const startX = clip.style!.x

    fireEvent.pointerDown(parts.move, { button: 0, pointerId: 7, clientX: 200, clientY: 112.5 })
    fireEvent.pointerMove(parts.gizmo, { pointerId: 7, clientX: 248, clientY: 112.5 })
    fireEvent.pointerUp(parts.gizmo, { pointerId: 7 })

    // 48 client px on a 400 px canvas = 230.4 project px, halved by scale 2.
    const moved = useEditorStore.getState().doc.project.tracks[0].clips[0]
    expect(moved.style!.x).toBeCloseTo(startX + 230.4 / 1920 / 2, 4)
  })

  it('a stale release does not commit after a foreign edit', () => {
    // Stability guard, not a red proof: HEAD's endGizmoDrag already compared
    // the token, so this passed before 0.28.4. It locks that ownership rule
    // against a future regression.
    docWithSelectedClip()
    render(<PreviewPanel />)
    const canvas = screen.getByTestId('preview-canvas')
    canvasRect(canvas)
    const parts = gizmoParts()

    fireEvent.pointerDown(parts.rotate, { button: 0, pointerId: 8, clientX: 200, clientY: 42.75 })
    // A foreign edit resolves the gizmo's gesture before the stale pointer
    // releases. The release must not roll that committed edit back or add a
    // second history entry.
    const live = useEditorStore.getState()
    live.apply({ type: 'setClipRotation', clipId: 'clip_v', rotation: 10 })
    const pastAfterApply = useEditorStore.getState().past.length
    fireEvent.pointerUp(screen.getByTestId('transform-gizmo'), { pointerId: 8 })

    expect(useEditorStore.getState().past.length).toBe(pastAfterApply)
    expect(useEditorStore.getState().doc.project.tracks[0].clips[0].rotation).toBe(10)
  })

  it('accumulates full turns without snapping at the half-turn', () => {
    docWithSelectedClip()
    render(<PreviewPanel />)
    const canvas = screen.getByTestId('preview-canvas')
    canvasRect(canvas)
    const parts = gizmoParts()

    fireEvent.pointerDown(parts.rotate, { button: 0, pointerId: 10, clientX: 200, clientY: 42.75 })
    const rad = (deg: number) => (deg * Math.PI) / 180
    const at = (deg: number) => ({
      clientX: ((960 + 200 * Math.cos(rad(deg))) / 1920) * 400,
      clientY: ((540 + 200 * Math.sin(rad(deg))) / 1080) * 225,
    })
    // 45-degree steps from -45 up: the fifth frame crosses the half-turn
    // opposite the grab point, where a net-from-start delta would snap.
    for (let k = 1; k <= 5; k++) {
      const p = at(-90 + 45 * k)
      fireEvent.pointerMove(parts.gizmo, { pointerId: 10, clientX: p.clientX, clientY: p.clientY })
    }
    expect(useEditorStore.getState().doc.project.tracks[0].clips[0].rotation).toBeCloseTo(225, 1)
    // A second full turn keeps adding instead of cancelling out.
    for (let k = 6; k <= 16; k++) {
      const p = at(-90 + 45 * k)
      fireEvent.pointerMove(parts.gizmo, { pointerId: 10, clientX: p.clientX, clientY: p.clientY })
    }
    fireEvent.pointerUp(parts.gizmo, { pointerId: 10 })

    const clip = useEditorStore.getState().doc.project.tracks[0].clips[0]
    expect(clip.rotation).toBeCloseTo(720, 0)
    expect(useEditorStore.getState().past.length).toBe(1)
  })

  it('clears the drag highlight when playback leaves the clip mid-drag', () => {
    docWithSelectedClip()
    render(<PreviewPanel />)
    const canvas = screen.getByTestId('preview-canvas')
    canvasRect(canvas)
    const parts = gizmoParts()

    fireEvent.pointerDown(parts.rotate, { button: 0, pointerId: 9, clientX: 200, clientY: 42.75 })
    const activeClass = screen
      .getByTestId('transform-gizmo')
      .querySelector('[data-gizmo="move"]')
      ?.getAttribute('class')
    expect(activeClass).toMatch(/fill-rose-400\/10/)

    // Playback carries the playhead past the clip: the SVG unmounts mid-drag.
    act(() => {
      useEditorStore.setState({ playhead: 5 })
    })
    expect(screen.queryByTestId('transform-gizmo')).not.toBeInTheDocument()

    // Back inside the clip the highlight must not be stuck on.
    act(() => {
      useEditorStore.setState({ playhead: 1 })
    })
    const resetClass = screen
      .getByTestId('transform-gizmo')
      .querySelector('[data-gizmo="move"]')
      ?.getAttribute('class')
    expect(resetClass).not.toMatch(/fill-rose-400\/10/)
  })
})
