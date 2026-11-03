'use client'

import { create } from 'zustand'

import {
  defaultWorkspace,
  isCollapsedSize,
  loadWorkspace,
  saveWorkspace,
  withCollapsed,
  withHidden,
  withKeyframeGraphHeight,
  withSize,
  type PanelId,
  type WorkspaceState,
} from './workspace'
import type { KeyframeProperty } from './types'

/**
 * UI-side workspace store (panel sizes / collapse / visibility).
 *
 * Backed by the pure `workspace.ts` functions; every mutation is persisted to
 * localStorage (sizes are debounced because the layout engine reports many
 * intermediate values while the user drags a handle).
 */

interface WorkspaceStoreState extends WorkspaceState {
  setHidden: (id: PanelId, hidden: boolean) => void
  toggleHidden: (id: PanelId) => void
  toggleCollapsed: (id: PanelId) => void
  setCollapsed: (id: PanelId, collapsed: boolean) => void
  setSize: (id: 'media' | 'source' | 'inspector' | 'timeline' | 'captions', size: number) => void
  setKeyframeGraphHeight: (property: KeyframeProperty, height: number) => void
  resetWorkspace: () => void
}

let sizeDebounce: ReturnType<typeof setTimeout> | null = null

function getPreferredStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  return typeof window === 'undefined' ? null : window.localStorage
}

export const useWorkspaceStore = create<WorkspaceStoreState>((set, get) => {
  // Safe on the server too — loadWorkspace(null) returns defaults there.
  const initial = loadWorkspace(typeof window === 'undefined' ? null : getPreferredStorage())

  const persist = (state: WorkspaceState) => {
    // An immediate write supersedes any pending size debounce: the timer holds
    // a snapshot from before this change and would otherwise overwrite it 300ms
    // later (the keyframe graph height was the visible case).
    if (sizeDebounce) {
      clearTimeout(sizeDebounce)
      sizeDebounce = null
    }
    saveWorkspace(state, getPreferredStorage())
  }

  return {
    ...initial,

    setHidden: (id, hidden) => {
      if (get().hidden[id] === hidden) return
      const next = withHidden(get(), id, hidden)
      set(next)
      persist(next)
    },

    toggleHidden: (id) => {
      get().setHidden(id, !get().hidden[id])
    },

    toggleCollapsed: (id) => {
      const next = withCollapsed(get(), id, !get().collapsed[id])
      set(next)
      persist(next)
    },

    setCollapsed: (id, collapsed) => {
      if (get().collapsed[id] === collapsed) return
      const next = withCollapsed(get(), id, collapsed)
      set(next)
      persist(next)
    },

    setSize: (id, size) => {
      // The layout engine reports collapsed strips (~2.5%) too — never store
      // those as the panel's "expanded" size and keep the flag in sync so a
      // drag-collapse is reflected by the Window menu after a reload.
      if (isCollapsedSize(size)) {
        get().setCollapsed(id, true)
        return
      }
      const next = withCollapsed(withSize(get(), id, size), id, false)
      if (next === get()) return
      set(next)
      // Sizes stream in continuously while dragging — debounce the writes.
      if (sizeDebounce) clearTimeout(sizeDebounce)
      sizeDebounce = setTimeout(() => {
        sizeDebounce = null
        persist(next)
      }, 300)
    },

    setKeyframeGraphHeight: (property, height) => {
      const next = withKeyframeGraphHeight(get(), property, height)
      if (next === get()) return
      set(next)
      persist(next)
    },

    resetWorkspace: () => {
      const next = defaultWorkspace()
      set(next)
      persist(next)
    },
  }
})

/** Maps a persisted size for a panel to its initial collapsed flag. */
export function initialCollapsedFromSize(size: number | undefined): boolean {
  return size !== undefined && isCollapsedSize(size)
}
