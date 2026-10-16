// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { InspectorPanel } from '@/components/editor/InspectorPanel'
import { useEditorKeyboard } from '@/hooks/editor/useEditorKeyboard'
import { installBrowserMocks, type MockHarness } from './mocks/browser-mocks'
import { playbackRef, type PlaybackController } from '../playback/engine-ref'
import { isTransientActive, useEditorStore } from '../store'
import {
  clipFitsTrack,
  createClip,
  createMediaAsset,
  createTextClip,
  createTrack,
} from '../factories'
import { linkGroupChangesRate } from '../links'
import { EASING_PRESETS } from '../bezier'
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

  it('the speed readout follows a flat timeScale curve', async () => {
    // A flat curve OWNS the clip's rate (constantTimeScaleRate): the label and
    // the disabled thumb must show the curve's value, not the stale static
    // field. The fix falls back to clip.speed for a REAL ramp, where
    // constantTimeScaleRate is undefined (there the readout must stay finite).
    const { doc } = docWithSelectedVideoClip()
    doc.project.tracks[0].clips[0].keyframes = {
      timeScale: [{ time: 0, value: 2, interpolation: 'linear' }],
    }
    useEditorStore.setState({ doc })
    render(<InspectorPanel />)
    await userEvent.click(screen.getByTestId('inspector-tab-effects'))
    const section = screen.getByTestId('speed-section')
    // '2.00×' alone proves nothing (the time remap row shows the curve value
    // either way): the stale STATIC label must be gone too.
    expect(section).toHaveTextContent('2.00×')
    expect(section).not.toHaveTextContent('1.00×')
    expect(screen.getByRole('slider', { name: 'Clip speed' })).toHaveAttribute('aria-valuenow', '2')
  })

  it('the Speed slider on one half of a linked pair edits that half and silences the group', async () => {
    // The runtime binding the static locks cannot prove: the control edits the
    // SELECTED half (speed does not route through `audibleClipId` the way
    // gain/mute do), and the resulting static disagreement drops the pair's
    // audio in preview and export alike (`linkGroupChangesRate`).
    const asset = createMediaAsset({
      kind: 'video',
      duration: 30,
      name: 'demo.mp4',
      url: 'blob:demo',
      hasAudio: true,
    })
    const video = createClip({
      id: 'clip_v',
      mediaId: asset.id,
      start: 0,
      duration: 6,
      linkId: 'L1',
    })
    const twin = createClip({
      id: 'clip_a',
      mediaId: asset.id,
      start: 0,
      duration: 6,
      linkId: 'L1',
      audioOnly: true,
    })
    const doc: Doc = {
      project: {
        tracks: [
          createTrack('video', 1, { clips: [video] }),
          createTrack('audio', 1, { clips: [twin] }),
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

    fireEvent.keyDown(screen.getByRole('slider', { name: 'Clip speed' }), { key: 'ArrowRight' })

    const next = useEditorStore.getState().doc
    const nextVideo = next.project.tracks[0].clips[0]
    const nextTwin = next.project.tracks[1].clips[0]
    expect(nextVideo.speed).toBeCloseTo(1.05, 5)
    expect(nextTwin.speed).toBeUndefined() // the twin was never touched
    // The halves now disagree about rate, so the group contributes no audio.
    expect(linkGroupChangesRate(next, nextVideo)).toBe(true)
    expect(linkGroupChangesRate(next, nextTwin)).toBe(true)
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

  it('re-picking the displayed preset keeps the exact quad object', async () => {
    // The stored name AND quad both match the displayed preset (V2_C). Deep
    // data cannot tell the guard's no-op from a stamp that rewrites the same
    // preset values, but reference identity can: the guard returns the store's
    // own keyframe, and sanitizeKeyframes rides its easeOut array into the
    // cloned doc, while a stamp would swap in a fresh copy. This is the only
    // observable that pins the same-name protection for a full-preset quad.
    const { doc } = docWithSelectedVideoClip()
    const clip = doc.project.tracks[0].clips[0]
    clip.keyframes = {
      opacity: [
        { time: 1, value: 1, interpolation: 'easeIn', easeOut: EASING_PRESETS.easeIn },
        { time: 5, value: 0.2 },
      ],
    }
    useEditorStore.setState({ doc: structuredClone(doc), playhead: 1.1 })
    render(<InspectorPanel />)
    await userEvent.click(screen.getByTestId('inspector-tab-effects'))

    const pressed = screen.getByTestId('kf-ease-opacity-easeIn')
    expect(pressed).toHaveAttribute('aria-pressed', 'true')
    const before =
      useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.opacity?.[0]?.easeOut
    expect(before).toBeDefined()

    await userEvent.click(pressed)

    const kfs = useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.opacity
    expect(kfs?.[0].interpolation).toBe('easeIn')
    expect(kfs?.[0].easeOut).toEqual(EASING_PRESETS.easeIn)
    expect(kfs?.[0].easeOut).toBe(before)
  })

  it('shows a foreign eased quad under a linear name as eased and unnamed', async () => {
    // Hydration normalizes an unknown interpolation name to 'linear' while
    // KEEPING a valid `easeOut` (keyframes.test.ts), and every evaluator reads
    // the shape (`easeOut ?? preset`). A hand-edited file can therefore carry
    // a segment that renders eased under a linear name: the dot must read the
    // SHAPE, and no button may claim the segment is linear.
    const { doc } = docWithSelectedVideoClip()
    const clip = doc.project.tracks[0].clips[0]
    clip.keyframes = {
      opacity: [
        { time: 1, value: 1, interpolation: 'linear', easeOut: [0.2, 0.3, 0.7, 0.8] },
        { time: 5, value: 0.2 },
      ],
    }
    useEditorStore.setState({ doc: structuredClone(doc), playhead: 1.1 })
    render(<InspectorPanel />)
    await userEvent.click(screen.getByTestId('inspector-tab-effects'))

    expect(screen.getByTestId('kf-dot-opacity-0').className).toContain('border-dashed')
    expect(screen.getByTestId('kf-ease-opacity-linear')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('kf-ease-opacity-easeIn')).toHaveAttribute('aria-pressed', 'false')
  })

  it('picking Linear clears a foreign eased quad under a linear name', async () => {
    // The same-name guard exists to protect a subdivided sub-curve, but a
    // linear name describes no quad: a click on Linear must normalize the
    // foreign data instead of leaving the segment eased forever.
    const { doc } = docWithSelectedVideoClip()
    const clip = doc.project.tracks[0].clips[0]
    clip.keyframes = {
      opacity: [
        { time: 1, value: 1, interpolation: 'linear', easeOut: [0.2, 0.3, 0.7, 0.8] },
        { time: 5, value: 0.2 },
      ],
    }
    useEditorStore.setState({ doc: structuredClone(doc), playhead: 1.1 })
    render(<InspectorPanel />)
    await userEvent.click(screen.getByTestId('inspector-tab-effects'))

    await userEvent.click(screen.getByTestId('kf-ease-opacity-linear'))

    const kfs = useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.opacity
    expect(kfs?.[0].interpolation).toBe('linear')
    expect(kfs?.[0].easeOut).toBeUndefined()
    expect(screen.getByTestId('kf-dot-opacity-0').className).not.toContain('border-dashed')
  })

  it('picking an unpressed name replaces a foreign quad that shows another preset', async () => {
    // A foreign keyframe can carry a non-linear name whose quad matches a
    // DIFFERENT preset (hydration keeps both). The picker shows that quad's
    // preset pressed; the no-op guard must compare against the displayed
    // value, or clicking the unpressed name silently changes nothing.
    const { doc } = docWithSelectedVideoClip()
    const clip = doc.project.tracks[0].clips[0]
    clip.keyframes = {
      opacity: [
        { time: 1, value: 1, interpolation: 'easeIn', easeOut: EASING_PRESETS.easeOut },
        { time: 5, value: 0.2 },
      ],
    }
    useEditorStore.setState({ doc: structuredClone(doc), playhead: 1.1 })
    render(<InspectorPanel />)
    await userEvent.click(screen.getByTestId('inspector-tab-effects'))

    expect(screen.getByTestId('kf-ease-opacity-easeOut')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('kf-ease-opacity-easeIn')).toHaveAttribute('aria-pressed', 'false')

    await userEvent.click(screen.getByTestId('kf-ease-opacity-easeIn'))

    const kfs = useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.opacity
    expect(kfs?.[0].interpolation).toBe('easeIn')
    expect(kfs?.[0].easeOut).toEqual(EASING_PRESETS.easeIn)
    expect(screen.getByTestId('kf-ease-opacity-easeIn')).toHaveAttribute('aria-pressed', 'true')
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

  it('measures the picker target on the mirrored axis (the segment start rule)', async () => {
    // The picker edits the active segment's START keyframe on the row's own
    // axis. The nearest-keyframe rule lands on the same keyframe here, so this
    // case cannot tell the two targets apart; it DOES catch a read that forgot
    // the mirror: a plain-local-time read would select the 0-3 segment and
    // press its start (time 0) instead of time 3.
    const { doc } = docWithSelectedVideoClip()
    doc.project.tracks[0].clips[0].keyframes = {
      timeScale: [
        { time: 0, value: 1, interpolation: 'easeIn' },
        { time: 3, value: 2, interpolation: 'easeOut' },
        { time: 6, value: 4, interpolation: 'linear' },
      ],
    }
    const reversed = structuredClone(doc)
    reversed.project.tracks[0].clips[0].reverse = true
    useEditorStore.setState({ doc: reversed, playhead: 2 })
    render(<InspectorPanel />)
    await userEvent.click(screen.getByTestId('inspector-tab-effects'))

    // Mirrored playhead 6 - 2 = 4 starts (and is nearest) curve time 3.
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

describe('keyframe curve, handles and easing defaults', () => {
  function seed(mutate: (clip: Clip) => void, playhead: number) {
    const { doc } = docWithSelectedVideoClip()
    mutate(doc.project.tracks[0].clips[0])
    useEditorStore.setState({ doc: structuredClone(doc), playhead })
  }

  function sizeGraph(property = 'opacity') {
    const graph = screen.getByTestId(`kf-graph-${property}`)
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
  }

  it('draws an eased segment as a cubic and reports the active quad', async () => {
    // Clip duration 6: the dots sit at 16.667% / 0% and 83.333% / 20% (from
    // the bottom); an easeInOut segment's controls are its box fractions of
    // that span.
    seed((clip) => {
      clip.keyframes = {
        opacity: [
          { time: 1, value: 1, interpolation: 'easeInOut' },
          { time: 5, value: 0.2 },
        ],
      }
    }, 1.1)
    render(<InspectorPanel />)
    await userEvent.click(screen.getByTestId('inspector-tab-effects'))

    expect(screen.getByTestId('kf-seg-opacity-0')).toHaveAttribute(
      'd',
      'M 16.667,0.000 C 44.667,0.000 55.333,80.000 83.333,80.000',
    )
    expect(screen.getByTestId('kf-graph-opacity')).toHaveAttribute(
      'data-active-quad',
      '0.420,0.000,0.580,1.000',
    )
  })

  it('draws a linear segment as a line and reports the canonical linear quad', async () => {
    seed((clip) => {
      clip.keyframes = {
        opacity: [
          { time: 1, value: 1 },
          { time: 5, value: 0.2 },
        ],
      }
    }, 1.1)
    render(<InspectorPanel />)
    await userEvent.click(screen.getByTestId('inspector-tab-effects'))

    expect(screen.getByTestId('kf-seg-opacity-0')).toHaveAttribute(
      'd',
      'M 16.667,0.000 L 83.333,80.000',
    )
    expect(screen.getByTestId('kf-graph-opacity')).toHaveAttribute(
      'data-active-quad',
      '0.333,0.333,0.667,0.667',
    )
  })

  it('draws a subdivided segment from its exact sub-curve, not the preset name', async () => {
    seed((clip) => {
      clip.keyframes = {
        opacity: [
          { time: 1, value: 1, interpolation: 'linear', easeOut: [0.29, 0.5, 0.58, 1] },
          { time: 5, value: 0.2 },
        ],
      }
    }, 1.1)
    render(<InspectorPanel />)
    await userEvent.click(screen.getByTestId('inspector-tab-effects'))

    expect(screen.getByTestId('kf-seg-opacity-0')).toHaveAttribute(
      'd',
      'M 16.667,0.000 C 36.000,40.000 55.333,80.000 83.333,80.000',
    )
    expect(screen.getByTestId('kf-graph-opacity')).toHaveAttribute(
      'data-active-quad',
      '0.290,0.500,0.580,1.000',
    )
  })

  it('draws a reversed timeScale row as the mirrored shape, left to right', async () => {
    // Reversed: kf0 (time 0) sits at the RIGHT end, kf1 at the left. The drawn
    // quad is mirrorQuad(stored), one application, never a second flip.
    seed((clip) => {
      clip.reverse = true
      clip.keyframes = {
        timeScale: [
          { time: 0, value: 1, interpolation: 'easeIn' },
          { time: 6, value: 4 },
        ],
      }
    }, 2)
    render(<InspectorPanel />)
    await userEvent.click(screen.getByTestId('inspector-tab-effects'))

    expect(screen.getByTestId('kf-seg-timeScale-0')).toHaveAttribute(
      'd',
      'M 0.000,0.000 C 0.000,0.000 58.000,80.000 100.000,80.000',
    )
    expect(screen.getByTestId('kf-graph-timeScale')).toHaveAttribute(
      'data-active-quad',
      '0.000,0.000,0.580,1.000',
    )
  })

  it('takes the first pair when the playhead precedes the first keyframe', async () => {
    seed((clip) => {
      clip.keyframes = {
        opacity: [
          { time: 3, value: 0.4, interpolation: 'easeIn' },
          { time: 5, value: 0.6 },
        ],
      }
    }, 0)
    render(<InspectorPanel />)
    await userEvent.click(screen.getByTestId('inspector-tab-effects'))

    expect(screen.getByTestId('kf-graph-opacity')).toHaveAttribute(
      'data-active-quad',
      '0.420,0.000,1.000,1.000',
    )
    // The picker and the handles agree on that first pair.
    await userEvent.click(screen.getByTestId('kf-ease-opacity-easeInOut'))
    const kfs = useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.opacity
    expect(kfs?.[0].interpolation).toBe('easeInOut')
    expect(kfs?.[1].interpolation).toBe('linear')
  })

  it('omits data-active-quad and the handles when a property has one keyframe', async () => {
    seed((clip) => {
      clip.keyframes = { opacity: [{ time: 2, value: 1 }] }
    }, 2)
    render(<InspectorPanel />)
    await userEvent.click(screen.getByTestId('inspector-tab-effects'))

    expect(screen.getByTestId('kf-graph-opacity')).not.toHaveAttribute('data-active-quad')
    expect(screen.queryByTestId('kf-handle-opacity-out')).not.toBeInTheDocument()
    // No segment exists, so the picker targets the only keyframe (today's rule).
    expect(screen.getByTestId('kf-ease-opacity-linear')).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(screen.getByTestId('kf-ease-opacity-easeIn'))
    const kfs = useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.opacity
    expect(kfs?.[0].interpolation).toBe('easeIn')
  })

  it('retargets the picker to the active segment start, not the nearest keyframe', async () => {
    // The playhead sits ON the last keyframe (5). The old nearest-keyframe rule
    // would press the keyframe at 5; the aligned rule presses the segment's
    // start (1), because no segment starts at the last keyframe and editing it
    // changes nothing visible. This is the red-first case for the retarget.
    seed((clip) => {
      clip.keyframes = {
        opacity: [
          { time: 1, value: 1, interpolation: 'easeIn' },
          { time: 5, value: 0.2, interpolation: 'linear' },
        ],
      }
    }, 5)
    render(<InspectorPanel />)
    await userEvent.click(screen.getByTestId('inspector-tab-effects'))

    await userEvent.click(screen.getByTestId('kf-ease-opacity-easeInOut'))
    const kfs = useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.opacity
    expect(kfs?.[0].interpolation).toBe('easeInOut')
    expect(kfs?.[1].interpolation).toBe('linear')
    expect(screen.getByTestId('kf-ease-opacity-easeInOut')).toHaveAttribute('aria-pressed', 'true')
  })

  it('lays the handles on the active segment and drags the outgoing one in one undo step', async () => {
    seed((clip) => {
      clip.keyframes = {
        opacity: [
          { time: 1, value: 1, interpolation: 'easeInOut' },
          { time: 5, value: 0.2 },
        ],
      }
    }, 1.1)
    render(<InspectorPanel />)
    await userEvent.click(screen.getByTestId('inspector-tab-effects'))
    sizeGraph()

    // The outgoing handle starts on the quad's point 0: (0.42, 0) of the box,
    // so at 44.667% of the width, on the bottom edge.
    const handle = screen.getByTestId('kf-handle-opacity-out')
    expect(Number.parseFloat(handle.style.left)).toBeCloseTo(44.667, 3)
    expect(Number.parseFloat(handle.style.bottom)).toBeCloseTo(100, 6)
    const pastBefore = useEditorStore.getState().past.length
    fireEvent.pointerDown(handle, { bubbles: true, pointerId: 5, clientX: 89, clientY: 0 })
    // To (u, v) = (0.5, 0.625): the middle of the span, 62.5% from the first
    // keyframe's value to the second's.
    fireEvent.pointerMove(window, { pointerId: 5, clientX: 100, clientY: 20 })
    fireEvent.pointerUp(window, { pointerId: 5 })

    const kfs = useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.opacity
    // Box fractions, so the x comes back as 0.4999999999999999 (the strip
    // midpoint is 0.5 of this segment's box): compare with a tolerance.
    expect(kfs?.[0].easeOut?.[0]).toBeCloseTo(0.5, 6)
    expect(kfs?.[0].easeOut?.[1]).toBeCloseTo(0.625, 6)
    expect(kfs?.[0].easeOut?.[2]).toBe(0.58)
    expect(kfs?.[0].easeOut?.[3]).toBe(1)
    // The write normalizes the name: a hand-made shape matches no preset, so
    // the picker shows nothing pressed (the segment still renders eased).
    expect(kfs?.[0].interpolation).toBe('linear')
    expect(screen.getByTestId('kf-ease-opacity-easeInOut')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('kf-ease-opacity-easeIn')).toHaveAttribute('aria-pressed', 'false')
    expect(useEditorStore.getState().past.length).toBe(pastBefore + 1)

    useEditorStore.getState().undo()
    const undone = useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.opacity
    expect(undone?.[0].interpolation).toBe('easeInOut')
    expect(undone?.[0].easeOut).toBeUndefined()
  })

  it('nudges handles with the arrows in stored curve coordinates, clamped', async () => {
    seed((clip) => {
      clip.keyframes = {
        opacity: [
          { time: 1, value: 1, interpolation: 'easeInOut' },
          { time: 5, value: 0.2 },
        ],
      }
    }, 1.1)
    render(<InspectorPanel />)
    await userEvent.click(screen.getByTestId('inspector-tab-effects'))

    const step = 0.02
    fireEvent.keyDown(screen.getByTestId('kf-handle-opacity-out'), {
      key: 'ArrowUp',
      bubbles: true,
    })
    fireEvent.keyDown(screen.getByTestId('kf-handle-opacity-out'), {
      key: 'ArrowUp',
      bubbles: true,
    })
    fireEvent.keyDown(screen.getByTestId('kf-handle-opacity-out'), {
      key: 'ArrowLeft',
      bubbles: true,
    })
    // The incoming handle sits on y = 1 already: ArrowUp clamps there.
    fireEvent.keyDown(screen.getByTestId('kf-handle-opacity-in'), { key: 'ArrowUp', bubbles: true })
    fireEvent.keyDown(screen.getByTestId('kf-handle-opacity-in'), {
      key: 'ArrowRight',
      bubbles: true,
    })

    const kfs = useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.opacity
    expect(kfs?.[0].easeOut).toEqual([0.42 - step, 2 * step, 0.58 + step, 1])
  })

  it('writes the un-mirrored quad for a mirrored handle drag', async () => {
    // On a reversed row the stored `out` pair is DRAWN at box point 1, and the
    // pointer maps back through the same single mirrorQuad conversion: dragging
    // to (u, v) stores (1-u, 1-v).
    seed((clip) => {
      clip.reverse = true
      clip.keyframes = {
        timeScale: [
          { time: 0, value: 1, interpolation: 'easeIn' },
          { time: 6, value: 4 },
        ],
      }
    }, 2)
    render(<InspectorPanel />)
    await userEvent.click(screen.getByTestId('inspector-tab-effects'))
    sizeGraph('timeScale')

    const handle = screen.getByTestId('kf-handle-timeScale-out')
    // The drawn quad is mirrorQuad(easeIn) = [0, 0, 0.58, 1]; the out handle
    // sits at its point 1 = (0.58, 1) of the box.
    expect(Number.parseFloat(handle.style.left)).toBeCloseTo(58, 6)
    expect(Number.parseFloat(handle.style.bottom)).toBeCloseTo(20, 6)
    fireEvent.pointerDown(handle, { bubbles: true, pointerId: 5, clientX: 58, clientY: 32 })
    fireEvent.pointerMove(window, { pointerId: 5, clientX: 100, clientY: 20 })
    fireEvent.pointerUp(window, { pointerId: 5 })

    const kfs = useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.timeScale
    expect(kfs?.[0].easeOut).toEqual([0.5, 0.375, 1, 1])
    // The drawn quad follows the pointer: stored (0.5, 0.375) mirrors to the
    // box point (0.5, 0.625) the pointer landed on.
    expect(screen.getByTestId('kf-graph-timeScale')).toHaveAttribute(
      'data-active-quad',
      '0.000,0.000,0.500,0.625',
    )
  })

  it('reads the handle x in the segment box, not as a fraction of the strip', async () => {
    // The segment spans t=1..5 on a 6s clip: 16.667% to 83.333% of the strip.
    // A pointer at 30% of the strip sits at (30 - 16.667) / 66.667 = 0.2 of
    // the segment's own box, which is what the quad stores and what the draw
    // maps through. Reading u off the strip (0.3) redraws the handle 6.667pp
    // away from the pointer.
    seed((clip) => {
      clip.keyframes = {
        opacity: [
          { time: 1, value: 1, interpolation: 'easeInOut' },
          { time: 5, value: 0.2 },
        ],
      }
    }, 1.1)
    render(<InspectorPanel />)
    await userEvent.click(screen.getByTestId('inspector-tab-effects'))
    sizeGraph()

    const handle = screen.getByTestId('kf-handle-opacity-out')
    fireEvent.pointerDown(handle, { bubbles: true, pointerId: 5, clientX: 89, clientY: 0 })
    // clientX 60 = 30% of the 200px strip; clientY 12 = 70% up the 40px row.
    fireEvent.pointerMove(window, { pointerId: 5, clientX: 60, clientY: 12 })
    fireEvent.pointerUp(window, { pointerId: 5 })

    const quad =
      useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.opacity?.[0].easeOut
    expect(quad?.[0]).toBeCloseTo(0.2, 6)
    // clientY 12 -> vRow 0.7 -> v = (70 - 100) / -80 = 0.375 of the box.
    expect(quad?.[1]).toBeCloseTo(0.375, 6)
    expect(quad?.[2]).toBe(0.58)
    expect(quad?.[3]).toBe(1)
  })

  it('keeps the quad intact when a handle is pressed and released with no movement', async () => {
    // A stored hand-made quad: the out pair sits at box (0.2, 0.375), drawn at
    // 30% of the strip (16.667 + 0.2 * 66.667) and 70% from the bottom.
    seed((clip) => {
      clip.keyframes = {
        opacity: [
          { time: 1, value: 1, easeOut: [0.2, 0.375, 0.58, 1] },
          { time: 5, value: 0.2 },
        ],
      }
    }, 1.1)
    render(<InspectorPanel />)
    await userEvent.click(screen.getByTestId('inspector-tab-effects'))
    sizeGraph()

    const handle = screen.getByTestId('kf-handle-opacity-out')
    expect(Number.parseFloat(handle.style.left)).toBeCloseTo(30, 3)
    expect(Number.parseFloat(handle.style.bottom)).toBeCloseTo(70, 3)
    // Press right on the handle and move by zero: nothing may change. A
    // strip-normalized u would read 0.3 here and corrupt the stored 0.2.
    fireEvent.pointerDown(handle, { bubbles: true, pointerId: 5, clientX: 60, clientY: 12 })
    fireEvent.pointerMove(window, { pointerId: 5, clientX: 60, clientY: 12 })
    fireEvent.pointerUp(window, { pointerId: 5 })

    const quad =
      useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.opacity?.[0].easeOut
    expect(quad?.[0]).toBeCloseTo(0.2, 6)
    expect(quad?.[1]).toBeCloseTo(0.375, 6)
    expect(quad?.[2]).toBe(0.58)
    expect(quad?.[3]).toBe(1)
  })

  it('keeps the eased curve on the pair when a dot is dragged past its neighbour', async () => {
    // A segment's shape lives on the keyframe that STARTS it, so a plain time
    // sort would hand the segment to the other keyframe and draw it linear.
    // Reading the pair's curve backwards is its mirror, so the curve must come
    // back on the new start as the MIRRORED quad, named for the mirrored preset.
    seed((clip) => {
      clip.keyframes = {
        opacity: [
          { time: 1, value: 0.2, interpolation: 'easeOut' },
          { time: 5, value: 1 },
        ],
      }
    }, 1.1)
    render(<InspectorPanel />)
    await userEvent.click(screen.getByTestId('inspector-tab-effects'))
    sizeGraph()
    const seeded = structuredClone(
      useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.opacity,
    )

    const dot = screen.getByTestId('kf-dot-opacity-1')
    expect(Number.parseFloat(dot.style.left)).toBeCloseTo(83.333, 3)
    // Drag the later dot (5s of 6s = 83.333%) left past the earlier one: 20 of
    // the 200px strip is 0.6s, so the pair swaps.
    fireEvent.pointerDown(dot, { bubbles: true, pointerId: 5, clientX: 166.667, clientY: 60 })
    fireEvent.pointerMove(window, { pointerId: 5, clientX: 20, clientY: 60 })
    fireEvent.pointerUp(window, { pointerId: 5 })

    const kfs = useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.opacity
    // easeOut [0, 0, 0.58, 1] read right-to-left mirrors to easeIn's preset,
    // and the old start starts nothing now, so it keeps no shape (a stored quad
    // under a preset NAME would otherwise resolve back through the name). The
    // pointer-to-time conversion is floating point, so times compare loosely.
    expect(kfs?.length).toBe(2)
    expect(kfs?.[0].time).toBeCloseTo(0.6, 9)
    expect(kfs?.[0]).toMatchObject({ value: 1, interpolation: 'easeIn', easeOut: [0.42, 0, 1, 1] })
    expect(kfs?.[1].time).toBeCloseTo(1, 9)
    expect(kfs?.[1]).toMatchObject({ value: 0.2, interpolation: 'linear' })
    expect(kfs?.[1].easeOut).toBeUndefined()
    // The DRAWN segment is still a cubic, not the line a naive sort leaves: the
    // mirrored quad over the reversed pair (box y is drawn top-down).
    expect(screen.getByTestId('kf-seg-opacity-0')).toHaveAttribute(
      'd',
      'M 10.000,0.000 C 12.800,0.000 16.667,80.000 16.667,80.000',
    )
    expect(screen.getByTestId('kf-graph-opacity')).toHaveAttribute(
      'data-active-quad',
      '0.420,0.000,1.000,1.000',
    )
    // The picker follows the mirrored name, and the drag stays one undo step
    // that restores the original order, name and quad.
    expect(screen.getByTestId('kf-ease-opacity-easeIn')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('kf-ease-opacity-easeOut')).toHaveAttribute('aria-pressed', 'false')

    useEditorStore.getState().undo()
    const undone = useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.opacity
    expect(undone).toEqual(seeded)
  })

  it('follows the grabbed dot across a neighbour, not its array index', async () => {
    // The store re-sorts the moment a crossing frame lands (and the reorder
    // re-homes the pair's curve), so an index captured at pointerdown names
    // another keyframe afterwards: the grabbed dot then freezes while its
    // neighbour runs to the pointer, flipping the curve on every frame. The
    // gesture must follow the keyframe it grabbed, so the dot it passes keeps
    // its time, its value and its linear reading.
    seed((clip) => {
      clip.keyframes = {
        opacity: [
          { time: 1, value: 0.2, interpolation: 'easeOut' },
          { time: 5, value: 1 },
        ],
      }
    }, 1.1)
    render(<InspectorPanel />)
    await userEvent.click(screen.getByTestId('inspector-tab-effects'))
    sizeGraph()

    // Grab the LATER (value 1) dot: 5s of 6s is 83.333% of the 200px strip.
    const dot = screen.getByTestId('kf-dot-opacity-1')
    fireEvent.pointerDown(dot, { bubbles: true, pointerId: 5, clientX: 166.667, clientY: 60 })
    // Three moves, so the drag keeps going AFTER the pair swaps.
    for (const x of [20, 10, 8]) {
      fireEvent.pointerMove(window, { pointerId: 5, clientX: x, clientY: 60 })
    }
    fireEvent.pointerUp(window, { pointerId: 5 })

    const kfs = useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.opacity
    // 8px of 200px is 4% of 6s, so the grabbed dot lands at 0.24s; the dot it
    // passed stays at 1s. easeOut [0, 0, 0.58, 1] read backwards is easeIn.
    expect(kfs?.length).toBe(2)
    expect(kfs?.[0].time).toBeCloseTo(0.24, 9)
    expect(kfs?.[0]).toMatchObject({ value: 1, interpolation: 'easeIn', easeOut: [0.42, 0, 1, 1] })
    expect(kfs?.[1].time).toBeCloseTo(1, 9)
    expect(kfs?.[1]).toMatchObject({ value: 0.2, interpolation: 'linear' })
    expect(kfs?.[1].easeOut).toBeUndefined()
  })

  it('shows the picker on an unanimated property and writes the property default', async () => {
    docWithSelectedVideoClip()
    render(<InspectorPanel />)
    await userEvent.click(screen.getByTestId('inspector-tab-effects'))

    // The control was absent entirely before this change (the whole graph hid
    // behind `animated`), so presence, label and effect are all new.
    const row = screen.getByTestId('prop-opacity')
    expect(within(row).getByText('Default easing')).toBeInTheDocument()
    expect(screen.getByTestId('kf-ease-opacity')).toHaveAttribute(
      'aria-label',
      'opacity default easing',
    )
    expect(screen.getByTestId('kf-ease-opacity-linear')).toHaveAttribute('aria-pressed', 'true')

    const pastBefore = useEditorStore.getState().past.length
    await userEvent.click(screen.getByTestId('kf-ease-opacity-easeIn'))
    expect(useEditorStore.getState().doc.project.keyframeDefaults).toEqual({ opacity: 'easeIn' })
    expect(screen.getByTestId('kf-ease-opacity-easeIn')).toHaveAttribute('aria-pressed', 'true')
    expect(useEditorStore.getState().past.length).toBe(pastBefore + 1)

    // Pressing the already-pressed name is a no-op (no history entry).
    await userEvent.click(screen.getByTestId('kf-ease-opacity-easeIn'))
    expect(useEditorStore.getState().past.length).toBe(pastBefore + 1)

    // Linear clears the entry (absent reads as linear).
    await userEvent.click(screen.getByTestId('kf-ease-opacity-linear'))
    expect(useEditorStore.getState().doc.project.keyframeDefaults).toBeUndefined()
  })

  it('seeds a keyframe with the default name and its exact quad', async () => {
    seed(() => {}, 2)
    useEditorStore.setState((s) => ({
      doc: { ...s.doc, project: { ...s.doc.project, keyframeDefaults: { opacity: 'easeIn' } } },
    }))
    render(<InspectorPanel />)
    await userEvent.click(screen.getByTestId('inspector-tab-effects'))

    await userEvent.click(screen.getByTestId('kf-toggle-opacity'))
    const kfs = useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.opacity
    expect(kfs).toEqual([{ time: 2, value: 1, interpolation: 'easeIn', easeOut: [0.42, 0, 1, 1] }])
  })

  it('stamps the default on a slider-created keyframe of an animated property', async () => {
    // Start below the property's max: a keyboard step at the bound is a no-op
    // and would commit nothing (the keyframe write is what is under test).
    seed((clip) => {
      clip.keyframes = { opacity: [{ time: 1, value: 0.5 }] }
    }, 2)
    useEditorStore.setState((s) => ({
      doc: { ...s.doc, project: { ...s.doc.project, keyframeDefaults: { opacity: 'easeOut' } } },
    }))
    render(<InspectorPanel />)
    await userEvent.click(screen.getByTestId('inspector-tab-effects'))

    // A keyboard step on the slider commits immediately (Radix semantics).
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Opacity value' }), {
      key: 'ArrowRight',
    })
    const kfs = useEditorStore.getState().doc.project.tracks[0].clips[0].keyframes?.opacity
    const created = kfs?.find((k) => Math.abs(k.time - 2) < 1e-6)
    expect(created?.time).toBeCloseTo(2, 6)
    expect(created).toMatchObject({ interpolation: 'easeOut', easeOut: [0, 0, 0.58, 1] })
    // The pre-existing keyframe keeps its shape (sanitize normalizes the
    // absent name to linear, it does not take the new default).
    const untouched = kfs?.find((k) => Math.abs(k.time - 1) < 1e-6)
    expect(untouched?.interpolation).toBe('linear')
    expect(untouched?.easeOut).toBeUndefined()
  })

  it('keeps a split boundary on the crossing sub-curve, never the property default', async () => {
    const { doc } = docWithSelectedVideoClip()
    const clipId = doc.project.tracks[0].clips[0].id
    const clip = doc.project.tracks[0].clips[0]
    clip.keyframes = {
      timeScale: [
        { time: 0, value: 1, interpolation: 'easeInOut' },
        { time: 6, value: 3 },
      ],
    }
    doc.project.keyframeDefaults = { timeScale: 'easeIn' }
    useEditorStore.setState({ doc: structuredClone(doc), playhead: 3 })

    useEditorStore.getState().apply({ type: 'splitClip', clipId, atTime: 3 })
    const left = useEditorStore.getState().doc.project.tracks[0].clips.find((c) => c.id === clipId)
    const kfs = left?.keyframes?.timeScale ?? []
    const boundary = kfs[kfs.length - 1]
    expect(boundary?.time).toBeCloseTo(3, 6)
    // The boundary keeps the subdivided shape of the crossing segment, not the
    // stored default: defaults stamp NEW keyframes only.
    expect(boundary?.easeOut).toBeDefined()
    expect(boundary?.easeOut).not.toEqual(EASING_PRESETS.easeIn)
  })
})

describe('InspectorPanel LUT import', () => {
  const SHAPER = ['LUT_1D_SIZE 2', '0 0 0', '1 1 1'].join('\n')

  it('loads a .cube into the library and assigns it in ONE undo step', async () => {
    docWithSelectedVideoClip()
    render(<InspectorPanel />)
    expect(screen.getByTestId('lut-select')).toBeInTheDocument()

    const file = new File([SHAPER], 'My Grade.cube', { type: 'text/plain' })
    fireEvent.change(screen.getByTestId('lut-file'), { target: { files: [file] } })

    await waitFor(() => {
      expect(useEditorStore.getState().doc.project.luts).toHaveLength(1)
    })
    const state = useEditorStore.getState()
    const lut = state.doc.project.luts![0]
    expect(lut.name).toBe('My Grade')
    expect(lut.kind).toBe('1d')
    expect(state.doc.project.tracks[0].clips[0].lutId).toBe(lut.id)
    // Import and assignment are one batch: one undo entry, and one Ctrl+Z
    // removes the clip's grade AND the library entry together.
    expect(state.past).toHaveLength(1)
    state.undo()
    expect(useEditorStore.getState().doc.project.luts).toBeUndefined()
    expect(useEditorStore.getState().doc.project.tracks[0].clips[0].lutId).toBeUndefined()
  })

  it('hides the LUT row for a text clip (a 3D pass needs a decoded frame)', () => {
    const track = createTrack('text', 1, {
      id: 't-text',
      clips: [createTextClip({ id: 'clip_txt', start: 0, duration: 4 })],
    })
    const asset = createMediaAsset({ kind: 'video', duration: 30, name: 'demo.mp4' })
    useEditorStore.setState({
      doc: {
        project: { tracks: [track], id: 'p', name: 't', width: 1920, height: 1080, fps: 30 },
        media: [asset],
      },
      selection: 'clip_txt',
      selections: ['clip_txt'],
    })
    render(<InspectorPanel />)
    expect(screen.getByRole('slider', { name: 'Temperature' })).toBeInTheDocument()
    expect(screen.queryByTestId('lut-select')).not.toBeInTheDocument()
  })

  it('writes nothing when the .cube cannot be read (the refusal is a toast)', async () => {
    docWithSelectedVideoClip()
    render(<InspectorPanel />)

    const file = new File(['not a cube at all'], 'broken.cube', { type: 'text/plain' })
    fireEvent.change(screen.getByTestId('lut-file'), { target: { files: [file] } })

    // The parse rejects (proven in lut.test.ts) and the Inspector surfaces it
    // through `showError`; that the whole batch is refused is what matters here:
    // no library entry, no clip reference, no undo entry.
    await waitFor(() => {
      expect(useEditorStore.getState().doc.project.luts).toBeUndefined()
    })
    expect(useEditorStore.getState().doc.project.tracks[0].clips[0].lutId).toBeUndefined()
    expect(useEditorStore.getState().past).toHaveLength(0)
  })
})

describe('InspectorPanel transition picker', () => {
  function docWithTransition(): { clipId: string } {
    const asset = createMediaAsset({ kind: 'video', duration: 30, name: 'demo.mp4' })
    // The section (and picker) renders only with a following clip and an
    // existing transitionOut: nextClip gates the section, transitionOut
    // gates the picker.
    const a = createClip({
      id: 'clip_ta',
      mediaId: asset.id,
      start: 0,
      duration: 6,
      transitionOut: { type: 'crossfade', duration: 0.5 },
    })
    const b = createClip({ id: 'clip_tb', mediaId: asset.id, start: 5.5, duration: 6 })
    const track = createTrack('video', 1, { clips: [a as Clip, b as Clip] })
    const doc: Doc = {
      project: { tracks: [track], id: 'p_test', name: 'test', width: 1920, height: 1080, fps: 30 },
      media: [asset],
    }
    useEditorStore.setState({ doc, selection: a.id, selections: [a.id], playhead: 1 })
    return { clipId: a.id }
  }

  // NOTE: jsdom never mounts Radix Select portals (verified: trigger goes
  // aria-expanded with zero listbox/option nodes via pointer, keyboard,
  // and pumped rAF alike), so the menu cannot be driven here. Presence
  // and gating are locked here; the dispatch wiring is locked by a
  // static-source assertion in compositing-ui.test.ts, and the real
  // open-and-choose interaction is covered by manual UI proof.
  it('renders the picker and a checked switch when a transition exists', () => {
    docWithTransition()
    render(<InspectorPanel />)
    expect(screen.getByRole('combobox', { name: 'Transition type' })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Enable transition' })).toBeChecked()
  })

  it('hides the picker without an existing transition', () => {
    const asset = createMediaAsset({ kind: 'video', duration: 30, name: 'demo.mp4' })
    const a = createClip({ id: 'clip_ta', mediaId: asset.id, start: 0, duration: 6 })
    const b = createClip({ id: 'clip_tb', mediaId: asset.id, start: 6, duration: 6 })
    const track = createTrack('video', 1, { clips: [a as Clip, b as Clip] })
    const doc: Doc = {
      project: { tracks: [track], id: 'p_test', name: 'test', width: 1920, height: 1080, fps: 30 },
      media: [asset],
    }
    useEditorStore.setState({ doc, selection: a.id, selections: [a.id], playhead: 1 })
    render(<InspectorPanel />)
    expect(screen.getByRole('switch', { name: 'Enable transition' })).not.toBeChecked()
    expect(screen.queryByRole('combobox', { name: 'Transition type' })).not.toBeInTheDocument()
  })

  function docWithSpatialTransition(transitionOut: {
    type: 'wipe' | 'slide' | 'push'
    duration: number
    edge?: 'hard' | 'feathered'
  }): void {
    const asset = createMediaAsset({ kind: 'video', duration: 30, name: 'demo.mp4' })
    const a = createClip({
      id: 'clip_ta',
      mediaId: asset.id,
      start: 0,
      duration: 6,
      transitionOut,
    })
    const b = createClip({ id: 'clip_tb', mediaId: asset.id, start: 5.5, duration: 6 })
    const track = createTrack('video', 1, { clips: [a as Clip, b as Clip] })
    const doc: Doc = {
      project: { tracks: [track], id: 'p_test', name: 'test', width: 1920, height: 1080, fps: 30 },
      media: [asset],
    }
    useEditorStore.setState({ doc, selection: a.id, selections: [a.id], playhead: 1 })
  }

  it('shows direction, edge and feather controls for a feathered wipe', () => {
    docWithSpatialTransition({ type: 'wipe', duration: 0.5, edge: 'feathered' })
    render(<InspectorPanel />)
    expect(screen.getByRole('combobox', { name: 'Transition direction' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Wipe edge' })).toBeInTheDocument()
    expect(screen.getByRole('slider', { name: 'Wipe feather width' })).toBeInTheDocument()
  })

  it('hides the feather slider for a hard-edge wipe', () => {
    docWithSpatialTransition({ type: 'wipe', duration: 0.5, edge: 'hard' })
    render(<InspectorPanel />)
    expect(screen.getByRole('combobox', { name: 'Transition direction' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Wipe edge' })).toBeInTheDocument()
    expect(screen.queryByRole('slider', { name: 'Wipe feather width' })).not.toBeInTheDocument()
  })

  it('hides all spatial controls for a crossfade', () => {
    docWithTransition()
    render(<InspectorPanel />)
    expect(screen.queryByRole('combobox', { name: 'Transition direction' })).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Wipe edge' })).not.toBeInTheDocument()
    expect(screen.queryByRole('slider', { name: 'Wipe feather width' })).not.toBeInTheDocument()
  })
})
