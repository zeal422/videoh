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
import { useWorkspaceStore } from '../workspace-store'
import { WORKSPACE_STORAGE_KEY } from '../workspace'
import { downloadBlob } from '../export/mp4'
import {
  createClip,
  createMediaAsset,
  createTextClip,
  createTrack,
  docDuration,
} from '../factories'
import type { Doc } from '../types'
import { CURRENT_VERSION } from '../../releases'

vi.mock('../export/mp4', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../export/mp4')>()
  return { ...actual, downloadBlob: vi.fn() }
})

/**
 * jsdom render tests for the editor shell's dangling-gesture safety net: a
 * pointer released outside the element that started a drag (or the window
 * blurring) must commit the live gesture so history never stays open — but a
 * DIFFERENT pointer lifting must not end a gesture it does not own.
 */

let h: MockHarness
const initialWorkspace = useWorkspaceStore.getInitialState()

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
  useWorkspaceStore.setState(initialWorkspace, true)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
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

  it('Download VTT button is present beside Download SRT', () => {
    render(<CaptionsPanel />)
    expect(screen.getByTestId('captions-download-vtt')).toBeInTheDocument()
  })

  it('Download VTT downloads the cues as a WebVTT document', async () => {
    const doc = captionsDoc()
    render(
      <>
        <Toaster />
        <CaptionsPanel />
      </>,
    )
    fireEvent.click(screen.getByTestId('captions-download-vtt'))
    const mocked = vi.mocked(downloadBlob)
    expect(mocked).toHaveBeenCalledTimes(1)
    const [blob, filename] = mocked.mock.calls[0] as [Blob, string]
    expect(filename).toBe(`${doc.project.name}.vtt`)
    expect(blob.type).toBe('text/vtt;charset=utf-8')
    const text = await blob.text()
    expect(text).toBe(
      'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nFirst\n\n00:00:04.000 --> 00:00:05.000\nSecond\n\n',
    )
    // No error toast on the success path. Scoped to VTT-specific texts:
    // the toast store is module-level memory, so the SRT zero-cue test's
    // "No captions to export" toast replays in any later Toaster and cannot
    // be asserted absent here.
    expect(screen.queryByText(/Could not build|supported export/)).not.toBeInTheDocument()
  })

  it('Download VTT with an out-of-range cue shows the range refusal', async () => {
    const doc: Doc = structuredClone(useEditorStore.getState().doc)
    const track = createTrack('text', 1, { id: 'track_cap', name: 'Captions' })
    track.clips = [
      createTextClip({
        id: 'cap_far',
        isCaption: true,
        start: 2000000001,
        duration: 1,
        text: 'Far',
      }),
    ]
    doc.project.tracks.push(track)
    useEditorStore.setState({ doc, playhead: 0, activeSequencePath: [] })
    render(
      <>
        <Toaster />
        <CaptionsPanel />
      </>,
    )
    fireEvent.click(screen.getByTestId('captions-download-vtt'))
    expect(await screen.findByText(/supported export range/)).toBeInTheDocument()
    expect(vi.mocked(downloadBlob)).not.toHaveBeenCalled()
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

describe('EditorShell panel model (static locks)', () => {
  it('has no collapse state, controls, or checks left in the workspace shell', () => {
    const editor = readFileSync('src/components/editor/EditorShell.tsx', 'utf8')
    const shell = readFileSync('src/components/editor/PanelShell.tsx', 'utf8')
    for (const source of [editor, shell]) {
      expect(source).not.toContain('collapsed')
      expect(source).not.toContain('collapsible')
      expect(source).not.toContain('bottomCollapsedWant')
      expect(source).not.toContain('isCollapsed')
      expect(source).not.toContain('CollapseIcon')
    }
    expect(shell).toContain('PanelMenu')
    expect(editor).not.toContain('side="left"')
    expect(editor).not.toContain('side="right"')
    expect(editor).not.toContain('side="bottom"')
  })

  it('keys the conditional panel children and leaves the groups unkeyed', () => {
    const src = readFileSync('src/components/editor/EditorShell.tsx', 'utf8')
    for (const key of [
      'key="media"',
      'key="source"',
      'key="source-handle"',
      'key="preview"',
      'key="workspace"',
      'key="inspector-handle"',
      'key="inspector"',
      'key="upper"',
      'key="bottom"',
      'key="timeline"',
      'key="captions-handle"',
      'key="captions"',
    ]) {
      expect(src).toContain(key)
    }
    // The preview flag is the only group key.
    expect(src).toContain('key={`upper-${Number(!hidden.preview)}`}')
  })

  it('bounds the persisted bottom measurements and leaves solo groups uncapped', () => {
    const src = readFileSync('src/components/editor/EditorShell.tsx', 'utf8')
    expect(src).toContain('minSize={PANEL_BOUNDS.timeline.min}')
    expect(src).toContain('maxSize={showUpperArea ? PANEL_BOUNDS.timeline.max : undefined}')
    expect(src).toContain('maxSize={!hidden.timeline ? PANEL_BOUNDS.captions.max : undefined}')
    expect(src).toContain('defaultSize={hidden.timeline ? undefined : sizes.captions}')
    expect(src).not.toContain('hidden.timeline || collapsed.timeline')
  })

  it('guards the observers by shape and cancels a pending reset on gesture start', () => {
    const src = readFileSync('src/components/editor/EditorShell.tsx', 'utf8')
    expect(src).toContain('isExpectedPanelLayout')
    expect(src).toContain('resetTracker.noteLayout')
    expect(src).toContain('createResetTracker')
    expect(src).toContain('getLayout()')
    expect(src).toContain('onGestureStart={cancelPendingReset}')
    expect(src).toContain('showUpperArea && showBottomArea')
  })
})

describe('EditorShell panel model (render)', () => {
  const renderShell = () => {
    window.localStorage.setItem('releases:lastSeen', CURRENT_VERSION)
    return render(<EditorShell />)
  }

  // jsdom has no layout, and react-resizable-panels' global pointer listener
  // sees every pointerdown as touching a zero-size handle and stops it before
  // Radix. The keyboard path exercises the same trigger and item handlers.
  const openPanelMenu = (id: string) => {
    const trigger = screen.getByTestId(`panel-menu-${id}`)
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'Enter' })
    return trigger
  }

  const selectClosePanel = () => {
    const item = screen.getByRole('menuitem', { name: /close panel/i })
    fireEvent.keyDown(item, { key: 'Enter' })
  }

  const openWindowMenu = () => {
    const trigger = screen.getByTestId('menubar-window')
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'Enter' })
    return trigger
  }

  it('mounts all six panels and a panel menu on every desktop header', () => {
    renderShell()
    for (const id of ['media', 'source', 'preview', 'inspector', 'timeline', 'captions']) {
      expect(screen.getByTestId(`panel-menu-${id}`)).toBeInTheDocument()
    }
    expect(screen.getByTestId('preview-canvas')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /program monitor/i })).toBeInTheDocument()
  })

  it('closes a panel from its menu and restores it from the Window menu', async () => {
    renderShell()
    openPanelMenu('media')
    selectClosePanel()
    expect(document.getElementById('panel-media')).toBeNull()
    expect(screen.queryByTestId('panel-menu-media')).not.toBeInTheDocument()

    openWindowMenu()
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Media' }))
    expect(document.getElementById('panel-media')).not.toBeNull()
    expect(screen.getByTestId('panel-menu-media')).toBeInTheDocument()
  })

  it('closing every panel shows the empty state and Reset restores all six', async () => {
    // Seed a non-default payload so the persisted-defaults assertion below
    // fails if resetWorkspace() does not actually write the defaults.
    window.localStorage.setItem(
      WORKSPACE_STORAGE_KEY,
      JSON.stringify({
        sizes: { media: 12, source: 14, inspector: 16, timeline: 15, captions: 15 },
        hidden: {},
        keyframeGraphHeights: {},
      }),
    )
    useWorkspaceStore.setState({
      hidden: {
        media: true,
        preview: true,
        source: true,
        inspector: true,
        timeline: true,
        captions: true,
      },
    })
    renderShell()
    expect(screen.getByTestId('workspace-empty')).toBeInTheDocument()
    expect(screen.getByRole('menubar')).toBeInTheDocument()

    openWindowMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /reset workspace layout/i }))
    await waitFor(() => {
      for (const id of ['media', 'source', 'preview', 'inspector', 'timeline', 'captions']) {
        expect(document.getElementById(`panel-${id}`)).not.toBeNull()
      }
    })
    expect(screen.queryByTestId('workspace-empty')).not.toBeInTheDocument()
    expect(useWorkspaceStore.getState().sizes).toEqual({
      media: 32,
      source: 24,
      inspector: 26,
      timeline: 50,
      captions: 24,
    })
    const stored = () =>
      JSON.parse(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)!) as {
        sizes: Record<string, number>
      }
    const defaults = {
      media: 32,
      source: 24,
      inspector: 26,
      timeline: 50,
      captions: 24,
    }
    expect(stored().sizes).toEqual(defaults)
    // The queued reset frame must not write a transient layout over the
    // defaults the reset itself persisted.
    await act(async () => {
      await h.pump.pump(2)
    })
    expect(stored().sizes).toEqual(defaults)
  })

  it('a handle gesture before the reset frame cancels the pending resize', async () => {
    // Make the layout dirty: Window > Reset Workspace Layout is disabled on a
    // default layout, and without it begin() never schedules the frame under test.
    const workspace = useWorkspaceStore.getState()
    useWorkspaceStore.setState({ sizes: { ...workspace.sizes, media: 36 } })
    renderShell()
    openWindowMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /reset workspace layout/i }))
    // resetWorkspace() writes the default sizes synchronously, so the sizes
    // alone cannot prove the queued reset was cancelled. Watch the schedulers
    // the tracker cancels through and count the live frame before the gesture.
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame')
    const clearTimer = vi.spyOn(window, 'clearTimeout')
    const queuedBefore = h.pump.queued()
    expect(queuedBefore).toBeGreaterThan(0)
    const handle = screen.getByLabelText('Resize inspector panel (double-click to reset)')
    // isPrimary must be set: react-resizable-panels treats a non-primary
    // pointer as coordinates Infinity, which matches no handle.
    fireEvent.pointerDown(handle, {
      button: 0,
      buttons: 1,
      isPrimary: true,
      pointerId: 1,
      pointerType: 'mouse',
    })
    // One pending frame and its fallback timer must both be cancelled, and the
    // frame must leave the pump queue.
    expect(cancelFrame).toHaveBeenCalledTimes(1)
    expect(clearTimer).toHaveBeenCalled()
    expect(h.pump.queued()).toBe(queuedBefore - 1)
    await act(async () => {
      await h.pump.pump(2)
    })
    expect(useWorkspaceStore.getState().sizes).toEqual({
      media: 32,
      source: 24,
      inspector: 26,
      timeline: 50,
      captions: 24,
    })
    expect(document.getElementById('panel-inspector')).not.toBeNull()
    expect(screen.queryByTestId('workspace-empty')).not.toBeInTheDocument()
  })

  it('a store hide during a pending reset clears the token and keeps the hide', async () => {
    const workspace = useWorkspaceStore.getState()
    useWorkspaceStore.setState({ sizes: { ...workspace.sizes, media: 36 } })
    renderShell()
    openWindowMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /reset workspace layout/i }))
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame')
    const queuedBefore = h.pump.queued()
    expect(queuedBefore).toBeGreaterThan(0)
    act(() => {
      useWorkspaceStore.getState().setHidden('media', true)
    })
    expect(cancelFrame).toHaveBeenCalledTimes(1)
    expect(h.pump.queued()).toBe(queuedBefore - 1)
    expect(useWorkspaceStore.getState().hidden.media).toBe(true)
    expect(document.getElementById('panel-media')).toBeNull()
    await act(async () => {
      await h.pump.pump(2)
    })
    expect(document.getElementById('panel-media')).toBeNull()
    expect(useWorkspaceStore.getState().sizes).toEqual({
      media: 32,
      source: 24,
      inspector: 26,
      timeline: 50,
      captions: 24,
    })
  })

  it('a Window checkbox hide during a pending reset clears the token and keeps the hide', async () => {
    const workspace = useWorkspaceStore.getState()
    useWorkspaceStore.setState({ sizes: { ...workspace.sizes, media: 36 } })
    renderShell()
    openWindowMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /reset workspace layout/i }))
    await waitFor(() =>
      expect(
        screen.queryByRole('menuitem', { name: /reset workspace layout/i }),
      ).not.toBeInTheDocument(),
    )
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame')
    const queuedBefore = h.pump.queued()
    expect(queuedBefore).toBeGreaterThan(0)
    openWindowMenu()
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Media' }))
    expect(cancelFrame).toHaveBeenCalledTimes(1)
    expect(h.pump.queued()).toBe(queuedBefore - 1)
    expect(useWorkspaceStore.getState().hidden.media).toBe(true)
    await act(async () => {
      await h.pump.pump(2)
    })
    expect(document.getElementById('panel-media')).toBeNull()
  })

  it('closes and reopens every panel through its menu and the Window menu', async () => {
    renderShell()
    const cases: Array<[string, string, string]> = [
      ['media', 'Media panel menu', 'Media'],
      ['source', 'Source Monitor panel menu', 'Source Monitor'],
      ['preview', 'Program Monitor panel menu', 'Program Monitor'],
      ['inspector', 'Inspector panel menu', 'Inspector'],
      ['timeline', 'Timeline panel menu', 'Timeline'],
      ['captions', 'Captions panel menu', 'Captions'],
    ]
    for (const [id, menuName, windowName] of cases) {
      openPanelMenu(id)
      selectClosePanel()
      expect(document.getElementById(`panel-${id}`)).toBeNull()
      expect(screen.queryByTestId(`panel-menu-${id}`)).not.toBeInTheDocument()
      openWindowMenu()
      fireEvent.click(screen.getByRole('menuitemcheckbox', { name: windowName }))
      expect(document.getElementById(`panel-${id}`)).not.toBeNull()
      // Reopening a panel can restore focus through queued Radix work; let it
      // settle before the next menu interaction.
      await waitFor(() => expect(screen.getByTestId(`panel-menu-${id}`)).toBeInTheDocument())
    }
  })

  it('hides the workspace column and keeps Inspector when the upper row is empty', () => {
    const workspace = useWorkspaceStore.getState()
    useWorkspaceStore.setState({
      hidden: { ...workspace.hidden, media: true, source: true, preview: true },
    })
    renderShell()
    expect(document.getElementById('panel-workspace')).toBeNull()
    expect(document.getElementById('panel-inspector')).not.toBeNull()
    expect(
      screen.queryByLabelText('Resize inspector panel (double-click to reset)'),
    ).not.toBeInTheDocument()
  })

  it('removes the upper row when its last panel closes', async () => {
    const workspace = useWorkspaceStore.getState()
    useWorkspaceStore.setState({
      hidden: { ...workspace.hidden, media: true, source: true, preview: true },
    })
    renderShell()
    openPanelMenu('inspector')
    selectClosePanel()
    await waitFor(() => expect(document.getElementById('panel-upper')).toBeNull())
    expect(document.getElementById('panel-bottom')).not.toBeNull()
  })

  it('removes the bottom row when Timeline and Captions close', () => {
    const workspace = useWorkspaceStore.getState()
    useWorkspaceStore.setState({
      hidden: { ...workspace.hidden, timeline: true, captions: true },
    })
    renderShell()
    expect(document.getElementById('panel-bottom')).toBeNull()
    expect(document.getElementById('panel-upper')).not.toBeNull()
  })

  it('moves focus to the DOM-next trigger after Close Panel', async () => {
    renderShell()
    const sourceTrigger = screen.getByTestId('panel-menu-source')
    const triggersBefore = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid^="panel-menu-"]'),
    )
    expect(triggersBefore.indexOf(sourceTrigger)).toBe(1)
    openPanelMenu('source')
    selectClosePanel()
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId('panel-menu-preview')),
    )
    // The catalog order would select Inspector, which is still mounted; this
    // proves the anchor is the trigger's DOM index.
    expect(screen.getByTestId('panel-menu-inspector')).toBeInTheDocument()
  })

  it('leaves Radix focus restoration intact for Escape', async () => {
    renderShell()
    const trigger = openPanelMenu('source')
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    await waitFor(() => expect(document.activeElement).toBe(trigger))
    expect(document.getElementById('panel-source')).not.toBeNull()
  })

  it('moves focus to the first trigger when the last panel closes and others remain', async () => {
    renderShell()
    const captionsTrigger = screen.getByTestId('panel-menu-captions')
    const triggers = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid^="panel-menu-"]'),
    )
    expect(triggers[triggers.length - 1]).toBe(captionsTrigger)
    openPanelMenu('captions')
    selectClosePanel()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('panel-menu-media')))
    expect(document.getElementById('panel-captions')).toBeNull()
    expect(screen.getByTestId('panel-menu-timeline')).toBeInTheDocument()
  })

  it('leaves Radix focus restoration intact for an outside click', async () => {
    renderShell()
    const trigger = openPanelMenu('source')
    // Radix attaches its document pointerdown listener on the next tick.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    fireEvent.pointerDown(document, {
      button: 0,
      buttons: 1,
      clientX: 5000,
      clientY: 5000,
      isPrimary: true,
      pointerId: 2,
      pointerType: 'mouse',
    })
    await waitFor(() =>
      expect(screen.queryByRole('menuitem', { name: /close panel/i })).not.toBeInTheDocument(),
    )
    await waitFor(() => expect(document.activeElement).toBe(trigger))
    expect(document.getElementById('panel-source')).not.toBeNull()
  })

  it('moves focus to the Window trigger when the last panel closes', async () => {
    useWorkspaceStore.setState({
      hidden: {
        media: false,
        preview: true,
        source: true,
        inspector: true,
        timeline: true,
        captions: true,
      },
    })
    renderShell()
    openPanelMenu('media')
    selectClosePanel()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('menubar-window')))
    expect(screen.getByTestId('workspace-empty')).toBeInTheDocument()
  })

  it('keeps the stored size when a panel is closed and reopened', async () => {
    const workspace = useWorkspaceStore.getState()
    useWorkspaceStore.setState({ sizes: { ...workspace.sizes, media: 36 } })
    renderShell()
    openPanelMenu('media')
    selectClosePanel()
    openWindowMenu()
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Media' }))
    await waitFor(() => expect(document.getElementById('panel-media')).not.toBeNull())
    expect(useWorkspaceStore.getState().sizes.media).toBe(36)
  })

  it('preserves the surviving panel DOM nodes across sibling closes', async () => {
    renderShell()
    const source = document.getElementById('panel-source')
    const preview = document.getElementById('panel-preview')
    openPanelMenu('media')
    selectClosePanel()
    expect(document.getElementById('panel-source')).toBe(source)
    expect(document.getElementById('panel-preview')).toBe(preview)

    openWindowMenu()
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Media' }))
    const media = document.getElementById('panel-media')
    openPanelMenu('source')
    selectClosePanel()
    expect(document.getElementById('panel-media')).toBe(media)
    expect(document.getElementById('panel-preview')).toBe(preview)

    const timeline = document.getElementById('panel-timeline')
    openWindowMenu()
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Captions' }))
    expect(document.getElementById('panel-timeline')).toBe(timeline)

    const inspector = document.getElementById('panel-inspector')
    const ws = useWorkspaceStore.getState()
    act(() => {
      useWorkspaceStore.setState({
        hidden: { ...ws.hidden, media: true, source: true, preview: true },
      })
    })
    expect(document.getElementById('panel-inspector')).toBe(inspector)
    act(() => {
      useWorkspaceStore.setState({ hidden: { ...ws.hidden, preview: true } })
    })
    expect(document.getElementById('panel-inspector')).toBe(inspector)
  })

  it('keeps the Program Monitor volume across a bottom-row close and reopen', async () => {
    renderShell()
    const slider = screen.getByRole('slider', { name: 'Master volume' })
    expect(slider).toHaveAttribute('aria-valuenow', '1')
    fireEvent.keyDown(slider, { key: 'ArrowLeft' })
    expect(slider).toHaveAttribute('aria-valuenow', '0.95')

    openPanelMenu('timeline')
    selectClosePanel()
    openPanelMenu('captions')
    selectClosePanel()
    expect(document.getElementById('panel-bottom')).toBeNull()
    expect(screen.getByRole('slider', { name: 'Master volume' })).toBe(slider)
    expect(slider).toHaveAttribute('aria-valuenow', '0.95')

    openWindowMenu()
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Timeline' }))
    await waitFor(() => expect(document.getElementById('panel-bottom')).not.toBeNull())
    expect(screen.getByRole('slider', { name: 'Master volume' })).toBe(slider)
    expect(slider).toHaveAttribute('aria-valuenow', '0.95')
  })

  it('preserves the bottom row DOM node across an upper-area close and reopen', async () => {
    renderShell()
    const bottom = document.getElementById('panel-bottom')
    expect(bottom).not.toBeNull()
    for (const id of ['media', 'source', 'preview', 'inspector'] as const) {
      openPanelMenu(id)
      selectClosePanel()
    }
    expect(document.getElementById('panel-upper')).toBeNull()
    expect(document.getElementById('panel-bottom')).toBe(bottom)

    openWindowMenu()
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Media' }))
    await waitFor(() => expect(document.getElementById('panel-upper')).not.toBeNull())
    expect(document.getElementById('panel-bottom')).toBe(bottom)
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

describe('decode recovery overlay', () => {
  it('renders skip and terminal copy, keeps only the latest notice, and dismisses', () => {
    render(<EditorShell />)

    act(() => {
      useEditorStore.getState().setMediaError({
        clipId: 'c1',
        code: 3,
        time: 118.4,
        skippedTo: 124.3,
        terminal: false,
      })
    })
    const overlay = screen.getByTestId('media-decode-overlay')
    expect(overlay).toHaveTextContent('Skipped damaged media')
    expect(overlay).toHaveTextContent('from 01:58.4 to 02:04.3')
    expect(overlay).toHaveTextContent('The browser could not decode that section.')
    expect(overlay).not.toHaveTextContent('Chrome')

    act(() => {
      useEditorStore.getState().setMediaError({
        clipId: 'c2',
        code: 4,
        time: 10,
        terminal: true,
      })
    })
    expect(screen.getByTestId('media-decode-overlay')).toHaveTextContent('Damaged media')
    expect(screen.getByTestId('media-decode-overlay')).toHaveTextContent('around 00:10.0')
    expect(screen.getByTestId('media-decode-overlay')).toHaveTextContent(
      'the browser cannot decode',
    )

    act(() => {
      useEditorStore.getState().setMediaError({
        clipId: 'a1',
        code: 3,
        time: 1,
        skippedTo: 2,
        terminal: false,
      })
    })
    expect(screen.getByTestId('media-decode-overlay')).toHaveTextContent('media')
    expect(screen.getByTestId('media-decode-overlay')).not.toHaveTextContent('video')

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByTestId('media-decode-overlay')).not.toBeInTheDocument()
  })
})

describe('track lock notice (0.14.0)', () => {
  it('surfaces the command message for a refused dispatch and keeps the doc', async () => {
    const asset = createMediaAsset({ kind: 'video', duration: 10, name: 'x.mp4' })
    const track = createTrack('video', 1, { id: 'lv', locked: true })
    track.clips = [createClip({ id: 'lc', mediaId: asset.id, start: 0, duration: 2, inPoint: 0 })]
    const doc: Doc = {
      project: {
        tracks: [track],
        id: 'p_lock_notice',
        name: 'lock',
        width: 1920,
        height: 1080,
        fps: 30,
      },
      media: [asset],
    }
    useEditorStore.setState({ doc })

    render(
      <>
        <EditorShell />
        <Toaster />
      </>,
    )
    act(() => {
      useEditorStore.getState().apply({ type: 'deleteClip', clipId: 'lc' })
    })
    expect(
      await screen.findByText('Track V1 is locked. Unlock it to edit its clips.'),
    ).toBeInTheDocument()
    expect(useEditorStore.getState().doc.project.tracks[0].clips).toHaveLength(1)
  })
})
