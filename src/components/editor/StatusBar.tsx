'use client'

import { Check, CloudOff, Loader2 } from 'lucide-react'
import { useEditorStore } from '@/lib/editor/store'
import { docDuration } from '@/lib/editor/factories'
import { formatTime } from '@/lib/editor/time'

/** Bottom status bar — always pinned to the viewport bottom (app-shell footer). */
export function StatusBar() {
  const project = useEditorStore((s) => s.doc.project)
  const duration = useEditorStore((s) => docDuration(s.doc))
  const autosaveStatus = useEditorStore((s) => s.autosaveStatus)
  const autosavedAt = useEditorStore((s) => s.autosavedAt)
  const selections = useEditorStore((s) => s.selections)
  const pxPerSec = useEditorStore((s) => s.pxPerSec)
  const past = useEditorStore((s) => s.past)
  const clock = autosavedAt ? new Date(autosavedAt).toLocaleTimeString() : ''

  const primary = selections[0]
  const selected =
    primary != null
      ? project.tracks.flatMap((t) => t.clips).find((c) => c.id === primary)
      : undefined

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
        {selected && (
          <span className="hidden md:inline">
            Selected clip {formatTime(selected.start)}–
            {formatTime(selected.start + selected.duration)}
          </span>
        )}
        <span className="hidden lg:inline">{Math.round(pxPerSec)} px/s</span>
        <span className="hidden lg:inline">{past.length} undo steps</span>
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
