// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { EditorShell } from '@/components/editor/EditorShell'
import { installBrowserMocks, type MockHarness } from './mocks/browser-mocks'
import { isTransientActive, useEditorStore } from '../store'
import { createClip, createMediaAsset, createTrack } from '../factories'
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
