// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { InspectorPanel } from '@/components/editor/InspectorPanel'
import { installBrowserMocks, type MockHarness } from './mocks/browser-mocks'
import { isTransientActive, useEditorStore } from '../store'
import { createClip, createMediaAsset, createTrack } from '../factories'
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

  it('switches to the Effect Controls tab and shows the property rows', async () => {
    docWithSelectedVideoClip()
    render(<InspectorPanel />)
    await userEvent.click(screen.getByTestId('inspector-tab-effects'))
    expect(screen.getByTestId('effect-controls')).toBeInTheDocument()
    expect(screen.getByTestId('prop-opacity')).toBeInTheDocument()
    expect(screen.getByTestId('prop-scale')).toBeInTheDocument()
    expect(screen.getByTestId('prop-hue')).toBeInTheDocument()
    expect(screen.getByTestId('speed-section')).toBeInTheDocument()
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
    // Visual groups are absent for an audio-only clip.
    expect(screen.queryByTestId('prop-opacity')).not.toBeInTheDocument()
  })
})
