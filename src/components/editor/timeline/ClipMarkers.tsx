'use client'

import { useEffect, useMemo, useRef } from 'react'

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { SNAP_THRESHOLD_PX } from '@/lib/editor/constants'
import { sourceTimeAt } from '@/lib/editor/factories'
import {
  clipMarkerLocalTime,
  markerColorValue,
  markerTooltip,
  visibleClipMarkers,
} from '@/lib/editor/markers'
import { playbackRef } from '@/lib/editor/playback/engine-ref'
import { applySnap, computeSnapPoints, snapGuide } from '@/lib/editor/snap'
import { currentTransientToken, useEditorStore } from '@/lib/editor/store'
import { clamp } from '@/lib/editor/time'
import type { Clip, Marker } from '@/lib/editor/types'
import { cn } from '@/lib/utils'

const DRAG_THRESHOLD_PX = 3

/**
 * Clip markers: small colored tabs on the clip's bottom strip (the top corners
 * hold the link/speed/reverse badges and the top edge the trim handles).
 *
 * Marker times are SOURCE seconds, so dragging works in the clip's local
 * timeline space and converts back through `sourceTimeAt`: a drag is clamped
 * inside the clip's visible span (a marker can never leave its clip) and
 * honors speed and reverse for free. Click seeks + selects, double-click opens
 * the dialog, right-click offers edit/delete.
 */
export function ClipMarkers({ clip, pxPerSec }: { clip: Clip; pxPerSec: number }) {
  const selectedMarker = useEditorStore((s) => s.selectedMarker)
  const markers = useMemo(() => visibleClipMarkers(clip), [clip])
  const detachRef = useRef<(() => void) | null>(null)
  // True only while THIS component's own drag owns the store's transient, so
  // the unmount cleanup below never cancels a foreign gesture (e.g. a ClipView
  // clip drag that remounts this component on a lane change).
  const ownsTransientRef = useRef(false)
  useEffect(
    () => () => {
      detachRef.current?.()
      // A mid-drag unmount (the owning clip was deleted under a live tab drag)
      // must cancel the gesture, not just drop the listeners, or transientBase
      // stays set forever: the move never reaches history and autosave skips
      // every later change (initAutosave ignores stores mid-transient).
      if (ownsTransientRef.current) useEditorStore.getState().cancelTransient()
    },
    [],
  )
  if (markers.length === 0) return null

  const selectMarker = (marker: Marker) =>
    useEditorStore.getState().selectMarker({ scope: 'clip', clipId: clip.id, markerId: marker.id })

  const openDialog = (marker: Marker) => {
    selectMarker(marker)
    window.dispatchEvent(new CustomEvent('editor:marker-edit'))
  }

  function beginPointerDrag(e: React.PointerEvent, marker: Marker) {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    // A second pointerdown abandons a still-live drag: cancel it (one clean
    // rollback) rather than just detaching, which would fold its move into
    // the new drag's undo entry. Multi-pointer only.
    detachRef.current?.()
    if (ownsTransientRef.current) {
      ownsTransientRef.current = false
      useEditorStore.getState().cancelTransient()
      // The cancel restored the BASE doc, so the closure's marker may be a
      // stale clone; read the live one or the replacement drag would start a
      // jump of the abandoned delta away from the cursor.
      marker =
        useEditorStore
          .getState()
          .doc.project.tracks.flatMap((t) => t.clips)
          .find((c) => c.id === clip.id)
          ?.markers?.find((m) => m.id === marker.id) ?? marker
    }
    const startX = e.clientX
    const startLocal = clipMarkerLocalTime(clip, marker.time) ?? 0
    // Own this drag to ONE pointer: a second pointerdown abandons the first
    // drag (above), so its lingering move/up/cancel events must not drive or
    // end the replacement. Events from other pointers are ignored below.
    const pointerId = e.pointerId
    let moved = false
    // The gesture slot begins lazily on the first real move (past the wobble
    // threshold); the token lets later frames detect a foreign end.
    let token = -1

    function onMove(ev: PointerEvent) {
      if (ev.pointerId !== pointerId) return
      const dx = ev.clientX - startX
      if (!moved && Math.abs(dx) < DRAG_THRESHOLD_PX) return
      if (!moved) {
        moved = true
        ownsTransientRef.current = true
        token = useEditorStore.getState().beginTransient(pointerId)
      }
      // A foreign commit (keyboard delete, undo) ended the gesture slot:
      // applying further frames would mutate the doc with no undo entry, and
      // the drag's own commit/cancel are already no-ops. Drop the frame; the
      // stale drag dies silently.
      if (currentTransientToken() !== token) return
      const live = useEditorStore.getState()
      let local = clamp(startLocal + dx / pxPerSec, 0, clip.duration)
      if (live.snapEnabled) {
        const points = computeSnapPoints(live.doc, {
          excludeClipIds: [clip.id],
          excludeMarkerId: marker.id,
          playhead: live.playhead,
        })
        const snapped = applySnap(clip.start + local, points, SNAP_THRESHOLD_PX / pxPerSec)
        local = clamp(snapped.time - clip.start, 0, clip.duration)
        // The guide must point at a position the marker actually took: the
        // clamped position can differ from the pre-clamp snap (the clip
        // edge), and showing that discarded snap would mislead.
        live.setSnapLine(snapGuide(snapped.snapped, clip.start + local))
      }
      live.applyTransient({
        type: 'moveClipMarker',
        clipId: clip.id,
        markerId: marker.id,
        time: sourceTimeAt(clip, local),
      })
    }

    function onUp(ev: PointerEvent) {
      if (ev.pointerId !== pointerId) return
      detach()
      const live = useEditorStore.getState()
      live.setSnapLine(null)
      if (moved) {
        ownsTransientRef.current = false
        live.commitTransient()
        return
      }
      selectMarker(marker)
      playbackRef.current?.seek(clip.start + startLocal)
    }

    function onCancel(ev: PointerEvent) {
      if (ev.pointerId !== pointerId) return
      detach()
      const live = useEditorStore.getState()
      live.setSnapLine(null)
      if (moved) {
        ownsTransientRef.current = false
        live.cancelTransient()
      }
    }

    function detach() {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      detachRef.current = null
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    detachRef.current = detach
  }

  return (
    <>
      {markers.map(({ marker, timelineTime }) => {
        const selected = selectedMarker?.scope === 'clip' && selectedMarker.markerId === marker.id
        const tooltip = markerTooltip(marker, timelineTime)
        return (
          <ContextMenu key={marker.id}>
            <ContextMenuTrigger asChild>
              <button
                type="button"
                data-testid="clip-marker"
                data-marker-id={marker.id}
                data-marker-time={marker.time}
                data-marker-selected={selected ? 'true' : 'false'}
                aria-label={`Clip marker ${tooltip}`}
                title={tooltip}
                className={cn(
                  // Above the z-10 trim handles: `M` with the playhead past the
                  // clip end parks a marker exactly on the end handle, and a
                  // marker underneath it could never be dragged or deleted.
                  'absolute bottom-0 z-[11] h-2 w-2 -translate-x-1/2 rounded-[2px] border border-black/40 shadow-sm',
                  selected && 'ring-1 ring-white',
                )}
                style={{
                  left: (timelineTime - clip.start) * pxPerSec,
                  backgroundColor: markerColorValue(marker.color),
                }}
                onPointerDown={(e) => beginPointerDrag(e, marker)}
                onDoubleClick={() => openDialog(marker)}
                onContextMenu={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    openDialog(marker)
                  }
                }}
              />
            </ContextMenuTrigger>
            <ContextMenuContent data-testid="marker-context-menu">
              <ContextMenuItem data-testid="marker-menu-edit" onSelect={() => openDialog(marker)}>
                Edit Marker…
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                data-testid="marker-menu-delete"
                variant="destructive"
                onSelect={() => {
                  useEditorStore
                    .getState()
                    .apply({ type: 'deleteClipMarker', clipId: clip.id, markerId: marker.id })
                  useEditorStore.getState().selectMarker(null)
                }}
              >
                Delete Marker
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        )
      })}
    </>
  )
}
