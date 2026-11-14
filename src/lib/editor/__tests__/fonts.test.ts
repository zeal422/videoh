import { describe, expect, it } from 'vitest'

import {
  BUILTIN_FONTS,
  FONT_FILE_ACCEPT,
  FONT_ID_PATTERN,
  fontFaceFamily,
  fontFamilyForId,
  fontFormatForName,
  fontFormatFromBytes,
  fontMimeForFormat,
  isBuiltinFontFamily,
  isValidFontId,
  sanitizeFontFamily,
  sanitizeFontName,
  sanitizeProjectFont,
  validateFontFile,
} from '../fonts'
import { FONT_FILE_MAX_BYTES, FONT_NAME_MAX } from '../constants'
import type { ProjectFont } from '../types'

const HASH = 'a'.repeat(64)
const ID = 'font_123e4567-e89b-12d3-a456-426614174000'

function font(overrides: Partial<ProjectFont> = {}): ProjectFont {
  return {
    id: ID,
    name: 'Inter',
    family: fontFamilyForId(ID),
    contentHash: HASH,
    ...overrides,
  }
}

function bytes(...head: number[]): Uint8Array {
  return new Uint8Array([...head, 0, 0, 0, 0])
}

describe('project font metadata (0.25.0)', () => {
  it('generates one immutable family from the id, with an Arial fallback', () => {
    expect(fontFaceFamily(ID)).toBe(`videoh-font-${ID}`)
    expect(fontFamilyForId(ID)).toBe(`videoh-font-${ID}, Arial, sans-serif`)
    expect(fontFamilyForId(ID)).toBe(font().family)
    expect(FONT_ID_PATTERN.test(ID)).toBe(true)
    expect(isValidFontId(ID)).toBe(true)
  })

  it('rejects id path traversal and non-font prefixes', () => {
    for (const value of ['', 'Inter', 'font_', 'font_../x', 'font_a/b', 'other_123', 7, null]) {
      expect(isValidFontId(value)).toBe(false)
    }
  })

  it('sanitizes display names without touching the generated family', () => {
    expect(sanitizeFontName('  Inter\nDisplay  ')).toBe('InterDisplay')
    expect(sanitizeFontName('\u0000 \u001f')).toBeUndefined()
    expect(sanitizeFontName('x'.repeat(FONT_NAME_MAX + 20))).toHaveLength(FONT_NAME_MAX)
    expect(sanitizeFontName(3)).toBeUndefined()
  })

  it('accepts a complete entry and keeps its optional weight and italic style', () => {
    const parsed = sanitizeProjectFont({ ...font({ weight: 700, style: 'italic' }) })
    expect(parsed).toEqual(font({ weight: 700, style: 'italic' }))
  })

  it('normalizes optional fields instead of dropping the entry', () => {
    expect(sanitizeProjectFont({ ...font(), weight: 50 })).toEqual(font({ weight: 100 }))
    expect(sanitizeProjectFont({ ...font(), weight: 5000 })).toEqual(font({ weight: 900 }))
    // 400 is the browser default, so the stored entry stays clean.
    expect(sanitizeProjectFont({ ...font(), weight: 400 })).toEqual(font())
    expect(sanitizeProjectFont({ ...font(), weight: 'bold', style: 'oblique' })).toEqual(font())
  })

  it('rejects a family that was not generated from the id (CSS injection)', () => {
    for (const family of [
      'Inter, sans-serif',
      'videoh-font-other, Arial, sans-serif',
      'Arial; background: url(x)',
      '',
    ]) {
      expect(sanitizeProjectFont({ ...font(), family })).toBeUndefined()
    }
  })

  it('rejects malformed ids, names, hashes, and non-objects', () => {
    expect(sanitizeProjectFont(null)).toBeUndefined()
    expect(sanitizeProjectFont({ ...font(), id: 'font_../x' })).toBeUndefined()
    expect(sanitizeProjectFont({ ...font(), name: '   ' })).toBeUndefined()
    for (const contentHash of ['', '../hash', HASH.toUpperCase(), 'a'.repeat(63), 7]) {
      expect(sanitizeProjectFont({ ...font(), contentHash })).toBeUndefined()
    }
  })

  it('lists distinct built-in families and recognizes them', () => {
    const families = BUILTIN_FONTS.map((entry) => entry.family)
    expect(new Set(families).size).toBe(families.length)
    expect(families).toContain('Arial, sans-serif')
    expect(isBuiltinFontFamily('Arial, sans-serif')).toBe(true)
    expect(isBuiltinFontFamily('Inter')).toBe(false)
  })

  it('accepts safe system-family stacks and rejects CSS-function syntax', () => {
    for (const family of [
      'Arial, sans-serif',
      '"Times New Roman", Times, serif',
      'videoh-font-font_abc, Arial, sans-serif',
      'My Installed Font',
    ]) {
      expect(sanitizeFontFamily(family)).toBe(family)
    }
    for (const family of [
      'Arial; color: red',
      'url(https://example.com/x.woff2)',
      'var(--font)',
      'Arial\n, sans-serif',
      'x'.repeat(201),
      '',
      7,
    ]) {
      expect(sanitizeFontFamily(family)).toBeUndefined()
    }
  })
})

describe('font file validation (0.25.0)', () => {
  it('detects the four accepted font formats by header', () => {
    expect(fontFormatFromBytes(bytes(0x77, 0x4f, 0x46, 0x32))).toBe('woff2')
    expect(fontFormatFromBytes(bytes(0x77, 0x4f, 0x46, 0x46))).toBe('woff')
    expect(fontFormatFromBytes(bytes(0x4f, 0x54, 0x54, 0x4f))).toBe('otf')
    expect(fontFormatFromBytes(bytes(0x00, 0x01, 0x00, 0x00))).toBe('ttf')
    expect(fontFormatFromBytes(bytes(0x74, 0x72, 0x75, 0x65))).toBe('ttf')
    expect(fontFormatFromBytes(bytes(0x74, 0x79, 0x70, 0x31))).toBe('ttf')
    expect(fontFormatFromBytes(bytes(0x74, 0x74, 0x63, 0x66))).toBeNull()
    expect(fontFormatFromBytes(new Uint8Array([0x77]))).toBeNull()
  })

  it('accepts an extension only when the header is a real font', () => {
    expect(validateFontFile('Inter.woff2', bytes(0x77, 0x4f, 0x46, 0x32))).toBe('woff2')
    expect(validateFontFile('Inter.ttf', bytes(0x00, 0x01, 0x00, 0x00))).toBe('ttf')
    // A renamed payload is identified by its header, never by its name.
    expect(validateFontFile('Inter.ttf', bytes(0x4f, 0x54, 0x54, 0x4f))).toBe('otf')
    expect(validateFontFile('Inter.txt', bytes(0x77, 0x4f, 0x46, 0x32))).toBeNull()
    expect(validateFontFile('Inter.woff2', bytes(0x50, 0x4b, 0x03, 0x04))).toBeNull()
    expect(validateFontFile('Inter.woff2', new Uint8Array())).toBeNull()
  })

  it('rejects empty and over-cap files before parsing them', () => {
    const huge = new Uint8Array(FONT_FILE_MAX_BYTES + 1)
    huge.set([0x77, 0x4f, 0x46, 0x32])
    expect(validateFontFile('Inter.woff2', huge)).toBeNull()
  })

  it('maps formats to file extensions, MIME types, and the picker accept list', () => {
    expect(fontFormatForName('a.WOFF2')).toBe('woff2')
    expect(fontFormatForName('a.woff')).toBe('woff')
    expect(fontFormatForName('a.otf')).toBe('otf')
    expect(fontFormatForName('a.ttf')).toBe('ttf')
    expect(fontFormatForName('a.svg')).toBeNull()
    expect(fontMimeForFormat('woff2')).toBe('font/woff2')
    expect(fontMimeForFormat('ttf')).toBe('font/ttf')
    expect(FONT_FILE_ACCEPT).toContain('.woff2')
    expect(FONT_FILE_ACCEPT).toContain('.otf')
    expect(FONT_FILE_ACCEPT).not.toContain('svg')
  })
})
