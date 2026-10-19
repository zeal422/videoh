/**
 * Anti-regression tests for the chroma keyer (chroma-key.ts): color parsing,
 * chroma distance, the similarity/blend ramp with its hard-step fallback, the
 * clip-black/clip-white remap with its equal-threshold step, despill, and the
 * in-place pixel pass. Pure, no harness.
 */
import { describe, expect, it } from 'vitest'

import {
  applyChromaKeyToRgba,
  applyClipRange,
  buildMatteMask,
  chromaDistance,
  keyAlpha,
  maskValue,
  parseKeyColor,
  rgbToCbCr,
  rgbToY,
} from '../chroma-key'
import { CHROMA_PLANE_MAX } from '../constants'

describe('parseKeyColor', () => {
  it('parses 6-digit hex and short hex', () => {
    expect(parseKeyColor('#00ff00')).toEqual([0, 255, 0])
    expect(parseKeyColor('#0f0')).toEqual([0, 255, 0])
    expect(parseKeyColor('#FF0000')).toEqual([255, 0, 0])
  })

  it('refuses malformed colors', () => {
    expect(parseKeyColor('green')).toBeUndefined()
    expect(parseKeyColor('#gggggg')).toBeUndefined()
    expect(parseKeyColor('#12345')).toBeUndefined()
    expect(parseKeyColor('')).toBeUndefined()
  })
})

describe('chroma math', () => {
  it('defines the plane maximum as 255*sqrt(2)', () => {
    expect(CHROMA_PLANE_MAX).toBeCloseTo(255 * Math.sqrt(2), 10)
  })

  it('measures zero distance for identical colors', () => {
    expect(chromaDistance(0, 255, 0, 0, 255, 0)).toBe(0)
    expect(rgbToY(255, 255, 255)).toBeCloseTo(255, 10)
    expect(rgbToCbCr(0, 0, 0)).toEqual([128, 128])
  })

  it('normalizes far colors toward 1 without exceeding it', () => {
    const d = chromaDistance(255, 0, 0, 0, 255, 0)
    expect(d).toBeGreaterThan(0.5)
    expect(d).toBeLessThanOrEqual(1)
  })
})

describe('keyAlpha', () => {
  it('ramps from transparent to opaque across similarity..similarity+blend', () => {
    expect(keyAlpha(0.1, 0.2, 0.4)).toBe(0)
    expect(keyAlpha(0.6, 0.2, 0.4)).toBe(1)
    const mid = keyAlpha(0.3, 0.2, 0.4)
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(1)
  })

  it('collapses to a hard step on degenerate intervals', () => {
    // Blend zero: a1 === a0.
    expect(keyAlpha(0.2, 0.2, 0)).toBe(0)
    expect(keyAlpha(0.2001, 0.2, 0)).toBe(1)
    // Similarity one: a0 === a1 === 1.
    expect(keyAlpha(1, 1, 0.5)).toBe(0)
    expect(keyAlpha(1.0001, 1, 0.5)).toBe(1)
  })
})

describe('applyClipRange', () => {
  it('remaps linearly inside the range and clamps outside', () => {
    expect(applyClipRange(0.5, 0, 1)).toBe(0.5)
    expect(applyClipRange(0.25, 0.25, 0.75)).toBe(0)
    expect(applyClipRange(0.75, 0.25, 0.75)).toBe(1)
    expect(applyClipRange(0.5, 0.25, 0.75)).toBe(0.5)
  })

  it('treats equal thresholds as a hard step', () => {
    expect(applyClipRange(0.6, 0.5, 0.5)).toBe(1)
    expect(applyClipRange(0.4, 0.5, 0.5)).toBe(0)
    expect(applyClipRange(0.5, 0.5, 0.5)).toBe(0)
  })
})

describe('applyChromaKeyToRgba', () => {
  const params = {
    key: [0, 255, 0] as [number, number, number],
    similarity: 0.1,
    blend: 0.3,
    clipBlack: 0,
    clipWhite: 1,
    despill: 0.5,
  }

  it('clears key-colored pixels and keeps distant ones', () => {
    // Two pixels: pure green, pure red.
    const data = new Uint8ClampedArray([0, 255, 0, 255, 255, 0, 0, 255])
    applyChromaKeyToRgba(data, params)
    expect(data[3]).toBe(0)
    expect(data[7]).toBe(255)
  })

  it('round-trips neutrally when nothing is near the key', () => {
    const data = new Uint8ClampedArray([10, 20, 200, 255])
    applyChromaKeyToRgba(data, { ...params, key: [0, 255, 0] })
    expect(Array.from(data)).toEqual([10, 20, 200, 255])
  })

  it('despills green spill on edge pixels', () => {
    // A greenish edge pixel inside the ramp (partial alpha): green falls.
    const data = new Uint8ClampedArray([100, 200, 100, 255])
    applyChromaKeyToRgba(data, { ...params, similarity: 0.2, blend: 0.2 })
    expect(data[3]).toBeGreaterThan(0)
    expect(data[3]).toBeLessThan(255)
    expect(data[1]).toBeLessThan(200)
  })
})

describe('maskValue', () => {
  it('reads luma or alpha with optional reversal', () => {
    expect(maskValue(255, 255, 255, 0, 'luma', false)).toBe(255)
    expect(maskValue(255, 255, 255, 0, 'luma', true)).toBe(0)
    expect(maskValue(0, 0, 0, 128, 'alpha', false)).toBe(128)
    expect(maskValue(0, 0, 0, 128, 'alpha', true)).toBe(127)
  })
})

describe('buildMatteMask', () => {
  it('keys on the SOURCE pixels, not its own white (read before write)', () => {
    // White glyph, black surround, one transparent pixel: the luma mask
    // keeps the glyph, drops the surround, and leaves transparency alone.
    // A write-then-read loop would return full white for all three.
    const data = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 0, 0, 0, 0])
    buildMatteMask(data, 'luma', false)
    expect(Array.from(data)).toEqual([255, 255, 255, 255, 255, 255, 255, 0, 255, 255, 255, 0])
  })

  it('honors alpha mode and reversal', () => {
    const data = new Uint8ClampedArray([10, 20, 30, 100])
    buildMatteMask(data, 'alpha', false)
    expect(Array.from(data)).toEqual([255, 255, 255, 100])
    const data2 = new Uint8ClampedArray([10, 20, 30, 100])
    buildMatteMask(data2, 'alpha', true)
    expect(Array.from(data2)).toEqual([255, 255, 255, 155])
  })
})
