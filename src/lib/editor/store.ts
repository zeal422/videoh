import { create } from 'zustand'
import { HISTORY_LIMIT, PPS_DEFAULT } from './constants'
import { clearClipboard } from './clipboard'
import { applyCommand, applyCommands, EditorCommand } from './commands'
import { activeTracks, createDoc, findSequence, findTrack } from './factories'
import { linkedClips } from './links'
import { markerSelectionExists, type MarkerSelection } from './markers'
import type { PlacementMode } from './sequence-ops'
import { pruneEmptiedTracks, pruneOrphanSequences } from './tracks'
import type { ProxyEntry } from './proxy'
import type { Doc, Track } from './types'

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
  /**
   * Sticky placement mode for lane drops (Premiere-style Place / Insert /
   * Overwrite). Session UI state, never part of the Doc, and it survives a
   * project open like `activeTool`. `,`/`.` are independent one-shot keys.
   */
  dropMode: PlacementMode
  /**
   * The media bin asset the Source monitor shows, or null. Session state: the
   * marks and the source playhead belong to it and clear whenever it changes.
   */
  sourceAssetId: string | null
  /** Marked source in point (seconds), null = open end. */
  sourceIn: number | null
  /** Marked source out point (seconds), null = open end. */
  sourceOut: number | null
  /**
   * The ONE owner of the source monitor's time: the source preview element
   * writes it from its playback/seek callbacks, and the panel readout, I/O
   * marks and the placement range all read this field.
   */
  sourcePlayhead: number
  /**
   * Track ids the user turned OFF for lane-less placement (paste, quick-add,
   * add text). Session UI state, never part of the Doc: an absent id means
   * targeted, so the default empty list targets everything and a new track is
   * targeted with no extra code. Ids of removed tracks stay inert; undo that
   * restores the track restores its posture.
   */
  untargetedTracks: string[]
  /**
   * Whether proxies are used for preview (View > Use Proxies). Session-only,
   * never in the Doc, and it survives a project open like `activeTool`.
   */
  proxiesEnabled: boolean
  /**
   * Per-asset proxy build state (status + object URL). Session-only and outside
   * document history and serialization; the object URLs are owned by the
   * `media/proxies.ts` registry, which revokes them on drop.
   */
  proxyByAssetId: Record<string, ProxyEntry>
  /**
   * The open compound sequence path (0.8.1): empty at the project root,
   * otherwise the sequence ids from the root to the open child. The timeline
   * and preview render the ACTIVE sequence's tracks. Session-only: never in the
   * Doc, never serialized, never undoable. Normalized against the doc whenever
   * the doc changes (a compound deletion or an undo past creation truncates it).
   */
  activeSequencePath: string[]

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
  setDropMode: (mode: PlacementMode) => void
  /** Select the Source monitor's asset; changing it clears the marks and the time. */
  setSourceAsset: (assetId: string | null) => void
  /** Write the source time (clamped into the asset), from element callbacks. */
  setSourcePlayhead: (t: number) => void
  /** Mark In at the source playhead (no-op without a duration-bearing asset). */
  markSourceIn: () => void
  /** Mark Out at the source playhead. */
  markSourceOut: () => void
  clearSourceMarks: () => void
  /** Toggle a lane's targeting: session UI state, never a history entry. */
  setTrackTargeted: (trackId: string, targeted: boolean) => void
  /** Enable or disable proxies for preview (View > Use Proxies). */
  setProxiesEnabled: (enabled: boolean) => void
  /** Record one asset's proxy build state (status + optional object URL). */
  setProxyEntry: (assetId: string, entry: ProxyEntry) => void
  /** Forget one asset's proxy entry (the registry revokes its URL first). */
  clearProxyEntry: (assetId: string) => void
  /** Open a compound sequence (pushes onto the active path). */
  openSequence: (sequenceId: string) => void
  /** Jump the breadcrumb: keep the path up to and including `index` (-1 = root). */
  setActiveSequencePath: (path: string[]) => void
  /**
   * Select every clip on a lane, expanding each clip's link group so an A/V
   * pair split across lanes selects both halves. The lane's first clip is the
   * primary; the marker selection clears.
   */
  selectTrackClips: (trackId: string) => void
  setAutosaveStatus: (status: AutosaveStatus) => void
  markAutosaved: () => void
  setPendingRestore: (json: string | null) => void
}

/**
 * The asset the Source monitor is showing, or undefined when none is selected
 * (or the asset has no source window: images have none).
 */
function sourceAssetOf(state: {
  doc: Doc
  sourceAssetId: string | null
}): { id: string; duration: number } | undefined {
  const asset = state.sourceAssetId
    ? state.doc.media.find((m) => m.id === state.sourceAssetId)
    : undefined
  if (!asset || asset.kind === 'image' || asset.duration <= 0) return undefined
  return asset
}

/**
 * Drops the source selection when its asset no longer exists (a media
 * removal); a live selection whose asset is present is untouched.
 */
function normalizeSourceState(
  doc: Doc,
  state: { sourceAssetId: string | null },
): Partial<EditorState> {
  if (!state.sourceAssetId) return {}
  if (doc.media.some((m) => m.id === state.sourceAssetId)) return {}
  return { sourceAssetId: null, sourceIn: null, sourceOut: null, sourcePlayhead: 0 }
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
  if (base) {
    const path = normalizeActivePath(base, get().activeSequencePath)
    set({
      doc: base,
      activeSequencePath: path,
      ...normalizeSelections(base, get().selections, path),
      selectedMarker: normalizeMarkerSelection(base, get().selectedMarker),
    })
  }
}

/** Drops a marker selection whose marker no longer exists (undo/redo, deletes). */
function normalizeMarkerSelection(
  doc: Doc,
  selection: MarkerSelection | null,
): MarkerSelection | null {
  if (!selection) return null
  return markerSelectionExists(doc, selection) ? selection : null
}

/**
 * Normalizes selections: dedupe, drop ids that no longer exist, primary first.
 * Scoped to the ACTIVE sequence: a selection can only reference clips in the
 * open sequence, so a stale id from another sequence is dropped.
 */
function normalizeSelections(
  doc: Doc,
  ids: string[],
  activeSequencePath: readonly string[],
): { selections: string[]; selection: string | null } {
  const seen = new Set<string>()
  const valid: string[] = []
  const inScope = new Set<string>()
  for (const track of activeTracks(doc, activeSequencePath)) {
    for (const clip of track.clips) inScope.add(clip.id)
  }
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    if (inScope.has(id)) valid.push(id)
  }
  return { selections: valid, selection: valid[0] ?? null }
}

/**
 * Truncates the active path at the first id the doc no longer resolves, so an
 * undo past a compound creation (or a container deletion) falls back to its
 * surviving parent rather than rendering a sequence that is gone.
 */
function normalizeActivePath(doc: Doc, path: readonly string[]): string[] {
  const out: string[] = []
  // Each step must be a real parent-child edge: the sequence is referenced by a
  // compound on the preceding sequence's (or root's) tracks. An id that exists
  // but is no longer a child of its predecessor truncates the path.
  let parentTracks: readonly Track[] = doc.project.tracks
  for (const id of path) {
    const sequence = findSequence(doc, id)
    if (!sequence) break
    const isChild = parentTracks.some((t) => t.clips.some((c) => c.sequenceId === id))
    if (!isChild) break
    out.push(id)
    parentTracks = sequence.tracks
  }
  return out
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
  dropMode: 'place',
  sourceAssetId: null,
  sourceIn: null,
  sourceOut: null,
  sourcePlayhead: 0,
  untargetedTracks: [],
  proxiesEnabled: false,
  proxyByAssetId: {},
  activeSequencePath: [],
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
    // layers never linger), and an edit that drops the last container of a
    // compound takes its sequence with it. Both ride in the same history entry
    // as the edit, so undo restores them.
    const pruned = pruneOrphanSequences(pruneEmptiedTracks(doc, next))
    const path = normalizeActivePath(pruned, get().activeSequencePath)
    set({
      doc: pruned,
      activeSequencePath: path,
      past: [...past, doc].slice(-HISTORY_LIMIT),
      future: [],
      // Commands may delete selected clips — drop dangling selection ids.
      ...normalizeSelections(pruned, get().selections, path),
      selectedMarker: normalizeMarkerSelection(pruned, get().selectedMarker),
      // A removed media asset takes the Source monitor's selection with it.
      ...normalizeSourceState(pruned, get()),
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
    const pruned = pruneOrphanSequences(pruneEmptiedTracks(base, doc))
    const changed = JSON.stringify(base) !== JSON.stringify(pruned)
    // Clear the transient flag BEFORE set() — the autosave subscription runs
    // synchronously and must observe a non-transient state to schedule a save.
    endTransient()
    if (changed) {
      const path = normalizeActivePath(pruned, get().activeSequencePath)
      set({
        doc: pruned,
        activeSequencePath: path,
        past: [...past, base].slice(-HISTORY_LIMIT),
        future: [],
        ...normalizeSelections(pruned, get().selections, path),
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
    const path = normalizeActivePath(previous, get().activeSequencePath)
    set({
      doc: previous,
      activeSequencePath: path,
      past: past.slice(0, -1),
      future: [doc, ...future].slice(0, HISTORY_LIMIT),
      // Drop selection members that no longer exist in the restored doc.
      ...normalizeSelections(previous, selections, path),
      selectedMarker: normalizeMarkerSelection(previous, selectedMarker),
    })
  },
  redo: () => {
    // Same hazard as `apply`.
    rollbackToBase(set, get)
    const { past, future, doc, selections, selectedMarker } = get()
    if (future.length === 0) return
    const next = future[0]
    const path = normalizeActivePath(next, get().activeSequencePath)
    set({
      doc: next,
      activeSequencePath: path,
      past: [...past, doc].slice(-HISTORY_LIMIT),
      future: future.slice(1),
      ...normalizeSelections(next, selections, path),
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
    // A clipboard entry belongs to the project it was copied from: its clips
    // (and any compound sequence they reference) may not exist here.
    clearClipboard()
    set({
      doc,
      past: [...past, get().doc].slice(-HISTORY_LIMIT),
      future: [],
      selections: [],
      selection: null,
      selectedMarker: null,
      // The source selection references doc assets, so a project open drops
      // it. `dropMode` is a tool posture (like `activeTool`) and survives.
      sourceAssetId: null,
      sourceIn: null,
      sourceOut: null,
      sourcePlayhead: 0,
      untargetedTracks: [],
      proxyByAssetId: {},
      activeSequencePath: [],
      playhead: 0,
      playing: false,
    })
  },

  select: (clipId) =>
    set(
      clipId
        ? {
            ...normalizeSelections(get().doc, [clipId], get().activeSequencePath),
            selectedMarker: null,
          }
        : { selections: [], selection: null, selectedMarker: null },
    ),

  setSelections: (clipIds) =>
    set({
      ...normalizeSelections(get().doc, clipIds, get().activeSequencePath),
      selectedMarker: null,
    }),

  setTrackTargeted: (trackId, targeted) => {
    const { untargetedTracks } = get()
    const next = targeted
      ? untargetedTracks.filter((id) => id !== trackId)
      : untargetedTracks.includes(trackId)
        ? untargetedTracks
        : [...untargetedTracks, trackId]
    set({ untargetedTracks: next })
  },

  setProxiesEnabled: (enabled) => set({ proxiesEnabled: enabled }),

  setProxyEntry: (assetId, entry) =>
    set((s) => ({ proxyByAssetId: { ...s.proxyByAssetId, [assetId]: entry } })),

  clearProxyEntry: (assetId) =>
    set((s) => {
      if (!(assetId in s.proxyByAssetId)) return {}
      const next = { ...s.proxyByAssetId }
      delete next[assetId]
      return { proxyByAssetId: next }
    }),

  openSequence: (sequenceId) => {
    const { doc, activeSequencePath } = get()
    if (!findSequence(doc, sequenceId)) return
    if (activeSequencePath.includes(sequenceId)) return
    get().setActiveSequencePath([...activeSequencePath, sequenceId])
  },

  setActiveSequencePath: (path) => {
    const next = normalizeActivePath(get().doc, path)
    // Opening or leaving a sequence scopes every editing surface, so a stale
    // selection, marker selection or lane posture from the old scope is cleared.
    set({
      activeSequencePath: next,
      selections: [],
      selection: null,
      selectedMarker: null,
      untargetedTracks: [],
    })
  },

  selectTrackClips: (trackId) => {
    const { doc } = get()
    const track = findTrack(doc, trackId)
    if (!track) return
    const ids: string[] = []
    for (const clip of track.clips) {
      if (ids.includes(clip.id)) continue
      ids.push(clip.id)
      for (const member of linkedClips(doc, clip.id)) {
        if (!ids.includes(member.id)) ids.push(member.id)
      }
    }
    set({
      ...normalizeSelections(doc, ids, get().activeSequencePath),
      selectedMarker: null,
    })
  },

  selectMarker: (selection) =>
    set(
      selection
        ? { selectedMarker: selection, selections: [], selection: null }
        : { selectedMarker: null },
    ),

  addSelection: (clipId) => {
    const { doc, selections, activeSequencePath } = get()
    const group = linkedClips(doc, clipId).map((c) => c.id)
    set({
      ...normalizeSelections(doc, [...selections, ...group], activeSequencePath),
      selectedMarker: null,
    })
  },

  toggleSelection: (clipId) => {
    const { doc, selections, activeSequencePath } = get()
    const group = linkedClips(doc, clipId).map((c) => c.id)
    const allIn = group.every((id) => selections.includes(id))
    const next = allIn ? selections.filter((id) => !group.includes(id)) : [...selections, ...group]
    set({ ...normalizeSelections(doc, next, activeSequencePath), selectedMarker: null })
  },

  selectAll: () => {
    const { doc, activeSequencePath } = get()
    set({
      ...normalizeSelections(
        doc,
        activeTracks(doc, activeSequencePath).flatMap((t) => t.clips.map((c) => c.id)),
        activeSequencePath,
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
  setDropMode: (dropMode) => set({ dropMode }),

  setSourceAsset: (assetId) => {
    if (get().sourceAssetId === assetId) return
    // Both marks and the time belong to the asset, so a selection change
    // clears them together (the panel and keys read one truth).
    set({ sourceAssetId: assetId, sourceIn: null, sourceOut: null, sourcePlayhead: 0 })
  },

  setSourcePlayhead: (t) => {
    const { doc, sourceAssetId } = get()
    const asset = sourceAssetId ? doc.media.find((m) => m.id === sourceAssetId) : undefined
    const max = asset && asset.kind !== 'image' && asset.duration > 0 ? asset.duration : undefined
    set({ sourcePlayhead: Math.max(0, max === undefined ? t : Math.min(t, max)) })
  },

  markSourceIn: () => {
    const asset = sourceAssetOf(get())
    if (!asset) return
    set({ sourceIn: Math.min(Math.max(0, get().sourcePlayhead), asset.duration) })
  },

  markSourceOut: () => {
    const asset = sourceAssetOf(get())
    if (!asset) return
    set({ sourceOut: Math.min(Math.max(0, get().sourcePlayhead), asset.duration) })
  },

  clearSourceMarks: () => set({ sourceIn: null, sourceOut: null }),

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
