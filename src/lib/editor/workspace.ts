/**
 * Workspace layout state — pure, serializable, storage-agnostic.
 *
 * The workspace describes how the editor's panels are arranged:
 * - `sizes`     panel widths/heights as percentages WITHIN their panel group
 *               (preview has no stored size — it always fills the remainder)
 * - `collapsed` panels shrunk to a slim strip (expandable with one click)
 * - `hidden`    panels fully closed (restorable from the Window menu)
 *
 * All persistence goes through an injected `Storage` so the module stays
 * testable and SSR-safe. `sanitizeWorkspace()` never throws: corrupt or
 * hand-edited localStorage data falls back to defaults instead of crashing
 * the editor on boot.
 */

export type PanelId = 'media' | 'preview' | 'inspector' | 'timeline'

export interface PanelInfo {
  id: PanelId
  title: string
}

/** Panel catalog (order is only informational — layout is defined by EditorShell). */
export const PANELS: PanelInfo[] = [
  { id: 'media', title: 'Media' },
  { id: 'preview', title: 'Program Monitor' },
  { id: 'inspector', title: 'Inspector' },
  { id: 'timeline', title: 'Timeline' },
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

export const PANEL_BOUNDS: Record<'media' | 'inspector' | 'timeline', PanelBounds> = {
  media: { default: 20, min: 12, max: 42 },
  inspector: { default: 26, min: 16, max: 46 },
  timeline: { default: 38, min: 15, max: 72 },
}

/**
 * Size (percent) at or below which a collapsible panel counts as collapsed.
 * Must match `COLLAPSED_SIZE_PCT` used by the panel components.
 */
export const COLLAPSED_SIZE_PCT = 2.5
/** Tolerance when comparing persisted sizes against COLLAPSED_SIZE_PCT. */
export const COLLAPSED_EPSILON = 0.6

export interface WorkspaceState {
  sizes: {
    media: number
    inspector: number
    timeline: number
  }
  collapsed: Record<PanelId, boolean>
  hidden: Record<PanelId, boolean>
}

export const WORKSPACE_STORAGE_KEY = 'web-video-editor:workspace:v1'

/** Fresh default workspace (nothing hidden, nothing collapsed). */
export function defaultWorkspace(): WorkspaceState {
  return {
    sizes: {
      media: PANEL_BOUNDS.media.default,
      inspector: PANEL_BOUNDS.inspector.default,
      timeline: PANEL_BOUNDS.timeline.default,
    },
    collapsed: { media: false, preview: false, inspector: false, timeline: false },
    hidden: { media: false, preview: false, inspector: false, timeline: false },
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
 */
export function sanitizeWorkspace(raw: unknown): WorkspaceState {
  const fallback = defaultWorkspace()
  if (typeof raw !== 'object' || raw === null) return fallback

  const obj = raw as Record<string, unknown>

  // Only known panel sizes are read; unknown keys are ignored (forward compat).
  const sizeKeys = ['media', 'inspector', 'timeline'] as const
  const sizes = { ...fallback.sizes }
  for (const key of sizeKeys) {
    const value = (obj.sizes as Record<string, unknown> | null)?.[key]
    if (typeof value === 'number' && Number.isFinite(value)) {
      sizes[key] = clamp(value, PANEL_BOUNDS[key].min, PANEL_BOUNDS[key].max)
    }
  }

  const panelIds = PANEL_IDS
  return {
    sizes,
    collapsed: sanitizePanelIdSet(obj.collapsed, panelIds),
    hidden: sanitizePanelIdSet(obj.hidden, panelIds),
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

/** Immutable update helper: show/hide a panel (Window menu). */
export function withHidden(state: WorkspaceState, id: PanelId, hidden: boolean): WorkspaceState {
  return { ...state, hidden: { ...state.hidden, [id]: hidden } }
}

/** Immutable update helper: collapse/expand a panel (header chevron / handle drag). */
export function withCollapsed(
  state: WorkspaceState,
  id: PanelId,
  collapsed: boolean,
): WorkspaceState {
  return { ...state, collapsed: { ...state.collapsed, [id]: collapsed } }
}

/** Immutable update helper: store a panel size observed from the layout engine. */
export function withSize(
  state: WorkspaceState,
  id: 'media' | 'inspector' | 'timeline',
  size: number,
): WorkspaceState {
  const clamped = clamp(size, PANEL_BOUNDS[id].min, PANEL_BOUNDS[id].max)
  if (state.sizes[id] === clamped) return state
  return { ...state, sizes: { ...state.sizes, [id]: clamped } }
}

/** True when a persisted/observed size means "panel is collapsed". */
export function isCollapsedSize(size: number): boolean {
  return size <= COLLAPSED_SIZE_PCT + COLLAPSED_EPSILON
}
