// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, cleanup, render, screen } from '@testing-library/react'

import { DELAY_STEP, RIPPLE_MS, Preloader } from '@/components/editor/Preloader'

/**
 * Preloader locks: the 10x10 boot ripple grid.
 *
 * One seamless center-out wave: delay is distance from the grid center, so
 * the component is stateless and the grid never remounts after mount.
 * Rendered assertions cover DOM facts jsdom can see (cell count, inline
 * delays, aria, node identity across timer advances). Wave shape, keyframes,
 * and the @property registration are static-source or pure-function
 * assertions, the same method as menubar.test.tsx (jsdom applies no
 * stylesheets and runs no animations).
 */

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

/** Mid-flash offset inside the 1.6s schedule: flat-top lobe spans 6.25% to 18.75% (0.1s to 0.3s). */
const MID_FLASH_OFFSET = 0.2

function cells() {
  return Array.from(document.querySelectorAll('[data-testid="preloader-cell"]'))
}

function delay(el: Element): number {
  return parseFloat((el as HTMLElement).style.animationDelay)
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('preloader grid', () => {
  it('renders exactly 100 cells', () => {
    render(<Preloader />)
    expect(cells()).toHaveLength(100)
  })

  it('hides the grid from assistive tech and keeps a screen-reader-only label', () => {
    render(<Preloader />)
    expect(document.querySelector('[data-testid="preloader-grid"]')).toHaveAttribute(
      'aria-hidden',
      'true',
    )
    const label = screen.getByText('Loading editor')
    expect(label.className).toMatch(/sr-only/)
  })

  it('opens at the center and closes at the corners inside one 1.6s cycle', () => {
    render(<Preloader />)
    const all = cells()
    const at = (r: number, c: number) => delay(all[r * 10 + c])
    expect(at(4, 4)).toBeLessThan(at(4, 0))
    expect(at(4, 0)).toBeLessThan(at(0, 0))
    expect(at(0, 0)).toBeCloseTo(1.2, 6)
    expect(at(4, 4) + MID_FLASH_OFFSET).toBeCloseTo(0.33, 2)
    expect(at(0, 0) + MID_FLASH_OFFSET).toBeCloseTo(1.4, 2)
  })

  it('rises smoothly with distance, never in stepped zones', () => {
    render(<Preloader />)
    const all = cells()
    const at = (r: number, c: number) => delay(all[r * 10 + c])
    const outward = [at(4, 4), at(4, 3), at(4, 2), at(4, 1), at(4, 0)]
    for (let i = 1; i < outward.length; i++) {
      expect(outward[i]).toBeGreaterThan(outward[i - 1])
    }
    // Adjacent cells differ by under 0.2s everywhere; the old zone steps
    // jumped 0.4s, so this fails on any stepped map.
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 10; c++) {
        if (c + 1 < 10) expect(Math.abs(at(r, c + 1) - at(r, c))).toBeLessThan(0.2)
        if (r + 1 < 10) expect(Math.abs(at(r + 1, c) - at(r, c))).toBeLessThan(0.2)
      }
    }
  })

  it('keeps 180-degree rotational pairs on identical delays', () => {
    render(<Preloader />)
    const all = cells()
    for (const [r, c] of [
      [0, 1],
      [2, 7],
      [4, 4],
    ]) {
      expect(delay(all[r * 10 + c])).toBeCloseTo(delay(all[(9 - r) * 10 + (9 - c)]), 6)
    }
  })

  it('fits the whole wave inside one 1.6s cycle', () => {
    expect(RIPPLE_MS).toBe(1600)
    expect(DELAY_STEP).toBeCloseTo(1.2 / Math.hypot(4.5, 4.5), 12)
    render(<Preloader />)
    const all = cells()
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 10; c++) {
        expect(delay(all[r * 10 + c])).toBeLessThan(1.6)
      }
    }
  })

  it('never remounts or retimes after mount', () => {
    render(<Preloader />)
    const before = document.querySelector('[data-testid="preloader-grid"]')
    const delaysBefore = cells().map(delay)
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(document.querySelector('[data-testid="preloader-grid"]')).toBe(before)
    expect(cells().map(delay)).toEqual(delaysBefore)
  })
})

describe('preloader statics', () => {
  it('feathers the grid edges with a radial mask', () => {
    render(<Preloader />)
    expect(document.querySelector('[data-testid="preloader-grid"]')?.className).toContain(
      'ripple-feather',
    )
    const css = read('src/app/globals.css')
    expect(css).toContain('@utility ripple-feather')
    expect(css).toContain(
      'mask-image: radial-gradient(circle at center, black 40%, transparent 85%)',
    )
  })

  it('paints dim-by-default violet cells, dim even without @property', () => {
    const src = read('src/components/editor/Preloader.tsx').replace(/\s+/g, '')
    expect(src).toContain('hsl(270,100%,50%)')
    // Without the fallback, a browser lacking @property drops the whole
    // calc and the cells render fully bright instead of dim.
    expect(src).toContain('var(--b,0)')
  })

  it('defines the flat-top lobe keyframes in globals.css', () => {
    const css = read('src/app/globals.css')
    expect(css).toContain('@keyframes ripple')
    expect(css).toContain('0%')
    expect(css).toContain('6.25%')
    expect(css).toContain('18.75%')
    expect(css).toContain('25%')
    expect(css).toContain('100%')
    expect(css).toContain('--b: 1')
  })

  it('registers the custom property with syntax, inherits, and initial value', () => {
    const css = read('src/app/globals.css')
    expect(css).toContain('@property --b')
    expect(css).toContain("syntax: '<number>'")
    expect(css).toContain('inherits: false')
    expect(css).toContain('initial-value: 0')
  })

  it('loops the hue wheel on the grid wrapper over 4.8s', () => {
    const css = read('src/app/globals.css')
    expect(css).toContain('@keyframes hue-travel')
    expect(css).toContain('hue-rotate(360deg)')
    expect(css).toContain('hue-travel 4.8s linear infinite')
    render(<Preloader />)
    const grid = document.querySelector('[data-testid="preloader-grid"]')
    expect(grid?.parentElement?.className).toContain('motion-safe:hue-travel')
  })

  it('prefixes every animation class motion-safe with no bare fallback', () => {
    const src = read('src/components/editor/Preloader.tsx')
    expect(src).toContain('motion-safe:ripple-cell')
    expect(src).toContain('motion-safe:hue-travel')
    expect(src).not.toMatch(/(^|[^:\w-])ripple-cell/)
    expect(src).not.toMatch(/(^|[^:\w-])hue-travel/)
    expect(src).not.toContain('preloader-enter')
    expect(read('src/app/globals.css')).not.toContain('preloader-enter')
  })
})
