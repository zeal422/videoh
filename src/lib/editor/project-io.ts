'use client'

import { toast } from '@/hooks/use-toast'

import { relinkPatchFrom } from './media/relink'
import { importFile } from './media/probe'
import { buildProxy, revokeAllProxies } from './media/proxies'
import { collectMediaHashes } from './media-cleanup-plan'
import { prepareProjectStore, storeMediaAsset, writeProjectClaim } from './media/persist'
import {
  activateProjectFonts,
  activateStagedProjectFonts,
  stageProjectFontFaces,
  type StagedProjectFonts,
} from './media/font-store'
import { ProjectLock } from './media/project-lock'
import { rehydrateMedia, revokeRehydratedUrls } from './media/rehydrate'
import { shouldProxy } from './proxy'
import { parseSerializedDoc, projectFileName, serializeDoc } from './serialization'
import { useEditorStore } from './store'
import type { Doc, MediaAsset, PendingRestore } from './types'

/**
 * Project file I/O shared by the toolbar, the menu bar and the media bin:
 * - `downloadProjectJSON()`     save the current project as `.veproj.json`
 * - `loadProjectFile()`         parse + validate a project JSON file
 * - `importMediaFiles()`        import media files with auto-relink (File > Import)
 * - `openProjectFile(file)`     THE project open: parse, rehydrate, install, report
 * - `restoreAutosaveProject()`  the autosave banner's install path
 * - `openProjectFromPicker()`   picker + `openProjectFile` (the File > Open path)
 * - `bumpProjectGeneration()`   invalidate in-flight loads when a project installs
 * - `ensureProjectLock()`       hold the shared multi-tab media lock
 *
 * 0.23.0: durable media. An open rehydrates stored bytes, claims them, and only
 * then installs; a save claims before it writes a file. Parsing stays
 * synchronous and `installProject` stays the one install path.
 */

/** A save failed because the copy's stored media could not be claimed. */
export class ProjectClaimError extends Error {
  constructor() {
    super(
      "Could not record this project's stored media. Nothing was downloaded; save again or keep the original files.",
    )
    this.name = 'ProjectClaimError'
  }
}

export interface ProjectToken {
  projectId: string
  /** Bumped only by replaceDoc, so an edit does not look like an install. */
  epoch: number
}

/** Identity of the live project, captured before an async media operation. */
export function currentProjectToken(): ProjectToken {
  const state = useEditorStore.getState()
  return { projectId: state.doc.project.id, epoch: state.projectEpoch }
}

/** True while the live project is still the one the token was captured from. */
export function isProjectTokenCurrent(token: ProjectToken): boolean {
  const state = useEditorStore.getState()
  return state.projectEpoch === token.epoch && state.doc.project.id === token.projectId
}

/** Releases a probed asset whose project was replaced before it was attached. */
function discardFreshMedia(asset: MediaAsset): void {
  if (!asset.url) return
  try {
    URL.revokeObjectURL(asset.url)
  } catch {
    // An already revoked URL is harmless.
  }
}

/**
 * Serializes the current doc and triggers a browser download. The claim shard
 * is written from the SAME snapshot that is serialized, before the file is
 * produced, so a copy is never written with unclaimed bytes. Returns filename.
 */
export async function downloadProjectJSON(): Promise<string> {
  const snapshot = useEditorStore.getState().doc
  const token = currentProjectToken()
  const json = JSON.stringify(serializeDoc(snapshot), null, 2)
  if (collectMediaHashes(snapshot).length > 0) {
    // Hold an independent shared lock on this copy through publication. The
    // active hold may switch to another project (or be released) while the
    // claim writes; without this, another tab's clean of this project would
    // no longer see our announcement and could delete what we are claiming.
    let claimLock: ProjectLock | null = null
    try {
      claimLock = await ProjectLock.acquire(snapshot.project.id)
    } catch {
      claimLock = null
    }
    try {
      const claimed = await writeProjectClaim(snapshot)
      if (!claimed) throw new ProjectClaimError()
    } finally {
      if (claimLock && claimLock !== currentProjectLock()) claimLock.dispose()
    }
    // The claim succeeded: a previous degraded open can clean again. Only for
    // the project this save belongs to; a newer install owns its own flag.
    if (isProjectTokenCurrent(token)) {
      useEditorStore.getState().setMediaCleanBlocked(false)
    }
  }
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const filename = projectFileName(snapshot.project.name)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
  return filename
}

/** Parse + validate a saved project file into a Doc (throws on invalid JSON/version). */
export async function loadProjectFile(file: File): Promise<{ doc: Doc; warnings: string[] }> {
  const text = await file.text()
  // Parse the text HERE: deserializeDoc validates an already-parsed value, and
  // feeding it the raw string failed every real open with "root is not an
  // object" (autosave restore used parseSerializedDoc and worked).
  const { doc, warnings } = parseSerializedDoc(text)
  return { doc, warnings }
}

/**
 * The relink patch for a freshly probed file. The hash is part of the patch
 * only when the bytes are actually stored; a session-only relink clears it so
 * no persisted hash names bytes the store does not have.
 */
export function relinkPatchFor(fresh: MediaAsset, stored: boolean): Partial<MediaAsset> {
  return {
    ...relinkPatchFrom(fresh, 'manual'),
    contentHash: stored ? fresh.contentHash : undefined,
  }
}

/**
 * Import media files into the project, auto-relinking assets whose name
 * matches an offline (missing) asset. Returns the number of files imported
 * (relinks count as imports). Never throws: failures surface as toasts.
 */
export async function importMediaFiles(files: FileList | File[]): Promise<number> {
  let imported = 0
  const heavy: MediaAsset[] = []
  // One token for the whole batch. A project replacement between files must
  // stop the remaining imports instead of attaching them to the new project.
  const token = currentProjectToken()
  for (const file of Array.from(files)) {
    if (!isProjectTokenCurrent(token)) return imported
    const { asset, stopped } = await importOneMediaFile(file, {}, heavy, token)
    if (stopped || !isProjectTokenCurrent(token)) return imported
    if (asset) imported += 1
  }
  if (!isProjectTokenCurrent(token)) return imported
  handleHeavySources(heavy)
  return imported
}

/**
 * Imports one recorded file through the same probe, store, and add-media path
 * as a picked file. `durationHint` fills a container duration the browser
 * cannot read (MediaRecorder WebM). Returns the attached asset, or null when
 * the import failed or the project changed.
 */
export async function importRecordedFile(
  file: File,
  durationHint?: number,
): Promise<MediaAsset | null> {
  const heavy: MediaAsset[] = []
  const token = currentProjectToken()
  const { asset } = await importOneMediaFile(file, { durationHint }, heavy, token)
  // A replacement after the attach still owns none of this take's follow-up.
  if (!isProjectTokenCurrent(token)) return null
  handleHeavySources(heavy)
  return asset
}

/** One file through probe, store, relink-or-add. `stopped` means the project changed. */
async function importOneMediaFile(
  file: File,
  options: { durationHint?: number },
  heavy: MediaAsset[],
  token: ProjectToken = currentProjectToken(),
): Promise<{ asset: MediaAsset | null; stopped: boolean }> {
  // The project can be replaced while a probe or a store write is in flight.
  // A completion from the old project must not attach its bytes to the new
  // one, so every await is followed by a token check.
  let fresh: MediaAsset | null = null
  /** True only once the doc takes the probed asset. */
  let attached = false
  try {
    fresh = await importFile(file, options)
    if (!isProjectTokenCurrent(token)) return { asset: null, stopped: true }
    const { asset, stored, warning } = await storeMediaAsset(token.projectId, fresh)
    if (!isProjectTokenCurrent(token)) return { asset: null, stopped: true }
    if (warning) {
      toast({
        title: 'Media is session-only',
        description: warning,
        variant: 'destructive',
      })
    }
    // Re-read after the awaits: the doc may have changed while the bytes wrote.
    const store = useEditorStore.getState()
    const missing = store.doc.media.find((m) => m.missing && m.name === asset.name)
    if (missing) {
      if (
        !store.apply({
          type: 'relinkMedia',
          mediaId: missing.id,
          patch: relinkPatchFor(asset, stored),
        })
      )
        return { asset: null, stopped: false }
      attached = true
      toast({ title: 'Media relinked', description: asset.name })
      // The reducer keeps the offline entry's id, so callers that place a clip
      // must receive that entry, not the freshly probed asset.
      const linked = useEditorStore.getState().doc.media.find((m) => m.id === missing.id)
      return { asset: linked ?? asset, stopped: false }
    }
    if (!store.apply({ type: 'addMediaAsset', asset })) return { asset: null, stopped: false }
    attached = true
    if (shouldProxy(asset)) heavy.push(asset)
    return { asset, stopped: false }
  } catch (error) {
    if (!isProjectTokenCurrent(token)) return { asset: null, stopped: true }
    toast({
      title: `Could not import ${file.name}`,
      description: error instanceof Error ? error.message : String(error),
      variant: 'destructive',
    })
    return { asset: null, stopped: false }
  } finally {
    // A refused relink (a locked track) or a replaced project leaves the
    // probed bytes owned by nobody; release their object URL with them.
    if (fresh && !attached) discardFreshMedia(fresh)
  }
}

/** Heavy sources: build a proxy now when proxies are on, else prompt once. */
function handleHeavySources(heavy: MediaAsset[]): void {
  if (heavy.length === 0) return
  if (useEditorStore.getState().proxiesEnabled) {
    for (const asset of heavy) void buildProxy(asset)
    return
  }
  toast({
    title: 'Heavy source imported',
    description: `${heavy.map((a) => a.name).join(', ')} exceeds 1920 px. Enable View > Use Proxies for smoother preview.`,
  })
}

/** Trigger the browser file picker and resolve with the selected files. */
export function pickFiles(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.multiple = multiple
    input.style.display = 'none'
    input.addEventListener('change', () => {
      resolve(input.files ? Array.from(input.files) : [])
      input.remove()
    })
    // If the user cancels, `change` never fires: resolve empty on focus return.
    window.addEventListener('focus', () => setTimeout(() => resolve([]), 300), { once: true })
    document.body.appendChild(input)
    input.click()
  })
}

// project install coordination

/**
 * Project-install coordination.
 *
 * A project load is not one step: pick the file, parse it, mark unresolved
 * assets missing, install. Between the pick and the install, the user can
 * start another load from EITHER entry point (toolbar button, File > Open),
 * or install a project in some other way (File > New). Whichever lands last
 * wins, so every loader asks the shared generation before it installs, and
 * every installer invalidates the loads that are still in flight.
 *
 * This lives here and not in a component: MenuBar and Toolbar each held their
 * own counter, which only ordered loads that passed through the SAME handler.
 * A toolbar open and a menu open could still clobber each other, and neither
 * counter was bumped by `file.newProject`, so a pending load could overwrite
 * a brand-new empty project.
 */
let projectGeneration = 0

/** Invalidates every project load still in flight. Call when a project is installed by any means. */
export function bumpProjectGeneration(): number {
  return ++projectGeneration
}

/** True when `loadId` is still the newest project request. */
export function isCurrentProjectLoad(loadId: number): boolean {
  return loadId === projectGeneration
}

// multi-tab media lock

let activeProjectLock: ProjectLock | null = null
let activeLockProjectId: string | null = null
/**
 * A lock acquired for a doc that is about to be installed but is not live yet.
 * It is held alongside the installed project's lock, so another tab's clean
 * cannot slip in while a restore or open prepares, and it is swapped in by
 * `installProject`.
 */
let preparedLock: ProjectLock | null = null
let preparedLockProjectId: string | null = null
/** Orders concurrent `ensureProjectLock` calls so a superseded open cannot steal the lock. */
let lockRequest = 0

/** Removes and disposes the prepared lock unless it belongs to `projectId`. */
function takePreparedLock(projectId: string): ProjectLock | null {
  if (preparedLockProjectId !== projectId) {
    preparedLock?.dispose()
    preparedLock = null
    preparedLockProjectId = null
    return null
  }
  const lock = preparedLock
  preparedLock = null
  preparedLockProjectId = null
  return lock
}

function activateLock(lock: ProjectLock, projectId: string): void {
  if (activeProjectLock === lock && activeLockProjectId === projectId) return
  activeProjectLock?.dispose()
  activeProjectLock = lock
  activeLockProjectId = projectId
}

/**
 * Holds the shared project lock for the installed doc, or prepares one for a
 * doc that is about to be installed. Idempotent per project id. A caller that
 * was superseded releases the lock it just acquired and gets null.
 *
 * `forInstall` keeps the installed project's lock until `installProject`
 * swaps the prepared one in, so a failed or discarded load never drops the
 * live project's hold. Each load owns a distinct prepared hold: a newer load
 * supersedes and disposes the previous one, so a stale load's cancellation can
 * never release a newer load's hold.
 */
export async function ensureProjectLock(
  doc: Doc,
  options: { forInstall?: boolean } = {},
): Promise<ProjectLock | null> {
  // Advance the token BEFORE the idempotent reuse check: a re-opened current
  // project must invalidate an acquire for another project that is still
  // waiting, or that older request would later dispose this lock and take over.
  const request = ++lockRequest
  if (activeLockProjectId === doc.project.id && activeProjectLock) return activeProjectLock
  const acquired = await ProjectLock.acquire(doc.project.id)
  if (request !== lockRequest) {
    // A newer project request won while this one waited for the lock.
    acquired.dispose()
    return null
  }
  if (options.forInstall) {
    preparedLock?.dispose()
    preparedLock = acquired
    preparedLockProjectId = doc.project.id
    return acquired
  }
  // The doc is already live: hand the lock over now. A prepared hold for the
  // same project is reused instead of leaked: it leaves the registry here but
  // its shared hold would otherwise stay unreachable to releaseProjectLock.
  const prepared = takePreparedLock(doc.project.id)
  if (prepared) {
    activateLock(prepared, doc.project.id)
    acquired.dispose()
    return activeProjectLock
  }
  activateLock(acquired, doc.project.id)
  return activeProjectLock
}

/** The lock held for the current project, when one has been acquired. */
export function currentProjectLock(): ProjectLock | null {
  return activeProjectLock
}

/**
 * Releases the hold a cancelled or superseded load acquired, identified by its
 * own lock object rather than by project id. The installed project's lock and
 * another load's prepared hold are never touched.
 */
export function discardProjectLock(lock: ProjectLock | null): void {
  if (!lock || lock === activeProjectLock) return
  if (preparedLock === lock) {
    preparedLock = null
    preparedLockProjectId = null
  }
  lock.dispose()
}

/** Releases the shared media lock (page teardown). */
export function releaseProjectLock(): void {
  // Retire any acquisition still waiting: without the bump it would see a
  // current request, activate, and resurrect a hold after teardown.
  lockRequest += 1
  preparedLock?.dispose()
  preparedLock = null
  preparedLockProjectId = null
  activeProjectLock?.dispose()
  activeProjectLock = null
  activeLockProjectId = null
}

/**
 * THE project install path (0.20.0): invalidate in-flight loads, revoke the
 * old project's proxy URLs, replace the doc, and clear any restore banner.
 * Every installer routes through this, so no path can leave a stale autosave
 * prompt over a project that is already live. Callers keep their warnings and
 * toasts.
 *
 * 0.23.0: the new project announces itself to other tabs through the shared
 * media lock. A prepared lock (from `ensureProjectLock(..., { forInstall })`)
 * swaps in here, after the doc has been replaced, so the old project's hold is
 * never dropped before this install commits. The fallback acquisition is not
 * awaited so this stays synchronous.
 */
export function installProject(doc: Doc, stagedFonts?: StagedProjectFonts): void {
  bumpProjectGeneration()
  revokeAllProxies()
  // The font registry follows the installed project. An open stages the
  // incoming faces without touching the registry, so this activation is the
  // single commit point: a superseded open drops its staged set and the
  // installed project's faces are never disturbed. Paths without a staged
  // set (a brand-new project) fall back to the live registry switch.
  if (stagedFonts && stagedFonts.projectId === doc.project.id) {
    activateStagedProjectFonts(stagedFonts)
  } else {
    // The fallback load is fire-and-forget; the shell repaints once it lands.
    void activateProjectFonts(doc)
  }
  const prepared = takePreparedLock(doc.project.id)
  const store = useEditorStore.getState()
  store.replaceDoc(doc)
  store.clearPendingRestore()
  // A fresh install has no unclaimed stored bytes; a degraded open sets the
  // flag again after this call.
  store.setMediaCleanBlocked(false)
  if (prepared) activateLock(prepared, doc.project.id)
  else void ensureProjectLock(doc)
  // Every installed project owns a project directory with an empty claims
  // directory, even before its first save.
  void prepareProjectStore(doc.project.id)
}

/** Rehydration + claim for a doc that is about to be installed, or null when superseded. */
async function prepareForInstall(
  doc: Doc,
  loadId: number,
): Promise<{
  doc: Doc
  warnings: string[]
  claimFailed: boolean
  stagedFonts: StagedProjectFonts
} | null> {
  const lock = await ensureProjectLock(doc, { forInstall: true })
  if (!lock || !isCurrentProjectLoad(loadId)) {
    discardProjectLock(lock)
    return null
  }
  const rehydration = await rehydrateMedia(doc)
  if (!isCurrentProjectLoad(loadId)) {
    revokeRehydratedUrls(rehydration.urls)
    discardProjectLock(lock)
    return null
  }
  // Staged, never live: a superseded request drops its staged faces below and
  // the installed project's registry is untouched either way.
  const stagedFonts = await stageProjectFontFaces(rehydration.doc)
  if (!isCurrentProjectLoad(loadId)) {
    revokeRehydratedUrls(rehydration.urls)
    discardProjectLock(lock)
    return null
  }
  // The claims directory exists for every installed project, empty or not, so
  // a missing directory always means lost records rather than "nothing saved".
  const storeReady = await prepareProjectStore(rehydration.doc.project.id)
  const hashes = collectMediaHashes(rehydration.doc)
  const claimed = storeReady && (hashes.length === 0 || (await writeProjectClaim(rehydration.doc)))
  if (!isCurrentProjectLoad(loadId)) {
    revokeRehydratedUrls(rehydration.urls)
    discardProjectLock(lock)
    return null
  }
  const warnings = [...rehydration.warnings]
  if (!claimed) {
    warnings.push(
      'Stored media could not be claimed, so Clean Unused Media stays unavailable until you save this project.',
    )
  }
  warnings.push(...stagedFonts.warnings)
  return { doc: rehydration.doc, warnings, claimFailed: !claimed, stagedFonts }
}

/**
 * The one project-open implementation, shared by the menu and the toolbar:
 * parse the chosen file, rehydrate, claim, install, report.
 *
 * A load request is numbered as it ENTERS this function, and parsing,
 * rehydration, install and error reporting all check the generation, so a load
 * that a newer request (or a new project) has superseded writes nothing and
 * reports nothing. Canceling a picker never reaches here, so it can never
 * invalidate a load that is already in flight.
 */
export async function openProjectFile(file: File): Promise<void> {
  const loadId = bumpProjectGeneration()
  // `installProject` bumps the generation itself, so after it starts a load can
  // no longer look "current". Track that transition explicitly: a stale id
  // means superseded only while installation has not started; a failure after
  // that point must still be reported.
  let installStarted = false
  try {
    const { doc: parsed, warnings: parseWarnings } = await loadProjectFile(file)
    if (!isCurrentProjectLoad(loadId)) return // a newer request superseded this one
    const prepared = await prepareForInstall(parsed, loadId)
    if (!prepared) return
    installStarted = true
    installProject(prepared.doc, prepared.stagedFonts)
    if (prepared.claimFailed) useEditorStore.getState().setMediaCleanBlocked(true)
    const remaining = prepared.doc.media.filter((asset) => asset.missing).length
    const description = [
      remaining > 0 ? `${remaining} media file(s) need relinking.` : undefined,
      ...parseWarnings,
      ...prepared.warnings,
    ]
      .filter(Boolean)
      .join(' ')
    toast({
      title: 'Project loaded',
      description: description || undefined,
    })
  } catch (error) {
    if (!installStarted && !isCurrentProjectLoad(loadId)) return
    toast({
      title: 'Load failed',
      description: error instanceof Error ? error.message : String(error),
      variant: 'destructive',
    })
  }
}

/**
 * The autosave banner's install path. Rehydrates first, then installs through
 * the one install function. An autosave restore writes no claim: the slot is a
 * live reference and clean reads it directly. Returns null when superseded.
 */
export async function restoreAutosaveProject(
  restore: PendingRestore,
  stillWanted: () => boolean = () => true,
): Promise<{ doc: Doc; warnings: string[] } | null> {
  const loadId = bumpProjectGeneration()
  const lock = await ensureProjectLock(restore.doc, { forInstall: true })
  if (!lock || !isCurrentProjectLoad(loadId) || !stillWanted()) {
    discardProjectLock(lock)
    return null
  }
  const rehydration = await rehydrateMedia(restore.doc)
  if (!isCurrentProjectLoad(loadId) || !stillWanted()) {
    revokeRehydratedUrls(rehydration.urls)
    discardProjectLock(lock)
    return null
  }
  const stagedFonts = await stageProjectFontFaces(rehydration.doc)
  if (!isCurrentProjectLoad(loadId) || !stillWanted()) {
    revokeRehydratedUrls(rehydration.urls)
    discardProjectLock(lock)
    return null
  }
  const doc = rehydration.doc
  installProject(doc, stagedFonts)
  return {
    doc,
    warnings: [...restore.warnings, ...rehydration.warnings, ...stagedFonts.warnings],
  }
}

/**
 * File > Open with the picker: choose a file, then hand it to `openProjectFile`.
 * A canceled picker returns without touching the generation, so an in-flight
 * load stays current.
 */
export async function openProjectFromPicker(accept = '.json,application/json'): Promise<void> {
  const files = await pickFiles(accept)
  const file = files[0]
  if (!file) return // canceled picker: an in-flight load stays current
  return openProjectFile(file)
}
