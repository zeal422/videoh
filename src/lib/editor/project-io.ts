'use client'

import { toast } from '@/hooks/use-toast'

import {
  readZipDirectory,
  readZipEntry,
  writeZip,
  zipBlob,
  zipStoreOverhead,
  type ZipInputEntry,
} from './bundle-zip'
import { FONT_FILE_MAX_BYTES } from './constants'
import { fontMimeForFormat, isValidFontId, validateFontBytes } from './fonts'
import { relinkPatchFrom } from './media/relink'
import { importFile } from './media/probe'
import { buildProxy, revokeAllProxies } from './media/proxies'
import { collectMediaHashes } from './media-cleanup-plan'
import {
  beginMediaActivityWhenIdle,
  endMediaActivity,
  inspectProjectStore,
  prepareProjectStore,
  storeMediaAsset,
  writeProjectClaim,
  writeProjectClaimOutcome,
} from './media/persist'
import {
  deleteMediaClaim,
  ensureProjectMedia,
  hasAnyInstallClaims,
  hashFile,
  isMediaStoreSupported,
  listMediaFiles,
  readMediaClaims,
  readMediaClaimShards,
  readMediaFile,
  sha256Hex,
  writeMediaClaim,
  writeMediaFile,
} from './media/media-store'
import { mimeTypeForName } from './media/rehydrate'
import { newInstallId, readInstalledRegistryState } from './media/installed-registry'
import {
  claimAutosaveOwnership,
  markAutosaveImported,
  markInstallPending,
  pauseOtherAutosaveTabs,
  queueAutosaveRetry,
  queuePendingInstallRetry,
  recordInstallUnderLock,
  releaseAutosaveOwnership,
  requireAutosaveImportFence,
  resumeAutosaveTabs,
  writeAutosaveCooperatively,
} from './persistence'
import {
  BUNDLE_MANIFEST_PATH,
  BUNDLE_MAX_BLOB_BYTES,
  BUNDLE_MAX_ENTRIES,
  BUNDLE_MAX_ENTRY_BYTES,
  BUNDLE_MAX_MANIFEST_BYTES,
  BUNDLE_MAX_PROJECT_BYTES,
  BUNDLE_MAX_TOTAL_BYTES,
  buildBundleManifest,
  bundleFileName,
  isFontReferenced,
  isValidBundleMediaId,
  matchBundleFonts,
  matchBundleMedia,
  planBundleEntries,
  validateBundleManifest,
  type BundleManifestAsset,
  type BundleManifestFont,
} from './project-bundle'
import { isValidContentHash } from './project-validation'
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
 * True when every stored media and font hash is referenced by the saved
 * snapshot or protected by a claim shard. A missing or unreadable store is
 * "not covered": the clean block stays until the bytes can be proven safe.
 *
 * Read the claims BEFORE listing stored bytes. A write that lands while the
 * claims are read is then visible to the listing, while a claim written after
 * the read only makes the answer conservatively false. Listing first would let
 * a hash stored between the listing and the claims read look covered.
 */
async function storedHashesCovered(
  projectId: string,
  referenced: ReadonlySet<string>,
): Promise<boolean> {
  const claims = await readMediaClaims(projectId)
  if (claims === null) return false
  const media = await listMediaFiles(projectId, 'media')
  const fonts = await listMediaFiles(projectId, 'fonts')
  const stored = [...media.map((entry) => entry.hash), ...fonts.map((entry) => entry.hash)]
  const unprotected = stored.filter((hash) => !referenced.has(hash))
  if (unprotected.length === 0) return true
  // Only a stored hash that the snapshot does not reference needs a claim.
  const claimed = new Set(claims)
  return unprotected.every((hash) => claimed.has(hash))
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
  const hashes = collectMediaHashes(snapshot)
  if (hashes.length > 0) {
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
      // A saved copy records the install id of its claim, so an orphan-shard
      // recovery can tell a completed save from a crashed bundle import. If
      // the registry write fails, the shard is written without an id and is
      // kept forever, which is the safe direction.
      // A lost registry must not be replaced by an incomplete one. Read the
      // shards before this save appends its record; a missing or unreadable
      // claims record is unknown history, so treat it as such.
      let hadInstallClaims = true
      try {
        const existing = await readMediaClaimShards(snapshot.project.id)
        hadInstallClaims =
          existing === null || existing.shards.some((shard) => shard.installId !== null)
      } catch {
        hadInstallClaims = true
      }
      // A missing registry must not be recreated from this copy alone:
      // another project's install-tagged shards would then look orphaned.
      if (!hadInstallClaims && readInstalledRegistryState().status === 'missing') {
        hadInstallClaims = await hasAnyInstallClaims()
      }
      const installId = newInstallId()
      let recorded = false
      try {
        recorded = await recordInstallUnderLock(snapshot.project.id, installId, hadInstallClaims)
      } catch {
        recorded = false
      }
      const claimed = await writeProjectClaim(snapshot, recorded ? installId : undefined)
      if (!claimed) throw new ProjectClaimError()
    } finally {
      if (claimLock && claimLock !== currentProjectLock()) claimLock.dispose()
    }
    // The claim succeeded, but a previous degraded open can clean again only
    // when the snapshot plus the claim set covers every stored hash: an
    // earlier copy's unclaimed bytes must keep the guard. Only for the project
    // this save belongs to; a newer install owns its own reason. No reason
    // means there is nothing to clear, so a normal save skips the store walk.
    if (useEditorStore.getState().mediaCleanBlockReason !== null) {
      let covered = false
      try {
        covered = await storedHashesCovered(snapshot.project.id, new Set(hashes))
      } catch {
        covered = false
      }
      if (covered && isProjectTokenCurrent(token)) {
        useEditorStore.getState().setMediaCleanBlockReason(null)
      }
    }
  } else if (useEditorStore.getState().mediaCleanBlockReason !== null) {
    // A no-hash save cannot repair an unclaimed stored asset, so it clears
    // only when an existing claim already protects every stored hash. After
    // Clear All there are no stored hashes, which is the repair path.
    try {
      const storeState = await ensureProjectMedia(snapshot.project.id)
      if (storeState === 'ready') {
        const covered = await storedHashesCovered(snapshot.project.id, new Set())
        if (covered && isProjectTokenCurrent(token)) {
          useEditorStore.getState().setMediaCleanBlockReason(null)
        }
      }
    } catch {
      // Leave the reason: the store could not prove the bytes are protected.
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
  // reason again after this call.
  store.setMediaCleanBlockReason(null)
  if (prepared) activateLock(prepared, doc.project.id)
  else void ensureProjectLock(doc)
  // Every installed project owns a project directory with an empty claims
  // directory, even before its first save.
  void prepareProjectStore(doc.project.id)
}

/**
 * The warning shown after a degraded open, per cause. Only a failed claim
 * write can be repaired by a save; lost records need Clear All first, and an
 * unavailable store cannot be claimed at all.
 */
const CLAIM_FAILURE_WARNINGS: Record<
  'claims-missing' | 'claim-write' | 'storage-unavailable',
  string
> = {
  'claims-missing':
    'This project lost its saved-copy records, so Clean Unused Media stays unavailable. Use Clear All Stored Media, then save this project again.',
  'claim-write':
    'Stored media could not be claimed, so Clean Unused Media stays unavailable. A save repairs this only when it references or claims every stored asset; otherwise use Clear All Stored Media.',
  'storage-unavailable':
    'Media storage is unavailable in this browser, so Clean Unused Media stays unavailable and stored media cannot be claimed.',
}

/** Rehydration + claim for a doc that is about to be installed, or null when superseded. */
async function prepareForInstall(
  doc: Doc,
  loadId: number,
): Promise<{
  doc: Doc
  warnings: string[]
  claimFailure: 'claims-missing' | 'claim-write' | 'storage-unavailable' | null
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
  // Classify instead of collapsing: only a claim-write failure is repairable
  // by a later save that covers the stored bytes.
  const storeState = await inspectProjectStore(rehydration.doc.project.id)
  let claimFailure: 'claims-missing' | 'claim-write' | 'storage-unavailable' | null = null
  if (storeState !== 'ready') {
    claimFailure = storeState
  } else if (collectMediaHashes(rehydration.doc).length > 0) {
    // Classify the write itself: the store can disappear between the check
    // above and this call, and that is not a rejected claim.
    const outcome = await writeProjectClaimOutcome(rehydration.doc)
    if (outcome !== 'claimed') claimFailure = outcome
  }
  if (!isCurrentProjectLoad(loadId)) {
    revokeRehydratedUrls(rehydration.urls)
    discardProjectLock(lock)
    return null
  }
  const warnings = [...rehydration.warnings]
  if (claimFailure) warnings.push(CLAIM_FAILURE_WARNINGS[claimFailure])
  warnings.push(...stagedFonts.warnings)
  return { doc: rehydration.doc, warnings, claimFailure, stagedFonts }
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
    if (prepared.claimFailure) {
      useEditorStore
        .getState()
        .setMediaCleanBlockReason(
          prepared.claimFailure === 'claim-write' ? 'unclaimed' : prepared.claimFailure,
        )
    }
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

// project bundles (0.28.0)

/** An export was refused before any archive was written. */
export class BundleExportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BundleExportError'
  }
}

/** An import was refused; nothing was installed. */
export class BundleImportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BundleImportError'
  }
}

export interface PreparedBundle {
  filename: string
  entries: ZipInputEntry[]
  /** Estimated archive bytes including ZIP metadata, used for the Blob-fallback budget. */
  bytes: number
  warnings: string[]
}

export type BundlePrepareResult =
  | { status: 'prepared'; bundle: PreparedBundle }
  | { status: 'needs-font-confirmation'; fonts: string[] }

interface BundleAssetFile {
  entry: BundleManifestAsset
  file: File
}

interface BundleFontFile {
  entry: BundleManifestFont
  file: File
}

function quotedList(names: readonly string[], limit = 6): string {
  const shown = names.slice(0, limit)
  const rest = names.length - shown.length
  return `${shown.map((name) => `"${name}"`).join(', ')}${rest > 0 ? ` and ${rest} more` : ''}`
}

/**
 * Gathers the project snapshot's media and font bytes and builds the two JSON
 * entries plus the manifest. Every `Doc.media` entry and every `Project.fonts`
 * entry is required: unused bin items and brand-kit-only fonts travel too,
 * because the project JSON lists them.
 *
 * Missing media and a stored hash that disagrees with the bytes refuse the
 * export. A missing font is a warning; a missing font the project visibly uses
 * needs confirmation first.
 */
export async function prepareProjectBundle(
  doc: Doc,
  options: { confirmMissingFonts?: boolean } = {},
): Promise<BundlePrepareResult> {
  const projectId = doc.project.id
  const plan = planBundleEntries(doc)
  for (const item of plan.media) {
    if (!isValidBundleMediaId(item.asset.id)) {
      throw new BundleExportError(
        `Cannot bundle this project: media "${item.asset.name}" has an id that is not path-safe.`,
      )
    }
  }
  for (const item of plan.fonts) {
    if (!isValidFontId(item.font.id)) {
      throw new BundleExportError(
        `Cannot bundle this project: font "${item.font.name}" has an id that is not path-safe.`,
      )
    }
  }
  if (plan.media.length + plan.fonts.length + 2 > BUNDLE_MAX_ENTRIES) {
    throw new BundleExportError(
      `Cannot bundle this project: it has more than ${BUNDLE_MAX_ENTRIES} media and font entries.`,
    )
  }
  // Refuse an oversized entry before any stored bytes are hashed:
  // `readMediaFile` verifies by reading the whole file, so the post-read cap is
  // too late to protect the tab.
  const storedSizes = new Map<string, number>()
  const recordStoredSize = (hash: string, size: number): void => {
    // Media and font namespaces can hold the same hash. Keep the largest size:
    // a damaged, oversized media copy must not be hidden by a small font copy.
    if (size > (storedSizes.get(hash) ?? 0)) storedSizes.set(hash, size)
  }
  if (isMediaStoreSupported()) {
    try {
      for (const entry of await listMediaFiles(projectId, 'media')) {
        recordStoredSize(entry.hash, entry.size)
      }
      for (const entry of await listMediaFiles(projectId, 'fonts')) {
        recordStoredSize(entry.hash, entry.size)
      }
    } catch {
      // Storage is available but its sizes cannot be read. Do not hash blind:
      // the whole point of this pass is to refuse before a full read.
      throw new BundleExportError(
        "Cannot inspect this project's stored media sizes, so the bundle was not written. Try again.",
      )
    }
  }
  const plannedSizes: number[] = []
  const entryTooLarge = (): never => {
    throw new BundleExportError(
      `Cannot bundle this project: one entry is larger than the ${Math.round(
        BUNDLE_MAX_ENTRY_BYTES / (1024 * 1024),
      )} MB per-entry limit.`,
    )
  }
  const fontTooLarge = (): never => {
    throw new BundleExportError(
      `Cannot bundle this project: one font is larger than the ${Math.round(
        FONT_FILE_MAX_BYTES / (1024 * 1024),
      )} MB font limit.`,
    )
  }
  for (const { asset } of plan.media) {
    const storedSize = isValidContentHash(asset.contentHash)
      ? storedSizes.get(asset.contentHash)
      : undefined
    const sessionSize = asset.file?.size
    if ((storedSize ?? 0) > BUNDLE_MAX_ENTRY_BYTES) entryTooLarge()
    if ((sessionSize ?? 0) > BUNDLE_MAX_ENTRY_BYTES) entryTooLarge()
    // The read path uses the stored copy first, else the session file. Budget
    // for the larger of the two so either path stays within the limit.
    const planned = Math.max(storedSize ?? 0, sessionSize ?? 0)
    if (planned > 0) plannedSizes.push(planned)
  }
  for (const { font } of plan.fonts) {
    const storedSize = isValidContentHash(font.contentHash)
      ? storedSizes.get(font.contentHash)
      : undefined
    if ((storedSize ?? 0) > FONT_FILE_MAX_BYTES) fontTooLarge()
    if (storedSize !== undefined) plannedSizes.push(storedSize)
  }
  if (plannedSizes.reduce((sum, size) => sum + size, 0) > BUNDLE_MAX_TOTAL_BYTES) {
    throw new BundleExportError(
      `Cannot bundle this project: its media and fonts exceed the ${Math.round(
        BUNDLE_MAX_TOTAL_BYTES / (1024 * 1024 * 1024),
      )} GB bundle limit.`,
    )
  }
  const assetFiles: BundleAssetFile[] = []
  const missingMedia: string[] = []
  const mismatched: string[] = []
  for (const { asset, path } of plan.media) {
    let file: File | null = null
    let sha256: string | null = null
    if (isValidContentHash(asset.contentHash)) {
      const stored = await readMediaFile(projectId, asset.contentHash)
      if (stored) {
        file = new File([stored.file], asset.name, {
          type: stored.type || mimeTypeForName(asset.name),
        })
        // `readMediaFile` verifies the bytes against the hash before returning.
        sha256 = asset.contentHash
      }
    }
    if (!file && asset.file) {
      const computed = await hashFile(asset.file)
      if (isValidContentHash(asset.contentHash) && computed !== asset.contentHash) {
        mismatched.push(asset.name)
        continue
      }
      file = new File([asset.file], asset.name, {
        type: asset.file.type || mimeTypeForName(asset.name),
      })
      sha256 = computed
    }
    if (!file || !sha256) {
      missingMedia.push(asset.name)
      continue
    }
    assetFiles.push({
      entry: {
        id: asset.id,
        path,
        name: asset.name,
        type: file.type || mimeTypeForName(asset.name),
        size: file.size,
        sha256,
      },
      file,
    })
  }
  if (missingMedia.length > 0) {
    throw new BundleExportError(
      `Cannot bundle this project: ${quotedList(missingMedia)} ${missingMedia.length === 1 ? 'has' : 'have'} no stored or session copy. Relink or remove ${missingMedia.length === 1 ? 'it' : 'them'} first.`,
    )
  }
  if (mismatched.length > 0) {
    throw new BundleExportError(
      `Cannot bundle this project: the stored bytes do not match the recorded hash for ${quotedList(mismatched)}. Relink the file first.`,
    )
  }
  const fontFiles: BundleFontFile[] = []
  const missingReferenced: string[] = []
  const warnings: string[] = []
  for (const { font, path } of plan.fonts) {
    const stored = isValidContentHash(font.contentHash)
      ? await readMediaFile(projectId, font.contentHash, 'fonts')
      : null
    if (!stored) {
      if (isFontReferenced(doc, font)) missingReferenced.push(font.name)
      else warnings.push(`Font "${font.name}" is missing from this browser and was left out.`)
      continue
    }
    fontFiles.push({
      entry: {
        id: font.id,
        path,
        name: font.name,
        size: stored.file.size,
        sha256: font.contentHash,
      },
      file: stored.file,
    })
  }
  if (missingReferenced.length > 0 && !options.confirmMissingFonts) {
    return { status: 'needs-font-confirmation', fonts: missingReferenced }
  }
  for (const item of assetFiles) {
    if (item.file.size > BUNDLE_MAX_ENTRY_BYTES) entryTooLarge()
  }
  for (const item of fontFiles) {
    if (item.file.size > FONT_FILE_MAX_BYTES) fontTooLarge()
  }
  const totalBytes = [
    ...assetFiles.map((item) => item.file.size),
    ...fontFiles.map((item) => item.file.size),
  ]
  if (totalBytes.reduce((sum, size) => sum + size, 0) > BUNDLE_MAX_TOTAL_BYTES) {
    throw new BundleExportError(
      `Cannot bundle this project: its media and fonts exceed the ${Math.round(
        BUNDLE_MAX_TOTAL_BYTES / (1024 * 1024 * 1024),
      )} GB bundle limit.`,
    )
  }
  for (const name of missingReferenced) {
    warnings.push(`Font "${name}" is missing from this browser; the bundle falls back to Arial.`)
  }
  const manifest = buildBundleManifest({
    createdAt: new Date().toISOString(),
    assets: assetFiles.map((item) => item.entry),
    fonts: fontFiles.map((item) => item.entry),
  })
  // Never write a manifest this app would refuse to open: a sanitizer change
  // or an unusual id must fail the export, not produce a dead bundle.
  const manifestCheck = validateBundleManifest(manifest)
  if ('error' in manifestCheck) {
    throw new BundleExportError(`Cannot bundle this project: ${manifestCheck.error}`)
  }
  const projectJSON = JSON.stringify(serializeDoc(doc), null, 2)
  const manifestJSON = JSON.stringify(manifest, null, 2)
  const manifestBlob = new Blob([manifestJSON], { type: 'application/json' })
  const projectBlob = new Blob([projectJSON], { type: 'application/json' })
  if (projectBlob.size > BUNDLE_MAX_PROJECT_BYTES) {
    throw new BundleExportError(
      `Cannot bundle this project: its project file is larger than the ${Math.round(
        BUNDLE_MAX_PROJECT_BYTES / (1024 * 1024),
      )} MB limit.`,
    )
  }
  if (manifestBlob.size > BUNDLE_MAX_MANIFEST_BYTES) {
    throw new BundleExportError('Cannot bundle this project: its manifest is too large.')
  }
  const entries: ZipInputEntry[] = [
    { path: BUNDLE_MANIFEST_PATH, data: manifestBlob },
    { path: manifest.project, data: projectBlob },
    ...assetFiles.map((item) => ({ path: item.entry.path, data: item.file })),
    ...fontFiles.map((item) => ({ path: item.entry.path, data: item.file })),
  ]
  const bytes =
    zipStoreOverhead(entries.map((entry) => entry.path)) +
    manifestBlob.size +
    projectBlob.size +
    assetFiles.reduce((sum, item) => sum + item.file.size, 0) +
    fontFiles.reduce((sum, item) => sum + item.file.size, 0)
  return {
    status: 'prepared',
    bundle: { filename: bundleFileName(doc.project.name), entries, bytes, warnings },
  }
}

export type BundleExportOutcome =
  | { status: 'saved'; filename: string; bytes: number; warning?: string }
  | { status: 'cancelled' }
  | { status: 'needs-font-confirmation'; fonts: string[] }

interface SaveFilePickerWindow extends Window {
  showSaveFilePicker?: (options?: {
    suggestedName?: string
    types?: { description?: string; accept: Record<string, string[]> }[]
  }) => Promise<FileSystemFileHandle>
}

function isPickerAbort(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  )
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

/**
 * Refuses a no-picker export that would build an oversized archive in memory.
 * The check runs before `zipBlob`, so the refusal happens before the allocation
 * rather than after it.
 */
export function assertBundleFitsBlob(bytes: number): void {
  if (bytes <= BUNDLE_MAX_BLOB_BYTES) return
  throw new BundleExportError(
    `Cannot bundle this project in this browser: the bundle is about ${Math.ceil(
      bytes / (1024 * 1024),
    )} MB and this browser cannot stream the save. Use a browser with the File System Access API, or reduce the project's media.`,
  )
}

interface PendingBundleHandle {
  handle: FileSystemFileHandle
  suggestedName: string
  /** The project whose bundle was being prepared when the handle was chosen. */
  projectId: string
}

/**
 * A save handle chosen before the heavy preparation. It is kept only across a
 * missing-font confirmation, so the confirmed retry can write without asking
 * for transient user activation a second time.
 */
let pendingBundleHandle: PendingBundleHandle | null = null
/**
 * Bumped when the owning menu goes away. An export still preparing captures
 * this value and must not publish its handle afterward, or a later export
 * would reuse a destination chosen before navigation.
 */
let bundleExportGeneration = 0

/** Drops a handle kept for a font confirmation the user abandoned. */
export function discardPendingBundleExport(): void {
  bundleExportGeneration += 1
  pendingBundleHandle = null
}

async function writeBundleToHandle(
  handle: FileSystemFileHandle,
  entries: ZipInputEntry[],
): Promise<void> {
  let writable: FileSystemWritableFileStream | null = null
  try {
    writable = await handle.createWritable()
    const sink = writable
    await writeZip(entries, {
      write: async (chunk) => {
        await sink.write(chunk as unknown as BufferSource)
      },
    })
    await writable.close()
  } catch (error) {
    await writable?.abort().catch(() => undefined)
    throw error
  }
}

/**
 * Exports the live project as a bundle. The snapshot is captured once, so edits
 * during the write cannot mix project states. A File System Access sink streams
 * the archive; without it the bundle is built in memory, and a bundle over the
 * in-memory budget is refused before the build.
 *
 * The save picker is requested before any media is read: `showSaveFilePicker`
 * needs transient user activation, and hashing a large project can outlast it.
 */
export async function exportProjectBundle(
  options: { confirmMissingFonts?: boolean } = {},
): Promise<BundleExportOutcome> {
  const snapshot = useEditorStore.getState().doc
  const exportGeneration = bundleExportGeneration
  const suggestedName = bundleFileName(snapshot.project.name)
  const picker = (window as SaveFilePickerWindow).showSaveFilePicker
  let handle: FileSystemFileHandle | null = null
  if (typeof picker === 'function') {
    const pending = pendingBundleHandle
    pendingBundleHandle = null
    if (pending && pending.projectId === snapshot.project.id) {
      handle = pending.handle
    } else {
      try {
        handle = await picker.call(window, {
          suggestedName,
          types: [
            {
              description: 'Video editor project bundle',
              accept: { 'application/zip': ['.vebundle.zip'] },
            },
          ],
        })
      } catch (error) {
        if (isPickerAbort(error)) return { status: 'cancelled' }
        throw error
      }
    }
  }
  try {
    const prepared = await prepareProjectBundle(snapshot, options)
    if (prepared.status === 'needs-font-confirmation') {
      if (handle && exportGeneration === bundleExportGeneration) {
        pendingBundleHandle = { handle, suggestedName, projectId: snapshot.project.id }
      }
      return { status: 'needs-font-confirmation', fonts: prepared.fonts }
    }
    const { filename, entries, bytes, warnings } = prepared.bundle
    if (handle) {
      await writeBundleToHandle(handle, entries)
      return {
        status: 'saved',
        filename,
        bytes,
        ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {}),
      }
    }
    assertBundleFitsBlob(bytes)
    const blob = await zipBlob(entries)
    downloadBlob(blob, filename)
    return {
      status: 'saved',
      filename,
      bytes: blob.size,
      ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {}),
    }
  } catch (error) {
    pendingBundleHandle = null
    throw error
  }
}

export interface BundleOpenOutcome {
  status: 'opened' | 'cancelled'
  warnings: string[]
}

function durationForImport(probed: number, serialized: number): number {
  if (Number.isFinite(probed) && probed > 0) return probed
  if (Number.isFinite(serialized)) return serialized
  return 0
}

/**
 * Opens a bundle as a project: validate the archive and manifest, verify every
 * entry, probe the media, promote the bytes, claim them, install once, then
 * update the shared autosave slot under this tab's ownership.
 *
 * Nothing is written before every entry validates, and a failed install leaves
 * no project installed. Promoted hashes stay for the clean action.
 */
export async function openBundleFile(file: File): Promise<BundleOpenOutcome> {
  const loadId = bumpProjectGeneration()
  const probedUrls: string[] = []
  let activityStarted = false
  let claimId: string | null = null
  let claimProjectId: string | null = null
  let ownershipEpoch: number | null = null
  let pauseRequestId: string | null = null
  let installAttempted = false
  let installed = false
  // Bookkeeping values the post-install catch needs: they live inside the try
  // block, but a failure after the install must still report a successful open.
  let installedContext: { projectId: string; installId: string; warnings: string[] } | null = null
  let hadInstallClaims = true
  let preparedLock: ProjectLock | null = null
  let aborted = false

  const abortPreInstall = async (): Promise<void> => {
    if (aborted) return
    aborted = true
    if (claimId && claimProjectId) {
      await deleteMediaClaim(claimProjectId, claimId).catch(() => undefined)
    }
    if (preparedLock) discardProjectLock(preparedLock)
    preparedLock = null
    // Release ownership first: a resumed tab rechecks the record, so it must
    // see this import's claim gone (unless a newer import still holds it).
    if (ownershipEpoch !== null) releaseAutosaveOwnership(ownershipEpoch)
    if (pauseRequestId) resumeAutosaveTabs(pauseRequestId)
  }

  // A cancelled probe loop has not taken ownership or written anything yet, so
  // it can return without the pre-install abort path.
  const cancelBeforeOwnership = (): BundleOpenOutcome => {
    for (const url of probedUrls) URL.revokeObjectURL(url)
    return { status: 'cancelled', warnings: [] }
  }

  try {
    const entries = await readZipDirectory(file, { maxEntries: BUNDLE_MAX_ENTRIES })
    const byPath = new Map(entries.map((entry) => [entry.path, entry]))
    const manifestEntry = byPath.get(BUNDLE_MANIFEST_PATH)
    if (!manifestEntry) throw new BundleImportError('The bundle has no manifest.')
    if (
      manifestEntry.uncompressedSize > BUNDLE_MAX_MANIFEST_BYTES ||
      manifestEntry.compressedSize > BUNDLE_MAX_MANIFEST_BYTES
    ) {
      throw new BundleImportError('The bundle manifest is too large.')
    }
    let manifestValue: unknown
    try {
      manifestValue = JSON.parse(await (await readZipEntry(file, manifestEntry)).text())
    } catch (error) {
      if (error instanceof BundleImportError) throw error
      throw new BundleImportError('The bundle manifest is not valid JSON.')
    }
    const validated = validateBundleManifest(manifestValue)
    if ('error' in validated) throw new BundleImportError(validated.error)
    const manifest = validated.manifest
    const projectEntry = byPath.get(manifest.project)
    if (!projectEntry) throw new BundleImportError('The bundle has no project file.')
    if (
      projectEntry.uncompressedSize > BUNDLE_MAX_PROJECT_BYTES ||
      projectEntry.compressedSize > BUNDLE_MAX_PROJECT_BYTES
    ) {
      throw new BundleImportError('The bundle project file is too large.')
    }
    const projectText = await (await readZipEntry(file, projectEntry)).text()
    const parsed = parseSerializedDoc(projectText)
    const doc = parsed.doc
    const allowedPaths = new Set<string>([
      BUNDLE_MANIFEST_PATH,
      manifest.project,
      ...manifest.assets.map((entry) => entry.path),
      ...manifest.fonts.map((entry) => entry.path),
    ])
    for (const entry of entries) {
      if (!allowedPaths.has(entry.path)) {
        throw new BundleImportError(`The bundle contains an unexpected entry: ${entry.path}`)
      }
    }
    const mediaMatch = matchBundleMedia(doc, manifest)
    if (mediaMatch.errors.length > 0) {
      throw new BundleImportError(mediaMatch.errors.join(' '))
    }
    const fontMatch = matchBundleFonts(doc, manifest)
    if (fontMatch.errors.length > 0) {
      throw new BundleImportError(fontMatch.errors.join(' '))
    }
    const warnings = [
      ...parsed.warnings,
      ...fontMatch.missing.map(
        (font) => `Font "${font.name}" is not in this bundle, so its text falls back to Arial.`,
      ),
    ]

    const media: { asset: MediaAsset; entry: BundleManifestAsset }[] = []
    for (const pair of mediaMatch.assets) {
      if (!isCurrentProjectLoad(loadId)) return cancelBeforeOwnership()
      const zipEntry = byPath.get(pair.entry.path)
      if (!zipEntry || zipEntry.uncompressedSize !== pair.entry.size) {
        throw new BundleImportError(`The bundle entry for "${pair.asset.name}" has the wrong size.`)
      }
      const blob = await readZipEntry(file, zipEntry)
      if (blob.size !== pair.entry.size) {
        throw new BundleImportError(`The bundle entry for "${pair.asset.name}" has the wrong size.`)
      }
      if ((await sha256Hex(await blob.arrayBuffer())) !== pair.entry.sha256) {
        throw new BundleImportError(`The bundle's copy of "${pair.asset.name}" is damaged.`)
      }
      const mediaFile = new File([blob], pair.asset.name, {
        type: pair.entry.type || mimeTypeForName(pair.asset.name),
      })
      let probed: MediaAsset
      try {
        probed = await importFile(mediaFile, {
          durationHint: Number.isFinite(pair.asset.duration) ? pair.asset.duration : undefined,
        })
      } catch {
        throw new BundleImportError(`The bundle's copy of "${pair.asset.name}" could not be read.`)
      }
      probedUrls.push(probed.url)
      media.push({
        asset: {
          ...pair.asset,
          kind: probed.kind,
          duration: durationForImport(probed.duration, pair.asset.duration),
          width: probed.width,
          height: probed.height,
          hasAudio: probed.hasAudio,
          thumbnail: pair.asset.thumbnail ?? probed.thumbnail,
          waveformPeaks: pair.asset.waveformPeaks ?? probed.waveformPeaks,
          contentHash: pair.entry.sha256,
          file: probed.file ?? mediaFile,
          url: probed.url,
          missing: false,
        },
        entry: pair.entry,
      })
    }

    const fonts: BundleFontFile[] = []
    for (const pair of fontMatch.fonts) {
      if (!isCurrentProjectLoad(loadId)) return cancelBeforeOwnership()
      const zipEntry = byPath.get(pair.entry.path)
      if (!zipEntry || zipEntry.uncompressedSize !== pair.entry.size) {
        throw new BundleImportError(`The bundle entry for font "${pair.font.name}" is missing.`)
      }
      const blob = await readZipEntry(file, zipEntry)
      const bytes = new Uint8Array(await blob.arrayBuffer())
      if (bytes.length !== pair.entry.size || (await sha256Hex(bytes)) !== pair.entry.sha256) {
        throw new BundleImportError(`The bundle's copy of font "${pair.font.name}" is damaged.`)
      }
      const format = validateFontBytes(bytes)
      if (!format) {
        warnings.push(
          `Font "${pair.font.name}" is damaged, so its text falls back to Arial. Re-upload it to restore the look.`,
        )
        continue
      }
      fonts.push({
        entry: pair.entry,
        file: new File([bytes], pair.entry.name, { type: fontMimeForFormat(format) }),
      })
    }

    if (!isCurrentProjectLoad(loadId)) {
      for (const url of probedUrls) URL.revokeObjectURL(url)
      return { status: 'cancelled', warnings: [] }
    }

    const claim = await claimAutosaveOwnership()
    if (!claim.ok) throw new BundleImportError(claim.reason)
    ownershipEpoch = claim.epoch
    const pause = await pauseOtherAutosaveTabs()
    // Record the request before checking the result: tabs that acknowledged
    // must be resumed even when another tab timed out.
    pauseRequestId = pause.requestId
    if (!pause.ok) throw new BundleImportError(pause.reason)

    preparedLock = await ensureProjectLock(doc, { forInstall: true })
    if (!preparedLock || !isCurrentProjectLoad(loadId)) {
      await abortPreInstall()
      for (const url of probedUrls) URL.revokeObjectURL(url)
      return { status: 'cancelled', warnings: [] }
    }

    const activity = await beginMediaActivityWhenIdle()
    activityStarted = true
    if (!isCurrentProjectLoad(loadId)) {
      await abortPreInstall()
      for (const url of probedUrls) URL.revokeObjectURL(url)
      return { status: 'cancelled', warnings: [] }
    }
    // The claims directory must exist before the first hash lands: an
    // existing project with stored bytes and no claims record is ambiguous and
    // must never be recreated as "no claims".
    if (!(await prepareProjectStore(doc.project.id))) {
      throw new BundleImportError(
        "This project's stored media records are missing or unreadable, so the bundle was not installed.",
      )
    }
    // Read the pre-import shards before this import adds its own, so a lost
    // registry is marked unknown instead of publishing an incomplete one.
    try {
      const existing = await readMediaClaimShards(doc.project.id)
      hadInstallClaims =
        existing === null || existing.shards.some((shard) => shard.installId !== null)
    } catch {
      hadInstallClaims = true
    }
    // A missing registry must not be recreated from this import alone:
    // another project's install-tagged shards would then look orphaned.
    if (!hadInstallClaims && readInstalledRegistryState().status === 'missing') {
      hadInstallClaims = await hasAnyInstallClaims()
    }
    for (const pair of media) {
      await writeMediaFile(doc.project.id, pair.entry.sha256, pair.asset.file!, 'media')
    }
    for (const font of fonts) {
      await writeMediaFile(doc.project.id, font.entry.sha256, font.file, 'fonts')
    }
    if (!isCurrentProjectLoad(loadId)) {
      await abortPreInstall()
      for (const url of probedUrls) URL.revokeObjectURL(url)
      return { status: 'cancelled', warnings: [] }
    }
    // Adopt the manifest hash for a project that predates content hashes, and
    // for a font whose bytes match the bundle.
    const fontHashById = new Map(fonts.map((font) => [font.entry.id, font.entry.sha256]))
    const hydrated: Doc = {
      ...doc,
      project: {
        ...doc.project,
        fonts: (doc.project.fonts ?? []).map((font) => {
          const hash = fontHashById.get(font.id)
          return hash ? { ...font, contentHash: hash } : font
        }),
      },
      media: media.map((pair) => pair.asset),
    }
    const installId = newInstallId()
    claimProjectId = doc.project.id
    claimId = await writeMediaClaim(doc.project.id, collectMediaHashes(hydrated), installId)
    const stagedFonts = await stageProjectFontFaces(hydrated, activity)
    warnings.push(...stagedFonts.warnings)
    if (!isCurrentProjectLoad(loadId)) {
      await abortPreInstall()
      for (const url of probedUrls) URL.revokeObjectURL(url)
      return { status: 'cancelled', warnings: [] }
    }
    // The doc change triggers the ordinary debounced save. Record the marker
    // requirement first, so that save cannot write the imported slot without it.
    requireAutosaveImportFence(doc.project.id)
    installAttempted = true
    installProject(hydrated, stagedFonts)
    installed = true
    installedContext = { projectId: doc.project.id, installId, warnings }
    let recorded = false
    try {
      recorded = await recordInstallUnderLock(doc.project.id, installId, hadInstallClaims)
    } catch {
      recorded = false
    }
    if (!recorded) {
      if (useEditorStore.getState().doc.project.id === doc.project.id) {
        useEditorStore.getState().setAutosaveStatus('error')
      }
      await markInstallPending(doc.project.id, installId, hadInstallClaims)
      // One retry covers both paths: it serializes at fire time, writes the
      // slot only while the imported project is still live, and otherwise
      // finishes the registry append without touching another project's slot.
      queuePendingInstallRetry(doc.project.id)
      warnings.push(
        'The project was imported, but its install record could not be saved yet. Autosave will retry; keep this tab open. Closing it before the retry saves can lose the imported project.',
      )
      return { status: 'opened', warnings }
    }
    markAutosaveImported()
    // Another project may have become live while the record was appended. Its
    // slot belongs to that project, so the imported snapshot must not replace
    // it. The install record is already durable at this point.
    if (useEditorStore.getState().doc.project.id !== doc.project.id) {
      return { status: 'opened', warnings }
    }
    let slot: 'saved' | 'read-only' | 'error' | 'superseded' = 'error'
    let writtenDoc: Doc | null = null
    try {
      // Compare the doc reference after the write, not its text: every
      // serialization stamps a fresh `savedAt`, which would read as an edit.
      writtenDoc = useEditorStore.getState().doc
      slot = await writeAutosaveCooperatively(
        JSON.stringify(serializeDoc(writtenDoc)),
        undefined,
        doc.project.id,
        doc.project.id,
      )
    } catch {
      slot = 'error'
    }
    if (slot !== 'saved' && slot !== 'superseded') {
      // Retry from the live doc, not the captured JSON: an edit made while the
      // write was blocked must not be replaced by this older snapshot.
      useEditorStore.getState().setAutosaveStatus('error')
      queuePendingInstallRetry(doc.project.id)
      warnings.push(
        'The project was imported, but the shared autosave copy could not be updated yet. Autosave will retry; keep this tab open. Closing it before the retry saves can lose the imported project.',
      )
    } else if (slot === 'superseded') {
      // A newer write for this project won, or another project became live
      // while this write was queued. A replaced coordination record returns
      // 'read-only' and takes the retry branch above, so this arm is a genuine
      // supersession. Only a newer write for this project means this doc saved.
      if (useEditorStore.getState().doc.project.id === doc.project.id) {
        const store = useEditorStore.getState()
        store.setAutosaveStatus('saved')
        store.markAutosaved()
      }
    } else {
      // This write won, but an edit may have landed while it was in flight.
      // Reporting saved while the live doc differs would mark a newer unsaved
      // document as safe, so report pending and let the scheduled save finish.
      const store = useEditorStore.getState()
      if (writtenDoc !== null && store.doc !== writtenDoc) {
        store.setAutosaveStatus('pending')
      } else {
        store.setAutosaveStatus('saved')
        store.markAutosaved()
      }
    }
    return { status: 'opened', warnings }
  } catch (error) {
    if (installed && installedContext) {
      // The project already replaced the live doc and the probed URLs are its
      // media now. A bookkeeping failure must not revoke them or report the
      // open as failed: keep the installed project and ask for a save retry.
      // Other tabs still hold the pre-import doc, so tell them to reload.
      if (useEditorStore.getState().doc.project.id === installedContext.projectId) {
        useEditorStore.getState().setAutosaveStatus('error')
      }
      markAutosaveImported()
      await markInstallPending(
        installedContext.projectId,
        installedContext.installId,
        hadInstallClaims,
      )
      // The payload may never have been serialized (or the write never ran):
      // retry from the live doc so clearing the failure completes the registry
      // append and the slot write with no further edit.
      queuePendingInstallRetry()
      installedContext.warnings.push(
        'The project was opened, but its save record could not be completed. Autosave will retry; keep this tab open. Closing it before the retry saves can lose the imported project.',
      )
      return { status: 'opened', warnings: installedContext.warnings }
    }
    const superseded = !installAttempted && !isCurrentProjectLoad(loadId)
    await abortPreInstall()
    for (const url of probedUrls) URL.revokeObjectURL(url)
    if (superseded) return { status: 'cancelled', warnings: [] }
    throw error
  } finally {
    if (activityStarted) endMediaActivity()
  }
}

/** File > Open Bundle: pick one archive, then open it. Null when cancelled. */
export async function openBundleFromPicker(): Promise<BundleOpenOutcome | null> {
  const files = await pickFiles('.vebundle.zip,application/zip')
  const file = files[0]
  if (!file) return null
  return openBundleFile(file)
}
