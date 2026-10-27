// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'

import { TimelinePanel } from '@/components/editor/timeline/TimelinePanel'
import { InspectorPanel } from '@/components/editor/InspectorPanel'
import { VolumeEnvelope } from '@/components/editor/timeline/VolumeEnvelope'
import { findClip, createClip, createMediaAsset, createTrack } from '@/lib/editor/factories'
import { computeDuckingKeyframes } from '@/lib/editor/ducking'
import { isTransientActive, useEditorStore } from '@/lib/editor/store'
import { frameToTime } from '@/lib/editor/time'
import { dbToGain, gainToDb, gainToUnit } from '@/lib/editor/volume-automation'
import type { Clip, Doc, Keyframe, MediaAsset } from '@/lib/editor/types'
import { installBrowserMocks, type MockHarness } from './mocks/browser-mocks'

const h: MockHarness = installBrowserMocks()

afterAll(() => h.uninstall())

const AUDIO = createMediaAsset({
  id: 'media-a',
  kind: 'audio',
  name: 'sound.mp3',
  duration: 30,
  url: 'blob:audio',
  waveformPeaks: [0.2, 0.8, 0.4],
})

const VIDEO_WITH_AUDIO = createMediaAsset({
  id: 'media-v',
  kind: 'video',
  name: 'demo.mp4',
  duration: 30,
  width: 1920,
  height: 1080,
  url: 'blob:video',
  hasAudio: true,
  waveformPeaks: [0.2, 0.8, 0.4],
  thumbnail: 'data:image/jpeg;base64,AAAA',
})

const VIDEO_NO_AUDIO = createMediaAsset({
  id: 'media-silent',
  kind: 'video',
  name: 'silent.mp4',
  duration: 30,
  width: 1920,
  height: 1080,
  url: 'blob:silent',
  hasAudio: false,
})

function projectDoc(tracks: ReturnType<typeof createTrack>[], media: MediaAsset[]): Doc {
  return {
    project: {
      id: 'p_volume',
      name: 'volume ui',
      width: 1920,
      height: 1080,
      fps: 30,
      tracks,
    },
    media,
  }
}

function audioDoc(
  keyframes?: Keyframe[],
  options: { gain?: number; muted?: boolean; selected?: boolean } = {},
): Doc {
  const clip = createClip({
    id: 'clip-a',
    mediaId: AUDIO.id,
    start: 0,
    duration: 4,
    gain: options.gain,
    muted: options.muted,
    keyframes: keyframes ? { volume: keyframes } : undefined,
  })
  const track = createTrack('audio', 1, { clips: [clip] })
  return projectDoc([track], [AUDIO])
}

function seedStore(doc: Doc, clipId: string) {
  useEditorStore.setState({
    ...useEditorStore.getInitialState(),
    doc,
    selections: [clipId],
    selection: clipId,
    playhead: 0,
    pxPerSec: 100,
  })
}

function stubPlot(left = 0, top = 10, width = 200, height = 20): HTMLElement {
  const plot = screen.getByTestId('volume-envelope-plot')
  plot.getBoundingClientRect = () =>
    ({
      left,
      top,
      right: left + width,
      bottom: top + height,
      width,
      height,
      x: left,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect
  return plot
}

function yFor(gain: number, top = 10, height = 20): number {
  return top + (1 - gainToUnit(gain)) * height
}

function EnvelopeHarness({
  id = 'clip-a',
  selected = true,
  razorActive = false,
}: {
  id?: string
  selected?: boolean
  razorActive?: boolean
}) {
  const doc = useEditorStore((s) => s.doc)
  const clip = findClip(doc, id)?.clip
  if (!clip) return null
  return (
    <VolumeEnvelope
      clip={clip}
      widthPx={200}
      height={36}
      selected={selected}
      razorActive={razorActive}
    />
  )
}

beforeEach(() => {
  useEditorStore.setState(useEditorStore.getInitialState())
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

const TWO_POINTS: Keyframe[] = [
  { time: 1, value: 1, interpolation: 'linear' },
  { time: 3, value: 1, interpolation: 'linear' },
]

describe('volume envelope rendering', () => {
  it('draws a sampled curve and a dot per keyframe', () => {
    seedStore(audioDoc(TWO_POINTS), 'clip-a')
    render(<EnvelopeHarness selected={false} />)

    expect(screen.getByTestId('volume-envelope')).toBeInTheDocument()
    const curve = screen.getByTestId('volume-envelope-curve')
    const d = curve.getAttribute('d') ?? ''
    expect(d.startsWith('M ')).toBe(true)
    expect((d.match(/L /g) ?? []).length).toBeGreaterThan(20)
    expect(screen.getByTestId('volume-dot-0')).toHaveAttribute('role', 'slider')
    expect(screen.getByTestId('volume-dot-1')).toBeInTheDocument()
    expect(screen.getByTestId('volume-dot-1')).toHaveAttribute('aria-label', 'Volume keyframe 2')
    // A keyframe at 1 s of a 4 s clip sits at 25% of the plot.
    expect(screen.getByTestId('volume-dot-0').style.left).toBe('25%')
  })

  it('shows a flat line when selected and no curve exists, and nothing when idle', () => {
    seedStore(audioDoc(), 'clip-a')
    const { rerender } = render(<EnvelopeHarness selected />)
    expect(screen.getByTestId('volume-envelope-curve')).toBeInTheDocument()
    expect(screen.queryByTestId('volume-dot-0')).not.toBeInTheDocument()
    rerender(<EnvelopeHarness selected={false} />)
    expect(screen.queryByTestId('volume-envelope')).not.toBeInTheDocument()
  })

  it('dims a muted clip but keeps the curve and dots editable', () => {
    seedStore(audioDoc(TWO_POINTS, { muted: true }), 'clip-a')
    render(<EnvelopeHarness />)
    const root = screen.getByTestId('volume-envelope')
    expect(root.className).toContain('opacity-50')
    expect(screen.getByTestId('volume-envelope-curve')).toBeInTheDocument()
    expect(screen.getByTestId('volume-dot-0').className).toContain('pointer-events-auto')
  })

  it('insets the plot away from the trim handles', () => {
    seedStore(audioDoc(TWO_POINTS), 'clip-a')
    render(<EnvelopeHarness />)
    const plot = screen.getByTestId('volume-envelope-plot')
    expect(plot.style.left).toBe('8px')
    expect(plot.style.right).toBe('8px')
  })
})

describe('volume envelope gestures', () => {
  it('writes a transient per move and commits exactly one undo entry', () => {
    seedStore(audioDoc(TWO_POINTS), 'clip-a')
    render(<EnvelopeHarness />)
    stubPlot()
    const pastBefore = useEditorStore.getState().past.length

    fireEvent.pointerDown(screen.getByTestId('volume-dot-0'), {
      bubbles: true,
      pointerId: 7,
      clientX: 50,
      clientY: yFor(1),
      button: 0,
    })
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 100, clientY: yFor(1) })
    expect(isTransientActive()).toBe(true)
    expect(screen.getByTestId('volume-envelope-hud')).toHaveTextContent('0.0 dB')
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 150, clientY: yFor(0.5) })
    expect(screen.getByTestId('volume-envelope-hud')).toHaveTextContent('-6.0 dB')
    fireEvent.pointerUp(window, { pointerId: 7 })

    expect(isTransientActive()).toBe(false)
    expect(screen.queryByTestId('volume-envelope-hud')).not.toBeInTheDocument()
    const curve = useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.volume
    expect(curve?.[0].time).toBeCloseTo(3, 5)
    expect(curve?.[0].value).toBeCloseTo(0.5, 4)
    expect(useEditorStore.getState().past.length).toBe(pastBefore + 1)

    useEditorStore.getState().undo()
    const undone = useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.volume
    expect(undone?.[0]).toEqual(TWO_POINTS[0])
  })

  it('treats a 2px move as a click and writes nothing', () => {
    seedStore(audioDoc(TWO_POINTS), 'clip-a')
    render(<EnvelopeHarness />)
    stubPlot()
    const pastBefore = useEditorStore.getState().past.length

    fireEvent.pointerDown(screen.getByTestId('volume-dot-0'), {
      bubbles: true,
      pointerId: 7,
      clientX: 50,
      clientY: yFor(1),
      button: 0,
    })
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 52, clientY: yFor(1) })
    expect(isTransientActive()).toBe(false)
    fireEvent.pointerUp(window, { pointerId: 7 })

    expect(useEditorStore.getState().past.length).toBe(pastBefore)
    expect(
      useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.volume?.[0].time,
    ).toBe(1)
  })

  it('starts one transient on a 4px move', () => {
    seedStore(audioDoc(TWO_POINTS), 'clip-a')
    render(<EnvelopeHarness />)
    stubPlot()

    fireEvent.pointerDown(screen.getByTestId('volume-dot-0'), {
      bubbles: true,
      pointerId: 7,
      clientX: 50,
      clientY: yFor(1),
      button: 0,
    })
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 54, clientY: yFor(1) })
    expect(isTransientActive()).toBe(true)
    fireEvent.pointerUp(window, { pointerId: 7 })
    expect(useEditorStore.getState().past.length).toBe(1)
  })

  it('stops writing after a foreign commit ends the drag', () => {
    seedStore(audioDoc(TWO_POINTS), 'clip-a')
    render(<EnvelopeHarness />)
    stubPlot()
    const pastBefore = useEditorStore.getState().past.length

    fireEvent.pointerDown(screen.getByTestId('volume-dot-0'), {
      bubbles: true,
      pointerId: 7,
      clientX: 50,
      clientY: yFor(1),
      button: 0,
    })
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 100, clientY: yFor(1) })
    useEditorStore.getState().apply({ type: 'setClipMuted', clipId: 'clip-a', muted: true })
    expect(useEditorStore.getState().past.length).toBe(pastBefore + 1)

    fireEvent.pointerMove(window, { pointerId: 7, clientX: 150, clientY: yFor(1) })
    expect(
      useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.volume?.[0].time,
    ).toBe(1)
    fireEvent.pointerUp(window, { pointerId: 7 })
  })

  it('cancels and restores on pointercancel', () => {
    seedStore(audioDoc(TWO_POINTS), 'clip-a')
    render(<EnvelopeHarness />)
    stubPlot()
    const pastBefore = useEditorStore.getState().past.length

    fireEvent.pointerDown(screen.getByTestId('volume-dot-0'), {
      bubbles: true,
      pointerId: 7,
      clientX: 50,
      clientY: yFor(1),
      button: 0,
    })
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 100, clientY: yFor(1) })
    expect(isTransientActive()).toBe(true)
    fireEvent.pointerCancel(window, { pointerId: 7 })

    expect(isTransientActive()).toBe(false)
    expect(useEditorStore.getState().past.length).toBe(pastBefore)
    expect(
      useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.volume?.[0].time,
    ).toBe(1)
  })

  it('alt-click removes on pointerup and pointercancel leaves the keyframe', () => {
    seedStore(audioDoc(TWO_POINTS), 'clip-a')
    render(<EnvelopeHarness />)
    stubPlot()
    const pastBefore = useEditorStore.getState().past.length

    // A canceled Alt-press removes nothing and writes no history.
    fireEvent.pointerDown(screen.getByTestId('volume-dot-0'), {
      bubbles: true,
      pointerId: 7,
      clientX: 50,
      clientY: yFor(1),
      button: 0,
      altKey: true,
    })
    fireEvent.pointerCancel(window, { pointerId: 7 })
    expect(useEditorStore.getState().past.length).toBe(pastBefore)
    expect(useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.volume).toHaveLength(
      2,
    )

    // A completed Alt-press removes it as one undo entry.
    fireEvent.pointerDown(screen.getByTestId('volume-dot-0'), {
      bubbles: true,
      pointerId: 8,
      clientX: 50,
      clientY: yFor(1),
      button: 0,
      altKey: true,
    })
    fireEvent.pointerUp(window, { pointerId: 8 })
    const curve = useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.volume
    expect(curve).toHaveLength(1)
    expect(curve?.[0].time).toBe(3)
    expect(useEditorStore.getState().past.length).toBe(pastBefore + 1)
  })

  it('an alt-press that moves past the threshold neither removes nor drags', () => {
    seedStore(audioDoc(TWO_POINTS), 'clip-a')
    render(<EnvelopeHarness />)
    stubPlot()
    const pastBefore = useEditorStore.getState().past.length

    fireEvent.pointerDown(screen.getByTestId('volume-dot-0'), {
      bubbles: true,
      pointerId: 9,
      clientX: 50,
      clientY: yFor(1),
      button: 0,
      altKey: true,
    })
    fireEvent.pointerMove(window, { pointerId: 9, clientX: 100, clientY: yFor(1) })
    fireEvent.pointerUp(window, { pointerId: 9 })

    expect(isTransientActive()).toBe(false)
    expect(useEditorStore.getState().past.length).toBe(pastBefore)
    expect(useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.volume).toHaveLength(
      2,
    )
  })

  it('double-click seeds the first point on a static clip with the static gain', () => {
    seedStore(audioDoc(undefined, { gain: 0.5 }), 'clip-a')
    render(<EnvelopeHarness />)
    stubPlot()

    fireEvent.doubleClick(screen.getByTestId('volume-envelope-hit'), {
      clientX: 100,
      clientY: yFor(0.5),
    })

    const curve = useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.volume
    expect(curve).toHaveLength(1)
    expect(curve?.[0].time).toBe(2)
    expect(curve?.[0].value).toBeCloseTo(0.5, 6)
    expect(screen.getByTestId('volume-dot-0')).toBeInTheDocument()
    expect(useEditorStore.getState().past.length).toBe(1)
  })

  it('double-click adds an interpolated point and stops the parent double-click', () => {
    seedStore(audioDoc(TWO_POINTS), 'clip-a')
    const parentDouble = vi.fn()
    render(
      <div onDoubleClick={parentDouble}>
        <EnvelopeHarness />
      </div>,
    )
    stubPlot()

    fireEvent.doubleClick(screen.getByTestId('volume-envelope-hit'), {
      clientX: 100,
      clientY: yFor(1),
    })

    const curve = useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.volume
    expect(curve).toHaveLength(3)
    expect(curve?.[1].time).toBe(2)
    expect(curve?.[1].value).toBeCloseTo(1, 5)
    expect(parentDouble).not.toHaveBeenCalled()
    expect(useEditorStore.getState().past.length).toBe(1)
  })

  it('nudges and deletes from the focused dot without the global shortcuts', () => {
    seedStore(audioDoc(TWO_POINTS), 'clip-a')
    render(<EnvelopeHarness />)
    const dot = screen.getByTestId('volume-dot-0')

    fireEvent.keyDown(dot, { key: 'ArrowRight' })
    let curve = useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.volume
    expect(curve?.[0].time).toBeCloseTo(1 + frameToTime(1, 30), 6)

    fireEvent.keyDown(screen.getByTestId('volume-dot-0'), { key: 'ArrowUp' })
    curve = useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.volume
    expect(gainToDb(curve![0].value)).toBeCloseTo(0.5, 6)

    fireEvent.keyDown(screen.getByTestId('volume-dot-0'), { key: 'ArrowDown' })
    curve = useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.volume
    expect(gainToDb(curve![0].value)).toBeCloseTo(0, 6)

    fireEvent.keyDown(screen.getByTestId('volume-dot-0'), { key: 'Delete' })
    curve = useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.volume
    expect(curve).toHaveLength(1)

    fireEvent.keyDown(screen.getByTestId('volume-dot-0'), { key: 'Backspace' })
    curve = useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.volume
    expect(curve).toBeUndefined()
  })

  it('re-sorts a crossed neighbour and keeps the grabbed point', () => {
    seedStore(
      audioDoc([
        { time: 1, value: 0.25 },
        { time: 3, value: 0.75 },
      ]),
      'clip-a',
    )
    render(<EnvelopeHarness />)
    stubPlot()

    fireEvent.pointerDown(screen.getByTestId('volume-dot-0'), {
      bubbles: true,
      pointerId: 7,
      clientX: 50,
      clientY: yFor(0.25),
      button: 0,
    })
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 200, clientY: yFor(0.25) })
    fireEvent.pointerUp(window, { pointerId: 7 })

    const curve = useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.volume
    expect(curve?.map((k) => k.time)).toEqual([3, 4])
    expect(curve?.[0].value).toBeCloseTo(0.75, 6)
    expect(curve?.[1].value).toBeCloseTo(0.25, 6)
  })
})

describe('volume envelope in the timeline', () => {
  function renderTimeline(doc: Doc, selection: string[] = []) {
    useEditorStore.setState({
      ...useEditorStore.getInitialState(),
      doc,
      selections: selection,
      selection: selection[0] ?? null,
      playhead: 0,
      pxPerSec: 100,
    })
    return render(<TimelinePanel />)
  }

  it('renders the envelope and dots on an audio clip with keyframes', () => {
    renderTimeline(audioDoc(TWO_POINTS))
    const clip = screen.getByTestId('clip-clip-a')
    expect(within(clip).getByTestId('volume-envelope')).toBeInTheDocument()
    expect(within(clip).getByTestId('volume-dot-0')).toBeInTheDocument()
    expect(within(clip).getByLabelText('Trim clip start')).toBeInTheDocument()
    expect(within(clip).getByLabelText('Trim clip end')).toBeInTheDocument()
    expect(within(clip).getByText('sound.mp3')).toBeInTheDocument()
  })

  it('puts the envelope on the audio twin, never the linked video half', () => {
    const video = createClip({
      id: 'clip-v',
      mediaId: VIDEO_WITH_AUDIO.id,
      start: 0,
      duration: 4,
      linkId: 'L',
    })
    const twin = createClip({
      id: 'clip-a',
      mediaId: VIDEO_WITH_AUDIO.id,
      start: 0,
      duration: 4,
      linkId: 'L',
      audioOnly: true,
      keyframes: { volume: TWO_POINTS },
    })
    const doc = projectDoc(
      [createTrack('video', 1, { clips: [video] }), createTrack('audio', 1, { clips: [twin] })],
      [VIDEO_WITH_AUDIO],
    )
    renderTimeline(doc)

    const videoHalf = screen.getByTestId('clip-clip-v')
    const audioHalf = screen.getByTestId('clip-clip-a')
    expect(within(videoHalf).queryByTestId('volume-envelope')).not.toBeInTheDocument()
    expect(within(audioHalf).getByTestId('volume-envelope')).toBeInTheDocument()
    // The label and link badge survive the overlay; the twin keeps its waveform.
    expect(within(videoHalf).getByText('demo.mp4')).toBeInTheDocument()
    expect(within(videoHalf).getByTestId('clip-link-badge')).toBeInTheDocument()
    expect(audioHalf.querySelector('canvas')).not.toBeNull()
  })

  it('does not capture a click on empty clip space', () => {
    renderTimeline(audioDoc(TWO_POINTS))
    const clip = screen.getByTestId('clip-clip-a')
    expect(within(clip).getByTestId('volume-envelope').className).toContain('pointer-events-none')
    expect(within(clip).getByTestId('volume-envelope-plot').className).toContain(
      'pointer-events-none',
    )

    fireEvent.pointerDown(clip, {
      bubbles: true,
      pointerId: 7,
      clientX: 200,
      clientY: 20,
      button: 0,
    })
    expect(useEditorStore.getState().selections).toContain('clip-a')
    expect(isTransientActive()).toBe(true)
    fireEvent.pointerUp(window, { pointerId: 7 })
    expect(isTransientActive()).toBe(false)
  })

  it('renders an auto-duck curve and keeps its dots editable', () => {
    const dialogueAsset = createMediaAsset({
      id: 'media-d',
      kind: 'audio',
      name: 'voice.mp3',
      duration: 30,
      url: 'blob:voice',
      waveformPeaks: new Array(1000).fill(1),
    })
    const musicAsset = createMediaAsset({
      id: 'media-m',
      kind: 'audio',
      name: 'music.mp3',
      duration: 30,
      url: 'blob:music',
      waveformPeaks: new Array(1000).fill(0.2),
    })
    const dialogue = createClip({
      id: 'clip-d',
      mediaId: dialogueAsset.id,
      start: 0,
      duration: 4,
    })
    const music = createClip({
      id: 'clip-m',
      mediaId: musicAsset.id,
      start: 0,
      duration: 4,
    })
    const doc = projectDoc(
      [createTrack('audio', 1, { clips: [dialogue] }), createTrack('audio', 2, { clips: [music] })],
      [dialogueAsset, musicAsset],
    )
    const ducked = computeDuckingKeyframes(doc, music, [dialogue])
    expect(ducked.length).toBeGreaterThan(0)
    useEditorStore.setState({
      ...useEditorStore.getInitialState(),
      doc,
      selections: [],
      selection: null,
      playhead: 0,
      pxPerSec: 100,
    })
    useEditorStore.getState().apply({
      type: 'setClipKeyframes',
      clipId: music.id,
      property: 'volume',
      keyframes: ducked,
    })
    render(<TimelinePanel />)

    const musicEl = screen.getByTestId('clip-clip-m')
    expect(within(musicEl).getByTestId('volume-envelope')).toBeInTheDocument()
    expect(within(musicEl).getAllByTestId(/^volume-dot-/).length).toBeGreaterThan(0)
    expect(within(musicEl).getByTestId('volume-dot-0').className).toContain('pointer-events-auto')
  })

  it('renders on a solo video with embedded audio and not on a silent video', () => {
    const loud = createClip({
      id: 'clip-loud',
      mediaId: VIDEO_WITH_AUDIO.id,
      start: 0,
      duration: 4,
      keyframes: { volume: TWO_POINTS },
    })
    const loudDoc = projectDoc([createTrack('video', 1, { clips: [loud] })], [VIDEO_WITH_AUDIO])
    const { unmount } = renderTimeline(loudDoc)
    expect(
      within(screen.getByTestId('clip-clip-loud')).getByTestId('volume-envelope'),
    ).toBeInTheDocument()
    unmount()

    const quiet = createClip({
      id: 'clip-quiet',
      mediaId: VIDEO_NO_AUDIO.id,
      start: 0,
      duration: 4,
      keyframes: { volume: TWO_POINTS },
    })
    const quietDoc = projectDoc([createTrack('video', 1, { clips: [quiet] })], [VIDEO_NO_AUDIO])
    renderTimeline(quietDoc)
    expect(
      within(screen.getByTestId('clip-clip-quiet')).queryByTestId('volume-envelope'),
    ).not.toBeInTheDocument()
  })

  it('keeps the trim handle above a dot at the clip head', () => {
    renderTimeline(audioDoc([{ time: 0, value: 1 }]), ['clip-a'])
    const clip = screen.getByTestId('clip-clip-a')
    const dot = within(clip).getByTestId('volume-dot-0')
    const handle = within(clip).getByLabelText('Trim clip start')
    expect(dot.className).toContain('z-[1]')
    expect(handle.className).toContain('z-10')
    const plot = within(clip).getByTestId('volume-envelope-plot')
    expect(plot.style.left).toBe('8px')
  })

  it('lets a razor click cut the clip instead of starting a keyframe drag', () => {
    const clip = createClip({
      id: 'clip-a',
      mediaId: AUDIO.id,
      start: 0,
      duration: 4,
      keyframes: { volume: TWO_POINTS },
    })
    const doc = projectDoc([createTrack('audio', 1, { clips: [clip] })], [AUDIO])
    useEditorStore.setState({
      ...useEditorStore.getInitialState(),
      doc,
      selections: [],
      selection: null,
      playhead: 0,
      pxPerSec: 100,
      activeTool: 'razor',
    })
    render(<TimelinePanel />)
    const clipEl = screen.getByTestId('clip-clip-a')
    clipEl.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        right: 400,
        bottom: 40,
        width: 400,
        height: 40,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect

    fireEvent.pointerDown(within(clipEl).getByTestId('volume-dot-0'), {
      bubbles: true,
      pointerId: 7,
      clientX: 200,
      clientY: 10,
      button: 0,
    })

    expect(isTransientActive()).toBe(false)
    const clips = useEditorStore.getState().doc.project.tracks[0].clips
    expect(clips).toHaveLength(2)
    expect(clips.map((c) => c.duration)).toEqual([2, 2])
    // Both halves keep the volume curve; the cut redistributes it.
    expect(clips[0].keyframes?.volume?.length).toBeGreaterThan(0)
    expect(clips[1].keyframes?.volume?.length).toBeGreaterThan(0)
  })
})

describe('Clip tab volume summary', () => {
  function renderInspector(doc: Doc, clipId: string) {
    useEditorStore.setState({
      ...useEditorStore.getInitialState(),
      doc,
      selections: [clipId],
      selection: clipId,
      playhead: 0,
      pxPerSec: 100,
    })
    render(<InspectorPanel />)
  }

  it('shows one Volume section with dB, mute, gain, and the shared dB graph', () => {
    renderInspector(audioDoc(TWO_POINTS, { gain: 0.5 }), 'clip-a')

    const section = screen.getByTestId('clip-volume-section')
    expect(section).toBeInTheDocument()
    expect(screen.getByTestId('clip-volume-db')).toHaveTextContent('0.0 dB')
    expect(screen.getByTestId('clip-gain-db')).toHaveTextContent('-6.0 dB')
    expect(screen.getByRole('slider', { name: 'Clip gain percent' })).toBeInTheDocument()
    expect(screen.getByTestId('kf-graph-volume')).toBeInTheDocument()
    expect(screen.getByTestId('kf-axis-volume')).toHaveTextContent('-6 dB')
    expect(screen.getByTestId('kf-axis-volume')).toHaveTextContent('0 dB')
    expect(screen.getByTestId('kf-axis-volume')).toHaveTextContent('-inf')
    // The old Audio section is gone; there is exactly one volume surface.
    expect(screen.queryByRole('heading', { name: 'Audio' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('heading', { name: 'Volume' })).toHaveLength(1)
  })

  it('shows a dB summary even before the first keyframe, with an add hint', () => {
    renderInspector(audioDoc(undefined, { gain: 0.5 }), 'clip-a')
    expect(screen.getByTestId('clip-volume-db')).toHaveTextContent('-6.0 dB')
    expect(screen.getByTestId('volume-graph-empty')).toBeInTheDocument()
    expect(screen.queryByTestId('kf-graph-volume')).not.toBeInTheDocument()
  })

  it('hides Volume for a silent video and keeps it for an embedded-audio video', () => {
    // The Clip tab follows the audible carrier. A video with no audio probe or
    // waveform peaks has nothing to mix, so it must not offer gain/mute. The
    // positive control is a solo video that does carry embedded audio.
    const silent = createClip({
      id: 'clip-silent',
      mediaId: VIDEO_NO_AUDIO.id,
      start: 0,
      duration: 4,
    })
    renderInspector(
      projectDoc([createTrack('video', 1, { clips: [silent] })], [VIDEO_NO_AUDIO]),
      'clip-silent',
    )
    expect(screen.queryByTestId('clip-volume-section')).not.toBeInTheDocument()
    cleanup()

    const loud = createClip({
      id: 'clip-loud',
      mediaId: VIDEO_WITH_AUDIO.id,
      start: 0,
      duration: 4,
    })
    renderInspector(
      projectDoc([createTrack('video', 1, { clips: [loud] })], [VIDEO_WITH_AUDIO]),
      'clip-loud',
    )
    expect(screen.getByTestId('clip-volume-section')).toBeInTheDocument()
  })

  it('targets the linked audio twin from a video-half selection', () => {
    const video = createClip({
      id: 'clip-v',
      mediaId: VIDEO_WITH_AUDIO.id,
      start: 0,
      duration: 4,
      linkId: 'L',
      gain: 1,
    })
    const twin = createClip({
      id: 'clip-a',
      mediaId: VIDEO_WITH_AUDIO.id,
      start: 0,
      duration: 4,
      linkId: 'L',
      audioOnly: true,
      gain: 0.5,
    })
    const doc = projectDoc(
      [createTrack('video', 1, { clips: [video] }), createTrack('audio', 1, { clips: [twin] })],
      [VIDEO_WITH_AUDIO],
    )
    renderInspector(doc, 'clip-v')

    expect(screen.getByTestId('volume-twin-target')).toHaveTextContent('demo.mp4')
    expect(screen.getByTestId('clip-gain-db')).toHaveTextContent('-6.0 dB')
    const slider = screen.getByRole('slider', { name: 'Clip gain percent' })
    expect(slider).toHaveAttribute('aria-valuenow', '50')

    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    const after = useEditorStore.getState().doc
    expect(after.project.tracks[0].clips[0].gain).toBe(1)
    expect(after.project.tracks[1].clips[0].gain).toBeCloseTo(0.55, 5)
  })
})
