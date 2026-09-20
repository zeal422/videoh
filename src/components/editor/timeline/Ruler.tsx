'use client'

import { useEffect, useRef } from 'react'
import { formatTime, rulerStep } from '@/lib/editor/time'

/**
 * Time ruler: canvas-drawn ticks + labels, doubles as the scrub surface
 * (pointerdown/drag seeks the playhead).
 */
export function Ruler({
  width,
  pxPerSec,
  onScrubStart,
  onScrub,
  onScrubEnd,
}: {
  width: number
  pxPerSec: number
  onScrubStart: (t: number) => void
  onScrub: (t: number) => void
  onScrubEnd: () => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const scrubbingRef = useRef(false)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = Math.min(2, typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1)
    const w = Math.min(width, 30000)
    canvas.width = Math.max(1, Math.round(w * dpr))
    canvas.height = Math.round(28 * dpr)
    canvas.style.width = `${w}px`
    canvas.style.height = '28px'

    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, 28)

    // background
    ctx.fillStyle = 'hsl(240 6% 12%)'
    ctx.fillRect(0, 0, w, 28)

    const step = rulerStep(pxPerSec)
    const minorStep = step / 5

    // minor ticks
    ctx.strokeStyle = 'hsl(240 4% 26%)'
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let t = 0; t * pxPerSec <= w; t += minorStep) {
      const x = Math.round(t * pxPerSec) + 0.5
      ctx.moveTo(x, 20)
      ctx.lineTo(x, 28)
    }
    ctx.stroke()

    // major ticks + labels
    ctx.fillStyle = 'hsl(240 5% 64%)'
    ctx.strokeStyle = 'hsl(240 4% 40%)'
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif'
    ctx.textBaseline = 'top'
    ctx.beginPath()
    for (let t = 0; t * pxPerSec <= w; t += step) {
      const x = Math.round(t * pxPerSec) + 0.5
      ctx.moveTo(x, 12)
      ctx.lineTo(x, 28)
      ctx.fillText(formatTime(t), x + 3, 2)
    }
    ctx.stroke()
  }, [width, pxPerSec])

  const timeFromEvent = (clientX: number): number => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return 0
    return Math.max(0, (clientX - rect.left) / pxPerSec)
  }

  return (
    <div
      role="slider"
      aria-label="Timeline playhead position"
      aria-valuenow={undefined}
      className="relative h-7 shrink-0 cursor-ew-resize select-none"
      style={{ width: Math.min(width, 30000) }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        scrubbingRef.current = true
        onScrubStart(timeFromEvent(e.clientX))
      }}
      onPointerMove={(e) => {
        if (scrubbingRef.current) onScrub(timeFromEvent(e.clientX))
      }}
      onPointerUp={() => {
        scrubbingRef.current = false
        onScrubEnd()
      }}
      onPointerCancel={() => {
        scrubbingRef.current = false
        onScrubEnd()
      }}
    >
      <canvas ref={canvasRef} className="block" aria-hidden="true" />
    </div>
  )
}
