// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Editor boot locks: the preloader shows while the shell chunk loads, the
 * shell reveals after both the import and the 3.2s minimum show, and a
 * rejected chunk import surfaces a retry that re-imports on click.
 *
 * Each test rebuilds the module registry (resetModules), registers its own
 * EditorShell mock, then imports EditorBoot AND the renderer from that same
 * fresh registry. Importing the renderer statically while the boot component
 * comes from a reset registry would pair two React instances (probe-verified:
 * post-reset dynamic import re-evaluates react); sharing the registry keeps
 * one. Timer control stays on the global fake clock.
 */

const SHELL_READY = 'shell-ready'

type Rtl = typeof import('@testing-library/react')

let cleanupRtl: (() => void) | null = null

async function setup(mockEditorShell: () => { default: unknown }) {
  vi.resetModules()
  vi.doMock('@/components/editor/EditorShell', mockEditorShell)
  const rtl: Rtl = await import('@testing-library/react')
  const EditorBoot = (await import('@/components/editor/EditorBoot')).EditorBoot
  // Unmount even when an assertion fails, so a failed case cannot leave a
  // mounted preloader and its pending timer behind for the next test.
  cleanupRtl = rtl.cleanup
  return { EditorBoot, rtl }
}

function stubShell() {
  return { default: () => <div data-testid={SHELL_READY}>shell</div> }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanupRtl?.()
  cleanupRtl = null
  vi.useRealTimers()
  window.localStorage.clear()
  delete document.documentElement.dataset.palette
})

describe('editor boot', () => {
  it('shows the preloader, then reveals the shell after import and min-show', async () => {
    const { EditorBoot, rtl } = await setup(stubShell)
    rtl.render(<EditorBoot />)
    expect(document.querySelector('[data-testid="preloader-grid"]')).not.toBeNull()
    expect(rtl.screen.queryByTestId(SHELL_READY)).toBeNull()
    // Flush the import while the 3.2s timer is still pending: the shell
    // must stay hidden until the min-show elapses, not appear on import.
    await rtl.act(async () => {})
    expect(rtl.screen.queryByTestId(SHELL_READY)).toBeNull()
    await rtl.act(async () => {
      vi.advanceTimersByTime(3199)
    })
    expect(rtl.screen.queryByTestId(SHELL_READY)).toBeNull()
    await rtl.act(async () => {
      vi.advanceTimersByTime(1)
    })
    expect(rtl.screen.queryByTestId(SHELL_READY)).not.toBeNull()
    expect(document.querySelector('[data-testid="preloader-grid"]')).toBeNull()
    rtl.cleanup()
  })

  it('applies a stored palette on boot', async () => {
    const { EditorBoot, rtl } = await setup(stubShell)
    const { THEME_STORAGE_KEY } = await import('@/lib/editor/theme')
    window.localStorage.setItem(THEME_STORAGE_KEY, 'midnight')
    rtl.render(<EditorBoot />)
    await rtl.act(async () => {})
    expect(document.documentElement.dataset.palette).toBe('midnight')
    rtl.cleanup()
  })

  it('shows a recoverable error when the chunk import rejects', async () => {
    const { EditorBoot, rtl } = await setup(() => {
      throw new Error('chunk failed')
    })
    rtl.render(<EditorBoot />)
    await rtl.act(async () => {})
    expect(rtl.screen.getByRole('alert')).toHaveTextContent('The editor failed to load.')
    expect(rtl.screen.getByRole('button', { name: 'Try again' })).not.toBeNull()
    expect(document.querySelector('[data-testid="preloader-grid"]')).toBeNull()
    rtl.cleanup()
  })

  it('retry re-imports and reveals the shell', async () => {
    let calls = 0
    const { EditorBoot, rtl } = await setup(() => {
      calls += 1
      if (calls === 1) throw new Error('chunk failed')
      return stubShell()
    })
    rtl.render(<EditorBoot />)
    await rtl.act(async () => {})
    expect(rtl.screen.getByRole('alert')).not.toBeNull()
    rtl.act(() => {
      rtl.screen.getByRole('button', { name: 'Try again' }).click()
    })
    await rtl.act(async () => {
      vi.advanceTimersByTime(3200)
    })
    expect(rtl.screen.queryByTestId(SHELL_READY)).not.toBeNull()
    rtl.cleanup()
  })

  it('shows a reload fallback after a retry also fails', async () => {
    const { EditorBoot, rtl } = await setup(() => {
      throw new Error('chunk failed')
    })
    rtl.render(<EditorBoot />)
    await rtl.act(async () => {})
    expect(rtl.screen.queryByRole('button', { name: 'Reload page' })).toBeNull()
    const reload = vi.fn()
    vi.stubGlobal('location', { reload })
    rtl.act(() => {
      rtl.screen.getByRole('button', { name: 'Try again' }).click()
    })
    await rtl.act(async () => {})
    expect(rtl.screen.getByRole('button', { name: 'Reload page' })).not.toBeNull()
    rtl.act(() => {
      rtl.screen.getByRole('button', { name: 'Reload page' }).click()
    })
    expect(reload).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
    rtl.cleanup()
  })
})
