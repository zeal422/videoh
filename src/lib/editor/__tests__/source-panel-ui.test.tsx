// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'

import { MediaBin } from '@/components/editor/MediaBin'
import { SourcePanel } from '@/components/editor/SourcePanel'
import { useEditorKeyboard } from '@/hooks/editor/useEditorKeyboard'
import { toast } from '@/hooks/use-toast'
import { installBrowserMocks, type MockHarness } from './mocks/browser-mocks'
import { useEditorStore } from '../store'
import { DEFAULT_IMAGE_DURATION } from '../constants'
import { SOURCE_RANGE_MESSAGE } from '../sequence-ops'
import { createClip, createDoc, createMediaAsset } from '../factories'
import type { Doc, MediaAsset } from '../types'

/**
 * Source monitor locks (0.7.2 three-point editing):
 *
 * - bin row click selection feeds the panel (data-selected / aria-pressed);
 * - the panel's Mark In / Mark Out / Clear buttons and the span readout;
 * - `I` / `O` / `,` / `.` through the REAL window key handlers: marks record
 *   `sourcePlayhead` (the one owner of the source time) and the keys place the
 *   marked span at the sequence playhead in insert / overwrite mode;
 * - images have no source window: in/out controls disable and `,` places
 *   DEFAULT_IMAGE_DURATION;
 * - an inverted or sub-floor range toasts once and places nothing;
 * - the singleton preview element: switching assets or unmounting the panel
 *   releases it, so at most ONE live element exists (pinned through the
 *   browser mocks' media element patches).
 */

vi.mock('@/hooks/use-toast', () => ({
  toast: vi.fn(),
  useToast: () => ({ toasts: [], toast: vi.fn(), dismiss: vi.fn() }),
}))

let h: MockHarness

function Harness() {
  useEditorKeyboard(() => {})
  return null
}

function videoAsset(name: string, partial: Partial<MediaAsset> = {}): MediaAsset {
  return createMediaAsset({ kind: 'video', name, duration: 10, url: `blob:${name}`, ...partial })
}

/** Installs a doc holding the assets (V1 + A1 lanes) and resets the source state. */
function installDoc(media: MediaAsset[]): Doc {
  const doc = createDoc()
  doc.media = media
  useEditorStore.setState({ doc })
  return doc
}

function seekSource(t: number) {
  fireEvent.change(screen.getByLabelText('Source position'), { target: { value: String(t) } })
}

/** Marks In then Out through the real key handlers at source times. */
function markRange(inPoint: number, outPoint: number) {
  seekSource(inPoint)
  fireEvent.keyDown(window, { key: 'i' })
  seekSource(outPoint)
  fireEvent.keyDown(window, { key: 'o' })
}

beforeEach(() => {
  h = installBrowserMocks()
  document.body.innerHTML = ''
  useEditorStore.setState(useEditorStore.getInitialState())
  vi.mocked(toast).mockClear()
})

afterEach(() => {
  cleanup()
  h.uninstall()
})

describe('Source monitor (three-point editing, 0.7.2)', () => {
  it('clicking a bin row marks it selected and feeds the Source panel', () => {
    const a = videoAsset('a.mp4')
    const b = videoAsset('b.mp4')
    installDoc([a, b])
    render(
      <>
        <MediaBin />
        <SourcePanel />
      </>,
    )

    // Nothing selected yet: the panel invites a bin click.
    expect(screen.getByText('No source selected')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId(`media-item-${a.id}`))
    expect(screen.getByTestId(`media-item-${a.id}`)).toHaveAttribute('data-selected', 'true')
    expect(screen.getByTestId(`media-item-${a.id}`)).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('source-panel')).toHaveAttribute('data-selected-asset', a.id)
    // The panel header shows the asset name (scoped: the bin row shares it).
    expect(within(screen.getByTestId('source-panel')).getByTitle('a.mp4')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId(`media-item-${b.id}`))
    expect(screen.getByTestId(`media-item-${a.id}`)).toHaveAttribute('data-selected', 'false')
    expect(screen.getByTestId(`media-item-${b.id}`)).toHaveAttribute('data-selected', 'true')
    expect(screen.getByTestId('source-panel')).toHaveAttribute('data-selected-asset', b.id)
  })

  it('Mark In / Mark Out / Clear update the marks and the span readout', () => {
    const a = videoAsset('a.mp4')
    installDoc([a])
    useEditorStore.getState().setSourceAsset(a.id)
    render(<SourcePanel />)

    // Clear starts disabled: there is nothing to clear.
    expect(screen.getByTestId('source-clear')).toBeDisabled()
    expect(screen.getByTestId('source-span')).toHaveTextContent('Whole asset')

    seekSource(3)
    expect(screen.getByTestId('source-time')).toHaveTextContent('3.00s')
    fireEvent.click(screen.getByTestId('source-mark-in'))
    expect(useEditorStore.getState().sourceIn).toBe(3)

    seekSource(7)
    fireEvent.click(screen.getByTestId('source-mark-out'))
    expect(useEditorStore.getState().sourceOut).toBe(7)
    expect(screen.getByTestId('source-span')).toHaveTextContent('In 3.00s · Out 7.00s · 4.00s')
    expect(screen.getByTestId('source-span')).not.toHaveAttribute('data-invalid')
    expect(screen.getByTestId('source-clear')).toBeEnabled()

    fireEvent.click(screen.getByTestId('source-clear'))
    expect(useEditorStore.getState().sourceIn).toBeNull()
    expect(useEditorStore.getState().sourceOut).toBeNull()
    expect(screen.getByTestId('source-span')).toHaveTextContent('Whole asset')
  })

  it('I and O mark at the source playhead through the real key handlers', () => {
    const a = videoAsset('a.mp4')
    installDoc([a])
    useEditorStore.getState().setSourceAsset(a.id)
    render(
      <>
        <Harness />
        <SourcePanel />
      </>,
    )

    seekSource(2.5)
    fireEvent.keyDown(window, { key: 'i' })
    expect(useEditorStore.getState().sourceIn).toBe(2.5)

    seekSource(6)
    fireEvent.keyDown(window, { key: 'o' })
    expect(useEditorStore.getState().sourceOut).toBe(6)
  })

  it('a source seek followed by I records sourceIn at the seeked time', () => {
    const a = videoAsset('a.mp4')
    installDoc([a])
    useEditorStore.getState().setSourceAsset(a.id)
    render(
      <>
        <Harness />
        <SourcePanel />
      </>,
    )

    // One owner of the source time: the panel readout, the seeked element and
    // the recorded mark all agree on the same store field.
    seekSource(3.5)
    expect(screen.getByTestId('source-time')).toHaveTextContent('3.50s')
    fireEvent.keyDown(window, { key: 'i' })
    expect(useEditorStore.getState().sourceIn).toBe(3.5)
    expect(useEditorStore.getState().sourceIn).toBe(useEditorStore.getState().sourcePlayhead)
  })

  it("',' inserts the marked span at the playhead as ONE undo step", () => {
    const media = videoAsset('a.mp4')
    const incoming = videoAsset('b.mp4')
    const doc = installDoc([media, incoming])
    doc.project.tracks[0].clips = [
      createClip({ id: 'c1', mediaId: media.id, start: 6, duration: 4 }),
    ]
    useEditorStore.setState({ doc, playhead: 2 })
    useEditorStore.getState().setSourceAsset(incoming.id)
    render(
      <>
        <Harness />
        <SourcePanel />
      </>,
    )

    markRange(5, 8) // 3s of source: 5..8
    fireEvent.keyDown(window, { key: ',' })

    const state = useEditorStore.getState()
    const clips = state.doc.project.tracks[0].clips
    const placed = clips.find((c) => c.mediaId === incoming.id)!
    expect(placed).toMatchObject({ start: 2, duration: 3, inPoint: 5 })
    expect(clips.find((c) => c.id === 'c1')!.start).toBe(9) // shifted by the span
    expect(state.past).toHaveLength(1) // displacement + placement = one entry

    useEditorStore.getState().undo()
    const after = useEditorStore.getState().doc.project.tracks[0].clips
    expect(after).toHaveLength(1)
    expect(after[0].start).toBe(6)
  })

  it("'.' overwrites the covered span at the playhead", () => {
    const media = videoAsset('a.mp4')
    const incoming = videoAsset('b.mp4')
    const doc = installDoc([media, incoming])
    doc.project.tracks[0].clips = [
      createClip({ id: 'c1', mediaId: media.id, start: 0, duration: 4 }),
    ]
    useEditorStore.setState({ doc, playhead: 1 })
    useEditorStore.getState().setSourceAsset(incoming.id)
    render(
      <>
        <Harness />
        <SourcePanel />
      </>,
    )

    markRange(5, 8) // 3s span overwrites 1..4
    fireEvent.keyDown(window, { key: '.' })

    const clips = useEditorStore.getState().doc.project.tracks[0].clips
    const c1 = clips.find((c) => c.id === 'c1')!
    expect(c1.start + c1.duration).toBeCloseTo(1, 6) // tail trimmed to the edit point
    const placed = clips.find((c) => c.mediaId === incoming.id)!
    expect(placed).toMatchObject({ start: 1, duration: 3, inPoint: 5 })
    expect(useEditorStore.getState().past).toHaveLength(1)
  })

  it('no source selected is a no-op for , and .', () => {
    const media = videoAsset('a.mp4')
    installDoc([media])
    render(<Harness />)

    fireEvent.keyDown(window, { key: ',' })
    fireEvent.keyDown(window, { key: '.' })
    expect(useEditorStore.getState().doc.project.tracks[0].clips).toHaveLength(0)
    expect(useEditorStore.getState().past).toHaveLength(0)
    expect(vi.mocked(toast)).not.toHaveBeenCalled()
  })

  it('images disable the in/out controls and place 4s', () => {
    const img = createMediaAsset({ kind: 'image', name: 'p.png', duration: 0, url: '' })
    const doc = installDoc([img])
    useEditorStore.setState({ doc, playhead: 1.5 })
    useEditorStore.getState().setSourceAsset(img.id)
    render(
      <>
        <Harness />
        <SourcePanel />
      </>,
    )

    expect(screen.getByTestId('source-mark-in')).toBeDisabled()
    expect(screen.getByTestId('source-mark-out')).toBeDisabled()
    expect(screen.getByTestId('source-clear')).toBeDisabled()
    expect(screen.getByTestId('source-span')).toHaveTextContent('Images have no source window.')

    fireEvent.keyDown(window, { key: ',' })
    const clips = useEditorStore.getState().doc.project.tracks[0].clips
    expect(clips[0]).toMatchObject({
      start: 1.5,
      duration: DEFAULT_IMAGE_DURATION,
      inPoint: 0,
    })
  })

  it('an inverted or sub-floor range is refused with one toast and places nothing', () => {
    const incoming = videoAsset('b.mp4')
    installDoc([incoming])
    useEditorStore.getState().setSourceAsset(incoming.id)
    render(
      <>
        <Harness />
        <SourcePanel />
      </>,
    )

    // Inverted: In 5, Out 2.
    markRange(5, 2)
    expect(screen.getByTestId('source-span')).toHaveAttribute('data-invalid')
    fireEvent.keyDown(window, { key: ',' })
    expect(vi.mocked(toast)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(toast)).toHaveBeenCalledWith(
      expect.objectContaining({ description: SOURCE_RANGE_MESSAGE }),
    )
    expect(useEditorStore.getState().doc.project.tracks[0].clips).toHaveLength(0)
    expect(useEditorStore.getState().past).toHaveLength(0)

    // Sub-floor: 0.05s sits under MIN_CLIP_DURATION (0.1s).
    useEditorStore.getState().clearSourceMarks()
    markRange(2, 2.05)
    expect(screen.getByTestId('source-span')).toHaveAttribute('data-invalid')
    fireEvent.keyDown(window, { key: '.' })
    expect(vi.mocked(toast)).toHaveBeenCalledTimes(2)
    expect(vi.mocked(toast)).toHaveBeenLastCalledWith(
      expect.objectContaining({ description: SOURCE_RANGE_MESSAGE }),
    )
    expect(useEditorStore.getState().doc.project.tracks[0].clips).toHaveLength(0)
    expect(useEditorStore.getState().past).toHaveLength(0)
  })

  it('one-sided mark (in only) spans [in, asset end]', () => {
    const incoming = videoAsset('b.mp4')
    const doc = installDoc([incoming])
    useEditorStore.setState({ doc, playhead: 0 })
    useEditorStore.getState().setSourceAsset(incoming.id)
    render(
      <>
        <Harness />
        <SourcePanel />
      </>,
    )

    seekSource(5)
    fireEvent.keyDown(window, { key: 'i' })
    expect(screen.getByTestId('source-span')).toHaveTextContent('In 5.00s · Out 10.00s · 5.00s')

    fireEvent.keyDown(window, { key: ',' })
    const placed = useEditorStore.getState().doc.project.tracks[0].clips[0]
    expect(placed).toMatchObject({ start: 0, inPoint: 5, duration: 5 })
  })

  it('one-sided mark (out only) spans [0, out]', () => {
    const incoming = videoAsset('b.mp4')
    installDoc([incoming])
    useEditorStore.getState().setSourceAsset(incoming.id)
    render(
      <>
        <Harness />
        <SourcePanel />
      </>,
    )

    seekSource(3)
    fireEvent.keyDown(window, { key: 'o' })
    expect(screen.getByTestId('source-span')).toHaveTextContent('In 0.00s · Out 3.00s · 3.00s')

    fireEvent.keyDown(window, { key: ',' })
    const placed = useEditorStore.getState().doc.project.tracks[0].clips[0]
    expect(placed).toMatchObject({ start: 0, inPoint: 0, duration: 3 })
  })

  it('switching the selected asset clears the marks and releases the previous preview', () => {
    const a = videoAsset('a.mp4')
    const b = videoAsset('b.mp4')
    installDoc([a, b])
    useEditorStore.getState().setSourceAsset(a.id)
    render(
      <>
        <Harness />
        <SourcePanel />
      </>,
    )

    const previews = () => document.querySelectorAll('[data-testid="source-preview"]')
    expect(previews()).toHaveLength(1)
    const first = previews()[0]

    seekSource(4)
    fireEvent.keyDown(window, { key: 'i' })
    expect(useEditorStore.getState().sourceIn).toBe(4)

    // Outside fireEvent's act, so flush the re-render the store update triggers.
    act(() => useEditorStore.getState().setSourceAsset(b.id))
    const s = useEditorStore.getState()
    expect(s.sourceAssetId).toBe(b.id)
    expect(s.sourceIn).toBeNull()
    expect(s.sourceOut).toBeNull()
    expect(s.sourcePlayhead).toBe(0)
    // The old element was released and exactly one live element remains.
    expect(previews()).toHaveLength(1)
    expect(previews()[0]).not.toBe(first)
    expect(previews()[0]).toHaveAttribute('aria-label', 'b.mp4 source preview')
  })

  it('unmounting the panel releases the preview element', () => {
    const a = videoAsset('a.mp4')
    installDoc([a])
    useEditorStore.getState().setSourceAsset(a.id)
    const view = render(<SourcePanel />)
    expect(document.querySelectorAll('[data-testid="source-preview"]')).toHaveLength(1)

    view.unmount()
    expect(document.querySelectorAll('[data-testid="source-preview"]')).toHaveLength(0)
  })

  it('reroutes the mounted source preview when proxies toggle or a proxy becomes ready', () => {
    const a = videoAsset('a.mp4', { width: 3840, height: 2160 })
    installDoc([a])
    useEditorStore.getState().setSourceAsset(a.id)
    render(<SourcePanel />)

    const preview = () =>
      document.querySelector('[data-testid="source-preview"]') as HTMLVideoElement
    expect(preview().getAttribute('src')).toContain('blob:a.mp4')

    // A re-attach for the same asset must not reset the source playhead.
    act(() => useEditorStore.getState().setSourcePlayhead(4))

    // A ready proxy plus the toggle reroutes the already-mounted element.
    act(() => {
      useEditorStore.getState().setProxyEntry(a.id, { status: 'ready', url: 'blob:proxy' })
      useEditorStore.getState().setProxiesEnabled(true)
    })
    expect(preview().getAttribute('src')).toContain('blob:proxy')
    expect(useEditorStore.getState().sourcePlayhead).toBe(4)

    // Turning proxies off restores the original and still keeps the playhead.
    act(() => useEditorStore.getState().setProxiesEnabled(false))
    expect(preview().getAttribute('src')).toContain('blob:a.mp4')
    expect(useEditorStore.getState().sourcePlayhead).toBe(4)
  })

  it('a still shows the still itself and never mounts a source <video>', () => {
    // Regression lock: the singleton used to be attached for EVERY asset with
    // a url, so a selected PNG got a <video src="blob:...png"> that could not
    // demux (readyState 0 / DEMUXER_ERROR_COULD_NOT_OPEN) and the monitor
    // showed a black box. The still is drawn by the panel; no element attaches.
    const still = createMediaAsset({
      kind: 'image',
      name: 'p.png',
      duration: 0,
      url: 'blob:p.png',
    })
    const clip = videoAsset('a.mp4')
    installDoc([still, clip])
    useEditorStore.getState().setSourceAsset(still.id)
    render(
      <>
        <Harness />
        <SourcePanel />
      </>,
    )

    const img = screen.getByTestId('source-image')
    expect(img).toHaveAttribute('src', 'blob:p.png')
    expect(img).toHaveAttribute('alt', 'p.png')
    expect(document.querySelectorAll('[data-testid="source-preview"]')).toHaveLength(0)

    // Switching to a timed asset still attaches exactly one element, and
    // coming back to the still leaves none behind.
    act(() => useEditorStore.getState().setSourceAsset(clip.id))
    expect(document.querySelectorAll('[data-testid="source-preview"]')).toHaveLength(1)
    act(() => useEditorStore.getState().setSourceAsset(still.id))
    expect(document.querySelectorAll('[data-testid="source-preview"]')).toHaveLength(0)
    expect(screen.getByTestId('source-image')).toBeInTheDocument()
  })

  it('the transport play button mirrors the element state', () => {
    const a = videoAsset('a.mp4')
    installDoc([a])
    useEditorStore.getState().setSourceAsset(a.id)
    render(<SourcePanel />)

    expect(screen.getByRole('button', { name: 'Play source' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Play source' }))
    expect(screen.getByRole('button', { name: 'Pause source' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Pause source' }))
    expect(screen.getByRole('button', { name: 'Play source' })).toBeInTheDocument()
  })
})
