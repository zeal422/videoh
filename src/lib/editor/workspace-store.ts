'use client'

import { create } from 'zustand'

import {
  defaultWorkspace,
  loadWorkspace,
  saveWorkspace,
  withHidden,
  withKeyframeGraphHeight,
  withSize,
  type PanelId,
  type PanelSizeId,
  type WorkspaceState,
} from './workspace'
import type { KeyframeProperty } from './types'

/**
 * UI-side workspace store (panel sizes / visibility).
 *
 * Backed by the pure `workspace.ts` functions; every mutation is persisted to
 * localStorage (sizes are debounced because the layout engine reports many
 * intermediate values while the user drags a handle).
 */

interface WorkspaceStoreState extends WorkspaceState {
  setHidden: (id: PanelId, hidden: boolean) => void
  toggleHidden: (id: PanelId) => void
  setSize: (id: PanelSizeId, size: number) => void
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

    setSize: (id, size) => {
      const next = withSize(get(), id, size)
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
