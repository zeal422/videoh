// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'

import { TimelinePanel } from '@/components/editor/timeline/TimelinePanel'
import { InspectorPanel } from '@/components/editor/InspectorPanel'
import { AutomationEnvelope } from '@/components/editor/timeline/AutomationEnvelope'
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

function videoDoc(
  keyframes?: Keyframe[],
  options: { opacity?: number; selected?: boolean } = {},
): Doc {
  const clip = createClip({
    id: 'clip-v',
    mediaId: VIDEO_NO_AUDIO.id,
    start: 0,
    duration: 4,
    opacity: options.opacity,
    keyframes: keyframes ? { opacity: keyframes } : undefined,
  })
  const track = createTrack('video', 1, { clips: [clip] })
  return projectDoc([track], [VIDEO_NO_AUDIO])
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

function stubPlot(
  prefix = 'volume-envelope',
  left = 0,
  top = 10,
  width = 200,
  height = 20,
): HTMLElement {
  const plot = screen.getByTestId(`${prefix}-plot`)
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
  property = 'volume',
  selected = true,
  inert = false,
  penTarget = false,
  dotsOnly = false,
}: {
  id?: string
  property?: 'volume' | 'opacity'
  selected?: boolean
  inert?: boolean
  penTarget?: boolean
  dotsOnly?: boolean
}) {
  const doc = useEditorStore((s) => s.doc)
  const clip = findClip(doc, id)?.clip
  if (!clip) return null
  return (
    <AutomationEnvelope
      clip={clip}
      property={property}
      widthPx={200}
      height={36}
      selected={selected}
      inert={inert}
      penTarget={penTarget}
      dotsOnly={dotsOnly}
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

const OPACITY_POINTS: Keyframe[] = [
  { time: 0, value: 1, interpolation: 'linear' },
  { time: 4, value: 0.25, interpolation: 'linear' },
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

  it('plots keyframe dots on the same dB axis as the curve', () => {
    renderInspector(
      audioDoc([
        { time: 1, value: 1, interpolation: 'linear' },
        { time: 3, value: 0.5, interpolation: 'linear' },
      ]),
      'clip-a',
    )

    // Unity gain is 0 dB, which sits at (0 + 60) / 66 of the -60..+6 dB box.
    // The unfixed dot used the linear 0..2 gain box and read 50.
    expect(parseFloat(screen.getByTestId('kf-dot-volume-0').style.bottom)).toBeCloseTo(90.909, 3)
    // Gain 0.5 is -6.02 dB, slightly below the -6 dB label at 81.818.
    expect(parseFloat(screen.getByTestId('kf-dot-volume-1').style.bottom)).toBeCloseTo(81.787, 3)

    // The segment endpoints read the same mapping: 100 - percentForValue.
    const d = screen.getByTestId('kf-seg-volume-0').getAttribute('d') ?? ''
    expect(d.startsWith('M 25.000,9.091')).toBe(true)
    expect(d.endsWith('75.000,18.213')).toBe(true)
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

describe('opacity envelope and the Pen (0.16.0)', () => {
  function yForOpacity(value: number, top = 10, height = 20): number {
    return top + (1 - value) * height
  }

  it('shows opacity only for existing keyframes or the Pen target', () => {
    seedStore(videoDoc(), 'clip-v')
    const { rerender } = render(<EnvelopeHarness id="clip-v" property="opacity" selected />)
    expect(screen.queryByTestId('opacity-envelope')).not.toBeInTheDocument()

    rerender(<EnvelopeHarness id="clip-v" property="opacity" selected penTarget />)
    expect(screen.getByTestId('opacity-envelope-curve')).toBeInTheDocument()
    expect(screen.queryByTestId('opacity-dot-0')).not.toBeInTheDocument()
    const hit = screen.getByTestId('opacity-envelope-hit')
    expect(hit.style.pointerEvents).toBe('stroke')
    expect(hit.style.cursor).toBe('crosshair')
  })

  it('renders an existing opacity curve display-only outside the Pen', () => {
    seedStore(videoDoc(OPACITY_POINTS), 'clip-v')
    render(<EnvelopeHarness id="clip-v" property="opacity" selected={false} />)
    expect(screen.getByTestId('opacity-envelope-curve')).toBeInTheDocument()
    const dot = screen.getByTestId('opacity-dot-0')
    expect(dot).toHaveAttribute('tabindex', '-1')
    expect(dot).toHaveAttribute('aria-disabled', 'true')
    expect(dot.className).toContain('pointer-events-none')
    expect(screen.getByTestId('opacity-envelope-hit').style.pointerEvents).toBe('none')
  })

  it('a Pen click adds an interpolated opacity point and one undo entry', () => {
    seedStore(videoDoc(OPACITY_POINTS), 'clip-v')
    render(<EnvelopeHarness id="clip-v" property="opacity" selected penTarget />)
    stubPlot('opacity-envelope')
    const pastBefore = useEditorStore.getState().past.length

    fireEvent.click(screen.getByTestId('opacity-envelope-hit'), { clientX: 100 })

    const curve = useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.opacity
    expect(curve).toHaveLength(3)
    expect(curve?.[1].time).toBe(2)
    expect(curve?.[1].value).toBeCloseTo(0.625, 6)
    expect(useEditorStore.getState().past.length).toBe(pastBefore + 1)
  })

  it('a Pen click seeds the first opacity point from the static value', () => {
    seedStore(videoDoc(undefined, { opacity: 0.5 }), 'clip-v')
    render(<EnvelopeHarness id="clip-v" property="opacity" selected penTarget />)
    stubPlot('opacity-envelope')

    fireEvent.click(screen.getByTestId('opacity-envelope-hit'), { clientX: 100 })

    const curve = useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.opacity
    expect(curve).toEqual([{ time: 2, value: 0.5, interpolation: 'linear' }])
  })

  it('a Pen double-click adds one point and one undo entry', () => {
    seedStore(videoDoc(), 'clip-v')
    render(<EnvelopeHarness id="clip-v" property="opacity" selected penTarget />)
    stubPlot('opacity-envelope')
    const pastBefore = useEditorStore.getState().past.length
    const hit = screen.getByTestId('opacity-envelope-hit')

    fireEvent.click(hit, { clientX: 100, detail: 1 })
    fireEvent.click(hit, { clientX: 100, detail: 2 })

    const curve = useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.opacity
    expect(curve).toEqual([{ time: 2, value: 1, interpolation: 'linear' }])
    expect(useEditorStore.getState().past.length).toBe(pastBefore + 1)
  })

  it('drags an opacity dot in time and value with one undo entry and a readout', () => {
    seedStore(videoDoc(OPACITY_POINTS), 'clip-v')
    render(<EnvelopeHarness id="clip-v" property="opacity" selected penTarget />)
    stubPlot('opacity-envelope')
    const pastBefore = useEditorStore.getState().past.length

    fireEvent.pointerDown(screen.getByTestId('opacity-dot-1'), {
      bubbles: true,
      pointerId: 7,
      clientX: 200,
      clientY: yForOpacity(0.25),
      button: 0,
    })
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 150, clientY: yForOpacity(0.5) })
    expect(screen.getByTestId('opacity-envelope-hud')).toHaveTextContent('50%')
    fireEvent.pointerUp(window, { pointerId: 7 })

    const curve = useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.opacity
    expect(curve?.map((k) => k.time)).toEqual([0, 3])
    expect(curve?.[1].value).toBeCloseTo(0.5, 6)
    expect(useEditorStore.getState().past.length).toBe(pastBefore + 1)
    expect(screen.queryByTestId('opacity-envelope-hud')).not.toBeInTheDocument()
  })

  it('keeps the grabbed opacity point tracking the pointer across frames', () => {
    seedStore(videoDoc(OPACITY_POINTS), 'clip-v')
    render(<EnvelopeHarness id="clip-v" property="opacity" selected penTarget />)
    stubPlot('opacity-envelope')

    fireEvent.pointerDown(screen.getByTestId('opacity-dot-1'), {
      bubbles: true,
      pointerId: 7,
      clientX: 200,
      clientY: yForOpacity(0.25),
      button: 0,
    })
    // 1.3s is a deterministic one-ULP mismatch: the stored time becomes
    // 1.2999999999999998, so an exact dragTime of 1.3 would miss it.
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 65, clientY: yForOpacity(0.5) })
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 35, clientY: yForOpacity(0.25) })
    fireEvent.pointerUp(window, { pointerId: 7 })

    const curve = useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.opacity
    expect(curve?.[1].time).toBeCloseTo(0.7, 6)
  })

  it('removes an opacity point by Alt-click and by Delete, one undo each', () => {
    seedStore(videoDoc(OPACITY_POINTS), 'clip-v')
    render(<EnvelopeHarness id="clip-v" property="opacity" selected penTarget />)
    stubPlot('opacity-envelope')
    const pastBefore = useEditorStore.getState().past.length

    fireEvent.pointerDown(screen.getByTestId('opacity-dot-0'), {
      bubbles: true,
      pointerId: 8,
      clientX: 0,
      clientY: yForOpacity(1),
      button: 0,
      altKey: true,
    })
    fireEvent.pointerUp(window, { pointerId: 8 })
    let curve = useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.opacity
    expect(curve).toHaveLength(1)
    expect(curve?.[0].time).toBe(4)
    expect(useEditorStore.getState().past.length).toBe(pastBefore + 1)

    fireEvent.keyDown(screen.getByTestId('opacity-dot-0'), { key: 'Delete' })
    curve = useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.opacity
    expect(curve).toBeUndefined()
    expect(useEditorStore.getState().past.length).toBe(pastBefore + 2)
  })

  it('nudges opacity time by one frame and value by 5%', () => {
    seedStore(videoDoc(OPACITY_POINTS), 'clip-v')
    render(<EnvelopeHarness id="clip-v" property="opacity" selected penTarget />)
    const dot = screen.getByTestId('opacity-dot-0')

    fireEvent.keyDown(dot, { key: 'ArrowRight' })
    let curve = useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.opacity
    expect(curve?.[0].time).toBeCloseTo(frameToTime(1, 30), 6)

    fireEvent.keyDown(screen.getByTestId('opacity-dot-0'), { key: 'ArrowDown' })
    curve = useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.opacity
    expect(curve?.[0].value).toBeCloseTo(0.95, 6)

    fireEvent.keyDown(screen.getByTestId('opacity-dot-0'), { key: 'ArrowUp' })
    curve = useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.opacity
    expect(curve?.[0].value).toBeCloseTo(1, 6)
  })

  it('cancels a live opacity drag and keeps the curve unchanged', () => {
    seedStore(videoDoc(OPACITY_POINTS), 'clip-v')
    render(<EnvelopeHarness id="clip-v" property="opacity" selected penTarget />)
    stubPlot('opacity-envelope')
    const pastBefore = useEditorStore.getState().past.length

    fireEvent.pointerDown(screen.getByTestId('opacity-dot-0'), {
      bubbles: true,
      pointerId: 7,
      clientX: 0,
      clientY: yForOpacity(1),
      button: 0,
    })
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 100, clientY: yForOpacity(0.5) })
    expect(isTransientActive()).toBe(true)
    fireEvent.pointerCancel(window, { pointerId: 7 })

    expect(isTransientActive()).toBe(false)
    expect(useEditorStore.getState().past.length).toBe(pastBefore)
    expect(useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.opacity).toEqual(
      OPACITY_POINTS,
    )
  })

  it('clears a pending Pen gesture marker on window blur', () => {
    seedStore(videoDoc(OPACITY_POINTS), 'clip-v')
    render(<EnvelopeHarness id="clip-v" property="opacity" selected penTarget />)
    stubPlot('opacity-envelope')
    const root = screen.getByTestId('opacity-envelope')
    const before = useEditorStore.getState().past.length

    fireEvent.pointerDown(screen.getByTestId('opacity-dot-0'), {
      bubbles: true,
      pointerId: 7,
      clientX: 0,
      clientY: yForOpacity(1),
      button: 0,
    })
    expect(root).toHaveAttribute('data-automation-gesture', 'true')
    fireEvent.blur(window)
    expect(root).not.toHaveAttribute('data-automation-gesture')
    fireEvent.pointerUp(window, { pointerId: 7 })

    expect(useEditorStore.getState().past.length).toBe(before)
    expect(useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.opacity).toEqual(
      OPACITY_POINTS,
    )
  })

  it('refuses opacity edits on a locked track', () => {
    const doc = videoDoc(OPACITY_POINTS)
    doc.project.tracks[0].locked = true
    seedStore(doc, 'clip-v')
    render(<EnvelopeHarness id="clip-v" property="opacity" selected penTarget />)
    stubPlot('opacity-envelope')
    const pastBefore = useEditorStore.getState().past.length

    fireEvent.click(screen.getByTestId('opacity-envelope-hit'), { clientX: 100 })
    fireEvent.pointerDown(screen.getByTestId('opacity-dot-0'), {
      bubbles: true,
      pointerId: 9,
      clientX: 0,
      clientY: yForOpacity(1),
      button: 0,
    })
    fireEvent.pointerMove(window, { pointerId: 9, clientX: 100, clientY: yForOpacity(0.5) })
    fireEvent.pointerUp(window, { pointerId: 9 })
    fireEvent.keyDown(screen.getByTestId('opacity-dot-0'), { key: 'ArrowUp' })

    expect(useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.opacity).toEqual(
      OPACITY_POINTS,
    )
    expect(useEditorStore.getState().past.length).toBe(pastBefore)
    expect(isTransientActive()).toBe(false)
  })

  it('is inert under a modal tool', () => {
    seedStore(videoDoc(OPACITY_POINTS), 'clip-v')
    render(<EnvelopeHarness id="clip-v" property="opacity" selected inert />)
    expect(screen.getByTestId('opacity-envelope-hit').style.pointerEvents).toBe('none')
    expect(screen.getByTestId('opacity-dot-0').className).toContain('pointer-events-none')
  })

  it('a Pen target makes a single click add a volume point too', () => {
    seedStore(audioDoc(), 'clip-a')
    render(<EnvelopeHarness penTarget />)
    stubPlot()
    const before = useEditorStore.getState().doc.project.tracks[0].clips[0]

    fireEvent.click(screen.getByTestId('volume-envelope-hit'), { clientX: 100 })

    const after = useEditorStore.getState().doc.project.tracks[0].clips[0]
    expect(after.keyframes?.volume).toHaveLength(1)
    expect(after.keyframes?.volume?.[0]).toMatchObject({ time: 2, value: 1 })
    expect(after).toMatchObject({ start: before.start, duration: before.duration })
  })

  it('a dots-only volume overlay leaves the line and keeps the dots live', () => {
    seedStore(audioDoc(TWO_POINTS), 'clip-a')
    render(<EnvelopeHarness dotsOnly />)
    stubPlot()
    const pastBefore = useEditorStore.getState().past.length

    // The line belongs to opacity under the Pen: the volume overlay keeps only
    // its points, so a solo video never shows two curves at once.
    expect(screen.queryByTestId('volume-envelope-curve')).not.toBeInTheDocument()
    expect(screen.getByTestId('volume-envelope-hit').style.pointerEvents).toBe('none')
    expect(screen.getByTestId('volume-dot-0').className).toContain('pointer-events-auto')

    fireEvent.pointerDown(screen.getByTestId('volume-dot-0'), {
      bubbles: true,
      pointerId: 7,
      clientX: 50,
      clientY: yFor(1),
      button: 0,
    })
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 100, clientY: yFor(0.5) })
    fireEvent.pointerUp(window, { pointerId: 7 })

    const curve = useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.volume
    expect(curve?.[0].time).toBe(2)
    expect(useEditorStore.getState().past.length).toBe(pastBefore + 1)
  })

  it('a solo video under the Pen edits opacity while its volume dots stay live', () => {
    const clip = createClip({
      id: 'clip-loud',
      mediaId: VIDEO_WITH_AUDIO.id,
      start: 0,
      duration: 4,
      keyframes: { volume: TWO_POINTS },
    })
    const doc = projectDoc([createTrack('video', 1, { clips: [clip] })], [VIDEO_WITH_AUDIO])
    useEditorStore.setState({
      ...useEditorStore.getInitialState(),
      doc,
      selections: ['clip-loud'],
      selection: 'clip-loud',
      playhead: 0,
      pxPerSec: 100,
      activeTool: 'pen',
    })
    render(<TimelinePanel />)

    const clipEl = screen.getByTestId('clip-clip-loud')
    expect(within(clipEl).getByTestId('opacity-envelope')).toBeInTheDocument()
    expect(within(clipEl).getByTestId('volume-envelope')).toBeInTheDocument()
    expect(within(clipEl).getByTestId('opacity-envelope-hit').style.pointerEvents).toBe('stroke')
    expect(within(clipEl).getByTestId('volume-envelope-hit').style.pointerEvents).toBe('none')
    expect(within(clipEl).getByTestId('volume-dot-0').className).toContain('pointer-events-auto')

    stubPlot('opacity-envelope')
    fireEvent.click(within(clipEl).getByTestId('opacity-envelope-hit'), { clientX: 100 })
    const stored = useEditorStore.getState().doc.project.tracks[0].clips[0]
    expect(stored.keyframes?.opacity).toHaveLength(1)
    expect(stored.keyframes?.opacity?.[0]).toMatchObject({ time: 2, value: 1 })
    expect(stored.keyframes?.volume).toEqual(TWO_POINTS)

    fireEvent.pointerDown(within(clipEl).getByTestId('volume-dot-0'), {
      bubbles: true,
      pointerId: 11,
      clientX: 50,
      clientY: yFor(1),
      button: 0,
      altKey: true,
    })
    fireEvent.pointerUp(window, { pointerId: 11 })
    const afterVolume = useEditorStore.getState().doc.project.tracks[0].clips[0]
    expect(afterVolume.keyframes?.volume).toHaveLength(1)
    expect(afterVolume.keyframes?.opacity).toHaveLength(1)
    expect(afterVolume).toMatchObject({ start: 0, duration: 4, inPoint: 0 })
  })
})

describe('volume envelope on a locked track (0.14.0)', () => {
  function lockedDoc(keyframes = TWO_POINTS) {
    const doc = audioDoc(keyframes)
    doc.project.tracks[0].locked = true
    return doc
  }

  it('refuses a dot drag before any transient starts', () => {
    seedStore(lockedDoc(), 'clip-a')
    render(<EnvelopeHarness />)
    stubPlot()
    const pastBefore = useEditorStore.getState().past.length

    fireEvent.pointerDown(screen.getByTestId('volume-dot-0'), {
      bubbles: true,
      pointerId: 21,
      clientX: 50,
      clientY: yFor(1),
      button: 0,
    })
    fireEvent.pointerMove(window, { pointerId: 21, clientX: 150, clientY: yFor(0.5) })
    expect(isTransientActive()).toBe(false)
    expect(screen.queryByTestId('volume-envelope-hud')).not.toBeInTheDocument()
    fireEvent.pointerUp(window, { pointerId: 21 })

    const curve = useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.volume
    expect(curve).toEqual(TWO_POINTS)
    expect(useEditorStore.getState().past.length).toBe(pastBefore)
  })

  it('refuses a double-click add', () => {
    seedStore(audioDoc(), 'clip-a')
    useEditorStore.getState().doc.project.tracks[0].locked = true
    render(<EnvelopeHarness />)
    stubPlot()
    fireEvent.doubleClick(screen.getByTestId('volume-envelope-hit'), {
      clientX: 100,
      clientY: yFor(1),
    })
    expect(
      useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.volume,
    ).toBeUndefined()
  })

  it('refuses Alt-click removal', () => {
    seedStore(lockedDoc(), 'clip-a')
    render(<EnvelopeHarness />)
    stubPlot()
    fireEvent.pointerDown(screen.getByTestId('volume-dot-0'), {
      bubbles: true,
      pointerId: 22,
      clientX: 50,
      clientY: yFor(1),
      button: 0,
      altKey: true,
    })
    fireEvent.pointerUp(window, { pointerId: 22 })
    const curve = useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.volume
    expect(curve).toEqual(TWO_POINTS)
  })

  it('refuses keyboard nudge and delete', () => {
    seedStore(lockedDoc(), 'clip-a')
    render(<EnvelopeHarness />)
    const dot = screen.getByTestId('volume-dot-0')
    fireEvent.keyDown(dot, { key: 'ArrowUp' })
    fireEvent.keyDown(dot, { key: 'ArrowLeft' })
    fireEvent.keyDown(dot, { key: 'Delete' })
    const curve = useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.volume
    expect(curve).toEqual(TWO_POINTS)
  })
})
