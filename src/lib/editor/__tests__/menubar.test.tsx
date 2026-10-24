// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { MenuBar } from '@/components/editor/MenuBar'
import { installBrowserMocks, type MockHarness } from './mocks/browser-mocks'
import { useEditorStore } from '../store'
import { CURRENT_VERSION } from '../../releases'
import { THEME_STORAGE_KEY } from '../theme'
import { createClip, createDoc, createMediaAsset, createTrack } from '../factories'

/**
 * Menu-bar regression locks: the scrollbar fix and the version label.
 *
 * Scrollbar: the menubar root is h-8 (32px) while the shadcn Menubar
 * primitive pads p-1 and each trigger stands h-7 (28px): 28 + 4 + 4 = 36px
 * of content in a 32px box. The 4px invisible overflow, combined with the
 * bar's overflow-x-auto (CSS promotes the other axis to auto), made Chromium
 * paint a native vertical scrollbar (with up/down arrows) at the right end
 * of the menu bar. The component must keep the primitive's vertical padding
 * collapsed (py-0) and force overflow-y-hidden so no scrollbar can appear.
 *
 * The static-on-purpose cases use the source contract (jsdom applies no
 * stylesheets and reports no scrollbars), the same method as theme.test.ts.
 */

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

describe('menubar scrollbar lock', () => {
  it('collapses the primitive vertical padding and hides the vertical overflow', () => {
    const src = read('src/components/editor/MenuBar.tsx')
    const bar = src.match(/<Menubar[^>]*aria-label="Application menu"[^>]*>/)
    expect(bar, 'the application Menubar root element').not.toBeNull()
    expect(bar![0]).toContain('h-8')
    expect(bar![0]).toContain('py-0')
    expect(bar![0]).toContain('overflow-y-hidden')
    expect(bar![0]).toContain('overflow-x-auto')
  })
})

describe('menubar version label', () => {
  let h: MockHarness

  beforeEach(() => {
    h = installBrowserMocks()
    // MenuBar reads the viewport hook for the Window toggles; jsdom has no
    // matchMedia (same stub as the shell suite).
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
    useEditorStore.setState(useEditorStore.getInitialState())
  })

  afterEach(() => {
    cleanup()
    h.uninstall()
  })

  it('shows the running version as a static muted label at the right edge', () => {
    render(
      <MenuBar onOpenExport={() => {}} onResetLayout={() => {}} onOpenReleaseNotes={() => {}} />,
    )
    const label = screen.getByTestId('menubar-version')
    // Value comes from the gate-locked releases.ts source (test 1 of
    // releases.test.ts ties it to package.json), not a hardcoded literal.
    expect(label).toHaveTextContent(`v${CURRENT_VERSION}`)
    expect(label.className).toContain('ml-auto')
    expect(label.className).toContain('text-muted-foreground')
    // Static: a plain span, not a button or a menu item.
    expect(label.tagName).toBe('SPAN')
  })
})

/**
 * Checkbox-row semantics: toggle rows render as plain items for flush-left
 * alignment, so the checked state must be carried by role + aria-checked
 * instead of the checkbox primitive. Mute is the Clip-menu instance.
 */
describe('menubar checkbox semantics', () => {
  let h: MockHarness

  beforeEach(() => {
    h = installBrowserMocks()
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
    useEditorStore.setState(useEditorStore.getInitialState())
  })

  afterEach(() => {
    cleanup()
    h.uninstall()
  })

  function audioDoc(muted: boolean) {
    const asset = createMediaAsset({ kind: 'audio', name: 'voice.mp3' })
    const clip = createClip({ mediaId: asset.id, muted })
    const track = createTrack('audio', 1, { clips: [clip] })
    const doc = createDoc()
    doc.media = [asset]
    doc.project.tracks = [track]
    return { doc, clip }
  }

  function renderBar() {
    render(
      <MenuBar onOpenExport={() => {}} onResetLayout={() => {}} onOpenReleaseNotes={() => {}} />,
    )
  }

  it('exposes Mute as a menuitemcheckbox reflecting the unmuted state', async () => {
    const { doc, clip } = audioDoc(false)
    useEditorStore.setState({ doc, selections: [clip.id], selection: clip.id })
    renderBar()
    await userEvent.setup().click(screen.getByText('Clip'))
    expect(screen.getByRole('menuitemcheckbox', { name: /Mute/ })).toHaveAttribute(
      'aria-checked',
      'false',
    )
  })

  it('reports aria-checked true when the selected audio is muted', async () => {
    const { doc, clip } = audioDoc(true)
    useEditorStore.setState({ doc, selections: [clip.id], selection: clip.id })
    renderBar()
    await userEvent.setup().click(screen.getByText('Clip'))
    expect(screen.getByRole('menuitemcheckbox', { name: /Mute/ })).toHaveAttribute(
      'aria-checked',
      'true',
    )
  })
})

/** Sequence > Sequence Settings opens a modal over the project settings. */
describe('sequence settings dialog', () => {
  let h: MockHarness

  beforeEach(() => {
    h = installBrowserMocks()
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
    useEditorStore.setState(useEditorStore.getInitialState())
  })

  afterEach(() => {
    cleanup()
    h.uninstall()
  })

  function renderBar() {
    render(
      <MenuBar onOpenExport={() => {}} onResetLayout={() => {}} onOpenReleaseNotes={() => {}} />,
    )
  }

  async function openSettings() {
    await userEvent.setup().click(screen.getByText('Sequence'))
    await userEvent.setup().click(screen.getByText(/Sequence Settings/))
  }

  it('opens prefilled with the current project values', async () => {
    renderBar()
    await openSettings()
    expect(screen.getByRole('dialog', { name: 'Sequence Settings' })).toBeInTheDocument()
    expect(screen.getByLabelText('Name')).toHaveValue('Untitled Project')
    expect(screen.getByLabelText('Width (px)')).toHaveValue(1920)
    expect(screen.getByLabelText('Height (px)')).toHaveValue(1080)
    expect(screen.getByLabelText('Frame rate (fps)')).toHaveValue(30)
  })

  it('OK commits the change as a single undo step', async () => {
    renderBar()
    await openSettings()
    fireEvent.change(screen.getByLabelText('Width (px)'), { target: { value: '1280' } })
    await userEvent.setup().click(screen.getByText('OK'))
    const state = useEditorStore.getState()
    expect(state.doc.project.width).toBe(1280)
    expect(state.past).toHaveLength(1)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('Cancel discards the draft', async () => {
    renderBar()
    await openSettings()
    fireEvent.change(screen.getByLabelText('Height (px)'), { target: { value: '720' } })
    await userEvent.setup().click(screen.getByText('Cancel'))
    const state = useEditorStore.getState()
    expect(state.doc.project.height).toBe(1080)
    expect(state.past).toHaveLength(0)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

/** View > Appearance opens the palette dialog and applies a selection at once. */
describe('appearance dialog', () => {
  let h: MockHarness

  beforeEach(() => {
    h = installBrowserMocks()
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
    useEditorStore.setState(useEditorStore.getInitialState())
  })

  afterEach(() => {
    cleanup()
    h.uninstall()
    window.localStorage.clear()
    delete document.documentElement.dataset.palette
  })

  it('opens from View and applies the selected palette', async () => {
    render(
      <MenuBar onOpenExport={() => {}} onResetLayout={() => {}} onOpenReleaseNotes={() => {}} />,
    )
    await userEvent.setup().click(screen.getByText('View'))
    await userEvent.setup().click(screen.getByText('Appearance…'))
    expect(screen.getByRole('dialog', { name: 'Appearance' })).toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('radio', { name: 'Midnight' }))
    expect(document.documentElement.dataset.palette).toBe('midnight')
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('midnight')
  })
})
