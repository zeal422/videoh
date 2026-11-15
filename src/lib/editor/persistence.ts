import { isTransientActive, editorStore } from './store'
import { parseSerializedDoc, serializeDoc } from './serialization'
import {
  clearPendingInstallRecord,
  readPendingInstallRecords,
  recordInstalledImport,
  writePendingInstallRecord,
} from './media/installed-registry'
import type { PendingInstallRecord } from './media/installed-registry'
import type { Doc, PendingRestore } from './types'

/**
 * Local autosave, and the cross-tab ownership that makes an imported bundle
 * survive (0.28.0).
 *
 * The slot is one localStorage key shared by every window: importing a project
 * replaces it for good. An older tab that is still editing would otherwise
 * write its pre-import document back a moment later. Every writer therefore
 * takes the same Web Lock (or an IndexedDB transaction fallback), re-reads the
 * ownership record, and refuses to write when another tab owns the slot.
 *
 * Ownership is claimed by a bundle import before installation. It is held
 * until the page unloads (a heartbeat keeps the record fresh); other tabs pause
 * their autosave, acknowledge, and stay paused until they reload. A record that
 * stops being refreshed can be taken over by the next import. A reload of the
 * owner keeps its session id and resume token and reclaims the record only when
 * no old page answers and the epoch is unchanged.
 *
 * Object URLs are never persisted; restored assets start "missing".
 */

const AUTOSAVE_KEY = 'web-video-editor:autosave:v1'
const OWNER_KEY = 'web-video-editor:autosave-owner:v1'
/**
 * Generation marker written by a project-scoped slot write (a bundle import
 * or its retry). A tab that observed an older marker must not overwrite the
 * slot, even when it missed the pause and the owner record is gone.
 */
const IMPORT_KEY = 'web-video-editor:autosave-import:v1'
const SESSION_KEY = 'web-video-editor:autosave-session:v1'
const DEBOUNCE_MS = 800

/** Web Locks names and the BroadcastChannel used for pause/resume. */
export const AUTOSAVE_LOCK_NAME = 'videoh-autosave:v1'
export const AUTOSAVE_CHANNEL_NAME = 'web-video-editor:autosave-channel:v1'
const PRESENCE_PREFIX = 'videoh-autosave-tab:'
const LEASE_MS = 15_000
const HEARTBEAT_MS = 5_000
const PAUSE_TIMEOUT_MS = 2_000
const PROBE_TIMEOUT_MS = 250
const RETRY_MS = 3_000
const MAX_RETRIES = 5

/**
 * The slot text this tab last wrote or saw at mount. A provisional resume may
 * write only when the slot still matches it: different text means another tab
 * replaced the slot (an imported project), and overwriting would lose it.
 */
let knownSlotRaw: string | null | undefined

/**
 * The import marker this tab observed at mount. `undefined` means this session
 * has not observed one yet, so the first write adopts the current marker.
 */
let knownImportFence: string | null | undefined

/** Writes the doc to localStorage. Returns false on quota/serialization errors. */
export function writeAutosave(doc: Doc): boolean {
  try {
    const json = JSON.stringify(serializeDoc(doc))
    localStorage.setItem(AUTOSAVE_KEY, json)
    knownSlotRaw = json
    return true
  } catch {
    return false
  }
}

/** Reads the raw autosaved JSON (or null). */
export function readAutosave(): string | null {
  try {
    return localStorage.getItem(AUTOSAVE_KEY)
  } catch {
    return null
  }
}

function readImportFence(): string | null {
  try {
    return localStorage.getItem(IMPORT_KEY)
  } catch {
    return null
  }
}

function writeImportFence(token: string): boolean {
  try {
    localStorage.setItem(IMPORT_KEY, token)
    return true
  } catch {
    return false
  }
}

export async function clearAutosave(expectedRaw?: string): Promise<void> {
  // A paused tab must not erase the project another tab just imported: its
  // Discard button acts on a banner for the pre-import document.
  if (isAutosavePaused()) return
  try {
    await withAutosaveSection(() => {
      // A live record names the tab whose project owns the slot now.
      const record = readOwnerRecord()
      if (record && record.tabId !== tabId && recordIsFresh(record)) return
      const current = readAutosave()
      if (current === null) return
      // Discard acts on one banner. Never delete a newer restore that landed
      // after that banner was captured.
      if (expectedRaw !== undefined && current !== expectedRaw) return
      localStorage.removeItem(AUTOSAVE_KEY)
      knownSlotRaw = null
    })
  } catch {
    // A failed coordination section leaves the slot in place, which is safe.
  }
}

/**
 * Validates autosaved JSON and returns the parsed restore object, or null.
 * Parsing happens once here: the banner stores this typed object, and the
 * restore path installs its doc without re-parsing the raw text.
 */
export function readValidAutosave(): PendingRestore | null {
  const json = readAutosave()
  knownSlotRaw = json
  if (!json) return null
  try {
    const { doc, warnings } = parseSerializedDoc(json)
    return { doc, warnings, raw: json }
  } catch {
    return null
  }
}

// autosave ownership and the pause handshake

interface OwnerRecord {
  tabId: string
  sessionId: string
  tokenHash: string
  epoch: number
  heartbeatAt: number
}

interface SessionIdentity {
  sessionId: string
  tokenHash: string
}

export type AutosaveClaimResult = { ok: true; epoch: number } | { ok: false; reason: string }
export type AutosavePauseResult =
  { ok: true; requestId: string } | { ok: false; reason: string; requestId: string }
export type AutosaveWriteResult = 'saved' | 'read-only' | 'error' | 'superseded'

let initialized = false
let channel: BroadcastChannel | null = null
const tabId = `tab-${randomToken()}`
const session = readSessionIdentity()
let owns = false
let ourEpoch = 0
let paused = false
let importedAway = false
let readOnly = false
let heartbeat: ReturnType<typeof setInterval> | null = null
let cancelPendingWrite: (() => void) | null = null
let localWrites: Promise<unknown> = Promise.resolve()
interface PendingPause {
  expected: Set<string>
  acked: Set<string>
  timer: ReturnType<typeof setTimeout>
  finish: (result: AutosavePauseResult) => void
}
/**
 * Pause requests are keyed by request id, not held in one slot: two imports
 * that overlap in this tab must each settle instead of the newer one silently
 * orphaning the older promise.
 */
const pendingPauses = new Map<string, PendingPause>()
let pendingProbe: { requestId: string; resolve: (present: boolean) => void } | null = null
/**
 * Identifies the live coordination session. A teardown bumps it so an
 * `initializeOwnership` still awaiting its probe cannot reclaim the record and
 * start a heartbeat after unmount.
 */
let coordinationGeneration = 0
/**
 * Pending install records keyed by project. Two imports in one tab can both
 * fail their registry append; a single slot would drop the earlier project's
 * record and let recovery retire its claim shard.
 */
const pendingInstalls = new Map<string, PendingInstallRecord>()
/**
 * A project-scoped slot write whose import marker has not landed yet. An
 * ordinary autosave for the same project must finish the marker first, so a
 * failed import marker cannot be bypassed by the next edit's save.
 */
let pendingImportFence: { projectId: string; token: string } | null = null
interface AutosaveRetry {
  json: string
  attempts: number
  seq: number
  /** The project the retry belongs to, or null for a plain slot retry. */
  projectId: string | null
  timer: ReturnType<typeof setTimeout>
}
let retry: AutosaveRetry | null = null
/** Monotonic sequence for slot writes, so an older retry cannot win a race. */
let writeSeq = 0
let committedSeq = 0
/**
 * Pause request ids this tab is honoring from other importers, with receipt
 * time. An importer that crashes after pausing but before resuming would
 * otherwise leave this tab paused forever: each request gets a recovery timer
 * that rechecks ownership once the owner's lease must have expired.
 */
const activePauses = new Map<string, number>()
/** Recovery timers for pause requests whose importer may have crashed. */
const pauseRecoveryTimers = new Map<string, ReturnType<typeof setTimeout>>()
/** A pause outlives the owner's lease by this long before recovery checks it. */
const PAUSE_RECOVERY_MS = LEASE_MS + 5_000
/** Resolves the shared presence lock on coordination teardown. */
let releasePresence: (() => void) | null = null

function randomToken(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** A stable non-reversible tag for the session's resume token. */
function tokenHash(token: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < token.length; index += 1) {
    hash = Math.imul(hash ^ token.charCodeAt(index), 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function readSessionIdentity(): SessionIdentity {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY)
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof (parsed as { sessionId?: unknown }).sessionId === 'string' &&
        typeof (parsed as { token?: unknown }).token === 'string'
      ) {
        const record = parsed as { sessionId: string; token: string }
        return { sessionId: record.sessionId, tokenHash: tokenHash(record.token) }
      }
    }
  } catch {
    // Private mode or blocked storage: fall back to a per-page identity.
  }
  const fresh = { sessionId: `session-${randomToken()}`, token: randomToken() }
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(fresh))
  } catch {
    // The in-memory identity still works for this page.
  }
  return { sessionId: fresh.sessionId, tokenHash: tokenHash(fresh.token) }
}

function now(): number {
  return Date.now()
}

function recordIsFresh(record: OwnerRecord): boolean {
  return now() - record.heartbeatAt < LEASE_MS
}

function readOwnerRecord(): OwnerRecord | null {
  try {
    const raw = localStorage.getItem(OWNER_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Partial<OwnerRecord>
    if (
      typeof record.tabId !== 'string' ||
      typeof record.sessionId !== 'string' ||
      typeof record.tokenHash !== 'string' ||
      typeof record.epoch !== 'number' ||
      !Number.isInteger(record.epoch) ||
      record.epoch < 0 ||
      typeof record.heartbeatAt !== 'number' ||
      !Number.isFinite(record.heartbeatAt)
    ) {
      return null
    }
    return record as OwnerRecord
  } catch {
    return null
  }
}

function writeOwnerRecord(record: OwnerRecord): boolean {
  try {
    localStorage.setItem(OWNER_KEY, JSON.stringify(record))
    return true
  } catch {
    return false
  }
}

function clearOwnerRecordIfOurs(): void {
  const record = readOwnerRecord()
  if (record?.tabId !== tabId) return
  try {
    localStorage.removeItem(OWNER_KEY)
  } catch {
    // ignore
  }
}

function lockManager(): LockManager | null {
  if (typeof navigator === 'undefined') return null
  const locks = navigator.locks
  return locks && typeof locks.request === 'function' ? locks : null
}

/** True when a cross-tab section can be serialized by Web Locks or IndexedDB. */
function hasAutosaveSerialization(): boolean {
  return lockManager() !== null || typeof indexedDB !== 'undefined'
}

class AutosaveCoordinationError extends Error {
  constructor() {
    super('Autosave coordination is unavailable')
    this.name = 'AutosaveCoordinationError'
  }
}

interface SectionOptions {
  /** Refuse to run outside a real lock or transaction when the section mutates shared state. */
  requireSerialization?: boolean
}

/**
 * Serializes an ownership check and slot write across tabs. Web Locks is the
 * primary mechanism; without it, one IndexedDB readwrite transaction holds the
 * section so another tab's transaction cannot interleave. The section must be
 * synchronous: IDB transactions end when the task yields.
 *
 * `requireSerialization` fails closed when the IDB path cannot run the section
 * inside a transaction. It is used by ownership and registry mutations: the
 * old direct fallback let two tabs claim the same slot when IDB was present but
 * broken.
 */
async function withAutosaveSection<T>(section: () => T, options: SectionOptions = {}): Promise<T> {
  const locks = lockManager()
  if (locks) {
    return locks.request(AUTOSAVE_LOCK_NAME, { mode: 'exclusive' }, async () => section())
  }
  return withIdbSection(section, options)
}

function withIdbSection<T>(section: () => T, options: SectionOptions = {}): Promise<T> {
  const requireSerialization = options.requireSerialization ?? false
  const direct = (): Promise<T> => {
    if (requireSerialization) return Promise.reject(new AutosaveCoordinationError())
    try {
      return Promise.resolve(section())
    } catch (error) {
      return Promise.reject(error)
    }
  }
  if (typeof indexedDB === 'undefined') return direct()
  return new Promise<T>((resolve, reject) => {
    let settled = false
    let ran = false
    let result: T
    const settle = (action: () => void) => {
      if (settled) return
      settled = true
      action()
    }
    const runDirect = () => {
      if (ran) return
      if (requireSerialization) {
        settle(() => reject(new AutosaveCoordinationError()))
        return
      }
      ran = true
      try {
        result = section()
        settle(() => resolve(result))
      } catch (error) {
        settle(() => reject(error))
      }
    }
    const open = indexedDB.open('web-video-editor-autosave', 1)
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains('sections')) {
        open.result.createObjectStore('sections')
      }
    }
    open.onerror = () => runDirect()
    open.onsuccess = () => {
      const db = open.result
      let transaction: IDBTransaction
      try {
        transaction = db.transaction('sections', 'readwrite')
      } catch {
        db.close()
        runDirect()
        return
      }
      const store = transaction.objectStore('sections')
      const read = store.get('autosave')
      read.onsuccess = () => {
        try {
          result = section()
          ran = true
          store.put({ at: now() }, 'autosave')
        } catch (error) {
          try {
            transaction.abort()
          } catch {
            // Already aborted.
          }
          db.close()
          settle(() => reject(error))
        }
      }
      // The section has already run when a late put or commit fails: resolve
      // its result instead of leaving the caller waiting forever. A failure
      // before the section runs falls back to a direct run.
      transaction.oncomplete = () => {
        db.close()
        if (ran) settle(() => resolve(result))
        else runDirect()
      }
      transaction.onerror = () => {
        db.close()
        if (ran) settle(() => resolve(result))
        else runDirect()
      }
      transaction.onabort = () => {
        db.close()
        if (ran) settle(() => resolve(result))
        else runDirect()
      }
    }
  })
}

function holdPresence(): void {
  if (releasePresence) return
  const locks = lockManager()
  if (!locks) return
  // Other tabs query the lock manager to learn who must acknowledge a pause.
  // The callback promise is settled by coordination teardown; otherwise an
  // unmount without a page unload would leave a presence no tab can answer.
  let release!: () => void
  const hold = new Promise<void>((resolve) => {
    release = resolve
  })
  releasePresence = () => {
    releasePresence = null
    release()
  }
  void locks
    .request(`${PRESENCE_PREFIX}${tabId}`, { mode: 'shared' }, () => hold)
    .catch(() => {
      releasePresence = null
    })
}

async function otherAutosaveTabs(): Promise<string[]> {
  const locks = lockManager()
  if (!locks || typeof locks.query !== 'function') return []
  try {
    const snapshot = await locks.query()
    const ids = new Set<string>()
    for (const lock of [...(snapshot.held ?? []), ...(snapshot.pending ?? [])]) {
      if (typeof lock.name === 'string' && lock.name.startsWith(PRESENCE_PREFIX)) {
        const id = lock.name.slice(PRESENCE_PREFIX.length)
        if (id && id !== tabId) ids.add(id)
      }
    }
    return [...ids]
  } catch {
    return []
  }
}

function setPausedByOtherTab(): void {
  paused = true
  if (cancelPendingWrite) cancelPendingWrite()
  try {
    editorStore.getState().setAutosavePaused(true)
  } catch {
    // The store is always available in the app; a test can call the module alone.
  }
}

function setResumed(): void {
  const wasPaused = paused
  paused = false
  try {
    editorStore.getState().setAutosavePaused(false)
  } catch {
    // ignore
  }
  // A pause cancels the debounced write. Resume it from the live doc so a
  // failed import does not leave the tab's last edit unsaved.
  if (wasPaused) resumePendingAutosave()
}

function resumePendingAutosave(): void {
  try {
    const store = editorStore.getState()
    // A pending restore banner means the live doc is not the session the slot
    // holds. Do not replace that session before the user chooses Restore or
    // Discard.
    if (store.pendingRestore) return
    const json = JSON.stringify(serializeDoc(store.doc))
    void writeAutosaveCooperatively(json)
      .then((result) => {
        const current = editorStore.getState()
        if (result === 'saved' || result === 'superseded') {
          current.setAutosaveStatus('saved')
          current.markAutosaved()
        } else if (result === 'error') {
          current.setAutosaveStatus('error')
        }
      })
      .catch(() => undefined)
  } catch {
    // A serialization failure is the autosave path's own error to report.
  }
}

/**
 * A provisional read-only state (another tab owned the slot at write time) is
 * cleared when the importer that paused this tab reports failure and no other
 * importer remains. A recorded takeover or a completed import stays read-only.
 */
async function recheckOwnershipAfterResume(): Promise<void> {
  if (importedAway) return
  let canResume = false
  try {
    canResume = await withAutosaveSection(
      () => {
        const record = readOwnerRecord()
        if (record && recordIsFresh(record) && record.tabId !== tabId) return false
        if (record && record.tabId === tabId && record.epoch !== ourEpoch) return false
        return true
      },
      { requireSerialization: true },
    )
  } catch {
    return
  }
  if (!canResume || importedAway || activePauses.size > 0) return
  // The slot must still be the one this tab knew. A different text means a
  // successful import replaced it, so resuming would overwrite that project.
  // An unknown text proves nothing either: this session never observed the
  // slot, so it stays read-only rather than guess.
  if (knownSlotRaw === undefined || readAutosave() !== knownSlotRaw) return
  readOnly = false
  setResumed()
}

function markReadOnly(): void {
  readOnly = true
  paused = true
  try {
    editorStore.getState().setAutosavePaused(true)
  } catch {
    // ignore
  }
}

function startHeartbeat(): void {
  stopHeartbeat()
  heartbeat = setInterval(() => {
    if (!owns) return
    void withAutosaveSection(
      () => {
        const record = readOwnerRecord()
        if (!record || record.tabId !== tabId || record.epoch !== ourEpoch) {
          // A takeover moved the slot; this tab must not write again.
          owns = false
          markReadOnly()
          return
        }
        writeOwnerRecord({ ...record, heartbeatAt: now() })
      },
      { requireSerialization: true },
    ).catch(() => {
      // Without a serializable section this tab cannot prove it still owns the
      // slot. Stop writing rather than race a takeover.
      owns = false
      markReadOnly()
    })
  }, HEARTBEAT_MS)
}

function stopHeartbeat(): void {
  if (heartbeat !== null) clearInterval(heartbeat)
  heartbeat = null
}

function post(message: unknown): void {
  try {
    channel?.postMessage(message)
  } catch {
    // A closed channel loses the message; the fallback timeouts still apply.
  }
}

function handlePause(requestId: string): void {
  activePauses.set(requestId, now())
  setPausedByOtherTab()
  schedulePauseRecovery(requestId)
  // Acknowledge only after this tab's in-flight write settles, so an older
  // document cannot land after the importer starts installing.
  void localWrites.catch(() => undefined).then(() => post({ type: 'paused', requestId, tabId }))
}

/** Drops one honored pause request and its recovery timer. */
function dropActivePause(requestId: string): void {
  activePauses.delete(requestId)
  const timer = pauseRecoveryTimers.get(requestId)
  if (timer !== undefined) {
    clearTimeout(timer)
    pauseRecoveryTimers.delete(requestId)
  }
}

/** Drops every honored pause request and its recovery timer. */
function clearActivePauses(): void {
  activePauses.clear()
  for (const timer of pauseRecoveryTimers.values()) clearTimeout(timer)
  pauseRecoveryTimers.clear()
}

function schedulePauseRecovery(requestId: string): void {
  if (pauseRecoveryTimers.has(requestId)) return
  pauseRecoveryTimers.set(
    requestId,
    setTimeout(() => {
      pauseRecoveryTimers.delete(requestId)
      void recoverAbandonedPause(requestId)
    }, PAUSE_RECOVERY_MS),
  )
}

/**
 * Recovers a pause whose importer may have crashed after pausing but before
 * resuming. A live owner means the import (or a successor) still holds the
 * slot, so the pause stays and recovery is rescheduled. With no live owner
 * the slot decides: unchanged means no import completed, so the abandoned
 * request is dropped and the tab resumes; changed means an import may have
 * completed without its broadcast, so the tab stays paused and read-only
 * rather than overwrite it.
 */
async function recoverAbandonedPause(requestId: string): Promise<void> {
  if (!activePauses.has(requestId) || importedAway) return
  let owned = false
  try {
    owned = await withAutosaveSection(
      () => {
        const record = readOwnerRecord()
        return record !== null && recordIsFresh(record)
      },
      { requireSerialization: true },
    )
  } catch {
    // Coordination is unavailable: leave the pause and check again later.
    schedulePauseRecovery(requestId)
    return
  }
  if (!activePauses.has(requestId) || importedAway) return
  if (owned) {
    schedulePauseRecovery(requestId)
    return
  }
  if (knownSlotRaw === undefined || readAutosave() !== knownSlotRaw) {
    dropActivePause(requestId)
    markReadOnly()
    return
  }
  dropActivePause(requestId)
  if (activePauses.size > 0) return
  if (readOnly) {
    await recheckOwnershipAfterResume()
    return
  }
  setResumed()
}

function handleMessage(event: MessageEvent): void {
  const data = event.data as {
    type?: unknown
    requestId?: unknown
    tabId?: unknown
    sessionId?: unknown
  } | null
  if (!data || typeof data.type !== 'string') return
  switch (data.type) {
    case 'pause':
      if (typeof data.requestId === 'string') handlePause(data.requestId)
      break
    case 'paused': {
      if (typeof data.requestId !== 'string' || typeof data.tabId !== 'string') break
      const pending = pendingPauses.get(data.requestId)
      if (!pending) break
      pending.acked.add(data.tabId)
      if ([...pending.expected].every((id) => pending.acked.has(id))) {
        pendingPauses.delete(data.requestId)
        clearTimeout(pending.timer)
        pending.finish({ ok: true, requestId: data.requestId })
      }
      break
    }
    case 'imported':
      importedAway = true
      clearActivePauses()
      setPausedByOtherTab()
      markReadOnly()
      break
    case 'resume': {
      if (importedAway || typeof data.requestId !== 'string') break
      dropActivePause(data.requestId)
      if (activePauses.size > 0) break
      if (readOnly) {
        void recheckOwnershipAfterResume()
        break
      }
      setResumed()
      break
    }
    case 'probe-session':
      if (data.sessionId === session.sessionId && typeof data.requestId === 'string') {
        post({ type: 'session-present', requestId: data.requestId, sessionId: session.sessionId })
      }
      break
    case 'session-present':
      if (pendingProbe && data.requestId === pendingProbe.requestId) {
        const resolve = pendingProbe.resolve
        pendingProbe = null
        resolve(true)
      }
      break
    default:
      break
  }
}

function probeSession(): Promise<boolean> {
  if (!channel) return Promise.resolve(false)
  return new Promise((resolve) => {
    const requestId = randomToken()
    const timer = setTimeout(() => {
      if (pendingProbe?.requestId === requestId) pendingProbe = null
      resolve(false)
    }, PROBE_TIMEOUT_MS)
    pendingProbe = {
      requestId,
      resolve: (present) => {
        clearTimeout(timer)
        resolve(present)
      },
    }
    post({ type: 'probe-session', requestId, sessionId: session.sessionId })
  })
}

async function initializeOwnership(generation: number): Promise<void> {
  if (importedAway) {
    markReadOnly()
    return
  }
  const record = readOwnerRecord()
  if (!record || !recordIsFresh(record)) {
    // A pause from an importer that arrived before this async check still
    // holds; do not clear a live request.
    if (activePauses.size > 0) {
      setPausedByOtherTab()
      return
    }
    // The slot may have changed while this tab had no live owner (an import
    // finished and its tab closed). A tab that is already read-only must not
    // resume over it; a fresh mount still reads the slot after this check and
    // must not be paused by state left from an earlier coordination session.
    if (readOnly && readAutosave() !== knownSlotRaw) {
      markReadOnly()
      return
    }
    // No live owner and an unchanged slot: normal multi-tab behavior, and this
    // tab may write. A provisional read-only state from a previous coordination
    // session is gone with its owner, and the stale ownership flag must not
    // survive it.
    owns = false
    readOnly = false
    paused = false
    try {
      editorStore.getState().setAutosavePaused(false)
    } catch {
      // The store is always available in the app; a test can call the module alone.
    }
    return
  }
  const sameSession =
    record.sessionId === session.sessionId && record.tokenHash === session.tokenHash
  if (!sameSession) {
    markReadOnly()
    return
  }
  // This page may be a reload of the owner. If an old page still answers, the
  // session is open elsewhere and this page must stay read-only.
  const present = await probeSession()
  if (generation !== coordinationGeneration) return
  if (present) {
    markReadOnly()
    return
  }
  try {
    await withAutosaveSection(
      () => {
        if (generation !== coordinationGeneration) return
        const current = readOwnerRecord()
        if (
          !current ||
          current.sessionId !== session.sessionId ||
          current.tokenHash !== session.tokenHash ||
          current.epoch !== record.epoch
        ) {
          markReadOnly()
          return
        }
        owns = true
        ourEpoch = current.epoch
        readOnly = false
        paused = false
        try {
          editorStore.getState().setAutosavePaused(false)
        } catch {
          // The store is always available in the app; a test can call the module alone.
        }
        writeOwnerRecord({ ...current, tabId, heartbeatAt: now() })
        startHeartbeat()
      },
      { requireSerialization: true },
    )
  } catch {
    markReadOnly()
  }
}

/**
 * Starts the cross-tab autosave listener. Safe to call once per page; returns a
 * cleanup that stops timers and closes the channel. An unmount does not release
 * ownership (a remount must not lose it); a pagehide does.
 */
export function initAutosaveCoordination(): () => void {
  if (initialized) return () => undefined
  initialized = true
  // A fresh page adopts the marker it boots on. A coordination remount keeps
  // the marker the live document already observed, so an import that landed
  // while the editor was unmounted cannot make the old document writable.
  if (knownImportFence === undefined) knownImportFence = readImportFence()
  const generation = (coordinationGeneration += 1)
  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(AUTOSAVE_CHANNEL_NAME)
    channel.addEventListener('message', handleMessage)
  }
  holdPresence()
  void initializeOwnership(generation).catch(() => undefined)
  const onPageHide = () => releaseAutosaveOwnership()
  // The storage event is the cross-tab signal when there is no
  // BroadcastChannel. Another tab clearing the owner record is observable
  // here, so a provisional read-only tab can recheck and save instead of
  // staying paused until reload. An acquisition is observable too: an idle
  // tab that sees a fresh foreign record becomes read-only now instead of
  // discovering the import at its next write.
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== null && event.key !== OWNER_KEY) return
    if (event.key === OWNER_KEY && event.newValue !== null) {
      if (importedAway || readOnly) return
      try {
        const parsed = JSON.parse(event.newValue) as Partial<OwnerRecord>
        if (
          typeof parsed.tabId === 'string' &&
          parsed.tabId !== tabId &&
          typeof parsed.heartbeatAt === 'number' &&
          Number.isFinite(parsed.heartbeatAt)
        ) {
          markReadOnly()
          // A suspended tab receives queued storage events only after it
          // wakes, so the heartbeat can be older than the lease by then. A
          // stale record does not prove the import is gone: recheck once and
          // resume only if the slot is still the one this tab observed.
          if (now() - parsed.heartbeatAt >= LEASE_MS) {
            void recheckOwnershipAfterResume()
          }
        }
      } catch {
        // A malformed record proves nothing; the write path rechecks anyway.
      }
      return
    }
    if (!readOnly || importedAway || activePauses.size > 0) return
    void recheckOwnershipAfterResume()
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('storage', onStorage)
  }
  return () => {
    coordinationGeneration += 1
    if (typeof window !== 'undefined') {
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('storage', onStorage)
    }
    releasePresence?.()
    stopHeartbeat()
    // The owner record may survive for a remount, but the in-memory claim does
    // not: otherwise a stale remount refreshes the record without a heartbeat.
    owns = false
    // A pause belongs to the coordination session. A remount starts a new
    // channel and may miss a resume sent while this one was closed, so drop
    // the transient pause and let initializeOwnership re-evaluate the record.
    // A completed import or a recorded takeover stays paused.
    clearActivePauses()
    if (!importedAway && !readOnly) {
      paused = false
      try {
        editorStore.getState().setAutosavePaused(false)
      } catch {
        // The store is always available in the app; a test can call the module alone.
      }
    }
    for (const [requestId, pending] of pendingPauses) {
      clearTimeout(pending.timer)
      pending.finish({
        ok: false,
        reason: 'This tab closed during the autosave pause.',
        requestId,
      })
    }
    pendingPauses.clear()
    if (retry) {
      clearTimeout(retry.timer)
      retry = null
    }
    channel?.removeEventListener('message', handleMessage)
    channel?.close()
    channel = null
    initialized = false
  }
}

/** True while this tab must not write the shared autosave slot. */
export function isAutosavePaused(): boolean {
  return paused || readOnly || importedAway
}

/**
 * Claims the shared slot for a bundle import. A fresh record from another tab
 * refuses; a stale record (an unresponsive owner) is taken over with a new
 * epoch, so a former owner that resumes cannot overwrite this tab's write.
 */
export async function claimAutosaveOwnership(): Promise<AutosaveClaimResult> {
  if (importedAway) {
    return { ok: false, reason: 'This tab must reload before it can import a project.' }
  }
  if (!hasAutosaveSerialization()) {
    return {
      ok: false,
      reason:
        'This browser cannot coordinate autosave across tabs. Use a browser with Web Locks or IndexedDB, then try again.',
    }
  }
  if (activePauses.size > 0) {
    return {
      ok: false,
      reason: 'Another import is pausing this tab. Reload after it finishes, then try again.',
    }
  }
  const initial = readOwnerRecord()
  let probedOwner: OwnerRecord | null = null
  if (initial && initial.tabId !== tabId && recordIsFresh(initial)) {
    const sameSession =
      initial.sessionId === session.sessionId && initial.tokenHash === session.tokenHash
    if (sameSession) {
      if (await probeSession()) {
        return {
          ok: false,
          reason: 'Another tab is saving this project. Close or reload it, then try again.',
        }
      }
      probedOwner = initial
    }
  }
  let result: AutosaveClaimResult
  try {
    result = await withAutosaveSection(
      (): AutosaveClaimResult => {
        const record = readOwnerRecord()
        if (record && record.tabId !== tabId && recordIsFresh(record)) {
          const sameSession =
            record.sessionId === session.sessionId && record.tokenHash === session.tokenHash
          if (!sameSession) {
            return {
              ok: false,
              reason: 'Another tab is saving this project. Close or reload it, then try again.',
            }
          }
          // The probe answered for one exact record. A record that appeared
          // or changed while this claim waited was never cleared, so replacing
          // it could take the slot from a live page of this same session.
          if (
            !probedOwner ||
            record.sessionId !== probedOwner.sessionId ||
            record.tokenHash !== probedOwner.tokenHash ||
            record.epoch !== probedOwner.epoch
          ) {
            return {
              ok: false,
              reason: 'Another tab is saving this project. Close or reload it, then try again.',
            }
          }
        }
        const epoch = Math.max(record?.epoch ?? 0, ourEpoch) + 1
        owns = writeOwnerRecord({
          tabId,
          sessionId: session.sessionId,
          tokenHash: session.tokenHash,
          epoch,
          heartbeatAt: now(),
        })
        if (!owns) {
          return { ok: false, reason: 'This browser could not record autosave ownership.' }
        }
        ourEpoch = epoch
        readOnly = false
        paused = false
        clearActivePauses()
        startHeartbeat()
        return { ok: true, epoch }
      },
      { requireSerialization: true },
    )
  } catch {
    return {
      ok: false,
      reason:
        'This browser could not coordinate autosave across tabs. Close other tabs or reload, then try again.',
    }
  }
  return result
}

/**
 * Drops ownership (failed import, or page teardown). An operation passes the
 * epoch its claim received: a newer import in the same tab owns a newer epoch,
 * so an older import must not stop its heartbeat or delete its record.
 */
export function releaseAutosaveOwnership(epoch?: number): void {
  if (epoch !== undefined) {
    if (ourEpoch !== epoch) return
    const record = readOwnerRecord()
    if (record && record.tabId === tabId && record.epoch !== epoch) return
  }
  stopHeartbeat()
  owns = false
  clearOwnerRecordIfOurs()
}

/**
 * Broadcasts a pause and waits for every known editor tab to acknowledge.
 * Without a channel this is a single tab, so it succeeds. Tabs that do not
 * answer within the timeout refuse the import instead of risking the slot.
 */
export async function pauseOtherAutosaveTabs(): Promise<AutosavePauseResult> {
  if (!channel) return { ok: true, requestId: 'local' }
  const expected = new Set(await otherAutosaveTabs())
  const requestId = randomToken()
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => {
        const pending = pendingPauses.get(requestId)
        if (!pending) return
        const missing = [...pending.expected].filter((id) => !pending.acked.has(id))
        pendingPauses.delete(requestId)
        resolve(
          missing.length > 0
            ? {
                ok: false,
                reason:
                  'Another editor tab did not pause autosave. Close or reload it, then try again.',
                requestId,
              }
            : { ok: true, requestId },
        )
      },
      expected.size > 0 ? PAUSE_TIMEOUT_MS : PROBE_TIMEOUT_MS,
    )
    pendingPauses.set(requestId, {
      expected,
      acked: new Set(),
      timer,
      finish: resolve,
    })
    post({ type: 'pause', requestId })
  })
}

/** Tells paused tabs this import failed before any slot write: resume editing. */
export function resumeAutosaveTabs(requestId: string): void {
  post({ type: 'resume', requestId })
}

/** Tells paused tabs a project was imported: stay paused until they reload. */
export function markAutosaveImported(): void {
  post({ type: 'imported' })
}

/**
 * Records an install id under the same cross-tab section as the slot, so two
 * tabs cannot lose each other's append. Used by bundle import and Save a copy.
 */
export async function recordInstallUnderLock(
  projectId: string,
  installId: string,
  hadInstallClaims = false,
): Promise<boolean> {
  if (!hasAutosaveSerialization()) return false
  try {
    return await withAutosaveSection(
      () => recordInstalledImport(projectId, installId, { hadInstallClaims }),
      { requireSerialization: true },
    )
  } catch {
    return false
  }
}

/**
 * Appends one pending install inside the autosave section and clears only the
 * record this call captured. A newer install for the same project may have
 * replaced it while the append waited for the lock, and must survive.
 */
function recordPendingInstallInSection(pending: PendingInstallRecord): boolean {
  if (
    !recordInstalledImport(pending.projectId, pending.installId, {
      hadInstallClaims: pending.hadInstallClaims,
    })
  ) {
    return false
  }
  const current = pendingInstalls.get(pending.projectId)
  if (current?.installId === pending.installId) pendingInstalls.delete(pending.projectId)
  clearPendingInstallRecord(pending.projectId, pending.installId)
  return true
}

async function recordAndClearPendingInstall(pending: PendingInstallRecord): Promise<boolean> {
  if (!hasAutosaveSerialization()) return false
  try {
    return await withAutosaveSection(() => recordPendingInstallInSection(pending), {
      requireSerialization: true,
    })
  } catch {
    return false
  }
}

/**
 * Queues the installed bundle in the durable registry for the next slot write.
 * A failed registry append must not leave the slot naming an install whose
 * claim shard recovery would retire.
 */
export async function markInstallPending(
  projectId: string,
  installId: string,
  hadInstallClaims = false,
): Promise<void> {
  pendingInstalls.set(projectId, { projectId, installId, hadInstallClaims })
  // Mirror durably inside the same cross-tab section as every other pending
  // map write, so two tabs cannot read-modify-write the map past each other.
  // Best effort: when the section is unavailable the in-memory retry still
  // protects this session, and an unreadable registry keeps every shard.
  try {
    await withAutosaveSection(
      () => writePendingInstallRecord({ projectId, installId, hadInstallClaims }),
      { requireSerialization: true },
    )
  } catch {
    // The in-memory retry still protects this session.
  }
}

/**
 * Marks an import before its doc becomes live. The next cooperative write for
 * that project, including the ordinary debounced save triggered by the
 * install, must land this marker before it writes the slot.
 */
export function requireAutosaveImportFence(projectId: string): void {
  pendingImportFence = { projectId, token: randomToken() }
}

/** Restores every durable pending install from a previous page into memory. */
function restorePendingInstalls(): void {
  for (const record of readPendingInstallRecords()) {
    if (!pendingInstalls.has(record.projectId)) pendingInstalls.set(record.projectId, record)
  }
}

/** True when an install record still awaits a durable write. */
export function hasPendingInstall(): boolean {
  return pendingInstalls.size > 0
}

function nextWriteSeq(): number {
  writeSeq += 1
  return writeSeq
}

function clearAutosaveRetry(): void {
  if (!retry) return
  clearTimeout(retry.timer)
  retry = null
}

/**
 * Writes the slot under the shared lock, refusing when another tab owns it.
 * Serialization happens before the call, so the section stays synchronous.
 * `seq` orders writes: an older retry that runs after a newer write committed
 * is superseded instead of replacing the newer document. `projectId` scopes a
 * bundle write: when another project became live while it was queued, the
 * imported snapshot must not replace that project's slot.
 */
export function writeAutosaveCooperatively(
  json: string,
  seq = nextWriteSeq(),
  projectId?: string,
): Promise<AutosaveWriteResult> {
  if (isAutosavePaused()) return Promise.resolve('read-only')
  const requireSerialization = owns || pendingInstalls.size > 0
  const run = localWrites
    .catch(() => undefined)
    .then(() =>
      withAutosaveSection(
        (): AutosaveWriteResult => {
          const record = readOwnerRecord()
          if (record && record.tabId !== tabId && recordIsFresh(record)) {
            markReadOnly()
            return 'read-only'
          }
          // A former owner must not write against a newer epoch even after that
          // owner's lease went stale: a stale lease must not make an old epoch
          // valid again.
          if (record && ourEpoch > 0 && record.epoch > ourEpoch) {
            owns = false
            markReadOnly()
            return 'read-only'
          }
          if (record && record.tabId === tabId && record.epoch !== ourEpoch) {
            owns = false
            markReadOnly()
            return 'read-only'
          }
          const writeProjectId = projectId ?? editorStore.getState().doc.project.id
          const pending = pendingInstalls.get(writeProjectId)
          if (pending && !recordPendingInstallInSection(pending)) return 'error'
          // A project-scoped write is an import or its retry. A tab that
          // observed an older import marker must not overwrite the slot even
          // when it missed the pause and no owner record remains. The install
          // record above is still completed: it is bookkeeping, not a slot
          // write, and recovery must keep its claim.
          const fence = readImportFence()
          if (knownImportFence === undefined) {
            knownImportFence = fence
          } else if (fence !== knownImportFence) {
            markReadOnly()
            return 'read-only'
          }
          // A bundle import can finish after another project became live. Its
          // snapshot must not replace that project's slot or report it saved.
          if (projectId !== undefined && editorStore.getState().doc.project.id !== projectId) {
            return 'superseded'
          }
          if (seq < committedSeq) return 'superseded'
          // The marker must be durable before the slot names the imported
          // project: a project-scoped save without it leaves a tab that missed
          // the pause free to replace the slot after the lease expires. The
          // requirement outlives the call that started it, so an ordinary
          // autosave for the same project cannot write the slot without it.
          const fenceProjectId = projectId ?? editorStore.getState().doc.project.id
          if (pendingImportFence !== null && pendingImportFence.projectId !== fenceProjectId) {
            // The imported project no longer owns the live slot, so its
            // unfinished marker cannot protect another project's write.
            pendingImportFence = null
          }
          if (projectId !== undefined && pendingImportFence === null) {
            pendingImportFence = { projectId, token: randomToken() }
          }
          if (pendingImportFence !== null) {
            if (!writeImportFence(pendingImportFence.token)) return 'error'
            knownImportFence = pendingImportFence.token
          }
          try {
            localStorage.setItem(AUTOSAVE_KEY, json)
          } catch {
            return 'error'
          }
          committedSeq = Math.max(committedSeq, seq)
          knownSlotRaw = json
          // An ordinary save keeps the requirement so the import's own
          // project-scoped write can reuse the same marker instead of fencing
          // the slot a second time.
          if (projectId !== undefined) pendingImportFence = null
          if (retry && retry.seq < seq) clearAutosaveRetry()
          if (owns) {
            const current = readOwnerRecord()
            if (current && current.tabId === tabId) {
              writeOwnerRecord({ ...current, heartbeatAt: now() })
            } else if (!current) {
              // The record vanished (storage eviction, manual clear): re-establish
              // it before another tab can claim the slot this write just changed.
              const epoch = ourEpoch + 1
              if (
                !writeOwnerRecord({
                  tabId,
                  sessionId: session.sessionId,
                  tokenHash: session.tokenHash,
                  epoch,
                  heartbeatAt: now(),
                })
              ) {
                return 'error'
              }
              ourEpoch = epoch
            }
          }
          return 'saved'
        },
        { requireSerialization },
      ).catch(() => 'error' as AutosaveWriteResult),
    )
  localWrites = run
  return run
}

/**
 * Compares autosaved document content, not its text: `serializeDoc` stamps a
 * fresh `savedAt` on every call, so a text comparison would discard an
 * unchanged document on every retry.
 */
function autosaveContentOf(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const content = { ...(parsed as Record<string, unknown>) }
    delete content.savedAt
    return JSON.stringify(content)
  } catch {
    return null
  }
}

/**
 * Retries a slot write that failed after installation (storage full, registry
 * append refused). Retries are bounded; a later edit schedules its own write.
 */
export function queueAutosaveRetry(json: string, seq?: number, projectId?: string): void {
  if (retry) clearTimeout(retry.timer)
  const attempt = (retry?.attempts ?? 0) + 1
  if (attempt > MAX_RETRIES) {
    retry = null
    return
  }
  // Retain the original sequence across attempts: allocating a newer sequence
  // per retry would let an old document overwrite a newer edit that committed
  // between attempts. A newer edit allocates a higher sequence and supersedes
  // this retry instead.
  const useSeq = seq ?? nextWriteSeq()
  const target = projectId ?? retry?.projectId ?? null
  const content = target !== null ? autosaveContentOf(json) : null
  retry = {
    json,
    attempts: attempt,
    seq: useSeq,
    projectId: target,
    timer: setTimeout(() => {
      const scheduled = retry
      if (target !== null) {
        const live = editorStore.getState()
        // A bundle slot retry belongs to the project it was captured for. Once
        // another project is live, writing it would replace that project's
        // slot and report it saved, so the retry is dropped.
        if (live.doc.project.id !== target) {
          if (retry === scheduled) retry = null
          return
        }
        // The same project id can come back with new content (a reopen or a
        // rename). A captured snapshot that no longer matches the live doc is
        // stale; the newer edit schedules its own write.
        let current: string
        try {
          current = JSON.stringify(serializeDoc(live.doc))
        } catch {
          if (retry === scheduled) retry = null
          return
        }
        if (content !== null && autosaveContentOf(current) !== content) {
          if (retry === scheduled) retry = null
          return
        }
      }
      void writeAutosaveCooperatively(json, useSeq, target ?? undefined).then((result) => {
        if (result === 'saved' || result === 'superseded') {
          retry = null
          if (target !== null) {
            const store = editorStore.getState()
            if (store.doc.project.id !== target) return
            // An edit landed while this write was queued: its own save is
            // scheduled, so do not report the newer document saved.
            let current: string | null = null
            try {
              current = autosaveContentOf(JSON.stringify(serializeDoc(store.doc)))
            } catch {
              current = null
            }
            if (content !== null && current !== content) return
            store.setAutosaveStatus('saved')
            store.markAutosaved()
            return
          }
          const store = editorStore.getState()
          store.setAutosaveStatus('saved')
          store.markAutosaved()
          return
        }
        queueAutosaveRetry(json, useSeq, target ?? undefined)
      })
    }, RETRY_MS),
  }
}

/**
 * Retries a pending install record whose JSON could not even be serialized
 * (or whose write failed before a payload existed). The live doc is
 * serialized when the timer fires, not when the failure happened, so clearing
 * the failure completes the registry append and the slot write with no
 * further edit. The sequence is retained across attempts like above.
 *
 * `projectId` names the project the pending slot write belongs to. A retry
 * restored after a reload always has a pending install record; a payload-less
 * failure in the same session passes the project it was saving.
 */
export function queuePendingInstallRetry(projectId?: string): void {
  if (retry) clearTimeout(retry.timer)
  const attempt = (retry?.attempts ?? 0) + 1
  if (attempt > MAX_RETRIES) {
    retry = null
    return
  }
  const useSeq = retry?.seq ?? nextWriteSeq()
  const target = projectId ?? retry?.projectId ?? null
  const scheduled: AutosaveRetry = {
    json: '',
    attempts: attempt,
    seq: useSeq,
    projectId: target,
    timer: setTimeout(() => {
      void runPendingInstallRetry(scheduled)
    }, RETRY_MS),
  }
  retry = scheduled
}

/**
 * One retry pass for every pending install record and the live slot.
 *
 * Records for projects that are not live only need the registry append; their
 * slot belongs to another session. The live project's record, or a plain slot
 * retry, also serializes the live doc at fire time, so clearing the failure
 * completes the append and the slot write with no further edit.
 */
async function runPendingInstallRetry(scheduled: AutosaveRetry): Promise<void> {
  const liveProjectId = editorStore.getState().doc.project.id
  // A durable pending install outlives the page that imported it. On a later
  // boot the live doc can be a different project (the failed slot write is
  // what made the record durable), so never replace the slot with a doc the
  // install does not own.
  for (const pending of [...pendingInstalls.values()]) {
    if (pending.projectId === liveProjectId) continue
    await recordAndClearPendingInstall(pending)
    if (retry !== scheduled) return
  }
  if (retry !== scheduled) return
  const livePending = pendingInstalls.has(liveProjectId)
  const slotProjectId = livePending ? liveProjectId : scheduled.projectId
  if (slotProjectId === null || (!livePending && slotProjectId !== liveProjectId)) {
    if (pendingInstalls.size > 0) {
      // Keep the attempt count, but stop carrying a slot project: the rest of
      // this pass is registry appends only.
      scheduled.projectId = null
      queuePendingInstallRetry()
    } else {
      retry = null
    }
    return
  }
  let savedDoc: Doc
  let json: string
  try {
    savedDoc = editorStore.getState().doc
    json = JSON.stringify(serializeDoc(savedDoc))
  } catch {
    queuePendingInstallRetry(slotProjectId)
    return
  }
  if (retry === scheduled) scheduled.json = json
  const result = await writeAutosaveCooperatively(json, scheduled.seq, slotProjectId)
  if (retry !== scheduled) return
  if (result === 'saved' || result === 'superseded') {
    const store = editorStore.getState()
    if (store.doc.project.id === slotProjectId) {
      // A newer edit that landed while the retry was queued owns its own save.
      // Reporting it saved here would hide the unsaved document.
      if (store.doc !== savedDoc) {
        store.setAutosaveStatus('pending')
      } else {
        store.setAutosaveStatus('saved')
        store.markAutosaved()
      }
    }
    if (pendingInstalls.size > 0) {
      // The live slot is saved. Only another project's append remains, so the
      // next pass must not rewrite this slot or fence it again.
      scheduled.projectId = null
      queuePendingInstallRetry()
    } else {
      retry = null
    }
    return
  }
  if (pendingInstalls.size > 0) {
    queuePendingInstallRetry(slotProjectId)
    return
  }
  queueAutosaveRetry(json, scheduled.seq, slotProjectId)
}

/** Registers the callback a pause uses to cancel this tab's pending timer. */
export function setAutosaveCancel(cancel: (() => void) | null): void {
  cancelPendingWrite = cancel
}

/** Test hook: reset every module-level coordination bit. */
export function resetAutosaveCoordinationForTests(): void {
  coordinationGeneration += 1
  releasePresence?.()
  stopHeartbeat()
  for (const pending of pendingPauses.values()) clearTimeout(pending.timer)
  pendingPauses.clear()
  pendingProbe = null
  if (retry) clearTimeout(retry.timer)
  retry = null
  channel?.close()
  channel = null
  initialized = false
  owns = false
  ourEpoch = 0
  paused = false
  importedAway = false
  readOnly = false
  cancelPendingWrite = null
  localWrites = Promise.resolve()
  pendingInstalls.clear()
  pendingImportFence = null
  clearActivePauses()
  knownSlotRaw = undefined
  knownImportFence = undefined
  writeSeq = 0
  committedSeq = 0
  try {
    localStorage.removeItem(OWNER_KEY)
    localStorage.removeItem(SESSION_KEY)
  } catch {
    // ignore
  }
}

/**
 * Subscribes to the store and autosaves (debounced) after every committed change.
 * Transient drag frames are skipped; the final commit triggers one save.
 * Returns an unsubscribe function (call on unmount).
 */
export function initAutosave(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const cancel = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  setAutosaveCancel(cancel)

  // A reload after a completed install with a failed append must finish the
  // registration with no further edit: restore the durable pending install
  // and retry it on the timer.
  restorePendingInstalls()
  if (pendingInstalls.size > 0) queuePendingInstallRetry()

  const unsubscribe = editorStore.subscribe((state, prevState) => {
    // Save when the doc changes (commands) OR when a transient gesture commits
    // (commitTransient only moves `past` — the doc reference is already final).
    const docChanged =
      state.doc !== prevState.doc ||
      state.past !== prevState.past ||
      state.future !== prevState.future
    if (!docChanged) return // ignore playhead/selection/zoom churn
    if (isTransientActive()) return
    if (isAutosavePaused()) return
    if (timer) clearTimeout(timer)
    editorStore.getState().setAutosaveStatus('pending')
    const seq = nextWriteSeq()
    timer = setTimeout(() => {
      timer = null
      const savedDoc = editorStore.getState().doc
      const json = JSON.stringify(serializeDoc(savedDoc))
      void writeAutosaveCooperatively(json, seq).then((result) => {
        const store = editorStore.getState()
        if (result === 'saved') {
          // A newer edit landed while this write was queued. Its own save is
          // already scheduled; marking it saved here would hide that.
          if (store.doc !== savedDoc) {
            store.setAutosaveStatus('pending')
            return
          }
          store.setAutosaveStatus('saved')
          store.markAutosaved()
        } else if (result === 'superseded') {
          store.setAutosaveStatus('saved')
          store.markAutosaved()
        } else if (result === 'error') {
          store.setAutosaveStatus('error')
        }
      })
    }, DEBOUNCE_MS)
  })

  return () => {
    cancel()
    setAutosaveCancel(null)
    unsubscribe()
  }
}
