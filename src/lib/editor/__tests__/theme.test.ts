import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Theme wiring regression locks.
 *
 * The editor is permanently dark-themed, but every Radix portal (menubar
 * dropdowns, dialogs, selects, toasts) mounts at document.body —
 * OUTSIDE any in-app wrapper div. The `.dark` class must therefore live on
 * `<html>` itself (src/app/layout.tsx), or portaled surfaces silently fall
 * back to the light `:root` tokens and render white.
 *
 * Native widgets (number-input spin buttons, scrollbars, checkboxes, date
 * pickers) are painted by the browser according to the CSS `color-scheme`
 * property, so `.dark` must also declare `color-scheme: dark` — otherwise the
 * Inspector's number spinners render with white chrome.
 *
 * These tests are intentionally static: jsdom does not apply stylesheets, so
 * the only reliable way to keep this wiring from regressing is to lock the
 * source-level contract.
 */

/** Tests run from the project root (vitest cwd). */
const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

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
    // whatever theme <html> declares — never a hardcoded light surface.
    for (const file of [
      'src/components/ui/menubar.tsx',
      'src/components/ui/dropdown-menu.tsx',
      'src/components/ui/select.tsx',
      'src/components/ui/dialog.tsx',
    ]) {
      expect(read(file), `${file} must not hardcode bg-white`).not.toMatch(/bg-white\b/)
    }
  })
})
