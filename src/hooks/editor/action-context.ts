'use client'

import { toast } from '@/hooks/use-toast'
import { activeSequenceDuration, createDoc } from '@/lib/editor/factories'
import {
  commandsToFreezeFrame,
  planFreezeFrame,
  type FreezeRefusalReason,
} from '@/lib/editor/freeze-plan'
import { renderFreezeFrame } from '@/lib/editor/media/freeze-frame'
import { storeMediaAsset } from '@/lib/editor/media/persist'
import { PPS_MAX, PPS_MIN, TRACK_HEADER_WIDTH } from '@/lib/editor/constants'
import {
  currentProjectToken,
  downloadProjectJSON,
  importMediaFiles,
  installProject,
  isProjectTokenCurrent,
  openProjectFromPicker,
  pickFiles,
} from '@/lib/editor/project-io'
import { playbackRef } from '@/lib/editor/playback/engine-ref'
import { useEditorStore } from '@/lib/editor/store'
import { importFile } from '@/lib/editor/media/probe'
import type { ActionContext } from '@/lib/editor/action-executor'
import type { MediaAsset } from '@/lib/editor/types'

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

const FREEZE_REFUSAL: Record<FreezeRefusalReason, string> = {
  empty: 'Nothing visible sits under the playhead.',
  offline: 'A visible clip has no media online. Relink it, then freeze the frame.',
  'no-sequence': 'The active sequence is unavailable.',
}

/**
 * Freeze Frame (0.23.0): render the composited frame at the playhead, store the
 * PNG through the normal import path, then add the asset, a new topmost video
 * lane, and the still clip as one undoable batch.
 *
 * The time is captured once, so a scrub during the async render cannot land the
 * still somewhere other than the frame it shows.
 */
export async function freezeFrameAtPlayhead(): Promise<void> {
  const before = useEditorStore.getState()
  const token = currentProjectToken()
  const sequencePath = [...before.activeSequencePath]
  const time = before.playhead
  const plan = planFreezeFrame(before.doc, sequencePath, time)
  if (!plan.ok) {
    toast({
      title: 'Freeze Frame is unavailable',
      description: FREEZE_REFUSAL[plan.reason],
      variant: 'destructive',
    })
    return
  }

  const refuse = (description: string) => {
    toast({ title: 'Freeze Frame is unavailable', description, variant: 'destructive' })
  }
  /** The still may only land on the project and sequence it was captured from. */
  const contextStillCurrent = (): boolean => {
    if (!isProjectTokenCurrent(token)) {
      refuse('The project changed while the frame rendered.')
      return false
    }
    const state = useEditorStore.getState()
    if (state.activeSequencePath.join('/') !== sequencePath.join('/')) {
      refuse('The active sequence changed while the frame rendered.')
      return false
    }
    const current = planFreezeFrame(state.doc, sequencePath, time)
    if (!current.ok) {
      refuse(FREEZE_REFUSAL[current.reason])
      return false
    }
    return true
  }

  let fresh: MediaAsset | null = null
  /** True only once the still's asset is part of the installed doc. */
  let attached = false
  try {
    const file = await renderFreezeFrame(before.doc, sequencePath, time)
    if (!contextStillCurrent()) return
    fresh = await importFile(file)
    if (!contextStillCurrent()) return
    // Store under the captured project: if a new project replaced it during
    // the probe, the token check above cancelled before this write.
    const stored = await storeMediaAsset(token.projectId, fresh)
    if (!contextStillCurrent()) return
    if (stored.warning) {
      toast({
        title: 'Media is session-only',
        description: stored.warning,
        variant: 'destructive',
      })
    }
    const latest = useEditorStore.getState()
    const batch = commandsToFreezeFrame({
      activeSequencePath: sequencePath,
      time,
      asset: stored.asset,
    })
    if (!latest.apply(batch.commands)) return
    attached = true
    useEditorStore.getState().setSelections([batch.clipId])
  } catch (error) {
    reportAsyncFailure('Freeze Frame failed', error)
  } finally {
    // The probed stills owns an object URL until the doc takes it. A cancel or
    // a post-import failure would otherwise leave it alive for the page.
    if (fresh && !attached) URL.revokeObjectURL(fresh.url)
  }
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
        void downloadProjectJSON()
          .then((filename) =>
            toast({ title: 'Project saved', description: `${filename} downloaded` }),
          )
          .catch((error) => reportAsyncFailure('Save failed', error))
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
    freezeFrame: () => {
      void freezeFrameAtPlayhead()
    },
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
