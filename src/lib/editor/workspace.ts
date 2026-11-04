/**
 * Workspace layout state — pure, serializable, storage-agnostic.
 *
 * The workspace describes how the editor's panels are arranged:
 * - `sizes`     panel widths/heights as percentages WITHIN their panel group
 *               (the preview has no stored size — it always fills the remainder)
 * - `hidden`    panels fully closed (restorable from the Window menu)
 *
 * All persistence goes through an injected `Storage` so the module stays
 * testable and SSR-safe. `sanitizeWorkspace()` never throws: corrupt or
 * hand-edited localStorage data falls back to defaults instead of crashing
 * the editor on boot.
 */

import { isAnimatableProperty } from './keyframes'
import type { KeyframeProperty } from './types'

export type PanelId = 'media' | 'preview' | 'source' | 'inspector' | 'timeline' | 'captions'
export type PanelSizeId = 'media' | 'source' | 'inspector' | 'timeline' | 'captions'

export interface PanelInfo {
  id: PanelId
  title: string
}

/** Panel catalog (order is only informational — layout is defined by EditorShell). */
export const PANELS: PanelInfo[] = [
  { id: 'media', title: 'Media' },
  { id: 'preview', title: 'Program Monitor' },
  { id: 'source', title: 'Source Monitor' },
  { id: 'inspector', title: 'Inspector' },
  { id: 'timeline', title: 'Timeline' },
  { id: 'captions', title: 'Captions' },
]

export const PANEL_IDS: PanelId[] = PANELS.map((p) => p.id)

/** Per-panel percentage bounds inside their own group. */
export interface PanelBounds {
  /** Default size when the workspace has never been customized. */
  default: number
  /** Smallest expanded size (percent). */
  min: number
  /** Largest expanded size (percent). */
  max: number
}

export const PANEL_BOUNDS: Record<PanelSizeId, PanelBounds> = {
  media: { default: 32, min: 12, max: 42 },
  source: { default: 24, min: 14, max: 44 },
  inspector: { default: 26, min: 16, max: 46 },
  timeline: { default: 50, min: 15, max: 72 },
  captions: { default: 24, min: 15, max: 45 },
}

export interface WorkspaceState {
  sizes: {
    media: number
    source: number
    inspector: number
    timeline: number
    captions: number
  }
  hidden: Record<PanelId, boolean>
  /**
   * Inspector keyframe graph height per property, in CSS pixels (0.18.0).
   * UI state only: it must never enter the Doc or the undo history.
   */
  keyframeGraphHeights: Partial<Record<KeyframeProperty, number>>
}

/** Bounds for a dragged Inspector keyframe graph (CSS pixels). */
export const KEYFRAME_GRAPH_MIN_HEIGHT = 32
export const KEYFRAME_GRAPH_MAX_HEIGHT = 240

export const WORKSPACE_STORAGE_KEY = 'web-video-editor:workspace:v1'

/** Fresh default workspace (nothing hidden). */
export function defaultWorkspace(): WorkspaceState {
  return {
    sizes: {
      media: PANEL_BOUNDS.media.default,
      source: PANEL_BOUNDS.source.default,
      inspector: PANEL_BOUNDS.inspector.default,
      timeline: PANEL_BOUNDS.timeline.default,
      captions: PANEL_BOUNDS.captions.default,
    },
    hidden: {
      media: false,
      preview: false,
      source: false,
      inspector: false,
      timeline: false,
      captions: false,
    },
    keyframeGraphHeights: {},
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function asBool(value: unknown): boolean {
  return value === true
}

function sanitizePanelIdSet(raw: unknown, panelIds: PanelId[]): Record<PanelId, boolean> {
  const out = {} as Record<PanelId, boolean>
  for (const id of panelIds) out[id] = asBool((raw as Record<string, unknown> | null)?.[id])
  return out
}

/**
 * Repair arbitrary parsed JSON into a valid WorkspaceState.
 * Guarantees: every field present, sizes within bounds, no unknown state.
 * A legacy `collapsed` key is ignored (0.19.0 removed collapse).
 */
export function sanitizeWorkspace(raw: unknown): WorkspaceState {
  const fallback = defaultWorkspace()
  if (typeof raw !== 'object' || raw === null) return fallback

  const obj = raw as Record<string, unknown>

  // Only known panel sizes are read; unknown keys are ignored (forward compat).
  const sizeKeys: PanelSizeId[] = ['media', 'source', 'inspector', 'timeline', 'captions']
  const sizes = { ...fallback.sizes }
  for (const key of sizeKeys) {
    const value = (obj.sizes as Record<string, unknown> | null)?.[key]
    if (typeof value === 'number' && Number.isFinite(value)) {
      sizes[key] = clamp(value, PANEL_BOUNDS[key].min, PANEL_BOUNDS[key].max)
    }
  }

  const panelIds = PANEL_IDS
  const heights: Partial<Record<KeyframeProperty, number>> = {}
  const rawHeights = obj.keyframeGraphHeights
  if (typeof rawHeights === 'object' && rawHeights !== null) {
    for (const [key, value] of Object.entries(rawHeights as Record<string, unknown>)) {
      // Unknown property keys are dropped; a hostile or stale value never
      // reaches the component.
      if (!isAnimatableProperty(key)) continue
      if (typeof value !== 'number' || !Number.isFinite(value)) continue
      heights[key] = clamp(value, KEYFRAME_GRAPH_MIN_HEIGHT, KEYFRAME_GRAPH_MAX_HEIGHT)
    }
  }
  return {
    sizes,
    hidden: sanitizePanelIdSet(obj.hidden, panelIds),
    keyframeGraphHeights: heights,
  }
}

export function workspaceToJSON(state: WorkspaceState): string {
  return JSON.stringify(state)
}

/**
 * Read the workspace from a storage. Missing or corrupt data yields defaults.
 * `storage` is injected; pass `null` (or omit on the server) to skip loading.
 */
export function loadWorkspace(storage?: Pick<Storage, 'getItem'> | null): WorkspaceState {
  if (!storage) return defaultWorkspace()
  try {
    const raw = storage.getItem(WORKSPACE_STORAGE_KEY)
    if (!raw) return defaultWorkspace()
    return sanitizeWorkspace(JSON.parse(raw))
  } catch {
    return defaultWorkspace()
  }
}

/** Persist the workspace. Storage failures (private mode, quota) are ignored. */
export function saveWorkspace(
  state: WorkspaceState,
  storage?: Pick<Storage, 'setItem'> | null,
): void {
  if (!storage) return
  try {
    storage.setItem(WORKSPACE_STORAGE_KEY, workspaceToJSON(state))
  } catch {
    // Ignore write failures — losing a layout preference is not fatal.
  }
}

/** Immutable update helper: show/hide a panel (Window menu / panel menu). */
export function withHidden(state: WorkspaceState, id: PanelId, hidden: boolean): WorkspaceState {
  return { ...state, hidden: { ...state.hidden, [id]: hidden } }
}

/** Immutable update helper: store a panel size observed from the layout engine. */
export function withSize(state: WorkspaceState, id: PanelSizeId, size: number): WorkspaceState {
  const clamped = clamp(size, PANEL_BOUNDS[id].min, PANEL_BOUNDS[id].max)
  if (state.sizes[id] === clamped) return state
  return { ...state, sizes: { ...state.sizes, [id]: clamped } }
}

/** Immutable update for one Inspector keyframe graph height (0.18.0). */
export function withKeyframeGraphHeight(
  state: WorkspaceState,
  property: KeyframeProperty,
  height: number,
): WorkspaceState {
  if (!Number.isFinite(height)) return state
  const clamped = clamp(height, KEYFRAME_GRAPH_MIN_HEIGHT, KEYFRAME_GRAPH_MAX_HEIGHT)
  if (state.keyframeGraphHeights[property] === clamped) return state
  return {
    ...state,
    keyframeGraphHeights: { ...state.keyframeGraphHeights, [property]: clamped },
  }
}

/** One persisted slot inside a group layout. */
export interface ExpectedPanelSlot {
  /** Index in the full group layout array. */
  index: number
  /** Bounds for the persisted size at that index. */
  bounds: PanelBounds
}

/**
 * Validate a full group layout against the current shape and the persisted
 * slots. `expectedLength` is the number of mounted panels in the group, which
 * is the layout length the library emits. Unmapped slots (auto-sized preview,
 * workspace column, upper row, Timeline remainder) are never inspected.
 */
export function isExpectedPanelLayout(
  layout: number[],
  expectedLength: number,
  entries: readonly ExpectedPanelSlot[],
): boolean {
  if (!Array.isArray(layout) || layout.length !== expectedLength) return false
  for (const entry of entries) {
    if (!Number.isInteger(entry.index) || entry.index < 0 || entry.index >= expectedLength) {
      return false
    }
    const value = layout[entry.index]
    if (typeof value !== 'number' || !Number.isFinite(value)) return false
    if (value < entry.bounds.min || value > entry.bounds.max) return false
  }
  return true
}

export type ResetGroupId = 'upper' | 'top' | 'bottom' | 'vertical'

export interface ResetGroupSpec {
  id: ResetGroupId
  expectedLength: number
  entries: readonly ExpectedPanelSlot[]
}

/** The full reset layout: every panel visible after `resetWorkspace()`. */
export const RESET_GROUP_SPECS: readonly ResetGroupSpec[] = [
  {
    id: 'upper',
    expectedLength: 3,
    entries: [
      { index: 0, bounds: PANEL_BOUNDS.media },
      { index: 1, bounds: PANEL_BOUNDS.source },
    ],
  },
  { id: 'top', expectedLength: 2, entries: [{ index: 1, bounds: PANEL_BOUNDS.inspector }] },
  { id: 'bottom', expectedLength: 2, entries: [{ index: 1, bounds: PANEL_BOUNDS.captions }] },
  { id: 'vertical', expectedLength: 2, entries: [{ index: 1, bounds: PANEL_BOUNDS.timeline }] },
]

/** Work the reset tracker delegates to the shell. */
export interface ResetTrackerHooks {
  /** Imperatively resize the named groups to their default shares. */
  issueResizes: (groups: ResetGroupId[]) => void
  /** Read each mounted group's current layout synchronously. */
  readLayouts: () => Partial<Record<ResetGroupId, number[]>>
}

export interface ResetTrackerOptions {
  groups: readonly ResetGroupSpec[]
  hooks: ResetTrackerHooks
  scheduleFrame: (callback: () => void) => number
  cancelFrame: (handle: number) => void
  scheduleTimer: (callback: () => void, delayMs: number) => number
  cancelTimer: (handle: number) => void
  fallbackMs?: number
  maxRearms?: number
}

export interface ResetTracker {
  /** Start a generation and schedule its frame and fallback. */
  begin: () => number
  /** Record a post-issue layout; pre-issue layouts are ignored. */
  noteLayout: (token: number, group: ResetGroupId, layout: number[]) => boolean
  /** Cancel the pending reset and its timers. */
  cancel: () => void
  pendingToken: () => number | null
  isIssued: () => boolean
  completedGroups: () => ResetGroupId[]
}

/**
 * Pure generation tracker for Reset Workspace Layout. It owns the timing
 * decisions but delegates the imperative resizes and layout reads through
 * injected hooks, so unit tests can drive the frame and fallback synchronously.
 */
export function createResetTracker(options: ResetTrackerOptions): ResetTracker {
  const fallbackMs = options.fallbackMs ?? 1000
  const maxRearms = options.maxRearms ?? 2
  let seq = 0
  let token: number | null = null
  let issued = false
  let completed = new Set<ResetGroupId>()
  let rearms = 0
  let frameHandle: number | null = null
  let timerHandle: number | null = null

  const cancelHandles = () => {
    if (frameHandle !== null) {
      options.cancelFrame(frameHandle)
      frameHandle = null
    }
    if (timerHandle !== null) {
      options.cancelTimer(timerHandle)
      timerHandle = null
    }
  }

  const clear = () => {
    cancelHandles()
    token = null
    issued = false
    completed = new Set()
    rearms = 0
  }

  const remaining = () => options.groups.map((group) => group.id).filter((id) => !completed.has(id))

  const observe = (activeToken: number, layouts: Partial<Record<ResetGroupId, number[]>>) => {
    if (activeToken !== token || !issued) return
    for (const group of options.groups) {
      const layout = layouts[group.id]
      if (!layout) continue
      if (isExpectedPanelLayout(layout, group.expectedLength, group.entries)) {
        completed.add(group.id)
      }
    }
    if (remaining().length === 0) clear()
  }

  const runFrame = (activeToken: number) => {
    frameHandle = null
    if (activeToken !== token) return
    issued = true
    options.hooks.issueResizes(options.groups.map((group) => group.id))
    observe(activeToken, options.hooks.readLayouts())
  }

  const runFallback = (activeToken: number) => {
    timerHandle = null
    if (activeToken !== token) return
    const pending = remaining()
    if (pending.length === 0) {
      clear()
      return
    }
    if (rearms >= maxRearms) {
      clear()
      return
    }
    rearms += 1
    issued = true
    options.hooks.issueResizes(pending)
    observe(activeToken, options.hooks.readLayouts())
    if (activeToken === token && remaining().length > 0) {
      timerHandle = options.scheduleTimer(() => runFallback(activeToken), fallbackMs)
    }
  }

  return {
    begin: () => {
      cancelHandles()
      token = ++seq
      issued = false
      completed = new Set()
      rearms = 0
      const started = token
      frameHandle = options.scheduleFrame(() => runFrame(started))
      timerHandle = options.scheduleTimer(() => runFallback(started), fallbackMs)
      return started
    },
    noteLayout: (activeToken, group, layout) => {
      if (activeToken !== token || !issued) return false
      const spec = options.groups.find((candidate) => candidate.id === group)
      if (!spec) return false
      if (!isExpectedPanelLayout(layout, spec.expectedLength, spec.entries)) return false
      completed.add(group)
      if (remaining().length === 0) clear()
      return true
    },
    cancel: clear,
    pendingToken: () => token,
    isIssued: () => issued,
    completedGroups: () => [...completed],
  }
}
