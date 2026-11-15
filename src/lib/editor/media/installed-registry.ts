/**
 * installed-registry.ts: the durable record of bundle installs (0.28.0).
 *
 * A bundle import writes its claim shard BEFORE `installProject`, so a crash
 * can leave a shard for a project that was never installed. This append-only
 * registry records the install id of every successful import (and every saved
 * copy's claim), keyed by project id. Recovery reads it before treating a
 * shard as orphaned; a missing or unreadable registry proves nothing, so every
 * shard is kept.
 *
 * The registry is not cleared when another project opens: a saved copy's
 * record must survive a project switch so its shard keeps protecting bytes.
 *
 * Browser-bound (localStorage).
 */

const REGISTRY_KEY = 'web-video-editor:installed-installs:v1'
/**
 * Set when an append finds no registry but install-tagged claims exist. The
 * registry can no longer prove which installs completed, so recovery stops
 * retiring install-tagged shards. It is never cleared automatically.
 */
const HISTORY_LOST_KEY = 'web-video-editor:installed-history-lost:v1'
/**
 * An install that completed locally but whose registry append has not been
 * confirmed. Written alongside the in-memory pending install so a reload
 * before registration still protects the claim: recovery keeps the shard
 * until the append lands. Cleared when the append is confirmed.
 */
const PENDING_INSTALL_KEY = 'web-video-editor:pending-install:v1'
const INSTALL_ID_PATTERN = /^install-[A-Za-z0-9-]{1,80}$/
const PROJECT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const MAX_PROJECTS = 2048
const MAX_INSTALLS_PER_PROJECT = 2048
/** Keep the localStorage record bounded; a full record refuses the append. */
const MAX_REGISTRY_CHARS = 1_500_000

export interface InstalledRegistry {
  [projectId: string]: string[]
}

/**
 * A registry dictionary with no prototype. Project ids are user-controlled
 * strings that accept `constructor` and `__proto__`; on a plain object those
 * read inherited values or mutate the prototype, so every lookup and append
 * must use this shape.
 */
function emptyRegistry(): InstalledRegistry {
  return Object.create(null) as InstalledRegistry
}

/** A fresh install id for one import or saved copy. */
export function newInstallId(): string {
  const raw =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  return `install-${raw}`
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/**
 * The registry's state. A missing key is distinct from an empty record: a
 * claim shard carrying an install id proves a record was written once, so a
 * lost key means the installation history is unknown, not empty. Recovery must
 * keep its shards then.
 */
export type InstalledRegistryState =
  | { status: 'present'; registry: InstalledRegistry }
  | { status: 'missing' }
  | { status: 'unreadable' }

/**
 * Reads and validates the registry with its state. Callers that delete claim
 * shards must use this and keep every shard unless the state is `present`.
 */
export function readInstalledRegistryState(): InstalledRegistryState {
  const store = storage()
  if (!store) return { status: 'unreadable' }
  let raw: string | null
  try {
    raw = store.getItem(REGISTRY_KEY)
  } catch {
    return { status: 'unreadable' }
  }
  if (raw === null) return { status: 'missing' }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { status: 'unreadable' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { status: 'unreadable' }
  }
  const registry = emptyRegistry()
  for (const [projectId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!PROJECT_ID_PATTERN.test(projectId)) return { status: 'unreadable' }
    if (!Array.isArray(value)) return { status: 'unreadable' }
    const ids: string[] = []
    for (const entry of value) {
      if (typeof entry !== 'string' || !INSTALL_ID_PATTERN.test(entry)) {
        return { status: 'unreadable' }
      }
      ids.push(entry)
    }
    registry[projectId] = ids
  }
  return { status: 'present', registry }
}

/**
 * Reads and validates the registry. Returns null when storage is unavailable
 * or the record is malformed. A missing key reads as empty for append-only
 * callers; recovery uses `readInstalledRegistryState` and keeps its shards.
 */
export function readInstalledRegistry(): InstalledRegistry | null {
  const state = readInstalledRegistryState()
  if (state.status === 'unreadable') return null
  return state.status === 'missing' ? emptyRegistry() : state.registry
}

export interface PendingInstallRecord {
  projectId: string
  installId: string
  hadInstallClaims: boolean
}

/** Best-effort durable mirror of the in-memory pending install. */
export function writePendingInstallRecord(record: PendingInstallRecord): boolean {
  if (!PROJECT_ID_PATTERN.test(record.projectId) || !INSTALL_ID_PATTERN.test(record.installId)) {
    return false
  }
  const store = storage()
  if (!store) return false
  try {
    store.setItem(
      PENDING_INSTALL_KEY,
      JSON.stringify({
        projectId: record.projectId,
        installId: record.installId,
        hadInstallClaims: record.hadInstallClaims,
      }),
    )
    return true
  } catch {
    return false
  }
}

/** The durable pending install, or null when none was recorded or it is malformed. */
export function readPendingInstallRecord(): PendingInstallRecord | null {
  const store = storage()
  if (!store) return null
  let raw: string | null
  try {
    raw = store.getItem(PENDING_INSTALL_KEY)
  } catch {
    return null
  }
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as Partial<PendingInstallRecord>
    if (
      typeof parsed.projectId !== 'string' ||
      !PROJECT_ID_PATTERN.test(parsed.projectId) ||
      typeof parsed.installId !== 'string' ||
      !INSTALL_ID_PATTERN.test(parsed.installId)
    ) {
      return null
    }
    return {
      projectId: parsed.projectId,
      installId: parsed.installId,
      hadInstallClaims: parsed.hadInstallClaims === true,
    }
  } catch {
    return null
  }
}

/** True when a durable pending install exists for this project. */
export function hasPendingInstallFor(projectId: string): boolean {
  const pending = readPendingInstallRecord()
  return pending !== null && pending.projectId === projectId
}

/** Drops the durable pending install. A missing key is not an error. */
export function clearPendingInstallRecord(): void {
  try {
    storage()?.removeItem(PENDING_INSTALL_KEY)
  } catch {
    // A blocked storage is already the state this hook wants.
  }
}

/** True when an append found a lost install history and marked it unknown. */
export function isInstallHistoryLost(): boolean {
  const store = storage()
  if (!store) return true
  try {
    return store.getItem(HISTORY_LOST_KEY) !== null
  } catch {
    return true
  }
}

/** Marks the install history unknown. Returns false when storage refused it. */
export function markInstallHistoryLost(): boolean {
  const store = storage()
  if (!store) return false
  try {
    store.setItem(HISTORY_LOST_KEY, '1')
    return true
  } catch {
    return false
  }
}

/**
 * Appends one install id. Returns false when storage rejected the write, so
 * the caller can keep its claim shard and retry.
 *
 * `hadInstallClaims` means the project already has install-tagged claim shards.
 * If this project is absent from the registry (because the key was lost or its
 * entry never existed), a new append would publish an incomplete history, so
 * the history-lost marker is written first. Recovery then keeps those shards
 * instead of treating their installs as orphans.
 */
export function recordInstalledImport(
  projectId: string,
  installId: string,
  options: { hadInstallClaims?: boolean } = {},
): boolean {
  // A refused append cannot record this install. The registry would then look
  // complete while missing an id whose shard recovery may need, so mark the
  // history unknown and keep install-tagged shards.
  const refuse = (): false => {
    markInstallHistoryLost()
    return false
  }
  if (!PROJECT_ID_PATTERN.test(projectId) || !INSTALL_ID_PATTERN.test(installId)) return false
  const state = readInstalledRegistryState()
  if (state.status === 'unreadable') return false
  const registry = state.status === 'present' ? state.registry : emptyRegistry()
  if (options.hadInstallClaims && !Object.hasOwn(registry, projectId)) {
    if (!markInstallHistoryLost()) return false
  }
  const projectIds = Object.keys(registry)
  if (!Object.hasOwn(registry, projectId) && projectIds.length >= MAX_PROJECTS) {
    return refuse()
  }
  const ids = registry[projectId] ?? []
  if (ids.includes(installId)) return true
  if (ids.length >= MAX_INSTALLS_PER_PROJECT) return refuse()
  registry[projectId] = [...ids, installId]
  const serialized = JSON.stringify(registry)
  if (serialized.length > MAX_REGISTRY_CHARS) return refuse()
  const store = storage()
  if (!store) return false
  try {
    store.setItem(REGISTRY_KEY, serialized)
    return true
  } catch {
    return refuse()
  }
}

/**
 * True when the project's registry records the install, false when it does
 * not, and null when the registry is unavailable or ambiguous.
 */
export function isInstallRecorded(projectId: string, installId: string): boolean | null {
  if (!PROJECT_ID_PATTERN.test(projectId) || !INSTALL_ID_PATTERN.test(installId)) return null
  const state = readInstalledRegistryState()
  if (state.status !== 'present') return null
  const recorded = (state.registry[projectId] ?? []).includes(installId)
  if (recorded) return true
  // A lost history cannot prove that an absent id never installed.
  return isInstallHistoryLost() ? null : false
}

/** Test hook: forget every recorded install and the lost-history marker. */
export function clearInstalledRegistry(): void {
  try {
    storage()?.removeItem(REGISTRY_KEY)
    storage()?.removeItem(HISTORY_LOST_KEY)
    storage()?.removeItem(PENDING_INSTALL_KEY)
  } catch {
    // A blocked storage is already the state this hook wants.
  }
}

/** True when `value` is an install id this module generated. */
export function isValidInstallId(value: unknown): value is string {
  return typeof value === 'string' && INSTALL_ID_PATTERN.test(value)
}
