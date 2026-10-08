'use client'

import { useEffect, useRef, useState } from 'react'

import {
  LUMA_BUCKETS,
  VECTORSCOPE_SIZE,
  sampleLuma,
  sampleRgbBalance,
  sampleVectorscope,
  sampleWaveform,
  scopeSampleSize,
  type RgbaPixels,
  type VectorscopeDensity,
  type WaveformTrace,
} from '@/lib/editor/color'

/**
 * Scopes, a collapsible section inside the preview panel (0.6.0).
 *
 * Four meters: a luma histogram, an RGB balance read, a waveform and a
 * vectorscope. They sample the MONITOR canvas, so what the meters show is what
 * the user sees (grades, opacity and crossfades included) rather than the
 * source frames.
 *
 * Cost is bounded two ways: the monitor is drawn into a small offscreen canvas
 * (at most 256x144, see scopeSampleSize) so the pixel read never scales with
 * project resolution, and the read runs at ~10 Hz instead of per frame, so
 * playback keeps its budget. A tainted canvas (cross-origin media) logs once
 * and hides the meters instead of throwing into the render loop.
 */

const SAMPLE_INTERVAL_MS = 100

export function ScopesPanel({
  canvas,
  open,
  onToggle,
}: {
  /** The monitor canvas to read (PreviewPanel's preview-canvas). */
  canvas: HTMLCanvasElement | null
  open: boolean
  onToggle: () => void
}) {
  const histRef = useRef<HTMLCanvasElement>(null)
  const balanceRef = useRef<HTMLCanvasElement>(null)
  const waveRef = useRef<HTMLCanvasElement>(null)
  const vectorRef = useRef<HTMLCanvasElement>(null)
  /** One reusable downsample scratch, never a fresh canvas per read. */
  const scratchRef = useRef<HTMLCanvasElement | null>(null)
  /** The `unavailable` latch, readable from the interval without re-keying it. */
  const unavailableRef = useRef(false)
  const [unavailable, setUnavailable] = useState(false)
  /** The canvas the unavailable state was computed against (identity tracking). */
  const [seenCanvas, setSeenCanvas] = useState<HTMLCanvasElement | null>(canvas)
  if (canvas !== seenCanvas) {
    // A canvas identity change restarts from a clean slate even while open:
    // the new element has no sampling history, so a taint verdict about the
    // OLD canvas must not keep the interval dead for the new one. (Render-time
    // state adjustment, the React-recommended pattern; avoids an effect.)
    setSeenCanvas(canvas)
    setUnavailable(false)
  }
  if (!open && unavailable) {
    // A close/reopen cycle (or a fresh canvas node) restarts from a clean
    // slate: a canvas that was tainted once (unlinked media, a failed load)
    // may be readable after the project under it changed, so the unavailable
    // flag must not outlive the collapse. Resetting during the render of a
    // closed panel is the React-recommended pattern for state derived from
    // other state, and avoids an effect (and its cascading render).
    setUnavailable(false)
  }

  useEffect(() => {
    if (!canvas) {
      scratchRef.current = null
      return
    }
    const sample = scopeSampleSize(canvas.width, canvas.height)
    const scratch = document.createElement('canvas')
    scratch.width = sample.width
    scratch.height = sample.height
    scratchRef.current = scratch
    return () => {
      scratchRef.current = null
    }
  }, [canvas])

  useEffect(() => {
    // Deliberately NOT keyed on `unavailable`: the interval keeps running while
    // the banner is up so sampling can recover on its own. A resize resets the
    // canvas's origin-clean flag (and a relink removes the tainting media), so
    // the canvas can become readable again with the panel still open; keying on
    // the latch would keep the meters dead until a close/reopen cycle.
    if (!open || !canvas) return
    let warned = false
    const timer = window.setInterval(() => {
      // Re-derive the sample size every tick: the monitor canvas is resized by
      // project-settings changes (PreviewPanel mirrors width/height onto the
      // element), and the scratch must follow or the read would sample a stale
      // grid. Resizing a canvas clears it, which the draw below overwrites.
      const sample = scopeSampleSize(canvas.width, canvas.height)
      const scratch = scratchRef.current
      if (!scratch) {
        const fresh = document.createElement('canvas')
        fresh.width = sample.width
        fresh.height = sample.height
        scratchRef.current = fresh
        return
      }
      if (scratch.width !== sample.width || scratch.height !== sample.height) {
        scratch.width = sample.width
        scratch.height = sample.height
      }
      const ctx = scratch.getContext('2d')
      if (!ctx) return
      let pixels: RgbaPixels | null = null
      try {
        ctx.drawImage(canvas, 0, 0, scratch.width, scratch.height)
        pixels = ctx.getImageData(0, 0, scratch.width, scratch.height)
      } catch {
        // A tainted canvas cannot be sampled. Hide the meters once, loudly
        // enough to diagnose, instead of throwing on every tick.
        if (!warned) {
          warned = true
          console.warn('Scopes: the preview canvas cannot be sampled (tainted media)')
        }
        unavailableRef.current = true
        setUnavailable(true)
        return
      }
      if (!pixels) return
      if (unavailableRef.current) {
        // Readable again: clear the latch and let the meters paint this tick.
        unavailableRef.current = false
        setUnavailable(false)
      }
      drawHistogram(histRef.current, sampleLuma(pixels))
      drawBalance(balanceRef.current, sampleRgbBalance(pixels))
      drawWaveform(waveRef.current, sampleWaveform(pixels))
      drawVectorscope(vectorRef.current, sampleVectorscope(pixels))
    }, SAMPLE_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [open, canvas])

  return (
    <div
      data-testid="scopes-panel"
      className="shrink-0 border-t border-zinc-800 bg-zinc-900/60 px-3 py-2"
    >
      <div className="flex items-center justify-between">
        <button
          type="button"
          aria-label="Toggle scopes"
          aria-expanded={open}
          data-testid="scopes-toggle"
          className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400 hover:text-zinc-200"
          onClick={onToggle}
        >
          Scopes {open ? '▾' : '▸'}
        </button>
        {open && (
          <span className="text-[10px] text-zinc-500">
            luma histogram · rgb balance · waveform · vectorscope · ~10 Hz
          </span>
        )}
      </div>
      {open && (
        <div className="mt-2 flex flex-wrap items-center gap-3" data-testid="scopes-meters">
          <div>
            <p className="mb-1 text-[10px] text-zinc-500">Luma</p>
            <canvas
              ref={histRef}
              width={LUMA_BUCKETS}
              height={64}
              data-testid="scopes-luma"
              className="block h-16 w-64 max-w-full rounded border border-zinc-800 bg-black"
            />
          </div>
          <div>
            <p className="mb-1 text-[10px] text-zinc-500">RGB balance</p>
            <canvas
              ref={balanceRef}
              width={96}
              height={64}
              data-testid="scopes-balance"
              className="block h-16 w-24 rounded border border-zinc-800 bg-black"
            />
          </div>
          <div>
            <p className="mb-1 text-[10px] text-zinc-500">Waveform</p>
            <canvas
              ref={waveRef}
              width={WAVEFORM_WIDTH}
              height={64}
              data-testid="scopes-waveform"
              className="block h-16 w-64 max-w-full rounded border border-zinc-800 bg-black"
            />
          </div>
          <div>
            <p className="mb-1 text-[10px] text-zinc-500">Vectorscope</p>
            <canvas
              ref={vectorRef}
              width={96}
              height={96}
              data-testid="scopes-vectorscope"
              className="block h-24 w-24 rounded border border-zinc-800 bg-black"
            />
          </div>
        </div>
      )}
      {unavailable && (
        <p className="mt-1 text-[10px] text-amber-300">
          Meters unavailable: the preview canvas cannot be sampled.
        </p>
      )}
    </div>
  )
}

/** Display width of the waveform trace; the sampled columns tile it edge to edge. */
const WAVEFORM_WIDTH = 256

/** Paints the luma histogram (one bar per bucket, log-friendly scaling). */
function drawHistogram(canvas: HTMLCanvasElement | null, buckets: number[]): void {
  const ctx = canvas?.getContext('2d')
  if (!ctx || !canvas) return
  const { width, height } = canvas
  ctx.clearRect(0, 0, width, height)
  // Normalize against the busiest bucket so a mostly-dark frame still reads.
  const peak = Math.max(...buckets, 1e-6)
  ctx.fillStyle = '#e5e7eb'
  for (let b = 0; b < buckets.length; b++) {
    const bar = (buckets[b] / peak) * (height - 2)
    if (bar <= 0) continue
    ctx.fillRect(b, height - bar, 1, bar)
  }
}

/**
 * Paints the waveform: one vertical span per sampled column, from the column's
 * minimum to its maximum luma, the columns tiling the full canvas width. A flat
 * (all-black) frame still draws a 1px line instead of nothing, so a dark picture
 * reads as a trace at the floor.
 */
function drawWaveform(canvas: HTMLCanvasElement | null, trace: WaveformTrace): void {
  const ctx = canvas?.getContext('2d')
  if (!ctx || !canvas) return
  const { width, height } = canvas
  ctx.clearRect(0, 0, width, height)
  const columns = trace.min.length
  if (columns === 0) return
  ctx.fillStyle = '#e5e7eb'
  // Pixel-snapped shared edges: adjacent columns meet, so the trace spans the
  // whole canvas whether the sample carries 256 columns or 81. A floor()ed bar
  // width left the right edge blank whenever columns < width.
  const step = width / columns
  for (let x = 0; x < columns; x++) {
    const left = Math.round(x * step)
    const right = Math.max(left + 1, Math.round((x + 1) * step))
    const top = Math.min(height - 1, Math.max(0, Math.round(height - trace.max[x] * height)))
    const bottom = Math.min(height, Math.max(0, Math.round(height - trace.min[x] * height)))
    const bar = Math.max(1, bottom - top)
    ctx.fillRect(left, top, right - left, Math.min(bar, height - top))
  }
}

/**
 * Paints the vectorscope: the chroma-plane density as a grid of cells, each
 * cell's brightness scaled against the busiest one. Only occupied cells draw.
 */
function drawVectorscope(canvas: HTMLCanvasElement | null, density: VectorscopeDensity): void {
  const ctx = canvas?.getContext('2d')
  if (!ctx || !canvas) return
  const { width, height } = canvas
  ctx.clearRect(0, 0, width, height)
  const { size, bins } = density
  if (size <= 0 || bins.length < size * size) return
  const peak = Math.max(...bins, 1e-6)
  const cell = Math.max(1, Math.floor(Math.min(width, height) / size))
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const weight = bins[y * size + x] / peak
      if (weight <= 0) continue
      ctx.fillStyle = `rgba(190, 220, 255, ${(0.25 + 0.75 * weight).toFixed(3)})`
      ctx.fillRect(x * cell, y * cell, cell, cell)
    }
  }
}

/** Paints the RGB balance meters (one bar per channel, 0..255 scale). */
function drawBalance(
  canvas: HTMLCanvasElement | null,
  balance: { r: number; g: number; b: number },
): void {
  const ctx = canvas?.getContext('2d')
  if (!ctx || !canvas) return
  const { width, height } = canvas
  ctx.clearRect(0, 0, width, height)
  const channels: [number, string][] = [
    [balance.r, '#f87171'],
    [balance.g, '#4ade80'],
    [balance.b, '#60a5fa'],
  ]
  const barWidth = width / channels.length
  channels.forEach(([level, color], i) => {
    const bar = Math.max(0, Math.min(1, level)) * (height - 2)
    ctx.fillStyle = color
    ctx.fillRect(i * barWidth + 2, height - bar, barWidth - 4, bar)
  })
}
