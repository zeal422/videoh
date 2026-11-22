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
  /** Visible radius in project pixels: about a 5px CSS radius. */
  visualRadius: number
  /** Hit radius in project pixels: at least a 12px CSS radius. */
  hitRadius: number
  /** Full-height and full-width amber guides for a snapped monitor move. */
  snapGuides?: { x: number | null; y: number | null }
  /** Drag highlight while a gesture is live. */
  active: boolean
  onPointerDown: (mode: GizmoMode, e: ReactPointerEvent<SVGSVGElement>, corner?: number) => void
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
  visualRadius,
  hitRadius,
  snapGuides,
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
      // The root spans the monitor, so it must not hit-test: clicks that miss
      // the box and handles belong to the canvas underneath (the text drag
      // starts there). The move polygon and handles opt back in below, and
      // pointer capture keeps the gesture on the root once it starts.
      style={{ pointerEvents: 'none' }}
      onPointerDown={(e) => {
        const mode = modeFromTarget(e.target)
        if (!mode) return
        const element = e.target instanceof Element ? e.target.closest('[data-gizmo]') : null
        const rawCorner = element?.getAttribute('data-corner')
        const corner = rawCorner === null || rawCorner === undefined ? undefined : Number(rawCorner)
        try {
          e.currentTarget.setPointerCapture(e.pointerId)
        } catch {
          // Headless/automation: proceed without capture.
        }
        onPointerDown(mode, e, Number.isFinite(corner) ? corner : undefined)
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
      {snapGuides?.x != null && (
        <line
          data-testid="canvas-snap-guide-x"
          x1={snapGuides.x}
          y1={0}
          x2={snapGuides.x}
          y2={projectHeight}
          className="stroke-amber-400"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
          style={{ pointerEvents: 'none' }}
        />
      )}
      {snapGuides?.y != null && (
        <line
          data-testid="canvas-snap-guide-y"
          x1={0}
          y1={snapGuides.y}
          x2={projectWidth}
          y2={snapGuides.y}
          className="stroke-amber-400"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
          style={{ pointerEvents: 'none' }}
        />
      )}
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
        <g key={`corner-${index}`}>
          <circle
            data-gizmo="scale"
            data-corner={index}
            cx={point.x}
            cy={point.y}
            r={hitRadius}
            fill="transparent"
            stroke="none"
            style={{ pointerEvents: 'all', cursor: 'nwse-resize' }}
          />
          <circle
            data-gizmo-visual="scale"
            cx={point.x}
            cy={point.y}
            r={visualRadius}
            className="fill-rose-400 stroke-white"
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
            style={{ pointerEvents: 'none' }}
          />
        </g>
      ))}
      <circle
        data-gizmo="rotate"
        cx={rotateHandle.x}
        cy={rotateHandle.y}
        r={hitRadius}
        fill="transparent"
        stroke="none"
        style={{ pointerEvents: 'all', cursor: 'grab' }}
      />
      <circle
        data-gizmo-visual="rotate"
        cx={rotateHandle.x}
        cy={rotateHandle.y}
        r={visualRadius}
        className="fill-white stroke-rose-400"
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
        style={{ pointerEvents: 'none' }}
      />
    </svg>
  )
}
