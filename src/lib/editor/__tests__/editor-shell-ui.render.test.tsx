// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { EditorShell } from '@/components/editor/EditorShell'
import { CaptionsPanel, captionCueRootTime } from '@/components/editor/CaptionsPanel'
import { Toaster } from '@/components/ui/toaster'
import { readFileSync } from 'node:fs'
import { installBrowserMocks, type MockHarness } from './mocks/browser-mocks'
import { playbackRef } from '../playback/engine-ref'
import { isTransientActive, useEditorStore } from '../store'
import {
  createClip,
  createMediaAsset,
  createTextClip,
  createTrack,
  docDuration,
} from '../factories'
import type { Doc } from '../types'
import { CURRENT_VERSION } from '../../releases'

/**
 * jsdom render tests for the editor shell's dangling-gesture safety net: a
 * pointer released outside the element that started a drag (or the window
 * blurring) must commit the live gesture so history never stays open — but a
 * DIFFERENT pointer lifting must not end a gesture it does not own.
 */

let h: MockHarness

beforeEach(() => {
  h = installBrowserMocks()
  // The shadcn sidebar breakpoint hook probes matchMedia; jsdom has none.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }))
  document.body.innerHTML = ''
  useEditorStore.setState(useEditorStore.getInitialState())
})

afterEach(() => {
  cleanup()
  h.uninstall()
})

describe('EditorShell dangling-gesture safety net', () => {
  it('a foreign pointer release does not end the live gesture', () => {
    const { unmount } = render(<EditorShell />)
    // A gesture owned by pointer 5 (as a real drag would start it).
    useEditorStore.getState().beginTransient(5)

    // Pointer 9 lifts: the shell must leave pointer 5's gesture alone.
    fireEvent.pointerUp(window, { pointerId: 9 })
    expect(isTransientActive()).toBe(true)

    // The owning pointer's release commits it.
    fireEvent.pointerUp(window, { pointerId: 5 })
    expect(isTransientActive()).toBe(false)
    unmount()
  })

  it('a window blur commits the live gesture (pointerless event)', () => {
    render(<EditorShell />)
    useEditorStore.getState().beginTransient(5)
    fireEvent(window, new Event('blur'))
    expect(isTransientActive()).toBe(false)
  })

  it('greys out marker navigation when every marker is past the sequence end', async () => {
    // A sequence that shrank (clips deleted) can strand markers beyond the end.
    // Navigation ignores them, so the menu must not offer a jump that no-ops.
    const asset = createMediaAsset({ kind: 'video', duration: 30, name: 'a.mp4' })
    const clip = createClip({ id: 'c1', mediaId: asset.id, start: 0, duration: 6, inPoint: 0 })
    const doc: Doc = {
      project: {
        tracks: [createTrack('video', 1, { clips: [clip] })],
        markers: [{ id: 'm1', time: 20 }],
        id: 'p_test',
        name: 'test',
        width: 1920,
        height: 1080,
        fps: 30,
      },
      media: [asset],
    }
    useEditorStore.setState({ doc })
    const user = userEvent.setup()
    // The welcome modal would open over this menu interaction (fresh visitor);
    // record the version so the shell stays silent for this test.
    window.localStorage.setItem('releases:lastSeen', CURRENT_VERSION)
    render(<EditorShell />)

    const trigger = screen.getByRole('menuitem', { name: 'Marker' })
    fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' })
    fireEvent.pointerUp(trigger, { button: 0, pointerType: 'mouse' })
    const next = await screen.findByRole('menuitem', { name: /Go to Next Marker/ })
    expect(next).toHaveAttribute('aria-disabled', 'true')

    // Put the marker inside the sequence and the same item comes alive.
    const inside: Doc = { ...doc, project: { ...doc.project, markers: [{ id: 'm1', time: 3 }] } }
    useEditorStore.setState({ doc: inside })
    await waitFor(() =>
      expect(screen.getByRole('menuitem', { name: /Go to Next Marker/ })).not.toHaveAttribute(
        'aria-disabled',
        'true',
      ),
    )
  })

  it('unmount removes the blur listener (no commit after teardown)', () => {
    const { unmount } = render(<EditorShell />)
    useEditorStore.getState().beginTransient(5)
    unmount()

    // A leaked blur listener would still commit the gesture slot.
    fireEvent(window, new Event('blur'))
    expect(isTransientActive()).toBe(true)
    useEditorStore.getState().cancelTransient()
  })
})

describe('preview active-sequence reset (0.8.1)', () => {
  it('leaves the playhead alone on mount and resets it on a path change', () => {
    const doc = useEditorStore.getState().doc
    const vTrack = doc.project.tracks.find((t) => t.kind === 'video')!
    vTrack.clips.push({ id: 'rootA', sequenceId: 'A', start: 0, duration: 10, inPoint: 0 })
    doc.project.sequences = [
      { id: 'A', name: 'A', tracks: [{ id: 'ta', kind: 'video', name: 'V1', clips: [] }] },
    ]
    useEditorStore.setState({ doc })
    // Set the playhead BEFORE mounting, so the assertion below actually detects
    // any mount-time reset instead of restating a value set after mount.
    useEditorStore.getState().setPlayhead(5)
    expect(useEditorStore.getState().playhead).toBe(5)

    render(<EditorShell />)
    // Mounting the preview must not clobber a live playhead.
    expect(useEditorStore.getState().playhead).toBe(5)

    // Opening the child sequence resets the playhead to the new clock's start.
    act(() => useEditorStore.getState().setActiveSequencePath(['A']))
    expect(useEditorStore.getState().activeSequencePath).toEqual(['A'])
    expect(useEditorStore.getState().playhead).toBe(0)
  })
})

describe('CaptionsPanel (0.8.5)', () => {
  /** Root doc with one Captions track holding two out-of-order flagged clips. */
  function captionsDoc() {
    // Clone: the store's initial doc object is shared, so pushing tracks
    // into it directly would leak captions into every later test.
    const doc: Doc = structuredClone(useEditorStore.getState().doc)
    const track = createTrack('text', 1, { id: 'track_cap', name: 'Captions' })
    track.clips = [
      createTextClip({ id: 'cap_b', isCaption: true, start: 4, duration: 1, text: 'Second' }),
      createTextClip({ id: 'cap_a', isCaption: true, start: 1, duration: 2, text: 'First' }),
    ]
    doc.project.tracks.push(track)
    useEditorStore.setState({ doc, playhead: 0, activeSequencePath: [] })
    return doc
  }

  /** The captions doc plus one compound container opening sequence seq_1. */
  function compoundCaptionsDoc(containerStarts: number[]) {
    const doc = captionsDoc()
    const lane = doc.project.tracks.find((t) => t.kind === 'video')!
    containerStarts.forEach((start, i) => {
      lane.clips.push({ id: `box${i}`, sequenceId: 'seq_1', start, duration: 5, inPoint: 0 })
    })
    doc.project.sequences = [
      { id: 'seq_1', name: 'Nested', tracks: [{ id: 'tn', kind: 'video', name: 'V1', clips: [] }] },
    ]
    useEditorStore.setState({ doc })
    return doc
  }

  function cueClips() {
    return useEditorStore.getState().doc.project.tracks.find((t) => t.id === 'track_cap')!.clips
  }

  it('lists cues in start order with seek buttons and time/text fields', () => {
    captionsDoc()
    render(<CaptionsPanel />)
    const seeks = screen.getAllByRole('button', { name: /Seek to cue/ })
    expect(seeks.map((b) => b.textContent)).toEqual(['1', '2'])
    expect(screen.getByLabelText('Cue 1 text')).toHaveValue('First')
    expect(screen.getByLabelText('Cue 2 text')).toHaveValue('Second')
    expect(screen.getByLabelText('Cue 1 start (seconds)')).toHaveValue(1)
    expect(screen.getByLabelText('Cue 2 end (seconds)')).toHaveValue(5)
  })

  it('clicking a cue number seeks to its start', () => {
    captionsDoc()
    render(<CaptionsPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Seek to cue 2' }))
    expect(useEditorStore.getState().playhead).toBe(4)
  })

  it('seek returns to the root sequence first when a compound is open', () => {
    compoundCaptionsDoc([10])
    useEditorStore.getState().setActiveSequencePath(['seq_1'])
    render(<CaptionsPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Seek to cue 1' }))
    expect(useEditorStore.getState().activeSequencePath).toEqual([])
    expect(useEditorStore.getState().playhead).toBe(1)
  })

  it('start/end/text edits dispatch the existing clip commands', () => {
    captionsDoc()
    render(<CaptionsPanel />)
    const start = screen.getByLabelText('Cue 1 start (seconds)')
    fireEvent.change(start, { target: { value: '5' } })
    fireEvent.blur(start)
    expect(cueClips().find((c) => c.id === 'cap_a')!.start).toBe(5)
    // The move re-sorts the list: cap_b (start 4) is cue 1 again, cap_a cue 2.
    const end = screen.getByLabelText('Cue 1 end (seconds)')
    fireEvent.change(end, { target: { value: '8' } })
    fireEvent.blur(end)
    expect(cueClips().find((c) => c.id === 'cap_b')!.duration).toBe(4)
    const text = screen.getByLabelText('Cue 2 text')
    fireEvent.change(text, { target: { value: 'Edited' } })
    fireEvent.blur(text)
    expect(cueClips().find((c) => c.id === 'cap_a')!.text).toBe('Edited')
  })

  it('New Cue stamps at the playhead on the first captions track, one undo step', () => {
    captionsDoc()
    useEditorStore.getState().setPlayhead(7)
    const pastBefore = useEditorStore.getState().past.length
    render(<CaptionsPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'New Cue' }))
    const clips = cueClips()
    expect(clips.some((c) => c.start === 7 && c.isCaption && c.text === '')).toBe(true)
    expect(useEditorStore.getState().past.length).toBe(pastBefore + 1)
  })

  it('New Cue creates a first-free Captions track in one batch when none exists', () => {
    useEditorStore.getState().setPlayhead(2)
    const pastBefore = useEditorStore.getState().past.length
    render(<CaptionsPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'New Cue' }))
    const state = useEditorStore.getState()
    const track = state.doc.project.tracks.find((t) => t.name === 'Captions')
    expect(track?.kind).toBe('text')
    expect(track?.clips).toHaveLength(1)
    expect(track?.clips[0].start).toBe(2)
    expect(track?.clips[0].isCaption).toBe(true)
    expect(state.past.length).toBe(pastBefore + 1)
  })

  it('New Cue from a compound path stamps the converted root-absolute time', () => {
    compoundCaptionsDoc([10])
    useEditorStore.getState().setActiveSequencePath(['seq_1'])
    useEditorStore.getState().setPlayhead(2)
    render(<CaptionsPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'New Cue' }))
    const state = useEditorStore.getState()
    expect(state.activeSequencePath).toEqual([])
    expect(cueClips().some((c) => c.start === 12)).toBe(true)
  })

  it('New Cue is unavailable when the open path is shared by two containers', () => {
    compoundCaptionsDoc([10, 20])
    useEditorStore.getState().setActiveSequencePath(['seq_1'])
    render(<CaptionsPanel />)
    expect(screen.getByRole('button', { name: 'New Cue' })).toBeDisabled()
  })

  it('captionCueRootTime refuses non-finite times', () => {
    const doc = compoundCaptionsDoc([10])
    expect(captionCueRootTime(doc, [], NaN)).toBe(null)
    expect(captionCueRootTime(doc, ['seq_1'], Infinity)).toBe(null)
    // Finite values still convert (locked against the guard swallowing all).
    expect(captionCueRootTime(doc, [], 2)).toBe(2)
  })

  it('captionCueRootTime converts along the path and refuses ambiguity', () => {
    const doc = compoundCaptionsDoc([10])
    // Empty path is a passthrough: the root clock needs no conversion.
    expect(captionCueRootTime(doc, [], 2)).toBe(2)
    expect(captionCueRootTime(doc, ['seq_1'], 2)).toBe(12)
    expect(captionCueRootTime(doc, ['seq_nope'], 2)).toBe(null)
    const ambiguous = compoundCaptionsDoc([10, 20])
    expect(captionCueRootTime(ambiguous, ['seq_1'], 2)).toBe(null)
  })

  it('orders equal cues by trimmed text, matching the export file', () => {
    const doc: Doc = structuredClone(useEditorStore.getState().doc)
    const track = createTrack('text', 1, { id: 'track_cap', name: 'Captions' })
    // Raw code-unit order would put 'b' before 'b ' (prefix first), but the
    // export trims before the tiebreak, so both read 'b' and track order
    // wins: the panel must agree with the file.
    track.clips = [
      createTextClip({ id: 'cap_x', isCaption: true, start: 1, duration: 1, text: 'b ' }),
      createTextClip({ id: 'cap_y', isCaption: true, start: 1, duration: 1, text: 'b' }),
    ]
    doc.project.tracks.push(track)
    useEditorStore.setState({ doc })
    render(<CaptionsPanel />)
    expect(screen.getByLabelText('Cue 1 text')).toHaveValue('b ')
  })

  it('New Cue past the supported range toasts instead of throwing', async () => {
    useEditorStore.getState().setPlayhead(2_000_000_000)
    render(
      <>
        <Toaster />
        <CaptionsPanel />
      </>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'New Cue' }))
    expect(await screen.findByText('Could not create the cue')).toBeInTheDocument()
    // The fresh-track batch is atomic: the refusal leaves no track behind.
    expect(useEditorStore.getState().doc.project.tracks.some((t) => t.name === 'Captions')).toBe(
      false,
    )
  })

  it('committing the displayed end keeps a nominal 100 ms span', () => {
    // Float subtraction degrades the span: 0.7 + 0.1 re-reads as
    // 0.09999999999999998 s, under the floor, so the edit must round through
    // milliseconds instead of comparing the raw difference.
    const doc: Doc = structuredClone(useEditorStore.getState().doc)
    const track = createTrack('text', 1, { id: 'track_cap', name: 'Captions' })
    track.clips = [
      createTextClip({ id: 'cap_dust', isCaption: true, start: 0.7, duration: 0.1, text: 'Dust' }),
    ]
    doc.project.tracks.push(track)
    useEditorStore.setState({ doc })
    const pastBefore = useEditorStore.getState().past.length
    render(<CaptionsPanel />)
    const end = screen.getByLabelText('Cue 1 end (seconds)')
    fireEvent.blur(end)
    expect(useEditorStore.getState().past.length).toBe(pastBefore + 1)
  })

  it('a refused New Cue keeps the open compound path', async () => {
    // The path resets only after a successful stamp: a refusal must not
    // strand the user at the root with no cue created.
    compoundCaptionsDoc([10])
    useEditorStore.getState().setActiveSequencePath(['seq_1'])
    useEditorStore.getState().setPlayhead(2_000_000_000)
    render(
      <>
        <Toaster />
        <CaptionsPanel />
      </>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'New Cue' }))
    expect(await screen.findByText('Could not create the cue')).toBeInTheDocument()
    expect(useEditorStore.getState().activeSequencePath).toEqual(['seq_1'])
    expect(cueClips()).toHaveLength(2)
  })

  it('committing an end on a corrupt-timed clip stays silent', async () => {
    // A NaN start can only come from deliberately corrupt data (no command
    // stores one): the edit is ignored like any other invalid input instead
    // of raising a refusal toast at the user.
    const doc: Doc = structuredClone(useEditorStore.getState().doc)
    const track = createTrack('text', 1, { id: 'track_cap', name: 'Captions' })
    const corrupt = createTextClip({
      id: 'cap_bad',
      isCaption: true,
      start: 1,
      duration: 1,
      text: 'Bad',
    })
    corrupt.start = NaN
    track.clips = [corrupt]
    doc.project.tracks.push(track)
    useEditorStore.setState({ doc })
    const pastBefore = useEditorStore.getState().past.length
    render(
      <>
        <Toaster />
        <CaptionsPanel />
      </>,
    )
    const end = screen.getByLabelText('Cue 1 end (seconds)')
    fireEvent.change(end, { target: { value: '5' } })
    fireEvent.blur(end)
    expect(useEditorStore.getState().past.length).toBe(pastBefore)
    await waitFor(() => expect(screen.getByTestId('captions-list')).toBeInTheDocument())
    expect(screen.queryByText('Could not edit the cue')).not.toBeInTheDocument()
  })

  it('empty state names the SRT import entry point', () => {
    render(<CaptionsPanel />)
    expect(screen.getByText(/Import an SRT file/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Import SRT' })).toBeInTheDocument()
    expect(screen.getByTestId('captions-download')).toBeInTheDocument()
  })

  it('an empty-text flagged clip renders without throwing', () => {
    const doc: Doc = structuredClone(useEditorStore.getState().doc)
    const track = createTrack('text', 1, { id: 'track_cap', name: 'Captions' })
    track.clips = [
      createTextClip({ id: 'cap_blank', isCaption: true, start: 0, duration: 1, text: '' }),
    ]
    doc.project.tracks.push(track)
    useEditorStore.setState({ doc })
    render(<CaptionsPanel />)
    expect(screen.getByLabelText('Cue 1 text')).toHaveValue('')
  })

  it('Download SRT with zero cues toasts the refusal', async () => {
    render(
      <>
        <Toaster />
        <CaptionsPanel />
      </>,
    )
    fireEvent.click(screen.getByTestId('captions-download'))
    expect(await screen.findByText('No captions to export')).toBeInTheDocument()
  })

  it('choosing an SRT file imports timed flagged clips', async () => {
    render(<CaptionsPanel />)
    const file = new File(['1\n00:00:01,000 --> 00:00:02,000\nHello\n'], 'cues.srt', {
      type: 'text/srt',
    })
    fireEvent.change(screen.getByTestId('captions-import'), { target: { files: [file] } })
    await waitFor(() => expect(screen.getByLabelText('Cue 1 text')).toHaveValue('Hello'))
    expect(useEditorStore.getState().doc.project.tracks.map((t) => t.name)).toContain('Captions')
  })
})

describe('EditorShell bottom-row wiring (static)', () => {
  it('a lone bottom panel fills the row and records no constrained size', () => {
    // Static lock: jsdom never runs the layout engine, so the lone-panel
    // geometry is asserted on the source instead. The bottom row deliberately
    // carries NO maxSize: either panel collapsing must fit inside the other,
    // and a cap refuses the collapse (a dead chevron plus a persisted
    // collapsed flag on an expanded panel). Alone, captions mounts without a
    // defaultSize so it fills the row, and the width handler stores nothing.
    const src = readFileSync('src/components/editor/EditorShell.tsx', 'utf8')
    expect(src).not.toContain('PANEL_BOUNDS.timeline.max')
    expect(src).not.toContain('PANEL_BOUNDS.captions.max')
    // With a collapsed timeline captions mounts auto (an all-fixed pair
    // summing far under 100 gets normalized and the strip breaks at
    // minSize, while an auto member absorbs the slack instead).
    expect(src).toContain('hidden.timeline || collapsed.timeline ? undefined : sizes.captions')
    expect(src).toContain('if (!hidden.timeline && !hidden.captions) {')
    // Persisted bottom collapse is enforced post-layout: a collapsed mount
    // cannot survive nested-group init, so the shells mount expanded and
    // the enforcer collapses flagged panels once layout settles. It reruns
    // on visibility and viewport transitions (mobile-to-desktop, unhide),
    // reading a snapshot the mount cannot have rewritten.
    expect(src).toContain('requestAnimationFrame')
    expect(src).toContain('bottomCollapsedWant')
    expect(src).toContain('[hidden.captions, hidden.timeline, isMobile]')
    // The intent snapshot refreshes on partial absence too: a snapshot
    // frozen while the row is fully visible goes stale when the user
    // expands a panel, and a later unhide would re-collapse it.
    expect(src).toContain('hidden.timeline ||')
    expect(src).toContain('hidden.captions')
    const shell = readFileSync('src/components/editor/PanelShell.tsx', 'utf8')
    // No collapse-state subscriptions: the library fires both spuriously
    // during mount init, reverting persisted flags before first paint. The
    // store owns the flags (explicit setters, drag-size sync, and the
    // post-transition reconcile).
    expect(shell).not.toContain('onCollapse={')
    expect(shell).not.toContain('onExpand={')
  })
})

describe('playhead effect-contract', () => {
  /** Root doc plus one compound container (ends at 15) opening seq_1. */
  function compoundDoc(): Doc {
    const doc: Doc = structuredClone(useEditorStore.getState().doc)
    const lane = doc.project.tracks.find((t) => t.kind === 'video')!
    lane.clips.push({ id: 'box0', sequenceId: 'seq_1', start: 10, duration: 5, inPoint: 0 })
    doc.project.sequences = [
      { id: 'seq_1', name: 'Nested', tracks: [{ id: 'tn', kind: 'video', name: 'V1', clips: [] }] },
    ]
    useEditorStore.setState({ doc, playhead: 0, activeSequencePath: [] })
    return doc
  }

  it('a real path change parks a nonzero playhead at 0', () => {
    compoundDoc()
    const store = useEditorStore.getState()
    store.setPlayhead(12)
    store.setActiveSequencePath(['seq_1'])
    expect(useEditorStore.getState().activeSequencePath).toEqual(['seq_1'])
    expect(useEditorStore.getState().playhead).toBe(0)
  })

  it('a same-path call leaves a nonzero playhead alone', () => {
    compoundDoc()
    const store = useEditorStore.getState()
    store.setPlayhead(12)
    store.setActiveSequencePath([])
    expect(useEditorStore.getState().activeSequencePath).toEqual([])
    expect(useEditorStore.getState().playhead).toBe(12)
  })

  it('a playhead written after the path change wins', () => {
    compoundDoc()
    const store = useEditorStore.getState()
    store.setActiveSequencePath(['seq_1'])
    store.setPlayhead(12)
    expect(useEditorStore.getState().activeSequencePath).toEqual(['seq_1'])
    expect(useEditorStore.getState().playhead).toBe(12)
  })

  it('openSequence drill-in parks a nonzero playhead at 0', () => {
    compoundDoc()
    const store = useEditorStore.getState()
    store.setPlayhead(7)
    store.openSequence('seq_1')
    expect(useEditorStore.getState().activeSequencePath).toEqual(['seq_1'])
    expect(useEditorStore.getState().playhead).toBe(0)
  })

  it('a negative playhead still clamps to 0', () => {
    compoundDoc()
    useEditorStore.getState().setPlayhead(-3)
    expect(useEditorStore.getState().playhead).toBe(0)
  })

  it('deleting the compound container keeps a nonzero playhead through apply and undo', () => {
    compoundDoc()
    const store = useEditorStore.getState()
    store.setActiveSequencePath(['seq_1'])
    store.setPlayhead(2)
    // The delete prunes orphan seq_1, so normalization shortens the path.
    store.apply({ type: 'deleteClip', clipId: 'box0' })
    expect(useEditorStore.getState().activeSequencePath).toEqual([])
    expect(useEditorStore.getState().playhead).toBe(2)
    store.undo()
    expect(useEditorStore.getState().activeSequencePath).toEqual([])
    expect(useEditorStore.getState().playhead).toBe(2)
  })

  it('with the panel mounted, a path change plus an explicit playhead lands on the playhead', () => {
    const doc = compoundDoc()
    // The mirror seeks the store playhead and the engine clamps to the scope,
    // so the test time must sit inside the fixture duration.
    expect(docDuration(doc)).toBeGreaterThan(12)
    useEditorStore.getState().setActiveSequencePath(['seq_1'])
    render(<EditorShell />)
    // Spy calls through, so the engine still seeks and the state assertions
    // below keep proving the store contract alongside the engine behavior.
    const seek = vi.spyOn(playbackRef.current!, 'seek')
    act(() => {
      useEditorStore.getState().setActiveSequencePath([])
      useEditorStore.getState().setPlayhead(12)
    })
    expect(useEditorStore.getState().activeSequencePath).toEqual([])
    expect(useEditorStore.getState().playhead).toBe(12)
    expect(seek).toHaveBeenCalledWith(12)
  })

  it('with the panel mounted, a lone path change still parks at 0', () => {
    compoundDoc()
    useEditorStore.getState().setPlayhead(9)
    render(<EditorShell />)
    act(() => {
      useEditorStore.getState().setActiveSequencePath(['seq_1'])
    })
    expect(useEditorStore.getState().activeSequencePath).toEqual(['seq_1'])
    expect(useEditorStore.getState().playhead).toBe(0)
  })

  it('with the panel mounted, an engine seek past the scope clamps into the store', () => {
    const doc = compoundDoc()
    render(<EditorShell />)
    const limit = docDuration(doc)
    act(() => {
      playbackRef.current?.seek(limit + 100)
    })
    expect(useEditorStore.getState().playhead).toBe(limit)
  })

  /** Root doc plus compound container plus one root caption cue at 12 s. */
  function compoundDocWithCue(): Doc {
    const doc = compoundDoc()
    const track = createTrack('text', 1, { id: 'track_cap', name: 'Captions' })
    track.clips = [createTextClip({ id: 'cap_a', isCaption: true, start: 12, duration: 1 })]
    doc.project.tracks.push(track)
    useEditorStore.setState({ doc })
    return doc
  }

  it('cue seek at the root moves the engine to the cue time', () => {
    compoundDocWithCue()
    // Already at the root, so no path transition fires the mirror effect: the
    // only engine seek the spy can observe is the explicit one in seekToCue.
    // EditorShell already mounts a Captions panel; a second render would duplicate
    // its buttons.
    render(<EditorShell />)
    const seek = vi.spyOn(playbackRef.current!, 'seek')
    fireEvent.click(screen.getByRole('button', { name: 'Seek to cue 1' }))
    expect(useEditorStore.getState().activeSequencePath).toEqual([])
    expect(useEditorStore.getState().playhead).toBe(12)
    expect(seek).toHaveBeenCalledWith(12)
  })

  it('New Cue at the root moves the engine to the new cue', () => {
    compoundDocWithCue()
    // Same-path by construction (already at the root): the mirror never runs,
    // so the spy observes only the explicit seek in addCue.
    render(<EditorShell />)
    // Inside act(): the click handler closes over render-time state, so the
    // playhead set must commit before the click dispatches.
    act(() => {
      useEditorStore.getState().setPlayhead(4)
    })
    const seek = vi.spyOn(playbackRef.current!, 'seek')
    fireEvent.click(screen.getByRole('button', { name: 'New Cue' }))
    const caps = useEditorStore
      .getState()
      .doc.project.tracks.find((t) => t.id === 'track_cap')!.clips
    expect(caps.some((c) => c.start === 4)).toBe(true)
    expect(seek).toHaveBeenCalledWith(4)
  })

  it('a path change while playing keeps the live value instead of snapping to 0', async () => {
    const doc = compoundDoc()
    expect(docDuration(doc)).toBeGreaterThan(12)
    // The post-change tick reads the child scope, so the child needs its own
    // duration: an empty child ends playback at 0 on the first tick there.
    const seq = doc.project.sequences!.find((s) => s.id === 'seq_1')!
    seq.tracks[0]!.clips.push({ id: 'n1', start: 0, duration: 5, inPoint: 0 })
    useEditorStore.setState({ doc })
    render(<EditorShell />)
    const store = () => useEditorStore.getState()
    act(() => {
      playbackRef.current?.play()
    })
    // play() prepares asynchronously and the controller is fire-and-forget:
    // pumping before the playing flag lands finds an empty rAF queue.
    await waitFor(() => expect(store().playing).toBe(true))
    h.lastAudioContext().currentTime += 1
    await act(async () => {
      await h.pump.pump(1)
    })
    expect(store().playhead).toBeCloseTo(1, 5)
    await act(async () => {
      store().setActiveSequencePath(['seq_1'])
      h.lastAudioContext().currentTime += 1
      // No await: pump() runs the queued frame callback synchronously up to
      // its first internal await, so the tick (and its onFrame store write)
      // lands after the park and before the flush at act exit. Awaiting here
      // would flush the pending mirror effect first, reading the parked 0.
      void h.pump.pump(1)
    })
    expect(store().activeSequencePath).toEqual(['seq_1'])
    expect(store().playhead).toBeCloseTo(2, 5)
  })
})
