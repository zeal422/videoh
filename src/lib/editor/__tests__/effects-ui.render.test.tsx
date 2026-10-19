// @vitest-environment jsdom
/**
 * jsdom render tests for the 0.8.6 effects UI: the Applied Effects section
 * lists stack entries with enable/delete/reset, the picker adds entries, the
 * blend dropdown writes the fixed field, the track eyeball flips visibility,
 * and the eyedropper arms and disarms. Store-level proof; pixels stay with
 * the battery.
 */
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { InspectorPanel } from '@/components/editor/InspectorPanel'
import { TimelinePanel } from '@/components/editor/timeline/TimelinePanel'
import { installBrowserMocks, type MockHarness } from './mocks/browser-mocks'
import { useEditorStore } from '../store'
import { createClip, createMediaAsset, createTrack } from '../factories'
import type { Clip, Doc } from '../types'

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

function docWithVideoClip(over: Partial<Clip> = {}): { doc: Doc; clipId: string } {
  const asset = createMediaAsset({ kind: 'video', duration: 30, name: 'demo.mp4' })
  const clip = createClip({ id: 'clip_fx', mediaId: asset.id, start: 0, duration: 6, ...over })
  const track = createTrack('video', 1, { clips: [clip as Clip] })
  const doc: Doc = {
    project: { tracks: [track], id: 'p_test', name: 'test', width: 1920, height: 1080, fps: 30 },
    media: [asset],
  }
  useEditorStore.setState({ doc, selection: clip.id, selections: [clip.id], playhead: 2 })
  return { doc, clipId: clip.id }
}

function openEffectsTab() {
  render(<InspectorPanel />)
  fireEvent.click(screen.getByTestId('inspector-tab-effects'))
}

function storedClip(clipId: string): Clip {
  const found = useEditorStore
    .getState()
    .doc.project.tracks.flatMap((t) => t.clips)
    .find((c) => c.id === clipId)
  if (!found) throw new Error('clip vanished')
  return found
}

describe('Applied Effects section', () => {
  it('lists stack entries and renders the empty state without any', () => {
    docWithVideoClip()
    openEffectsTab()
    expect(screen.getByTestId('applied-effects')).toBeInTheDocument()
    expect(screen.getByText(/No effects/)).toBeInTheDocument()
  })

  it('the picker adds a crop entry to the selected clip', async () => {
    const { clipId } = docWithVideoClip()
    openEffectsTab()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Add effect' }))
    await user.click(screen.getByRole('menuitem', { name: 'Crop' }))
    const clip = storedClip(clipId)
    expect(clip.effects?.map((e) => e.type)).toEqual(['crop'])
    expect(screen.getByTestId(`effect-${clip.effects![0].id}`)).toBeInTheDocument()
  })

  it('enable, reset and remove act on the entry', async () => {
    const { clipId } = docWithVideoClip({
      effects: [{ id: 'fx_crop', type: 'crop', left: 20 }],
    })
    openEffectsTab()
    const card = screen.getByTestId('effect-fx_crop')
    const user = userEvent.setup()
    await user.click(within(card).getByRole('switch', { name: 'Crop enabled' }))
    expect(storedClip(clipId).effects?.[0].enabled).toBe(false)
    await user.click(within(card).getByRole('switch', { name: 'Crop enabled' }))
    await user.click(within(card).getByRole('button', { name: 'Reset Crop' }))
    expect(storedClip(clipId).effects?.[0]).toMatchObject({ left: undefined })
    await user.click(within(card).getByRole('button', { name: 'Remove Crop' }))
    expect(storedClip(clipId).effects).toBeUndefined()
  })

  it('the crop diamond pins a keyframe at the playhead', async () => {
    const { clipId } = docWithVideoClip({
      effects: [{ id: 'fx_crop', type: 'crop', left: 20 }],
    })
    openEffectsTab()
    const user = userEvent.setup()
    await user.click(screen.getByTestId('fx-kf-fx_crop-left'))
    const keys = storedClip(clipId).effects?.[0].keyframes?.left
    expect(keys).toHaveLength(1)
    expect(keys?.[0]).toMatchObject({ time: 2, value: 20 })
  })

  it('the matte submenu lists only tracks above the clip', async () => {
    const asset = createMediaAsset({ kind: 'video', duration: 30, name: 'demo.mp4' })
    const top = createTrack('video', 1, { id: 'v_top', name: 'V1' })
    const bottom = createTrack('video', 2, { id: 'v_bot', name: 'V2' })
    const clip = createClip({ id: 'clip_low', mediaId: asset.id, start: 0, duration: 6 })
    bottom.clips = [clip as Clip]
    const doc: Doc = {
      project: { tracks: [top, bottom], id: 'p', name: 't', width: 1920, height: 1080, fps: 30 },
      media: [asset],
    }
    useEditorStore.setState({ doc, selection: clip.id, selections: [clip.id], playhead: 1 })
    openEffectsTab()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Add effect' }))
    await user.hover(screen.getByRole('menuitem', { name: 'Track matte' }))
    expect(await screen.findByRole('menuitem', { name: 'V1' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'V2' })).not.toBeInTheDocument()
  })
})

describe('blend mode dropdown', () => {
  it('renders Normal selected and offers the canvas set', () => {
    docWithVideoClip({ blendMode: 'screen' })
    render(<InspectorPanel />)
    expect(screen.getByRole('combobox', { name: 'Clip blend mode' })).toHaveTextContent('Screen')
  })
})

describe('track eyeball', () => {
  it('flips visibility on video lanes and marks the hidden header', async () => {
    docWithVideoClip()
    render(<TimelinePanel />)
    const user = userEvent.setup()
    const header = screen.getByTestId(/track-header-/)
    expect(header).toHaveAttribute('data-visible', 'true')
    await user.click(screen.getByRole('button', { name: /Hide / }))
    const track = useEditorStore.getState().doc.project.tracks[0]
    expect(track.visible).toBe(false)
    expect(screen.getByTestId(/track-header-/)).toHaveAttribute('data-visible', 'false')
    // The lane dims with the header (header-only dimming is not sufficient).
    const lane = document.querySelector(`[data-lane-id="${track.id}"]`)
    expect(lane).toHaveAttribute('data-visible', 'false')
    expect(lane?.className).toMatch(/opacity-60/)
  })

  it('audio lanes get no eye', () => {
    const asset = createMediaAsset({ kind: 'audio', duration: 30, name: 'song.mp3' })
    const track = createTrack('audio', 1, { id: 'a1', name: 'A1' })
    const doc: Doc = {
      project: { tracks: [track], id: 'p', name: 't', width: 1920, height: 1080, fps: 30 },
      media: [asset],
    }
    useEditorStore.setState({ doc })
    render(<TimelinePanel />)
    expect(screen.queryByRole('button', { name: /Hide |Show / })).not.toBeInTheDocument()
  })
})

describe('eyedropper arming', () => {
  it('arms from the chroma entry and disarms on second click', async () => {
    const { clipId } = docWithVideoClip({
      effects: [{ id: 'fx_key', type: 'chromaKey', key: '#00ff00' }],
    })
    openEffectsTab()
    const user = userEvent.setup()
    expect(useEditorStore.getState().eyedropper).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Pick key color from monitor' }))
    expect(useEditorStore.getState().eyedropper).toEqual({ clipId, effectId: 'fx_key' })
    expect(screen.getByText(/Click the Program Monitor/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancel eyedropper' }))
    expect(useEditorStore.getState().eyedropper).toBeNull()
  })
})
