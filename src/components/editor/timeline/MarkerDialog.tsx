'use client'

import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { commandsToDeleteMarker } from '@/lib/editor/actions'
import {
  clipMarkerTimelineTime,
  DEFAULT_MARKER_COLOR,
  MARKER_COLORS,
  MARKER_COLOR_VALUES,
  markerFromSelection,
  type MarkerSelection,
} from '@/lib/editor/markers'
import { useEditorStore } from '@/lib/editor/store'
import { formatTime } from '@/lib/editor/time'
import type { MarkerColor } from '@/lib/editor/types'
import { cn } from '@/lib/utils'

/**
 * Marker editor: name, color swatch and notes, opened by double-clicking a
 * marker or Marker > Edit Selected Marker (the menu bar and the timeline
 * gestures both dispatch `editor:marker-edit`, which this listens for — the
 * same decoupling the Audio Gain dialog uses). Hosted in EditorShell so
 * hiding the timeline panel cannot make the command unreachable.
 *
 * The open state is DERIVED from the edited marker resolving in the doc: an
 * undo or a delete that removes it closes the dialog without extra effects.
 */
export function MarkerDialog() {
  const doc = useEditorStore((s) => s.doc)
  const [editing, setEditing] = useState<MarkerSelection | null>(null)
  const [name, setName] = useState('')
  const [notes, setNotes] = useState('')
  const [color, setColor] = useState<MarkerColor>(DEFAULT_MARKER_COLOR)

  useEffect(() => {
    const onOpen = () => {
      const state = useEditorStore.getState()
      const selection = state.selectedMarker
      const marker = selection ? markerFromSelection(state.doc, selection) : undefined
      if (!selection || !marker) return
      setName(marker.name ?? '')
      setNotes(marker.notes ?? '')
      setColor(marker.color ?? DEFAULT_MARKER_COLOR)
      setEditing(selection)
    }
    window.addEventListener('editor:marker-edit', onOpen)
    return () => window.removeEventListener('editor:marker-edit', onOpen)
  }, [])

  const target = editing ? markerFromSelection(doc, editing) : undefined
  // A controlled Dialog never fires onOpenChange for an `open` flip, so a
  // target that stops resolving (undo/redo/delete while open) must clear the
  // edit state right here — or a redo that brings the marker back pops the
  // stale dialog open again. (Adjusting state during render is the React
  // pattern for state that must react to a derived value going away.)
  if (editing && !target) {
    setEditing(null)
    return null
  }

  let timeLabel = ''
  if (editing && target) {
    if (editing.scope === 'sequence') {
      timeLabel = formatTime(target.time)
    } else {
      const clip = doc.project.tracks.flatMap((t) => t.clips).find((c) => c.id === editing.clipId)
      const timelineTime = clip ? clipMarkerTimelineTime(clip, target) : null
      timeLabel = timelineTime === null ? 'outside the clip span' : formatTime(timelineTime)
    }
  }

  const save = () => {
    if (!editing) return
    const store = useEditorStore.getState()
    const patch = { name, color, notes }
    store.apply(
      editing.scope === 'sequence'
        ? { type: 'updateSequenceMarker', markerId: editing.markerId, patch }
        : {
            type: 'updateClipMarker',
            clipId: editing.clipId,
            markerId: editing.markerId,
            patch,
          },
    )
    setEditing(null)
  }

  const remove = () => {
    if (!editing) return
    const store = useEditorStore.getState()
    const commands = commandsToDeleteMarker(store.doc, editing)
    if (commands) store.apply(commands)
    store.selectMarker(null)
    setEditing(null)
  }

  return (
    <Dialog
      open={!!target}
      onOpenChange={(next) => {
        if (!next) setEditing(null)
      }}
    >
      <DialogContent className="sm:max-w-sm" data-testid="marker-dialog">
        <DialogHeader>
          <DialogTitle>Marker</DialogTitle>
          <DialogDescription>
            {editing?.scope === 'sequence' ? 'Sequence marker' : 'Clip marker'}
            {timeLabel ? ` at ${timeLabel}` : ''}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Name</span>
            <Input
              data-testid="marker-name-input"
              aria-label="Marker name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Untitled marker"
            />
          </label>
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Color</span>
            {/* Arrow keys move the selection (roving focus), the standard
                radiogroup contract: plain buttons alone would make a keyboard
                user tab through all eight swatches. */}
            <div
              role="radiogroup"
              aria-label="Marker color"
              className="flex flex-wrap gap-1.5"
              onKeyDown={(e) => {
                if (
                  e.key !== 'ArrowRight' &&
                  e.key !== 'ArrowDown' &&
                  e.key !== 'ArrowLeft' &&
                  e.key !== 'ArrowUp'
                )
                  return
                e.preventDefault()
                // The swatch is a plain <button>, so the global editor shortcut
                // handler (which only skips form fields) would otherwise treat
                // the same arrow as frame-step / jump-to-edit.
                e.stopPropagation()
                const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1
                const next =
                  MARKER_COLORS[
                    (MARKER_COLORS.indexOf(color) + dir + MARKER_COLORS.length) %
                      MARKER_COLORS.length
                  ]
                setColor(next)
                e.currentTarget
                  .querySelector<HTMLButtonElement>(`[data-testid="marker-color-${next}"]`)
                  ?.focus()
              }}
            >
              {MARKER_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={color === c}
                  aria-label={`Marker color ${c}`}
                  // Roving focus: only the checked radio is in the tab order;
                  // arrows move the selection (see the group's onKeyDown).
                  tabIndex={color === c ? 0 : -1}
                  data-testid={`marker-color-${c}`}
                  className={cn(
                    'size-5 rounded-full border border-black/40 shadow-sm',
                    color === c && 'ring-2 ring-white ring-offset-1 ring-offset-background',
                  )}
                  style={{ backgroundColor: MARKER_COLOR_VALUES[c] }}
                  onClick={() => setColor(c)}
                />
              ))}
            </div>
          </div>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Notes</span>
            <Textarea
              data-testid="marker-notes-input"
              aria-label="Marker notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="Optional notes"
            />
          </label>
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            variant="destructive"
            data-testid="marker-delete"
            onClick={remove}
            disabled={!target}
          >
            Delete
          </Button>
          <span className="flex gap-2">
            <Button variant="secondary" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button data-testid="marker-save" onClick={save} disabled={!target}>
              Save
            </Button>
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
