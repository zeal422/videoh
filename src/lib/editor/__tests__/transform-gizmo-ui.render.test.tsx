// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import { PreviewPanel } from '@/components/editor/PreviewPanel'
import { installBrowserMocks, type MockHarness } from './mocks/browser-mocks'
import { isTransientActive, useEditorStore } from '../store'
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
  if (isTransientActive()) useEditorStore.getState().cancelTransient()
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

  it('a playhead move mid-drag cancels the gesture instead of writing at a stale time', () => {
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
    // The cached snap targets and the captured keyframe time belong to the
    // pointer-down playhead, so a playhead move cancels the gesture.
    useEditorStore.setState({ playhead: 3 })
    const gizmo = screen.getByTestId('transform-gizmo')
    fireEvent.pointerMove(gizmo, { pointerId: 6, clientX: 269.7, clientY: 112.5 })
    fireEvent.pointerUp(gizmo, { pointerId: 6 })

    const clip = useEditorStore.getState().doc.project.tracks[0].clips[0]
    expect(clip.keyframes?.rotation).toEqual([{ time: 0, value: 0, interpolation: 'linear' }])
    expect(clip.rotation).toBeUndefined()
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

  it('snaps rotation to the nearest 15-degree step within 3 degrees', () => {
    docWithSelectedClip()
    render(<PreviewPanel />)
    const canvas = screen.getByTestId('preview-canvas')
    canvasRect(canvas)
    const parts = gizmoParts()

    // The handle starts above the box center: client (200, 42.75), radius
    // 69.75. Drag to 44 degrees from the top.
    const radians = ((-90 + 44) * Math.PI) / 180
    fireEvent.pointerDown(parts.rotate, { button: 0, pointerId: 21, clientX: 200, clientY: 42.75 })
    fireEvent.pointerMove(parts.gizmo, {
      pointerId: 21,
      clientX: 200 + 69.75 * Math.cos(radians),
      clientY: 112.5 + 69.75 * Math.sin(radians),
    })
    fireEvent.pointerUp(parts.gizmo, { pointerId: 21 })
    expect(useEditorStore.getState().doc.project.tracks[0].clips[0].rotation).toBeCloseTo(45, 3)
  })

  it('leaves rotation unsnapped when snapping is off, and keeps authored turns', () => {
    docWithSelectedClip({ rotation: 720 })
    useEditorStore.setState({ snapEnabled: false })
    render(<PreviewPanel />)
    const canvas = screen.getByTestId('preview-canvas')
    canvasRect(canvas)
    const parts = gizmoParts()

    const radians = ((-90 + 1) * Math.PI) / 180
    fireEvent.pointerDown(parts.rotate, { button: 0, pointerId: 22, clientX: 200, clientY: 42.75 })
    fireEvent.pointerMove(parts.gizmo, {
      pointerId: 22,
      clientX: 200 + 69.75 * Math.cos(radians),
      clientY: 112.5 + 69.75 * Math.sin(radians),
    })
    fireEvent.pointerUp(parts.gizmo, { pointerId: 22 })
    // 720 is two authored turns and 721 is not a step: snapping off keeps 721.
    expect(useEditorStore.getState().doc.project.tracks[0].clips[0].rotation).toBeCloseTo(721, 3)

    useEditorStore.setState({ snapEnabled: true })
    fireEvent.pointerDown(parts.rotate, { button: 0, pointerId: 23, clientX: 200, clientY: 42.75 })
    fireEvent.pointerMove(parts.gizmo, {
      pointerId: 23,
      clientX: 200 + 69.75 * Math.cos(radians),
      clientY: 112.5 + 69.75 * Math.sin(radians),
    })
    fireEvent.pointerUp(parts.gizmo, { pointerId: 23 })
    // Snapping on, 721 becomes 720: still two turns, not a folded 0.
    expect(useEditorStore.getState().doc.project.tracks[0].clips[0].rotation).toBeCloseTo(720, 3)
  })

  it('an empty press on the move box clears the selection instead of transforming', () => {
    docWithSelectedClip({ opacity: 0 })
    render(<PreviewPanel />)
    const canvas = screen.getByTestId('preview-canvas')
    canvasRect(canvas)
    const parts = gizmoParts()

    // The picker skips a fully transparent clip, but its gizmo still draws.
    fireEvent.pointerDown(parts.move, {
      button: 0,
      pointerId: 70,
      clientX: 200,
      clientY: 112.5,
    })
    expect(useEditorStore.getState().selection).toBeNull()
    expect(useEditorStore.getState().past).toHaveLength(0)
  })

  it('Ctrl-click on the selected clip toggles its selection instead of moving', () => {
    const { clipId } = docWithSelectedClip()
    render(<PreviewPanel />)
    const canvas = screen.getByTestId('preview-canvas')
    canvasRect(canvas)
    const parts = gizmoParts()

    fireEvent.pointerDown(parts.move, {
      button: 0,
      pointerId: 71,
      ctrlKey: true,
      clientX: 200,
      clientY: 112.5,
    })
    expect(useEditorStore.getState().selection).toBeNull()
    expect(useEditorStore.getState().doc.project.tracks[0].clips[0].id).toBe(clipId)
    expect(useEditorStore.getState().past).toHaveLength(0)
  })

  it('a proportional drag keeps a pre-stretched clip off the uniform scale field', () => {
    const clip = createTextClip({ id: 'clip_ps', start: 0, duration: 4, stretchX: 2 })
    const track = createTrack('text', 1, { clips: [clip] })
    const doc: Doc = {
      project: { tracks: [track], id: 'p_test', name: 'test', width: 1920, height: 1080, fps: 30 },
      media: [],
    }
    useEditorStore.setState({ doc, selection: clip.id, selections: [clip.id], playhead: 1 })
    render(<PreviewPanel />)
    const canvas = screen.getByTestId('preview-canvas')
    canvasRect(canvas)
    const gizmo = screen.getByTestId('transform-gizmo')
    const corner = gizmo.querySelectorAll('[data-gizmo="scale"]')[2] as Element
    const cx = Number(corner.getAttribute('cx')) / 4.8
    const cy = Number(corner.getAttribute('cy')) / 4.8

    fireEvent.pointerDown(corner, {
      button: 0,
      pointerId: 72,
      clientX: cx,
      clientY: cy,
    })
    fireEvent.pointerMove(gizmo, { pointerId: 72, clientX: cx, clientY: cy })
    fireEvent.pointerUp(gizmo, { pointerId: 72 })

    const moved = useEditorStore.getState().doc.project.tracks[0].clips[0]
    expect(moved.stretchX).toBe(2)
    // Pointer did not move: the uniform scale must not absorb the stretch.
    expect(moved.animStatics?.scale).toBeUndefined()
  })

  it('cancelling for Play removes the Shift window listeners', () => {
    docWithSelectedClip()
    render(<PreviewPanel />)
    const canvas = screen.getByTestId('preview-canvas')
    canvasRect(canvas)
    const parts = gizmoParts()
    const remove = vi.spyOn(window, 'removeEventListener')

    fireEvent.pointerDown(parts.corners[2]!, {
      button: 0,
      pointerId: 73,
      clientX: 400,
      clientY: 168.75,
      shiftKey: true,
    })
    act(() => useEditorStore.getState().setPlaying(true))
    expect(remove).toHaveBeenCalledWith('keydown', expect.any(Function))
    expect(remove).toHaveBeenCalledWith('keyup', expect.any(Function))
    remove.mockRestore()
  })

  it('hides the gizmo while the eyedropper is armed', () => {
    const { clipId } = docWithSelectedClip()
    render(<PreviewPanel />)
    expect(screen.getByTestId('transform-gizmo')).toBeInTheDocument()

    // The overlay's box and handles swallow canvas clicks, so they must yield
    // while sampling.
    act(() => {
      useEditorStore.getState().setEyedropper({ clipId, effectId: 'fx' })
    })
    expect(screen.queryByTestId('transform-gizmo')).not.toBeInTheDocument()

    act(() => {
      useEditorStore.getState().setEyedropper(null)
    })
    expect(screen.getByTestId('transform-gizmo')).toBeInTheDocument()
  })

  it('hit-tests only its box and handles, leaving the canvas reachable', () => {
    // The SVG root spans the whole monitor. Without pointer-events: none it
    // absorbs every canvas click, and the monitor's text drag (which starts on
    // the canvas) can never run. The move box and the handles opt back in.
    const src = readFileSync('src/components/editor/TransformGizmo.tsx', 'utf8')
    const openTag = src.slice(src.indexOf('<svg'), src.indexOf('>', src.indexOf('<svg')) + 1)
    expect(openTag).toMatch(/pointerEvents: 'none'|pointer-events-none/)
    expect(src.match(/pointerEvents: 'all'/g)?.length ?? 0).toBeGreaterThanOrEqual(3)
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

  it('unmounting mid-drag cancels the gesture instead of leaving it open', () => {
    docWithSelectedClip()
    const { unmount } = render(<PreviewPanel />)
    const canvas = screen.getByTestId('preview-canvas')
    canvasRect(canvas)
    const parts = gizmoParts()

    fireEvent.pointerDown(parts.rotate, { button: 0, pointerId: 61, clientX: 200, clientY: 42.75 })
    fireEvent.pointerMove(parts.gizmo, { pointerId: 61, clientX: 269.7, clientY: 112.5 })
    unmount()

    expect(isTransientActive()).toBe(false)
    expect(useEditorStore.getState().doc.project.tracks[0].clips[0].rotation).toBeUndefined()
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

describe('monitor handle sizing (0.29.5)', () => {
  function withCanvasSize(width: number, height: number, run: () => void) {
    const original = HTMLCanvasElement.prototype.getBoundingClientRect
    HTMLCanvasElement.prototype.getBoundingClientRect = function () {
      return {
        left: 0,
        top: 0,
        right: width,
        bottom: height,
        width,
        height,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect
    }
    try {
      run()
    } finally {
      HTMLCanvasElement.prototype.getBoundingClientRect = original
    }
  }

  function radii() {
    const gizmo = screen.getByTestId('transform-gizmo')
    const visual = gizmo.querySelector('[data-gizmo-visual="scale"]') as SVGCircleElement
    const hit = gizmo.querySelector('[data-gizmo="scale"]') as SVGCircleElement
    return { visual: Number(visual.getAttribute('r')), hit: Number(hit.getAttribute('r')) }
  }

  it('keeps a 10px visible dot and a 24px hit target at 400 and 1600 CSS px', () => {
    docWithSelectedClip()
    withCanvasSize(400, 225, () => {
      render(<PreviewPanel />)
      const r = radii()
      // cssScale = 400/1920: a 5px CSS radius is 24 project px.
      expect(r.visual).toBeCloseTo(24, 6)
      expect(r.hit).toBeCloseTo(57.6, 6)
      expect(r.visual * 2 * (400 / 1920)).toBeCloseTo(10, 6)
      expect(r.hit * 2 * (400 / 1920)).toBeCloseTo(24, 6)
      cleanup()
    })

    withCanvasSize(1600, 900, () => {
      render(<PreviewPanel />)
      const r = radii()
      expect(r.visual * 2 * (1600 / 1920)).toBeCloseTo(10, 6)
      expect(r.hit * 2 * (1600 / 1920)).toBeCloseTo(24, 6)
      cleanup()
    })
  })

  it('updates through ResizeObserver and disconnects on unmount', () => {
    const triggers: (() => void)[] = []
    let disconnected = false
    class FakeObserver {
      constructor(callback: ResizeObserverCallback) {
        triggers.push(() => callback([], this as unknown as ResizeObserver))
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {
        disconnected = true
      }
    }
    const harnessObserver = globalThis.ResizeObserver
    vi.stubGlobal('ResizeObserver', FakeObserver)
    docWithSelectedClip()
    let width = 400
    const original = HTMLCanvasElement.prototype.getBoundingClientRect
    HTMLCanvasElement.prototype.getBoundingClientRect = function () {
      return {
        left: 0,
        top: 0,
        right: width,
        bottom: (width * 9) / 16,
        width,
        height: (width * 9) / 16,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect
    }
    try {
      const { unmount } = render(<PreviewPanel />)
      expect(triggers.length).toBeGreaterThan(0)
      expect(radii().hit).toBeCloseTo(57.6, 6)
      width = 1600
      act(() => {
        for (const trigger of triggers) trigger()
      })
      expect(radii().hit).toBeCloseTo(14.4, 6)
      unmount()
      expect(disconnected).toBe(true)
    } finally {
      HTMLCanvasElement.prototype.getBoundingClientRect = original
      vi.stubGlobal('ResizeObserver', harnessObserver)
    }
  })

  it('falls back to the project-relative pair for an unmeasured rect', () => {
    const originalRect = HTMLCanvasElement.prototype.getBoundingClientRect
    // jsdom's default zero rect stays unmeasured (the harness ResizeObserver
    // never fires, like the first paint before a real one).
    HTMLCanvasElement.prototype.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }) as DOMRect
    try {
      docWithSelectedClip()
      render(<PreviewPanel />)
      const r = radii()
      expect(r.visual).toBeCloseTo(Math.max(5, 1920 * 0.007), 6)
      expect(r.hit).toBeCloseTo(Math.max(10, 1920 * 0.014), 6)
      expect(r.hit).toBeGreaterThan(r.visual)
    } finally {
      HTMLCanvasElement.prototype.getBoundingClientRect = originalRect
    }

    // The no-ResizeObserver path is a static lock: Radix's own slider needs
    // ResizeObserver, so the real listener wiring cannot be rendered here.
    const src = readFileSync('src/components/editor/PreviewPanel.tsx', 'utf8')
    expect(src).toContain("typeof ResizeObserver !== 'undefined'")
    expect(src).toContain("window.addEventListener('resize', measure)")
    expect(src).toContain("window.removeEventListener('resize', measure)")
  })
})

describe('Shift non-uniform scaling (0.29.5)', () => {
  function cornerDrag(
    pointerId: number,
    moveTo: { clientX: number; clientY: number },
    opts: { shiftKey?: boolean } = {},
  ) {
    const canvas = screen.getByTestId('preview-canvas')
    canvasRect(canvas)
    const gizmo = screen.getByTestId('transform-gizmo')
    const corner = gizmo.querySelectorAll('[data-gizmo="scale"]')[2] as Element
    fireEvent.pointerDown(corner, {
      button: 0,
      pointerId,
      clientX: 400,
      clientY: 168.75,
      shiftKey: opts.shiftKey ?? false,
    })
    fireEvent.pointerMove(gizmo, { pointerId, ...moveTo, shiftKey: opts.shiftKey ?? false })
    return gizmo
  }

  it('changes both axes independently and leaves the uniform scale alone', () => {
    docWithSelectedClip()
    render(<PreviewPanel />)
    const gizmo = cornerDrag(31, { clientX: 450, clientY: 180 }, { shiftKey: true })
    const clip = useEditorStore.getState().doc.project.tracks[0].clips[0]
    expect(clip.stretchX).toBeCloseTo(1.25, 5)
    expect(clip.stretchY).toBeCloseTo(1.2, 5)
    expect(clip.animStatics?.scale).toBeUndefined()
    fireEvent.pointerUp(gizmo, { pointerId: 31, shiftKey: true })
    expect(useEditorStore.getState().past).toHaveLength(1)
  })

  it('releasing Shift with no pointermove returns the preview to proportional', () => {
    docWithSelectedClip()
    render(<PreviewPanel />)
    const gizmo = cornerDrag(32, { clientX: 450, clientY: 168.75 }, { shiftKey: true })
    expect(useEditorStore.getState().doc.project.tracks[0].clips[0].stretchX).toBeCloseTo(1.25, 5)

    fireEvent.keyUp(window, { key: 'Shift' })
    const clip = useEditorStore.getState().doc.project.tracks[0].clips[0]
    expect(clip.stretchX).toBeUndefined()
    expect(clip.animStatics?.scale).toBeGreaterThan(1)
    fireEvent.pointerUp(gizmo, { pointerId: 32 })
  })

  it('pressing Shift after a uniform preview discards it and applies stretch', () => {
    docWithSelectedClip()
    render(<PreviewPanel />)
    const canvas = screen.getByTestId('preview-canvas')
    canvasRect(canvas)
    const gizmo = screen.getByTestId('transform-gizmo')
    const corner = gizmo.querySelectorAll('[data-gizmo="scale"]')[2] as Element
    fireEvent.pointerDown(corner, { button: 0, pointerId: 33, clientX: 400, clientY: 168.75 })
    fireEvent.pointerMove(gizmo, { pointerId: 33, clientX: 450, clientY: 168.75 })
    expect(
      useEditorStore.getState().doc.project.tracks[0].clips[0].animStatics?.scale,
    ).toBeGreaterThan(1)

    fireEvent.keyDown(window, { key: 'Shift' })
    const clip = useEditorStore.getState().doc.project.tracks[0].clips[0]
    expect(clip.animStatics?.scale).toBeUndefined()
    expect(clip.stretchX).toBeCloseTo(1.25, 5)
    fireEvent.pointerUp(gizmo, { pointerId: 33, shiftKey: true })
    expect(useEditorStore.getState().doc.project.tracks[0].clips[0].stretchX).toBeCloseTo(1.25, 5)
  })

  it('a pre-stretched clip multiplies the captured stretch, not the effective scale', () => {
    docWithSelectedClip({ stretchX: 1.5, animStatics: { scale: 2 } })
    render(<PreviewPanel />)
    const canvas = screen.getByTestId('preview-canvas')
    canvasRect(canvas)
    const gizmo = screen.getByTestId('transform-gizmo')
    const corner = gizmo.querySelectorAll('[data-gizmo="scale"]')[2] as Element
    // The captured 2x uniform scale plus 1.5 stretch puts the corner at project
    // (3840, 1350): client (800, 281.25). Pull it 25% further out (240 project
    // px = 50 client px): the captured stretch 1.5 * 1.25 = 1.875, never
    // 2 * 1.5 * 1.25.
    fireEvent.pointerDown(corner, {
      button: 0,
      pointerId: 34,
      clientX: 800,
      clientY: 281.25,
      shiftKey: true,
    })
    fireEvent.pointerMove(gizmo, { pointerId: 34, clientX: 950, clientY: 281.25, shiftKey: true })
    const stretchX = useEditorStore.getState().doc.project.tracks[0].clips[0].stretchX
    expect(stretchX).toBeCloseTo(1.875, 5)
    expect(stretchX).not.toBeCloseTo(3.75, 5)
    fireEvent.pointerUp(gizmo, { pointerId: 34, shiftKey: true })
  })

  it('a scale curve stays untouched while Shift stretches, then release edits it', () => {
    docWithSelectedClip({
      keyframes: { scale: [{ time: 0, value: 1, interpolation: 'linear' }] },
    })
    render(<PreviewPanel />)
    const gizmo = cornerDrag(35, { clientX: 450, clientY: 168.75 }, { shiftKey: true })
    const stretched = useEditorStore.getState().doc.project.tracks[0].clips[0]
    expect(stretched.stretchX).toBeCloseTo(1.25, 5)
    expect(stretched.keyframes?.scale).toEqual([{ time: 0, value: 1, interpolation: 'linear' }])

    fireEvent.pointerUp(gizmo, { pointerId: 35, shiftKey: false, clientX: 450, clientY: 168.75 })
    const released = useEditorStore.getState().doc.project.tracks[0].clips[0]
    expect(released.stretchX).toBeUndefined()
    expect(
      released.keyframes?.scale?.find((k) => Math.abs(k.time - 1) < 1e-6)?.value,
    ).toBeGreaterThan(1)
  })

  it('preserves the grab offset so a press inside the hit target does not jump', () => {
    docWithSelectedClip()
    render(<PreviewPanel />)
    const canvas = screen.getByTestId('preview-canvas')
    canvasRect(canvas)
    const gizmo = screen.getByTestId('transform-gizmo')
    const corner = gizmo.querySelectorAll('[data-gizmo="scale"]')[2] as Element
    fireEvent.pointerDown(corner, {
      button: 0,
      pointerId: 36,
      clientX: 397,
      clientY: 167,
      shiftKey: true,
    })
    fireEvent.pointerMove(gizmo, { pointerId: 36, clientX: 398, clientY: 168, shiftKey: true })
    const stretchX = useEditorStore.getState().doc.project.tracks[0].clips[0].stretchX
    expect(stretchX ?? 1).toBeCloseTo(1, 2)
    fireEvent.pointerUp(gizmo, { pointerId: 36, shiftKey: true })
  })
})
