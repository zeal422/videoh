// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, render, screen, within } from '@testing-library/react'

import { MediaBin } from '@/components/editor/MediaBin'
import { PreviewPanel } from '@/components/editor/PreviewPanel'
import { StatusBar } from '@/components/editor/StatusBar'
import { installBrowserMocks, type MockHarness } from './mocks/browser-mocks'
import { useEditorStore } from '../store'
import { createClip, createDoc, createMediaAsset, createTrack } from '../factories'
import type { Doc, MediaAsset, Track } from '../types'

/**
 * Plan 02 chrome render tests: media cards, the status bar, and the padded
 * transport clock. Geometry that jsdom cannot measure (track rows, panel
 * widths) is locked separately in the timeline and shell suites.
 */

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

let h: MockHarness

beforeEach(() => {
  h = installBrowserMocks()
  document.body.innerHTML = ''
  useEditorStore.setState(useEditorStore.getInitialState())
})

afterEach(() => {
  cleanup()
  h.uninstall()
})

function mediaAsset(partial: Partial<MediaAsset> & { kind: MediaAsset['kind'] }): MediaAsset {
  return createMediaAsset(partial)
}

function docWithMedia(media: MediaAsset[]): Doc {
  const doc = createDoc()
  doc.media = media
  return doc
}

function docWithTracks(
  tracks: Track[],
  clips: { id: string; start: number; duration: number }[] = [],
) {
  const doc = createDoc()
  doc.project.tracks = tracks
  doc.media = []
  if (clips.length > 0) {
    for (const clip of clips) {
      doc.project.tracks[0].clips.push(
        createClip({ id: clip.id, start: clip.start, duration: clip.duration }),
      )
    }
  }
  return doc
}

describe('media bin cards', () => {
  it('renders the 64x40 thumbnail, name, kind, and duration', () => {
    const asset = mediaAsset({
      id: 'media_video',
      kind: 'video',
      name: 'clip.mp4',
      duration: 6.02,
      width: 640,
      height: 360,
      thumbnail: 'data:image/jpeg;base64,AAAA',
    })
    useEditorStore.setState({ doc: docWithMedia([asset]) })
    render(<MediaBin heading={false} />)

    const card = screen.getByTestId('media-item-media_video')
    expect(within(card).getByText('clip.mp4')).toBeInTheDocument()
    expect(within(card).getByText('video')).toBeInTheDocument()
    expect(within(card).getByText('6.0s')).toBeInTheDocument()
    const image = card.querySelector('img')
    expect(image).toHaveClass('size-full', 'object-cover')
    expect(card.querySelector('.h-10.w-16')).not.toBeNull()
    expect(within(card).getByLabelText('Add to timeline')).toBeInTheDocument()
    expect(within(card).getByLabelText('Remove from bin')).toBeInTheDocument()
  })

  it('keeps the selected ring and the offline state', () => {
    const online = mediaAsset({ id: 'media_online', kind: 'video', name: 'ok.mp4', duration: 2 })
    const offline = mediaAsset({
      id: 'media_offline',
      kind: 'audio',
      name: 'gone.mp3',
      duration: 2,
      missing: true,
    })
    useEditorStore.setState({ doc: docWithMedia([online, offline]), sourceAssetId: online.id })
    render(<MediaBin heading={false} />)

    const selected = screen.getByTestId('media-item-media_online')
    expect(selected).toHaveAttribute('data-selected', 'true')
    expect(selected.className).toContain('border-rose-400/70')
    const missing = screen.getByTestId('media-item-media_offline')
    expect(missing).toHaveAttribute('data-selected', 'false')
    expect(within(missing).getByText('offline')).toBeInTheDocument()
    expect(missing.className).toContain('border-amber-500/40')
    expect(within(missing).getByLabelText('Relink media file')).toBeInTheDocument()
  })

  it('locks the thumbnail size class in source', () => {
    const src = read('src/components/editor/MediaBin.tsx')
    expect(src).toContain('h-10 w-16')
    expect(src).not.toContain('flex size-10 shrink-0')
  })
})

describe('status bar', () => {
  it('counts a multi-selection and keeps the compact timeline duration', () => {
    const doc = docWithTracks(
      [createTrack('video', 1)],
      [
        { id: 'v1', start: 0, duration: 4.2 },
        { id: 'v2', start: 5, duration: 2 },
      ],
    )
    doc.project.tracks[0].clips[0].duration = 12
    doc.project.tracks[0].clips[1].start = 12
    useEditorStore.setState({ doc, selections: ['v1', 'v2'] })
    render(<StatusBar />)

    expect(screen.getByText('2 clips selected')).toBeInTheDocument()
    expect(screen.getByText(/Timeline 0:14\.0/)).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('px/s')
    expect(document.body.textContent).not.toContain('undo steps')
  })

  it('shows the single-clip range with an en dash and its duration', () => {
    const doc = docWithTracks([createTrack('video', 1)], [{ id: 'v1', start: 0, duration: 4.2 }])
    useEditorStore.setState({ doc, selections: ['v1'] })
    render(<StatusBar />)

    expect(screen.getByTestId('status-selection')).toHaveTextContent(
      'Selected clip 00:00–00:04.2 (4.2s)',
    )
  })

  it('trims a whole-second endpoint and a whole-second duration', () => {
    const doc = docWithTracks([createTrack('video', 1)], [{ id: 'v1', start: 0, duration: 4 }])
    useEditorStore.setState({ doc, selections: ['v1'] })
    render(<StatusBar />)

    expect(screen.getByTestId('status-selection')).toHaveTextContent(
      'Selected clip 00:00–00:04 (4s)',
    )
  })

  it('counts video and audio tracks, omits text tracks, and hides below xl', () => {
    const tracks = [
      createTrack('video', 1),
      createTrack('video', 2),
      createTrack('video', 3),
      createTrack('video', 4),
      createTrack('video', 5),
      createTrack('audio', 1),
      createTrack('audio', 2),
      createTrack('audio', 3),
      createTrack('audio', 4),
      createTrack('text', 1),
    ]
    useEditorStore.setState({ doc: docWithTracks(tracks) })
    render(<StatusBar />)

    const counts = screen.getByTestId('status-track-counts')
    expect(counts).toHaveTextContent('5 video tracks · 4 audio tracks')
    expect(counts).not.toHaveTextContent('text')
    expect(counts.className).toContain('hidden')
    expect(counts.className).toContain('xl:inline')
  })

  it('uses singular track labels', () => {
    useEditorStore.setState({
      doc: docWithTracks([createTrack('video', 1), createTrack('audio', 1)]),
    })
    render(<StatusBar />)

    expect(screen.getByTestId('status-track-counts')).toHaveTextContent(
      '1 video track · 1 audio track',
    )
  })

  it('counts the open compound sequence, not the root project', () => {
    const root = createDoc()
    root.project.tracks = [createTrack('video', 1), createTrack('audio', 1)]
    root.project.sequences = [
      {
        id: 'seq_1',
        name: 'Nested',
        tracks: [
          createTrack('video', 1),
          createTrack('video', 2),
          createTrack('audio', 1),
          createTrack('text', 1),
        ],
      },
    ]
    useEditorStore.setState({ doc: root, activeSequencePath: ['seq_1'] })
    render(<StatusBar />)

    expect(screen.getByTestId('status-track-counts')).toHaveTextContent(
      '2 video tracks · 1 audio track',
    )
  })
})

describe('transport clock', () => {
  it('shows the padded total-minutes format', () => {
    const doc = docWithTracks([createTrack('video', 1)], [{ id: 'v1', start: 0, duration: 18 }])
    useEditorStore.setState({ doc, playhead: 2.7 })
    render(<PreviewPanel />)

    expect(screen.getByTestId('time-display')).toHaveTextContent('00:02.7 / 00:18.0')
  })
})
