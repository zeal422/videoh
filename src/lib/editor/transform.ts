/**
 * transform.ts: the ONE trigonometry for clip Motion (0.24.0).
 *
 * Rotation and flip join the position-and-scale transform every draw path
 * already shared, so the preview compositor, the offline exporter, the effect
 * pipeline, and the monitor gizmo cannot disagree. The matrix helpers are pure
 * and Node-testable; `applyRotationFlip` issues the same matrix on a canvas.
 */

export interface ClipTransform {
  posX: number
  posY: number
  scale: number
  /** Degrees, -3600..3600; 0 is neutral. */
  rotation: number
  flipX: boolean
  flipY: boolean
}

/** Neutral Motion: no position, no scale, no rotation, no flip. */
export const IDENTITY_TRANSFORM: ClipTransform = {
  posX: 0,
  posY: 0,
  scale: 1,
  rotation: 0,
  flipX: false,
  flipY: false,
}

export interface Point {
  x: number
  y: number
}

/** Canvas 2D matrix in its native order: x' = a*x + c*y + e, y' = b*x + d*y + f. */
export interface Matrix2D {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
}

export const IDENTITY_MATRIX: Matrix2D = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }

/** m1 applied first, then m2 (the canvas call order: each call postmultiplies). */
export function multiplyMatrix(m1: Matrix2D, m2: Matrix2D): Matrix2D {
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e,
    f: m1.b * m2.e + m1.d * m2.f + m1.f,
  }
}

export function translationMatrix(x: number, y: number): Matrix2D {
  return { a: 1, b: 0, c: 0, d: 1, e: x, f: y }
}

export function scaleMatrix(x: number, y: number): Matrix2D {
  return { a: x, b: 0, c: 0, d: y, e: 0, f: 0 }
}

export function rotationMatrix(degrees: number): Matrix2D {
  const radians = (degrees * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  return { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 }
}

export function transformPoint(m: Matrix2D, x: number, y: number): Point {
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f }
}

/** Flip signs from the explicit boolean pair. */
export function flipSigns(transform: Pick<ClipTransform, 'flipX' | 'flipY'>): Point {
  return { x: transform.flipX ? -1 : 1, y: transform.flipY ? -1 : 1 }
}

/**
 * Rotation and flip around a point: T(origin) R F T(-origin). This is the
 * left-hand factor of the Motion matrix, so a rotated clip keeps `origin`
 * fixed and a companion position-and-scale factor can be applied after it.
 */
export function rotationFlipMatrix(
  transform: Pick<ClipTransform, 'rotation' | 'flipX' | 'flipY'>,
  originX: number,
  originY: number,
): Matrix2D {
  const flip = flipSigns(transform)
  return multiplyMatrix(
    multiplyMatrix(
      multiplyMatrix(translationMatrix(originX, originY), rotationMatrix(transform.rotation)),
      scaleMatrix(flip.x, flip.y),
    ),
    translationMatrix(-originX, -originY),
  )
}

/** The transformed center of a point under position and scale around `center`. */
export function positionedCenter(
  point: Point,
  transform: Pick<ClipTransform, 'posX' | 'posY' | 'scale'>,
  center: Point,
): Point {
  return {
    x: center.x + transform.posX + (point.x - center.x) * transform.scale,
    y: center.y + transform.posY + (point.y - center.y) * transform.scale,
  }
}

/**
 * Issues the rotation/flip factor around `origin`. Canvas postmultiplies, so a
 * caller that then issues the position-and-scale factor gets
 * `R · Mpos` applied to drawn points, exactly like `rotationFlipMatrix`.
 */
export function applyRotationFlip(
  ctx: CanvasRenderingContext2D,
  transform: Pick<ClipTransform, 'rotation' | 'flipX' | 'flipY'>,
  originX: number,
  originY: number,
): void {
  const flip = flipSigns(transform)
  if (transform.rotation === 0 && flip.x === 1 && flip.y === 1) return
  ctx.translate(originX, originY)
  if (transform.rotation !== 0) ctx.rotate((transform.rotation * Math.PI) / 180)
  if (flip.x !== 1 || flip.y !== 1) ctx.scale(flip.x, flip.y)
  ctx.translate(-originX, -originY)
}

// gizmo geometry

export interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** The four corners of `rect` rotated (and mirrored) around its center. */
export function rotatedRectCorners(rect: Rect, rotation: number): Point[] {
  const center = { x: (rect.x0 + rect.x1) / 2, y: (rect.y0 + rect.y1) / 2 }
  const m = rotationFlipMatrix({ rotation, flipX: false, flipY: false }, center.x, center.y)
  return [
    transformPoint(m, rect.x0, rect.y0),
    transformPoint(m, rect.x1, rect.y0),
    transformPoint(m, rect.x1, rect.y1),
    transformPoint(m, rect.x0, rect.y1),
  ]
}

/** Applies position and scale around the frame center, keeping the rect shape. */
export function positionedRect(
  rect: Rect,
  transform: Pick<ClipTransform, 'posX' | 'posY' | 'scale'>,
  frameWidth: number,
  frameHeight: number,
): Rect {
  const center = { x: frameWidth / 2, y: frameHeight / 2 }
  const scaled = {
    x0: center.x + transform.posX + (rect.x0 - center.x) * transform.scale,
    y0: center.y + transform.posY + (rect.y0 - center.y) * transform.scale,
    x1: center.x + transform.posX + (rect.x1 - center.x) * transform.scale,
    y1: center.y + transform.posY + (rect.y1 - center.y) * transform.scale,
  }
  return scaled
}

/** The gizmo quad: the clip's positioned, scaled, rotated box. */
export function gizmoQuad(
  base: Rect,
  transform: ClipTransform,
  frameWidth: number,
  frameHeight: number,
): Point[] {
  return rotatedRectCorners(
    positionedRect(base, transform, frameWidth, frameHeight),
    transform.rotation,
  )
}

/** Uniform scale factor for a corner drag about the box center. */
export function scaleFromDrag(
  startDistance: number,
  currentDistance: number,
  startScale: number,
  min: number,
  max: number,
): number {
  if (!Number.isFinite(startDistance) || startDistance <= 0) return startScale
  const next = (currentDistance / startDistance) * startScale
  return Math.min(max, Math.max(min, next))
}

/** Shortest signed angle from `from` to `to`, in degrees (-180, 180]. */
export function angleDelta(from: number, to: number): number {
  const delta = ((to - from + 540) % 360) - 180
  return delta === -180 ? 180 : delta
}

/** Rotation for a handle drag, keeping the authored turn count. */
export function rotationFromDrag(
  startRotation: number,
  startAngle: number,
  currentAngle: number,
  min: number,
  max: number,
): number {
  const next = startRotation + angleDelta(startAngle, currentAngle)
  return Math.min(max, Math.max(min, next))
}

/**
 * Rotation handle that stays inside the interactive monitor viewport: the
 * outward position when it fits, mirrored inward across the top edge midpoint
 * when it would fall outside. An unrotated full-frame clip otherwise parks its
 * handle above the SVG, out of reach.
 */
export function rotationHandleInBounds(
  quad: readonly Point[],
  distance: number,
  width: number,
  height: number,
): Point {
  const outer = rotationHandlePoint(quad, distance)
  if (outer.x >= 0 && outer.x <= width && outer.y >= 0 && outer.y <= height) return outer
  return rotationHandlePoint(quad, -distance)
}

/** Convex-quad containment (the gizmo box for a rotated clip). */
export function pointInQuad(point: Point, quad: readonly Point[]): boolean {
  if (quad.length !== 4) return false
  let sign = 0
  for (let i = 0; i < 4; i++) {
    const a = quad[i]
    const b = quad[(i + 1) % 4]
    const cross = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x)
    if (Math.abs(cross) < 1e-9) continue
    const next = Math.sign(cross)
    if (sign === 0) sign = next
    else if (sign !== next) return false
  }
  return true
}

/** The rotation handle sits one box-height above the top edge midpoint. */
export function rotationHandlePoint(quad: readonly Point[], distance: number): Point {
  const topLeft = quad[0]
  const topRight = quad[1]
  const mid = { x: (topLeft.x + topRight.x) / 2, y: (topLeft.y + topRight.y) / 2 }
  const bottomMid = { x: (quad[3].x + quad[2].x) / 2, y: (quad[3].y + quad[2].y) / 2 }
  const dx = mid.x - bottomMid.x
  const dy = mid.y - bottomMid.y
  const length = Math.hypot(dx, dy) || 1
  return { x: mid.x + (dx / length) * distance, y: mid.y + (dy / length) * distance }
}

/** Pointer position in project pixels from the canvas's client rect. */
export function pointerProjectPoint(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  projectWidth: number,
  projectHeight: number,
): Point {
  const width = rect.width || 1
  const height = rect.height || 1
  return {
    x: ((clientX - rect.left) / width) * projectWidth,
    y: ((clientY - rect.top) / height) * projectHeight,
  }
}

/** Rotation in degrees of `point` around `center`, measured from 12 o'clock. */
export function angleFromCenter(center: Point, point: Point): number {
  return (Math.atan2(point.y - center.y, point.x - center.x) * 180) / Math.PI
}
