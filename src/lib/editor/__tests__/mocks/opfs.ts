/**
 * In-memory OPFS and Web Locks doubles for the 0.23.0 media suite.
 *
 * The store is written against the small `MediaStoreDirectory` /
 * `MediaStoreFileHandle` interfaces, so a fake root exercises every read, write,
 * promote, quarantine, claim, and clean path in plain Node.
 */

import { AsyncLocalStorage, createHook, executionAsyncResource } from 'node:async_hooks'

import type {
  MediaStoreDirectory,
  MediaStoreFileHandle,
  MediaStoreWritable,
} from '../../media/media-store'

interface FakeFile {
  bytes: Uint8Array
  type: string
  /** Test-only size override, so a listing can report an entry without allocating it. */
  size?: number
}

function notFound(): Error {
  return new DOMException('A requested file or directory could not be found', 'NotFoundError')
}

function invalidName(): Error {
  // MDN: an invalid name throws TypeError. TypeMismatchError is for a
  // directory passed to getFileHandle, or a file to getDirectoryHandle.
  return new TypeError('Invalid name')
}

export interface FakeOpfs {
  root: MediaStoreDirectory
  /** Every file by `/<project>/<name>` path. */
  files: Map<string, FakeFile>
  /** Every directory path that exists. */
  directories: Set<string>
  /** Make the next N writable `close()` calls fail like a quota rejection. */
  failWrites: number
  /** Make the next N `removeEntry` calls fail with a non-missing error. */
  failRemoves: number
  /** Make the next N writable `close()` calls store bytes that do not match their hash. */
  corruptWrites: number
  /** When false, file handles have no `move`, exercising the copy fallback. */
  supportsMove: boolean
  quotaBytes: number
  /** Total committed bytes. */
  usage(): number
  /** Writes a file directly, bypassing the store's promotion rules. */
  put(path: string, bytes: Uint8Array | string, type?: string): void
  /** Reads a file's raw bytes, or undefined. */
  get(path: string): FakeFile | undefined
  /** Removes one file by path. */
  remove(path: string): void
}

export function createFakeOpfs(options: { quotaBytes?: number } = {}): FakeOpfs {
  const files = new Map<string, FakeFile>()
  const directories = new Set<string>(['/'])
  const state = {
    failWrites: 0,
    failRemoves: 0,
    corruptWrites: 0,
    supportsMove: true,
    quotaBytes: options.quotaBytes ?? Number.POSITIVE_INFINITY,
  }

  const usage = () => [...files.values()].reduce((total, file) => total + file.bytes.length, 0)

  class FakeWritable implements MediaStoreWritable {
    private chunks: Uint8Array[] = []

    constructor(
      private readonly path: string,
      private readonly type: string,
    ) {}

    async write(data: Blob | BufferSource | string): Promise<void> {
      if (typeof data === 'string') {
        this.chunks.push(new TextEncoder().encode(data))
        return
      }
      if (data instanceof Blob) {
        this.chunks.push(new Uint8Array(await data.arrayBuffer()))
        return
      }
      const view =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      this.chunks.push(view.slice())
    }

    async close(): Promise<void> {
      if (state.failWrites > 0) {
        state.failWrites -= 1
        const error = new Error('The quota has been exceeded')
        error.name = 'QuotaExceededError'
        throw error
      }
      const bytes = new Uint8Array(this.chunks.reduce((total, chunk) => total + chunk.length, 0))
      let offset = 0
      for (const chunk of this.chunks) {
        bytes.set(chunk, offset)
        offset += chunk.length
      }
      if (state.corruptWrites > 0) {
        state.corruptWrites -= 1
        if (bytes.length > 0) bytes[0] = bytes[0] ^ 0xff
      }
      const previous = files.get(this.path)?.bytes.length ?? 0
      if (usage() - previous + bytes.length > state.quotaBytes) {
        const error = new Error('The quota has been exceeded')
        error.name = 'QuotaExceededError'
        throw error
      }
      files.set(this.path, { bytes, type: this.type })
    }

    async abort(): Promise<void> {
      this.chunks = []
    }
  }

  class FakeFileHandle implements MediaStoreFileHandle {
    constructor(
      private readonly directory: FakeDirectory,
      private readonly name: string,
    ) {}

    async getFile(): Promise<File> {
      const record = files.get(this.directory.childPath(this.name))
      if (!record) throw notFound()
      const bytes = new Uint8Array(record.bytes)
      if (record.size !== undefined) {
        // A File-like record whose reported size is independent of its bytes.
        // Reading its content still returns the tiny fixture, so a test can
        // assert that the size check ran before any read.
        return {
          name: this.name,
          type: record.type,
          size: record.size,
          arrayBuffer: async () => bytes.buffer,
          text: async () => new TextDecoder().decode(bytes),
        } as unknown as File
      }
      return new File([bytes], this.name, { type: record.type })
    }

    async createWritable(): Promise<MediaStoreWritable> {
      return new FakeWritable(this.directory.childPath(this.name), 'application/octet-stream')
    }

    move?: (destination: MediaStoreDirectory, name: string) => Promise<void>

    bindMove(): void {
      if (!state.supportsMove) return
      this.move = async (destination, name) => {
        const target = destination as FakeDirectory
        const source = this.directory.childPath(this.name)
        const record = files.get(source)
        if (!record) throw notFound()
        const next = target.childPath(name)
        files.delete(source)
        files.set(next, record)
        this.directory.removeFile(this.name)
        target.addFile(name)
      }
    }
  }

  class FakeDirectory implements MediaStoreDirectory {
    constructor(readonly path: string) {}

    childPath(name: string): string {
      return `${this.path === '/' ? '' : this.path}/${name}`
    }

    addDirectory(name: string): void {
      directories.add(this.childPath(name))
    }

    removeDirectory(name: string): void {
      directories.delete(this.childPath(name))
    }

    addFile(name: string): void {
      files.set(
        this.childPath(name),
        files.get(this.childPath(name)) ?? { bytes: new Uint8Array(), type: '' },
      )
    }

    removeFile(name: string): void {
      files.delete(this.childPath(name))
    }

    async getDirectoryHandle(
      name: string,
      options?: { create?: boolean },
    ): Promise<MediaStoreDirectory> {
      if (name.length === 0 || name.includes('/') || name === '..' || name === '.') {
        throw invalidName()
      }
      const path = this.childPath(name)
      if (!directories.has(path)) {
        if (!options?.create) throw notFound()
        directories.add(path)
      }
      return new FakeDirectory(path)
    }

    async getFileHandle(
      name: string,
      options?: { create?: boolean },
    ): Promise<MediaStoreFileHandle> {
      if (name.length === 0 || name.includes('/') || name === '..' || name === '.') {
        throw invalidName()
      }
      const path = this.childPath(name)
      // Real OPFS getFileHandle() on a directory throws TypeMismatchError, not
      // NotFoundError. Cleanup must size such an entry quietly and still try to
      // remove it, so the double has to model the distinction.
      if (directories.has(path)) {
        throw new DOMException('The requested file is a directory', 'TypeMismatchError')
      }
      if (!files.has(path) && !options?.create) throw notFound()
      if (!files.has(path)) files.set(path, { bytes: new Uint8Array(), type: '' })
      const handle = new FakeFileHandle(this, name)
      handle.bindMove()
      return handle
    }

    async removeEntry(name: string, options?: { recursive?: boolean }): Promise<void> {
      if (state.failRemoves > 0) {
        state.failRemoves -= 1
        throw new DOMException('The entry could not be removed', 'InvalidStateError')
      }
      const path = this.childPath(name)
      if (directories.has(path)) {
        const prefix = `${path}/`
        const hasChildren =
          [...files.keys()].some((key) => key.startsWith(prefix)) ||
          [...directories].some((key) => key.startsWith(prefix))
        if (hasChildren && !options?.recursive) {
          throw new DOMException('Directory is not empty', 'InvalidStateError')
        }
        for (const key of [...files.keys()]) if (key.startsWith(prefix)) files.delete(key)
        for (const key of [...directories]) if (key.startsWith(prefix)) directories.delete(key)
        directories.delete(path)
        return
      }
      if (!files.has(path)) throw notFound()
      files.delete(path)
    }

    async *keys(): AsyncIterableIterator<string> {
      const prefix = this.path === '/' ? '/' : `${this.path}/`
      const names = new Set<string>()
      for (const path of [...directories, ...files.keys()]) {
        if (!path.startsWith(prefix) || path === this.path) continue
        const rest = path.slice(prefix.length)
        if (rest.includes('/')) continue
        if (rest.length > 0) names.add(rest)
      }
      yield* [...names].sort()
    }
  }

  return {
    root: new FakeDirectory('/'),
    files,
    directories,
    get failWrites() {
      return state.failWrites
    },
    set failWrites(value: number) {
      state.failWrites = value
    },
    get failRemoves() {
      return state.failRemoves
    },
    set failRemoves(value: number) {
      state.failRemoves = value
    },
    get corruptWrites() {
      return state.corruptWrites
    },
    set corruptWrites(value: number) {
      state.corruptWrites = value
    },
    get supportsMove() {
      return state.supportsMove
    },
    set supportsMove(value: boolean) {
      state.supportsMove = value
    },
    get quotaBytes() {
      return state.quotaBytes
    },
    set quotaBytes(value: number) {
      state.quotaBytes = value
    },
    usage,
    put(path, bytes, type = 'application/octet-stream') {
      const encoded = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes.slice()
      files.set(path, { bytes: encoded, type })
      const directory = path.slice(0, path.lastIndexOf('/')) || '/'
      directories.add(directory)
    },
    get(path) {
      return files.get(path)
    },
    remove(path) {
      files.delete(path)
    },
  }
}

// IndexedDB double

interface FakeIdbRequest<T> {
  result: T
  error: unknown
  onsuccess: (() => void) | null
  onerror: (() => void) | null
  onupgradeneeded: (() => void) | null
}

export interface FakeIndexedDb {
  /** The value to stub as the global `indexedDB`. */
  factory: {
    open(name: string, version?: number): FakeIdbRequest<FakeIdbDatabase>
  }
  /** Every object store and its key/value records. */
  databases: Map<string, Map<string, Map<string, unknown>>>
  /** Make the next open request fail. */
  failOpen: boolean
  /** Make `db.transaction` throw, as a closed or broken database does. */
  failTransaction: boolean
  /** Make the section read request fail before the section runs. */
  failRead: boolean
  /** Make the section `put` commit fail after the section ran. */
  failCommit: boolean
  /** Fire a second transaction event after the first, to exercise the settle guard. */
  duplicateEvent: boolean
  /** Transactions aborted through `abort()`, so a test can see the call. */
  aborts: number
  /** Transaction event deliveries, including the duplicate-event knob. */
  events: number
}

export interface FakeIdbDatabase {
  objectStoreNames: { contains(name: string): boolean }
  createObjectStore(name: string): void
  transaction(name: string, mode: string): FakeIdbTransaction
  close(): void
  readonly closed: boolean
}

interface FakeIdbTransaction {
  objectStore(name: string): {
    get(key: string): FakeIdbRequest<unknown>
    put(value: unknown, key: string): FakeIdbRequest<void>
  }
  abort(): void
  oncomplete: (() => void) | null
  onerror: (() => void) | null
  onabort: (() => void) | null
}

interface PendingIdbRequest {
  error: unknown
  onerror: (() => void) | null
}

interface ActivityToken {
  kind: 'create' | 'callback'
  closed: boolean
  owner?: ActivityToken
}

/**
 * The creation task's active window. Microtasks queued before the transaction
 * inherit the parent context, so they cannot carry its token; this window lets
 * them in through the full checkpoint. A timer callback from another task
 * closes it before the request can run.
 */
interface ActivityWindow {
  open: boolean
  token: ActivityToken
  task: object | undefined
}

/** Node exposes `hasRef` on its timer resources, including fake-timer callbacks. */
function isTimerResource(resource: object | undefined): boolean {
  return typeof (resource as { hasRef?: unknown } | undefined)?.hasRef === 'function'
}

const taskWindows = new Set<ActivityWindow>()
const openCallbacks = new Set<ActivityToken>()
let taskHook: ReturnType<typeof createHook> | null = null

function closeTaskActivity(): void {
  for (const window of taskWindows) {
    window.open = false
    taskWindows.delete(window)
  }
  for (const token of openCallbacks) token.closed = true
  openCallbacks.clear()
  releaseTaskHookIfIdle()
}

function ensureTaskHook(): void {
  if (taskHook) return
  taskHook = createHook({
    before() {
      if (!isTimerResource(executionAsyncResource())) return
      closeTaskActivity()
    },
  })
  taskHook.enable()
}

function releaseTaskHookIfIdle(): void {
  if (taskHook === null || taskWindows.size > 0 || openCallbacks.size > 0) return
  taskHook.disable()
  taskHook = null
}

/**
 * A small IndexedDB double for the autosave coordination fallback.
 *
 * It models only what `withIdbSection` uses: open with an upgrade callback, a
 * readwrite transaction, one get, one put, and the complete/error/abort events.
 * Request events are delivered as microtasks for deterministic tests; the fake
 * does not model native IndexedDB task boundaries where other browser events
 * can run between a request and its callback. A test that needs task ordering
 * must not read a microtask checkpoint as native delivery. Each failure knob is
 * a one-shot switch a test sets before exercising the path.
 *
 * `open` fires `onupgradeneeded` only when the requested version is higher
 * than the open version, as native IndexedDB does. A pre-populated
 * `databases` entry is treated as version 1.
 */
export function createFakeIndexedDb(): FakeIndexedDb {
  const state: FakeIndexedDb = {
    factory: { open },
    databases: new Map(),
    failOpen: false,
    failTransaction: false,
    failRead: false,
    failCommit: false,
    duplicateEvent: false,
    aborts: 0,
    events: 0,
  }

  // One queue per backing database, shared by every connection. The real
  // engine serializes transactions on the same store across connections too.
  const queues = new Map<string, Map<string, Promise<void>>>()
  const versions = new Map<string, number>()
  // The creation task's async context. An earlier timer keeps the context it
  // was scheduled under, so it cannot slip a request in before the checkpoint
  // timer closes, while nested microtasks inherit the creating context.
  const activity = new AsyncLocalStorage<{ tokens: Set<ActivityToken> }>()

  function open(name: string, version?: number): FakeIdbRequest<FakeIdbDatabase> {
    const request: FakeIdbRequest<FakeIdbDatabase> = {
      result: undefined as unknown as FakeIdbDatabase,
      error: null,
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null,
    }
    const existed = state.databases.has(name)
    let tails = queues.get(name)
    if (!tails) {
      tails = new Map()
      queues.set(name, tails)
    }
    const dbTails = tails
    queueMicrotask(() => {
      if (state.failOpen) {
        state.failOpen = false
        request.error = new Error('The connection could not be opened')
        request.onerror?.()
        return
      }
      const existing = state.databases.get(name)
      const currentVersion = versions.get(name) ?? (existed ? 1 : 0)
      const requestedVersion = version ?? Math.max(1, currentVersion)
      if (requestedVersion < currentVersion) {
        request.error = new DOMException(
          'The requested version is lower than the existing version',
          'VersionError',
        )
        request.onerror?.()
        return
      }
      const upgrade = requestedVersion > currentVersion
      const stores = upgrade ? new Map(existing ?? []) : (existing ?? new Map())
      // The upgrade callback and the success result share one connection. Its
      // schema permission is revoked when the callback exits, including on a
      // throw, so a saved connection cannot mutate the committed store map.
      const schema = { canCreateStore: upgrade, upgrading: upgrade }
      request.result = createDatabase(stores, dbTails, schema)
      if (upgrade) {
        try {
          request.onupgradeneeded?.()
        } catch (error) {
          schema.canCreateStore = false
          schema.upgrading = false
          // The open failed, so its provisional connection is no longer usable.
          // Close it before reporting, so it cannot reach the rolled-back
          // store map after the request errors.
          request.result.close()
          request.error = error
          request.onerror?.()
          return
        } finally {
          schema.canCreateStore = false
          schema.upgrading = false
        }
        state.databases.set(name, stores)
        versions.set(name, requestedVersion)
      }
      request.onsuccess?.()
    })
    return request
  }

  function createDatabase(
    stores: Map<string, Map<string, unknown>>,
    tails: Map<string, Promise<void>>,
    schema: { canCreateStore: boolean; upgrading: boolean },
  ): FakeIdbDatabase {
    let closed = false
    return {
      objectStoreNames: { contains: (storeName) => stores.has(storeName) },
      createObjectStore(storeName) {
        if (!schema.canCreateStore) {
          throw new Error('Object store creation is only allowed during an upgrade')
        }
        if (stores.has(storeName)) throw new Error(`Object store already exists: ${storeName}`)
        stores.set(storeName, new Map())
      },
      transaction(storeName, mode) {
        if (closed) throw new Error('The database is closed')
        if (schema.upgrading) {
          throw new DOMException(
            'The database is running an upgrade transaction',
            'InvalidStateError',
          )
        }
        if (state.failTransaction) {
          state.failTransaction = false
          throw new Error('The database is not open')
        }
        const records = stores.get(storeName)
        if (!records) throw new Error(`No object store named ${storeName}`)
        const previous = tails.get(storeName) ?? Promise.resolve()
        let releaseTail!: () => void
        const tail = new Promise<void>((resolve) => (releaseTail = resolve))
        tails.set(storeName, tail)
        const releaseOnce = () => {
          if (tails.get(storeName) === tail) tails.delete(storeName)
          releaseTail()
        }
        return createTransaction(storeName, records, previous, releaseOnce, mode === 'readonly')
      },
      close() {
        closed = true
      },
      get closed() {
        return closed
      },
    }
  }

  function createTransaction(
    storeName: string,
    records: Map<string, unknown>,
    previous: Promise<void>,
    release: () => void,
    readOnly: boolean,
  ): FakeIdbTransaction {
    let aborted = false
    let finished = false
    let checkpointOpen = true
    let released = false
    let pendingRequests = 0
    const staged = new Map<string, unknown>()
    const pending = new Set<PendingIdbRequest>()
    const creationToken: ActivityToken = { kind: 'create', closed: false }
    // A later transaction in the same task inherits the earlier tokens, so
    // both stay usable. A timer scheduled before a transaction keeps the
    // older context and cannot borrow the new token.
    const parent = activity.getStore()
    const contextTokens = new Set(parent ? parent.tokens : [])
    contextTokens.add(creationToken)
    activity.enterWith({ tokens: contextTokens })
    // Microtasks queued before the transaction do not inherit its token. The
    // window admits them through the creation task's checkpoint. A timer from
    // another task closes it in ensureActive, so an earlier timer stays rejected
    // while nested microtasks still run.
    const creationWindow: ActivityWindow = {
      open: true,
      token: creationToken,
      task: executionAsyncResource(),
    }
    taskWindows.add(creationWindow)
    ensureTaskHook()
    const ensureActive = () => {
      if (finished || aborted) throw new Error('The transaction is finished')
      const context = activity.getStore()
      if (!checkpointOpen) {
        const callbackActive = context
          ? [...context.tokens].some(
              (token) =>
                token.kind === 'callback' && token.owner === creationToken && !token.closed,
            )
          : false
        if (!callbackActive) {
          throw new DOMException('The transaction is inactive', 'TransactionInactiveError')
        }
        return
      }
      const resource = executionAsyncResource()
      if (creationWindow.open && isTimerResource(resource) && resource !== creationWindow.task) {
        creationWindow.open = false
        taskWindows.delete(creationWindow)
        releaseTaskHookIfIdle()
      }
      const inCreationTask =
        (context?.tokens.has(creationToken) ?? false) ||
        [...taskWindows].some((window) => window.open && window.token === creationToken)
      if (creationToken.closed || !inCreationTask) {
        throw new DOMException('The transaction is inactive', 'TransactionInactiveError')
      }
    }
    // A request callback stays active through its microtask checkpoint. The
    // token closes on the next timer turn, after nested microtasks and awaited
    // continuations have run, but before a later timer can issue a request.
    const beginCallback = () => {
      const token: ActivityToken = { kind: 'callback', closed: false, owner: creationToken }
      const current = activity.getStore()
      const tokens = new Set(current ? current.tokens : [])
      tokens.add(token)
      activity.enterWith({ tokens })
      openCallbacks.add(token)
      ensureTaskHook()
    }
    // Every transaction event goes through one delivery point so the event
    // count and the one-shot duplicate knob apply to completion, read errors,
    // and explicit aborts alike.
    function deliver(handler: (() => void) | null): void {
      state.events += 1
      try {
        handler?.()
      } catch {
        // The transaction handler failed while the event was delivered.
      }
      if (state.duplicateEvent) {
        state.duplicateEvent = false
        state.events += 1
        queueMicrotask(() => {
          try {
            handler?.()
          } catch {
            // The duplicate delivery failed while the event was delivered.
          }
        })
      }
    }
    // Active for the creation task and its microtask checkpoint only. A later
    // timer is a different task and must be rejected.
    setTimeout(() => {
      checkpointOpen = false
      creationToken.closed = true
      creationWindow.open = false
      taskWindows.delete(creationWindow)
      releaseTaskHookIfIdle()
    }, 0)
    function rejectPending(): void {
      for (const request of pending) {
        request.error = new DOMException('The transaction was aborted', 'AbortError')
        try {
          request.onerror?.()
        } catch {
          // The request handler failed while the transaction was aborting.
        }
      }
      pending.clear()
    }
    // Hold this transaction's barrier in the queue until its predecessor
    // settles, even when this transaction aborts early: a successor queued
    // behind it must still wait for the predecessor.
    const finishRelease = () => {
      if (released) return
      released = true
      void previous.then(release)
    }
    // Wait for the predecessor, then one timer turn before committing. The
    // wait keeps an empty transaction behind its queue neighbour; the timer
    // gives the creation task's microtask checkpoint a chance to enqueue its
    // requests, as native IndexedDB allows.
    const scheduleComplete = () => {
      void previous.then(() => {
        setTimeout(() => {
          if (finished || aborted || pendingRequests > 0) return
          // Only a transaction with a staged write can fail at commit. An
          // empty predecessor completes without consuming the one-shot flag,
          // so the section's put still receives the intended failure.
          if (state.failCommit && staged.size > 0) {
            state.failCommit = false
            finish('abort')
            return
          }
          finish('complete')
        }, 0)
      })
    }
    const transaction: FakeIdbTransaction = {
      objectStore(name: string) {
        // An unfinished transaction still returns a handle after its active
        // window closes; only a finished one is refused. The handle's get and
        // put enforce the activity window.
        if (finished || aborted) throw new Error('The transaction is finished')
        if (name !== storeName) throw new Error(`No object store named ${name}`)
        return {
          get(key: string): FakeIdbRequest<unknown> {
            ensureActive()
            const request: FakeIdbRequest<unknown> = {
              result: undefined,
              error: null,
              onsuccess: null,
              onerror: null,
              onupgradeneeded: null,
            }
            pending.add(request)
            pendingRequests += 1
            void previous.then(() => {
              // Deliberate fake behavior: request callbacks run in a
              // microtask after the queue predecessor, not in a native
              // IndexedDB task. Tests must not expect intervening browser
              // events between the request and its callback.
              queueMicrotask(() => {
                pendingRequests -= 1
                if (aborted || finished) return
                pending.delete(request)
                if (state.failRead) {
                  state.failRead = false
                  request.error = new Error('The read failed')
                  try {
                    beginCallback()
                    request.onerror?.()
                  } catch {
                    abortFromHandler()
                    return
                  }
                  finishRequestError()
                  return
                }
                try {
                  request.result = structuredClone(
                    staged.has(key) ? staged.get(key) : records.get(key),
                  )
                  beginCallback()
                  request.onsuccess?.()
                } catch {
                  abortFromHandler()
                  return
                }
                // A get-only transaction commits after its handler and any
                // continuation run; a request they enqueue keeps it open.
                scheduleComplete()
              })
            })
            return request
          },
          put(value: unknown, key: string): FakeIdbRequest<void> {
            if (readOnly) {
              throw new DOMException('The transaction is read-only', 'ReadOnlyError')
            }
            ensureActive()
            const snapshot = structuredClone(value)
            const request: FakeIdbRequest<void> = {
              result: undefined,
              error: null,
              onsuccess: null,
              onerror: null,
              onupgradeneeded: null,
            }
            pending.add(request)
            pendingRequests += 1
            void previous.then(() => {
              // Deliberate fake behavior: request callbacks run in a
              // microtask after the queue predecessor, not in a native
              // IndexedDB task. Tests must not expect intervening browser
              // events between the request and its callback.
              queueMicrotask(() => {
                pendingRequests -= 1
                if (aborted || finished) return
                pending.delete(request)
                staged.set(key, snapshot)
                try {
                  beginCallback()
                  request.onsuccess?.()
                } catch {
                  abortFromHandler()
                  return
                }
                scheduleComplete()
              })
            })
            return request
          },
        }
      },
      abort() {
        if (finished) throw new Error('The transaction is finished')
        if (aborted) return
        aborted = true
        finished = true
        state.aborts += 1
        staged.clear()
        finishRelease()
        queueMicrotask(() => {
          const hadPending = pending.size > 0
          // Abort makes the transaction inactive at once, but request errors
          // are delivered only after abort() returns, before the transaction
          // error and abort events. An abort with no pending request emits no
          // request or transaction error.
          rejectPending()
          if (hadPending) deliver(transaction.onerror)
          deliver(transaction.onabort)
        })
      },
      oncomplete: null,
      onerror: null,
      onabort: null,
    }

    function abortFromHandler(): void {
      try {
        transaction.abort()
      } catch {
        // The handler already aborted or the transaction finished.
      }
    }

    function finishRequestError(): void {
      if (finished || aborted) return
      aborted = true
      finished = true
      finishRelease()
      queueMicrotask(() => {
        deliver(transaction.onerror)
        rejectPending()
        staged.clear()
        queueMicrotask(() => deliver(transaction.onabort))
      })
    }

    function finish(kind: 'complete' | 'error' | 'abort'): void {
      if (finished || aborted) return
      finished = true
      if (kind === 'complete') {
        for (const [key, value] of staged) records.set(key, value)
        staged.clear()
      } else {
        staged.clear()
      }
      const handler =
        kind === 'complete'
          ? transaction.oncomplete
          : kind === 'error'
            ? transaction.onerror
            : transaction.onabort
      finishRelease()
      queueMicrotask(() => deliver(handler))
    }

    // The mock commits a transaction with no requests on its next timer turn,
    // not a native microtask, and releases the queue entry it holds.
    scheduleComplete()

    return transaction
  }

  return state
}

// Web Locks double

interface LockHolder {
  mode: 'shared' | 'exclusive'
  token: object
}

interface PendingRequest {
  name: string
  mode: 'shared' | 'exclusive'
  ifAvailable: boolean
  callback: (lock: object | null) => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

/**
 * A small Web Locks double: shared requests are compatible with each other,
 * exclusive requests need the lock free, and `ifAvailable` resolves the
 * callback with null instead of queueing. `held` reports live holders so tests
 * can assert that a clean restored the shared hold.
 */
export class FakeLockManager {
  private holders = new Map<string, LockHolder[]>()
  private pending: PendingRequest[] = []

  held(name: string): number {
    return (this.holders.get(name) ?? []).length
  }

  /** Names with at least one current holder, for presence-lock assertions. */
  heldNames(): string[] {
    return [...this.holders.entries()].filter(([, list]) => list.length > 0).map(([name]) => name)
  }

  request<T>(
    name: string,
    options: { mode?: 'shared' | 'exclusive'; ifAvailable?: boolean },
    callback: (lock: object | null) => Promise<T>,
  ): Promise<T> {
    const mode = options.mode ?? 'exclusive'
    const ifAvailable = options.ifAvailable ?? false
    return new Promise<T>((resolve, reject) => {
      const entry: PendingRequest = {
        name,
        mode,
        ifAvailable,
        callback: callback as (lock: object | null) => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      }
      // FIFO per name like the real manager: a request queued behind an
      // earlier pending request for the same name must not jump ahead of it,
      // and a blocked later request with `ifAvailable` sees null.
      const queuedAhead = this.pending.some((queued) => queued.name === name)
      if (!queuedAhead && this.canGrant(entry)) {
        void this.grant(entry)
      } else if (ifAvailable) {
        void Promise.resolve(callback(null)).then(resolve, reject)
      } else {
        this.pending.push(entry)
      }
    })
  }

  private canGrant(entry: PendingRequest): boolean {
    const list = this.holders.get(entry.name) ?? []
    return entry.mode === 'shared'
      ? list.every((holder) => holder.mode === 'shared')
      : list.length === 0
  }

  private async grant(entry: PendingRequest): Promise<void> {
    const token = {}
    const list = this.holders.get(entry.name) ?? []
    list.push({ mode: entry.mode, token })
    this.holders.set(entry.name, list)
    try {
      entry.resolve(await entry.callback(token))
    } catch (error) {
      entry.reject(error)
    } finally {
      this.holders.set(
        entry.name,
        (this.holders.get(entry.name) ?? []).filter((holder) => holder.token !== token),
      )
      this.drain()
    }
  }

  private drain(): void {
    // Only the head request per name is eligible, in queue order: granting a
    // later request while an earlier one for the same name stays blocked
    // would reorder the queue. Unrelated names still proceed independently.
    for (const entry of [...this.pending]) {
      const head = this.pending.find((queued) => queued.name === entry.name)
      if (head !== entry) continue
      if (!this.canGrant(entry)) continue
      this.pending = this.pending.filter((candidate) => candidate !== entry)
      void this.grant(entry)
    }
  }
}
