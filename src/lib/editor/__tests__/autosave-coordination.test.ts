import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AUTOSAVE_CHANNEL_NAME,
  AUTOSAVE_LOCK_NAME,
  claimAutosaveOwnership,
  clearAutosave,
  hasPendingInstall,
  initAutosave,
  initAutosaveCoordination,
  isAutosavePaused,
  markInstallPending,
  pauseOtherAutosaveTabs,
  queueAutosaveRetry,
  queuePendingInstallRetry,
  readAutosave,
  readValidAutosave,
  recordInstallUnderLock,
  releaseAutosaveOwnership,
  requireAutosaveImportFence,
  resetAutosaveCoordinationForTests,
  resumeAutosaveTabs,
  setAutosaveCancel,
  writeAutosaveCooperatively,
} from '../persistence'
import { readInstalledRegistry, readPendingInstallRecords } from '../media/installed-registry'
import { useEditorStore } from '../store'
import { createDoc } from '../factories'
import { parseSerializedDoc, serializeDoc } from '../serialization'
import { FakeLockManager, createFakeIndexedDb, type FakeIdbDatabase } from './mocks/opfs'

const OWNER_KEY = 'web-video-editor:autosave-owner:v1'
const AUTOSAVE_KEY = 'web-video-editor:autosave:v1'
const IMPORT_KEY = 'web-video-editor:autosave-import:v1'
const storage = new Map<string, string>()

const localStorageMock = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
  clear: () => void storage.clear(),
}

class FakeChannel {
  static all = new Set<FakeChannel>()
  private listeners = new Set<(event: MessageEvent) => void>()
  received: unknown[] = []
  constructor(readonly name: string) {
    FakeChannel.all.add(this)
  }
  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    if (type === 'message') this.listeners.add(listener)
  }
  removeEventListener(type: string, listener: (event: MessageEvent) => void): void {
    if (type === 'message') this.listeners.delete(listener)
  }
  postMessage(data: unknown): void {
    for (const channel of FakeChannel.all) {
      if (channel === this) continue
      channel.received.push(data)
      for (const listener of channel.listeners) listener({ data } as MessageEvent)
    }
  }
  close(): void {
    FakeChannel.all.delete(this)
    this.listeners.clear()
  }
}

function writeRecord(record: {
  tabId: string
  sessionId?: string
  tokenHash?: string
  epoch?: number
  heartbeatAt?: number
}): void {
  storage.set(
    OWNER_KEY,
    JSON.stringify({
      sessionId: 'other-session',
      tokenHash: 'deadbeef',
      epoch: 1,
      heartbeatAt: Date.now(),
      ...record,
    }),
  )
}

function readRecord(): { tabId: string; epoch: number } {
  return JSON.parse(storage.get(OWNER_KEY)!) as { tabId: string; epoch: number }
}

beforeEach(() => {
  storage.clear()
  FakeChannel.all.clear()
  vi.stubGlobal('localStorage', localStorageMock)
  vi.stubGlobal('BroadcastChannel', FakeChannel)
  const locks = Object.assign(new FakeLockManager(), {
    query: async () => ({ held: [], pending: [] }),
  })
  vi.stubGlobal('navigator', { locks })
  resetAutosaveCoordinationForTests()
})

afterEach(() => {
  // A failed or early-returning test may leave fake timers installed. Restore
  // them unconditionally so the next test and its teardown run in real time.
  vi.useRealTimers()
  resetAutosaveCoordinationForTests()
  vi.unstubAllGlobals()
})

describe('autosave ownership (0.28.0)', () => {
  it('refuses to write the slot while another tab owns it', async () => {
    writeRecord({ tabId: 'other-tab' })
    expect(await writeAutosaveCooperatively('{"theirs":true}')).toBe('read-only')
    expect(readAutosave()).toBeNull()
    expect(isAutosavePaused()).toBe(true)
    expect(storage.has(AUTOSAVE_KEY)).toBe(false)
  })

  it('refuses to claim a fresh owner from another tab', async () => {
    writeRecord({ tabId: 'other-tab' })
    expect(await claimAutosaveOwnership()).toEqual({
      ok: false,
      reason: 'Another tab is saving this project. Close or reload it, then try again.',
    })
  })

  it('takes over a stale owner with a new epoch and then writes', async () => {
    writeRecord({ tabId: 'other-tab', heartbeatAt: Date.now() - 60_000, epoch: 4 })
    expect(await claimAutosaveOwnership()).toMatchObject({ ok: true })
    const record = readRecord()
    expect(record.tabId).not.toBe('other-tab')
    expect(record.epoch).toBeGreaterThan(4)
    expect(await writeAutosaveCooperatively('{"ours":true}')).toBe('saved')
    expect(readAutosave()).toBe('{"ours":true}')
  })

  it('releases only the epoch its import claimed', async () => {
    const first = await claimAutosaveOwnership()
    const second = await claimAutosaveOwnership()
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.epoch).toBe(first.epoch + 1)
    releaseAutosaveOwnership(first.epoch)
    expect(readRecord().epoch).toBe(second.epoch)
    releaseAutosaveOwnership(second.epoch)
    expect(storage.has(OWNER_KEY)).toBe(false)
  })

  it('a stale import cannot release a replacement claim after reset', async () => {
    const first = await claimAutosaveOwnership()
    expect(first.ok).toBe(true)
    if (!first.ok) return
    resetAutosaveCoordinationForTests()
    const second = await claimAutosaveOwnership()
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.epoch).toBeGreaterThan(first.epoch)
    releaseAutosaveOwnership(first.epoch)
    expect(storage.has(OWNER_KEY)).toBe(true)
    expect(readRecord().epoch).toBe(second.epoch)
    releaseAutosaveOwnership(second.epoch)
    expect(storage.has(OWNER_KEY)).toBe(false)
  })

  it('fails ownership closed when IndexedDB cannot open', async () => {
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('indexedDB', {
      open: () => {
        const request: { onerror?: () => void } = {}
        queueMicrotask(() => request.onerror?.())
        return request
      },
    })
    expect(await claimAutosaveOwnership()).toMatchObject({
      ok: false,
      reason: expect.stringContaining('could not coordinate'),
    })
    expect(await recordInstallUnderLock('proj_a', 'install-test-1')).toBe(false)
  })

  it('refuses ownership and install records when no serialization primitive exists', async () => {
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('indexedDB', undefined)
    expect(await claimAutosaveOwnership()).toMatchObject({
      ok: false,
      reason: expect.stringContaining('cannot coordinate autosave'),
    })
    expect(await recordInstallUnderLock('proj_a', 'install-test-1')).toBe(false)
  })

  it('refuses a former owner against a stale newer epoch', async () => {
    const claim = await claimAutosaveOwnership()
    expect(claim.ok).toBe(true)
    if (!claim.ok) return
    writeRecord({
      tabId: 'other-tab',
      heartbeatAt: Date.now() - 60_000,
      epoch: claim.epoch + 1,
    })
    expect(await writeAutosaveCooperatively('{"late":true}')).toBe('read-only')
    expect(readAutosave()).toBeNull()
  })

  it('does not let an older retry overwrite a newer committed document', async () => {
    vi.useFakeTimers()
    try {
      queueAutosaveRetry('{"old":true}')
      expect(await writeAutosaveCooperatively('{"new":true}')).toBe('saved')
      await vi.advanceTimersByTimeAsync(3_100)
      expect(readAutosave()).toBe('{"new":true}')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a newer retry alive when an older retry write resolves', async () => {
    vi.useFakeTimers()
    const locks = (navigator as unknown as { locks: FakeLockManager }).locks
    const original = locks.request.bind(locks)
    let releaseWrite: (() => void) | null = null
    let gate = false
    locks.request = ((
      name: string,
      options: never,
      callback: (lock: object | null) => Promise<unknown>,
    ) => {
      if (name !== AUTOSAVE_LOCK_NAME || !gate) return original(name, options, callback)
      gate = false
      return new Promise<unknown>((resolve, reject) => {
        releaseWrite = () => {
          void original(name, options, callback).then(resolve, reject)
        }
      })
    }) as typeof locks.request
    try {
      queueAutosaveRetry('{"first":true}')
      gate = true
      await vi.advanceTimersByTimeAsync(3_000)
      expect(releaseWrite).not.toBeNull()

      // A newer edit queues its own retry while the first write is in flight.
      queueAutosaveRetry('{"second":true}')
      // The first write fails (quota); its completion must not requeue over
      // the newer retry and erase it.
      vi.stubGlobal('localStorage', {
        ...localStorageMock,
        setItem: () => {
          throw new Error('quota')
        },
      })
      releaseWrite!()
      await vi.advanceTimersByTimeAsync(0)
      vi.stubGlobal('localStorage', localStorageMock)

      await vi.advanceTimersByTimeAsync(3_000)
      expect(readAutosave()).toBe('{"second":true}')
    } finally {
      vi.useRealTimers()
    }
  })

  it('retains the original sequence when a failed retry requeues', async () => {
    vi.useFakeTimers()
    const unsubscribe = initAutosave()
    try {
      expect(await writeAutosaveCooperatively('{"base":true}')).toBe('saved')
      queueAutosaveRetry('{"old":true}')
      // Storage refuses the slot while a newer edit is already scheduled: the
      // scheduled write carries an older sequence than any requeue, because
      // its sequence was allocated at schedule time.
      vi.stubGlobal('localStorage', {
        ...localStorageMock,
        setItem: () => {
          throw new Error('quota')
        },
      })
      await vi.advanceTimersByTimeAsync(2_500)
      const live = useEditorStore.getState().doc
      useEditorStore.setState({
        doc: { ...live, project: { ...live.project, name: 'Edited' } },
      })
      await vi.advanceTimersByTimeAsync(500)
      // The retry failed with an error and requeued. Storage recovers, so the
      // scheduled newer write commits. A requeue with a freshly allocated
      // sequence would survive that commit and overwrite it with the old
      // document; retaining the original sequence lets the commit supersede it.
      vi.stubGlobal('localStorage', localStorageMock)
      await vi.advanceTimersByTimeAsync(300)
      await vi.advanceTimersByTimeAsync(2_700)
      // A requeued retry with a freshly allocated sequence would be newer
      // than the committed write and overwrite it with the old document.
      // `savedAt` advances with the fake clock, so compare the payload.
      expect(readAutosave()).not.toBe('{"old":true}')
      expect(parseSerializedDoc(readAutosave()!).doc.project.name).toBe('Edited')
    } finally {
      unsubscribe()
      vi.useRealTimers()
    }
  })

  it('becomes read-only when another tab acquires ownership without a channel', async () => {
    vi.stubGlobal('BroadcastChannel', undefined)
    const listeners = new Map<string, (event: StorageEvent) => void>()
    vi.stubGlobal('window', {
      addEventListener: (type: string, listener: (event: StorageEvent) => void) => {
        listeners.set(type, listener)
      },
      removeEventListener: (type: string) => listeners.delete(type),
    })
    const cleanup = initAutosaveCoordination()
    try {
      expect(isAutosavePaused()).toBe(false)
      // Another tab claims the slot; the storage event reaches this idle tab.
      const record = {
        tabId: 'other-tab',
        sessionId: 'other-session',
        tokenHash: 'deadbeef',
        epoch: 1,
        heartbeatAt: Date.now(),
      }
      storage.set(OWNER_KEY, JSON.stringify(record))
      listeners.get('storage')?.({
        key: OWNER_KEY,
        newValue: JSON.stringify(record),
      } as StorageEvent)
      expect(isAutosavePaused()).toBe(true)
      expect(await writeAutosaveCooperatively('{"mine":true}')).toBe('read-only')
    } finally {
      cleanup()
    }
  })

  it('stays read-only when an import event arrives after the owner lease expires', async () => {
    vi.stubGlobal('BroadcastChannel', undefined)
    const listeners = new Map<string, (event: StorageEvent) => void>()
    vi.stubGlobal('window', {
      addEventListener: (type: string, listener: (event: StorageEvent) => void) => {
        listeners.set(type, listener)
      },
      removeEventListener: (type: string) => listeners.delete(type),
    })
    storage.set(AUTOSAVE_KEY, '{"old":true}')
    // Seeds the slot this tab observed; the text itself is not a project.
    readValidAutosave()
    const cleanup = initAutosaveCoordination()
    try {
      const record = JSON.stringify({
        tabId: 'other-tab',
        sessionId: 'other-session',
        tokenHash: 'deadbeef',
        epoch: 1,
        heartbeatAt: Date.now() - 60_000,
      })
      storage.set(OWNER_KEY, record)
      storage.set(AUTOSAVE_KEY, '{"imported":true}')
      storage.set(IMPORT_KEY, 'import-token')
      // Both events were queued while this tab was suspended, so they arrive
      // only after the owner lease has expired.
      listeners.get('storage')?.({ key: OWNER_KEY, newValue: record } as StorageEvent)
      listeners.get('storage')?.({ key: OWNER_KEY, newValue: null } as StorageEvent)
      await vi.waitFor(() => expect(isAutosavePaused()).toBe(true))
      expect(await writeAutosaveCooperatively('{"old":true}')).toBe('read-only')
      expect(readAutosave()).toBe('{"imported":true}')
    } finally {
      cleanup()
    }
  })

  it('refuses a write when an import changed the fence this tab never saw', async () => {
    storage.set(AUTOSAVE_KEY, '{"old":true}')
    readValidAutosave()
    const cleanup = initAutosaveCoordination()
    try {
      storage.set(AUTOSAVE_KEY, '{"imported":true}')
      storage.set(IMPORT_KEY, 'import-token')
      expect(await writeAutosaveCooperatively('{"old":true}')).toBe('read-only')
      expect(readAutosave()).toBe('{"imported":true}')
    } finally {
      cleanup()
    }
  })

  it('lets a tab that mounted after an import write the slot', async () => {
    storage.set(AUTOSAVE_KEY, '{"imported":true}')
    storage.set(IMPORT_KEY, 'import-token')
    readValidAutosave()
    const cleanup = initAutosaveCoordination()
    try {
      expect(await writeAutosaveCooperatively('{"next":true}')).toBe('saved')
      expect(readAutosave()).toBe('{"next":true}')
    } finally {
      cleanup()
    }
  })

  it('writes an import marker on a project-scoped slot write', async () => {
    const live = createDoc()
    useEditorStore.setState({
      doc: { ...live, project: { ...live.project, id: 'proj_fence' } },
      autosaveStatus: 'idle',
    })
    readValidAutosave()
    const cleanup = initAutosaveCoordination()
    try {
      expect(storage.has(IMPORT_KEY)).toBe(false)
      expect(await writeAutosaveCooperatively('{"imported":true}', undefined, 'proj_fence')).toBe(
        'saved',
      )
      expect(storage.get(IMPORT_KEY)).toBeTruthy()
      // The importing tab accepted its own marker and keeps writing normally.
      expect(await writeAutosaveCooperatively('{"next":true}', undefined, 'proj_fence')).toBe(
        'saved',
      )
      expect(readAutosave()).toBe('{"next":true}')
    } finally {
      cleanup()
    }
  })

  it('reports an error and leaves the slot when the import marker cannot be written', async () => {
    const live = createDoc()
    useEditorStore.setState({
      doc: { ...live, project: { ...live.project, id: 'proj_fence' } },
      autosaveStatus: 'idle',
    })
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (key === IMPORT_KEY) throw new Error('quota')
        storage.set(key, value)
      },
      removeItem: (key: string) => void storage.delete(key),
      clear: () => void storage.clear(),
    })
    storage.set(AUTOSAVE_KEY, '{"old":true}')
    readValidAutosave()
    const cleanup = initAutosaveCoordination()
    try {
      expect(await writeAutosaveCooperatively('{"imported":true}', undefined, 'proj_fence')).toBe(
        'error',
      )
      // No imported slot may land without the marker that protects it.
      expect(readAutosave()).toBe('{"old":true}')
      expect(storage.has(IMPORT_KEY)).toBe(false)
    } finally {
      cleanup()
    }
  })

  it('retries an ordinary slot write after the import marker write fails', async () => {
    vi.useFakeTimers()
    const live = createDoc()
    useEditorStore.setState({
      doc: { ...live, project: { ...live.project, id: 'proj_fence_retry' } },
    })
    await markInstallPending('proj_fence_retry', 'install-fence-retry')
    let failFence = true
    vi.stubGlobal('localStorage', {
      ...localStorageMock,
      setItem: (key: string, value: string) => {
        if (failFence && key === IMPORT_KEY) throw new Error('quota')
        storage.set(key, value)
      },
    })
    const cleanup = initAutosaveCoordination()
    try {
      const json = JSON.stringify(serializeDoc(useEditorStore.getState().doc))
      expect(await writeAutosaveCooperatively(json)).toBe('error')
      // The pending install is durable, while its marker and slot are owed.
      expect(readInstalledRegistry()?.['proj_fence_retry']).toContain('install-fence-retry')
      expect(hasPendingInstall()).toBe(false)
      expect(readAutosave()).toBeNull()
      failFence = false
      await vi.advanceTimersByTimeAsync(3_100)
      expect(storage.get(IMPORT_KEY)).toBeTruthy()
      expect(parseSerializedDoc(readAutosave()!).doc.project.id).toBe('proj_fence_retry')
      expect(useEditorStore.getState().autosaveStatus).toBe('saved')
    } finally {
      cleanup()
      vi.useRealTimers()
    }
  })

  it('preserves a non-live pending install retry when a live fence write fails', async () => {
    vi.useFakeTimers()
    const live = createDoc()
    useEditorStore.setState({
      doc: { ...live, project: { ...live.project, id: 'proj_a', name: 'A' } },
    })
    await markInstallPending('proj_b', 'install-b')
    queuePendingInstallRetry('proj_b')
    requireAutosaveImportFence('proj_a')
    let failFence = true
    vi.stubGlobal('localStorage', {
      ...localStorageMock,
      setItem: (key: string, value: string) => {
        if (failFence && key === IMPORT_KEY) throw new Error('quota')
        storage.set(key, value)
      },
    })
    const cleanup = initAutosaveCoordination()
    try {
      const json = JSON.stringify(serializeDoc(useEditorStore.getState().doc))
      expect(await writeAutosaveCooperatively(json)).toBe('error')
      // B's registry append is still owed, and A's marker and slot are owed.
      expect(hasPendingInstall()).toBe(true)
      expect(readInstalledRegistry()?.['proj_b']).toBeUndefined()
      expect(readAutosave()).toBeNull()

      failFence = false
      await vi.advanceTimersByTimeAsync(3_100)
      expect(readInstalledRegistry()?.['proj_b']).toContain('install-b')
      expect(hasPendingInstall()).toBe(false)
      expect(storage.get(IMPORT_KEY)).toBeTruthy()
      expect(parseSerializedDoc(readAutosave()!).doc.project.id).toBe('proj_a')
    } finally {
      cleanup()
      vi.useRealTimers()
    }
  })

  it('keeps another project pending-install retry after a live save', async () => {
    vi.useFakeTimers()
    const live = createDoc()
    useEditorStore.setState({
      doc: { ...live, project: { ...live.project, id: 'proj_a', name: 'A' } },
    })
    await markInstallPending('proj_b', 'install-b')
    queuePendingInstallRetry('proj_b')
    try {
      const json = JSON.stringify(serializeDoc(useEditorStore.getState().doc))
      expect(await writeAutosaveCooperatively(json)).toBe('saved')
      // A's slot is saved, but B's registry append is still owed.
      expect(hasPendingInstall()).toBe(true)
      expect(readInstalledRegistry()?.['proj_b']).toBeUndefined()

      await vi.advanceTimersByTimeAsync(3_100)
      expect(readInstalledRegistry()?.['proj_b']).toContain('install-b')
      expect(hasPendingInstall()).toBe(false)
      expect(parseSerializedDoc(readAutosave()!).doc.project.id).toBe('proj_a')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the live slot retry sequence when a pending append is also owed', async () => {
    vi.useFakeTimers()
    const live = createDoc()
    const latest = { ...live, project: { ...live.project, id: 'proj_a', name: 'latest' } }
    const intermediate = {
      ...live,
      project: { ...live.project, id: 'proj_a', name: 'intermediate' },
    }
    useEditorStore.setState({ doc: latest, autosaveStatus: 'pending' })
    await markInstallPending('proj_b', 'install-b')
    queuePendingInstallRetry('proj_b')
    let failFence = false
    vi.stubGlobal('localStorage', {
      ...localStorageMock,
      setItem: (key: string, value: string) => {
        if (failFence && key === IMPORT_KEY) throw new Error('quota')
        storage.set(key, value)
      },
    })
    try {
      // An intermediate A save commits with sequence 2 after B's retry (1).
      expect(
        await writeAutosaveCooperatively(
          JSON.stringify(serializeDoc(intermediate)),
          2,
          'proj_a',
          'proj_a',
        ),
      ).toBe('saved')

      // A's later fence failure uses sequence 3. The combined retry must keep
      // that sequence; B's older sequence would be superseded by the commit.
      requireAutosaveImportFence('proj_a')
      failFence = true
      expect(await writeAutosaveCooperatively(JSON.stringify(serializeDoc(latest)), 3)).toBe(
        'error',
      )
      failFence = false

      await vi.advanceTimersByTimeAsync(3_100)
      expect(readInstalledRegistry()?.['proj_b']).toContain('install-b')
      expect(parseSerializedDoc(readAutosave()!).doc.project.name).toBe('latest')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a combined registry append after a newer save clears the slot retry', async () => {
    vi.useFakeTimers()
    const live = createDoc()
    const latest = { ...live, project: { ...live.project, id: 'proj_a', name: 'latest' } }
    useEditorStore.setState({ doc: latest, autosaveStatus: 'pending' })
    await markInstallPending('proj_b', 'install-b')
    queuePendingInstallRetry('proj_a')
    try {
      const json = JSON.stringify(serializeDoc(latest))
      expect(await writeAutosaveCooperatively(json, 2)).toBe('saved')
      // A's slot is saved. B's registry append still needs its timer, and the
      // retry must not write A's slot a second time.
      expect(readInstalledRegistry()?.['proj_b']).toBeUndefined()
      await vi.advanceTimersByTimeAsync(3_100)
      expect(readInstalledRegistry()?.['proj_b']).toContain('install-b')
      expect(hasPendingInstall()).toBe(false)
      expect(parseSerializedDoc(readAutosave()!).doc.project.name).toBe('latest')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the observed import marker across a coordination remount', async () => {
    storage.set(AUTOSAVE_KEY, '{"old":true}')
    readValidAutosave()
    const first = initAutosaveCoordination()
    first()
    // Another tab imports while this editor is unmounted.
    storage.set(AUTOSAVE_KEY, '{"imported":true}')
    storage.set(IMPORT_KEY, 'import-token')
    const second = initAutosaveCoordination()
    try {
      expect(await writeAutosaveCooperatively('{"old":true}')).toBe('read-only')
      expect(readAutosave()).toBe('{"imported":true}')
    } finally {
      second()
    }
  })

  it('finishes an unfinished import marker before an ordinary slot write', async () => {
    const live = createDoc()
    useEditorStore.setState({
      doc: { ...live, project: { ...live.project, id: 'proj_fence' } },
      autosaveStatus: 'idle',
    })
    storage.set(AUTOSAVE_KEY, '{"old":true}')
    readValidAutosave()
    let failFence = true
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (failFence && key === IMPORT_KEY) throw new Error('quota')
        storage.set(key, value)
      },
      removeItem: (key: string) => void storage.delete(key),
      clear: () => void storage.clear(),
    })
    const cleanup = initAutosaveCoordination()
    try {
      expect(await writeAutosaveCooperatively('{"imported":true}', undefined, 'proj_fence')).toBe(
        'error',
      )
      expect(readAutosave()).toBe('{"old":true}')
      failFence = false
      // The failed project write left the marker requirement behind, so the
      // ordinary save must finish it before it may write the slot.
      expect(await writeAutosaveCooperatively('{"next":true}')).toBe('saved')
      expect(storage.get(IMPORT_KEY)).toBeTruthy()
      expect(readAutosave()).toBe('{"next":true}')
    } finally {
      cleanup()
    }
  })

  it('writes a pending install record only inside the autosave lock', async () => {
    const locks = navigator.locks as unknown as FakeLockManager
    let release!: () => void
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const held = locks.request(AUTOSAVE_LOCK_NAME, { mode: 'exclusive' }, () => hold)
    const installId = 'install-lock-1'
    const write = markInstallPending('proj_lock', installId, true)
    await Promise.resolve()
    await Promise.resolve()
    expect(readPendingInstallRecords()).toEqual([])
    expect(hasPendingInstall()).toBe(true)
    release()
    await held
    await write
    expect(readPendingInstallRecords()).toEqual([
      { projectId: 'proj_lock', installId, hadInstallClaims: true },
    ])
  })

  it('recovers an abandoned pause once the owner lease expires', async () => {
    vi.useFakeTimers()
    try {
      // Every mounted editor reads the slot first, so the recovery can prove
      // it is unchanged. Seed that observation.
      readValidAutosave()
      const cleanup = initAutosaveCoordination()
      const other = new FakeChannel(AUTOSAVE_CHANNEL_NAME)
      try {
        other.postMessage({ type: 'pause', requestId: 'rx-abandoned' })
        expect(isAutosavePaused()).toBe(true)
        // The importer crashes: no resume, no owner record, slot unchanged.
        await vi.advanceTimersByTimeAsync(20_000)
        expect(isAutosavePaused()).toBe(false)
      } finally {
        cleanup()
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('stays paused when an abandoned pause has no known slot text', async () => {
    vi.useFakeTimers()
    try {
      // No readValidAutosave here: this coordination session never observed
      // the slot, so it cannot prove that no import replaced it.
      const cleanup = initAutosaveCoordination()
      const other = new FakeChannel(AUTOSAVE_CHANNEL_NAME)
      try {
        other.postMessage({ type: 'pause', requestId: 'rx-unknown' })
        expect(isAutosavePaused()).toBe(true)
        storage.set(AUTOSAVE_KEY, '{"imported":true}')
        await vi.advanceTimersByTimeAsync(20_000)
        expect(isAutosavePaused()).toBe(true)
        expect(readAutosave()).toBe('{"imported":true}')
      } finally {
        cleanup()
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('stays read-only when an abandoned pause finds a replaced slot', async () => {
    vi.useFakeTimers()
    try {
      storage.set(AUTOSAVE_KEY, '{"old":true}')
      readValidAutosave()
      const cleanup = initAutosaveCoordination()
      const other = new FakeChannel(AUTOSAVE_CHANNEL_NAME)
      try {
        other.postMessage({ type: 'pause', requestId: 'rx-replaced' })
        expect(isAutosavePaused()).toBe(true)
        // An import completed without its broadcast reaching this tab.
        storage.set(AUTOSAVE_KEY, '{"imported":true}')
        await vi.advanceTimersByTimeAsync(20_000)
        expect(isAutosavePaused()).toBe(true)
        expect(readAutosave()).toBe('{"imported":true}')
        // A late resume from the crashed importer must not write this tab's
        // pre-import document over the imported project.
        other.postMessage({ type: 'resume', requestId: 'rx-replaced' })
        await vi.advanceTimersByTimeAsync(0)
        expect(isAutosavePaused()).toBe(true)
        expect(readAutosave()).toBe('{"imported":true}')
      } finally {
        cleanup()
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses to write after another tab takes over with a newer epoch', async () => {
    writeRecord({ tabId: 'other-tab', heartbeatAt: Date.now() - 60_000, epoch: 2 })
    expect((await claimAutosaveOwnership()).ok).toBe(true)
    const ours = readRecord()
    writeRecord({ tabId: 'other-tab', epoch: ours.epoch + 1 })
    expect(await writeAutosaveCooperatively('{"late":true}')).toBe('read-only')
    expect(readAutosave()).toBeNull()
  })
})

describe('autosave pause handshake (0.28.0)', () => {
  it('waits for a known other tab to acknowledge the pause', async () => {
    const cleanup = initAutosaveCoordination()
    try {
      const locks = navigator.locks as unknown as {
        query: () => Promise<{ held: { name: string }[]; pending: never[] }>
      }
      locks.query = async () => ({
        held: [{ name: 'videoh-autosave-tab:tab-other' }],
        pending: [],
      })
      const other = new FakeChannel(AUTOSAVE_CHANNEL_NAME)
      const listener = (event: MessageEvent) => {
        const data = event.data as { type?: string; requestId?: string }
        if (data.type === 'pause') {
          other.postMessage({ type: 'paused', requestId: data.requestId, tabId: 'tab-other' })
        }
      }
      other.addEventListener('message', listener)
      expect(await pauseOtherAutosaveTabs()).toMatchObject({ ok: true })
      other.removeEventListener('message', listener)
    } finally {
      cleanup()
    }
  })

  it('refuses when a known tab never acknowledges', async () => {
    vi.useFakeTimers()
    const cleanup = initAutosaveCoordination()
    try {
      const locks = navigator.locks as unknown as {
        query: () => Promise<{ held: { name: string }[]; pending: never[] }>
      }
      locks.query = async () => ({
        held: [{ name: 'videoh-autosave-tab:tab-silent' }],
        pending: [],
      })
      const pending = pauseOtherAutosaveTabs()
      await vi.advanceTimersByTimeAsync(2_100)
      const result = await pending
      expect(result).toMatchObject({
        ok: false,
        reason: 'Another editor tab did not pause autosave. Close or reload it, then try again.',
      })
      expect(result.requestId).toBeTruthy()
    } finally {
      cleanup()
      vi.useRealTimers()
    }
  })

  it('releases the presence lock when coordination stops', async () => {
    const locks = Object.assign(new FakeLockManager(), {
      query: async () => ({ held: [], pending: [] }),
    })
    vi.stubGlobal('navigator', { locks })
    const cleanup = initAutosaveCoordination()
    await vi.waitFor(() =>
      expect(locks.heldNames().some((name) => name.startsWith('videoh-autosave-tab:'))).toBe(true),
    )
    cleanup()
    await vi.waitFor(() =>
      expect(locks.heldNames().some((name) => name.startsWith('videoh-autosave-tab:'))).toBe(false),
    )
  })

  it('recovers a paused tab across a coordination restart', async () => {
    const cleanup = initAutosaveCoordination()
    const other = new FakeChannel(AUTOSAVE_CHANNEL_NAME)
    other.postMessage({ type: 'pause', requestId: 'r1' })
    expect(isAutosavePaused()).toBe(true)
    cleanup()
    // The importer's resume arrives while this tab's channel is closed.
    other.postMessage({ type: 'resume', requestId: 'r1' })
    const restart = initAutosaveCoordination()
    try {
      await vi.waitFor(() => expect(isAutosavePaused()).toBe(false))
    } finally {
      restart()
    }
  })

  it('stays paused while another import still holds a pause request', async () => {
    const cleanup = initAutosaveCoordination()
    try {
      const other = new FakeChannel(AUTOSAVE_CHANNEL_NAME)
      other.postMessage({ type: 'pause', requestId: 'r1' })
      other.postMessage({ type: 'pause', requestId: 'r2' })
      expect(isAutosavePaused()).toBe(true)
      other.postMessage({ type: 'resume', requestId: 'r1' })
      await Promise.resolve()
      expect(isAutosavePaused()).toBe(true)
      other.postMessage({ type: 'resume', requestId: 'r2' })
      await vi.waitFor(() => expect(isAutosavePaused()).toBe(false))
    } finally {
      cleanup()
    }
  })

  it('writes the pending document after a failed import resumes this tab', async () => {
    const cleanup = initAutosaveCoordination()
    try {
      const other = new FakeChannel(AUTOSAVE_CHANNEL_NAME)
      other.postMessage({ type: 'pause', requestId: 'r1' })
      expect(isAutosavePaused()).toBe(true)
      other.postMessage({ type: 'resume', requestId: 'r1' })
      await vi.waitFor(() => expect(readAutosave()).not.toBeNull())
    } finally {
      cleanup()
    }
  })

  it('recovers a provisional read-only tab when the importer releases its claim', async () => {
    const cleanup = initAutosaveCoordination()
    try {
      otherPause: {
        const other = new FakeChannel(AUTOSAVE_CHANNEL_NAME)
        other.postMessage({ type: 'pause', requestId: 'r1' })
        writeRecord({ tabId: 'other-tab' })
        expect(await writeAutosaveCooperatively('{}')).toBe('read-only')
        expect(isAutosavePaused()).toBe(true)
        storage.delete(OWNER_KEY)
        other.postMessage({ type: 'resume', requestId: 'r1' })
      }
      await vi.waitFor(() => expect(isAutosavePaused()).toBe(false))
      expect(await writeAutosaveCooperatively('{"ok":true}')).toBe('saved')
    } finally {
      cleanup()
    }
  })

  it('sends the pause request id with a resume', async () => {
    const cleanup = initAutosaveCoordination()
    try {
      const other = new FakeChannel(AUTOSAVE_CHANNEL_NAME)
      resumeAutosaveTabs('r1')
      expect(other.received).toContainEqual({ type: 'resume', requestId: 'r1' })
    } finally {
      cleanup()
    }
  })

  it('settles both of two overlapping pause requests', async () => {
    vi.useFakeTimers()
    const cleanup = initAutosaveCoordination()
    try {
      const locks = navigator.locks as unknown as {
        query: () => Promise<{ held: { name: string }[]; pending: never[] }>
      }
      locks.query = async () => ({
        held: [{ name: 'videoh-autosave-tab:tab-slow' }],
        pending: [],
      })
      const settled: string[] = []
      const first = pauseOtherAutosaveTabs().then((result) => {
        settled.push(result.ok ? 'first-ok' : 'first-refused')
      })
      const second = pauseOtherAutosaveTabs().then((result) => {
        settled.push(result.ok ? 'second-ok' : 'second-refused')
      })
      await vi.advanceTimersByTimeAsync(2_100)
      expect(settled.sort()).toEqual(['first-refused', 'second-refused'])
      await Promise.all([first, second])
    } finally {
      cleanup()
      vi.useRealTimers()
    }
  })

  it("discards only the restore the banner showed, never another tab's slot", async () => {
    // No BroadcastChannel: the other tab cannot pause this one, so the guard
    // has to come from the owner record and the slot contents.
    vi.stubGlobal('BroadcastChannel', undefined)
    storage.set(AUTOSAVE_KEY, '{"theirs":true}')
    writeRecord({ tabId: 'other-tab' })
    expect(isAutosavePaused()).toBe(false)
    await clearAutosave('{"mine":true}')
    expect(readAutosave()).toBe('{"theirs":true}')
    // Even with no owner record, a newer slot is not the banner's restore.
    storage.delete(OWNER_KEY)
    await clearAutosave('{"mine":true}')
    expect(readAutosave()).toBe('{"theirs":true}')
    storage.set(AUTOSAVE_KEY, '{"mine":true}')
    await clearAutosave('{"mine":true}')
    expect(readAutosave()).toBeNull()
  })

  it('keeps a read-only tab across a restart when the slot changed with no owner', async () => {
    storage.set(AUTOSAVE_KEY, '{"old":true}')
    readValidAutosave()
    writeRecord({ tabId: 'other-tab' })
    const first = initAutosaveCoordination()
    expect(isAutosavePaused()).toBe(true)
    first()
    // The import finished and released its record while this tab was stopped.
    storage.set(AUTOSAVE_KEY, '{"imported":true}')
    storage.delete(OWNER_KEY)
    const second = initAutosaveCoordination()
    try {
      expect(isAutosavePaused()).toBe(true)
    } finally {
      second()
    }
  })

  it('refuses a claim when a same-session record appears after the probe', async () => {
    const first = await claimAutosaveOwnership()
    expect(first).toMatchObject({ ok: true })
    const record = JSON.parse(storage.get(OWNER_KEY)!) as {
      sessionId: string
      tokenHash: string
    }
    releaseAutosaveOwnership()
    expect(storage.has(OWNER_KEY)).toBe(false)

    const locks = (navigator as unknown as { locks: FakeLockManager }).locks
    const original = locks.request.bind(locks)
    let releaseLock: (() => void) | null = null
    let entered: (() => void) | null = null
    const queued = new Promise<void>((resolve) => {
      entered = resolve
    })
    locks.request = ((
      name: string,
      options: never,
      callback: (lock: object | null) => Promise<unknown>,
    ) => {
      if (name !== AUTOSAVE_LOCK_NAME) return original(name, options, callback)
      return new Promise<unknown>((resolve, reject) => {
        entered?.()
        releaseLock = () => {
          void original(name, options, callback).then(resolve, reject)
        }
      })
    }) as typeof locks.request
    const claiming = claimAutosaveOwnership()
    await queued
    // A second page of the same session claims while this claim waits.
    writeRecord({
      tabId: 'other-tab',
      sessionId: record.sessionId,
      tokenHash: record.tokenHash,
      epoch: 7,
    })
    releaseLock!()
    expect(await claiming).toMatchObject({ ok: false })
  })

  it('keeps autosave pending when a newer edit lands during the write', async () => {
    vi.useFakeTimers()
    const locks = (navigator as unknown as { locks: FakeLockManager }).locks
    const original = locks.request.bind(locks)
    let releaseLock: (() => void) | null = null
    let gateFirst = true
    locks.request = ((
      name: string,
      options: never,
      callback: (lock: object | null) => Promise<unknown>,
    ) => {
      if (name !== AUTOSAVE_LOCK_NAME || !gateFirst) return original(name, options, callback)
      gateFirst = false
      return new Promise<unknown>((resolve, reject) => {
        releaseLock = () => {
          void original(name, options, callback).then(resolve, reject)
        }
      })
    }) as typeof locks.request
    const cleanup = initAutosave()
    try {
      const first = useEditorStore.getState().doc
      useEditorStore.setState({ doc: { ...first, project: { ...first.project, name: 'Edit A' } } })
      await vi.advanceTimersByTimeAsync(800)
      expect(releaseLock).not.toBeNull()
      const second = useEditorStore.getState().doc
      useEditorStore.setState({
        doc: { ...second, project: { ...second.project, name: 'Edit B' } },
      })
      releaseLock!()
      await vi.advanceTimersByTimeAsync(0)
      expect(useEditorStore.getState().autosaveStatus).not.toBe('saved')
      await vi.advanceTimersByTimeAsync(800)
      expect(useEditorStore.getState().autosaveStatus).toBe('saved')
    } finally {
      cleanup()
      vi.useRealTimers()
    }
  })

  it('keeps autosave off when a takeover lands during a debounced save', async () => {
    vi.useFakeTimers()
    const cleanupCoordination = initAutosaveCoordination()
    await vi.advanceTimersByTimeAsync(0)
    const other = new FakeChannel(AUTOSAVE_CHANNEL_NAME)
    const locks = (navigator as unknown as { locks: FakeLockManager }).locks
    const original = locks.request.bind(locks)
    let releaseWrite: (() => void) | null = null
    let gateFirst = true
    locks.request = ((
      name: string,
      options: never,
      callback: (lock: object | null) => Promise<unknown>,
    ) => {
      if (name !== AUTOSAVE_LOCK_NAME || !gateFirst) return original(name, options, callback)
      gateFirst = false
      return new Promise<unknown>((resolve, reject) => {
        releaseWrite = () => {
          void original(name, options, async () => {
            const result = await callback(null)
            // The takeover lands after the slot write but before the save
            // completion, so the completion must not restore saved.
            other.postMessage({ type: 'imported' })
            return result
          }).then(resolve, reject)
        }
      })
    }) as typeof locks.request
    const cleanup = initAutosave()
    try {
      const first = useEditorStore.getState().doc
      useEditorStore.setState({ doc: { ...first, project: { ...first.project, name: 'Save me' } } })
      await vi.advanceTimersByTimeAsync(800)
      expect(releaseWrite).not.toBeNull()
      releaseWrite!()
      await vi.advanceTimersByTimeAsync(0)
      expect(isAutosavePaused()).toBe(true)
      expect(useEditorStore.getState().autosaveStatus).toBe('error')
    } finally {
      cleanup()
      cleanupCoordination()
      useEditorStore.getState().setAutosaveStatus('idle')
      vi.useRealTimers()
    }
  })

  it('keeps autosave off when a takeover lands during a slot retry', async () => {
    vi.useFakeTimers()
    const cleanupCoordination = initAutosaveCoordination()
    await vi.advanceTimersByTimeAsync(0)
    const other = new FakeChannel(AUTOSAVE_CHANNEL_NAME)
    const locks = (navigator as unknown as { locks: FakeLockManager }).locks
    const original = locks.request.bind(locks)
    let releaseWrite: (() => void) | null = null
    let gateFirst = true
    locks.request = ((
      name: string,
      options: never,
      callback: (lock: object | null) => Promise<unknown>,
    ) => {
      if (name !== AUTOSAVE_LOCK_NAME || !gateFirst) return original(name, options, callback)
      gateFirst = false
      return new Promise<unknown>((resolve, reject) => {
        releaseWrite = () => {
          void original(name, options, async () => {
            const result = await callback(null)
            other.postMessage({ type: 'imported' })
            return result
          }).then(resolve, reject)
        }
      })
    }) as typeof locks.request
    try {
      const live = createDoc()
      useEditorStore.setState({
        doc: { ...live, project: { ...live.project, id: 'proj_readonly_retry' } },
        autosaveStatus: 'pending',
      })
      const json = JSON.stringify(serializeDoc(useEditorStore.getState().doc))
      queueAutosaveRetry(json, undefined, 'proj_readonly_retry')
      await vi.advanceTimersByTimeAsync(3_000)
      expect(releaseWrite).not.toBeNull()
      releaseWrite!()
      await vi.advanceTimersByTimeAsync(0)
      expect(isAutosavePaused()).toBe(true)
      expect(useEditorStore.getState().autosaveStatus).toBe('error')
    } finally {
      cleanupCoordination()
      useEditorStore.getState().setAutosaveStatus('idle')
      vi.useRealTimers()
    }
  })

  it('keeps a resumed write pending when a newer edit lands during it', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('BroadcastChannel', undefined)
    const listeners = new Map<string, (event: StorageEvent) => void>()
    vi.stubGlobal('window', {
      addEventListener: (type: string, listener: (event: StorageEvent) => void) => {
        listeners.set(type, listener)
      },
      removeEventListener: (type: string) => listeners.delete(type),
    })
    storage.set(AUTOSAVE_KEY, '{"mine":true}')
    readValidAutosave()
    writeRecord({ tabId: 'other-tab' })
    const cleanupCoordination = initAutosaveCoordination()
    const unsubscribe = initAutosave()
    const locks = (navigator as unknown as { locks: FakeLockManager }).locks
    const original = locks.request.bind(locks)
    let releaseWrite: (() => void) | null = null
    let requests = 0
    locks.request = ((
      name: string,
      options: never,
      callback: (lock: object | null) => Promise<unknown>,
    ) => {
      if (name !== AUTOSAVE_LOCK_NAME) return original(name, options, callback)
      requests += 1
      // Request 1 is the ownership recheck; request 2 is the resumed slot
      // write, which the test holds open.
      if (requests !== 2) return original(name, options, callback)
      return new Promise<unknown>((resolve, reject) => {
        releaseWrite = () => {
          void original(name, options, callback).then(resolve, reject)
        }
      })
    }) as typeof locks.request
    try {
      expect(isAutosavePaused()).toBe(true)
      storage.delete(OWNER_KEY)
      listeners.get('storage')?.({ key: OWNER_KEY, newValue: null } as StorageEvent)
      await vi.advanceTimersByTimeAsync(0)
      expect(releaseWrite).not.toBeNull()
      expect(isAutosavePaused()).toBe(false)

      const first = useEditorStore.getState().doc
      useEditorStore.setState({
        doc: { ...first, project: { ...first.project, name: 'Newer edit' } },
      })
      releaseWrite!()
      await vi.advanceTimersByTimeAsync(0)
      // The held write carried the OLD document; skipping it before any slot
      // side effect leaves the previously committed slot untouched.
      expect(readAutosave()).toBe('{"mine":true}')
      // The resumed write must not report the newer edit saved.
      expect(useEditorStore.getState().autosaveStatus).toBe('pending')

      await vi.advanceTimersByTimeAsync(800)
      expect(useEditorStore.getState().autosaveStatus).toBe('saved')
      expect(parseSerializedDoc(readAutosave()!).doc.project.name).toBe('Newer edit')
    } finally {
      unsubscribe()
      cleanupCoordination()
      useEditorStore.getState().setAutosaveStatus('idle')
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })

  it('reports autosave off when a resumed write is refused as read-only', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('BroadcastChannel', undefined)
    const listeners = new Map<string, (event: StorageEvent) => void>()
    vi.stubGlobal('window', {
      addEventListener: (type: string, listener: (event: StorageEvent) => void) => {
        listeners.set(type, listener)
      },
      removeEventListener: (type: string) => listeners.delete(type),
    })
    storage.set(AUTOSAVE_KEY, '{"mine":true}')
    readValidAutosave()
    writeRecord({ tabId: 'other-tab' })
    const cleanupCoordination = initAutosaveCoordination()
    const unsubscribe = initAutosave()
    const locks = (navigator as unknown as { locks: FakeLockManager }).locks
    const original = locks.request.bind(locks)
    let releaseWrite: (() => void) | null = null
    let requests = 0
    locks.request = ((
      name: string,
      options: never,
      callback: (lock: object | null) => Promise<unknown>,
    ) => {
      if (name !== AUTOSAVE_LOCK_NAME) return original(name, options, callback)
      requests += 1
      // Request 1 is the ownership recheck; request 2 is the resumed slot
      // write, which the test holds open.
      if (requests !== 2) return original(name, options, callback)
      return new Promise<unknown>((resolve, reject) => {
        releaseWrite = () => {
          void original(name, options, callback).then(resolve, reject)
        }
      })
    }) as typeof locks.request
    try {
      expect(isAutosavePaused()).toBe(true)
      storage.delete(OWNER_KEY)
      listeners.get('storage')?.({ key: OWNER_KEY, newValue: null } as StorageEvent)
      await vi.advanceTimersByTimeAsync(0)
      expect(releaseWrite).not.toBeNull()
      expect(isAutosavePaused()).toBe(false)

      // Another tab takes the slot while the resumed write waits for the
      // lock. The write must report the read-only refusal as autosave off,
      // not leave the indicator pending or claim the old slot saved.
      writeRecord({ tabId: 'other-tab' })
      releaseWrite!()
      await vi.advanceTimersByTimeAsync(0)

      expect(useEditorStore.getState().autosaveStatus).toBe('error')
      expect(readAutosave()).toBe('{"mine":true}')
    } finally {
      unsubscribe()
      cleanupCoordination()
      useEditorStore.getState().setAutosaveStatus('idle')
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })

  it('reports autosave off when a debounced write is refused as read-only', async () => {
    vi.useFakeTimers()
    const unsubscribe = initAutosave()
    try {
      writeRecord({ tabId: 'other-tab' })
      const first = useEditorStore.getState().doc
      useEditorStore.setState({
        doc: { ...first, project: { ...first.project, name: 'Blocked edit' } },
      })
      await vi.advanceTimersByTimeAsync(900)
      expect(useEditorStore.getState().autosaveStatus).toBe('error')
      expect(isAutosavePaused()).toBe(true)
    } finally {
      unsubscribe()
      useEditorStore.getState().setAutosaveStatus('idle')
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })

  it('resumes a read-only tab when the owner record is removed without a channel', async () => {
    vi.stubGlobal('BroadcastChannel', undefined)
    const listeners = new Map<string, (event: StorageEvent) => void>()
    vi.stubGlobal('window', {
      addEventListener: (type: string, listener: (event: StorageEvent) => void) => {
        listeners.set(type, listener)
      },
      removeEventListener: (type: string) => listeners.delete(type),
    })
    storage.set(AUTOSAVE_KEY, '{"mine":true}')
    readValidAutosave()
    writeRecord({ tabId: 'other-tab' })
    const cleanup = initAutosaveCoordination()
    try {
      expect(isAutosavePaused()).toBe(true)
      storage.delete(OWNER_KEY)
      // The release reaches this tab as a localStorage change, not a message.
      listeners.get('storage')?.({ key: OWNER_KEY, newValue: null } as StorageEvent)
      await vi.waitFor(() => expect(isAutosavePaused()).toBe(false))
      expect(await writeAutosaveCooperatively('{"mine":true}')).toBe('saved')
      expect(readAutosave()).toBe('{"mine":true}')
    } finally {
      cleanup()
    }
  })

  it('does not replace a pending restore when it resumes', async () => {
    vi.stubGlobal('BroadcastChannel', undefined)
    const listeners = new Map<string, (event: StorageEvent) => void>()
    vi.stubGlobal('window', {
      addEventListener: (type: string, listener: (event: StorageEvent) => void) => {
        listeners.set(type, listener)
      },
      removeEventListener: (type: string) => listeners.delete(type),
    })
    storage.set(AUTOSAVE_KEY, '{"old":true}')
    readValidAutosave()
    const store = useEditorStore.getState()
    const before = store.pendingRestore
    useEditorStore.setState({ pendingRestore: { doc: store.doc, warnings: [] } })
    writeRecord({ tabId: 'other-tab' })
    const cleanup = initAutosaveCoordination()
    try {
      storage.delete(OWNER_KEY)
      listeners.get('storage')?.({ key: OWNER_KEY, newValue: null } as StorageEvent)
      await vi.waitFor(() => expect(isAutosavePaused()).toBe(false))
      // Resuming must not write the live doc over the session awaiting Restore.
      expect(readAutosave()).toBe('{"old":true}')
    } finally {
      useEditorStore.setState({ pendingRestore: before })
      cleanup()
    }
  })

  it('stays paused when an import replaced the slot before the release', async () => {
    vi.stubGlobal('BroadcastChannel', undefined)
    const listeners = new Map<string, (event: StorageEvent) => void>()
    vi.stubGlobal('window', {
      addEventListener: (type: string, listener: (event: StorageEvent) => void) => {
        listeners.set(type, listener)
      },
      removeEventListener: (type: string) => listeners.delete(type),
    })
    storage.set(AUTOSAVE_KEY, '{"old":true}')
    readValidAutosave()
    writeRecord({ tabId: 'other-tab' })
    const cleanup = initAutosaveCoordination()
    try {
      expect(isAutosavePaused()).toBe(true)
      // The importer wrote its project before releasing the record.
      storage.set(AUTOSAVE_KEY, '{"imported":true}')
      storage.delete(OWNER_KEY)
      listeners.get('storage')?.({ key: OWNER_KEY, newValue: null } as StorageEvent)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(isAutosavePaused()).toBe(true)
      expect(readAutosave()).toBe('{"imported":true}')
    } finally {
      cleanup()
    }
  })

  it('does not revive a stale owner record after a remount', async () => {
    vi.useFakeTimers()
    try {
      const cleanup = initAutosaveCoordination()
      expect(await claimAutosaveOwnership()).toMatchObject({ ok: true })
      cleanup()
      // The record survives the unmount for a fast remount, but its lease ends.
      await vi.advanceTimersByTimeAsync(16_000)
      const before = storage.get(OWNER_KEY)
      const restart = initAutosaveCoordination()
      try {
        await vi.advanceTimersByTimeAsync(0)
        expect(isAutosavePaused()).toBe(false)
        expect(await writeAutosaveCooperatively('{"slot":1}')).toBe('saved')
        // Normal editing with no live owner must not refresh or recreate one.
        expect(storage.get(OWNER_KEY)).toBe(before)
      } finally {
        restart()
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears the error status when a queued retry succeeds', async () => {
    vi.useFakeTimers()
    useEditorStore.getState().setAutosaveStatus('error')
    try {
      queueAutosaveRetry('{"retry":true}')
      await vi.advanceTimersByTimeAsync(3_000)
      expect(readAutosave()).toBe('{"retry":true}')
      expect(useEditorStore.getState().autosaveStatus).toBe('saved')
    } finally {
      useEditorStore.getState().setAutosaveStatus('idle')
      vi.useRealTimers()
    }
  })

  it('does not reclaim ownership after coordination is torn down mid-probe', async () => {
    vi.useFakeTimers()
    try {
      expect(await claimAutosaveOwnership()).toMatchObject({ ok: true })
      const claimed = JSON.parse(storage.get(OWNER_KEY)!) as Record<string, unknown>
      resetAutosaveCoordinationForTests()
      storage.set(
        OWNER_KEY,
        JSON.stringify({ ...claimed, tabId: 'prior-tab', epoch: 3, heartbeatAt: Date.now() }),
      )
      const before = storage.get(OWNER_KEY)
      const cleanup = initAutosaveCoordination()
      await vi.advanceTimersByTimeAsync(0)
      cleanup()
      // Teardown clears the probe timer with the rest of the coordination state.
      expect(vi.getTimerCount()).toBe(0)
      // The probe times out after teardown. A late takeover would rewrite the
      // record and start a heartbeat for an unmounted editor.
      await vi.advanceTimersByTimeAsync(3_000)
      expect(storage.get(OWNER_KEY)).toBe(before)
    } finally {
      vi.useRealTimers()
    }
  })

  it('pauses on another tab pause and stays paused after an import', async () => {
    const cleanup = initAutosaveCoordination()
    try {
      const other = new FakeChannel(AUTOSAVE_CHANNEL_NAME)
      other.postMessage({ type: 'pause', requestId: 'r1', tabId: 'tab-other' })
      expect(isAutosavePaused()).toBe(true)
      await vi.waitFor(() =>
        expect(other.received).toContainEqual({
          type: 'paused',
          requestId: 'r1',
          tabId: expect.any(String),
        }),
      )
      other.postMessage({ type: 'resume', requestId: 'r1' })
      expect(isAutosavePaused()).toBe(false)
      other.postMessage({ type: 'imported' })
      expect(isAutosavePaused()).toBe(true)
      // An imported project permanently pauses this tab until it reloads.
      other.postMessage({ type: 'resume', requestId: 'r1' })
      expect(isAutosavePaused()).toBe(true)
      expect(await writeAutosaveCooperatively('{}')).toBe('read-only')
    } finally {
      cleanup()
    }
  })

  it('refuses a pause when coordination is torn down during peer discovery', async () => {
    const cleanup = initAutosaveCoordination()
    try {
      let releaseQuery!: (value: { held: { name: string }[]; pending: never[] }) => void
      const query = new Promise<{ held: { name: string }[]; pending: never[] }>((resolve) => {
        releaseQuery = resolve
      })
      const locks = navigator.locks as unknown as {
        query: () => Promise<{ held: { name: string }[]; pending: never[] }>
      }
      locks.query = () => query
      const pending = pauseOtherAutosaveTabs()
      resetAutosaveCoordinationForTests()
      releaseQuery({ held: [], pending: [] })
      await expect(pending).resolves.toMatchObject({
        ok: false,
        reason: 'This tab closed during the autosave pause.',
      })
    } finally {
      cleanup()
    }
  })

  it('settles a pending pause when the test reset disposes coordination', async () => {
    const cleanup = initAutosaveCoordination()
    try {
      const locks = navigator.locks as unknown as {
        query: () => Promise<{ held: { name: string }[]; pending: never[] }>
      }
      locks.query = async () => ({
        held: [{ name: 'videoh-autosave-tab:tab-other' }],
        pending: [],
      })
      const pending = pauseOtherAutosaveTabs()
      await new Promise((resolve) => setTimeout(resolve, 0))
      resetAutosaveCoordinationForTests()
      await expect(pending).resolves.toMatchObject({
        ok: false,
        reason: 'The editor was reset during the autosave pause.',
      })
    } finally {
      cleanup()
    }
  })

  it('an old cleanup does not dispose a replacement mount', async () => {
    const cleanup1 = initAutosaveCoordination()
    resetAutosaveCoordinationForTests()
    const cleanup2 = initAutosaveCoordination()
    try {
      cleanup1()
      expect(FakeChannel.all.size).toBe(1)
    } finally {
      cleanup2()
      resetAutosaveCoordinationForTests()
    }
  })

  it('does not let a stale presence rejection clear a replacement release handle', async () => {
    const locks = (navigator as unknown as { locks: FakeLockManager }).locks
    const original = locks.request.bind(locks)
    let rejectFirst!: (error: Error) => void
    let presenceCalls = 0
    locks.request = ((
      name: string,
      options: never,
      callback: (lock: object | null) => Promise<unknown>,
    ) => {
      if (name.startsWith('videoh-autosave-tab:')) {
        presenceCalls += 1
        if (presenceCalls === 1) {
          return new Promise<unknown>((_, reject) => {
            rejectFirst = reject
          })
        }
      }
      return original(name, options, callback)
    }) as typeof locks.request
    const cleanup1 = initAutosaveCoordination()
    cleanup1()
    resetAutosaveCoordinationForTests()
    const cleanup2 = initAutosaveCoordination()
    const presenceHeld = () =>
      locks.heldNames().some((name) => name.startsWith('videoh-autosave-tab:'))
    try {
      await vi.waitFor(() => expect(presenceHeld()).toBe(true))
      rejectFirst(new Error('presence request failed'))
      await new Promise((resolve) => setTimeout(resolve, 0))
      cleanup2()
      await vi.waitFor(() => expect(presenceHeld()).toBe(false))
    } finally {
      cleanup2()
      locks.request = original as typeof locks.request
      resetAutosaveCoordinationForTests()
    }
  })

  it('does not acknowledge a pause after its coordination record is replaced', async () => {
    const cleanup1 = initAutosaveCoordination()
    const other = new FakeChannel(AUTOSAVE_CHANNEL_NAME)
    const locks = (navigator as unknown as { locks: FakeLockManager }).locks
    const original = locks.request.bind(locks)
    let releaseWrite!: () => void
    let entered!: () => void
    const requested = new Promise<void>((resolve) => {
      entered = resolve
    })
    let gate = false
    locks.request = ((
      name: string,
      options: never,
      callback: (lock: object | null) => Promise<unknown>,
    ) => {
      if (name !== AUTOSAVE_LOCK_NAME || !gate) return original(name, options, callback)
      gate = false
      return new Promise<unknown>((resolve, reject) => {
        entered()
        releaseWrite = () => {
          void original(name, options, callback).then(resolve, reject)
        }
      })
    }) as typeof locks.request
    let cleanup2: (() => void) | null = null
    try {
      // Let the initial ownership check settle before holding the write lock.
      await new Promise((resolve) => setTimeout(resolve, 0))
      gate = true
      const queued = writeAutosaveCooperatively('{"queued-ack":true}')
      await requested
      other.postMessage({ type: 'pause', requestId: 'r-stale-ack' })
      expect(isAutosavePaused()).toBe(true)
      resetAutosaveCoordinationForTests()
      cleanup2 = initAutosaveCoordination()
      releaseWrite()
      await queued
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(other.received).not.toContainEqual(
        expect.objectContaining({ type: 'paused', requestId: 'r-stale-ack' }),
      )
    } finally {
      cleanup2?.()
      locks.request = original as typeof locks.request
      cleanup1()
    }
  })
})

describe('autosave lifecycle (0.29.6 follow-up)', () => {
  it('detaches the mount listeners when reset disposes the record', () => {
    vi.stubGlobal('BroadcastChannel', undefined)
    const listeners = new Map<string, Set<(event: Event) => void>>()
    vi.stubGlobal('window', {
      addEventListener: (type: string, listener: (event: Event) => void) => {
        const callbacks = listeners.get(type) ?? new Set()
        callbacks.add(listener)
        listeners.set(type, callbacks)
      },
      removeEventListener: (type: string, listener: (event: Event) => void) => {
        const callbacks = listeners.get(type)
        if (!callbacks) return
        callbacks.delete(listener)
        if (callbacks.size === 0) listeners.delete(type)
      },
    })
    const cleanup = initAutosaveCoordination()
    try {
      expect(listeners.has('storage')).toBe(true)
      expect(listeners.has('pagehide')).toBe(true)
      resetAutosaveCoordinationForTests()
      expect(listeners.has('storage')).toBe(false)
      expect(listeners.has('pagehide')).toBe(false)
    } finally {
      cleanup()
    }
  })

  it('cancels the armed debounce when reset disposes the record', () => {
    const cancel = vi.fn()
    setAutosaveCancel(cancel)
    resetAutosaveCoordinationForTests()
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('an old cleanup does not clear the replacement mount pause flag', () => {
    const cleanup1 = initAutosaveCoordination()
    resetAutosaveCoordinationForTests()
    const cleanup2 = initAutosaveCoordination()
    try {
      useEditorStore.getState().setAutosavePaused(true)
      cleanup1()
      expect(useEditorStore.getState().autosavePaused).toBe(true)
    } finally {
      cleanup2()
      resetAutosaveCoordinationForTests()
    }
  })

  it('a replaced record ignores the debounced save result', async () => {
    vi.useFakeTimers()
    const unsubscribe = initAutosave()
    const locks = (navigator as unknown as { locks: FakeLockManager }).locks
    const original = locks.request.bind(locks)
    let releaseWrite!: () => void
    let entered!: () => void
    const requested = new Promise<void>((resolve) => {
      entered = resolve
    })
    let gate = false
    locks.request = ((
      name: string,
      options: never,
      callback: (lock: object | null) => Promise<unknown>,
    ) => {
      if (name !== AUTOSAVE_LOCK_NAME || !gate) return original(name, options, callback)
      gate = false
      return new Promise<unknown>((resolve, reject) => {
        entered()
        releaseWrite = () => {
          void original(name, options, callback).then(resolve, reject)
        }
      })
    }) as typeof locks.request
    try {
      gate = true
      const doc = useEditorStore.getState().doc
      useEditorStore.setState({ doc: { ...doc, project: { ...doc.project, name: 'Edited' } } })
      await vi.advanceTimersByTimeAsync(800)
      await requested
      resetAutosaveCoordinationForTests()
      useEditorStore.getState().setAutosaveStatus('idle')
      const autosaved = useEditorStore.getState().autosavedAt
      releaseWrite()
      await vi.advanceTimersByTimeAsync(0)
      await Promise.resolve()
      await Promise.resolve()
      expect(useEditorStore.getState().autosaveStatus).toBe('idle')
      expect(useEditorStore.getState().autosavedAt).toBe(autosaved)
    } finally {
      locks.request = original as typeof locks.request
      unsubscribe()
      vi.useRealTimers()
      resetAutosaveCoordinationForTests()
    }
  })

  it('a replaced record ignores the resume save result', async () => {
    const cleanup = initAutosaveCoordination()
    const other = new FakeChannel(AUTOSAVE_CHANNEL_NAME)
    const locks = (navigator as unknown as { locks: FakeLockManager }).locks
    const original = locks.request.bind(locks)
    let releaseWrite!: () => void
    let entered!: () => void
    const requested = new Promise<void>((resolve) => {
      entered = resolve
    })
    let gate = false
    locks.request = ((
      name: string,
      options: never,
      callback: (lock: object | null) => Promise<unknown>,
    ) => {
      if (name !== AUTOSAVE_LOCK_NAME || !gate) return original(name, options, callback)
      gate = false
      return new Promise<unknown>((resolve, reject) => {
        entered()
        releaseWrite = () => {
          void original(name, options, callback).then(resolve, reject)
        }
      })
    }) as typeof locks.request
    try {
      // Let the initial ownership check settle before holding the resume write.
      await new Promise((resolve) => setTimeout(resolve, 0))
      gate = true
      other.postMessage({ type: 'pause', requestId: 'r-resume' })
      expect(isAutosavePaused()).toBe(true)
      other.postMessage({ type: 'resume', requestId: 'r-resume' })
      await requested
      resetAutosaveCoordinationForTests()
      useEditorStore.getState().setAutosaveStatus('idle')
      const autosaved = useEditorStore.getState().autosavedAt
      releaseWrite()
      await new Promise((resolve) => setTimeout(resolve, 0))
      await Promise.resolve()
      await Promise.resolve()
      expect(useEditorStore.getState().autosaveStatus).toBe('idle')
      expect(useEditorStore.getState().autosavedAt).toBe(autosaved)
    } finally {
      locks.request = original as typeof locks.request
      cleanup()
      resetAutosaveCoordinationForTests()
    }
  })

  it('rejects a write queued before coordination is reset', async () => {
    const locks = (navigator as unknown as { locks: FakeLockManager }).locks
    const original = locks.request.bind(locks)
    let releaseWrite!: () => void
    let entered!: () => void
    const requested = new Promise<void>((resolve) => {
      entered = resolve
    })
    let gate = false
    locks.request = ((
      name: string,
      options: never,
      callback: (lock: object | null) => Promise<unknown>,
    ) => {
      if (name !== AUTOSAVE_LOCK_NAME || !gate) return original(name, options, callback)
      gate = false
      return new Promise<unknown>((resolve, reject) => {
        entered()
        releaseWrite = () => {
          void original(name, options, callback).then(resolve, reject)
        }
      })
    }) as typeof locks.request
    try {
      gate = true
      const queued = writeAutosaveCooperatively('{"queued-reset":true}', 20)
      await requested
      resetAutosaveCoordinationForTests()
      releaseWrite()
      expect(await queued).toBe('read-only')
      expect(readAutosave()).toBeNull()
      expect(await writeAutosaveCooperatively('{"new":true}')).toBe('saved')
      expect(readAutosave()).toBe('{"new":true}')
    } finally {
      locks.request = original as typeof locks.request
      resetAutosaveCoordinationForTests()
    }
  })
})

describe('autosave IndexedDB fallback (0.29.0)', () => {
  function useIdb(): ReturnType<typeof createFakeIndexedDb> {
    const idb = createFakeIndexedDb()
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('indexedDB', idb.factory)
    return idb
  }

  function records(idb: ReturnType<typeof createFakeIndexedDb>): Map<string, unknown> {
    return idb.databases.get('web-video-editor-autosave')?.get('sections') ?? new Map()
  }

  async function settle(): Promise<void> {
    // Let the completion macrotask and any successor completion run.
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }

  function openDb(idb: ReturnType<typeof createFakeIndexedDb>): Promise<FakeIdbDatabase> {
    return new Promise((resolve, reject) => {
      const request = idb.factory.open('web-video-editor-autosave', 1)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('sections')) {
          request.result.createObjectStore('sections')
        }
      }
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result)
    })
  }

  it('serializes a claim through a readwrite transaction when Web Locks is absent', async () => {
    const idb = useIdb()
    expect(await claimAutosaveOwnership()).toMatchObject({ ok: true })
    expect(storage.has(OWNER_KEY)).toBe(true)
    // The section's put records the coordination write.
    expect(records(idb).has('autosave')).toBe(true)
  })

  it('opens an existing sections store without recreating it', async () => {
    const idb = useIdb()
    idb.databases.set('web-video-editor-autosave', new Map([['sections', new Map()]]))
    expect(await claimAutosaveOwnership()).toMatchObject({ ok: true })
    expect(records(idb).has('autosave')).toBe(true)
  })

  it('falls back to a direct section when the transaction constructor throws', async () => {
    const idb = useIdb()
    idb.failTransaction = true
    expect(await claimAutosaveOwnership()).toMatchObject({
      ok: false,
      reason: expect.stringContaining('could not coordinate'),
    })
    storage.set(AUTOSAVE_KEY, '{"slot":true}')
    idb.failTransaction = true
    await clearAutosave()
    expect(readAutosave()).toBeNull()
  })

  it('fails a required section closed when the database cannot open', async () => {
    const idb = useIdb()
    idb.failOpen = true
    expect(await claimAutosaveOwnership()).toMatchObject({
      ok: false,
      reason: expect.stringContaining('could not coordinate'),
    })
    // A best-effort section still runs directly after the open failure.
    storage.set(AUTOSAVE_KEY, '{"slot":true}')
    idb.failOpen = true
    await clearAutosave()
    expect(readAutosave()).toBeNull()
  })

  it('refuses an unserialized fallback when a pending install arrives while opening', async () => {
    const idb = useIdb()
    idb.databases.set('web-video-editor-autosave', new Map([['sections', new Map()]]))
    let failedOpen: { onerror?: () => void } | null = null
    let first = true
    const factory = idb.factory
    vi.stubGlobal('indexedDB', {
      open: (...args: Parameters<typeof factory.open>) => {
        if (first) {
          first = false
          const request: { onerror?: () => void } = {}
          failedOpen = request
          return request
        }
        return factory.open(...args)
      },
    })
    const write = writeAutosaveCooperatively('{"ordinary":true}')
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
    expect(failedOpen).not.toBeNull()
    // The pending install lands after the write captured its serialization
    // requirement but before the failed open falls back to a direct section.
    await markInstallPending('proj_fallback', 'install-fallback')
    failedOpen!.onerror?.()
    await expect(write).resolves.toBe('error')
    expect(readAutosave()).toBeNull()
    expect(hasPendingInstall()).toBe(true)
    expect(storage.has(IMPORT_KEY)).toBe(false)
  })

  it('fails a project-scoped write closed when the database cannot open', async () => {
    const idb = useIdb()
    const live = createDoc()
    useEditorStore.setState({
      doc: { ...live, project: { ...live.project, id: 'proj_scoped' } },
    })
    const json = JSON.stringify(serializeDoc(useEditorStore.getState().doc))
    idb.failOpen = true
    expect(await writeAutosaveCooperatively(json, undefined, 'proj_scoped')).toBe('error')
    expect(readAutosave()).toBeNull()
  })

  it('fails an unfinished import fence closed when the database cannot open', async () => {
    const idb = useIdb()
    const live = createDoc()
    useEditorStore.setState({
      doc: { ...live, project: { ...live.project, id: 'proj_fence_fallback' } },
    })
    requireAutosaveImportFence('proj_fence_fallback')
    const json = JSON.stringify(serializeDoc(useEditorStore.getState().doc))
    idb.failOpen = true
    expect(await writeAutosaveCooperatively(json)).toBe('error')
    expect(readAutosave()).toBeNull()
    expect(storage.has(IMPORT_KEY)).toBe(false)
  })

  it('keeps the direct fallback for an ordinary write with no obligations', async () => {
    const idb = useIdb()
    const live = createDoc()
    useEditorStore.setState({
      doc: { ...live, project: { ...live.project, id: 'proj_ordinary' } },
    })
    const json = JSON.stringify(serializeDoc(useEditorStore.getState().doc))
    idb.failOpen = true
    expect(await writeAutosaveCooperatively(json)).toBe('saved')
    expect(readAutosave()).toBe(json)
  })

  it('fails a required section closed when the transaction read fails', async () => {
    const idb = useIdb()
    idb.failRead = true
    expect(await claimAutosaveOwnership()).toMatchObject({
      ok: false,
      reason: expect.stringContaining('could not coordinate'),
    })
  })

  it('keeps the section result when the commit fails after it ran', async () => {
    const idb = useIdb()
    idb.failCommit = true
    const writes = vi.spyOn(localStorageMock, 'setItem')
    try {
      expect(await claimAutosaveOwnership()).toMatchObject({ ok: true })
      // The abort event after the failed commit resolves the captured result;
      // the section must not run a second time to produce it.
      expect(writes.mock.calls.filter(([key]) => key === OWNER_KEY)).toHaveLength(1)
    } finally {
      writes.mockRestore()
    }
    expect(storage.has(OWNER_KEY)).toBe(true)
  })

  it('aborts the transaction when the section throws and never retries it through the commit', async () => {
    const idb = useIdb()
    storage.set(AUTOSAVE_KEY, '{"slot":true}')
    const remove = vi.spyOn(localStorageMock, 'removeItem').mockImplementation(() => {
      throw new Error('storage is blocked')
    })
    try {
      await expect(clearAutosave()).resolves.toBeUndefined()
      // The section throws inside the transaction (aborting it) and runs again
      // in the best-effort direct retry: exactly one removal per attempt.
      expect(remove.mock.calls.filter(([key]) => key === AUTOSAVE_KEY)).toHaveLength(2)
      // The transaction itself is aborted, not left open for its commit.
      expect(idb.aborts).toBe(1)
    } finally {
      remove.mockRestore()
    }
    // The section threw before its put, so nothing was committed.
    expect(records(idb).has('autosave')).toBe(false)
  })

  it('ignores a duplicated transaction event after the section settled', async () => {
    const idb = useIdb()
    idb.duplicateEvent = true
    const writes = vi.spyOn(localStorageMock, 'setItem')
    try {
      expect(await claimAutosaveOwnership()).toMatchObject({ ok: true })
      // Smoke test: the fake delivers the event twice and the section still
      // runs once. Promise settlement is idempotent, so this does not prove a
      // removed settle flag would be observable; the delivery count is real.
      expect(idb.events).toBe(2)
      expect(writes.mock.calls.filter(([key]) => key === OWNER_KEY)).toHaveLength(1)
    } finally {
      writes.mockRestore()
    }
    expect(records(idb).has('autosave')).toBe(true)
  })

  // The tests below exercise the fake IndexedDB itself and call no production
  // export. They lock the harness that the fallback tests above depend on.
  it('allows store creation only during an upgrade', async () => {
    const idb = useIdb()
    const db = await openDb(idb)
    expect(() => db.createObjectStore('sections')).toThrow('only allowed during an upgrade')
    const transaction = db.transaction('sections', 'readwrite')
    expect(() => transaction.objectStore('other')).toThrow('No object store named other')
    const duplicate = createFakeIndexedDb()
    const request = duplicate.factory.open('web-video-editor-autosave', 1)
    let upgradeConnection: FakeIdbDatabase | undefined
    request.onupgradeneeded = () => {
      upgradeConnection = request.result
      request.result.createObjectStore('sections')
      expect(() => request.result.createObjectStore('sections')).toThrow(
        'Object store already exists',
      )
    }
    await new Promise<void>((resolve, reject) => {
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
    // The saved upgrade connection is the success result, and neither can
    // create a store after the callback exited.
    expect(upgradeConnection).toBe(request.result)
    expect(() => upgradeConnection!.createObjectStore('late')).toThrow(
      'only allowed during an upgrade',
    )
    expect(() => request.result.createObjectStore('late')).toThrow('only allowed during an upgrade')
    expect(request.result.objectStoreNames.contains('sections')).toBe(true)
  })

  it('fires onupgradeneeded only when the version increases', async () => {
    const idb = useIdb()
    let upgrades = 0
    const first = await openDb(idb)
    expect(first.objectStoreNames.contains('sections')).toBe(true)
    const same = idb.factory.open('web-video-editor-autosave', 1)
    same.onupgradeneeded = () => {
      upgrades += 1
    }
    await new Promise<void>((resolve, reject) => {
      same.onsuccess = () => resolve()
      same.onerror = () => reject(same.error)
    })
    expect(upgrades).toBe(0)
    first.close()
    same.result.close()
    const upgraded = idb.factory.open('web-video-editor-autosave', 2)
    upgraded.onupgradeneeded = () => {
      upgrades += 1
    }
    await new Promise<void>((resolve, reject) => {
      upgraded.onsuccess = () => resolve()
      upgraded.onerror = () => reject(upgraded.error)
    })
    expect(upgrades).toBe(1)
    const lower = idb.factory.open('web-video-editor-autosave', 1)
    lower.onupgradeneeded = () => {
      upgrades += 1
    }
    const lowerError = await new Promise<unknown>((resolve) => {
      lower.onsuccess = () => resolve(null)
      lower.onerror = () => resolve(lower.error)
    })
    expect((lowerError as Error).name).toBe('VersionError')
    expect(upgrades).toBe(1)
  })

  it('serializes a transaction across connections until the writer commits', async () => {
    const idb = useIdb()
    idb.databases.set('web-video-editor-autosave', new Map([['sections', new Map()]]))
    const writer = await openDb(idb)
    const reader = await openDb(idb)
    const write = writer.transaction('sections', 'readwrite')
    let committed = false
    write.oncomplete = () => {
      committed = true
    }
    const first = write.objectStore('sections').put({ at: 1 }, 'autosave')
    // Chain a second put so the writer stays open across more than one fake
    // delivery turn; the fake serializes this through its shared queue and
    // does not claim native task boundaries.
    first.onsuccess = () => {
      write.objectStore('sections').put({ at: 2 }, 'autosave')
    }
    const read = reader.transaction('sections', 'readwrite')
    const get = read.objectStore('sections').get('autosave')
    let seen: unknown
    get.onsuccess = () => {
      seen = get.result
    }
    await settle()
    expect(committed).toBe(true)
    expect(seen).toEqual({ at: 2 })
  })

  it('completes a get-only transaction and releases its successor', async () => {
    const idb = useIdb()
    idb.databases.set(
      'web-video-editor-autosave',
      new Map([['sections', new Map([['autosave', { at: 5 }]])]]),
    )
    const db = await openDb(idb)
    const first = db.transaction('sections', 'readwrite')
    let firstResult: unknown
    const firstGet = first.objectStore('sections').get('autosave')
    firstGet.onsuccess = () => {
      firstResult = firstGet.result
    }
    const second = db.transaction('sections', 'readwrite')
    let secondEntered = false
    const secondGet = second.objectStore('sections').get('autosave')
    secondGet.onsuccess = () => {
      secondEntered = true
    }
    // No abort: a get-only transaction commits when its handler returns.
    await settle()
    expect(firstResult).toEqual({ at: 5 })
    expect(secondEntered).toBe(true)
  })

  it('completes a transaction with no requests and releases the queue', async () => {
    const idb = useIdb()
    idb.databases.set('web-video-editor-autosave', new Map([['sections', new Map()]]))
    const first = await openDb(idb)
    const second = await openDb(idb)
    // No get and no put: the mock commits this on its next timer turn and must
    // not leave the store queue blocked for another connection.
    first.transaction('sections', 'readwrite')
    const write = second.transaction('sections', 'readwrite')
    write.objectStore('sections').put({ at: 9 }, 'autosave')
    await settle()
    expect(records(idb).get('autosave')).toEqual({ at: 9 })
  })

  it('completes an empty transaction after its queued predecessor', async () => {
    const idb = useIdb()
    idb.databases.set('web-video-editor-autosave', new Map([['sections', new Map()]]))
    const writer = await openDb(idb)
    const other = await openDb(idb)
    const order: string[] = []
    const write = writer.transaction('sections', 'readwrite')
    write.oncomplete = () => order.push('writer')
    const first = write.objectStore('sections').put({ at: 1 }, 'autosave')
    first.onsuccess = () => {
      write.objectStore('sections').put({ at: 2 }, 'autosave')
    }
    // No requests: this must still wait for the writer's queue entry, not
    // complete ahead of it.
    const empty = other.transaction('sections', 'readwrite')
    empty.oncomplete = () => order.push('empty')
    await settle()
    expect(order).toEqual(['writer', 'empty'])
  })

  it('keeps a new transaction open for a nested-microtask put', async () => {
    const idb = useIdb()
    idb.databases.set('web-video-editor-autosave', new Map([['sections', new Map()]]))
    const db = await openDb(idb)
    const transaction = db.transaction('sections', 'readwrite')
    const store = transaction.objectStore('sections')
    // Queue the put in a microtask queued by the creation task's microtask:
    // the transaction must stay open for the whole checkpoint.
    queueMicrotask(() => {
      queueMicrotask(() => store.put({ at: 4 }, 'autosave'))
    })
    await settle()
    expect(records(idb).get('autosave')).toEqual({ at: 4 })
  })

  it('lets an awaited get continuation enqueue a put in the same transaction', async () => {
    const idb = useIdb()
    idb.databases.set(
      'web-video-editor-autosave',
      new Map([['sections', new Map([['autosave', { at: 1 }]])]]),
    )
    const db = await openDb(idb)
    const transaction = db.transaction('sections', 'readwrite')
    const store = transaction.objectStore('sections')
    const read = await new Promise<unknown>((resolve) => {
      const get = store.get('autosave')
      get.onsuccess = () => resolve(get.result)
    })
    // The continuation runs after the success handler returns; the transaction
    // must still be open so this put lands.
    store.put({ at: 2, read }, 'autosave')
    await settle()
    expect(records(idb).get('autosave')).toEqual({ at: 2, read: { at: 1 } })
  })

  it('keeps an aborted transaction barrier until its predecessor settles', async () => {
    const idb = useIdb()
    idb.databases.set('web-video-editor-autosave', new Map([['sections', new Map()]]))
    const writer = await openDb(idb)
    const other = await openDb(idb)
    const write = writer.transaction('sections', 'readwrite')
    let committed = false
    write.oncomplete = () => {
      committed = true
    }
    const first = write.objectStore('sections').put({ at: 1 }, 'autosave')
    first.onsuccess = () => {
      write.objectStore('sections').put({ at: 2 }, 'autosave')
    }
    const abandoned = other.transaction('sections', 'readwrite')
    let abortSeen = false
    abandoned.onabort = () => {
      abortSeen = true
    }
    abandoned.abort()
    const successor = other.transaction('sections', 'readwrite')
    let seen: unknown
    const get = successor.objectStore('sections').get('autosave')
    get.onsuccess = () => {
      seen = get.result
    }
    await settle()
    // The abort is reported at once, but the next transaction still waits for
    // the writer, so it reads the committed value rather than undefined.
    expect(abortSeen).toBe(true)
    expect(committed).toBe(true)
    expect(seen).toEqual({ at: 2 })
  })

  it('rejects puts in a readonly transaction and still reads', async () => {
    const idb = useIdb()
    idb.databases.set(
      'web-video-editor-autosave',
      new Map([['sections', new Map([['autosave', { at: 1 }]])]]),
    )
    const db = await openDb(idb)
    const transaction = db.transaction('sections', 'readonly')
    const store = transaction.objectStore('sections')
    let seen: unknown
    const get = store.get('autosave')
    get.onsuccess = () => {
      seen = get.result
    }
    let refused: unknown
    try {
      store.put({ at: 2 }, 'autosave')
    } catch (error) {
      refused = error
    }
    await settle()
    expect((refused as Error).name).toBe('ReadOnlyError')
    expect(seen).toEqual({ at: 1 })
    expect(records(idb).get('autosave')).toEqual({ at: 1 })
  })

  it('stages puts until commit and discards them on abort', async () => {
    const idb = useIdb()
    idb.databases.set('web-video-editor-autosave', new Map([['sections', new Map()]]))
    const db = await openDb(idb)
    const staged = db.transaction('sections', 'readwrite')
    let stagedAtSuccess = false
    let abortSeen = false
    staged.onabort = () => {
      abortSeen = true
    }
    const put = staged.objectStore('sections').put({ at: 1 }, 'autosave')
    put.onsuccess = () => {
      stagedAtSuccess = records(idb).has('autosave')
      staged.abort()
    }
    await settle()
    expect(stagedAtSuccess).toBe(false)
    expect(abortSeen).toBe(true)
    expect(records(idb).has('autosave')).toBe(false)
    expect(() => staged.abort()).toThrow('The transaction is finished')
    // A closed connection rejects new transactions but an open one commits.
    const live = await openDb(idb)
    const committing = live.transaction('sections', 'readwrite')
    committing.objectStore('sections').put({ at: 2 }, 'autosave')
    await settle()
    expect(records(idb).get('autosave')).toEqual({ at: 2 })
    live.close()
    expect(() => live.transaction('sections', 'readwrite')).toThrow('The database is closed')
  })

  it('snapshots puts and clones gets', async () => {
    const idb = useIdb()
    idb.databases.set('web-video-editor-autosave', new Map([['sections', new Map()]]))
    const db = await openDb(idb)
    const value = { at: 1, nested: { n: 1 } }
    const writer = db.transaction('sections', 'readwrite')
    writer.objectStore('sections').put(value, 'autosave')
    value.at = 99
    value.nested.n = 99
    await settle()
    expect(records(idb).get('autosave')).toEqual({ at: 1, nested: { n: 1 } })
    const reader = db.transaction('sections', 'readwrite')
    let seen: unknown
    const get = reader.objectStore('sections').get('autosave')
    get.onsuccess = () => {
      seen = get.result
      ;(seen as { at: number }).at = 7
    }
    await settle()
    expect(seen).toEqual({ at: 7, nested: { n: 1 } })
    expect(records(idb).get('autosave')).toEqual({ at: 1, nested: { n: 1 } })
  })

  it('aborts a transaction when a request handler throws', async () => {
    const idb = useIdb()
    idb.databases.set('web-video-editor-autosave', new Map([['sections', new Map()]]))
    const db = await openDb(idb)
    const writer = db.transaction('sections', 'readwrite')
    const put = writer.objectStore('sections').put({ at: 1 }, 'autosave')
    put.onsuccess = () => {
      throw new Error('put handler failed')
    }
    const successor = db.transaction('sections', 'readwrite')
    successor.objectStore('sections').put({ at: 2 }, 'autosave')
    await settle()
    expect(idb.aborts).toBe(1)
    expect(records(idb).get('autosave')).toEqual({ at: 2 })
    const reader = db.transaction('sections', 'readwrite')
    const get = reader.objectStore('sections').get('autosave')
    get.onsuccess = () => {
      throw new Error('get handler failed')
    }
    const afterGet = db.transaction('sections', 'readwrite')
    afterGet.objectStore('sections').put({ at: 3 }, 'autosave')
    await settle()
    expect(idb.aborts).toBe(2)
    expect(records(idb).get('autosave')).toEqual({ at: 3 })
    idb.failRead = true
    const failedRead = db.transaction('sections', 'readwrite')
    const readError = failedRead.objectStore('sections').get('autosave')
    readError.onerror = () => {
      throw new Error('read error handler failed')
    }
    const afterRead = db.transaction('sections', 'readwrite')
    afterRead.objectStore('sections').put({ at: 4 }, 'autosave')
    await settle()
    expect(idb.aborts).toBe(3)
    expect(records(idb).get('autosave')).toEqual({ at: 4 })
  })

  it('emits request, transaction error, and abort for a failed read', async () => {
    const idb = useIdb()
    idb.databases.set('web-video-editor-autosave', new Map([['sections', new Map()]]))
    const db = await openDb(idb)
    const transaction = db.transaction('sections', 'readwrite')
    const events: string[] = []
    transaction.onerror = () => events.push('transaction-error')
    transaction.onabort = () => events.push('transaction-abort')
    transaction.objectStore('sections').put({ at: 1 }, 'autosave')
    idb.failRead = true
    const get = transaction.objectStore('sections').get('autosave')
    get.onerror = () => events.push(`request-error:${(get.error as Error).name}`)
    const successor = db.transaction('sections', 'readwrite')
    const successorStore = successor.objectStore('sections')
    let successorSaw: unknown = 'not-read'
    const successorRead = successorStore.get('autosave')
    successorRead.onsuccess = () => {
      successorSaw = successorRead.result
      successorStore.put({ at: 2 }, 'autosave')
    }
    await settle()
    expect(events).toEqual(['request-error:Error', 'transaction-error', 'transaction-abort'])
    // Read failure and abort are two centralized transaction deliveries; the
    // successor then completes once.
    expect(idb.events).toBe(3)
    // The successor sees the failed transaction's staged put was rolled back.
    expect(successorSaw).toBeUndefined()
    expect(records(idb).get('autosave')).toEqual({ at: 2 })
  })

  it('rejects queued requests with AbortError before onabort', async () => {
    const idb = useIdb()
    idb.databases.set('web-video-editor-autosave', new Map([['sections', new Map()]]))
    const db = await openDb(idb)
    const transaction = db.transaction('sections', 'readwrite')
    const events: string[] = []
    transaction.onerror = () => events.push('transaction-error')
    transaction.onabort = () => events.push('transaction-abort')
    let abortReturned = false
    const put = transaction.objectStore('sections').put({ at: 1 }, 'autosave')
    put.onerror = () =>
      events.push(
        `request-error:${(put.error as Error).name}:${abortReturned ? 'deferred' : 'sync'}`,
      )
    transaction.abort()
    abortReturned = true
    await settle()
    expect(events).toEqual([
      'request-error:AbortError:deferred',
      'transaction-error',
      'transaction-abort',
    ])
    expect(idb.events).toBe(2)
    expect(records(idb).has('autosave')).toBe(false)
    // An abort with no pending request emits no request error.
    const empty = db.transaction('sections', 'readwrite')
    let emptyErrors = 0
    empty.onerror = () => {
      emptyErrors += 1
    }
    empty.onabort = () => {
      emptyErrors += 100
    }
    empty.abort()
    await settle()
    expect(emptyErrors).toBe(100)
    expect(idb.events).toBe(3)
  })

  it('rolls back a failed upgrade and preserves the prior schema', async () => {
    const idb = useIdb()
    idb.databases.set(
      'web-video-editor-autosave',
      new Map([['sections', new Map([['autosave', { at: 1 }]])]]),
    )
    const first = await openDb(idb)
    first.close()
    const request = idb.factory.open('web-video-editor-autosave', 2)
    let failedConnection: FakeIdbDatabase | undefined
    let refused: unknown
    request.onupgradeneeded = () => {
      failedConnection = request.result
      try {
        request.result.transaction('sections', 'readwrite')
      } catch (error) {
        refused = error
      }
      request.result.createObjectStore('extra')
      throw new Error('upgrade failed')
    }
    const error = await new Promise<unknown>((resolve) => {
      request.onsuccess = () => resolve(null)
      request.onerror = () => resolve(request.error)
    })
    expect((error as Error).message).toBe('upgrade failed')
    expect((refused as Error).name).toBe('InvalidStateError')
    // The failed open closes its provisional connection, so no transaction can
    // reach the rolled-back store map through it.
    expect(() => failedConnection!.transaction('sections', 'readwrite')).toThrow(
      'The database is closed',
    )
    expect(() => failedConnection!.createObjectStore('late')).toThrow(
      'only allowed during an upgrade',
    )
    // The rejected transaction never joined the queue or wrote a record.
    expect(records(idb).get('autosave')).toEqual({ at: 1 })
    expect(idb.databases.get('web-video-editor-autosave')?.has('extra')).toBe(false)
    const fresh = await openDb(idb)
    let seen: unknown
    const read = fresh.transaction('sections', 'readonly').objectStore('sections').get('autosave')
    read.onsuccess = () => {
      seen = read.result
    }
    await settle()
    expect(seen).toEqual({ at: 1 })
    fresh.close()
    const retry = idb.factory.open('web-video-editor-autosave', 2)
    let upgrades = 0
    retry.onupgradeneeded = () => {
      upgrades += 1
    }
    await new Promise<void>((resolve, reject) => {
      retry.onsuccess = () => resolve()
      retry.onerror = () => reject(retry.error)
    })
    expect(upgrades).toBe(1)
    expect(retry.result.objectStoreNames.contains('sections')).toBe(true)
    expect(retry.result.objectStoreNames.contains('extra')).toBe(false)
    const normal = retry.result.transaction('sections', 'readwrite')
    normal.objectStore('sections').put({ at: 2 }, 'autosave')
    await settle()
    expect(records(idb).get('autosave')).toEqual({ at: 2 })
  })

  it('rejects requests from a later timer while the transaction is queued', async () => {
    const idb = useIdb()
    idb.databases.set('web-video-editor-autosave', new Map([['sections', new Map()]]))
    const db = await openDb(idb)
    const writer = db.transaction('sections', 'readwrite')
    const first = writer.objectStore('sections').put({ at: 1 }, 'autosave')
    first.onsuccess = () => {
      writer.objectStore('sections').put({ at: 2 }, 'autosave')
    }
    const queued = db.transaction('sections', 'readwrite')
    await new Promise((resolve) => setTimeout(resolve, 0))
    const store = queued.objectStore('sections')
    // The handle stays usable after the active window closes, but issuing a
    // request through it does not.
    expect(() => store.get('autosave')).toThrow('The transaction is inactive')
    expect(() => store.put({ at: 3 }, 'autosave')).toThrow('The transaction is inactive')
    await settle()
    expect(records(idb).get('autosave')).toEqual({ at: 2 })
  })

  it('rejects a request from a timer scheduled before the transaction', async () => {
    const idb = useIdb()
    idb.databases.set('web-video-editor-autosave', new Map([['sections', new Map()]]))
    const db = await openDb(idb)
    let write: (() => void) | null = null
    let error: Error | null = null
    const earlierTimer = new Promise<void>((resolve) => {
      setTimeout(() => {
        try {
          write?.()
        } catch (caught) {
          error = caught as Error
        }
        resolve()
      }, 0)
    })
    const transaction = db.transaction('sections', 'readwrite')
    const store = transaction.objectStore('sections')
    write = () => {
      store.put({ at: 1 }, 'autosave')
    }
    await earlierTimer
    // The timer was scheduled before the creation task, so it is a later task
    // even though it runs before the checkpoint timer.
    expect(error).not.toBeNull()
    expect(error!.name).toBe('TransactionInactiveError')
    await settle()
    expect(records(idb).has('autosave')).toBe(false)
  })

  it('rejects a microtask queued from a timer scheduled before the transaction', async () => {
    const idb = useIdb()
    idb.databases.set('web-video-editor-autosave', new Map([['sections', new Map()]]))
    const db = await openDb(idb)
    let write: (() => void) | null = null
    let error: Error | null = null
    let ran = false
    const earlierTimer = new Promise<void>((resolve) => {
      setTimeout(() => {
        queueMicrotask(() => {
          ran = true
          try {
            write?.()
          } catch (caught) {
            error = caught as Error
          }
          resolve()
        })
      }, 0)
    })
    const transaction = db.transaction('sections', 'readwrite')
    const store = transaction.objectStore('sections')
    write = () => {
      store.put({ at: 1 }, 'autosave')
    }
    await earlierTimer
    // The timer that queued this microtask is a later task than the creation
    // task, so its microtask cannot borrow the creation window.
    expect(ran).toBe(true)
    expect(error).not.toBeNull()
    expect(error!.name).toBe('TransactionInactiveError')
    await settle()
    expect(records(idb).has('autosave')).toBe(false)
  })

  it('keeps a transaction active for a microtask queued before it', async () => {
    const idb = useIdb()
    idb.databases.set('web-video-editor-autosave', new Map([['sections', new Map()]]))
    const db = await openDb(idb)
    let write: (() => void) | null = null
    let error: Error | null = null
    let ran = false
    queueMicrotask(() => {
      ran = true
      try {
        write?.()
      } catch (caught) {
        error = caught as Error
      }
    })
    const transaction = db.transaction('sections', 'readwrite')
    const store = transaction.objectStore('sections')
    write = () => {
      store.put({ at: 1 }, 'autosave')
    }
    await settle()
    // A microtask queued before the transaction still runs in the creation
    // task's checkpoint, which native IndexedDB keeps active.
    expect(ran).toBe(true)
    expect(error).toBeNull()
    expect(records(idb).get('autosave')).toEqual({ at: 1 })
  })

  it('keeps a transaction active for a nested microtask before the checkpoint ends', async () => {
    const idb = useIdb()
    idb.databases.set('web-video-editor-autosave', new Map([['sections', new Map()]]))
    const db = await openDb(idb)
    let write: (() => void) | null = null
    let error: Error | null = null
    let ran = false
    queueMicrotask(() => {
      queueMicrotask(() => {
        ran = true
        try {
          write?.()
        } catch (caught) {
          error = caught as Error
        }
      })
    })
    const transaction = db.transaction('sections', 'readwrite')
    const store = transaction.objectStore('sections')
    write = () => {
      store.put({ at: 1 }, 'autosave')
    }
    await settle()
    // The creation window lasts through the full checkpoint, including work
    // queued by an earlier microtask.
    expect(ran).toBe(true)
    expect(error).toBeNull()
    expect(records(idb).get('autosave')).toEqual({ at: 1 })
  })

  it('keeps an earlier transaction active when a later one is created', async () => {
    const idb = useIdb()
    idb.databases.set('web-video-editor-autosave', new Map([['sections', new Map()]]))
    const db = await openDb(idb)
    const first = db.transaction('sections', 'readwrite')
    const second = db.transaction('sections', 'readwrite')
    // Both transactions were created in this task, so the first remains
    // eligible even after the second one installed its own context.
    first.objectStore('sections').put({ at: 1 }, 'autosave')
    second.objectStore('sections').put({ at: 2 }, 'other')
    await settle()
    expect(records(idb).get('autosave')).toEqual({ at: 1 })
    expect(records(idb).get('other')).toEqual({ at: 2 })
  })

  it('keeps a queued transaction active inside a request callback', async () => {
    const idb = useIdb()
    idb.databases.set('web-video-editor-autosave', new Map([['sections', new Map()]]))
    const writer = await openDb(idb)
    const reader = await openDb(idb)
    const write = writer.transaction('sections', 'readwrite')
    const first = write.objectStore('sections').put({ at: 1 }, 'seed')
    first.onsuccess = () => {
      write.objectStore('sections').put({ at: 2 }, 'seed')
    }
    const queued = reader.transaction('sections', 'readwrite')
    const store = queued.objectStore('sections')
    let seen: unknown
    const get = store.get('seed')
    get.onsuccess = () => {
      seen = get.result
      store.put({ at: 3, read: seen }, 'autosave')
    }
    await settle()
    expect(seen).toEqual({ at: 2 })
    expect(records(idb).get('autosave')).toEqual({ at: 3, read: { at: 2 } })
  })

  it('keeps a queued transaction active through an awaited request callback', async () => {
    const idb = useIdb()
    idb.databases.set('web-video-editor-autosave', new Map([['sections', new Map()]]))
    const writer = await openDb(idb)
    const reader = await openDb(idb)
    const write = writer.transaction('sections', 'readwrite')
    const first = write.objectStore('sections').put({ at: 1 }, 'seed')
    first.onsuccess = () => {
      write.objectStore('sections').put({ at: 2 }, 'seed')
    }
    const queued = reader.transaction('sections', 'readwrite')
    const store = queued.objectStore('sections')
    let seen: unknown
    const get = store.get('seed')
    get.onsuccess = async () => {
      seen = get.result
      await Promise.resolve()
      store.put({ at: 3, read: seen }, 'autosave')
    }
    await settle()
    expect(seen).toEqual({ at: 2 })
    expect(records(idb).get('autosave')).toEqual({ at: 3, read: { at: 2 } })
  })

  it('keeps a queued transaction active after awaiting a read promise', async () => {
    const idb = useIdb()
    idb.databases.set('web-video-editor-autosave', new Map([['sections', new Map()]]))
    const writer = await openDb(idb)
    const reader = await openDb(idb)
    const write = writer.transaction('sections', 'readwrite')
    const first = write.objectStore('sections').put({ at: 1 }, 'seed')
    first.onsuccess = () => {
      write.objectStore('sections').put({ at: 2 }, 'seed')
    }
    const queued = reader.transaction('sections', 'readwrite')
    const store = queued.objectStore('sections')
    let resolveRead: (() => void) | null = null
    const readPromise = new Promise<void>((resolve) => {
      resolveRead = resolve
    })
    let seen: unknown
    const get = store.get('seed')
    get.onsuccess = async () => {
      seen = get.result
      queueMicrotask(() => resolveRead?.())
      await readPromise
      store.put({ at: 3, read: seen }, 'autosave')
    }
    await settle()
    expect(seen).toEqual({ at: 2 })
    expect(records(idb).get('autosave')).toEqual({ at: 3, read: { at: 2 } })
  })

  it('deactivates a queued transaction after a setImmediate continuation', async () => {
    const idb = useIdb()
    idb.databases.set('web-video-editor-autosave', new Map([['sections', new Map()]]))
    const writer = await openDb(idb)
    const reader = await openDb(idb)
    const write = writer.transaction('sections', 'readwrite')
    const first = write.objectStore('sections').put({ at: 1 }, 'seed')
    first.onsuccess = () => {
      write.objectStore('sections').put({ at: 2 }, 'seed')
    }
    const queued = reader.transaction('sections', 'readwrite')
    const store = queued.objectStore('sections')
    let error: Error | null = null
    const get = store.get('seed')
    get.onsuccess = async () => {
      await new Promise<void>((resolve) => setImmediate(resolve))
      try {
        store.put({ at: 3 }, 'autosave')
      } catch (caught) {
        error = caught as Error
      }
    }
    await settle()
    // The callback's task ended before the setImmediate continuation, so the
    // queued transaction is no longer active even though it has not committed.
    expect(error).not.toBeNull()
    expect(error!.name).toBe('TransactionInactiveError')
    expect(records(idb).get('autosave')).toBeUndefined()
    expect(records(idb).get('seed')).toEqual({ at: 2 })
  })

  it('keeps a queued get callback active through nested microtasks', async () => {
    const idb = useIdb()
    idb.databases.set('web-video-editor-autosave', new Map([['sections', new Map()]]))
    const writer = await openDb(idb)
    const reader = await openDb(idb)
    const write = writer.transaction('sections', 'readwrite')
    const first = write.objectStore('sections').put({ at: 1 }, 'seed')
    first.onsuccess = () => {
      write.objectStore('sections').put({ at: 2 }, 'seed')
    }
    const queued = reader.transaction('sections', 'readwrite')
    const store = queued.objectStore('sections')
    let seen: unknown
    const get = store.get('seed')
    get.onsuccess = () => {
      seen = get.result
      queueMicrotask(() => {
        queueMicrotask(() => {
          store.put({ at: 3, read: seen }, 'autosave')
        })
      })
    }
    await settle()
    expect(seen).toEqual({ at: 2 })
    expect(records(idb).get('autosave')).toEqual({ at: 3, read: { at: 2 } })
  })

  it('lets a queued get finish before a commit failure aborts', async () => {
    const idb = useIdb()
    idb.databases.set('web-video-editor-autosave', new Map([['sections', new Map()]]))
    const db = await openDb(idb)
    const transaction = db.transaction('sections', 'readwrite')
    const events: string[] = []
    transaction.onabort = () => events.push('abort')
    transaction.objectStore('sections').put({ at: 1 }, 'autosave')
    idb.failCommit = true
    const get = transaction.objectStore('sections').get('autosave')
    get.onsuccess = () => events.push(`get:${JSON.stringify(get.result)}`)
    const successor = db.transaction('sections', 'readwrite')
    successor.objectStore('sections').put({ at: 2 }, 'autosave')
    await settle()
    expect(events).toEqual(['get:{"at":1}', 'abort'])
    expect(records(idb).get('autosave')).toEqual({ at: 2 })
  })

  it('keeps the commit-failure flag for a transaction with no staged put', async () => {
    const idb = useIdb()
    idb.databases.set('web-video-editor-autosave', new Map([['sections', new Map()]]))
    const db = await openDb(idb)
    idb.failCommit = true
    const empty = db.transaction('sections', 'readwrite')
    let emptyCompleted = false
    empty.oncomplete = () => {
      emptyCompleted = true
    }
    await settle()
    expect(emptyCompleted).toBe(true)
    expect(idb.failCommit).toBe(true)
    const failing = db.transaction('sections', 'readwrite')
    const events: string[] = []
    failing.onabort = () => events.push('abort')
    failing.objectStore('sections').put({ at: 1 }, 'autosave')
    await settle()
    expect(events).toEqual(['abort'])
    expect(idb.failCommit).toBe(false)
    expect(records(idb).has('autosave')).toBe(false)
  })

  it('keeps a get issued before a put reading the old value', async () => {
    const idb = useIdb()
    idb.databases.set(
      'web-video-editor-autosave',
      new Map([['sections', new Map([['autosave', { at: 1 }]])]]),
    )
    const db = await openDb(idb)
    const transaction = db.transaction('sections', 'readwrite')
    const store = transaction.objectStore('sections')
    let seen: unknown
    const get = store.get('autosave')
    get.onsuccess = () => {
      seen = get.result
    }
    store.put({ at: 2 }, 'autosave')
    await settle()
    expect(seen).toEqual({ at: 1 })
    expect(records(idb).get('autosave')).toEqual({ at: 2 })
  })

  it('rejects a put after the transaction finishes or aborts', async () => {
    const idb = useIdb()
    idb.databases.set('web-video-editor-autosave', new Map([['sections', new Map()]]))
    const db = await openDb(idb)
    const aborted = db.transaction('sections', 'readwrite')
    const abortedStore = aborted.objectStore('sections')
    aborted.abort()
    expect(() => aborted.objectStore('sections')).toThrow('The transaction is finished')
    expect(() => abortedStore.put({ at: 1 }, 'autosave')).toThrow('The transaction is finished')
    const completed = db.transaction('sections', 'readwrite')
    const completedStore = completed.objectStore('sections')
    completedStore.put({ at: 2 }, 'autosave')
    await settle()
    expect(() => completed.objectStore('sections')).toThrow('The transaction is finished')
    expect(() => completedStore.put({ at: 3 }, 'autosave')).toThrow('The transaction is finished')
    expect(records(idb).get('autosave')).toEqual({ at: 2 })
  })

  it('reports a failed owner record after the serialized section ran', async () => {
    useIdb()
    const set = vi.spyOn(localStorageMock, 'setItem').mockImplementation((key, value) => {
      if (key === OWNER_KEY) throw new Error('The quota has been exceeded')
      storage.set(key, value)
    })
    try {
      expect(await claimAutosaveOwnership()).toMatchObject({
        ok: false,
        reason: 'This browser could not record autosave ownership.',
      })
    } finally {
      set.mockRestore()
    }
  })

  it('fails a required section closed when no serialization primitive exists at all', async () => {
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('indexedDB', undefined)
    await expect(markInstallPending('proj_a', 'install-test-1')).resolves.toBeUndefined()
    // The in-memory retry still protects this session, but nothing durable
    // was written without a serializing section.
    expect(hasPendingInstall()).toBe(true)
    expect(readPendingInstallRecords()).toEqual([])
  })

  it('writes the durable pending marker when coordination is available', async () => {
    await expect(markInstallPending('proj_a', 'install-test-1')).resolves.toBeUndefined()
    expect(hasPendingInstall()).toBe(true)
    expect(readPendingInstallRecords()).toEqual([
      { projectId: 'proj_a', installId: 'install-test-1', hadInstallClaims: false },
    ])
  })

  it('runs a best-effort section directly when IndexedDB is absent', async () => {
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('indexedDB', undefined)
    storage.set(AUTOSAVE_KEY, '{"slot":true}')
    await clearAutosave()
    expect(readAutosave()).toBeNull()
  })
})

describe('autosave branch matrix (0.29.0)', () => {
  function stubWindow(
    options: { keepChannel?: boolean } = {},
  ): Map<string, (event: StorageEvent) => void> {
    const listeners = new Map<string, (event: StorageEvent) => void>()
    if (!options.keepChannel) vi.stubGlobal('BroadcastChannel', undefined)
    vi.stubGlobal('window', {
      addEventListener: (type: string, listener: (event: StorageEvent) => void) => {
        listeners.set(type, listener)
      },
      removeEventListener: (type: string) => listeners.delete(type),
    })
    return listeners
  }

  /**
   * Resolves after the next owner-record read through the serialized section.
   * Waiting on this instead of the paused flag proves the recheck actually ran,
   * because a paused tab is already paused before the event is handled.
   */
  function ownerReadProbe(): { next: () => Promise<void>; restore: () => void } {
    let resolveNext: (() => void) | null = null
    const original = localStorageMock.getItem
    const spy = vi.spyOn(localStorageMock, 'getItem').mockImplementation((key: string) => {
      const value = original(key)
      if (key === OWNER_KEY) {
        const resolve = resolveNext
        resolveNext = null
        resolve?.()
      }
      return value
    })
    return {
      next: () =>
        new Promise<void>((resolve) => {
          resolveNext = resolve
        }),
      restore: () => spy.mockRestore(),
    }
  }

  async function claimed(): Promise<{
    tabId: string
    epoch: number
    sessionId: string
    tokenHash: string
  }> {
    expect(await claimAutosaveOwnership()).toMatchObject({ ok: true })
    return JSON.parse(storage.get(OWNER_KEY)!) as {
      tabId: string
      epoch: number
      sessionId: string
      tokenHash: string
    }
  }

  it('does not clear the slot while this tab is paused', async () => {
    const cleanup = initAutosaveCoordination()
    const other = new FakeChannel(AUTOSAVE_CHANNEL_NAME)
    try {
      storage.set(AUTOSAVE_KEY, '{"slot":true}')
      other.postMessage({ type: 'pause', requestId: 'r-clear' })
      expect(isAutosavePaused()).toBe(true)
      await clearAutosave()
      expect(readAutosave()).toBe('{"slot":true}')
    } finally {
      cleanup()
    }
  })

  it('treats a missing slot as already clear', async () => {
    await expect(clearAutosave()).resolves.toBeUndefined()
    expect(readAutosave()).toBeNull()
  })

  it.each([
    ['not json', 'not json'],
    ['a number', '5'],
    ['an invalid record shape', '{"tabId":1}'],
  ])('ignores %s in the owner record', async (_label, raw) => {
    storage.set(OWNER_KEY, raw)
    expect(await claimAutosaveOwnership()).toMatchObject({ ok: true })
  })

  it('keeps a foreign owner record when releasing this tab', async () => {
    const record = await claimed()
    storage.set(OWNER_KEY, JSON.stringify({ ...record, tabId: 'other-tab', epoch: 9 }))
    releaseAutosaveOwnership(record.epoch)
    expect(storage.has(OWNER_KEY)).toBe(true)
  })

  it('falls back to a time and random token without crypto.randomUUID', async () => {
    vi.stubGlobal('crypto', {})
    expect(await claimAutosaveOwnership()).toMatchObject({ ok: true })
    expect(storage.has(OWNER_KEY)).toBe(true)
  })

  it('serializes through IndexedDB when navigator itself is absent', async () => {
    const idb = createFakeIndexedDb()
    vi.stubGlobal('navigator', undefined)
    vi.stubGlobal('indexedDB', idb.factory)
    expect(await claimAutosaveOwnership()).toMatchObject({ ok: true })
  })

  it('keeps a second coordination start inert', () => {
    const first = initAutosaveCoordination()
    const second = initAutosaveCoordination()
    second()
    first()
  })

  it('pauses with no known other tabs and reports success on the probe timeout', async () => {
    vi.useFakeTimers()
    try {
      const cleanup = initAutosaveCoordination()
      try {
        const locks = navigator.locks as unknown as { query?: unknown }
        locks.query = undefined
        const pending = pauseOtherAutosaveTabs()
        await vi.advanceTimersByTimeAsync(300)
        expect(await pending).toMatchObject({ ok: true })
      } finally {
        cleanup()
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores malformed and unrelated presence names', async () => {
    vi.useFakeTimers()
    try {
      const locks = Object.assign(new FakeLockManager(), {
        query: async () => ({
          held: [{ name: 5 }, { name: 'videoh-autosave-tab:' }, { name: 'other' }],
        }),
      })
      vi.stubGlobal('navigator', { locks })
      const cleanup = initAutosaveCoordination()
      try {
        const pending = pauseOtherAutosaveTabs()
        await vi.advanceTimersByTimeAsync(300)
        expect(await pending).toMatchObject({ ok: true })
      } finally {
        cleanup()
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels a pending debounced write when another tab pauses this one', async () => {
    const cancel = vi.fn()
    setAutosaveCancel(cancel)
    const cleanup = initAutosaveCoordination()
    const other = new FakeChannel(AUTOSAVE_CHANNEL_NAME)
    try {
      other.postMessage({ type: 'pause', requestId: 'r-cancel' })
      expect(cancel).toHaveBeenCalledTimes(1)
    } finally {
      cleanup()
    }
  })

  it('reports autosave off when a resume finds another tab owns the slot', async () => {
    storage.set(AUTOSAVE_KEY, '{"slot":true}')
    readValidAutosave()
    const cleanup = initAutosaveCoordination()
    const other = new FakeChannel(AUTOSAVE_CHANNEL_NAME)
    try {
      other.postMessage({ type: 'pause', requestId: 'r-resume' })
      // Another tab claims while this tab is paused.
      storage.set(
        OWNER_KEY,
        JSON.stringify({
          tabId: 'other-tab',
          sessionId: 'other-session',
          tokenHash: 'deadbeef',
          epoch: 4,
          heartbeatAt: Date.now(),
        }),
      )
      other.postMessage({ type: 'resume', requestId: 'r-resume' })
      await vi.waitFor(() => expect(useEditorStore.getState().autosaveStatus).toBe('error'))
    } finally {
      cleanup()
    }
  })

  it('reports an error when a resume write hits a full quota', async () => {
    storage.set(AUTOSAVE_KEY, '{"slot":true}')
    readValidAutosave()
    const cleanup = initAutosaveCoordination()
    const other = new FakeChannel(AUTOSAVE_CHANNEL_NAME)
    vi.stubGlobal('localStorage', {
      ...localStorageMock,
      setItem: () => {
        throw new Error('quota')
      },
    })
    try {
      other.postMessage({ type: 'pause', requestId: 'r-resume-error' })
      other.postMessage({ type: 'resume', requestId: 'r-resume-error' })
      await vi.waitFor(() => expect(useEditorStore.getState().autosaveStatus).toBe('error'))
    } finally {
      cleanup()
    }
  })

  it('stays paused when a recheck finds a fresh owner from another tab', async () => {
    const listeners = stubWindow()
    storage.set(AUTOSAVE_KEY, '{"slot":true}')
    readValidAutosave()
    const cleanup = initAutosaveCoordination()
    const probe = ownerReadProbe()
    try {
      const record = {
        tabId: 'other-tab',
        sessionId: 'other-session',
        tokenHash: 'deadbeef',
        epoch: 1,
        heartbeatAt: Date.now(),
      }
      storage.set(OWNER_KEY, JSON.stringify(record))
      listeners.get('storage')?.({
        key: OWNER_KEY,
        newValue: JSON.stringify(record),
      } as StorageEvent)
      expect(isAutosavePaused()).toBe(true)
      // A removed record is the recovery signal, but the owner is still fresh.
      const recheck = probe.next()
      listeners.get('storage')?.({ key: OWNER_KEY, newValue: null } as StorageEvent)
      await recheck
      // The read proves the serialized section ran; let its continuation settle.
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(isAutosavePaused()).toBe(true)
      expect(readOwner()).toMatchObject({ tabId: 'other-tab' })
    } finally {
      probe.restore()
      cleanup()
    }
  })

  it('stays paused when a removal recheck finds this tab on an older epoch', async () => {
    const listeners = stubWindow()
    const cleanup = initAutosaveCoordination()
    const record = await claimed()
    const probe = ownerReadProbe()
    try {
      // A fresh foreign record makes this tab read-only without a peer pause.
      const foreign = {
        tabId: 'other-tab',
        sessionId: 'other-session',
        tokenHash: 'deadbeef',
        epoch: record.epoch + 1,
        heartbeatAt: Date.now(),
      }
      storage.set(OWNER_KEY, JSON.stringify(foreign))
      listeners.get('storage')?.({
        key: OWNER_KEY,
        newValue: JSON.stringify(foreign),
      } as StorageEvent)
      expect(isAutosavePaused()).toBe(true)

      // The removal triggers a recheck, but the stored record now carries this
      // tab at a newer epoch than the claim, so it must stay read-only.
      const changed = { ...record, epoch: record.epoch + 1 }
      storage.set(OWNER_KEY, JSON.stringify(changed))
      const removalRecheck = probe.next()
      listeners.get('storage')?.({ key: OWNER_KEY, newValue: null } as StorageEvent)
      await removalRecheck
      // The read proves the serialized section ran; let its continuation settle.
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(isAutosavePaused()).toBe(true)
      expect(readOwner()).toMatchObject({ tabId: record.tabId, epoch: changed.epoch })
    } finally {
      probe.restore()
      cleanup()
    }
  })

  function readOwner(): Record<string, unknown> | null {
    const raw = storage.get(OWNER_KEY)
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null
  }

  it('ignores storage events for other keys and events while writable', async () => {
    const listeners = stubWindow()
    const cleanup = initAutosaveCoordination()
    try {
      listeners.get('storage')?.({ key: 'unrelated', newValue: 'x' } as StorageEvent)
      listeners.get('storage')?.({ key: OWNER_KEY, newValue: null } as StorageEvent)
      expect(isAutosavePaused()).toBe(false)
    } finally {
      cleanup()
    }
  })

  it('ignores a malformed ownership record in a storage event', async () => {
    const listeners = stubWindow()
    const cleanup = initAutosaveCoordination()
    try {
      listeners.get('storage')?.({ key: OWNER_KEY, newValue: '{"tabId":7}' } as StorageEvent)
      expect(isAutosavePaused()).toBe(false)
    } finally {
      cleanup()
    }
  })

  it('refuses a claim after another tab reported an import', async () => {
    const cleanup = initAutosaveCoordination()
    const other = new FakeChannel(AUTOSAVE_CHANNEL_NAME)
    try {
      other.postMessage({ type: 'imported' })
      expect(await claimAutosaveOwnership()).toMatchObject({
        ok: false,
        reason: 'This tab must reload before it can import a project.',
      })
    } finally {
      cleanup()
    }
  })

  it('refuses a claim while another import is pausing this tab', async () => {
    const cleanup = initAutosaveCoordination()
    const other = new FakeChannel(AUTOSAVE_CHANNEL_NAME)
    try {
      other.postMessage({ type: 'pause', requestId: 'r-claim' })
      expect(await claimAutosaveOwnership()).toMatchObject({
        ok: false,
        reason: expect.stringContaining('Another import is pausing this tab'),
      })
    } finally {
      cleanup()
    }
  })

  it('refuses a same-session claim when the old page answers the probe', async () => {
    const record = await claimed()
    resetAutosaveCoordinationForTests()
    storage.set(
      OWNER_KEY,
      JSON.stringify({ ...record, tabId: 'prior-page', epoch: 7, heartbeatAt: Date.now() }),
    )
    const cleanup = initAutosaveCoordination()
    const peer = new FakeChannel(AUTOSAVE_CHANNEL_NAME)
    peer.addEventListener('message', (event) => {
      const data = event.data as { type?: string; requestId?: string }
      if (data.type === 'probe-session' && data.requestId) {
        peer.postMessage({
          type: 'session-present',
          requestId: data.requestId,
          sessionId: record.sessionId,
        })
      }
    })
    try {
      expect(await claimAutosaveOwnership()).toMatchObject({
        ok: false,
        reason: expect.stringContaining('Another tab is saving this project'),
      })
    } finally {
      cleanup()
    }
  })

  it('takes over a stale same-session record after the probe times out', async () => {
    vi.useFakeTimers()
    try {
      const record = await claimed()
      resetAutosaveCoordinationForTests()
      storage.set(
        OWNER_KEY,
        JSON.stringify({ ...record, tabId: 'prior-page', epoch: 7, heartbeatAt: Date.now() }),
      )
      const cleanup = initAutosaveCoordination()
      try {
        const pending = claimAutosaveOwnership()
        await vi.advanceTimersByTimeAsync(300)
        expect(await pending).toMatchObject({ ok: true })
        // The takeover reclaims ownership for this tab with a newer epoch.
        const owner = JSON.parse(storage.get(OWNER_KEY)!) as { tabId: string; epoch: number }
        expect(owner.tabId).not.toBe('prior-page')
        expect(owner.epoch).toBeGreaterThan(7)
      } finally {
        cleanup()
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a newer epoch when an older import releases', async () => {
    const first = await claimAutosaveOwnership()
    const second = await claimAutosaveOwnership()
    if (!first.ok || !second.ok) throw new Error('claims must succeed')
    releaseAutosaveOwnership(first.epoch)
    expect(readRecord().epoch).toBe(second.epoch)
  })

  it('reports a queued project write as superseded when another project is live', async () => {
    const live = createDoc()
    useEditorStore.setState({ doc: { ...live, project: { ...live.project, id: 'proj_live' } } })
    expect(await writeAutosaveCooperatively('{"queued":true}', undefined, 'proj_other')).toBe(
      'superseded',
    )
    expect(readAutosave()).toBeNull()
  })

  it('refuses a write that became paused while queued', async () => {
    const cleanup = initAutosaveCoordination()
    const other = new FakeChannel(AUTOSAVE_CHANNEL_NAME)
    const locks = (navigator as unknown as { locks: FakeLockManager }).locks
    const original = locks.request.bind(locks)
    let releaseWrite: (() => void) | null = null
    let entered: (() => void) | null = null
    const requested = new Promise<void>((resolve) => {
      entered = resolve
    })
    let gate = false
    locks.request = ((
      name: string,
      options: never,
      callback: (lock: object | null) => Promise<unknown>,
    ) => {
      if (name !== AUTOSAVE_LOCK_NAME || !gate) return original(name, options, callback)
      gate = false
      return new Promise<unknown>((resolve, reject) => {
        entered?.()
        releaseWrite = () => {
          void original(name, options, callback).then(resolve, reject)
        }
      })
    }) as typeof locks.request
    try {
      // Let the initial ownership check settle before holding the write lock.
      await new Promise((resolve) => setTimeout(resolve, 0))
      gate = true
      const queued = writeAutosaveCooperatively('{"queued-paused":true}')
      await requested
      // The pause lands while the write waits for the lock, after its early
      // check but before the serialized section runs.
      other.postMessage({ type: 'pause', requestId: 'r-queued' })
      expect(isAutosavePaused()).toBe(true)
      releaseWrite!()
      expect(await queued).toBe('read-only')
      expect(readAutosave()).toBeNull()
    } finally {
      locks.request = original as typeof locks.request
      cleanup()
    }
  })

  it('reports an older sequence as superseded', async () => {
    expect(await writeAutosaveCooperatively('{"newer":true}')).toBe('saved')
    expect(await writeAutosaveCooperatively('{"older":true}', 0)).toBe('superseded')
    expect(readAutosave()).toBe('{"newer":true}')
  })

  it('drops an import fence that belongs to another project', async () => {
    const live = createDoc()
    useEditorStore.setState({ doc: { ...live, project: { ...live.project, id: 'proj_live' } } })
    requireAutosaveImportFence('proj_gone')
    expect(await writeAutosaveCooperatively('{"live":true}')).toBe('saved')
    expect(readAutosave()).toBe('{"live":true}')
    // The other project's fence is dropped before the live slot is written.
    expect(storage.has(IMPORT_KEY)).toBe(false)
  })

  it('re-establishes a vanished owner record before reporting a write saved', async () => {
    const record = await claimed()
    storage.delete(OWNER_KEY)
    expect(await writeAutosaveCooperatively('{"kept":true}')).toBe('saved')
    expect(readRecord().epoch).toBe(record.epoch + 1)
  })

  it('reports an error when the vanished owner record cannot be rewritten', async () => {
    await claimed()
    storage.delete(OWNER_KEY)
    vi.stubGlobal('localStorage', {
      ...localStorageMock,
      setItem: (key: string, value: string) => {
        if (key === OWNER_KEY) throw new Error('quota')
        storage.set(key, value)
      },
    })
    expect(await writeAutosaveCooperatively('{"lost":true}')).toBe('error')
  })

  it('stops executing slot retries after the attempt cap', async () => {
    vi.useFakeTimers()
    const live = createDoc()
    useEditorStore.setState({
      doc: { ...live, project: { ...live.project, id: 'proj_cap' } },
    })
    const json = JSON.stringify(serializeDoc(useEditorStore.getState().doc))
    let slotWrites = 0
    vi.stubGlobal('localStorage', {
      ...localStorageMock,
      setItem: (key: string, value: string) => {
        if (key === AUTOSAVE_KEY) {
          slotWrites += 1
          throw new Error('quota')
        }
        storage.set(key, value)
      },
    })
    try {
      queueAutosaveRetry(json, undefined, 'proj_cap')
      // Each pass must run before the next timer is scheduled, so the cap is
      // checked against executed attempts rather than synchronous requeues.
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await vi.advanceTimersByTimeAsync(3_100)
      }
      expect(slotWrites).toBe(5)
      expect(readAutosave()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reads non-object retry content as unknown rather than throwing', async () => {
    vi.useFakeTimers()
    try {
      const live = createDoc()
      useEditorStore.setState({ doc: { ...live, project: { ...live.project, id: 'proj_retry' } } })
      queueAutosaveRetry('5', undefined, 'proj_retry')
      await vi.advanceTimersByTimeAsync(3_100)
      expect(readAutosave()).toBe('5')
    } finally {
      vi.useRealTimers()
    }
  })

  it('refreshes the owner heartbeat while this tab still owns the slot', async () => {
    vi.useFakeTimers()
    try {
      const record = await claimed()
      const before = readOwner()?.heartbeatAt
      await vi.advanceTimersByTimeAsync(5_100)
      expect(readOwner()?.heartbeatAt).toBeGreaterThan(before as number)
      expect(readOwner()?.epoch).toBe(record.epoch)
    } finally {
      vi.useRealTimers()
    }
  })

  it('goes read-only on a heartbeat that finds a takeover record', async () => {
    vi.useFakeTimers()
    try {
      await claimed()
      storage.set(
        OWNER_KEY,
        JSON.stringify({
          tabId: 'other-tab',
          sessionId: 'other-session',
          tokenHash: 'deadbeef',
          epoch: 99,
          heartbeatAt: Date.now(),
        }),
      )
      await vi.advanceTimersByTimeAsync(5_100)
      expect(isAutosavePaused()).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops a heartbeat after a takeover already cleared ownership', async () => {
    vi.useFakeTimers()
    try {
      await claimed()
      expect(vi.getTimerCount()).toBe(1)
      storage.set(
        OWNER_KEY,
        JSON.stringify({
          tabId: 'other-tab',
          sessionId: 'other-session',
          tokenHash: 'deadbeef',
          epoch: 99,
          heartbeatAt: Date.now(),
        }),
      )
      expect(await writeAutosaveCooperatively('{"taken":true}')).toBe('read-only')
      // The heartbeat is gone; the one remaining timer is the armed ownership
      // recheck, which runs after the lease and must not write by itself.
      expect(vi.getTimerCount()).toBe(1)
      const locks = navigator.locks as unknown as FakeLockManager
      const request = vi.spyOn(locks, 'request')
      await vi.advanceTimersByTimeAsync(5_100)
      expect(request).not.toHaveBeenCalled()
      expect(isAutosavePaused()).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails a heartbeat closed when coordination disappears', async () => {
    vi.useFakeTimers()
    try {
      await claimed()
      vi.stubGlobal('navigator', {})
      vi.stubGlobal('indexedDB', undefined)
      await vi.advanceTimersByTimeAsync(5_100)
      expect(isAutosavePaused()).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores malformed coordination messages and unknown types', async () => {
    const cleanup = initAutosaveCoordination()
    const other = new FakeChannel(AUTOSAVE_CHANNEL_NAME)
    try {
      other.postMessage(null)
      other.postMessage({ type: 5 })
      other.postMessage({ type: 'unknown-type' })
      other.postMessage({ type: 'pause' })
      other.postMessage({ type: 'paused' })
      other.postMessage({ type: 'paused', requestId: 'missing', tabId: 'x' })
      other.postMessage({ type: 'session-present', requestId: 'nobody' })
      other.postMessage({ type: 'probe-session', requestId: 'r', sessionId: 'other-session' })
      expect(isAutosavePaused()).toBe(false)
    } finally {
      cleanup()
    }
  })

  it('answers a probe for this session and ignores the rest', async () => {
    const record = await claimed()
    resetAutosaveCoordinationForTests()
    storage.set(
      OWNER_KEY,
      JSON.stringify({ ...record, tabId: 'prior-page', epoch: 7, heartbeatAt: Date.now() }),
    )
    const cleanup = initAutosaveCoordination()
    const peer = new FakeChannel(AUTOSAVE_CHANNEL_NAME)
    try {
      peer.postMessage({ type: 'probe-session', requestId: 'r', sessionId: record.sessionId })
      await vi.waitFor(() =>
        expect(peer.received).toContainEqual({
          type: 'session-present',
          requestId: 'r',
          sessionId: record.sessionId,
        }),
      )
      const before = peer.received.length
      peer.postMessage({ type: 'probe-session', requestId: 'r2', sessionId: 'wrong' })
      peer.postMessage({ type: 'probe-session', sessionId: record.sessionId })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(peer.received.length).toBe(before)
      expect(peer.received).not.toContainEqual(
        expect.objectContaining({ type: 'session-present', requestId: 'r2' }),
      )
    } finally {
      cleanup()
    }
  })

  it('stays paused when a recovery finds a live owner after an abandoned pause', async () => {
    vi.useFakeTimers()
    try {
      readValidAutosave()
      const cleanup = initAutosaveCoordination()
      const other = new FakeChannel(AUTOSAVE_CHANNEL_NAME)
      try {
        other.postMessage({ type: 'pause', requestId: 'r-owned' })
        storage.set(
          OWNER_KEY,
          JSON.stringify({
            tabId: 'other-tab',
            sessionId: 'other-session',
            tokenHash: 'deadbeef',
            epoch: 5,
            heartbeatAt: Date.now() + 10_000,
          }),
        )
        await vi.advanceTimersByTimeAsync(20_000)
        expect(isAutosavePaused()).toBe(true)
      } finally {
        cleanup()
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a second pause request recovery timer from stacking', async () => {
    vi.useFakeTimers()
    try {
      readValidAutosave()
      const cleanup = initAutosaveCoordination()
      const other = new FakeChannel(AUTOSAVE_CHANNEL_NAME)
      try {
        other.postMessage({ type: 'pause', requestId: 'r-twice' })
        await vi.advanceTimersByTimeAsync(10_000)
        // A duplicate arrival must not reschedule the original deadline.
        other.postMessage({ type: 'pause', requestId: 'r-twice' })
        await vi.advanceTimersByTimeAsync(10_000)
        expect(isAutosavePaused()).toBe(false)
      } finally {
        cleanup()
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('stays paused while another honored pause remains after a recovery', async () => {
    vi.useFakeTimers()
    try {
      readValidAutosave()
      const cleanup = initAutosaveCoordination()
      const other = new FakeChannel(AUTOSAVE_CHANNEL_NAME)
      try {
        other.postMessage({ type: 'pause', requestId: 'r-one' })
        await vi.advanceTimersByTimeAsync(10_000)
        other.postMessage({ type: 'pause', requestId: 'r-two' })
        // The first request hits its recovery deadline while the second is
        // still honored, so the tab must stay paused.
        await vi.advanceTimersByTimeAsync(10_000)
        expect(isAutosavePaused()).toBe(true)
        // The second deadline then drops the last pause and resumes.
        await vi.advanceTimersByTimeAsync(10_000)
        expect(isAutosavePaused()).toBe(false)
      } finally {
        cleanup()
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('rechecks ownership when an abandoned pause finds this tab read-only', async () => {
    vi.useFakeTimers()
    try {
      storage.set(AUTOSAVE_KEY, '{"old":true}')
      readValidAutosave()
      // Keep the BroadcastChannel: the pause request must reach the tab, or
      // the resume assertion passes without ever entering the paused state.
      const listeners = stubWindow({ keepChannel: true })
      const cleanup = initAutosaveCoordination()
      const other = new FakeChannel(AUTOSAVE_CHANNEL_NAME)
      try {
        listeners.get('storage')?.({
          key: OWNER_KEY,
          newValue: JSON.stringify({
            tabId: 'other-tab',
            sessionId: 'other-session',
            tokenHash: 'deadbeef',
            epoch: 2,
            heartbeatAt: Date.now() - 60_000,
          }),
        } as StorageEvent)
        other.postMessage({ type: 'pause', requestId: 'r-readonly' })
        await vi.advanceTimersByTimeAsync(0)
        expect(other.received).toContainEqual(
          expect.objectContaining({ type: 'paused', requestId: 'r-readonly' }),
        )
        // Remove the stale record; the unchanged slot lets the tab resume.
        storage.delete(OWNER_KEY)
        await vi.advanceTimersByTimeAsync(20_000)
        // The read-only state is rechecked against the unchanged slot and clears.
        expect(isAutosavePaused()).toBe(false)
      } finally {
        cleanup()
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops an abandoned pause when the owner record is stale', async () => {
    vi.useFakeTimers()
    try {
      readValidAutosave()
      const cleanup = initAutosaveCoordination()
      const other = new FakeChannel(AUTOSAVE_CHANNEL_NAME)
      try {
        other.postMessage({ type: 'pause', requestId: 'r-stale' })
        storage.set(
          OWNER_KEY,
          JSON.stringify({
            tabId: 'other-tab',
            sessionId: 'other-session',
            tokenHash: 'deadbeef',
            epoch: 2,
            heartbeatAt: Date.now() - 60_000,
          }),
        )
        await vi.advanceTimersByTimeAsync(20_000)
        expect(isAutosavePaused()).toBe(false)
      } finally {
        cleanup()
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('pauses on an acquisition event after an import and ignores later events', async () => {
    const listeners = stubWindow({ keepChannel: true })
    const cleanup = initAutosaveCoordination()
    const other = new FakeChannel(AUTOSAVE_CHANNEL_NAME)
    try {
      other.postMessage({ type: 'imported' })
      expect(isAutosavePaused()).toBe(true)
      listeners.get('storage')?.({
        key: OWNER_KEY,
        newValue: JSON.stringify({
          tabId: 'other-tab',
          sessionId: 'other-session',
          tokenHash: 'deadbeef',
          epoch: 1,
          heartbeatAt: Date.now(),
        }),
      } as StorageEvent)
      expect(isAutosavePaused()).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('marks read-only when coordination starts after an import', () => {
    const cleanup = initAutosaveCoordination()
    const other = new FakeChannel(AUTOSAVE_CHANNEL_NAME)
    other.postMessage({ type: 'imported' })
    cleanup()
    const second = initAutosaveCoordination()
    second()
    expect(isAutosavePaused()).toBe(true)
  })

  it('clears a queued retry when coordination is torn down', async () => {
    vi.useFakeTimers()
    try {
      queueAutosaveRetry('{"queued":true}')
      const cleanup = initAutosaveCoordination()
      cleanup()
      await vi.advanceTimersByTimeAsync(3_100)
      expect(readAutosave()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('pauses without a channel and treats it as a local pause', async () => {
    await expect(pauseOtherAutosaveTabs()).resolves.toEqual({ ok: true, requestId: 'local' })
  })

  it('keeps the current epoch when a stale record matches the release epoch', async () => {
    const record = await claimed()
    storage.set(OWNER_KEY, JSON.stringify({ ...record, epoch: 99 }))
    releaseAutosaveOwnership(record.epoch)
    expect(readRecord().epoch).toBe(99)
  })

  it('ignores a duplicate presence snapshot with no held or pending arrays', async () => {
    vi.useFakeTimers()
    try {
      const locks = Object.assign(new FakeLockManager(), { query: async () => ({}) })
      vi.stubGlobal('navigator', { locks })
      const cleanup = initAutosaveCoordination()
      try {
        const pending = pauseOtherAutosaveTabs()
        await vi.advanceTimersByTimeAsync(300)
        expect(await pending).toMatchObject({ ok: true })
      } finally {
        cleanup()
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('completes a pending install for the live project and saves the slot', async () => {
    vi.useFakeTimers()
    const live = createDoc()
    useEditorStore.setState({ doc: { ...live, project: { ...live.project, id: 'proj_pending' } } })
    await markInstallPending('proj_pending', 'install-live-1')
    const cleanup = initAutosave()
    try {
      await vi.advanceTimersByTimeAsync(3_100)
      expect(readAutosave()).not.toBeNull()
      expect(hasPendingInstall()).toBe(false)
    } finally {
      cleanup()
    }
  })

  it('finishes a paused live pending install when autosave resumes', async () => {
    vi.useFakeTimers()
    const live = createDoc()
    useEditorStore.setState({
      doc: { ...live, project: { ...live.project, id: 'proj_paused_install' } },
    })
    await markInstallPending('proj_paused_install', 'install-paused')
    const coordination = initAutosaveCoordination()
    const cleanup = initAutosave()
    const other = new FakeChannel(AUTOSAVE_CHANNEL_NAME)
    try {
      other.postMessage({ type: 'pause', requestId: 'r-install' })
      await vi.advanceTimersByTimeAsync(3_100)
      // The retry ran while paused, so the append and slot write are still owed.
      expect(hasPendingInstall()).toBe(true)
      expect(readAutosave()).toBeNull()

      other.postMessage({ type: 'resume', requestId: 'r-install' })
      await vi.advanceTimersByTimeAsync(0)
      expect(hasPendingInstall()).toBe(false)
      expect(readInstalledRegistry()?.['proj_paused_install']).toContain('install-paused')
      expect(storage.get(IMPORT_KEY)).toBeTruthy()
      expect(parseSerializedDoc(readAutosave()!).doc.project.id).toBe('proj_paused_install')
      expect(readPendingInstallRecords()).toEqual([])
    } finally {
      cleanup()
      coordination()
    }
  })

  it('only appends a pending install for another project without touching the slot', async () => {
    vi.useFakeTimers()
    const live = createDoc()
    useEditorStore.setState({ doc: { ...live, project: { ...live.project, id: 'proj_live' } } })
    await markInstallPending('proj_other', 'install-other-1')
    expect(readPendingInstallRecords()).toContainEqual({
      projectId: 'proj_other',
      installId: 'install-other-1',
      hadInstallClaims: false,
    })
    storage.set(AUTOSAVE_KEY, '{"seed":true}')
    const cleanup = initAutosave()
    try {
      await vi.advanceTimersByTimeAsync(3_100)
      expect(readAutosave()).toBe('{"seed":true}')
      expect(readInstalledRegistry()?.['proj_other']).toContain('install-other-1')
      expect(hasPendingInstall()).toBe(false)
    } finally {
      cleanup()
    }
  })

  it('keeps a pending install when its registry append keeps failing', async () => {
    vi.useFakeTimers()
    const live = createDoc()
    useEditorStore.setState({ doc: { ...live, project: { ...live.project, id: 'proj_live' } } })
    await markInstallPending('proj_other', 'install-other-2')
    vi.stubGlobal('localStorage', {
      ...localStorageMock,
      setItem: (key: string, value: string) => {
        if (key.includes('installed-installs')) throw new Error('quota')
        storage.set(key, value)
      },
    })
    const cleanup = initAutosave()
    try {
      await vi.advanceTimersByTimeAsync(16_000)
      expect(hasPendingInstall()).toBe(true)
      expect(readAutosave()).toBeNull()
    } finally {
      cleanup()
    }
  })

  it('attempts the slot write after the registry append succeeded', async () => {
    vi.useFakeTimers()
    const live = createDoc()
    useEditorStore.setState({
      doc: { ...live, project: { ...live.project, id: 'proj_pending_2' } },
    })
    await markInstallPending('proj_pending_2', 'install-live-2')
    const attempted: string[] = []
    let registryAtSlotWrite: string[] | null = null
    vi.stubGlobal('localStorage', {
      ...localStorageMock,
      setItem: (key: string, value: string) => {
        attempted.push(key)
        if (key === AUTOSAVE_KEY) {
          registryAtSlotWrite = readInstalledRegistry()?.['proj_pending_2'] ?? null
          throw new Error('quota')
        }
        storage.set(key, value)
      },
    })
    const cleanup = initAutosave()
    try {
      await vi.advanceTimersByTimeAsync(3_100)
      // The registry append succeeded before the slot write was attempted, so
      // the install is durable at that moment; the pending marker was consumed
      // and the failed slot write reported an error.
      expect(attempted).toContain(AUTOSAVE_KEY)
      expect(registryAtSlotWrite).toContain('install-live-2')
      expect(readAutosave()).toBeNull()
      expect(hasPendingInstall()).toBe(false)
      expect(readPendingInstallRecords()).toEqual([])
    } finally {
      cleanup()
    }
  })

  it('keeps a pending install when a stale snapshot is superseded', async () => {
    vi.useFakeTimers()
    const live = createDoc()
    useEditorStore.setState({
      doc: { ...live, project: { ...live.project, id: 'proj_stale_snapshot', name: 'A' } },
    })
    const snapshot = JSON.stringify(serializeDoc(useEditorStore.getState().doc))
    await markInstallPending('proj_stale_snapshot', 'install-stale')
    useEditorStore.setState({
      doc: { ...live, project: { ...live.project, id: 'proj_live_after_switch', name: 'B' } },
    })
    const cleanup = initAutosaveCoordination()
    try {
      expect(await writeAutosaveCooperatively(snapshot)).toBe('superseded')
      // The stale snapshot must not replace the new live project's slot or
      // consume the install it does not own.
      expect(readAutosave()).toBeNull()
      expect(hasPendingInstall()).toBe(true)
      expect(readInstalledRegistry()?.['proj_stale_snapshot']).toBeUndefined()
      expect(storage.has(IMPORT_KEY)).toBe(false)
      // Registry bookkeeping still lands without touching the live slot.
      queuePendingInstallRetry('proj_stale_snapshot')
      await vi.advanceTimersByTimeAsync(3_100)
      expect(readInstalledRegistry()?.['proj_stale_snapshot']).toContain('install-stale')
      expect(hasPendingInstall()).toBe(false)
      expect(readAutosave()).toBeNull()
    } finally {
      cleanup()
      vi.useRealTimers()
    }
  })

  it('falls back to the live project for a non-object snapshot', async () => {
    const live = createDoc()
    useEditorStore.setState({
      doc: { ...live, project: { ...live.project, id: 'proj_plain' } },
    })
    const cleanup = initAutosaveCoordination()
    try {
      // Non-doc JSON has no project identity, so it is written as the live
      // project, matching the fallback for legacy payloads.
      expect(await writeAutosaveCooperatively('null')).toBe('saved')
      expect(readAutosave()).toBe('null')
    } finally {
      cleanup()
    }
  })

  it('supersedes a snapshot whose project id is malformed', async () => {
    const live = createDoc()
    useEditorStore.setState({
      doc: { ...live, project: { ...live.project, id: 'proj_valid' } },
    })
    const cleanup = initAutosaveCoordination()
    try {
      // A malformed id names no live project, so the snapshot cannot take the
      // slot even though the document itself parses as JSON.
      expect(await writeAutosaveCooperatively('{"project":{"id":42}}')).toBe('superseded')
      expect(readAutosave()).toBeNull()
    } finally {
      cleanup()
    }
  })

  it('keeps a pending install fence when an older ordinary write is superseded', async () => {
    const live = createDoc()
    useEditorStore.setState({
      doc: { ...live, project: { ...live.project, id: 'proj_fence_seq' } },
    })
    const cleanup = initAutosaveCoordination()
    try {
      const json = JSON.stringify(serializeDoc(useEditorStore.getState().doc))
      expect(await writeAutosaveCooperatively(json, 5)).toBe('saved')
      await markInstallPending('proj_fence_seq', 'install-fence-seq')
      expect(storage.has(IMPORT_KEY)).toBe(false)
      // The older sequence cannot write, and it must not consume the install
      // whose marker the next eligible save still owes.
      expect(await writeAutosaveCooperatively(json, 3)).toBe('superseded')
      expect(hasPendingInstall()).toBe(true)
      expect(readInstalledRegistry()?.['proj_fence_seq']).toBeUndefined()
      expect(await writeAutosaveCooperatively(json, 6)).toBe('saved')
      expect(storage.get(IMPORT_KEY)).toBeTruthy()
      expect(parseSerializedDoc(readAutosave()!).doc.project.id).toBe('proj_fence_seq')
      expect(readInstalledRegistry()?.['proj_fence_seq']).toContain('install-fence-seq')
    } finally {
      cleanup()
    }
  })

  it('falls back to a slot retry after clearing another project append', async () => {
    vi.useFakeTimers()
    const live = createDoc()
    useEditorStore.setState({ doc: { ...live, project: { ...live.project, id: 'proj_live' } } })
    await markInstallPending('proj_other', 'install-other-slot')
    let failSlot = true
    vi.stubGlobal('localStorage', {
      ...localStorageMock,
      setItem: (key: string, value: string) => {
        if (key === AUTOSAVE_KEY && failSlot) throw new Error('quota')
        storage.set(key, value)
      },
    })
    try {
      queuePendingInstallRetry('proj_live')
      await vi.advanceTimersByTimeAsync(3_100)
      // The other project's append succeeded and was cleared, then the live
      // slot write failed with no pending install left to retry.
      expect(hasPendingInstall()).toBe(false)
      expect(readInstalledRegistry()?.['proj_other']).toEqual(['install-other-slot'])
      expect(readAutosave()).toBeNull()

      failSlot = false
      await vi.advanceTimersByTimeAsync(3_100)
      expect(readAutosave()).not.toBeNull()
      expect(parseSerializedDoc(readAutosave()!).doc.project.id).toBe('proj_live')
      expect(useEditorStore.getState().autosaveStatus).toBe('saved')
      // The cleared append must not be registered a second time by the slot
      // retry.
      expect(readInstalledRegistry()?.['proj_other']).toEqual(['install-other-slot'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps retrying a live pending install whose registry append fails', async () => {
    vi.useFakeTimers()
    const live = createDoc()
    useEditorStore.setState({
      doc: { ...live, project: { ...live.project, id: 'proj_pending_append' } },
    })
    await markInstallPending('proj_pending_append', 'install-live-append')
    let failAppend = true
    vi.stubGlobal('localStorage', {
      ...localStorageMock,
      setItem: (key: string, value: string) => {
        if (failAppend && key.includes('installed-installs')) throw new Error('quota')
        storage.set(key, value)
      },
    })
    try {
      queuePendingInstallRetry('proj_pending_append')
      await vi.advanceTimersByTimeAsync(3_100)
      // The live slot write refuses before writing because its pending install
      // could not be registered, so the retry remains queued.
      expect(hasPendingInstall()).toBe(true)
      expect(readInstalledRegistry()?.['proj_pending_append']).toBeUndefined()
      expect(readAutosave()).toBeNull()

      failAppend = false
      await vi.advanceTimersByTimeAsync(3_100)
      // The next retry lands the append and then the live slot, so the install
      // is registered, the pending record is cleared, and the project is saved.
      expect(readInstalledRegistry()?.['proj_pending_append']).toContain('install-live-append')
      expect(hasPendingInstall()).toBe(false)
      expect(readPendingInstallRecords()).toEqual([])
      expect(parseSerializedDoc(readAutosave()!).doc.project.id).toBe('proj_pending_append')
      expect(useEditorStore.getState().autosaveStatus).toBe('saved')
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops a queued retry for a project that is no longer live', async () => {
    vi.useFakeTimers()
    try {
      const live = createDoc()
      useEditorStore.setState({ doc: { ...live, project: { ...live.project, id: 'proj_a' } } })
      queueAutosaveRetry('{"a":1}', undefined, 'proj_a')
      useEditorStore.setState({ doc: { ...live, project: { ...live.project, id: 'proj_b' } } })
      await vi.advanceTimersByTimeAsync(3_100)
      expect(readAutosave()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops a retry whose live document cannot be serialized', async () => {
    vi.useFakeTimers()
    try {
      const live = createDoc()
      useEditorStore.setState({ doc: { ...live, project: { ...live.project, id: 'proj_a' } } })
      const circular: Record<string, unknown> = { project: { id: 'proj_a' } }
      ;(circular.project as Record<string, unknown>).self = circular
      useEditorStore.setState({ doc: circular as never })
      queueAutosaveRetry('{"a":1}', undefined, 'proj_a')
      await vi.advanceTimersByTimeAsync(3_100)
      expect(readAutosave()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops a retry whose captured content no longer matches the live doc', async () => {
    vi.useFakeTimers()
    try {
      const live = createDoc()
      useEditorStore.setState({
        doc: { ...live, project: { ...live.project, id: 'proj_a', name: 'A' } },
      })
      const snapshot = JSON.stringify(serializeDoc(useEditorStore.getState().doc))
      queueAutosaveRetry(snapshot, undefined, 'proj_a')
      useEditorStore.setState({
        doc: { ...live, project: { ...live.project, id: 'proj_a', name: 'B' } },
      })
      await vi.advanceTimersByTimeAsync(3_100)
      expect(readAutosave()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('writes a retry whose captured content still matches the live doc', async () => {
    vi.useFakeTimers()
    try {
      const live = createDoc()
      useEditorStore.setState({
        doc: { ...live, project: { ...live.project, id: 'proj_a', name: 'A' } },
      })
      const snapshot = JSON.stringify(serializeDoc(useEditorStore.getState().doc))
      queueAutosaveRetry(snapshot, undefined, 'proj_a')
      await vi.advanceTimersByTimeAsync(3_100)
      const stored = parseSerializedDoc(readAutosave()!).doc
      expect(stored.project.id).toBe('proj_a')
      expect(stored.project.name).toBe('A')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not report an older retry saved while the slot holds another project', async () => {
    vi.useFakeTimers()
    try {
      const live = createDoc()
      const a = { ...live, project: { ...live.project, id: 'proj_a', name: 'A' } }
      const b = { ...live, project: { ...live.project, id: 'proj_b', name: 'B' } }
      useEditorStore.setState({ doc: a, autosaveStatus: 'pending' })
      const jsonA = JSON.stringify(serializeDoc(a))

      // B commits with a newer sequence before the old A retry is queued.
      useEditorStore.setState({ doc: b, autosaveStatus: 'pending' })
      const jsonB = JSON.stringify(serializeDoc(b))
      expect(await writeAutosaveCooperatively(jsonB, 2, 'proj_b', 'proj_b')).toBe('saved')
      expect(parseSerializedDoc(readAutosave()!).doc.project.id).toBe('proj_b')

      // The same A object comes back, and an old sequence is retried. The live
      // reference matches, but the slot still holds B, so this is not saved.
      useEditorStore.setState({ doc: a, autosaveStatus: 'pending' })
      queueAutosaveRetry(jsonA, 1, 'proj_a')
      await vi.advanceTimersByTimeAsync(3_100)
      expect(parseSerializedDoc(readAutosave()!).doc.project.id).toBe('proj_b')
      expect(useEditorStore.getState().autosaveStatus).toBe('pending')
    } finally {
      useEditorStore.getState().setAutosaveStatus('idle')
      vi.useRealTimers()
    }
  })

  it('does not match malformed snapshot content against the slot', async () => {
    vi.useFakeTimers()
    try {
      const live = createDoc()
      const a = { ...live, project: { ...live.project, id: 'proj_a', name: 'A' } }
      const b = { ...live, project: { ...live.project, id: 'proj_b', name: 'B' } }
      useEditorStore.setState({ doc: b, autosaveStatus: 'pending' })
      expect(
        await writeAutosaveCooperatively(JSON.stringify(serializeDoc(b)), 2, 'proj_b', 'proj_b'),
      ).toBe('saved')

      useEditorStore.setState({ doc: a, autosaveStatus: 'pending' })
      storage.set(AUTOSAVE_KEY, 'not json')
      queueAutosaveRetry('not json', 1, 'proj_a')
      await vi.advanceTimersByTimeAsync(3_100)
      // Both payloads fail normalization, so they must not count as a match.
      expect(readAutosave()).toBe('not json')
      expect(useEditorStore.getState().autosaveStatus).toBe('pending')
    } finally {
      useEditorStore.getState().setAutosaveStatus('idle')
      vi.useRealTimers()
    }
  })

  it('does not report a retry saved after the live project changed', async () => {
    vi.useFakeTimers()
    const locks = navigator.locks as unknown as FakeLockManager
    let release!: () => void
    const hold = new Promise<void>((resolve) => (release = resolve))
    const held = locks.request(AUTOSAVE_LOCK_NAME, { mode: 'exclusive' }, () => hold)
    try {
      const live = createDoc()
      useEditorStore.setState({
        doc: { ...live, project: { ...live.project, id: 'proj_a', name: 'A' } },
      })
      const json = JSON.stringify(serializeDoc(useEditorStore.getState().doc))
      useEditorStore.setState({ autosaveStatus: 'pending' })
      queueAutosaveRetry(json, undefined, 'proj_a')
      await vi.advanceTimersByTimeAsync(3_100)
      useEditorStore.setState({
        doc: { ...live, project: { ...live.project, id: 'proj_b', name: 'B' } },
      })
      release()
      await held
      await vi.advanceTimersByTimeAsync(0)
      expect(useEditorStore.getState().autosaveStatus).toBe('pending')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not report a retry saved after a newer edit landed', async () => {
    vi.useFakeTimers()
    const locks = navigator.locks as unknown as FakeLockManager
    let release!: () => void
    const hold = new Promise<void>((resolve) => (release = resolve))
    const held = locks.request(AUTOSAVE_LOCK_NAME, { mode: 'exclusive' }, () => hold)
    try {
      const live = createDoc()
      useEditorStore.setState({
        doc: { ...live, project: { ...live.project, id: 'proj_a', name: 'A' } },
      })
      const json = JSON.stringify(serializeDoc(useEditorStore.getState().doc))
      useEditorStore.setState({ autosaveStatus: 'pending' })
      queueAutosaveRetry(json, undefined, 'proj_a')
      await vi.advanceTimersByTimeAsync(3_100)
      useEditorStore.setState({
        doc: { ...live, project: { ...live.project, id: 'proj_a', name: 'Edited' } },
      })
      release()
      await held
      await vi.advanceTimersByTimeAsync(0)
      expect(useEditorStore.getState().autosaveStatus).toBe('pending')
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops queueing a pending-install retry after the attempt cap', async () => {
    vi.useFakeTimers()
    const live = createDoc()
    useEditorStore.setState({ doc: { ...live, project: { ...live.project, id: 'proj_live' } } })
    await markInstallPending('proj_a', 'install-cap-1')
    const appends = vi
      .spyOn(localStorageMock, 'setItem')
      .mockImplementation((key: string, value: string) => {
        // A refused append keeps the pending install, so every retry pass
        // reaches the append again until the cap stops scheduling.
        if (key.includes('installed-installs')) throw new Error('quota')
        storage.set(key, value)
      })
    try {
      queuePendingInstallRetry('proj_a')
      // Each retry pass attempts the registry append once. A refused append
      // leaves the pending install in place, so the next pass tries again
      // until the cap stops scheduling.
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await vi.advanceTimersByTimeAsync(3_100)
      }
      const registryAppends = appends.mock.calls.filter(([key]) =>
        key.includes('installed-installs'),
      )
      expect(registryAppends).toHaveLength(5)
      expect(hasPendingInstall()).toBe(true)
      expect(readAutosave()).toBeNull()
    } finally {
      appends.mockRestore()
      vi.useRealTimers()
    }
  })

  it.each([
    // Each owner field is rechecked after the probe.
    ['epoch'],
    ['sessionId'],
    ['tokenHash'],
  ])('refuses a same-session claim whose record changed in %s during the probe', async (field) => {
    const record = await claimed()
    resetAutosaveCoordinationForTests()
    const initial = {
      ...record,
      tabId: 'prior-page',
      epoch: 7,
      heartbeatAt: Date.now(),
    }
    storage.set(OWNER_KEY, JSON.stringify(initial))
    const locks = navigator.locks as unknown as FakeLockManager
    let release!: () => void
    const hold = new Promise<void>((resolve) => (release = resolve))
    const held = locks.request(AUTOSAVE_LOCK_NAME, { mode: 'exclusive' }, () => hold)
    const pending = claimAutosaveOwnership()
    await Promise.resolve()
    const changed = { ...initial }
    if (field === 'epoch') changed.epoch = 8
    if (field === 'sessionId') changed.sessionId = 'another-session'
    if (field === 'tokenHash') changed.tokenHash = '00000000'
    storage.set(OWNER_KEY, JSON.stringify(changed))
    release()
    await held
    expect(await pending).toMatchObject({ ok: false })
  })

  it('stays read-only when an old page answers the same-session probe', async () => {
    const record = await claimed()
    resetAutosaveCoordinationForTests()
    storage.set(
      OWNER_KEY,
      JSON.stringify({ ...record, tabId: 'prior-page', epoch: 7, heartbeatAt: Date.now() }),
    )
    const peer = new FakeChannel(AUTOSAVE_CHANNEL_NAME)
    peer.addEventListener('message', (event) => {
      const data = event.data as { type?: string; requestId?: string }
      if (data.type === 'probe-session' && data.requestId) {
        peer.postMessage({
          type: 'session-present',
          requestId: data.requestId,
          sessionId: record.sessionId,
        })
      }
    })
    const cleanup = initAutosaveCoordination()
    try {
      await vi.waitFor(() => expect(isAutosavePaused()).toBe(true))
      // The old page answered, so this page never reclaims: the owner still
      // names the prior page.
      expect(readOwner()).toMatchObject({ tabId: 'prior-page', epoch: 7 })
    } finally {
      cleanup()
    }
  })

  it('does not reclaim ownership after teardown while the lock section waits', async () => {
    const record = await claimed()
    resetAutosaveCoordinationForTests()
    storage.set(
      OWNER_KEY,
      JSON.stringify({
        ...record,
        tabId: 'prior-page',
        epoch: 7,
        heartbeatAt: Date.now(),
      }),
    )
    vi.stubGlobal('BroadcastChannel', undefined)
    const locks = navigator.locks as unknown as FakeLockManager
    let release!: () => void
    const hold = new Promise<void>((resolve) => (release = resolve))
    const held = locks.request(AUTOSAVE_LOCK_NAME, { mode: 'exclusive' }, () => hold)
    const cleanup = initAutosaveCoordination()
    await Promise.resolve()
    await Promise.resolve()
    cleanup()
    release()
    await held
    expect(storage.get(OWNER_KEY)).toContain('prior-page')
  })

  it('creates an import fence token without crypto.randomUUID', () => {
    vi.stubGlobal('crypto', {})
    const live = createDoc()
    useEditorStore.setState({ doc: { ...live, project: { ...live.project, id: 'proj_token' } } })
    requireAutosaveImportFence('proj_token')
    // The fence is observable through the next scoped write's marker.
    return writeAutosaveCooperatively('{"fenced":true}', undefined, 'proj_token').then((result) => {
      expect(result).toBe('saved')
      expect(storage.get(IMPORT_KEY)).toBeTruthy()
    })
  })

  it('treats a resume with no honored pause as a plain resume', async () => {
    const cleanup = initAutosaveCoordination()
    const other = new FakeChannel(AUTOSAVE_CHANNEL_NAME)
    try {
      other.postMessage({ type: 'resume', requestId: 'never-paused' })
      expect(isAutosavePaused()).toBe(false)
    } finally {
      cleanup()
    }
  })

  it('refuses a write against an older epoch of this same tab', async () => {
    const record = await claimed()
    storage.set(OWNER_KEY, JSON.stringify({ ...record, epoch: record.epoch - 1 }))
    expect(await writeAutosaveCooperatively('{"stale":true}')).toBe('read-only')
  })

  it('saves over a stale foreign owner record without refreshing it', async () => {
    await claimed()
    storage.set(
      OWNER_KEY,
      JSON.stringify({
        tabId: 'other-tab',
        sessionId: 'other-session',
        tokenHash: 'deadbeef',
        epoch: 0,
        heartbeatAt: Date.now() - 60_000,
      }),
    )
    expect(await writeAutosaveCooperatively('{"stale-owner":true}')).toBe('saved')
    expect(readRecord().tabId).toBe('other-tab')
  })

  it('records a non-live pending install without serialization', async () => {
    vi.useFakeTimers()
    try {
      const live = createDoc()
      useEditorStore.setState({ doc: { ...live, project: { ...live.project, id: 'proj_live' } } })
      await markInstallPending('proj_other', 'install-no-serial')
      vi.stubGlobal('navigator', {})
      vi.stubGlobal('indexedDB', undefined)
      queuePendingInstallRetry('proj_other')
      await vi.advanceTimersByTimeAsync(3_100)
      expect(hasPendingInstall()).toBe(true)
      expect(readPendingInstallRecords()).toContainEqual({
        projectId: 'proj_other',
        installId: 'install-no-serial',
        hadInstallClaims: false,
      })
      // Without a serializable section the registry append never happened.
      expect(readInstalledRegistry()?.['proj_other']).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('skips a paused debounced save and clears an older debounce timer', async () => {
    vi.useFakeTimers()
    const cleanup = initAutosave()
    const coordination = initAutosaveCoordination()
    const other = new FakeChannel(AUTOSAVE_CHANNEL_NAME)
    try {
      other.postMessage({ type: 'pause', requestId: 'r-debounce' })
      const live = createDoc()
      useEditorStore.setState({ doc: { ...live, project: { ...live.project, name: 'Paused' } } })
      await vi.advanceTimersByTimeAsync(1_000)
      // A paused tab schedules nothing while the pause banner is up.
      expect(readAutosave()).toBeNull()
      other.postMessage({ type: 'resume', requestId: 'r-debounce' })
      // Two quick edits keep only the last debounce timer: the first deadline
      // passes without writing the intermediate value.
      const writes: string[] = []
      const setItem = vi
        .spyOn(localStorageMock, 'setItem')
        .mockImplementation((key: string, value: string) => {
          if (key === AUTOSAVE_KEY) writes.push(value)
          storage.set(key, value)
        })
      try {
        useEditorStore.setState({ doc: { ...live, project: { ...live.project, name: 'One' } } })
        await vi.advanceTimersByTimeAsync(400)
        expect(writes.some((value) => value.includes('"One"'))).toBe(false)
        useEditorStore.setState({ doc: { ...live, project: { ...live.project, name: 'Two' } } })
        await vi.advanceTimersByTimeAsync(1_000)
        expect(parseSerializedDoc(readAutosave()!).doc.project.name).toBe('Two')
        expect(writes.filter((value) => value.includes('"One"'))).toHaveLength(0)
        expect(writes.filter((value) => value.includes('"Two"'))).toHaveLength(1)
      } finally {
        setItem.mockRestore()
      }
    } finally {
      coordination()
      cleanup()
    }
  })

  it('keeps a debounced save pending through a temporary pause and saves on resume', async () => {
    vi.useFakeTimers()
    const coordination = initAutosaveCoordination()
    const cleanup = initAutosave()
    const other = new FakeChannel(AUTOSAVE_CHANNEL_NAME)
    const locks = (navigator as unknown as { locks: FakeLockManager }).locks
    const original = locks.request.bind(locks)
    let releaseWrite: (() => void) | null = null
    let entered: (() => void) | null = null
    const requested = new Promise<void>((resolve) => {
      entered = resolve
    })
    let gate = false
    locks.request = ((
      name: string,
      options: never,
      callback: (lock: object | null) => Promise<unknown>,
    ) => {
      if (name !== AUTOSAVE_LOCK_NAME || !gate) return original(name, options, callback)
      gate = false
      return new Promise<unknown>((resolve, reject) => {
        entered?.()
        releaseWrite = () => {
          void original(name, options, callback).then(resolve, reject)
        }
      })
    }) as typeof locks.request
    try {
      await vi.advanceTimersByTimeAsync(0)
      gate = true
      const live = createDoc()
      useEditorStore.setState({
        doc: { ...live, project: { ...live.project, name: 'Paused after debounce' } },
      })
      await vi.advanceTimersByTimeAsync(800)
      expect(releaseWrite).not.toBeNull()
      expect(useEditorStore.getState().autosaveStatus).toBe('pending')

      // The pause lands while the debounced write waits for the lock, so the
      // serialized section refuses it.
      other.postMessage({ type: 'pause', requestId: 'r-debounce-late' })
      expect(isAutosavePaused()).toBe(true)
      releaseWrite!()
      await vi.advanceTimersByTimeAsync(0)
      expect(useEditorStore.getState().autosaveStatus).toBe('pending')
      expect(readAutosave()).toBeNull()

      // Resume saves the existing live document without another edit.
      other.postMessage({ type: 'resume', requestId: 'r-debounce-late' })
      await vi.advanceTimersByTimeAsync(0)
      expect(isAutosavePaused()).toBe(false)
      expect(parseSerializedDoc(readAutosave()!).doc.project.name).toBe('Paused after debounce')
      expect(useEditorStore.getState().autosaveStatus).toBe('saved')
    } finally {
      locks.request = original as typeof locks.request
      cleanup()
      coordination()
      useEditorStore.getState().setAutosaveStatus('idle')
    }
  })

  it('reports autosave off when a temporary pause becomes a completed import', async () => {
    vi.useFakeTimers()
    const coordination = initAutosaveCoordination()
    const cleanup = initAutosave()
    const other = new FakeChannel(AUTOSAVE_CHANNEL_NAME)
    const locks = (navigator as unknown as { locks: FakeLockManager }).locks
    const original = locks.request.bind(locks)
    let releaseWrite: (() => void) | null = null
    let entered: (() => void) | null = null
    const requested = new Promise<void>((resolve) => {
      entered = resolve
    })
    let gate = false
    locks.request = ((
      name: string,
      options: never,
      callback: (lock: object | null) => Promise<unknown>,
    ) => {
      if (name !== AUTOSAVE_LOCK_NAME || !gate) return original(name, options, callback)
      gate = false
      return new Promise<unknown>((resolve, reject) => {
        entered?.()
        releaseWrite = () => {
          void original(name, options, callback).then(resolve, reject)
        }
      })
    }) as typeof locks.request
    try {
      await vi.advanceTimersByTimeAsync(0)
      gate = true
      const live = createDoc()
      useEditorStore.setState({
        doc: { ...live, project: { ...live.project, name: 'Queued before import' } },
      })
      await vi.advanceTimersByTimeAsync(800)
      expect(releaseWrite).not.toBeNull()
      // The pause lands while the write waits, so the refusal is temporary and
      // the status stays pending until the peer decides.
      other.postMessage({ type: 'pause', requestId: 'r-import-status' })
      expect(isAutosavePaused()).toBe(true)
      releaseWrite!()
      await vi.advanceTimersByTimeAsync(0)
      expect(useEditorStore.getState().autosaveStatus).toBe('pending')

      // The peer completes the import instead of resuming. Autosave is now
      // permanently off for this tab, so pending must not keep spinning.
      other.postMessage({ type: 'imported' })
      await vi.advanceTimersByTimeAsync(0)
      expect(useEditorStore.getState().autosaveStatus).toBe('error')
    } finally {
      locks.request = original as typeof locks.request
      cleanup()
      coordination()
      other.close()
      useEditorStore.getState().setAutosaveStatus('idle')
    }
  })

  it('does not report a superseded snapshot saved after the live project changes', async () => {
    vi.useFakeTimers()
    const cleanup = initAutosave()
    const writes = vi.spyOn(localStorageMock, 'setItem')
    const locks = (navigator as unknown as { locks: FakeLockManager }).locks
    const original = locks.request.bind(locks)
    let releaseWrite: (() => void) | null = null
    let entered: (() => void) | null = null
    const requested = new Promise<void>((resolve) => {
      entered = resolve
    })
    let gate = false
    locks.request = ((
      name: string,
      options: never,
      callback: (lock: object | null) => Promise<unknown>,
    ) => {
      if (name !== AUTOSAVE_LOCK_NAME || !gate) return original(name, options, callback)
      gate = false
      return new Promise<unknown>((resolve, reject) => {
        entered?.()
        releaseWrite = () => {
          void original(name, options, callback).then(resolve, reject)
        }
      })
    }) as typeof locks.request
    try {
      await vi.advanceTimersByTimeAsync(0)
      gate = true
      const live = createDoc()
      useEditorStore.setState({
        doc: { ...live, project: { ...live.project, id: 'proj_a', name: 'A' } },
      })
      await vi.advanceTimersByTimeAsync(800)
      expect(releaseWrite).not.toBeNull()

      // The slot still holds A, but the live project is now B. A slot match
      // alone must not report B saved.
      storage.set(AUTOSAVE_KEY, JSON.stringify(serializeDoc(useEditorStore.getState().doc)))
      useEditorStore.setState({
        doc: { ...live, project: { ...live.project, id: 'proj_b', name: 'B' } },
        autosaveStatus: 'pending',
      })
      writes.mockClear()
      releaseWrite!()
      await vi.advanceTimersByTimeAsync(0)
      expect(writes.mock.calls.filter(([key]) => key === AUTOSAVE_KEY)).toHaveLength(0)
      expect(parseSerializedDoc(readAutosave()!).doc.project.id).toBe('proj_a')
      expect(useEditorStore.getState().autosaveStatus).toBe('pending')
    } finally {
      writes.mockRestore()
      locks.request = original as typeof locks.request
      cleanup()
      useEditorStore.getState().setAutosaveStatus('idle')
      vi.useRealTimers()
    }
  })

  it('does not report a superseded resume saved after the live project changes', async () => {
    vi.useFakeTimers()
    const coordination = initAutosaveCoordination()
    const writes = vi.spyOn(localStorageMock, 'setItem')
    const other = new FakeChannel(AUTOSAVE_CHANNEL_NAME)
    const locks = (navigator as unknown as { locks: FakeLockManager }).locks
    const original = locks.request.bind(locks)
    let releaseWrite: (() => void) | null = null
    let entered: (() => void) | null = null
    const requested = new Promise<void>((resolve) => {
      entered = resolve
    })
    let gate = false
    locks.request = ((
      name: string,
      options: never,
      callback: (lock: object | null) => Promise<unknown>,
    ) => {
      if (name !== AUTOSAVE_LOCK_NAME || !gate) return original(name, options, callback)
      gate = false
      return new Promise<unknown>((resolve, reject) => {
        entered?.()
        releaseWrite = () => {
          void original(name, options, callback).then(resolve, reject)
        }
      })
    }) as typeof locks.request
    try {
      gate = true
      const live = createDoc()
      useEditorStore.setState({
        doc: { ...live, project: { ...live.project, id: 'proj_a', name: 'A' } },
        autosaveStatus: 'pending',
      })
      other.postMessage({ type: 'pause', requestId: 'r-supersede-resume' })
      other.postMessage({ type: 'resume', requestId: 'r-supersede-resume' })
      await vi.advanceTimersByTimeAsync(0)
      expect(releaseWrite).not.toBeNull()

      // The slot holds A while the live project becomes B.
      storage.set(AUTOSAVE_KEY, JSON.stringify(serializeDoc(useEditorStore.getState().doc)))
      useEditorStore.setState({
        doc: { ...live, project: { ...live.project, id: 'proj_b', name: 'B' } },
        autosaveStatus: 'pending',
      })
      writes.mockClear()
      releaseWrite!()
      await vi.advanceTimersByTimeAsync(0)
      expect(writes.mock.calls.filter(([key]) => key === AUTOSAVE_KEY)).toHaveLength(0)
      expect(parseSerializedDoc(readAutosave()!).doc.project.id).toBe('proj_a')
      expect(useEditorStore.getState().autosaveStatus).toBe('pending')
    } finally {
      writes.mockRestore()
      locks.request = original as typeof locks.request
      coordination()
      other.close()
      useEditorStore.getState().setAutosaveStatus('idle')
      vi.useRealTimers()
    }
  })

  it('reports a superseded debounced save as saved', async () => {
    vi.useFakeTimers()
    const cleanup = initAutosave()
    const writes = vi.spyOn(localStorageMock, 'setItem')
    try {
      const live = createDoc()
      useEditorStore.setState({ doc: { ...live, project: { ...live.project, name: 'Scheduled' } } })
      const scheduled = useEditorStore.getState().doc
      // A newer write of the live document commits before the debounce fires;
      // the scheduled older sequence must report as superseded instead of
      // replacing the newer document.
      await writeAutosaveCooperatively(JSON.stringify(serializeDoc(scheduled)))
      writes.mockClear()
      await vi.advanceTimersByTimeAsync(1_000)
      // The superseded debounce reports saved without writing the slot again.
      expect(writes.mock.calls.filter(([key]) => key === AUTOSAVE_KEY)).toHaveLength(0)
      expect(readAutosave()).not.toBeNull()
      const stored = parseSerializedDoc(readAutosave()!).doc
      const current = useEditorStore.getState().doc
      expect(stored.project.id).toBe(current.project.id)
      expect(stored.project.name).toBe('Scheduled')
      expect(stored.project.tracks.map((track) => track.id)).toEqual(
        current.project.tracks.map((track) => track.id),
      )
      expect(stored.media).toEqual(current.media)
      expect(useEditorStore.getState().autosaveStatus).toBe('saved')
    } finally {
      writes.mockRestore()
      cleanup()
    }
  })

  it('reports a debounced save error when storage fills', async () => {
    vi.useFakeTimers()
    const cleanup = initAutosave()
    try {
      const live = createDoc()
      useEditorStore.setState({ doc: { ...live, project: { ...live.project, name: 'Full' } } })
      vi.stubGlobal('localStorage', {
        ...localStorageMock,
        setItem: () => {
          throw new Error('quota')
        },
      })
      await vi.advanceTimersByTimeAsync(1_000)
      expect(useEditorStore.getState().autosaveStatus).toBe('error')
    } finally {
      cleanup()
    }
  })

  it('reports a debounced read-only save as autosave off', async () => {
    vi.useFakeTimers()
    const cleanup = initAutosave()
    try {
      const live = createDoc()
      storage.set(
        OWNER_KEY,
        JSON.stringify({
          tabId: 'other-tab',
          sessionId: 'other-session',
          tokenHash: 'deadbeef',
          epoch: 1,
          heartbeatAt: Date.now(),
        }),
      )
      useEditorStore.setState({ doc: { ...live, project: { ...live.project, name: 'Theirs' } } })
      await vi.advanceTimersByTimeAsync(1_000)
      expect(useEditorStore.getState().autosaveStatus).toBe('error')
    } finally {
      cleanup()
    }
  })
})

describe('autosave session identity (0.29.0)', () => {
  it.each([
    ['no stored session', null, false],
    ['malformed JSON', '{broken', false],
    ['a string', '"session"', false],
    ['null', 'null', false],
    ['a non-string session id', '{"sessionId":1,"token":"t"}', false],
    ['a non-string token', '{"sessionId":"s","token":1}', false],
    ['a valid identity', '{"sessionId":"s","token":"t"}', true],
  ])('loads a session with %s', async (_label, raw, valid) => {
    vi.resetModules()
    const written: string[] = []
    vi.stubGlobal('sessionStorage', {
      getItem: () => raw,
      setItem: (_key: string, value: string) => void written.push(value),
    })
    const fresh = await import('../persistence')
    expect(typeof fresh.resetAutosaveCoordinationForTests).toBe('function')
    try {
      // A valid identity is preserved; anything else is replaced with a fresh
      // per-page identity (which is then written back when storage allows).
      await fresh.claimAutosaveOwnership()
      const owner = JSON.parse(
        (storage.get('web-video-editor:autosave-owner:v1') as string) ?? 'null',
      ) as { sessionId: string } | null
      if (valid) {
        expect(owner?.sessionId).toBe('s')
        expect(written).toEqual([])
      } else {
        expect(owner?.sessionId).toMatch(/^session-/)
        expect(written).toHaveLength(1)
        const replacement = JSON.parse(written[0]!) as { sessionId: string; token: string }
        expect(replacement.sessionId).toBe(owner?.sessionId)
        expect(typeof replacement.token).toBe('string')
        expect(replacement.token.length).toBeGreaterThan(0)
      }
    } finally {
      fresh.resetAutosaveCoordinationForTests()
    }
  })
})

describe('autosave hardening (0.29.6)', () => {
  function ownerNow(): { tabId: string; epoch: number; sessionId: string } | null {
    const raw = storage.get(OWNER_KEY)
    return raw ? (JSON.parse(raw) as { tabId: string; epoch: number; sessionId: string }) : null
  }

  async function seededOwner(): Promise<Record<string, unknown>> {
    expect(await claimAutosaveOwnership()).toMatchObject({ ok: true })
    const record = JSON.parse(storage.get(OWNER_KEY)!) as Record<string, unknown>
    resetAutosaveCoordinationForTests()
    storage.set(
      OWNER_KEY,
      JSON.stringify({ ...record, tabId: 'prior-page', epoch: 7, heartbeatAt: Date.now() }),
    )
    return record
  }

  it('keeps independent probes when coordination and a claim overlap', async () => {
    const record = await seededOwner()
    vi.useFakeTimers()
    const peer = new FakeChannel(AUTOSAVE_CHANNEL_NAME)
    const probes: string[] = []
    peer.addEventListener('message', (event) => {
      const data = event.data as { type?: string; requestId?: string }
      if (data.type === 'probe-session' && data.requestId) probes.push(data.requestId)
    })
    const cleanup = initAutosaveCoordination()
    const claim = claimAutosaveOwnership()
    try {
      await vi.advanceTimersByTimeAsync(0)
      // Both probes are outstanding before any answer: the initialization
      // probe starts first, then the claim's.
      expect(probes).toHaveLength(2)
      // Answer the claim first, then the initialization probe. A single-slot
      // implementation drops the first request, so its operation never sees
      // the paused state its own matching answer should produce.
      peer.postMessage({
        type: 'session-present',
        requestId: probes[1],
        sessionId: record.sessionId,
      })
      await vi.advanceTimersByTimeAsync(0)
      // The claim settled on its own answer while the initialization probe
      // is still outstanding.
      expect(await claim).toMatchObject({
        ok: false,
        reason: expect.stringContaining('Another tab is saving this project'),
      })
      expect(isAutosavePaused()).toBe(false)
      peer.postMessage({
        type: 'session-present',
        requestId: probes[0],
        sessionId: record.sessionId,
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(isAutosavePaused()).toBe(true)
      expect(ownerNow()).toMatchObject({ tabId: 'prior-page', epoch: 7 })
    } finally {
      cleanup()
      vi.useRealTimers()
    }
  })

  it('ignores a session-present reply with the wrong session id', async () => {
    const record = await seededOwner()
    const peer = new FakeChannel(AUTOSAVE_CHANNEL_NAME)
    peer.addEventListener('message', (event) => {
      const data = event.data as { type?: string; requestId?: string }
      if (data.type === 'probe-session' && data.requestId) {
        peer.postMessage({
          type: 'session-present',
          requestId: data.requestId,
          sessionId: 'wrong-session',
        })
      }
    })
    vi.useFakeTimers()
    const cleanup = initAutosaveCoordination()
    try {
      await vi.advanceTimersByTimeAsync(300)
      // The wrong reply did not settle the probe; the timeout reclaimed the
      // stale same-session record for this page.
      expect(ownerNow()?.tabId).not.toBe('prior-page')
      // Reclaim keeps the record's epoch; only a claim advances it.
      expect(ownerNow()?.epoch).toBe(7)
    } finally {
      cleanup()
      vi.useRealTimers()
    }
  })

  it('fails a reclaim write closed without starting the heartbeat', async () => {
    await seededOwner()
    vi.useFakeTimers()
    const interval = vi.spyOn(globalThis, 'setInterval')
    const setItem = vi.spyOn(localStorageMock, 'setItem')
    setItem.mockImplementation((key: string, value: string) => {
      if (key === OWNER_KEY) throw new Error('quota')
      storage.set(key, value)
    })
    const cleanup = initAutosaveCoordination()
    try {
      await vi.advanceTimersByTimeAsync(300)
      expect(isAutosavePaused()).toBe(true)
      expect(ownerNow()).toMatchObject({ tabId: 'prior-page', epoch: 7 })
      expect(interval).not.toHaveBeenCalled()
    } finally {
      cleanup()
      interval.mockRestore()
      setItem.mockRestore()
      vi.useRealTimers()
    }
  })

  it('stops the heartbeat after an owner refresh failure', async () => {
    vi.useFakeTimers()
    expect(await claimAutosaveOwnership()).toMatchObject({ ok: true })
    const setItem = vi.spyOn(localStorageMock, 'setItem')
    let ownerWrites = 0
    setItem.mockImplementation((key: string, value: string) => {
      if (key === OWNER_KEY) {
        ownerWrites += 1
        throw new Error('quota')
      }
      storage.set(key, value)
    })
    try {
      await vi.advanceTimersByTimeAsync(5_100)
      expect(isAutosavePaused()).toBe(true)
      // A storage write failure is not retried by the automatic recheck.
      expect(vi.getTimerCount()).toBe(0)
      const afterFailure = ownerWrites
      await vi.advanceTimersByTimeAsync(25_000)
      expect(ownerWrites).toBe(afterFailure)
      expect(isAutosavePaused()).toBe(true)
    } finally {
      setItem.mockRestore()
      vi.useRealTimers()
    }
  })

  it('refuses a claim whose probe is in flight when coordination tears down', async () => {
    const record = await seededOwner()
    vi.useFakeTimers()
    const cleanup = initAutosaveCoordination()
    const claim = claimAutosaveOwnership()
    try {
      await vi.advanceTimersByTimeAsync(0)
      cleanup()
      await vi.advanceTimersByTimeAsync(300)
      expect(await claim).toMatchObject({ ok: false })
      expect(ownerNow()).toMatchObject({ tabId: 'prior-page', epoch: 7 })
    } finally {
      cleanup()
      vi.useRealTimers()
    }
  })

  it('keeps a pause that arrives during the reclaim probe', async () => {
    await seededOwner()
    storage.set(AUTOSAVE_KEY, JSON.stringify(serializeDoc(useEditorStore.getState().doc)))
    readValidAutosave()
    vi.useFakeTimers()
    const cleanup = initAutosaveCoordination()
    const other = new FakeChannel(AUTOSAVE_CHANNEL_NAME)
    try {
      await vi.advanceTimersByTimeAsync(0)
      other.postMessage({ type: 'pause', requestId: 'pause-reclaim', tabId: 'other' })
      await vi.advanceTimersByTimeAsync(300)
      expect(isAutosavePaused()).toBe(true)
      expect(ownerNow()).toMatchObject({ tabId: 'prior-page', epoch: 7 })

      // The pause ends while the peer's lease is still fresh: the reclaim
      // never claimed, so the resume path must not restore writes yet.
      const watched: boolean[] = []
      const stopWatching = useEditorStore.subscribe((state) => watched.push(state.autosavePaused))
      other.postMessage({ type: 'resume', requestId: 'pause-reclaim' })
      await vi.advanceTimersByTimeAsync(0)
      stopWatching()
      expect(watched).not.toContain(false)
      expect(isAutosavePaused()).toBe(true)

      // Once the lease expires and the slot is unchanged, the recheck may
      // resume ordinary multi-tab editing.
      await vi.advanceTimersByTimeAsync(20_100)
      expect(isAutosavePaused()).toBe(false)
    } finally {
      cleanup()
      vi.useRealTimers()
    }
  })

  it('stays read-only when the observed slot changed while the probe is pending', async () => {
    await seededOwner()
    const live = createDoc()
    const original = JSON.stringify(serializeDoc(live))
    storage.set(AUTOSAVE_KEY, original)
    expect(readValidAutosave()).not.toBeNull()
    vi.useFakeTimers()
    const peer = new FakeChannel(AUTOSAVE_CHANNEL_NAME)
    const probes: string[] = []
    peer.addEventListener('message', (event) => {
      const data = event.data as { type?: string; requestId?: string }
      if (data.type === 'probe-session' && data.requestId) probes.push(data.requestId)
    })
    const cleanup = initAutosaveCoordination()
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(probes).toHaveLength(1)
      // Replace the slot after the outbound probe is observed, then let the
      // timeout run: only an in-section strict read can catch this race.
      storage.set(AUTOSAVE_KEY, '{"peer":true}')
      await vi.advanceTimersByTimeAsync(300)
      expect(isAutosavePaused()).toBe(true)
      expect(readAutosave()).toBe('{"peer":true}')
      expect(ownerNow()).toMatchObject({ tabId: 'prior-page', epoch: 7 })
    } finally {
      cleanup()
      vi.useRealTimers()
    }
  })

  it('stays read-only when the strict slot read fails during a reclaim', async () => {
    await seededOwner()
    const live = createDoc()
    storage.set(AUTOSAVE_KEY, JSON.stringify(serializeDoc(live)))
    readValidAutosave()
    vi.useFakeTimers()
    const getItem = vi.spyOn(localStorageMock, 'getItem')
    getItem.mockImplementation((key: string) => {
      if (key === AUTOSAVE_KEY) throw new Error('blocked')
      return storage.get(key) ?? null
    })
    const cleanup = initAutosaveCoordination()
    try {
      await vi.advanceTimersByTimeAsync(300)
      expect(isAutosavePaused()).toBe(true)
      expect(ownerNow()).toMatchObject({ tabId: 'prior-page', epoch: 7 })
      // The strict read failure arms a retry instead of giving up until reload.
      expect(vi.getTimerCount()).toBe(1)
    } finally {
      cleanup()
      getItem.mockRestore()
      vi.useRealTimers()
    }
  })

  it('holds saves while an initialization probe owns the lock', async () => {
    await seededOwner()
    const live = createDoc()
    const original = JSON.stringify(serializeDoc(live))
    storage.set(AUTOSAVE_KEY, original)
    readValidAutosave()
    vi.useFakeTimers()
    const locks = navigator.locks as unknown as FakeLockManager
    let release!: () => void
    const hold = new Promise<void>((resolve) => (release = resolve))
    const held = locks.request(AUTOSAVE_LOCK_NAME, { mode: 'exclusive' }, () => hold)
    const cleanup = initAutosaveCoordination()
    try {
      await vi.advanceTimersByTimeAsync(300)
      expect(await writeAutosaveCooperatively('{"held":true}')).toBe('read-only')
      expect(readAutosave()).toBe(original)

      release()
      await held
      await vi.advanceTimersByTimeAsync(0)
      // The finally block cleared the marker and resumed the live document.
      const resumed = readValidAutosave()
      expect(resumed?.doc.project.id).toBe(useEditorStore.getState().doc.project.id)
      expect(await writeAutosaveCooperatively('{"after":true}')).toBe('saved')
      expect(readAutosave()).toBe('{"after":true}')
    } finally {
      cleanup()
      vi.useRealTimers()
    }
  })

  it('keeps autosave enabled when a discard lands during a reclaim', async () => {
    await seededOwner()
    const live = createDoc()
    const original = JSON.stringify(serializeDoc(live))
    storage.set(AUTOSAVE_KEY, original)
    const restore = readValidAutosave()
    vi.useFakeTimers()
    const cleanup = initAutosaveCoordination()
    try {
      await vi.advanceTimersByTimeAsync(0)
      await clearAutosave(restore?.raw)
      await vi.advanceTimersByTimeAsync(300)
      expect(isAutosavePaused()).toBe(false)
      expect(ownerNow()?.tabId).not.toBe('prior-page')
    } finally {
      cleanup()
      vi.useRealTimers()
    }
  })
})

describe('autosave ownership hardening (0.29.6)', () => {
  function ownerNow(): { tabId: string; epoch: number } | null {
    const raw = storage.get(OWNER_KEY)
    return raw ? (JSON.parse(raw) as { tabId: string; epoch: number }) : null
  }

  function ownerRecord(): Record<string, unknown> | null {
    const raw = storage.get(OWNER_KEY)
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null
  }

  async function seededOwner(): Promise<Record<string, unknown>> {
    expect(await claimAutosaveOwnership()).toMatchObject({ ok: true })
    const record = JSON.parse(storage.get(OWNER_KEY)!) as Record<string, unknown>
    resetAutosaveCoordinationForTests()
    storage.set(
      OWNER_KEY,
      JSON.stringify({ ...record, tabId: 'prior-page', epoch: 7, heartbeatAt: Date.now() }),
    )
    return record
  }

  it('refuses a claim when the observed slot changed while its probe is pending', async () => {
    await seededOwner()
    const live = createDoc()
    storage.set(AUTOSAVE_KEY, JSON.stringify(serializeDoc(live)))
    expect(readValidAutosave()).not.toBeNull()
    vi.useFakeTimers()
    const peer = new FakeChannel(AUTOSAVE_CHANNEL_NAME)
    const probes: string[] = []
    peer.addEventListener('message', (event) => {
      const data = event.data as { type?: string; requestId?: string }
      if (data.type === 'probe-session' && data.requestId) probes.push(data.requestId)
    })
    // seededOwner reset coordination, so establish the channel before the
    // claim: without it the probe resolves absent immediately and there is no
    // pending window to exercise.
    const cleanup = initAutosaveCoordination()
    const claim = claimAutosaveOwnership()
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(probes).toHaveLength(2)
      storage.set(AUTOSAVE_KEY, '{"peer":true}')
      await vi.advanceTimersByTimeAsync(300)
      expect(await claim).toMatchObject({
        ok: false,
        reason: expect.stringContaining('saved this project after this page loaded'),
      })
      expect(readAutosave()).toBe('{"peer":true}')
      expect(ownerNow()).toMatchObject({ tabId: 'prior-page', epoch: 7 })
    } finally {
      cleanup()
      vi.useRealTimers()
    }
  })

  it('lets the newer of two overlapping claims own the slot', async () => {
    await seededOwner()
    vi.useFakeTimers()
    const older = claimAutosaveOwnership()
    const newer = claimAutosaveOwnership()
    try {
      await vi.advanceTimersByTimeAsync(0)
      const [olderResult, newerResult] = await Promise.all([older, newer])
      expect(olderResult).toMatchObject({
        ok: false,
        reason: expect.stringContaining('Another import took over'),
      })
      expect(newerResult.ok).toBe(true)
      if (!newerResult.ok) throw new Error('newer claim refused')
      expect(ownerNow()).toMatchObject({ epoch: newerResult.epoch })
      expect(ownerNow()?.tabId).not.toBe('prior-page')
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses a queued claim when an import lands while it waits', async () => {
    await seededOwner()
    vi.useFakeTimers()
    const locks = navigator.locks as unknown as FakeLockManager
    let release!: () => void
    const hold = new Promise<void>((resolve) => (release = resolve))
    const held = locks.request(AUTOSAVE_LOCK_NAME, { mode: 'exclusive' }, () => hold)
    const cleanup = initAutosaveCoordination()
    const other = new FakeChannel(AUTOSAVE_CHANNEL_NAME)
    const claim = claimAutosaveOwnership()
    try {
      await vi.advanceTimersByTimeAsync(300)
      other.postMessage({ type: 'imported' })
      await vi.advanceTimersByTimeAsync(0)
      release()
      await held
      await vi.advanceTimersByTimeAsync(0)
      expect(await claim).toMatchObject({
        ok: false,
        reason: expect.stringContaining('reload before it can import'),
      })
      expect(ownerNow()).toMatchObject({ tabId: 'prior-page', epoch: 7 })
    } finally {
      cleanup()
      vi.useRealTimers()
    }
  })

  it('stays read-only when a stale record carries a newer epoch', async () => {
    const live = createDoc()
    storage.set(AUTOSAVE_KEY, JSON.stringify(serializeDoc(live)))
    readValidAutosave()
    vi.useFakeTimers()
    const cleanup = initAutosaveCoordination()
    const other = new FakeChannel(AUTOSAVE_CHANNEL_NAME)
    try {
      expect(await claimAutosaveOwnership()).toMatchObject({ ok: true })
      const claimed = ownerRecord()!
      storage.set(
        OWNER_KEY,
        JSON.stringify({
          ...claimed,
          tabId: 'newer-owner',
          epoch: (claimed.epoch as number) + 1,
          heartbeatAt: Date.now() - 60_000,
        }),
      )
      // The write path marks this tab read-only against the newer record.
      expect(await writeAutosaveCooperatively('{"mine":true}')).toBe('read-only')
      expect(isAutosavePaused()).toBe(true)
      const watched: boolean[] = []
      const stopWatching = useEditorStore.subscribe((state) => watched.push(state.autosavePaused))
      other.postMessage({ type: 'resume', requestId: 'epoch-check' })
      await vi.advanceTimersByTimeAsync(0)
      stopWatching()
      // A stale lease does not make the older epoch valid again, and the
      // recheck must not briefly publish an unpaused state before the write
      // path rejects it.
      expect(watched).not.toContain(false)
      expect(isAutosavePaused()).toBe(true)
    } finally {
      cleanup()
      vi.useRealTimers()
    }
  })

  it('keeps autosave off when an import lands while a resume waits', async () => {
    const live = createDoc()
    storage.set(AUTOSAVE_KEY, JSON.stringify(serializeDoc(live)))
    readValidAutosave()
    vi.useFakeTimers()
    const cleanup = initAutosaveCoordination()
    const other = new FakeChannel(AUTOSAVE_CHANNEL_NAME)
    try {
      expect(await claimAutosaveOwnership()).toMatchObject({ ok: true })
      const claimed = ownerRecord()!
      storage.set(
        OWNER_KEY,
        JSON.stringify({
          ...claimed,
          tabId: 'newer-owner',
          epoch: (claimed.epoch as number) + 1,
          heartbeatAt: Date.now(),
        }),
      )
      expect(await writeAutosaveCooperatively('{"mine":true}')).toBe('read-only')
      expect(isAutosavePaused()).toBe(true)
      // Let the record pass the lease and epoch checks so only the import
      // check can keep the tab read-only.
      storage.set(
        OWNER_KEY,
        JSON.stringify({
          tabId: 'other-tab',
          sessionId: 'other-session',
          tokenHash: 'old',
          epoch: claimed.epoch,
          heartbeatAt: Date.now() - 60_000,
        }),
      )
      const locks = navigator.locks as unknown as FakeLockManager
      let release!: () => void
      const hold = new Promise<void>((resolve) => (release = resolve))
      const held = locks.request(AUTOSAVE_LOCK_NAME, { mode: 'exclusive' }, () => hold)
      const watched: boolean[] = []
      const stopWatching = useEditorStore.subscribe((state) => watched.push(state.autosavePaused))
      other.postMessage({ type: 'resume', requestId: 'import-wait' })
      await vi.advanceTimersByTimeAsync(0)
      other.postMessage({ type: 'imported' })
      await vi.advanceTimersByTimeAsync(0)
      release()
      await held
      await vi.advanceTimersByTimeAsync(0)
      stopWatching()
      // The import check must win inside the section, before the store is
      // published as unpaused.
      expect(watched).not.toContain(false)
      expect(isAutosavePaused()).toBe(true)
    } finally {
      cleanup()
      vi.useRealTimers()
    }
  })

  it('keeps autosave off when an import fence moves while a resume waits', async () => {
    const live = createDoc()
    const original = JSON.stringify(serializeDoc(live))
    storage.set(AUTOSAVE_KEY, original)
    readValidAutosave()
    vi.useFakeTimers()
    const cleanup = initAutosaveCoordination()
    const other = new FakeChannel(AUTOSAVE_CHANNEL_NAME)
    try {
      expect(await claimAutosaveOwnership()).toMatchObject({ ok: true })
      const claimed = ownerRecord()!
      storage.set(
        OWNER_KEY,
        JSON.stringify({
          ...claimed,
          tabId: 'newer-owner',
          epoch: (claimed.epoch as number) + 1,
          heartbeatAt: Date.now(),
        }),
      )
      expect(await writeAutosaveCooperatively('{"mine":true}')).toBe('read-only')
      expect(isAutosavePaused()).toBe(true)
      storage.set(
        OWNER_KEY,
        JSON.stringify({
          tabId: 'other-tab',
          sessionId: 'other-session',
          tokenHash: 'old',
          epoch: claimed.epoch,
          heartbeatAt: Date.now() - 60_000,
        }),
      )
      const locks = navigator.locks as unknown as FakeLockManager
      let release!: () => void
      const hold = new Promise<void>((resolve) => (release = resolve))
      const held = locks.request(AUTOSAVE_LOCK_NAME, { mode: 'exclusive' }, () => hold)
      const watched: boolean[] = []
      const stopWatching = useEditorStore.subscribe((state) => watched.push(state.autosavePaused))
      other.postMessage({ type: 'resume', requestId: 'fence-wait' })
      await vi.advanceTimersByTimeAsync(0)
      storage.set(IMPORT_KEY, 'import-token')
      await vi.advanceTimersByTimeAsync(0)
      release()
      await held
      await vi.advanceTimersByTimeAsync(0)
      stopWatching()
      // The changed fence keeps the tab read-only inside the section.
      expect(watched).not.toContain(false)
      expect(isAutosavePaused()).toBe(true)
      expect(readAutosave()).toBe(original)
      // The marker is permanent for this session. Do not keep a retry timer
      // alive that can never match again.
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      cleanup()
      vi.useRealTimers()
    }
  })

  it('does not write the boot document when a reclaim holds no save', async () => {
    await seededOwner()
    const saved = createDoc()
    saved.project.name = 'Saved project'
    const original = JSON.stringify(serializeDoc(saved))
    storage.set(AUTOSAVE_KEY, original)
    expect(readValidAutosave()?.doc.project.name).toBe('Saved project')
    vi.useFakeTimers()
    const cleanup = initAutosaveCoordination()
    try {
      await vi.advanceTimersByTimeAsync(0)
      // A project-scoped write rejected by the probe is not an ordinary held
      // save; the import retry owns it.
      expect(await writeAutosaveCooperatively('{"scoped":true}', undefined, 'proj_scoped')).toBe(
        'read-only',
      )
      await vi.advanceTimersByTimeAsync(300)
      expect(isAutosavePaused()).toBe(false)
      expect(ownerNow()?.tabId).not.toBe('prior-page')
      // Nothing was waiting, so the restore candidate is untouched.
      expect(readAutosave()).toBe(original)
    } finally {
      cleanup()
      vi.useRealTimers()
    }
  })

  it('lets an own save that lands before the claim match the slot', async () => {
    expect(await writeAutosaveCooperatively('{"own":true}')).toBe('saved')
    expect(await claimAutosaveOwnership()).toMatchObject({ ok: true })
    expect(readAutosave()).toBe('{"own":true}')
  })

  it('fails a claim write closed without leaving the heartbeat armed', async () => {
    vi.useFakeTimers()
    expect(await claimAutosaveOwnership()).toMatchObject({ ok: true })
    const firstOwner = ownerNow()
    const setItem = vi.spyOn(localStorageMock, 'setItem')
    let ownerWrites = 0
    setItem.mockImplementation((key: string, value: string) => {
      if (key === OWNER_KEY) {
        ownerWrites += 1
        throw new Error('quota')
      }
      storage.set(key, value)
    })
    try {
      expect(await claimAutosaveOwnership()).toMatchObject({ ok: false })
      expect(isAutosavePaused()).toBe(true)
      expect(ownerNow()).toMatchObject(firstOwner!)
      const afterFailure = ownerWrites
      await vi.advanceTimersByTimeAsync(5_100)
      expect(ownerWrites).toBe(afterFailure)
    } finally {
      setItem.mockRestore()
      vi.useRealTimers()
    }
  })

  it('reports saved but goes read-only when the save-time refresh fails', async () => {
    vi.useFakeTimers()
    expect(await claimAutosaveOwnership()).toMatchObject({ ok: true })
    const firstOwner = ownerNow()
    const setItem = vi.spyOn(localStorageMock, 'setItem')
    let ownerWrites = 0
    setItem.mockImplementation((key: string, value: string) => {
      if (key === OWNER_KEY) {
        ownerWrites += 1
        throw new Error('quota')
      }
      storage.set(key, value)
    })
    try {
      expect(await writeAutosaveCooperatively('{"slot":true}')).toBe('saved')
      expect(ownerWrites).toBe(1)
      expect(isAutosavePaused()).toBe(true)
      expect(ownerNow()).toMatchObject(firstOwner!)
      expect(await writeAutosaveCooperatively('{"later":true}')).toBe('read-only')
      expect(readAutosave()).toBe('{"slot":true}')
    } finally {
      setItem.mockRestore()
      vi.useRealTimers()
    }
  })

  it('returns error when the missing-record re-establish write fails', async () => {
    vi.useFakeTimers()
    expect(await claimAutosaveOwnership()).toMatchObject({ ok: true })
    storage.delete(OWNER_KEY)
    const setItem = vi.spyOn(localStorageMock, 'setItem')
    setItem.mockImplementation((key: string, value: string) => {
      if (key === OWNER_KEY) throw new Error('quota')
      storage.set(key, value)
    })
    try {
      expect(await writeAutosaveCooperatively('{"slot":true}')).toBe('error')
      expect(isAutosavePaused()).toBe(true)
      expect(storage.has(OWNER_KEY)).toBe(false)
      expect(await writeAutosaveCooperatively('{"later":true}')).toBe('read-only')
    } finally {
      setItem.mockRestore()
      vi.useRealTimers()
    }
  })

  it('reclaims after a heartbeat refresh during the first probe and a crash', async () => {
    await seededOwner()
    vi.useFakeTimers()
    const cleanup = initAutosaveCoordination()
    try {
      await vi.advanceTimersByTimeAsync(200)
      const record = JSON.parse(storage.get(OWNER_KEY)!) as Record<string, unknown>
      storage.set(OWNER_KEY, JSON.stringify({ ...record, heartbeatAt: Date.now() + 1_000 }))
      await vi.advanceTimersByTimeAsync(400)
      expect(isAutosavePaused()).toBe(false)
      expect(ownerNow()?.tabId).not.toBe('prior-page')
      expect(ownerNow()?.epoch).toBe(7)
    } finally {
      cleanup()
      vi.useRealTimers()
    }
  })

  it('stays read-only when the peer refreshes during both probes', async () => {
    await seededOwner()
    storage.set(AUTOSAVE_KEY, JSON.stringify(serializeDoc(createDoc())))
    readValidAutosave()
    vi.useFakeTimers()
    const cleanup = initAutosaveCoordination()
    try {
      await vi.advanceTimersByTimeAsync(200)
      const first = JSON.parse(storage.get(OWNER_KEY)!) as Record<string, unknown>
      storage.set(OWNER_KEY, JSON.stringify({ ...first, heartbeatAt: Date.now() + 1_000 }))
      await vi.advanceTimersByTimeAsync(100)
      const second = JSON.parse(storage.get(OWNER_KEY)!) as Record<string, unknown>
      storage.set(OWNER_KEY, JSON.stringify({ ...second, heartbeatAt: Date.now() + 30_000 }))
      await vi.advanceTimersByTimeAsync(400)
      expect(isAutosavePaused()).toBe(true)
      expect(ownerNow()).toMatchObject({ tabId: 'prior-page', epoch: 7 })
      // A fresh peer keeps the tab read-only and the lease check reschedules.
      expect(vi.getTimerCount()).toBe(1)
      await vi.advanceTimersByTimeAsync(20_100)
      expect(isAutosavePaused()).toBe(true)
      expect(vi.getTimerCount()).toBe(1)
      // Once the peer stops refreshing, the next lease check resumes.
      storage.set(
        OWNER_KEY,
        JSON.stringify({
          tabId: 'prior-page',
          sessionId: 'prior-session',
          tokenHash: 'old',
          epoch: 7,
          heartbeatAt: Date.now() - 60_000,
        }),
      )
      await vi.advanceTimersByTimeAsync(20_100)
      expect(isAutosavePaused()).toBe(false)
    } finally {
      cleanup()
      vi.useRealTimers()
    }
  })

  it('resumes after a peer answers and then its record goes stale', async () => {
    const record = await seededOwner()
    const live = createDoc()
    storage.set(AUTOSAVE_KEY, JSON.stringify(serializeDoc(live)))
    readValidAutosave()
    vi.useFakeTimers()
    const peer = new FakeChannel(AUTOSAVE_CHANNEL_NAME)
    peer.addEventListener('message', (event) => {
      const data = event.data as { type?: string; requestId?: string }
      if (data.type === 'probe-session' && data.requestId) {
        peer.postMessage({
          type: 'session-present',
          requestId: data.requestId,
          sessionId: record.sessionId,
        })
      }
    })
    const cleanup = initAutosaveCoordination()
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(isAutosavePaused()).toBe(true)
      storage.set(
        OWNER_KEY,
        JSON.stringify({
          ...record,
          tabId: 'prior-page',
          epoch: 7,
          heartbeatAt: Date.now() - 60_000,
        }),
      )
      await vi.advanceTimersByTimeAsync(20_100)
      expect(isAutosavePaused()).toBe(false)
    } finally {
      cleanup()
      vi.useRealTimers()
    }
  })

  it('ignores an unexpected pause acknowledgement until the known peer answers', async () => {
    vi.useFakeTimers()
    const locks = Object.assign(new FakeLockManager(), {
      query: async () => ({ held: [{ name: 'videoh-autosave-tab:peer-1' }] }),
    })
    vi.stubGlobal('navigator', { locks })
    const cleanup = initAutosaveCoordination()
    const other = new FakeChannel(AUTOSAVE_CHANNEL_NAME)
    let requestId: string | null = null
    other.addEventListener('message', (event) => {
      const data = event.data as { type?: string; requestId?: string }
      if (data.type === 'pause' && data.requestId) requestId = data.requestId
    })
    try {
      let settled = false
      const pending = pauseOtherAutosaveTabs().then((result) => {
        settled = true
        return result
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(requestId).not.toBeNull()
      // The active request id matches, so only the tab-id check can reject it.
      other.postMessage({ type: 'paused', requestId: requestId!, tabId: 'unexpected-tab' })
      await vi.advanceTimersByTimeAsync(0)
      expect(settled).toBe(false)
      other.postMessage({ type: 'paused', requestId: requestId!, tabId: 'peer-1' })
      expect(await pending).toMatchObject({ ok: true })
    } finally {
      cleanup()
      vi.useRealTimers()
    }
  })
})

describe('autosave transient handoff (0.29.6)', () => {
  it('defers a resumed save until a no-frame gesture ends', async () => {
    vi.useFakeTimers()
    const coordination = initAutosaveCoordination()
    const autosave = initAutosave()
    const other = new FakeChannel(AUTOSAVE_CHANNEL_NAME)
    try {
      useEditorStore.getState().apply({ type: 'setProjectSettings', patch: { name: 'committed' } })
      useEditorStore.getState().beginTransient(77)
      other.postMessage({ type: 'pause', requestId: 'transient-pause' })
      expect(isAutosavePaused()).toBe(true)
      other.postMessage({ type: 'resume', requestId: 'transient-pause' })
      expect(isAutosavePaused()).toBe(false)

      // The resume must not persist an unfinished gesture, and the cancelled
      // debounce timer must not fire on its own either.
      await vi.advanceTimersByTimeAsync(900)
      for (let i = 0; i < 10; i += 1) await Promise.resolve()
      expect(readAutosave()).toBeNull()

      // A no-frame cancel changes no doc, past, or future reference. The
      // deferred resume must still own the flush.
      useEditorStore.getState().cancelTransient()
      await vi.advanceTimersByTimeAsync(900)
      for (let i = 0; i < 10; i += 1) await Promise.resolve()
      expect(readValidAutosave()?.doc.project.name).toBe('committed')
    } finally {
      autosave()
      coordination()
      vi.useRealTimers()
    }
  })
})
