'use client'

import type { PointerEvent as ReactPointerEvent } from 'react'

import type { Point } from '@/lib/editor/transform'

export type GizmoMode = 'move' | 'scale' | 'rotate'

interface TransformGizmoProps {
  projectWidth: number
  projectHeight: number
  /** The positioned, scaled, rotated box corners. */
  quad: Point[]
  rotateHandle: Point
  /** Hit radius in project pixels (derived from the monitor's CSS scale). */
  hitRadius: number
  /** Drag highlight while a gesture is live. */
  active: boolean
  onPointerDown: (mode: GizmoMode, e: ReactPointerEvent<SVGSVGElement>) => void
  onPointerMove: (e: ReactPointerEvent<SVGSVGElement>) => void
  onPointerUp: (e: ReactPointerEvent<SVGSVGElement>) => void
  onPointerCancel: (e: ReactPointerEvent<SVGSVGElement>) => void
}

/**
 * Monitor transform overlay (0.24.0): rotated box, four corner scale handles,
 * and a rotation handle above the top edge. Geometry arrives from the pure
 * `transform.ts` helpers, so the overlay and the renderer cannot drift.
 */
export function TransformGizmo({
  projectWidth,
  projectHeight,
  quad,
  rotateHandle,
  hitRadius,
  active,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
}: TransformGizmoProps) {
  const modeFromTarget = (target: EventTarget | null): GizmoMode | null => {
    const element = target instanceof Element ? target.closest('[data-gizmo]') : null
    const mode = element?.getAttribute('data-gizmo')
    return mode === 'move' || mode === 'scale' || mode === 'rotate' ? mode : null
  }
  const polygon = quad.map((point) => `${point.x},${point.y}`).join(' ')
  const topMid = {
    x: (quad[0].x + quad[1].x) / 2,
    y: (quad[0].y + quad[1].y) / 2,
  }

  return (
    <svg
      aria-label="Transform gizmo"
      data-testid="transform-gizmo"
      className="absolute inset-0 size-full touch-none"
      viewBox={`0 0 ${projectWidth} ${projectHeight}`}
      preserveAspectRatio="none"
      onPointerDown={(e) => {
        const mode = modeFromTarget(e.target)
        if (!mode) return
        try {
          e.currentTarget.setPointerCapture(e.pointerId)
        } catch {
          // Headless/automation: proceed without capture.
        }
        onPointerDown(mode, e)
      }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <polygon
        data-gizmo="move"
        points={polygon}
        className={active ? 'fill-rose-400/10' : 'fill-transparent'}
        stroke="none"
        style={{ pointerEvents: 'all', cursor: 'move' }}
      />
      <polygon
        points={polygon}
        fill="none"
        className="stroke-rose-400"
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
        style={{ pointerEvents: 'none' }}
      />
      <line
        x1={topMid.x}
        y1={topMid.y}
        x2={rotateHandle.x}
        y2={rotateHandle.y}
        className="stroke-rose-400"
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
        style={{ pointerEvents: 'none' }}
      />
      {quad.map((point, index) => (
        <circle
          key={`corner-${index}`}
          data-gizmo="scale"
          cx={point.x}
          cy={point.y}
          r={hitRadius}
          className="fill-rose-400 stroke-white"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
          style={{ pointerEvents: 'all', cursor: 'nwse-resize' }}
        />
      ))}
      <circle
        data-gizmo="rotate"
        cx={rotateHandle.x}
        cy={rotateHandle.y}
        r={hitRadius}
        className="fill-white stroke-rose-400"
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
        style={{ pointerEvents: 'all', cursor: 'grab' }}
      />
    </svg>
  )
}
