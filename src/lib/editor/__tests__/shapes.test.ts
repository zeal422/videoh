import { describe, expect, it } from 'vitest'

import {
  SHAPE_KINDS,
  createShapeStyle,
  isShapeHexColor,
  isShapeKind,
  pointInShape,
  sanitizeShape,
  shapeBounds,
  shapeBox,
  shapeKindLabel,
  shapePathData,
} from '../shapes'
import {
  SHAPE_FRAME_SCALE,
  SHAPE_POINTS_DEFAULT,
  SHAPE_POINTS_MAX,
  SHAPE_POINTS_MIN,
  SHAPE_RADIUS_MAX,
  SHAPE_STROKE_MAX,
} from '../constants'
import type { ShapeStyle } from '../types'

const W = 1000
const H = 1000

describe('shape validation (0.25.0)', () => {
  it('offers the six parameterized kinds in menu order', () => {
    expect(SHAPE_KINDS).toEqual(['rectangle', 'ellipse', 'triangle', 'star', 'polygon', 'heart'])
    expect(SHAPE_KINDS.every(isShapeKind)).toBe(true)
    expect(isShapeKind('rect')).toBe(false)
    // The signature promises a string, so an unknown kind reads as a generic
    // label instead of injecting undefined into an aria-label.
    expect(shapeKindLabel('speech-bubble' as never)).toBe('Shape')
    expect(shapeKindLabel('star')).toBe('Star')
  })

  it('creates clean defaults per kind', () => {
    expect(createShapeStyle('rectangle')).toEqual({ kind: 'rectangle', fill: '#ffffff', radius: 0 })
    expect(createShapeStyle('star')).toEqual({ kind: 'star', fill: '#ffffff', points: 5 })
    expect(createShapeStyle('ellipse')).toEqual({ kind: 'ellipse', fill: '#ffffff' })
  })

  it('accepts and normalizes a full shape', () => {
    expect(
      sanitizeShape({
        kind: 'rectangle',
        fill: '#AABBCC',
        stroke: '#001122',
        strokeWidth: 12,
        radius: 24,
        points: 99,
      }),
    ).toEqual({
      kind: 'rectangle',
      fill: '#aabbcc',
      stroke: '#001122',
      strokeWidth: 12,
      radius: 24,
    })
  })

  it('accepts strict hex colors only', () => {
    expect(isShapeHexColor('#ffffff')).toBe(true)
    expect(isShapeHexColor('#000')).toBe(false)
    expect(isShapeHexColor('white')).toBe(false)
    expect(isShapeHexColor('url(#paint)')).toBe(false)
    for (const fill of ['url(#x)', 'red', '#fff', 'rgba(0,0,0,0.5)', '', null, 7]) {
      expect(sanitizeShape({ kind: 'rectangle', fill })).toBeUndefined()
    }
    expect(sanitizeShape({ kind: 'rect', fill: '#ffffff' })).toBeUndefined()
    expect(sanitizeShape(null)).toBeUndefined()
  })

  it('clamps stroke width and radius, and drops fields the kind ignores', () => {
    expect(
      sanitizeShape({ kind: 'ellipse', fill: '#ffffff', stroke: '#000000', strokeWidth: 999 }),
    ).toEqual({
      kind: 'ellipse',
      fill: '#ffffff',
      stroke: '#000000',
      strokeWidth: SHAPE_STROKE_MAX,
    })
    expect(
      sanitizeShape({ kind: 'rectangle', fill: '#ffffff', stroke: '#000000', strokeWidth: -4 }),
    ).toEqual({ kind: 'rectangle', fill: '#ffffff' })
    expect(sanitizeShape({ kind: 'ellipse', fill: '#ffffff', radius: 100 })).toEqual({
      kind: 'ellipse',
      fill: '#ffffff',
    })
    expect(
      sanitizeShape({ kind: 'rectangle', fill: '#ffffff', radius: SHAPE_RADIUS_MAX + 100 }),
    ).toEqual({ kind: 'rectangle', fill: '#ffffff', radius: SHAPE_RADIUS_MAX })
  })

  it('clamps and rounds point counts for stars and polygons only', () => {
    expect(sanitizeShape({ kind: 'star', fill: '#ffffff', points: 2 })).toEqual({
      kind: 'star',
      fill: '#ffffff',
      points: SHAPE_POINTS_MIN,
    })
    expect(sanitizeShape({ kind: 'polygon', fill: '#ffffff', points: 99 })).toEqual({
      kind: 'polygon',
      fill: '#ffffff',
      points: SHAPE_POINTS_MAX,
    })
    expect(sanitizeShape({ kind: 'polygon', fill: '#ffffff', points: 5.6 })).toEqual({
      kind: 'polygon',
      fill: '#ffffff',
      points: 6,
    })
    expect(sanitizeShape({ kind: 'triangle', fill: '#ffffff', points: 8 })).toEqual({
      kind: 'triangle',
      fill: '#ffffff',
    })
  })

  it('uses one centered box covering the documented frame fraction', () => {
    expect(shapeBox(1000, 500)).toEqual({ x: 100, y: 50, w: 800, h: 400 })
    expect(SHAPE_FRAME_SCALE).toBe(0.8)
    expect(shapeBox(0, 0)).toEqual({ x: 0, y: 0, w: 0, h: 0 })
  })

  it('expands bounds by half the stroke for the gizmo', () => {
    const plain = shapeBounds({ kind: 'rectangle', fill: '#ffffff' }, W, H)
    expect(plain).toEqual({ x0: 100, y0: 100, x1: 900, y1: 900 })
    const stroked = shapeBounds(
      { kind: 'rectangle', fill: '#ffffff', stroke: '#000000', strokeWidth: 20 },
      W,
      H,
    )
    expect(stroked).toEqual({ x0: 90, y0: 90, x1: 910, y1: 910 })
  })
})

describe('shape geometry (0.25.0)', () => {
  it('builds a rounded rectangle and an ellipse inside the box', () => {
    const rect = shapePathData({ kind: 'rectangle', fill: '#fff', radius: 30 }, W, H)
    expect(rect).toEqual({ kind: 'rect', rect: { x: 100, y: 100, w: 800, h: 800 }, radius: 30 })
    const ellipse = shapePathData({ kind: 'ellipse', fill: '#fff' }, W, H)
    expect(ellipse).toEqual({ kind: 'ellipse', cx: 500, cy: 500, rx: 400, ry: 400 })
  })

  it('builds a top-centered triangle, an n-gon, a star, and a sampled heart', () => {
    const triangle = shapePathData({ kind: 'triangle', fill: '#fff' }, W, H)
    expect(triangle.kind).toBe('polygon')
    if (triangle.kind === 'polygon') {
      expect(triangle.points).toHaveLength(3)
      expect(triangle.points[0]).toEqual({ x: 500, y: 100 })
    }
    const polygon = shapePathData({ kind: 'polygon', fill: '#fff', points: 6 }, W, H)
    expect(polygon.kind === 'polygon' && polygon.points).toHaveLength(6)
    const star = shapePathData({ kind: 'star', fill: '#fff', points: 5 }, W, H)
    expect(star.kind === 'polygon' && star.points).toHaveLength(10)
    const heart = shapePathData({ kind: 'heart', fill: '#fff' }, W, H)
    expect(heart.kind === 'polygon' && heart.points).toHaveLength(48)
    if (heart.kind === 'polygon') {
      for (const point of heart.points) {
        expect(point.x).toBeGreaterThanOrEqual(99.9)
        expect(point.x).toBeLessThanOrEqual(900.1)
        expect(point.y).toBeGreaterThanOrEqual(99.9)
        expect(point.y).toBeLessThanOrEqual(900.1)
      }
    }
  })

  it('bounds a hostile point count instead of looping or allocating', () => {
    // Sanitized shapes carry 3..12 points, but a hand-built style can carry
    // anything; the generator clamps to the same range. (A 1e9 count would
    // spin the unfixed loop for minutes, so the red run uses a smaller
    // out-of-range count and the non-finite branch.)
    const huge = shapePathData({ kind: 'polygon', fill: '#fff', points: 500 }, W, H)
    expect(huge.kind === 'polygon' && huge.points).toHaveLength(SHAPE_POINTS_MAX)
    const infinite = shapePathData({ kind: 'star', fill: '#fff', points: Number.NaN }, W, H)
    expect(infinite.kind === 'polygon' && infinite.points).toHaveLength(SHAPE_POINTS_DEFAULT * 2)
  })

  it('hit-tests the real path, not the bounding rectangle', () => {
    const rect: ShapeStyle = { kind: 'rectangle', fill: '#fff', radius: 100 }
    expect(pointInShape(rect, W, H, 500, 500)).toBe(true)
    expect(pointInShape(rect, W, H, 50, 50)).toBe(false)
    // Inside the bounding square but outside the rounded corner.
    expect(pointInShape(rect, W, H, 105, 105)).toBe(false)

    const ellipse: ShapeStyle = { kind: 'ellipse', fill: '#fff' }
    expect(pointInShape(ellipse, W, H, 500, 500)).toBe(true)
    expect(pointInShape(ellipse, W, H, 105, 105)).toBe(false)

    const triangle: ShapeStyle = { kind: 'triangle', fill: '#fff' }
    expect(pointInShape(triangle, W, H, 500, 700)).toBe(true)
    expect(pointInShape(triangle, W, H, 120, 120)).toBe(false)
  })

  it('misses a star notch between two points', () => {
    const star: ShapeStyle = { kind: 'star', fill: '#fff', points: 5 }
    expect(pointInShape(star, W, H, 500, 500)).toBe(true)
    // A real notch: the inner vertex along 18 degrees sits at radius 180 from
    // the center, so a point at radius 250 on that ray is still inside the
    // 800 px box but outside the concave star. (The old probe at x=895 was
    // outside the whole polygon, which never exercised the notch.)
    expect(pointInShape(star, W, H, 737.8, 577.3)).toBe(false)
  })
})
