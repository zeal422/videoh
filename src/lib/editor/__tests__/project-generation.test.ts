import { afterEach, describe, expect, it, vi } from 'vitest'

const claimState = vi.hoisted(() => ({
  started: false,
  resolve: null as null | ((claimed: boolean) => void),
}))

vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }))
vi.mock('../media/persist', () => ({
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
}))

import { downloadProjectJSON, installProject } from '../project-io'
import { createDoc, createMediaAsset } from '../factories'
import { useEditorStore } from '../store'
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

afterEach(() => {
  claimState.started = false
  claimState.resolve = null
  vi.unstubAllGlobals()
  useEditorStore.setState({ mediaCleanBlocked: false })
})

describe('save claim and project identity', () => {
  it('does not unblock clean for a project installed while the save claims', async () => {
    vi.stubGlobal('document', {
      createElement: () => ({ click: () => undefined, href: '', download: '' }),
    })
    const docA = docWithHash()
    useEditorStore.setState({ doc: docA, projectEpoch: 5, mediaCleanBlocked: true })
    const pending = downloadProjectJSON()
    await vi.waitFor(() => expect(claimState.started).toBe(true))

    // A newer, degraded open installs while A's claim is still in flight.
    installProject(createDoc())
    useEditorStore.getState().setMediaCleanBlocked(true)

    claimState.resolve?.(true)
    await pending
    expect(useEditorStore.getState().mediaCleanBlocked).toBe(true)
  })

  it('unblocks clean when the same project is still live', async () => {
    vi.stubGlobal('document', {
      createElement: () => ({ click: () => undefined, href: '', download: '' }),
    })
    useEditorStore.setState({ doc: docWithHash(), projectEpoch: 9, mediaCleanBlocked: true })
    const pending = downloadProjectJSON()
    await vi.waitFor(() => expect(claimState.started).toBe(true))
    claimState.resolve?.(true)
    await pending
    expect(useEditorStore.getState().mediaCleanBlocked).toBe(false)
  })
})
