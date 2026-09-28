'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Volume2,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { docDuration, findClip } from '@/lib/editor/factories'
import { offlineMediaAt } from '@/lib/editor/offline'
import { formatTime } from '@/lib/editor/time'
import { attachPreviewEngine, detachPreviewEngine } from '@/lib/editor/playback/preview'
import { playbackRef } from '@/lib/editor/playback/engine-ref'
import { clamp01, measureTextBox } from '@/lib/editor/playback/text-box'
import { currentTransientToken, useEditorStore } from '@/lib/editor/store'
import { cn } from '@/lib/utils'

/**
 * Center panel: the program monitor (canvas composited by the playback engine)
 * plus transport controls (play/pause, skip, frame-step, time display, volume).
 *
 * Drag-to-position: when the selected TEXT clip is live at the playhead, the
 * monitor becomes a positioning surface — pointer drags update style.x/y via
 * transient commands (one undo step per gesture, committed on release) and a
 * dashed outline (measureTextBox, the compositor's geometry twin) shows what
 * is being moved. Precise/keyboard positioning stays in the Inspector sliders.
 */
export function PreviewPanel() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const doc = useEditorStore((s) => s.doc)
  const playhead = useEditorStore((s) => s.playhead)
  const playing = useEditorStore((s) => s.playing)
  const selection = useEditorStore((s) => s.selection)
  const [volume, setVolume] = useState(1)
  const [draggingText, setDraggingText] = useState(false)
  const dragOrigin = useRef<{ px: number; py: number; x: number; y: number } | null>(null)
  /** Initiating pointer of the active text drag (multi-touch: ignore others). */
  const textDragPointerId = useRef<number | null>(null)
  /** Gesture token from beginTransient: a foreign commit bumps it and the
   *  drag then refuses further frames (they would carry no undo entry). */
  const textDragToken = useRef(-1)

  // Attach the engine once; canvas resolution follows project settings.
  useEffect(() => {
    if (!canvasRef.current) return
    attachPreviewEngine(canvasRef.current)
    return () => detachPreviewEngine()
  }, [])

  useEffect(() => {
    playbackRef.current?.setMasterVolume(volume)
  }, [volume])

  // Resolution changes follow project settings; the engine re-syncs on draw.
  useEffect(() => {
    const engine = canvasRef.current
    if (engine) {
      engine.width = doc.project.width
      engine.height = doc.project.height
    }
  }, [doc.project.width, doc.project.height])

  const duration = docDuration(doc)
  const isEmpty = duration <= 0
  // A frame that needs offline media renders black and silent; naming the file
  // is the difference between "broken" and "waiting for a relink".
  const offlineMedia = useMemo(() => offlineMediaAt(doc, playhead), [doc, playhead])

  // ————— drag-to-position (text) —————
  const selected = selection ? findClip(doc, selection) : undefined
  const textClip =
    selected && selected.clip.text !== undefined && selected.track.kind === 'text'
      ? selected.clip
      : undefined
  const textLive =
    !!textClip && playhead >= textClip.start && playhead < textClip.start + textClip.duration
  const canDragText = !!textClip && textLive

  const textBox = useMemo(() => {
    if (!canDragText || !textClip?.style) return null
    return measureTextBox(textClip, doc.project.width, doc.project.height)
  }, [canDragText, textClip, doc.project.width, doc.project.height])

  const onCanvasPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!canDragText || !textClip?.style || e.button !== 0) return
    const store = useEditorStore.getState()
    const canvas = canvasRef.current
    const rect = canvas?.getBoundingClientRect()
    if (!rect || rect.width === 0 || rect.height === 0) return
    // Synthetic pointer events (automation) carry an inactive pointerId —
    // capture is a UX nicety, not required for the gesture to work.
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* headless/automation: proceed without capture */
    }
    dragOrigin.current = {
      px: e.clientX,
      py: e.clientY,
      x: textClip.style.x,
      y: textClip.style.y,
    }
    textDragToken.current = store.beginTransient(e.pointerId)
    textDragPointerId.current = e.pointerId
    setDraggingText(true)
  }

  const onCanvasPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    // Only the initiating pointer drives the drag (multi-touch).
    if (dragOrigin.current && e.pointerId !== textDragPointerId.current) return
    const origin = dragOrigin.current
    const canvas = canvasRef.current
    if (!origin || !canvas) return
    // A foreign commit (keyboard delete, undo) ended the gesture slot: applying
    // further frames would mutate the doc with no undo entry behind them.
    if (currentTransientToken() !== textDragToken.current) return
    const rect = canvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    // Client-pixel delta ÷ displayed canvas size = normalized project delta
    // (the monitor letterboxes to the project aspect, so this maps 1:1).
    const x = clamp01(origin.x + (e.clientX - origin.px) / rect.width)
    const y = clamp01(origin.y + (e.clientY - origin.py) / rect.height)
    useEditorStore.getState().applyTransient({
      type: 'setTextStyle',
      clipId: textClip!.id,
      style: { x, y },
    })
  }

  const endTextDrag = (commit: boolean, e?: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragOrigin.current) return
    // A second pointer must not end a drag it did not start (multi-touch).
    if (e && e.pointerId !== textDragPointerId.current) return
    dragOrigin.current = null
    textDragPointerId.current = null
    const store = useEditorStore.getState()
    if (commit) store.commitTransient()
    else store.cancelTransient()
    setDraggingText(false)
  }

  return (
    /* @container: the volume slider's visibility (@lg:) keys off THIS panel's
       width, not the viewport — a narrow panel hides the slider instead of
       letting the transport row overflow and clip its buttons. */
    <section
      aria-label="Preview"
      className="@container flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-zinc-950"
    >
      <div className="relative flex min-h-0 flex-1 items-center justify-center p-3">
        <div
          className="relative max-h-full max-w-full"
          style={{
            aspectRatio: `${doc.project.width} / ${doc.project.height}`,
          }}
        >
          <canvas
            ref={canvasRef}
            aria-label="Video preview canvas"
            data-testid="preview-canvas"
            className={cn(
              'block h-full max-h-full w-auto max-w-full rounded border border-zinc-800 bg-black shadow-2xl',
              canDragText && !draggingText && 'cursor-grab',
              draggingText && 'cursor-grabbing',
            )}
            style={{
              aspectRatio: `${doc.project.width} / ${doc.project.height}`,
            }}
            title={canDragText ? 'Drag to reposition the selected text' : undefined}
            onPointerDown={onCanvasPointerDown}
            onPointerMove={onCanvasPointerMove}
            onPointerUp={(e) => endTextDrag(true, e)}
            onPointerCancel={(e) => endTextDrag(false, e)}
          />
          {textBox && (
            <div
              aria-hidden="true"
              data-testid="text-drag-outline"
              className={cn(
                'pointer-events-none absolute rounded-sm border border-dashed transition-colors',
                draggingText ? 'border-rose-400 bg-rose-400/5' : 'border-white/50',
              )}
              style={{
                left: `${Math.max(0, textBox.x0) * 100}%`,
                top: `${Math.max(0, textBox.y0) * 100}%`,
                width: `${(Math.min(1, textBox.x1) - Math.max(0, textBox.x0)) * 100}%`,
                height: `${(Math.min(1, textBox.y1) - Math.max(0, textBox.y0)) * 100}%`,
              }}
            />
          )}
          {isEmpty && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <p className="rounded-lg bg-black/60 px-4 py-2 text-sm text-zinc-300">
                Import media or press <kbd className="rounded bg-zinc-700 px-1">T</kbd> to add text
              </p>
            </div>
          )}
          {!isEmpty && offlineMedia.length > 0 && (
            <div
              data-testid="media-offline-overlay"
              className="pointer-events-none absolute inset-0 flex items-center justify-center p-4"
            >
              <div className="max-w-full rounded-lg border border-amber-500/40 bg-black/70 px-4 py-3 text-center">
                <p className="text-sm font-medium text-amber-300">Media offline</p>
                <p className="mt-1 truncate text-xs text-amber-200/80">{offlineMedia.join(', ')}</p>
                <p className="mt-1 text-[11px] text-zinc-400">
                  Relink in the Media bin to bring this frame back
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* transport — shrink-0 so it stays visible at any panel height; the
          canvas area above is the only part that gives up space. */}
      <div className="flex h-12 min-w-0 shrink-0 items-center justify-center gap-1 overflow-hidden border-t border-zinc-800 bg-zinc-900/60 px-3">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Go to start (Home)"
          onClick={() => playbackRef.current?.seek(0)}
        >
          <SkipBack className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Previous frame (←)"
          onClick={() => playbackRef.current?.stepFrames(-1)}
        >
          <ChevronLeft className="size-4" />
        </Button>
        <Button
          variant="default"
          size="icon"
          aria-label={playing ? 'Pause (Space)' : 'Play (Space)'}
          data-testid="play-pause"
          onClick={() => playbackRef.current?.toggle()}
          disabled={isEmpty}
          className="mx-1"
        >
          {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Next frame (→)"
          onClick={() => playbackRef.current?.stepFrames(1)}
        >
          <ChevronRight className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Go to end (End)"
          onClick={() => playbackRef.current?.seek(duration)}
        >
          <SkipForward className="size-4" />
        </Button>

        <div
          className="ml-3 whitespace-nowrap font-mono text-xs text-zinc-300"
          data-testid="time-display"
        >
          {formatTime(playhead)} <span className="text-zinc-500">/ {formatTime(duration)}</span>
        </div>

        <div className="ml-4 hidden items-center gap-2 @lg:flex">
          <Volume2 className="size-4 text-zinc-400" aria-hidden="true" />
          <Slider
            aria-label="Master volume"
            value={[volume]}
            min={0}
            max={1}
            step={0.05}
            onValueChange={([v]) => setVolume(v)}
            className="w-24"
          />
        </div>
      </div>
    </section>
  )
}
