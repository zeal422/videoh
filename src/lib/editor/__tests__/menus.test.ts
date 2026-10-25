/**
 * Anti-regression tests for the menu bar model (menus.ts).
 *
 * Guards:
 * 1. The menu bar keeps the Premiere Pro–style structure (menu order + labels).
 * 2. Every item is well-formed: unique ids, a label + action (except
 *    separators), shortcuts only where a global keybinding really exists.
 * 3. Enabled/checked logic reacts correctly to the editor context
 *    (undo/redo depth, selection, split validity, snap state, panel visibility).
 */
import { describe, expect, it } from 'vitest'

import { buildMenus, collectMenuActions, MENU_SPECS, type MenuContext } from '../menus'
import { defaultWorkspace, type PanelId } from '../workspace'

/** Menu bar order mirrors Adobe Premiere Pro's top menu (adapted to the app). */
const EXPECTED_MENU_ORDER = [
  'File',
  'Edit',
  'Clip',
  'Sequence',
  'Marker',
  'Graphics',
  'View',
  'Window',
  'Help',
]

/** Shortcuts displayed in the menu MUST be wired globally (no dead hints). */
const REAL_SHORTCUTS = new Set([
  'Ctrl+Z',
  'Ctrl+Shift+Z',
  'Ctrl+S',
  'Ctrl+X',
  'Ctrl+C',
  'Ctrl+V',
  'Ctrl+K',
  'Ctrl+L',
  'Ctrl+A',
  'Ctrl+Shift+A',
  'S',
  'D',
  'Del',
  'Shift+Del',
  'M',
  'Shift+M',
  'Ctrl+Shift+M',
  'Shift+E',
  'T',
  '+',
  '−',
  '\\',
])

function baseCtx(overrides: Partial<MenuContext> = {}): MenuContext {
  return {
    canUndo: false,
    canRedo: false,
    hasSelection: false,
    selectionCount: 0,
    hasClips: false,
    canSplit: false,
    selectionHasAudio: false,
    selectionMuted: false,
    canPaste: false,
    selectionLinked: false,
    canLink: false,
    canCreateCompound: false,
    hasMarkers: false,
    hasSelectedMarker: false,
    // The base context is the project root, where Add Marker is always possible.
    canAddMarker: true,
    snapEnabled: true,
    proxiesEnabled: false,
    panelHidden: {
      media: false,
      preview: false,
      source: false,
      inspector: false,
      timeline: false,
      captions: false,
    },
    workspaceDirty: false,
    isMobile: false,
    ...overrides,
  }
}

function findMenu(label: string) {
  const menu = MENU_SPECS.find((m) => m.label === label)
  expect(menu, `menu "${label}" exists`).toBeDefined()
  return menu!
}

function itemOf(label: string, itemId: string) {
  const menu = findMenu(label)
  const item = menu.items.find((i) => i.id === itemId)
  expect(item, `"${label}" > "${itemId}" exists`).toBeDefined()
  return item!
}

describe('menu structure (Premiere Pro–style)', () => {
  it('has the canonical menu order', () => {
    expect(MENU_SPECS.map((m) => m.label)).toEqual(EXPECTED_MENU_ORDER)
  })

  it('gives every menu a unique id and non-empty item list', () => {
    const ids = new Set(MENU_SPECS.map((m) => m.id))
    expect(ids.size).toBe(MENU_SPECS.length)
    for (const menu of MENU_SPECS) {
      expect(menu.items.length).toBeGreaterThan(0)
    }
  })

  it('every item is well-formed: unique id, valid kind, action + label unless separator', () => {
    const seenIds = new Set<string>()
    const knownActions = new Set(collectMenuActions())
    for (const menu of MENU_SPECS) {
      for (const item of menu.items) {
        expect(seenIds.has(item.id), `duplicate item id ${item.id}`).toBe(false)
        seenIds.add(item.id)
        expect(['item', 'separator', 'checkbox']).toContain(item.kind)
        if (item.kind === 'separator') {
          expect(item.label).toBeUndefined()
          expect(item.action).toBeUndefined()
        } else {
          expect(item.label?.length ?? 0).toBeGreaterThan(0)
          expect(item.action, `${item.id} needs an action`).toBeDefined()
          expect(knownActions.has(item.action!)).toBe(true)
        }
        if (item.shortcut) {
          expect(
            REAL_SHORTCUTS.has(item.shortcut),
            `${item.id} shows shortcut "${item.shortcut}" that is not wired globally`,
          ).toBe(true)
        }
      }
    }
  })

  it('File menu exposes the project lifecycle actions', () => {
    expect(itemOf('File', 'file.new').action).toBe('file.newProject')
    expect(itemOf('File', 'file.open').action).toBe('file.openProject')
    expect(itemOf('File', 'file.import').action).toBe('file.importMedia')
    expect(itemOf('File', 'file.save').action).toBe('file.saveProject')
    expect(itemOf('File', 'file.save').shortcut).toBe('Ctrl+S')
    expect(itemOf('File', 'file.export').action).toBe('file.exportMedia')
  })

  it('Edit menu wires undo/redo/select-all/deselect', () => {
    expect(itemOf('Edit', 'edit.undo').action).toBe('edit.undo')
    expect(itemOf('Edit', 'edit.redo').action).toBe('edit.redo')
    expect(itemOf('Edit', 'edit.selectAll').action).toBe('edit.selectAll')
    expect(itemOf('Edit', 'edit.selectAll').shortcut).toBe('Ctrl+A')
    expect(itemOf('Edit', 'edit.deselect').action).toBe('edit.deselectAll')
    expect(itemOf('Edit', 'edit.deselect').shortcut).toBe('Ctrl+Shift+A')
  })

  it('Clip menu exposes split/duplicate/delete/ripple/cut/copy/paste/link/unlink/mute/gain', () => {
    expect(itemOf('Clip', 'clip.split').shortcut).toBe('Ctrl+K') // Premiere Add Edit
    expect(itemOf('Clip', 'clip.duplicate').shortcut).toBe('D')
    expect(itemOf('Clip', 'clip.delete').shortcut).toBe('Del')
    expect(itemOf('Clip', 'clip.rippleDelete').action).toBe('clip.rippleDelete')
    expect(itemOf('Clip', 'clip.rippleDelete').shortcut).toBe('Shift+Del')
    expect(itemOf('Clip', 'clip.cut').action).toBe('clip.cut')
    expect(itemOf('Clip', 'clip.cut').shortcut).toBe('Ctrl+X')
    expect(itemOf('Clip', 'clip.copy').action).toBe('clip.copy')
    expect(itemOf('Clip', 'clip.copy').shortcut).toBe('Ctrl+C')
    expect(itemOf('Clip', 'clip.paste').action).toBe('clip.paste')
    expect(itemOf('Clip', 'clip.paste').shortcut).toBe('Ctrl+V')
    expect(itemOf('Clip', 'clip.link').action).toBe('clip.link')
    expect(itemOf('Clip', 'clip.link').shortcut).toBe('Ctrl+L')
    expect(itemOf('Clip', 'clip.unlink').action).toBe('clip.unlink')
    expect(itemOf('Clip', 'clip.unlink').shortcut).toBe('Ctrl+L')
    expect(itemOf('Clip', 'clip.mute').kind).toBe('checkbox')
    expect(itemOf('Clip', 'clip.mute').shortcut).toBe('Shift+E')
    expect(itemOf('Clip', 'clip.gain').action).toBe('clip.audioGain')
  })

  it('View menu exposes zoom-to-fit + snap with their Premiere shortcuts', () => {
    expect(itemOf('View', 'view.zoomFit').action).toBe('view.zoomFit')
    expect(itemOf('View', 'view.zoomFit').shortcut).toBe('\\')
    expect(itemOf('View', 'view.snap').shortcut).toBe('S')
  })

  it('Sequence menu offers track management + settings', () => {
    expect(itemOf('Sequence', 'sequence.addVideoTrack').action).toBe('sequence.addVideoTrack')
    expect(itemOf('Sequence', 'sequence.addAudioTrack').action).toBe('sequence.addAudioTrack')
    expect(itemOf('Sequence', 'sequence.addTextTrack').action).toBe('sequence.addTextTrack')
    expect(itemOf('Sequence', 'sequence.settings').action).toBe('sequence.settings')
  })

  it('Window menu toggles all six workspace panels + reset', () => {
    const menu = findMenu('Window')
    const toggles = menu.items.filter((i) => i.kind === 'checkbox')
    expect(toggles.map((i) => i.action)).toEqual([
      'window.toggleMedia',
      'window.togglePreview',
      'window.toggleSource',
      'window.toggleInspector',
      'window.toggleTimeline',
      'window.toggleCaptions',
    ])
    expect(itemOf('Window', 'window.source').label).toBe('Source Monitor')
    expect(itemOf('Window', 'window.reset').action).toBe('window.resetLayout')
  })

  it('only the release-notes entry is tinted (green highlight in the Help menu)', () => {
    const tinted = MENU_SPECS.flatMap((m) => m.items.filter((i) => i.tinted))
    expect(tinted.map((i) => i.id)).toEqual(['help.releaseNotes'])
    expect(itemOf('Help', 'help.releaseNotes').label).toMatch(/What's new in .+…$/)
  })

  it('collectMenuActions returns one entry per actionable item', () => {
    const actions = collectMenuActions()
    const expected = MENU_SPECS.flatMap((m) =>
      m.items.filter((i) => i.action).map((i) => i.action!),
    )
    expect(actions).toEqual(expected)
  })

  it('exposes Appearance in the View menu without a shortcut', () => {
    const item = itemOf('View', 'view.appearance')
    expect(item.label).toBe('Appearance…')
    expect(item.shortcut).toBeUndefined()
  })
})

describe('menu state resolution (buildMenus)', () => {
  it('undo/redo are disabled without history, enabled with it', () => {
    const disabled = buildMenus(baseCtx())
    const editMenu = disabled.find((m) => m.spec.id === 'edit')!
    expect(editMenu.items.find((i) => i.spec.id === 'edit.undo')!.enabled).toBe(false)
    expect(editMenu.items.find((i) => i.spec.id === 'edit.redo')!.enabled).toBe(false)

    const enabled = buildMenus(baseCtx({ canUndo: true, canRedo: true }))
    const editMenu2 = enabled.find((m) => m.spec.id === 'edit')!
    expect(editMenu2.items.find((i) => i.spec.id === 'edit.undo')!.enabled).toBe(true)
    expect(editMenu2.items.find((i) => i.spec.id === 'edit.redo')!.enabled).toBe(true)
  })

  it('clip actions follow selection state', () => {
    const noSelection = buildMenus(baseCtx())
    const clipMenu = noSelection.find((m) => m.spec.id === 'clip')!
    for (const id of [
      'clip.split',
      'clip.duplicate',
      'clip.delete',
      'clip.cut',
      'clip.copy',
      'clip.unlink',
      'clip.mute',
      'clip.gain',
    ]) {
      expect(clipMenu.items.find((i) => i.spec.id === id)!.enabled).toBe(false)
    }

    // Selected but playhead outside the clip: split stays disabled.
    const selected = buildMenus(baseCtx({ hasSelection: true, selectionHasAudio: true }))
    const clipMenu2 = selected.find((m) => m.spec.id === 'clip')!
    expect(clipMenu2.items.find((i) => i.spec.id === 'clip.split')!.enabled).toBe(false)
    expect(clipMenu2.items.find((i) => i.spec.id === 'clip.duplicate')!.enabled).toBe(true)
    expect(clipMenu2.items.find((i) => i.spec.id === 'clip.gain')!.enabled).toBe(true)

    // Playhead inside: split enables.
    const splittable = buildMenus(baseCtx({ hasSelection: true, canSplit: true }))
    const clipMenu3 = splittable.find((m) => m.spec.id === 'clip')!
    expect(clipMenu3.items.find((i) => i.spec.id === 'clip.split')!.enabled).toBe(true)
  })

  it('paste follows the clipboard and unlink follows the A/V link', () => {
    const empty = buildMenus(baseCtx({ hasSelection: true }))
    const clipMenu = empty.find((m) => m.spec.id === 'clip')!
    expect(clipMenu.items.find((i) => i.spec.id === 'clip.paste')!.enabled).toBe(false)
    expect(clipMenu.items.find((i) => i.spec.id === 'clip.unlink')!.enabled).toBe(false)

    const full = buildMenus(baseCtx({ canPaste: true, selectionLinked: true }))
    const clipMenu2 = full.find((m) => m.spec.id === 'clip')!
    expect(clipMenu2.items.find((i) => i.spec.id === 'clip.paste')!.enabled).toBe(true)
    expect(clipMenu2.items.find((i) => i.spec.id === 'clip.unlink')!.enabled).toBe(true)
  })

  it('Link enables for ≥2 clips in distinct groups, never for a single/merged selection', () => {
    const noSelection = buildMenus(baseCtx())
    const clipMenu = noSelection.find((m) => m.spec.id === 'clip')!
    expect(clipMenu.items.find((i) => i.spec.id === 'clip.link')!.enabled).toBe(false)

    const multi = buildMenus(baseCtx({ hasSelection: true, selectionCount: 2, canLink: true }))
    const clipMenu2 = multi.find((m) => m.spec.id === 'clip')!
    expect(clipMenu2.items.find((i) => i.spec.id === 'clip.link')!.enabled).toBe(true)
  })

  it('Select All follows hasClips; Ripple Delete follows hasSelection', () => {
    const empty = buildMenus(baseCtx())
    const editMenu = empty.find((m) => m.spec.id === 'edit')!
    expect(editMenu.items.find((i) => i.spec.id === 'edit.selectAll')!.enabled).toBe(false)
    const clipMenu = empty.find((m) => m.spec.id === 'clip')!
    expect(clipMenu.items.find((i) => i.spec.id === 'clip.rippleDelete')!.enabled).toBe(false)

    const clips = buildMenus(baseCtx({ hasClips: true, hasSelection: true, selectionCount: 1 }))
    const editMenu2 = clips.find((m) => m.spec.id === 'edit')!
    expect(editMenu2.items.find((i) => i.spec.id === 'edit.selectAll')!.enabled).toBe(true)
    const clipMenu2 = clips.find((m) => m.spec.id === 'clip')!
    expect(clipMenu2.items.find((i) => i.spec.id === 'clip.rippleDelete')!.enabled).toBe(true)
  })

  it('mute checkbox mirrors selectionHasAudio + selectionMuted', () => {
    const ctx = baseCtx({ hasSelection: true, selectionHasAudio: true, selectionMuted: true })
    const menus = buildMenus(ctx)
    const mute = menus
      .find((m) => m.spec.id === 'clip')!
      .items.find((i) => i.spec.id === 'clip.mute')!
    expect(mute.enabled).toBe(true)
    expect(mute.checked).toBe(true)
  })

  it('text-only selection disables audio items', () => {
    const ctx = baseCtx({ hasSelection: true, selectionHasAudio: false })
    const clipMenu = buildMenus(ctx).find((m) => m.spec.id === 'clip')!
    expect(clipMenu.items.find((i) => i.spec.id === 'clip.mute')!.enabled).toBe(false)
    expect(clipMenu.items.find((i) => i.spec.id === 'clip.gain')!.enabled).toBe(false)
  })

  it('snap checkbox mirrors snapEnabled', () => {
    const on = buildMenus(baseCtx({ snapEnabled: true }))
    const snapOn = on
      .find((m) => m.spec.id === 'view')!
      .items.find((i) => i.spec.id === 'view.snap')!
    expect(snapOn.checked).toBe(true)

    const off = buildMenus(baseCtx({ snapEnabled: false }))
    const snapOff = off
      .find((m) => m.spec.id === 'view')!
      .items.find((i) => i.spec.id === 'view.snap')!
    expect(snapOff.checked).toBe(false)
  })

  it('Window checkboxes reflect panel visibility (checked = visible)', () => {
    const hiddenPanels: Partial<Record<PanelId, boolean>> = {
      media: true,
      inspector: true,
      source: true,
    }
    const ctx = baseCtx({
      panelHidden: { ...defaultWorkspace().hidden, ...hiddenPanels } as MenuContext['panelHidden'],
    })
    const window = buildMenus(ctx).find((m) => m.spec.id === 'window')!
    expect(window.items.find((i) => i.spec.id === 'window.media')!.checked).toBe(false)
    expect(window.items.find((i) => i.spec.id === 'window.inspector')!.checked).toBe(false)
    expect(window.items.find((i) => i.spec.id === 'window.source')!.checked).toBe(false)
    expect(window.items.find((i) => i.spec.id === 'window.preview')!.checked).toBe(true)
    expect(window.items.find((i) => i.spec.id === 'window.timeline')!.checked).toBe(true)
    expect(window.items.find((i) => i.spec.id === 'window.captions')!.checked).toBe(true)
  })

  it('Window panel toggles disable on mobile (no workspace panels there)', () => {
    const menus = buildMenus(baseCtx({ isMobile: true }))
    const window = menus.find((m) => m.spec.id === 'window')!
    const toggles = window.items.filter((i) => i.spec.kind === 'checkbox')
    expect(toggles.map((i) => i.spec.id)).toContain('window.captions')
    for (const item of toggles) expect(item.enabled).toBe(false)
    const desktop = buildMenus(baseCtx({ isMobile: false }))
    const desktopToggles = desktop
      .find((m) => m.spec.id === 'window')!
      .items.filter((i) => i.spec.kind === 'checkbox')
    for (const item of desktopToggles) expect(item.enabled).toBe(true)
  })

  it('reset layout is enabled whenever the workspace deviates from defaults', () => {
    const allVisible = buildMenus(baseCtx())
    const resetDefault = allVisible
      .find((m) => m.spec.id === 'window')!
      .items.find((i) => i.spec.id === 'window.reset')!
    expect(resetDefault.enabled).toBe(false)

    // A hidden panel counts as dirty…
    const oneHidden = buildMenus(
      baseCtx({
        panelHidden: {
          media: true,
          preview: false,
          source: false,
          inspector: false,
          timeline: false,
          captions: false,
        },
        workspaceDirty: true,
      }),
    )
    const resetHidden = oneHidden
      .find((m) => m.spec.id === 'window')!
      .items.find((i) => i.spec.id === 'window.reset')!
    expect(resetHidden.enabled).toBe(true)

    // …and so does a resized/collapsed workspace with everything visible.
    const resized = buildMenus(baseCtx({ workspaceDirty: true }))
    const resetResized = resized
      .find((m) => m.spec.id === 'window')!
      .items.find((i) => i.spec.id === 'window.reset')!
    expect(resetResized.enabled).toBe(true)
  })

  it('items without predicates are always enabled (e.g. File > Save)', () => {
    const menus = buildMenus(baseCtx())
    const save = menus
      .find((m) => m.spec.id === 'file')!
      .items.find((i) => i.spec.id === 'file.save')!
    expect(save.enabled).toBe(true)
  })

  it('Marker menu exposes add/edit/delete and navigation actions', () => {
    expect(itemOf('Marker', 'marker.add').action).toBe('marker.add')
    expect(itemOf('Marker', 'marker.add').shortcut).toBe('M')
    expect(itemOf('Marker', 'marker.edit').action).toBe('marker.edit')
    expect(itemOf('Marker', 'marker.delete').action).toBe('marker.delete')
    expect(itemOf('Marker', 'marker.next').action).toBe('marker.next')
    expect(itemOf('Marker', 'marker.next').shortcut).toBe('Shift+M')
    expect(itemOf('Marker', 'marker.previous').action).toBe('marker.previous')
    expect(itemOf('Marker', 'marker.previous').shortcut).toBe('Ctrl+Shift+M')
  })

  it('Marker menu enables edit/delete only with a selected marker', () => {
    const none = buildMenus(baseCtx())
    const markerMenu = none.find((m) => m.spec.id === 'marker')!
    const enabledOf = (id: string) => markerMenu.items.find((i) => i.spec.id === id)!.enabled
    expect(enabledOf('marker.add')).toBe(true) // add is always possible
    expect(enabledOf('marker.edit')).toBe(false)
    expect(enabledOf('marker.delete')).toBe(false)
    expect(enabledOf('marker.next')).toBe(false)
    expect(enabledOf('marker.previous')).toBe(false)

    const selected = buildMenus(baseCtx({ hasSelectedMarker: true }))
    const withMarker = selected.find((m) => m.spec.id === 'marker')!
    const selectedEnabled = (id: string) => withMarker.items.find((i) => i.spec.id === id)!.enabled
    expect(selectedEnabled('marker.edit')).toBe(true)
    expect(selectedEnabled('marker.delete')).toBe(true)
    expect(selectedEnabled('marker.next')).toBe(false) // no markers to visit yet

    const withMarkers = buildMenus(baseCtx({ hasMarkers: true }))
    const navigable = withMarkers.find((m) => m.spec.id === 'marker')!
    const navEnabled = (id: string) => navigable.items.find((i) => i.spec.id === id)!.enabled
    expect(navEnabled('marker.next')).toBe(true)
    expect(navEnabled('marker.previous')).toBe(true)
  })
})
