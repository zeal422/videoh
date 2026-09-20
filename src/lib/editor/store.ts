import { create } from 'zustand'
import { HISTORY_LIMIT, PPS_DEFAULT } from './constants'
import { applyCommand, applyCommands, EditorCommand } from './commands'
import { createDoc } from './factories'
import { linkedClips } from './links'
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
 * menu all agree on one truth.
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
  beginTransient: () => void
  applyTransient: (command: EditorCommand) => void
  commitTransient: (label?: string) => void
  cancelTransient: () => void

  undo: () => void
  redo: () => void

  replaceDoc: (doc: Doc) => void
  /** Reset to a single (primary) selection; null clears. */
  select: (clipId: string | null) => void
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

/** Internal transient bookkeeping (kept outside the reactive state shape). */
let transientBase: Doc | null = null

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
    })
  },

  beginTransient: () => {
    transientBase = structuredClone(get().doc)
  },

  applyTransient: (command) => {
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
    transientBase = null
    if (changed) {
      set({
        doc: pruned,
        past: [...past, base].slice(-HISTORY_LIMIT),
        future: [],
      })
    }
  },

  cancelTransient: () => {
    if (!transientBase) return
    set({ doc: transientBase })
    transientBase = null
  },

  undo: () => {
    const { past, future, doc, selections } = get()
    if (past.length === 0) return
    const previous = past[past.length - 1]
    set({
      doc: previous,
      past: past.slice(0, -1),
      future: [doc, ...future].slice(0, HISTORY_LIMIT),
      // Drop selection members that no longer exist in the restored doc.
      ...normalizeSelections(previous, selections),
    })
  },

  redo: () => {
    const { past, future, doc, selections } = get()
    if (future.length === 0) return
    const next = future[0]
    set({
      doc: next,
      past: [...past, doc].slice(-HISTORY_LIMIT),
      future: future.slice(1),
      ...normalizeSelections(next, selections),
    })
  },

  replaceDoc: (doc) => {
    const { past } = get()
    set({
      doc,
      past: [...past, get().doc].slice(-HISTORY_LIMIT),
      future: [],
      selections: [],
      selection: null,
      playhead: 0,
      playing: false,
    })
  },

  select: (clipId) =>
    set(clipId ? normalizeSelections(get().doc, [clipId]) : { selections: [], selection: null }),

  addSelection: (clipId) => {
    const { doc, selections } = get()
    const group = linkedClips(doc, clipId).map((c) => c.id)
    set(normalizeSelections(doc, [...selections, ...group]))
  },

  toggleSelection: (clipId) => {
    const { doc, selections } = get()
    const group = linkedClips(doc, clipId).map((c) => c.id)
    const allIn = group.every((id) => selections.includes(id))
    const next = allIn ? selections.filter((id) => !group.includes(id)) : [...selections, ...group]
    set(normalizeSelections(doc, next))
  },

  selectAll: () => {
    const { doc } = get()
    set(
      normalizeSelections(
        doc,
        doc.project.tracks.flatMap((t) => t.clips.map((c) => c.id)),
      ),
    )
  },

  deselectAll: () => set({ selections: [], selection: null }),

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
