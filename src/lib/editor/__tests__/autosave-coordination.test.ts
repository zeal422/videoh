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
  readAutosave,
  readValidAutosave,
  recordInstallUnderLock,
  releaseAutosaveOwnership,
  resetAutosaveCoordinationForTests,
  resumeAutosaveTabs,
  writeAutosaveCooperatively,
} from '../persistence'
import { readPendingInstallRecords } from '../media/installed-registry'
import { useEditorStore } from '../store'
import { createDoc } from '../factories'
import { parseSerializedDoc, serializeDoc } from '../serialization'
import { FakeLockManager } from './mocks/opfs'

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
    expect(record.epoch).toBe(5)
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
    writeRecord({ tabId: 'other-tab', heartbeatAt: Date.now() - 60_000, epoch: 2 })
    expect((await claimAutosaveOwnership()).ok).toBe(true)
    writeRecord({ tabId: 'other-tab', heartbeatAt: Date.now() - 60_000, epoch: 4 })
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
    locks.request = ((name: string, options: never, callback: never) => {
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
    locks.request = ((name: string, options: never, callback: never) => {
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
})
