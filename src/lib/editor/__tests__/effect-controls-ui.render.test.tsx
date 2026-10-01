// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { InspectorPanel } from '@/components/editor/InspectorPanel'
import { useEditorKeyboard } from '@/hooks/editor/useEditorKeyboard'
import { installBrowserMocks, type MockHarness } from './mocks/browser-mocks'
import { playbackRef, type PlaybackController } from '../playback/engine-ref'
import { isTransientActive, useEditorStore } from '../store'
import { clipFitsTrack, createClip, createMediaAsset, createTrack } from '../factories'
import type { Clip, Doc } from '../types'

/**
 * jsdom render tests for the Effect Controls tab: selecting a clip shows the
 * two-tab inspector, the diamond button writes a first keyframe at the
 * playhead through the store, and the audio section appears for audio-bearing
 * clips. The full UI stays covered by the E2E battery.
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
  playbackRef.current = null
})

function docWithSelectedVideoClip(): { doc: Doc; clipId: string } {
  const asset = createMediaAsset({ kind: 'video', duration: 30, name: 'demo.mp4' })
  const clip = createClip({ id: 'clip_ec', mediaId: asset.id, start: 0, duration: 6 })
  const track = createTrack('video', 1, { clips: [clip as Clip] })
  const doc: Doc = {
    project: { tracks: [track], id: 'p_test', name: 'test', width: 1920, height: 1080, fps: 30 },
    media: [asset],
  }
  useEditorStore.setState({ doc, selection: clip.id, selections: [clip.id], playhead: 2 })
  return { doc, clipId: clip.id }
}

describe('InspectorPanel tabs', () => {
  it('renders Clip and Effect Controls tabs for a selected clip', () => {
    docWithSelectedVideoClip()
    render(<InspectorPanel />)
    expect(screen.getByTestId('inspector-tab-clip')).toBeInTheDocument()
    expect(screen.getByTestId('inspector-tab-effects')).toBeInTheDocument()
    expect(screen.getByTestId('inspector-tab-clip')).toHaveAttribute('aria-selected', 'true')
  })

  it('the color grade sliders commit a setClipColorParams for the selected clip', async () => {
    docWithSelectedVideoClip()
    render(<InspectorPanel />)
    // Selected by role and NAME: the `role="slider"` element is Radix's thumb,
    // not the root that carries the id, and a CSS walk into the root would keep
    // passing even if the thumb were left unannounced (see the naming test).
    const temperature = screen.getByRole('slider', { name: 'Temperature' })
    expect(temperature).toHaveAttribute('aria-valuemin', '-100')
    expect(temperature).toHaveAttribute('aria-valuemax', '100')
    expect(temperature).toHaveAttribute('aria-valuenow', '0')
    expect(screen.getByRole('slider', { name: 'Tint' })).toBeInTheDocument()

    // A keyboard step commits immediately (Radix treats keys as committed).
    fireEvent.keyDown(temperature, { key: 'ArrowRight' })

    const clip = useEditorStore.getState().doc.project.tracks[0].clips[0]
    expect(clip.temperature).toBe(1)
    // The untouched control stays neutral (absent, not a zero-valued field).
    expect(clip.tint).toBeUndefined()
  })

  it('names every inspector slider thumb for assistive tech', async () => {
    // The name has to reach the THUMB (the element with role="slider"): an
    // `aria-label` on the root span is inert, since Radix reads a thumb's name
    // from its own props and a single-value slider has no fallback label.
    docWithSelectedVideoClip()
    render(<InspectorPanel />)
    expect(screen.getByRole('slider', { name: 'Temperature' })).toBeInTheDocument()
    expect(screen.getByRole('slider', { name: 'Tint' })).toBeInTheDocument()
    expect(screen.getByRole('slider', { name: 'Clip opacity percent' })).toBeInTheDocument()
    expect(screen.getByRole('slider', { name: 'Clip gain percent' })).toBeInTheDocument()

    // The Effect Controls rows are named the same way, including the easing
    // group's own sliders.
    await userEvent.click(screen.getByTestId('inspector-tab-effects'))
    expect(screen.getByRole('slider', { name: 'Opacity value' })).toBeInTheDocument()
    expect(screen.getByRole('slider', { name: 'Clip speed' })).toBeInTheDocument()
    expect(screen.getByRole('slider', { name: 'Time remapping value' })).toBeInTheDocument()
  })

  it('switches to the Effect Controls tab and shows the property rows', async () => {
    docWithSelectedVideoClip()
    render(<InspectorPanel />)
    await userEvent.click(screen.getByTestId('inspector-tab-effects'))
    expect(screen.getByTestId('effect-controls')).toBeInTheDocument()
    expect(screen.getByTestId('prop-opacity')).toBeInTheDocument()
    expect(screen.getByTestId('prop-scale')).toBeInTheDocument()
    expect(screen.getByTestId('prop-hue')).toBeInTheDocument()
    expect(screen.getByTestId('speed-section')).toBeInTheDocument()
    // No curve yet, so the static control is live.
    expect(
      document.querySelector('[data-testid="speed-section"] [data-slot="slider"]'),
    ).not.toHaveAttribute('data-disabled')
  })

  it('disables the static speed slider once a time remapping curve exists', async () => {
    const { doc } = docWithSelectedVideoClip()
    const slider = () =>
      document.querySelector('[data-testid="speed-section"] [data-slot="slider"]') as HTMLElement

    doc.project.tracks[0].clips[0].keyframes = { timeScale: [{ time: 0, value: 1 }] }
    useEditorStore.setState({ doc })
    render(<InspectorPanel />)
    await userEvent.click(screen.getByTestId('inspector-tab-effects'))

    // The curve, not the static rate, decides the clip's speed, so the control
    // is disabled and points at where the rate actually comes from.
    expect(slider()).toHaveAttribute('data-disabled')
    expect(screen.getByTestId('speed-section')).toHaveTextContent('time remapping curve')
  })

  it('the keyframe diamond writes a first keyframe at clip-local playhead time', async () => {
    docWithSelectedVideoClip()
    render(<InspectorPanel />)
    await userEvent.click(screen.getByTestId('inspector-tab-effects'))
    await userEvent.click(screen.getByTestId('kf-toggle-opacity'))
    const doc = useEditorStore.getState().doc
    const clip = doc.project.tracks[0].clips[0]
    expect(clip.keyframes?.opacity).toEqual([{ time: 2, value: 1, interpolation: 'linear' }])
    // The toggle flips to the animated state and the graph appears.
    expect(screen.getByTestId('kf-toggle-opacity')).toHaveAttribute('data-active', 'true')
    expect(screen.getByTestId('kf-graph-opacity')).toBeInTheDocument()
  })

  it('the time-remap row seeds a timeScale curve at the playhead', async () => {
    docWithSelectedVideoClip()
    render(<InspectorPanel />)
    await userEvent.click(screen.getByTestId('inspector-tab-effects'))
    expect(screen.getByTestId('prop-timeScale')).toBeInTheDocument()

    // The diamond pins the clip's current speed as the first ramp keyframe.
    await userEvent.click(screen.getByTestId('kf-toggle-timeScale'))
    const clip = useEditorStore.getState().doc.project.tracks[0].clips[0]
    expect(clip.keyframes?.timeScale).toEqual([{ time: 2, value: 1, interpolation: 'linear' }])
    expect(clip.speed).toBeUndefined() // the curve is separate from the static rate
    expect(screen.getByTestId('kf-graph-timeScale')).toBeInTheDocument()
  })

  it('the easing picker rewrites the active keyframe interpolation and marks the dot', async () => {
    const { doc } = docWithSelectedVideoClip()
    const clip = doc.project.tracks[0].clips[0]
    clip.keyframes = {
      opacity: [
        { time: 1, value: 1 },
        { time: 5, value: 0.2 },
      ],
    }
    useEditorStore.setState({ doc: structuredClone(doc), playhead: 1.1 })
    render(<InspectorPanel />)
    await userEvent.click(screen.getByTestId('inspector-tab-effects'))
    expect(screen.getByTestId('kf-dot-opacity-0')).toHaveAttribute('data-interpolation', 'linear')

    await userEvent.click(screen.getByTestId('kf-ease-opacity-easeInOut'))

    const kfs = useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.opacity
    // The keyframe nearest the playhead takes the easing; the other is untouched.
    expect(kfs?.[0].interpolation).toBe('easeInOut')
    expect(kfs?.[1].interpolation).toBe('linear')
    expect(screen.getByTestId('kf-dot-opacity-0')).toHaveAttribute(
      'data-interpolation',
      'easeInOut',
    )
    expect(screen.getByTestId('kf-ease-opacity-easeInOut')).toHaveAttribute('aria-pressed', 'true')
  })

  it('re-picking the active easing keeps an exact subdivided sub-curve', async () => {
    // A segment produced by a split or a trim carries the exact subdivided
    // bezier in `easeOut` while its `interpolation` name still renders as the
    // pressed button. Clicking that same name must be a no-op: otherwise one
    // click on a control that looks inert replaces the sub-curve with the
    // full-span preset and re-times the half.
    const { doc } = docWithSelectedVideoClip()
    const clip = doc.project.tracks[0].clips[0]
    const sub = [0.29, 0.5, 0.58, 1] as const
    clip.keyframes = {
      opacity: [
        { time: 1, value: 1, interpolation: 'easeInOut', easeOut: sub },
        { time: 5, value: 0.2 },
      ],
    }
    useEditorStore.setState({ doc: structuredClone(doc), playhead: 1.1 })
    render(<InspectorPanel />)
    await userEvent.click(screen.getByTestId('inspector-tab-effects'))
    const pressed = screen.getByTestId('kf-ease-opacity-easeInOut')
    expect(pressed).toHaveAttribute('aria-pressed', 'true')

    await userEvent.click(pressed)

    let kfs = useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.opacity
    expect(kfs?.[0].easeOut).toEqual(sub)

    // Guards the guard: picking a DIFFERENT name still replaces the data.
    await userEvent.click(screen.getByTestId('kf-ease-opacity-linear'))
    kfs = useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.opacity
    expect(kfs?.[0].interpolation).toBe('linear')
    expect(kfs?.[0].easeOut).toBeUndefined()
  })

  it('an arrow key on the easing picker does not drive the global shortcut', async () => {
    const { doc } = docWithSelectedVideoClip()
    const clip = doc.project.tracks[0].clips[0]
    clip.keyframes = {
      opacity: [
        { time: 1, value: 1 },
        { time: 5, value: 0.2 },
      ],
    }
    useEditorStore.setState({ doc: structuredClone(doc), playhead: 1.1 })
    const stepFrames = vi.fn()
    const seek = vi.fn()
    playbackRef.current = { stepFrames, seek } as unknown as PlaybackController

    function Harness() {
      useEditorKeyboard(() => {})
      return <InspectorPanel />
    }
    render(<Harness />)
    await userEvent.click(screen.getByTestId('inspector-tab-effects'))

    // The swatches are plain <button>s, so without a key guard of their own the
    // global handler (which only skips form fields) reads the arrow as
    // frame-step / jump-to-edit: the exact failure MarkerDialog's radiogroup
    // already had to fix for the marker color swatches in 0.5.6.
    fireEvent.keyDown(screen.getByTestId('kf-ease-opacity-easeIn'), {
      key: 'ArrowRight',
      bubbles: true,
    })
    expect(stepFrames).not.toHaveBeenCalled()
    expect(seek).not.toHaveBeenCalled()

    // The shortcut itself stays live away from the picker (guards the guard).
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(stepFrames).toHaveBeenCalledWith(1)
  })

  it('an arrow key on a keyframe graph dot does not drive the global shortcut', async () => {
    const { doc } = docWithSelectedVideoClip()
    const clip = doc.project.tracks[0].clips[0]
    clip.keyframes = {
      opacity: [
        { time: 1, value: 1 },
        { time: 5, value: 0.2 },
      ],
    }
    useEditorStore.setState({ doc: structuredClone(doc), playhead: 1.1 })
    const stepFrames = vi.fn()
    const seek = vi.fn()
    playbackRef.current = { stepFrames, seek } as unknown as PlaybackController

    function Harness() {
      useEditorKeyboard(() => {})
      return <InspectorPanel />
    }
    render(<Harness />)
    await userEvent.click(screen.getByTestId('inspector-tab-effects'))

    // The dots are focusable `role="slider"` divs with no key behaviour of their
    // own, so without the graph wrapper's guard the global handler (which skips
    // only form fields) would frame-step / jump-to-edit while the dot sits
    // there: the same defect the easing picker above already fixed.
    const dot = screen.getByTestId('kf-dot-opacity-0')
    dot.focus()
    fireEvent.keyDown(dot, { key: 'ArrowRight', bubbles: true })
    fireEvent.keyDown(dot, { key: 'ArrowDown', bubbles: true })
    expect(stepFrames).not.toHaveBeenCalled()
    expect(seek).not.toHaveBeenCalled()

    // The shortcut itself stays live away from the graph (guards the guard).
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(stepFrames).toHaveBeenCalledWith(1)
  })

  it('arrow keys on a focused dot nudge its time by one frame (the slider contract)', async () => {
    // The dots are focusable `role="slider"` elements, which promises a
    // keyboard path; the wrapper guard used to swallow every arrow and leave
    // the promise unbacked. Left/Right now nudge the focused dot's time by
    // one frame (clamped to the clip), Up/Down stay inert, the global
    // shortcut stays silent, and a key HELD down does not ratchet repeats.
    const { doc } = docWithSelectedVideoClip()
    const clip = doc.project.tracks[0].clips[0]
    clip.keyframes = {
      opacity: [
        { time: 1, value: 1 },
        { time: 5, value: 0.2 },
      ],
    }
    useEditorStore.setState({ doc: structuredClone(doc), playhead: 1.1 })
    const stepFrames = vi.fn()
    playbackRef.current = { stepFrames, seek: vi.fn() } as unknown as PlaybackController

    function Harness() {
      useEditorKeyboard(() => {})
      return <InspectorPanel />
    }
    render(<Harness />)
    await userEvent.click(screen.getByTestId('inspector-tab-effects'))

    const dot = screen.getByTestId('kf-dot-opacity-0')
    dot.focus()
    fireEvent.keyDown(dot, { key: 'ArrowRight', bubbles: true })
    let kfs = useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes!.opacity!
    expect(kfs[0].time).toBeCloseTo(1 + 1 / 30, 6)
    // Steps repeat while held (a native slider thumb does the same).
    fireEvent.keyDown(dot, { key: 'ArrowRight', bubbles: true, repeat: true })
    kfs = useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes!.opacity!
    expect(kfs[0].time).toBeCloseTo(1 + 2 / 30, 6)

    fireEvent.keyDown(dot, { key: 'ArrowLeft', bubbles: true })
    kfs = useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes!.opacity!
    expect(kfs[0].time).toBeCloseTo(1 + 1 / 30, 6)

    // Up/Down stay inert (this axis is time-only) and never reach the global
    // shortcut.
    fireEvent.keyDown(dot, { key: 'ArrowUp', bubbles: true })
    fireEvent.keyDown(dot, { key: 'ArrowDown', bubbles: true })
    kfs = useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes!.opacity!
    expect(kfs[0].time).toBeCloseTo(1 + 1 / 30, 6)

    // Global shortcut stayed silent through all of it.
    expect(stepFrames).not.toHaveBeenCalled()

    // The OTHER dot is the one that moves when it holds focus (per-dot
    // handler), and a dot already at the clip edge cannot nudge past it.
    const last = screen.getByTestId('kf-dot-opacity-1')
    last.focus()
    fireEvent.keyDown(last, { key: 'ArrowLeft', bubbles: true })
    kfs = useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes!.opacity!
    expect(kfs[0].time).toBeCloseTo(1 + 1 / 30, 6) // first dot untouched
    expect(kfs[1].time).toBeCloseTo(5 - 1 / 30, 6)
    const clampDoc = useEditorStore.getState().doc
    clampDoc.project.tracks[0].clips[0].keyframes!.opacity![1].time = 6
    useEditorStore.setState({ doc: clampDoc })
    fireEvent.keyDown(last, { key: 'ArrowRight', bubbles: true })
    kfs = useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes!.opacity!
    expect(kfs[1].time).toBe(6)
  })

  it('nudges a mirrored row in screen space so Left moves the dot left on screen', async () => {
    // A reversed clip's timeScale axis is flipped (`axis = duration - t`):
    // the nudge runs in AXIS space and converts back, so screen-left is
    // curve-right and the clamps land where the user sees them.
    const { doc } = docWithSelectedVideoClip()
    const clip = doc.project.tracks[0].clips[0]
    clip.reverse = true
    clip.keyframes = {
      timeScale: [
        { time: 1, value: 1 },
        { time: 5, value: 2 },
      ],
    }
    useEditorStore.setState({ doc: structuredClone(doc), playhead: 2 })
    const stepFrames = vi.fn()
    playbackRef.current = { stepFrames, seek: vi.fn() } as unknown as PlaybackController

    function Harness() {
      useEditorKeyboard(() => {})
      return <InspectorPanel />
    }
    render(<Harness />)
    await userEvent.click(screen.getByTestId('inspector-tab-effects'))

    const dot = screen.getByTestId('kf-dot-timeScale-0')
    dot.focus()
    fireEvent.keyDown(dot, { key: 'ArrowLeft', bubbles: true })
    // Screen-left on a mirrored axis is curve-RIGHT (+1 frame).
    const kfs = useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes!.timeScale!
    expect(kfs[0].time).toBeCloseTo(1 + 1 / 30, 6)
    expect(stepFrames).not.toHaveBeenCalled()
  })

  it('mirrors the time-remap axis for a reversed clip', async () => {
    // `sourceTimeAt` indexes a reversed clip's curve at `duration - local`, so
    // the row must read and write the MIRRORED time or the whole curve lands on
    // the wrong axis (the rate shown where the engine applies the other end).
    const { doc } = docWithSelectedVideoClip()
    const clip = doc.project.tracks[0].clips[0]
    clip.keyframes = {
      timeScale: [
        { time: 0, value: 1 },
        { time: 6, value: 4 },
      ],
    }
    useEditorStore.setState({ doc: structuredClone(doc), playhead: 2 })
    render(<InspectorPanel />)
    await userEvent.click(screen.getByTestId('inspector-tab-effects'))
    // The forward axis reads offset 2 -> rate 1 + (2/6) * 3 = 2.
    expect(screen.getByTestId('prop-timeScale')).toHaveTextContent('2.00')
    expect(screen.getByTestId('kf-dot-timeScale-0')).toHaveStyle({ left: '0%' })

    // Reversed: mirrored offset 6 - 2 = 4 -> rate 3, and the dot for curve time
    // 0 belongs at the axis's RIGHT end, curve time 6 at the left.
    cleanup()
    const reversed = structuredClone(doc)
    reversed.project.tracks[0].clips[0].reverse = true
    useEditorStore.setState({ doc: reversed, playhead: 2 })
    render(<InspectorPanel />)
    await userEvent.click(screen.getByTestId('inspector-tab-effects'))
    expect(screen.getByTestId('prop-timeScale')).toHaveTextContent('3.00')
    expect(screen.getByTestId('kf-dot-timeScale-0')).toHaveStyle({ left: '100%' })
    expect(screen.getByTestId('kf-dot-timeScale-1')).toHaveStyle({ left: '0%' })
  })

  it('targets the mirrored keyframe with the easing picker on a reversed clip', async () => {
    // The picker edits the keyframe nearest the playhead, so it has to measure on
    // the same mirrored axis as the value and the dots; measuring on the plain
    // local time edits the other end of the curve.
    const { doc } = docWithSelectedVideoClip()
    doc.project.tracks[0].clips[0].keyframes = {
      timeScale: [
        { time: 0, value: 1, interpolation: 'easeIn' },
        { time: 6, value: 4, interpolation: 'easeOut' },
      ],
    }
    const reversed = structuredClone(doc)
    reversed.project.tracks[0].clips[0].reverse = true
    useEditorStore.setState({ doc: reversed, playhead: 2 })
    render(<InspectorPanel />)
    await userEvent.click(screen.getByTestId('inspector-tab-effects'))

    // Mirrored playhead 6 - 2 = 4 is nearer curve time 6 than curve time 0.
    expect(screen.getByTestId('kf-ease-timeScale-easeOut')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('kf-ease-timeScale-easeIn')).toHaveAttribute('aria-pressed', 'false')
  })

  it('removes the mirrored keyframe with the diamond on a reversed clip', async () => {
    // Same axis as the picker: the diamond removes the keyframe the mirrored
    // playhead sits nearest, which is the one its own seed path would have made.
    const { doc } = docWithSelectedVideoClip()
    doc.project.tracks[0].clips[0].keyframes = {
      timeScale: [
        { time: 0, value: 1 },
        { time: 6, value: 4 },
      ],
    }
    const reversed = structuredClone(doc)
    reversed.project.tracks[0].clips[0].reverse = true
    useEditorStore.setState({ doc: reversed, playhead: 2 })
    render(<InspectorPanel />)
    await userEvent.click(screen.getByTestId('inspector-tab-effects'))

    await userEvent.click(screen.getByTestId('kf-toggle-timeScale'))
    const kept = useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.timeScale
    expect(kept?.map((k) => k.time)).toEqual([0])
  })

  it('hides the picture-only rows for the A/V audio twin on a video track', async () => {
    // `clipFitsTrack` lets a video asset's `audioOnly` twin move to a video
    // track, so the track kind is not a proxy for "carries picture": gating the
    // picture-only rows on it alone lets the twin seed a time-remap curve, and a
    // ramp anywhere in the link group drops the whole group's audio.
    const asset = createMediaAsset({ kind: 'video', duration: 30, name: 'twin.mp4' })
    const twin = createClip({
      id: 'clip_twin',
      mediaId: asset.id,
      start: 0,
      duration: 6,
      linkId: 'L',
      audioOnly: true,
    })
    const track = createTrack('video', 1, { clips: [twin as Clip] })
    const doc: Doc = {
      project: { tracks: [track], id: 'p_test', name: 'test', width: 1920, height: 1080, fps: 30 },
      media: [asset],
    }
    expect(clipFitsTrack(doc, twin as Clip, track)).toBe(true)
    useEditorStore.setState({ doc, selection: twin.id, selections: [twin.id], playhead: 2 })
    render(<InspectorPanel />)
    await userEvent.click(screen.getByTestId('inspector-tab-effects'))

    // The static Speed slider stays: it re-times the twin's own audio element.
    expect(screen.getByTestId('speed-section')).toBeInTheDocument()
    expect(screen.getByLabelText('Clip speed')).toBeInTheDocument()
    expect(screen.queryByTestId('prop-timeScale')).not.toBeInTheDocument()
    expect(screen.queryByTestId('kf-toggle-timeScale')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Reverse clip')).not.toBeInTheDocument()
  })

  it('a second click removes the keyframe and clears the curve', async () => {
    docWithSelectedVideoClip()
    render(<InspectorPanel />)
    await userEvent.click(screen.getByTestId('inspector-tab-effects'))
    await userEvent.click(screen.getByTestId('kf-toggle-opacity'))
    await userEvent.click(screen.getByTestId('kf-toggle-opacity'))
    const clip = useEditorStore.getState().doc.project.tracks[0].clips[0]
    expect(clip.keyframes?.opacity).toBeUndefined()
  })

  it('dragging a keyframe dot commits exactly one undo step', async () => {
    const { doc } = docWithSelectedVideoClip()
    const clip = doc.project.tracks[0].clips[0]
    clip.keyframes = {
      opacity: [
        { time: 1, value: 1 },
        { time: 3, value: 1 },
      ],
    }
    useEditorStore.setState({ doc: structuredClone(doc) })
    render(<InspectorPanel />)
    await userEvent.click(screen.getByTestId('inspector-tab-effects'))

    // jsdom reports a zero-size rect; the drag math needs the graph's width.
    const graph = screen.getByTestId('kf-graph-opacity')
    graph.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        right: 200,
        bottom: 40,
        width: 200,
        height: 40,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect

    const pastBefore = useEditorStore.getState().past.length
    fireEvent(
      screen.getByTestId('kf-dot-opacity-0'),
      new MouseEvent('pointerdown', { bubbles: true, clientX: 33 }),
    )
    fireEvent(window, new MouseEvent('pointermove', { clientX: 50 })) // 50/200 of 6 s
    fireEvent(window, new MouseEvent('pointerup'))

    const moved =
      useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.opacity?.[0].time
    expect(moved).toBeCloseTo(1.5, 5)
    expect(useEditorStore.getState().past.length).toBe(pastBefore + 1)

    useEditorStore.getState().undo()
    const undone =
      useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.opacity?.[0].time
    expect(undone).toBe(1)
  })

  it('a foreign commit mid-drag makes the dot refuse its remaining frames', async () => {
    const { doc, clipId } = docWithSelectedVideoClip()
    const clip = doc.project.tracks[0].clips[0]
    clip.keyframes = {
      opacity: [
        { time: 1, value: 1 },
        { time: 3, value: 1 },
      ],
    }
    useEditorStore.setState({ doc: structuredClone(doc) })
    render(<InspectorPanel />)
    await userEvent.click(screen.getByTestId('inspector-tab-effects'))

    const graph = screen.getByTestId('kf-graph-opacity')
    graph.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        right: 200,
        bottom: 40,
        width: 200,
        height: 40,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect

    const pastBefore = useEditorStore.getState().past.length
    fireEvent(
      screen.getByTestId('kf-dot-opacity-0'),
      new MouseEvent('pointerdown', { bubbles: true, clientX: 33 }),
    )
    fireEvent(window, new MouseEvent('pointermove', { clientX: 50 })) // 1.5 s
    // A foreign commit (keyboard delete, menu action, ...) resolves the gesture
    // first: the drag's in-flight frame rolls back before the history snapshot.
    useEditorStore.getState().apply({ type: 'setClipMuted', clipId, muted: true })
    expect(useEditorStore.getState().past.length).toBe(pastBefore + 1)
    const keyframeTime = () =>
      useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.opacity?.[0].time
    expect(keyframeTime()).toBe(1)

    // The stale drag's next frame must be refused, or it would mutate the doc
    // with no undo entry behind it (unreachable by undoing the history).
    fireEvent(window, new MouseEvent('pointermove', { clientX: 150 })) // would be 4.5 s
    expect(keyframeTime()).toBe(1)
    expect(useEditorStore.getState().past.length).toBe(pastBefore + 1)
    fireEvent(window, new MouseEvent('pointerup'))
  })

  it('a foreign pointer release does not end the keyframe drag it does not own', async () => {
    const { doc } = docWithSelectedVideoClip()
    const clip = doc.project.tracks[0].clips[0]
    clip.keyframes = {
      opacity: [
        { time: 1, value: 1 },
        { time: 3, value: 1 },
      ],
    }
    useEditorStore.setState({ doc: structuredClone(doc) })
    render(<InspectorPanel />)
    await userEvent.click(screen.getByTestId('inspector-tab-effects'))

    const graph = screen.getByTestId('kf-graph-opacity')
    graph.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        right: 200,
        bottom: 40,
        width: 200,
        height: 40,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect

    fireEvent.pointerDown(screen.getByTestId('kf-dot-opacity-0'), {
      bubbles: true,
      pointerId: 5,
      clientX: 33,
    })
    fireEvent.pointerMove(window, { pointerId: 5, clientX: 50 }) // 1.5 s
    expect(isTransientActive()).toBe(true)

    // A second finger lifts (multi-touch): it must not commit the drag the
    // first pointer still owns.
    fireEvent.pointerUp(window, { pointerId: 9 })
    expect(isTransientActive()).toBe(true)

    fireEvent.pointerUp(window, { pointerId: 5 })
    expect(isTransientActive()).toBe(false)
    const time =
      useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.opacity?.[0].time
    expect(time).toBeCloseTo(1.5, 5)
  })

  it('a second pointer re-grabbing the same dot takes the drag over', async () => {
    const { doc } = docWithSelectedVideoClip()
    const clip = doc.project.tracks[0].clips[0]
    clip.keyframes = {
      opacity: [
        { time: 1, value: 1 },
        { time: 3, value: 1 },
      ],
    }
    useEditorStore.setState({ doc: structuredClone(doc) })
    render(<InspectorPanel />)
    await userEvent.click(screen.getByTestId('inspector-tab-effects'))

    const graph = screen.getByTestId('kf-graph-opacity')
    graph.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        right: 200,
        bottom: 40,
        width: 200,
        height: 40,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect
    const dot = screen.getByTestId('kf-dot-opacity-0')
    const dotTime = () =>
      useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.opacity?.[0].time

    fireEvent.pointerDown(dot, { bubbles: true, pointerId: 5, clientX: 33 })
    fireEvent.pointerMove(window, { pointerId: 5, clientX: 50 }) // 1.5 s
    expect(dotTime()).toBeCloseTo(1.5, 5)

    // The same dot is grabbed by another pointer: ownership transfers, so the
    // handlers must read the CURRENT pointerId (the effect re-runs) instead of
    // keeping the first pointer's and ignoring every later frame. The dot is
    // re-queried because its React key carries the time, so a transient frame
    // remounts the element (the drag itself rides on window listeners).
    fireEvent.pointerDown(screen.getByTestId('kf-dot-opacity-0'), {
      bubbles: true,
      pointerId: 9,
      clientX: 33,
    })
    fireEvent.pointerMove(window, { pointerId: 9, clientX: 100 }) // 3.0 s
    expect(dotTime()).toBeCloseTo(3, 5)
    fireEvent.pointerUp(window, { pointerId: 9 })
  })

  it('a pointercancel discards the keyframe drag instead of stranding its transient', async () => {
    const { doc } = docWithSelectedVideoClip()
    const clip = doc.project.tracks[0].clips[0]
    clip.keyframes = {
      opacity: [
        { time: 1, value: 1 },
        { time: 3, value: 1 },
      ],
    }
    useEditorStore.setState({ doc: structuredClone(doc) })
    render(<InspectorPanel />)
    await userEvent.click(screen.getByTestId('inspector-tab-effects'))

    const graph = screen.getByTestId('kf-graph-opacity')
    graph.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        right: 200,
        bottom: 40,
        width: 200,
        height: 40,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect

    const pastBefore = useEditorStore.getState().past.length
    fireEvent.pointerDown(screen.getByTestId('kf-dot-opacity-0'), {
      bubbles: true,
      pointerId: 7,
      clientX: 33,
    })
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 50 })
    expect(isTransientActive()).toBe(true)

    // The browser took the pointer: the gesture is discarded, not committed.
    fireEvent.pointerCancel(window, { pointerId: 7 })
    expect(isTransientActive()).toBe(false)
    const after = useEditorStore.getState()
    expect(after.past.length).toBe(pastBefore)
    expect(after.doc.project.tracks[0].clips[0].keyframes?.opacity?.[0].time).toBe(1)
  })

  it('routes audio edits to the linked audio twin, the pair sound carrier', async () => {
    const asset = createMediaAsset({ kind: 'video', duration: 30, name: 'pair.mp4' })
    const video = createClip({
      id: 'clip_v',
      mediaId: asset.id,
      start: 0,
      duration: 6,
      linkId: 'L',
    })
    const twin = createClip({
      id: 'clip_a',
      mediaId: asset.id,
      start: 0,
      duration: 6,
      linkId: 'L',
      audioOnly: true,
    })
    const doc: Doc = {
      project: {
        tracks: [
          createTrack('video', 1, { clips: [video as Clip] }),
          createTrack('audio', 1, { clips: [twin as Clip] }),
        ],
        id: 'p_test',
        name: 'test',
        width: 1920,
        height: 1080,
        fps: 30,
      },
      media: [asset],
    }
    useEditorStore.setState({ doc, selection: video.id, selections: [video.id], playhead: 2 })
    render(<InspectorPanel />)
    await userEvent.click(screen.getByTestId('inspector-tab-effects'))

    // The video half shows the audio group (through its twin) and the visual one.
    expect(screen.getByTestId('prop-volume')).toBeInTheDocument()
    expect(screen.getByTestId('prop-scale')).toBeInTheDocument()

    // A volume keyframe goes to the twin, not to the silent video half.
    await userEvent.click(screen.getByTestId('kf-toggle-volume'))
    const after = useEditorStore.getState().doc
    const twinNow = after.project.tracks[1].clips[0]
    const videoNow = after.project.tracks[0].clips[0]
    expect(twinNow.keyframes?.volume).toEqual([{ time: 2, value: 1, interpolation: 'linear' }])
    expect(videoNow.keyframes?.volume).toBeUndefined()
  })

  it('an audio clip gets the volume group and the audio shaping section', async () => {
    const asset = createMediaAsset({ kind: 'audio', duration: 20, name: 'song.mp3' })
    const clip = createClip({ id: 'clip_audio', mediaId: asset.id, start: 0, duration: 5 })
    const track = createTrack('audio', 1, { clips: [clip as Clip] })
    const doc: Doc = {
      project: { tracks: [track], id: 'p_test', name: 'test', width: 1920, height: 1080, fps: 30 },
      media: [asset],
    }
    useEditorStore.setState({ doc, selection: clip.id, selections: [clip.id], playhead: 1 })
    render(<InspectorPanel />)
    await userEvent.click(screen.getByTestId('inspector-tab-effects'))
    expect(screen.getByTestId('prop-volume')).toBeInTheDocument()
    expect(screen.getByLabelText('Clip pan')).toBeInTheDocument()
    expect(screen.getByTestId('auto-duck')).toBeInTheDocument()
    // "Reduce noise" is the denoise switch, off to start with.
    const denoise = screen.getByLabelText('Reduce noise')
    expect(denoise).toHaveAttribute('aria-checked', 'false')
    // Visual groups are absent for an audio-only clip.
    expect(screen.queryByTestId('prop-opacity')).not.toBeInTheDocument()
  })

  it('the Reduce noise switch writes setClipDenoise for the audio clip', async () => {
    const asset = createMediaAsset({ kind: 'audio', duration: 20, name: 'hissy.mp3' })
    const clip = createClip({ id: 'clip_denoise', mediaId: asset.id, start: 0, duration: 5 })
    const track = createTrack('audio', 1, { clips: [clip as Clip] })
    const doc: Doc = {
      project: { tracks: [track], id: 'p_test', name: 'test', width: 1920, height: 1080, fps: 30 },
      media: [asset],
    }
    useEditorStore.setState({ doc, selection: clip.id, selections: [clip.id], playhead: 1 })
    render(<InspectorPanel />)
    await userEvent.click(screen.getByTestId('inspector-tab-effects'))

    const before = useEditorStore.getState().past.length
    await userEvent.click(screen.getByLabelText('Reduce noise'))
    const after = useEditorStore.getState().doc.project.tracks[0].clips[0]
    expect(after.denoise).toBe(true)
    // One undo step, like every other inspector edit.
    expect(useEditorStore.getState().past.length).toBe(before + 1)

    await userEvent.click(screen.getByLabelText('Reduce noise'))
    expect(useEditorStore.getState().doc.project.tracks[0].clips[0].denoise).toBe(false)
  })

  it('hides the time-remap row on an audio clip', async () => {
    // Time remapping is picture-only: a ramp drops its link group's audio in
    // both render paths, so on an audio-only clip the row could only silence
    // the pair (a linked pair's video half reads its OWN curve, not the twin's).
    // The static Speed slider stays, since it re-times the audio element.
    const asset = createMediaAsset({ kind: 'audio', duration: 20, name: 'song.mp3' })
    const clip = createClip({ id: 'clip_audio', mediaId: asset.id, start: 0, duration: 5 })
    const track = createTrack('audio', 1, { clips: [clip as Clip] })
    const doc: Doc = {
      project: { tracks: [track], id: 'p_test', name: 'test', width: 1920, height: 1080, fps: 30 },
      media: [asset],
    }
    useEditorStore.setState({ doc, selection: clip.id, selections: [clip.id], playhead: 1 })
    render(<InspectorPanel />)
    await userEvent.click(screen.getByTestId('inspector-tab-effects'))
    expect(screen.getByTestId('speed-section')).toBeInTheDocument()
    expect(screen.getByLabelText('Clip speed')).toBeInTheDocument()
    expect(screen.queryByTestId('prop-timeScale')).not.toBeInTheDocument()
    expect(screen.queryByTestId('kf-toggle-timeScale')).not.toBeInTheDocument()

    // A video clip keeps it: the row is audio-only specific, not removed.
    cleanup()
    const videoAsset = createMediaAsset({ kind: 'video', duration: 30, name: 'demo.mp4' })
    const video = createClip({ id: 'clip_v', mediaId: videoAsset.id, start: 0, duration: 6 })
    const videoDoc: Doc = {
      project: {
        tracks: [createTrack('video', 1, { clips: [video as Clip] })],
        id: 'p_test',
        name: 'test',
        width: 1920,
        height: 1080,
        fps: 30,
      },
      media: [videoAsset],
    }
    useEditorStore.setState({ doc: videoDoc, selection: video.id, selections: [video.id] })
    render(<InspectorPanel />)
    await userEvent.click(screen.getByTestId('inspector-tab-effects'))
    expect(screen.getByTestId('prop-timeScale')).toBeInTheDocument()
  })
})
