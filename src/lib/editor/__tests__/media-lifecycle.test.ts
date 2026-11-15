import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  currentProjectLock,
  downloadProjectJSON,
  ensureProjectLock,
  importMediaFiles,
  importRecordedFile,
  installProject,
  openProjectFile,
  ProjectClaimError,
  releaseProjectLock,
  relinkPatchFor,
  restoreAutosaveProject,
} from '../project-io'
import { createDoc, createMediaAsset } from '../factories'
import { serializeDoc } from '../serialization'
import { useEditorStore } from '../store'
import {
  ensureProjectMedia,
  readMediaClaims,
  readMediaFile,
  sha256Hex,
  writeMediaFile,
} from '../media/media-store'
import {
  beginMediaActivity,
  cleanUnusedMedia,
  clearAllProjectMedia,
  endMediaActivity,
  isMediaActivityActive,
  runCleanExclusive,
  storeMediaAsset,
  writeProjectClaim,
} from '../media/persist'
import { collectMediaHashes } from '../media-cleanup-plan'
import { mimeTypeForName, rehydrateMedia, revokeRehydratedUrls } from '../media/rehydrate'
import { ProjectLock, projectLockName } from '../media/project-lock'
import { createFakeOpfs, FakeLockManager, type FakeOpfs } from './mocks/opfs'
import type { MediaAsset } from '../types'

const toastMock = vi.hoisted(() => vi.fn())
vi.mock('@/hooks/use-toast', () => ({ toast: toastMock }))

const probeMock = vi.hoisted(() => ({ importFile: vi.fn() }))
vi.mock('../media/probe', () => probeMock)

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  useEditorStore.setState({ mediaCleanBlocked: false })
})

const TEXT = 'the source bytes'

function sourceFile(name = 'clip.mp4', type = 'video/mp4', text = TEXT) {
  return new File([text], name, { type })
}

function bytes(text: string) {
  return new TextEncoder().encode(text)
}

async function hashOf(text = TEXT) {
  return sha256Hex(bytes(text))
}

function docWithHash(hash: string, name = 'clip.mp4', type = 'video/mp4') {
  const doc = createDoc()
  doc.media = [
    createMediaAsset({
      id: 'media_1',
      kind: 'video',
      name,
      duration: 10,
      width: 640,
      height: 360,
      contentHash: hash,
      // A parsed doc always starts offline; rehydration clears it.
      missing: true,
    }),
  ]
  return doc
}

function stubStore(fake: FakeOpfs, locks?: FakeLockManager) {
  vi.stubGlobal('navigator', {
    storage: {
      getDirectory: async () => fake.root,
      estimate: async () => ({ usage: fake.usage(), quota: 4096 }),
      persist: async () => true,
      persisted: async () => false,
    },
    ...(locks ? { locks } : {}),
  })
}

describe('storeMediaAsset', () => {
  it('stores the bytes and returns the asset with its hash', async () => {
    const fake = createFakeOpfs()
    stubStore(fake)
    const hash = await hashOf()
    const asset = createMediaAsset({
      kind: 'video',
      name: 'clip.mp4',
      contentHash: hash,
      file: sourceFile(),
    })
    const result = await storeMediaAsset('proj_a', asset)
    expect(result.stored).toBe(true)
    expect(result.asset.contentHash).toBe(hash)
    expect(await readMediaFile('proj_a', hash)).not.toBeNull()
  })

  it('creates the claims directory with the first stored import', async () => {
    // A fresh session's doc never installs, so the claims directory does not
    // exist yet. Without it, clean would read "records lost" and refuse to
    // reclaim anything the user later removes.
    const fake = createFakeOpfs()
    stubStore(fake)
    const hash = await hashOf()
    const asset = createMediaAsset({
      kind: 'video',
      name: 'clip.mp4',
      contentHash: hash,
      file: sourceFile(),
    })
    expect(await storeMediaAsset('proj_fresh', asset)).toMatchObject({ stored: true })
    expect(await readMediaClaims('proj_fresh')).toEqual([])
  })

  it('degrades to a session-only asset when the write fails', async () => {
    const fake = createFakeOpfs()
    fake.failWrites = 1
    stubStore(fake)
    const hash = await hashOf()
    const asset = createMediaAsset({
      kind: 'video',
      name: 'clip.mp4',
      contentHash: hash,
      file: sourceFile(),
    })
    const result = await storeMediaAsset('proj_a', asset)
    expect(result.stored).toBe(false)
    expect(result.asset.contentHash).toBeUndefined()
    expect(result.asset.missing).toBe(false)
    expect(result.warning).toContain('clip.mp4')
    expect(fake.files.size).toBe(0)
  })

  it('treats an asset without a file or hash as session-only', async () => {
    const fake = createFakeOpfs()
    stubStore(fake)
    const result = await storeMediaAsset(
      'proj_a',
      createMediaAsset({ kind: 'audio', name: 'voice.wav' }),
    )
    expect(result.stored).toBe(false)
    expect(result.warning).toBeTruthy()

    // A hash without bytes must not survive: it would name stored media that
    // was never written.
    const orphan = await storeMediaAsset(
      'proj_a',
      createMediaAsset({ kind: 'audio', name: 'voice.wav', contentHash: 'a'.repeat(64) }),
    )
    expect(orphan.stored).toBe(false)
    expect(orphan.asset.contentHash).toBeUndefined()
  })

  it('serializes concurrent cleans instead of letting both enter', async () => {
    const order: string[] = []
    let releaseFirst!: () => void
    const first = runCleanExclusive(
      () =>
        new Promise<string>((resolve) => {
          order.push('first-enter')
          releaseFirst = () => resolve('first')
        }),
    )
    // Let the first call take the flag.
    await new Promise((resolve) => setTimeout(resolve, 10))
    let releaseSecond!: () => void
    const second = runCleanExclusive(
      () =>
        new Promise<string>((resolve) => {
          order.push('second-enter')
          releaseSecond = () => resolve('second')
        }),
    )
    let thirdEntered = false
    const third = runCleanExclusive(async () => {
      thirdEntered = true
      order.push('third-enter')
      return 'third'
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    // Both waiters must stay out while the first holds the flag.
    expect(order).toEqual(['first-enter'])

    releaseFirst()
    expect(await first).toBe('first')
    // The second waiter entered next; the third must still wait for it.
    await vi.waitFor(() => expect(order).toContain('second-enter'))
    expect(thirdEntered).toBe(false)

    releaseSecond()
    expect(await second).toBe('second')
    expect(await third).toBe('third')
    expect(order).toEqual(['first-enter', 'second-enter', 'third-enter'])
  })

  it('holds a clean across a later import so a candidate cannot be rewritten', async () => {
    const fake = createFakeOpfs()
    stubStore(fake)
    const hash = await hashOf()
    let releaseClean!: () => void
    const clean = runCleanExclusive(
      () =>
        new Promise<void>((resolve) => {
          releaseClean = resolve
        }),
    )
    // A clean has the flag: the import reserves activity only after it ends.
    const pendingStore = storeMediaAsset(
      'proj_clean',
      createMediaAsset({
        kind: 'video',
        name: 'clip.mp4',
        contentHash: hash,
        file: sourceFile(),
      }),
    )
    // The write waits for the clean: it has not even reserved activity yet.
    expect(isMediaActivityActive()).toBe(false)
    expect(fake.files.size).toBe(0)

    releaseClean()
    await clean
    expect(await pendingStore).toMatchObject({ stored: true })
    expect(await readMediaFile('proj_clean', hash)).not.toBeNull()
  })

  it('counts an in-flight media write so clean can refuse', async () => {
    expect(isMediaActivityActive()).toBe(false)
    beginMediaActivity()
    expect(isMediaActivityActive()).toBe(true)
    endMediaActivity()
    expect(isMediaActivityActive()).toBe(false)
  })
})

describe('rehydrateMedia', () => {
  it('restores file and url from the hash and sidecar, clearing missing', async () => {
    const fake = createFakeOpfs()
    stubStore(fake)
    const hash = await hashOf()
    const doc = docWithHash(hash)
    await writeMediaFile(doc.project.id, hash, sourceFile('clip.mp4', 'video/quicktime'))

    const result = await rehydrateMedia(doc)
    expect(result.hydrated).toBe(1)
    expect(result.unreadable).toBe(0)
    expect(result.urls).toHaveLength(1)
    const asset = result.doc.media[0]
    expect(asset.missing).toBe(false)
    expect(asset.url).toBe(result.urls[0])
    expect(asset.file?.name).toBe('clip.mp4')
    expect(asset.file?.type).toBe('video/quicktime')
    revokeRehydratedUrls(result.urls)
  })

  it("refuses a clean that would run under another project's lock", async () => {
    const fake = createFakeOpfs()
    const locks = new FakeLockManager()
    stubStore(fake, locks)
    const hash = await hashOf()
    await ensureProjectMedia('proj_clean_a')
    await writeMediaFile('proj_clean_a', hash, sourceFile())
    const lockB = await ProjectLock.acquire('proj_clean_b')
    try {
      // An undo that restored project A leaves B's hold active; deleting A's
      // bytes under B's coordination would prove nothing about A's readers.
      const outcome = await cleanUnusedMedia({
        projectId: 'proj_clean_a',
        lock: lockB,
        cleanBlocked: false,
        referenced: () => new Set<string>(),
      })
      expect(outcome).toEqual({ status: 'unsupported' })
      expect(await readMediaFile('proj_clean_a', hash)).not.toBeNull()
    } finally {
      lockB.dispose()
    }
  })

  it('refuses a clean while an install record is still pending', async () => {
    const fake = createFakeOpfs()
    const locks = new FakeLockManager()
    stubStore(fake, locks)
    const hash = await hashOf()
    await ensureProjectMedia('proj_clean')
    await writeMediaFile('proj_clean', hash, sourceFile())
    const lock = await ProjectLock.acquire('proj_clean')
    try {
      const outcome = await cleanUnusedMedia({
        projectId: 'proj_clean',
        lock,
        cleanBlocked: false,
        referenced: () => new Set<string>(),
        pendingInstall: () => true,
      })
      expect(outcome).toEqual({ status: 'pending' })
      expect(await readMediaFile('proj_clean', hash)).not.toBeNull()
    } finally {
      lock.dispose()
    }
  })

  it('refuses a clean whose install record becomes pending during the preview', async () => {
    const fake = createFakeOpfs()
    const locks = new FakeLockManager()
    stubStore(fake, locks)
    const hash = await hashOf()
    await ensureProjectMedia('proj_clean')
    await writeMediaFile('proj_clean', hash, sourceFile())
    const lock = await ProjectLock.acquire('proj_clean')
    try {
      // The entry check passes, then the install lands while the preview
      // yields. The inner recheck must refuse before recovery can retire it.
      let pending = false
      const outcomePromise = cleanUnusedMedia({
        projectId: 'proj_clean',
        lock,
        cleanBlocked: false,
        referenced: () => new Set<string>(),
        pendingInstall: () => pending,
      })
      pending = true
      expect(await outcomePromise).toEqual({ status: 'pending' })
      expect(await readMediaFile('proj_clean', hash)).not.toBeNull()
    } finally {
      lock.dispose()
    }
  })

  it('holds an independent lock on the saved project through its claim', async () => {
    const fake = createFakeOpfs()
    const locks = new FakeLockManager()
    stubStore(fake, locks)
    vi.stubGlobal('document', {
      createElement: () => ({ click: () => undefined, href: '', download: '' }),
    })
    const hash = await hashOf()
    const docA = docWithHash(hash)
    const docB = createDoc()
    const lockB = await ensureProjectLock(docB)
    useEditorStore.setState({ doc: docA })
    const acquire = vi.spyOn(ProjectLock, 'acquire')
    try {
      await downloadProjectJSON()
      // The save announces the snapshot project with its own hold instead of
      // borrowing the active one: an install that switches the active hold
      // mid-claim cannot drop this announcement.
      expect(acquire).toHaveBeenCalledWith(docA.project.id)
      expect(currentProjectLock()).toBe(lockB)
      expect(await readMediaClaims(docA.project.id)).toEqual([hash])
    } finally {
      acquire.mockRestore()
      releaseProjectLock()
      vi.unstubAllGlobals()
    }
  })

  it('refuses a clean whose project changed before the deletes', async () => {
    const fake = createFakeOpfs()
    const locks = new FakeLockManager()
    stubStore(fake, locks)
    const hash = await hashOf()
    await ensureProjectMedia('proj_clean')
    await writeMediaFile('proj_clean', hash, sourceFile())
    const lock = await ProjectLock.acquire('proj_clean')
    try {
      const outcome = await cleanUnusedMedia({
        projectId: 'proj_clean',
        lock,
        cleanBlocked: false,
        referenced: () => new Set<string>(),
        isProjectCurrent: () => false,
      })
      expect(outcome).toEqual({ status: 'changed' })
      expect(await readMediaFile('proj_clean', hash)).not.toBeNull()
    } finally {
      lock.dispose()
    }
  })

  it('waits for an in-flight media write before clearing', async () => {
    const fake = createFakeOpfs()
    const locks = new FakeLockManager()
    stubStore(fake, locks)
    const project = 'proj_clear_wait'
    const hash = await hashOf()
    await ensureProjectMedia(project)
    await writeMediaFile(project, hash, sourceFile())
    const lock = await ProjectLock.acquire(project)
    beginMediaActivity()

    let settled = false
    const pending = clearAllProjectMedia({ projectId: project, lock }).then((outcome) => {
      settled = true
      return outcome
    })
    // The clear holds the same-tab flag and waits for the write already running.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(settled).toBe(false)
    expect(await readMediaFile(project, hash)).not.toBeNull()

    endMediaActivity()
    expect(await pending).toEqual({
      status: 'ran',
      result: { deleted: 1, reclaimed: sourceFile().size },
    })
    expect(await readMediaFile(project, hash)).toBeNull()
    lock.dispose()
  })

  it('refuses clear-all without a matching shared hold', async () => {
    const fake = createFakeOpfs()
    const locks = new FakeLockManager()
    stubStore(fake, locks)
    const hash = await hashOf()
    await ensureProjectMedia('proj_clear_nomatch')
    await writeMediaFile('proj_clear_nomatch', hash, sourceFile())
    const other = await ProjectLock.acquire('proj_other')

    try {
      expect(await clearAllProjectMedia({ projectId: 'proj_clear_nomatch', lock: null })).toEqual({
        status: 'unsupported',
      })
      expect(await clearAllProjectMedia({ projectId: 'proj_clear_nomatch', lock: other })).toEqual({
        status: 'unsupported',
      })
      // Neither refusal deletes.
      expect(await readMediaFile('proj_clear_nomatch', hash)).not.toBeNull()
    } finally {
      other.dispose()
    }
  })

  it('refuses clear-all without Web Locks coordination', async () => {
    const fake = createFakeOpfs()
    stubStore(fake)
    const project = 'proj_clear_nolocks'
    const hash = await hashOf()
    await ensureProjectMedia(project)
    await writeMediaFile(project, hash, sourceFile())
    // No `locks` in the stubbed navigator: acquires cannot hold, so the
    // reset must refuse instead of deleting without a cross-tab guard.
    const lock = await ProjectLock.acquire(project)

    try {
      expect(await clearAllProjectMedia({ projectId: project, lock })).toEqual({
        status: 'unsupported',
      })
      expect(await readMediaFile(project, hash)).not.toBeNull()
    } finally {
      lock.dispose()
    }
  })

  it('refuses clear-all while another tab holds the project', async () => {
    const fake = createFakeOpfs()
    const locks = new FakeLockManager()
    stubStore(fake, locks)
    const project = 'proj_clear_busy'
    const hash = await hashOf()
    await ensureProjectMedia(project)
    await writeMediaFile(project, hash, sourceFile())
    const lock = await ProjectLock.acquire(project)
    let releaseHolder!: () => void
    const holder = locks.request(
      projectLockName(project),
      { mode: 'exclusive' },
      () =>
        new Promise<void>((resolve) => {
          releaseHolder = resolve
        }),
    )
    const pending = clearAllProjectMedia({ projectId: project, lock })
    try {
      // Let the exclusive request see the other tab's hold, then release it so
      // this tab's restored shared hold can settle.
      await new Promise((resolve) => setTimeout(resolve, 10))
      releaseHolder()
      await holder
      expect(await pending).toEqual({ status: 'busy' })
      expect(await readMediaFile(project, hash)).not.toBeNull()
    } finally {
      lock.dispose()
    }
  })

  it('reports a failed delete instead of an empty clear', async () => {
    const fake = createFakeOpfs()
    const locks = new FakeLockManager()
    stubStore(fake, locks)
    const project = 'proj_clear_fail'
    const hash = await hashOf()
    await ensureProjectMedia(project)
    await writeMediaFile(project, hash, sourceFile())
    const lock = await ProjectLock.acquire(project)
    fake.failRemoves = 1

    try {
      await expect(clearAllProjectMedia({ projectId: project, lock })).rejects.toThrow()
      // The failure is not counted as "nothing to remove": the entry is still there.
      expect(await readMediaFile(project, hash)).not.toBeNull()
    } finally {
      lock.dispose()
    }
  })

  it('keeps the installed lock and drops the replacement when a restore is discarded', async () => {
    const fake = createFakeOpfs()
    const locks = new FakeLockManager()
    stubStore(fake, locks)
    const hash = await hashOf()
    const docA = createDoc()
    const docB = docWithHash(hash)
    await ensureProjectMedia(docB.project.id)
    await writeMediaFile(docB.project.id, hash, sourceFile())
    const lockA = await ensureProjectLock(docA, { forInstall: true })
    installProject(docA)

    const restored = await restoreAutosaveProject({ doc: docB, warnings: [] }, () => false)

    expect(restored).toBeNull()
    expect(currentProjectLock()).toBe(lockA)
    expect(locks.held(projectLockName(docA.project.id))).toBe(1)
    await vi.waitFor(() => expect(locks.held(projectLockName(docB.project.id))).toBe(0))
  })

  it('keeps a v4 asset with no hash missing and relinkable', async () => {
    const fake = createFakeOpfs()
    stubStore(fake)
    const doc = createDoc()
    doc.media = [createMediaAsset({ id: 'm', kind: 'video', name: 'old.mp4', missing: true })]
    const result = await rehydrateMedia(doc)
    expect(result.hydrated).toBe(0)
    expect(result.doc.media[0].missing).toBe(true)
    expect(result.doc.media[0].url).toBe('')
  })

  it('keeps an asset whose stored bytes are missing or damaged missing', async () => {
    const fake = createFakeOpfs()
    stubStore(fake)
    const hash = await hashOf()
    const doc = docWithHash(hash)
    const missing = await rehydrateMedia(doc)
    expect(missing.unreadable).toBe(1)
    expect(missing.doc.media[0].missing).toBe(true)

    await writeMediaFile(doc.project.id, hash, sourceFile())
    fake.put(`/${doc.project.id}/${hash}`, 'swapped')
    const damaged = await rehydrateMedia(doc)
    expect(damaged.unreadable).toBe(1)
    expect(damaged.doc.media[0].missing).toBe(true)
  })

  it('derives the type from the extension when the sidecar is gone', async () => {
    const fake = createFakeOpfs()
    stubStore(fake)
    const hash = await hashOf()
    const doc = docWithHash(hash, 'clip.mp3', 'audio/mpeg')
    await writeMediaFile(doc.project.id, hash, sourceFile('clip.mp3', 'audio/mpeg'))
    fake.remove(`/${doc.project.id}/${hash}.json`)
    const result = await rehydrateMedia(doc)
    expect(result.warnings).toEqual([expect.stringContaining('file extension')])
    expect(result.doc.media[0].file?.type).toBe('audio/mpeg')
  })

  it('maps known extensions and falls back to a binary type', () => {
    expect(mimeTypeForName('A.MP4')).toBe('video/mp4')
    expect(mimeTypeForName('still.png')).toBe('image/png')
    expect(mimeTypeForName('thing.unknown')).toBe('application/octet-stream')
    expect(mimeTypeForName('no-extension')).toBe('application/octet-stream')
  })

  it('collects only valid doc hashes', async () => {
    const hash = await hashOf()
    const doc = docWithHash(hash)
    doc.media.push(createMediaAsset({ id: 'm2', kind: 'video', contentHash: '../evil' }))
    expect(collectMediaHashes(doc)).toEqual([hash])
  })
})

describe('importMediaFiles wiring', () => {
  it('attaches the hash only after the store write succeeds', async () => {
    const fake = createFakeOpfs()
    stubStore(fake)
    const hash = await hashOf()
    useEditorStore.setState({ doc: createDoc() })
    probeMock.importFile.mockResolvedValue(
      createMediaAsset({
        kind: 'video',
        name: 'clip.mp4',
        contentHash: hash,
        file: sourceFile(),
        url: 'blob:fresh',
      }),
    )
    expect(await importMediaFiles([sourceFile()])).toBe(1)
    const asset = useEditorStore.getState().doc.media[0]
    expect(asset.contentHash).toBe(hash)
    expect(await readMediaFile(useEditorStore.getState().doc.project.id, hash)).not.toBeNull()
  })

  it('adds a session-only asset when the store write fails', async () => {
    const fake = createFakeOpfs()
    fake.failWrites = 1
    stubStore(fake)
    const hash = await hashOf()
    useEditorStore.setState({ doc: createDoc() })
    probeMock.importFile.mockResolvedValue(
      createMediaAsset({
        kind: 'video',
        name: 'clip.mp4',
        contentHash: hash,
        file: sourceFile(),
        url: 'blob:fresh',
      }),
    )
    expect(await importMediaFiles([sourceFile()])).toBe(1)
    const asset = useEditorStore.getState().doc.media[0]
    expect(asset.contentHash).toBeUndefined()
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Media is session-only' }),
    )
  })

  it('keeps the old hash and bytes when a relink write fails', async () => {
    const fake = createFakeOpfs()
    stubStore(fake)
    const oldHash = await hashOf()
    const doc = docWithHash(oldHash, 'clip.mp4')
    doc.media[0].missing = false
    doc.media[0].url = 'blob:old'
    await writeMediaFile(doc.project.id, oldHash, sourceFile())
    useEditorStore.setState({ doc })

    const newHash = await sha256Hex(bytes('replacement bytes'))
    const fresh = createMediaAsset({
      kind: 'video',
      name: 'clip.mp4',
      contentHash: newHash,
      file: new File(['replacement bytes'], 'clip.mp4', { type: 'video/mp4' }),
      url: 'blob:replacement',
    })
    fake.failWrites = 1
    const stored = await storeMediaAsset(doc.project.id, fresh)
    expect(stored.stored).toBe(false)
    expect(
      useEditorStore.getState().apply({
        type: 'relinkMedia',
        mediaId: 'media_1',
        patch: relinkPatchFor(stored.asset, stored.stored),
      }),
    ).toBe(true)

    const relinked = useEditorStore.getState().doc.media[0]
    expect(relinked.contentHash).toBeUndefined()
    expect(relinked.missing).toBe(false)
    expect(relinked.url).toBe('blob:replacement')
    // The old revision is still stored for undo and other copies.
    expect(await readMediaFile(doc.project.id, oldHash)).not.toBeNull()
  })

  it('relinks a missing asset with the new hash', async () => {
    const fake = createFakeOpfs()
    stubStore(fake)
    const hash = await hashOf()
    const doc = createDoc()
    doc.media = [
      createMediaAsset({ id: 'missing', kind: 'video', name: 'clip.mp4', missing: true, url: '' }),
    ]
    useEditorStore.setState({ doc })
    probeMock.importFile.mockResolvedValue(
      createMediaAsset({
        kind: 'video',
        name: 'clip.mp4',
        contentHash: hash,
        file: sourceFile(),
        url: 'blob:fresh',
      }),
    )
    expect(await importMediaFiles([sourceFile()])).toBe(1)
    const asset = useEditorStore.getState().doc.media[0]
    expect(asset.missing).toBe(false)
    expect(asset.contentHash).toBe(hash)
    expect(await readMediaFile(doc.project.id, hash)).not.toBeNull()
  })

  it('returns the relinked entry id when a recorded take matches a missing asset', async () => {
    const fake = createFakeOpfs()
    stubStore(fake)
    const hash = await hashOf()
    const doc = createDoc()
    doc.media = [
      createMediaAsset({ id: 'missing', kind: 'audio', name: 'take.webm', missing: true, url: '' }),
    ]
    useEditorStore.setState({ doc })
    probeMock.importFile.mockResolvedValue(
      createMediaAsset({
        id: 'fresh',
        kind: 'audio',
        name: 'take.webm',
        contentHash: hash,
        file: sourceFile('take.webm', 'audio/webm'),
        url: 'blob:fresh',
      }),
    )
    const asset = await importRecordedFile(sourceFile('take.webm', 'audio/webm'), 12.5)
    // The reducer keeps the offline entry's id, so placement must use that id.
    expect(asset?.id).toBe('missing')
    expect(useEditorStore.getState().doc.media[0].missing).toBe(false)
  })

  it('stops a multi-file batch when the project changes between files', async () => {
    const fake = createFakeOpfs()
    stubStore(fake)
    const hash = await hashOf()
    useEditorStore.setState({ doc: createDoc() })
    probeMock.importFile.mockImplementation(async (file: File) =>
      createMediaAsset({
        kind: 'video',
        name: file.name,
        contentHash: hash,
        file,
        url: `blob:${file.name}`,
      }),
    )
    let replaced = false
    const unsubscribe = useEditorStore.subscribe((state, previous) => {
      if (replaced) return
      if (state.doc.media.length > previous.doc.media.length) {
        replaced = true
        useEditorStore.getState().replaceDoc(createDoc())
      }
    })
    try {
      const imported = await importMediaFiles([
        new File(['a'], 'a.mp4', { type: 'video/mp4' }),
        new File(['b'], 'b.mp4', { type: 'video/mp4' }),
      ])
      expect(replaced).toBe(true)
      // The replaced project owns none of the batch; the second file is never
      // probed, and the first attachment is gone with the old project.
      expect(imported).toBe(0)
      expect(probeMock.importFile).toHaveBeenCalledTimes(1)
    } finally {
      unsubscribe()
      probeMock.importFile.mockReset()
    }
  })

  it('drops a probe whose project was replaced while it ran', async () => {
    const fake = createFakeOpfs()
    stubStore(fake)
    let release!: (asset: MediaAsset) => void
    probeMock.importFile.mockReturnValue(
      new Promise<MediaAsset>((resolve) => {
        release = resolve
      }),
    )
    useEditorStore.setState({ doc: createDoc() })
    const pending = importMediaFiles([sourceFile()])
    const replacement = createDoc()
    useEditorStore.setState({
      doc: replacement,
      projectEpoch: useEditorStore.getState().projectEpoch + 1,
    })
    release(
      createMediaAsset({
        kind: 'video',
        name: 'clip.mp4',
        contentHash: await hashOf(),
        file: sourceFile(),
        url: 'blob:stale',
      }),
    )
    expect(await pending).toBe(0)
    expect(useEditorStore.getState().doc).toBe(replacement)
    expect(useEditorStore.getState().doc.media).toEqual([])
    expect(fake.files.size).toBe(0)
  })
})

describe('claims on open and save', () => {
  it('rehydrates and claims before installing', async () => {
    const fake = createFakeOpfs()
    const locks = new FakeLockManager()
    stubStore(fake, locks)
    const hash = await hashOf()
    const doc = docWithHash(hash)
    // An established project has a claims directory; a project file opened
    // later can claim into it. A project that already stored bytes without one
    // is treated as claims-lost and opens degraded.
    await ensureProjectMedia(doc.project.id)
    await writeMediaFile(doc.project.id, hash, sourceFile())
    const json = JSON.stringify(serializeDoc(doc))

    await openProjectFile(new File([json], 'p.veproj.json'))

    const installed = useEditorStore.getState().doc
    expect(installed.media[0].missing).toBe(false)
    expect(installed.media[0].url).toContain('blob:')
    expect(await readMediaClaims(doc.project.id)).toEqual([hash])
    expect(locks.held(projectLockName(doc.project.id))).toBe(1)
  })

  it('opens degraded with clean blocked when the claim write fails', async () => {
    const fake = createFakeOpfs()
    stubStore(fake)
    const hash = await hashOf()
    const doc = docWithHash(hash)
    await ensureProjectMedia(doc.project.id)
    await writeMediaFile(doc.project.id, hash, sourceFile())
    fake.failWrites = 1
    const json = JSON.stringify(serializeDoc(doc))

    await openProjectFile(new File([json], 'p.veproj.json'))

    expect(fake.failWrites).toBe(0)
    expect(useEditorStore.getState().doc.media[0].missing).toBe(false)
    expect(useEditorStore.getState().mediaCleanBlocked).toBe(true)
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ description: expect.stringContaining('Clean Unused Media') }),
    )
  })

  it('writes no claim on an autosave restore', async () => {
    const fake = createFakeOpfs()
    stubStore(fake)
    const hash = await hashOf()
    const doc = docWithHash(hash)
    await ensureProjectMedia(doc.project.id)
    await writeMediaFile(doc.project.id, hash, sourceFile())

    const restored = await restoreAutosaveProject({ doc, warnings: [] })
    expect(restored?.doc.media[0].missing).toBe(false)
    expect(await readMediaClaims(doc.project.id)).toEqual([])
  })

  it('refuses to save a copy whose stored media cannot be claimed', async () => {
    const fake = createFakeOpfs()
    stubStore(fake)
    const hash = await hashOf()
    useEditorStore.setState({ doc: docWithHash(hash) })
    fake.failWrites = 1
    await expect(downloadProjectJSON()).rejects.toBeInstanceOf(ProjectClaimError)
  })

  it('claims and downloads a saved copy', async () => {
    const fake = createFakeOpfs()
    stubStore(fake)
    const hash = await hashOf()
    const doc = docWithHash(hash)
    useEditorStore.setState({ doc })
    const click = vi.fn()
    vi.stubGlobal('document', {
      createElement: () => ({ click, href: '', download: '' }),
    })
    await expect(downloadProjectJSON()).resolves.toContain('.veproj.json')
    expect(click).toHaveBeenCalled()
    expect(await readMediaClaims(doc.project.id)).toEqual([hash])
  })

  it('writes a claim for a doc with media, and skips the write for an empty doc', async () => {
    const fake = createFakeOpfs()
    stubStore(fake)
    const hash = await hashOf()
    const doc = docWithHash(hash)
    expect(await writeProjectClaim(createDoc())).toBe(true)
    expect(await writeProjectClaim(doc)).toBe(true)
    expect(await readMediaClaims(doc.project.id)).toEqual([hash])
  })

  it('revokes the probed URL when a relink is refused', async () => {
    const fake = createFakeOpfs()
    stubStore(fake)
    const hash = await hashOf()
    const doc = createDoc()
    doc.media = [
      createMediaAsset({
        id: 'media_missing',
        kind: 'video',
        name: 'clip.mp4',
        missing: true,
      }),
    ]
    useEditorStore.setState({ doc })
    probeMock.importFile.mockResolvedValue(
      createMediaAsset({
        kind: 'video',
        name: 'clip.mp4',
        contentHash: hash,
        file: sourceFile(),
        url: 'blob:fresh',
      }),
    )
    const revoke = vi.fn()
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke })
    const apply = vi.spyOn(useEditorStore.getState(), 'apply').mockReturnValue(false)
    try {
      expect(await importMediaFiles([sourceFile()])).toBe(0)
    } finally {
      apply.mockRestore()
    }

    expect(revoke).toHaveBeenCalledWith('blob:fresh')
    expect(useEditorStore.getState().doc.media[0].missing).toBe(true)
  })

  it('refuses a claim when an existing project lost its claims records', async () => {
    const fake = createFakeOpfs()
    stubStore(fake)
    const hash = await hashOf()
    const doc = docWithHash(hash)
    // Existing stored bytes with no claims directory: a fresh shard for only
    // this doc's hashes would hide another copy's lost claims.
    await writeMediaFile(doc.project.id, hash, sourceFile())
    expect(await writeProjectClaim(doc)).toBe(false)
    expect(await readMediaClaims(doc.project.id)).toBeNull()
    expect(fake.directories.has(`/${doc.project.id}/claims`)).toBe(false)
  })

  it('installs nothing when a restore is discarded during rehydration', async () => {
    const fake = createFakeOpfs()
    stubStore(fake)
    const hash = await hashOf()
    const doc = docWithHash(hash)
    await ensureProjectMedia(doc.project.id)
    await writeMediaFile(doc.project.id, hash, sourceFile())
    const before = useEditorStore.getState().doc
    let calls = 0
    const restored = await restoreAutosaveProject({ doc, warnings: [] }, () => ++calls < 2)
    expect(restored).toBeNull()
    expect(useEditorStore.getState().doc).toBe(before)
    expect(await readMediaClaims(doc.project.id)).toEqual([])
  })

  it('does not install a superseded open', async () => {
    const fake = createFakeOpfs()
    stubStore(fake)
    const hash = await hashOf()
    const doc = docWithHash(hash)
    const json = JSON.stringify(serializeDoc(doc))
    const before = useEditorStore.getState().doc
    const pending = openProjectFile(new File([json], 'p.veproj.json'))
    // A newer project install wins while the open is parsing.
    installProject(createDoc())
    const newer = useEditorStore.getState().doc
    await pending
    expect(useEditorStore.getState().doc).toBe(newer)
    expect(useEditorStore.getState().doc).not.toBe(before)
  })
})
