import { create } from 'zustand'
import { HISTORY_LIMIT, PPS_DEFAULT } from './constants'
import { applyCommand, applyCommands, EditorCommand } from './commands'
import { createDoc } from './factories'
import { linkedClips } from './links'
import { markerSelectionExists, type MarkerSelection } from './markers'
import { pruneEmptiedTracks } from './tracks'
import type { Doc } from './types'

/**
 * Editor store (zustand).
 *
 * History model: before each committed command we push a whole-`Doc` snapshot
 * onto `past`. `undo` pops a snapshot and pushes the current doc to `future`.
 * Doc JSON is small (kilobytes), so full snapshots are cheap and make every
 * command trivially reversible.
 *
 * Drag interactions use *transient* updates: `beginTransient()` snapshots the
 * base doc, every pointermove applies its command WITHOUT history, and
 * `commitTransient()` finally pushes the base snapshot — one undo step per gesture.
 *
 * Selection model (Premiere-style): `selections` is the ordered list of
 * selected clip ids (primary first); `selection` mirrors the PRIMARY id for
 * the many single-selection consumers. Shift+click ADDS a clip's whole link
 * group, Ctrl+click toggles it, plain click resets to one group. Link-group
 * expansion happens in the store so highlight, group ops and the context
 * menu all agree on one truth. Markers keep their own single selection
 * (`selectedMarker`): it is exclusive with the clip selection, and normalized
 * away when its marker stops existing (undo/redo, deletes).
 */

export type AutosaveStatus = 'idle' | 'pending' | 'saved' | 'error'

/** Timeline editing tools (Premiere: V = selection, C = razor). */
export type EditorTool = 'select' | 'razor'

export interface EditorState {
  doc: Doc
  past: Doc[]
  future: Doc[]

  /** All selected clip ids, ordered (primary/anchor first). */
  selections: string[]
  /** Primary selected clip id (`selections[0]`, kept in sync). */
  selection: string | null
  /**
   * The selected marker, if any. Store-only state (never part of the Doc).
   * Selecting a marker clears the clip selection and vice versa.
   */
  selectedMarker: MarkerSelection | null

  playhead: number
  playing: boolean
  pxPerSec: number
  snapEnabled: boolean
  /** While dragging: the time a snap guide line should be drawn at (or null). */
  snapLine: number | null
  /** Active timeline tool (Premiere: V selection / C razor). UI-only state. */
  activeTool: EditorTool

  autosaveStatus: AutosaveStatus
  autosavedAt: number | null
  /** Serialized JSON awaiting user confirmation for restore (startup banner). */
  pendingRestore: string | null

  apply: (command: EditorCommand | EditorCommand[]) => void
  /** Begins a gesture slot and returns its token; pass the initiating pointerId when known. */
  beginTransient: (pointerId?: number) => number
  applyTransient: (command: EditorCommand) => void
  commitTransient: (label?: string) => void
  cancelTransient: () => void

  undo: () => void
  redo: () => void

  replaceDoc: (doc: Doc) => void
  /** Reset to a single (primary) selection; null clears. */
  select: (clipId: string | null) => void
  /** Marquee commit: set the selection to a whole id list (primary first). */
  setSelections: (clipIds: string[]) => void
  /** Select a marker (clears the clip selection), or null to clear it. */
  selectMarker: (selection: MarkerSelection | null) => void
  /** Shift+click: ADD the clip's whole link group to the selection. */
  addSelection: (clipId: string) => void
  /** Ctrl+click: toggle the clip's whole link group in/out of the selection. */
  toggleSelection: (clipId: string) => void
  /** Select every clip in the doc (Premiere Ctrl+A). */
  selectAll: () => void
  /** Clear the selection (Premiere Ctrl+Shift+A). */
  deselectAll: () => void
  setPlayhead: (t: number) => void
  setPlaying: (playing: boolean) => void
  setPxPerSec: (pps: number) => void
  toggleSnap: () => void
  setSnapLine: (t: number | null) => void
  setActiveTool: (tool: EditorTool) => void
  setAutosaveStatus: (status: AutosaveStatus) => void
  markAutosaved: () => void
  setPendingRestore: (json: string | null) => void
}

/**
 * Internal transient bookkeeping (kept outside the reactive state shape).
 *
 * `transientBase` is the live gesture's snapshot. `transientToken` is a
 * monotonic id handed to a drag by `beginTransient()` and bumped whenever the
 * slot ends (commit, cancel, or a foreign apply/undo/redo): a drag whose token
 * no longer matches knows its gesture is gone and must not apply further
 * frames (they would mutate the doc with no undo entry). `transientPointerId`
 * records which pointer owns the gesture so a stray pointer cannot end it.
 */
let transientBase: Doc | null = null
let transientToken = 0
let transientPointerId: number | null = null

/** Ends the gesture slot: invalidates the live token and forgets its pointer. */
function endTransient() {
  transientBase = null
  transientPointerId = null
  transientToken++
}

/** Restores the base doc over a live gesture's in-flight frames. */
function rollbackToBase(set: (partial: Partial<EditorState>) => void, get: () => EditorState) {
  const base = transientBase
  endTransient()
  if (base)
    set({
      doc: base,
      ...normalizeSelections(base, get().selections),
      selectedMarker: normalizeMarkerSelection(base, get().selectedMarker),
    })
}

/** Drops a marker selection whose marker no longer exists (undo/redo, deletes). */
function normalizeMarkerSelection(
  doc: Doc,
  selection: MarkerSelection | null,
): MarkerSelection | null {
  if (!selection) return null
  return markerSelectionExists(doc, selection) ? selection : null
}

/** Normalizes selections: dedupe, drop ids that no longer exist, primary first. */
function normalizeSelections(
  doc: Doc,
  ids: string[],
): { selections: string[]; selection: string | null } {
  const seen = new Set<string>()
  const valid: string[] = []
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    if (doc.project.tracks.some((t) => t.clips.some((c) => c.id === id))) valid.push(id)
  }
  return { selections: valid, selection: valid[0] ?? null }
}

export const useEditorStore = create<EditorState>((set, get) => ({
  doc: createDoc(),
  past: [],
  future: [],
  selections: [],
  selection: null,
  selectedMarker: null,
  playhead: 0,
  playing: false,
  pxPerSec: PPS_DEFAULT,
  snapEnabled: true,
  snapLine: null,
  activeTool: 'select',
  autosaveStatus: 'idle',
  autosavedAt: null,
  pendingRestore: null,

  apply: (command) => {
    // A foreign commit during a live gesture (keyboard delete, menu action,
    // ...) resolves the gesture FIRST: the doc rolls back to the base so the
    // history snapshot and the new edit both start from the last state with a
    // real history entry — drag frames never leak into `past`. The token bump
    // makes the drag's later frames refuse to apply.
    rollbackToBase(set, get)
    const { doc, past } = get()
    const next = Array.isArray(command) ? applyCommands(doc, command) : applyCommand(doc, command)
    // An edit that takes a lane's last clip takes the lane with it (empty
    // layers never linger); it rides in the same history entry as the edit.
    const pruned = pruneEmptiedTracks(doc, next)
    set({
      doc: pruned,
      past: [...past, doc].slice(-HISTORY_LIMIT),
      future: [],
      // Commands may delete selected clips — drop dangling selection ids.
      ...normalizeSelections(pruned, get().selections),
      selectedMarker: normalizeMarkerSelection(pruned, get().selectedMarker),
    })
  },

  beginTransient: (pointerId) => {
    transientBase = structuredClone(get().doc)
    transientPointerId = pointerId ?? null
    return ++transientToken
  },

  applyTransient: (command) => {
    // Deliberately unguarded: slider previews (InspectorPanel, EffectControls)
    // apply transient frames WITHOUT a gesture slot and commit once via
    // onValueCommit. Drag gestures guard their own frames by token instead.
    const { doc } = get()
    try {
      set({ doc: applyCommand(doc, command) })
    } catch {
      // Transient (mid-drag) commands may transiently violate constraints;
      // the drag code clamps beforehand — swallow here to keep gestures smooth.
    }
  },

  commitTransient: () => {
    const { doc, past } = get()
    if (!transientBase) return
    const base = transientBase
    // Prune only now, on commit: mid-gesture the source lane is legitimately
    // empty for a frame, and removing it would delete the lane being dragged out of.
    const pruned = pruneEmptiedTracks(base, doc)
    const changed = JSON.stringify(base) !== JSON.stringify(pruned)
    // Clear the transient flag BEFORE set() — the autosave subscription runs
    // synchronously and must observe a non-transient state to schedule a save.
    endTransient()
    if (changed) {
      set({
        doc: pruned,
        past: [...past, base].slice(-HISTORY_LIMIT),
        future: [],
        // A transient gesture may have deleted the selected marker; drop a
        // selection whose target no longer exists in the committed doc.
        selectedMarker: normalizeMarkerSelection(pruned, get().selectedMarker),
      })
    }
  },

  cancelTransient: () => {
    if (!transientBase) return
    const base = transientBase
    endTransient()
    set({
      doc: base,
      // The restored BASE doc decides what still exists: the LIVE selection
      // survives only if it still resolves there. A selection cleared
      // mid-gesture stays cleared, and one that never existed in the base is
      // dropped — cancel never resurrects a selection the user changed.
      selectedMarker: normalizeMarkerSelection(base, get().selectedMarker),
    })
  },

  undo: () => {
    // Same hazard as `apply`: resolve a live gesture first so the undo starts
    // from the base doc and no drag frames leak into `future`.
    rollbackToBase(set, get)
    const { past, future, doc, selections, selectedMarker } = get()
    if (past.length === 0) return
    const previous = past[past.length - 1]
    set({
      doc: previous,
      past: past.slice(0, -1),
      future: [doc, ...future].slice(0, HISTORY_LIMIT),
      // Drop selection members that no longer exist in the restored doc.
      ...normalizeSelections(previous, selections),
      selectedMarker: normalizeMarkerSelection(previous, selectedMarker),
    })
  },
  redo: () => {
    // Same hazard as `apply`.
    rollbackToBase(set, get)
    const { past, future, doc, selections, selectedMarker } = get()
    if (future.length === 0) return
    const next = future[0]
    set({
      doc: next,
      past: [...past, doc].slice(-HISTORY_LIMIT),
      future: future.slice(1),
      ...normalizeSelections(next, selections),
      selectedMarker: normalizeMarkerSelection(next, selectedMarker),
    })
  },

  replaceDoc: (doc) => {
    const { past } = get()
    // Same stale-base hazard as `apply`: a newly installed project must not
    // be revertible by a gesture cleanup still holding a pre-install base.
    // No rollback: the incoming doc replaces everything anyway; the token
    // bump alone retires any live drag.
    endTransient()
    set({
      doc,
      past: [...past, get().doc].slice(-HISTORY_LIMIT),
      future: [],
      selections: [],
      selection: null,
      selectedMarker: null,
      playhead: 0,
      playing: false,
    })
  },

  select: (clipId) =>
    set(
      clipId
        ? { ...normalizeSelections(get().doc, [clipId]), selectedMarker: null }
        : { selections: [], selection: null, selectedMarker: null },
    ),

  setSelections: (clipIds) =>
    set({ ...normalizeSelections(get().doc, clipIds), selectedMarker: null }),

  selectMarker: (selection) =>
    set(
      selection
        ? { selectedMarker: selection, selections: [], selection: null }
        : { selectedMarker: null },
    ),

  addSelection: (clipId) => {
    const { doc, selections } = get()
    const group = linkedClips(doc, clipId).map((c) => c.id)
    set({ ...normalizeSelections(doc, [...selections, ...group]), selectedMarker: null })
  },

  toggleSelection: (clipId) => {
    const { doc, selections } = get()
    const group = linkedClips(doc, clipId).map((c) => c.id)
    const allIn = group.every((id) => selections.includes(id))
    const next = allIn ? selections.filter((id) => !group.includes(id)) : [...selections, ...group]
    set({ ...normalizeSelections(doc, next), selectedMarker: null })
  },

  selectAll: () => {
    const { doc } = get()
    set({
      ...normalizeSelections(
        doc,
        doc.project.tracks.flatMap((t) => t.clips.map((c) => c.id)),
      ),
      selectedMarker: null,
    })
  },

  deselectAll: () => set({ selections: [], selection: null, selectedMarker: null }),

  setPlayhead: (t) => set({ playhead: Math.max(0, t) }),
  setPlaying: (playing) => set({ playing }),
  setPxPerSec: (pps) => set({ pxPerSec: pps }),
  toggleSnap: () => set({ snapEnabled: !get().snapEnabled }),
  setSnapLine: (t) => set({ snapLine: t }),
  setActiveTool: (tool) => set({ activeTool: tool }),
  setAutosaveStatus: (status) => set({ autosaveStatus: status }),
  markAutosaved: () => set({ autosavedAt: Date.now() }),
  setPendingRestore: (json) => set({ pendingRestore: json }),
}))

/** Raw (non-hook) access for engine code and tests. */
export const editorStore = {
  getState: useEditorStore.getState,
  setState: useEditorStore.setState,
  subscribe: useEditorStore.subscribe,
}

/** True when a drag gesture is currently in progress. */
export function isTransientActive(): boolean {
  return transientBase !== null
}

/** Monotonic token of the gesture slot; drags compare to detect a foreign end. */
export function currentTransientToken(): number {
  return transientToken
}

/** Initiating pointerId of the live gesture, or null when none is recorded. */
export function activeTransientPointerId(): number | null {
  return transientPointerId
}
