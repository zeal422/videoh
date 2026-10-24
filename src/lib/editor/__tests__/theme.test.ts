import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { DEFAULT_THEME, readTheme, THEMES, THEME_STORAGE_KEY, writeTheme } from '../theme'
import { WORKSPACE_STORAGE_KEY } from '../workspace'

/**
 * Theme wiring regression locks.
 *
 * The editor is dark-themed, but every Radix portal (menubar dropdowns,
 * dialogs, selects, toasts) mounts at document.body, OUTSIDE any in-app
 * wrapper div. The `.dark` class must therefore live on `<html>` itself
 * (src/app/layout.tsx), or portaled surfaces silently fall back to the light
 * `:root` tokens and render white.
 *
 * Native widgets (number-input spin buttons, scrollbars, checkboxes, date
 * pickers) are painted by the browser according to the CSS `color-scheme`
 * property, so `.dark` must also declare `color-scheme: dark`; otherwise the
 * Inspector's number spinners render with white chrome.
 *
 * Appearance palettes ride on top of `.dark` as `:root[data-palette]` blocks.
 * The palette, token-set, and contrast assertions are intentionally static:
 * jsdom does not apply stylesheets, so the source contract is the only reliable
 * lock. The contrast math follows the same OKLCH to sRGB conversion the plan
 * records, including clipping the out-of-gamut destructive fills.
 */

/** Tests run from the project root (vitest cwd). */
const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

const REQUIRED_PALETTE_TOKENS = [
  'background',
  'foreground',
  'card',
  'card-foreground',
  'popover',
  'popover-foreground',
  'primary',
  'primary-foreground',
  'secondary',
  'secondary-foreground',
  'muted',
  'muted-foreground',
  'accent',
  'accent-foreground',
  'border',
  'input',
  'ring',
] as const

function storageOf(value?: string) {
  const entries = new Map<string, string>()
  if (value !== undefined) entries.set(THEME_STORAGE_KEY, value)
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, next: string) => {
      entries.set(key, next)
    },
    removeItem: (key: string) => {
      entries.delete(key)
    },
  }
}

function paletteBlocks() {
  return [
    ...read('src/app/globals.css').matchAll(/:root\[data-palette='([\w-]+)'\]\s*\{([^}]*)\}/g),
  ].map((match) => ({ id: match[1], body: match[2] }))
}

function tokenValues(body: string) {
  const values = new Map<string, string>()
  for (const match of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) {
    values.set(match[1], match[2].trim())
  }
  return values
}

function tokenDeclarations(body: string) {
  return [...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((match) => match[1])
}

function oklchToSrgb(L: number, C: number, H: number): [number, number, number] {
  const radians = (H * Math.PI) / 180
  const a = C * Math.cos(radians)
  const b = C * Math.sin(radians)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
  return linear.map((channel) => {
    const magnitude = Math.abs(channel)
    const encoded =
      magnitude <= 0.0031308 ? 12.92 * magnitude : 1.055 * magnitude ** (1 / 2.4) - 0.055
    return Math.sign(channel) * encoded
  }) as [number, number, number]
}

function parseOklch(value: string): [number, number, number] {
  const match = value.match(/oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)/)
  if (!match) throw new Error(`not an oklch colour: ${value}`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function clipSrgb([r, g, b]: [number, number, number]): [number, number, number] {
  const clip = (channel: number) => Math.min(1, Math.max(0, channel))
  return [clip(r), clip(g), clip(b)]
}

function luminance([r, g, b]: [number, number, number]) {
  const linear = (channel: number) => {
    const magnitude = Math.abs(channel)
    return magnitude <= 0.04045 ? magnitude / 12.92 : ((magnitude + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

function contrast(a: [number, number, number], b: [number, number, number]) {
  const first = luminance(a)
  const second = luminance(b)
  const high = Math.max(first, second)
  const low = Math.min(first, second)
  return (high + 0.05) / (low + 0.05)
}

describe('theme wiring', () => {
  it('applies the dark class to <html> so portals inherit dark tokens', () => {
    const layout = read('src/app/layout.tsx')
    // The html element itself must carry the theme; wrappers inside the tree
    // are not enough because Radix portals escape them via createPortal(body).
    expect(layout).toMatch(/<html[^>]*className="dark"/)
  })

  it('declares color-scheme: dark inside the .dark block for native widgets', () => {
    const css = read('src/app/globals.css')
    const darkBlock = css.match(/\.dark\s*\{([^}]*)\}/)
    expect(darkBlock, 'globals.css must define a .dark variable block').not.toBeNull()
    expect(darkBlock![1]).toMatch(/color-scheme:\s*dark/)
  })

  it('keeps portaled UI primitives on theme tokens (no hardcoded bg-white)', () => {
    // Menus/selects/dialogs must stay token-driven (bg-popover) so they follow
    // whatever theme <html> declares, never a hardcoded light surface.
    for (const file of [
      'src/components/ui/menubar.tsx',
      'src/components/ui/dropdown-menu.tsx',
      'src/components/ui/select.tsx',
      'src/components/ui/dialog.tsx',
    ]) {
      expect(read(file), `${file} must not hardcode bg-white`).not.toMatch(/bg-white\b/)
    }
  })

  it('declares and maps the destructive text token', () => {
    const css = read('src/app/globals.css')
    const root = css.match(/:root\s*\{([^}]*)\}/)?.[1] ?? ''
    const dark = css.match(/\.dark\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(root).toContain('--destructive-foreground: oklch(0.985 0 0)')
    expect(dark).toContain('--destructive-foreground: oklch(0.205 0 0)')
    expect(css).toContain('--color-destructive-foreground: var(--destructive-foreground)')
  })
})

describe('theme preference', () => {
  it('accepts only the listed ids and falls back to the default', () => {
    for (const theme of THEMES) {
      expect(readTheme(storageOf(theme.id)), theme.id).toBe(theme.id)
    }
    for (const raw of ['Midnight', '__proto__', '', '{"id":"midnight"}', 'midnight; color: red']) {
      expect(readTheme(storageOf(raw)), raw).toBe(DEFAULT_THEME)
    }
    expect(readTheme(null)).toBe(DEFAULT_THEME)
  })

  it('persists a non-default id and removes the key for the default', () => {
    const storage = storageOf()
    writeTheme(storage, 'forest')
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe('forest')
    writeTheme(storage, DEFAULT_THEME)
    expect(storage.getItem(THEME_STORAGE_KEY)).toBeNull()
  })

  it('degrades to the default on a failed read and never throws on a failed write', () => {
    const throwing = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
      removeItem: () => {
        throw new Error('denied')
      },
    }
    expect(readTheme(throwing)).toBe(DEFAULT_THEME)
    expect(() => writeTheme(throwing, 'plum')).not.toThrow()
  })

  it('uses a key separate from the workspace layout', () => {
    expect(THEME_STORAGE_KEY).not.toBe(WORKSPACE_STORAGE_KEY)
    expect(THEME_STORAGE_KEY).toBe('web-video-editor:theme:v1')
  })
})

describe('appearance palettes', () => {
  it('defines one block per non-default id, and none for the default', () => {
    const ids = paletteBlocks()
      .map((block) => block.id)
      .sort()
    const expected = THEMES.filter((theme) => theme.id !== DEFAULT_THEME)
      .map((theme) => theme.id)
      .sort()
    expect(ids).toEqual(expected)
  })

  it('declares every required token in each palette block', () => {
    for (const block of paletteBlocks()) {
      const names = [...tokenValues(block.body).keys()]
      expect(names, block.id).toEqual(expect.arrayContaining([...REQUIRED_PALETTE_TOKENS]))
    }
  })

  it('declares each required token exactly once in every palette block', () => {
    for (const block of paletteBlocks()) {
      const names = tokenDeclarations(block.body)
      expect(names, block.id).toHaveLength(REQUIRED_PALETTE_TOKENS.length)
      expect(new Set(names).size, block.id).toBe(REQUIRED_PALETTE_TOKENS.length)
    }
  })

  it('keeps palette borders and inputs at the fixed alpha whites', () => {
    for (const block of paletteBlocks()) {
      const tokens = tokenValues(block.body)
      expect(tokens.get('border'), block.id).toBe('oklch(1 0 0 / 10%)')
      expect(tokens.get('input'), block.id).toBe('oklch(1 0 0 / 15%)')
    }
  })

  it('declares no token outside the required set in a palette block', () => {
    for (const block of paletteBlocks()) {
      const unknown = [...tokenValues(block.body).keys()].filter(
        (name) => !(REQUIRED_PALETTE_TOKENS as readonly string[]).includes(name),
      )
      expect(unknown, block.id).toEqual([])
    }
  })

  it('keeps every palette above the contrast floors', () => {
    const floors: Array<[string, string, number]> = [
      ['foreground', 'background', 4.5],
      ['muted-foreground', 'background', 4.5],
      ['primary-foreground', 'primary', 4.5],
      ['ring', 'background', 3],
    ]
    for (const block of paletteBlocks()) {
      const tokens = tokenValues(block.body)
      const colours = new Map<string, [number, number, number]>()
      for (const [name, value] of tokens) {
        if (name === 'border' || name === 'input') continue
        const rgb = oklchToSrgb(...parseOklch(value))
        for (const channel of rgb) {
          expect(channel, `${block.id} ${name} in gamut`).toBeGreaterThanOrEqual(-1e-6)
          expect(channel, `${block.id} ${name} in gamut`).toBeLessThanOrEqual(1 + 1e-6)
        }
        colours.set(name, rgb)
      }
      for (const [foreground, background, floor] of floors) {
        expect(
          contrast(colours.get(foreground)!, colours.get(background)!),
          `${block.id} ${foreground}/${background}`,
        ).toBeGreaterThanOrEqual(floor)
      }
    }
  })

  it('keeps destructive text above the contrast floor in both blocks', () => {
    const css = read('src/app/globals.css')
    const blocks = {
      root: css.match(/:root\s*\{([^}]*)\}/)?.[1] ?? '',
      dark: css.match(/\.dark\s*\{([^}]*)\}/)?.[1] ?? '',
    }
    for (const [name, body] of Object.entries(blocks)) {
      const tokens = tokenValues(body)
      const fill = clipSrgb(oklchToSrgb(...parseOklch(tokens.get('destructive')!)))
      const text = oklchToSrgb(...parseOklch(tokens.get('destructive-foreground')!))
      expect(contrast(fill, text), `${name} destructive text`).toBeGreaterThanOrEqual(4.5)
    }
  })
})
