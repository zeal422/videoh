'use client'

import { Layers, Shapes, Type } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { activeTracks, findSequence } from '@/lib/editor/factories'
import { formatTime } from '@/lib/editor/time'
import { useEditorStore } from '@/lib/editor/store'
import { shapeKindLabel } from '@/lib/editor/shapes'
import { playbackRef } from '@/lib/editor/playback/engine-ref'
import type { Clip, Doc, Track } from '@/lib/editor/types'

/**
 * Project tab (0.29.5): generated text, shape, and compound clips in the
 * ACTIVE sequence. Imported files stay in the Media tab; this list is a
 * navigation surface over the timeline, so one row is one button and every
 * activation selects the clip and parks the playhead at its sequence-local
 * start.
 */

interface ProjectItem {
  clip: Clip
  track: Track
  label: string
  kindLabel: string
  Icon: typeof Type
}

function projectItems(clips: { clip: Clip; track: Track }[], doc: Doc) {
  return clips.flatMap(({ clip, track }): ProjectItem[] => {
    if (clip.text !== undefined) {
      return [
        {
          clip,
          track,
          label: clip.text.trim().split('\n')[0] || '(empty text)',
          kindLabel: 'Text',
          Icon: Type,
        },
      ]
    }
    if (clip.shape) {
      return [
        {
          clip,
          track,
          label: shapeKindLabel(clip.shape.kind),
          kindLabel: 'Shape',
          Icon: Shapes,
        },
      ]
    }
    if (clip.sequenceId) {
      return [
        {
          clip,
          track,
          label: findSequence(doc, clip.sequenceId)?.name ?? 'Compound clip',
          kindLabel: 'Compound',
          Icon: Layers,
        },
      ]
    }
    return []
  })
}

export function ProjectItemsPanel() {
  const doc = useEditorStore((s) => s.doc)
  const activeSequencePath = useEditorStore((s) => s.activeSequencePath)
  const items = projectItems(
    activeTracks(doc, activeSequencePath).flatMap((track) =>
      track.clips.map((clip) => ({ clip, track })),
    ),
    doc,
  )

  if (items.length === 0) {
    return (
      <p
        data-testid="project-items-empty"
        className="mt-6 rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground"
      >
        No text, shapes, or compound clips in this sequence.
      </p>
    )
  }

  return (
    <ul className="space-y-1.5" aria-label="Project items">
      {items.map(({ clip, track, label, kindLabel, Icon }) => {
        const hidden = track.visible === false
        return (
          <li key={clip.id}>
            <Button
              type="button"
              variant="ghost"
              data-testid={`project-item-${clip.id}`}
              className="h-auto w-full justify-start gap-2 rounded-md border bg-background/60 px-2 py-2 text-left hover:bg-accent/60"
              onClick={() => {
                const store = useEditorStore.getState()
                if (hidden)
                  store.apply({ type: 'setTrackVisible', trackId: track.id, visible: true })
                store.select(clip.id)
                playbackRef.current?.seek(clip.start)
              }}
            >
              <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium" title={label}>
                  {label}
                </span>
                <span className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
                  <span>{kindLabel}</span>
                  <span aria-hidden>·</span>
                  <span>{formatTime(clip.start)}</span>
                  <span aria-hidden>·</span>
                  <span>{formatTime(clip.duration)}</span>
                  {hidden && <span className="text-amber-500">Hidden track</span>}
                </span>
              </span>
              <span className="shrink-0 text-[10px] text-muted-foreground">Go to</span>
            </Button>
          </li>
        )
      })}
    </ul>
  )
}
