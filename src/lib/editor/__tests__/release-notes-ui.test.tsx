// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { ReleaseNotesModal } from '@/components/editor/ReleaseNotesModal'
import { MenuBar } from '@/components/editor/MenuBar'
import { EditorShell } from '@/components/editor/EditorShell'
import { installBrowserMocks, type MockHarness } from './mocks/browser-mocks'
import { useEditorStore } from '../store'
import { createDoc } from '../factories'
import { serializeDoc } from '../serialization'
import { CURRENT_VERSION, releases } from '../../releases'

/**
 * jsdom locks for the welcome-modal feature (0.5.6): the modal renders the
 * release data with chips and stagger classes, the Help menu entry opens it,
 * and EditorShell auto-opens it once per new version only after the restore
 * prompt is gone.
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
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
  h.uninstall()
})

describe('ReleaseNotesModal render', () => {
  it('shows the last five versions with chips and at least four bullets each', () => {
    render(<ReleaseNotesModal open onOpenChange={() => {}} />)

    const shown = releases.slice(0, 5)
    for (const r of shown) {
      expect(screen.getByTestId(`release-chip-${r.version}`)).toHaveTextContent(`v${r.version}`)
    }
    // One bullet per highlight across all shown blocks, so each version
    // carries at least four (the gate lock enforces the minimum in data).
    const bullets = screen.getAllByRole('listitem')
    expect(bullets).toHaveLength(shown.reduce((n, r) => n + r.highlights.length, 0))
    for (const r of shown) {
      expect(screen.getByText(r.highlights[0])).toBeInTheDocument()
    }
    expect(screen.getByText(releases[0].highlights[0])).toBeInTheDocument()
  })

  it('the latest version chip is highlighted and carries the New badge', () => {
    render(<ReleaseNotesModal open onOpenChange={() => {}} />)
    const latest = screen.getByTestId(`release-chip-${releases[0].version}`)
    expect(latest.className).toContain('bg-emerald-500')
    const older = screen.getByTestId(`release-chip-${releases[1].version}`)
    expect(older.className).not.toContain('bg-emerald-500')
    expect(screen.getByText('New')).toBeInTheDocument()
  })

  it('every stagger class is motion-safe so reduced motion renders instantly', () => {
    // Radix portals the dialog into document.body, so query the document,
    // not the container.
    render(<ReleaseNotesModal open onOpenChange={() => {}} />)
    const blocks = document.querySelectorAll('section')
    expect(blocks.length).toBe(5)
    for (const block of blocks) {
      const cls = (block as HTMLElement).className
      expect(cls).toContain('motion-safe:animate-in')
      expect(cls).not.toMatch(/(^|\s)animate-in/)
    }
  })

  it('closed state renders nothing', () => {
    render(<ReleaseNotesModal open={false} onOpenChange={() => {}} />)
    expect(screen.queryByTestId('release-notes-modal')).toBeNull()
  })
})

describe('Help menu entry point', () => {
  function openHelp() {
    const help = screen.getByRole('menuitem', { name: 'Help' })
    // Radix menus open via pointerdown + pointerup with pointerType mouse.
    fireEvent.pointerDown(help, { button: 0, pointerType: 'mouse' })
    fireEvent.pointerUp(help, { pointerType: 'mouse' })
  }

  it('opens the release-notes modal from the Help menu', async () => {
    // The single modal instance lives in EditorShell; MenuBar only raises the
    // request. Render both together exactly like the real shell does.
    let notesOpen = false
    const openNotes = () => {
      notesOpen = true
      rerenderShell()
    }
    function Shell() {
      return (
        <>
          <MenuBar
            onOpenExport={() => {}}
            onResetLayout={() => {}}
            onOpenReleaseNotes={openNotes}
          />
          <ReleaseNotesModal open={notesOpen} onOpenChange={() => {}} />
        </>
      )
    }
    const view = render(<Shell />)
    function rerenderShell() {
      view.rerender(<Shell />)
    }
    openHelp()

    const label = `What's new in ${CURRENT_VERSION}…`
    const entry = await waitFor(() => screen.getByRole('menuitem', { name: label }))
    // The release-notes row is the tinted one: light emerald at rest, deeper
    // green when highlighted; other rows keep the neutral accent.
    expect(entry.className).toContain('bg-emerald-500/15')
    expect(entry.className).toContain('focus:bg-emerald-500/25')
    expect(screen.getByRole('menuitem', { name: 'Keyboard Shortcuts…' }).className).not.toContain(
      'bg-emerald-500',
    )
    fireEvent.click(entry)

    await waitFor(() => expect(screen.getByTestId('release-notes-modal')).toBeInTheDocument())
  })
})

describe('once-per-version auto-open in EditorShell', () => {
  it('greets a fresh visitor after the restore prompt resolves and records the version', async () => {
    render(<EditorShell />)
    // No pending restore: the modal opens on mount.
    await waitFor(() => expect(screen.getByTestId('release-notes-modal')).toBeInTheDocument())
    expect(window.localStorage.getItem('releases:lastSeen')).toBe(CURRENT_VERSION)
  })

  it('does not greet twice: a recorded version stays silent', async () => {
    window.localStorage.setItem('releases:lastSeen', CURRENT_VERSION)
    render(<EditorShell />)
    // Give the effect a tick, then assert the modal never appeared.
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByTestId('release-notes-modal')).toBeNull()
  })

  it('holds the greeting while a restore is pending, then opens after it clears', async () => {
    useEditorStore.setState({ pendingRestore: '{}' })
    const { rerender } = render(<EditorShell />)
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByTestId('release-notes-modal')).toBeNull()

    // The user discards (or restores): pendingRestore clears, the effect reruns.
    useEditorStore.setState({ pendingRestore: null })
    rerender(<EditorShell />)
    await waitFor(() => expect(screen.getByTestId('release-notes-modal')).toBeInTheDocument())
  })

  it('an unknown recorded version (older app) greets again', async () => {
    window.localStorage.setItem('releases:lastSeen', '0.1.0')
    render(<EditorShell />)
    await waitFor(() => expect(screen.getByTestId('release-notes-modal')).toBeInTheDocument())
    expect(window.localStorage.getItem('releases:lastSeen')).toBe(CURRENT_VERSION)
  })

  it('greets only AFTER the autosave scan finished, never over a discovered restore', async () => {
    // The regression: the mount effect that discovers the autosave and the
    // greeting effect share one commit, so the greeting effect used its stale
    // pendingRestore (null) closure and greeted BEFORE the restore banner was
    // raised, recording lastSeen over a session the user was about to restore.
    // The lock: a valid autosave in storage, NOTHING pre-set on the store.
    window.localStorage.setItem(
      'web-video-editor:autosave:v1',
      JSON.stringify(serializeDoc(createDoc())),
    )

    render(<EditorShell />)

    // The restore banner is up (from the scan, not from a pre-set state).
    await waitFor(() =>
      expect(
        screen.getByText('Found an autosaved session from your last visit.'),
      ).toBeInTheDocument(),
    )
    // And the greeting never fired while it waits.
    expect(screen.queryByTestId('release-notes-modal')).toBeNull()
    expect(window.localStorage.getItem('releases:lastSeen')).toBeNull()

    // Discard resolves the prompt; only then does the greeting open.
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    await waitFor(() => expect(screen.getByTestId('release-notes-modal')).toBeInTheDocument())
    expect(window.localStorage.getItem('releases:lastSeen')).toBe(CURRENT_VERSION)
  })
})
