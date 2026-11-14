/**
 * shapes.ts: pure geometry and validation for shape clips (0.25.0).
 *
 * Shapes are parameterized primitives, never arbitrary paths. Every kind is
 * generated inside one centered box covering `SHAPE_FRAME_SCALE` of the frame,
 * so preview, export, the effect path, and the monitor gizmo all place the same
 * geometry. The compositor interprets the path data; hit testing and bounds
 * stay here so they can run in the Node test environment.
 */

import {
  SHAPE_FILL_DEFAULT,
  SHAPE_FRAME_SCALE,
  SHAPE_POINTS_DEFAULT,
  SHAPE_POINTS_MAX,
  SHAPE_POINTS_MIN,
  SHAPE_RADIUS_MAX,
  SHAPE_STROKE_DEFAULT,
  SHAPE_STROKE_MAX,
  SHAPE_STROKE_WIDTH_DEFAULT,
} from './constants'
import { clamp } from './time'
import type { ShapeKind, ShapeStyle } from './types'

export interface ShapePoint {
  x: number
  y: number
}

export interface ShapeRect {
  x: number
  y: number
  w: number
  h: number
}

export interface ShapeBounds {
  x0: number
  y0: number
  x1: number
  y1: number
}

export type ShapePath =
  | { kind: 'rect'; rect: ShapeRect; radius: number }
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number }
  | { kind: 'polygon'; points: ShapePoint[] }

/** All shape kinds, in menu order. */
export const SHAPE_KINDS: readonly ShapeKind[] = [
  'rectangle',
  'ellipse',
  'triangle',
  'star',
  'polygon',
  'heart',
]

const SHAPE_LABELS: Record<ShapeKind, string> = {
  rectangle: 'Rectangle',
  ellipse: 'Ellipse',
  triangle: 'Triangle',
  star: 'Star',
  polygon: 'Polygon',
  heart: 'Heart',
}

export function isShapeKind(value: unknown): value is ShapeKind {
  return typeof value === 'string' && (SHAPE_KINDS as readonly string[]).includes(value)
}

export function shapeKindLabel(kind: ShapeKind): string {
  // The signature promises a string, so an unknown kind (only reachable from a
  // hand-built style or a future kind this build does not label) falls back
  // instead of returning undefined into an aria-label.
  return SHAPE_LABELS[kind] ?? 'Shape'
}

/** `#rrggbb`, the only color form the shape commands and hydration accept. */
export function isShapeHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)
}

function normalizeColor(color: string): string {
  return color.toLowerCase()
}

export function createShapeStyle(kind: ShapeKind): ShapeStyle {
  const shape: ShapeStyle = { kind, fill: SHAPE_FILL_DEFAULT }
  if (kind === 'rectangle') shape.radius = 0
  if (kind === 'star' || kind === 'polygon') shape.points = SHAPE_POINTS_DEFAULT
  return shape
}

/**
 * Validates a shape at a command or hydration boundary. A missing or hostile
 * kind/fill drops the whole entry; optional fields fall back or clamp
 * per-field, so a usable shape survives one wild value.
 */
export function sanitizeShape(raw: unknown): ShapeStyle | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const entry = raw as Record<string, unknown>
  if (!isShapeKind(entry.kind)) return undefined
  if (!isShapeHexColor(entry.fill)) return undefined
  const shape: ShapeStyle = { kind: entry.kind, fill: normalizeColor(entry.fill) }

  if (isShapeHexColor(entry.stroke)) {
    const width =
      typeof entry.strokeWidth === 'number' && Number.isFinite(entry.strokeWidth)
        ? clamp(entry.strokeWidth, 0, SHAPE_STROKE_MAX)
        : SHAPE_STROKE_WIDTH_DEFAULT
    // A zero-width stroke is no stroke; keep the stored shape clean rather than
    // leaving a color the renderer would have to ignore.
    if (width > 0) {
      shape.stroke = normalizeColor(entry.stroke)
      shape.strokeWidth = width
    }
  }

  if (shape.kind === 'rectangle') {
    const radius =
      typeof entry.radius === 'number' && Number.isFinite(entry.radius)
        ? clamp(entry.radius, 0, SHAPE_RADIUS_MAX)
        : 0
    if (radius > 0) shape.radius = radius
  }
  if (shape.kind === 'star' || shape.kind === 'polygon') {
    const points =
      typeof entry.points === 'number' && Number.isFinite(entry.points)
        ? Math.round(clamp(entry.points, SHAPE_POINTS_MIN, SHAPE_POINTS_MAX))
        : SHAPE_POINTS_DEFAULT
    shape.points = clamp(points, SHAPE_POINTS_MIN, SHAPE_POINTS_MAX)
  }
  return shape
}

/** The centered path box before stroke expansion. */
export function shapeBox(width: number, height: number): ShapeRect {
  const w = Math.max(0, width) * SHAPE_FRAME_SCALE
  const h = Math.max(0, height) * SHAPE_FRAME_SCALE
  return { x: (width - w) / 2, y: (height - h) / 2, w, h }
}

/** The visual bounds including half the stroke width, for the gizmo and selection. */
export function shapeBounds(shape: ShapeStyle, width: number, height: number): ShapeBounds {
  const box = shapeBox(width, height)
  const pad = shape.stroke ? (shape.strokeWidth ?? SHAPE_STROKE_WIDTH_DEFAULT) / 2 : 0
  return {
    x0: box.x - pad,
    y0: box.y - pad,
    x1: box.x + box.w + pad,
    y1: box.y + box.h + pad,
  }
}

function polygon(
  count: number,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  innerRatio = 1,
): ShapePoint[] {
  const points: ShapePoint[] = []
  // Sanitized shapes always carry 3..12 points, but a hand-built ShapeStyle
  // can carry any number: a non-finite count would loop forever and a huge one
  // would allocate unboundedly. Clamp to the same range sanitizeShape enforces.
  const safe = Number.isFinite(count)
    ? Math.round(clamp(count, SHAPE_POINTS_MIN, SHAPE_POINTS_MAX))
    : SHAPE_POINTS_DEFAULT
  const total = innerRatio < 1 ? safe * 2 : safe
  for (let i = 0; i < total; i++) {
    const ratio = innerRatio < 1 && i % 2 === 1 ? innerRatio : 1
    const angle = -Math.PI / 2 + (i * Math.PI * 2) / total
    points.push({
      x: cx + Math.cos(angle) * rx * ratio,
      y: cy + Math.sin(angle) * ry * ratio,
    })
  }
  return points
}

/**
 * The heart is a sampled parametric curve, not a bezier path: a pure polygon
 * keeps bounds and hit testing exact and needs no path parser. 48 samples is
 * smooth at every supported project size.
 *
 * The sample normalization is computed once: it depends only on the curve, so
 * doing it per frame (and per heart clip) allocated four scratch arrays and four
 * variadic spreads on every draw. The unit points are scaled into the box here.
 */
const HEART_UNIT_POINTS: readonly ShapePoint[] = (() => {
  const count = 48
  const raw: ShapePoint[] = []
  for (let i = 0; i < count; i++) {
    const t = (i / count) * Math.PI * 2
    raw.push({
      x: 16 * Math.sin(t) ** 3,
      y: 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t),
    })
  }
  // The parametric y range is not symmetric (the lobes rise above y=5), so a
  // hard-coded divisor would push points outside the shape bounds.
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const point of raw) {
    if (point.x < minX) minX = point.x
    if (point.x > maxX) maxX = point.x
    if (point.y < minY) minY = point.y
    if (point.y > maxY) maxY = point.y
  }
  return raw.map((point) => ({
    x: (point.x - minX) / (maxX - minX),
    y: (maxY - point.y) / (maxY - minY),
  }))
})()

function heartPoints(box: ShapeRect): ShapePoint[] {
  return HEART_UNIT_POINTS.map((point) => ({
    x: box.x + point.x * box.w,
    y: box.y + point.y * box.h,
  }))
}

/** The drawable path for a shape at a project size. */
export function shapePathData(shape: ShapeStyle, width: number, height: number): ShapePath {
  const box = shapeBox(width, height)
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  switch (shape.kind) {
    case 'rectangle':
      return { kind: 'rect', rect: box, radius: shape.radius ?? 0 }
    case 'ellipse':
      return { kind: 'ellipse', cx, cy, rx: box.w / 2, ry: box.h / 2 }
    case 'triangle':
      return {
        kind: 'polygon',
        points: [
          { x: cx, y: box.y },
          { x: box.x + box.w, y: box.y + box.h },
          { x: box.x, y: box.y + box.h },
        ],
      }
    case 'polygon':
      return {
        kind: 'polygon',
        points: polygon(shape.points ?? SHAPE_POINTS_DEFAULT, cx, cy, box.w / 2, box.h / 2),
      }
    case 'star':
      return {
        kind: 'polygon',
        points: polygon(shape.points ?? SHAPE_POINTS_DEFAULT, cx, cy, box.w / 2, box.h / 2, 0.45),
      }
    case 'heart':
      return { kind: 'polygon', points: heartPoints(box) }
  }
}

function pointInRoundedRect(rect: ShapeRect, radius: number, x: number, y: number): boolean {
  if (x < rect.x || y < rect.y || x > rect.x + rect.w || y > rect.y + rect.h) return false
  const r = clamp(radius, 0, Math.min(rect.w, rect.h) / 2)
  if (r <= 0) return true
  const cx = clamp(x, rect.x + r, rect.x + rect.w - r)
  const cy = clamp(y, rect.y + r, rect.y + rect.h - r)
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
}

function pointInPolygon(points: readonly ShapePoint[], x: number, y: number): boolean {
  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i]
    const b = points[j]
    const intersects = a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x
    if (intersects) inside = !inside
  }
  return inside
}

/**
 * Hit testing against the real path, never a bounding rectangle. Used by the
 * shape geometry tests and available to monitor interactions; a triangle's
 * empty corners and a star's notches correctly miss.
 */
export function pointInShape(
  shape: ShapeStyle,
  width: number,
  height: number,
  x: number,
  y: number,
): boolean {
  const path = shapePathData(shape, width, height)
  if (path.kind === 'rect') return pointInRoundedRect(path.rect, path.radius, x, y)
  if (path.kind === 'ellipse') {
    if (path.rx <= 0 || path.ry <= 0) return false
    return ((x - path.cx) / path.rx) ** 2 + ((y - path.cy) / path.ry) ** 2 <= 1
  }
  return pointInPolygon(path.points, x, y)
}
