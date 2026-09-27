/**
 * Tests for the timeline's edge scroll geometry.
 *
 * `autoScrollStep` (vertical) is the whole reason a clip can reach a lane that
 * is not currently on screen, and `autoScrollStepX` (horizontal) is what lets
 * the marquee reach time outside the viewport. Both are pure, so the ramp is
 * pinned here instead of being re-discovered by hand in the browser.
 */
import { describe, expect, it } from 'vitest'
import { AUTOSCROLL_EDGE_PX, autoScrollStep, autoScrollStepX } from '../timeline-scroll'

const band = { top: 400, bottom: 550 }

describe('autoScrollStep', () => {
  it('does nothing in the neutral middle of the band', () => {
    expect(autoScrollStep((band.top + band.bottom) / 2, band)).toBe(0)
  })

  it('does nothing exactly at the inner edge of either band', () => {
    expect(autoScrollStep(band.top + AUTOSCROLL_EDGE_PX, band)).toBe(0)
    expect(autoScrollStep(band.bottom - AUTOSCROLL_EDGE_PX, band)).toBe(0)
  })

  it('scrolls up near the top edge and down near the bottom edge', () => {
    expect(autoScrollStep(band.top + 2, band)).toBeLessThan(0)
    expect(autoScrollStep(band.bottom - 2, band)).toBeGreaterThan(0)
  })

  it('ramps with depth and clamps at maxStep', () => {
    const creep = Math.abs(autoScrollStep(band.top + 22, band))
    const fast = Math.abs(autoScrollStep(band.top + 1, band))
    expect(creep).toBeLessThan(fast)
    // well past the edge (and outside the band entirely) stays clamped
    expect(autoScrollStep(band.top - 500, band)).toBe(-14)
    expect(autoScrollStep(band.bottom + 500, band)).toBe(14)
  })

  it('honours a custom edge and step for a shorter track area', () => {
    const short = { top: 400, bottom: 470 }
    expect(autoScrollStep(465, short, 40, 10)).toBe(9)
    expect(autoScrollStep(500, short, 40, 10)).toBe(10)
  })

  it('is inert for a degenerate edge', () => {
    expect(autoScrollStep(band.top, band, 0)).toBe(0)
  })
})

describe('autoScrollStepX (marquee edge scrolling)', () => {
  const hband = { left: 300, right: 700 }

  it('does nothing in the neutral middle or exactly at the inner edges', () => {
    expect(autoScrollStepX(500, hband)).toBe(0)
    expect(autoScrollStepX(hband.left + AUTOSCROLL_EDGE_PX, hband)).toBe(0)
    expect(autoScrollStepX(hband.right - AUTOSCROLL_EDGE_PX, hband)).toBe(0)
  })

  it('scrolls left near the left edge and right near the right edge', () => {
    expect(autoScrollStepX(hband.left + 2, hband)).toBeLessThan(0)
    expect(autoScrollStepX(hband.right - 2, hband)).toBeGreaterThan(0)
  })

  it('ramps with depth and clamps at maxStep', () => {
    const creep = Math.abs(autoScrollStepX(hband.left + 22, hband))
    const fast = Math.abs(autoScrollStepX(hband.left + 1, hband))
    expect(creep).toBeLessThan(fast)
    expect(autoScrollStepX(hband.left - 500, hband)).toBe(-14)
    expect(autoScrollStepX(hband.right + 500, hband)).toBe(14)
  })

  it('honours a custom edge and is inert for a degenerate one', () => {
    // depth 5 of a 10px edge, maxStep 6 → round(6 * 5 / 10) = 3
    expect(autoScrollStepX(695, hband, 10, 6)).toBe(3)
    expect(autoScrollStepX(hband.left, hband, 0)).toBe(0)
  })
})
