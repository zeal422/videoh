// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { MediaBin } from '@/components/editor/MediaBin'
import { installBrowserMocks, type MockHarness } from './mocks/browser-mocks'
import { useEditorStore } from '../store'
import { playbackRef, type PlaybackController } from '../playback/engine-ref'
import {
  createClip,
  createMediaAsset,
  createShapeClip,
  createTextClip,
  createTrack,
} from '../factories'
import type { Doc, Sequence } from '../types'

/**
 * Project tab (0.29.5): generated text, shape, and compound clips live in a
 * second tab inside the Media panel. Media is the default, the Project list
 * reads only the ACTIVE sequence, and activation selects and seeks without
 * adding another interactive control inside the row.
 */

let h: MockHarness

beforeEach(() => {
  h = installBrowserMocks()
  document.body.innerHTML = ''
  useEditorStore.setState(useEditorStore.getInitialState())
  playbackRef.current = null
})

afterEach(() => {
  playbackRef.current = null
  cleanup()
  h.uninstall()
})

function projectDoc(): Doc {
  const asset = createMediaAsset({
    id: 'media_imported',
    kind: 'video',
    name: 'imported.mp4',
    duration: 10,
  })
  const textTrack = createTrack('text', 1, { id: 'track_text', visible: false })
  textTrack.clips = [createTextClip({ id: 'clip_text', text: 'Title card', start: 2, duration: 3 })]
  const videoTrack = createTrack('video', 1, { id: 'track_video' })
  videoTrack.clips = [
    createShapeClip({ id: 'clip_shape', start: 5, duration: 2 }),
    createClip({
      id: 'clip_imported',
      mediaId: asset.id,
      start: 0,
      duration: 2,
    }),
  ]
  const compoundTrack = createTrack('video', 2, { id: 'track_compound' })
  compoundTrack.clips = [
    createClip({ id: 'clip_compound', sequenceId: 'seq_inner', start: 8, duration: 2 }),
  ]
  const innerText = createTextClip({ id: 'clip_inner_text', text: 'Inner', start: 4, duration: 1 })
  const inner: Sequence = {
    id: 'seq_inner',
    name: 'Inner sequence',
    tracks: [createTrack('text', 1, { id: 'track_inner', clips: [innerText] })],
  }
  return {
    project: {
      tracks: [textTrack, videoTrack, compoundTrack],
      sequences: [inner],
      id: 'p_project',
      name: 'Project',
      width: 1920,
      height: 1080,
      fps: 30,
    },
    media: [asset],
  }
}

function stubSeek() {
  const seek = vi.fn()
  playbackRef.current = { seek } as unknown as PlaybackController
  return seek
}

function openProjectTab() {
  fireEvent.click(screen.getByRole('tab', { name: 'Project' }))
}

describe('Media/Project tab strip (0.29.5)', () => {
  it('starts on Media with the import controls and the empty state', () => {
    const doc: Doc = {
      project: {
        tracks: [createTrack('video', 1)],
        id: 'p_empty',
        name: 'Empty',
        width: 1920,
        height: 1080,
        fps: 30,
      },
      media: [],
    }
    useEditorStore.setState({ doc })
    render(<MediaBin />)

    expect(screen.getByRole('tablist', { name: 'Media and project' })).toBeInTheDocument()
    const media = screen.getByRole('tab', { name: 'Media' })
    const project = screen.getByRole('tab', { name: 'Project' })
    expect(media).toHaveAttribute('aria-selected', 'true')
    expect(project).toHaveAttribute('aria-selected', 'false')
    expect(media).toHaveAttribute('tabindex', '0')
    expect(project).toHaveAttribute('tabindex', '-1')
    expect(document.querySelector('input[type="file"]')).not.toBeNull()
    expect(screen.getByTestId('media-storage')).toBeInTheDocument()
    expect(screen.getByTestId('media-record')).toBeInTheDocument()
    expect(screen.getByText('No media yet')).toBeVisible()
    expect(screen.getByRole('tabpanel', { name: 'Media' })).not.toHaveAttribute('hidden')
    // The inactive panel is `hidden`, and its display class must be none too:
    // an author `flex` utility would otherwise beat the UA [hidden] rule.
    const projectPanel = document.getElementById('media-bin-panel-project')!
    expect(projectPanel).toHaveAttribute('hidden')
    expect(projectPanel).toHaveClass('hidden')
    expect(projectPanel).not.toHaveClass('flex')
    expect(document.getElementById('media-bin-panel-media')).toHaveClass('flex')
  })

  it('wires aria-controls and aria-labelledby both ways', () => {
    useEditorStore.setState({ doc: projectDoc() })
    render(<MediaBin />)
    const media = screen.getByRole('tab', { name: 'Media' })
    const project = screen.getByRole('tab', { name: 'Project' })
    expect(media).toHaveAttribute('aria-controls', 'media-bin-panel-media')
    expect(project).toHaveAttribute('aria-controls', 'media-bin-panel-project')
    expect(screen.getByRole('tabpanel', { name: 'Media' })).toHaveAttribute(
      'aria-labelledby',
      'media-bin-tab-media',
    )
    expect(document.getElementById('media-bin-panel-project')).toHaveAttribute(
      'aria-labelledby',
      'media-bin-tab-project',
    )
  })

  it('moves focus and activates with Arrow keys, Home, and End', () => {
    useEditorStore.setState({ doc: projectDoc() })
    render(<MediaBin />)
    const media = screen.getByRole('tab', { name: 'Media' })
    const project = screen.getByRole('tab', { name: 'Project' })

    fireEvent.keyDown(media, { key: 'ArrowRight' })
    expect(project).toHaveAttribute('aria-selected', 'true')
    expect(document.activeElement).toBe(project)

    fireEvent.keyDown(project, { key: 'ArrowLeft' })
    expect(media).toHaveAttribute('aria-selected', 'true')
    expect(document.activeElement).toBe(media)

    fireEvent.keyDown(media, { key: 'End' })
    expect(project).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(project, { key: 'Home' })
    expect(media).toHaveAttribute('aria-selected', 'true')
    expect(document.getElementById('media-bin-panel-media')).toHaveClass('flex')
    expect(document.getElementById('media-bin-panel-project')).toHaveClass('hidden')
  })
})

describe('Project items list (0.29.5)', () => {
  it('lists generated clips only, in the active sequence', () => {
    useEditorStore.setState({ doc: projectDoc() })
    render(<MediaBin />)
    openProjectTab()

    expect(screen.getByTestId('project-item-clip_text')).toHaveTextContent('Title card')
    expect(screen.getByTestId('project-item-clip_text')).toHaveTextContent('Text')
    expect(screen.getByTestId('project-item-clip_shape')).toHaveTextContent('Rectangle')
    expect(screen.getByTestId('project-item-clip_compound')).toHaveTextContent('Inner sequence')
    expect(screen.queryByTestId('project-item-clip_imported')).not.toBeInTheDocument()

    // One row is one button, with the Go to hint as plain text.
    const row = screen.getByTestId('project-item-clip_text')
    expect(row.tagName).toBe('BUTTON')
    expect(row.querySelectorAll('button')).toHaveLength(0)
    expect(row).toHaveTextContent('Go to')
    expect(screen.getByTestId('project-item-clip_text')).toHaveTextContent('Hidden track')
  })

  it('selects, seeks to the clip start, and reveals a hidden track', () => {
    const doc = projectDoc()
    useEditorStore.setState({ doc })
    render(<MediaBin />)
    openProjectTab()
    const seek = stubSeek()

    fireEvent.click(screen.getByTestId('project-item-clip_text'))
    expect(useEditorStore.getState().selection).toBe('clip_text')
    expect(seek).toHaveBeenCalledWith(2)
    expect(useEditorStore.getState().doc.project.tracks[0].visible).not.toBe(false)
  })

  it('reads the active compound sequence, not the parent timeline', () => {
    const doc = projectDoc()
    useEditorStore.setState({ doc, activeSequencePath: ['seq_inner'], playhead: 0 })
    render(<MediaBin />)
    openProjectTab()
    const seek = stubSeek()

    expect(screen.getByTestId('project-item-clip_inner_text')).toHaveTextContent('Inner')
    expect(screen.queryByTestId('project-item-clip_text')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('project-item-clip_inner_text'))
    expect(useEditorStore.getState().selection).toBe('clip_inner_text')
    expect(seek).toHaveBeenCalledWith(4)
  })

  it('shows the empty state on a sequence with no generated clips', () => {
    const doc = projectDoc()
    useEditorStore.setState({ doc, activeSequencePath: ['seq_empty'] })
    const store = useEditorStore.getState()
    store.replaceDoc({
      ...doc,
      project: {
        ...doc.project,
        sequences: [
          ...(doc.project.sequences ?? []),
          {
            id: 'seq_empty',
            name: 'Empty sequence',
            tracks: [createTrack('video', 1)],
          },
        ],
      },
    })
    useEditorStore.setState({ activeSequencePath: ['seq_empty'] })
    render(<MediaBin />)
    openProjectTab()
    expect(screen.getByTestId('project-items-empty')).toHaveTextContent(
      'No text, shapes, or compound clips in this sequence.',
    )
  })

  it('selects a clip on a locked track', () => {
    const doc = projectDoc()
    doc.project.tracks[1].locked = true
    useEditorStore.setState({ doc })
    render(<MediaBin />)
    openProjectTab()
    stubSeek()
    fireEvent.click(screen.getByTestId('project-item-clip_shape'))
    expect(useEditorStore.getState().selection).toBe('clip_shape')
  })
})
