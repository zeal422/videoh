'use client'

import { Check, CloudOff, Loader2 } from 'lucide-react'
import { useEditorStore } from '@/lib/editor/store'
import { activeSequenceDuration, activeTracks, findClip } from '@/lib/editor/factories'
import { formatDurationSeconds, formatRangeTime, formatTime } from '@/lib/editor/time'

/** Bottom status bar — always pinned to the viewport bottom (app-shell footer). */
export function StatusBar() {
  const project = useEditorStore((s) => s.doc.project)
  const doc = useEditorStore((s) => s.doc)
  const activeSequencePath = useEditorStore((s) => s.activeSequencePath)
  const duration = useEditorStore((s) => activeSequenceDuration(s.doc, s.activeSequencePath))
  const autosaveStatus = useEditorStore((s) => s.autosaveStatus)
  const autosavedAt = useEditorStore((s) => s.autosavedAt)
  const selections = useEditorStore((s) => s.selections)
  const clock = autosavedAt ? new Date(autosavedAt).toLocaleTimeString() : ''

  const primary = selections[0]
  const selected = primary != null ? findClip(doc, primary)?.clip : undefined
  const tracks = activeTracks(doc, activeSequencePath)
  const videoCount = tracks.filter((t) => t.kind === 'video').length
  const audioCount = tracks.filter((t) => t.kind === 'audio').length
  const countLabel = (count: number, kind: string) =>
    `${count} ${kind} track${count === 1 ? '' : 's'}`

  return (
    <footer
      role="contentinfo"
      className="flex h-7 shrink-0 items-center justify-between gap-3 border-t bg-card px-3 text-[11px] text-muted-foreground"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate font-medium text-foreground/80">{project.name}</span>
        <span aria-hidden>·</span>
        <span>
          {project.width}×{project.height} @ {project.fps}fps
        </span>
        <span aria-hidden className="hidden sm:inline">
          ·
        </span>
        <span className="hidden sm:inline">Timeline {formatTime(duration)}</span>
      </div>

      <div className="flex items-center gap-3">
        {selections.length > 1 && (
          <span className="font-medium text-foreground/80">{selections.length} clips selected</span>
        )}
        {selections.length === 1 && selected && (
          <span className="hidden md:inline" data-testid="status-selection">
            Selected clip {formatRangeTime(selected.start)}–
            {formatRangeTime(selected.start + selected.duration)} (
            {formatDurationSeconds(selected.duration)})
          </span>
        )}
        <span className="hidden xl:inline" data-testid="status-track-counts">
          {countLabel(videoCount, 'video')} · {countLabel(audioCount, 'audio')}
        </span>
        <AutosaveIndicator status={autosaveStatus} clock={clock} />
      </div>
    </footer>
  )
}

function AutosaveIndicator({ status, clock }: { status: string; clock: string }) {
  if (status === 'saving' || status === 'pending') {
    return (
      <span className="flex items-center gap-1" aria-live="polite">
        <Loader2 className="size-3 animate-spin" /> Autosaving…
      </span>
    )
  }
  if (status === 'error') {
    return (
      <span className="flex items-center gap-1 text-amber-500" aria-live="polite">
        <CloudOff className="size-3" /> Autosave off
      </span>
    )
  }
  return (
    <span className="flex items-center gap-1" aria-live="polite">
      <Check className="size-3" /> {clock ? `Autosaved ${clock}` : 'Autosave on'}
    </span>
  )
}
