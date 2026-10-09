'use client'

import { useEffect, useReducer, useRef } from 'react'
import { Pause, Play, Undo2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useEditorStore } from '@/lib/editor/store'
import { sourceRangeFor, sourceRangeInvalid } from '@/lib/editor/sequence-ops'
import {
  attachSourcePreview,
  detachSourcePreview,
  sourcePreviewIsPlaying,
  sourcePreviewPause,
  sourcePreviewPlay,
  sourcePreviewSeek,
} from '@/lib/editor/playback/source-preview'

/**
 * Source monitor (three-point editing): the media bin's selected asset plays
 * here, `I`/`O` mark its in/out points, and `,`/`.` place the marked span at
 * the sequence playhead in insert/overwrite mode.
 *
 * All time comes from `sourcePlayhead` in the store (written by the preview
 * element's callbacks), never from the element directly, so the readout, the
 * marks and the placement range cannot disagree.
 */
export function SourcePanel({ className }: { className?: string }) {
  const doc = useEditorStore((s) => s.doc)
  const sourceAssetId = useEditorStore((s) => s.sourceAssetId)
  const sourceIn = useEditorStore((s) => s.sourceIn)
  const sourceOut = useEditorStore((s) => s.sourceOut)
  const sourcePlayhead = useEditorStore((s) => s.sourcePlayhead)
  const markSourceIn = useEditorStore((s) => s.markSourceIn)
  const markSourceOut = useEditorStore((s) => s.markSourceOut)
  const clearSourceMarks = useEditorStore((s) => s.clearSourceMarks)

  const asset = sourceAssetId ? doc.media.find((m) => m.id === sourceAssetId) : undefined
  const assetId = asset?.id
  const assetUrl = asset?.url
  const hasWindow = !!asset && asset.kind !== 'image' && asset.duration > 0
  const playing = sourcePreviewIsPlaying()

  const hostRef = useRef<HTMLDivElement>(null)
  // Transport icon state lives on the element, so event callbacks force one
  // re-render (the store owns the time; this only mirrors play/pause).
  const [, forceRender] = useReducer((n: number) => n + 1, 0)

  useEffect(() => {
    const host = hostRef.current
    if (!host || !assetId || !assetUrl) return
    const current = useEditorStore.getState().doc.media.find((m) => m.id === assetId)
    if (!current || !current.url) return
    // A still has no source window and no `<video>` path: the panel draws the
    // image itself below. Attaching a video element to a PNG only ever left a
    // black box behind (the demuxer cannot open it).
    if (current.kind === 'image') return
    attachSourcePreview(host, current, () => forceRender())
    return () => detachSourcePreview()
  }, [assetId, assetUrl])

  if (!asset) {
    return (
      <div
        data-testid="source-panel"
        className={cn(
          'flex min-h-0 flex-1 flex-col items-center justify-center gap-1 p-4 text-center text-xs text-muted-foreground',
          className,
        )}
      >
        <p className="font-medium">No source selected</p>
        <p className="leading-relaxed">Click an asset in the Media bin to load it here.</p>
      </div>
    )
  }

  const range = hasWindow ? sourceRangeFor(asset, sourceIn, sourceOut) : null
  const invalid = sourceRangeInvalid(range)
  const playheadMax = hasWindow ? asset.duration : 0

  return (
    <div
      data-testid="source-panel"
      data-selected-asset={asset.id}
      className={cn('flex min-h-0 flex-1 flex-col gap-2 p-2', className)}
    >
      <p className="truncate text-xs font-medium" title={asset.name}>
        {asset.name}
      </p>

      {/* The singleton appends its own <video data-testid="source-preview"> for
          timed assets; a still is drawn here instead (no element at all). */}
      <div
        ref={hostRef}
        className="flex aspect-video w-full shrink-0 items-center justify-center overflow-hidden rounded bg-black"
      >
        {!asset.url && <span className="text-[10px] text-muted-foreground">Media offline</span>}
        {asset.url && asset.kind === 'image' && (
          <img
            data-testid="source-image"
            src={asset.url}
            alt={asset.name}
            className="max-h-full max-w-full object-contain"
          />
        )}
      </div>

      <div className="flex items-center gap-1.5">
        <Button
          size="icon"
          variant="secondary"
          className="size-7 shrink-0"
          aria-label={playing ? 'Pause source' : 'Play source'}
          disabled={!hasWindow}
          onClick={() => {
            if (playing) sourcePreviewPause()
            else sourcePreviewPlay()
            forceRender()
          }}
        >
          {playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
        </Button>
        <input
          type="range"
          aria-label="Source position"
          className="h-1.5 min-w-0 flex-1 accent-rose-500"
          min={0}
          max={Math.max(playheadMax, 0.01)}
          step={0.01}
          value={Math.min(sourcePlayhead, playheadMax)}
          disabled={!hasWindow}
          onChange={(e) => {
            const t = Number(e.target.value)
            useEditorStore.getState().setSourcePlayhead(t)
            sourcePreviewSeek(t)
          }}
        />
        <span
          data-testid="source-time"
          className="w-14 shrink-0 text-right font-mono text-[11px] tabular-nums"
        >
          {sourcePlayhead.toFixed(2)}s
        </span>
      </div>

      <div className="flex items-center gap-1">
        <Button
          data-testid="source-mark-in"
          size="sm"
          variant="secondary"
          className="h-7 flex-1 px-1 text-[11px]"
          disabled={!hasWindow}
          aria-label="Mark In (I)"
          onClick={markSourceIn}
        >
          Mark In
        </Button>
        <Button
          data-testid="source-mark-out"
          size="sm"
          variant="secondary"
          className="h-7 flex-1 px-1 text-[11px]"
          disabled={!hasWindow}
          aria-label="Mark Out (O)"
          onClick={markSourceOut}
        >
          Mark Out
        </Button>
        <Button
          data-testid="source-clear"
          size="sm"
          variant="ghost"
          className="h-7 shrink-0 px-1.5 text-[11px]"
          disabled={!hasWindow || (sourceIn === null && sourceOut === null)}
          aria-label="Clear source in and out"
          onClick={clearSourceMarks}
        >
          <Undo2 className="size-3.5" />
        </Button>
      </div>

      <p
        data-testid="source-span"
        data-invalid={invalid || undefined}
        className={cn(
          'text-[10px] leading-relaxed',
          invalid ? 'text-rose-400' : 'text-muted-foreground',
        )}
      >
        {!hasWindow
          ? 'Images have no source window.'
          : range
            ? `In ${range.inPoint.toFixed(2)}s · Out ${range.outPoint.toFixed(2)}s · ${
                invalid ? 'invalid range' : `${(range.outPoint - range.inPoint).toFixed(2)}s`
              }`
            : 'Whole asset · press I / O to mark a range'}
      </p>
    </div>
  )
}
