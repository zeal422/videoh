/**
 * In-memory OPFS and Web Locks doubles for the 0.23.0 media suite.
 *
 * The store is written against the small `MediaStoreDirectory` /
 * `MediaStoreFileHandle` interfaces, so a fake root exercises every read, write,
 * promote, quarantine, claim, and clean path in plain Node.
 */

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
