// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Editor boot locks: the preloader shows while the shell chunk loads, the
 * shell reveals after both the import and the 2.44s bloom-peak hold, and a
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
  return {
    default: ({ interactive }: { interactive?: boolean }) => (
      <div data-testid={SHELL_READY} data-interactive={String(interactive)}>
        shell
      </div>
    ),
  }
}

function stubMotionPreference(initial: boolean) {
  let reduced = initial
  const listeners = new Set<() => void>()
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return reduced && query.includes('prefers-reduced-motion: reduce')
    },
    media: query,
    onchange: null,
    addEventListener: (_event: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_event: string, cb: () => void) => listeners.delete(cb),
    addListener: (cb: () => void) => listeners.add(cb),
    removeListener: (cb: () => void) => listeners.delete(cb),
    dispatchEvent: () => false,
  }))
  return {
    setReduced(next: boolean) {
      reduced = next
      for (const cb of listeners) cb()
    },
  }
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
  it('holds the pull at 2.4s while the shell mounts, then exits on the bloom peak', async () => {
    const { EditorBoot, rtl } = await setup(stubShell)
    rtl.render(<EditorBoot />)
    expect(document.querySelector('[data-testid="preloader-stage"]')).not.toBeNull()
    expect(rtl.screen.queryByTestId(SHELL_READY)).toBeNull()
    // Flush the import while the pull is still running. The shell must not
    // mount until the pull reaches the 2.4s split.
    await rtl.act(async () => {})
    expect(rtl.screen.queryByTestId(SHELL_READY)).toBeNull()
    const veil = document.querySelector('[data-testid="preloader-veil"]')
    expect(veil).not.toHaveClass('preloader-hold')
    expect(veil).not.toHaveAttribute('data-exiting')
    await rtl.act(async () => {
      vi.advanceTimersByTime(2399)
    })
    expect(rtl.screen.queryByTestId(SHELL_READY)).toBeNull()
    await rtl.act(async () => {
      vi.advanceTimersByTime(1)
    })
    // The pull is frozen with the glow and line still active while the shell
    // mounts behind it.
    expect(veil).toHaveClass('preloader-hold')
    expect(rtl.screen.queryByTestId(SHELL_READY)).toBeNull()
    await rtl.act(async () => {
      vi.advanceTimersByTime(16)
    })
    const shell = rtl.screen.getByTestId(SHELL_READY)
    // The early mount must not take input or open the version greeting.
    expect(shell).toHaveAttribute('data-interactive', 'false')
    expect(veil).toHaveClass('preloader-hold')
    await rtl.act(async () => {
      vi.advanceTimersByTime(16)
    })
    // The mount has painted, so the pull resumes into the bloom peak.
    expect(veil).not.toHaveClass('preloader-hold')
    expect(veil).not.toHaveAttribute('data-exiting')
    await rtl.act(async () => {
      vi.advanceTimersByTime(37)
    })
    expect(veil).not.toHaveAttribute('data-exiting')
    await rtl.act(async () => {
      vi.advanceTimersByTime(1)
    })
    // The exit starts on the peak, with the shell already mounted.
    expect(veil).toHaveAttribute('data-exiting', 'true')
    expect(rtl.screen.getByTestId(SHELL_READY)).toBe(shell)
    await rtl.act(async () => {
      vi.advanceTimersByTime(999)
    })
    expect(document.querySelector('[data-testid="preloader-stage"]')).not.toBeNull()
    await rtl.act(async () => {
      vi.advanceTimersByTime(1)
    })
    expect(document.querySelector('[data-testid="preloader-stage"]')).toBeNull()
    // The shell is never remounted: the wrapper outlives the overlay, so
    // the mounted editor keeps its state through the handoff. Input and the
    // greeting unlock only at reveal.
    expect(rtl.screen.getByTestId(SHELL_READY)).toBe(shell)
    expect(shell).toHaveAttribute('data-interactive', 'true')
    rtl.cleanup()
  })

  it('measures the pull progress so hydration cannot add a dead hold', async () => {
    const original = Element.prototype.getAnimations
    const fake = { currentTime: 2000 } as Animation
    Object.defineProperty(Element.prototype, 'getAnimations', {
      configurable: true,
      value: () => [fake],
    })
    try {
      const { EditorBoot, rtl } = await setup(stubShell)
      rtl.render(<EditorBoot />)
      await rtl.act(async () => {})
      // The pull is 2s in, so the 2.4s hold is 400ms away, not the full 2400.
      const veil = document.querySelector('[data-testid="preloader-veil"]')
      await rtl.act(async () => {
        vi.advanceTimersByTime(399)
      })
      expect(veil).not.toHaveClass('preloader-hold')
      await rtl.act(async () => {
        vi.advanceTimersByTime(1)
      })
      expect(veil).toHaveClass('preloader-hold')
      rtl.cleanup()
    } finally {
      if (original) {
        Object.defineProperty(Element.prototype, 'getAnimations', {
          configurable: true,
          value: original,
        })
      } else {
        delete (Element.prototype as { getAnimations?: unknown }).getAnimations
      }
    }
  })

  it('skips the exit and reveals at 2.44s under reduced motion', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('prefers-reduced-motion: reduce'),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }))
    const { EditorBoot, rtl } = await setup(stubShell)
    rtl.render(<EditorBoot />)
    await rtl.act(async () => {})
    await rtl.act(async () => {
      vi.advanceTimersByTime(2438)
    })
    expect(rtl.screen.queryByTestId(SHELL_READY)).not.toBeNull()
    expect(document.querySelector('[data-testid="preloader-stage"]')).toBeNull()
    vi.unstubAllGlobals()
    rtl.cleanup()
  })

  it('spends the reduced-motion minimum show from the boot start, not after a slow import', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('prefers-reduced-motion: reduce'),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }))
    const { EditorBoot, rtl } = await setup(stubShell)
    rtl.render(<EditorBoot />)
    // The import microtask has not flushed yet, so the boot clock advances
    // first: the shell becomes ready one second in, and only the remainder
    // of the minimum show is left.
    vi.advanceTimersByTime(1000)
    await rtl.act(async () => {})
    expect(rtl.screen.queryByTestId(SHELL_READY)).toBeNull()
    await rtl.act(async () => {
      vi.advanceTimersByTime(1437)
    })
    expect(document.querySelector('[data-testid="preloader-stage"]')).not.toBeNull()
    await rtl.act(async () => {
      vi.advanceTimersByTime(1)
    })
    expect(rtl.screen.queryByTestId(SHELL_READY)).not.toBeNull()
    expect(document.querySelector('[data-testid="preloader-stage"]')).toBeNull()
    vi.unstubAllGlobals()
    rtl.cleanup()
  })

  it('follows a reduced-motion change during loading', async () => {
    const motion = stubMotionPreference(true)
    const { EditorBoot, rtl } = await setup(stubShell)
    rtl.render(<EditorBoot />)
    await rtl.act(async () => {})
    // Boot started under reduce; the user turns it off while the pull is
    // fresh. The strip timeline must take over instead of the reduced reveal.
    rtl.act(() => {
      motion.setReduced(false)
    })
    const veil = document.querySelector('[data-testid="preloader-veil"]')
    await rtl.act(async () => {
      vi.advanceTimersByTime(2399)
    })
    expect(veil).not.toHaveClass('preloader-hold')
    await rtl.act(async () => {
      vi.advanceTimersByTime(1)
    })
    expect(veil).toHaveClass('preloader-hold')
    await rtl.act(async () => {
      vi.advanceTimersByTime(16)
    })
    expect(rtl.screen.queryByTestId(SHELL_READY)).not.toBeNull()
    await rtl.act(async () => {
      vi.advanceTimersByTime(16)
    })
    await rtl.act(async () => {
      vi.advanceTimersByTime(37)
    })
    expect(veil).not.toHaveAttribute('data-exiting')
    await rtl.act(async () => {
      vi.advanceTimersByTime(1)
    })
    // The reduced-reveal timer is gone: the preloader is still up and the
    // strip exit has started, which only the full timeline does.
    expect(veil).toHaveAttribute('data-exiting', 'true')
    await rtl.act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(document.querySelector('[data-testid="preloader-stage"]')).toBeNull()
    expect(rtl.screen.queryByTestId(SHELL_READY)).not.toBeNull()
    vi.unstubAllGlobals()
    rtl.cleanup()
  })

  it('reveals at once when reduced motion is enabled during the exit', async () => {
    const motion = stubMotionPreference(false)
    const { EditorBoot, rtl } = await setup(stubShell)
    rtl.render(<EditorBoot />)
    await rtl.act(async () => {})
    const veil = document.querySelector('[data-testid="preloader-veil"]')
    // Normal timeline through the hold, mount, release, and bloom-peak exit.
    await rtl.act(async () => {
      vi.advanceTimersByTime(2400)
    })
    await rtl.act(async () => {
      vi.advanceTimersByTime(16)
    })
    const shell = rtl.screen.getByTestId(SHELL_READY)
    await rtl.act(async () => {
      vi.advanceTimersByTime(16)
    })
    await rtl.act(async () => {
      vi.advanceTimersByTime(38)
    })
    expect(veil).toHaveAttribute('data-exiting', 'true')
    expect(shell).toHaveAttribute('data-interactive', 'false')
    // The user asks for reduced motion mid-exit: the remaining strips stop
    // instead of holding the veil for the rest of the second.
    rtl.act(() => {
      motion.setReduced(true)
    })
    await rtl.act(async () => {
      vi.advanceTimersByTime(1)
    })
    expect(document.querySelector('[data-testid="preloader-veil"]')).toBeNull()
    expect(shell).toHaveAttribute('data-interactive', 'true')
    vi.unstubAllGlobals()
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
    expect(document.querySelector('[data-testid="preloader-stage"]')).toBeNull()
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
      vi.advanceTimersByTime(2438)
    })
    await rtl.act(async () => {
      vi.advanceTimersByTime(16)
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
