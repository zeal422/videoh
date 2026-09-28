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
  /** Pointer that owns the scrub. Any pointer over the ruler may start one, but
   *  only this one drives it: a second finger's move must not seek and its
   *  release must not stop the scrub the first finger is still performing. */
  const scrubPointerIdRef = useRef<number | null>(null)

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
        // The newest pointer owns the scrub. It RECLAIMS ownership rather than
        // refusing a second pointer: without pointer capture (headless, or a
        // release outside the window) a scrub can outlive its pointer, and a
        // refusal would leave the ruler dead for the rest of the session.
        // Synthetic pointer events (automation) carry an inactive pointerId,
        // so capture is a UX nicety, not required for the scrub to work.
        try {
          e.currentTarget.setPointerCapture(e.pointerId)
        } catch {
          /* headless/automation: proceed without capture */
        }
        scrubbingRef.current = true
        scrubPointerIdRef.current = e.pointerId
        onScrubStart(timeFromEvent(e.clientX))
      }}
      onPointerMove={(e) => {
        if (e.pointerId !== scrubPointerIdRef.current) return
        if (scrubbingRef.current) onScrub(timeFromEvent(e.clientX))
      }}
      onPointerUp={(e) => {
        if (e.pointerId !== scrubPointerIdRef.current) return
        scrubbingRef.current = false
        scrubPointerIdRef.current = null
        onScrubEnd()
      }}
      onPointerCancel={(e) => {
        if (e.pointerId !== scrubPointerIdRef.current) return
        scrubbingRef.current = false
        scrubPointerIdRef.current = null
        onScrubEnd()
      }}
    >
      <canvas ref={canvasRef} className="block" aria-hidden="true" />
    </div>
  )
}
