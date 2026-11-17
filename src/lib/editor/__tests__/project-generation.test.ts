import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const claimState = vi.hoisted(() => ({
  started: false,
  resolve: null as null | ((claimed: boolean) => void),
}))

vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }))
vi.mock('../media/persist', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../media/persist')>()
  return {
    ...actual,
    prepareProjectStore: async () => true,
    storeMediaAsset: async () => {
      throw new Error('not used')
    },
    writeProjectClaim: () => {
      claimState.started = true
      return new Promise<boolean>((resolve) => {
        claimState.resolve = resolve
      })
    },
  }
})

import { downloadProjectJSON, installProject } from '../project-io'
import { createDoc, createMediaAsset } from '../factories'
import { ensureProjectMedia } from '../media/media-store'
import { useEditorStore } from '../store'
import { createFakeOpfs, type FakeOpfs } from './mocks/opfs'
import type { Doc } from '../types'

/**
 * A save claims the snapshot it serializes, and the claim can outlive the
 * project it belongs to. Only that project may be unblocked when the claim
 * resolves: a newer install owns its own degraded-open flag.
 */

function docWithHash(): Doc {
  const doc = createDoc()
  doc.media = [
    createMediaAsset({
      id: 'media_1',
      kind: 'video',
      name: 'clip.mp4',
      contentHash: 'a'.repeat(64),
    }),
  ]
  return doc
}

let opfs: FakeOpfs

/**
 * The claim write is mocked here, so the coverage setup is the claims
 * directory plus the stored copy of the hash doc A references.
 */
async function storeCoveredHash(doc: Doc): Promise<void> {
  await ensureProjectMedia(doc.project.id)
  opfs.put(`/${doc.project.id}/${'a'.repeat(64)}`, 'stored bytes')
}

beforeEach(() => {
  opfs = createFakeOpfs()
  vi.stubGlobal('navigator', {
    storage: { getDirectory: async () => opfs.root },
  })
})

afterEach(() => {
  claimState.started = false
  claimState.resolve = null
  vi.unstubAllGlobals()
  useEditorStore.setState({ mediaCleanBlockReason: null })
})

describe('save claim and project identity', () => {
  it('does not unblock clean for a project installed while the save claims', async () => {
    vi.stubGlobal('document', {
      createElement: () => ({ click: () => undefined, href: '', download: '' }),
    })
    const docA = docWithHash()
    await storeCoveredHash(docA)
    useEditorStore.setState({ doc: docA, projectEpoch: 5, mediaCleanBlockReason: 'unclaimed' })
    const pending = downloadProjectJSON()
    await vi.waitFor(() => expect(claimState.started).toBe(true))

    // A newer, degraded open installs while A's claim is still in flight.
    installProject(createDoc())
    useEditorStore.getState().setMediaCleanBlockReason('unclaimed')

    claimState.resolve?.(true)
    await pending
    expect(useEditorStore.getState().mediaCleanBlockReason).toBe('unclaimed')
  })

  it('unblocks clean when the same project is still live', async () => {
    vi.stubGlobal('document', {
      createElement: () => ({ click: () => undefined, href: '', download: '' }),
    })
    const doc = docWithHash()
    await storeCoveredHash(doc)
    useEditorStore.setState({ doc, projectEpoch: 9, mediaCleanBlockReason: 'unclaimed' })
    const pending = downloadProjectJSON()
    await vi.waitFor(() => expect(claimState.started).toBe(true))
    claimState.resolve?.(true)
    await pending
    expect(useEditorStore.getState().mediaCleanBlockReason).toBeNull()
  })
})
