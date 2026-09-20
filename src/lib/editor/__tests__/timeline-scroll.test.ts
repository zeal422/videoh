/**
 * Tests for the timeline's vertical scroll geometry.
 *
 * `autoScrollStep` is the whole reason a clip can reach a lane that is not
 * currently on screen — it drives the drag-time edge scrolling. It is pure, so
 * the ramp is pinned here instead of being re-discovered by hand in the browser.
 */
import { describe, expect, it } from 'vitest'
import { AUTOSCROLL_EDGE_PX, autoScrollStep } from '../timeline-scroll'

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
