// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, cleanup, render, screen } from '@testing-library/react'

import { Preloader } from '@/components/editor/Preloader'

/**
 * Preloader locks: the wordmark focus pull and its strip exit.
 *
 * Three copies of "videoh" share one grid cell: a white master and rose/blue
 * ghosts. The ghosts start scaled, rotated, and soft, then settle into the
 * sharp mark while the focus brackets and distance needle arrive. The settled
 * lockup is drawn once per uneven band, so the handoff can feather and slide
 * the same screen apart without a remount. Rendered assertions cover DOM
 * facts jsdom can see; keyframes, fixed colors, the container-sized stage,
 * the one-shot exit, and the reduced-motion lockup are static-source
 * assertions because jsdom applies no stylesheets and runs no animations.
 */

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')
const css = () => read('src/app/globals.css')
const source = () => read('src/components/editor/Preloader.tsx')

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('preloader wordmark', () => {
  it('draws one white mark and two ghosts in each of the six bands', () => {
    render(<Preloader />)
    const bands = Array.from(document.querySelectorAll('[data-testid="preloader-band"]'))
    expect(bands).toHaveLength(6)
    for (const band of bands) {
      const white = band.querySelector('[data-testid="preloader-word"]')
      const ghosts = Array.from(band.querySelectorAll('[data-testid="preloader-ghost"]'))
      expect(white).toHaveTextContent('videoh')
      expect(ghosts.map((ghost) => ghost.textContent)).toEqual(['videoh', 'videoh'])
      // The white copy is last in source order, so it paints over the ghosts.
      expect(
        ghosts.every(
          (ghost) => ghost.compareDocumentPosition(white!) & Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      ).toBe(true)
    }
  })

  it('tiles the frame with six uneven bands that alternate their exit', () => {
    render(<Preloader />)
    const bands = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="preloader-band"]'),
    )
    const style = (band: HTMLElement, name: string) => band.style.getPropertyValue(name)
    expect(bands.map((band) => style(band, '--preloader-top'))).toEqual([
      '0%',
      '12%',
      '28%',
      '50%',
      '76%',
      '90%',
    ])
    expect(bands.map((band) => style(band, '--preloader-bottom'))).toEqual([
      '88%',
      '72%',
      '50%',
      '24%',
      '10%',
      '0%',
    ])
    expect(bands.map((band) => style(band, '--preloader-x'))).toEqual([
      '-6%',
      '6%',
      '-6%',
      '6%',
      '-6%',
      '6%',
    ])
    expect(bands.map((band) => style(band, '--preloader-delay'))).toEqual([
      '0s',
      '0.03s',
      '0.06s',
      '0.09s',
      '0.12s',
      '0.15s',
    ])
  })

  it('exposes the one-shot exit only when the handoff starts', () => {
    const { container, rerender } = render(<Preloader />)
    const veil = container.querySelector('[data-testid="preloader-veil"]')
    expect(veil).not.toHaveClass('preloader-exit')
    expect(veil).not.toHaveAttribute('data-exiting')
    const stage = container.querySelector('[data-testid="preloader-stage"]')
    rerender(<Preloader exiting />)
    expect(veil).toHaveClass('preloader-exit')
    expect(veil).toHaveAttribute('data-exiting', 'true')
    // Flipping the flag animates the existing bands; it does not remount them.
    expect(container.querySelector('[data-testid="preloader-stage"]')).toBe(stage)
  })

  it('hides the decorative stage and keeps a screen-reader-only label outside it', () => {
    render(<Preloader />)
    const stage = document.querySelector('[data-testid="preloader-stage"]')
    expect(stage).toHaveAttribute('aria-hidden', 'true')
    const label = screen.getByText('Loading editor')
    expect(label.className).toMatch(/sr-only/)
    expect(stage).not.toContainElement(label)
  })

  it('renders the focus brackets, the distance scale, the rule, and the loading label', () => {
    render(<Preloader />)
    const band = document.querySelector('[data-testid="preloader-band"]')
    expect(band?.querySelectorAll('[data-testid="preloader-brackets"] i')).toHaveLength(4)
    expect(band?.querySelector('[data-testid="preloader-scale"] .preloader-needle')).not.toBeNull()
    expect(band?.querySelector('[data-testid="preloader-rule"]')).not.toBeNull()
    const labels = Array.from(document.querySelectorAll('.preloader-label'))
    expect(labels).toHaveLength(6)
    expect(labels.every((label) => label.textContent === 'LOADING...')).toBe(true)
  })

  it('centers the word under the scale and lets the ellipsis trail', () => {
    render(<Preloader />)
    const band = document.querySelector('[data-testid="preloader-band"]')
    const label = band?.querySelector<HTMLElement>('.preloader-label')
    const dots = label?.querySelector<HTMLElement>('.preloader-label-dots')
    expect(label?.textContent).toBe('LOADING...')
    // The dots are out of flow, so the label box centers the visible word
    // instead of the wider LOADING... string. The needle lands on the word.
    const directText = Array.from(label?.childNodes ?? [])
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent)
      .join('')
    expect(directText).toBe('LOADING')
    expect(dots).toHaveTextContent('...')
    const sourceCss = css()
    expect(sourceCss).toMatch(
      /\.preloader-label-dots\s*{[^}]*position:\s*absolute[^}]*left:\s*100%[^}]*text-indent:\s*0/,
    )
  })

  it('freezes the pull on hold without remounting it', () => {
    const { container, rerender } = render(<Preloader />)
    const veil = container.querySelector('[data-testid="preloader-veil"]')
    expect(veil).not.toHaveClass('preloader-hold')
    const stage = container.querySelector('[data-testid="preloader-stage"]')
    rerender(<Preloader hold />)
    expect(veil).toHaveClass('preloader-hold')
    expect(container.querySelector('[data-testid="preloader-stage"]')).toBe(stage)
    const sourceCss = css()
    expect(sourceCss).toMatch(
      /\.preloader-hold \.preloader-rule\s*{[^}]*animation-play-state:\s*paused/,
    )
  })

  it('no longer renders the retired ripple grid', () => {
    render(<Preloader />)
    expect(document.querySelector('[data-testid="preloader-grid"]')).toBeNull()
    expect(document.querySelectorAll('[data-testid="preloader-cell"]')).toHaveLength(0)
  })

  it('never remounts or retimes after mount', () => {
    render(<Preloader />)
    const before = document.querySelector('[data-testid="preloader-stage"]')
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(document.querySelector('[data-testid="preloader-stage"]')).toBe(before)
  })
})

describe('preloader statics', () => {
  it('defines the white mark focus pull', () => {
    const sourceCss = css()
    expect(sourceCss).toContain('@keyframes preloader-word')
    expect(sourceCss).toMatch(/scale\(0?\.9\)/)
    expect(sourceCss).toContain('scale(0.96)')
    expect(sourceCss).toContain('blur(0.35cqw)')
    expect(sourceCss).toContain('preloader-word 2.56s')
  })

  it('retimes the pull tail 5x onto a 2.56s pull', () => {
    const sourceCss = css()
    expect(sourceCss).not.toContain('preloader-word 3.2s')
    expect(sourceCss.match(/animation: preloader-[a-z-]+ 2\.56s/g)).toHaveLength(8)
    const wordFrame = sourceCss.slice(
      sourceCss.indexOf('@keyframes preloader-word'),
      sourceCss.indexOf('@keyframes preloader-ghost-rose'),
    )
    // 2.4s / 2.56s = 93.75%: the depth convergence lands there, and the
    // remaining 6.25% runs in 0.16s instead of the old 0.8s.
    expect(wordFrame).toContain('93.75%')
    expect(wordFrame).toMatch(/93\.75%\s*{[^}]*transform:\s*scale\(1\)/)
    const split = 0.9375 * 2.56
    expect(split).toBeGreaterThan(2.39)
    expect(split).toBeLessThan(2.41)
    // The bloom peaks at 95.25%, and the strip exit starts there at 2438ms,
    // so the handoff carries the flash instead of starting after it faded.
    const bloomFrame = sourceCss.slice(
      sourceCss.indexOf('@keyframes preloader-bloom'),
      sourceCss.indexOf('@keyframes preloader-brackets'),
    )
    expect(bloomFrame).toContain('95.25%')
    expect(bloomFrame).toMatch(/95\.25%\s*{[^}]*opacity:\s*0\.55/)
    const peak = 0.9525 * 2.56
    expect(peak).toBeGreaterThan(2.43)
    expect(peak).toBeLessThan(2.45)
  })

  it('defines the rose ghost with its start pose and fixed color', () => {
    const sourceCss = css()
    expect(sourceCss).toContain('@keyframes preloader-ghost-rose')
    expect(sourceCss).toContain('scale(1.34)')
    expect(sourceCss).toContain('rotate(-2.6deg)')
    expect(sourceCss).toContain('blur(0.85cqw)')
    expect(sourceCss).toContain('#fb7185')
  })

  it('defines the blue ghost with its start pose and fixed color', () => {
    const sourceCss = css()
    expect(sourceCss).toContain('@keyframes preloader-ghost-blue')
    expect(sourceCss).toContain('scale(1.22)')
    expect(sourceCss).toContain('rotate(2deg)')
    expect(sourceCss).toContain('blur(0.7cqw)')
    expect(sourceCss).toContain('#2d5bff')
  })

  it('defines the focus rig keyframes for the brackets, needle, rule, and bloom', () => {
    const sourceCss = css()
    expect(sourceCss).toContain('@keyframes preloader-brackets')
    expect(sourceCss).toContain('@keyframes preloader-needle')
    expect(sourceCss).toContain('@keyframes preloader-rule')
    expect(sourceCss).toContain('@keyframes preloader-bloom')
    expect(sourceCss).toContain('translateX(-10cqw)')
    expect(sourceCss).toContain('width: 58cqw')
  })

  it('sizes the stage as a 16:9 container with a 13cqw mark', () => {
    const sourceCss = css()
    expect(sourceCss).toContain('container-type: inline-size')
    expect(sourceCss).toMatch(/min\(88vw,\s*760px,\s*150dvh\)/)
    expect(sourceCss).toContain('aspect-ratio: 16 / 9')
    expect(sourceCss).toContain('font-size: 13cqw')
  })

  it('gates the pull behind no-preference and shows a settled lockup under reduce', () => {
    const sourceCss = css()
    expect(sourceCss).toMatch(/@media\s*\(prefers-reduced-motion:\s*no-preference\)/)
    expect(sourceCss).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/)
    expect(sourceCss).toMatch(/\.preloader-word\s*{[^}]*opacity:\s*1/)
    expect(sourceCss).toMatch(
      /\.preloader-ghost-rose,\s*\.preloader-ghost-blue\s*{[^}]*opacity:\s*0/,
    )
    const block = sourceCss.slice(
      sourceCss.indexOf('/* ----- Boot preloader'),
      sourceCss.indexOf('/* A clip dragged over a lane'),
    )
    expect(block).not.toContain('infinite')
    expect(block).toContain('1 forwards')
    const wordFrame = block.slice(
      block.indexOf('@keyframes preloader-word'),
      block.indexOf('@keyframes preloader-ghost-rose'),
    )
    expect(wordFrame).not.toMatch(/opacity:\s*0;/)
    expect(wordFrame).toContain('opacity: 1')
    expect(wordFrame).not.toContain('scale(0.985)')
    expect(wordFrame).not.toContain('scale(1.01)')
  })

  it('removes the old ripple and hue loop from the stylesheet', () => {
    const sourceCss = css()
    expect(sourceCss).not.toContain('@keyframes ripple')
    expect(sourceCss).not.toContain('ripple-cell')
    expect(sourceCss).not.toContain('hue-travel')
    expect(sourceCss).not.toContain('@property --b')
  })

  it('feathers and slides the six bands once with no loop', () => {
    const sourceCss = css()
    expect(sourceCss).toContain('@property --preloader-sedge')
    expect(sourceCss).toContain('@keyframes preloader-band-out')
    expect(sourceCss).toContain('preloader-band-out 1s cubic-bezier(0.4, 0, 0.2, 1)')
    expect(sourceCss).toContain('--preloader-sedge: 2%')
    expect(sourceCss).toMatch(/\.preloader-exit \.preloader-band\s*{[^}]*1\s+forwards/)
    expect(sourceCss).toMatch(
      /clip-path: inset\(var\(--preloader-top\) 0 var\(--preloader-bottom\) 0\)/,
    )
    expect(sourceCss).toContain('mask-image: linear-gradient(')
    expect(sourceCss).toContain('translateX(var(--preloader-x)) scaleX(1.02)')
  })

  it('racks the editor in while the soft vignette clears', () => {
    const sourceCss = css()
    expect(sourceCss).toContain('@keyframes preloader-editor-rack')
    expect(sourceCss).toContain('@keyframes preloader-vignette-out')
    expect(sourceCss).toContain('filter: blur(1.4vw)')
    expect(sourceCss).toContain('transform: scale(1.03)')
    expect(sourceCss).toContain(".preloader-editor-rack[data-exiting='true']")
    expect(sourceCss).toMatch(/preloader-editor-rack 1s cubic-bezier/)
  })

  it('hides the exit under reduced motion instead of animating it', () => {
    const sourceCss = css()
    expect(sourceCss).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*{\s*\.preloader-exit \.preloader-band,\s*\.preloader-exit \.preloader-vignette\s*{[^}]*opacity:\s*0/,
    )
  })

  it('keeps the component stateless and the visible label inside the hidden stage', () => {
    const src = source()
    expect(src).toContain('preloader-stage')
    expect(src).toContain("'LOADING'")
    expect(src).toContain('preloader-label-dots')
    expect(src).toContain('Loading editor')
    expect(src).not.toMatch(/\b(useState|useEffect|setTimeout|setInterval)\b/)
  })
})
