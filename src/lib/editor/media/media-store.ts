/**
 * media-store.ts: durable media storage in OPFS (0.23.0).
 *
 * Keys are `<project-id>/<content-hash>`: the hash is the SHA-256 of the bytes,
 * so an entry is immutable and a saved copy that still points at an old hash
 * keeps loading those bytes after another copy relinks. A sidecar
 * `<content-hash>.json` stores the MIME type, which is a property of the bytes;
 * the display name stays per asset in the project file.
 *
 * Readers verify a hash and treat a mismatch as missing, so a partial write can
 * never be served as valid media. Writes go to a temporary entry, verify, then
 * promote: an existing valid entry is reused, a damaged one is quarantined
 * first. The claims directory is the record a closed copy relies on; a missing
 * or unreadable claims directory disables content-hash deletion.
 *
 * Browser-bound. The suite drives it through a stubbed `navigator.storage`
 * returning an in-memory directory (see `__tests__/mocks/opfs.ts`).
 */

import { isValidContentHash, isValidProjectId } from '../project-validation'
import {
  hasPendingInstallFor,
  isInstallHistoryLost,
  readInstalledRegistryState,
} from './installed-registry'

const CLAIMS_DIR = 'claims'
const TEMPORARY_PREFIX = '.tmp-'
const QUARANTINE_PREFIX = '.quarantine-'
/** Metadata entries the hash iterator must never treat as media. */
const SIDECAR_SUFFIX = '.json'
/** Font bytes live in a subdirectory so the two content namespaces never mix. */
export const FONT_NAMESPACE = 'fonts'
export type StoreNamespace = 'media' | typeof FONT_NAMESPACE

export class MediaStoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MediaStoreError'
  }
}

/** The subset of `FileSystemWritableFileStream` the store uses. */
export interface MediaStoreWritable {
  write(data: Blob | BufferSource | string): Promise<void>
  close(): Promise<void>
  abort?(): Promise<void>
}

/** The subset of `FileSystemFileHandle` the store uses. */
export interface MediaStoreFileHandle {
  getFile(): Promise<File>
  createWritable(): Promise<MediaStoreWritable>
  /** OPFS rename, when the browser implements it (Chromium). */
  move?(destination: MediaStoreDirectory, name: string): Promise<void>
}

/** The subset of `FileSystemDirectoryHandle` the store uses. */
export interface MediaStoreDirectory {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<MediaStoreDirectory>
  getFileHandle(name: string, options?: { create?: boolean }): Promise<MediaStoreFileHandle>
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>
  keys(): AsyncIterableIterator<string>
}

export interface StoredMediaFile {
  file: File
  /** Sidecar MIME type, or the empty string when the sidecar is missing or malformed. */
  type: string
  size: number
  hasSidecar: boolean
}

export interface StoredHashEntry {
  hash: string
  size: number
}

export interface MediaCleanupResult {
  /** Content hashes that were deleted. */
  deleted: string[]
  /** Bytes reclaimed by this run. */
  reclaimed: number
  /** True when claims were missing or unreadable, so no content hash was deleted. */
  claimsUnreadable: boolean
  /** Temporary and quarantine entries removed alongside the hashes. */
  removedTemporary: number
}

export interface MediaClearResult {
  deleted: number
  reclaimed: number
}

// runtime detection

function storageManager(): StorageManager | undefined {
  if (typeof navigator === 'undefined') return undefined
  const storage = (navigator as Navigator | undefined)?.storage
  return storage && typeof storage.getDirectory === 'function' ? storage : undefined
}

/** True when this browser exposes OPFS through `navigator.storage`. */
export function isMediaStoreSupported(): boolean {
  return storageManager() !== undefined
}

async function rootDirectory(): Promise<MediaStoreDirectory> {
  const storage = storageManager()
  if (!storage) throw new MediaStoreError('Media storage is unavailable')
  try {
    return (await storage.getDirectory()) as unknown as MediaStoreDirectory
  } catch {
    throw new MediaStoreError('Media storage is unavailable')
  }
}

// validation and key helpers

/**
 * A project id becomes a directory name. The rule lives in the pure validation
 * module so hydration and the store share one boundary.
 */

function assertProjectId(projectId: string): void {
  if (!isValidProjectId(projectId))
    throw new MediaStoreError('Invalid project id for media storage')
}

function assertContentHash(contentHash: string): void {
  if (!isValidContentHash(contentHash)) throw new MediaStoreError('Invalid media content hash')
}

function sidecarName(contentHash: string): string {
  return `${contentHash}${SIDECAR_SUFFIX}`
}

function randomSuffix(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function temporaryName(kind: 'tmp' | 'quarantine'): string {
  return `${kind === 'tmp' ? TEMPORARY_PREFIX : QUARANTINE_PREFIX}${randomSuffix()}`
}

function isEntryNameMetadata(name: string): boolean {
  return (
    name === CLAIMS_DIR ||
    name === FONT_NAMESPACE ||
    name.startsWith(TEMPORARY_PREFIX) ||
    name.startsWith(QUARANTINE_PREFIX) ||
    // A sidecar belongs to its hash; it is never a media entry itself.
    (name.endsWith(SIDECAR_SUFFIX) && isValidContentHash(name.slice(0, -SIDECAR_SUFFIX.length)))
  )
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'NotFoundError'
  )
}

// hashing

/** Lowercase hex SHA-256 of the given bytes. */
export async function sha256Hex(data: BufferSource): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new MediaStoreError('Hashing is unavailable')
  const digest = await subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Lowercase hex SHA-256 of a file's bytes. */
export async function hashFile(file: Blob): Promise<string> {
  return sha256Hex(await file.arrayBuffer())
}

// directory primitives

async function projectDirectory(
  projectId: string,
  create: boolean,
): Promise<MediaStoreDirectory | null> {
  assertProjectId(projectId)
  const root = await rootDirectory()
  try {
    return await root.getDirectoryHandle(projectId, create ? { create: true } : undefined)
  } catch (error) {
    if (!create && isNotFound(error)) return null
    throw new MediaStoreError('Media storage could not open the project')
  }
}

/**
 * The directory holding one content namespace. Media keeps the project root
 * (v1 layout, so 0.23.0 stores keep loading); fonts live in `fonts/`. Both
 * namespaces share the same content-hash keys and claim shards.
 */
async function namespaceDirectory(
  projectId: string,
  namespace: StoreNamespace,
  create: boolean,
): Promise<MediaStoreDirectory | null> {
  const dir = await projectDirectory(projectId, create)
  if (!dir || namespace === 'media') return dir
  try {
    return await dir.getDirectoryHandle(FONT_NAMESPACE, create ? { create: true } : undefined)
  } catch (error) {
    if (!create && isNotFound(error)) return null
    throw new MediaStoreError('Media storage could not open the font namespace')
  }
}

/**
 * `ready` means the project's claims directory is complete records. `claims-missing`
 * means the project already held stored bytes but its claims directory is gone:
 * recreating an empty one would turn "unknown claims" into "no claims", and a
 * later clean would delete bytes a closed copy still references.
 */
export type ProjectMediaState = 'ready' | 'claims-missing'

/**
 * Creates the project directory and its claims directory for a new project.
 * For an existing project whose claims directory is missing, an empty claims
 * directory is created only when no stored hash could be protected by a lost
 * claim; any stored hash keeps the state `claims-missing` until the user
 * explicitly clears the project's media.
 */
export async function ensureProjectMedia(projectId: string): Promise<ProjectMediaState> {
  assertProjectId(projectId)
  const root = await rootDirectory()
  let dir: MediaStoreDirectory
  let existed = true
  try {
    dir = await root.getDirectoryHandle(projectId)
  } catch (error) {
    if (!isNotFound(error)) throw new MediaStoreError('Media storage could not open the project')
    existed = false
    try {
      dir = await root.getDirectoryHandle(projectId, { create: true })
    } catch {
      throw new MediaStoreError('Media storage could not create the project')
    }
  }
  if (!existed) {
    await dir.getDirectoryHandle(CLAIMS_DIR, { create: true })
    return 'ready'
  }
  try {
    await dir.getDirectoryHandle(CLAIMS_DIR)
    return 'ready'
  } catch (error) {
    if (!isNotFound(error)) throw new MediaStoreError('Media claims could not be read')
  }
  const rootHashes = (await directoryNames(dir)).some(isValidContentHash)
  let fontHashes = false
  try {
    const fontDir = await dir.getDirectoryHandle(FONT_NAMESPACE)
    fontHashes = (await directoryNames(fontDir)).some(isValidContentHash)
  } catch (error) {
    if (!isNotFound(error)) throw new MediaStoreError('Media claims could not be read')
  }
  // Font bytes live under `fonts/`; a text-only project must not be mistaken
  // for an empty one because the root has no hashes.
  if (rootHashes || fontHashes) return 'claims-missing'
  // The directory was emptied (for example by clear-all) or never had media.
  // There is nothing a lost claim could still protect, so an empty record is
  // complete and clean can stay available.
  await dir.getDirectoryHandle(CLAIMS_DIR, { create: true })
  return 'ready'
}

async function readFileHandle(dir: MediaStoreDirectory, name: string): Promise<File | null> {
  try {
    const handle = await dir.getFileHandle(name)
    return await handle.getFile()
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
}

async function removeEntryQuiet(
  dir: MediaStoreDirectory,
  name: string,
  options?: { recursive?: boolean },
): Promise<boolean> {
  try {
    await dir.removeEntry(name, options)
    return true
  } catch (error) {
    if (isNotFound(error)) return false
    return false
  }
}

/**
 * Deletes an entry, rethrowing anything except a missing entry. Destructive
 * actions that report a result use this, so a failed delete cannot be counted
 * as "nothing to remove". Best-effort cleanup keeps the quiet variant.
 */
async function removeEntryStrict(
  dir: MediaStoreDirectory,
  name: string,
  options?: { recursive?: boolean },
): Promise<boolean> {
  try {
    await dir.removeEntry(name, options)
    return true
  } catch (error) {
    if (isNotFound(error)) return false
    throw error
  }
}

async function directoryNames(dir: MediaStoreDirectory): Promise<string[]> {
  // Snapshot first: callers delete while they walk, and an async iterator over
  // a directory that is being mutated is not guaranteed to be stable.
  const names: string[] = []
  for await (const name of dir.keys()) names.push(name)
  return names
}

/** A file entry's size, or 0 when the name is a directory or cannot be read. */
async function entrySizeQuiet(dir: MediaStoreDirectory, name: string): Promise<number> {
  try {
    const handle = await dir.getFileHandle(name)
    return (await handle.getFile()).size
  } catch {
    return 0
  }
}

/** Writes a blob to `name` in one create-writable pass. */
async function writeBlob(
  dir: MediaStoreDirectory,
  name: string,
  bytes: BufferSource | Blob | string,
): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true })
  const writable = await handle.createWritable()
  try {
    await writable.write(bytes)
    await writable.close()
  } catch (error) {
    try {
      await writable.abort?.()
    } catch {
      // The temp entry is removed by the caller.
    }
    throw error
  }
}

async function writeJson(dir: MediaStoreDirectory, name: string, value: unknown): Promise<void> {
  await writeBlob(dir, name, JSON.stringify(value))
}

/**
 * Moves a temp entry onto `contentHash`. OPFS `move` is used when the browser
 * implements it; otherwise the verified bytes are copied into the final name.
 * Readers verify the hash, so the copy fallback cannot serve a partial entry as
 * valid.
 */
async function promote(
  dir: MediaStoreDirectory,
  tempName: string,
  contentHash: string,
  bytes: ArrayBuffer,
): Promise<void> {
  const temp = await dir.getFileHandle(tempName)
  if (typeof temp.move === 'function') {
    try {
      await temp.move(dir, contentHash)
      return
    } catch {
      // Fall through to the copy path.
    }
  }
  await writeBlob(dir, contentHash, bytes)
}

// reads

/** True when `contentHash` names an entry whose bytes still match the hash. */
async function hasVerifiedEntry(dir: MediaStoreDirectory, contentHash: string): Promise<boolean> {
  const file = await readFileHandle(dir, contentHash)
  if (!file) return false
  try {
    return (await hashFile(file)) === contentHash
  } catch {
    return false
  }
}

async function readSidecar(
  dir: MediaStoreDirectory,
  contentHash: string,
): Promise<{ type: string } | null> {
  const file = await readFileHandle(dir, sidecarName(contentHash))
  if (!file) return null
  try {
    const parsed: unknown = JSON.parse(await file.text())
    if (typeof parsed !== 'object' || parsed === null) return null
    const type = (parsed as { type?: unknown }).type
    if (typeof type !== 'string' || type.length > 255) return null
    return { type }
  } catch {
    return null
  }
}

/** Reads verified bytes for a hash, or null when the entry is absent or damaged. */
export async function readMediaFile(
  projectId: string,
  contentHash: string,
  namespace: StoreNamespace = 'media',
): Promise<StoredMediaFile | null> {
  assertProjectId(projectId)
  assertContentHash(contentHash)
  const dir = await namespaceDirectory(projectId, namespace, false)
  if (!dir) return null
  const file = await readFileHandle(dir, contentHash)
  if (!file) return null
  try {
    if ((await hashFile(file)) !== contentHash) return null
  } catch {
    return null
  }
  const sidecar = await readSidecar(dir, contentHash)
  return { file, type: sidecar?.type ?? '', size: file.size, hasSidecar: sidecar !== null }
}

// writes

/**
 * Stores the bytes for `contentHash` under the project, writing the sidecar
 * type. A valid entry is reused; a damaged one is quarantined and replaced.
 * Throws when the bytes do not hash to `contentHash`.
 */
export async function writeMediaFile(
  projectId: string,
  contentHash: string,
  file: Blob,
  namespace: StoreNamespace = 'media',
): Promise<void> {
  assertProjectId(projectId)
  assertContentHash(contentHash)
  const dir = await namespaceDirectory(projectId, namespace, true)
  if (!dir) throw new MediaStoreError('Media storage could not create the project')
  const bytes = await file.arrayBuffer()
  if ((await sha256Hex(bytes)) !== contentHash) {
    throw new MediaStoreError('Media hash does not match its contents')
  }
  if (await hasVerifiedEntry(dir, contentHash)) {
    // The hash proves the bytes are identical. Keep the first writer's sidecar
    // instead of letting a bundle's declared MIME rewrite a shared entry that
    // another project already resolves.
    if (!(await readSidecar(dir, contentHash))) {
      await writeSidecar(dir, contentHash, file.type, bytes.byteLength)
    }
    return
  }
  // A damaged entry is moved aside so the replacement can take the real name.
  // If the browser has no rename, dropping it is equivalent: readers already
  // reject it.
  let quarantined: string | null = null
  const damaged = await readFileHandle(dir, contentHash)
  if (damaged) {
    try {
      const handle = await dir.getFileHandle(contentHash)
      const target = temporaryName('quarantine')
      if (typeof handle.move === 'function') {
        try {
          await handle.move(dir, target)
          quarantined = target
        } catch {
          await removeEntryQuiet(dir, contentHash)
        }
      } else {
        await removeEntryQuiet(dir, contentHash)
      }
    } catch (error) {
      // A concurrent writer may have removed the damaged entry between the
      // read and the handle lookup; that is already the desired state.
      if (!isNotFound(error)) throw error
    }
  }
  const tempName = temporaryName('tmp')
  let promoted = false
  try {
    await writeBlob(dir, tempName, bytes)
    const written = await readFileHandle(dir, tempName)
    if (!written || (await hashFile(written)) !== contentHash) {
      throw new MediaStoreError('Stored media failed verification')
    }
    await promote(dir, tempName, contentHash, bytes)
    promoted = true
  } finally {
    await removeEntryQuiet(dir, tempName)
    if (quarantined) {
      // A failed replacement must not destroy the entry that was already there:
      // another writer may have just promoted a valid copy for this hash.
      if (promoted) await removeEntryQuiet(dir, quarantined)
      else await restoreQuarantined(dir, quarantined, contentHash)
    }
  }
  await writeSidecar(dir, contentHash, file.type, bytes.byteLength)
}

/**
 * Returns a quarantined entry to its real name after a failed replacement.
 * Best effort: the original failure is what the caller needs to see. Only bytes
 * that still hash to `contentHash` go back, so a damaged entry is never
 * resurrected under a valid name. A valid entry a concurrent writer already
 * promoted wins, and the quarantine is dropped.
 */
async function restoreQuarantined(
  dir: MediaStoreDirectory,
  quarantined: string,
  contentHash: string,
): Promise<void> {
  try {
    const file = await readFileHandle(dir, quarantined)
    if (!file || (await hashFile(file)) !== contentHash) {
      await removeEntryQuiet(dir, quarantined)
      return
    }
    const current = await readFileHandle(dir, contentHash)
    if (current) {
      if ((await hashFile(current)) === contentHash) {
        await removeEntryQuiet(dir, quarantined)
        return
      }
      await removeEntryQuiet(dir, contentHash)
    }
    const handle = await dir.getFileHandle(quarantined)
    if (typeof handle.move === 'function') {
      await handle.move(dir, contentHash)
      return
    }
    await writeBlob(dir, contentHash, await file.arrayBuffer())
    await removeEntryQuiet(dir, quarantined)
  } catch {
    // The caller reports the failed write; a leftover quarantine can be cleaned.
  }
}

/**
 * Best-effort sidecar write. The sidecar is metadata: losing it costs a MIME
 * fallback from the file extension, never the media bytes, so a quota failure
 * here must not fail an otherwise successful import.
 */
async function writeSidecar(
  dir: MediaStoreDirectory,
  contentHash: string,
  type: string,
  size: number,
): Promise<void> {
  try {
    await writeJson(dir, sidecarName(contentHash), { type, size })
  } catch {
    // Fall back to the file extension on read.
  }
}

/** Lists stored entries for a project namespace. Damaged entries are included; reads reject them. */
export async function listMediaFiles(
  projectId: string,
  namespace: StoreNamespace = 'media',
): Promise<StoredHashEntry[]> {
  assertProjectId(projectId)
  const dir = await namespaceDirectory(projectId, namespace, false)
  if (!dir) return []
  const entries: StoredHashEntry[] = []
  for (const name of await directoryNames(dir)) {
    if (isEntryNameMetadata(name)) continue
    if (!isValidContentHash(name)) continue
    const file = await readFileHandle(dir, name)
    if (!file) continue
    entries.push({ hash: name, size: file.size })
  }
  return entries.sort((a, b) => a.hash.localeCompare(b.hash))
}

/** Deletes one stored entry and its sidecar. A missing entry is not an error. */
export async function deleteMediaFile(
  projectId: string,
  contentHash: string,
  namespace: StoreNamespace = 'media',
): Promise<void> {
  assertProjectId(projectId)
  assertContentHash(contentHash)
  const dir = await namespaceDirectory(projectId, namespace, false)
  if (!dir) return
  await removeEntryQuiet(dir, contentHash)
  await removeEntryQuiet(dir, sidecarName(contentHash))
}

// claims

/**
 * Writes an immutable claim shard listing the hashes this copy may reference.
 * Shards are uniquely named and never merged, so two saves cannot lose a claim.
 */
export async function writeMediaClaim(
  projectId: string,
  hashes: readonly string[],
  installId?: string,
): Promise<string> {
  assertProjectId(projectId)
  if (installId !== undefined && !/^install-[A-Za-z0-9-]{1,80}$/.test(installId)) {
    throw new MediaStoreError('Invalid bundle install id')
  }
  const dir = await projectDirectory(projectId, true)
  if (!dir) throw new MediaStoreError('Media storage could not create the project')
  // Fail closed on lost or unreadable records. Creating the directory here
  // would turn unknown claims into "no claims", and publishing a shard beside
  // an unreadable one would report a save as safe while some claims stay lost.
  // Callers create a complete empty record through `ensureProjectMedia` first.
  let claims: MediaStoreDirectory
  try {
    claims = await dir.getDirectoryHandle(CLAIMS_DIR)
  } catch (error) {
    if (!isNotFound(error)) throw new MediaStoreError('Media claims could not be read')
    throw new MediaStoreError('Media claims are missing')
  }
  if ((await readMediaClaims(projectId)) === null) {
    throw new MediaStoreError('Media claims could not be read')
  }
  const claimId = `claim-${randomSuffix()}`
  const unique = [...new Set(hashes.filter(isValidContentHash))].sort()
  // The install id ties a bundle's pre-install shard to the registry record
  // written after the install. A normal save leaves it out, so its shard is
  // kept forever.
  const payload = installId
    ? { version: 1, hashes: unique, installId }
    : { version: 1, hashes: unique }
  // Temp then promote, so a reader never sees a half-written shard.
  const tempName = temporaryName('tmp')
  try {
    await writeJson(claims, tempName, payload)
    const temp = await claims.getFileHandle(tempName)
    const name = `${claimId}${SIDECAR_SUFFIX}`
    if (typeof temp.move === 'function') {
      await temp.move(claims, name)
    } else {
      // No rename: publish straight to the final name. A failed write must
      // remove its own partial shard (the name is unique, so no existing
      // claim is at risk); otherwise a corrupt final entry would read as
      // unreadable claims and block cleanup permanently.
      try {
        await writeJson(claims, name, payload)
      } catch (error) {
        await removeEntryQuiet(claims, name)
        throw error
      }
      await removeEntryQuiet(claims, tempName)
    }
  } finally {
    await removeEntryQuiet(claims, tempName)
  }
  return claimId
}

export interface ClaimShard {
  /** The shard file name, including `.json`. */
  name: string
  /** The bundle import that wrote the shard, or null for a normal save. */
  installId: string | null
}

export interface ClaimShardRecords {
  hashes: string[]
  shards: ClaimShard[]
}

/**
 * Reads every claim shard with its install id. Returns null when the claims
 * directory is missing or any shard is unreadable, which callers must treat as
 * "deletion disabled".
 */
export async function readMediaClaimShards(projectId: string): Promise<ClaimShardRecords | null> {
  assertProjectId(projectId)
  const dir = await projectDirectory(projectId, false)
  if (!dir) return null
  let claims: MediaStoreDirectory
  try {
    claims = await dir.getDirectoryHandle(CLAIMS_DIR)
  } catch (error) {
    if (isNotFound(error)) return null
    throw new MediaStoreError('Media claims could not be read')
  }
  const hashes = new Set<string>()
  const shards: ClaimShard[] = []
  for (const name of await directoryNames(claims)) {
    if (!name.endsWith(SIDECAR_SUFFIX) || name.startsWith(TEMPORARY_PREFIX)) continue
    // Only a shard this module could have written is a claim. A stray file
    // with a `.json` suffix must not be deletable by the recovery pass.
    if (!/^claim-[A-Za-z0-9-]{1,80}\.json$/.test(name)) return null
    const file = await readFileHandle(claims, name)
    if (!file) return null
    try {
      const parsed: unknown = JSON.parse(await file.text())
      if (typeof parsed !== 'object' || parsed === null) return null
      const record = parsed as { version?: unknown; hashes?: unknown; installId?: unknown }
      if (record.version !== 1 || !Array.isArray(record.hashes)) return null
      if (
        record.installId !== undefined &&
        (typeof record.installId !== 'string' ||
          !/^install-[A-Za-z0-9-]{1,80}$/.test(record.installId))
      ) {
        return null
      }
      for (const hash of record.hashes) {
        if (!isValidContentHash(hash)) return null
        hashes.add(hash)
      }
      shards.push({ name, installId: (record.installId as string | undefined) ?? null })
    } catch {
      return null
    }
  }
  return { hashes: [...hashes].sort(), shards: shards.sort((a, b) => a.name.localeCompare(b.name)) }
}

/**
 * True when any project holds an install-tagged claim shard, or a claim record
 * cannot be read. Called before the first append into a missing registry: that
 * append must not publish a history that omits another project's completed
 * installs, or recovery would treat those shards as orphans. A missing claims
 * directory is treated as unknown here because the API cannot distinguish it
 * from an unreadable one, and the safe direction is to keep shards.
 */
export async function hasAnyInstallClaims(): Promise<boolean> {
  if (!isMediaStoreSupported()) return false
  let root: MediaStoreDirectory
  try {
    root = await rootDirectory()
  } catch {
    return true
  }
  try {
    for await (const name of root.keys()) {
      if (!isValidProjectId(name)) continue
      const records = await readMediaClaimShards(name)
      if (records === null) return true
      if (records.shards.some((shard) => shard.installId !== null)) return true
    }
  } catch {
    return true
  }
  return false
}

/**
 * Unions every claim shard. Null means the claims record is missing or unreadable. */
export async function readMediaClaims(projectId: string): Promise<string[] | null> {
  const records = await readMediaClaimShards(projectId)
  return records ? records.hashes : null
}

export interface ClaimRecoveryResult {
  removed: number
  kept: number
  /** True when the installation state could not be read, so every shard stayed. */
  ambiguous: boolean
  warning?: string
}

/**
 * Retires claim shards whose bundle install never completed. Runs before the
 * clean action, under its exclusive lock. It removes only the shard, never the
 * bytes: promoted hashes are left for the clean action, and a shard from a
 * normal save (no install id) is always kept.
 */
export async function recoverOrphanedClaimShards(projectId: string): Promise<ClaimRecoveryResult> {
  const records = await readMediaClaimShards(projectId)
  if (!records) {
    return {
      removed: 0,
      kept: 0,
      ambiguous: true,
      warning: 'Saved-copy records could not be read, so no recovery was attempted.',
    }
  }
  // A pending install has not been registered yet: its shard is not an
  // orphan, and recovery must not retire it before the append lands. The
  // durable record survives a reload; the in-memory one is checked by the
  // clean entry path before recovery runs.
  if (hasPendingInstallFor(projectId)) {
    return {
      removed: 0,
      kept: records.shards.length,
      ambiguous: true,
      warning: 'An install record is still pending, so saved-copy claims were kept.',
    }
  }
  // Only an install-tagged shard can be an orphan. With none, the registry
  // state cannot change the outcome, so this is a proven result, not an
  // ambiguous one.
  if (!records.shards.some((shard) => shard.installId !== null)) {
    return { removed: 0, kept: records.shards.length, ambiguous: false }
  }
  if (isInstallHistoryLost()) {
    return {
      removed: 0,
      kept: records.shards.length,
      ambiguous: true,
      warning: 'The install history was lost, so saved-copy claims were kept.',
    }
  }
  const state = readInstalledRegistryState()
  if (state.status === 'missing') {
    return {
      removed: 0,
      kept: records.shards.length,
      ambiguous: true,
      warning: 'The installation record is missing, so saved-copy claims were kept.',
    }
  }
  if (state.status === 'unreadable') {
    return {
      removed: 0,
      kept: records.shards.length,
      ambiguous: true,
      warning: 'The installation record is unreadable, so saved-copy claims were kept.',
    }
  }
  const installed = new Set(state.registry[projectId] ?? [])
  let removed = 0
  let kept = 0
  for (const shard of records.shards) {
    if (!shard.installId || installed.has(shard.installId)) {
      kept += 1
      continue
    }
    await deleteMediaClaim(projectId, shard.name.slice(0, -SIDECAR_SUFFIX.length))
    removed += 1
  }
  return { removed, kept, ambiguous: false }
}

/** Deletes one claim shard. */
export async function deleteMediaClaim(projectId: string, claimId: string): Promise<void> {
  assertProjectId(projectId)
  if (!/^claim-[A-Za-z0-9-]{1,80}$/.test(claimId)) {
    throw new MediaStoreError('Invalid media claim id')
  }
  const dir = await projectDirectory(projectId, false)
  if (!dir) return
  try {
    const claims = await dir.getDirectoryHandle(CLAIMS_DIR)
    await removeEntryQuiet(claims, `${claimId}${SIDECAR_SUFFIX}`)
  } catch (error) {
    if (!isNotFound(error)) throw new MediaStoreError('Media claims could not be read')
  }
}

// cleanup

/**
 * Deletes unclaimed, unreferenced entries and their sidecars across both the
 * media and font namespaces, plus temp and quarantine leftovers. `keepHashes`
 * is the caller's live reference set (doc, both history stacks, and the
 * autosave slot); claimed hashes are added here. A missing or unreadable claims
 * directory deletes no content hash.
 */
export async function cleanProjectMedia(
  projectId: string,
  keepHashes: readonly string[],
): Promise<MediaCleanupResult> {
  assertProjectId(projectId)
  const mediaDir = await projectDirectory(projectId, false)
  if (!mediaDir) {
    return { deleted: [], reclaimed: 0, claimsUnreadable: false, removedTemporary: 0 }
  }
  const fontDir = await namespaceDirectory(projectId, FONT_NAMESPACE, false)
  const dirs = fontDir ? [mediaDir, fontDir] : [mediaDir]
  const entries: { dir: MediaStoreDirectory; hash: string; size: number }[] = []
  let removedTemporary = 0
  for (const dir of dirs) {
    const names = await directoryNames(dir)
    for (const name of names) {
      if (name.startsWith(TEMPORARY_PREFIX) || name.startsWith(QUARANTINE_PREFIX)) {
        if (await removeEntryQuiet(dir, name, { recursive: true })) removedTemporary += 1
        continue
      }
      if (!isValidContentHash(name)) continue
      const file = await readFileHandle(dir, name)
      entries.push({ dir, hash: name, size: file?.size ?? 0 })
    }
  }
  const claims = await readMediaClaims(projectId)
  if (claims === null) {
    return { deleted: [], reclaimed: 0, claimsUnreadable: true, removedTemporary }
  }
  const keep = new Set(keepHashes.filter(isValidContentHash))
  for (const hash of claims) keep.add(hash)
  const deleted = new Set<string>()
  let reclaimed = 0
  for (const entry of entries) {
    if (keep.has(entry.hash)) continue
    // The sidecar is deleted with its media entry. Size it quietly so a
    // directory or unreadable sidecar name cannot block the main delete; a
    // readable sidecar still reports its exact bytes.
    const sidecarSize = await entrySizeQuiet(entry.dir, sidecarName(entry.hash))
    // Strict: a failed delete must surface instead of reading as "nothing to
    // clean" downstream. Temp and quarantine sweeping above stays best-effort.
    if (await removeEntryStrict(entry.dir, entry.hash)) {
      deleted.add(entry.hash)
      reclaimed += entry.size
    }
    if (await removeEntryStrict(entry.dir, sidecarName(entry.hash))) {
      reclaimed += sidecarSize
    }
  }
  return {
    deleted: [...deleted].sort(),
    reclaimed,
    claimsUnreadable: false,
    removedTemporary,
  }
}

/**
 * Removes every stored entry, sidecar, temp file, quarantine file, and the
 * claims directory. The only action allowed to drop claims; the project file
 * and its clips are untouched and every asset becomes missing on reload.
 */
export async function clearProjectMedia(projectId: string): Promise<MediaClearResult> {
  assertProjectId(projectId)
  const dir = await projectDirectory(projectId, false)
  if (!dir) return { deleted: 0, reclaimed: 0 }
  let deleted = 0
  let reclaimed = 0
  // Fonts live in their own directory; count and remove it before the root
  // sweep so its files are never mistaken for unknown root leftovers.
  const fontDir = await namespaceDirectory(projectId, FONT_NAMESPACE, false)
  if (fontDir) {
    for (const name of await directoryNames(fontDir)) {
      if (isValidContentHash(name)) deleted += 1
      // Count every entry, including temp, quarantine, and sidecar leftovers:
      // the recursive remove frees those bytes too.
      reclaimed += await entrySizeQuiet(fontDir, name)
    }
    await removeEntryStrict(dir, FONT_NAMESPACE, { recursive: true })
  }
  for (const name of await directoryNames(dir)) {
    if (name === CLAIMS_DIR) {
      await removeEntryStrict(dir, name, { recursive: true })
      continue
    }
    if (name === FONT_NAMESPACE) continue
    if (isValidContentHash(name)) {
      const file = await readFileHandle(dir, name)
      const size = file?.size ?? 0
      // Same rule as cleanProjectMedia: an unreadable or directory-shaped
      // sidecar name must not block the main delete. Readable sidecars keep
      // their exact byte count.
      const sidecarSize = await entrySizeQuiet(dir, sidecarName(name))
      if (await removeEntryStrict(dir, name)) {
        deleted += 1
        reclaimed += size
      }
      if (await removeEntryStrict(dir, sidecarName(name))) {
        reclaimed += sidecarSize
      }
      continue
    }
    // A temp entry, a quarantine leftover, or an orphaned sidecar is not valid
    // media, but it still occupies this project's storage. Clear-all removes it
    // and reports the bytes it frees.
    const size = await entrySizeQuiet(dir, name)
    if (await removeEntryStrict(dir, name, { recursive: true })) reclaimed += size
  }
  return { deleted, reclaimed }
}

/** Bytes stored for one project, across media and fonts. */
export async function projectMediaUsage(projectId: string): Promise<number> {
  const media = await listMediaFiles(projectId)
  const fonts = await listMediaFiles(projectId, FONT_NAMESPACE)
  return [...media, ...fonts].reduce((total, entry) => total + entry.size, 0)
}

/** Origin storage estimate, or null when the browser cannot report one. */
export async function estimateMediaStore(): Promise<{ usage: number; quota: number } | null> {
  const storage = storageManager()
  if (!storage || typeof storage.estimate !== 'function') return null
  try {
    const estimate = await storage.estimate()
    return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 }
  } catch {
    return null
  }
}

/** Asks the browser to keep this origin's storage; false when refused or unsupported. */
export async function requestPersistentStorage(): Promise<boolean> {
  const storage = storageManager()
  if (!storage || typeof storage.persist !== 'function') return false
  try {
    if (typeof storage.persisted === 'function' && (await storage.persisted())) return true
    return await storage.persist()
  } catch {
    return false
  }
}

/** True when the origin's storage is already persistent. */
export async function isStoragePersistent(): Promise<boolean> {
  const storage = storageManager()
  if (!storage || typeof storage.persisted !== 'function') return false
  try {
    return await storage.persisted()
  } catch {
    return false
  }
}
