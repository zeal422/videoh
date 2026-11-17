import { describe, expect, it } from 'vitest'

import {
  BUNDLE_MAX_ENTRIES,
  BUNDLE_MAX_ENTRY_BYTES,
  BUNDLE_VERSION,
  buildBundleManifest,
  bundleFileName,
  bundleFontPath,
  bundleMediaPath,
  isValidBundleMediaId,
  isFontReferenced,
  matchBundleFonts,
  matchBundleMedia,
  normalizeBundlePath,
  planBundleEntries,
  referencedFontFamilies,
  sanitizeBundleFileName,
  validateBundleManifest,
} from '../project-bundle'
import { FONT_FILE_MAX_BYTES } from '../constants'
import type { Doc, MediaAsset, ProjectFont } from '../types'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const HASH_C = 'c'.repeat(64)

function asset(id: string, name: string, overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id,
    name,
    kind: 'video',
    duration: 3,
    width: 640,
    height: 360,
    url: `blob:${id}`,
    contentHash: HASH_A,
    ...overrides,
  }
}

function font(id: string, name: string, overrides: Partial<ProjectFont> = {}): ProjectFont {
  return {
    id,
    name,
    family: `videoh-font-${id}, Arial, sans-serif`,
    contentHash: HASH_B,
    ...overrides,
  }
}

function docWith(media: MediaAsset[], fonts: ProjectFont[] = []): Doc {
  return {
    project: {
      id: 'proj_a',
      name: 'Demo',
      width: 1920,
      height: 1080,
      fps: 30,
      tracks: [{ id: 'track_a', kind: 'video', name: 'V1', clips: [] }],
      fonts,
    },
    media,
  }
}

function manifestFor(assets: MediaAsset[], fonts: ProjectFont[] = []) {
  return buildBundleManifest({
    createdAt: '2026-11-14T12:00:00.000Z',
    assets: assets.map((entry) => ({
      id: entry.id,
      path: bundleMediaPath(entry.id, entry.name),
      name: entry.name,
      type: 'video/mp4',
      size: 4,
      sha256: entry.contentHash ?? HASH_A,
    })),
    fonts: fonts.map((entry) => ({
      id: entry.id,
      path: bundleFontPath(entry.id, entry.name),
      name: entry.name,
      size: 8,
      sha256: entry.contentHash,
    })),
  })
}

describe('bundle paths (0.28.0)', () => {
  it('accepts a plain relative path and normalizes it', () => {
    expect(normalizeBundlePath('media/media_a/clip.mp4')).toBe('media/media_a/clip.mp4')
  })

  it.each([
    ['../escape.mp4'],
    ['media/../../escape.mp4'],
    ['/absolute.mp4'],
    ['media\\media_a\\clip.mp4'],
    ['media/media_a/../clip.mp4'],
    ['media//clip.mp4'],
    ['media/./clip.mp4'],
    ['media/media_a/clip\u0000.mp4'],
    ['C:/media/clip.mp4'],
    [''],
    [null],
    [42],
  ])('refuses unsafe path %j', (value) => {
    expect(normalizeBundlePath(value)).toBeNull()
  })

  it('refuses an overlong path', () => {
    expect(normalizeBundlePath(`media/media_a/${'x'.repeat(600)}`)).toBeNull()
  })

  it('sanitizes a display name into one safe segment', () => {
    expect(sanitizeBundleFileName('my clip / take 1.mp4')).toBe('my clip _ take 1.mp4')
    expect(sanitizeBundleFileName('..hidden')).toBe('hidden')
    expect(sanitizeBundleFileName('   ')).toBe('file')
    expect(sanitizeBundleFileName('a:b?.mp4')).toBe('a_b_.mp4')
  })

  it('removes every control character so the generated path passes validation', () => {
    const name = 'clip\u0001\u0002.mp4'
    const path = bundleMediaPath('media_a', name)
    expect(path).toBe('media/media_a/clip.mp4')
    const manifest = buildBundleManifest({
      createdAt: '2026-11-14T12:00:00.000Z',
      assets: [{ id: 'media_a', path, name, type: 'video/mp4', size: 4, sha256: HASH_A }],
      fonts: [],
    })
    expect('manifest' in validateBundleManifest(manifest)).toBe(true)
  })

  it('keeps the extension when shortening a long name', () => {
    const name = sanitizeBundleFileName(`${'x'.repeat(300)}.mp4`)
    expect(name.length).toBeLessThanOrEqual(120)
    expect(name.endsWith('.mp4')).toBe(true)
  })

  it('builds bundle media and font paths under the id directory', () => {
    expect(bundleMediaPath('media_a', 'Clip One.mp4')).toBe('media/media_a/Clip One.mp4')
    expect(bundleFontPath('font_a', 'Inter.woff2')).toBe('fonts/font_a/Inter.woff2')
  })

  it('never splits a surrogate pair when truncating a long name', () => {
    const name = `${'a'.repeat(119)}😀${'b'.repeat(20)}`
    const sanitized = sanitizeBundleFileName(name)
    expect(sanitized.length).toBeLessThanOrEqual(120)
    expect(new TextDecoder().decode(new TextEncoder().encode(sanitized))).toBe(sanitized)
  })

  it('names the bundle with the documented extension', () => {
    expect(bundleFileName('My Project')).toBe('My Project.vebundle.zip')
    expect(bundleFileName('My Project.veproj.json')).toBe('My Project.vebundle.zip')
    expect(bundleFileName('My Project.json')).toBe('My Project.vebundle.zip')
    expect(bundleFileName('My Project.zip')).toBe('My Project.vebundle.zip')
    expect(bundleFileName('Demo v1.2')).toBe('Demo v1.2.vebundle.zip')
    expect(bundleFileName('   ')).toBe('project.vebundle.zip')
  })
})

describe('bundle planning (0.28.0)', () => {
  it('includes every media asset and font, including unused ones', () => {
    const unused = asset('media_unused', 'unused.mp4')
    const used = asset('media_used', 'used.mp4')
    const brandOnly = font('font_brand', 'Brand')
    const plan = planBundleEntries(docWith([unused, used], [brandOnly]))
    expect(plan.media.map((item) => item.asset.id)).toEqual(['media_unused', 'media_used'])
    expect(plan.fonts.map((item) => item.font.id)).toEqual(['font_brand'])
  })

  it('sorts entries by id so the bundle is deterministic', () => {
    const plan = planBundleEntries(docWith([asset('media_z', 'z'), asset('media_a', 'a')]))
    expect(plan.media.map((item) => item.asset.id)).toEqual(['media_a', 'media_z'])
  })

  it('lists the font families a project visibly uses', () => {
    const doc = docWith([], [font('font_used', 'Used'), font('font_unused', 'Unused')])
    doc.project.tracks[0]!.clips.push({
      id: 'clip_a',
      start: 0,
      duration: 2,
      inPoint: 0,
      text: 'Title',
      style: {
        fontSize: 48,
        color: '#ffffff',
        fontFamily: 'videoh-font-font_used, Arial, sans-serif',
        bold: false,
        italic: false,
        align: 'center',
        x: 0.5,
        y: 0.5,
        shadow: false,
      },
    })
    doc.project.brandKit = { colors: [], fontFamilies: ['videoh-font-font_unused, Arial'] }
    expect(referencedFontFamilies(doc).has('videoh-font-font_used')).toBe(true)
    expect(referencedFontFamilies(doc).has('videoh-font-font_unused')).toBe(true)
    expect(isFontReferenced(doc, font('font_used', 'Used'))).toBe(true)
    expect(isFontReferenced(doc, font('font_other', 'Other'))).toBe(false)
  })
})

describe('bundle manifest validation (0.28.0)', () => {
  it('accepts a manifest the builder produced', () => {
    const manifest = manifestFor([asset('media_a', 'a.mp4')], [font('font_a', 'A.woff2')])
    const result = validateBundleManifest(manifest)
    expect('manifest' in result).toBe(true)
    if ('manifest' in result) {
      expect(result.manifest.assets).toHaveLength(1)
      expect(result.manifest.fonts).toHaveLength(1)
    }
  })

  it('refuses a control character in the media MIME type', () => {
    const one = manifestFor([asset('media_a', 'a.mp4')])
    const manifest = {
      ...one,
      assets: [{ ...one.assets[0]!, type: 'video/\u0001mp4' }],
    }
    expect(validateBundleManifest(manifest)).toEqual({
      error: 'The bundle has a media entry with no valid type.',
    })
  })

  it('refuses a newer bundle version', () => {
    const manifest = { ...manifestFor([]), bundleVersion: BUNDLE_VERSION + 1 }
    const result = validateBundleManifest(manifest)
    expect('error' in result && result.error).toContain('does not open')
  })

  it('refuses an unknown project path', () => {
    const manifest = { ...manifestFor([]), project: '../project.veproj.json' }
    expect(validateBundleManifest(manifest)).toEqual({
      error: 'The bundle manifest does not name the project file.',
    })
  })

  it('refuses duplicate media ids', () => {
    const one = manifestFor([asset('media_a', 'a.mp4')])
    const manifest = { ...one, assets: [one.assets[0], one.assets[0]] }
    expect(validateBundleManifest(manifest)).toEqual({
      error: 'The bundle has a duplicate media id.',
    })
  })

  it('refuses a font path outside the font namespace', () => {
    const shared = 'shared/path'
    const manifest = manifestFor([])
    manifest.assets.push({
      id: 'media_a',
      path: 'media/media_a/a.mp4',
      name: 'a.mp4',
      type: 'video/mp4',
      size: 1,
      sha256: HASH_A,
    })
    manifest.fonts.push({
      id: 'font_a',
      path: 'media/media_a/a.mp4',
      name: shared,
      size: 1,
      sha256: HASH_B,
    })
    const result = validateBundleManifest(manifest)
    expect('error' in result && result.error).toContain('unsafe font path')
  })

  it('refuses an entry path that does not name its own id', () => {
    const manifest = manifestFor([asset('media_a', 'a.mp4')])
    manifest.assets[0] = { ...manifest.assets[0]!, path: 'media/media_b/a.mp4' }
    expect(validateBundleManifest(manifest)).toEqual({
      error: 'The bundle has an unsafe media path.',
    })
  })

  it('refuses a nested path under an id directory', () => {
    const manifest = manifestFor([asset('media_a', 'a.mp4')])
    manifest.assets[0] = { ...manifest.assets[0]!, path: 'media/media_a/nested/a.mp4' }
    expect(validateBundleManifest(manifest)).toEqual({
      error: 'The bundle has an unsafe media path.',
    })
  })

  it('refuses an oversized entry and an invalid hash', () => {
    const manifest = manifestFor([asset('media_a', 'a.mp4')])
    manifest.assets[0] = { ...manifest.assets[0]!, size: BUNDLE_MAX_ENTRY_BYTES + 1 }
    expect(validateBundleManifest(manifest)).toEqual({
      error: 'The bundle has a media entry with an invalid size.',
    })
    const second = manifestFor([asset('media_a', 'a.mp4')])
    second.assets[0] = { ...second.assets[0]!, sha256: 'NOT-A-HASH' }
    expect(validateBundleManifest(second)).toEqual({
      error: 'The bundle has a media entry with an invalid hash.',
    })
  })

  it('refuses a manifest over the total memory budget', () => {
    const manifest = manifestFor([
      asset('media_a', 'a.mp4'),
      asset('media_b', 'b.mp4'),
      asset('media_c', 'c.mp4'),
    ])
    manifest.assets = manifest.assets.map((entry) => ({
      ...entry,
      size: 400 * 1024 * 1024,
    }))
    expect(validateBundleManifest(manifest)).toEqual({
      error: 'The bundle exceeds the total size limit.',
    })
  })

  it('refuses too many entries', () => {
    const manifest = manifestFor([])
    manifest.assets = Array.from({ length: BUNDLE_MAX_ENTRIES }, (_, index) => ({
      id: `media_${index}`,
      path: `media/media_${index}/a.mp4`,
      name: 'a.mp4',
      type: 'video/mp4',
      size: 1,
      sha256: HASH_A,
    }))
    expect('error' in validateBundleManifest(manifest)).toBe(true)
  })

  it('refuses malformed shapes instead of throwing', () => {
    for (const value of [null, 'x', {}, { bundleVersion: 1 }]) {
      expect('error' in validateBundleManifest(value)).toBe(true)
    }
  })
})

describe('bundle matching (0.28.0)', () => {
  it('matches every media asset and refuses a missing one', () => {
    const one = asset('media_a', 'a.mp4')
    const two = asset('media_b', 'b.mp4')
    const manifest = manifestFor([one])
    expect(matchBundleMedia(docWith([one]), manifest).errors).toEqual([])
    expect(matchBundleMedia(docWith([one, two]), manifest).errors).toEqual([
      'The bundle is missing media "b.mp4".',
    ])
  })

  it('refuses an extra media entry', () => {
    const one = asset('media_a', 'a.mp4')
    const manifest = manifestFor([one, asset('media_b', 'b.mp4')])
    expect(matchBundleMedia(docWith([one]), manifest).errors).toEqual([
      'The bundle contains media the project does not list: b.mp4.',
    ])
  })

  it('refuses a project hash that disagrees with the manifest', () => {
    const one = asset('media_a', 'a.mp4')
    const manifest = manifestFor([one])
    manifest.assets[0] = { ...manifest.assets[0]!, sha256: HASH_C }
    expect(matchBundleMedia(docWith([one]), manifest).errors).toEqual([
      'The bundle\'s copy of "a.mp4" does not match the project hash.',
    ])
  })

  it('reports a missing font as a warning, not an error', () => {
    const used = font('font_a', 'A.woff2')
    const manifest = manifestFor([], [])
    const match = matchBundleFonts(docWith([], [used]), manifest)
    expect(match.errors).toEqual([])
    expect(match.missing).toEqual([{ id: 'font_a', name: 'A.woff2' }])
  })

  it('refuses an extra font and a font hash conflict', () => {
    const extra = font('font_extra', 'Extra.woff2')
    const manifest = manifestFor([], [extra])
    expect(matchBundleFonts(docWith([], []), manifest).errors).toEqual([
      'The bundle contains a font the project does not list: Extra.woff2.',
    ])
    const used = font('font_a', 'A.woff2')
    const conflict = manifestFor([], [used])
    conflict.fonts[0] = { ...conflict.fonts[0]!, sha256: HASH_C }
    expect(matchBundleFonts(docWith([], [used]), conflict).errors).toEqual([
      'The bundle\'s copy of font "A.woff2" does not match the project hash.',
    ])
  })

  it('validates media ids', () => {
    expect(isValidBundleMediaId('media_12ab-C')).toBe(true)
    expect(isValidBundleMediaId('../media')).toBe(false)
    expect(isValidBundleMediaId('')).toBe(false)
    expect(isValidBundleMediaId(7)).toBe(false)
  })
})

describe('bundle manifest font cap (0.28.2)', () => {
  it('refuses a font entry above the 8 MiB font cap', () => {
    const manifest = manifestFor([], [font('font_a', 'A.woff2')])
    manifest.fonts[0] = { ...manifest.fonts[0]!, size: FONT_FILE_MAX_BYTES + 1 }
    const result = validateBundleManifest(manifest)
    expect('error' in result && /invalid size/i.test(result.error)).toBe(true)
  })

  it('accepts a font entry exactly at the cap', () => {
    const manifest = manifestFor([], [font('font_b', 'B.woff2')])
    manifest.fonts[0] = { ...manifest.fonts[0]!, size: FONT_FILE_MAX_BYTES }
    expect('manifest' in validateBundleManifest(manifest)).toBe(true)
  })

  it('still accepts a media entry above 8 MiB', () => {
    const manifest = manifestFor([asset('media_a', 'clip.mp4')], [])
    manifest.assets[0] = { ...manifest.assets[0]!, size: 9 * 1024 * 1024 }
    expect('manifest' in validateBundleManifest(manifest)).toBe(true)
  })
})
