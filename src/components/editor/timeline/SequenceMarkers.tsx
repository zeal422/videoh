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
import { docDuration } from '@/lib/editor/factories'
import {
  markerColorValue,
  markerTooltip,
  sequenceMarkers,
  staggerMarkerPositions,
} from '@/lib/editor/markers'
import { playbackRef } from '@/lib/editor/playback/engine-ref'
import { applySnap, computeSnapPoints, snapGuide } from '@/lib/editor/snap'
import { currentTransientToken, useEditorStore } from '@/lib/editor/store'
import type { Marker } from '@/lib/editor/types'
import { cn } from '@/lib/utils'

/** A wobble below this stays a click (select + seek), like the clip gestures. */
const DRAG_THRESHOLD_PX = 3

/**
 * Sequence markers: colored tabs pinned to the bottom edge of the ruler, drawn
 * as a DOM overlay above the ruler canvas (so they get tooltips, hover states
 * and context menus the canvas cannot provide). Tabs closer than ~12px are
 * staggered rightward so every one stays clickable; the marker keeps its true
 * time either way.
 *
 * Gestures: click selects and seeks; drag moves through a transient store
 * update (one undo step on pointerup); double-click opens the marker dialog;
 * right-click opens the edit/delete menu.
 */
export function SequenceMarkers({ pxPerSec }: { pxPerSec: number }) {
  const doc = useEditorStore((s) => s.doc)
  const selectedMarker = useEditorStore((s) => s.selectedMarker)
  const markers = useMemo(() => sequenceMarkers(doc.project), [doc.project])
  const positions = useMemo(
    () =>
      staggerMarkerPositions(
        markers.map((m) => m.time),
        pxPerSec,
      ),
    [markers, pxPerSec],
  )
  // Detach for a drag that is still live when the panel unmounts, and cancel
  // the gesture: a stranded transientBase would block autosave forever (see
  // ClipMarkers' unmount cleanup). The ownership flag keeps the cleanup from
  // cancelling a foreign gesture that outlives this component.
  const detachRef = useRef<(() => void) | null>(null)
  const ownsTransientRef = useRef(false)
  useEffect(
    () => () => {
      detachRef.current?.()
      if (ownsTransientRef.current) useEditorStore.getState().cancelTransient()
    },
    [],
  )

  const selectMarker = (marker: Marker) =>
    useEditorStore.getState().selectMarker({ scope: 'sequence', markerId: marker.id })

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
      // The cancel restored the BASE doc; read the live marker or the
      // replacement drag would start a jump of the abandoned delta away
      // from the cursor.
      marker =
        (useEditorStore.getState().doc.project.markers ?? []).find((m) => m.id === marker.id) ??
        marker
    }
    const startX = e.clientX
    const startTime = marker.time
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
      let time = Math.max(0, startTime + dx / pxPerSec)
      let snappedPoint: number | null = null
      if (live.snapEnabled) {
        const points = computeSnapPoints(live.doc, {
          excludeMarkerId: marker.id,
          playhead: live.playhead,
        })
        const snapped = applySnap(time, points, SNAP_THRESHOLD_PX / pxPerSec)
        time = snapped.time
        snappedPoint = snapped.snapped
      }
      // A sequence marker cannot be parked past the sequence end (the playhead
      // can never seek there, so the marker would be unreachable). The guide
      // only shows a snap the clamp did not move off.
      const end = docDuration(live.doc)
      if (time > end) time = end
      live.setSnapLine(snapGuide(snappedPoint, time))
      live.applyTransient({ type: 'moveSequenceMarker', markerId: marker.id, time })
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
      // Never traveled: a plain click selects and seeks to the marker.
      selectMarker(marker)
      playbackRef.current?.seek(marker.time)
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
    <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
      {markers.map((marker, i) => {
        const selected =
          selectedMarker?.scope === 'sequence' && selectedMarker.markerId === marker.id
        const tooltip = markerTooltip(marker, marker.time)
        return (
          <ContextMenu key={marker.id}>
            <ContextMenuTrigger asChild>
              <button
                type="button"
                data-testid="sequence-marker"
                data-marker-id={marker.id}
                data-marker-time={marker.time}
                data-marker-selected={selected ? 'true' : 'false'}
                aria-label={`Marker ${tooltip}`}
                title={tooltip}
                className={cn(
                  'pointer-events-auto absolute bottom-0 h-2.5 w-2.5 -translate-x-1/2 rounded-[2px] border border-black/40 shadow-sm',
                  selected && 'ring-1 ring-white',
                )}
                style={{ left: positions[i], backgroundColor: markerColorValue(marker.color) }}
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
                    .apply({ type: 'deleteSequenceMarker', markerId: marker.id })
                  useEditorStore.getState().selectMarker(null)
                }}
              >
                Delete Marker
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        )
      })}
    </div>
  )
}
