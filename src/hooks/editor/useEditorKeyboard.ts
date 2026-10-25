'use client'

import { useEffect } from 'react'
import {
  commandsToAddMarker,
  commandsToAddText,
  commandsToDeleteClips,
  commandsToDeleteMarker,
  commandsToDuplicateClips,
  commandsToLinkClips,
  commandsToPlaceSource,
  commandsToRippleDeleteClips,
  commandsToSplitAllAt,
  commandsToSplitClipsAt,
  commandsToUnlinkClips,
} from '@/lib/editor/actions'
import { commandsToCutClips, commandsToPasteClips, copyClips } from '@/lib/editor/clipboard'
import { audibleClipId, anySelectionLinked, canLinkClips } from '@/lib/editor/links'
import { markerSelectionExists, neighborMarker } from '@/lib/editor/markers'
import { activeSequenceDuration, activeTracks, findClip } from '@/lib/editor/factories'
import {
  placementRefusalMessage,
  sourceRangeFor,
  sourceRangeInvalid,
  SOURCE_RANGE_MESSAGE,
} from '@/lib/editor/sequence-ops'
import { toast } from '@/hooks/use-toast'
import { FRAME_STEPS, PPS_MAX, PPS_MIN, TRACK_HEADER_WIDTH } from '@/lib/editor/constants'
import { playbackRef } from '@/lib/editor/playback/engine-ref'
import { useEditorStore } from '@/lib/editor/store'

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
      const { doc, playhead, pxPerSec, selections, selection, selectedMarker } = store
      // Multi-selection source of truth; falls back to the primary id.
      const selectedIds = selections.length > 0 ? selections : selection ? [selection] : []
      const primaryId = selectedIds[0] ?? null
      const mod = e.ctrlKey || e.metaKey
      const key = e.key.toLowerCase()

      // ————— modifier combos —————
      if (mod && key === 'z') {
        e.preventDefault()
        if (e.shiftKey) store.redo()
        else store.undo()
        return
      }
      if (mod && key === 'y') {
        e.preventDefault()
        store.redo()
        return
      }
      if (mod && key === 's') {
        e.preventDefault()
        onSave()
        return
      }
      if (mod && key === 'a') {
        e.preventDefault()
        if (e.shiftKey) store.deselectAll()
        else store.selectAll()
        return
      }
      if (mod && key === 'x') {
        // Cut = copy into the clipboard + delete the selection, one undo step.
        if (selectedIds.length > 0) {
          e.preventDefault()
          const commands = commandsToCutClips(doc, selectedIds)
          if (commands) {
            store.apply(commands)
            store.deselectAll()
          }
        }
        return
      }
      if (mod && key === 'c') {
        if (selectedIds.length > 0) {
          e.preventDefault()
          copyClips(doc, selectedIds)
        }
        return
      }
      if (mod && key === 'v') {
        e.preventDefault()
        const commands = commandsToPasteClips(
          doc,
          playhead,
          store.untargetedTracks,
          store.activeSequencePath[store.activeSequencePath.length - 1],
        )
        if (commands) {
          try {
            store.apply(commands)
          } catch (error) {
            // A stale clipboard entry (its compound sequence pruned, or media
            // from another project) cannot be placed. Surface it the same way
            // the context-menu paste does (runMenuAction), never silently.
            toast({
              title: 'Action failed',
              description: error instanceof Error ? error.message : String(error),
              variant: 'destructive',
            })
          }
        }
        return
      }
      if (mod && key === 'k') {
        // Premiere "Add Edit": split the selection at the playhead — or, with
        // nothing selected, every clip on every track the playhead crosses.
        e.preventDefault()
        const commands = selectedIds.length
          ? commandsToSplitClipsAt(doc, selectedIds, playhead)
          : commandsToSplitAllAt(doc, playhead, store.activeSequencePath)
        if (commands) {
          try {
            store.apply(commands)
          } catch {
            // playhead micro-outside a splittable range — ignore
          }
        }
        return
      }
      if (mod && key === 'l') {
        // Premiere toggle: linked selection unlinks; ≥2 separate clips link.
        e.preventDefault()
        if (anySelectionLinked(doc, selectedIds)) {
          const commands = commandsToUnlinkClips(doc, selectedIds)
          if (commands) store.apply(commands)
        } else if (canLinkClips(doc, selectedIds)) {
          store.apply(commandsToLinkClips(doc, selectedIds)!)
        }
        return
      }
      if (mod && e.shiftKey && key === 'm') {
        // Premiere Ctrl+Shift+M: go to the previous marker.
        e.preventDefault()
        const point = neighborMarker(doc, playhead, 'prev', store.activeSequencePath)
        if (point) playbackRef.current?.seek(point.timelineTime)
        return
      }
      if (!mod && e.shiftKey && key === 'm') {
        // Premiere Shift+M: go to the next marker.
        e.preventDefault()
        const point = neighborMarker(doc, playhead, 'next', store.activeSequencePath)
        if (point) playbackRef.current?.seek(point.timelineTime)
        return
      }
      if (mod && e.shiftKey && (e.key === '/' || e.key === '?')) {
        // Premiere "Duplicate" (Ctrl+Shift+/) — same as the D alias below.
        if (selectedIds.length > 0) {
          e.preventDefault()
          const commands = commandsToDuplicateClips(doc, selectedIds)
          if (commands) store.apply(commands)
        }
        return
      }

      // ————— single keys —————
      switch (e.key) {
        case 'v':
        case 'V': {
          store.setActiveTool('select')
          break
        }
        case 'c':
        case 'C': {
          // Premiere razor tool: click a clip to cut it (ClipView handles it).
          store.setActiveTool('razor')
          break
        }
        case 'Escape': {
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
          // stale selection (marker already gone) is dropped and the clip
          // path runs, so a dangling selection can never eat the keypress.
          if (selectedMarker) {
            if (!markerSelectionExists(doc, selectedMarker)) {
              store.selectMarker(null)
            } else {
              e.preventDefault()
              const markerCommands = commandsToDeleteMarker(doc, selectedMarker)
              if (markerCommands) store.apply(markerCommands)
              store.selectMarker(null)
              return
            }
          }
          if (selectedIds.length > 0) {
            e.preventDefault()
            if (e.shiftKey) {
              // Premiere Ripple Delete: remove AND close the gap.
              const commands = commandsToRippleDeleteClips(
                doc,
                selectedIds,
                store.activeSequencePath,
              )
              if (commands) store.apply(commands)
            } else {
              // Linked A/V pairs die together — until explicitly unlinked.
              store.apply(commandsToDeleteClips(doc, selectedIds))
            }
            store.deselectAll()
          }
          break
        }
        case 's':
        case 'S': {
          // Premiere: S toggles snapping (split lives on Ctrl+K now).
          store.toggleSnap()
          break
        }
        case 'd':
        case 'D': {
          if (selectedIds.length > 0) {
            e.preventDefault()
            const commands = commandsToDuplicateClips(doc, selectedIds)
            if (commands) store.apply(commands)
          }
          break
        }
        case 'm':
        case 'M': {
          // Premiere M: add a marker — a clip marker on the primary selected
          // clip when there is one (clamped into its visible span), otherwise
          // a sequence marker at the playhead. Shift+M navigates (above).
          e.preventDefault()
          const markerCommands = commandsToAddMarker(
            doc,
            playhead,
            selectedIds,
            store.activeSequencePath,
          )
          if (markerCommands) store.apply(markerCommands)
          break
        }
        case 'e':
        case 'E': {
          // Shift+E mutes: Premiere binds Shift+E to clip enable/disable, the
          // closest match this app has (its mute only owns the audio side).
          if (!e.shiftKey) break
          if (primaryId) {
            e.preventDefault()
            // Mute is an AUDIO property: for a linked pair it always targets
            // the audio twin, whichever half is selected (muting the video
            // half would unmask its embedded audio and double-play).
            const audibleId = audibleClipId(doc, primaryId)
            const audible = findClip(doc, audibleId)?.clip
            store.apply({
              type: 'setClipMuted',
              clipId: audibleId,
              muted: !(audible?.muted ?? false),
            })
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
          store.apply(
            commandsToAddText(
              doc,
              playhead,
              store.untargetedTracks,
              store.activeSequencePath[store.activeSequencePath.length - 1],
            ),
          )
          break
        }
        case 'i':
        case 'I': {
          // Premiere: I marks the source In at the source monitor's playhead.
          // Ignored without a source selection (and inside form fields, like
          // every binding here).
          if (mod || !store.sourceAssetId) break
          store.markSourceIn()
          break
        }
        case 'o':
        case 'O': {
          if (mod || !store.sourceAssetId) break
          store.markSourceOut()
          break
        }
        case ',':
        case '.': {
          // Three-point editing: place the marked span (or the whole asset)
          // at the sequence playhead. `,` inserts, `.` overwrites. Independent
          // of the sticky drop-mode toggle, like Premiere's defaults.
          if (mod) break
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
          store.setPxPerSec(Math.min(PPS_MAX, Math.round(pxPerSec * 1.4)))
          break
        }
        case '-':
        case '_': {
          store.setPxPerSec(Math.max(PPS_MIN, Math.round(pxPerSec / 1.4)))
          break
        }
        case '\\': {
          // Premiere backslash: zoom the timeline so the whole sequence fits.
          const el = document.querySelector('[data-timeline-scroll]')
          const viewport = el ? el.clientWidth - TRACK_HEADER_WIDTH - 12 : 0
          const duration = activeSequenceDuration(doc, store.activeSequencePath)
          if (viewport > 40 && duration > 0.25) {
            store.setPxPerSec(Math.min(PPS_MAX, Math.max(PPS_MIN, Math.round(viewport / duration))))
          }
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
