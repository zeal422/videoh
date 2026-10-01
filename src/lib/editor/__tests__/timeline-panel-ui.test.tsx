// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { TimelinePanel, TRACK_HEADER_WIDTH } from '@/components/editor/timeline/TimelinePanel'
import { Ruler } from '@/components/editor/timeline/Ruler'
import { applyCommands } from '@/lib/editor/commands'
import * as commandsModule from '@/lib/editor/commands'
import { installBrowserMocks, type MockHarness } from './mocks/browser-mocks'
import { editorStore, useEditorStore } from '../store'
import { PPS_DEFAULT } from '@/lib/editor/constants'
import { createClip, createDoc, createMediaAsset, createTrack, sourceTimeAt } from '../factories'
import type { Clip, Doc, MediaAsset, Track } from '../types'

/**
 * First React-render tests in the gate (jsdom + Testing Library): the timeline
 * renders its lanes from the store, and the drag commit path (transient
 * gesture begin/apply/commit) leaves one undo entry with the moved clip. This
 * closes part of the "green gate, broken UI" hole; the full UI remains covered
 * by the E2E battery.
 */

let h: MockHarness

beforeEach(() => {
  h = installBrowserMocks()
  document.body.innerHTML = ''
  // A fresh doc per test: the store is module-global, tests must not share state.
  useEditorStore.setState(useEditorStore.getInitialState())
})

afterEach(() => {
  cleanup()
  h.uninstall()
})

function docWithClips(): { doc: Doc; asset: MediaAsset; trackId: string } {
  const asset = createMediaAsset({ kind: 'video', duration: 30, name: 'demo.mp4' })
  const track = createTrack('video', 1)
  return {
    doc: {
      project: { tracks: [track], id: 'p_test', name: 'test', width: 1920, height: 1080, fps: 30 },
      media: [asset],
    },
    asset,
    trackId: track.id,
  }
}

describe('TimelinePanel render', () => {
  it('renders one lane per track with its header', () => {
    const { doc, trackId } = docWithClips()
    useEditorStore.setState({ doc })
    render(<TimelinePanel />)
    expect(screen.getByTestId(`track-header-${trackId}`)).toBeInTheDocument()
    expect(document.querySelectorAll('[data-lane-id]').length).toBe(1)
  })

  it('renders a clip inside its lane and an aria label with its span', () => {
    const { doc, asset, trackId } = docWithClips()
    doc.project.tracks[0].clips = [
      {
        id: 'clip_x',
        trackId,
        mediaId: asset.id,
        start: 1,
        duration: 5,
        inPoint: 0,
      } as Clip,
    ]
    useEditorStore.setState({ doc })
    render(<TimelinePanel />)
    const clipEl = screen.getByTestId('clip-clip_x')
    expect(clipEl).toBeInTheDocument()
    expect(clipEl.getAttribute('aria-label')).toContain('from 1.00 to 6.00 seconds')
  })

  it('an empty doc renders zero lanes only after tracks exist (starter lanes render)', () => {
    useEditorStore.setState({ doc: createDoc() })
    render(<TimelinePanel />)
    // createDoc ships starter lanes; they must be visible without any clips.
    expect(document.querySelectorAll('[data-lane-id]').length).toBeGreaterThan(0)
  })
})

describe('speed badge gating', () => {
  function clipDoc(over: Partial<Clip>) {
    const asset = createMediaAsset({ kind: 'video', duration: 30, name: 'demo.mp4' })
    const track = createTrack('video', 1)
    track.clips = [createClip({ id: 'clip_s', mediaId: asset.id, start: 0, duration: 4, ...over })]
    const doc: Doc = {
      project: { tracks: [track], id: 'p_test', name: 'test', width: 1920, height: 1080, fps: 30 },
      media: [asset],
    }
    return doc
  }

  it('a 2x clip shows the speed badge, a 1x clip does not', () => {
    useEditorStore.setState({ doc: clipDoc({ speed: 2 }) })
    const { unmount } = render(<TimelinePanel />)
    expect(screen.getByTestId('clip-speed-badge')).toBeInTheDocument()
    unmount()
    useEditorStore.setState({ doc: clipDoc({}) })
    render(<TimelinePanel />)
    expect(screen.queryByTestId('clip-speed-badge')).not.toBeInTheDocument()
  })

  it('a clip with a timeScale curve hides the badge even with a stale static speed', () => {
    // The curve, not the static rate, decides a ramped clip's speed, so the
    // badge would advertise a rate that is not in effect.
    useEditorStore.setState({
      doc: clipDoc({
        speed: 2,
        keyframes: { timeScale: [{ time: 0, value: 1 }] },
      }),
    })
    render(<TimelinePanel />)
    expect(screen.queryByTestId('clip-speed-badge')).not.toBeInTheDocument()
  })
})

describe('alt-drag rate stretch', () => {
  const RULER_HEIGHT = 28

  it('applies neither half of the pair when the trim is rejected', () => {
    // A relink to shorter media can leave LESS than the minimum window
    // readable (0.01s here, against a 0.025s floor), so no span clamp can make
    // the pair legal. The speed half used to land alone with no feedback:
    // `applyTransient` swallows command errors (slider previews rely on it),
    // so the gesture's catch was unreachable and the drag silently slowed the
    // clip and cut its duration. Rejected pairs must still change nothing.
    const asset = createMediaAsset({ kind: 'video', duration: 3.5, name: 'short.mp4' })
    const track = createTrack('video', 1)
    const doc: Doc = {
      project: { tracks: [track], id: 'p_test', name: 'test', width: 1920, height: 1080, fps: 30 },
      media: [asset],
    }
    doc.project.tracks[0].clips = [
      createClip({ id: 'clip_x', mediaId: asset.id, start: 0, duration: 3, inPoint: 3.49 }),
    ]
    useEditorStore.setState({ doc })
    render(<TimelinePanel />)

    // +80px at 80px/s re-times the 3s span to 4s; the window cannot fit the
    // 0.01s the 3.5s asset has left, so the pair is rejected.
    fireEvent.pointerDown(screen.getByLabelText('Trim clip end'), {
      button: 0,
      altKey: true,
      pointerId: 3,
      clientX: 240,
      clientY: RULER_HEIGHT + 10,
    })
    fireEvent.pointerMove(window, { pointerId: 3, clientX: 320, clientY: RULER_HEIGHT + 10 })
    fireEvent.pointerUp(window, { pointerId: 3 })

    const clip = useEditorStore.getState().doc.project.tracks[0].clips[0]
    expect(clip.speed ?? 1).toBe(1) // the speed half never landed
    expect(clip.duration).toBe(3) // and the duration was never re-derived
    expect(useEditorStore.getState().past).toHaveLength(0)
  })

  it('a well-fitting alt-drag pays NO validation clone (the !fits gate stays shut)', () => {
    // Locks the gate structurally: hoisting the validation out of the `!s.fits`
    // branch (or dropping `fits` entirely) would clone the whole document on
    // EVERY pointermove of EVERY rate stretch, and only this spy notices. The
    // outcome-only tests below stay green through such a regression.
    vi.spyOn(commandsModule, 'applyCommands')
    const asset = createMediaAsset({ kind: 'video', duration: 30, name: 'demo.mp4' })
    const track = createTrack('video', 1)
    const doc: Doc = {
      project: { tracks: [track], id: 'p_test', name: 'test', width: 1920, height: 1080, fps: 30 },
      media: [asset],
    }
    doc.project.tracks[0].clips = [
      createClip({ id: 'clip_x', mediaId: asset.id, start: 0, duration: 3, inPoint: 0 }),
    ]
    useEditorStore.setState({ doc })
    render(<TimelinePanel />)

    fireEvent.pointerDown(screen.getByLabelText('Trim clip end'), {
      button: 0,
      altKey: true,
      pointerId: 3,
      clientX: 240,
      clientY: RULER_HEIGHT + 10,
    })
    fireEvent.pointerMove(window, { pointerId: 3, clientX: 320, clientY: RULER_HEIGHT + 10 })
    fireEvent.pointerUp(window, { pointerId: 3 })

    const clip = useEditorStore.getState().doc.project.tracks[0].clips[0]
    expect(clip.speed).toBeCloseTo(3 / 4, 10)
    expect(commandsModule.applyCommands).not.toHaveBeenCalled()
  })

  it('the !fits corner validates ONCE per drag, not per move', () => {
    // The corner's outcome cannot change mid-drag (the clamped span is
    // pointer-independent), so the second move must not pay another
    // whole-document clone. Used to be one `applyCommands` per pointermove.
    vi.spyOn(commandsModule, 'applyCommands')
    const asset = createMediaAsset({ kind: 'video', duration: 3.5, name: 'short.mp4' })
    const track = createTrack('video', 1)
    const doc: Doc = {
      project: { tracks: [track], id: 'p_test', name: 'test', width: 1920, height: 1080, fps: 30 },
      media: [asset],
    }
    doc.project.tracks[0].clips = [
      createClip({ id: 'clip_x', mediaId: asset.id, start: 0, duration: 3, inPoint: 3.49 }),
    ]
    useEditorStore.setState({ doc })
    render(<TimelinePanel />)

    fireEvent.pointerDown(screen.getByLabelText('Trim clip end'), {
      button: 0,
      altKey: true,
      pointerId: 3,
      clientX: 240,
      clientY: RULER_HEIGHT + 10,
    })
    fireEvent.pointerMove(window, { pointerId: 3, clientX: 300, clientY: RULER_HEIGHT + 10 })
    fireEvent.pointerMove(window, { pointerId: 3, clientX: 320, clientY: RULER_HEIGHT + 10 })
    fireEvent.pointerUp(window, { pointerId: 3 })

    expect(commandsModule.applyCommands).toHaveBeenCalledTimes(1)
    // The pair still never lands: the rejection applies neither half.
    const clip = useEditorStore.getState().doc.project.tracks[0].clips[0]
    expect(clip.speed ?? 1).toBe(1)
    expect(clip.duration).toBe(3)
  })

  it('recovers a readable-but-over-consuming clip instead of doing nothing', () => {
    // The same relink fixture one step less extreme: 1.5s of source is still
    // readable, so the decision clamps the span to the asset's tail and the
    // drag changes the pair instead of toasting from every pointer position.
    const asset = createMediaAsset({ kind: 'video', duration: 3.5, name: 'short.mp4' })
    const track = createTrack('video', 1)
    const doc: Doc = {
      project: { tracks: [track], id: 'p_test', name: 'test', width: 1920, height: 1080, fps: 30 },
      media: [asset],
    }
    doc.project.tracks[0].clips = [
      createClip({ id: 'clip_x', mediaId: asset.id, start: 0, duration: 3, inPoint: 2 }),
    ]
    useEditorStore.setState({ doc })
    render(<TimelinePanel />)

    fireEvent.pointerDown(screen.getByLabelText('Trim clip end'), {
      button: 0,
      altKey: true,
      pointerId: 3,
      clientX: 240,
      clientY: RULER_HEIGHT + 10,
    })
    fireEvent.pointerMove(window, { pointerId: 3, clientX: 320, clientY: RULER_HEIGHT + 10 })
    fireEvent.pointerUp(window, { pointerId: 3 })

    const clip = useEditorStore.getState().doc.project.tracks[0].clips[0]
    // The 4s drag re-times the readable 1.5s of source (asset 3.5 from inPoint 2).
    expect(clip.speed).toBeCloseTo(1.5 / 4, 10)
    expect(clip.duration).toBeCloseTo(4, 10)
    expect(clip.inPoint).toBe(2)
    expect(clip.inPoint + clip.duration * (clip.speed ?? 1)).toBeLessThanOrEqual(3.5 + 1e-6)
  })
})

describe('reversed clip edges', () => {
  const RULER_HEIGHT = 28

  /** A reversed clip (source 0..4 of a 10s asset), end edge at 4s x 80px/s. */
  function reversedDoc(over: Partial<Clip> = {}) {
    const asset = createMediaAsset({ kind: 'video', duration: 10, name: 'demo.mp4' })
    const track = createTrack('video', 1)
    track.clips = [
      createClip({
        id: 'clip_r',
        mediaId: asset.id,
        start: 0,
        duration: 4,
        inPoint: 0,
        reverse: true,
        ...over,
      }),
    ]
    const doc: Doc = {
      project: { tracks: [track], id: 'p_test', name: 'test', width: 1920, height: 1080, fps: 30 },
      media: [asset],
    }
    useEditorStore.setState({ doc })
    return doc
  }

  it('the tail edge cuts source off the low end instead of sliding the picture', () => {
    // The wiring end to end (ClipView's dispatch through trimClip): a reversed
    // clip's tail shows the span's LOW source end, so the tail move has to hold
    // the high end the head displays. Pinning inPoint instead slid every kept
    // frame up the source by the trimmed second, since the reversed read maps
    // local time to `duration - local`.
    reversedDoc()
    render(<TimelinePanel />)
    const before = useEditorStore.getState().doc.project.tracks[0].clips[0]

    fireEvent.pointerDown(screen.getByLabelText('Trim clip end'), {
      button: 0,
      pointerId: 5,
      clientX: 4 * PPS_DEFAULT,
      clientY: RULER_HEIGHT + 10,
    })
    fireEvent.pointerMove(window, {
      pointerId: 5,
      clientX: 3 * PPS_DEFAULT,
      clientY: RULER_HEIGHT + 10,
    })
    fireEvent.pointerUp(window, { pointerId: 5 })

    const after = useEditorStore.getState().doc.project.tracks[0].clips[0]
    expect(after.duration).toBeCloseTo(3, 6)
    expect(after.inPoint).toBeCloseTo(1, 6) // the low anchor moved up by the cut
    for (const local of [0, 0.5, 1, 1.5, 2, 3]) {
      expect(sourceTimeAt(after, local)).toBeCloseTo(sourceTimeAt(before, local), 6)
    }
  })

  it('the head edge extends into the source above the span', () => {
    // The mirrored head room. This clip sits at 2s with inPoint 0, so the head
    // it shows (source 2) has the asset's remaining 8s above it: pulling the head
    // 1s left must extend the clip to 3s. The forward formula floored the pull at
    // inPoint, which is 0 here, and refused the move outright.
    reversedDoc({ start: 2, duration: 2 })
    render(<TimelinePanel />)
    const before = useEditorStore.getState().doc.project.tracks[0].clips[0]

    fireEvent.pointerDown(screen.getByLabelText('Trim clip start'), {
      button: 0,
      pointerId: 6,
      clientX: 2 * PPS_DEFAULT,
      clientY: RULER_HEIGHT + 10,
    })
    fireEvent.pointerMove(window, {
      pointerId: 6,
      clientX: 1 * PPS_DEFAULT,
      clientY: RULER_HEIGHT + 10,
    })
    fireEvent.pointerUp(window, { pointerId: 6 })

    const after = useEditorStore.getState().doc.project.tracks[0].clips[0]
    expect(after.start).toBeCloseTo(1, 6)
    expect(after.duration).toBeCloseTo(3, 6)
    // The old locals shifted one slot later, and the new first second reads the
    // source the extension revealed (one step further up the span's high end).
    for (const local of [0, 0.5, 1, 2]) {
      expect(sourceTimeAt(after, local + 1)).toBeCloseTo(sourceTimeAt(before, local), 6)
    }
    expect(sourceTimeAt(after, 0)).toBeCloseTo(3, 6)
  })
})

describe('marquee selection (box drag on empty lane space)', () => {
  /** jsdom reports zero-size rects, so the content origin is (0, 0) and lane
   *  coordinates map to client coordinates by adding the header/ruler offsets. */
  const RULER_HEIGHT = 28
  const LANE_Y = 10

  function twoClipDoc() {
    const asset = createMediaAsset({ kind: 'video', duration: 30, name: 'demo.mp4' })
    const track = createTrack('video', 1)
    const a = createClip({ id: 'clip_a', mediaId: asset.id, start: 0, duration: 1, inPoint: 0 })
    const b = createClip({ id: 'clip_b', mediaId: asset.id, start: 2, duration: 1, inPoint: 0 })
    track.clips = [a, b]
    const doc: Doc = {
      project: { tracks: [track], id: 'p_test', name: 'test', width: 1920, height: 1080, fps: 30 },
      media: [asset],
    }
    return { doc, a, b }
  }

  function laneEl(): Element {
    const el = document.querySelector('[data-lane-id]')
    if (!el) throw new Error('lane not rendered')
    return el
  }

  function clientX(laneX: number) {
    return TRACK_HEADER_WIDTH + laneX
  }

  type DragOpts = { shiftKey?: boolean; ctrlKey?: boolean; laneY?: number; pointerId?: number }

  function beginDrag(fromLaneX: number, opts: DragOpts = {}) {
    const { laneY = LANE_Y, ...mods } = opts
    fireEvent.pointerDown(laneEl(), {
      button: 0,
      clientX: clientX(fromLaneX),
      clientY: RULER_HEIGHT + laneY,
      ...mods,
    })
  }

  function moveDrag(toLaneX: number, opts: DragOpts = {}) {
    const { laneY = LANE_Y, ...mods } = opts
    fireEvent.pointerMove(window, {
      clientX: clientX(toLaneX),
      clientY: RULER_HEIGHT + laneY,
      ...mods,
    })
  }

  function releaseDrag(toLaneX: number, opts: DragOpts = {}) {
    const { laneY = LANE_Y, ...mods } = opts
    fireEvent.pointerUp(window, {
      clientX: clientX(toLaneX),
      clientY: RULER_HEIGHT + laneY,
      ...mods,
    })
  }

  it('a drag across one clip selects exactly that clip (replace)', () => {
    const { doc, a, b } = twoClipDoc()
    useEditorStore.setState({ doc })
    useEditorStore.getState().select(a.id)
    render(<TimelinePanel />)

    beginDrag(100)
    moveDrag(250)
    releaseDrag(250)

    expect(useEditorStore.getState().selections).toEqual([b.id])
  })

  it('a drag over the video half of a linked pair selects both halves', () => {
    const asset = createMediaAsset({ kind: 'video', duration: 30, name: 'demo.mp4' })
    const videoTrack = createTrack('video', 1)
    const audioTrack = createTrack('audio', 1)
    const video = createClip({
      id: 'clip_v',
      linkId: 'link_1',
      mediaId: asset.id,
      start: 0,
      duration: 2,
      inPoint: 0,
    })
    const twin = createClip({
      id: 'clip_a',
      linkId: 'link_1',
      mediaId: asset.id,
      start: 0,
      duration: 2,
      inPoint: 0,
      audioOnly: true,
    })
    videoTrack.clips = [video]
    audioTrack.clips = [twin]
    const doc: Doc = {
      project: {
        tracks: [videoTrack, audioTrack],
        id: 'p_test',
        name: 'test',
        width: 1920,
        height: 1080,
        fps: 30,
      },
      media: [asset],
    }
    useEditorStore.setState({ doc })
    render(<TimelinePanel />)

    // A rect inside the video clip's own span (0..2s at 80 pps).
    beginDrag(40)
    moveDrag(120)
    releaseDrag(120)

    expect(useEditorStore.getState().selections).toEqual([video.id, twin.id])
  })

  it('shift-drag adds the box contents to the selection', () => {
    const { doc, a, b } = twoClipDoc()
    useEditorStore.setState({ doc })
    useEditorStore.getState().select(a.id)
    render(<TimelinePanel />)

    beginDrag(150, { shiftKey: true })
    moveDrag(250, { shiftKey: true })
    releaseDrag(250, { shiftKey: true })

    expect(useEditorStore.getState().selections).toEqual([a.id, b.id])
  })

  it('ctrl-drag toggles an already-selected clip out of the selection', () => {
    const { doc, a, b } = twoClipDoc()
    useEditorStore.setState({ doc })
    useEditorStore.getState().setSelections([a.id, b.id])
    render(<TimelinePanel />)

    beginDrag(150, { ctrlKey: true })
    moveDrag(250, { ctrlKey: true })
    releaseDrag(250, { ctrlKey: true })

    expect(useEditorStore.getState().selections).toEqual([a.id])
  })

  it('a drag that hits no clip clears the selection (replace)', () => {
    const { doc, a } = twoClipDoc()
    useEditorStore.setState({ doc })
    useEditorStore.getState().select(a.id)
    render(<TimelinePanel />)

    beginDrag(500)
    moveDrag(600)
    releaseDrag(600)

    expect(useEditorStore.getState().selections).toEqual([])
  })

  it('a drag in the empty strip below the rows selects nothing and still clears', () => {
    const { doc, a } = twoClipDoc()
    useEditorStore.setState({ doc })
    useEditorStore.getState().select(a.id)
    render(<TimelinePanel />)

    // The single video row spans y 0..64; 200 is the empty strip below it, the
    // area a pointer lands on when the lanes leave room at the bottom.
    beginDrag(100, { laneY: 200 })
    moveDrag(250, { laneY: 200 })
    expect(screen.getByTestId('marquee-rect')).toBeInTheDocument()
    releaseDrag(250, { laneY: 200 })

    expect(useEditorStore.getState().selections).toEqual([])
    expect(screen.queryByTestId('marquee-rect')).toBeNull()
  })

  it('a click on empty space still deselects; a modifier click does not', () => {
    const { doc, a } = twoClipDoc()
    useEditorStore.setState({ doc })
    render(<TimelinePanel />)

    useEditorStore.getState().select(a.id)
    beginDrag(300)
    releaseDrag(300)
    expect(useEditorStore.getState().selections).toEqual([])

    useEditorStore.getState().select(a.id)
    beginDrag(300, { shiftKey: true })
    releaseDrag(300, { shiftKey: true })
    expect(useEditorStore.getState().selections).toEqual([a.id])
  })

  it('draws the marquee rect during the drag and removes it on release', () => {
    const { doc } = twoClipDoc()
    useEditorStore.setState({ doc })
    render(<TimelinePanel />)

    beginDrag(100)
    expect(screen.queryByTestId('marquee-rect')).toBeNull()
    moveDrag(200)
    expect(screen.getByTestId('marquee-rect')).toBeInTheDocument()
    releaseDrag(200)
    expect(screen.queryByTestId('marquee-rect')).toBeNull()
  })

  it('a second drag closes a stale gesture instead of being swallowed', () => {
    const { doc, b } = twoClipDoc()
    useEditorStore.setState({ doc })
    render(<TimelinePanel />)

    // First drag never releases (its pointerup was lost outside the window).
    beginDrag(300)
    moveDrag(400)
    expect(useEditorStore.getState().selections).toEqual([])

    // The next drag must not be ignored: it closes the stale gesture and wins.
    beginDrag(100)
    moveDrag(250)
    releaseDrag(250)

    expect(useEditorStore.getState().selections).toEqual([b.id])
  })

  it('pointercancel discards the box instead of committing the selection', () => {
    const { doc, a, b } = twoClipDoc()
    useEditorStore.setState({ doc })
    useEditorStore.getState().select(a.id)
    render(<TimelinePanel />)

    // Arm and move: the box is live and spans clip_b.
    beginDrag(100)
    moveDrag(250)
    expect(screen.getByTestId('marquee-rect')).toBeInTheDocument()

    // The browser cancels the gesture (touch pan, native drag): no commit.
    fireEvent.pointerCancel(window)
    expect(screen.queryByTestId('marquee-rect')).toBeNull()
    expect(useEditorStore.getState().selections).toEqual([a.id])

    // The cancelled gesture is gone: a fresh drag commits normally.
    beginDrag(150)
    moveDrag(250)
    releaseDrag(250)
    expect(useEditorStore.getState().selections).toEqual([b.id])
  })

  it('a foreign pointer release does not end the box it does not own', () => {
    const { doc, a, b } = twoClipDoc()
    useEditorStore.setState({ doc })
    useEditorStore.getState().select(a.id)
    render(<TimelinePanel />)

    beginDrag(100, { pointerId: 5 })
    moveDrag(250, { pointerId: 5 })
    expect(screen.getByTestId('marquee-rect')).toBeInTheDocument()

    // A second finger lifting must not resolve the box mid-drag (that would
    // commit a selection from a rect the first pointer is still dragging) nor
    // tear the box down. Its MOVE must not steer the rect either: left of the
    // anchor it would narrow the box onto clip a, so the owner's later release
    // is what proves the rect never moved.
    moveDrag(40, { pointerId: 9 })
    releaseDrag(250, { pointerId: 9 })
    expect(screen.getByTestId('marquee-rect')).toBeInTheDocument()
    expect(useEditorStore.getState().selections).toEqual([a.id])

    // The owner still drives the box and its release commits, still hitting b.
    releaseDrag(250, { pointerId: 5 })
    expect(screen.queryByTestId('marquee-rect')).toBeNull()
    expect(useEditorStore.getState().selections).toEqual([b.id])
  })

  it('the razor tool does not arm a marquee', () => {
    const { doc, a } = twoClipDoc()
    useEditorStore.setState({ doc })
    useEditorStore.getState().select(a.id)
    useEditorStore.getState().setActiveTool('razor')
    render(<TimelinePanel />)

    beginDrag(150)
    moveDrag(250)
    releaseDrag(250)

    // A razor click on empty space keeps its pre-marquee deselect behavior;
    // no box is ever drawn, so the drag cannot select either.
    expect(useEditorStore.getState().selections).toEqual([])
    expect(screen.queryByTestId('marquee-rect')).toBeNull()
  })
})

describe('ruler scrub (playhead drag) pointer ownership', () => {
  it('a foreign pointer move and release do not drive or end the scrub', () => {
    const onScrubStart = vi.fn()
    const onScrub = vi.fn()
    const onScrubEnd = vi.fn()
    render(
      <Ruler
        width={800}
        pxPerSec={PPS_DEFAULT}
        onScrubStart={onScrubStart}
        onScrub={onScrub}
        onScrubEnd={onScrubEnd}
      />,
    )
    const rulerEl = document.querySelector('[role="slider"]')
    if (!rulerEl) throw new Error('ruler not rendered')

    fireEvent.pointerDown(rulerEl, { button: 0, clientX: 10, pointerId: 5 })
    expect(onScrubStart).toHaveBeenCalledTimes(1)

    // The owner's move seeks.
    fireEvent.pointerMove(rulerEl, { clientX: 40, pointerId: 5 })
    expect(onScrub).toHaveBeenCalledTimes(1)

    // A second finger over the ruler must not seek, and its release must not
    // end the scrub the first finger is still performing.
    fireEvent.pointerMove(rulerEl, { clientX: 200, pointerId: 9 })
    fireEvent.pointerUp(rulerEl, { pointerId: 9 })
    expect(onScrub).toHaveBeenCalledTimes(1)
    expect(onScrubEnd).not.toHaveBeenCalled()

    // The owner keeps driving and ends the scrub.
    fireEvent.pointerMove(rulerEl, { clientX: 60, pointerId: 5 })
    expect(onScrub).toHaveBeenCalledTimes(2)
    fireEvent.pointerUp(rulerEl, { pointerId: 5 })
    expect(onScrubEnd).toHaveBeenCalledTimes(1)
  })

  it('a new pointerdown reclaims a scrub whose pointer never released', () => {
    const onScrubEnd = vi.fn()
    const onScrub = vi.fn()
    const noop = vi.fn()
    render(
      <Ruler
        width={800}
        pxPerSec={PPS_DEFAULT}
        onScrubStart={noop}
        onScrub={onScrub}
        onScrubEnd={onScrubEnd}
      />,
    )
    const rulerEl = document.querySelector('[role="slider"]')
    if (!rulerEl) throw new Error('ruler not rendered')

    // Pointer 5 starts a scrub and is never released (its pointerup was lost).
    fireEvent.pointerDown(rulerEl, { button: 0, clientX: 10, pointerId: 5 })
    // A fresh pointer must recover rather than be refused, or the ruler would
    // stay dead for the rest of the session.
    fireEvent.pointerDown(rulerEl, { button: 0, clientX: 20, pointerId: 6 })
    fireEvent.pointerMove(rulerEl, { clientX: 30, pointerId: 6 })
    expect(onScrub).toHaveBeenCalledTimes(1)
    fireEvent.pointerUp(rulerEl, { pointerId: 6 })
    expect(onScrubEnd).toHaveBeenCalledTimes(1)
  })
})

describe('drag commit path (transient gesture -> one undo entry)', () => {
  it('commitTransient lands the moved clip and exactly one history entry', () => {
    const { doc, asset, trackId } = docWithClips()
    doc.project.tracks[0].clips = [
      { id: 'clip_x', trackId, mediaId: asset.id, start: 1, duration: 5, inPoint: 0 } as Clip,
    ]
    useEditorStore.setState({ doc })
    const before = editorStore.getState().past.length

    // The gesture lifecycle ClipView drives: begin, transient moves, commit.
    editorStore.getState().beginTransient()
    editorStore.getState().applyTransient({ type: 'moveClip', clipId: 'clip_x', trackId, start: 4 })
    editorStore.getState().commitTransient()

    const after = editorStore.getState()
    expect(after.past.length).toBe(before + 1) // ONE undo entry per gesture
    const clip = after.doc.project.tracks[0].clips[0]
    expect(clip.start).toBe(4)
  })

  it('cancelTransient restores the base doc (refused drop)', () => {
    const { doc, asset, trackId } = docWithClips()
    doc.project.tracks[0].clips = [
      { id: 'clip_x', trackId, mediaId: asset.id, start: 1, duration: 5, inPoint: 0 } as Clip,
    ]
    useEditorStore.setState({ doc })
    const before = editorStore.getState().past.length

    editorStore.getState().beginTransient()
    editorStore.getState().applyTransient({ type: 'moveClip', clipId: 'clip_x', trackId, start: 9 })
    editorStore.getState().cancelTransient()

    const after = editorStore.getState()
    expect(after.past.length).toBe(before) // no history entry for a refused drop
    expect(after.doc.project.tracks[0].clips[0].start).toBe(1)
  })

  it('a foreign pointer release does not end the clip drag it does not own', () => {
    const { doc, asset, trackId } = docWithClips()
    doc.project.tracks[0].clips = [
      { id: 'clip_x', trackId, mediaId: asset.id, start: 1, duration: 5, inPoint: 0 } as Clip,
    ]
    useEditorStore.setState({ doc })
    render(<TimelinePanel />)

    const startNow = () => useEditorStore.getState().doc.project.tracks[0].clips[0].start
    const pastBefore = useEditorStore.getState().past.length
    const RULER_HEIGHT = 28

    fireEvent.pointerDown(screen.getByTestId('clip-clip_x'), {
      button: 0,
      pointerId: 5,
      clientX: 100,
      clientY: RULER_HEIGHT + 10,
    })
    fireEvent.pointerMove(window, { pointerId: 5, clientX: 180, clientY: RULER_HEIGHT + 10 })
    expect(startNow()).toBe(2)

    // A second pointer lifts: the gesture survives, the owning pointer keeps
    // driving it and lands the commit.
    fireEvent.pointerUp(window, { pointerId: 9 })
    fireEvent.pointerMove(window, { pointerId: 5, clientX: 260, clientY: RULER_HEIGHT + 10 })
    expect(startNow()).toBe(3)
    fireEvent.pointerUp(window, { pointerId: 5 })
    expect(useEditorStore.getState().past.length).toBe(pastBefore + 1)
  })

  it('a foreign commit mid-clip-drag rolls the clip back and refuses later frames', () => {
    const { doc, asset, trackId } = docWithClips()
    doc.project.tracks[0].clips = [
      { id: 'clip_x', trackId, mediaId: asset.id, start: 1, duration: 5, inPoint: 0 } as Clip,
    ]
    useEditorStore.setState({ doc })
    render(<TimelinePanel />)

    const startNow = () => useEditorStore.getState().doc.project.tracks[0].clips[0].start
    const pastBefore = useEditorStore.getState().past.length
    const RULER_HEIGHT = 28

    fireEvent.pointerDown(screen.getByTestId('clip-clip_x'), {
      button: 0,
      clientX: 100,
      clientY: RULER_HEIGHT + 10,
    })
    fireEvent.pointerMove(window, { clientX: 180, clientY: RULER_HEIGHT + 10 })
    expect(startNow()).toBe(2) // +80 px at 80 px/s

    // A foreign commit (keyboard delete, menu action, ...) resolves the gesture
    // first: the in-flight frame rolls back before the history snapshot.
    useEditorStore.getState().apply({ type: 'setClipMuted', clipId: 'clip_x', muted: true })
    expect(useEditorStore.getState().past.length).toBe(pastBefore + 1)
    expect(startNow()).toBe(1)

    // The stale drag's remaining frames must be refused, or they would mutate
    // the doc with no undo entry behind them.
    fireEvent.pointerMove(window, { clientX: 500, clientY: RULER_HEIGHT + 10 })
    expect(startNow()).toBe(1)
    expect(useEditorStore.getState().past.length).toBe(pastBefore + 1)
    fireEvent.pointerUp(window)
  })

  it('dragging via applyTransient does NOT push history until commit', () => {
    const { doc, asset, trackId } = docWithClips()
    doc.project.tracks[0].clips = [
      { id: 'clip_x', trackId, mediaId: asset.id, start: 1, duration: 5, inPoint: 0 } as Clip,
    ]
    useEditorStore.setState({ doc })
    const before = editorStore.getState().past.length

    editorStore.getState().beginTransient()
    for (const start of [2, 3, 4, 5]) {
      editorStore.getState().applyTransient({ type: 'moveClip', clipId: 'clip_x', trackId, start })
    }
    expect(editorStore.getState().past.length).toBe(before) // still nothing
    editorStore.getState().commitTransient()
    expect(editorStore.getState().past.length).toBe(before + 1)
  })
})

describe('timeline content width', () => {
  it('reaches a sequence marker parked past the last clip', () => {
    const { doc } = docWithClips()
    doc.project.tracks[0].clips = [createClip({ id: 'clip_x', start: 1, duration: 5, inPoint: 0 })]
    // 40 s is far past the 6 s sequence end (and past the 20 s tail padding):
    // without the markersEnd term the tab would be parked off-screen.
    doc.project.markers = [{ id: 'm1', time: 40 }]
    useEditorStore.setState({ doc })
    render(<TimelinePanel />)

    const content = document.querySelector('[data-timeline-scroll]')!
      .firstElementChild as HTMLElement
    expect(Number.parseFloat(content.style.width)).toBeGreaterThanOrEqual(
      TRACK_HEADER_WIDTH + 40 * PPS_DEFAULT,
    )
  })
})
