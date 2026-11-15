import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  cleanProjectMedia,
  ensureProjectMedia,
  readMediaClaimShards,
  readMediaClaims,
  readMediaFile,
  recoverOrphanedClaimShards,
  sha256Hex,
  writeMediaClaim,
  writeMediaFile,
} from '../media/media-store'
import {
  clearInstalledRegistry,
  isInstallHistoryLost,
  isInstallRecorded,
  newInstallId,
  readInstalledRegistry,
  recordInstalledImport,
  writePendingInstallRecord,
} from '../media/installed-registry'
import { createFakeOpfs, type FakeOpfs } from './mocks/opfs'

const PROJECT = 'proj_claims'
const storage = new Map<string, string>()

const localStorageMock = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
  clear: () => void storage.clear(),
}

let opfs: FakeOpfs

beforeEach(async () => {
  storage.clear()
  vi.stubGlobal('localStorage', localStorageMock)
  opfs = createFakeOpfs()
  vi.stubGlobal('navigator', {
    storage: { getDirectory: async () => opfs.root },
  })
  clearInstalledRegistry()
  await ensureProjectMedia(PROJECT)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function hash(text: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(text))
}

describe('claim recovery (0.28.0)', () => {
  it('keeps a shard whose install is recorded', async () => {
    const installId = newInstallId()
    expect(recordInstalledImport(PROJECT, installId)).toBe(true)
    await writeMediaClaim(PROJECT, [await hash('a')], installId)
    const result = await recoverOrphanedClaimShards(PROJECT)
    expect(result).toMatchObject({ removed: 0, kept: 1, ambiguous: false })
    expect((await readMediaClaimShards(PROJECT))?.shards).toHaveLength(1)
  })

  it('removes a shard whose install was never recorded, without deleting bytes', async () => {
    // A present registry makes the absence of this id meaningful. With no
    // record at all, recovery keeps the shard (see the missing-key test).
    expect(recordInstalledImport(PROJECT, newInstallId())).toBe(true)
    const installId = newInstallId()
    await writeMediaClaim(PROJECT, [await hash('a')], installId)
    expect((await readMediaClaimShards(PROJECT))?.shards[0]?.installId).toBe(installId)
    const result = await recoverOrphanedClaimShards(PROJECT)
    expect(result).toMatchObject({ removed: 1, kept: 0, ambiguous: false })
    expect(await readMediaClaims(PROJECT)).toEqual([])
  })

  it('treats a missing registry as proven when no shard carries an install id', async () => {
    await writeMediaClaim(PROJECT, [await hash('a')])
    const result = await recoverOrphanedClaimShards(PROJECT)
    expect(result).toMatchObject({ removed: 0, kept: 1, ambiguous: false })
    expect((await readMediaClaimShards(PROJECT))?.shards).toHaveLength(1)
  })

  it('marks the install history unknown when an append would exceed its bound', async () => {
    const ids = Array.from({ length: 2048 }, (_, index) => `install-cap-${index}`)
    localStorageMock.setItem(
      'web-video-editor:installed-installs:v1',
      JSON.stringify({ [PROJECT]: ids }),
    )
    expect(recordInstalledImport(PROJECT, newInstallId())).toBe(false)
    expect(isInstallHistoryLost()).toBe(true)
  })

  it('always keeps a normal save shard without an install id', async () => {
    expect(recordInstalledImport(PROJECT, newInstallId())).toBe(true)
    await writeMediaClaim(PROJECT, [await hash('a')])
    const result = await recoverOrphanedClaimShards(PROJECT)
    expect(result).toMatchObject({ removed: 0, kept: 1, ambiguous: false })
    expect(await readMediaClaims(PROJECT)).toEqual([await hash('a')])
  })

  it('keeps every shard and warns when the install registry is unreadable', async () => {
    const installId = newInstallId()
    await writeMediaClaim(PROJECT, [await hash('a')], installId)
    localStorageMock.setItem('web-video-editor:installed-installs:v1', '{not json')
    expect(readInstalledRegistry()).toBeNull()
    expect(isInstallRecorded(PROJECT, installId)).toBeNull()
    const result = await recoverOrphanedClaimShards(PROJECT)
    expect(result.ambiguous).toBe(true)
    expect(result.removed).toBe(0)
    expect(result.warning).toContain('kept')
    expect((await readMediaClaimShards(PROJECT))?.shards).toHaveLength(1)
  })

  it('keeps a recorded install claim and its bytes when the registry key is lost', async () => {
    const installId = newInstallId()
    const content = 'kept-bytes'
    const digest = await hash(content)
    await writeMediaFile(
      PROJECT,
      digest,
      new File([new TextEncoder().encode(content)], 'kept.mp4', { type: 'video/mp4' }),
    )
    expect(recordInstalledImport(PROJECT, installId)).toBe(true)
    await writeMediaClaim(PROJECT, [digest], installId)
    localStorageMock.removeItem('web-video-editor:installed-installs:v1')
    // A missing record proves nothing, so it must not read as "no installs".
    expect(isInstallRecorded(PROJECT, installId)).toBeNull()
    const recovery = await recoverOrphanedClaimShards(PROJECT)
    expect(recovery).toMatchObject({ removed: 0, kept: 1, ambiguous: true })
    expect(recovery.warning).toContain('missing')
    const cleaned = await cleanProjectMedia(PROJECT, [])
    expect(cleaned.deleted).toEqual([])
    expect(await readMediaFile(PROJECT, digest)).not.toBeNull()
  })

  it('keeps a completed install claim while its record is still pending', async () => {
    // The registry looks complete but omits this install: without durable
    // pending state, recovery would retire the shard after a reload.
    expect(recordInstalledImport(PROJECT, newInstallId())).toBe(true)
    const installId = newInstallId()
    await writeMediaClaim(PROJECT, [await hash('a')], installId)
    expect(
      writePendingInstallRecord({ projectId: PROJECT, installId, hadInstallClaims: true }),
    ).toBe(true)
    const result = await recoverOrphanedClaimShards(PROJECT)
    expect(result).toMatchObject({ removed: 0, kept: 1, ambiguous: true })
    expect(result.warning).toContain('pending')
    expect((await readMediaClaimShards(PROJECT))?.shards).toHaveLength(1)
  })

  it('keeps earlier claims when a lost registry is recreated by a new install', async () => {
    const first = newInstallId()
    expect(recordInstalledImport(PROJECT, first)).toBe(true)
    await writeMediaClaim(PROJECT, [await hash('a')], first)
    localStorageMock.removeItem('web-video-editor:installed-installs:v1')
    const second = newInstallId()
    expect(recordInstalledImport(PROJECT, second, { hadInstallClaims: true })).toBe(true)
    const recovery = await recoverOrphanedClaimShards(PROJECT)
    expect(recovery).toMatchObject({ removed: 0, kept: 1, ambiguous: true })
    expect(recovery.warning).toContain('lost')
    expect((await readMediaClaimShards(PROJECT))?.shards[0]?.installId).toBe(first)
  })

  async function expectProjectIdHandled(projectId: string): Promise<void> {
    const first = newInstallId()
    const second = newInstallId()
    expect(recordInstalledImport(projectId, first)).toBe(true)
    expect(recordInstalledImport(projectId, second)).toBe(true)
    expect(isInstallRecorded(projectId, first)).toBe(true)
    expect(readInstalledRegistry()?.[projectId]).toEqual([first, second])
  }

  it('handles the constructor project id without an inherited lookup', async () => {
    await expectProjectIdHandled('constructor')
  })

  it('handles the __proto__ project id without an inherited lookup', async () => {
    await expectProjectIdHandled('__proto__')
  })

  it('validates hostile registry records instead of trusting them', () => {
    for (const value of [
      '[]',
      '{"proj_claims": "install-one"}',
      '{"proj_claims": ["bad"]}',
      '{"../evil": ["install-one"]}',
    ]) {
      localStorageMock.setItem('web-video-editor:installed-installs:v1', value)
      expect(readInstalledRegistry()).toBeNull()
    }
  })

  it('writes the install id into the shard and unions hashes normally', async () => {
    const installId = newInstallId()
    const one = await hash('a')
    const two = await hash('b')
    await writeMediaClaim(PROJECT, [one], installId)
    await writeMediaClaim(PROJECT, [two])
    const records = await readMediaClaimShards(PROJECT)
    expect(records?.hashes).toEqual([one, two].sort())
    expect(records?.shards.map((shard) => shard.installId).sort()).toEqual([installId, null].sort())
  })
})
