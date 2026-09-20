'use client'

import { useEffect, useRef } from 'react'

/**
 * Waveform renderer for audio-bearing clips. Draws the slice of the asset's
 * peak data covered by [inPoint, inPoint + duration], mirrored around the
 * vertical center. Redraws when the pixel width bucket changes (to avoid
 * per-pixel churn during zoom/trim) and on mute changes.
 */
export function Waveform({
  peaks,
  assetDuration,
  inPoint,
  duration,
  widthPx,
  height,
  muted,
}: {
  peaks: number[]
  assetDuration: number
  inPoint: number
  duration: number
  widthPx: number
  height: number
  muted: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const fromFrac = assetDuration > 0 ? inPoint / assetDuration : 0
  const toFrac = assetDuration > 0 ? (inPoint + duration) / assetDuration : 1

  // Debounce redraws during continuous resize by bucketing the width to 8px steps.
  const widthBucket = Math.max(2, Math.floor(Math.min(widthPx, 8000) / 8) * 8)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = Math.min(2, typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1)
    const w = widthBucket
    const h = Math.max(8, height - 14) // leave room for the label strip
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`

    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    const startIdx = Math.floor(fromFrac * peaks.length)
    const endIdx = Math.ceil(toFrac * peaks.length)
    const slice = peaks.slice(
      Math.max(0, startIdx),
      Math.min(peaks.length, Math.max(endIdx, startIdx + 1)),
    )
    if (slice.length === 0) return

    const mid = h / 2
    ctx.fillStyle = muted ? 'rgba(255,255,255,0.18)' : 'rgba(253, 230, 138, 0.75)' // amber-200/75
    const barWidth = Math.max(1, w / slice.length)
    for (let x = 0; x < w; x++) {
      const idx = Math.min(slice.length - 1, Math.floor((x / w) * slice.length))
      const amp = Math.max(0.02, slice[idx]) * (mid - 1)
      ctx.fillRect(x, mid - amp, Math.max(1, barWidth - (barWidth > 2 ? 0.5 : 0)), amp * 2)
    }
  }, [peaks, fromFrac, toFrac, widthBucket, height, muted])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none absolute bottom-0.5 left-0"
    />
  )
}
