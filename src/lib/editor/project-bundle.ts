/**
 * project-bundle.ts: the pure bundle format (0.28.0).
 *
 * A bundle is a store-only ZIP:
 *
 * ```text
 * manifest.json
 * project.veproj.json
 * media/<assetId>/<sanitized-name>
 * fonts/<fontId>/<sanitized-name>
 * ```
 *
 * The project inside keeps its existing serialization version. The manifest
 * names every media asset in `Doc.media` and every font in `Project.fonts`,
 * with the byte size and SHA-256 of each entry. This module owns the manifest
 * schema, path policy, limits, entry planning, and the id matching both the
 * export and import flows rely on. It never touches the browser or the store.
 */

import { isValidFontId, primaryFontFamily } from './fonts'
import { isValidContentHash } from './project-validation'
import type { Doc, MediaAsset, ProjectFont } from './types'

/** Format version of the bundle container. Independent of the project schema. */
export const BUNDLE_VERSION = 1
export const BUNDLE_MANIFEST_PATH = 'manifest.json'
export const BUNDLE_PROJECT_PATH = 'project.veproj.json'
export const BUNDLE_EXTENSION = '.vebundle.zip'
export const BUNDLE_MEDIA_PREFIX = 'media/'
export const BUNDLE_FONTS_PREFIX = 'fonts/'

/**
 * Hostile-archive limits. Documented in docs/flows.md.
 *
 * These are a memory budget, not a disk budget: an import reads one entry into
 * a full buffer several times (CRC, SHA-256, probe, store write), and the
 * no-picker export fallback holds the whole archive in memory. The caps keep
 * the advertised maximum within what a browser tab can actually process.
 */
export const BUNDLE_MAX_ENTRIES = 4096
export const BUNDLE_MAX_ENTRY_BYTES = 512 * 1024 * 1024
export const BUNDLE_MAX_TOTAL_BYTES = 1024 * 1024 * 1024
export const BUNDLE_MAX_MANIFEST_BYTES = 8 * 1024 * 1024
/** The project JSON carries thumbnails and waveform peaks; cap it too. */
export const BUNDLE_MAX_PROJECT_BYTES = 64 * 1024 * 1024
/** The no-picker fallback builds the archive in memory; refuse above this. */
export const BUNDLE_MAX_BLOB_BYTES = 512 * 1024 * 1024
export const BUNDLE_MAX_PATH_LENGTH = 512
export const BUNDLE_MAX_NAME_LENGTH = 255

const MEDIA_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
/** The same class with `g`, for removing every occurrence. */
const CONTROL_CHARACTERS_GLOBAL = /[\u0000-\u001f\u007f]/g

export interface BundleManifestAsset {
  id: string
  path: string
  name: string
  /** MIME type recorded at export; the import probes the bytes anyway. */
  type: string
  size: number
  sha256: string
}

export interface BundleManifestFont {
  id: string
  path: string
  name: string
  size: number
  sha256: string
}

export interface BundleManifest {
  bundleVersion: number
  createdAt: string
  project: string
  assets: BundleManifestAsset[]
  fonts: BundleManifestFont[]
}

export type BundleManifestResult = { manifest: BundleManifest } | { error: string }

/** True when `id` is a media id this app generated. */
export function isValidBundleMediaId(value: unknown): value is string {
  return typeof value === 'string' && MEDIA_ID_PATTERN.test(value)
}

/**
 * Normalizes an archive path, or returns null when it is unsafe. Absolute
 * paths, backslashes, NUL and control characters, empty segments, `.`, and
 * `..` are refused outright: there is no valid bundle path that needs them.
 */
export function normalizeBundlePath(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null
  if (raw.length > BUNDLE_MAX_PATH_LENGTH) return null
  if (raw.includes('\0') || raw.includes('\\')) return null
  if (CONTROL_CHARACTERS.test(raw)) return null
  if (raw.startsWith('/')) return null
  const segments = raw.split('/')
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return null
    // A colon would read as a drive letter on a case-insensitive filesystem.
    if (segment.includes(':')) return null
  }
  return segments.join('/')
}

/** Cuts at a UTF-16 boundary without leaving half of a surrogate pair. */
function sliceCodeUnits(value: string, end: number): string {
  const sliced = value.slice(0, end)
  const last = sliced.charCodeAt(sliced.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? sliced.slice(0, -1) : sliced
}

/**
 * Makes a display name safe as one path segment. Path separators, control
 * characters, a leading dot run, and a trailing dot or space are removed;
 * the result is deterministic and never empty.
 */
export function sanitizeBundleFileName(raw: string, fallback = 'file'): string {
  let name = raw
    .replace(CONTROL_CHARACTERS_GLOBAL, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim()
  name = name.replace(/^\.+/, '').replace(/[. ]+$/, '')
  if (!name) name = fallback
  if (name.length > 120) {
    const dot = name.lastIndexOf('.')
    if (dot > 0 && name.length - dot <= 16) {
      name = `${sliceCodeUnits(name, 120 - (name.length - dot))}${name.slice(dot)}`
    } else {
      name = sliceCodeUnits(name, 120)
    }
  }
  return name || fallback
}

/**
 * Makes a display name safe for the manifest: control characters removed and
 * the length capped. The manifest name is informational (the project JSON
 * carries the real name), so sanitizing it cannot rename the asset on import.
 */
export function sanitizeBundleDisplayName(raw: string, fallback = 'file'): string {
  const name = sliceCodeUnits(
    raw.replace(CONTROL_CHARACTERS_GLOBAL, '').trim(),
    BUNDLE_MAX_NAME_LENGTH,
  )
  return name || fallback
}

/** The archive path for one media entry. */
export function bundleMediaPath(id: string, name: string): string {
  return `${BUNDLE_MEDIA_PREFIX}${id}/${sanitizeBundleFileName(name, 'media')}`
}

/** The archive path for one font entry. */
export function bundleFontPath(id: string, name: string): string {
  return `${BUNDLE_FONTS_PREFIX}${id}/${sanitizeBundleFileName(name, 'font')}`
}

/** The download name for a bundle. */
export function bundleFileName(projectName: string): string {
  const base = sanitizeBundleFileName(projectName, 'project')
    .replace(/\.veproj\.json$/i, '')
    .replace(/\.json$/i, '')
    .replace(/\.zip$/i, '')
  return `${base || 'project'}${BUNDLE_EXTENSION}`
}

function isOneSegmentAfter(path: string, prefix: string): boolean {
  if (!path.startsWith(prefix)) return false
  const rest = path.slice(prefix.length)
  return rest.length > 0 && !rest.includes('/')
}

/** True when `path` is exactly `media/<id>/<one segment>`. */
export function isBundleMediaPath(path: string, id: string): boolean {
  return isOneSegmentAfter(path, `${BUNDLE_MEDIA_PREFIX}${id}/`)
}

/** True when `path` is exactly `fonts/<id>/<one segment>`. */
export function isBundleFontPath(path: string, id: string): boolean {
  return isOneSegmentAfter(path, `${BUNDLE_FONTS_PREFIX}${id}/`)
}

export interface BundleMediaPlanItem {
  asset: MediaAsset
  path: string
}

export interface BundleFontPlanItem {
  font: ProjectFont
  path: string
}

/**
 * Every entry a project's bundle must contain, in a deterministic order. The
 * doc's media and font libraries are the source of truth, including unused bin
 * items and brand-kit-only fonts: the project JSON lists them on import.
 */
export function planBundleEntries(doc: Doc): {
  media: BundleMediaPlanItem[]
  fonts: BundleFontPlanItem[]
} {
  const media = [...doc.media]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((asset) => ({ asset, path: bundleMediaPath(asset.id, asset.name) }))
  const fonts = [...(doc.project.fonts ?? [])]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((font) => ({ font, path: bundleFontPath(font.id, font.name) }))
  return { media, fonts }
}

/** Builds a manifest, sorting entries by id so equal inputs give equal JSON. */
export function buildBundleManifest(input: {
  createdAt: string
  assets: readonly BundleManifestAsset[]
  fonts: readonly BundleManifestFont[]
}): BundleManifest {
  return {
    bundleVersion: BUNDLE_VERSION,
    createdAt: input.createdAt,
    project: BUNDLE_PROJECT_PATH,
    assets: [...input.assets]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((entry) => ({ ...entry, name: sanitizeBundleDisplayName(entry.name) })),
    fonts: [...input.fonts]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((entry) => ({ ...entry, name: sanitizeBundleDisplayName(entry.name) })),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readString(value: unknown, max: number): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) return null
  if (CONTROL_CHARACTERS.test(value)) return null
  return value
}

function readSize(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) return null
  if (value < 0 || value > BUNDLE_MAX_ENTRY_BYTES) return null
  return value
}

/**
 * Validates an untrusted parsed `manifest.json`. The archive itself is checked
 * separately: this validates types, limits, ids, paths, sizes, and hashes.
 */
export function validateBundleManifest(raw: unknown): BundleManifestResult {
  if (!isRecord(raw)) return { error: 'The bundle manifest is not an object.' }
  const bundleVersion = raw.bundleVersion
  if (typeof bundleVersion !== 'number' || !Number.isInteger(bundleVersion) || bundleVersion < 1) {
    return { error: 'The bundle manifest has no valid version.' }
  }
  if (bundleVersion > BUNDLE_VERSION) {
    return {
      error: `This bundle uses format version ${bundleVersion}, which this app does not open. Update the app to open it.`,
    }
  }
  if (raw.project !== BUNDLE_PROJECT_PATH) {
    return { error: 'The bundle manifest does not name the project file.' }
  }
  const createdAt = raw.createdAt
  if (
    typeof createdAt !== 'string' ||
    createdAt.length > 64 ||
    !Number.isFinite(Date.parse(createdAt))
  ) {
    return { error: 'The bundle manifest has no valid creation date.' }
  }
  if (!Array.isArray(raw.assets) || !Array.isArray(raw.fonts)) {
    return { error: 'The bundle manifest is missing its entry lists.' }
  }
  if (raw.assets.length + raw.fonts.length + 2 > BUNDLE_MAX_ENTRIES) {
    return { error: `The bundle has more than ${BUNDLE_MAX_ENTRIES} entries.` }
  }
  const paths = new Set<string>([BUNDLE_MANIFEST_PATH, BUNDLE_PROJECT_PATH])
  const assetIds = new Set<string>()
  const assets: BundleManifestAsset[] = []
  let total = 0
  for (const value of raw.assets) {
    if (!isRecord(value)) return { error: 'The bundle has a malformed media entry.' }
    if (!isValidBundleMediaId(value.id)) return { error: 'The bundle has an invalid media id.' }
    if (assetIds.has(value.id)) return { error: 'The bundle has a duplicate media id.' }
    assetIds.add(value.id)
    const path = normalizeBundlePath(value.path)
    if (!path || !isBundleMediaPath(path, value.id)) {
      return { error: 'The bundle has an unsafe media path.' }
    }
    if (paths.has(path)) return { error: 'The bundle has a duplicate entry path.' }
    paths.add(path)
    const name = readString(value.name, BUNDLE_MAX_NAME_LENGTH)
    if (!name) return { error: 'The bundle has a media entry with no valid name.' }
    const type = typeof value.type === 'string' && value.type.length <= 255 ? value.type : null
    if (type === null) return { error: 'The bundle has a media entry with no valid type.' }
    const size = readSize(value.size)
    if (size === null) return { error: 'The bundle has a media entry with an invalid size.' }
    if (!isValidContentHash(value.sha256)) {
      return { error: 'The bundle has a media entry with an invalid hash.' }
    }
    total += size
    assets.push({ id: value.id, path, name, type, size, sha256: value.sha256 })
  }
  const fonts: BundleManifestFont[] = []
  const fontIds = new Set<string>()
  for (const value of raw.fonts) {
    if (!isRecord(value)) return { error: 'The bundle has a malformed font entry.' }
    if (!isValidFontId(value.id)) return { error: 'The bundle has an invalid font id.' }
    if (fontIds.has(value.id)) return { error: 'The bundle has a duplicate font id.' }
    fontIds.add(value.id)
    const path = normalizeBundlePath(value.path)
    if (!path || !isBundleFontPath(path, value.id)) {
      return { error: 'The bundle has an unsafe font path.' }
    }
    if (paths.has(path)) return { error: 'The bundle has a duplicate entry path.' }
    paths.add(path)
    const name = readString(value.name, BUNDLE_MAX_NAME_LENGTH)
    if (!name) return { error: 'The bundle has a font entry with no valid name.' }
    const size = readSize(value.size)
    if (size === null) return { error: 'The bundle has a font entry with an invalid size.' }
    if (!isValidContentHash(value.sha256)) {
      return { error: 'The bundle has a font entry with an invalid hash.' }
    }
    total += size
    fonts.push({ id: value.id, path, name, size, sha256: value.sha256 })
  }
  if (total > BUNDLE_MAX_TOTAL_BYTES) {
    return { error: 'The bundle exceeds the total size limit.' }
  }
  return {
    manifest: {
      bundleVersion,
      createdAt,
      project: BUNDLE_PROJECT_PATH,
      assets,
      fonts,
    },
  }
}

export interface BundleMediaMatch {
  assets: { asset: MediaAsset; entry: BundleManifestAsset }[]
  errors: string[]
}

/**
 * Matches manifest assets to every `Doc.media` id. Extra entries, missing
 * media, and a declared project hash that disagrees with the manifest refuse.
 */
export function matchBundleMedia(doc: Doc, manifest: BundleManifest): BundleMediaMatch {
  const errors: string[] = []
  const byId = new Map<string, BundleManifestAsset>()
  for (const entry of manifest.assets) byId.set(entry.id, entry)
  const assets: BundleMediaMatch['assets'] = []
  const used = new Set<string>()
  for (const asset of doc.media) {
    const entry = byId.get(asset.id)
    if (!entry) {
      errors.push(`The bundle is missing media "${asset.name}".`)
      continue
    }
    used.add(asset.id)
    if (isValidContentHash(asset.contentHash) && asset.contentHash !== entry.sha256) {
      errors.push(`The bundle's copy of "${asset.name}" does not match the project hash.`)
      continue
    }
    assets.push({ asset, entry })
  }
  for (const entry of manifest.assets) {
    if (!used.has(entry.id)) {
      errors.push(`The bundle contains media the project does not list: ${entry.name}.`)
    }
  }
  return { assets, errors }
}

export interface BundleFontMatch {
  fonts: { font: ProjectFont; entry: BundleManifestFont }[]
  /** Fonts the project lists but the bundle does not carry. */
  missing: { id: string; name: string }[]
  errors: string[]
}

/**
 * Matches manifest fonts to every `Project.fonts` id. A missing font is a
 * warning (the project falls back to Arial); an extra entry or a hash conflict
 * refuses.
 */
export function matchBundleFonts(doc: Doc, manifest: BundleManifest): BundleFontMatch {
  const errors: string[] = []
  const byId = new Map<string, BundleManifestFont>()
  for (const entry of manifest.fonts) byId.set(entry.id, entry)
  const fonts: BundleFontMatch['fonts'] = []
  const missing: BundleFontMatch['missing'] = []
  const projectFonts = doc.project.fonts ?? []
  const projectIds = new Set(projectFonts.map((font) => font.id))
  for (const font of projectFonts) {
    const entry = byId.get(font.id)
    if (!entry) {
      missing.push({ id: font.id, name: font.name })
      continue
    }
    if (isValidContentHash(font.contentHash) && font.contentHash !== entry.sha256) {
      errors.push(`The bundle's copy of font "${font.name}" does not match the project hash.`)
      continue
    }
    fonts.push({ font, entry })
  }
  for (const entry of manifest.fonts) {
    if (!projectIds.has(entry.id)) {
      errors.push(`The bundle contains a font the project does not list: ${entry.name}.`)
    }
  }
  return { fonts, missing, errors }
}

/**
 * Families a project visibly depends on: text clips and the brand kit. Used to
 * tell a missing referenced font (confirm before exporting) from a missing
 * library font nobody uses (warn only).
 */
export function referencedFontFamilies(doc: Doc): Set<string> {
  const families = new Set<string>()
  const add = (value: unknown) => {
    if (typeof value !== 'string') return
    for (const token of value.split(',')) {
      const trimmed = token.trim().replace(/^["']|["']$/g, '')
      if (trimmed) families.add(trimmed)
    }
  }
  for (const track of doc.project.tracks) {
    for (const clip of track.clips) add(clip.style?.fontFamily)
  }
  for (const sequence of doc.project.sequences ?? []) {
    for (const track of sequence.tracks) {
      for (const clip of track.clips) add(clip.style?.fontFamily)
    }
  }
  for (const family of doc.project.brandKit?.fontFamilies ?? []) add(family)
  return families
}

/** True when a missing project font is used by a clip or the brand kit. */
export function isFontReferenced(doc: Doc, font: ProjectFont): boolean {
  const primary = primaryFontFamily(font.family)
  return primary ? referencedFontFamilies(doc).has(primary) : false
}
