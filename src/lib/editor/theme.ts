/**
 * Appearance palettes: the allowlisted ids, their labels, and the persisted
 * preference.
 *
 * This module is pure and browser-free. Storage is injected, so Node tests can
 * exercise validation and the boot/dialog callers pass `window.localStorage`.
 */

export const THEME_STORAGE_KEY = 'web-video-editor:theme:v1'

export const THEMES = [
  { id: 'default', label: 'Default' },
  { id: 'midnight', label: 'Midnight' },
  { id: 'forest', label: 'Forest' },
  { id: 'plum', label: 'Plum' },
] as const satisfies readonly { id: string; label: string }[]

export type ThemeId = (typeof THEMES)[number]['id']

export const DEFAULT_THEME: ThemeId = 'default'

function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && THEMES.some((theme) => theme.id === value)
}

/** Read the stored palette. Missing, invalid, or unreadable values mean default. */
export function readTheme(storage?: Pick<Storage, 'getItem'> | null): ThemeId {
  if (!storage) return DEFAULT_THEME
  try {
    const stored = storage.getItem(THEME_STORAGE_KEY)
    return isThemeId(stored) ? stored : DEFAULT_THEME
  } catch {
    return DEFAULT_THEME
  }
}

/**
 * Persist a palette. The default removes the key so "no key" and "default"
 * are one state. Failures are swallowed; losing an appearance preference is
 * not fatal, and a storage error must never escape into a click handler.
 */
export function writeTheme(
  storage: Pick<Storage, 'setItem' | 'removeItem'> | null | undefined,
  id: ThemeId,
): void {
  if (!storage) return
  try {
    if (id === DEFAULT_THEME) storage.removeItem(THEME_STORAGE_KEY)
    else storage.setItem(THEME_STORAGE_KEY, id)
  } catch {
    // Ignore write failures.
  }
}
