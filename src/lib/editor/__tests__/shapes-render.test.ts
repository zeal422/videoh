// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { drawFrame, drawShapeClip } from '../playback/compositor'
import { compositeFrame } from '../export/mp4'
import { planVideoFrame } from '../export/offline'
import { createDoc, createShapeClip, createTrack } from '../factories'
import { createShapeStyle } from '../shapes'
import type { ClipTransform } from '../transform'
import { createFake2DContext, installBrowserMocks, type MockHarness } from './mocks/browser-mocks'
import type { Doc, ShapeKind } from '../types'

let h: MockHarness

beforeEach(() => {
  h = installBrowserMocks()
})

afterEach(() => {
  h.uninstall()
})

type Call = { op: string; args: unknown[] }
const calls = (ctx: CanvasRenderingContext2D): Call[] => (ctx as unknown as { calls: Call[] }).calls
const ops = (ctx: CanvasRenderingContext2D, op: string): Call[] =>
  calls(ctx).filter((call) => call.op === op)

function shapeDoc(kind: ShapeKind = 'star'): Doc {
  const doc = createDoc()
  const video = doc.project.tracks.find((track) => track.kind === 'video')!
  video.clips.push(
    createShapeClip({
      id: 'clip_shape',
      start: 0,
      duration: 4,
      shape: createShapeStyle(kind),
    }),
  )
  return doc
}

describe('shape renderer (0.25.0)', () => {
  it('draws a centered rectangle and a real ellipse path', () => {
    const rect = createFake2DContext()
    drawShapeClip(
      rect,
      createShapeClip({ shape: createShapeStyle('rectangle') }),
      1920,
      1080,
      1,
      'none',
      null,
    )
    expect(ops(rect, 'rect')[0].args).toEqual([192, 108, 1536, 864])
    expect(ops(rect, 'fill')).toHaveLength(1)

    const ellipse = createFake2DContext()
    drawShapeClip(
      ellipse,
      createShapeClip({ shape: createShapeStyle('ellipse') }),
      1920,
      1080,
      1,
      'none',
      null,
    )
    expect(ops(ellipse, 'ellipse')[0].args).toEqual([960, 540, 768, 432, 0, 0, Math.PI * 2])
    expect(ops(ellipse, 'fill')).toHaveLength(1)
  })

  it('draws a star polygon and an optional stroke', () => {
    const ctx = createFake2DContext()
    drawShapeClip(
      ctx,
      createShapeClip({
        shape: {
          ...createShapeStyle('star'),
          fill: '#ff0000',
          stroke: '#000000',
          strokeWidth: 8,
        },
      }),
      1920,
      1080,
      1,
      'none',
      null,
    )
    // Five outer + five inner points: one moveTo and nine lineTo calls.
    expect(ops(ctx, 'moveTo')).toHaveLength(1)
    expect(ops(ctx, 'lineTo')).toHaveLength(9)
    expect(ops(ctx, 'closePath')).toHaveLength(1)
    expect(ops(ctx, 'set:fillStyle')[0].args).toEqual(['#ff0000'])
    expect(ops(ctx, 'set:strokeStyle')[0].args).toEqual(['#000000'])
    expect(ops(ctx, 'set:lineWidth')[0].args).toEqual([8])
    expect(ops(ctx, 'fill')).toHaveLength(1)
    expect(ops(ctx, 'stroke')).toHaveLength(1)
  })

  it('applies position, scale, rotation, and flip around the positioned frame center', () => {
    const ctx = createFake2DContext()
    const transform: ClipTransform = {
      posX: 100,
      posY: 50,
      scale: 2,
      rotation: 90,
      flipX: true,
      flipY: false,
    }
    drawShapeClip(
      ctx,
      createShapeClip({ shape: createShapeStyle('heart') }),
      1920,
      1080,
      1,
      'none',
      transform,
    )
    expect(ops(ctx, 'set:globalAlpha')[0].args).toEqual([1])
    // Rotation/flip first around the positioned center, then the Motion factor.
    const translates = ops(ctx, 'translate').map((call) => call.args)
    expect(translates[0]).toEqual([1060, 590])
    expect(translates[1]).toEqual([-1060, -590])
    expect(translates[2]).toEqual([1060, 590])
    expect(translates[3]).toEqual([-960, -540])
    expect(ops(ctx, 'rotate')).toHaveLength(1)
    // The flip pair is a signed scale; Motion's uniform scale follows it.
    expect(ops(ctx, 'scale')[0].args).toEqual([-1, 1])
    expect(ops(ctx, 'scale')[1].args).toEqual([2, 2])
  })

  it('composites a translucent shape once instead of double-applying alpha', () => {
    const ctx = createFake2DContext()
    drawShapeClip(
      ctx,
      createShapeClip({
        shape: {
          ...createShapeStyle('star'),
          stroke: '#000000',
          strokeWidth: 8,
        },
      }),
      1920,
      1080,
      0.5,
      'none',
      null,
    )
    // Group composite: fill and stroke paint onto the scratch (never the
    // frame), and the frame sees a single blit at the requested alpha. The
    // stroke's inner half overlaps the fill, so two frame-level ops at 0.5
    // would leave that band more opaque than the clip.
    expect(ops(ctx, 'fill')).toEqual([])
    expect(ops(ctx, 'stroke')).toEqual([])
    expect(ops(ctx, 'set:globalAlpha')).toHaveLength(1)
    expect(ops(ctx, 'set:globalAlpha')[0].args).toEqual([0.5])
    expect(ops(ctx, 'drawImage')).toHaveLength(1)
  })

  it('renders the same shape through the preview frame and the export composite', () => {
    const doc = shapeDoc('star')
    const preview = createFake2DContext()
    drawFrame({ ctx: preview, doc, time: 0, resolve: () => undefined })
    const plan = planVideoFrame(doc, 0)
    expect(plan.draws).toHaveLength(1)
    expect(plan.draws[0].clip.shape?.kind).toBe('star')
    expect(plan.draws[0].asset).toBeUndefined()
    const exporter = createFake2DContext()
    compositeFrame(exporter, doc, plan, new Map(), 1920, 1080, new Map())

    const shapeOps = ['beginPath', 'moveTo', 'lineTo', 'closePath', 'fill']
    const selected = (ctx: CanvasRenderingContext2D) =>
      calls(ctx).filter((call) => shapeOps.includes(call.op))
    expect(selected(preview).length).toBeGreaterThan(0)
    expect(selected(exporter)).toEqual(selected(preview))
    // A shape has no decoded frame: an opaque shape paints directly, so
    // neither path may request a drawImage for it. (A translucent shape
    // composites once from a scratch surface; that blit is covered above.)
    expect(ops(preview, 'drawImage')).toEqual([])
    expect(ops(exporter, 'drawImage')).toEqual([])
  })

  it('excludes a shape on a hidden track from the export plan', () => {
    const doc = shapeDoc()
    doc.project.tracks.find((track) => track.kind === 'video')!.visible = false
    expect(planVideoFrame(doc, 0).draws).toEqual([])
  })

  it('keeps a shape out of the audio lane in the plan', () => {
    const doc = createDoc()
    const audio = doc.project.tracks.find((track) => track.kind === 'audio')!
    audio.clips.push(
      createShapeClip({
        id: 'clip_shape',
        start: 0,
        duration: 2,
        shape: createShapeStyle('heart'),
      }),
    )
    expect(planVideoFrame(doc, 0).draws).toEqual([])
  })

  it('does not draw a shape clip with no shape payload', () => {
    const ctx = createFake2DContext()
    const clip = createShapeClip({ shape: undefined })
    drawShapeClip(ctx, clip, 1920, 1080, 1, 'none', null)
    expect(ops(ctx, 'fill')).toEqual([])
  })
})
