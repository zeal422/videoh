import { DEFAULT_THEME, type ThemeId } from '@/lib/editor/theme'

/**
 * Apply a palette to a root element.
 *
 * The default palette is the absence of the attribute, so the base `.dark`
 * tokens stay in charge rather than a `data-palette="default"` block.
 * `document` is referenced only at call time, which keeps this file out of the
 * state core while still usable from the boot effect and the dialog.
 */
export function applyTheme(id: ThemeId, root: HTMLElement = document.documentElement): void {
  if (id === DEFAULT_THEME) delete root.dataset.palette
  else root.dataset.palette = id
}

/**
 * The real localStorage, or null when the browser blocks the getter itself.
 * `readTheme`/`writeTheme` guard their methods, but evaluating
 * `window.localStorage` can throw before they run. The optional getter keeps
 * that failure path testable without stubbing the global.
 */
export function themeStorage(read: () => Storage = () => window.localStorage): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return read()
  } catch {
    return null
  }
}
