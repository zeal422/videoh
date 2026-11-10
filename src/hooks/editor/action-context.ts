'use client'

import { toast } from '@/hooks/use-toast'
import { activeSequenceDuration, createDoc } from '@/lib/editor/factories'
import { PPS_MAX, PPS_MIN, TRACK_HEADER_WIDTH } from '@/lib/editor/constants'
import {
  downloadProjectJSON,
  importMediaFiles,
  installProject,
  openProjectFromPicker,
  pickFiles,
} from '@/lib/editor/project-io'
import { playbackRef } from '@/lib/editor/playback/engine-ref'
import { useEditorStore } from '@/lib/editor/store'
import type { ActionContext } from '@/lib/editor/action-executor'

/**
 * Browser-bound adapter that fills the pure executor's context from the store
 * and the app's side-effect helpers. It lives outside `src/lib/editor/` so the
 * executor stays Node-testable and the coverage include list stays honest.
 */

function reportAsyncFailure(title: string, error: unknown): void {
  toast({
    title,
    description: error instanceof Error ? error.message : String(error),
    variant: 'destructive',
  })
}

export interface ActionContextOverrides {
  openExport?: () => void
  openGain?: () => void
  /** The keyboard keeps EditorShell's existing save callback. */
  saveProject?: () => void
}

export function createActionContext(overrides: ActionContextOverrides = {}): ActionContext {
  const store = useEditorStore.getState()
  return {
    state: {
      doc: store.doc,
      selections: store.selections,
      selection: store.selection,
      selectedMarker: store.selectedMarker,
      playhead: store.playhead,
      activeSequencePath: store.activeSequencePath,
      untargetedTracks: store.untargetedTracks,
      pxPerSec: store.pxPerSec,
      proxiesEnabled: store.proxiesEnabled,
    },
    undo: store.undo,
    redo: store.redo,
    selectAll: store.selectAll,
    deselectAll: store.deselectAll,
    selectMarker: store.selectMarker,
    setPxPerSec: store.setPxPerSec,
    toggleSnap: store.toggleSnap,
    setProxiesEnabled: store.setProxiesEnabled,
    saveProject:
      overrides.saveProject ??
      (() => {
        const filename = downloadProjectJSON()
        toast({ title: 'Project saved', description: `${filename} downloaded` })
      }),
    newProject: () => {
      installProject(createDoc())
      toast({ title: 'New project created' })
    },
    openProject: () => {
      void openProjectFromPicker().catch((error) =>
        reportAsyncFailure('Open project failed', error),
      )
    },
    importMedia: () => {
      void pickFiles('video/*,audio/*,image/*', true)
        .then(async (files) => {
          if (files.length === 0) return
          const count = await importMediaFiles(files)
          if (count > 0) toast({ title: `Imported ${count} file(s)` })
        })
        .catch((error) => reportAsyncFailure('Import media failed', error))
    },
    openExport: overrides.openExport ?? (() => undefined),
    openGain: overrides.openGain ?? (() => undefined),
    editMarker: () => window.dispatchEvent(new CustomEvent('editor:marker-edit')),
    seek: (time) => playbackRef.current?.seek(time),
    zoomToFit: () => {
      // Read the store again: the context may be a few ticks old by the time a
      // menu action lands.
      const current = useEditorStore.getState()
      const el = document.querySelector('[data-timeline-scroll]')
      const viewport = el ? el.clientWidth - TRACK_HEADER_WIDTH - 12 : 0
      const duration = activeSequenceDuration(current.doc, current.activeSequencePath)
      if (viewport > 40 && duration > 0.25) {
        current.setPxPerSec(Math.min(PPS_MAX, Math.max(PPS_MIN, Math.round(viewport / duration))))
      }
    },
    notify: (message) => toast(message),
  }
}
