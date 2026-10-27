// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { TimelinePanel } from '@/components/editor/timeline/TimelinePanel'
import { FILMSTRIP_DEBOUNCE_MS } from '@/components/editor/timeline/Filmstrip'
import { createClip, createMediaAsset, createTrack } from '@/lib/editor/factories'
import { useEditorStore } from '@/lib/editor/store'
import { disposeAll, setFilmstripImageLoader } from '@/lib/editor/media/filmstrip-cache'
import type { Clip, Doc } from '@/lib/editor/types'
import { installBrowserMocks, type MockHarness } from './mocks/browser-mocks'

const h: MockHarness = installBrowserMocks()

afterAll(() => h.uninstall())

const ASSET = createMediaAsset({
  id: 'media-v',
  kind: 'video',
  name: 'demo.mp4',
  duration: 30,
  width: 1920,
  height: 1080,
  url: 'blob:video',
  waveformPeaks: [0.2, 0.8, 0.4],
  thumbnail: 'data:image/jpeg;base64,AAAA',
})

function makeDoc(options: { twin?: boolean; clip?: Partial<Clip> } = {}): Doc {
  const videoTrack = createTrack('video', 1)
  const audioTrack = createTrack('audio', 1)
  const linkId = options.twin ? 'link-av' : undefined
  videoTrack.clips = [
    createClip({
      id: 'clip-v',
      mediaId: ASSET.id,
      start: 0,
      duration: 4,
      inPoint: 0,
      linkId,
      ...options.clip,
    }),
  ]
  if (options.twin) {
    audioTrack.clips = [
      createClip({
        id: 'clip-a',
        mediaId: ASSET.id,
        start: 0,
        duration: 4,
        inPoint: 0,
        linkId,
        audioOnly: true,
      }),
    ]
  }
  return {
    project: {
      id: 'p_filmstrip',
      name: 'filmstrip test',
      width: 1920,
      height: 1080,
      fps: 30,
      tracks: [videoTrack, audioTrack],
    },
    media: [ASSET],
  }
}

function imageDoc(): Doc {
  const asset = createMediaAsset({
    id: 'media-i',
    kind: 'image',
    name: 'still.png',
    width: 800,
    height: 600,
    url: 'blob:image',
    thumbnail: 'data:image/jpeg;base64,AAAA',
  })
  const track = createTrack('video', 1)
  track.clips = [createClip({ id: 'clip-i', mediaId: asset.id, start: 0, duration: 4 })]
  return {
    project: {
      id: 'p_image',
      name: 'image test',
      width: 1920,
      height: 1080,
      fps: 30,
      tracks: [track],
    },
    media: [asset],
  }
}

async function flushMicrotasks(count = 500): Promise<void> {
  for (let i = 0; i < count; i++) await Promise.resolve()
}

async function settleStrips(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(FILMSTRIP_DEBOUNCE_MS + 10)
  })
  await act(async () => {
    await flushMicrotasks()
  })
}

function canvases(container: HTMLElement): HTMLCanvasElement[] {
  return Array.from(container.querySelectorAll('canvas'))
}

function waveformCanvas(container: HTMLElement): HTMLCanvasElement | undefined {
  return canvases(container).find((canvas) => canvas.className.includes('bottom-0.5'))
}

function filmstripCanvas(container: HTMLElement): HTMLCanvasElement | undefined {
  return canvases(container).find((canvas) => canvas.className.includes('inset-0'))
}

beforeEach(() => {
  vi.useFakeTimers()
  disposeAll()
  setFilmstripImageLoader(null)
  useEditorStore.setState({
    doc: makeDoc(),
    selections: [],
    selection: null,
    activeTool: 'select',
    pxPerSec: 100,
  })
})

afterEach(() => {
  cleanup()
  disposeAll()
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('filmstrip layer', () => {
  it('renders a sampled strip behind the label and keeps every clip affordance', async () => {
    const { container } = render(<TimelinePanel />)
    expect(screen.getByTestId('clip-clip-v')).toBeInTheDocument()
    expect(screen.getByText('demo.mp4')).toBeInTheDocument()

    await settleStrips()

    const strip = container.querySelector('[data-filmstrip-ready="true"]')
    expect(strip).toBeInTheDocument()
    const canvas = filmstripCanvas(container)
    expect(canvas).toBeInTheDocument()
    expect(canvas!.className).toContain('pointer-events-none')
    const fake = canvas as HTMLCanvasElement & {
      __fakeCtx?: { calls: { op: string }[] }
    }
    expect(fake.__fakeCtx?.calls.some((call) => call.op === 'drawImage')).toBe(true)
  })

  it('keeps the label, link, speed, transition, trim handles, and context menu', async () => {
    useEditorStore.setState({
      doc: makeDoc({
        twin: true,
        clip: {
          speed: 2,
          reverse: true,
          transitionOut: { type: 'crossfade', duration: 0.6, direction: 'left' },
        },
      }),
    })
    const { container } = render(<TimelinePanel />)
    await settleStrips()

    const videoHalf = screen.getByTestId('clip-clip-v')
    const video = within(videoHalf)
    expect(video.getByText('demo.mp4')).toBeInTheDocument()
    expect(video.getByTestId('clip-link-badge')).toBeInTheDocument()
    expect(video.getByTestId('clip-speed-badge')).toBeInTheDocument()
    expect(video.getByTestId('clip-reverse-badge')).toBeInTheDocument()
    expect(video.getByText(/0\.6s/)).toBeInTheDocument()
    expect(video.getByLabelText('Trim clip start')).toBeInTheDocument()
    expect(video.getByLabelText('Trim clip end')).toBeInTheDocument()

    fireEvent.contextMenu(videoHalf)
    await act(async () => {
      vi.advanceTimersByTime(50)
      await flushMicrotasks(50)
    })
    expect(screen.getByTestId('clip-context-menu')).toBeInTheDocument()
    expect(filmstripCanvas(container)).toBeInTheDocument()
  })

  it('reuses the strip on a move instead of requesting a new one', async () => {
    const { container } = render(<TimelinePanel />)
    await settleStrips()
    expect(container.querySelector('[data-filmstrip-ready="true"]')).toBeInTheDocument()

    const doc = useEditorStore.getState().doc
    const moved: Doc = {
      ...doc,
      project: {
        ...doc.project,
        tracks: doc.project.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((clip) =>
            clip.id === 'clip-v' ? { ...clip, start: clip.start + 1 } : clip,
          ),
        })),
      },
    }
    act(() => {
      useEditorStore.setState({ doc: moved })
    })
    expect(container.querySelector('[data-filmstrip-ready="true"]')).toBeInTheDocument()
  })

  it('hides the waveform on a video half with a linked audio twin', async () => {
    useEditorStore.setState({ doc: makeDoc({ twin: true }) })
    render(<TimelinePanel />)
    await settleStrips()
    const videoHalf = screen.getByTestId('clip-clip-v')
    expect(waveformCanvas(videoHalf)).toBeUndefined()
    expect(filmstripCanvas(videoHalf)).toBeInTheDocument()
    // The twin carries the sound, so its waveform stays.
    expect(waveformCanvas(screen.getByTestId('clip-clip-a'))).toBeInTheDocument()
  })

  it('keeps the waveform on a solo video (positive control)', async () => {
    useEditorStore.setState({ doc: makeDoc({ twin: false }) })
    render(<TimelinePanel />)
    await settleStrips()
    const clip = screen.getByTestId('clip-clip-v')
    expect(waveformCanvas(clip)).toBeInTheDocument()
    expect(filmstripCanvas(clip)).toBeInTheDocument()
  })

  it('never draws a strip for an audio clip and keeps its waveform', async () => {
    const track = createTrack('audio', 1)
    track.clips = [
      createClip({ id: 'clip-a', mediaId: ASSET.id, start: 0, duration: 4, audioOnly: true }),
    ]
    const doc = makeDoc()
    doc.project.tracks = [track]
    useEditorStore.setState({ doc })
    const { container } = render(<TimelinePanel />)
    await settleStrips()
    const clip = screen.getByTestId('clip-clip-a')
    expect(filmstripCanvas(clip)).toBeUndefined()
    expect(clip.querySelector('[data-filmstrip-ready]')).toBeNull()
    expect(waveformCanvas(clip)).toBeInTheDocument()
  })

  it('shows no strip below the 24px width threshold', async () => {
    useEditorStore.setState({ pxPerSec: 3 })
    const { container } = render(<TimelinePanel />)
    await settleStrips()
    expect(container.querySelector('[data-filmstrip-ready]')).toBeNull()
    expect(screen.getByTestId('clip-clip-v')).toBeInTheDocument()
  })

  it('draws an image clip once and never seeks', async () => {
    const image = document.createElement('canvas')
    image.width = 800
    image.height = 600
    const loader = vi.fn(async () => image)
    setFilmstripImageLoader(loader)
    useEditorStore.setState({ doc: imageDoc() })
    const { container } = render(<TimelinePanel />)
    await settleStrips()
    expect(container.querySelector('[data-filmstrip-ready="true"]')).toBeInTheDocument()
    expect(filmstripCanvas(container)).toBeInTheDocument()
    expect(loader).toHaveBeenCalledTimes(1)
    expect(document.querySelectorAll('video')).toHaveLength(0)
    expect(waveformCanvas(container)).toBeUndefined()
  })

  it('publishes the timeline ready marker around a request', async () => {
    render(<TimelinePanel />)
    const root = screen.getByLabelText('Timeline')
    expect(root).toHaveAttribute('data-filmstrips-ready', 'true')
    act(() => {
      vi.advanceTimersByTime(FILMSTRIP_DEBOUNCE_MS + 10)
    })
    expect(root).toHaveAttribute('data-filmstrips-ready', 'false')
    await act(async () => {
      await flushMicrotasks()
    })
    expect(root).toHaveAttribute('data-filmstrips-ready', 'true')
  })
})

describe('filmstrip wiring locks', () => {
  const read = (file: string) => readFileSync(path.resolve(process.cwd(), file), 'utf8')

  it('renders the layer below the label and trim handles', () => {
    const clipView = read('src/components/editor/timeline/ClipView.tsx')
    expect(clipView).toContain("from './Filmstrip'")
    const layer = clipView.indexOf('<Filmstrip')
    expect(layer).toBeGreaterThan(-1)
    expect(layer).toBeLessThan(clipView.indexOf('{/* label */}'))
    expect(layer).toBeLessThan(clipView.indexOf('{/* trim handles */}'))
    expect(layer).toBeLessThan(clipView.indexOf('{/* waveform'))
  })

  it('keeps the cache out of the pure state core and serialization', () => {
    expect(read('src/lib/editor/serialization.ts')).not.toMatch(/filmstrip/i)
    expect(read('src/lib/editor/persistence.ts')).not.toMatch(/filmstrip/i)
    for (const file of [
      'commands.ts',
      'store.ts',
      'factories.ts',
      'serialization.ts',
      'types.ts',
    ]) {
      expect(read(`src/lib/editor/${file}`)).not.toContain('filmstrip-cache')
    }
  })

  it('publishes the root marker and syncs the asset lifecycle', () => {
    expect(read('src/components/editor/timeline/TimelinePanel.tsx')).toContain(
      'data-filmstrips-ready',
    )
    expect(read('src/components/editor/EditorShell.tsx')).toContain('syncFilmstrips(')
  })

  it('keeps the clip gesture handlers intact', () => {
    const clipView = read('src/components/editor/timeline/ClipView.tsx')
    expect(clipView).toContain("beginGesture(e, 'move')")
    expect(clipView).toContain("beginGesture(e, 'trim-start')")
    expect(clipView).toContain("beginGesture(e, 'trim-end')")
    expect(clipView).toContain('onDoubleClick')
  })

  it('never lets the strip intercept pointer events', () => {
    const filmstrip = read('src/components/editor/timeline/Filmstrip.tsx')
    expect(filmstrip).toContain('pointer-events-none')
    expect(filmstrip).toContain('data-filmstrip-ready')
    expect(filmstrip).toContain('filmstripCanvasFits')
    expect(filmstrip).toContain('FILMSTRIP_DEBOUNCE_MS')
  })
})
