/**
 * Cubic-bezier timing solver (pure: no browser APIs, no dependency).
 *
 * The presets are Premiere Pro's default easings and match the CSS keywords of
 * the same name: easeIn cubic-bezier(0.42, 0, 1, 1), easeOut
 * cubic-bezier(0, 0, 0.58, 1), easeInOut cubic-bezier(0.42, 0, 0.58, 1).
 *
 * `cubicBezier` solves x(t) = p for t (Newton, with a bisection fallback) and
 * returns y(t), the same approach browsers use for `cubic-bezier()` timing
 * functions. `cubicBezierArea` returns the exact integral ∫₀^q y dp, which is
 * what a time-remap ramp needs: integrating the rate curve turns timeline
 * seconds into source seconds. The endpoints are exact: p <= 0 reads 0 and
 * p >= 1 reads 1.
 */

import type { KeyframeInterpolation } from './types'

/** Control points of a cubic-bezier timing function: x1, y1, x2, y2. */
export type BezierControls = readonly [number, number, number, number]

/** A timing function: maps linear progress 0..1 to eased progress 0..1. */
export type TimingFunction = (p: number) => number

/** Premiere's named easings, as cubic-bezier control points. */
export const EASING_PRESETS = {
  easeIn: [0.42, 0, 1, 1],
  easeOut: [0, 0, 0.58, 1],
  easeInOut: [0.42, 0, 0.58, 1],
} as const satisfies Record<string, BezierControls>

/** Newton iterations before the bisection fallback (matches browser solvers). */
const NEWTON_ITERATIONS = 12
/** Bisection depth once Newton stalls (its x is exact to ~1e-10 there). */
const BISECTION_ITERATIONS = 40
/**
 * Precision of the x-solve. Tightened from the browser-typical 1e-6 because
 * an eased segment's shape is now SUBDIVIDED into exact halves that are
 * re-evaluated through this same solver: a loose epsilon compounded into
 * visible re-timing drift at the join of the two halves.
 */
const SOLVE_EPSILON = 1e-9

function coefA(a1: number, a2: number): number {
  return 1 - 3 * a2 + 3 * a1
}

function coefB(a1: number, a2: number): number {
  return 3 * a2 - 6 * a1
}

function coefC(a1: number): number {
  return 3 * a1
}

/** The cubic polynomial of one axis at parameter t. Endpoints are exact. */
function curveAt(t: number, a1: number, a2: number): number {
  return ((coefA(a1, a2) * t + coefB(a1, a2)) * t + coefC(a1)) * t
}

/** Its derivative, for Newton's method. */
function slopeAt(t: number, a1: number, a2: number): number {
  return 3 * coefA(a1, a2) * t * t + 2 * coefB(a1, a2) * t + coefC(a1)
}

/** Solves x(t) = x for the curve's x control points. */
function makeSolveT(x1: number, x2: number): (x: number) => number {
  return (x) => {
    let t = x
    for (let i = 0; i < NEWTON_ITERATIONS; i++) {
      const error = curveAt(t, x1, x2) - x
      if (Math.abs(error) < SOLVE_EPSILON) return t
      const slope = slopeAt(t, x1, x2)
      // A flat slope (x1 or x2 at 0) cannot be inverted: bisect instead.
      if (Math.abs(slope) < SOLVE_EPSILON) break
      t -= error / slope
    }
    // Bisection fallback at a fixed depth, so the result does not depend on
    // how quickly the interval happens to shrink: 24 halvings pin t to ~6e-8.
    let low = 0
    let high = 1
    for (let i = 0; i < BISECTION_ITERATIONS; i++) {
      const mid = (low + high) / 2
      if (curveAt(mid, x1, x2) < x) low = mid
      else high = mid
    }
    return (low + high) / 2
  }
}

const identity: TimingFunction = (p) => p

/**
 * Builds the timing function for cubic-bezier(x1, y1, x2, y2). `p` is the
 * linear progress through the segment (0 at the outgoing keyframe, 1 at the
 * incoming one).
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): TimingFunction {
  // A curve whose x and y control points match is the identity.
  if (x1 === y1 && x2 === y2) return identity
  const solveT = makeSolveT(x1, x2)
  return (p) => {
    if (p <= 0) return 0
    if (p >= 1) return 1
    return curveAt(solveT(p), y1, y2)
  }
}

/**
 * Builds the exact integral of the curve: `area(q)` = ∫₀^q easing(p) dp.
 *
 * Substituting p = x(t) turns it into ∫₀^T y(t) x'(t) dt, a quintic whose
 * antiderivative is written out below, so the result is exact for any q
 * (numeric quadrature drifts badly across a long clip's ramp). For a full
 * segment the area is 0.5 + 0.3*((y1 - x1) + (y2 - x2)).
 */
export function cubicBezierArea(x1: number, y1: number, x2: number, y2: number): TimingFunction {
  const a1 = coefA(x1, x2)
  const b1 = coefB(x1, x2)
  const c1 = coefC(x1)
  const a2 = coefA(y1, y2)
  const b2 = coefB(y1, y2)
  const c2 = coefC(y1)
  // Antiderivative coefficients of y(t) * x'(t), by degree.
  const t6 = (3 * a1 * a2) / 6
  const t5 = (2 * b1 * a2 + 3 * a1 * b2) / 5
  const t4 = (c1 * a2 + 2 * b1 * b2 + 3 * a1 * c2) / 4
  const t3 = (c1 * b2 + 2 * b1 * c2) / 3
  const t2 = (c1 * c2) / 2
  const areaAt = (t: number) => t * t * (t2 + t * (t3 + t * (t4 + t * (t5 + t * t6))))
  const solveT = makeSolveT(x1, x2)
  const total = areaAt(1)
  return (q) => {
    if (q <= 0) return 0
    if (q >= 1) return total
    return areaAt(solveT(q))
  }
}

/** One timing function per interpolation name (exhaustive by type). */
export const TIMING_FUNCTIONS: Record<KeyframeInterpolation, TimingFunction> = {
  linear: identity,
  easeIn: cubicBezier(...EASING_PRESETS.easeIn),
  easeOut: cubicBezier(...EASING_PRESETS.easeOut),
  easeInOut: cubicBezier(...EASING_PRESETS.easeInOut),
}

/** One area function per interpolation name (linear's integral is q²/2). */
export const TIMING_AREAS: Record<KeyframeInterpolation, TimingFunction> = {
  linear: (q) => (q * q) / 2,
  easeIn: cubicBezierArea(...EASING_PRESETS.easeIn),
  easeOut: cubicBezierArea(...EASING_PRESETS.easeOut),
  easeInOut: cubicBezierArea(...EASING_PRESETS.easeInOut),
}

/**
 * Looks up a timing function. Absent or unknown interpolation reads as linear,
 * so a file written by a future build still evaluates.
 */
export function easingFunction(interpolation: string | undefined): TimingFunction {
  if (interpolation === undefined) return identity
  return TIMING_FUNCTIONS[interpolation as KeyframeInterpolation] ?? identity
}

/** Looks up a curve's area function; unknown interpolation reads as linear. */
export function easingArea(interpolation: string | undefined): TimingFunction {
  if (interpolation === undefined) return TIMING_AREAS.linear
  return TIMING_AREAS[interpolation as KeyframeInterpolation] ?? TIMING_AREAS.linear
}
