// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const toastMock = vi.hoisted(() => vi.fn())
vi.mock('@/hooks/use-toast', () => ({ toast: toastMock }))

const listUnusedMock = vi.hoisted(() => vi.fn())
const cleanMock = vi.hoisted(() => vi.fn())
const clearMock = vi.hoisted(() => vi.fn())
const supportedMock = vi.hoisted(() => vi.fn())
const persistMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/editor/media/persist', () => ({
  listUnusedMedia: listUnusedMock,
  cleanUnusedMedia: cleanMock,
  clearAllProjectMedia: clearMock,
}))
vi.mock('@/lib/editor/media/media-store', () => ({
  isMediaStoreSupported: supportedMock,
  projectMediaUsage: async () => 2048,
  estimateMediaStore: async () => ({ usage: 2048, quota: 1_000_000_000 }),
  isStoragePersistent: async () => false,
  requestPersistentStorage: persistMock,
}))
vi.mock('@/lib/editor/project-io', () => ({ currentProjectLock: () => ({}) }))
vi.mock('@/lib/editor/persistence', () => ({ readAutosave: () => null }))

import { StorageDialog } from '@/components/editor/StorageDialog'
import { createDoc, createMediaAsset } from '../factories'
import { useEditorStore } from '../store'

beforeEach(() => {
  useEditorStore.setState({ doc: createDoc(), mediaCleanBlocked: false })
  supportedMock.mockReturnValue(true)
  listUnusedMock.mockResolvedValue({
    candidates: [{ hash: 'a'.repeat(64), size: 2_000_000 }],
    reclaimed: 2_000_000,
    blocked: false,
  })
  cleanMock.mockResolvedValue({ status: 'ran', report: { deleted: ['h'], reclaimed: 2_000_000 } })
  clearMock.mockResolvedValue({ status: 'ran', result: { deleted: 2, reclaimed: 4_000_000 } })
  persistMock.mockResolvedValue(true)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderDialog() {
  render(<StorageDialog open onOpenChange={() => {}} />)
}

describe('StorageDialog', () => {
  it('explains an unsupported media store', async () => {
    supportedMock.mockReturnValue(false)
    renderDialog()
    expect(await screen.findByText(/cannot store media/i)).toBeInTheDocument()
    expect(screen.queryByTestId('storage-clean')).not.toBeInTheDocument()
  })

  it('lists the usage and requires a confirmation before cleaning', async () => {
    renderDialog()
    await waitFor(() => expect(screen.getByTestId('storage-usage')).toHaveTextContent('2.0 KB'))
    expect(cleanMock).not.toHaveBeenCalled()
    expect(screen.getByTestId('storage-clean')).toHaveTextContent('Clean Unused Media')

    fireEvent.click(screen.getByTestId('storage-clean'))
    fireEvent.click(screen.getByTestId('storage-clean-confirm'))

    await waitFor(() => expect(cleanMock).toHaveBeenCalledTimes(1))
    const input = cleanMock.mock.calls[0][0]
    expect(input.projectId).toBe(useEditorStore.getState().doc.project.id)
    expect(typeof input.referenced).toBe('function')
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'Reclaimed 2.0 MB' }))
  })

  it('drops a stale refresh that resolves after a newer one', async () => {
    const view = render(<StorageDialog open onOpenChange={() => {}} />)
    await waitFor(() => expect(screen.getByTestId('storage-clean')).toBeEnabled())

    // Hold the next listing read; reopening starts a newer pass for the same
    // project, so only the request token (not the project id) can tell the
    // stale pass to stay silent.
    let release!: (listing: {
      candidates: { hash: string; size: number }[]
      reclaimed: number
      blocked: boolean
    }) => void
    listUnusedMock.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve
      }),
    )
    view.rerender(<StorageDialog open={false} onOpenChange={() => {}} />)
    view.rerender(<StorageDialog open onOpenChange={() => {}} />)
    await waitFor(() => expect(listUnusedMock.mock.calls.length).toBeGreaterThanOrEqual(2))

    // A second reopen starts a newer pass for the same project before the
    // held read lands.
    view.rerender(<StorageDialog open={false} onOpenChange={() => {}} />)
    view.rerender(<StorageDialog open onOpenChange={() => {}} />)
    await waitFor(() =>
      expect(screen.getByTestId('storage-dialog').textContent).toContain('2.0 MB'),
    )

    release({
      candidates: [{ hash: 'b'.repeat(64), size: 999_999 }],
      reclaimed: 999_999,
      blocked: false,
    })

    // The newer pass already published the fresh 2.0 MB figure; the stale
    // 1000.0 KB payload must never replace it.
    await waitFor(() =>
      expect(screen.getByTestId('storage-dialog').textContent).toContain('2.0 MB'),
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.getByTestId('storage-dialog').textContent).not.toContain('1000.0 KB')
  })

  it('drops a stale refresh when the project changes mid-read', async () => {
    renderDialog()
    await waitFor(() => expect(screen.getByTestId('storage-clean')).toBeEnabled())

    // Hold the listing read so the project can change underneath it.
    let release!: (listing: {
      candidates: { hash: string; size: number }[]
      reclaimed: number
      blocked: boolean
    }) => void
    listUnusedMock.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve
      }),
    )
    act(() => useEditorStore.setState({ doc: createDoc() }))
    await waitFor(() => expect(listUnusedMock).toHaveBeenCalled())

    // The project moves on again before the stale read lands.
    act(() => useEditorStore.setState({ doc: createDoc() }))
    release({
      candidates: [{ hash: 'b'.repeat(64), size: 999_999 }],
      reclaimed: 999_999,
      blocked: false,
    })

    // The newer pass already published the fresh 2.0 MB figure; the stale
    // 1000.0 KB payload must never replace it.
    await waitFor(() =>
      expect(screen.getByTestId('storage-dialog').textContent).toContain('2.0 MB'),
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.getByTestId('storage-dialog').textContent).not.toContain('1000.0 KB')
  })

  it('reports a refusal without deleting and keeps the dialog usable', async () => {
    cleanMock.mockResolvedValue({ status: 'claims' })
    renderDialog()
    await waitFor(() => expect(screen.getByTestId('storage-clean')).toBeEnabled())
    fireEvent.click(screen.getByTestId('storage-clean'))
    fireEvent.click(screen.getByTestId('storage-clean-confirm'))
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Clean Unused Media is unavailable',
          description: expect.stringContaining('saved-copy records'),
          variant: 'destructive',
        }),
      ),
    )
  })

  it('disables cleaning when the project opened without a claim', async () => {
    useEditorStore.setState({ mediaCleanBlocked: true })
    renderDialog()
    await waitFor(() => expect(screen.getByTestId('storage-clean')).toBeDisabled())
    expect(screen.getByTestId('storage-dialog')).toHaveTextContent(/without a saved-copy record/i)
  })

  it('requires a second confirmation before clearing all media', async () => {
    renderDialog()
    await waitFor(() => expect(screen.getByTestId('storage-clear')).toBeEnabled())
    fireEvent.click(screen.getByTestId('storage-clear'))
    expect(clearMock).not.toHaveBeenCalled()
    expect(screen.getByTestId('storage-dialog')).toHaveTextContent(
      /every saved copy of this project/i,
    )
    fireEvent.click(screen.getByTestId('storage-clear-confirm'))
    await waitFor(() => expect(clearMock).toHaveBeenCalledTimes(1))
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'Cleared 4.0 MB' }))
  })

  it('drops a clear confirmation when the project changes', async () => {
    renderDialog()
    await waitFor(() => expect(screen.getByTestId('storage-clear')).toBeEnabled())
    fireEvent.click(screen.getByTestId('storage-clear'))
    expect(screen.getByTestId('storage-clear-confirm')).toBeInTheDocument()

    act(() => useEditorStore.setState({ doc: createDoc() }))

    await waitFor(() =>
      expect(screen.queryByTestId('storage-clear-confirm')).not.toBeInTheDocument(),
    )
    fireEvent.click(screen.getByTestId('storage-clear'))
    expect(clearMock).not.toHaveBeenCalled()
  })

  it('reads references from the live store when the clean runs', async () => {
    const doc = createDoc()
    doc.media = [createMediaAsset({ kind: 'video', name: 'a.mp4', contentHash: 'a'.repeat(64) })]
    useEditorStore.setState({ doc, past: [], future: [] })
    renderDialog()
    await waitFor(() => expect(screen.getByTestId('storage-clean')).toBeEnabled())
    fireEvent.click(screen.getByTestId('storage-clean'))
    fireEvent.click(screen.getByTestId('storage-clean-confirm'))
    await waitFor(() => expect(cleanMock).toHaveBeenCalledTimes(1))

    const referenced = cleanMock.mock.calls[0][0].referenced as () => ReadonlySet<string>
    const later = createMediaAsset({ kind: 'video', name: 'b.mp4', contentHash: 'b'.repeat(64) })
    act(() => useEditorStore.setState({ doc: { ...doc, media: [...doc.media, later] } }))

    expect(referenced().has('b'.repeat(64))).toBe(true)
  })

  it('returns to ready when a clean rejects', async () => {
    cleanMock.mockRejectedValueOnce(new Error('storage read failed'))
    renderDialog()
    await waitFor(() => expect(screen.getByTestId('storage-clean')).toBeEnabled())
    fireEvent.click(screen.getByTestId('storage-clean'))
    fireEvent.click(screen.getByTestId('storage-clean-confirm'))
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Clean Unused Media failed',
          description: 'storage read failed',
          variant: 'destructive',
        }),
      ),
    )
    await waitFor(() => expect(screen.getByTestId('storage-clean')).toBeEnabled())
  })

  it('returns to ready when clear-all rejects', async () => {
    clearMock.mockRejectedValueOnce(new Error('the store is unavailable'))
    renderDialog()
    await waitFor(() => expect(screen.getByTestId('storage-clear')).toBeEnabled())
    fireEvent.click(screen.getByTestId('storage-clear'))
    fireEvent.click(screen.getByTestId('storage-clear-confirm'))
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Clear All Stored Media failed',
          variant: 'destructive',
        }),
      ),
    )
    await waitFor(() => expect(screen.getByTestId('storage-clear')).toBeEnabled())
  })

  it('drops an armed confirmation when the dialog closes and reopens', async () => {
    const view = render(<StorageDialog open onOpenChange={() => {}} />)
    await waitFor(() => expect(screen.getByTestId('storage-clear')).toBeEnabled())
    fireEvent.click(screen.getByTestId('storage-clear'))
    expect(screen.getByTestId('storage-clear-confirm')).toBeInTheDocument()

    view.rerender(<StorageDialog open={false} onOpenChange={() => {}} />)
    view.rerender(<StorageDialog open onOpenChange={() => {}} />)

    await waitFor(() =>
      expect(screen.queryByTestId('storage-clear-confirm')).not.toBeInTheDocument(),
    )
    expect(screen.getByTestId('storage-clear')).toHaveTextContent('Clear All Stored Media')
  })

  it('reports a clear refusal while another tab has the project open', async () => {
    clearMock.mockResolvedValueOnce({ status: 'busy' })
    renderDialog()
    await waitFor(() => expect(screen.getByTestId('storage-clear')).toBeEnabled())
    fireEvent.click(screen.getByTestId('storage-clear'))
    fireEvent.click(screen.getByTestId('storage-clear-confirm'))

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Clear All Stored Media is unavailable',
          description: expect.stringContaining('Another tab'),
          variant: 'destructive',
        }),
      ),
    )
    expect(toastMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringContaining('Cleared') }),
    )
    await waitFor(() => expect(screen.getByTestId('storage-clear')).toBeEnabled())
  })

  it('asks the browser to keep the storage', async () => {
    renderDialog()
    await waitFor(() => expect(screen.getByTestId('storage-persist')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('storage-persist'))
    await waitFor(() => expect(persistMock).toHaveBeenCalledTimes(1))
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Storage will be kept' }),
    )
  })
})
