/**
 * persist.ts: the bridge between media assets and the durable store (0.23.0).
 *
 * `importFile` attaches a content hash; this module makes the bytes durable
 * before an asset reaches the document. A store failure never blocks an import:
 * the asset stays session-only (no `contentHash`) with a warning, so no saved
 * project can name bytes that were never stored. The activity counter lets the
 * clean action refuse while a write is in flight.
 *
 * Browser-bound.
 */

import { isValidContentHash } from '../project-validation'
import { collectMediaHashes, planMediaCleanup } from '../media-cleanup-plan'
import type { Doc, MediaAsset } from '../types'
import {
  cleanProjectMedia,
  clearProjectMedia,
  ensureProjectMedia,
  isMediaStoreSupported,
  listMediaFiles,
  readMediaClaims,
  writeMediaClaim,
  writeMediaFile,
} from './media-store'
import type { MediaClearResult } from './media-store'
import type { ProjectLock } from './project-lock'

let activeWrites = 0
let cleanInProgress = false
const cleanWaiters: Array<() => void> = []
const activityWaiters: Array<() => void> = []

/** True while an import, relink, or rehydration is writing or reading media. */
export function isMediaActivityActive(): boolean {
  return activeWrites > 0
}

/** Marks a media read or write as in flight; the clean action refuses while any is. */
export function beginMediaActivity(): void {
  activeWrites += 1
}

export function endMediaActivity(): void {
  activeWrites = Math.max(0, activeWrites - 1)
  if (activeWrites === 0) {
    for (const resolve of activityWaiters.splice(0)) resolve()
  }
}

/**
 * Waits for same-tab media work that already started to finish. Call only with
 * the clean flag held: then no new write can begin, so this terminates.
 */
async function waitForMediaActivityIdle(): Promise<void> {
  while (activeWrites > 0) {
    await new Promise<void>((resolve) => activityWaiters.push(resolve))
  }
}

async function waitForClean(): Promise<void> {
  while (cleanInProgress) {
    await new Promise<void>((resolve) => cleanWaiters.push(resolve))
  }
}

/**
 * Starts a media read or write, waiting while a same-tab clean is running.
 * The reservation is synchronous, so a clean that flips its flag cannot miss a
 * write that starts in the same turn.
 */
export async function beginMediaActivityWhenIdle(): Promise<void> {
  while (cleanInProgress) {
    await new Promise<void>((resolve) => cleanWaiters.push(resolve))
  }
  beginMediaActivity()
}

/**
 * Runs a clean while every same-tab import, relink, Freeze Frame write, and
 * rehydration waits. The clean holds the flag from its activity check through
 * the last delete, so a candidate hash cannot be written or attached between
 * the reference snapshot and the delete.
 */
export async function runCleanExclusive<T>(fn: () => Promise<T>): Promise<T> {
  // Set the flag before the first yield so a write that starts in this same
  // turn sees a running clean and waits instead of racing its deletes. Recheck
  // after every wait: the wake-up releases every waiter at once, so two
  // waiters must not both enter the protected region.
  while (cleanInProgress) await waitForClean()
  cleanInProgress = true
  try {
    return await fn()
  } finally {
    cleanInProgress = false
    for (const resolve of cleanWaiters.splice(0)) resolve()
  }
}

export interface StoredMediaAsset {
  /** The asset to put in the doc: no `contentHash` when the bytes are session-only. */
  asset: MediaAsset
  stored: boolean
  /** User-facing explanation when the bytes could not be stored. */
  warning?: string
}

/** Removes the hash, because a session-only asset must not name stored bytes. */
function sessionOnly(asset: MediaAsset): MediaAsset {
  const { contentHash: _dropped, ...rest } = asset
  return { ...rest, missing: false }
}

/**
 * Writes a probed asset's bytes to the project store and returns the asset to
 * attach. The hash is set only after the write succeeds.
 */
export async function storeMediaAsset(
  projectId: string,
  asset: MediaAsset,
): Promise<StoredMediaAsset> {
  if (!asset.file || !isValidContentHash(asset.contentHash)) {
    return {
      asset: sessionOnly(asset),
      stored: false,
      warning: `Could not store ${asset.name} for reload. Relink it after reopening the project.`,
    }
  }
  // Wait for a same-tab clean instead of interleaving with it: a clean that
  // already snapshotted its candidates must not see this hash written and
  // attached before its deletes.
  await beginMediaActivityWhenIdle()
  try {
    // A fresh session's doc never passed through an install, so its project
    // directory and (empty) claims directory may not exist yet. Creating them
    // here is what makes the first import cleanable: without a claims
    // directory, clean must assume a closed copy's claims were lost.
    await ensureProjectMedia(projectId)
    await writeMediaFile(projectId, asset.contentHash, asset.file)
    return { asset, stored: true }
  } catch {
    return {
      asset: sessionOnly(asset),
      stored: false,
      warning: `Could not store ${asset.name} for reload. Relink it after reopening the project.`,
    }
  } finally {
    endMediaActivity()
  }
}

/**
 * Writes a claim shard for every hash the doc references. Returns false when
 * the store is unavailable or rejects the claim; callers open degraded rather
 * than block the project.
 */
export async function writeProjectClaim(doc: Doc): Promise<boolean> {
  const hashes = collectMediaHashes(doc)
  if (hashes.length === 0) return true
  try {
    // An existing project that lost its claims cannot be repaired by writing a
    // shard for the current hashes only: another saved copy's claims are still
    // unknown. Refuse so clean stays blocked and the save reports the risk.
    const state = await ensureProjectMedia(doc.project.id)
    if (state !== 'ready') return false
    await writeMediaClaim(doc.project.id, hashes)
    return true
  } catch {
    return false
  }
}

/** Creates the project and claims directories before a doc is installed. */
export async function prepareProjectStore(projectId: string): Promise<boolean> {
  try {
    return (await ensureProjectMedia(projectId)) === 'ready'
  } catch {
    return false
  }
}

// cleanup

export type MediaCleanRefusal =
  'unsupported' | 'activity' | 'unclaimed' | 'claims' | 'busy' | 'changed'

export interface MediaCleanReport {
  deleted: string[]
  reclaimed: number
}

/** Clear All's outcome: `busy` means another open tab holds the project. */
export type MediaClearOutcome =
  { status: 'ran'; result: MediaClearResult } | { status: 'busy' } | { status: 'unsupported' }

export interface UnusedMediaListing {
  candidates: { hash: string; size: number }[]
  reclaimed: number
  blocked: boolean
}

/** Candidates for the confirmation list: stored hashes nothing references or claims. */
export async function listUnusedMedia(
  projectId: string,
  referenced: ReadonlySet<string>,
): Promise<UnusedMediaListing> {
  if (!isMediaStoreSupported()) return { candidates: [], reclaimed: 0, blocked: false }
  try {
    // Media and font bytes share the reference/claim sets and the clean action,
    // so the listing unions both namespaces (one hash used by both counts once).
    const byHash = new Map<string, number>()
    for (const entry of [
      ...(await listMediaFiles(projectId)),
      ...(await listMediaFiles(projectId, 'fonts')),
    ]) {
      byHash.set(entry.hash, (byHash.get(entry.hash) ?? 0) + entry.size)
    }
    const stored = [...byHash].map(([hash, size]) => ({ hash, size }))
    const claimed = await readMediaClaims(projectId)
    const plan = planMediaCleanup({ stored, referenced, claimed })
    return { candidates: plan.candidates, reclaimed: plan.reclaimed, blocked: plan.blocked }
  } catch {
    // An unreadable store must not report "nothing to clean": mark it blocked.
    return { candidates: [], reclaimed: 0, blocked: true }
  }
}

/**
 * Deletes the unclaimed, unreferenced entries under the exclusive project lock.
 * Refuses when the store is unavailable, a claim is missing, a media write is
 * in flight, or another tab has the project open. References are read again
 * inside the lock, so a hash that became reachable while the dialog was open
 * survives.
 */
export async function cleanUnusedMedia(input: {
  projectId: string
  lock: ProjectLock | null
  cleanBlocked: boolean
  referenced: () => ReadonlySet<string>
  /**
   * Checked inside the same-tab clean flag, immediately before the deletes. The
   * referenced set is read from the live doc, so a project installed while the
   * confirmation was open would otherwise clean the old project's directory
   * against the new project's references.
   */
  isProjectCurrent?: () => boolean
}): Promise<{ status: 'ran'; report: MediaCleanReport } | { status: MediaCleanRefusal }> {
  if (!isMediaStoreSupported()) return { status: 'unsupported' }
  if (input.cleanBlocked) return { status: 'unclaimed' }
  if (isMediaActivityActive()) return { status: 'activity' }
  const { lock } = input
  // A lock for another project proves nothing about this one: an undo that
  // restored a different project leaves the old hold active. Refuse rather
  // than delete under the wrong project's coordination.
  if (!lock || lock.projectId !== input.projectId) return { status: 'unsupported' }
  const preview = await listUnusedMedia(input.projectId, input.referenced())
  if (preview.blocked) return { status: 'claims' }
  if (preview.candidates.length === 0) {
    return { status: 'ran', report: { deleted: [], reclaimed: 0 } }
  }
  const outcome = await lock.exclusive(async () => {
    // The exclusive lock excludes other tabs, not this tab's own work: a
    // keyboard-started import can begin while the confirmation is open. Hold
    // the clean flag across the activity check and every delete, so an import
    // that starts after the check waits instead of writing a candidate hash.
    return runCleanExclusive(async () => {
      if (input.isProjectCurrent && !input.isProjectCurrent()) return 'changed'
      if (isMediaActivityActive()) return null
      return cleanProjectMedia(input.projectId, [...input.referenced()])
    })
  })
  if (outcome.status === 'busy') return { status: 'busy' }
  if (outcome.status === 'unsupported') return { status: 'unsupported' }
  if (outcome.value === null) return { status: 'activity' }
  if (outcome.value === 'changed') return { status: 'changed' }
  if (outcome.value.claimsUnreadable) return { status: 'claims' }
  return {
    status: 'ran',
    report: { deleted: outcome.value.deleted, reclaimed: outcome.value.reclaimed },
  }
}

/**
 * Removes every stored entry and the claims directory. The only destructive
 * path that can break a saved copy; the confirmation owns that warning.
 *
 * Same-tab writes are serialized through the clean flag: no new import, relink,
 * Freeze Frame write, or rehydration starts, and one that already started
 * finishes before the directory snapshot. The deletes run under the exclusive
 * project lock, so another open tab cannot write during or after the snapshot.
 * Without a matching shared hold (no lock, another project's lock, or no Web
 * Locks to coordinate with) there is no cross-tab guard, so the reset refuses
 * instead of reporting a partial clear as complete.
 */
export async function clearAllProjectMedia(input: {
  projectId: string
  lock: ProjectLock | null
}): Promise<MediaClearOutcome> {
  if (!isMediaStoreSupported()) {
    return { status: 'ran', result: { deleted: 0, reclaimed: 0 } }
  }
  const { lock } = input
  if (!lock || lock.projectId !== input.projectId) return { status: 'unsupported' }
  return runCleanExclusive(async () => {
    await waitForMediaActivityIdle()
    const outcome = await lock.exclusive(() => clearProjectMedia(input.projectId))
    if (outcome.status === 'busy') return { status: 'busy' as const }
    if (outcome.status === 'unsupported') return { status: 'unsupported' as const }
    return { status: 'ran' as const, result: outcome.value }
  })
}
