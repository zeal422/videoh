import { describe, expect, it } from 'vitest'
import { getTransitionSpan, maxTransitionDuration, transitionAlphas } from '../transition'
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

describe('maxTransitionDuration', () => {
  it('is bounded by both durations and the available headroom to A.end', () => {
    const a = createClip({ start: 0, duration: 4 })
    const b = createClip({ start: 4, duration: 2 })
    expect(maxTransitionDuration(a, b, 4)).toBe(2)
    expect(maxTransitionDuration(a, b, 1)).toBe(1)
  })
})
