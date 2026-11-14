// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { fireEvent } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }))

const recorderMock = vi.hoisted(() => ({ readRecordingDuration: vi.fn() }))
vi.mock('@/lib/editor/media/recorder', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/editor/media/recorder')>()
  return { ...actual, readRecordingDuration: recorderMock.readRecordingDuration }
})

const projectIoMock = vi.hoisted(() => ({ importRecordedFile: vi.fn() }))
vi.mock('@/lib/editor/project-io', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/editor/project-io')>()
  return { ...actual, importRecordedFile: projectIoMock.importRecordedFile }
})

import { RecordingDialog } from '@/components/editor/RecordingDialog'
import { RECORDING_MAX_BYTES, RECORDING_SOFT_MAX_BYTES } from '@/lib/editor/constants'
import { createDoc, createMediaAsset } from '@/lib/editor/factories'
import { useEditorStore } from '@/lib/editor/store'
import { toast } from '@/hooks/use-toast'

class FakeTrack {
  stop = vi.fn()
  readyState: 'live' | 'ended' = 'live'
  private ended = new Set<() => void>()
  constructor(readonly kind: 'audio' | 'video') {}
  addEventListener(event: string, listener: () => void): void {
    if (event === 'ended') this.ended.add(listener)
  }
  emitEnded(): void {
    for (const listener of this.ended) listener()
  }
}

function fakeStream(): { stream: MediaStream; tracks: FakeTrack[] } {
  const tracks = [new FakeTrack('audio')]
  const stream = {
    getTracks: () => tracks,
    getAudioTracks: () => tracks,
    getVideoTracks: () => [],
  } as unknown as MediaStream
  return { stream, tracks }
}

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = []
  static isTypeSupported = (type: string) => type.includes('webm')
  static failStart = false
  static neverStop = false
  state: 'inactive' | 'recording' = 'inactive'
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(
    readonly stream: MediaStream,
    readonly options: MediaRecorderOptions,
  ) {
    FakeMediaRecorder.instances.push(this)
  }
  start(): void {
    if (FakeMediaRecorder.failStart) throw new Error('media recorder start failed')
    this.state = 'recording'
  }
  stop(): void {
    if (this.state === 'inactive') return
    this.state = 'inactive'
    if (FakeMediaRecorder.neverStop) return
    this.onstop?.()
  }
  emit(blob: Blob): void {
    this.ondataavailable?.({ data: blob })
  }
}

function installBrowser(stream: MediaStream, devices: MediaDeviceInfo[] = []): void {
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: vi.fn(async () => stream),
      getDisplayMedia: vi.fn(async () => stream),
      enumerateDevices: vi.fn(async () => devices),
    },
  })
}

beforeEach(() => {
  FakeMediaRecorder.instances = []
  FakeMediaRecorder.failStart = false
  FakeMediaRecorder.neverStop = false
  // Radix Select queries pointer capture and scrollIntoView; jsdom has neither.
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.setPointerCapture = () => undefined
  Element.prototype.releasePointerCapture = () => undefined
  Element.prototype.scrollIntoView = () => undefined
  recorderMock.readRecordingDuration.mockReset()
  projectIoMock.importRecordedFile.mockReset()
  vi.mocked(toast).mockClear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('recording dialog (0.27.0)', () => {
  it('disables start with a clear reason when the browser cannot record', async () => {
    vi.stubGlobal('MediaRecorder', undefined)
    render(<RecordingDialog open kind="voiceover" onOpenChange={() => {}} />)
    expect(await screen.findByTestId('recording-unsupported')).toHaveTextContent(
      /cannot record voiceover/i,
    )
    expect(screen.getByTestId('recording-start')).toBeDisabled()
  })

  it('disables the microphone source when getUserMedia is unavailable', async () => {
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getDisplayMedia: vi.fn(async () => fakeStream().stream),
        enumerateDevices: vi.fn(async () => []),
      },
    })
    render(<RecordingDialog open kind="screen" onOpenChange={() => {}} />)
    expect(await screen.findByText(/cannot record microphone audio/i)).toBeInTheDocument()
    fireEvent.pointerDown(screen.getByLabelText('Screen audio source'), {
      button: 0,
      ctrlKey: false,
      pointerType: 'mouse',
    })
    const option = await screen.findByRole('option', { name: /Microphone \(unavailable\)/ })
    expect(option).toHaveAttribute('aria-disabled', 'true')
  })

  it('releases the stream and re-enables Start when recorder.start throws', async () => {
    const { stream, tracks } = fakeStream()
    installBrowser(stream)
    FakeMediaRecorder.failStart = true
    try {
      render(<RecordingDialog open kind="voiceover" onOpenChange={() => {}} />)
      fireEvent.click(await screen.findByTestId('recording-start'))
      expect(await screen.findByTestId('recording-error')).toHaveTextContent(/start failed/)
      await waitFor(() =>
        expect(tracks.every((track) => track.stop.mock.calls.length === 1)).toBe(true),
      )
      expect(screen.getByTestId('recording-start')).toBeEnabled()
    } finally {
      FakeMediaRecorder.failStart = false
    }
  })

  it('starts the take and releases every track on unmount', async () => {
    const { stream, tracks } = fakeStream()
    installBrowser(stream)
    const onOpenChange = vi.fn()
    const { unmount } = render(
      <RecordingDialog open kind="voiceover" onOpenChange={onOpenChange} />,
    )
    fireEvent.click(await screen.findByTestId('recording-start'))
    await screen.findByTestId('recording-progress')
    expect(FakeMediaRecorder.instances).toHaveLength(1)
    expect(FakeMediaRecorder.instances[0].options.videoBitsPerSecond).toBe(6_000_000)

    unmount()
    await waitFor(() =>
      expect(tracks.every((track) => track.stop.mock.calls.length === 1)).toBe(true),
    )
  })

  it('ignores a default device entry with an empty id', async () => {
    const { stream } = fakeStream()
    installBrowser(stream, [
      { deviceId: '', groupId: '', kind: 'audioinput', label: '', toJSON: () => ({}) },
    ] as MediaDeviceInfo[])
    render(<RecordingDialog open kind="voiceover" onOpenChange={() => {}} />)
    expect(await screen.findByText('Record voiceover')).toBeInTheDocument()
    expect(screen.getByTestId('recording-start')).toBeEnabled()
  })

  it('discards a stream that arrives after the dialog closes', async () => {
    const { stream, tracks } = fakeStream()
    let resolveMedia: (value: MediaStream) => void = () => {}
    const pending = new Promise<MediaStream>((resolve) => {
      resolveMedia = resolve
    })
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn(() => pending),
        getDisplayMedia: vi.fn(() => pending),
        enumerateDevices: vi.fn(async () => []),
      },
    })
    const { unmount } = render(<RecordingDialog open kind="voiceover" onOpenChange={() => {}} />)
    fireEvent.click(await screen.findByTestId('recording-start'))
    unmount()
    resolveMedia(stream)
    await waitFor(() =>
      expect(tracks.every((track) => track.stop.mock.calls.length === 1)).toBe(true),
    )
    // No recorder was ever constructed for the closed dialog.
    expect(FakeMediaRecorder.instances).toHaveLength(0)
  })

  it('disables start when the browser supports no recording MIME type', async () => {
    const original = FakeMediaRecorder.isTypeSupported
    FakeMediaRecorder.isTypeSupported = () => false
    try {
      installBrowser(fakeStream().stream)
      render(<RecordingDialog open kind="voiceover" onOpenChange={() => {}} />)
      expect(await screen.findByTestId('recording-unsupported')).toBeInTheDocument()
      expect(screen.getByTestId('recording-start')).toBeDisabled()
    } finally {
      FakeMediaRecorder.isTypeSupported = original
    }
  })

  it('discards a take when the project is replaced while saving', async () => {
    const { stream } = fakeStream()
    installBrowser(stream)
    let releaseDuration: (value: number | null) => void = () => {}
    recorderMock.readRecordingDuration.mockReturnValue(
      new Promise<number | null>((resolve) => {
        releaseDuration = resolve
      }),
    )
    render(<RecordingDialog open kind="voiceover" onOpenChange={() => {}} />)
    fireEvent.click(await screen.findByTestId('recording-start'))
    await screen.findByTestId('recording-progress')
    FakeMediaRecorder.instances[0].emit(new Blob(['take']))
    fireEvent.click(screen.getByTestId('recording-stop'))
    await waitFor(() => expect(recorderMock.readRecordingDuration).toHaveBeenCalled())
    // The take belongs to the project it started in. Replacing that project
    // while the duration is read must not import into the new one.
    useEditorStore.getState().replaceDoc(createDoc())
    releaseDuration(4)
    await waitFor(() => expect(screen.queryByTestId('recording-progress')).not.toBeInTheDocument())
    expect(projectIoMock.importRecordedFile).not.toHaveBeenCalled()
  })

  it('re-enables Start after a denied permission request', async () => {
    const getUserMedia = vi.fn(async () => {
      throw new Error('NotAllowedError')
    })
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia,
        getDisplayMedia: vi.fn(),
        enumerateDevices: vi.fn(async () => []),
      },
    })
    render(<RecordingDialog open kind="voiceover" onOpenChange={() => {}} />)
    fireEvent.click(await screen.findByTestId('recording-start'))
    expect(await screen.findByTestId('recording-error')).toHaveTextContent('NotAllowedError')
    // The failed start must leave the dialog usable without a close and reopen.
    expect(screen.getByTestId('recording-start')).toBeEnabled()
  })

  it('imports a completed take with the verified duration', async () => {
    const { stream } = fakeStream()
    installBrowser(stream)
    recorderMock.readRecordingDuration.mockResolvedValue(12.5)
    projectIoMock.importRecordedFile.mockResolvedValue(
      createMediaAsset({
        id: 'take',
        kind: 'audio',
        name: 'Voiceover take.webm',
        duration: 12.5,
      }),
    )
    render(<RecordingDialog open kind="voiceover" onOpenChange={() => {}} />)
    // Placement needs a track; this test covers the import payload.
    fireEvent.click(await screen.findByLabelText('Place voiceover at the playhead'))
    fireEvent.click(screen.getByTestId('recording-start'))
    await screen.findByTestId('recording-progress')
    FakeMediaRecorder.instances[0].emit(new Blob(['take']))
    fireEvent.click(screen.getByTestId('recording-stop'))
    await waitFor(() => expect(projectIoMock.importRecordedFile).toHaveBeenCalled())
    const [file, duration] = projectIoMock.importRecordedFile.mock.calls[0]
    expect(file).toBeInstanceOf(File)
    expect(await file.text()).toBe('take')
    expect(duration).toBe(12.5)
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Recording added' })),
    )
  })

  it('imports a take at its measured length when the container has no duration', async () => {
    const { stream } = fakeStream()
    installBrowser(stream)
    // Firefox audio-only WebM reports no duration and cannot be seeked, so the
    // take's own clock is the only length available.
    recorderMock.readRecordingDuration.mockResolvedValue(null)
    projectIoMock.importRecordedFile.mockResolvedValue(
      createMediaAsset({ id: 'take', kind: 'audio', name: 'Voiceover take.webm', duration: 1 }),
    )
    render(<RecordingDialog open kind="voiceover" onOpenChange={() => {}} />)
    fireEvent.click(await screen.findByLabelText('Place voiceover at the playhead'))
    fireEvent.click(screen.getByTestId('recording-start'))
    await screen.findByTestId('recording-progress')
    FakeMediaRecorder.instances[0].emit(new Blob(['take']))
    await new Promise((resolve) => setTimeout(resolve, 60))
    fireEvent.click(screen.getByTestId('recording-stop'))
    await waitFor(() => expect(projectIoMock.importRecordedFile).toHaveBeenCalled())
    const [, duration] = projectIoMock.importRecordedFile.mock.calls[0]
    expect(duration).toBeGreaterThan(0)
    expect(screen.queryByTestId('recording-error')).not.toBeInTheDocument()
  })

  it('warns when a chunk was dropped at the size ceiling', async () => {
    const { stream } = fakeStream()
    installBrowser(stream)
    recorderMock.readRecordingDuration.mockResolvedValue(1)
    projectIoMock.importRecordedFile.mockResolvedValue(
      createMediaAsset({ id: 'take', kind: 'audio', name: 'Voiceover take.webm', duration: 1 }),
    )
    FakeMediaRecorder.neverStop = true
    try {
      render(<RecordingDialog open kind="voiceover" onOpenChange={() => {}} />)
      fireEvent.click(await screen.findByLabelText('Place voiceover at the playhead'))
      fireEvent.click(await screen.findByTestId('recording-start'))
      await screen.findByTestId('recording-progress')
      const instance = FakeMediaRecorder.instances[0]
      instance.emit(new Blob(['take']))
      const nearCap = new Blob(['x'])
      Object.defineProperty(nearCap, 'size', { value: RECORDING_SOFT_MAX_BYTES })
      instance.emit(nearCap)
      const crossing = new Blob(['y'])
      Object.defineProperty(crossing, 'size', {
        value: RECORDING_MAX_BYTES - RECORDING_SOFT_MAX_BYTES + 1,
      })
      instance.emit(crossing)
      await waitFor(() => expect(projectIoMock.importRecordedFile).toHaveBeenCalled())
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Recording stopped at the recording limit' }),
      )
      expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Recording added' }))
    } finally {
      FakeMediaRecorder.neverStop = false
    }
  })

  it('explains a take whose first chunk was already over the ceiling', async () => {
    const { stream } = fakeStream()
    installBrowser(stream)
    render(<RecordingDialog open kind="voiceover" onOpenChange={() => {}} />)
    fireEvent.click(await screen.findByTestId('recording-start'))
    await screen.findByTestId('recording-progress')
    const oversized = new Blob(['z'])
    Object.defineProperty(oversized, 'size', { value: RECORDING_MAX_BYTES + 1 })
    FakeMediaRecorder.instances[0].emit(oversized)
    expect(await screen.findByTestId('recording-error')).toHaveTextContent(
      /reached the 512 MB limit before a chunk could be saved/i,
    )
    expect(projectIoMock.importRecordedFile).not.toHaveBeenCalled()
    expect(screen.getByTestId('recording-start')).toBeEnabled()
  })

  it('ignores a second Start while the permission request is pending', async () => {
    const { stream } = fakeStream()
    let resolveMedia: (value: MediaStream) => void = () => {}
    const pending = new Promise<MediaStream>((resolve) => {
      resolveMedia = resolve
    })
    const getUserMedia = vi.fn(() => pending)
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia,
        getDisplayMedia: vi.fn(() => pending),
        enumerateDevices: vi.fn(async () => []),
      },
    })
    render(<RecordingDialog open kind="voiceover" onOpenChange={() => {}} />)
    const startButton = await screen.findByTestId('recording-start')
    fireEvent.click(startButton)
    fireEvent.click(startButton)
    expect(getUserMedia).toHaveBeenCalledTimes(1)
    expect(startButton).toBeDisabled()
    resolveMedia(stream)
    await screen.findByTestId('recording-progress')
    expect(FakeMediaRecorder.instances).toHaveLength(1)
  })

  it('reports a saved take that the timeline refused to place', async () => {
    const { stream } = fakeStream()
    installBrowser(stream)
    recorderMock.readRecordingDuration.mockResolvedValue(4)
    projectIoMock.importRecordedFile.mockResolvedValue(
      createMediaAsset({ id: 'take', kind: 'audio', name: 'Voiceover take.webm', duration: 4 }),
    )
    const apply = vi.spyOn(useEditorStore.getState(), 'apply').mockReturnValue(false)
    try {
      render(<RecordingDialog open kind="voiceover" onOpenChange={() => {}} />)
      fireEvent.click(await screen.findByTestId('recording-start'))
      await screen.findByTestId('recording-progress')
      FakeMediaRecorder.instances[0].emit(new Blob(['take']))
      fireEvent.click(screen.getByTestId('recording-stop'))
      await waitFor(() =>
        expect(toast).toHaveBeenCalledWith(
          expect.objectContaining({ title: 'Recording saved but not placed' }),
        ),
      )
      expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Recording added' }))
    } finally {
      apply.mockRestore()
    }
  })

  it('records through the shared import path, not a second asset constructor', () => {
    const dialog = readFileSync(
      join(process.cwd(), 'src/components/editor/RecordingDialog.tsx'),
      'utf8',
    )
    expect(dialog).toContain('importRecordedFile')
    expect(dialog).not.toMatch(/type: 'addMediaAsset'/)
    // Teardown aborts a screen request, and start passes the signal through.
    expect(dialog).toContain('abortRef.current?.abort()')
    expect(dialog).toContain('controller.signal')
    const bin = readFileSync(join(process.cwd(), 'src/components/editor/MediaBin.tsx'), 'utf8')
    expect(bin).toContain('data-testid="record-voiceover"')
    expect(bin).toContain('data-testid="record-screen"')
    expect(bin).toContain('data-testid="record-camera"')
  })
})
