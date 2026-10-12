/**
 * Data-driven model of the application menu bar.
 *
 * The structure mirrors Adobe Premiere Pro's top menu (File · Edit · Clip ·
 * Sequence · Graphics · View · Window · Help) adapted to the features this
 * editor actually has. Design rules:
 *
 * 1. **No dead menu items.** Every item maps to a real action id; anything the
 *    MVP cannot perform is not rendered at all.
 * 2. **Display-only shortcuts.** The shortcut column only shows keyboard
 *    shortcuts that are actually wired globally in `useEditorKeyboard.ts`.
 * 3. **Pure & testable.** `buildMenus(ctx)` resolves enabled/checked states
 *    from a plain context object — unit tests guard the structure and the
 *    state logic against regressions.
 */

import type { PanelId } from './workspace'
import { CURRENT_VERSION } from '../releases'

export type MenuId =
  'file' | 'edit' | 'clip' | 'sequence' | 'marker' | 'graphics' | 'view' | 'window' | 'help'

/** Every menu action the MenuBar component knows how to execute. */
export type MenuActionId =
  | 'file.newProject'
  | 'file.openProject'
  | 'file.importMedia'
  | 'file.saveProject'
  | 'file.exportMedia'
  | 'edit.undo'
  | 'edit.redo'
  | 'edit.selectAll'
  | 'edit.deselectAll'
  | 'clip.split'
  | 'clip.duplicate'
  | 'clip.delete'
  | 'clip.rippleDelete'
  | 'clip.cut'
  | 'clip.copy'
  | 'clip.paste'
  | 'clip.link'
  | 'clip.unlink'
  | 'clip.toggleMute'
  | 'clip.audioGain'
  | 'sequence.addVideoTrack'
  | 'sequence.addAudioTrack'
  | 'sequence.addTextTrack'
  | 'sequence.settings'
  | 'marker.add'
  | 'marker.edit'
  | 'marker.delete'
  | 'marker.next'
  | 'marker.previous'
  | 'graphics.newText'
  | 'view.zoomIn'
  | 'view.zoomOut'
  | 'view.zoomFit'
  | 'view.toggleSnap'
  | 'view.useProxies'
  | 'window.toggleMedia'
  | 'window.togglePreview'
  | 'window.toggleSource'
  | 'window.toggleInspector'
  | 'window.toggleTimeline'
  | 'window.resetLayout'
  | 'help.shortcuts'
  | 'help.releaseNotes'
  | 'help.about'

/** Snapshot of editor/workspace facts the menu states are derived from. */
export interface MenuContext {
  canUndo: boolean
  canRedo: boolean
  /** A clip is selected. */
  hasSelection: boolean
  /** How many clips are selected (multi-selection aware). */
  selectionCount: number
  /** The timeline holds at least one clip (Select All is meaningful). */
  hasClips: boolean
  /** The playhead is strictly inside at least one selected clip (split is possible). */
  canSplit: boolean
  /** The selected clip has a `muted` flag (audio-bearing media). */
  selectionHasAudio: boolean
  selectionMuted: boolean
  /** The clipboard holds at least one clip (paste is possible). */
  canPaste: boolean
  /** ANY selected clip belongs to a linked A/V group (unlink is meaningful). */
  selectionLinked: boolean
  /** ≥2 selected clips in distinct groups — "Link" would do something. */
  canLink: boolean
  snapEnabled: boolean
  /** Proxies are enabled for preview (View > Use Proxies). */
  proxiesEnabled: boolean
  /** At least one reachable marker exists (sequence or visible clip marker). */
  hasMarkers: boolean
  /** A marker is selected (Edit/Delete Selected Marker are meaningful). */
  hasSelectedMarker: boolean
  /** True = the panel is currently closed (Window menu checkboxes). */
  panelHidden: Record<PanelId, boolean>
  /** True when the layout differs from the default (hidden, collapsed, or resized). */
  workspaceDirty: boolean
}

/**
 * A single row inside a menu. `separator` rows render a divider and ignore
 * all other fields.
 */
export interface MenuItemSpec {
  id: string
  kind: 'item' | 'separator' | 'checkbox'
  label?: string
  action?: MenuActionId
  shortcut?: string
  /** Item is clickable (defaults to true). */
  enabled?: (ctx: MenuContext) => boolean
  /** Checkbox tick state (checkbox rows only). */
  checked?: (ctx: MenuContext) => boolean
  /** Render the row with the release-notes emerald tint (Help > What's new). */
  tinted?: boolean
}

export interface MenuSpec {
  id: MenuId
  label: string
  items: MenuItemSpec[]
}

/** A menu with its items resolved against a concrete context. */
export interface BuiltMenuItem {
  spec: MenuItemSpec
  enabled: boolean
  checked: boolean
}

export interface BuiltMenu {
  spec: MenuSpec
  items: BuiltMenuItem[]
}

const canUndo: (ctx: MenuContext) => boolean = (ctx) => ctx.canUndo
const canRedo: (ctx: MenuContext) => boolean = (ctx) => ctx.canRedo
const hasSelection: (ctx: MenuContext) => boolean = (ctx) => ctx.hasSelection
const hasClips: (ctx: MenuContext) => boolean = (ctx) => ctx.hasClips
const canSplit: (ctx: MenuContext) => boolean = (ctx) => ctx.canSplit
const hasAudioSelection: (ctx: MenuContext) => boolean = (ctx) => ctx.selectionHasAudio
const canPaste: (ctx: MenuContext) => boolean = (ctx) => ctx.canPaste
const selectionLinked: (ctx: MenuContext) => boolean = (ctx) => ctx.selectionLinked
const canLink: (ctx: MenuContext) => boolean = (ctx) => ctx.canLink
const hasMarkers: (ctx: MenuContext) => boolean = (ctx) => ctx.hasMarkers
const hasSelectedMarker: (ctx: MenuContext) => boolean = (ctx) => ctx.hasSelectedMarker
/** Reset makes sense as soon as the workspace deviates from its defaults. */
const workspaceDirty: (ctx: MenuContext) => boolean = (ctx) => ctx.workspaceDirty

/**
 * The canonical menu structure (order matches Premiere Pro's menu bar).
 * Structural changes here MUST be covered by `menus.test.ts`.
 */
export const MENU_SPECS: MenuSpec[] = [
  {
    id: 'file',
    label: 'File',
    items: [
      { id: 'file.new', kind: 'item', label: 'New Project', action: 'file.newProject' },
      { id: 'file.open', kind: 'item', label: 'Open Project…', action: 'file.openProject' },
      { id: 'file.import', kind: 'item', label: 'Import Media…', action: 'file.importMedia' },
      { id: 'file.sep1', kind: 'separator' },
      {
        id: 'file.save',
        kind: 'item',
        label: 'Save Project',
        action: 'file.saveProject',
        shortcut: 'Ctrl+S',
      },
      { id: 'file.export', kind: 'item', label: 'Export Media…', action: 'file.exportMedia' },
    ],
  },
  {
    id: 'edit',
    label: 'Edit',
    items: [
      {
        id: 'edit.undo',
        kind: 'item',
        label: 'Undo',
        action: 'edit.undo',
        shortcut: 'Ctrl+Z',
        enabled: canUndo,
      },
      {
        id: 'edit.redo',
        kind: 'item',
        label: 'Redo',
        action: 'edit.redo',
        shortcut: 'Ctrl+Shift+Z',
        enabled: canRedo,
      },
      { id: 'edit.sep1', kind: 'separator' },
      {
        id: 'edit.selectAll',
        kind: 'item',
        label: 'Select All',
        action: 'edit.selectAll',
        shortcut: 'Ctrl+A',
        enabled: hasClips,
      },
      {
        id: 'edit.deselect',
        kind: 'item',
        label: 'Deselect All',
        action: 'edit.deselectAll',
        shortcut: 'Ctrl+Shift+A',
        enabled: hasSelection,
      },
    ],
  },
  {
    id: 'clip',
    label: 'Clip',
    items: [
      {
        id: 'clip.split',
        kind: 'item',
        label: 'Split at Playhead',
        action: 'clip.split',
        shortcut: 'Ctrl+K',
        enabled: canSplit,
      },
      {
        id: 'clip.duplicate',
        kind: 'item',
        label: 'Duplicate',
        action: 'clip.duplicate',
        shortcut: 'D',
        enabled: hasSelection,
      },
      {
        id: 'clip.delete',
        kind: 'item',
        label: 'Delete',
        action: 'clip.delete',
        shortcut: 'Del',
        enabled: hasSelection,
      },
      {
        id: 'clip.rippleDelete',
        kind: 'item',
        label: 'Ripple Delete',
        action: 'clip.rippleDelete',
        shortcut: 'Shift+Del',
        enabled: hasSelection,
      },
      { id: 'clip.sep1', kind: 'separator' },
      {
        id: 'clip.cut',
        kind: 'item',
        label: 'Cut',
        action: 'clip.cut',
        shortcut: 'Ctrl+X',
        enabled: hasSelection,
      },
      {
        id: 'clip.copy',
        kind: 'item',
        label: 'Copy',
        action: 'clip.copy',
        shortcut: 'Ctrl+C',
        enabled: hasSelection,
      },
      {
        id: 'clip.paste',
        kind: 'item',
        label: 'Paste at Playhead',
        action: 'clip.paste',
        shortcut: 'Ctrl+V',
        enabled: canPaste,
      },
      {
        id: 'clip.link',
        kind: 'item',
        label: 'Link',
        action: 'clip.link',
        shortcut: 'Ctrl+L',
        enabled: canLink,
      },
      {
        id: 'clip.unlink',
        kind: 'item',
        label: 'Unlink Audio/Video',
        action: 'clip.unlink',
        shortcut: 'Ctrl+L',
        enabled: selectionLinked,
      },
      { id: 'clip.sep2', kind: 'separator' },
      {
        id: 'clip.mute',
        kind: 'checkbox',
        label: 'Mute',
        action: 'clip.toggleMute',
        shortcut: 'Shift+E',
        enabled: hasAudioSelection,
        checked: (ctx) => ctx.selectionMuted,
      },
      {
        id: 'clip.gain',
        kind: 'item',
        label: 'Audio Gain…',
        action: 'clip.audioGain',
        enabled: hasAudioSelection,
      },
    ],
  },
  {
    id: 'sequence',
    label: 'Sequence',
    items: [
      {
        id: 'sequence.addVideoTrack',
        kind: 'item',
        label: 'Add Video Track',
        action: 'sequence.addVideoTrack',
      },
      {
        id: 'sequence.addAudioTrack',
        kind: 'item',
        label: 'Add Audio Track',
        action: 'sequence.addAudioTrack',
      },
      {
        id: 'sequence.addTextTrack',
        kind: 'item',
        label: 'Add Text Track',
        action: 'sequence.addTextTrack',
      },
      { id: 'sequence.sep1', kind: 'separator' },
      {
        id: 'sequence.settings',
        kind: 'item',
        label: 'Sequence Settings…',
        action: 'sequence.settings',
      },
    ],
  },
  {
    id: 'marker',
    label: 'Marker',
    items: [
      {
        id: 'marker.add',
        kind: 'item',
        label: 'Add Marker',
        action: 'marker.add',
        shortcut: 'M',
      },
      {
        id: 'marker.edit',
        kind: 'item',
        label: 'Edit Selected Marker…',
        action: 'marker.edit',
        enabled: hasSelectedMarker,
      },
      {
        id: 'marker.delete',
        kind: 'item',
        label: 'Delete Selected Marker',
        action: 'marker.delete',
        enabled: hasSelectedMarker,
      },
      { id: 'marker.sep1', kind: 'separator' },
      {
        id: 'marker.next',
        kind: 'item',
        label: 'Go to Next Marker',
        action: 'marker.next',
        shortcut: 'Shift+M',
        enabled: hasMarkers,
      },
      {
        id: 'marker.previous',
        kind: 'item',
        label: 'Go to Previous Marker',
        action: 'marker.previous',
        shortcut: 'Ctrl+Shift+M',
        enabled: hasMarkers,
      },
    ],
  },
  {
    id: 'graphics',
    label: 'Graphics',
    items: [
      {
        id: 'graphics.newText',
        kind: 'item',
        label: 'New Text Layer at Playhead',
        action: 'graphics.newText',
        shortcut: 'T',
      },
    ],
  },
  {
    id: 'view',
    label: 'View',
    items: [
      {
        id: 'view.zoomIn',
        kind: 'item',
        label: 'Zoom In',
        action: 'view.zoomIn',
        shortcut: '+',
      },
      {
        id: 'view.zoomOut',
        kind: 'item',
        label: 'Zoom Out',
        action: 'view.zoomOut',
        shortcut: '−',
      },
      {
        id: 'view.zoomFit',
        kind: 'item',
        label: 'Zoom to Fit Sequence',
        action: 'view.zoomFit',
        shortcut: '\\',
      },
      { id: 'view.sep1', kind: 'separator' },
      {
        id: 'view.snap',
        kind: 'checkbox',
        label: 'Snapping',
        action: 'view.toggleSnap',
        shortcut: 'S',
        checked: (ctx) => ctx.snapEnabled,
      },
      {
        id: 'view.useProxies',
        kind: 'checkbox',
        label: 'Use Proxies',
        action: 'view.useProxies',
        checked: (ctx) => ctx.proxiesEnabled,
      },
    ],
  },
  {
    id: 'window',
    label: 'Window',
    items: [
      {
        id: 'window.media',
        kind: 'checkbox',
        label: 'Media',
        action: 'window.toggleMedia',
        checked: (ctx) => !ctx.panelHidden.media,
      },
      {
        id: 'window.preview',
        kind: 'checkbox',
        label: 'Program Monitor',
        action: 'window.togglePreview',
        checked: (ctx) => !ctx.panelHidden.preview,
      },
      {
        id: 'window.source',
        kind: 'checkbox',
        label: 'Source Monitor',
        action: 'window.toggleSource',
        checked: (ctx) => !ctx.panelHidden.source,
      },
      {
        id: 'window.inspector',
        kind: 'checkbox',
        label: 'Inspector',
        action: 'window.toggleInspector',
        checked: (ctx) => !ctx.panelHidden.inspector,
      },
      {
        id: 'window.timeline',
        kind: 'checkbox',
        label: 'Timeline',
        action: 'window.toggleTimeline',
        checked: (ctx) => !ctx.panelHidden.timeline,
      },
      { id: 'window.sep1', kind: 'separator' },
      {
        id: 'window.reset',
        kind: 'item',
        label: 'Reset Workspace Layout',
        action: 'window.resetLayout',
        enabled: workspaceDirty,
      },
    ],
  },
  {
    id: 'help',
    label: 'Help',
    items: [
      {
        id: 'help.releaseNotes',
        kind: 'item',
        label: `What's new in ${CURRENT_VERSION}…`,
        action: 'help.releaseNotes',
        tinted: true,
      },
      {
        id: 'help.shortcuts',
        kind: 'item',
        label: 'Keyboard Shortcuts…',
        action: 'help.shortcuts',
      },
      { id: 'help.about', kind: 'item', label: 'About Web Video Editor', action: 'help.about' },
    ],
  },
]

/**
 * Resolve all menus against a concrete context.
 * Items without an `enabled` predicate are always enabled; checkbox items
 * default to unchecked when no `checked` predicate is given.
 */
export function buildMenus(ctx: MenuContext): BuiltMenu[] {
  return MENU_SPECS.map((menu) => ({
    spec: menu,
    items: menu.items.map((spec) => ({
      spec,
      enabled: spec.enabled ? spec.enabled(ctx) : true,
      checked: spec.checked ? spec.checked(ctx) : false,
    })),
  }))
}

/** All action ids referenced by the menu (used by tests and the action map). */
export function collectMenuActions(): MenuActionId[] {
  const actions: MenuActionId[] = []
  for (const menu of MENU_SPECS) {
    for (const item of menu.items) {
      if (item.action) actions.push(item.action)
    }
  }
  return actions
}
