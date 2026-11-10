// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const toastMock = vi.hoisted(() => vi.fn())
const io = vi.hoisted(() => ({
  openProjectFromPicker: vi.fn(),
  pickFiles: vi.fn(),
  importMediaFiles: vi.fn(),
}))

vi.mock('@/hooks/use-toast', () => ({ toast: toastMock }))
vi.mock('@/lib/editor/project-io', () => ({
  downloadProjectJSON: vi.fn(),
  importMediaFiles: io.importMediaFiles,
  installProject: vi.fn(),
  openProjectFromPicker: io.openProjectFromPicker,
  pickFiles: io.pickFiles,
}))

import { createActionContext } from '@/hooks/editor/action-context'

/**
 * The browser-bound action context owns File > Open and File > Import. A
 * rejected picker or import must surface a destructive toast instead of
 * becoming an unhandled rejection.
 */
describe('action-context picker failures', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reports an open-project picker rejection', async () => {
    io.openProjectFromPicker.mockRejectedValueOnce(new Error('picker exploded'))
    createActionContext().openProject()
    await vi.waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith({
        title: 'Open project failed',
        description: 'picker exploded',
        variant: 'destructive',
      }),
    )
  })

  it('reports failures from the full import chain', async () => {
    io.pickFiles.mockRejectedValueOnce(new Error('picker exploded'))
    createActionContext().importMedia()
    await vi.waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith({
        title: 'Import media failed',
        description: 'picker exploded',
        variant: 'destructive',
      }),
    )

    toastMock.mockClear()
    io.pickFiles.mockResolvedValueOnce([new File(['x'], 'a.mp4')])
    io.importMediaFiles.mockRejectedValueOnce(new Error('import exploded'))
    createActionContext().importMedia()
    await vi.waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith({
        title: 'Import media failed',
        description: 'import exploded',
        variant: 'destructive',
      }),
    )
  })
})
