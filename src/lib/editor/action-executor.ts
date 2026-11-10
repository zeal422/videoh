import type { EditorCommand } from './commands'
import {
  commandsToAddMarker,
  commandsToAddText,
  commandsToCreateCompoundClip,
  commandsToDeleteClips,
  commandsToDeleteMarker,
  commandsToDuplicateClips,
  commandsToLinkClips,
  commandsToRippleDeleteClips,
  commandsToSplitAllAt,
  commandsToSplitClipsAt,
  commandsToUnlinkClips,
} from './actions'
import { commandsToCutClips, commandsToPasteClips, copyClips } from './clipboard'
import { findClip, uid } from './factories'
import { anySelectionLinked, audibleClipId, canLinkClips } from './links'
import { markerSelectionExists as markerExists, neighborMarker } from './markers'
import type { MarkerSelection } from './markers'
import type { MenuActionId } from './menus'
import { nextZoomPxPerSec } from './timeline-scroll'
import type { Doc } from './types'

/**
 * Policy-free action dispatch (0.20.0).
 *
 * The menu, toolbar, and keyboard all used to inline the same command batches.
 * This module maps an action id to the batch (or a store-only/callback-only
 * outcome) once. It never imports the global store: callers pass a snapshot
 * plus injected mutators and side-effect callbacks, so the pure branch runs in
 * Node tests.
 *
 * Contract:
 * - `handled: false` means the executor does not own the action; the caller
 *   keeps its UI switch (dialogs, window toggles, help).
 * - `handled: true, commands: null` means the action was owned and produced no
 *   command batch (a store call, a callback, a refusal, or a no-op).
 * - `commands` is applied by the caller with `store.apply`. `successToast` is
 *   shown only after that apply lands, so a locked-track refusal stays silent.
 */

export interface ActionState {
  doc: Doc
  selections: string[]
  selection: string | null
  selectedMarker: MarkerSelection | null
  playhead: number
  activeSequencePath: string[]
  untargetedTracks: string[]
  pxPerSec: number
  proxiesEnabled: boolean
}

export interface ActionToast {
  title: string
  description?: string
  variant?: 'destructive'
}

export interface ActionContext {
  state: ActionState
  /** Store-only surfaces; the executor never imports the store. */
  undo: () => void
  redo: () => void
  selectAll: () => void
  deselectAll: () => void
  selectMarker: (selection: MarkerSelection | null) => void
  setPxPerSec: (pps: number) => void
  toggleSnap: () => void
  setProxiesEnabled: (enabled: boolean) => void
  /** Side-effect callbacks. Toast ownership is explicit: the executor notifies
   * for copy/compound refusals; callers own their save/open/import toasts. */
  saveProject: () => void
  newProject: () => void
  openProject: () => void
  importMedia: () => void
  openExport: () => void
  openGain: () => void
  editMarker: () => void
  seek: (time: number) => void
  zoomToFit: () => void
  notify: (toast: ActionToast) => void
}

export interface ActionOutcome {
  handled: boolean
  commands: EditorCommand[] | null
  /** Shown only after the caller's apply succeeds. */
  successToast?: string
}

/** The keyboard's marker-first Delete is an internal action, not a menu id. */
export type ExecutorActionId = MenuActionId | 'keyboard.delete' | 'keyboard.linkToggle'

function selectedIds(state: ActionState): string[] {
  return state.selections.length > 0 ? state.selections : state.selection ? [state.selection] : []
}

function handled(commands: EditorCommand[] | null = null, successToast?: string): ActionOutcome {
  return {
    handled: true,
    commands,
    ...(successToast ? { successToast } : {}),
  }
}

function sequenceField(state: ActionState): { sequenceId?: string } {
  const id = state.activeSequencePath[state.activeSequencePath.length - 1]
  return id ? { sequenceId: id } : {}
}

function addTrackCommand(action: 'video' | 'audio' | 'text', state: ActionState): ActionOutcome {
  return handled([
    { type: 'addTrack', kind: action, trackId: uid('track'), ...sequenceField(state) },
  ])
}

/** The marker-first Delete the keyboard owns: marker, then clip selection. */
function deleteKeyboard(state: ActionState, ctx: ActionContext): ActionOutcome {
  const marker = state.selectedMarker
  if (marker) {
    if (markerExists(state.doc, marker)) {
      const commands = commandsToDeleteMarker(state.doc, marker)
      return handled(commands)
    }
    // A stale marker selection is dropped and the clip path runs below.
    ctx.selectMarker(null)
  }
  const ids = selectedIds(state)
  return handled(ids.length > 0 ? commandsToDeleteClips(state.doc, ids) : null)
}

/**
 * Resolve one action. Command batches are returned; state-only surfaces are
 * called through `ctx`; UI-owned actions return `handled: false`.
 */
export function executeAction(action: ExecutorActionId, ctx: ActionContext): ActionOutcome {
  const state = ctx.state
  const ids = selectedIds(state)

  switch (action) {
    case 'file.newProject':
      ctx.newProject()
      return handled()
    case 'file.openProject':
      ctx.openProject()
      return handled()
    case 'file.importMedia':
      ctx.importMedia()
      return handled()
    case 'file.saveProject':
      ctx.saveProject()
      return handled()
    case 'file.exportMedia':
      ctx.openExport()
      return handled()

    case 'edit.undo':
      ctx.undo()
      return handled()
    case 'edit.redo':
      ctx.redo()
      return handled()
    case 'edit.selectAll':
      ctx.selectAll()
      return handled()
    case 'edit.deselectAll':
      ctx.deselectAll()
      return handled()

    case 'clip.split':
      return handled(
        ids.length > 0
          ? commandsToSplitClipsAt(state.doc, ids, state.playhead)
          : commandsToSplitAllAt(state.doc, state.playhead, state.activeSequencePath),
      )
    case 'clip.duplicate':
      return handled(ids.length > 0 ? commandsToDuplicateClips(state.doc, ids) : null)
    case 'clip.delete':
      return handled(ids.length > 0 ? commandsToDeleteClips(state.doc, ids) : null)
    case 'clip.rippleDelete':
      return handled(
        ids.length > 0
          ? commandsToRippleDeleteClips(state.doc, ids, state.activeSequencePath)
          : null,
      )
    case 'clip.cut':
      return handled(ids.length > 0 ? commandsToCutClips(state.doc, ids) : null)
    case 'clip.copy': {
      if (ids.length === 0) return handled()
      const copied = copyClips(state.doc, ids)
      if (copied > 0) {
        ctx.notify({ title: `Copied ${copied} clip${copied > 1 ? 's' : ''}` })
      }
      return handled()
    }
    case 'clip.paste':
      return handled(
        commandsToPasteClips(
          state.doc,
          state.playhead,
          state.untargetedTracks,
          state.activeSequencePath[state.activeSequencePath.length - 1],
        ),
      )
    case 'clip.link': {
      if (!canLinkClips(state.doc, ids)) return handled()
      // The MenuBar row links or merges only. Smart link/unlink toggling is
      // the keyboard's separate action below, so a mixed selection can never
      // unlink clips from the Link row.
      return handled(commandsToLinkClips(state.doc, ids), 'Clips linked')
    }
    case 'keyboard.linkToggle': {
      if (ids.length === 0) return handled()
      // Ctrl+L is a smart toggle (Premiere): linked selection unlinks, two
      // separate groups link.
      if (anySelectionLinked(state.doc, ids)) {
        return handled(commandsToUnlinkClips(state.doc, ids))
      }
      if (!canLinkClips(state.doc, ids)) return handled()
      return handled(commandsToLinkClips(state.doc, ids))
    }
    case 'clip.unlink': {
      if (ids.length === 0 || !anySelectionLinked(state.doc, ids)) return handled()
      return handled(commandsToUnlinkClips(state.doc, ids), 'Audio and video unlinked')
    }
    case 'clip.toggleMute': {
      const primary = ids[0]
      if (!primary) return handled()
      // A stale selection can outlive its clip; treat it as a no-op like the
      // old MenuBar guard did instead of emitting an Unknown clip command.
      if (!findClip(state.doc, primary)) return handled()
      // Mute is an AUDIO property: always target the linked pair's audio twin.
      const audibleId = audibleClipId(state.doc, primary)
      const audible = findClip(state.doc, audibleId)?.clip
      return handled([
        {
          type: 'setClipMuted',
          clipId: audibleId,
          muted: !(audible?.muted ?? false),
        },
      ])
    }
    case 'clip.audioGain':
      ctx.openGain()
      return handled()

    case 'sequence.addVideoTrack':
      return addTrackCommand('video', state)
    case 'sequence.addAudioTrack':
      return addTrackCommand('audio', state)
    case 'sequence.addTextTrack':
      return addTrackCommand('text', state)
    case 'sequence.createCompound': {
      const commands = commandsToCreateCompoundClip(state.doc, ids)
      if (!commands) {
        ctx.notify({
          title: 'Cannot create a compound clip',
          description: 'Select at least one clip on a video lane.',
          variant: 'destructive',
        })
        return handled()
      }
      return handled(commands)
    }

    case 'marker.add':
      return handled(commandsToAddMarker(state.doc, state.playhead, ids, state.activeSequencePath))
    case 'marker.edit':
      ctx.editMarker()
      return handled()
    case 'marker.delete':
      return handled(
        state.selectedMarker ? commandsToDeleteMarker(state.doc, state.selectedMarker) : null,
      )
    case 'marker.next':
    case 'marker.previous': {
      const point = neighborMarker(
        state.doc,
        state.playhead,
        action === 'marker.next' ? 'next' : 'prev',
        state.activeSequencePath,
      )
      if (point) ctx.seek(point.timelineTime)
      return handled()
    }

    case 'graphics.newText':
      return handled(
        commandsToAddText(
          state.doc,
          state.playhead,
          state.untargetedTracks,
          state.activeSequencePath[state.activeSequencePath.length - 1],
        ),
      )

    case 'view.zoomIn':
      ctx.setPxPerSec(nextZoomPxPerSec(state.pxPerSec, 1.4))
      return handled()
    case 'view.zoomOut':
      ctx.setPxPerSec(nextZoomPxPerSec(state.pxPerSec, 1 / 1.4))
      return handled()
    case 'view.zoomFit':
      ctx.zoomToFit()
      return handled()
    case 'view.toggleSnap':
      ctx.toggleSnap()
      return handled()
    case 'view.useProxies':
      ctx.setProxiesEnabled(!state.proxiesEnabled)
      return handled()

    case 'keyboard.delete':
      return deleteKeyboard(state, ctx)

    default:
      // UI-owned actions (dialogs, window toggles, help) stay with the caller.
      return { handled: false, commands: null }
  }
}
