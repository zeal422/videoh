/**
 * font-store.ts: browser-bound custom font storage and font-face loading
 * (0.25.0).
 *
 * Bytes live in the project's OPFS font namespace, keyed by the font content
 * hash, through the same store and claim shards as media. Faces are registered
 * document-wide, so exactly one project's faces are active at a time: a project
 * switch removes the previous set before the new set loads, and an upload stages
 * a face (loads it without adding it) until the font command has committed.
 *
 * A missing or corrupt file is a warning, never a load failure: the generated
 * family carries an Arial fallback, so the project stays editable and the text
 * still renders.
 */

import {
  FONT_FILE_MAX_BYTES,
  FONT_WEIGHT_DEFAULT,
  FONT_WEIGHT_MAX,
  FONT_WEIGHT_MIN,
} from '../constants'
import {
  fontFaceFamily,
  fontFamilyForId,
  fontFormatFromBytes,
  fontMimeForFormat,
  sanitizeFontName,
  validateFontFile,
  type FontFormat,
} from '../fonts'
import type { Doc, ProjectFont } from '../types'
import { ensureProjectMedia, readMediaFile, sha256Hex, writeMediaFile } from './media-store'
import { beginMediaActivityWhenIdle, endMediaActivity } from './persist'
import type { MediaActivityToken } from './persist'

/** The active project's faces, keyed by generated family. */
let activeProjectId: string | null = null
const activeFaces = new Map<string, FontFace>()
/**
 * Registry generation, claimed synchronously beside `activeProjectId`. Every
 * await in a load re-checks it, so a load that a project switch superseded
 * registers nothing after the switch.
 */
let activeLoadSeq = 0
/**
 * Per-family commit generations. A staged face commits for one family; a
 * loader that started before it must not register the old face afterwards,
 * while loaders for other families keep going.
 */
const familyCommits = new Map<string, number>()

export interface FontLoadResult {
  warnings: string[]
  loaded: number
  missing: number
}

function fontsSupported(): boolean {
  return (
    typeof document !== 'undefined' &&
    typeof FontFace !== 'undefined' &&
    !!document.fonts &&
    typeof document.fonts.add === 'function'
  )
}

function faceDescriptors(font: ProjectFont): FontFaceDescriptors {
  return {
    weight: String(font.weight ?? FONT_WEIGHT_DEFAULT),
    style: font.style ?? 'normal',
  }
}

function unregisterFaces(): void {
  if (typeof document !== 'undefined' && document.fonts?.delete) {
    for (const face of activeFaces.values()) {
      try {
        document.fonts.delete(face)
      } catch {
        // A face the browser already dropped is harmless.
      }
    }
  }
  activeFaces.clear()
}

/**
 * Registers a face as the single active face for its family, evicting a
 * previously registered face first. A background `loadProjectFonts` racing the
 * `ensureProjectFontsReady` retry otherwise both add their own Face object
 * while `activeFaces` keeps only the last: a later project switch deletes just
 * the tracked one and the orphan keeps answering the family, possibly
 * shadowing a next project that reuses it.
 */
function registerFace(font: ProjectFont, face: FontFace): void {
  const previous = activeFaces.get(font.family)
  if (previous && previous !== face && document.fonts?.delete) {
    try {
      document.fonts.delete(previous)
    } catch {
      // A face the browser already dropped is harmless.
    }
  }
  document.fonts.add(face)
  activeFaces.set(font.family, face)
}

/**
 * Loads one font's bytes into a FontFace and verifies it parses. Returns null
 * with a reason when the bytes are missing, damaged, or invalid.
 */
async function loadFace(
  projectId: string,
  font: ProjectFont,
): Promise<{ face: FontFace } | { warning: string }> {
  let stored: Awaited<ReturnType<typeof readMediaFile>> = null
  try {
    stored = await readMediaFile(projectId, font.contentHash, 'fonts')
  } catch {
    stored = null
  }
  if (!stored) {
    return {
      warning: `Font "${font.name}" is missing from this browser, so its text falls back to Arial. Re-upload it to restore the look.`,
    }
  }
  // `arrayBuffer` can reject on a damaged stored blob: it stays inside the
  // `try` so a failed read warns and falls back to Arial instead of failing
  // the project open or the export that triggered the load.
  try {
    const bytes = await stored.file.arrayBuffer()
    const format = fontFormatFromBytes(new Uint8Array(bytes))
    if (!format) {
      return {
        warning: `Font "${font.name}" is damaged, so its text falls back to Arial. Re-upload it to restore the look.`,
      }
    }
    const face = new FontFace(fontFaceFamily(font.id), bytes, faceDescriptors(font))
    await face.load()
    return { face }
  } catch {
    return {
      warning: `Font "${font.name}" could not be loaded, so its text falls back to Arial. Re-upload it to restore the look.`,
    }
  }
}

/**
 * Replaces the active font set with this doc's project fonts. Used for
 * committed ownership changes (undo across projects, the export barrier's
 * fallback); file opens stage with `stageProjectFontFaces` instead so a
 * superseded request never touches the registry. A superseded live load
 * aborts at its generation guard and registers nothing further.
 */
export async function loadProjectFonts(doc: Doc): Promise<FontLoadResult> {
  const warnings: string[] = []
  unregisterFaces()
  activeProjectId = doc.project.id
  const seq = ++activeLoadSeq
  const familyEpochs = new Map(familyCommits)
  const fonts = doc.project.fonts ?? []
  if (fonts.length === 0) {
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      try {
        await document.fonts.ready
      } catch {
        // A rejected ready promise does not invalidate the rest of the load.
      }
    }
    return { warnings, loaded: 0, missing: 0 }
  }
  if (!fontsSupported()) {
    warnings.push('This browser cannot load custom fonts, so text falls back to Arial.')
    return { warnings, loaded: 0, missing: fonts.length }
  }
  let loaded = 0
  let missing = 0
  await beginMediaActivityWhenIdle()
  try {
    for (const font of fonts) {
      const result = await loadFace(doc.project.id, font)
      // A project switch during the read owns the registry now: registering
      // here would leave a stale face behind that the superseded cleanup
      // cannot remove (it only touches the still-active project). Either
      // signal on its own aborts the load.
      if (seq !== activeLoadSeq || activeProjectId !== doc.project.id) {
        return { warnings, loaded, missing }
      }
      // A commit for THIS family during the read owns the registry now. Skip
      // only this family; an unrelated family still registers.
      if ((familyCommits.get(font.family) ?? 0) !== (familyEpochs.get(font.family) ?? 0)) {
        continue
      }
      if ('warning' in result) {
        warnings.push(result.warning)
        missing += 1
        continue
      }
      registerFace(font, result.face)
      loaded += 1
    }
  } finally {
    endMediaActivity()
  }
  try {
    await document.fonts.ready
  } catch {
    // Same as above: loaded faces remain usable.
  }
  return { warnings, loaded, missing }
}

/**
 * A project's loaded faces that are not in the active registry yet. An open or
 * restore stages the incoming project here so a superseded or failed request
 * drops them without touching the installed project's registry; the install
 * activates the staged set when it commits.
 */
export interface StagedProjectFonts {
  projectId: string
  faces: { font: ProjectFont; face: FontFace }[]
  warnings: string[]
  loaded: number
  missing: number
}

/**
 * Loads a doc's project fonts without touching the active registry. Two
 * concurrent stages never share mutable state, so neither can plant a stale
 * face in the other project; activation is a separate synchronous step.
 */
export async function stageProjectFontFaces(
  doc: Doc,
  activity?: MediaActivityToken,
): Promise<StagedProjectFonts> {
  const staged: StagedProjectFonts = {
    projectId: doc.project.id,
    faces: [],
    warnings: [],
    loaded: 0,
    missing: 0,
  }
  const fonts = doc.project.fonts ?? []
  if (fonts.length === 0) return staged
  if (!fontsSupported()) {
    staged.warnings.push('This browser cannot load custom fonts, so text falls back to Arial.')
    staged.missing = fonts.length
    return staged
  }
  await beginMediaActivityWhenIdle(activity)
  try {
    for (const font of fonts) {
      const result = await loadFace(doc.project.id, font)
      if ('warning' in result) {
        staged.warnings.push(result.warning)
        staged.missing += 1
        continue
      }
      staged.faces.push({ font, face: result.face })
      staged.loaded += 1
    }
  } finally {
    endMediaActivity()
  }
  try {
    await document.fonts.ready
  } catch {
    // Loaded faces remain usable even if the aggregate promise rejects.
  }
  return staged
}

/**
 * Installs a staged set as the active registry, replacing the previous
 * project's faces. Call only when the staged project is being installed.
 */
export function activateStagedProjectFonts(staged: StagedProjectFonts): void {
  unregisterFaces()
  activeProjectId = staged.projectId
  // Changing ownership invalidates any live load that is still reading.
  activeLoadSeq += 1
  if (!fontsSupported()) return
  for (const { font, face } of staged.faces) {
    document.fonts.add(face)
    activeFaces.set(font.family, face)
  }
}
/**
 * Drops the faces a canceled load registered. Only the named project is
 * affected; the installed project's set is left alone. Bumps the generation
 * so a load that is still reading aborts instead of registering into the
 * cleared registry after the cancel.
 */
export function unregisterProjectFonts(projectId: string): void {
  if (activeProjectId !== projectId) return
  unregisterFaces()
  activeProjectId = null
  activeLoadSeq += 1
}

/**
 * Makes the doc's project the one whose faces are registered. A project that
 * was preloaded already owns the active set; a brand-new project has none and
 * clears the previous project's faces.
 *
 * Returns a promise that settles once this project's faces are registered, so
 * a caller that paints can repaint after the load instead of keeping the
 * fallback frame. It resolves immediately when no load was needed.
 */
export async function activateProjectFonts(doc: Doc): Promise<void> {
  if (activeProjectId === doc.project.id) return
  unregisterFaces()
  activeProjectId = doc.project.id
  // Changing ownership invalidates any load that is still reading: without
  // the bump it would keep registering faces into the new project's registry.
  activeLoadSeq += 1
  if ((doc.project.fonts ?? []).length > 0) await loadProjectFonts(doc)
}

/**
 * Export and first-preview barrier: the active project's faces are loaded and
 * any project font that lost its face is retried. Returns user-facing warnings
 * for missing/corrupt fonts so an export can report a fallback instead of
 * silently rendering one.
 */
export async function ensureProjectFontsReady(doc: Doc): Promise<string[]> {
  if (typeof document === 'undefined') return []
  if (activeProjectId !== doc.project.id) return (await loadProjectFonts(doc)).warnings
  const seq = activeLoadSeq
  const familyEpochs = new Map(familyCommits)
  const fonts = doc.project.fonts ?? []
  const warnings: string[] = []
  if (fonts.length > 0) {
    await beginMediaActivityWhenIdle()
    try {
      for (const font of fonts) {
        if (activeFaces.has(font.family)) continue
        if (!fontsSupported()) {
          warnings.push('This browser cannot load custom fonts, so text falls back to Arial.')
          break
        }
        const result = await loadFace(doc.project.id, font)
        // Same supersede rule as the full load: a switch or a fresh load
        // during the read owns the registry now.
        if (seq !== activeLoadSeq || activeProjectId !== doc.project.id) return warnings
        if ((familyCommits.get(font.family) ?? 0) !== (familyEpochs.get(font.family) ?? 0)) {
          continue
        }
        if ('warning' in result) {
          warnings.push(result.warning)
          continue
        }
        registerFace(font, result.face)
      }
    } finally {
      endMediaActivity()
    }
  }
  try {
    await document.fonts.ready
  } catch {
    // Loaded faces remain usable even if the aggregate promise rejects.
  }
  return warnings
}

export class FontUploadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FontUploadError'
  }
}

export interface StagedFont {
  font: ProjectFont
  face: FontFace
  /** The bytes stored under the font hash; used to release a failed install. */
  projectId: string
}

/**
 * Validates, hashes, stages, and stores an uploaded font. The face is loaded
 * but deliberately NOT added to `document.fonts` until `commitStagedFont` runs,
 * so a refused or superseded upload leaves no active face behind.
 */
export async function stageProjectFont(
  input: {
    projectId: string
    id: string
    name: string
    file: File
    weight?: number
    style?: 'normal' | 'italic'
  },
  activity?: MediaActivityToken,
): Promise<StagedFont> {
  const name = sanitizeFontName(input.name)
  if (!name) throw new FontUploadError('Font name cannot be empty')
  if (!fontsSupported()) throw new FontUploadError('This browser cannot load custom fonts')
  // Hold the media reservation across the whole read, parse, hash, and store:
  // the stored hash is unreferenced until the caller commits it, so a clean
  // must not run between the read and the write. (Every other loader reserves
  // before its read loop; this one used to reserve only around the write.)
  await beginMediaActivityWhenIdle(activity)
  try {
    // `File.size` is OS-reported metadata: reject an oversized file before
    // reading it into memory. The byte-length check after the read stays as the
    // authoritative validation of the actual contents.
    if (typeof input.file.size === 'number' && input.file.size > FONT_FILE_MAX_BYTES) {
      throw new FontUploadError(
        `Font files must be ${FONT_FILE_MAX_BYTES / (1024 * 1024)} MB or smaller`,
      )
    }
    const bytes = new Uint8Array(await input.file.arrayBuffer())
    if (bytes.length === 0) throw new FontUploadError('The font file is empty')
    if (bytes.length > FONT_FILE_MAX_BYTES) {
      throw new FontUploadError(
        `Font files must be ${FONT_FILE_MAX_BYTES / (1024 * 1024)} MB or smaller`,
      )
    }
    const format = validateFontFile(input.file.name, bytes)
    if (!format) {
      throw new FontUploadError('Choose a valid WOFF2, WOFF, TTF, or OTF font file')
    }
    const weight =
      typeof input.weight === 'number' && Number.isFinite(input.weight)
        ? Math.min(FONT_WEIGHT_MAX, Math.max(FONT_WEIGHT_MIN, Math.round(input.weight)))
        : undefined
    const font: ProjectFont = {
      id: input.id,
      name,
      family: fontFamilyForId(input.id),
      contentHash: await sha256Hex(bytes),
    }
    if (weight !== undefined && weight !== FONT_WEIGHT_DEFAULT) font.weight = weight
    if (input.style === 'italic') font.style = 'italic'

    let face: FontFace
    try {
      face = new FontFace(fontFaceFamily(font.id), bytes, faceDescriptors(font))
      await face.load()
    } catch {
      throw new FontUploadError('The font file could not be parsed')
    }
    // A fresh session's project may not exist yet, and an established project
    // may have lost its claims records. Prepare or refuse BEFORE writing bytes:
    // bytes written without a claims directory make the next explicit save
    // fail its claim write.
    try {
      const state = await ensureProjectMedia(input.projectId)
      if (state === 'claims-missing') {
        throw new FontUploadError(
          'This project lost its stored-media records, so the font was not saved. Use Clear All Stored Media, then upload the font again.',
        )
      }
    } catch (error) {
      if (error instanceof FontUploadError) throw error
      throw new FontUploadError('Font storage is unavailable in this browser')
    }
    try {
      await writeMediaFile(
        input.projectId,
        font.contentHash,
        new File([bytes], input.file.name, { type: fontMimeForFormat(format) }),
        'fonts',
      )
    } catch {
      throw new FontUploadError('The font could not be stored in this browser')
    }
    return { font, face, projectId: input.projectId }
  } finally {
    endMediaActivity()
  }
}

/**
 * Adds a staged face after its font entry committed. If the project changed
 * while the upload was in flight the face is dropped and the stored bytes stay
 * unreferenced for the clean action.
 */
export function commitStagedFont(staged: StagedFont, currentProjectId: string): boolean {
  if (staged.projectId !== currentProjectId || activeProjectId !== currentProjectId) return false
  if (!fontsSupported()) return false
  // Same eviction rule as registerFace: a re-upload of one family must leave a
  // single face answering it, so the later unregister cannot orphan one that
  // keeps shadowing the next project.
  const previous = activeFaces.get(staged.font.family)
  if (previous && previous !== staged.face && document.fonts?.delete) {
    try {
      document.fonts.delete(previous)
    } catch {
      // A face the browser already dropped is harmless.
    }
  }
  document.fonts.add(staged.face)
  activeFaces.set(staged.font.family, staged.face)
  // Invalidate only this family's in-flight reads. A loader that started
  // before this commit skips its registration at the final epoch check; a
  // load for another family is unaffected.
  familyCommits.set(staged.font.family, (familyCommits.get(staged.font.family) ?? 0) + 1)
  return true
}

/**
 * Drops a staged face that never committed; it was never added to
 * `document.fonts`, and it never entered `activeFaces` (only a commit
 * registers it). Touching the registry here would delete a previously
 * registered face for the same family while its FontFace stays in
 * `document.fonts`, leaving an orphan that a project switch cannot remove.
 */
export function discardStagedFont(staged: StagedFont): void {
  if (activeFaces.get(staged.font.family) === staged.face) activeFaces.delete(staged.font.family)
}

/** True when the family resolves to a loaded face for the active project. */
export function isFontFamilyActive(family: string): boolean {
  return activeFaces.has(family)
}

/** Test/reset hook: drops every active face without touching stored bytes. */
export function resetFontRegistryForTests(): void {
  unregisterFaces()
  activeProjectId = null
  activeLoadSeq = 0
  familyCommits.clear()
}

export type { FontFormat }
