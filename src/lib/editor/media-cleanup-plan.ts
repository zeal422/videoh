/**
 * media-cleanup-plan.ts: the pure reference set and candidate plan behind the
 * Clean Unused Media action (0.23.0).
 *
 * The clean action may only delete a stored hash when nothing can still reach
 * it: the live doc, either history stack, the autosave slot, or a claim shard
 * from an explicit save/open. A missing or unreadable claims directory means
 * the closed-copy set is unknown, so content-hash deletion is disabled and only
 * temporary files may go.
 *
 * The store call that actually deletes takes the same reference set again at
 * delete time, so a reference that appeared while the confirmation was open is
 * never lost.
 */

import { isValidContentHash } from './project-validation'
import { parseSerializedDoc } from './serialization'
import type { Doc } from './types'

/** A stored media entry, as the store lists it. */
export interface StoredMediaEntry {
  hash: string
  size: number
}

export interface MediaCleanupCandidate {
  hash: string
  size: number
}

export interface MediaCleanupPlan {
  candidates: MediaCleanupCandidate[]
  reclaimed: number
  /** Claimed hashes kept for closed copies. */
  claimedCount: number
  /** True when claims are missing or unreadable, so no content hash may be deleted. */
  blocked: boolean
}

/**
 * Every valid content hash a doc references, deduped and sorted. Media and
 * custom fonts share the content-addressed store and its claim shards, so both
 * kinds of bytes are protected by the same reference set.
 */
export function collectMediaHashes(doc: Doc): string[] {
  const hashes = new Set<string>()
  for (const asset of doc.media) {
    if (isValidContentHash(asset.contentHash)) hashes.add(asset.contentHash)
  }
  for (const font of doc.project.fonts ?? []) {
    if (isValidContentHash(font.contentHash)) hashes.add(font.contentHash)
  }
  return [...hashes].sort()
}

export interface MediaReferenceInput {
  doc: Doc
  /** Undo and redo snapshots; both are reachable for the whole session. */
  past: readonly Doc[]
  future: readonly Doc[]
  /** The serialized autosave text, or null when no slot exists. */
  autosave: string | null
}

/**
 * The union of hashes reachable from the live doc, both history stacks, and the
 * autosave slot for the SAME project. An autosave for another project cannot
 * keep this project's bytes alive; a malformed slot keeps nothing (the doc and
 * history still do, and claims cover saved copies).
 */
export function collectReferencedHashes(input: MediaReferenceInput): Set<string> {
  const referenced = new Set<string>()
  for (const hash of collectMediaHashes(input.doc)) referenced.add(hash)
  for (const snapshot of [...input.past, ...input.future]) {
    for (const hash of collectMediaHashes(snapshot)) referenced.add(hash)
  }
  if (input.autosave) {
    try {
      const { doc } = parseSerializedDoc(input.autosave)
      if (doc.project.id === input.doc.project.id) {
        for (const hash of collectMediaHashes(doc)) referenced.add(hash)
      }
    } catch {
      // A broken autosave is not a reference; claims still protect saved copies.
    }
  }
  return referenced
}

/**
 * Classifies stored entries against the reference set and the claims union.
 * `claimed` is null when the claims directory is missing or unreadable.
 */
export function planMediaCleanup(input: {
  stored: readonly StoredMediaEntry[]
  referenced: ReadonlySet<string>
  claimed: readonly string[] | null
}): MediaCleanupPlan {
  if (input.claimed === null) {
    return { candidates: [], reclaimed: 0, claimedCount: 0, blocked: true }
  }
  const claimed = new Set(input.claimed)
  const candidates: MediaCleanupCandidate[] = []
  let reclaimed = 0
  for (const entry of input.stored) {
    if (input.referenced.has(entry.hash) || claimed.has(entry.hash)) continue
    candidates.push({ hash: entry.hash, size: entry.size })
    reclaimed += entry.size
  }
  candidates.sort((a, b) => a.hash.localeCompare(b.hash))
  return { candidates, reclaimed, claimedCount: claimed.size, blocked: false }
}
