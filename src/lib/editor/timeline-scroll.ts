/**
 * Timeline edge auto-scroll geometry.
 *
 * The track rows live in a short scroll area, and the timeline both scrolls
 * vertically (more rows than fit) and horizontally (more time than fits), so a
 * drag can hold a pointer near any edge of the visible area. `autoScrollStep`
 * (vertical) and `autoScrollStepX` (horizontal) are how far to scroll per
 * animation frame at a pointer position, which is what lets a clip reach a row
 * that is not on screen and lets the marquee reach time outside the viewport.
 * They are pure so the ramp can be tested without a browser.
 *
 * Bands are viewport coordinates (`getBoundingClientRect`), so the step applies
 * directly to `scrollTop` / `scrollLeft`.
 */

/** Distance from an edge at which a drag starts auto-scrolling. */
export const AUTOSCROLL_EDGE_PX = 24
/** Largest scroll applied per animation frame while the pointer holds an edge. */
export const AUTOSCROLL_MAX_STEP_PX = 14

export interface BandRect {
  top: number
  bottom: number
}

export interface HorizontalBandRect {
  left: number
  right: number
}

/** The 1px-to-`maxStep` ramp both axes share. */
function ramp(depth: number, edge: number, maxStep: number): number {
  return Math.min(maxStep, Math.max(1, Math.round((maxStep * depth) / edge)))
}

/**
 * One-dimensional edge step: negative toward the start of the band, positive
 * toward its end, 0 in the neutral middle or for a degenerate edge.
 */
function edgeStep(
  pointer: number,
  start: number,
  end: number,
  edge: number,
  maxStep: number,
): number {
  if (edge <= 0) return 0
  const intoStart = start + edge - pointer
  if (intoStart > 0) return -ramp(intoStart, edge, maxStep)
  const intoEnd = pointer - (end - edge)
  if (intoEnd > 0) return ramp(intoEnd, edge, maxStep)
  return 0
}

/**
 * Scroll distance for one frame of drag auto-scroll at `pointerY`, or 0 when the
 * pointer is not in an edge band. Negative scrolls up. The step ramps from 1px
 * at the inner edge of the band to `maxStep` at (and beyond) the outer edge, so
 * holding the pointer just inside the band creeps and holding it past the edge
 * runs at full speed.
 */
export function autoScrollStep(
  pointerY: number,
  band: BandRect,
  edge = AUTOSCROLL_EDGE_PX,
  maxStep = AUTOSCROLL_MAX_STEP_PX,
): number {
  return edgeStep(pointerY, band.top, band.bottom, edge, maxStep)
}

/**
 * Horizontal twin: scroll distance for one frame at `pointerX`, negative toward
 * the left edge of the band. The caller passes the visible LANE region (its left
 * edge starts after the sticky header column, which must not trigger a scroll).
 */
export function autoScrollStepX(
  pointerX: number,
  band: HorizontalBandRect,
  edge = AUTOSCROLL_EDGE_PX,
  maxStep = AUTOSCROLL_MAX_STEP_PX,
): number {
  return edgeStep(pointerX, band.left, band.right, edge, maxStep)
}
