// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('@/lib/editor/media/font-store', () => ({
  stageProjectFont: vi.fn(),
  commitStagedFont: vi.fn(() => true),
  discardStagedFont: vi.fn(),
}))
vi.mock('@/lib/editor/project-io', () => ({
  currentProjectToken: () => ({ projectId: 'p_test', epoch: 1 }),
  isProjectTokenCurrent: () => true,
}))
vi.mock('@/lib/editor/media/probe', () => ({ importFile: vi.fn() }))
vi.mock('@/lib/editor/media/persist', () => ({
  storeMediaAsset: vi.fn(),
  beginMediaActivityWhenIdle: vi.fn(),
  endMediaActivity: vi.fn(),
}))
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }))
vi.mock('@/lib/editor/media/stickers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../media/stickers')>()
  return { ...actual, fetchStickerFile: vi.fn() }
})

import { InspectorPanel } from '@/components/editor/InspectorPanel'
import { StickerPicker } from '@/components/editor/StickerPicker'
import { installBrowserMocks, type MockHarness } from './mocks/browser-mocks'
import { useEditorStore } from '../store'
import { createShapeClip, createTextClip, createTrack } from '../factories'
import { createShapeStyle } from '../shapes'
import { fontFamilyForId } from '../fonts'
import { commitStagedFont, stageProjectFont } from '../media/font-store'
import { beginMediaActivityWhenIdle, endMediaActivity } from '../media/persist'
import { toast } from '@/hooks/use-toast'
import { importFile } from '../media/probe'
import { storeMediaAsset } from '../media/persist'
import { fetchStickerFile, STICKERS } from '../media/stickers'
import type { Clip, Doc, MediaAsset } from '../types'

let h: MockHarness

beforeEach(() => {
  h = installBrowserMocks()
  document.body.innerHTML = ''
  useEditorStore.setState(useEditorStore.getInitialState())
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
  h.uninstall()
})

function baseDoc(fonts: Doc['project']['fonts'] = []): Doc {
  const clip = createTextClip({ id: 'clip_title', text: 'Hello' })
  const text = createTrack('text', 1, { clips: [clip as Clip] })
  const video = createTrack('video', 1)
  const doc: Doc = {
    project: {
      tracks: [text, video],
      id: 'p_test',
      name: 'test',
      width: 1920,
      height: 1080,
      fps: 30,
      fonts,
    },
    media: [],
  }
  useEditorStore.setState({
    doc,
    selection: clip.id,
    selections: [clip.id],
    playhead: 1,
    projectEpoch: 1,
  })
  return doc
}

const FONT = {
  id: 'font_mock',
  name: 'Inter',
  family: fontFamilyForId('font_mock'),
  contentHash: 'a'.repeat(64),
}

describe('font picker (0.25.0)', () => {
  it('lists built-in and project fonts from the project library', () => {
    const doc = baseDoc([FONT])
    render(<InspectorPanel />)
    expect(screen.getByLabelText('Font family')).toHaveTextContent('Arial')
    // Radix portals do not mount in jsdom: the library wiring is locked by
    // source, and the project font is present in the real document.
    const source = readFileSync(join(process.cwd(), 'src/components/editor/FontPicker.tsx'), 'utf8')
    expect(source).toContain('BUILTIN_FONTS.map')
    expect(source).toContain('projectFonts.map')
    expect(doc.project.fonts).toHaveLength(1)
  })

  it('uploads a font and applies it to the selected clip in one undo step', async () => {
    vi.mocked(stageProjectFont).mockResolvedValue({
      font: FONT,
      face: {} as FontFace,
      projectId: 'p_test',
    })
    baseDoc()
    const pastBefore = useEditorStore.getState().past.length
    render(<InspectorPanel />)
    fireEvent.click(screen.getByLabelText('Upload font'))
    const file = new File(['font bytes'], 'Inter.woff2', { type: 'font/woff2' })
    fireEvent.change(screen.getByTestId('font-file'), { target: { files: [file] } })
    expect(screen.getByTestId('font-name')).toHaveValue('Inter')
    fireEvent.click(screen.getByTestId('font-upload'))

    await waitFor(() => expect(useEditorStore.getState().doc.project.fonts).toEqual([FONT]))
    const clip = useEditorStore.getState().doc.project.tracks[0].clips[0]
    expect(clip.style?.fontFamily).toBe(FONT.family)
    // The upload and its application are one command batch.
    expect(useEditorStore.getState().past.length).toBe(pastBefore + 1)
    expect(commitStagedFont).toHaveBeenCalledWith(expect.objectContaining({ font: FONT }), 'p_test')
    // The activity hold spans staging through commit, then releases.
    expect(beginMediaActivityWhenIdle).toHaveBeenCalled()
    expect(endMediaActivity).toHaveBeenCalled()
  })

  it('reports a failed staging without touching the project', async () => {
    vi.mocked(stageProjectFont).mockRejectedValue(new Error('bad font'))
    vi.mocked(toast).mockClear()
    baseDoc()
    const pastBefore = useEditorStore.getState().past.length
    render(<InspectorPanel />)
    fireEvent.click(screen.getByLabelText('Upload font'))
    fireEvent.change(screen.getByTestId('font-file'), {
      target: { files: [new File(['x'], 'Inter.woff2', { type: 'font/woff2' })] },
    })
    fireEvent.click(screen.getByTestId('font-upload'))
    // Wait for the rejection to be processed (the staging-error toast), not
    // for a state that is already true: the font assertion below passes
    // trivially before the upload runs.
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Font upload failed' })),
    )
    expect(useEditorStore.getState().doc.project.fonts).toEqual([])
    expect(useEditorStore.getState().doc.project.tracks[0].clips[0].style?.fontFamily).toBe(
      'Arial, sans-serif',
    )
    expect(useEditorStore.getState().past).toHaveLength(pastBefore)
    // Refusal releases the hold without touching committed media.
    expect(endMediaActivity).toHaveBeenCalled()
  })
})

describe('inspector edit history (0.25.0)', () => {
  it('records one undo entry for an entire text edit session', () => {
    baseDoc()
    render(<InspectorPanel />)
    const area = screen.getByLabelText('Text content')
    const pastBefore = useEditorStore.getState().past.length
    fireEvent.focus(area)
    fireEvent.change(area, { target: { value: 'He' } })
    fireEvent.change(area, { target: { value: 'Hello there' } })
    fireEvent.blur(area)
    expect(useEditorStore.getState().past.length).toBe(pastBefore + 1)
    // The entry is the pre-edit snapshot, so undo restores the old text.
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().doc.project.tracks[0].clips[0].text).toBe('Hello')
  })

  it('commits a slider gesture from its pre-drag value, and wires the position sliders to it', () => {
    baseDoc()
    const store = useEditorStore.getState()
    const pastBefore = store.past.length
    // The sequence the position sliders run: open on the first preview frame,
    // preview through the transient slot, then commit with apply (which rolls
    // the gesture back to its base before recording the final value).
    store.beginTransient()
    store.applyTransient({ type: 'setTextStyle', clipId: 'clip_title', style: { x: 0.6 } })
    expect(useEditorStore.getState().doc.project.tracks[0].clips[0].style!.x).toBe(0.6)
    store.apply({ type: 'setTextStyle', clipId: 'clip_title', style: { x: 0.6 } })
    expect(useEditorStore.getState().past.length).toBe(pastBefore + 1)
    useEditorStore.getState().undo()
    // One entry, taken before the first preview frame: undo returns to the
    // pre-drag position, not to the last preview frame.
    expect(useEditorStore.getState().doc.project.tracks[0].clips[0].style!.x).toBe(0.5)

    // jsdom cannot drive Radix's pointer math, so the wiring itself is locked
    // by source: the preview helper opens the gesture, and both position
    // sliders commit through the command path.
    const source = readFileSync(
      join(process.cwd(), 'src/components/editor/InspectorPanel.tsx'),
      'utf8',
    )
    expect(source).toContain('if (!isTransientActive()) beginTransient()')
    expect(source.match(/onValueCommit=\{\(\[v\]\) => setStyle\(\{ x: v \}\)\}/g)).toHaveLength(1)
    expect(source.match(/onValueCommit=\{\(\[v\]\) => setStyle\(\{ y: v \}\)\}/g)).toHaveLength(1)
  })

  it('records one undo entry for a shape color session', () => {
    const doc = baseDoc()
    const video = doc.project.tracks.find((track) => track.kind === 'video')!
    const shape = createShapeClip({ id: 'clip_shape', shape: createShapeStyle('rectangle') })
    video.clips.push(shape)
    useEditorStore.setState({ selection: shape.id, selections: [shape.id] })
    render(<InspectorPanel />)
    const fill = screen.getByLabelText('Shape fill')
    const pastBefore = useEditorStore.getState().past.length
    fireEvent.focus(fill)
    fireEvent.change(fill, { target: { value: '#112233' } })
    fireEvent.change(fill, { target: { value: '#445566' } })
    fireEvent.blur(fill)
    expect(useEditorStore.getState().past.length).toBe(pastBefore + 1)
    useEditorStore.getState().undo()
    const undone = useEditorStore
      .getState()
      .doc.project.tracks.flatMap((track) => track.clips)
      .find((clip) => clip.id === 'clip_shape')!.shape!
    expect(undone.fill).toBe(createShapeStyle('rectangle').fill)
  })
})

describe('font manager (0.25.0)', () => {
  it('renames and removes an unreferenced project font', () => {
    baseDoc([FONT])
    render(<InspectorPanel />)
    fireEvent.click(screen.getByLabelText('Manage project fonts'))
    const input = screen.getByLabelText('Font name for Inter')
    fireEvent.change(input, { target: { value: 'Inter Display' } })
    fireEvent.blur(input)
    expect(useEditorStore.getState().doc.project.fonts?.[0].name).toBe('Inter Display')
    fireEvent.click(screen.getByLabelText('Remove font Inter Display'))
    expect(useEditorStore.getState().doc.project.fonts).toBeUndefined()
  })

  it('surfaces the refusal while a text clip still uses the font', () => {
    vi.mocked(toast).mockClear()
    const doc = baseDoc([FONT])
    const text = doc.project.tracks[0].clips[0]
    text.style = { ...text.style!, fontFamily: FONT.family }
    useEditorStore.setState({ doc })
    render(<InspectorPanel />)
    fireEvent.click(screen.getByLabelText('Manage project fonts'))
    fireEvent.click(screen.getByLabelText('Remove font Inter'))
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Font not changed',
        description: expect.stringMatching(/still used by a text clip/),
      }),
    )
    expect(useEditorStore.getState().doc.project.fonts).toHaveLength(1)
  })
})

describe('built-in text animations (0.25.0)', () => {
  it('applies the chosen preset as ordinary keyframes', () => {
    baseDoc()
    render(<InspectorPanel />)
    fireEvent.click(screen.getByTestId('apply-text-animation'))
    const clip = useEditorStore.getState().doc.project.tracks[0].clips[0]
    expect(clip.keyframes?.opacity?.map((keyframe) => keyframe.value)).toEqual([0, 1])
  })

  it('names the property when the preset would overwrite a curve', () => {
    baseDoc()
    render(<InspectorPanel />)
    fireEvent.click(screen.getByTestId('apply-text-animation'))
    fireEvent.click(screen.getByTestId('apply-text-animation'))
    expect(screen.getByTestId('text-animation-error')).toHaveTextContent('already animates Opacity')
  })
})

describe('shape controls (0.25.0)', () => {
  function docWithShape(kind: 'rectangle' | 'star' = 'rectangle'): Doc {
    const doc = baseDoc()
    const video = doc.project.tracks.find((track) => track.kind === 'video')!
    const shape = createShapeClip({ id: 'clip_shape', shape: createShapeStyle(kind) })
    video.clips.push(shape)
    useEditorStore.setState({ selection: shape.id, selections: [shape.id] })
    return doc
  }

  it('edits fill and toggles the optional stroke', () => {
    const doc = docWithShape()
    render(<InspectorPanel />)
    expect(screen.getByTestId('clip-shape-section')).toBeInTheDocument()
    expect(screen.getByText('Rectangle')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Shape fill'), { target: { value: '#00ff00' } })
    let shape = useEditorStore
      .getState()
      .doc.project.tracks.flatMap((track) => track.clips)
      .find((clip) => clip.id === 'clip_shape')!.shape!
    expect(shape.fill).toBe('#00ff00')
    fireEvent.click(screen.getByLabelText('Enable shape stroke'))
    shape = useEditorStore
      .getState()
      .doc.project.tracks.flatMap((track) => track.clips)
      .find((clip) => clip.id === 'clip_shape')!.shape!
    expect(shape.stroke).toBe('#000000')
    expect(shape.strokeWidth).toBe(4)
  })

  it('shows the point count only for star and polygon kinds', () => {
    docWithShape('star')
    render(<InspectorPanel />)
    expect(screen.getByText('Points')).toBeInTheDocument()
    expect(screen.getByText('Star')).toBeInTheDocument()
  })

  it('shows the visual controls for a shape clip, but no LUT row', () => {
    docWithShape()
    render(<InspectorPanel />)
    // Opacity, blend, Transform, and grade are the shared visual surface:
    // a shape with no media asset must still reach them.
    expect(screen.getByRole('slider', { name: 'Clip opacity percent' })).toBeInTheDocument()
    expect(screen.getByLabelText('Clip blend mode')).toBeInTheDocument()
    expect(screen.getByText('Rotation (°)')).toBeInTheDocument()
    expect(screen.getByLabelText('Flip horizontally')).toBeInTheDocument()
    expect(screen.getByRole('slider', { name: 'Temperature' })).toBeInTheDocument()
    // A shape has no decoded frame for the 3D pixel pass, exactly like text.
    expect(screen.queryByTestId('lut-select')).not.toBeInTheDocument()
  })
})

describe('sticker picker (0.25.0)', () => {
  it('imports the chosen sticker through the image path and adds a clip', async () => {
    const doc = baseDoc()
    const fresh: MediaAsset = {
      id: 'media_sticker',
      kind: 'image',
      name: 'sticker-star.svg',
      duration: 0,
      width: 256,
      height: 256,
      url: 'blob:sticker',
    }
    const stored: MediaAsset = { ...fresh, contentHash: 'b'.repeat(64) }
    vi.mocked(fetchStickerFile).mockResolvedValue(
      new File(['<svg/>'], 'sticker-star.svg', { type: 'image/svg+xml' }),
    )
    vi.mocked(importFile).mockResolvedValue(fresh)
    vi.mocked(storeMediaAsset).mockResolvedValue({ asset: stored, stored: true })

    render(<StickerPicker open onOpenChange={() => {}} />)
    expect(screen.getByTestId('sticker-picker')).toBeInTheDocument()
    expect(STICKERS).toHaveLength(6)
    fireEvent.click(screen.getByTestId('sticker-star'))

    await waitFor(() =>
      expect(
        useEditorStore.getState().doc.media.some((asset) => asset.id === 'media_sticker'),
      ).toBe(true),
    )
    const clips = useEditorStore.getState().doc.project.tracks.flatMap((track) => track.clips)
    expect(clips.some((clip) => clip.mediaId === 'media_sticker')).toBe(true)
    expect(doc.project.tracks[0].clips).toHaveLength(1)
    expect(importFile).toHaveBeenCalledTimes(1)
    expect(storeMediaAsset).toHaveBeenCalledWith('p_test', fresh)
  })

  it('moves focus between tiles with the arrow keys', () => {
    render(<StickerPicker open onOpenChange={() => {}} />)
    const group = screen.getByRole('group', { name: 'Stickers' })
    const tiles = screen.getAllByRole('button', { name: /^Add .+ sticker$/ })
    tiles[0].focus()
    fireEvent.keyDown(group, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(tiles[1])
    fireEvent.keyDown(group, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(tiles[0])
    // Wraps to the last tile.
    fireEvent.keyDown(group, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(tiles[tiles.length - 1])
  })

  it('does not request a remote host', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/components/editor/StickerPicker.tsx'),
      'utf8',
    )
    expect(source).not.toMatch(/https?:\/\//)
    expect(source).toContain('fetchStickerFile')
    expect(source).toContain('storeMediaAsset')
  })

  it('lands at the playhead captured when insertion started', async () => {
    baseDoc()
    // playhead is 1 here; the import resolves after it moves.
    const fresh: MediaAsset = {
      id: 'media_sticker',
      kind: 'image',
      name: 'sticker-star.svg',
      duration: 0,
      width: 256,
      height: 256,
      url: 'blob:sticker',
    }
    const stored: MediaAsset = { ...fresh, contentHash: 'b'.repeat(64) }
    let resolveImport!: (asset: MediaAsset) => void
    const gate = new Promise<MediaAsset>((resolve) => {
      resolveImport = resolve
    })
    vi.mocked(fetchStickerFile).mockResolvedValue(
      new File(['<svg/>'], 'sticker-star.svg', { type: 'image/svg+xml' }),
    )
    vi.mocked(importFile).mockReturnValue(gate)
    vi.mocked(storeMediaAsset).mockResolvedValue({ asset: stored, stored: true })

    render(<StickerPicker open onOpenChange={() => {}} />)
    fireEvent.click(screen.getByTestId('sticker-star'))
    await waitFor(() => expect(importFile).toHaveBeenCalled())
    useEditorStore.getState().setPlayhead(9)
    resolveImport(fresh)

    await waitFor(() =>
      expect(
        useEditorStore.getState().doc.media.some((asset) => asset.id === 'media_sticker'),
      ).toBe(true),
    )
    const clips = useEditorStore.getState().doc.project.tracks.flatMap((track) => track.clips)
    const sticker = clips.find((clip) => clip.mediaId === 'media_sticker')!
    expect(sticker.start).toBe(1)
  })

  it('refuses when the captured sequence is deleted mid-import', async () => {
    const doc = baseDoc()
    const sequence = {
      id: 'seq_1',
      name: 'Nested',
      tracks: [createTrack('video', 1, { id: 'v_nested' })],
    }
    doc.project.sequences = [sequence]
    // A sequence is only reachable through a compound container on its parent.
    doc.project.tracks
      .find((track) => track.kind === 'video')!
      .clips.push({ id: 'clip_comp', start: 0, duration: 4, inPoint: 0, sequenceId: 'seq_1' })
    useEditorStore.getState().setActiveSequencePath(['seq_1'])
    expect(useEditorStore.getState().activeSequencePath).toEqual(['seq_1'])
    const fresh: MediaAsset = {
      id: 'media_sticker',
      kind: 'image',
      name: 'sticker-star.svg',
      duration: 0,
      width: 256,
      height: 256,
      url: 'blob:sticker',
    }
    let resolveImport!: (asset: MediaAsset) => void
    const gate = new Promise<MediaAsset>((resolve) => {
      resolveImport = resolve
    })
    vi.mocked(toast).mockClear()
    vi.mocked(fetchStickerFile).mockResolvedValue(
      new File(['<svg/>'], 'sticker-star.svg', { type: 'image/svg+xml' }),
    )
    vi.mocked(importFile).mockReturnValue(gate)
    vi.mocked(storeMediaAsset).mockResolvedValue({
      asset: { ...fresh, contentHash: 'b'.repeat(64) },
      stored: true,
    })

    render(<StickerPicker open onOpenChange={() => {}} />)
    fireEvent.click(screen.getByTestId('sticker-star'))
    await waitFor(() => expect(importFile).toHaveBeenCalled())
    // The sequence the sticker was aimed at disappears mid-import.
    useEditorStore.setState({
      doc: { ...useEditorStore.getState().doc, project: { ...doc.project, sequences: [] } },
      activeSequencePath: ['seq_1'],
    })
    resolveImport(fresh)

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Could not add the Star sticker' }),
      ),
    )
    // The refusal names the deleted sequence, not a thrown placement error.
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ description: expect.stringContaining('deleted') }),
    )
    // No clip lands anywhere, and the error is the sequence refusal rather
    // than a thrown `Unknown sequence` from deep in the placement.
    expect(
      useEditorStore
        .getState()
        .doc.project.tracks.flatMap((track) => track.clips)
        .some((clip) => clip.mediaId === 'media_sticker'),
    ).toBe(false)
    expect(useEditorStore.getState().doc.media).toHaveLength(0)
  })
})
