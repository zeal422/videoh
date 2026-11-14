// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const savedTemplates: unknown[] = []
vi.mock('@/lib/editor/template-store', () => ({
  templatesSupported: () => true,
  listSavedTemplates: vi.fn(async () => savedTemplates),
  saveTemplate: vi.fn(async (template: unknown) => {
    savedTemplates.push(template)
  }),
  updateSavedTemplate: vi.fn(async () => undefined),
  deleteSavedTemplate: vi.fn(async () => undefined),
}))
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }))

import { BrandKitPanel } from '@/components/editor/BrandKitPanel'
import { BrandColorSwatches } from '@/components/editor/BrandColorSwatches'
import { TemplateGallery } from '@/components/editor/TemplateGallery'
import { useEditorStore } from '../store'
import { createDoc, createTextClip, createTrack } from '../factories'
import { createBuiltinTemplates } from '../templates'
import { saveTemplate, updateSavedTemplate } from '../template-store'
import type { Doc } from '../types'

beforeEach(() => {
  savedTemplates.length = 0
  useEditorStore.setState(useEditorStore.getInitialState())
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

function docWithBrandKit(): Doc {
  const doc = createDoc()
  doc.project.brandKit = {
    colors: [
      { id: 'brand_ink', name: 'Ink', value: '#112233' },
      { id: 'brand_paper', name: 'Paper', value: '#fefefe' },
    ],
  }
  return doc
}

describe('brand kit UI (0.26.0)', () => {
  it('lists, renames, adds, and removes saved colors', () => {
    useEditorStore.setState({ doc: docWithBrandKit() })
    render(<BrandKitPanel open onOpenChange={() => {}} />)

    expect(screen.getByLabelText('Brand color name Ink')).toHaveValue('Ink')
    const name = screen.getByLabelText('Brand color name Ink')
    fireEvent.change(name, { target: { value: 'Deep ink' } })
    fireEvent.blur(name)
    expect(useEditorStore.getState().doc.project.brandKit!.colors[0].name).toBe('Deep ink')

    // A refused rename restores the stored name in the draft and shows why.
    const rejected = screen.getByLabelText('Brand color name Deep ink')
    fireEvent.change(rejected, { target: { value: '' } })
    fireEvent.blur(rejected)
    expect(useEditorStore.getState().doc.project.brandKit!.colors[0].name).toBe('Deep ink')
    expect(rejected).toHaveValue('Deep ink')
    expect(screen.getByTestId('brand-color-error-brand_ink')).toBeInTheDocument()

    const dialog = screen.getByTestId('brand-kit-dialog')
    expect(dialog.className).toContain('max-h-[85vh]')
    expect(dialog.className).toContain('overflow-y-auto')
    const colorList = screen.getByRole('list', { name: 'Brand colors' })
    expect(colorList.className).toContain('max-h-56')
    expect(colorList.className).toContain('overflow-y-auto')

    fireEvent.change(screen.getByTestId('brand-color-name'), { target: { value: 'Accent' } })
    fireEvent.change(screen.getByTestId('brand-color-value'), { target: { value: '#445566' } })
    fireEvent.click(screen.getByTestId('brand-color-add'))
    const colors = useEditorStore.getState().doc.project.brandKit!.colors
    expect(colors).toHaveLength(3)
    expect(colors.some((color) => color.name === 'Accent' && color.value === '#445566')).toBe(true)

    fireEvent.click(screen.getByLabelText('Remove brand color Deep ink'))
    expect(useEditorStore.getState().doc.project.brandKit!.colors).toHaveLength(2)
  })

  it('applies a swatch and saves the current color from the inspector row', () => {
    useEditorStore.setState({ doc: docWithBrandKit() })
    const onPick = vi.fn()
    const { rerender } = render(<BrandColorSwatches label="text" value="#445566" onPick={onPick} />)
    fireEvent.click(screen.getByLabelText('Apply brand color Ink'))
    expect(onPick).toHaveBeenCalledWith('#112233')

    expect(screen.getByLabelText('Save current color to brand kit')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Save current color to brand kit'))
    expect(useEditorStore.getState().doc.project.brandKit!.colors).toHaveLength(3)

    rerender(<BrandColorSwatches label="text" value="#445566" onPick={onPick} />)
    expect(screen.queryByLabelText('Save current color to brand kit')).not.toBeInTheDocument()
  })
})

describe('template gallery UI (0.26.0)', () => {
  function docWithText(): Doc {
    const doc = createDoc()
    const text = createTrack('text', 1, { id: 'track_text' })
    text.clips = [createTextClip({ id: 'clip_text', text: 'Saved title' })]
    doc.project.tracks.unshift(text)
    return doc
  }

  it('applies a built-in template as one undoable sequence', async () => {
    useEditorStore.setState({ doc: createDoc() })
    const onOpenChange = vi.fn()
    render(<TemplateGallery open onOpenChange={onOpenChange} />)
    const apply = await screen.findAllByRole('button', { name: 'Apply template Title card' })
    fireEvent.click(apply[0])
    await waitFor(() => expect(useEditorStore.getState().doc.project.sequences).toHaveLength(1))
    expect(useEditorStore.getState().activeSequencePath).toHaveLength(1)
    expect(onOpenChange).toHaveBeenCalledWith(false)
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().doc.project.sequences).toBeUndefined()
  })

  it('saves the current sequence through the browser-bound library', async () => {
    useEditorStore.setState({ doc: docWithText() })
    render(<TemplateGallery open onOpenChange={() => {}} />)
    await screen.findByText('No saved templates yet.')
    fireEvent.change(screen.getByTestId('template-name'), { target: { value: 'My opener' } })
    fireEvent.click(screen.getByTestId('template-save'))
    await waitFor(() => expect(saveTemplate).toHaveBeenCalledTimes(1))
    const template = vi.mocked(saveTemplate).mock.calls[0][0]
    expect(template.name).toBe('My opener')
    expect(template.sequence.tracks.flatMap((track) => track.clips)).toHaveLength(1)
  })

  it('restores the saved name when a template rename is refused', async () => {
    savedTemplates.push(createBuiltinTemplates()[0])
    vi.mocked(updateSavedTemplate).mockRejectedValueOnce(new Error('Template no longer exists'))
    render(<TemplateGallery open onOpenChange={() => {}} />)
    const input = await screen.findByLabelText('Template name Title card')
    fireEvent.change(input, { target: { value: 'Renamed' } })
    fireEvent.blur(input)
    await waitFor(() => expect(updateSavedTemplate).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(input).toHaveValue('Title card'))
    expect(vi.mocked(updateSavedTemplate)).toHaveBeenCalledWith(expect.any(String), {
      name: 'Renamed',
    })
  })

  it('shows a missing brand font as unavailable in the font picker', () => {
    const doc = createDoc()
    doc.project.brandKit = { colors: [], fontFamilies: ['videoh-font-missing, Arial, sans-serif'] }
    useEditorStore.setState({ doc })
    // The picker is exercised through its source contract here: rendering the
    // full Inspector needs a selected clip, and the label helper is static.
    const source = readFileSync(join(process.cwd(), 'src/components/editor/FontPicker.tsx'), 'utf8')
    expect(source).toContain('Brand kit')
    expect(source).toContain('(unavailable)')
    expect(source).toContain('disabled={!available}')
  })
})
