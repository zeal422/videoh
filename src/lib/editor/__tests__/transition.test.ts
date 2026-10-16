import { describe, expect, it } from 'vitest'
import {
  featherGradient,
  getTransitionSpan,
  maxTransitionDuration,
  transitionAlphas,
  transitionGeometry,
} from '../transition'
import { createClip } from '../factories'

describe('getTransitionSpan', () => {
  it('returns null without transitionOut', () => {
    const a = createClip({ id: 'a', start: 0, duration: 4 })
    const b = createClip({ id: 'b', start: 4, duration: 4 })
    expect(getTransitionSpan(a, b)).toBeNull()
  })

  it('returns null without overlap (clips moved apart)', () => {
    const a = createClip({
      id: 'a',
      start: 0,
      duration: 4,
      transitionOut: { type: 'crossfade', duration: 1 },
    })
    const b = createClip({ id: 'b', start: 5, duration: 4 })
    expect(getTransitionSpan(a, b)).toBeNull()
  })

  it('computes the clamped span inside the overlap', () => {
    const a = createClip({
      id: 'a',
      start: 0,
      duration: 4,
      transitionOut: { type: 'crossfade', duration: 1 },
    })
    const b = createClip({ id: 'b', start: 3, duration: 4 })
    const span = getTransitionSpan(a, b)
    expect(span).toEqual({ a, b, start: 3, end: 4, duration: 1 })
  })

  it('clamps the effective duration when the overlap is smaller than requested', () => {
    const a = createClip({
      id: 'a',
      start: 0,
      duration: 4,
      transitionOut: { type: 'crossfade', duration: 2 },
    })
    const b = createClip({ id: 'b', start: 3.5, duration: 4 })
    const span = getTransitionSpan(a, b)
    expect(span?.duration).toBe(0.5)
    expect(span?.end).toBe(4)
  })
})

describe('transitionAlphas', () => {
  const a = createClip({
    id: 'a',
    start: 0,
    duration: 4,
    transitionOut: { type: 'crossfade', duration: 1 },
  })
  const b = createClip({ id: 'b', start: 3, duration: 4 })
  const span = getTransitionSpan(a, b)!

  it('is fully opaque outside the span', () => {
    expect(transitionAlphas(span, 2)).toEqual({ aAlpha: 1, bAlpha: 0 })
    expect(transitionAlphas(span, 4.5)).toEqual({ aAlpha: 0, bAlpha: 1 })
  })

  it('crosses linearly through the span', () => {
    expect(transitionAlphas(span, 3)).toEqual({ aAlpha: 1, bAlpha: 0 })
    expect(transitionAlphas(span, 3.5)).toEqual({ aAlpha: 0.5, bAlpha: 0.5 })
    expect(transitionAlphas(span, 4)).toEqual({ aAlpha: 0, bAlpha: 1 })
  })
})

describe('transitionAlphas for dipToBlack', () => {
  const a = createClip({
    id: 'a',
    start: 0,
    duration: 4,
    transitionOut: { type: 'dipToBlack', duration: 1 },
  })
  const b = createClip({ id: 'b', start: 3, duration: 4 })
  const span = getTransitionSpan(a, b)!

  it('is fully opaque outside the span', () => {
    expect(transitionAlphas(span, 2)).toEqual({ aAlpha: 1, bAlpha: 0 })
    expect(transitionAlphas(span, 4.5)).toEqual({ aAlpha: 0, bAlpha: 1 })
  })

  it('fades the outgoing clip out over the first half', () => {
    expect(transitionAlphas(span, 3)).toEqual({ aAlpha: 1, bAlpha: 0 })
    expect(transitionAlphas(span, 3.25)).toEqual({ aAlpha: 0.5, bAlpha: 0 })
  })

  it('is exactly black at the midpoint', () => {
    expect(transitionAlphas(span, 3.5)).toEqual({ aAlpha: 0, bAlpha: 0 })
  })

  it('fades the incoming clip in over the second half', () => {
    expect(transitionAlphas(span, 3.75)).toEqual({ aAlpha: 0, bAlpha: 0.5 })
    expect(transitionAlphas(span, 4)).toEqual({ aAlpha: 0, bAlpha: 1 })
  })
})

describe('maxTransitionDuration', () => {
  it('is bounded by both durations and the available headroom to A.end', () => {
    const a = createClip({ start: 0, duration: 4 })
    const b = createClip({ start: 4, duration: 2 })
    expect(maxTransitionDuration(a, b, 4)).toBe(2)
    expect(maxTransitionDuration(a, b, 1)).toBe(1)
  })
})

describe('transitionGeometry', () => {
  const W = 100
  const H = 60
  /** Span 3..4 (duration 1) on a 100x60 frame, so p lands on round pixels. */
  function spanOf(type: 'wipe' | 'slide' | 'push' | 'crossfade' | 'dipToBlack') {
    const a = createClip({
      id: 'a',
      start: 0,
      duration: 4,
      transitionOut: { type, duration: 1 },
    })
    const b = createClip({ id: 'b', start: 3, duration: 4 })
    const span = getTransitionSpan(a, b)
    if (!span) throw new Error('span must exist')
    return span
  }

  it('returns null for the alpha-only types', () => {
    expect(transitionGeometry(spanOf('crossfade'), 3.5, W, H)).toBeNull()
    expect(transitionGeometry(spanOf('dipToBlack'), 3.5, W, H)).toBeNull()
  })

  it.each([
    ['left', { x: 0, y: 0, w: 50, h: 60 }],
    ['right', { x: 50, y: 0, w: 50, h: 60 }],
    ['up', { x: 0, y: 0, w: 100, h: 30 }],
    ['down', { x: 0, y: 30, w: 100, h: 30 }],
  ] as const)('wipe from %s reveals half the frame at p = 0.5', (direction, rect) => {
    const span = spanOf('wipe')
    span.a.transitionOut = { ...span.a.transitionOut!, direction }
    const geo = transitionGeometry(span, 3.5, W, H)
    expect(geo?.wipeRect).toEqual(rect)
    expect(geo?.aOffset).toEqual({ x: 0, y: 0 })
    expect(geo?.bOffset).toEqual({ x: 0, y: 0 })
    expect(geo?.featherPx).toBe(0)
  })

  it('wipe reveals nothing at p = 0 and the full frame at p = 1', () => {
    const span = spanOf('wipe')
    expect(transitionGeometry(span, 3, W, H)?.wipeRect).toEqual({ x: 0, y: 0, w: 0, h: 60 })
    expect(transitionGeometry(span, 4, W, H)?.wipeRect).toEqual({ x: 0, y: 0, w: 100, h: 60 })
  })

  it.each([
    ['left', { x: -50, y: 0 }],
    ['right', { x: 50, y: 0 }],
    ['up', { x: 0, y: -30 }],
    ['down', { x: 0, y: 30 }],
  ] as const)('slide from %s moves only the incoming picture', (direction, bOffset) => {
    const span = spanOf('slide')
    span.a.transitionOut = { ...span.a.transitionOut!, direction }
    const geo = transitionGeometry(span, 3.5, W, H)
    expect(geo?.aOffset).toEqual({ x: 0, y: 0 })
    expect(geo?.bOffset).toEqual(bOffset)
    expect(geo?.wipeRect).toBeNull()
  })

  it.each([
    ['left', { x: 50, y: 0 }, { x: -50, y: 0 }],
    ['right', { x: -50, y: 0 }, { x: 50, y: 0 }],
    ['up', { x: 0, y: 30 }, { x: 0, y: -30 }],
    ['down', { x: 0, y: -30 }, { x: 0, y: 30 }],
  ] as const)(
    'push from %s moves both pictures to tile the frame',
    (direction, aOffset, bOffset) => {
      const span = spanOf('push')
      span.a.transitionOut = { ...span.a.transitionOut!, direction }
      const geo = transitionGeometry(span, 3.5, W, H)
      expect(geo?.aOffset).toEqual(aOffset)
      expect(geo?.bOffset).toEqual(bOffset)
      expect(geo?.wipeRect).toBeNull()
    },
  )

  it('feather width converts the motion-axis fraction to pixels, hard wipes report 0', () => {
    const span = spanOf('wipe')
    span.a.transitionOut = {
      ...span.a.transitionOut!,
      direction: 'left',
      edge: 'feathered',
      feather: 0.2,
    }
    expect(transitionGeometry(span, 3.5, W, H)?.featherPx).toBe(20)
    span.a.transitionOut = {
      ...span.a.transitionOut!,
      direction: 'up',
      edge: 'feathered',
      feather: 0.2,
    }
    expect(transitionGeometry(span, 3.5, W, H)?.featherPx).toBe(12)
    span.a.transitionOut = {
      ...span.a.transitionOut!,
      direction: 'left',
      edge: 'hard',
      feather: 0.2,
    }
    expect(transitionGeometry(span, 3.5, W, H)?.featherPx).toBe(0)
  })

  it('feather band sits at the wipe boundary and echoes the direction', () => {
    const span = spanOf('wipe')
    span.a.transitionOut = {
      ...span.a.transitionOut!,
      direction: 'left',
      edge: 'feathered',
      feather: 0.2,
    }
    const geo = transitionGeometry(span, 3.5, W, H)
    expect(geo?.direction).toBe('left')
    // Boundary travels dim + f (120px): at p = 0.5 it sits at 60, revealed 60.
    expect(geo?.wipeRect).toEqual({ x: 0, y: 0, w: 60, h: 60 })
    expect(geo?.featherBand).toEqual({ x: 40, y: 0, w: 20, h: 60 })
    span.a.transitionOut = {
      ...span.a.transitionOut!,
      direction: 'left',
      edge: 'hard',
      feather: 0.2,
    }
    expect(transitionGeometry(span, 3.5, W, H)?.featherBand).toBeNull()
    const slide = spanOf('slide')
    expect(transitionGeometry(slide, 3.5, W, H)?.direction).toBe('left')
  })

  it('a finished feathered wipe carries no band: the incoming picture is pure', () => {
    const span = spanOf('wipe')
    span.a.transitionOut = {
      ...span.a.transitionOut!,
      direction: 'left',
      edge: 'feathered',
      feather: 0.2,
    }
    const geo = transitionGeometry(span, 4, W, H)
    expect(geo?.wipeRect).toEqual({ x: 0, y: 0, w: 100, h: 60 })
    expect(geo?.featherBand).toBeNull()
    expect(geo?.featherPx).toBe(20)
  })

  it('absent direction, edge and feather read as left, hard and 0.1 without NaN', () => {
    const span = spanOf('wipe')
    span.a.transitionOut = { type: 'wipe', duration: 1, edge: 'feathered' }
    const geo = transitionGeometry(span, 3.5, W, H)
    // Default feather 0.1 widens the travel to 110px: boundary at 55.
    expect(geo?.wipeRect).toEqual({ x: 0, y: 0, w: 55, h: 60 })
    expect(geo?.featherPx).toBe(10)
    const nums = [
      geo?.featherPx,
      geo?.wipeRect?.x,
      geo?.wipeRect?.w,
      geo?.aOffset.x,
      geo?.bOffset.x,
    ]
    for (const n of nums) expect(Number.isFinite(n)).toBe(true)
  })

  it('past span.end returns the p = 1 state, pictures at rest', () => {
    const wipe = spanOf('wipe')
    expect(transitionGeometry(wipe, 5, W, H)?.wipeRect).toEqual({ x: 0, y: 0, w: 100, h: 60 })
    const push = spanOf('push')
    push.a.transitionOut = { ...push.a.transitionOut!, direction: 'left' }
    const geo = transitionGeometry(push, 5, W, H)
    expect(geo?.aOffset).toEqual({ x: 100, y: 0 })
    expect(geo?.bOffset).toEqual({ x: 0, y: 0 })
  })
})

describe('featherGradient', () => {
  const W = 100
  const H = 60
  function featheredSpan(direction: 'left' | 'right' | 'up' | 'down') {
    const a = createClip({
      id: 'a',
      start: 0,
      duration: 4,
      transitionOut: { type: 'wipe', duration: 1, direction, edge: 'feathered', feather: 0.2 },
    })
    const b = createClip({ id: 'b', start: 3, duration: 4 })
    const span = getTransitionSpan(a, b)
    if (!span) throw new Error('span must exist')
    const geo = transitionGeometry(span, 3.5, W, H)
    if (!geo) throw new Error('geometry must exist')
    return geo
  }

  it('spans the revealed region with the fade starting at the band inner edge', () => {
    // Revealed 60px, band 20px: opaque through 40px, fading over the last 20.
    const g = featherGradient(featheredSpan('left'))
    expect(g).toEqual({
      x0: 0,
      y0: 0,
      x1: 60,
      y1: 0,
      stops: [
        { at: 0, opacity: 1 },
        { at: 2 / 3, opacity: 1 },
        { at: 1, opacity: 0 },
      ],
    })
    const r = featherGradient(featheredSpan('right'))
    expect(r?.x0).toBe(100)
    expect(r?.x1).toBe(40)
    expect(r?.stops).toEqual([
      { at: 0, opacity: 1 },
      { at: 2 / 3, opacity: 1 },
      { at: 1, opacity: 0 },
    ])
    const u = featherGradient(featheredSpan('up'))
    expect(u?.x1).toBe(0)
    expect(u?.y1).toBe(36)
    expect(u?.stops).toEqual([
      { at: 0, opacity: 1 },
      { at: 2 / 3, opacity: 1 },
      { at: 1, opacity: 0 },
    ])
  })

  it('accounts clipped band endpoints: partial opacity at the frame edge', () => {
    // Early wipe at p = 1/8 on a 100px frame (travel 120px): boundary at 15,
    // band [-5, 15], so the visible band starts off-frame and the frame
    // edge sits inside the fade at 15/20 opacity.
    const a = createClip({
      id: 'a',
      start: 0,
      duration: 4,
      transitionOut: {
        type: 'wipe',
        duration: 1,
        direction: 'left',
        edge: 'feathered',
        feather: 0.2,
      },
    })
    const b = createClip({ id: 'b', start: 3, duration: 4 })
    const span = getTransitionSpan(a, b)
    if (!span) throw new Error('span must exist')
    const geo = transitionGeometry(span, 3.125, W, H)
    const g = featherGradient(geo!)
    expect(geo?.wipeRect).toEqual({ x: 0, y: 0, w: 15, h: 60 })
    expect(g?.stops).toEqual([
      { at: 0, opacity: 0.75 },
      { at: 1, opacity: 0 },
    ])
  })

  it('returns null without a feather band', () => {
    const a = createClip({
      id: 'a',
      start: 0,
      duration: 4,
      transitionOut: { type: 'wipe', duration: 1 },
    })
    const b = createClip({ id: 'b', start: 3, duration: 4 })
    const span = getTransitionSpan(a, b)
    if (!span) throw new Error('span must exist')
    expect(featherGradient(transitionGeometry(span, 3.5, W, H)!)).toBeNull()
  })
})

describe('featherGradient late wipe', () => {
  it('holds partial opacity at the frame edge when the boundary has passed it', () => {
    // 100px frame, feather 0.25 (f = 25, travel 125), p = 7/8: boundary at
    // 109.375, band [84.375, 109.375], revealed clamped to the full 100px.
    // The frame edge sits 9.375px inside the band: 0.375, not 0.
    const a = createClip({
      id: 'a',
      start: 0,
      duration: 4,
      transitionOut: {
        type: 'wipe',
        duration: 1,
        direction: 'left',
        edge: 'feathered',
        feather: 0.25,
      },
    })
    const b = createClip({ id: 'b', start: 3, duration: 4 })
    const span = getTransitionSpan(a, b)
    if (!span) throw new Error('span must exist')
    const geo = transitionGeometry(span, 3.875, 100, 60)
    expect(geo?.wipeRect).toEqual({ x: 0, y: 0, w: 100, h: 60 })
    expect(geo?.featherBand).toEqual({ x: 84.375, y: 0, w: 25, h: 60 })
    expect(featherGradient(geo!)).toEqual({
      x0: 0,
      y0: 0,
      x1: 100,
      y1: 0,
      stops: [
        { at: 0, opacity: 1 },
        { at: 0.84375, opacity: 1 },
        { at: 1, opacity: 0.375 },
      ],
    })
  })
})

describe('featherGradient early negative-direction wipes', () => {
  function earlySpan(direction: 'right' | 'down') {
    const a = createClip({
      id: 'a',
      start: 0,
      duration: 4,
      transitionOut: { type: 'wipe', duration: 1, direction, edge: 'feathered', feather: 0.2 },
    })
    const b = createClip({ id: 'b', start: 3, duration: 4 })
    const span = getTransitionSpan(a, b)
    if (!span) throw new Error('span must exist')
    // p = 1/8: the band starts off-frame past the inner edge.
    return transitionGeometry(span, 3.125, 100, 60)!
  }

  it('early right wipe fades from the partial edge opacity, no solid start stop', () => {
    const geo = earlySpan('right')
    expect(geo.wipeRect).toEqual({ x: 85, y: 0, w: 15, h: 60 })
    expect(featherGradient(geo)).toEqual({
      x0: 100,
      y0: 0,
      x1: 85,
      y1: 0,
      stops: [
        { at: 0, opacity: 0.75 },
        { at: 1, opacity: 0 },
      ],
    })
  })

  it('early down wipe fades from the partial edge opacity, no solid start stop', () => {
    const geo = earlySpan('down')
    expect(geo.wipeRect).toEqual({ x: 0, y: 51, w: 100, h: 9 })
    expect(featherGradient(geo)).toEqual({
      x0: 0,
      y0: 60,
      x1: 0,
      y1: 51,
      stops: [
        { at: 0, opacity: 0.75 },
        { at: 1, opacity: 0 },
      ],
    })
  })
})
