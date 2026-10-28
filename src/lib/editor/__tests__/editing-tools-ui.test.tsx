// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'

import { Toolbar } from '@/components/editor/Toolbar'
import { TimelinePanel } from '@/components/editor/timeline/TimelinePanel'
import { useEditorKeyboard } from '@/hooks/editor/useEditorKeyboard'
import { toast } from '@/hooks/use-toast'
import { installBrowserMocks, type MockHarness } from './mocks/browser-mocks'
import { useEditorStore } from '../store'
import { createClip, createDoc, createMediaAsset, createTrack } from '../factories'
import type { Clip, Doc, MediaAsset } from '../types'

vi.mock('@/hooks/use-toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-toast')>()
  return { ...actual, toast: vi.fn() }
})

/**
 * 0.15.0 editing tools: the toolbar buttons, the B/Y shortcuts, and the
 * pointer matrix for Ripple Trim and Slip. The pure planners own the geometry;
 * these tests prove the UI routes to them, keeps one undo entry per gesture,
 * and never lets a modal tool move a clip.
 */

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')
const RULER_HEIGHT = 28
const LANE_Y = 10

let h: MockHarness

beforeEach(() => {
  h = installBrowserMocks()
  document.body.innerHTML = ''
  useEditorStore.setState(useEditorStore.getInitialState())
  useEditorStore.setState({ snapEnabled: false })
  vi.mocked(toast).mockClear()
})

afterEach(() => {
  cleanup()
  h.uninstall()
})

function asset(kind: 'video' | 'image' = 'video'): MediaAsset {
  return createMediaAsset({
    kind,
    name: kind === 'image' ? 'still.png' : 'demo.mp4',
    duration: 30,
  })
}

function twoClipDoc(): { doc: Doc; a: Clip; b: Clip; media: MediaAsset } {
  const media = asset()
  const track = createTrack('video', 1, { id: 'v1' })
  const a = createClip({ id: 'a', mediaId: media.id, start: 0, duration: 2, inPoint: 0 })
  const b = createClip({ id: 'b', mediaId: media.id, start: 3, duration: 2, inPoint: 0 })
  track.clips = [a, b]
  const doc: Doc = {
    project: { tracks: [track], id: 'p_tools', name: 'tools', width: 1920, height: 1080, fps: 30 },
    media: [media],
  }
  return { doc, a, b, media }
}

function clipEl(id: string): HTMLElement {
  return screen.getByTestId(`clip-${id}`)
}

function opacityDoc(points = true): { doc: Doc; a: Clip; media: MediaAsset } {
  const media = asset()
  const track = createTrack('video', 1, { id: 'v1' })
  const a = createClip({
    id: 'a',
    mediaId: media.id,
    start: 0,
    duration: 2,
    inPoint: 0,
    keyframes: points
      ? {
          opacity: [
            { time: 0, value: 1, interpolation: 'linear' },
            { time: 2, value: 0.25, interpolation: 'linear' },
          ],
        }
      : undefined,
  })
  track.clips = [a]
  const doc: Doc = {
    project: { tracks: [track], id: 'p_tools', name: 'tools', width: 1920, height: 1080, fps: 30 },
    media: [media],
  }
  return { doc, a, media }
}

function audioToolDoc(): { doc: Doc; a: Clip; media: MediaAsset } {
  const media = createMediaAsset({ kind: 'audio', name: 'sound.mp3', duration: 30 })
  const track = createTrack('audio', 1, { id: 'a1' })
  const a = createClip({ id: 'a', mediaId: media.id, start: 0, duration: 2, inPoint: 0 })
  track.clips = [a]
  const doc: Doc = {
    project: { tracks: [track], id: 'p_tools', name: 'tools', width: 1920, height: 1080, fps: 30 },
    media: [media],
  }
  return { doc, a, media }
}

function stubPlot(clipId: string, prefix: 'opacity-envelope' | 'volume-envelope') {
  const plot = within(clipEl(clipId)).getByTestId(`${prefix}-plot`)
  plot.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 10,
      right: 400,
      bottom: 30,
      width: 400,
      height: 20,
      x: 0,
      y: 10,
      toJSON: () => ({}),
    }) as DOMRect
  return plot
}

function yForOpacity(value: number, top = 10, height = 20): number {
  return top + (1 - value) * height
}

function Keys() {
  useEditorKeyboard(() => {})
  return null
}

function downAt(el: Element, clientX: number) {
  fireEvent.pointerDown(el, {
    button: 0,
    pointerId: 1,
    clientX,
    clientY: RULER_HEIGHT + LANE_Y,
  })
}

function moveTo(clientX: number) {
  fireEvent.pointerMove(window, {
    pointerId: 1,
    clientX,
    clientY: RULER_HEIGHT + LANE_Y,
  })
}

function upAt(clientX: number) {
  fireEvent.pointerUp(window, {
    pointerId: 1,
    clientX,
    clientY: RULER_HEIGHT + LANE_Y,
  })
}

function cancelAt(el: Element) {
  const event = new Event('pointercancel', { bubbles: true })
  Object.defineProperty(event, 'pointerId', { value: 1 })
  el.dispatchEvent(event)
}

function docClip(id: string): Clip {
  for (const track of useEditorStore.getState().doc.project.tracks) {
    const clip = track.clips.find((candidate) => candidate.id === id)
    if (clip) return clip
  }
  throw new Error(`clip ${id} not found`)
}

describe('toolbar tools', () => {
  it('renders select, razor, ripple, slip, and Pen with live controls', () => {
    render(<Toolbar onOpenExport={() => {}} />)
    expect(screen.getByRole('button', { name: /Selection tool/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Razor tool/ })).toBeInTheDocument()
    const ripple = screen.getByRole('button', { name: /Ripple trim tool/ })
    expect(ripple).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Slip tool/ })).toBeInTheDocument()
    const pen = screen.getByRole('button', { name: /Pen tool/ })
    expect(pen).toBeInTheDocument()
    // The limitation is named in the control the user hovers.
    expect(ripple.getAttribute('aria-label')).toContain(
      'linked partners on other tracks do not shift',
    )
    // The Pen names its scope: keyframes, not masks or roto.
    expect(pen.getAttribute('aria-label')).toMatch(/keyframe/i)
    expect(pen.getAttribute('aria-label')).not.toMatch(/mask|roto/i)
  })

  it('pressing a tool sets the active tool and its pressed state', () => {
    render(<Toolbar onOpenExport={() => {}} />)
    const ripple = screen.getByRole('button', { name: /Ripple trim tool/ })
    const slip = screen.getByRole('button', { name: /Slip tool/ })
    fireEvent.click(ripple)
    expect(useEditorStore.getState().activeTool).toBe('ripple')
    expect(ripple).toHaveAttribute('aria-pressed', 'true')
    expect(slip).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(slip)
    expect(useEditorStore.getState().activeTool).toBe('slip')
    expect(slip).toHaveAttribute('aria-pressed', 'true')
    const pen = screen.getByRole('button', { name: /Pen tool/ })
    fireEvent.click(pen)
    expect(useEditorStore.getState().activeTool).toBe('pen')
    expect(pen).toHaveAttribute('aria-pressed', 'true')
    expect(slip).toHaveAttribute('aria-pressed', 'false')
  })
})

describe('tool shortcuts', () => {
  function Keys() {
    useEditorKeyboard(() => {})
    return null
  }

  it('V, C, B, Y, P, and Escape select the six tool modes', () => {
    render(<Keys />)
    for (const [key, tool] of [
      ['v', 'select'],
      ['c', 'razor'],
      ['b', 'ripple'],
      ['y', 'slip'],
      ['p', 'pen'],
      ['Escape', 'select'],
    ] as const) {
      fireEvent.keyDown(window, { key })
      expect(useEditorStore.getState().activeTool).toBe(tool)
    }
  })

  it('Ctrl+Y still redoes instead of selecting the slip tool', () => {
    useEditorStore.getState().setActiveTool('razor')
    render(<Keys />)
    fireEvent.keyDown(window, { key: 'y', ctrlKey: true })
    expect(useEditorStore.getState().activeTool).toBe('razor')
  })
})

describe('ripple tool pointer routing', () => {
  it('a tail drag trims the clip and shifts the later clip, as one undo entry', () => {
    const { doc } = twoClipDoc()
    useEditorStore.setState({ doc })
    useEditorStore.getState().setActiveTool('ripple')
    render(<TimelinePanel />)
    const past = useEditorStore.getState().past.length

    const clip = clipEl('a')
    const handle = within(clip).getByLabelText('Trim clip end')
    // 80px at the default 80px/s is one second.
    downAt(handle, 200)
    moveTo(280)
    upAt(280)

    expect(docClip('a')).toMatchObject({ start: 0, duration: 3 })
    expect(docClip('b').start).toBe(4)
    expect(useEditorStore.getState().past).toHaveLength(past + 1)
  })

  it('a head drag keeps the start anchored and shifts the later clip left', () => {
    const { doc, a, b } = twoClipDoc()
    // A 2..6 with source from 2, B adjacent at 6.
    a.start = 2
    a.duration = 4
    a.inPoint = 2
    b.start = 6
    useEditorStore.setState({ doc })
    useEditorStore.getState().setActiveTool('ripple')
    render(<TimelinePanel />)

    const clip = clipEl('a')
    const handle = within(clip).getByLabelText('Trim clip start')
    downAt(handle, 200)
    moveTo(280)
    upAt(280)

    expect(docClip('a')).toMatchObject({ start: 2, inPoint: 3, duration: 3 })
    expect(docClip('b').start).toBe(5)
  })

  it('Alt-drag on a ripple edge rate-stretches and shifts the later clip', () => {
    const { doc, a, b } = twoClipDoc()
    a.start = 0
    a.duration = 4
    b.start = 6
    useEditorStore.setState({ doc })
    useEditorStore.getState().setActiveTool('ripple')
    render(<TimelinePanel />)

    const handle = within(clipEl('a')).getByLabelText('Trim clip end')
    fireEvent.pointerDown(handle, {
      button: 0,
      pointerId: 1,
      clientX: 200,
      clientY: RULER_HEIGHT + LANE_Y,
      altKey: true,
    })
    moveTo(280)
    upAt(280)

    // One second longer re-times the 4s source span to 0.8x; the end moves one
    // second right, so the later clip follows by the same delta.
    expect(docClip('a')).toMatchObject({ start: 0, duration: 5, speed: 0.8 })
    expect(docClip('b').start).toBe(7)
  })

  it('returning an Alt ripple stretch to its origin restores the later run', () => {
    const { doc, a, b } = twoClipDoc()
    a.start = 0
    a.duration = 4
    b.start = 6
    useEditorStore.setState({ doc })
    useEditorStore.getState().setActiveTool('ripple')
    render(<TimelinePanel />)

    const handle = within(clipEl('a')).getByLabelText('Trim clip end')
    fireEvent.pointerDown(handle, {
      button: 0,
      pointerId: 1,
      clientX: 200,
      clientY: RULER_HEIGHT + LANE_Y,
      altKey: true,
    })
    moveTo(280)
    expect(docClip('a')).toMatchObject({ duration: 5, speed: 0.8 })
    expect(docClip('b').start).toBe(7)
    moveTo(200)
    expect(docClip('a')).toMatchObject({ duration: 4 })
    expect(docClip('a').speed).toBeUndefined()
    expect(docClip('b').start).toBe(6)
    upAt(200)
    expect(useEditorStore.getState().past).toHaveLength(0)
  })

  it('a body drag only selects; it never moves the clip', () => {
    const { doc } = twoClipDoc()
    useEditorStore.setState({ doc })
    useEditorStore.getState().setActiveTool('ripple')
    render(<TimelinePanel />)

    downAt(clipEl('a'), 100)
    moveTo(180)
    upAt(180)

    expect(docClip('a').start).toBe(0)
    expect(useEditorStore.getState().selections).toEqual(['a'])
  })

  it('pointercancel restores the doc and adds no history entry', () => {
    const { doc } = twoClipDoc()
    useEditorStore.setState({ doc })
    useEditorStore.getState().setActiveTool('ripple')
    render(<TimelinePanel />)

    const handle = within(clipEl('a')).getByLabelText('Trim clip end')
    downAt(handle, 200)
    moveTo(280)
    expect(docClip('a').duration).toBe(3)
    cancelAt(clipEl('a'))
    expect(docClip('a')).toMatchObject({ duration: 2 })
    expect(docClip('b').start).toBe(3)
    expect(useEditorStore.getState().past).toHaveLength(0)
  })

  it('returning a tail drag to its origin restores the clip and the later run', () => {
    const { doc } = twoClipDoc()
    useEditorStore.setState({ doc })
    useEditorStore.getState().setActiveTool('ripple')
    render(<TimelinePanel />)

    const handle = within(clipEl('a')).getByLabelText('Trim clip end')
    downAt(handle, 200)
    moveTo(280)
    expect(docClip('a').duration).toBe(3)
    expect(docClip('b').start).toBe(4)
    moveTo(200)
    expect(docClip('a').duration).toBe(2)
    expect(docClip('b').start).toBe(3)
    upAt(200)
    expect(useEditorStore.getState().past).toHaveLength(0)
  })

  it('a collision refuses with a message and writes nothing', () => {
    const { doc, b } = twoClipDoc()
    // B overlaps A with no transitionOut, so a tail extension has no legal
    // shift. The planner refuses before any frame lands.
    b.start = 1.5
    useEditorStore.setState({ doc })
    useEditorStore.getState().setActiveTool('ripple')
    render(<TimelinePanel />)
    const before = structuredClone(useEditorStore.getState().doc)

    const handle = within(clipEl('a')).getByLabelText('Trim clip end')
    downAt(handle, 200)
    moveTo(280)
    upAt(280)

    expect(useEditorStore.getState().doc).toEqual(before)
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Cannot ripple trim' }))
    expect(useEditorStore.getState().past).toHaveLength(0)
  })

  it('refuses a locked track before the gesture starts', () => {
    const { doc } = twoClipDoc()
    doc.project.tracks[0].locked = true
    useEditorStore.setState({ doc })
    useEditorStore.getState().setActiveTool('ripple')
    render(<TimelinePanel />)
    const before = structuredClone(useEditorStore.getState().doc)

    const handle = within(clipEl('a')).getByLabelText('Trim clip end')
    downAt(handle, 200)
    moveTo(280)
    upAt(280)

    expect(useEditorStore.getState().doc).toEqual(before)
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Track locked' }))
    expect(useEditorStore.getState().past).toHaveLength(0)
  })
})

describe('slip tool pointer routing', () => {
  it('a body drag changes the in point and never the start or duration', () => {
    const { doc, a } = twoClipDoc()
    a.start = 2
    a.inPoint = 4
    useEditorStore.setState({ doc })
    useEditorStore.getState().setActiveTool('slip')
    render(<TimelinePanel />)
    const past = useEditorStore.getState().past.length

    downAt(clipEl('a'), 200)
    moveTo(280)
    expect(screen.getByTestId('slip-readout')).toHaveTextContent('In 3.00')
    upAt(280)

    // Dragging right reveals earlier source: -1s at speed 1.
    expect(docClip('a')).toMatchObject({ start: 2, duration: 2, inPoint: 3 })
    expect(clipEl('a').getAttribute('data-in-point')).toBe('3')
    expect(useEditorStore.getState().past).toHaveLength(past + 1)
    expect(screen.queryByTestId('slip-readout')).toBeNull()
  })

  it('an image refuses with a message and writes nothing', () => {
    const media = asset('image')
    const track = createTrack('video', 1, { id: 'v1' })
    track.clips = [createClip({ id: 'img', mediaId: media.id, start: 0, duration: 4, inPoint: 0 })]
    const doc: Doc = {
      project: {
        tracks: [track],
        id: 'p_tools',
        name: 'tools',
        width: 1920,
        height: 1080,
        fps: 30,
      },
      media: [media],
    }
    useEditorStore.setState({ doc })
    useEditorStore.getState().setActiveTool('slip')
    render(<TimelinePanel />)
    const before = structuredClone(useEditorStore.getState().doc)

    downAt(clipEl('img'), 200)
    moveTo(280)
    upAt(280)

    expect(useEditorStore.getState().doc).toEqual(before)
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Cannot slip that clip' }))
    expect(useEditorStore.getState().past).toHaveLength(0)
  })

  it('an edge drag does not trim', () => {
    const { doc, a } = twoClipDoc()
    a.start = 2
    useEditorStore.setState({ doc })
    useEditorStore.getState().setActiveTool('slip')
    render(<TimelinePanel />)

    const handle = within(clipEl('a')).getByLabelText('Trim clip end')
    downAt(handle, 200)
    moveTo(280)
    upAt(280)

    expect(docClip('a')).toMatchObject({ start: 2, duration: 2 })
  })

  it('pointercancel restores the in point and adds no history entry', () => {
    const { doc, a } = twoClipDoc()
    a.start = 2
    a.inPoint = 4
    useEditorStore.setState({ doc })
    useEditorStore.getState().setActiveTool('slip')
    render(<TimelinePanel />)

    downAt(clipEl('a'), 200)
    moveTo(280)
    expect(docClip('a').inPoint).toBe(3)
    cancelAt(clipEl('a'))
    expect(docClip('a').inPoint).toBe(4)
    expect(useEditorStore.getState().past).toHaveLength(0)
  })

  it('a foreign commit ends the gesture and later frames are ignored', () => {
    const { doc, a } = twoClipDoc()
    a.start = 2
    a.inPoint = 4
    useEditorStore.setState({ doc })
    useEditorStore.getState().setActiveTool('slip')
    render(<TimelinePanel />)

    downAt(clipEl('a'), 200)
    moveTo(280)
    expect(docClip('a').inPoint).toBe(3)
    // The command resolves the live transient first (rolling it back to the
    // base) and then applies; the gesture token changes, so later frames are
    // stale and cannot write with no undo entry behind them.
    useEditorStore.getState().apply({ type: 'setClipMuted', clipId: 'a', muted: true })
    moveTo(360)
    expect(docClip('a').inPoint).toBe(4)
    expect(docClip('a').muted).toBe(true)
    expect(useEditorStore.getState().past).toHaveLength(1)
    fireEvent.pointerUp(window, { pointerId: 1 })
  })

  it('returning a slip drag to its origin restores the base and clears the readout', () => {
    const { doc, a } = twoClipDoc()
    a.start = 2
    a.inPoint = 4
    useEditorStore.setState({ doc })
    useEditorStore.getState().setActiveTool('slip')
    render(<TimelinePanel />)

    downAt(clipEl('a'), 200)
    moveTo(280)
    expect(docClip('a').inPoint).toBe(3)
    moveTo(200)
    expect(docClip('a').inPoint).toBe(4)
    expect(screen.queryByTestId('slip-readout')).toBeNull()
    upAt(200)
    expect(useEditorStore.getState().past).toHaveLength(0)
  })

  it('Escape does not cancel a live slip gesture or switch the tool under it', () => {
    const { doc, a } = twoClipDoc()
    a.start = 2
    a.inPoint = 4
    useEditorStore.setState({ doc })
    useEditorStore.getState().setActiveTool('slip')
    render(<TimelinePanel />)
    const past = useEditorStore.getState().past.length

    downAt(clipEl('a'), 200)
    moveTo(280)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useEditorStore.getState().activeTool).toBe('slip')
    moveTo(360)
    upAt(360)

    expect(docClip('a')).toMatchObject({ start: 2, duration: 2, inPoint: 2 })
    expect(useEditorStore.getState().activeTool).toBe('slip')
    expect(useEditorStore.getState().past).toHaveLength(past + 1)
  })

  it('refuses a locked track before the gesture starts', () => {
    const { doc, a } = twoClipDoc()
    a.start = 2
    doc.project.tracks[0].locked = true
    useEditorStore.setState({ doc })
    useEditorStore.getState().setActiveTool('slip')
    render(<TimelinePanel />)
    const before = structuredClone(useEditorStore.getState().doc)

    downAt(clipEl('a'), 200)
    moveTo(280)
    upAt(280)

    expect(useEditorStore.getState().doc).toEqual(before)
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Track locked' }))
  })
})

describe('Pen tool pointer routing', () => {
  it('a body drag only selects; it never moves the clip', () => {
    const { doc } = twoClipDoc()
    useEditorStore.setState({ doc })
    useEditorStore.getState().setActiveTool('pen')
    render(<TimelinePanel />)

    downAt(clipEl('a'), 100)
    moveTo(180)
    upAt(180)

    expect(docClip('a')).toMatchObject({ start: 0, duration: 2 })
    expect(useEditorStore.getState().selections).toEqual(['a'])
    expect(useEditorStore.getState().past).toHaveLength(0)
  })

  it('an edge drag only selects; it never trims', () => {
    const { doc } = twoClipDoc()
    useEditorStore.setState({ doc })
    useEditorStore.getState().setActiveTool('pen')
    render(<TimelinePanel />)

    const handle = within(clipEl('a')).getByLabelText('Trim clip end')
    downAt(handle, 200)
    moveTo(280)
    upAt(280)

    expect(docClip('a')).toMatchObject({ start: 0, duration: 2, inPoint: 0 })
    expect(useEditorStore.getState().past).toHaveLength(0)
  })

  it('a curve click adds an opacity point without moving the clip, one undo entry', () => {
    const { doc } = twoClipDoc()
    useEditorStore.setState({ doc })
    useEditorStore.getState().setActiveTool('pen')
    render(<TimelinePanel />)

    downAt(clipEl('a'), 100)
    upAt(100)
    stubPlot('a', 'opacity-envelope')
    fireEvent.click(within(clipEl('a')).getByTestId('opacity-envelope-hit'), { clientX: 200 })

    const edited = docClip('a')
    expect(edited.keyframes?.opacity).toEqual([{ time: 1, value: 1, interpolation: 'linear' }])
    expect(edited).toMatchObject({ start: 0, duration: 2, inPoint: 0 })
    expect(useEditorStore.getState().past).toHaveLength(1)

    useEditorStore.getState().undo()
    expect(docClip('a').keyframes?.opacity).toBeUndefined()
    expect(docClip('a')).toMatchObject({ start: 0, duration: 2, inPoint: 0 })
  })

  it('a curve click adds a volume point on an audio clip', () => {
    const { doc } = audioToolDoc()
    useEditorStore.setState({ doc })
    useEditorStore.getState().setActiveTool('pen')
    render(<TimelinePanel />)

    downAt(clipEl('a'), 100)
    upAt(100)
    stubPlot('a', 'volume-envelope')
    fireEvent.click(within(clipEl('a')).getByTestId('volume-envelope-hit'), { clientX: 200 })

    const edited = docClip('a')
    expect(edited.keyframes?.volume).toEqual([{ time: 1, value: 1, interpolation: 'linear' }])
    expect(edited).toMatchObject({ start: 0, duration: 2, inPoint: 0 })
  })

  it('a dot drag edits opacity with one undo entry and does not move the clip', () => {
    const { doc } = opacityDoc()
    useEditorStore.setState({ doc, selections: ['a'], selection: 'a' })
    useEditorStore.getState().setActiveTool('pen')
    render(<TimelinePanel />)
    stubPlot('a', 'opacity-envelope')
    const before = useEditorStore.getState().past.length

    fireEvent.pointerDown(within(clipEl('a')).getByTestId('opacity-dot-1'), {
      bubbles: true,
      pointerId: 1,
      clientX: 400,
      clientY: yForOpacity(0.25),
      button: 0,
    })
    fireEvent.pointerMove(window, {
      pointerId: 1,
      clientX: 300,
      clientY: yForOpacity(0.5),
    })
    fireEvent.pointerUp(window, { pointerId: 1 })

    const edited = docClip('a')
    expect(edited.keyframes?.opacity?.[1].value).toBeCloseTo(0.5, 6)
    expect(edited).toMatchObject({ start: 0, duration: 2, inPoint: 0 })
    expect(useEditorStore.getState().past).toHaveLength(before + 1)
  })

  it('Shift keeps adding to the selection and the clip still does not move', () => {
    const { doc } = twoClipDoc()
    useEditorStore.setState({ doc })
    useEditorStore.getState().setActiveTool('pen')
    render(<TimelinePanel />)

    downAt(clipEl('a'), 100)
    upAt(100)
    fireEvent.pointerDown(clipEl('b'), {
      button: 0,
      pointerId: 2,
      clientX: 300,
      clientY: RULER_HEIGHT + LANE_Y,
      shiftKey: true,
    })
    fireEvent.pointerUp(window, {
      pointerId: 2,
      clientX: 300,
      clientY: RULER_HEIGHT + LANE_Y,
    })

    expect(useEditorStore.getState().selections).toEqual(expect.arrayContaining(['a', 'b']))
    expect(docClip('a')).toMatchObject({ start: 0, duration: 2 })
    expect(docClip('b')).toMatchObject({ start: 3, duration: 2 })
  })

  it('Escape does not cancel a live Pen drag or switch the tool under it', () => {
    const { doc } = opacityDoc()
    useEditorStore.setState({ doc, selections: ['a'], selection: 'a' })
    useEditorStore.getState().setActiveTool('pen')
    render(
      <>
        <Keys />
        <TimelinePanel />
      </>,
    )
    stubPlot('a', 'opacity-envelope')
    const before = useEditorStore.getState().past.length

    fireEvent.pointerDown(within(clipEl('a')).getByTestId('opacity-dot-0'), {
      bubbles: true,
      pointerId: 1,
      clientX: 0,
      clientY: yForOpacity(1),
      button: 0,
    })
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 200, clientY: yForOpacity(0.5) })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useEditorStore.getState().activeTool).toBe('pen')
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 300, clientY: yForOpacity(0.4) })
    fireEvent.pointerUp(window, { pointerId: 1 })

    expect(docClip('a').keyframes?.opacity?.[0].value).toBeCloseTo(0.4, 6)
    expect(useEditorStore.getState().past).toHaveLength(before + 1)
    expect(useEditorStore.getState().activeTool).toBe('pen')
  })

  it('Escape does not switch under a pending Alt-click removal', () => {
    const { doc } = opacityDoc()
    useEditorStore.setState({ doc, selections: ['a'], selection: 'a' })
    useEditorStore.getState().setActiveTool('pen')
    render(
      <>
        <Keys />
        <TimelinePanel />
      </>,
    )
    stubPlot('a', 'opacity-envelope')
    const before = useEditorStore.getState().past.length

    fireEvent.pointerDown(within(clipEl('a')).getByTestId('opacity-dot-0'), {
      bubbles: true,
      pointerId: 1,
      clientX: 0,
      clientY: yForOpacity(1),
      button: 0,
      altKey: true,
    })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useEditorStore.getState().activeTool).toBe('pen')
    fireEvent.pointerUp(window, { pointerId: 1 })

    expect(useEditorStore.getState().activeTool).toBe('pen')
    expect(docClip('a').keyframes?.opacity).toHaveLength(1)
    expect(useEditorStore.getState().past).toHaveLength(before + 1)
  })

  it('refuses a locked lane before an add or a dot drag', () => {
    const { doc } = opacityDoc()
    doc.project.tracks[0].locked = true
    useEditorStore.setState({ doc, selections: ['a'], selection: 'a' })
    useEditorStore.getState().setActiveTool('pen')
    render(<TimelinePanel />)
    stubPlot('a', 'opacity-envelope')
    const before = structuredClone(useEditorStore.getState().doc)

    fireEvent.click(within(clipEl('a')).getByTestId('opacity-envelope-hit'), { clientX: 100 })
    fireEvent.pointerDown(within(clipEl('a')).getByTestId('opacity-dot-0'), {
      bubbles: true,
      pointerId: 1,
      clientX: 0,
      clientY: yForOpacity(1),
      button: 0,
    })
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 200, clientY: yForOpacity(0.5) })
    fireEvent.pointerUp(window, { pointerId: 1 })

    expect(useEditorStore.getState().doc).toEqual(before)
    expect(useEditorStore.getState().past).toHaveLength(0)
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Track locked' }))
  })
})

describe('tool routing locks in source', () => {
  it('the full tool matrix is present and the Pen is keyframes only', () => {
    const clipView = read('src/components/editor/timeline/ClipView.tsx')
    expect(clipView).toMatch(/activeTool === 'ripple' && mode === 'move'/)
    expect(clipView).toMatch(/activeTool === 'slip' && mode !== 'move'/)
    expect(clipView).toMatch(/activeTool === 'pen'/)
    expect(clipView).toMatch(/planRippleTrim\(/)
    expect(clipView).toMatch(/planSlip\(/)

    const toolbar = read('src/components/editor/Toolbar.tsx')
    expect(toolbar).toMatch(/setActiveTool\('ripple'\)/)
    expect(toolbar).toMatch(/setActiveTool\('slip'\)/)
    expect(toolbar).toMatch(/setActiveTool\('pen'\)/)
    expect(toolbar).toMatch(/PenTool/)
    // The Pen edits keyframes; no mask or roto control is mounted.
    expect(toolbar).not.toMatch(/mask|roto/i)
    expect(clipView).not.toMatch(/mask|roto/i)
  })
})
