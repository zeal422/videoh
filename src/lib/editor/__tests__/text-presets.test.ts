/**
 * Anti-regression tests for title presets (0.8.3): the built-in library,
 * the save/rename/delete commands and their name rule, and applying a
 * preset through the existing setTextStyle command.
 */
import { describe, expect, it } from 'vitest'

import {
  applyCommand,
  EditorCommandError,
  normalizePresetName,
  TEXT_PRESET_NAME_MAX,
} from '../commands'
import { createBuiltinTextPresets, createDoc, createTextClip, createTrack } from '../factories'
import type { Doc, TextPreset, TextStyle } from '../types'

const STYLE_KEYS: (keyof TextStyle)[] = [
  'fontSize',
  'color',
  'fontFamily',
  'bold',
  'italic',
  'align',
  'x',
  'y',
  'shadow',
]

function preset(over: Partial<TextPreset> = {}): TextPreset {
  return {
    id: 'preset_user_1',
    name: 'My preset',
    style: createBuiltinTextPresets()[0].style,
    ...over,
  }
}

/** A doc with one text track holding one text clip. */
function textDoc(): { doc: Doc; clipId: string } {
  const doc = createDoc()
  const track = createTrack('text', 1)
  const clip = createTextClip({ id: 'clip_text_1', text: 'Hello' })
  track.clips = [clip]
  doc.project.tracks = [track, ...doc.project.tracks]
  return { doc, clipId: clip.id }
}

describe('createBuiltinTextPresets', () => {
  it('ships four entries with stable ids, names and full styles', () => {
    const builtins = createBuiltinTextPresets()
    expect(builtins.map((p) => p.id)).toEqual([
      'preset_builtin_title',
      'preset_builtin_subtitle',
      'preset_builtin_lower_third',
      'preset_builtin_caption',
    ])
    expect(builtins.map((p) => p.name)).toEqual(['Title', 'Subtitle', 'Lower third', 'Caption'])
    for (const p of builtins) {
      expect(Object.keys(p.style).sort()).toEqual([...STYLE_KEYS].sort())
    }
  })

  it('returns a fresh list on every call', () => {
    const a = createBuiltinTextPresets()
    const b = createBuiltinTextPresets()
    expect(a).toEqual(b)
    expect(a).not.toBe(b)
    expect(a[0]).not.toBe(b[0])
  })
})

describe('normalizePresetName', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizePresetName('  Title  ')).toBe('Title')
  })
})

describe('saveTextPreset', () => {
  it('saves onto the project and leaves the input doc untouched', () => {
    const doc = createDoc()
    const next = applyCommand(doc, { type: 'saveTextPreset', preset: preset() })
    expect(next.project.textPresets).toHaveLength(1)
    expect(next.project.textPresets![0]).toEqual(preset())
    expect(doc.project.textPresets).toBeUndefined()
  })

  it('refuses an empty name', () => {
    const doc = createDoc()
    expect(() =>
      applyCommand(doc, { type: 'saveTextPreset', preset: preset({ name: '   ' }) }),
    ).toThrow(EditorCommandError)
  })

  it('refuses an overlong name', () => {
    const doc = createDoc()
    expect(() =>
      applyCommand(doc, {
        type: 'saveTextPreset',
        preset: preset({ name: `x`.repeat(TEXT_PRESET_NAME_MAX + 1) }),
      }),
    ).toThrow(EditorCommandError)
  })

  it('refuses a duplicate name, trimmed and case-insensitive', () => {
    let doc = createDoc()
    doc = applyCommand(doc, { type: 'saveTextPreset', preset: preset({ name: 'Opener' }) })
    expect(() =>
      applyCommand(doc, { type: 'saveTextPreset', preset: preset({ name: '  opener ' }) }),
    ).toThrow(EditorCommandError)
  })

  it('refuses shadowing a built-in name', () => {
    const doc = createDoc()
    expect(() =>
      applyCommand(doc, { type: 'saveTextPreset', preset: preset({ name: 'title' }) }),
    ).toThrow(EditorCommandError)
  })

  it('refuses a duplicate id', () => {
    let doc = createDoc()
    doc = applyCommand(doc, { type: 'saveTextPreset', preset: preset() })
    expect(() =>
      applyCommand(doc, { type: 'saveTextPreset', preset: preset({ name: 'Other' }) }),
    ).toThrow(EditorCommandError)
  })

  it('refuses a built-in id', () => {
    const doc = createDoc()
    expect(() =>
      applyCommand(doc, {
        type: 'saveTextPreset',
        preset: preset({ id: 'preset_builtin_title', name: 'Sneaky' }),
      }),
    ).toThrow(EditorCommandError)
  })

  it('falls NaN style values back to the defaults on save', () => {
    const doc = createDoc()
    const next = applyCommand(doc, {
      type: 'saveTextPreset',
      preset: preset({
        name: 'Not a number',
        style: { ...createBuiltinTextPresets()[0].style, fontSize: NaN, x: NaN, y: NaN },
      }),
    })
    // NaN survives Math.min/Math.max, so the fallback runs before the clamp.
    expect(next.project.textPresets![0].style.fontSize).toBe(64)
    expect(next.project.textPresets![0].style.x).toBe(0.5)
    expect(next.project.textPresets![0].style.y).toBe(0.5)
  })

  it('normalizes an out-of-range style on save, so it applies safely', () => {
    const { doc, clipId } = textDoc()
    const wild = {
      ...createBuiltinTextPresets()[0].style,
      fontSize: -1e300,
      x: 7,
      y: -4,
    }
    const saved = applyCommand(doc, {
      type: 'saveTextPreset',
      preset: preset({ name: 'Wild', style: wild }),
    })
    // The library holds the collapsed style, and the caller's object is
    // untouched (the command clones).
    expect(saved.project.textPresets![0].style).toEqual({
      ...wild,
      fontSize: 8,
      x: 1,
      y: 0,
    })
    expect(wild.fontSize).toBe(-1e300)
    const applied = applyCommand(saved, {
      type: 'setTextStyle',
      clipId,
      style: saved.project.textPresets![0].style,
    })
    const track = applied.project.tracks.find((t) => t.kind === 'text')!
    expect(track.clips[0].style?.fontSize).toBe(8)
    expect(track.clips[0].style?.x).toBe(1)
    expect(track.clips[0].style?.y).toBe(0)
  })
})

describe('renameTextPreset', () => {
  it('renames and keeps the style', () => {
    let doc = createDoc()
    doc = applyCommand(doc, { type: 'saveTextPreset', preset: preset() })
    const next = applyCommand(doc, {
      type: 'renameTextPreset',
      presetId: 'preset_user_1',
      name: 'Renamed',
    })
    expect(next.project.textPresets![0].name).toBe('Renamed')
    expect(next.project.textPresets![0].style).toEqual(preset().style)
  })

  it('accepts renaming to the same name', () => {
    let doc = createDoc()
    doc = applyCommand(doc, { type: 'saveTextPreset', preset: preset() })
    const next = applyCommand(doc, {
      type: 'renameTextPreset',
      presetId: 'preset_user_1',
      name: 'My preset',
    })
    expect(next.project.textPresets![0].name).toBe('My preset')
  })

  it('refuses unknown ids, including built-in ids', () => {
    const doc = createDoc()
    expect(() =>
      applyCommand(doc, { type: 'renameTextPreset', presetId: 'preset_nope', name: 'X' }),
    ).toThrow(EditorCommandError)
    expect(() =>
      applyCommand(doc, {
        type: 'renameTextPreset',
        presetId: 'preset_builtin_title',
        name: 'X',
      }),
    ).toThrow(EditorCommandError)
  })

  it('refuses empty and duplicate names', () => {
    let doc = createDoc()
    doc = applyCommand(doc, { type: 'saveTextPreset', preset: preset() })
    doc = applyCommand(doc, {
      type: 'saveTextPreset',
      preset: preset({ id: 'preset_user_2', name: 'Second' }),
    })
    expect(() =>
      applyCommand(doc, { type: 'renameTextPreset', presetId: 'preset_user_1', name: '' }),
    ).toThrow(EditorCommandError)
    expect(() =>
      applyCommand(doc, {
        type: 'renameTextPreset',
        presetId: 'preset_user_1',
        name: 'second',
      }),
    ).toThrow(EditorCommandError)
  })
})

describe('deleteTextPreset', () => {
  it('deletes and leaves an empty list for the last preset', () => {
    let doc = createDoc()
    doc = applyCommand(doc, { type: 'saveTextPreset', preset: preset() })
    const next = applyCommand(doc, { type: 'deleteTextPreset', presetId: 'preset_user_1' })
    expect(next.project.textPresets).toEqual([])
  })

  it('refuses unknown ids, including built-in ids', () => {
    const doc = createDoc()
    expect(() => applyCommand(doc, { type: 'deleteTextPreset', presetId: 'preset_nope' })).toThrow(
      EditorCommandError,
    )
    expect(() =>
      applyCommand(doc, { type: 'deleteTextPreset', presetId: 'preset_builtin_title' }),
    ).toThrow(EditorCommandError)
  })
})

describe('applying a preset', () => {
  it('stamps the full style and keeps the clip text', () => {
    const { doc, clipId } = textDoc()
    const style = createBuiltinTextPresets()[2].style
    const next = applyCommand(doc, { type: 'setTextStyle', clipId, style })
    const clip = next.project.tracks[0].clips[0]
    expect(clip.style).toEqual(style)
    expect(clip.text).toBe('Hello')
  })
})
