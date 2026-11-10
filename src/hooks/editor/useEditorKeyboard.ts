'use client'

import { useEffect } from 'react'
import { commandsToPlaceSource } from '@/lib/editor/actions'
import { activeSequenceDuration, activeTracks } from '@/lib/editor/factories'
import { markerSelectionExists } from '@/lib/editor/markers'
import {
  placementRefusalMessage,
  sourceRangeFor,
  sourceRangeInvalid,
  SOURCE_RANGE_MESSAGE,
} from '@/lib/editor/sequence-ops'
import { toast } from '@/hooks/use-toast'
import { FRAME_STEPS } from '@/lib/editor/constants'
import { playbackRef } from '@/lib/editor/playback/engine-ref'
import { executeAction, type ExecutorActionId } from '@/lib/editor/action-executor'
import { createActionContext } from './action-context'
import { useEditorStore } from '@/lib/editor/store'
import { isAutomationGestureLive } from './gesture-state'

/**
 * Global keyboard shortcuts (skipped while typing in inputs/textareas).
 *
 * The map mirrors Adobe Premiere Pro's DEFAULT keybindings (verified against
 * Adobe's shortcut docs, Jan 2026); app-specific keys that Premiere cannot
 * map 1:1 are marked. One table — the Help > Shortcuts dialog mirrors it:
 *
 * | Key                    | Action                                             |
 * |------------------------|----------------------------------------------------|
 * | V                      | Selection tool                                     |
 * | C                      | Razor tool (click a clip to cut it)                |
 * | B                      | Ripple trim tool (shifts only the same track)      |
 * | Y                      | Slip tool (changes the source window, not the clip)|
 * | P                      | Pen tool (keyframes on the selected clip)          |
 * | Escape                 | Back to the selection tool                         |
 * | Space                  | Play / pause (not on a focused button)             |
 * | J / K / L              | Shuttle stop / stop / play                         |
 * | ← / →                  | Step 1 frame                                       |
 * | Shift+← / Shift+→      | Step 5 frames                                      |
 * | ↑ / ↓                  | Previous / next edit point (cut)                   |
 * | Home / End             | Jump to start / end                                |
 * | S                      | Toggle snapping                                    |
 * | Ctrl+K                 | Add Edit — split selection (or all tracks) at playhead |
 * | Delete / Backspace     | Delete selection (whole link groups)               |
 * | Shift+Delete           | Ripple delete — delete AND close the gap           |
 * | Ctrl+X / Ctrl+C / Ctrl+V | Cut / copy / paste (multi-selection aware)       |
 * | Ctrl+A / Ctrl+Shift+A  | Select all / deselect all                          |
 * | Shift+click            | Add clip (its link group) to the selection         |
 * | Ctrl+click             | Toggle clip (its link group) in the selection      |
 * | Ctrl+L                 | Link selection — or unlink when already linked     |
 * | Ctrl+Shift+/           | Duplicate selection                                |
 * | D                      | Duplicate selection                                |
 * | M                      | Add marker (clip marker when a clip is selected)   |
 * | Shift+M / Ctrl+Shift+M | Go to next / previous marker                       |
 * | I / O                  | Mark source In / Out at the source playhead        |
 * | , / .                  | Insert / overwrite the marked source at the playhead |
 * | Shift+E                | Mute / unmute the selected clip's audio side (app   |
 * |                        | mapping: Premiere uses Shift+E for clip enable)     |
 * | T                      | Add text clip at playhead (Premiere Type tool)     |
 * | G                      | Audio Gain dialog                                  |
 * | Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y | Undo / redo / redo                         |
 * | Ctrl+S                 | Save project JSON                                  |
 * | + / −                  | Zoom timeline                                      |
 * | \                      | Zoom timeline to fit the whole sequence            |
 */
export function useEditorKeyboard(onSave: () => void): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // A focused control that already consumed the key (radiogroup arrows, a
      // dialog's own shortcut) must not also drive the editor.
      if (e.defaultPrevented) return
      const target = e.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return
      }

      const store = useEditorStore.getState()
      const { doc, playhead, selections, selection, selectedMarker } = store
      // Multi-selection source of truth; falls back to the primary id.
      const selectedIds = selections.length > 0 ? selections : selection ? [selection] : []
      const primaryId = selectedIds[0] ?? null
      const mod = e.ctrlKey || e.metaKey
      const key = e.key.toLowerCase()

      /** One executor call; returns the outcome so callers can decide preventDefault. */
      const run = (action: ExecutorActionId) => {
        try {
          const outcome = executeAction(action, createActionContext({ saveProject: onSave }))
          if (outcome.commands) {
            const applied = store.apply(outcome.commands)
            if (applied && outcome.successToast) toast({ title: outcome.successToast })
          }
          return outcome
        } catch (error) {
          toast({
            title: 'Action failed',
            description: error instanceof Error ? error.message : String(error),
            variant: 'destructive',
          })
          return { handled: true, commands: null }
        }
      }

      // ————— modifier combos —————
      if (mod && key === 'z') {
        e.preventDefault()
        run(e.shiftKey ? 'edit.redo' : 'edit.undo')
        return
      }
      if (mod && key === 'y') {
        e.preventDefault()
        run('edit.redo')
        return
      }
      if (mod && key === 's') {
        e.preventDefault()
        run('file.saveProject')
        return
      }
      if (mod && key === 'a') {
        e.preventDefault()
        run(e.shiftKey ? 'edit.deselectAll' : 'edit.selectAll')
        return
      }
      if (mod && key === 'x') {
        if (selectedIds.length > 0) {
          e.preventDefault()
          run('clip.cut')
        }
        return
      }
      if (mod && key === 'c') {
        if (selectedIds.length > 0) {
          e.preventDefault()
          run('clip.copy')
        }
        return
      }
      if (mod && key === 'v') {
        e.preventDefault()
        run('clip.paste')
        return
      }
      if (mod && key === 'k') {
        // Premiere "Add Edit": split the selection at the playhead — or, with
        // nothing selected, every clip on every track the playhead crosses.
        e.preventDefault()
        run('clip.split')
        return
      }
      if (mod && key === 'l') {
        // Premiere toggle: linked selection unlinks; ≥2 separate clips link.
        e.preventDefault()
        run('keyboard.linkToggle')
        return
      }
      if (mod && e.shiftKey && key === 'm') {
        // Premiere Ctrl+Shift+M: go to the previous marker.
        e.preventDefault()
        run('marker.previous')
        return
      }
      if (!mod && e.shiftKey && key === 'm') {
        // Premiere Shift+M: go to the next marker.
        e.preventDefault()
        run('marker.next')
        return
      }
      if (mod && e.shiftKey && (e.key === '/' || e.key === '?')) {
        // Premiere "Duplicate" (Ctrl+Shift+/) — same as the D alias below.
        if (selectedIds.length > 0) {
          e.preventDefault()
          run('clip.duplicate')
        }
        return
      }

      // ————— single keys —————
      // A live gesture owns the tool. Switching mid-drag would change the
      // toolbar under a gesture whose closures still run the old tool, and the
      // 0.15.0 contract says Escape does not cancel a live gesture. The tool
      // keys wait for pointerup/pointercancel.
      // A pending automation press (a dot down before the 3px drag threshold,
      // or an armed Alt-click) owns the tool keys too, even though no transient
      // has started yet. The envelope marks the gesture on its root.
      const switchTool = (tool: 'select' | 'razor' | 'ripple' | 'slip' | 'pen') => {
        if (isAutomationGestureLive()) return
        store.setActiveTool(tool)
      }
      // Ctrl/Meta keys belong to the browser and the modifier combos above.
      // Without this gate every unmatched combo fell through to the single-key
      // map: Ctrl+P opened print AND selected the Pen, Ctrl+B ripple-trimmed,
      // Ctrl+D duplicated. Shift is deliberately NOT gated: the uppercase case
      // labels below are the Shift+letter shortcuts.
      if (mod) return
      switch (e.key) {
        case 'v':
        case 'V': {
          switchTool('select')
          break
        }
        case 'c':
        case 'C': {
          // Premiere razor tool: click a clip to cut it (ClipView handles it).
          switchTool('razor')
          break
        }
        case 'b':
        case 'B': {
          // Ripple trim: edge drags trim and shift the SAME track's later
          // clips. Linked partners on other tracks stay put (0.15.0).
          switchTool('ripple')
          break
        }
        case 'y':
        case 'Y': {
          // Slip: a body drag moves the source window, never the clip.
          switchTool('slip')
          break
        }
        case 'p':
        case 'P': {
          // Pen: add, drag, or remove keyframes on the selected clip's
          // automation curve (volume on audio, opacity on picture).
          switchTool('pen')
          break
        }
        case 'Escape': {
          if (isAutomationGestureLive()) break
          store.setActiveTool('select')
          store.selectMarker(null)
          break
        }
        case ' ': {
          // A focused button owns Space: native activation (the fullscreen
          // toggle included) must win over playback.
          if (
            target instanceof HTMLElement &&
            target.closest('button, [role="button"], [role="menuitem"], [role="menuitemcheckbox"]')
          ) {
            break
          }
          e.preventDefault()
          playbackRef.current?.toggle()
          break
        }
        case 'j':
        case 'J': {
          // Shuttle: reverse playback is not supported in the browser engine —
          // J stops, exactly like K (Premiere's shuttle without reverse).
          if (store.playing) playbackRef.current?.pause()
          break
        }
        case 'k':
        case 'K': {
          if (store.playing) playbackRef.current?.pause()
          break
        }
        case 'l':
        case 'L': {
          if (!store.playing) playbackRef.current?.play()
          break
        }
        case 'Delete':
        case 'Backspace': {
          // A LIVE selected marker owns the Delete key; clips otherwise. A
          // stale marker selection is dropped, then the ordinary Shift-aware
          // clip branch runs, so a dangling selection never eats the key or
          // turns Shift+Delete into a plain delete.
          if (selectedMarker) {
            if (markerSelectionExists(doc, selectedMarker)) {
              e.preventDefault()
              run('keyboard.delete')
              return
            }
            store.selectMarker(null)
          }
          if (selectedIds.length > 0) {
            e.preventDefault()
            // Premiere Ripple Delete (Shift) removes AND closes the gap.
            run(e.shiftKey ? 'clip.rippleDelete' : 'clip.delete')
          }
          break
        }
        case 's':
        case 'S': {
          // Premiere: S toggles snapping (split lives on Ctrl+K now).
          run('view.toggleSnap')
          break
        }
        case 'd':
        case 'D': {
          if (selectedIds.length > 0) {
            e.preventDefault()
            run('clip.duplicate')
          }
          break
        }
        case 'm':
        case 'M': {
          // Premiere M: add a marker — a clip marker on the primary selected
          // clip when there is one (clamped into its visible span), otherwise
          // a sequence marker at the playhead. Shift+M navigates (above).
          e.preventDefault()
          run('marker.add')
          break
        }
        case 'e':
        case 'E': {
          // Shift+E mutes: Premiere binds Shift+E to clip enable/disable, the
          // closest match this app has (its mute only owns the audio side).
          if (!e.shiftKey) break
          if (primaryId) {
            e.preventDefault()
            run('clip.toggleMute')
          }
          break
        }
        case 'g':
        case 'G': {
          // Premiere: G opens Audio Gain. The dialog lives in the MenuBar —
          // opened via an app event to keep the hook component-free.
          window.dispatchEvent(new CustomEvent('editor:audio-gain'))
          break
        }
        case 't':
        case 'T': {
          e.preventDefault()
          run('graphics.newText')
          break
        }
        case 'i':
        case 'I': {
          // Premiere: I marks the source In at the source monitor's playhead.
          // Ignored without a source selection (and inside form fields, like
          // every binding here).
          if (!store.sourceAssetId) break
          store.markSourceIn()
          break
        }
        case 'o':
        case 'O': {
          if (!store.sourceAssetId) break
          store.markSourceOut()
          break
        }
        case ',':
        case '.': {
          // Three-point editing: place the marked span (or the whole asset)
          // at the sequence playhead. `,` inserts, `.` overwrites. Independent
          // of the sticky drop-mode toggle, like Premiere's defaults.
          const source = store.sourceAssetId
            ? doc.media.find((m) => m.id === store.sourceAssetId)
            : undefined
          if (!source) break // no source selected: a no-op
          const range = sourceRangeFor(source, store.sourceIn, store.sourceOut)
          if (sourceRangeInvalid(range)) {
            toast({
              title: 'Cannot place source',
              description: SOURCE_RANGE_MESSAGE,
              variant: 'destructive',
            })
            break
          }
          e.preventDefault()
          const outcome = commandsToPlaceSource(
            doc,
            source,
            playhead,
            e.key === ',' ? 'insert' : 'overwrite',
            range,
            store.untargetedTracks,
            store.activeSequencePath[store.activeSequencePath.length - 1],
          )
          if (!outcome.commands) {
            toast({
              title: 'Placement refused',
              description: placementRefusalMessage(outcome.refusal ?? 'span'),
              variant: 'destructive',
            })
            break
          }
          store.apply(outcome.commands)
          break
        }
        case 'ArrowLeft': {
          e.preventDefault()
          playbackRef.current?.stepFrames(e.shiftKey ? -FRAME_STEPS : -1)
          break
        }
        case 'ArrowRight': {
          e.preventDefault()
          playbackRef.current?.stepFrames(e.shiftKey ? FRAME_STEPS : 1)
          break
        }
        case 'ArrowUp': {
          e.preventDefault()
          const point = nearestEditPoint(doc, playhead, 'prev', store.activeSequencePath)
          if (point !== null) playbackRef.current?.seek(point)
          break
        }
        case 'ArrowDown': {
          e.preventDefault()
          const point = nearestEditPoint(doc, playhead, 'next', store.activeSequencePath)
          if (point !== null) playbackRef.current?.seek(point)
          break
        }
        case 'Home': {
          e.preventDefault()
          playbackRef.current?.seek(0)
          break
        }
        case 'End': {
          e.preventDefault()
          playbackRef.current?.seek(activeSequenceDuration(doc, store.activeSequencePath))
          break
        }
        case '+':
        case '=': {
          run('view.zoomIn')
          break
        }
        case '-':
        case '_': {
          run('view.zoomOut')
          break
        }
        case '\\': {
          // Premiere backslash: zoom the timeline so the whole sequence fits.
          run('view.zoomFit')
          break
        }
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onSave])
}

/**
 * Previous/next edit point (Premiere ↑/↓): the nearest clip boundary across
 * ALL tracks, strictly before/after the playhead (null when none).
 */
function nearestEditPoint(
  doc: ReturnType<typeof useEditorStore.getState>['doc'],
  playhead: number,
  dir: 'prev' | 'next',
  activeSequencePath: readonly string[] = [],
): number | null {
  const EPS = 1e-3
  let best: number | null = null
  for (const track of activeTracks(doc, activeSequencePath)) {
    for (const c of track.clips) {
      for (const boundary of [c.start, c.start + c.duration]) {
        if (dir === 'next' ? boundary > playhead + EPS : boundary < playhead - EPS) {
          if (best === null || (dir === 'next' ? boundary < best : boundary > best)) best = boundary
        }
      }
    }
  }
  return best
}
