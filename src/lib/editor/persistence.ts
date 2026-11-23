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

/** Writes the doc to localStorage. Returns false on quota/serialization errors. */
export function writeAutosave(doc: Doc): boolean {
  try {
    const json = JSON.stringify(serializeDoc(doc))
    localStorage.setItem(AUTOSAVE_KEY, json)
    coordination.knownSlotRaw = json
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

/**
 * Reads the raw autosaved JSON, letting a storage failure throw. Callers that
 * compare ownership state must distinguish "no slot" from "cannot read the
 * slot"; the tolerant reader above would turn both into null.
 */
export function readAutosaveOrThrow(): string | null {
  return localStorage.getItem(AUTOSAVE_KEY)
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
      coordination.knownSlotRaw = null
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
  coordination.knownSlotRaw = json
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

interface PendingPause {
  expected: Set<string>
  acked: Set<string>
  timer: ReturnType<typeof setTimeout>
  finish: (result: AutosavePauseResult) => void
}

interface PendingProbe {
  timer: ReturnType<typeof setTimeout>
  resolve: (present: boolean) => void
}

interface AutosaveRetry {
  json: string
  attempts: number
  seq: number
  /** The project the retry belongs to, or null for a plain slot retry. */
  projectId: string | null
  timer: ReturnType<typeof setTimeout>
}

/**
 * Everything one coordination session owns. Resetting disposes this record and
 * installs a fresh one, so a new field cannot be forgotten by a hand-maintained
 * reset list. `tabId` and `session` stay module constants.
 * `coordinationGeneration`, `heartbeatInstance`, and `claimSequence` are
 * monotonic sentinels and are carried forward by the factory. `ourEpoch` is
 * also carried, so a stale import cannot release a replacement claim after a
 * reset reuses the same epoch number.
 */
interface CoordinationState {
  knownSlotRaw: string | null | undefined
  knownImportFence: string | null | undefined
  initialized: boolean
  channel: BroadcastChannel | null
  detachListeners: (() => void) | null
  owns: boolean
  ourEpoch: number
  paused: boolean
  importedAway: boolean
  readOnly: boolean
  heartbeat: ReturnType<typeof setInterval> | null
  cancelPendingWrite: (() => void) | null
  localWrites: Promise<unknown>
  pendingPauses: Map<string, PendingPause>
  pendingProbes: Map<string, PendingProbe>
  ownershipProbeGeneration: number | null
  ownerWriteFailed: boolean
  ownershipRecheck: ReturnType<typeof setTimeout> | null
  resumeAfterTransient: boolean
  probeHeldSave: boolean
  claimSequence: number
  coordinationGeneration: number
  pendingInstalls: Map<string, PendingInstallRecord>
  pendingImportFence: { projectId: string; token: string } | null
  retry: AutosaveRetry | null
  writeSeq: number
  committedSeq: number
  activePauses: Map<string, number>
  pauseRecoveryTimers: Map<string, ReturnType<typeof setTimeout>>
  releasePresence: (() => void) | null
  heartbeatInstance: number
}

function createCoordinationState(previous?: CoordinationState): CoordinationState {
  return {
    knownSlotRaw: undefined,
    knownImportFence: undefined,
    initialized: false,
    channel: null,
    detachListeners: null,
    owns: false,
    ourEpoch: previous?.ourEpoch ?? 0,
    paused: false,
    importedAway: false,
    readOnly: false,
    heartbeat: null,
    cancelPendingWrite: null,
    localWrites: Promise.resolve(),
    pendingPauses: new Map(),
    pendingProbes: new Map(),
    ownershipProbeGeneration: null,
    ownerWriteFailed: false,
    ownershipRecheck: null,
    resumeAfterTransient: false,
    probeHeldSave: false,
    claimSequence: previous?.claimSequence ?? 0,
    coordinationGeneration: previous?.coordinationGeneration ?? 0,
    pendingInstalls: new Map(),
    pendingImportFence: null,
    retry: null,
    writeSeq: 0,
    committedSeq: 0,
    activePauses: new Map(),
    pauseRecoveryTimers: new Map(),
    releasePresence: null,
    heartbeatInstance: previous?.heartbeatInstance ?? 0,
  }
}

const tabId = `tab-${randomToken()}`
const session = readSessionIdentity()

/** A pause outlives the owner's lease by this long before recovery checks it. */
const PAUSE_RECOVERY_MS = LEASE_MS + 5_000

let coordination = createCoordinationState()

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
  /**
   * Refuse to run outside a real lock or transaction when the section mutates
   * shared state. A function is re-evaluated at the fallback, so a requirement
   * that appeared while the IDB path was opening still fails closed.
   */
  requireSerialization?: boolean | (() => boolean)
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
  const requireSerialization = () =>
    typeof options.requireSerialization === 'function'
      ? options.requireSerialization()
      : (options.requireSerialization ?? false)
  const direct = (): Promise<T> => {
    if (requireSerialization()) return Promise.reject(new AutosaveCoordinationError())
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
      if (requireSerialization()) {
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
  const state = coordination
  if (state.releasePresence) return
  const locks = lockManager()
  if (!locks) return
  // Other tabs query the lock manager to learn who must acknowledge a pause.
  // The callback promise is settled by coordination teardown; otherwise an
  // unmount without a page unload would leave a presence no tab can answer.
  let release!: () => void
  const hold = new Promise<void>((resolve) => {
    release = resolve
  })
  const releasePresence = () => {
    if (state.releasePresence === releasePresence) state.releasePresence = null
    release()
  }
  state.releasePresence = releasePresence
  void locks
    .request(`${PRESENCE_PREFIX}${tabId}`, { mode: 'shared' }, () => hold)
    .catch(() => {
      if (state.releasePresence === releasePresence) state.releasePresence = null
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
  coordination.paused = true
  if (coordination.cancelPendingWrite) coordination.cancelPendingWrite()
  try {
    editorStore.getState().setAutosavePaused(true)
  } catch {
    // The store is always available in the app; a test can call the module alone.
  }
}

function setResumed(): void {
  const wasPaused = coordination.paused
  coordination.paused = false
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
    // A live gesture has not committed yet. Persisting its transient frame
    // would mix an unfinished preview into the slot, so mark the resume and
    // let the autosave subscription flush it when the gesture ends.
    if (isTransientActive()) {
      coordination.resumeAfterTransient = true
      return
    }
    coordination.resumeAfterTransient = false
    const savedDoc = store.doc
    const json = JSON.stringify(serializeDoc(savedDoc))
    const record = coordination
    const generation = record.coordinationGeneration
    void writeAutosaveCooperatively(json, undefined, undefined, savedDoc.project.id, savedDoc)
      .then((result) => {
        if (coordination !== record || record.coordinationGeneration !== generation) return
        const current = editorStore.getState()
        if (result === 'saved') {
          // A takeover or completed import can land after the slot write but
          // before this completion. Autosave is off then; leave the error
          // status instead of reporting saved.
          if (coordination.readOnly) return
          // A newer edit landed while this write was queued. Its own save is
          // already scheduled; reporting it saved would hide that.
          if (current.doc !== savedDoc) {
            current.setAutosaveStatus('pending')
            return
          }
          current.setAutosaveStatus('saved')
          current.markAutosaved()
        } else if (result === 'superseded') {
          // Only a live captured snapshot plus a committed slot proves this
          // write safe. A live reference alone can point at a newer document,
          // and a slot match alone can belong to the previous project.
          if (coordination.readOnly) return
          if (!autosaveSnapshotIsLive(current.doc, savedDoc, json)) return
          current.setAutosaveStatus('saved')
          current.markAutosaved()
        } else if (result === 'error') {
          current.setAutosaveStatus('error')
        } else if (result === 'read-only') {
          // The tab resumed but another tab owns the slot now: report autosave
          // off instead of leaving the indicator pending forever.
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
  if (coordination.importedAway || coordination.activePauses.size > 0) {
    if (!coordination.importedAway && coordination.readOnly) scheduleOwnershipRecheck()
    return
  }
  const generation = coordination.coordinationGeneration
  const wasPaused = coordination.paused
  let canResume = false
  let reloadRequired = false
  try {
    canResume = await withAutosaveSection(
      () => {
        // A teardown, a newer claim, or an owner-write failure makes this run
        // stale. Its callback must not touch shared state.
        if (
          generation !== coordination.coordinationGeneration ||
          coordination.owns ||
          coordination.ownerWriteFailed
        )
          return false
        // An import can land while this run waits for the lock. Keep autosave
        // off; the slot alone cannot prove the import is gone.
        if (coordination.importedAway) return false
        const record = readOwnerRecord()
        if (record && recordIsFresh(record) && record.tabId !== tabId) return false
        // A former owner must not resume against a newer epoch even after that
        // owner's lease went stale, matching the write path.
        if (record && coordination.ourEpoch > 0 && record.epoch > coordination.ourEpoch)
          return false
        if (record && record.tabId === tabId && record.epoch !== coordination.ourEpoch) return false
        // A different text means another tab replaced the slot. A failed read
        // proves nothing and stays read-only. The comparison and the resume
        // live inside the section so a claim cannot land in between.
        if (coordination.knownSlotRaw === undefined) return false
        let live: string | null
        try {
          live = readAutosaveOrThrow()
        } catch {
          return false
        }
        if (live !== coordination.knownSlotRaw) return false
        // An import marker that moved while this run waited means an import
        // landed without this tab seeing its pause. Stay read-only and stop
        // retrying: the observed marker can no longer match this session.
        if (
          coordination.knownImportFence !== undefined &&
          readImportFence() !== coordination.knownImportFence
        ) {
          reloadRequired = true
          clearOwnershipRecheck()
          return false
        }
        // A pause can arrive while this run waits for the lock. Leave the tab
        // paused so a save cannot land after it acknowledged that pause.
        if (coordination.activePauses.size > 0) return false
        coordination.readOnly = false
        coordination.paused = false
        try {
          editorStore.getState().setAutosavePaused(false)
        } catch {
          // The store is always available in the app; a test can call the module alone.
        }
        return true
      },
      { requireSerialization: true },
    )
  } catch {
    if (
      generation === coordination.coordinationGeneration &&
      !coordination.importedAway &&
      !coordination.ownerWriteFailed
    ) {
      scheduleOwnershipRecheck()
    }
    return
  }
  if (
    generation !== coordination.coordinationGeneration ||
    coordination.importedAway ||
    coordination.owns ||
    coordination.ownerWriteFailed
  )
    return
  if (!canResume) {
    if (coordination.readOnly && !reloadRequired) scheduleOwnershipRecheck()
    return
  }
  if (coordination.activePauses.size > 0) return
  // The probe held the debounced write the pause cancelled. Resume it now
  // that the slot check passed; a newer edit schedules its own save.
  if (wasPaused) resumePendingAutosave()
}

/** Clears the scheduled ownership recovery check. */
function clearOwnershipRecheck(state: CoordinationState = coordination): void {
  if (state.ownershipRecheck !== null) clearTimeout(state.ownershipRecheck)
  state.ownershipRecheck = null
}

/**
 * Arms one recovery check after the lease has expired. A peer that crashes
 * after answering (or after both failed probes) must not strand autosave until
 * reload; a strict slot-read failure is retried the same way.
 */
function scheduleOwnershipRecheck(): void {
  clearOwnershipRecheck()
  if (coordination.importedAway || coordination.ownerWriteFailed) return
  coordination.ownershipRecheck = setTimeout(() => {
    coordination.ownershipRecheck = null
    void recheckOwnershipAfterResume()
  }, PAUSE_RECOVERY_MS)
}

function markReadOnly(): void {
  coordination.owns = false
  stopHeartbeat()
  if (!coordination.importedAway && !coordination.ownerWriteFailed) scheduleOwnershipRecheck()
  coordination.readOnly = true
  coordination.paused = true
  try {
    const store = editorStore.getState()
    store.setAutosavePaused(true)
    // A permanent read-only state is autosave off. A temporary peer pause does
    // not pass through here, so its pending status survives until a resume.
    store.setAutosaveStatus('error')
  } catch {
    // ignore
  }
}

function startHeartbeat(): void {
  stopHeartbeat()
  const generation = coordination.coordinationGeneration
  const instance = ++coordination.heartbeatInstance
  coordination.heartbeat = setInterval(() => {
    if (!coordination.owns) return
    if (
      generation !== coordination.coordinationGeneration ||
      instance !== coordination.heartbeatInstance
    )
      return
    void withAutosaveSection(
      () => {
        if (
          generation !== coordination.coordinationGeneration ||
          instance !== coordination.heartbeatInstance ||
          !coordination.owns
        ) {
          return
        }
        const record = readOwnerRecord()
        if (!record || record.tabId !== tabId || record.epoch !== coordination.ourEpoch) {
          // A takeover moved the slot; this tab must not write again.
          if (
            generation !== coordination.coordinationGeneration ||
            instance !== coordination.heartbeatInstance
          )
            return
          coordination.owns = false
          stopHeartbeat()
          markReadOnly()
          return
        }
        if (!writeOwnerRecord({ ...record, heartbeatAt: now() })) {
          coordination.ownerWriteFailed = true
          coordination.owns = false
          stopHeartbeat()
          markReadOnly()
        }
      },
      { requireSerialization: true },
    ).catch(() => {
      // Without a serializable section this tab cannot prove it still owns the
      // slot. Stop writing rather than race a takeover. A stale section from
      // before teardown or a replacement claim must not touch the new session.
      if (
        generation !== coordination.coordinationGeneration ||
        instance !== coordination.heartbeatInstance
      )
        return
      coordination.ownerWriteFailed = true
      coordination.owns = false
      stopHeartbeat()
      markReadOnly()
    })
  }, HEARTBEAT_MS)
}

function stopHeartbeat(state: CoordinationState = coordination): void {
  if (state.heartbeat !== null) clearInterval(state.heartbeat)
  state.heartbeat = null
  state.heartbeatInstance += 1
}

function post(message: unknown): void {
  try {
    coordination.channel?.postMessage(message)
  } catch {
    // A closed channel loses the message; the fallback timeouts still apply.
  }
}

/** Settles one probe exactly once and clears its timer. */
function settleProbe(
  requestId: string,
  present: boolean,
  state: CoordinationState = coordination,
): void {
  const pending = state.pendingProbes.get(requestId)
  if (!pending) return
  clearTimeout(pending.timer)
  state.pendingProbes.delete(requestId)
  pending.resolve(present)
}

/** Clears every pending probe, resolving each absent. */
function clearPendingProbes(state: CoordinationState = coordination): void {
  for (const requestId of [...state.pendingProbes.keys()]) settleProbe(requestId, false, state)
}

function handlePause(requestId: string): void {
  coordination.activePauses.set(requestId, now())
  setPausedByOtherTab()
  schedulePauseRecovery(requestId)
  // Acknowledge only after this tab's in-flight write settles, so an older
  // document cannot land after the importer starts installing. The pause must
  // still belong to this coordination record when it does.
  const generation = coordination.coordinationGeneration
  void coordination.localWrites
    .catch(() => undefined)
    .then(() => {
      if (generation !== coordination.coordinationGeneration) return
      if (!coordination.activePauses.has(requestId)) return
      post({ type: 'paused', requestId, tabId })
    })
}

/** Drops one honored pause request and its recovery timer. */
function dropActivePause(requestId: string): void {
  coordination.activePauses.delete(requestId)
  const timer = coordination.pauseRecoveryTimers.get(requestId)
  if (timer !== undefined) {
    clearTimeout(timer)
    coordination.pauseRecoveryTimers.delete(requestId)
  }
}

/** Drops every honored pause request and its recovery timer. */
function clearActivePauses(state: CoordinationState = coordination): void {
  state.activePauses.clear()
  for (const timer of state.pauseRecoveryTimers.values()) clearTimeout(timer)
  state.pauseRecoveryTimers.clear()
}

interface CoordinationDisposeOptions {
  /** Settle pending pause promises with this reason. Omit to only clear timers. */
  pauseReason?: string
  /** Clear the editor paused flag when the tab is not imported or read-only. */
  resetPause?: boolean
}

/**
 * Releases everything one coordination record owns. The caller bumps
 * `coordinationGeneration` first, so a probe continuation resolved here cannot
 * touch the replacement record. A fresh reset then installs
 * `createCoordinationState(state)` to carry the monotonic sentinels forward.
 */
function disposeCoordination(
  state: CoordinationState,
  options: CoordinationDisposeOptions = {},
): void {
  state.detachListeners?.()
  state.detachListeners = null
  state.cancelPendingWrite?.()
  state.cancelPendingWrite = null
  state.releasePresence?.()
  state.releasePresence = null
  stopHeartbeat(state)
  state.owns = false
  clearActivePauses(state)
  if (options.resetPause && !state.importedAway && !state.readOnly) {
    state.paused = false
    if (coordination === state) {
      try {
        editorStore.getState().setAutosavePaused(false)
      } catch {
        // The store is always available in the app; a test can call the module alone.
      }
    }
  }
  for (const [requestId, pending] of state.pendingPauses) {
    clearTimeout(pending.timer)
    if (options.pauseReason !== undefined) {
      pending.finish({ ok: false, reason: options.pauseReason, requestId })
    }
  }
  state.pendingPauses.clear()
  clearPendingProbes(state)
  state.ownershipProbeGeneration = null
  state.ownerWriteFailed = false
  state.resumeAfterTransient = false
  state.probeHeldSave = false
  clearOwnershipRecheck(state)
  if (state.retry) clearTimeout(state.retry.timer)
  state.retry = null
  state.channel?.removeEventListener('message', handleMessage)
  state.channel?.close()
  state.channel = null
  state.initialized = false
}

function schedulePauseRecovery(requestId: string): void {
  if (coordination.pauseRecoveryTimers.has(requestId)) return
  coordination.pauseRecoveryTimers.set(
    requestId,
    setTimeout(() => {
      coordination.pauseRecoveryTimers.delete(requestId)
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
  if (!coordination.activePauses.has(requestId) || coordination.importedAway) return
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
  if (!coordination.activePauses.has(requestId) || coordination.importedAway) return
  if (owned) {
    schedulePauseRecovery(requestId)
    return
  }
  if (coordination.knownSlotRaw === undefined || readAutosave() !== coordination.knownSlotRaw) {
    dropActivePause(requestId)
    markReadOnly()
    return
  }
  dropActivePause(requestId)
  if (coordination.activePauses.size > 0) return
  if (coordination.readOnly) {
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
      const pending = coordination.pendingPauses.get(data.requestId)
      if (!pending) break
      // An acknowledgement from a tab the importer did not expect proves
      // nothing about the tabs it is waiting for.
      if (!pending.expected.has(data.tabId)) break
      pending.acked.add(data.tabId)
      if ([...pending.expected].every((id) => pending.acked.has(id))) {
        coordination.pendingPauses.delete(data.requestId)
        clearTimeout(pending.timer)
        pending.finish({ ok: true, requestId: data.requestId })
      }
      break
    }
    case 'imported':
      coordination.importedAway = true
      clearActivePauses()
      setPausedByOtherTab()
      markReadOnly()
      break
    case 'resume': {
      if (coordination.importedAway || typeof data.requestId !== 'string') break
      dropActivePause(data.requestId)
      if (coordination.activePauses.size > 0) break
      if (coordination.readOnly) {
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
      if (
        typeof data.requestId === 'string' &&
        data.sessionId === session.sessionId &&
        coordination.pendingProbes.has(data.requestId)
      ) {
        settleProbe(data.requestId, true)
      }
      break
    default:
      break
  }
}

function probeSession(): Promise<boolean> {
  if (!coordination.channel) return Promise.resolve(false)
  return new Promise((resolve) => {
    const requestId = randomToken()
    const timer = setTimeout(() => settleProbe(requestId, false), PROBE_TIMEOUT_MS)
    coordination.pendingProbes.set(requestId, { timer, resolve })
    post({ type: 'probe-session', requestId, sessionId: session.sessionId })
  })
}

async function initializeOwnership(generation: number): Promise<void> {
  if (coordination.importedAway) {
    markReadOnly()
    return
  }
  const record = readOwnerRecord()
  if (!record || !recordIsFresh(record)) {
    // A pause from an importer that arrived before this async check still
    // holds; do not clear a live request.
    if (coordination.activePauses.size > 0) {
      setPausedByOtherTab()
      return
    }
    // The slot may have changed while this tab had no live owner (an import
    // finished and its tab closed). A tab that is already read-only must not
    // resume over it; a fresh mount still reads the slot after this check and
    // must not be paused by state left from an earlier coordination session.
    if (coordination.readOnly && readAutosave() !== coordination.knownSlotRaw) {
      markReadOnly()
      return
    }
    // No live owner and an unchanged slot: normal multi-tab behavior, and this
    // tab may write. A provisional read-only state from a previous coordination
    // session is gone with its owner, and the stale ownership flag must not
    // survive it.
    coordination.owns = false
    coordination.readOnly = false
    coordination.paused = false
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

  const startingEpoch = coordination.ourEpoch
  const stillCurrent = () =>
    generation === coordination.coordinationGeneration &&
    coordination.ourEpoch === startingEpoch &&
    !coordination.importedAway
  const failClosed = () => {
    // An explicit claim in the same generation advances ourEpoch; a teardown
    // changes the generation. Neither may be revoked by this stale init.
    if (stillCurrent()) markReadOnly()
  }

  // Hold ordinary saves for the whole probe/reclaim so a write cannot advance
  // the slot the reclaim is about to compare. A stale probe from a torn-down
  // session cannot clear a newer session's marker because the generation
  // differs; teardown clears it explicitly.
  coordination.ownershipProbeGeneration = generation
  try {
    let probed = record
    for (let attempt = 0; attempt < 2; attempt += 1) {
      // This page may be a reload of the owner. If an old page still answers,
      // the session is open elsewhere and this page must stay read-only.
      const present = await probeSession()
      if (generation !== coordination.coordinationGeneration) return
      if (present) {
        failClosed()
        return
      }
      let outcome: 'claimed' | 'retry' | 'stale' | 'failed' | 'paused' = 'stale'
      let refreshed: OwnerRecord | null = null
      try {
        outcome = await withAutosaveSection(
          () => {
            if (!stillCurrent()) return 'stale'
            // A pause that arrived during the probe still owns the tab. Stay
            // read-only after it ends so the resume path rechecks ownership
            // instead of restoring writes from a probe that never claimed.
            if (coordination.activePauses.size > 0) {
              coordination.readOnly = true
              return 'paused'
            }
            // A prior owner-write failure is final until a new claim or reinit.
            if (coordination.ownerWriteFailed) return 'stale'
            const current = readOwnerRecord()
            if (!current) return 'stale'
            // Another same-session tab reclaimed while this init probed.
            if (current.tabId !== probed.tabId) return 'stale'
            if (
              current.sessionId !== probed.sessionId ||
              current.tokenHash !== probed.tokenHash ||
              current.epoch !== probed.epoch
            ) {
              return 'stale'
            }
            // A live peer refreshed its heartbeat during the probe. Retry once
            // against that record; a crash then leaves it unchanged and lets
            // the second timeout reclaim it.
            if (current.heartbeatAt !== probed.heartbeatAt) {
              refreshed = current
              return 'retry'
            }
            // The slot must still be the one this tab knew. A failed read is
            // fail-closed, never an empty slot.
            if (coordination.knownSlotRaw !== undefined) {
              let live: string | null
              try {
                live = readAutosaveOrThrow()
              } catch {
                return 'stale'
              }
              if (live !== coordination.knownSlotRaw) return 'stale'
            }
            if (!writeOwnerRecord({ ...current, tabId, heartbeatAt: now() })) {
              coordination.ownerWriteFailed = true
              coordination.owns = false
              stopHeartbeat()
              markReadOnly()
              return 'failed'
            }
            coordination.owns = true
            coordination.ourEpoch = current.epoch
            coordination.readOnly = false
            coordination.paused = false
            try {
              editorStore.getState().setAutosavePaused(false)
            } catch {
              // The store is always available in the app; a test can call the module alone.
            }
            startHeartbeat()
            return 'claimed'
          },
          { requireSerialization: true },
        )
      } catch {
        failClosed()
        return
      }
      if (outcome === 'claimed') return
      if (outcome === 'paused') return
      if (outcome === 'retry' && attempt === 0 && refreshed) {
        probed = refreshed
        continue
      }
      failClosed()
      return
    }
    failClosed()
  } finally {
    if (coordination.ownershipProbeGeneration === generation)
      coordination.ownershipProbeGeneration = null
    // Flush only a save this probe actually held. A writable tab with nothing
    // held must not write its boot document over the slot it is about to
    // restore. Teardown (generation changed), a read-only outcome, a pause, an
    // import, and a restore banner all keep the save pending instead. A
    // stale-epoch return stays writable by design: the explicit claim already
    // took the slot and the held edit belongs to it.
    const held = generation === coordination.coordinationGeneration && coordination.probeHeldSave
    if (generation === coordination.coordinationGeneration) coordination.probeHeldSave = false
    if (held) {
      const store = editorStore.getState()
      if (
        !coordination.readOnly &&
        !coordination.paused &&
        !coordination.importedAway &&
        !store.pendingRestore
      ) {
        resumePendingAutosave()
      }
    }
  }
}

/**
 * Starts the cross-tab autosave listener. Safe to call once per page; returns a
 * cleanup that stops timers and closes the channel. An unmount does not release
 * ownership (a remount must not lose it); a pagehide does.
 */
export function initAutosaveCoordination(): () => void {
  const mount = coordination
  if (mount.initialized) return () => undefined
  mount.initialized = true
  // A fresh page adopts the marker it boots on. A coordination remount keeps
  // the marker the live document already observed, so an import that landed
  // while the editor was unmounted cannot make the old document writable.
  if (coordination.knownImportFence === undefined) coordination.knownImportFence = readImportFence()
  const generation = (coordination.coordinationGeneration += 1)
  if (typeof BroadcastChannel !== 'undefined') {
    coordination.channel = new BroadcastChannel(AUTOSAVE_CHANNEL_NAME)
    coordination.channel.addEventListener('message', handleMessage)
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
      if (coordination.importedAway || coordination.readOnly) return
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
    if (!coordination.readOnly || coordination.importedAway || coordination.activePauses.size > 0)
      return
    void recheckOwnershipAfterResume()
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('storage', onStorage)
    mount.detachListeners = () => {
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('storage', onStorage)
    }
  }
  return () => {
    // This cleanup owns only the record this mount initialized. A test reset
    // can install a replacement record before the old cleanup runs; disposing
    // the replacement would close the new channel and heartbeat.
    mount.coordinationGeneration += 1
    // The owner record may survive for a remount, but the in-memory claim does
    // not: otherwise a stale remount refreshes the record without a heartbeat.
    // A pause belongs to the coordination session. A remount starts a new
    // channel and may miss a resume sent while this one was closed, so drop
    // the transient pause and let initializeOwnership re-evaluate the record.
    // A completed import or a recorded takeover stays paused. Disposal also
    // detaches this mount's storage and pagehide listeners.
    disposeCoordination(mount, {
      pauseReason: 'This tab closed during the autosave pause.',
      resetPause: true,
    })
  }
}

/** True while this tab must not write the shared autosave slot. */
export function isAutosavePaused(): boolean {
  return coordination.paused || coordination.readOnly || coordination.importedAway
}

/**
 * Claims the shared slot for a bundle import. A fresh record from another tab
 * refuses; a stale record (an unresponsive owner) is taken over with a new
 * epoch, so a former owner that resumes cannot overwrite this tab's write.
 */
export async function claimAutosaveOwnership(): Promise<AutosaveClaimResult> {
  if (coordination.importedAway) {
    return { ok: false, reason: 'This tab must reload before it can import a project.' }
  }
  if (!hasAutosaveSerialization()) {
    return {
      ok: false,
      reason:
        'This browser cannot coordinate autosave across tabs. Use a browser with Web Locks or IndexedDB, then try again.',
    }
  }
  if (coordination.activePauses.size > 0) {
    return {
      ok: false,
      reason: 'Another import is pausing this tab. Reload after it finishes, then try again.',
    }
  }
  // A later claim supersedes this one while it probes or waits for the lock.
  // Without it, an older import could write a higher epoch after the newer
  // claim succeeded and take the slot from it.
  const claimToken = ++coordination.claimSequence
  const generation = coordination.coordinationGeneration
  const entryEpoch = coordination.ourEpoch
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
      if (generation !== coordination.coordinationGeneration) {
        return { ok: false, reason: 'This tab closed during the autosave claim.' }
      }
      probedOwner = initial
    }
  }
  let result: AutosaveClaimResult
  try {
    result = await withAutosaveSection(
      (): AutosaveClaimResult => {
        if (generation !== coordination.coordinationGeneration) {
          return { ok: false, reason: 'This tab closed during the autosave claim.' }
        }
        if (coordination.importedAway) {
          return { ok: false, reason: 'This tab must reload before it can import a project.' }
        }
        if (claimToken !== coordination.claimSequence) {
          return {
            ok: false,
            reason: 'Another import took over the autosave claim. Reload, then try again.',
          }
        }
        if (coordination.activePauses.size > 0) {
          return {
            ok: false,
            reason: 'Another import is pausing this tab. Reload after it finishes, then try again.',
          }
        }
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
        // The slot this tab observed must still be the live slot. The read is
        // strict: a storage failure is a conflict, not an empty slot. A stale
        // claim that already lost to a newer one must not revoke it.
        const slotConflict = (reason: string): AutosaveClaimResult => {
          if (
            generation === coordination.coordinationGeneration &&
            coordination.ourEpoch === entryEpoch
          ) {
            coordination.owns = false
            stopHeartbeat()
            markReadOnly()
          }
          return { ok: false, reason }
        }
        if (coordination.knownSlotRaw !== undefined) {
          let live: string | null
          try {
            live = readAutosaveOrThrow()
          } catch {
            return slotConflict(
              'This tab could not verify the autosave slot. Reload and try again.',
            )
          }
          if (live !== coordination.knownSlotRaw) {
            return slotConflict(
              'Another tab saved this project after this page loaded. Reload and try again.',
            )
          }
        }
        const epoch = Math.max(record?.epoch ?? 0, coordination.ourEpoch) + 1
        const wrote = writeOwnerRecord({
          tabId,
          sessionId: session.sessionId,
          tokenHash: session.tokenHash,
          epoch,
          heartbeatAt: now(),
        })
        if (!wrote) {
          if (
            generation === coordination.coordinationGeneration &&
            coordination.ourEpoch === entryEpoch
          ) {
            coordination.ownerWriteFailed = true
            coordination.owns = false
            stopHeartbeat()
            markReadOnly()
          }
          return { ok: false, reason: 'This browser could not record autosave ownership.' }
        }
        coordination.owns = true
        coordination.ourEpoch = epoch
        coordination.ownerWriteFailed = false
        coordination.readOnly = false
        coordination.paused = false
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
    if (coordination.ourEpoch !== epoch) return
    const record = readOwnerRecord()
    if (record && record.tabId === tabId && record.epoch !== epoch) return
  }
  stopHeartbeat()
  coordination.owns = false
  clearOwnerRecordIfOurs()
}

/**
 * Broadcasts a pause and waits for every known editor tab to acknowledge.
 * Without a channel this is a single tab, so it succeeds. Tabs that do not
 * answer within the timeout refuse the import instead of risking the slot.
 */
export async function pauseOtherAutosaveTabs(): Promise<AutosavePauseResult> {
  if (!coordination.channel) return { ok: true, requestId: 'local' }
  const requestId = randomToken()
  const generation = coordination.coordinationGeneration
  const expected = new Set(await otherAutosaveTabs())
  if (generation !== coordination.coordinationGeneration) {
    return {
      ok: false,
      reason: 'This tab closed during the autosave pause.',
      requestId,
    }
  }
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => {
        const pending = coordination.pendingPauses.get(requestId)
        if (!pending) return
        const missing = [...pending.expected].filter((id) => !pending.acked.has(id))
        coordination.pendingPauses.delete(requestId)
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
    coordination.pendingPauses.set(requestId, {
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
  const current = coordination.pendingInstalls.get(pending.projectId)
  if (current?.installId === pending.installId)
    coordination.pendingInstalls.delete(pending.projectId)
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
  coordination.pendingInstalls.set(projectId, { projectId, installId, hadInstallClaims })
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
  coordination.pendingImportFence = { projectId, token: randomToken() }
}

/** Restores every durable pending install from a previous page into memory. */
function restorePendingInstalls(): void {
  for (const record of readPendingInstallRecords()) {
    if (!coordination.pendingInstalls.has(record.projectId))
      coordination.pendingInstalls.set(record.projectId, record)
  }
}

/** True when an install record still awaits a durable write. */
export function hasPendingInstall(): boolean {
  return coordination.pendingInstalls.size > 0
}

function nextWriteSeq(): number {
  coordination.writeSeq += 1
  return coordination.writeSeq
}

function clearAutosaveRetry(): void {
  if (!coordination.retry) return
  clearTimeout(coordination.retry.timer)
  coordination.retry = null
}

/**
 * Writes the slot under the shared lock, refusing when another tab owns it.
 * Serialization happens before the call, so the section stays synchronous.
 * `seq` orders writes: an older retry that runs after a newer write committed
 * is superseded instead of replacing the newer document. `projectId` scopes a
 * bundle write: when another project became live while it was queued, the
 * imported snapshot must not replace that project's slot. `snapshotId` is the
 * captured doc's project id, passed by callers that already know it so the
 * write does not re-parse the serialized JSON; when omitted it is read from the
 * JSON. `snapshotDoc` is the captured document reference, when the caller has
 * one, so a write queued behind another can prove the live document is still
 * that same snapshot before it touches the registry, fence, or slot.
 */
export function writeAutosaveCooperatively(
  json: string,
  seq = nextWriteSeq(),
  projectId?: string,
  snapshotId?: string,
  snapshotDoc?: Doc,
): Promise<AutosaveWriteResult> {
  const origin = coordination
  const generation = origin.coordinationGeneration
  if (isAutosavePaused()) return Promise.resolve('read-only')
  // An ownership probe compares the slot it saw before the probe. A save that
  // advanced it would make a peer's newer slot look like this tab's own write.
  // A project-scoped import write rejected here is preserved by the caller's
  // pending-install retry; an ordinary save resumes from the probe finally.
  if (origin.ownershipProbeGeneration !== null) {
    if (projectId === undefined) origin.probeHeldSave = true
    return Promise.resolve('read-only')
  }
  // Re-evaluated at an IDB fallback: a pending install, scoped write, or fence
  // can arrive after this call while the database open or read is in flight.
  const requireSerialization = () =>
    origin.owns ||
    origin.pendingInstalls.size > 0 ||
    projectId !== undefined ||
    origin.pendingImportFence !== null
  const run = origin.localWrites
    .catch(() => undefined)
    .then(() =>
      withAutosaveSection(
        (): AutosaveWriteResult => {
          // A reset can replace the coordination record while this write waits
          // for the section. The old write must not touch the replacement
          // record's slot, sequence, or registry. This is a failure, not a
          // supersession by a newer committed write: a project-scoped import
          // must keep its retry obligation when the write never ran.
          if (coordination !== origin || origin.coordinationGeneration !== generation) {
            return 'read-only'
          }
          // A pause can arrive after the early check while this write waits
          // for its turn. Never persist a document for a tab that is paused.
          if (isAutosavePaused()) return 'read-only'
          if (origin.ownershipProbeGeneration !== null) {
            if (projectId === undefined) origin.probeHeldSave = true
            return 'read-only'
          }
          // The captured document can be replaced while this write waits for
          // the section. Its newer edit owns persistence, and using the stale
          // snapshot here would consume an install or fence for old content.
          if (snapshotDoc !== undefined && editorStore.getState().doc !== snapshotDoc) {
            return 'superseded'
          }
          const record = readOwnerRecord()
          if (record && record.tabId !== tabId && recordIsFresh(record)) {
            origin.owns = false
            stopHeartbeat()
            markReadOnly()
            return 'read-only'
          }
          // A former owner must not write against a newer epoch even after that
          // owner's lease went stale: a stale lease must not make an old epoch
          // valid again.
          if (record && origin.ourEpoch > 0 && record.epoch > origin.ourEpoch) {
            origin.owns = false
            markReadOnly()
            return 'read-only'
          }
          if (record && record.tabId === tabId && record.epoch !== origin.ourEpoch) {
            origin.owns = false
            markReadOnly()
            return 'read-only'
          }
          const liveProjectId = editorStore.getState().doc.project.id
          // The JSON was captured for one project. Selecting the pending
          // install or the fence by the live project would let a stale
          // snapshot consume another project's install and overwrite its slot.
          const snapshotProjectId =
            snapshotId ?? serializedProjectId(json) ?? projectId ?? liveProjectId
          // A project-scoped write is an import or its retry. A tab that
          // observed an older import marker must not overwrite the slot even
          // when it missed the pause and no owner record remains.
          const fence = readImportFence()
          if (origin.knownImportFence === undefined) {
            origin.knownImportFence = fence
          } else if (fence !== origin.knownImportFence) {
            markReadOnly()
            return 'read-only'
          }
          // A bundle import can finish after another project became live. Its
          // snapshot must not replace that project's slot or report it saved.
          if (projectId !== undefined && liveProjectId !== projectId) {
            return 'superseded'
          }
          if (snapshotProjectId !== liveProjectId) {
            // A pending install for this snapshot keeps its record for the
            // retry path, which appends it without touching another slot.
            return 'superseded'
          }
          if (seq < origin.committedSeq) return 'superseded'
          // Consume the pending install only for an eligible snapshot. A
          // superseded save leaves it in memory, so the next eligible save
          // still appends the install and lands its marker.
          const pending = origin.pendingInstalls.get(snapshotProjectId)
          if (pending && !recordPendingInstallInSection(pending)) return 'error'
          // The marker must be durable before the slot names the imported
          // project: a project-scoped save without it leaves a tab that missed
          // the pause free to replace the slot after the lease expires. The
          // requirement outlives the call that started it, so an ordinary
          // autosave for the same project cannot write the slot without it.
          const fenceProjectId = snapshotProjectId
          if (
            origin.pendingImportFence !== null &&
            origin.pendingImportFence.projectId !== fenceProjectId
          ) {
            // The imported project no longer owns the live slot, so its
            // unfinished marker cannot protect another project's write.
            origin.pendingImportFence = null
          }
          // A pending install proves an install is mid-flight even when the
          // caller is the ordinary resume save. Establish the marker here so
          // neither the slot nor its retry can advance ahead of the fence.
          if (
            (projectId !== undefined || pending !== undefined) &&
            origin.pendingImportFence === null
          ) {
            origin.pendingImportFence = { projectId: fenceProjectId, token: randomToken() }
          }
          if (origin.pendingImportFence !== null) {
            if (!writeImportFence(origin.pendingImportFence.token)) {
              // The install append is durable, but the slot is not. An
              // ordinary save has no caller-owned retry, so schedule one bound
              // to this snapshot and sequence. With another project's append
              // still owed, the combined retry must keep both obligations
              // instead of replacing that project's timer.
              if (projectId === undefined) {
                if (origin.pendingInstalls.size > 0) {
                  queuePendingInstallRetry(snapshotProjectId, seq)
                } else {
                  queueAutosaveRetry(json, seq, snapshotProjectId)
                }
              }
              return 'error'
            }
            origin.knownImportFence = origin.pendingImportFence.token
          }
          try {
            localStorage.setItem(AUTOSAVE_KEY, json)
          } catch {
            return 'error'
          }
          origin.committedSeq = Math.max(origin.committedSeq, seq)
          origin.knownSlotRaw = json
          // An ordinary save keeps the requirement so the import's own
          // project-scoped write can reuse the same marker instead of fencing
          // the slot a second time.
          if (projectId !== undefined) origin.pendingImportFence = null
          // A live save clears only its own slot retry. Another project's
          // pending-install retry must survive until its append completes.
          if (
            origin.retry &&
            origin.retry.seq < seq &&
            (origin.retry.projectId === null || origin.retry.projectId === snapshotProjectId)
          ) {
            if (origin.pendingInstalls.size > 0) {
              // The slot is saved, but another project's registry append is
              // still owed. Keep its budget and reschedule that work without a
              // slot target instead of dropping the combined retry's timer.
              const attempts = origin.retry.attempts
              clearAutosaveRetry()
              queuePendingInstallRetry(undefined, undefined, attempts)
            } else {
              clearAutosaveRetry()
            }
          }
          if (origin.owns) {
            const current = readOwnerRecord()
            if (current && current.tabId === tabId) {
              if (!writeOwnerRecord({ ...current, heartbeatAt: now() })) {
                // Fail the claim this refresh actually targeted closed. A
                // superseded record's failure leaves the newer claim alone.
                if (current.epoch === origin.ourEpoch) {
                  origin.ownerWriteFailed = true
                  origin.owns = false
                  stopHeartbeat()
                  markReadOnly()
                }
              }
            } else if (!current) {
              // The record vanished (storage eviction, manual clear): re-establish
              // it before another tab can claim the slot this write just changed.
              const epoch = origin.ourEpoch + 1
              if (
                !writeOwnerRecord({
                  tabId,
                  sessionId: session.sessionId,
                  tokenHash: session.tokenHash,
                  epoch,
                  heartbeatAt: now(),
                })
              ) {
                origin.ownerWriteFailed = true
                origin.owns = false
                stopHeartbeat()
                markReadOnly()
                return 'error'
              }
              origin.ourEpoch = epoch
            }
          }
          return 'saved'
        },
        { requireSerialization },
      ).catch(() => 'error' as AutosaveWriteResult),
    )
  origin.localWrites = run
  return run
}

/** Reads a serialized snapshot's project id without hydrating the document. */
function serializedProjectId(json: string): string | null {
  try {
    const parsed: unknown = JSON.parse(json)
    if (typeof parsed !== 'object' || parsed === null) return null
    const project = (parsed as { project?: unknown }).project
    if (typeof project !== 'object' || project === null) return null
    const id = (project as { id?: unknown }).id
    // A malformed id cannot name a live project, so return a value no project
    // matches. The write is superseded instead of replacing the live slot.
    return typeof id === 'string' ? id : ''
  } catch {
    return null
  }
}

/**
 * Compares autosaved document content, not its text: `serializeDoc` stamps a
 * fresh `savedAt` on every call, so a text comparison would discard an
 * unchanged document on every retry.
 */
function autosaveContentOf(text: string | null): string | null {
  try {
    const parsed: unknown = JSON.parse(String(text))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const content = { ...(parsed as Record<string, unknown>) }
    delete content.savedAt
    return JSON.stringify(content)
  } catch {
    return null
  }
}

/** True when the committed slot contains exactly this serialized snapshot. */
function autosaveSlotMatches(json: string): boolean {
  const expected = autosaveContentOf(json)
  const committed = autosaveContentOf(readAutosave())
  return expected !== null && committed !== null && expected === committed
}

/** True when the live document and the committed slot both match the snapshot. */
function autosaveSnapshotIsLive(doc: Doc, savedDoc: Doc, json: string): boolean {
  if (doc !== savedDoc) return false
  return autosaveSlotMatches(json)
}

/**
 * Retries a slot write that failed after installation (storage full, registry
 * append refused). Retries are bounded; a later edit schedules its own write.
 */
export function queueAutosaveRetry(json: string, seq?: number, projectId?: string): void {
  if (coordination.retry) clearTimeout(coordination.retry.timer)
  const attempt = (coordination.retry?.attempts ?? 0) + 1
  if (attempt > MAX_RETRIES) {
    coordination.retry = null
    return
  }
  // Retain the original sequence across attempts: allocating a newer sequence
  // per retry would let an old document overwrite a newer edit that committed
  // between attempts. A newer edit allocates a higher sequence and supersedes
  // this retry instead.
  const useSeq = seq ?? nextWriteSeq()
  const target = projectId ?? coordination.retry?.projectId ?? null
  const content = target !== null ? autosaveContentOf(json) : null
  coordination.retry = {
    json,
    attempts: attempt,
    seq: useSeq,
    projectId: target,
    timer: setTimeout(() => {
      const scheduled = coordination.retry
      const live = editorStore.getState()
      if (target !== null) {
        // A bundle slot retry belongs to the project it was captured for. Once
        // another project is live, writing it would replace that project's
        // slot and report it saved, so the retry is dropped.
        if (live.doc.project.id !== target) {
          if (coordination.retry === scheduled) coordination.retry = null
          return
        }
        // The same project id can come back with new content (a reopen or a
        // rename). A captured snapshot that no longer matches the live doc is
        // stale; the newer edit schedules its own write.
        let current: string
        try {
          current = JSON.stringify(serializeDoc(live.doc))
        } catch {
          if (coordination.retry === scheduled) coordination.retry = null
          return
        }
        if (content !== null && autosaveContentOf(current) !== content) {
          if (coordination.retry === scheduled) coordination.retry = null
          return
        }
      }
      void writeAutosaveCooperatively(
        json,
        useSeq,
        target ?? undefined,
        target ?? undefined,
        target !== null ? live.doc : undefined,
      ).then((result) => {
        // A newer retry was queued while this write was in flight. Clearing or
        // replacing it here would erase that payload; its own completion owns
        // the slot and the status.
        if (coordination.retry !== scheduled) return
        if (result === 'saved' || result === 'superseded') {
          // A takeover or completed import may have turned this tab read-only
          // after the write ran. It must not restore a saved/pending status.
          if (coordination.readOnly) return
          coordination.retry = null
          // A sequence supersede proves this snapshot safe only when the
          // committed slot still contains it, not when another project won.
          if (result === 'superseded' && !autosaveSlotMatches(json)) return
          if (target !== null) {
            const store = editorStore.getState()
            // An edit landed while this write was queued: its own save is
            // scheduled, so do not report the newer document saved. The
            // content check also covers a project switch because the project
            // id is part of the serialized content.
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
 *
 * `attempts` carries an existing retry's budget when its timer is moved from a
 * combined pass to registry-only work, so a reschedule does not reset the cap.
 */
export function queuePendingInstallRetry(
  projectId?: string,
  seq?: number,
  attempts?: number,
): void {
  if (coordination.retry) clearTimeout(coordination.retry.timer)
  const attempt = attempts ?? (coordination.retry?.attempts ?? 0) + 1
  if (attempt > MAX_RETRIES) {
    coordination.retry = null
    return
  }
  const useSeq = seq ?? coordination.retry?.seq ?? nextWriteSeq()
  const target = projectId ?? coordination.retry?.projectId ?? null
  const scheduled: AutosaveRetry = {
    json: '',
    attempts: attempt,
    seq: useSeq,
    projectId: target,
    timer: setTimeout(() => {
      void runPendingInstallRetry(scheduled)
    }, RETRY_MS),
  }
  coordination.retry = scheduled
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
  for (const pending of [...coordination.pendingInstalls.values()]) {
    if (pending.projectId === liveProjectId) continue
    await recordAndClearPendingInstall(pending)
    if (coordination.retry !== scheduled) return
  }
  if (coordination.retry !== scheduled) return
  const livePending = coordination.pendingInstalls.has(liveProjectId)
  const slotProjectId = livePending ? liveProjectId : scheduled.projectId
  if (slotProjectId === null || (!livePending && slotProjectId !== liveProjectId)) {
    if (coordination.pendingInstalls.size > 0) {
      // Keep the attempt count, but stop carrying a slot project: the rest of
      // this pass is registry appends only.
      scheduled.projectId = null
      queuePendingInstallRetry()
    } else {
      coordination.retry = null
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
  if (coordination.retry === scheduled) scheduled.json = json
  const result = await writeAutosaveCooperatively(
    json,
    scheduled.seq,
    slotProjectId,
    savedDoc.project.id,
    savedDoc,
  )
  if (coordination.retry !== scheduled) return
  if (result === 'saved' || result === 'superseded') {
    const committed = autosaveSlotMatches(json)
    const store = editorStore.getState()
    if (store.doc.project.id === slotProjectId && !coordination.readOnly) {
      // A newer edit that landed while the retry was queued owns its own save.
      // Reporting it saved here would hide the unsaved document. A takeover or
      // completed import has already reported autosave off, and a late retry
      // completion must not restore saved or pending.
      if (store.doc !== savedDoc || !committed) {
        store.setAutosaveStatus('pending')
      } else {
        store.setAutosaveStatus('saved')
        store.markAutosaved()
      }
    }
    if (coordination.pendingInstalls.size > 0) {
      // The live slot is saved. Only another project's append remains, so the
      // next pass must not rewrite this slot or fence it again.
      scheduled.projectId = null
      queuePendingInstallRetry()
    } else {
      coordination.retry = null
    }
    return
  }
  if (coordination.pendingInstalls.size > 0) {
    queuePendingInstallRetry(slotProjectId)
    return
  }
  queueAutosaveRetry(json, scheduled.seq, slotProjectId)
}

/** Registers the callback a pause uses to cancel this tab's pending timer. */
export function setAutosaveCancel(cancel: (() => void) | null): void {
  coordination.cancelPendingWrite = cancel
}

/** Test hook: dispose the live record and install a fresh one. */
export function resetAutosaveCoordinationForTests(): void {
  const previous = coordination
  previous.coordinationGeneration += 1
  disposeCoordination(previous, {
    pauseReason: 'The editor was reset during the autosave pause.',
  })
  coordination = createCoordinationState(previous)
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
  if (coordination.pendingInstalls.size > 0) queuePendingInstallRetry()

  const unsubscribe = editorStore.subscribe((state, prevState) => {
    // Save when the doc changes (commands) OR when a transient gesture commits
    // (commitTransient only moves `past` — the doc reference is already final).
    const docChanged =
      state.doc !== prevState.doc ||
      state.past !== prevState.past ||
      state.future !== prevState.future
    if (!docChanged) {
      // A resume can arrive while a gesture is live. A cancel with no frame
      // leaves no doc change, so the ending transition owns that flush.
      if (coordination.resumeAfterTransient && !isTransientActive() && !isAutosavePaused()) {
        coordination.resumeAfterTransient = false
        resumePendingAutosave()
      }
      return
    }
    if (isTransientActive()) return
    if (isAutosavePaused()) return
    coordination.resumeAfterTransient = false
    if (timer) clearTimeout(timer)
    editorStore.getState().setAutosaveStatus('pending')
    const seq = nextWriteSeq()
    const record = coordination
    const generation = record.coordinationGeneration
    timer = setTimeout(() => {
      timer = null
      const savedDoc = editorStore.getState().doc
      const json = JSON.stringify(serializeDoc(savedDoc))
      void writeAutosaveCooperatively(json, seq, undefined, savedDoc.project.id, savedDoc).then(
        (result) => {
          if (coordination !== record || record.coordinationGeneration !== generation) return
          const store = editorStore.getState()
          if (result === 'saved') {
            // A takeover or completed import can land after the slot write but
            // before this completion. Autosave is off then; leave the error
            // status instead of restoring pending or saved.
            if (coordination.readOnly) return
            // A newer edit landed while this write was queued. Its own save is
            // already scheduled; marking it saved here would hide that.
            if (store.doc !== savedDoc) {
              store.setAutosaveStatus('pending')
              return
            }
            store.setAutosaveStatus('saved')
            store.markAutosaved()
          } else if (result === 'superseded') {
            // Only a live captured snapshot plus a committed slot proves this
            // write safe. A live reference alone can point at a newer document,
            // and a slot match alone can belong to the previous project.
            if (coordination.readOnly) return
            if (!autosaveSnapshotIsLive(store.doc, savedDoc, json)) return
            store.setAutosaveStatus('saved')
            store.markAutosaved()
          } else if (result === 'error') {
            store.setAutosaveStatus('error')
          } else if (result === 'read-only') {
            // A permanent refusal (takeover or completed import) is autosave
            // off; a temporary peer pause leaves the document pending for the
            // resume handler.
            store.setAutosaveStatus(coordination.readOnly ? 'error' : 'pending')
          }
        },
      )
    }, DEBOUNCE_MS)
  })

  return () => {
    cancel()
    setAutosaveCancel(null)
    unsubscribe()
  }
}
