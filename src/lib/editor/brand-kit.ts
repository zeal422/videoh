/**
 * brand-kit.ts: pure validation and palette helpers for the project brand kit
 * (0.26.0).
 *
 * Only strict `#rrggbb` hex values are accepted. `rgb()`, `url()`, CSS
 * variables, and every other CSS form are rejected at the command and
 * hydration boundaries, so a brand color is always safe to assign to a canvas
 * or an input value.
 */

import { BRAND_COLOR_NAME_MAX, BRAND_COLORS_MAX, BRAND_FONT_FAMILIES_MAX } from './constants'
import { sanitizeFontFamily } from './fonts'
import { isShapeHexColor } from './shapes'
import type { BrandColor, BrandKit } from './types'

/** Brand color ids are opaque project-scoped keys. */
export function isValidBrandColorId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 96 &&
    /^[A-Za-z0-9_-]+$/.test(value)
  )
}

/** A display name from any trust boundary: trimmed, bounded, no control chars. */
export function sanitizeBrandColorName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const name = raw.trim()
  if (!name || name.length > BRAND_COLOR_NAME_MAX) return undefined
  if (/[\u0000-\u001f\u007f]/.test(name)) return undefined
  return name
}

/** `#rrggbb` only, normalized to lowercase so duplicate checks fold case. */
export function brandColorValue(raw: unknown): string | undefined {
  if (!isShapeHexColor(raw)) return undefined
  return raw.toLowerCase()
}

/** Validates one serialized or command-payload brand color. */
export function sanitizeBrandColor(raw: unknown): BrandColor | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const entry = raw as Record<string, unknown>
  if (!isValidBrandColorId(entry.id)) return undefined
  const name = sanitizeBrandColorName(entry.name)
  if (!name) return undefined
  const value = brandColorValue(entry.value)
  if (!value) return undefined
  return { id: entry.id, name, value }
}

/** The next available generated name ("Color 1", "Color 2", ...). */
export function nextBrandColorName(colors: readonly BrandColor[]): string {
  const taken = new Set(colors.map((color) => color.name.toLowerCase()))
  let index = 1
  while (taken.has(`color ${index}`)) index += 1
  return `Color ${index}`
}

/**
 * Hydration-side validation. Never throws: unusable entries are dropped, a
 * later duplicate id or value loses to the first one, names are trimmed, and
 * the palette and font list are capped. The caller logs one warning for the
 * dropped count so a hostile file does not shrink silently.
 */
export function sanitizeBrandKit(raw: unknown): { kit?: BrandKit; dropped: number } {
  if (typeof raw !== 'object' || raw === null) return { dropped: 0 }
  const entry = raw as Record<string, unknown>
  let dropped = 0
  const colors: BrandColor[] = []
  const ids = new Set<string>()
  const values = new Set<string>()
  if (Array.isArray(entry.colors)) {
    for (const rawColor of entry.colors) {
      const color = sanitizeBrandColor(rawColor)
      if (!color) {
        dropped += 1
        continue
      }
      if (ids.has(color.id) || values.has(color.value) || colors.length >= BRAND_COLORS_MAX) {
        dropped += 1
        continue
      }
      ids.add(color.id)
      values.add(color.value)
      colors.push(color)
    }
  } else if (entry.colors !== undefined) {
    dropped += 1
  }

  const fontFamilies: string[] = []
  if (Array.isArray(entry.fontFamilies)) {
    const seen = new Set<string>()
    for (const rawFamily of entry.fontFamilies) {
      const family = sanitizeFontFamily(rawFamily)
      if (!family) {
        dropped += 1
        continue
      }
      const key = family.toLowerCase()
      if (seen.has(key) || fontFamilies.length >= BRAND_FONT_FAMILIES_MAX) {
        dropped += 1
        continue
      }
      seen.add(key)
      fontFamilies.push(family)
    }
  } else if (entry.fontFamilies !== undefined) {
    dropped += 1
  }

  if (colors.length === 0 && fontFamilies.length === 0) return { dropped }
  return {
    kit: {
      colors,
      ...(fontFamilies.length > 0 ? { fontFamilies } : {}),
    },
    dropped,
  }
}
