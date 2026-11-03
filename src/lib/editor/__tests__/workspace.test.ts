// @vitest-environment jsdom
/**
 * Anti-regression tests for the workspace layout state (workspace.ts).
 *
 * Guards:
 * 1. Defaults + immutable update helpers (hidden/collapsed/size).
 * 2. `sanitizeWorkspace` never throws and clamps out-of-range/corrupt data.
 * 3. save/load round-trips through an injected storage; corrupt JSON falls
 *    back to defaults instead of crashing the editor on boot.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  defaultWorkspace,
  isCollapsedSize,
  KEYFRAME_GRAPH_MAX_HEIGHT,
  KEYFRAME_GRAPH_MIN_HEIGHT,
  loadWorkspace,
  PANEL_BOUNDS,
  PANELS,
  sanitizeWorkspace,
  saveWorkspace,
  withCollapsed,
  withHidden,
  withKeyframeGraphHeight,
  withSize,
  WORKSPACE_STORAGE_KEY,
  workspaceToJSON,
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

describe('defaults and catalog', () => {
  it('default workspace: all panels visible, expanded, with bounded sizes', () => {
    const ws = defaultWorkspace()
    expect(ws.hidden).toEqual({
      media: false,
      preview: false,
      source: false,
      inspector: false,
      timeline: false,
      captions: false,
    })
    expect(ws.collapsed).toEqual({
      media: false,
      preview: false,
      source: false,
      inspector: false,
      timeline: false,
      captions: false,
    })
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

  it('withCollapsed toggles a single panel', () => {
    const ws = withCollapsed(defaultWorkspace(), 'timeline', true)
    expect(ws.collapsed.timeline).toBe(true)
    expect(ws.collapsed.media).toBe(false)
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

  it('isCollapsedSize only matches collapsed-strip sizes', () => {
    expect(isCollapsedSize(2.5)).toBe(true)
    expect(isCollapsedSize(0)).toBe(true)
    expect(isCollapsedSize(3.0)).toBe(true) // within tolerance
    expect(isCollapsedSize(PANEL_BOUNDS.media.min)).toBe(false)
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

  it('a stored layout from before the Source panel simply lacks the key', () => {
    // Forward-compat migration: the old four-panel shape loads as valid, with
    // the new panel taking its default (and staying visible).
    const legacy = sanitizeWorkspace({
      sizes: { media: 22, inspector: 30, timeline: 40 },
      collapsed: { media: true, preview: false, inspector: false, timeline: false },
      hidden: { media: false, preview: false, inspector: false, timeline: false },
    })
    expect(legacy.sizes.source).toBe(PANEL_BOUNDS.source.default)
    expect(legacy.hidden.source).toBe(false)
    expect(legacy.collapsed.media).toBe(true)
  })

  it('a stored layout from before the Captions panel simply lacks the key', () => {
    // Same forward-compat migration one release later: the five-size shape
    // loads as valid, with captions taking its default (and staying visible).
    const legacy = sanitizeWorkspace({
      sizes: { media: 22, source: 24, inspector: 30, timeline: 40 },
      collapsed: { media: true, preview: false, source: false, inspector: false, timeline: false },
      hidden: { media: false, preview: false, source: false, inspector: false, timeline: false },
    })
    expect(legacy.sizes.captions).toBe(PANEL_BOUNDS.captions.default)
    expect(legacy.hidden.captions).toBe(false)
    expect(legacy.collapsed.captions).toBe(false)
    expect(legacy.sizes.media).toBe(22)
  })

  it('withSize stores the captions width inside its bounds', () => {
    const ws = withSize(defaultWorkspace(), 'captions', 30)
    expect(ws.sizes.captions).toBe(30)
    expect(withSize(defaultWorkspace(), 'captions', 90).sizes.captions).toBe(
      PANEL_BOUNDS.captions.max,
    )
  })

  it('ignores non-numeric and unknown size keys', () => {
    const ws = sanitizeWorkspace({
      sizes: { media: 'twenty', unknown: 33, inspector: 30 },
    })
    expect(ws.sizes.media).toBe(PANEL_BOUNDS.media.default)
    expect((ws.sizes as Record<string, unknown>)['unknown']).toBeUndefined()
    expect(ws.sizes.inspector).toBe(30)
  })

  it('coerces hidden/collapsed flags to booleans and fills missing panels', () => {
    const ws = sanitizeWorkspace({
      collapsed: { media: true, timeline: 'yes' },
      hidden: { preview: false, bogus: true },
    })
    expect(ws.collapsed.media).toBe(true)
    expect(ws.collapsed.timeline).toBe(false) // non-boolean → false
    expect(ws.collapsed.preview).toBe(false) // missing → false
    expect(ws.hidden.preview).toBe(false)
    expect((ws.hidden as Record<string, unknown>)['bogus']).toBeUndefined()
  })
})

describe('persistence (injected storage)', () => {
  it('round-trips through save/load', () => {
    const storage = fakeStorage()
    const ws = withHidden(
      withSize(
        withSize(withCollapsed(defaultWorkspace(), 'media', true), 'timeline', 50),
        'source',
        30,
      ),
      'preview',
      true,
    )
    saveWorkspace(ws, storage)

    expect(storage.getItem(WORKSPACE_STORAGE_KEY)).toBeTruthy()
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
})
