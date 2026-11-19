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
  cleanProjectMedia,
  ensureProjectMedia,
  readMediaClaims,
  readMediaFile,
  sha256Hex,
  writeMediaClaim,
  writeMediaFile,
} from '../media/media-store'
import {
  beginMediaActivity,
  beginMediaActivityWhenIdle,
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
import type { Doc, MediaAsset } from '../types'

const toastMock = vi.hoisted(() => vi.fn())
vi.mock('@/hooks/use-toast', () => ({ toast: toastMock }))

const probeMock = vi.hoisted(() => ({ importFile: vi.fn() }))
vi.mock('../media/probe', () => probeMock)

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  useEditorStore.setState({ mediaCleanBlockReason: null })
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
    const sidecarBytes = fake.get(`/${project}/${hash}.json`)!.bytes.length
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
      // The paired sidecar's bytes are reclaimed with the media entry.
      result: { deleted: 1, reclaimed: sourceFile().size + sidecarBytes },
    })
    expect(await readMediaFile(project, hash)).toBeNull()
    lock.dispose()
  })

  it('admits a nested reservation while a clean waits instead of deadlocking', async () => {
    const fake = createFakeOpfs()
    const locks = new FakeLockManager()
    stubStore(fake, locks)
    const project = 'proj_clear_nested'
    const hash = await hashOf()
    await ensureProjectMedia(project)
    await writeMediaFile(project, hash, sourceFile())
    const lock = await ProjectLock.acquire(project)
    let outerStarted = false
    let nestedStarted = false
    try {
      const outer = await beginMediaActivityWhenIdle()
      outerStarted = true
      let cleared = false
      const pending = clearAllProjectMedia({ projectId: project, lock }).then((outcome) => {
        cleared = true
        return outcome
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      // The clean is waiting for the outer reservation, not deleting yet.
      expect(cleared).toBe(false)
      // The bundle-import shape: an operation already holding a reservation
      // passes its token, so the nested admission does not wait for a clean
      // that is waiting for it.
      const admitted = await Promise.race([
        beginMediaActivityWhenIdle(outer).then(() => 'admitted'),
        new Promise((resolve) => setTimeout(() => resolve('waiting'), 50)),
      ])
      expect(admitted).toBe('admitted')
      nestedStarted = true
      endMediaActivity()
      nestedStarted = false
      endMediaActivity()
      outerStarted = false
      expect(await pending).toMatchObject({ status: 'ran' })
      expect(await readMediaFile(project, hash)).toBeNull()
    } finally {
      if (nestedStarted) endMediaActivity()
      if (outerStarted) endMediaActivity()
      lock.dispose()
    }
  })

  it('keeps unrelated new activity waiting until a requested clear finishes', async () => {
    const fake = createFakeOpfs()
    const locks = new FakeLockManager()
    stubStore(fake, locks)
    const project = 'proj_clear_independent'
    const hash = await hashOf()
    await ensureProjectMedia(project)
    await writeMediaFile(project, hash, sourceFile())
    const lock = await ProjectLock.acquire(project)
    let held = true
    let independentAdmitted = false
    try {
      await beginMediaActivityWhenIdle()
      let cleared = false
      const pending = clearAllProjectMedia({ projectId: project, lock }).then((outcome) => {
        cleared = true
        return outcome
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(cleared).toBe(false)

      // While the clean waits for the held write, a top-level admission has no
      // parent token: it must not join (and so prolong) the wait.
      const independent = beginMediaActivityWhenIdle().then(() => {
        independentAdmitted = true
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(independentAdmitted).toBe(false)
      expect(cleared).toBe(false)

      endMediaActivity()
      held = false
      expect(await pending).toMatchObject({ status: 'ran' })
      await independent
      expect(independentAdmitted).toBe(true)
      expect(cleared).toBe(true)
      endMediaActivity()
    } finally {
      if (held) endMediaActivity()
      lock.dispose()
    }
  })

  it('keeps a sibling reservation valid after another hold is released', async () => {
    const fake = createFakeOpfs()
    const locks = new FakeLockManager()
    stubStore(fake, locks)
    const project = 'proj_clear_overlap'
    const hash = await hashOf()
    await ensureProjectMedia(project)
    await writeMediaFile(project, hash, sourceFile())
    const lock = await ProjectLock.acquire(project)
    let held = 0
    try {
      const first = await beginMediaActivityWhenIdle()
      held += 1
      const second = await beginMediaActivityWhenIdle(first)
      held += 1
      // Releasing one sibling must not invalidate the other token: activity is
      // still above zero, so the generation that minted both stays current.
      endMediaActivity()
      held -= 1

      let cleared = false
      const pending = clearAllProjectMedia({ projectId: project, lock }).then((outcome) => {
        cleared = true
        return outcome
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(cleared).toBe(false)

      const nested = beginMediaActivityWhenIdle(second).then((token) => {
        held += 1
        return token
      })
      const admitted = await Promise.race([
        nested.then(() => 'admitted'),
        new Promise((resolve) => setTimeout(() => resolve('waiting'), 50)),
      ])
      expect(admitted).toBe('admitted')

      endMediaActivity()
      held -= 1
      endMediaActivity()
      held -= 1
      expect(await pending).toMatchObject({ status: 'ran' })
      expect(await readMediaFile(project, hash)).toBeNull()
    } finally {
      while (held > 0) {
        endMediaActivity()
        held -= 1
      }
      lock.dispose()
    }
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

  it('counts a present but empty sidecar type as a fallback', async () => {
    const fake = createFakeOpfs()
    stubStore(fake)
    const hash = await hashOf()
    const doc = docWithHash(hash, 'clip.mp4', 'video/mp4')
    await writeMediaFile(doc.project.id, hash, sourceFile('clip.mp4', ''))
    const result = await rehydrateMedia(doc)
    expect(result.warnings).toEqual([expect.stringContaining('file extension')])
    expect(result.doc.media[0].file?.type).toBe('video/mp4')
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
    expect(useEditorStore.getState().mediaCleanBlockReason).toBe('unclaimed')
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining('A save repairs this'),
      }),
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

  it('a claim write waits for a clean and never writes during it (H7)', async () => {
    const fake = createFakeOpfs()
    stubStore(fake)
    const hash = await hashOf()
    const doc = docWithHash(hash)
    await ensureProjectMedia(doc.project.id)
    await writeMediaFile(doc.project.id, hash, sourceFile())
    let releaseClean!: () => void
    const clean = runCleanExclusive(
      () =>
        new Promise<void>((resolve) => {
          releaseClean = resolve
        }),
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    const claim = writeProjectClaim(doc)
    await new Promise((resolve) => setTimeout(resolve, 20))
    // The claim is waiting at the activity admission: no shard exists yet.
    expect([...fake.files.keys()].some((path) => path.includes('/claims/'))).toBe(false)
    releaseClean()
    await clean
    await expect(claim).resolves.toBe(true)
    expect([...fake.files.keys()].some((path) => path.includes('/claims/'))).toBe(true)
    expect(await readMediaClaims(doc.project.id)).toEqual([hash])
  })

  it('keeps an offline hash claimed so restored bytes survive another copy clean', async () => {
    const fake = createFakeOpfs()
    stubStore(fake)
    const hash = await hashOf()
    const doc = docWithHash(hash)
    // Copy A saves while the bytes are absent. The claim is a durable
    // reference, so it must still name the hash.
    expect(await writeProjectClaim(doc)).toBe(true)
    expect(await readMediaClaims(doc.project.id)).toEqual([hash])

    // Copy B restores the same bytes, then removes its reference and cleans.
    // Copy A's claim must keep the restored bytes.
    await writeMediaFile(doc.project.id, hash, sourceFile())
    const result = await cleanProjectMedia(doc.project.id, [])
    expect(result.deleted).toEqual([])
    expect(await readMediaFile(doc.project.id, hash)).not.toBeNull()
  })

  it('a clean returns busy while a save holds its independent shared lock', async () => {
    const fake = createFakeOpfs()
    const locks = new FakeLockManager()
    stubStore(fake, locks)
    await ensureProjectMedia('proj_lock')
    const active = await ProjectLock.acquire('proj_lock')
    const claimLock = await ProjectLock.acquire('proj_lock')
    try {
      const outcome = await clearAllProjectMedia({ projectId: 'proj_lock', lock: active })
      expect(outcome.status).toBe('busy')
      const doc = docWithHash(await hashOf())
      doc.project.id = 'proj_lock'
      await expect(writeProjectClaim(doc)).resolves.toBe(true)
    } finally {
      claimLock.dispose()
      active.dispose()
    }
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
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const apply = vi.spyOn(useEditorStore.getState(), 'apply').mockReturnValue(false)
    try {
      expect(await importMediaFiles([sourceFile()])).toBe(0)
      expect(revoke).toHaveBeenCalledWith('blob:fresh')
    } finally {
      apply.mockRestore()
      revoke.mockRestore()
    }

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

describe('clean-block reasons and the save coverage rule (0.28.2)', () => {
  function docWithProject(projectId: string): Doc {
    const doc = createDoc()
    doc.project.id = projectId
    return doc
  }

  function stubDownload(): void {
    vi.stubGlobal('document', {
      createElement: () => ({ click: () => undefined, href: '', download: '' }),
    })
  }

  it('classifies a lost claims directory as claims-missing', async () => {
    const fake = createFakeOpfs()
    stubStore(fake)
    const hash = await hashOf()
    const doc = docWithHash(hash)
    // Stored bytes without a claims directory: the records were lost.
    await writeMediaFile(doc.project.id, hash, sourceFile())
    await openProjectFile(new File([JSON.stringify(serializeDoc(doc))], 'p.veproj.json'))
    expect(useEditorStore.getState().mediaCleanBlockReason).toBe('claims-missing')
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining('Clear All Stored Media'),
      }),
    )
    expect(toastMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining('A save repairs this'),
      }),
    )
    // installProject's background prepare must not recreate the lost records:
    // an empty claims directory would hide them from every later open.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(await ensureProjectMedia(doc.project.id)).toBe('claims-missing')
  })

  it('classifies an unreadable store as storage-unavailable', async () => {
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: async () => {
          throw new Error('denied')
        },
      },
    })
    await openProjectFile(new File([JSON.stringify(serializeDoc(createDoc()))], 'p.veproj.json'))
    expect(useEditorStore.getState().mediaCleanBlockReason).toBe('storage-unavailable')
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining('storage is unavailable'),
      }),
    )
    expect(toastMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining('A save repairs this'),
      }),
    )
  })

  it('classifies a store that disappears during the claim write as storage-unavailable', async () => {
    const fake = createFakeOpfs()
    stubStore(fake)
    const hash = await hashOf()
    const doc = docWithHash(hash)
    await ensureProjectMedia(doc.project.id)
    await writeMediaFile(doc.project.id, hash, sourceFile())

    // The pre-claim inspection reads the claims directory once. The claim
    // path checks it again; fail that second read to simulate a store that
    // becomes unavailable after inspection.
    const proto = Object.getPrototypeOf(fake.root) as {
      getDirectoryHandle(
        this: { path: string },
        name: string,
        options?: { create?: boolean },
      ): Promise<unknown>
    }
    const original = proto.getDirectoryHandle
    let claimReads = 0
    const spy = vi.spyOn(proto, 'getDirectoryHandle').mockImplementation(async function (
      this: { path: string },
      name,
      options,
    ) {
      if (name === 'claims' && this.path === `/${doc.project.id}`) {
        claimReads += 1
        if (claimReads > 1) throw new Error('storage went away')
      }
      return original.call(this, name, options)
    })
    try {
      await openProjectFile(new File([JSON.stringify(serializeDoc(doc))], 'p.veproj.json'))
    } finally {
      spy.mockRestore()
    }

    expect(claimReads).toBeGreaterThanOrEqual(2)
    expect(useEditorStore.getState().mediaCleanBlockReason).toBe('storage-unavailable')
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining('storage is unavailable'),
      }),
    )
    expect(toastMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining('A save repairs this'),
      }),
    )
  })

  it('keeps the reason when a hash is stored while the coverage claims are read', async () => {
    const fake = createFakeOpfs()
    stubStore(fake)
    stubDownload()
    const projectId = 'proj_coverage_race'
    const referencedHash = await hashOf('referenced')
    const lateHash = await hashOf('late')
    const doc = docWithHash(referencedHash)
    doc.project.id = projectId
    await ensureProjectMedia(projectId)
    await writeMediaFile(
      projectId,
      referencedHash,
      sourceFile('referenced.mp4', 'video/mp4', 'referenced'),
    )
    // An install-tagged shard keeps the save's pre-check from scanning other
    // projects, so the claims-file open count stays deterministic.
    await writeMediaClaim(projectId, [referencedHash], 'install-race')
    useEditorStore.setState({ doc, mediaCleanBlockReason: 'unclaimed' })

    const proto = Object.getPrototypeOf(fake.root) as {
      getFileHandle(
        this: { path: string },
        name: string,
        options?: { create?: boolean },
      ): Promise<unknown>
    }
    const original = proto.getFileHandle
    let claimReads = 0
    const spy = vi.spyOn(proto, 'getFileHandle').mockImplementation(async function (
      this: { path: string },
      name,
      options,
    ) {
      if (
        !options?.create &&
        this.path === `/${projectId}/claims` &&
        /^claim-.+\.json$/.test(name)
      ) {
        claimReads += 1
        // The coverage read is the third claims-file open: the save reads
        // the existing shards once, then writeMediaClaim reads them again.
        if (claimReads === 3) {
          fake.put(`/${projectId}/${lateHash}`, new TextEncoder().encode('late'))
        }
      }
      return original.call(this, name, options)
    })
    try {
      await downloadProjectJSON()
    } finally {
      spy.mockRestore()
    }

    // The late hash was neither referenced nor claimed. The coverage answer
    // must be false, so the block survives instead of exposing it to clean.
    expect(useEditorStore.getState().mediaCleanBlockReason).toBe('unclaimed')
    expect(claimReads).toBeGreaterThanOrEqual(3)
  })

  it('keeps the reason when font enumeration fails during coverage', async () => {
    const fake = createFakeOpfs()
    stubStore(fake)
    stubDownload()
    const projectId = 'proj_font_enum'
    const referencedHash = await hashOf('referenced')
    const fontHash = await hashOf('font bytes')
    const doc = docWithHash(referencedHash)
    doc.project.id = projectId
    await ensureProjectMedia(projectId)
    await writeMediaFile(
      projectId,
      referencedHash,
      sourceFile('referenced.mp4', 'video/mp4', 'referenced'),
    )
    await writeMediaFile(
      projectId,
      fontHash,
      new File([new TextEncoder().encode('font bytes')], 'brand.woff2', {
        type: 'font/woff2',
      }),
      'fonts',
    )
    await writeMediaClaim(projectId, [referencedHash, fontHash])
    useEditorStore.setState({ doc, mediaCleanBlockReason: 'unclaimed' })

    const proto = Object.getPrototypeOf(fake.root) as {
      keys(this: { path: string }): AsyncIterableIterator<string>
    }
    const original = proto.keys
    let failFonts = true
    const spy = vi.spyOn(proto, 'keys').mockImplementation(function (this: { path: string }) {
      if (failFonts && this.path === `/${projectId}/fonts`) {
        throw new Error('font enumeration failed')
      }
      return original.call(this)
    })
    try {
      // An unreadable font list is not an empty font list: the block stays
      // even though every stored hash is claimed.
      await downloadProjectJSON()
      expect(useEditorStore.getState().mediaCleanBlockReason).toBe('unclaimed')

      // Once enumeration recovers, the same setup proves complete coverage.
      failFonts = false
      await downloadProjectJSON()
      expect(useEditorStore.getState().mediaCleanBlockReason).toBeNull()
    } finally {
      spy.mockRestore()
    }
  })

  it('clears the reason on a no-hash save after Clear All', async () => {
    const fake = createFakeOpfs()
    stubStore(fake)
    stubDownload()
    useEditorStore.setState({
      doc: docWithProject('proj_cleared'),
      mediaCleanBlockReason: 'claims-missing',
    })
    await downloadProjectJSON()
    expect(useEditorStore.getState().mediaCleanBlockReason).toBeNull()
  })

  it('keeps the reason on a no-hash save when stored bytes are unclaimed', async () => {
    const fake = createFakeOpfs()
    stubStore(fake)
    const projectId = 'proj_unclaimed'
    const hash = await hashOf()
    await ensureProjectMedia(projectId)
    await writeMediaFile(projectId, hash, sourceFile())
    const doc = docWithHash(hash)
    doc.project.id = projectId
    // A failed claim write marks the open as unclaimed while the bytes stay.
    fake.failWrites = 1
    await openProjectFile(new File([JSON.stringify(serializeDoc(doc))], 'p.veproj.json'))
    expect(useEditorStore.getState().mediaCleanBlockReason).toBe('unclaimed')

    stubDownload()
    useEditorStore.setState({ doc: docWithProject(projectId) })
    await downloadProjectJSON()
    expect(useEditorStore.getState().mediaCleanBlockReason).toBe('unclaimed')
  })

  it('clears the reason on a no-hash save when every stored hash is claimed', async () => {
    const fake = createFakeOpfs()
    stubStore(fake)
    stubDownload()
    const projectId = 'proj_claimed'
    const hash = await hashOf()
    await ensureProjectMedia(projectId)
    await writeMediaFile(projectId, hash, sourceFile())
    await writeMediaClaim(projectId, [hash])
    useEditorStore.setState({
      doc: docWithProject(projectId),
      mediaCleanBlockReason: 'unclaimed',
    })
    await downloadProjectJSON()
    expect(useEditorStore.getState().mediaCleanBlockReason).toBeNull()
  })

  it('keeps the reason on a hashed save when another stored hash is unclaimed', async () => {
    const fake = createFakeOpfs()
    stubStore(fake)
    const projectId = 'proj_partial'
    const claimedHash = await hashOf('claimed')
    const unclaimedHash = await hashOf('unclaimed')
    const doc = docWithHash(claimedHash)
    doc.project.id = projectId
    await ensureProjectMedia(projectId)
    await writeMediaFile(projectId, claimedHash, sourceFile('claimed.mp4', 'video/mp4', 'claimed'))
    await writeMediaFile(
      projectId,
      unclaimedHash,
      sourceFile('unclaimed.mp4', 'video/mp4', 'unclaimed'),
    )
    // One failed claim write on open leaves the reason set; the later save
    // succeeds but must not expose the unclaimed stored hash to Clean.
    fake.failWrites = 1
    await openProjectFile(new File([JSON.stringify(serializeDoc(doc))], 'p.veproj.json'))
    expect(useEditorStore.getState().mediaCleanBlockReason).toBe('unclaimed')

    stubDownload()
    await downloadProjectJSON()
    expect(useEditorStore.getState().mediaCleanBlockReason).toBe('unclaimed')
  })

  it('clears the reason on a hashed save when the snapshot covers every stored hash', async () => {
    const fake = createFakeOpfs()
    stubStore(fake)
    stubDownload()
    const projectId = 'proj_covered'
    const hash = await hashOf()
    const doc = docWithHash(hash)
    doc.project.id = projectId
    await ensureProjectMedia(projectId)
    await writeMediaFile(projectId, hash, sourceFile())
    useEditorStore.setState({ doc, mediaCleanBlockReason: 'unclaimed' })
    await downloadProjectJSON()
    expect(useEditorStore.getState().mediaCleanBlockReason).toBeNull()
  })
})
