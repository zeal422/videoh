// @vitest-environment jsdom
/**
 * Anti-regression tests for the workspace layout state (workspace.ts).
 *
 * Guards:
 * 1. Defaults + immutable update helpers (hidden/size).
 * 2. `sanitizeWorkspace` never throws and clamps out-of-range/corrupt data,
 *    including legacy collapse data from before 0.19.0.
 * 3. save/load round-trips through an injected storage; corrupt JSON falls
 *    back to defaults instead of crashing the editor on boot.
 * 4. The layout-shape guard and the reset generation tracker.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createResetTracker,
  defaultWorkspace,
  isExpectedPanelLayout,
  KEYFRAME_GRAPH_MAX_HEIGHT,
  KEYFRAME_GRAPH_MIN_HEIGHT,
  loadWorkspace,
  PANEL_BOUNDS,
  PANELS,
  RESET_GROUP_SPECS,
  sanitizeWorkspace,
  saveWorkspace,
  withHidden,
  withKeyframeGraphHeight,
  withSize,
  WORKSPACE_STORAGE_KEY,
  workspaceToJSON,
  type ResetGroupId,
} from '../workspace'
import { useWorkspaceStore } from '../workspace-store'

/** Minimal in-memory Storage double (no Node globals needed). */
function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  }
}

const FULL_RESET_LAYOUTS: Record<ResetGroupId, number[]> = {
  upper: [PANEL_BOUNDS.media.default, PANEL_BOUNDS.source.default, 44],
  top: [74, PANEL_BOUNDS.inspector.default],
  bottom: [76, PANEL_BOUNDS.captions.default],
  vertical: [50, PANEL_BOUNDS.timeline.default],
}

/** Deterministic tracker harness: capture the frame/timer callbacks. */
function trackerHarness() {
  const frames: Array<() => void> = []
  const timers: Array<() => void> = []
  const cancelledFrames: number[] = []
  const cancelledTimers: number[] = []
  const issued: ResetGroupId[][] = []
  let layouts: Partial<Record<ResetGroupId, number[]>> = {}

  const tracker = createResetTracker({
    groups: RESET_GROUP_SPECS,
    hooks: {
      issueResizes: (groups) => issued.push(groups),
      readLayouts: () => layouts,
    },
    scheduleFrame: (callback) => {
      frames.push(callback)
      return frames.length
    },
    cancelFrame: (handle) => cancelledFrames.push(handle),
    scheduleTimer: (callback) => {
      timers.push(callback)
      return timers.length
    },
    cancelTimer: (handle) => cancelledTimers.push(handle),
    fallbackMs: 1000,
    maxRearms: 2,
  })

  return {
    tracker,
    issued,
    cancelledFrames,
    cancelledTimers,
    setLayouts: (next: Partial<Record<ResetGroupId, number[]>>) => {
      layouts = next
    },
    runFrame: (index = frames.length - 1) => frames[index]?.(),
    runTimer: (index = timers.length - 1) => timers[index]?.(),
  }
}

describe('defaults and catalog', () => {
  it('default workspace: all panels visible, with bounded sizes and no collapsed key', () => {
    const ws = defaultWorkspace()
    expect(ws.hidden).toEqual({
      media: false,
      preview: false,
      source: false,
      inspector: false,
      timeline: false,
      captions: false,
    })
    expect('collapsed' in ws).toBe(false)
    expect(ws.sizes.media).toBe(PANEL_BOUNDS.media.default)
    expect(ws.sizes.source).toBe(PANEL_BOUNDS.source.default)
    expect(ws.sizes.inspector).toBe(PANEL_BOUNDS.inspector.default)
    expect(ws.sizes.timeline).toBe(PANEL_BOUNDS.timeline.default)
    expect(ws.sizes.captions).toBe(PANEL_BOUNDS.captions.default)
  })

  it('panel catalog covers exactly the six workspace panels', () => {
    expect(PANELS.map((p) => p.id).sort()).toEqual([
      'captions',
      'inspector',
      'media',
      'preview',
      'source',
      'timeline',
    ])
    expect(PANELS.find((p) => p.id === 'source')!.title).toBe('Source Monitor')
    for (const p of PANELS) {
      expect(p.title.length).toBeGreaterThan(0)
    }
  })

  it('default sizes respect the panel bounds', () => {
    for (const key of ['media', 'source', 'inspector', 'timeline', 'captions'] as const) {
      const b = PANEL_BOUNDS[key]
      expect(b.default).toBeGreaterThanOrEqual(b.min)
      expect(b.default).toBeLessThanOrEqual(b.max)
      expect(b.min).toBeLessThan(b.max)
    }
  })

  it('defaults to the reference panel shares', () => {
    // Media is a share of the media+preview workspace row; the inspector is a
    // share of the top row, and the timeline is a vertical share of the stacked
    // root. 32% of the 74% workspace row is about 24% of the full viewport.
    expect(PANEL_BOUNDS.media.default).toBe(32)
    expect(PANEL_BOUNDS.inspector.default).toBe(26)
    expect(PANEL_BOUNDS.timeline.default).toBe(50)
    expect(defaultWorkspace().sizes.media).toBe(32)
    expect(defaultWorkspace().sizes.timeline).toBe(50)
  })
})

describe('immutable update helpers', () => {
  it('withHidden toggles a single panel without touching others', () => {
    const ws = defaultWorkspace()
    const next = withHidden(ws, 'media', true)
    expect(next.hidden.media).toBe(true)
    expect(next.hidden.timeline).toBe(false)
    // Original untouched (immutability).
    expect(ws.hidden.media).toBe(false)
  })

  it('withSize clamps into panel bounds and keeps identity when equal', () => {
    const ws = defaultWorkspace()
    const clamped = withSize(ws, 'media', 500)
    expect(clamped.sizes.media).toBe(PANEL_BOUNDS.media.max)

    const same = withSize(ws, 'media', ws.sizes.media)
    expect(same).toBe(ws) // no-op returns the same object
  })

  it('withSize clamps the source panel too (the new workspace panel)', () => {
    const ws = withSize(defaultWorkspace(), 'source', 500)
    expect(ws.sizes.source).toBe(PANEL_BOUNDS.source.max)
    expect(ws.sizes.source).toBeGreaterThan(0)
  })
})

describe('sanitizeWorkspace', () => {
  it('returns defaults for garbage input instead of throwing', () => {
    expect(sanitizeWorkspace(null)).toEqual(defaultWorkspace())
    expect(sanitizeWorkspace(undefined)).toEqual(defaultWorkspace())
    expect(sanitizeWorkspace(42)).toEqual(defaultWorkspace())
    expect(sanitizeWorkspace('nonsense')).toEqual(defaultWorkspace())
  })

  it('clamps out-of-range sizes into bounds', () => {
    const ws = sanitizeWorkspace({ sizes: { media: 99, source: 90, inspector: -5, timeline: 12 } })
    expect(ws.sizes.media).toBe(PANEL_BOUNDS.media.max)
    expect(ws.sizes.source).toBe(PANEL_BOUNDS.source.max)
    expect(ws.sizes.inspector).toBe(PANEL_BOUNDS.inspector.min)
    // Below min → clamped to min.
    expect(ws.sizes.timeline).toBe(PANEL_BOUNDS.timeline.min)
  })

  it('ignores a legacy collapsed payload and keeps hidden and sizes', () => {
    const legacy = sanitizeWorkspace({
      sizes: { media: 22, inspector: 30, timeline: 40 },
      collapsed: { media: true, preview: false, inspector: false, timeline: false },
      hidden: { timeline: true },
    })
    expect('collapsed' in legacy).toBe(false)
    expect(legacy.hidden.timeline).toBe(true)
    expect(legacy.sizes.media).toBe(22)
    expect(legacy.sizes.source).toBe(PANEL_BOUNDS.source.default)
  })

  it('clamps a legacy collapsed-strip size to the panel minimum', () => {
    const legacy = sanitizeWorkspace({ sizes: { media: 2.5, captions: 0 } })
    expect(legacy.sizes.media).toBe(PANEL_BOUNDS.media.min)
    expect(legacy.sizes.captions).toBe(PANEL_BOUNDS.captions.min)
  })

  it('never lets a hostile collapsed value reach the returned state', () => {
    const hostile = sanitizeWorkspace({
      collapsed: { media: 'yes', preview: 1, timeline: { open: true } },
    })
    expect('collapsed' in hostile).toBe(false)
    expect(hostile).toEqual(defaultWorkspace())
  })

  it('ignores non-numeric and unknown size keys', () => {
    const ws = sanitizeWorkspace({
      sizes: { media: 'twenty', unknown: 33, inspector: 30 },
    })
    expect(ws.sizes.media).toBe(PANEL_BOUNDS.media.default)
    expect((ws.sizes as Record<string, unknown>)['unknown']).toBeUndefined()
    expect(ws.sizes.inspector).toBe(30)
  })

  it('coerces hidden flags to booleans and fills missing panels', () => {
    const ws = sanitizeWorkspace({
      hidden: { preview: false, bogus: true },
    })
    expect(ws.hidden.preview).toBe(false)
    expect((ws.hidden as Record<string, unknown>)['bogus']).toBeUndefined()
  })
})

describe('persistence (injected storage)', () => {
  it('round-trips through save/load without a collapsed key', () => {
    const storage = fakeStorage()
    const ws = withHidden(
      withSize(withSize(defaultWorkspace(), 'timeline', 50), 'source', 30),
      'preview',
      true,
    )
    saveWorkspace(ws, storage)

    const raw = storage.getItem(WORKSPACE_STORAGE_KEY)
    expect(raw).toBeTruthy()
    expect(raw).not.toContain('collapsed')
    const loaded = loadWorkspace(storage)
    expect(loaded).toEqual(ws)
    // The new panel's size really survives the round trip (it is not dropped
    // by the sanitizer's known-key filter).
    expect(loaded.sizes.source).toBe(30)
  })

  it('load with empty storage yields defaults', () => {
    expect(loadWorkspace(fakeStorage())).toEqual(defaultWorkspace())
  })

  it('corrupt JSON in storage falls back to defaults', () => {
    const storage = fakeStorage({ [WORKSPACE_STORAGE_KEY]: '{not json!' })
    expect(loadWorkspace(storage)).toEqual(defaultWorkspace())
  })

  it('null storage is tolerated (SSR / private mode)', () => {
    expect(() => loadWorkspace(null)).not.toThrow()
    expect(loadWorkspace(null)).toEqual(defaultWorkspace())
    expect(() => saveWorkspace(defaultWorkspace(), null)).not.toThrow()
  })

  it('workspaceToJSON → parse → sanitize equals the original', () => {
    const ws = withSize(defaultWorkspace(), 'inspector', 40)
    const parsed = sanitizeWorkspace(JSON.parse(workspaceToJSON(ws)))
    expect(parsed).toEqual(ws)
  })
})

describe('layout-shape guard', () => {
  const upperSlots = [
    { index: 0, bounds: PANEL_BOUNDS.media },
    { index: 1, bounds: PANEL_BOUNDS.source },
  ]

  it('accepts a full-group layout and ignores the unmapped auto-sized slot', () => {
    expect(isExpectedPanelLayout([32, 24, 44], 3, upperSlots)).toBe(true)
    // The preview is the unmapped third slot; its value is never inspected.
    expect(isExpectedPanelLayout([32, 24, 99], 3, upperSlots)).toBe(true)
  })

  it('rejects length mismatches, out-of-range indices, and non-finite values', () => {
    expect(isExpectedPanelLayout([32, 24], 3, upperSlots)).toBe(false)
    expect(isExpectedPanelLayout([32, 24, 44, 0], 3, upperSlots)).toBe(false)
    expect(isExpectedPanelLayout([32, Number.NaN, 44], 3, upperSlots)).toBe(false)
    expect(isExpectedPanelLayout([32, 24, 44], 3, [{ index: 3, bounds: PANEL_BOUNDS.media }])).toBe(
      false,
    )
  })

  it('rejects per-panel bounds in both directions', () => {
    expect(isExpectedPanelLayout([50, 24, 44], 3, upperSlots)).toBe(false)
    expect(isExpectedPanelLayout([8, 24, 44], 3, upperSlots)).toBe(false)
  })

  it('rejects a forced 100 in a mapped two-panel slot', () => {
    expect(isExpectedPanelLayout([100, 0], 2, [{ index: 1, bounds: PANEL_BOUNDS.inspector }])).toBe(
      false,
    )
  })

  it('accepts a solo top row with no mapped entries', () => {
    expect(isExpectedPanelLayout([100], 1, [])).toBe(true)
  })
})

describe('reset generation tracker', () => {
  it('pre-resize layouts never count', () => {
    const h = trackerHarness()
    const token = h.tracker.begin()
    expect(h.tracker.noteLayout(token, 'upper', FULL_RESET_LAYOUTS.upper)).toBe(false)
    expect(h.tracker.completedGroups()).toEqual([])
  })

  it('an explicit post-issue read counts when no onLayout fired', () => {
    const h = trackerHarness()
    h.setLayouts(FULL_RESET_LAYOUTS)
    h.tracker.begin()
    h.runFrame()
    expect(h.tracker.pendingToken()).toBeNull()
    expect(h.tracker.completedGroups()).toEqual([])
  })

  it('an older token never clears or completes a newer one', () => {
    const h = trackerHarness()
    const first = h.tracker.begin()
    const second = h.tracker.begin()
    expect(h.tracker.noteLayout(first, 'upper', FULL_RESET_LAYOUTS.upper)).toBe(false)
    h.setLayouts(FULL_RESET_LAYOUTS)
    h.runFrame()
    expect(h.tracker.pendingToken()).toBeNull()
    expect(second).toBeGreaterThan(first)
  })

  it('a stale frame callback performs zero resizes', () => {
    const h = trackerHarness()
    h.tracker.begin()
    h.tracker.begin()
    h.runFrame(0)
    expect(h.issued).toEqual([])
  })

  it('a cancel before the first frame makes that frame a no-op', () => {
    const h = trackerHarness()
    h.tracker.begin()
    h.tracker.cancel()
    h.runFrame()
    expect(h.issued).toEqual([])
    expect(h.tracker.pendingToken()).toBeNull()
  })

  it('an in-flight gesture cancel stops the fallback', () => {
    const h = trackerHarness()
    h.setLayouts({ upper: FULL_RESET_LAYOUTS.upper })
    h.tracker.begin()
    h.runFrame()
    const before = h.issued.length
    h.tracker.cancel()
    h.runTimer()
    expect(h.issued.length).toBe(before)
  })

  it('incomplete groups stay suppressed across a fallback and are re-applied exactly once', () => {
    const h = trackerHarness()
    h.setLayouts({ upper: FULL_RESET_LAYOUTS.upper })
    h.tracker.begin()
    h.runFrame()
    expect(h.tracker.completedGroups()).toEqual(['upper'])
    h.setLayouts(FULL_RESET_LAYOUTS)
    h.runTimer()
    expect(h.issued[1]).toEqual(['top', 'bottom', 'vertical'])
    expect(h.tracker.pendingToken()).toBeNull()
  })

  it('completion requires every expected group', () => {
    const h = trackerHarness()
    h.setLayouts({
      upper: FULL_RESET_LAYOUTS.upper,
      top: FULL_RESET_LAYOUTS.top,
      bottom: FULL_RESET_LAYOUTS.bottom,
    })
    h.tracker.begin()
    h.runFrame()
    expect(h.tracker.pendingToken()).not.toBeNull()
    expect(h.tracker.completedGroups().sort()).toEqual(['bottom', 'top', 'upper'])
  })

  it('exhaustion clears the token without completion', () => {
    const h = trackerHarness()
    h.tracker.begin()
    h.runFrame()
    h.runTimer()
    h.runTimer()
    h.runTimer()
    expect(h.tracker.pendingToken()).toBeNull()
    expect(h.tracker.completedGroups()).toEqual([])
  })

  it('a setHidden cancel clears the token and discards completions', () => {
    const h = trackerHarness()
    h.setLayouts({ upper: FULL_RESET_LAYOUTS.upper })
    h.tracker.begin()
    h.runFrame()
    expect(h.tracker.completedGroups()).toEqual(['upper'])
    h.tracker.cancel()
    expect(h.tracker.pendingToken()).toBeNull()
    expect(h.tracker.completedGroups()).toEqual([])
  })
})

describe('keyframe graph heights (0.18.0)', () => {
  it('defaults to an empty map and clamps a stored height', () => {
    expect(defaultWorkspace().keyframeGraphHeights).toEqual({})
    const ws = withKeyframeGraphHeight(defaultWorkspace(), 'opacity', 120)
    expect(ws.keyframeGraphHeights.opacity).toBe(120)
    expect(
      sanitizeWorkspace({ keyframeGraphHeights: { opacity: 120 } }).keyframeGraphHeights,
    ).toEqual({ opacity: 120 })
  })

  it('clamps and drops hostile values', () => {
    const ws = sanitizeWorkspace({
      keyframeGraphHeights: {
        opacity: 9999,
        volume: -4,
        scale: 'tall',
        hue: NaN,
        notAProperty: 100,
      },
    })
    expect(ws.keyframeGraphHeights.opacity).toBe(KEYFRAME_GRAPH_MAX_HEIGHT)
    expect(ws.keyframeGraphHeights.volume).toBe(KEYFRAME_GRAPH_MIN_HEIGHT)
    expect(ws.keyframeGraphHeights.scale).toBeUndefined()
    expect(ws.keyframeGraphHeights.hue).toBeUndefined()
    expect('notAProperty' in ws.keyframeGraphHeights).toBe(false)
  })

  it('old workspaces hydrate with defaults instead of being wiped', () => {
    const ws = sanitizeWorkspace({ sizes: { media: 20 }, hidden: { timeline: true } })
    expect(ws.sizes.media).toBe(20)
    expect(ws.hidden.timeline).toBe(true)
    expect(ws.keyframeGraphHeights).toEqual({})
  })
})

describe('workspace store persistence (0.18.0)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    useWorkspaceStore.setState(defaultWorkspace())
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('does not let a pending size debounce overwrite a keyframe graph height', () => {
    useWorkspaceStore.getState().setSize('media', 25)
    useWorkspaceStore.getState().setKeyframeGraphHeight('opacity', 120)
    // The size write is still pending; the graph-height write must cancel it,
    // or the delayed snapshot reverts the graph height 300 ms later.
    vi.advanceTimersByTime(400)
    const raw = localStorage.getItem(WORKSPACE_STORAGE_KEY)
    expect(raw).toBeTruthy()
    const stored = JSON.parse(raw!) as {
      sizes: { media: number }
      keyframeGraphHeights: { opacity?: number }
    }
    expect(stored.keyframeGraphHeights.opacity).toBe(120)
    expect(stored.sizes.media).toBe(25)
  })

  it('setSize clamps and persists without a collapsed branch', () => {
    useWorkspaceStore.getState().setSize('captions', 90)
    expect(useWorkspaceStore.getState().sizes.captions).toBe(PANEL_BOUNDS.captions.max)
    vi.advanceTimersByTime(400)
    const stored = JSON.parse(localStorage.getItem(WORKSPACE_STORAGE_KEY)!) as {
      sizes: { captions: number }
    }
    expect(stored.sizes.captions).toBe(PANEL_BOUNDS.captions.max)
    expect('collapsed' in stored).toBe(false)
  })
})
