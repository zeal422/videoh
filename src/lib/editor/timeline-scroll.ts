/**
 * Vertical scrolling geometry for the timeline's track area.
 *
 * The track rows live in a short scroll area — at a typical window height only
 * two rows fit — so lanes routinely sit outside its visible band. `autoScrollStep`
 * is how far to scroll per animation frame while a clip drag hovers near an edge,
 * which is what lets a clip reach a row that is not currently visible. It is pure
 * so the ramp can be tested without a browser.
 *
 * Rects are viewport coordinates (`getBoundingClientRect`), so the step applies
 * directly to `scrollTop`.
 */

/** Distance from an edge at which a drag starts auto-scrolling. */
export const AUTOSCROLL_EDGE_PX = 24
/** Largest scroll applied per animation frame while the pointer holds an edge. */
export const AUTOSCROLL_MAX_STEP_PX = 14

export interface BandRect {
  top: number
  bottom: number
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
  if (edge <= 0) return 0
  const ramp = (depth: number) =>
    Math.min(maxStep, Math.max(1, Math.round((maxStep * depth) / edge)))
  const intoTop = band.top + edge - pointerY
  if (intoTop > 0) return -ramp(intoTop)
  const intoBottom = pointerY - (band.bottom - edge)
  if (intoBottom > 0) return ramp(intoBottom)
  return 0
}
