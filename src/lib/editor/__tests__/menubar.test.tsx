// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { MenuBar } from '@/components/editor/MenuBar'
import { Toaster } from '@/components/ui/toaster'
import { useEditorKeyboard } from '@/hooks/editor/useEditorKeyboard'
import { playbackRef } from '@/lib/editor/playback/engine-ref'
import { installBrowserMocks, type MockHarness } from './mocks/browser-mocks'
import { useEditorStore } from '../store'
import { CURRENT_VERSION } from '../../releases'
import { THEME_STORAGE_KEY } from '../theme'
import { createClip, createDoc, createMediaAsset, createTrack } from '../factories'

/**
 * Menu-bar regression locks: the scrollbar fix, the version label, and the
 * fullscreen button.
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
    const right = screen.getByTestId('menubar-right')
    const menubar = screen.getByRole('menubar')
    const button = screen.getByTestId('menubar-fullscreen')
    // Value comes from the version-locked releases.ts source (test 1 of
    // releases.test.ts ties it to package.json), not a hardcoded literal.
    expect(label).toHaveTextContent(`v${CURRENT_VERSION}`)
    expect(label.className).toContain('text-muted-foreground')
    // Static: a plain span, not a button or a menu item.
    expect(label.tagName).toBe('SPAN')
    // The right group sits outside role=menubar, button first, version last.
    expect(menubar.nextElementSibling).toBe(right)
    expect(right.firstElementChild).toBe(button)
    expect(button.nextElementSibling).toBe(label)
    expect(label).toBe(right.lastElementChild)
    expect(menubar).not.toContainElement(button)
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

/**
 * Fullscreen: a native button outside role=menubar, driven by the page
 * Fullscreen API and kept in sync by fullscreenchange. Failures report
 * through the existing destructive toast instead of silently doing nothing.
 */
describe('menubar fullscreen button', () => {
  let h: MockHarness
  let fullscreenElement: Element | null
  let requestFullscreen: ReturnType<typeof vi.fn>
  let exitFullscreen: ReturnType<typeof vi.fn>
  let originalFullscreenElement: PropertyDescriptor | undefined
  let originalRequestFullscreen: PropertyDescriptor | undefined
  let originalExitFullscreen: PropertyDescriptor | undefined

  function restoreProperty(
    target: object,
    key: string,
    descriptor: PropertyDescriptor | undefined,
  ) {
    if (descriptor) Object.defineProperty(target, key, descriptor)
    else Reflect.deleteProperty(target, key)
  }

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

    fullscreenElement = null
    requestFullscreen = vi.fn(() => Promise.resolve())
    exitFullscreen = vi.fn(() => Promise.resolve())
    originalFullscreenElement = Object.getOwnPropertyDescriptor(document, 'fullscreenElement')
    originalRequestFullscreen = Object.getOwnPropertyDescriptor(
      document.documentElement,
      'requestFullscreen',
    )
    originalExitFullscreen = Object.getOwnPropertyDescriptor(document, 'exitFullscreen')

    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => fullscreenElement,
    })
    Object.defineProperty(document.documentElement, 'requestFullscreen', {
      configurable: true,
      value: requestFullscreen,
    })
    Object.defineProperty(document, 'exitFullscreen', {
      configurable: true,
      value: exitFullscreen,
    })
  })

  afterEach(() => {
    cleanup()
    h.uninstall()
    vi.restoreAllMocks()
    restoreProperty(document, 'fullscreenElement', originalFullscreenElement)
    restoreProperty(document.documentElement, 'requestFullscreen', originalRequestFullscreen)
    restoreProperty(document, 'exitFullscreen', originalExitFullscreen)
    playbackRef.current = null
  })

  function setFullscreenElement(element: Element | null) {
    fullscreenElement = element
    act(() => {
      document.dispatchEvent(new Event('fullscreenchange'))
    })
  }

  function KeyboardHarness() {
    useEditorKeyboard(() => {})
    return (
      <MenuBar onOpenExport={() => {}} onResetLayout={() => {}} onOpenReleaseNotes={() => {}} />
    )
  }

  function renderBar({
    withToaster = false,
    withKeyboard = false,
  }: {
    withToaster?: boolean
    withKeyboard?: boolean
  } = {}) {
    return render(
      <>
        {withKeyboard ? (
          <KeyboardHarness />
        ) : (
          <MenuBar onOpenExport={() => {}} onResetLayout={() => {}} onOpenReleaseNotes={() => {}} />
        )}
        {withToaster && <Toaster />}
      </>,
    )
  }

  it('places the fullscreen button before the version at h-5', () => {
    renderBar()
    const button = screen.getByTestId('menubar-fullscreen')
    const version = screen.getByTestId('menubar-version')
    const right = screen.getByTestId('menubar-right')

    expect(button.tagName).toBe('BUTTON')
    expect(button).toHaveAccessibleName('Full screen')
    expect(button).toHaveClass('h-5')
    expect(right.firstElementChild).toBe(button)
    expect(button.nextElementSibling).toBe(version)
    expect(version).toBe(right.lastElementChild)
    expect(screen.getByTestId('fullscreen-enter-icon')).toBeInTheDocument()
    expect(screen.queryByTestId('fullscreen-exit-icon')).not.toBeInTheDocument()
  })

  it('keeps native button semantics outside the menubar and activates on Enter and Space', async () => {
    const toggle = vi.fn()
    playbackRef.current = { toggle } as unknown as typeof playbackRef.current
    renderBar({ withKeyboard: true })
    const user = userEvent.setup()
    const button = screen.getByTestId('menubar-fullscreen')

    expect(button.tagName).toBe('BUTTON')
    expect(screen.getByRole('menubar')).not.toContainElement(button)
    button.focus()
    expect(button).toHaveFocus()

    await user.keyboard('{Enter}')
    await waitFor(() => expect(requestFullscreen).toHaveBeenCalledTimes(1))
    await user.keyboard(' ')
    await waitFor(() => expect(requestFullscreen).toHaveBeenCalledTimes(2))
    // The focused button owns Space, so the editor playback shortcut did not run.
    expect(toggle).not.toHaveBeenCalled()

    // With no button focused, Space still reaches the editor's play/pause map.
    fireEvent.keyDown(window, { key: ' ' })
    expect(toggle).toHaveBeenCalledTimes(1)
  })

  it('enters fullscreen and swaps the label and icon on fullscreenchange', async () => {
    renderBar()
    const button = screen.getByTestId('menubar-fullscreen')

    await userEvent.setup().click(button)
    expect(requestFullscreen).toHaveBeenCalledTimes(1)
    expect(button).toHaveAccessibleName('Full screen')

    setFullscreenElement(document.documentElement)
    expect(button).toHaveAccessibleName('Exit full screen')
    expect(screen.getByTestId('fullscreen-exit-icon')).toBeInTheDocument()
    expect(screen.queryByTestId('fullscreen-enter-icon')).not.toBeInTheDocument()
    expect(exitFullscreen).not.toHaveBeenCalled()
  })

  it('exits fullscreen and restores the resting state', async () => {
    fullscreenElement = document.documentElement
    renderBar()
    const button = screen.getByTestId('menubar-fullscreen')

    expect(button).toHaveAccessibleName('Exit full screen')
    await userEvent.setup().click(button)
    expect(exitFullscreen).toHaveBeenCalledTimes(1)
    expect(requestFullscreen).not.toHaveBeenCalled()

    setFullscreenElement(null)
    expect(button).toHaveAccessibleName('Full screen')
    expect(screen.getByTestId('fullscreen-enter-icon')).toBeInTheDocument()
  })

  it('tracks external fullscreen changes without a click', () => {
    renderBar()
    const button = screen.getByTestId('menubar-fullscreen')

    setFullscreenElement(document.documentElement)
    expect(button).toHaveAccessibleName('Exit full screen')
    setFullscreenElement(null)
    expect(button).toHaveAccessibleName('Full screen')
    expect(requestFullscreen).not.toHaveBeenCalled()
    expect(exitFullscreen).not.toHaveBeenCalled()
  })

  it('shows the Action failed toast when the request rejects', async () => {
    requestFullscreen.mockRejectedValueOnce(new Error('Fullscreen request rejected in test'))
    renderBar({ withToaster: true })
    const button = screen.getByTestId('menubar-fullscreen')

    await userEvent.setup().click(button)
    expect(requestFullscreen).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('Fullscreen request rejected in test')).toBeInTheDocument()
    expect(button).toHaveAccessibleName('Full screen')
    expect(screen.queryByTestId('fullscreen-exit-icon')).not.toBeInTheDocument()
  })

  it('shows the Action failed toast when the API is missing', async () => {
    Object.defineProperty(document.documentElement, 'requestFullscreen', {
      configurable: true,
      value: undefined,
    })
    renderBar({ withToaster: true })
    const button = screen.getByTestId('menubar-fullscreen')

    await userEvent.setup().click(button)
    expect(
      await screen.findByText('Full screen is not available in this browser.'),
    ).toBeInTheDocument()
    expect(button).toHaveAccessibleName('Full screen')
    expect(exitFullscreen).not.toHaveBeenCalled()
  })

  it('shows the Action failed toast when the exit API is missing', async () => {
    fullscreenElement = document.documentElement
    Object.defineProperty(document, 'exitFullscreen', {
      configurable: true,
      value: undefined,
    })
    renderBar({ withToaster: true })
    const button = screen.getByTestId('menubar-fullscreen')

    await userEvent.setup().click(button)
    expect(
      await screen.findByText('Exit full screen is not available in this browser.'),
    ).toBeInTheDocument()
    expect(button).toHaveAccessibleName('Exit full screen')
    expect(requestFullscreen).not.toHaveBeenCalled()
    expect(exitFullscreen).not.toHaveBeenCalled()
    expect(screen.getByTestId('fullscreen-exit-icon')).toBeInTheDocument()
  })

  it('ignores a second click while the first request is pending', async () => {
    let resolveRequest!: () => void
    requestFullscreen.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveRequest = resolve
        }),
    )
    renderBar()
    const button = screen.getByTestId('menubar-fullscreen')

    fireEvent.click(button)
    fireEvent.click(button)
    expect(requestFullscreen).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveRequest()
      await Promise.resolve()
    })
    await userEvent.setup().click(button)
    expect(requestFullscreen).toHaveBeenCalledTimes(2)
  })

  it('removes the fullscreenchange listener on unmount', () => {
    const removeSpy = vi.spyOn(document, 'removeEventListener')
    const { unmount } = renderBar()

    unmount()
    expect(removeSpy).toHaveBeenCalledWith('fullscreenchange', expect.any(Function))
  })
})
