// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { ExportDialog } from '@/components/editor/ExportDialog'
import { installBrowserMocks, type MockHarness } from './mocks/browser-mocks'
import { useEditorStore } from '../store'
import { createClip, createDoc, createMediaAsset, createTrack } from '../factories'

const mocks = vi.hoisted(() => ({
  exportTimeline: vi.fn(),
  downloadBlob: vi.fn(),
  codecs: { aac: false, mp3: false },
  audioSupported: true,
  offlineAll: false,
  offlineAudio: [] as string[],
}))

vi.mock('../export/mp4', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../export/mp4')>()
  return {
    ...actual,
    webCodecsSupported: () => true,
    audioCodecSupported: () => mocks.audioSupported,
    probeExportCodecs: async () => mocks.codecs,
    hasAudibleMix: () => true,
    exportTimeline: mocks.exportTimeline,
    downloadBlob: mocks.downloadBlob,
  }
})

vi.mock('../offline', () => ({
  hasOfflineMedia: () => mocks.offlineAll,
  offlineAudibleMedia: () => mocks.offlineAudio,
}))

function doc() {
  const asset = createMediaAsset({
    id: 'ma',
    kind: 'audio',
    name: 'voice.wav',
    duration: 4,
    url: 'blob:x',
  })
  const clip = createClip({ id: 'ca', mediaId: 'ma', audioOnly: true, start: 0, duration: 4 })
  const next = createDoc()
  next.project.tracks = [createTrack('audio', 1, { clips: [clip] })]
  next.media = [asset]
  return next
}

let h: MockHarness

beforeEach(() => {
  h = installBrowserMocks()
  // Radix Select queries pointer capture and scrollIntoView; jsdom has neither.
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.setPointerCapture = () => undefined
  Element.prototype.releasePointerCapture = () => undefined
  Element.prototype.scrollIntoView = () => undefined
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }))
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:result'),
  })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
  useEditorStore.setState({ doc: doc(), phase: 'idle' } as never)
  mocks.codecs = { aac: false, mp3: false }
  mocks.audioSupported = true
  mocks.offlineAll = false
  mocks.offlineAudio = []
  mocks.exportTimeline.mockReset()
  mocks.downloadBlob.mockReset()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  h.uninstall()
})

async function openFormatMenu() {
  const user = userEvent.setup()
  await user.click(screen.getByLabelText('Export format'))
  return user
}

describe('export dialog containers (0.21.0)', () => {
  it('offers every container and disables MP3 and M4A without their encoders', async () => {
    render(<ExportDialog open onOpenChange={() => {}} />)
    const user = await openFormatMenu()
    expect(screen.getByRole('option', { name: 'MP4 video' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    )
    expect(screen.getByRole('option', { name: 'MOV video' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    )
    expect(screen.getByRole('option', { name: 'MKV video' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    )
    expect(screen.getByRole('option', { name: 'WAV audio' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    )
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'MP3 audio' })).toHaveAttribute(
        'aria-disabled',
        'true',
      ),
    )
    expect(screen.getByRole('option', { name: 'M4A audio' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    await user.keyboard('{Escape}')
  })

  it('enables MP3 and M4A when both encoder probes pass', async () => {
    mocks.codecs = { aac: true, mp3: true }
    render(<ExportDialog open onOpenChange={() => {}} />)
    const user = await openFormatMenu()
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'MP3 audio' })).not.toHaveAttribute(
        'aria-disabled',
        'true',
      ),
    )
    expect(screen.getByRole('option', { name: 'M4A audio' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    )
    await user.keyboard('{Escape}')
  })

  it('shows the MOV audio compatibility note when MOV is selected', async () => {
    render(<ExportDialog open onOpenChange={() => {}} />)
    const user = await openFormatMenu()
    await user.click(screen.getByRole('option', { name: 'MOV video' }))
    expect(
      screen.getByText(/strict QuickTime players may not read the Opus fallback/),
    ).toBeInTheDocument()
  })

  it('keeps WAV enabled without AudioEncoder while disabling MP3 and M4A', async () => {
    mocks.audioSupported = false
    render(<ExportDialog open onOpenChange={() => {}} />)
    const user = await openFormatMenu()
    expect(screen.getByRole('option', { name: 'WAV audio' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    )
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'MP3 audio' })).toHaveAttribute(
        'aria-disabled',
        'true',
      ),
    )
    expect(screen.getByRole('option', { name: 'M4A audio' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    await user.keyboard('{Escape}')
  })
})

describe('export dialog offline gate (0.21.0)', () => {
  it('allows WAV when only non-audio media is offline', async () => {
    mocks.offlineAll = true
    mocks.offlineAudio = []
    render(<ExportDialog open onOpenChange={() => {}} />)
    const user = await openFormatMenu()
    await user.click(screen.getByRole('option', { name: 'WAV audio' }))
    expect(screen.getByRole('button', { name: 'Start export' })).not.toBeDisabled()
    expect(screen.queryByTestId('export-offline-warning')).not.toBeInTheDocument()
  })

  it('blocks WAV and names the offline audio file', async () => {
    mocks.offlineAudio = ['missing.mp3']
    render(<ExportDialog open onOpenChange={() => {}} />)
    const user = await openFormatMenu()
    await user.click(screen.getByRole('option', { name: 'WAV audio' }))
    expect(screen.getByRole('button', { name: 'Start export' })).toBeDisabled()
    expect(screen.getByTestId('export-offline-warning')).toHaveTextContent('missing.mp3')
  })

  it('keeps the document-wide offline check for video export', () => {
    mocks.offlineAll = true
    mocks.offlineAudio = []
    render(<ExportDialog open onOpenChange={() => {}} />)
    expect(screen.getByRole('button', { name: 'Start export' })).toBeDisabled()
    expect(screen.getByTestId('export-offline-warning')).toBeInTheDocument()
  })
})

describe('export dialog validation and start (0.21.0)', () => {
  it('requires both output dimensions and a positive bitrate', async () => {
    render(<ExportDialog open onOpenChange={() => {}} />)
    const start = screen.getByRole('button', { name: 'Start export' })
    expect(start).not.toBeDisabled()

    fireEvent.change(screen.getByLabelText('Output width (px)'), { target: { value: '1280' } })
    expect(screen.getByTestId('export-size-error')).toBeInTheDocument()
    expect(start).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Output height (px)'), { target: { value: '720' } })
    expect(screen.queryByTestId('export-size-error')).not.toBeInTheDocument()
    expect(start).not.toBeDisabled()

    fireEvent.change(screen.getByLabelText('Video bitrate (Mbps, optional)'), {
      target: { value: '-1' },
    })
    expect(screen.getByTestId('export-bitrate-error')).toBeInTheDocument()
    expect(start).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Video bitrate (Mbps, optional)'), {
      target: { value: '8' },
    })
    expect(screen.queryByTestId('export-bitrate-error')).not.toBeInTheDocument()
    expect(start).not.toBeDisabled()
  })

  it('passes the container, size and bitrate to the exporter', async () => {
    mocks.exportTimeline.mockResolvedValue({
      kind: 'blob',
      blob: new Blob(['x'], { type: 'video/mp4' }),
      mimeType: 'video/mp4',
      duration: 4,
    })
    render(<ExportDialog open onOpenChange={() => {}} />)
    fireEvent.change(screen.getByLabelText('Output width (px)'), { target: { value: '1280' } })
    fireEvent.change(screen.getByLabelText('Output height (px)'), { target: { value: '720' } })
    fireEvent.change(screen.getByLabelText('Video bitrate (Mbps, optional)'), {
      target: { value: '8' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Start export' }))
    await waitFor(() => expect(mocks.exportTimeline).toHaveBeenCalledTimes(1))
    const [, options] = mocks.exportTimeline.mock.calls[0] as [unknown, Record<string, unknown>]
    expect(options).toMatchObject({
      container: 'mp4',
      width: 1280,
      height: 720,
      videoBitrate: 8_000_000,
      quality: 'medium',
    })
    expect(await screen.findByTestId('export-result-video')).toBeInTheDocument()
  })

  it('renders an audio player for an audio-only result', async () => {
    mocks.exportTimeline.mockResolvedValue({
      kind: 'blob',
      blob: new Blob(['x'], { type: 'audio/wav' }),
      mimeType: 'audio/wav',
      duration: 4,
    })
    render(<ExportDialog open onOpenChange={() => {}} />)
    const user = await openFormatMenu()
    await user.click(screen.getByRole('option', { name: 'WAV audio' }))
    fireEvent.click(screen.getByRole('button', { name: 'Start export' }))
    await waitFor(() => expect(mocks.exportTimeline).toHaveBeenCalledTimes(1))
    const [, options] = mocks.exportTimeline.mock.calls[0] as [unknown, Record<string, unknown>]
    expect(options.container).toBe('wav')
    expect(options.width).toBeUndefined()
    expect(options.height).toBeUndefined()
    expect(await screen.findByTestId('export-result-audio')).toBeInTheDocument()
  })

  it('keeps the invoked container when the format changes while createWritable is pending', async () => {
    let resolveWritable!: (sink: {
      write: () => Promise<void>
      close: () => Promise<void>
      abort: () => Promise<void>
    }) => void
    const writable = new Promise<{
      write: () => Promise<void>
      close: () => Promise<void>
      abort: () => Promise<void>
    }>((resolve) => {
      resolveWritable = resolve
    })
    const picker = vi.fn(async () => ({
      name: 'movie.mp4',
      createWritable: () => writable,
    }))
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: picker,
    })
    mocks.exportTimeline.mockResolvedValue({
      kind: 'blob',
      blob: new Blob(['x'], { type: 'video/mp4' }),
      mimeType: 'video/mp4',
      duration: 4,
    })
    render(<ExportDialog open onOpenChange={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /Export to file/ }))
    await waitFor(() => expect(picker).toHaveBeenCalled())

    // The dialog stays in setup while createWritable() is pending, so the
    // format selector is still live. Switching it must not rewrite the result.
    const user = await openFormatMenu()
    await user.click(screen.getByRole('option', { name: 'WAV audio' }))
    resolveWritable({ write: async () => {}, close: async () => {}, abort: async () => {} })

    await waitFor(() => expect(mocks.exportTimeline).toHaveBeenCalledTimes(1))
    const [, options] = mocks.exportTimeline.mock.calls[0] as [unknown, Record<string, unknown>]
    expect(options.container).toBe('mp4')
    expect(await screen.findByTestId('export-result-video')).toBeInTheDocument()
    expect(screen.queryByTestId('export-result-audio')).not.toBeInTheDocument()
    expect(screen.getByText(/· MP4$/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Download/ }))
    expect(mocks.downloadBlob).toHaveBeenCalledWith(
      expect.any(Blob),
      expect.stringMatching(/\.mp4$/),
    )
  })
})
