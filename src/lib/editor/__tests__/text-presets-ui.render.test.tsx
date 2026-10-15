// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { InspectorPanel } from '@/components/editor/InspectorPanel'
import { installBrowserMocks, type MockHarness } from './mocks/browser-mocks'
import { useEditorStore } from '../store'
import { createTextClip, createTrack } from '../factories'
import type { Clip, Doc } from '../types'

/**
 * jsdom render tests for the title preset UI (0.8.3): the Presets section
 * renders for a selected text clip (and not for other clips), apply stamps
 * the picked built-in, and save-as stores the clip's style. Radix Select
 * portals never mount in jsdom, so picking an option and the rename/delete
 * wiring are locked with static-source assertions below, the same split the
 * dip-to-black picker used.
 */

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

function docWithSelectedTextClip(): { doc: Doc; clipId: string } {
  const clip = createTextClip({ id: 'clip_title', text: 'Hello' })
  const track = createTrack('text', 1, { clips: [clip as Clip] })
  const doc: Doc = {
    project: { tracks: [track], id: 'p_test', name: 'test', width: 1920, height: 1080, fps: 30 },
    media: [],
  }
  useEditorStore.setState({ doc, selection: clip.id, selections: [clip.id], playhead: 1 })
  return { doc, clipId: clip.id }
}

describe('title preset section', () => {
  it('renders for a selected text clip, with the Title built-in picked', () => {
    docWithSelectedTextClip()
    render(<InspectorPanel />)
    expect(screen.getByText('Presets')).toBeInTheDocument()
    expect(screen.getByLabelText('Title preset')).toHaveTextContent('Title')
    expect(screen.getByRole('button', { name: 'Apply preset' })).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Preset name')).toBeInTheDocument()
  })

  it('apply stamps the picked built-in style and keeps the clip text', () => {
    docWithSelectedTextClip()
    render(<InspectorPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Apply preset' }))
    const clip = useEditorStore.getState().doc.project.tracks[0].clips[0]
    expect(clip.style?.fontSize).toBe(96)
    expect(clip.style?.y).toBe(0.38)
    expect(clip.text).toBe('Hello')
  })

  it('save-as stores the clip style and a duplicate name stores nothing', () => {
    docWithSelectedTextClip()
    render(<InspectorPanel />)
    fireEvent.change(screen.getByPlaceholderText('Preset name'), { target: { value: 'Opener' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    let presets = useEditorStore.getState().doc.project.textPresets ?? []
    expect(presets).toHaveLength(1)
    expect(presets[0].name).toBe('Opener')
    expect(presets[0].style).toEqual(useEditorStore.getState().doc.project.tracks[0].clips[0].style)
    // A duplicate name refuses: the library is unchanged.
    fireEvent.change(screen.getByPlaceholderText('Preset name'), { target: { value: 'opener' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    presets = useEditorStore.getState().doc.project.textPresets ?? []
    expect(presets).toHaveLength(1)
  })
})

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

describe('title preset static wiring', () => {
  const panel = read('src/components/editor/InspectorPanel.tsx')
  const toolbar = read('src/components/editor/Toolbar.tsx')
  const actions = read('src/lib/editor/actions.ts')

  it('the Inspector manages user presets through the three preset commands', () => {
    expect(panel).toMatch(/type: 'saveTextPreset'/)
    expect(panel).toMatch(/type: 'renameTextPreset'/)
    expect(panel).toMatch(/type: 'deleteTextPreset'/)
    // Rename/delete render only for a user preset, never for a built-in.
    expect(panel).toMatch(/isUserPreset/)
    // Deleting falls back to the first built-in selection.
    expect(panel).toMatch(/setSelectedId\(builtins\[0\]\.id\)/)
    // Switching presets clears a typed rename, so stale text can never
    // rename the newly picked preset.
    expect(panel).toMatch(/setSelectedId\(id\)/)
    expect(panel).toMatch(/setRenameName\(''\)/)
  })

  it('the toolbar picker creates styled clips through the shared placement path', () => {
    expect(toolbar).toMatch(/aria-label="Add text with preset style"/)
    expect(toolbar).toMatch(/createBuiltinTextPresets\(\)/)
    expect(toolbar).toMatch(/onSelect=\{?\(\) => addTextWithStyle\(preset\.style\)\}?/)
    expect(toolbar).toMatch(/Default style/)
    expect(actions).toMatch(/style\?: TextStyle/)
  })
})
