/**
 * fonts.ts: pure metadata and validation for the custom font library (0.25.0).
 *
 * A project font is metadata only; its bytes live in OPFS under the project's
 * font namespace, keyed by `contentHash`. The CSS family is generated from the
 * font id (never from the display name) and is immutable, so renaming a font
 * leaves every `TextStyle.fontFamily` reference resolving. Hydration and the
 * command layer share these validators: a CSS family string crosses into
 * canvas, so a crafted project cannot install one.
 *
 * Browser-bound loading and byte storage live in `media/font-store.ts`.
 */

import {
  FONT_FILE_MAX_BYTES,
  FONT_NAME_MAX,
  FONT_WEIGHT_DEFAULT,
  FONT_WEIGHT_MAX,
  FONT_WEIGHT_MIN,
} from './constants'
import { isValidContentHash } from './project-validation'
import type { ProjectFont } from './types'

/** A built-in system family shown above project fonts in the picker. */
export interface BuiltinFont {
  family: string
  label: string
}

/**
 * System families offered without upload. The default text style already uses
 * `Arial, sans-serif`, so existing projects keep rendering exactly as before.
 */
export const BUILTIN_FONTS: readonly BuiltinFont[] = [
  { family: 'Arial, sans-serif', label: 'Arial' },
  { family: 'Georgia, serif', label: 'Georgia' },
  { family: '"Times New Roman", Times, serif', label: 'Times New Roman' },
  { family: '"Courier New", Courier, monospace', label: 'Courier New' },
  { family: 'Verdana, sans-serif', label: 'Verdana' },
  { family: 'Impact, sans-serif', label: 'Impact' },
  { family: '"Trebuchet MS", sans-serif', label: 'Trebuchet MS' },
  { family: '"Comic Sans MS", cursive, sans-serif', label: 'Comic Sans MS' },
]

/** The fixed shape of a generated font id. */
export const FONT_ID_PATTERN = /^font_[A-Za-z0-9_-]{1,96}$/

/** The generated family prefix; the rest of the family is the font id. */
export const FONT_FAMILY_PREFIX = 'videoh-font-'

/** File picker accept value for the upload dialog. */
export const FONT_FILE_ACCEPT = '.woff2,.woff,.ttf,.otf,font/woff2,font/woff,font/ttf,font/otf'

export type FontFormat = 'woff2' | 'woff' | 'ttf' | 'otf'

export function isValidFontId(value: unknown): value is string {
  return typeof value === 'string' && FONT_ID_PATTERN.test(value)
}

/**
 * The One generated family token for a font id. `FontFace` is constructed with
 * this bare token; `fontFamilyForId` appends the fallback stack for the style
 * string that canvas and the Inspector use. Keeping the two forms separate is
 * what lets the face answer the first family in that stack.
 */
export function fontFaceFamily(id: string): string {
  return `${FONT_FAMILY_PREFIX}${id}`
}

/**
 * The one generated family string for a font id. The fallback stack after the
 * generated token is what makes a missing font render as Arial instead of a
 * browser-dependent default.
 */
export function fontFamilyForId(id: string): string {
  return `${fontFaceFamily(id)}, Arial, sans-serif`
}

/** True when `family` names a built-in option. */
export function isBuiltinFontFamily(family: string): boolean {
  return BUILTIN_FONTS.some((font) => font.family === family)
}

/**
 * A safe CSS font-family stack. The value is interpolated into a canvas
 * `font` shorthand, never into a stylesheet, but a restricted grammar still
 * rejects control characters, semicolons, braces, and parentheses (so no
 * `url(...)` or `var(...)`), and caps the length. Unknown families are allowed:
 * an old project may name an installed system font this build does not list.
 */
export function sanitizeFontFamily(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const family = value.trim()
  if (family.length === 0 || family.length > 200) return undefined
  if (/[\u0000-\u001f\u007f]/.test(family)) return undefined
  if (!/^[A-Za-z0-9\s,'"._-]+$/.test(family)) return undefined
  return family
}

/**
 * Parses a CSS font-family stack into unquoted, lowercased family tokens.
 * Canvas resolves family names case-insensitively, and a reference may change
 * its fallbacks while keeping the same primary family, so comparisons use the
 * tokens rather than the whole stack string.
 */
export function fontFamilyTokens(value: string): string[] {
  return value
    .split(',')
    .map((token) =>
      token
        .trim()
        .replace(/^["'](.*)["']$/, '$1')
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean)
}

/** The primary family token of a stack, or undefined for an empty string. */
export function primaryFontFamily(value: string): string | undefined {
  return fontFamilyTokens(value)[0]
}

/**
 * Display names are trimmed, control characters removed, and capped. React
 * renders them as text, but a clean stored value still matters for the picker
 * and for project files copied between builds.
 */
export function sanitizeFontName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const name = value
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, FONT_NAME_MAX)
  return name.length > 0 ? name : undefined
}

function sanitizeWeight(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const weight = Math.round(Math.min(FONT_WEIGHT_MAX, Math.max(FONT_WEIGHT_MIN, value)))
  return weight === FONT_WEIGHT_DEFAULT ? undefined : weight
}

/**
 * Validates one project font at a trust boundary (hydration, command payload).
 * A malformed entry is dropped as a whole: a bad id, name, generated family, or
 * content hash has no safe partial form. Optional weight/style fall back
 * per-field instead, matching `hydrateStyle`.
 */
export function sanitizeProjectFont(raw: unknown): ProjectFont | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const entry = raw as Record<string, unknown>
  if (!isValidFontId(entry.id)) return undefined
  const name = sanitizeFontName(entry.name)
  if (!name) return undefined
  // The family is generated, never trusted from the file. This rejects CSS
  // injection and any rename that changed the reference the clips use.
  if (entry.family !== fontFamilyForId(entry.id)) return undefined
  if (!isValidContentHash(entry.contentHash)) return undefined
  const font: ProjectFont = {
    id: entry.id,
    name,
    family: fontFamilyForId(entry.id),
    contentHash: entry.contentHash,
  }
  const weight = sanitizeWeight(entry.weight)
  if (weight !== undefined) font.weight = weight
  if (entry.style === 'italic') font.style = 'italic'
  return font
}

/** Maps an accepted font file to its format, or null when the type is not one of the four. */
export function fontFormatForName(name: string): FontFormat | null {
  const extension = name.split('.').pop()?.toLowerCase() ?? ''
  if (extension === 'woff2') return 'woff2'
  if (extension === 'woff') return 'woff'
  if (extension === 'ttf') return 'ttf'
  if (extension === 'otf') return 'otf'
  return null
}

/** MIME type stored in the font namespace sidecar and used to rebuild the bytes. */
export function fontMimeForFormat(format: FontFormat): string {
  return format === 'ttf' ? 'font/ttf' : `font/${format}`
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false
  return signature.every((byte, index) => bytes[index] === byte)
}

/**
 * Identifies a font by its header, independent of the file name. A renamed
 * file cannot trick the store into accepting a non-font payload, and the
 * FontFace load that follows is the second parse check.
 */
export function fontFormatFromBytes(bytes: Uint8Array): FontFormat | null {
  if (startsWith(bytes, [0x77, 0x4f, 0x46, 0x32])) return 'woff2' // wOF2
  if (startsWith(bytes, [0x77, 0x4f, 0x46, 0x46])) return 'woff' // wOFF
  if (startsWith(bytes, [0x4f, 0x54, 0x54, 0x4f])) return 'otf' // OTTO
  if (
    startsWith(bytes, [0x00, 0x01, 0x00, 0x00]) || // TrueType outlines
    startsWith(bytes, [0x74, 0x72, 0x75, 0x65]) || // 'true'
    startsWith(bytes, [0x74, 0x79, 0x70, 0x31]) // 'typ1'
  ) {
    return 'ttf'
  }
  return null
}

/**
 * The upload trust check. Returns the detected format when the name is an
 * accepted extension, the size is within the cap, and the header is a real
 * font; otherwise null. No bytes are stored until this passes.
 */
export function validateFontFile(name: string, bytes: Uint8Array): FontFormat | null {
  if (bytes.length === 0 || bytes.length > FONT_FILE_MAX_BYTES) return null
  const named = fontFormatForName(name)
  if (!named) return null
  return fontFormatFromBytes(bytes)
}
