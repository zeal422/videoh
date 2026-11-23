import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  MediaStoreError,
  cleanProjectMedia,
  clearProjectMedia,
  deleteMediaFile,
  ensureProjectMedia,
  estimateMediaStore,
  hashFile,
  isMediaStoreSupported,
  isStoragePersistent,
  listMediaFiles,
  projectMediaUsage,
  readMediaClaims,
  readMediaFile,
  requestPersistentStorage,
  sha256Hex,
  writeMediaClaim,
  writeMediaFile,
} from '../media/media-store'
import { ProjectLock, projectLockName } from '../media/project-lock'
import { isValidProjectId } from '../project-validation'
import { createFakeOpfs, FakeLockManager, type FakeOpfs } from './mocks/opfs'

const PROJECT = 'proj_test'

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubStorage(fake: FakeOpfs) {
  vi.stubGlobal('navigator', {
    storage: {
      getDirectory: async () => fake.root,
      estimate: async () => ({ usage: fake.usage(), quota: 4096 }),
      persist: async () => true,
      persisted: async () => false,
    },
  })
}

function bytes(text: string) {
  return new TextEncoder().encode(text)
}

async function hashOf(text: string): Promise<string> {
  return sha256Hex(bytes(text))
}

function mediaFile(text: string, type = 'video/mp4', name = 'clip.mp4') {
  return new File([bytes(text)], name, { type })
}

describe('media store detection and keys', () => {
  it('reports an unsupported runtime and refuses writes', async () => {
    vi.stubGlobal('navigator', {})
    expect(isMediaStoreSupported()).toBe(false)
    await expect(writeMediaFile(PROJECT, await hashOf('a'), mediaFile('a'))).rejects.toBeInstanceOf(
      MediaStoreError,
    )
  })

  it('validates project ids and content hashes as path segments', async () => {
    expect(isValidProjectId('proj_ab-12')).toBe(true)
    expect(isValidProjectId('../escape')).toBe(false)
    expect(isValidProjectId('a/b')).toBe(false)
    expect(isValidProjectId('')).toBe(false)
    expect(isValidProjectId('x'.repeat(129))).toBe(false)
    const fake = createFakeOpfs()
    await expect(fake.root.getFileHandle('')).rejects.toBeInstanceOf(TypeError)
    await expect(fake.root.getDirectoryHandle('')).rejects.toBeInstanceOf(TypeError)
  })

  it('keeps the first type when the same bytes are stored again', async () => {
    const fake = createFakeOpfs()
    stubStorage(fake)
    const hash = await hashOf('same bytes')
    await writeMediaFile(PROJECT, hash, mediaFile('same bytes', 'video/mp4', 'clip.mp4'))
    await writeMediaFile(PROJECT, hash, mediaFile('same bytes', 'video/quicktime', 'clip.mov'))
    expect((await readMediaFile(PROJECT, hash))?.type).toBe('video/mp4')
  })

  it('rejects a hash that is not 64 lowercase hex characters', async () => {
    const fake = createFakeOpfs()
    stubStorage(fake)
    for (const hash of ['../evil', 'A'.repeat(64), 'g'.repeat(64), '0'.repeat(63), 1 as unknown]) {
      await expect(writeMediaFile(PROJECT, hash as string, mediaFile('x'))).rejects.toBeInstanceOf(
        MediaStoreError,
      )
    }
    await expect(readMediaFile(PROJECT, 'nope')).rejects.toBeInstanceOf(MediaStoreError)
    expect(fake.files.size).toBe(0)
  })

  it('rejects a traversal project id before touching the store', async () => {
    const fake = createFakeOpfs()
    stubStorage(fake)
    await expect(
      writeMediaFile('../../etc', await hashOf('x'), mediaFile('x')),
    ).rejects.toBeInstanceOf(MediaStoreError)
    expect(fake.directories.has('/../../etc')).toBe(false)
  })
})

describe('media store read and write', () => {
  it('round trips bytes and the sidecar type', async () => {
    const fake = createFakeOpfs()
    stubStorage(fake)
    const file = mediaFile('hello world', 'video/quicktime')
    const hash = await hashFile(file)
    await writeMediaFile(PROJECT, hash, file)

    const stored = await readMediaFile(PROJECT, hash)
    expect(stored).not.toBeNull()
    expect(stored?.type).toBe('video/quicktime')
    expect(stored?.size).toBe(file.size)
    expect(stored?.hasSidecar).toBe(true)
    expect(new TextDecoder().decode(new Uint8Array(await stored!.file.arrayBuffer()))).toBe(
      'hello world',
    )
  })

  it('rejects bytes that do not match the claimed hash and stores nothing', async () => {
    const fake = createFakeOpfs()
    stubStorage(fake)
    await expect(
      writeMediaFile(PROJECT, '0'.repeat(64), mediaFile('different')),
    ).rejects.toBeInstanceOf(MediaStoreError)
    expect(fake.files.size).toBe(0)
  })

  it('reuses an existing valid entry', async () => {
    const fake = createFakeOpfs()
    stubStorage(fake)
    const file = mediaFile('same bytes')
    const hash = await hashFile(file)
    await writeMediaFile(PROJECT, hash, file)
    const record = fake.get(`/${PROJECT}/${hash}`)
    await writeMediaFile(PROJECT, hash, file)
    expect(fake.get(`/${PROJECT}/${hash}`)).toBe(record)
  })

  it('quarantines a damaged entry and replaces it', async () => {
    const fake = createFakeOpfs()
    stubStorage(fake)
    const file = mediaFile('real bytes')
    const hash = await hashFile(file)
    fake.put(`/${PROJECT}/${hash}`, 'garbage')
    await writeMediaFile(PROJECT, hash, file)
    const stored = await readMediaFile(PROJECT, hash)
    expect(stored).not.toBeNull()
    expect(new TextDecoder().decode(new Uint8Array(await stored!.file.arrayBuffer()))).toBe(
      'real bytes',
    )
    expect([...fake.files.keys()].some((path) => path.includes('.quarantine-'))).toBe(false)
  })

  it('falls back to a direct copy when the browser has no file move', async () => {
    const fake = createFakeOpfs()
    fake.supportsMove = false
    stubStorage(fake)
    const file = mediaFile('copied bytes')
    const hash = await hashFile(file)
    await writeMediaFile(PROJECT, hash, file)
    expect(await readMediaFile(PROJECT, hash)).not.toBeNull()
    expect(fake.get(`/${PROJECT}/${hash}`)?.bytes.length).toBe(file.size)
  })

  it('rejects a write whose close fails and leaves no partial entry', async () => {
    const fake = createFakeOpfs()
    stubStorage(fake)
    const file = mediaFile('will fail')
    const hash = await hashFile(file)
    fake.failWrites = 1
    await expect(writeMediaFile(PROJECT, hash, file)).rejects.toThrow()
    expect(fake.get(`/${PROJECT}/${hash}`)).toBeUndefined()
    expect([...fake.files.keys()].some((path) => path.includes('.tmp-'))).toBe(false)
  })

  it('surfaces a quota rejection', async () => {
    const fake = createFakeOpfs({ quotaBytes: 4 })
    stubStorage(fake)
    const file = mediaFile('too large for the quota')
    const hash = await hashFile(file)
    await expect(writeMediaFile(PROJECT, hash, file)).rejects.toMatchObject({
      name: 'QuotaExceededError',
    })
    expect(fake.files.size).toBe(0)
  })

  it('treats a missing or tampered entry as missing', async () => {
    const fake = createFakeOpfs()
    stubStorage(fake)
    expect(await readMediaFile(PROJECT, 'a'.repeat(64))).toBeNull()
    const file = mediaFile('tampered later')
    const hash = await hashFile(file)
    await writeMediaFile(PROJECT, hash, file)
    fake.put(`/${PROJECT}/${hash}`, 'swapped bytes')
    expect(await readMediaFile(PROJECT, hash)).toBeNull()
  })

  it('falls back when the sidecar is malformed', async () => {
    const fake = createFakeOpfs()
    stubStorage(fake)
    const file = mediaFile('sidecar', 'audio/mpeg')
    const hash = await hashFile(file)
    await writeMediaFile(PROJECT, hash, file)
    fake.put(`/${PROJECT}/${hash}.json`, '{not json')
    const stored = await readMediaFile(PROJECT, hash)
    expect(stored?.type).toBe('')
    expect(stored?.hasSidecar).toBe(false)
  })

  it('deletes an entry and its sidecar, and ignores a missing entry', async () => {
    const fake = createFakeOpfs()
    stubStorage(fake)
    const file = mediaFile('to delete')
    const hash = await hashFile(file)
    await writeMediaFile(PROJECT, hash, file)
    await deleteMediaFile(PROJECT, hash)
    expect(fake.get(`/${PROJECT}/${hash}`)).toBeUndefined()
    expect(fake.get(`/${PROJECT}/${hash}.json`)).toBeUndefined()
    await expect(deleteMediaFile(PROJECT, 'b'.repeat(64))).resolves.toBeUndefined()
  })

  it('lists media entries without sidecars, claims, or temp files', async () => {
    const fake = createFakeOpfs()
    stubStorage(fake)
    const one = mediaFile('one')
    const two = mediaFile('two')
    const oneHash = await hashFile(one)
    const twoHash = await hashFile(two)
    await ensureProjectMedia(PROJECT)
    await writeMediaFile(PROJECT, oneHash, one)
    await writeMediaFile(PROJECT, twoHash, two)
    await writeMediaClaim(PROJECT, [oneHash])
    fake.put(`/${PROJECT}/.tmp-leftover`, 'x')
    const entries = await listMediaFiles(PROJECT)
    expect(entries.map((entry) => entry.hash)).toEqual([oneHash, twoHash].sort())
    expect(await projectMediaUsage(PROJECT)).toBe(one.size + two.size)
  })

  it('does not resurrect an entry that fails verification after a failed replacement', async () => {
    const fake = createFakeOpfs()
    stubStorage(fake)
    await ensureProjectMedia(PROJECT)
    const file = mediaFile('valid bytes')
    const hash = await hashFile(file)
    // The entry fails verification, so the write quarantines it and then fails
    // while writing the replacement. Corrupt bytes must not go back under the
    // hash just because they were there before.
    fake.put(`/${PROJECT}/${hash}`, 'damaged bytes')
    fake.failWrites = 1
    await expect(writeMediaFile(PROJECT, hash, file)).rejects.toBeInstanceOf(Error)
    expect(fake.get(`/${PROJECT}/${hash}`)).toBeUndefined()
    expect([...fake.files.keys()].filter((path) => path.includes('.quarantine'))).toEqual([])
  })

  it('restores a verified entry after a failed replacement', async () => {
    const fake = createFakeOpfs()
    stubStorage(fake)
    await ensureProjectMedia(PROJECT)
    const file = mediaFile('valid bytes')
    const hash = await hashFile(file)
    // A valid entry that the replacement read treats as damaged, as a racing
    // writer would: the failed write quarantines it and must put it back.
    fake.put(`/${PROJECT}/${hash}`, 'valid bytes')
    const realDigest = crypto.subtle.digest.bind(crypto.subtle)
    let calls = 0
    const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
      calls += 1
      const digest = await realDigest(algorithm, data)
      // Call 2 is the existing-entry check; the import's own hash is call 1.
      return calls === 2 ? new Uint8Array(digest.byteLength).buffer : digest
    })
    fake.failWrites = 1
    try {
      await expect(writeMediaFile(PROJECT, hash, file)).rejects.toBeInstanceOf(Error)
    } finally {
      spy.mockRestore()
    }
    expect(new Uint8Array(fake.get(`/${PROJECT}/${hash}`)?.bytes ?? [])).toEqual(
      new Uint8Array(await file.arrayBuffer()),
    )
  })
})

describe('media claims', () => {
  it('creates the project and claims directories on demand', async () => {
    const fake = createFakeOpfs()
    stubStorage(fake)
    await ensureProjectMedia(PROJECT)
    expect(fake.directories.has(`/${PROJECT}`)).toBe(true)
    expect(fake.directories.has(`/${PROJECT}/claims`)).toBe(true)
    expect(await readMediaClaims(PROJECT)).toEqual([])
  })

  it('unions two concurrent claim shards without losing either', async () => {
    const fake = createFakeOpfs()
    stubStorage(fake)
    await ensureProjectMedia(PROJECT)
    const a = 'a'.repeat(64)
    const b = 'b'.repeat(64)
    const [first, second] = await Promise.all([
      writeMediaClaim(PROJECT, [a]),
      writeMediaClaim(PROJECT, [b]),
    ])
    expect(first).not.toBe(second)
    expect(await readMediaClaims(PROJECT)).toEqual([a, b])
  })

  it('drops invalid hashes from a claim and keeps valid duplicates once', async () => {
    const fake = createFakeOpfs()
    stubStorage(fake)
    await ensureProjectMedia(PROJECT)
    const valid = 'c'.repeat(64)
    await writeMediaClaim(PROJECT, [valid, valid, '../evil', 'D'.repeat(64)])
    expect(await readMediaClaims(PROJECT)).toEqual([valid])
  })

  it('does not recreate a lost claims directory while stored hashes exist', async () => {
    const fake = createFakeOpfs()
    stubStorage(fake)
    const file = mediaFile('existing bytes')
    const hash = await hashFile(file)
    // Bytes written by an earlier build (or a partially evicted store) without
    // a claims directory: an empty replacement would erase the only evidence
    // that a closed copy may still reference them.
    await writeMediaFile(PROJECT, hash, file)
    expect(await ensureProjectMedia(PROJECT)).toBe('claims-missing')
    expect(fake.directories.has(`/${PROJECT}/claims`)).toBe(false)
    expect(await readMediaClaims(PROJECT)).toBeNull()
    expect((await cleanProjectMedia(PROJECT, [])).claimsUnreadable).toBe(true)
  })

  it('does not recreate lost claims when only the font namespace has hashes', async () => {
    const fake = createFakeOpfs()
    stubStorage(fake)
    const font = new File([bytes('font bytes')], 'brand.woff2', { type: 'font/woff2' })
    const hash = await hashFile(font)
    await writeMediaFile(PROJECT, hash, font, 'fonts')
    expect(await ensureProjectMedia(PROJECT)).toBe('claims-missing')
    expect(fake.directories.has(`/${PROJECT}/claims`)).toBe(false)
    expect(await readMediaClaims(PROJECT)).toBeNull()
  })

  it('creates a complete empty record for a project with no stored hashes', async () => {
    const fake = createFakeOpfs()
    stubStorage(fake)
    await ensureProjectMedia(PROJECT)
    fake.directories.delete(`/${PROJECT}/claims`)
    expect(await ensureProjectMedia(PROJECT)).toBe('ready')
    expect(await readMediaClaims(PROJECT)).toEqual([])
  })

  it('removes a partially published shard when the fallback write fails', async () => {
    const fake = createFakeOpfs()
    stubStorage(fake)
    await ensureProjectMedia(PROJECT)
    const first = 'a'.repeat(64)
    await writeMediaClaim(PROJECT, [first])

    // No rename support: the claim publishes straight to its final name. Fail
    // only that final write (the temp write must succeed first): size the
    // quota so the temp entry fits and the final one does not.
    fake.supportsMove = false
    const finalJson = JSON.stringify({ version: 1, hashes: ['b'.repeat(64)] })
    fake.quotaBytes = fake.usage() + finalJson.length + 10
    await expect(writeMediaClaim(PROJECT, ['b'.repeat(64)])).rejects.toThrow()
    expect(await readMediaClaims(PROJECT)).toEqual([first])
    expect([...fake.files.keys()].filter((path) => path.includes('/claims/claim-'))).toHaveLength(1)
  })

  it('returns null when the claims directory is missing and when a shard is unreadable', async () => {
    const fake = createFakeOpfs()
    stubStorage(fake)
    const hash = await hashOf('x')
    fake.put(`/${PROJECT}/${hash}`, 'x')
    expect(await readMediaClaims(PROJECT)).toBeNull()

    await ensureProjectMedia(PROJECT)
    fake.put(`/${PROJECT}/claims/claim-broken.json`, 'not json')
    expect(await readMediaClaims(PROJECT)).toBeNull()
  })

  it('refuses a claim when the claims directory is missing but bytes exist', async () => {
    const fake = createFakeOpfs()
    stubStorage(fake)
    const file = mediaFile('existing bytes')
    const hash = await hashFile(file)
    await writeMediaFile(PROJECT, hash, file)
    // Publishing a shard would create an empty directory here and report the
    // save as safe while a closed copy's claims stay unknown.
    await expect(writeMediaClaim(PROJECT, [hash])).rejects.toBeInstanceOf(MediaStoreError)
    expect(fake.directories.has(`/${PROJECT}/claims`)).toBe(false)
    expect(await readMediaClaims(PROJECT)).toBeNull()
  })

  it('refuses a claim when an existing shard is unreadable', async () => {
    const fake = createFakeOpfs()
    stubStorage(fake)
    await ensureProjectMedia(PROJECT)
    const hash = await hashOf('new bytes')
    fake.put(`/${PROJECT}/claims/claim-broken.json`, 'not json')
    await expect(writeMediaClaim(PROJECT, [hash])).rejects.toBeInstanceOf(MediaStoreError)
    // The broken shard is untouched, and the save is reported as refused.
    expect(fake.get(`/${PROJECT}/claims/claim-broken.json`)?.bytes).toBeDefined()
    expect(await readMediaClaims(PROJECT)).toBeNull()
  })
})

describe('media cleanup', () => {
  async function seeded() {
    const fake = createFakeOpfs()
    stubStorage(fake)
    await ensureProjectMedia(PROJECT)
    const claimed = mediaFile('claimed')
    const kept = mediaFile('kept')
    const orphan = mediaFile('orphan')
    const claimedHash = await hashFile(claimed)
    const keptHash = await hashFile(kept)
    const orphanHash = await hashFile(orphan)
    await writeMediaFile(PROJECT, claimedHash, claimed)
    await writeMediaFile(PROJECT, keptHash, kept)
    await writeMediaFile(PROJECT, orphanHash, orphan)
    await writeMediaClaim(PROJECT, [claimedHash])
    return { fake, claimedHash, keptHash, orphanHash }
  }

  it('deletes only unclaimed hashes outside the keep set and reports the size', async () => {
    const { fake, claimedHash, keptHash, orphanHash } = await seeded()
    const sidecarBytes = fake.get(`/${PROJECT}/${orphanHash}.json`)!.bytes.length
    const result = await cleanProjectMedia(PROJECT, [keptHash])
    expect(result.deleted).toEqual([orphanHash])
    expect(result.reclaimed).toBe(mediaFile('orphan').size + sidecarBytes)
    expect(result.claimsUnreadable).toBe(false)
    expect(await readMediaFile(PROJECT, claimedHash)).not.toBeNull()
    expect(await readMediaFile(PROJECT, keptHash)).not.toBeNull()
    expect(await readMediaFile(PROJECT, orphanHash)).toBeNull()
    expect(fake.get(`/${PROJECT}/${orphanHash}.json`)).toBeUndefined()
  })

  it('deletes no content hash when claims are missing, but clears temp files', async () => {
    const fake = createFakeOpfs()
    stubStorage(fake)
    const orphan = mediaFile('orphan')
    const hash = await hashFile(orphan)
    await writeMediaFile(PROJECT, hash, orphan)
    fake.put(`/${PROJECT}/.tmp-leftover`, 'x')
    fake.put(`/${PROJECT}/.quarantine-old`, 'y')
    const result = await cleanProjectMedia(PROJECT, [])
    expect(result.claimsUnreadable).toBe(true)
    expect(result.deleted).toEqual([])
    expect(result.removedTemporary).toBe(2)
    expect(await readMediaFile(PROJECT, hash)).not.toBeNull()
  })

  it('clear-all removes every entry and the claims directory, keeping the project dir', async () => {
    const { fake, claimedHash, keptHash, orphanHash } = await seeded()
    const sidecarBytes = [claimedHash, keptHash, orphanHash].reduce(
      (total, hash) => total + (fake.get(`/${PROJECT}/${hash}.json`)?.bytes.length ?? 0),
      0,
    )
    const result = await clearProjectMedia(PROJECT)
    expect(result.deleted).toBe(3)
    expect(result.reclaimed).toBe(
      mediaFile('claimed').size + mediaFile('kept').size + mediaFile('orphan').size + sidecarBytes,
    )
    for (const hash of [claimedHash, keptHash, orphanHash]) {
      expect(fake.get(`/${PROJECT}/${hash}`)).toBeUndefined()
    }
    expect(fake.directories.has(`/${PROJECT}/claims`)).toBe(false)
    expect(fake.directories.has(`/${PROJECT}`)).toBe(true)
    expect(await readMediaClaims(PROJECT)).toBeNull()
  })

  it('clear-all counts temp and quarantine bytes in the font namespace', async () => {
    const fake = createFakeOpfs()
    stubStorage(fake)
    await ensureProjectMedia(PROJECT)
    const font = new File([bytes('font bytes')], 'inter.woff2', { type: 'font/woff2' })
    const hash = await hashFile(font)
    await writeMediaFile(PROJECT, hash, font, 'fonts')
    fake.put(`/${PROJECT}/fonts/.tmp-leftover`, '123')
    fake.put(`/${PROJECT}/fonts/.quarantine-old`, '45')
    const expected = [...fake.files.entries()]
      .filter(([path]) => path.startsWith(`/${PROJECT}/fonts/`))
      .reduce((total, [, entry]) => total + entry.bytes.length, 0)

    const result = await clearProjectMedia(PROJECT)

    expect(result.deleted).toBe(1)
    expect(result.reclaimed).toBe(expected)
    expect([...fake.files.keys()].some((path) => path.startsWith(`/${PROJECT}/fonts/`))).toBe(false)
  })

  it('clear-all removes temp, quarantine, and orphan sidecar bytes and reports them', async () => {
    const fake = createFakeOpfs()
    stubStorage(fake)
    await ensureProjectMedia(PROJECT)
    const file = mediaFile('media bytes')
    const hash = await hashFile(file)
    await writeMediaFile(PROJECT, hash, file)
    fake.put(`/${PROJECT}/.tmp-leftover`, '123')
    fake.put(`/${PROJECT}/.quarantine-old`, '45')
    fake.put(`/${PROJECT}/${'b'.repeat(64)}.json`, '1234')
    const pairedSidecar = fake.get(`/${PROJECT}/${hash}.json`)!.bytes.length

    const result = await clearProjectMedia(PROJECT)

    expect(result.deleted).toBe(1)
    expect(result.reclaimed).toBe(file.size + pairedSidecar + 3 + 2 + 4)
    expect(fake.get(`/${PROJECT}/.tmp-leftover`)).toBeUndefined()
    expect(fake.get(`/${PROJECT}/.quarantine-old`)).toBeUndefined()
    expect(fake.get(`/${PROJECT}/${'b'.repeat(64)}.json`)).toBeUndefined()
    expect(fake.files.size).toBe(0)
  })

  it('reports a failed delete instead of claiming nothing was unreferenced', async () => {
    const fake = createFakeOpfs()
    stubStorage(fake)
    await ensureProjectMedia(PROJECT)
    const file = mediaFile('doomed')
    const hash = await hashFile(file)
    await writeMediaFile(PROJECT, hash, file)
    fake.failRemoves = 1

    await expect(cleanProjectMedia(PROJECT, [])).rejects.toThrow()
    // The failure surfaced instead of reading as "nothing to clean": the
    // entry is still there and no size was counted as reclaimed.
    expect(fake.get(`/${PROJECT}/${hash}`)?.bytes).toBeDefined()
  })

  it('cleans an entry whose sidecar name is a directory, counting only readable bytes', async () => {
    const fake = createFakeOpfs()
    stubStorage(fake)
    await ensureProjectMedia(PROJECT)
    const file = mediaFile('orphan with sidecar directory')
    const hash = await hashFile(file)
    await writeMediaFile(PROJECT, hash, file)
    const sidecar = `/${PROJECT}/${hash}.json`
    fake.remove(sidecar)
    fake.directories.add(sidecar)

    const result = await cleanProjectMedia(PROJECT, [])

    expect(result.deleted).toEqual([hash])
    expect(result.reclaimed).toBe(file.size)
    expect(fake.get(`/${PROJECT}/${hash}`)).toBeUndefined()
    expect(fake.directories.has(sidecar)).toBe(false)
  })

  it('clear-all removes an entry whose sidecar name is a directory', async () => {
    const fake = createFakeOpfs()
    stubStorage(fake)
    await ensureProjectMedia(PROJECT)
    const file = mediaFile('clear with sidecar directory')
    const hash = await hashFile(file)
    await writeMediaFile(PROJECT, hash, file)
    const sidecar = `/${PROJECT}/${hash}.json`
    fake.remove(sidecar)
    fake.directories.add(sidecar)

    const result = await clearProjectMedia(PROJECT)

    expect(result.deleted).toBe(1)
    expect(result.reclaimed).toBe(file.size)
    expect(fake.get(`/${PROJECT}/${hash}`)).toBeUndefined()
    expect(fake.directories.has(sidecar)).toBe(false)
  })

  it('reports storage estimates and persistence', async () => {
    const fake = createFakeOpfs()
    stubStorage(fake)
    fake.put(`/${PROJECT}/a`, '1234')
    expect(await estimateMediaStore()).toEqual({ usage: 4, quota: 4096 })
    expect(await requestPersistentStorage()).toBe(true)
    expect(await isStoragePersistent()).toBe(false)

    vi.stubGlobal('navigator', {})
    expect(await estimateMediaStore()).toBeNull()
    expect(await requestPersistentStorage()).toBe(false)
  })
})

describe('project lock', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function stubLocks() {
    const locks = new FakeLockManager()
    vi.stubGlobal('navigator', { locks })
    return locks
  }

  it('holds the shared lock for the tab lifetime', async () => {
    const locks = stubLocks()
    const lock = await ProjectLock.acquire(PROJECT)
    expect(locks.held(projectLockName(PROJECT))).toBe(1)
    lock.dispose()
    await vi.waitFor(() => expect(locks.held(projectLockName(PROJECT))).toBe(0))
  })

  it('refuses an exclusive request when another tab holds the project', async () => {
    const locks = stubLocks()
    const first = await ProjectLock.acquire(PROJECT)
    const second = await ProjectLock.acquire(PROJECT)
    const ran = vi.fn(async () => 'deleted')
    expect(await first.exclusive(ran)).toEqual({ status: 'busy' })
    expect(ran).not.toHaveBeenCalled()
    // The refused clean restored this tab's shared hold.
    expect(locks.held(projectLockName(PROJECT))).toBe(2)
    first.dispose()
    second.dispose()
  })

  it('runs exclusively when this tab is the only holder, then restores shared', async () => {
    const locks = stubLocks()
    const lock = await ProjectLock.acquire(PROJECT)
    const ran = vi.fn(async () => 'deleted')
    expect(await lock.exclusive(ran)).toEqual({ status: 'ran', value: 'deleted' })
    expect(ran).toHaveBeenCalledTimes(1)
    expect(locks.held(projectLockName(PROJECT))).toBe(1)
    lock.dispose()
  })

  it('reports unsupported without Web Locks and refuses after dispose', async () => {
    vi.stubGlobal('navigator', {})
    const unsupported = await ProjectLock.acquire(PROJECT)
    expect(unsupported.isHeld).toBe(false)
    expect(await unsupported.exclusive(async () => 1)).toEqual({ status: 'unsupported' })

    const locks = stubLocks()
    const lock = await ProjectLock.acquire(PROJECT)
    lock.dispose()
    expect(await lock.exclusive(async () => 1)).toEqual({ status: 'unsupported' })
    await vi.waitFor(() => expect(locks.held(projectLockName(PROJECT))).toBe(0))
  })

  it('does not look held when the shared request is rejected', async () => {
    const locks = stubLocks()
    const request = vi.spyOn(locks, 'request').mockRejectedValueOnce(new Error('denied'))
    const lock = await ProjectLock.acquire(PROJECT)
    try {
      // Open still resolves (never hangs), but without a real hold this tab
      // blocks nobody, so exclusive work refuses instead of deleting
      // uncoordinated.
      expect(lock.isHeld).toBe(false)
      expect(await lock.exclusive(async () => 1)).toEqual({ status: 'unsupported' })
      expect(locks.held(projectLockName(PROJECT))).toBe(0)
    } finally {
      request.mockRestore()
      lock.dispose()
    }
  })

  it('keeps same-name request order instead of letting a later one jump ahead', async () => {
    const locks = stubLocks()
    const order: string[] = []
    // A shared holder is compatible with a later shared request, but an
    // exclusive request queued in between owns the name first.
    let releaseHolder!: () => void
    const holder = locks.request(
      projectLockName(PROJECT),
      { mode: 'shared' },
      () =>
        new Promise<void>((resolve) => {
          releaseHolder = resolve
        }),
    )
    const first = locks.request(projectLockName(PROJECT), {}, async () => {
      order.push('first')
      return 'first'
    })
    let secondRan = false
    const second = locks.request(projectLockName(PROJECT), { mode: 'shared' }, async () => {
      secondRan = true
      order.push('second')
      return 'second'
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    // Grantable by holder count, but queued behind the earlier exclusive.
    expect(secondRan).toBe(false)

    releaseHolder()
    await holder
    expect(await first).toBe('first')
    expect(await second).toBe('second')
    expect(order).toEqual(['first', 'second'])
  })

  it('does not grant a later same-name request while the head stays blocked', async () => {
    const locks = stubLocks()
    const order: string[] = []
    // A persistent shared holder blocks an exclusive head but allows a shared
    // read; the later read must still wait behind the head. An unrelated
    // completion triggers the drain that would otherwise skip ahead.
    const other = `${PROJECT}-other`
    void locks.request(projectLockName(PROJECT), { mode: 'shared' }, () => new Promise(() => {}))
    const head = locks.request(projectLockName(PROJECT), {}, async () => {
      order.push('head')
      return 'head'
    })
    void head
    const later = locks.request(projectLockName(PROJECT), { mode: 'shared' }, async () => {
      order.push('later')
      return 'later'
    })
    void later
    await locks.request(projectLockName(other), { mode: 'shared' }, async () => 'unrelated')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(order).toEqual([])
  })

  it('reports a blocked later request with ifAvailable as null without skipping the queue', async () => {
    const locks = stubLocks()
    let releaseHolder!: () => void
    const holder = locks.request(
      projectLockName(PROJECT),
      { mode: 'exclusive' },
      () =>
        new Promise<void>((resolve) => {
          releaseHolder = resolve
        }),
    )
    const waiting = locks.request(projectLockName(PROJECT), {}, async () => 'waiting')
    // Blocked behind the earlier pending request for the same name, even
    // though no holder count would stop it yet: it must not jump the queue.
    let seen: unknown = 'unset'
    await locks.request(
      projectLockName(PROJECT),
      { mode: 'shared', ifAvailable: true },
      async (lock) => {
        seen = lock
        return 'done'
      },
    )
    expect(seen).toBeNull()

    releaseHolder()
    await holder
    expect(await waiting).toBe('waiting')
  })
})

describe('font namespace in the durable store (0.25.0)', () => {
  it('stores, reads, lists, and deletes font bytes separately from media', async () => {
    const fake = createFakeOpfs()
    stubStorage(fake)
    await ensureProjectMedia(PROJECT)
    const font = new File([bytes('font-bytes')], 'inter.woff2', { type: 'font/woff2' })
    const fontHash = await hashFile(font)
    const media = mediaFile('media-bytes')
    const mediaHash = await hashFile(media)
    await writeMediaFile(PROJECT, fontHash, font, 'fonts')
    await writeMediaFile(PROJECT, mediaHash, media)

    expect((await readMediaFile(PROJECT, fontHash, 'fonts'))?.type).toBe('font/woff2')
    expect(await readMediaFile(PROJECT, fontHash)).toBeNull()
    expect((await listMediaFiles(PROJECT, 'fonts')).map((entry) => entry.hash)).toEqual([fontHash])
    expect((await listMediaFiles(PROJECT)).map((entry) => entry.hash)).toEqual([mediaHash])
    expect(await projectMediaUsage(PROJECT)).toBe(font.size + media.size)

    await deleteMediaFile(PROJECT, fontHash, 'fonts')
    expect(await readMediaFile(PROJECT, fontHash, 'fonts')).toBeNull()
    expect(await listMediaFiles(PROJECT, 'fonts')).toEqual([])
    expect(await readMediaFile(PROJECT, mediaHash)).not.toBeNull()
  })

  it('cleans unreferenced font bytes and keeps claimed or referenced ones', async () => {
    const fake = createFakeOpfs()
    stubStorage(fake)
    await ensureProjectMedia(PROJECT)
    const kept = new File([bytes('kept-font')], 'kept.woff2', { type: 'font/woff2' })
    const keptHash = await hashFile(kept)
    const dropped = new File([bytes('dropped-font')], 'dropped.woff2', { type: 'font/woff2' })
    const droppedHash = await hashFile(dropped)
    const media = mediaFile('kept-media')
    const mediaHash = await hashFile(media)
    await writeMediaFile(PROJECT, keptHash, kept, 'fonts')
    await writeMediaFile(PROJECT, droppedHash, dropped, 'fonts')
    await writeMediaFile(PROJECT, mediaHash, media)
    await writeMediaClaim(PROJECT, [mediaHash])

    const sidecarBytes = fake.get(`/${PROJECT}/fonts/${droppedHash}.json`)!.bytes.length
    const result = await cleanProjectMedia(PROJECT, [keptHash])
    expect(result.deleted).toEqual([droppedHash])
    expect(result.reclaimed).toBe(dropped.size + sidecarBytes)
    expect(await listMediaFiles(PROJECT, 'fonts')).toEqual([{ hash: keptHash, size: kept.size }])
    expect(await readMediaFile(PROJECT, mediaHash)).not.toBeNull()
  })

  it('keeps a hash used by both namespaces when either side references it', async () => {
    const fake = createFakeOpfs()
    stubStorage(fake)
    await ensureProjectMedia(PROJECT)
    const bytesText = 'shared-bytes'
    const shared = new File([bytes(bytesText)], 'shared.woff2', { type: 'font/woff2' })
    const hash = await hashFile(shared)
    // The same content is a font and a media entry.
    await writeMediaFile(PROJECT, hash, shared, 'fonts')
    await writeMediaFile(PROJECT, hash, new File([bytes(bytesText)], 'shared.mp4'))
    const result = await cleanProjectMedia(PROJECT, [hash])
    expect(result.deleted).toEqual([])
    expect(await readMediaFile(PROJECT, hash, 'fonts')).not.toBeNull()
  })

  it('clear-all removes the font directory and its bytes', async () => {
    const fake = createFakeOpfs()
    stubStorage(fake)
    await ensureProjectMedia(PROJECT)
    const font = new File([bytes('font')], 'a.woff2', { type: 'font/woff2' })
    const hash = await hashFile(font)
    await writeMediaFile(PROJECT, hash, font, 'fonts')
    const expected = [...fake.files.entries()]
      .filter(([path]) => path.startsWith(`/${PROJECT}/fonts/`))
      .reduce((total, [, entry]) => total + entry.bytes.length, 0)
    const result = await clearProjectMedia(PROJECT)
    expect(result.deleted).toBe(1)
    expect(result.reclaimed).toBe(expected)
    expect(await listMediaFiles(PROJECT, 'fonts')).toEqual([])
    expect(fake.directories.has(`/${PROJECT}/fonts`)).toBe(false)
  })
})
