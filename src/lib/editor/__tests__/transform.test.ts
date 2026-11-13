import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { createClip, createDoc, createMediaAsset, createTrack } from '../factories'
import { animatedValue } from '../keyframes'
import { blitTransformed, drawContain, drawTextClip, motionPivot } from '../playback/compositor'
import { clipTransform, planVideoFrame } from '../export/offline'
import { textLayoutBox } from '../playback/text-box'
import {
  angleDelta,
  angleFromCenter,
  applyRotationFlip,
  gizmoQuad,
  IDENTITY_MATRIX,
  IDENTITY_TRANSFORM,
  multiplyMatrix,
  pointerProjectPoint,
  pointInQuad,
  positionedCenter,
  positionedRect,
  rotationFlipMatrix,
  rotationFromDrag,
  rotationHandleInBounds,
  rotationHandlePoint,
  rotationMatrix,
  rotatedRectCorners,
  scaleFromDrag,
  scaleMatrix,
  transformPoint,
  translationMatrix,
  type ClipTransform,
  type Matrix2D,
} from '../transform'
import type { TextStyle } from '../types'

const FC = { x: 960, y: 540 }

function transform(partial: Partial<ClipTransform> = {}): ClipTransform {
  return { ...IDENTITY_TRANSFORM, ...partial, flipX: false, flipY: false, ...partial }
}

/** Replays recorded canvas transform calls into the matrix they build. */
function replay(calls: { op: string; args: unknown[] }[]): Matrix2D {
  let m = IDENTITY_MATRIX
  for (const call of calls) {
    if (call.op === 'translate') {
      m = multiplyMatrix(m, translationMatrix(Number(call.args[0]), Number(call.args[1])))
    } else if (call.op === 'rotate') {
      m = multiplyMatrix(m, rotationMatrix((Number(call.args[0]) * 180) / Math.PI))
    } else if (call.op === 'scale') {
      m = multiplyMatrix(m, scaleMatrix(Number(call.args[0]), Number(call.args[1])))
    }
  }
  return m
}

function expectMatrix(actual: Matrix2D, expected: Matrix2D) {
  expect(actual.a).toBeCloseTo(expected.a, 6)
  expect(actual.b).toBeCloseTo(expected.b, 6)
  expect(actual.c).toBeCloseTo(expected.c, 6)
  expect(actual.d).toBeCloseTo(expected.d, 6)
  expect(actual.e).toBeCloseTo(expected.e, 6)
  expect(actual.f).toBeCloseTo(expected.f, 6)
}

describe('rotation and flip matrix', () => {
  it('rotates points clockwise in canvas coordinates', () => {
    const m = rotationFlipMatrix(transform({ rotation: 90 }), 0, 0)
    const point = transformPoint(m, 1, 0)
    expect(point.x).toBeCloseTo(0, 6)
    expect(point.y).toBeCloseTo(1, 6)
  })

  it('mirrors each axis independently', () => {
    const flipX = rotationFlipMatrix(transform({ flipX: true }), 0, 0)
    expect(transformPoint(flipX, 2, 3)).toEqual({ x: -2, y: 3 })
    const flipY = rotationFlipMatrix(transform({ flipY: true }), 0, 0)
    expect(transformPoint(flipY, 2, 3)).toEqual({ x: 2, y: -3 })
  })

  it('rotates after the flip (R times F)', () => {
    const m = rotationFlipMatrix(transform({ rotation: 90, flipX: true }), 0, 0)
    // F maps (1,0) to (-1,0); R90 then maps it to (0,-1).
    const point = transformPoint(m, 1, 0)
    expect(point.x).toBeCloseTo(0, 6)
    expect(point.y).toBeCloseTo(-1, 6)
  })

  it('keeps the origin fixed', () => {
    const m = rotationFlipMatrix(transform({ rotation: 137, flipY: true }), 50, 20)
    const point = transformPoint(m, 50, 20)
    expect(point.x).toBeCloseTo(50, 6)
    expect(point.y).toBeCloseTo(20, 6)
  })

  it('transforms a box corner to the rotated position and keeps the center', () => {
    const rect = { x0: 100, y0: 100, x1: 300, y1: 200 }
    const corners = rotatedRectCorners(rect, 90)
    const center = { x: 200, y: 150 }
    // Rotating the top-left corner 90 degrees around the center lands it at
    // the top-right.
    expect(corners[0].x).toBeCloseTo(250, 6)
    expect(corners[0].y).toBeCloseTo(50, 6)
    const average = {
      x: corners.reduce((sum, p) => sum + p.x, 0) / 4,
      y: corners.reduce((sum, p) => sum + p.y, 0) / 4,
    }
    expect(average.x).toBeCloseTo(center.x, 6)
    expect(average.y).toBeCloseTo(center.y, 6)
  })

  it('maps a point through the position-and-scale factor around the frame center', () => {
    const center = positionedCenter({ x: 100, y: 200 }, { posX: 10, posY: -20, scale: 2 }, FC)
    expect(center).toEqual({ x: 960 + 10 + (100 - 960) * 2, y: 540 - 20 + (200 - 540) * 2 })
  })

  it('builds the gizmo quad from the base box, transform, and frame', () => {
    const base = { x0: FC.x - 200, y0: FC.y - 100, x1: FC.x + 200, y1: FC.y + 100 }
    const scaled = positionedRect(base, { posX: 0, posY: 0, scale: 2 }, 1920, 1080)
    expect(scaled).toEqual({ x0: 560, y0: 340, x1: 1360, y1: 740 })
    const quad = gizmoQuad(base, transform({ scale: 2, rotation: 90 }), 1920, 1080)
    const average = {
      x: quad.reduce((sum, p) => sum + p.x, 0) / 4,
      y: quad.reduce((sum, p) => sum + p.y, 0) / 4,
    }
    expect(average.x).toBeCloseTo(FC.x, 6)
    expect(average.y).toBeCloseTo(FC.y, 6)
  })
})

describe('gizmo math', () => {
  it('finds points inside a rotated quad', () => {
    const quad = rotatedRectCorners({ x0: 100, y0: 100, x1: 300, y1: 200 }, 45)
    expect(pointInQuad({ x: 200, y: 150 }, quad)).toBe(true)
    expect(pointInQuad({ x: 100, y: 100 }, quad)).toBe(false)
  })

  it('puts the rotation handle perpendicular to the top edge', () => {
    const quad = rotatedRectCorners({ x0: 100, y0: 100, x1: 300, y1: 200 }, 0)
    const handle = rotationHandlePoint(quad, 40)
    expect(handle).toEqual({ x: 200, y: 60 })
    const turned = rotationHandlePoint(rotatedRectCorners(quadRect(), 90), 40)
    // A 90 degree turn moves "above" to the right of the box.
    expect(turned.x).toBeCloseTo(290, 6)
    expect(turned.y).toBeCloseTo(150, 6)
  })

  it('measures the shortest angle delta across the wrap point', () => {
    expect(angleDelta(170, -170)).toBe(20)
    expect(angleDelta(-170, 170)).toBe(-20)
    expect(angleDelta(0, 90)).toBe(90)
  })

  it('keeps the authored turns while dragging rotation', () => {
    expect(rotationFromDrag(720, 0, 30, -3600, 3600)).toBe(750)
    expect(rotationFromDrag(720, 350, 10, -3600, 3600)).toBe(740)
    expect(rotationFromDrag(3590, 0, 90, -3600, 3600)).toBe(3600)
  })

  it('scales uniformly from a corner drag and clamps', () => {
    expect(scaleFromDrag(100, 200, 1, 0.1, 4)).toBe(2)
    expect(scaleFromDrag(100, 1000, 1, 0.1, 4)).toBe(4)
    expect(scaleFromDrag(100, 1, 1, 0.1, 4)).toBe(0.1)
    expect(scaleFromDrag(0, 200, 1, 0.1, 4)).toBe(1)
  })

  it('maps client pixels to project pixels through the canvas rect', () => {
    const point = pointerProjectPoint(
      80,
      40,
      { left: 20, top: 10, width: 400, height: 200 },
      1920,
      1080,
    )
    expect(point).toEqual({ x: 288, y: 162 })
    expect(angleFromCenter({ x: 0, y: 0 }, { x: 1, y: 0 })).toBeCloseTo(0, 6)
  })

  it('keeps the rotation handle inside the frame', () => {
    // A full-frame box parks the outward handle above the viewport...
    const full = { x0: 0, y0: 0, x1: 1920, y1: 1080 }
    const fullQuad = rotatedRectCorners(full, 0)
    const outward = rotationHandlePoint(fullQuad, 64.8)
    expect(outward.y).toBeLessThan(0)
    const inward = rotationHandleInBounds(fullQuad, 64.8, 1920, 1080)
    expect(inward.y).toBeGreaterThanOrEqual(0)
    expect(inward.y).toBeLessThanOrEqual(1080)
    // ...while a box with room keeps the outward position unchanged.
    const small = rotatedRectCorners({ x0: 760, y0: 340, x1: 1160, y1: 740 }, 0)
    expect(rotationHandleInBounds(small, 40, 1920, 1080)).toEqual(rotationHandlePoint(small, 40))
  })

  function quadRect() {
    return { x0: 100, y0: 100, x1: 300, y1: 200 }
  }
})

describe('text box center', () => {
  const measure = (line: string) => line.length * 7
  const baseStyle: TextStyle = {
    x: 0.2,
    y: 0.5,
    fontSize: 40,
    color: '#fff',
    fontFamily: 'Arial',
    bold: false,
    italic: false,
    align: 'left',
    shadow: false,
  }

  it('uses the measured box center for left, center, and right alignment', () => {
    const left = textLayoutBox(
      { text: 'Hello', style: { ...baseStyle, align: 'left' } },
      1920,
      1080,
      measure,
    )!
    const center = textLayoutBox(
      { text: 'Hello', style: { ...baseStyle, align: 'center' } },
      1920,
      1080,
      measure,
    )!
    const right = textLayoutBox(
      { text: 'Hello', style: { ...baseStyle, align: 'right' } },
      1920,
      1080,
      measure,
    )!
    // Only center alignment puts the box center on the style.x anchor.
    expect(center.centerX).toBeCloseTo(0.2 * 1920, 6)
    expect(left.centerX).toBeCloseTo(0.2 * 1920 + 17.5, 6)
    expect(right.centerX).toBeCloseTo(0.2 * 1920 - 17.5, 6)
    expect(left.centerY).toBeCloseTo(540, 6)
  })
})

describe('rotation keyframes', () => {
  it('interpolates linearly and with easing', () => {
    const clip = createClip({
      id: 'c',
      keyframes: {
        rotation: [
          { time: 0, value: 0, interpolation: 'linear' },
          { time: 2, value: 180, interpolation: 'linear' },
        ],
      },
    })
    expect(animatedValue(clip, 'rotation', 1)).toBeCloseTo(90, 6)
    clip.keyframes!.rotation![0].interpolation = 'easeIn'
    expect(animatedValue(clip, 'rotation', 1)).toBeLessThan(90)
  })

  it('falls back to the static rotation when the curve is empty', () => {
    const clip = createClip({ id: 'c', rotation: 45 })
    expect(animatedValue(clip, 'rotation', 1)).toBe(45)
  })
})

describe('shared draw paths apply rotation and flip', () => {
  beforeEach(() => {
    // sourceSize narrows with instanceof; Node has no media element classes.
    vi.stubGlobal('HTMLVideoElement', class {})
    vi.stubGlobal('HTMLImageElement', class {})
    vi.stubGlobal('HTMLCanvasElement', class {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function source(): CanvasImageSource {
    return { width: 640, height: 360 } as unknown as CanvasImageSource
  }

  it('drawContain issues the rotation/flip factor around the moved center', () => {
    const ctx = createFakeCtx()
    const t = transform({ posX: 10, posY: 20, scale: 2, rotation: 90, flipX: true })
    drawContain(ctx as unknown as CanvasRenderingContext2D, source(), 1920, 1080, 1, 'none', t)
    const ops = ctx.calls.filter((call) => ['translate', 'rotate', 'scale'].includes(call.op))
    expectMatrix(replay(ops), rotationFlipMatrix(t, 970, 560))
    const draw = ctx.calls.find((call) => call.op === 'drawImage')
    expect(draw).toBeTruthy()
  })

  it('drawTextClip composes R around the measured box center before position and scale', () => {
    const style: TextStyle = {
      x: 0.2,
      y: 0.5,
      fontSize: 40,
      color: '#fff',
      fontFamily: 'Arial',
      bold: false,
      italic: false,
      align: 'left',
      shadow: false,
    }
    const clip = createClip({ id: 'c', text: 'Hi', style })
    const ctx = createFakeCtx()
    const t = transform({ posX: 30, posY: -10, scale: 2, rotation: 45, flipY: true })
    drawTextClip(ctx as unknown as CanvasRenderingContext2D, clip, 1920, 1080, 1, 'none', t)
    const box = textLayoutBox(clip, 1920, 1080, (line) => line.length * 7)!
    // Left-aligned text: the measured box center sits right of the anchor.
    expect(box.centerX).toBeGreaterThan(style.x * 1920)
    const c = positionedCenter({ x: box.centerX, y: box.centerY }, t, FC)
    const expected = multiplyMatrix(
      rotationFlipMatrix(t, c.x, c.y),
      multiplyMatrix(
        multiplyMatrix(
          translationMatrix(FC.x + t.posX, FC.y + t.posY),
          scaleMatrix(t.scale, t.scale),
        ),
        translationMatrix(-FC.x, -FC.y),
      ),
    )
    const ops = ctx.calls.filter((call) => ['translate', 'rotate', 'scale'].includes(call.op))
    expectMatrix(replay(ops), expected)
  })

  it('leaves unrotated, unflipped text at its old matrix', () => {
    const style: TextStyle = {
      x: 0.5,
      y: 0.5,
      fontSize: 40,
      color: '#fff',
      fontFamily: 'Arial',
      bold: false,
      italic: false,
      align: 'center',
      shadow: false,
    }
    const clip = createClip({ id: 'c', text: 'Hi', style })
    const ctx = createFakeCtx()
    const t = transform({ posX: 12, posY: 8, scale: 2 })
    drawTextClip(ctx as unknown as CanvasRenderingContext2D, clip, 1920, 1080, 1, 'none', t)
    const expected = multiplyMatrix(
      multiplyMatrix(translationMatrix(FC.x + 12, FC.y + 8), scaleMatrix(2, 2)),
      translationMatrix(-FC.x, -FC.y),
    )
    const ops = ctx.calls.filter((call) => ['translate', 'rotate', 'scale'].includes(call.op))
    expectMatrix(replay(ops), expected)
    expect(ctx.calls.some((call) => call.op === 'rotate')).toBe(false)
  })

  it('applyRotationFlip is the identity for neutral rotation and flips', () => {
    const ctx = createFakeCtx()
    applyRotationFlip(ctx as unknown as CanvasRenderingContext2D, IDENTITY_TRANSFORM, 100, 100)
    expect(ctx.calls).toEqual([])
  })
})

describe('preview and export parity', () => {
  function transformedDoc(rotation = 90, flipX = true) {
    const asset = createMediaAsset({
      id: 'media_p',
      kind: 'video',
      name: 'p.mp4',
      duration: 10,
      width: 640,
      height: 360,
      url: 'blob:p',
    })
    const clip = createClip({
      id: 'clip_p',
      mediaId: asset.id,
      start: 0,
      duration: 4,
      rotation,
      flipX,
      flipY: true,
      animStatics: { scale: 1.5, positionX: 40 },
    })
    const doc = createDoc()
    doc.media = [asset]
    doc.project.tracks[0].clips = [clip]
    doc.project.tracks.push(createTrack('audio', 1))
    return { doc, clip }
  }

  it('the export plan carries the same transform the preview draws', () => {
    const { doc, clip } = transformedDoc()
    const plan = planVideoFrame(doc, 1, doc.project.tracks)
    expect(plan.draws[0].transform).toEqual(clipTransform(clip, 1))
    expect(plan.draws[0].transform).toMatchObject({
      rotation: 90,
      flipX: true,
      flipY: true,
      scale: 1.5,
      posX: 40,
    })
  })

  it('a custom output size rotates around that frame center', () => {
    const { clip } = transformedDoc()
    const t = clipTransform(clip, 1)!
    vi.stubGlobal('HTMLVideoElement', class {})
    vi.stubGlobal('HTMLImageElement', class {})
    vi.stubGlobal('HTMLCanvasElement', class {})
    const ctx = createFakeCtx()
    drawContain(
      ctx as unknown as CanvasRenderingContext2D,
      { width: 640, height: 360 } as unknown as CanvasImageSource,
      1280,
      720,
      1,
      'none',
      t,
    )
    const ops = ctx.calls.filter((call) => ['translate', 'rotate', 'scale'].includes(call.op))
    expectMatrix(replay(ops), rotationFlipMatrix(t, 640 + t.posX, 360 + t.posY))
    vi.unstubAllGlobals()
  })
})

describe('static lock: one transform helper', () => {
  it('every compositor draw path routes rotation through applyRotationFlip', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/lib/editor/playback/compositor.ts'),
      'utf8',
    )
    const uses = source.match(/applyRotationFlip\(/g) ?? []
    // blitTransformed, drawContain, drawBlendedContain, drawTextClip.
    expect(uses.length).toBeGreaterThanOrEqual(4)
  })

  it('the exporter adds no second rotation formula', () => {
    const source = readFileSync(join(process.cwd(), 'src/lib/editor/export/mp4.ts'), 'utf8')
    expect(source).not.toContain('ctx.rotate(')
    expect(source).toContain('blitTransformed(')
    expect(source).toContain('drawContain(')
    expect(source).toContain('drawTextClip(')
  })
})

describe('effect-path pivot (motionPivot)', () => {
  const style: TextStyle = {
    x: 0.2,
    y: 0.5,
    fontSize: 40,
    color: '#fff',
    fontFamily: 'Arial',
    bold: false,
    italic: false,
    align: 'left',
    shadow: false,
  }
  const measure = (line: string) => line.length * 7

  it('returns the positioned text-box center for rotated or flipped text', () => {
    const clip = createClip({ id: 'c', text: 'Hi', style })
    const ctx = createFakeCtx()
    const t = transform({ posX: 30, posY: -10, scale: 2, rotation: 45, flipY: true })
    const pivot = motionPivot(ctx as unknown as CanvasRenderingContext2D, clip, t, 1920, 1080)
    const box = textLayoutBox(clip, 1920, 1080, measure)!
    const expected = positionedCenter({ x: box.centerX, y: box.centerY }, t, FC)
    expect(pivot.x).toBeCloseTo(expected.x, 6)
    expect(pivot.y).toBeCloseTo(expected.y, 6)
  })

  it('returns the positioned frame center for media and neutral text', () => {
    const ctx = createFakeCtx()
    const media = createClip({ id: 'm' })
    const rotated = transform({ posX: 10, rotation: 90 })
    expect(
      motionPivot(ctx as unknown as CanvasRenderingContext2D, media, rotated, 1920, 1080),
    ).toEqual({
      x: 960 + 10,
      y: 540,
    })
    const text = createClip({ id: 'c', text: 'Hi', style })
    const neutral = transform({ posX: 12, scale: 2 })
    expect(
      motionPivot(ctx as unknown as CanvasRenderingContext2D, text, neutral, 1920, 1080),
    ).toEqual({
      x: 960 + 12,
      y: 540,
    })
  })

  it('measures with the clip font, not the ambient context font', () => {
    const clip = createClip({ id: 'c', text: 'Hi', style })
    // Scratch and export contexts carry whatever font was left behind; metrics
    // follow the live font, so a stale 10px font would shrink the box.
    let font = '10px sans-serif'
    const ctx = {
      measureText: (text: string) => ({ width: text.length * (font.includes('40px') ? 7 : 3) }),
      get font() {
        return font
      },
      set font(v: string) {
        font = v
      },
    } as unknown as CanvasRenderingContext2D
    const t = transform({ rotation: 45 })
    const pivot = motionPivot(ctx, clip, t, 1920, 1080)
    // 40px metrics: 'Hi' is 14px wide, left-anchored at 384.
    const box = textLayoutBox(clip, 1920, 1080, (line) => line.length * 7)!
    const expected = positionedCenter({ x: box.centerX, y: box.centerY }, t, FC)
    expect(pivot.x).toBeCloseTo(expected.x, 6)
    expect(pivot.y).toBeCloseTo(expected.y, 6)
    // The ambient font is restored for the context's next user.
    expect(font).toBe('10px sans-serif')
  })

  it('blitTransformed pivots rotation on the given origin', () => {
    const ctx = createFakeCtx()
    const t = transform({ posX: 30, scale: 2, rotation: 90 })
    const origin = { x: 100, y: 200 }
    blitTransformed(
      ctx as unknown as CanvasRenderingContext2D,
      { width: 640, height: 360 } as unknown as CanvasImageSource,
      1920,
      1080,
      t,
      origin,
    )
    // The recorded ops are the rotation/flip factor (left) then the
    // position-and-scale factor (right); the -center tail lives in the
    // drawImage args, not in a canvas op.
    const expected = multiplyMatrix(
      rotationFlipMatrix(t, origin.x, origin.y),
      multiplyMatrix(translationMatrix(960 + 30, 540), scaleMatrix(2, 2)),
    )
    const ops = ctx.calls.filter((call) => ['translate', 'rotate', 'scale'].includes(call.op))
    expectMatrix(replay(ops), expected)
  })
})

function createFakeCtx() {
  const calls: { op: string; args: unknown[] }[] = []
  const ctx: Record<string, unknown> = {
    calls,
    save: () => calls.push({ op: 'save', args: [] }),
    restore: () => calls.push({ op: 'restore', args: [] }),
    translate: (x: number, y: number) => calls.push({ op: 'translate', args: [x, y] }),
    rotate: (r: number) => calls.push({ op: 'rotate', args: [r] }),
    scale: (x: number, y: number) => calls.push({ op: 'scale', args: [x, y] }),
    drawImage: () => calls.push({ op: 'drawImage', args: [] }),
    fillText: () => calls.push({ op: 'fillText', args: [] }),
    measureText: (text: string) => ({ width: text.length * 7 }),
    set globalAlpha(_v: number) {},
    set filter(_v: string) {},
    set font(_v: string) {},
    set textAlign(_v: string) {},
    set textBaseline(_v: string) {},
    set fillStyle(_v: string) {},
  }
  return ctx as unknown as CanvasRenderingContext2D & { calls: { op: string; args: unknown[] }[] }
}
