import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  bumpProjectGeneration,
  currentProjectLock,
  discardProjectLock,
  ensureProjectLock,
  releaseProjectLock,
  installProject,
  isCurrentProjectLoad,
  loadProjectFile,
  openProjectFile,
} from '../project-io'
import { projectLockName } from '../media/project-lock'
import { createFakeOpfs, FakeLockManager } from './mocks/opfs'
import { createDoc } from '../factories'
import { parseSerializedDoc, serializeDoc } from '../serialization'
import { useEditorStore } from '../store'

const toastMock = vi.hoisted(() => vi.fn())

vi.mock('@/hooks/use-toast', () => ({ toast: toastMock }))

/**
 * loadProjectFile is the File > Open / toolbar-open entry: it receives the
 * File object a picker (or battery upload) chose. It must parse the file's
 * JSON text. The regression: it handed the raw TEXT to deserializeDoc, which
 * rejected every real file with "root is not an object" while the unit tests
 * (which call deserializeDoc with objects) stayed green. Autosave restore
 * used parseSerializedDoc and worked, so only the picker paths were broken.
 */

describe('loadProjectFile (picker path)', () => {
  it('round-trips a saved project FILE, not just an already-parsed object', async () => {
    const json = JSON.stringify(serializeDoc(createDoc()), null, 2)
    const file = new File([json], 'roundtrip.veproj.json', { type: 'application/json' })
    const { doc } = await loadProjectFile(file)
    const fresh = createDoc()
    expect(doc.project.name).toBe(fresh.project.name)
    expect(doc.project.tracks.length).toBe(fresh.project.tracks.length)
    expect(doc.media).toEqual([])
  })

  it('returns the timeline migration warnings with the parsed doc', async () => {
    const json = JSON.stringify({
      version: 1,
      project: {
        tracks: [{ kind: 'video', clips: [{ id: 'long', start: 0, duration: 30 * 3600 }] }],
      },
    })
    const file = new File([json], 'legacy.veproj.json', { type: 'application/json' })
    const { doc, warnings } = await loadProjectFile(file)
    expect(doc.project.tracks[0].clips[0].duration).toBe(86_400)
    expect(warnings).toEqual([expect.stringContaining('24-hour')])
  })

  it('rejects non-JSON text with the parse error, not a validation error', async () => {
    const file = new File(['{nope'], 'broken.veproj.json', { type: 'application/json' })
    await expect(loadProjectFile(file)).rejects.toThrow('File is not valid JSON')
  })
})

describe('openProjectFile warning surface', () => {
  it('shows the migration warning in the project-loaded toast', async () => {
    toastMock.mockClear()
    const json = JSON.stringify({
      version: 1,
      project: {
        tracks: [{ kind: 'video', clips: [{ id: 'long', start: 0, duration: 30 * 3600 }] }],
      },
    })
    const file = new File([json], 'legacy.veproj.json', { type: 'application/json' })
    await openProjectFile(file)
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Project loaded',
        description: expect.stringContaining('24-hour'),
      }),
    )
  })

  it('reports a failure after installation started even though the generation moved', async () => {
    const original = useEditorStore.getState().replaceDoc
    const json = JSON.stringify(serializeDoc(createDoc()), null, 2)
    const file = new File([json], 'install-fail.veproj.json', { type: 'application/json' })
    useEditorStore.setState({
      replaceDoc: () => {
        throw new Error('install exploded')
      },
    })
    try {
      toastMock.mockClear()
      await openProjectFile(file)
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Load failed', description: 'install exploded' }),
      )
    } finally {
      useEditorStore.setState({ replaceDoc: original })
    }
  })

  it('separates the relink notice from the migration warning', async () => {
    toastMock.mockClear()
    const json = JSON.stringify({
      version: 1,
      project: {
        tracks: [
          {
            kind: 'video',
            clips: [{ id: 'long', mediaId: 'm1', start: 0, duration: 30 * 3600 }],
          },
        ],
      },
      media: [{ id: 'm1', kind: 'video', name: 'a.mp4', duration: 10 }],
    })
    const file = new File([json], 'legacy-media.veproj.json', { type: 'application/json' })
    await openProjectFile(file)
    const description = toastMock.mock.calls[0]?.[0]?.description as string
    expect(description).toContain('1 media file(s) need relinking. Trimmed')
  })
})

describe('parity fixture (e2e/fixtures/editor-parity.veproj.json)', () => {
  it('parses to the selected demo structure the screenshots and battery rely on', () => {
    const raw = readFileSync(join(process.cwd(), 'e2e/fixtures/editor-parity.veproj.json'), 'utf8')
    const { doc, missingMediaIds } = parseSerializedDoc(raw)

    expect(doc.project.name).toBe('Editor Parity Demo')
    expect(doc.project.tracks).toHaveLength(9)
    expect(doc.project.tracks.map((track) => track.kind)).toEqual([
      'video',
      'video',
      'video',
      'video',
      'video',
      'audio',
      'audio',
      'audio',
      'audio',
    ])
    expect(doc.project.tracks.map((track) => track.clips.length)).toEqual([
      1, 2, 4, 3, 3, 3, 1, 1, 1,
    ])
    expect(doc.media.map((asset) => asset.name)).toEqual([
      'sample-video.mp4',
      'sample-audio.mp3',
      'sample-image.png',
    ])
    // The fixture stores no object URLs: every asset hydrates offline until
    // the user relinks it from the media bin.
    expect(missingMediaIds).toHaveLength(3)
    expect(doc.media.every((asset) => asset.missing === true)).toBe(true)
  })
})

describe('installProject (runtime)', () => {
  it('bumps the epoch, clears the restore banner, and invalidates the previous load', () => {
    const before = useEditorStore.getState()
    const restoreDoc = createDoc()
    const nextDoc = createDoc()
    nextDoc.project.name = 'installed-project'
    const epochBefore = before.projectEpoch
    const previousLoadId = bumpProjectGeneration()
    useEditorStore.setState({ pendingRestore: { doc: restoreDoc, warnings: [] } })
    try {
      installProject(nextDoc)
      const after = useEditorStore.getState()
      expect(after.pendingRestore).toBeNull()
      expect(after.projectEpoch).toBeGreaterThan(epochBefore)
      expect(after.doc).toBe(nextDoc)
      expect(isCurrentProjectLoad(previousLoadId)).toBe(false)
    } finally {
      useEditorStore.setState({
        doc: before.doc,
        projectEpoch: before.projectEpoch,
        pendingRestore: before.pendingRestore,
      })
    }
  })
})

describe('ensureProjectLock ordering', () => {
  afterEach(() => {
    releaseProjectLock()
    vi.unstubAllGlobals()
  })

  it('invalidates a waiting acquire for another project when the current one re-opens', async () => {
    const locks = new FakeLockManager()
    vi.stubGlobal('navigator', { locks })
    const docA = createDoc()
    docA.project.id = 'proj_a'
    const docB = createDoc()
    docB.project.id = 'proj_b'

    const lockA = await ensureProjectLock(docA)
    expect(lockA).not.toBeNull()

    // Another tab holds B, so B's shared acquisition stays queued.
    let releaseHolder!: () => void
    const holder = locks.request(
      projectLockName('proj_b'),
      { mode: 'exclusive' },
      () =>
        new Promise<void>((resolve) => {
          releaseHolder = resolve
        }),
    )
    const pendingB = ensureProjectLock(docB)

    // A newer open of the project that is already active re-uses A's lock.
    const reused = await ensureProjectLock(docA)
    expect(reused).toBe(lockA)

    releaseHolder()
    await holder
    expect(await pendingB).toBeNull()
    expect(currentProjectLock()).toBe(lockA)
    await vi.waitFor(() => expect(locks.held(projectLockName('proj_b'))).toBe(0))
  })

  it('reuses a prepared hold for the live project instead of leaking it', async () => {
    const locks = new FakeLockManager()
    vi.stubGlobal('navigator', { locks })
    const docA = createDoc()
    docA.project.id = 'proj_a'
    const docB = createDoc()
    docB.project.id = 'proj_b'
    const lockB = await ensureProjectLock(docB)
    const preparedA = await ensureProjectLock(docA, { forInstall: true })

    // The live doc is A while B is still active (an undo across projects, or
    // an open racing the subscription): the prepared hold becomes active and
    // the redundant acquisition is released, so no hold leaves the registry
    // unreachable to releaseProjectLock.
    const active = await ensureProjectLock(docA)
    expect(active).toBe(preparedA)
    expect(currentProjectLock()).toBe(preparedA)
    expect(lockB?.isHeld).toBe(false)
    await vi.waitFor(() => expect(locks.held(projectLockName('proj_a'))).toBe(1))
    await vi.waitFor(() => expect(locks.held(projectLockName('proj_b'))).toBe(0))
  })

  it('retires a waiting acquire when the locks are released', async () => {
    const locks = new FakeLockManager()
    vi.stubGlobal('navigator', { locks })
    const docA = createDoc()
    docA.project.id = 'proj_a'
    const docB = createDoc()
    docB.project.id = 'proj_b'
    await ensureProjectLock(docA)

    // B's acquisition queues behind another tab's exclusive hold.
    let releaseHolder!: () => void
    const holder = locks.request(
      projectLockName('proj_b'),
      { mode: 'exclusive' },
      () =>
        new Promise<void>((resolve) => {
          releaseHolder = resolve
        }),
    )
    const pendingB = ensureProjectLock(docB)
    // Teardown retires the request before it can activate.
    releaseProjectLock()
    releaseHolder()
    await holder

    expect(await pendingB).toBeNull()
    expect(currentProjectLock()).toBeNull()
    await vi.waitFor(() => expect(locks.held(projectLockName('proj_b'))).toBe(0))
  })

  it('re-syncs the shared hold when the doc project changes without an install', async () => {
    const locks = new FakeLockManager()
    vi.stubGlobal('navigator', { locks })
    const docA = createDoc()
    docA.project.id = 'proj_a'
    const docB = createDoc()
    docB.project.id = 'proj_b'
    const lockA = await ensureProjectLock(docA)
    installProject(docA)
    expect(currentProjectLock()).toBe(lockA)

    const preparedB = await ensureProjectLock(docB, { forInstall: true })
    installProject(docB)
    expect(currentProjectLock()).toBe(preparedB)

    // An undo that restores A bypasses installProject; the same call the
    // shell subscription makes re-syncs the hold to the live project.
    useEditorStore.setState({ doc: docA })
    await ensureProjectLock(useEditorStore.getState().doc)
    expect(currentProjectLock()?.projectId).toBe('proj_a')
    await vi.waitFor(() => expect(locks.held(projectLockName('proj_b'))).toBe(0))
    expect(locks.held(projectLockName('proj_a'))).toBe(1)
  })

  it('keeps the installed lock until the replacement installs', async () => {
    const locks = new FakeLockManager()
    vi.stubGlobal('navigator', { locks })
    const docA = createDoc()
    docA.project.id = 'proj_a'
    const docB = createDoc()
    docB.project.id = 'proj_b'
    const lockA = await ensureProjectLock(docA)
    expect(currentProjectLock()).toBe(lockA)

    const preparedB = await ensureProjectLock(docB, { forInstall: true })
    expect(preparedB).not.toBeNull()
    // B is held, but the live project is still A and keeps its own hold.
    expect(currentProjectLock()).toBe(lockA)
    expect(locks.held(projectLockName('proj_a'))).toBe(1)
    expect(locks.held(projectLockName('proj_b'))).toBe(1)

    installProject(docB)
    expect(currentProjectLock()).toBe(preparedB)
    await vi.waitFor(() => expect(locks.held(projectLockName('proj_a'))).toBe(0))
    expect(locks.held(projectLockName('proj_b'))).toBe(1)
  })

  it("does not release another project's prepared hold when an older load is discarded", async () => {
    const locks = new FakeLockManager()
    vi.stubGlobal('navigator', { locks })
    const docA = createDoc()
    docA.project.id = 'proj_a'
    const docB = createDoc()
    docB.project.id = 'proj_b'
    const docC = createDoc()
    docC.project.id = 'proj_c'
    const lockA = await ensureProjectLock(docA)
    const lockB = await ensureProjectLock(docB, { forInstall: true })
    await ensureProjectLock(docC, { forInstall: true })

    // C's prepare superseded B. Discarding B's own hold must not touch C's.
    discardProjectLock(lockB)

    expect(currentProjectLock()).toBe(lockA)
    await vi.waitFor(() => expect(locks.held(projectLockName('proj_b'))).toBe(0))
    // C's hold is still live: a stale load's cancellation must not release it.
    expect(locks.held(projectLockName('proj_c'))).toBe(1)
  })

  it('gives each load of one project its own prepared hold', async () => {
    const locks = new FakeLockManager()
    vi.stubGlobal('navigator', { locks })
    const docA = createDoc()
    docA.project.id = 'proj_a'
    const docB = createDoc()
    docB.project.id = 'proj_b'
    await ensureProjectLock(docA)
    const first = await ensureProjectLock(docB, { forInstall: true })
    const second = await ensureProjectLock(docB, { forInstall: true })

    expect(first).not.toBe(second)
    // The stale load cannot release the newer load's hold.
    discardProjectLock(first)
    expect(second?.isHeld).toBe(true)

    installProject(docB)
    expect(currentProjectLock()).toBe(second)
    // The stale load's hold settles away; the committed one remains.
    await vi.waitFor(() => expect(locks.held(projectLockName('proj_b'))).toBe(1))
  })

  it('keeps the installed lock when a prepared install is discarded', async () => {
    const locks = new FakeLockManager()
    vi.stubGlobal('navigator', { locks })
    const docA = createDoc()
    docA.project.id = 'proj_a'
    const docB = createDoc()
    docB.project.id = 'proj_b'
    const lockA = await ensureProjectLock(docA)
    const preparedB = await ensureProjectLock(docB, { forInstall: true })

    discardProjectLock(preparedB)

    expect(currentProjectLock()).toBe(lockA)
    expect(preparedB?.isHeld).toBe(false)
    await vi.waitFor(() => expect(locks.held(projectLockName('proj_b'))).toBe(0))
    expect(locks.held(projectLockName('proj_a'))).toBe(1)
  })
})
