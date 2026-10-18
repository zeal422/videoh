'use client'

import { useRef } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/hooks/use-toast'
import { downloadBlob } from '@/lib/editor/export/mp4'
import { EditorCommandError, type EditorCommand } from '@/lib/editor/commands'
import { MIN_CLIP_DURATION } from '@/lib/editor/constants'
import { findSequence } from '@/lib/editor/factories'
import { compareSrtCues, collectCaptionCues, parseSrt, serializeSrt } from '@/lib/editor/srt'
import { useEditorStore } from '@/lib/editor/store'
import { commandsToAddCaptionCue } from '@/lib/editor/actions'
import type { Clip, Doc } from '@/lib/editor/types'

/** One flagged clip with its root track, in panel (export) order. */
interface CaptionEntry {
  trackId: string
  clip: Clip
}

function cueMillis(clip: Clip): { startMs: number; endMs: number } {
  const startMs = Math.round(clip.start * 1000)
  return { startMs, endMs: startMs + Math.round(clip.duration * 1000) }
}

/** Flagged clips on root project tracks, in export order (same tiebreak). */
function captionEntries(doc: Doc): CaptionEntry[] {
  const entries: CaptionEntry[] = []
  for (const track of doc.project.tracks) {
    if (track.kind !== 'text') continue
    for (const clip of track.clips) {
      if (clip.isCaption) entries.push({ trackId: track.id, clip })
    }
  }
  entries.sort((a, b) =>
    compareSrtCues(
      { ...cueMillis(a.clip), text: typeof a.clip.text === 'string' ? a.clip.text.trim() : '' },
      { ...cueMillis(b.clip), text: typeof b.clip.text === 'string' ? b.clip.text.trim() : '' },
    ),
  )
  return entries
}

/**
 * Convert a time on the open sequence path to root-absolute seconds by
 * summing container starts along the path. Returns null when a step is
 * missing or shared by more than one container (duplicates keep the same
 * `sequenceId`, so the path cannot name the container): stamping there has
 * no single right answer, so the caller keeps New Cue unavailable.
 */
export function captionCueRootTime(
  doc: Doc,
  path: readonly string[],
  localTime: number,
): number | null {
  if (!Number.isFinite(localTime)) return null
  let tracks = doc.project.tracks
  let total = localTime
  for (const sequenceId of path) {
    const containers = tracks.flatMap((t) => t.clips).filter((c) => c.sequenceId === sequenceId)
    if (containers.length !== 1 || containers[0] === undefined) return null
    total += containers[0].start
    // A corrupt container start poisons the sum: no single right answer.
    if (!Number.isFinite(total)) return null
    const sequence = findSequence(doc, sequenceId)
    if (!sequence) return null
    tracks = sequence.tracks
  }
  return total
}

/**
 * Captions panel (0.8.5): the cue list behind SRT import/export. Cue edits
 * dispatch the existing clip commands (no new mutation path); rendering an
 * empty-text flagged clip draws nothing and throws nothing, since new cues
 * start blank.
 */
export function CaptionsPanel() {
  const doc = useEditorStore((s) => s.doc)
  const playhead = useEditorStore((s) => s.playhead)
  const activeSequencePath = useEditorStore((s) => s.activeSequencePath)
  const fileRef = useRef<HTMLInputElement>(null)
  const entries = captionEntries(doc)
  const atRoot = activeSequencePath.length === 0
  const newCueAt = atRoot ? playhead : captionCueRootTime(doc, activeSequencePath, playhead)

  const seekToCue = (start: number) => {
    const store = useEditorStore.getState()
    // Cue times are root-absolute while the timeline follows the open path.
    if (store.activeSequencePath.length > 0) store.setActiveSequencePath([])
    store.setPlayhead(start)
  }

  /** Expected command refusals toast; programming errors rethrow. */
  const applyEdit = (command: EditorCommand) => {
    try {
      useEditorStore.getState().apply(command)
    } catch (error) {
      if (error instanceof EditorCommandError) {
        toast({ title: 'Could not edit the cue', variant: 'destructive' })
      } else {
        throw error
      }
    }
  }

  /** Fresh clip for a panel entry: the doc may have changed under a focused
   * field (restore, undo from elsewhere), so commits read the live clip
   * instead of closing over render-time values. Absent when the clip is gone.
   */
  function liveClip(trackId: string, clipId: string): Clip | undefined {
    const track = useEditorStore.getState().doc.project.tracks.find((t) => t.id === trackId)
    if (!track || track.kind !== 'text') return undefined
    return track.clips.find((c) => c.id === clipId)
  }

  const commitStart = (entry: CaptionEntry, raw: string) => {
    const start = Number(raw)
    if (!Number.isFinite(start) || start < 0) return
    const clip = liveClip(entry.trackId, entry.clip.id)
    if (!clip) return
    applyEdit({ type: 'moveClip', clipId: clip.id, trackId: entry.trackId, start })
  }

  const commitEnd = (entry: CaptionEntry, raw: string) => {
    const end = Number(raw)
    if (!Number.isFinite(end)) return
    const clip = liveClip(entry.trackId, entry.clip.id)
    if (!clip) return
    // Millisecond math: a float endpoint difference can read a nominal
    // 100 ms span as just under it, and the edit would be silently ignored.
    const durationMs = Math.round(end * 1000) - Math.round(clip.start * 1000)
    if (!Number.isFinite(durationMs) || durationMs < Math.round(MIN_CLIP_DURATION * 1000)) return
    const duration = durationMs / 1000
    applyEdit({
      type: 'trimClip',
      clipId: clip.id,
      start: clip.start,
      inPoint: clip.inPoint,
      duration,
      edge: 'tail',
    })
  }

  const commitText = (entry: CaptionEntry, text: string) => {
    const clip = liveClip(entry.trackId, entry.clip.id)
    if (!clip || text === (clip.text ?? '')) return
    applyEdit({ type: 'setTextContent', clipId: clip.id, text })
  }

  const addCue = () => {
    if (newCueAt === null) return
    const store = useEditorStore.getState()
    const state = store.doc
    try {
      const track = state.project.tracks.find(
        (t) => t.kind === 'text' && t.clips.some((c) => c.isCaption),
      )
      if (track) {
        store.apply({ type: 'addCaptionCue', trackId: track.id, start: newCueAt })
      } else {
        // No captions track yet: create a first-free Captions track and stamp
        // the cue in one batch, so creation stays one undo step.
        store.apply(commandsToAddCaptionCue(state, newCueAt))
      }
      // The path resets only after the stamp lands: a refusal must not
      // strand the user at the root with no cue created.
      if (!atRoot) store.setActiveSequencePath([])
    } catch (error) {
      // Expected command refusals toast; programming errors rethrow (the
      // MenuBar dispatch pattern), so they surface instead of hiding.
      if (error instanceof EditorCommandError) {
        toast({ title: 'Could not create the cue', variant: 'destructive' })
      } else {
        throw error
      }
    }
  }

  const importFile = async (file: File) => {
    let text: string
    try {
      text = await file.text()
    } catch {
      toast({ title: 'Could not read the SRT file', variant: 'destructive' })
      return
    }
    const { cues, dropped } = parseSrt(text)
    if (cues.length === 0) {
      toast({ title: 'No valid cues in the SRT file', variant: 'destructive' })
      return
    }
    try {
      useEditorStore.getState().apply({
        type: 'importCaptions',
        cues: cues.map((c) => ({
          start: c.startMs / 1000,
          duration: (c.endMs - c.startMs) / 1000,
          text: c.text,
        })),
      })
    } catch (error) {
      if (error instanceof EditorCommandError) {
        toast({ title: 'Could not import the SRT file', variant: 'destructive' })
      } else {
        throw error
      }
      return
    }
    if (dropped > 0) {
      toast({ title: `${dropped} cue${dropped === 1 ? '' : 's'} skipped` })
    }
  }

  const downloadFile = () => {
    const state = useEditorStore.getState().doc
    let cues
    try {
      cues = collectCaptionCues(state)
    } catch (error) {
      toast({
        title: error instanceof Error ? error.message : 'Could not build the SRT file',
        variant: 'destructive',
      })
      return
    }
    if (cues.length === 0) {
      toast({ title: 'No captions to export', variant: 'destructive' })
      return
    }
    downloadBlob(
      new Blob([serializeSrt(cues)], { type: 'text/srt;charset=utf-8' }),
      `${state.project.name}.srt`,
    )
  }

  return (
    <div data-testid="captions-panel" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b px-2 py-1.5">
        <Button
          size="sm"
          variant="secondary"
          className="h-6 px-2 text-xs"
          disabled={newCueAt === null}
          onClick={addCue}
        >
          New Cue
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs"
          onClick={() => fileRef.current?.click()}
        >
          Import SRT
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs"
          data-testid="captions-download"
          onClick={downloadFile}
        >
          Download SRT
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".srt"
          aria-label="Import SRT file"
          data-testid="captions-import"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            if (file) void importFile(file)
          }}
        />
      </div>
      {entries.length === 0 ? (
        <p className="text-muted-foreground px-3 py-4 text-xs">
          No captions yet. Import an SRT file to create timed cues, or press New Cue to write one at
          the playhead.
        </p>
      ) : (
        <ol
          data-testid="captions-list"
          className="editor-scroll min-h-0 flex-1 space-y-1.5 overflow-y-auto px-2 py-2"
        >
          {entries.map(({ trackId, clip }, index) => (
            <li
              key={clip.id}
              data-testid={`caption-cue-${clip.id}`}
              className="border-border rounded border p-1.5"
            >
              <div className="mb-1 flex items-center gap-1.5">
                <button
                  type="button"
                  aria-label={`Seek to cue ${index + 1}`}
                  title={`Seek to cue ${index + 1}`}
                  className="text-muted-foreground hover:text-foreground w-6 shrink-0 text-left text-xs font-semibold tabular-nums"
                  onClick={() => seekToCue(clip.start)}
                >
                  {index + 1}
                </button>
                <Input
                  key={`s-${clip.id}-${clip.start}`}
                  type="number"
                  step="0.1"
                  min="0"
                  defaultValue={clip.start}
                  aria-label={`Cue ${index + 1} start (seconds)`}
                  className="h-6 px-1.5 text-xs tabular-nums"
                  onBlur={(e) => commitStart({ trackId, clip }, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  }}
                />
                <span aria-hidden="true" className="text-muted-foreground text-xs">
                  to
                </span>
                <Input
                  key={`e-${clip.id}-${clip.start}-${clip.duration}`}
                  type="number"
                  step="0.1"
                  min="0"
                  defaultValue={clip.start + clip.duration}
                  aria-label={`Cue ${index + 1} end (seconds)`}
                  className="h-6 px-1.5 text-xs tabular-nums"
                  onBlur={(e) => commitEnd({ trackId, clip }, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  }}
                />
              </div>
              <Textarea
                key={`t-${clip.id}-${clip.text ?? ''}`}
                defaultValue={clip.text ?? ''}
                rows={2}
                aria-label={`Cue ${index + 1} text`}
                placeholder="Caption text"
                className="min-h-0 px-1.5 py-1 text-xs"
                onBlur={(e) => commitText({ trackId, clip }, e.target.value)}
              />
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
