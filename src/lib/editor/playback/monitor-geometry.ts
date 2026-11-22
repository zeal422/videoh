import { activeTracks, findMedia } from '../factories'
import { clipTransform } from '../export/offline'
import { animatedValue } from '../keyframes'
import { getTransitionSpan, transitionAlphas, transitionGeometry } from '../transition'
import { shapeBounds } from '../shapes'
import {
  gizmoQuad,
  IDENTITY_TRANSFORM,
  pointInQuad,
  type ClipTransform,
  type Point,
  type Rect,
} from '../transform'
import { containRect } from './compositor'
import type { NormalizedBox } from './text-box'
import type { Clip, Doc, MediaAsset } from '../types'

/**
 * Monitor geometry (0.29.5): the ONE source of the box a clip occupies in
 * project pixels. Selection, canvas snapping, and the transform gizmo all read
 * it, so a click target, a snap box, and a drawn gizmo cannot disagree.
 *
 * Pure and DOM-free. Text measurement is injected by the PreviewPanel (the
 * existing `measureTextBox`), so this module runs in Vitest's Node
 * environment; the compositor import is math, not a canvas touch.
 */

/** Measures a text clip's normalized box; null when it cannot be measured. */
export type TextMeasure = (
  clip: Pick<Clip, 'text' | 'style'>,
  width: number,
  height: number,
) => NormalizedBox | null

export interface CanvasSnapTargets {
  vertical: number[]
  horizontal: number[]
}

export interface CanvasSnapGuides {
  x: number | null
  y: number | null
}

export interface CanvasSnapResult {
  dx: number
  dy: number
  guides: CanvasSnapGuides
}

/**
 * The clip's untransformed box in project pixels: shape path bounds, a
 * measured text box, the full frame for a compound, or the contain-fit rect
 * for media. An offline or unmeasured media source still gets the full frame,
 * which is the move box the gizmo has always used.
 */
export function baseRectForClip(
  clip: Clip,
  asset: MediaAsset | undefined,
  width: number,
  height: number,
  measureText: TextMeasure,
): Rect | null {
  if (clip.audioOnly === true) return null
  if (clip.shape) return shapeBounds(clip.shape, width, height)
  if (clip.text !== undefined) {
    const box = measureText(clip, width, height)
    if (!box) return null
    return { x0: box.x0 * width, y0: box.y0 * height, x1: box.x1 * width, y1: box.y1 * height }
  }
  if (clip.sequenceId) return { x0: 0, y0: 0, x1: width, y1: height }
  if (asset) {
    if (asset.kind === 'audio') return null
    if (asset.width > 0 && asset.height > 0) {
      const rect = containRect(asset.width, asset.height, width, height, null)
      if (rect) {
        return { x0: rect.dx, y0: rect.dy, x1: rect.dx + rect.dw, y1: rect.dy + rect.dh }
      }
    }
  }
  return { x0: 0, y0: 0, x1: width, y1: height }
}

/** The clip's transformed corners through the same quad the gizmo draws. */
export function quadForClip(
  transform: ClipTransform,
  baseRect: Rect,
  width: number,
  height: number,
): Point[] {
  return gizmoQuad(baseRect, transform, width, height)
}

/** Axis-aligned bounds of a quad. Flip does not change these. */
export function quadBounds(quad: readonly Point[]): Rect {
  const xs = quad.map((point) => point.x)
  const ys = quad.map((point) => point.y)
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
}

/**
 * True when a clip needs a media asset it cannot resolve. Text, shape, and
 * compound clips carry no media requirement and stay eligible.
 */
function mediaMissing(doc: Doc, clip: Clip): boolean {
  if (clip.mediaId === undefined) return false
  return !findMedia(doc, clip.mediaId)
}

/** Effective opacity at the playhead, keyframed opacity included. */
export function clipOpacityAt(clip: Clip, playhead: number): number {
  const local = playhead - clip.start
  const value = animatedValue(clip, 'opacity', local)
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1
}

/** Clips that can be picked or snapped to: visual, live, visible, and opaque. */
function eligibleAt(doc: Doc, clip: Clip, playhead: number): boolean {
  // Both callers pass only clips active at the playhead; this answers the
  // media and visibility questions they do not.
  if (clip.audioOnly === true) return false
  if (mediaMissing(doc, clip)) return false
  if (clipOpacityAt(clip, playhead) <= 0) return false
  return true
}

/**
 * The rendered top clip whose transformed box contains `point`. `activeTracks[0]`
 * is the topmost layer and the compositor draws last-to-first, so the downward
 * walk returns what the viewer sees on top. Shape clicks use the box, not the
 * exact path: a click inside a star's transparent corner still selects it.
 */
export function pickVisualClipAt(
  doc: Doc,
  activeSequencePath: readonly string[],
  playhead: number,
  point: Point,
  measureText: TextMeasure,
): Clip | undefined {
  for (const track of activeTracks(doc, activeSequencePath)) {
    if (track.kind === 'audio' || track.visible === false) continue
    // Mirror the compositor: clips draw start-sorted, so a later-start clip
    // is on top within one lane. Walk that order from the last drawn one.
    const clips = [...track.clips].sort((a, b) => a.start - b.start)
    const active = clips.filter(
      (clip) => playhead >= clip.start && playhead < clip.start + clip.duration,
    )
    for (let index = active.length - 1; index >= 0; index--) {
      const clip = active[index]
      if (track.kind === 'text' && clip.text === undefined) continue
      if (!eligibleAt(doc, clip, playhead)) continue
      const role = transitionRoleAt(active, index, playhead, doc.project.width, doc.project.height)
      if (role?.hidden) continue
      if (role?.wipeRect) {
        const r = role.wipeRect
        if (point.x < r.x0 || point.x > r.x1 || point.y < r.y0 || point.y > r.y1) continue
      }
      const asset = findMedia(doc, clip.mediaId)
      const base = baseRectForClip(clip, asset, doc.project.width, doc.project.height, measureText)
      if (!base) continue
      const transform = clipTransform(clip, playhead - clip.start) ?? IDENTITY_TRANSFORM
      const quad = quadForClip(transform, base, doc.project.width, doc.project.height)
      const localPoint =
        role && (role.offset.x !== 0 || role.offset.y !== 0)
          ? { x: point.x - role.offset.x, y: point.y - role.offset.y }
          : point
      if (pointInQuad(localPoint, quad)) return clip
    }
  }
  return undefined
}

interface TransitionRole {
  /** Fully faded at this playhead (alpha crossfade or dip to black). */
  hidden: boolean
  /** The clip's draw-time translation (push for the outgoing, slide/push incoming). */
  offset: Point
  /** The visible incoming region for a wipe, in frame pixels. */
  wipeRect: Rect | null
}

/**
 * How the compositor draws the transition pair at this playhead: an alpha
 * head/tail can hide one side, a wipe limits the incoming to its reveal rect,
 * and slide/push translate a draw. Plain overlap returns null.
 */
function transitionRoleAt(
  active: Clip[],
  index: number,
  playhead: number,
  width: number,
  height: number,
): TransitionRole | null {
  if (active.length < 2 || index > 1) return null
  const span = getTransitionSpan(active[0]!, active[1]!)
  if (!span || playhead < span.start) return null
  const geo = transitionGeometry(span, playhead, width, height)
  if (geo) {
    return {
      hidden: false,
      offset: index === 0 ? geo.aOffset : geo.bOffset,
      wipeRect: index === 1 && geo.wipeRect ? rectFromFrame(geo.wipeRect) : null,
    }
  }
  const { aAlpha, bAlpha } = transitionAlphas(span, playhead)
  return {
    hidden: (index === 0 ? aAlpha : bAlpha) <= 0,
    offset: { x: 0, y: 0 },
    wipeRect: null,
  }
}

/** A frame rect ({x,y,w,h}) in the module's corner form. */
function rectFromFrame(rect: { x: number; y: number; w: number; h: number }): Rect {
  return { x0: rect.x, y0: rect.y, x1: rect.x + rect.w, y1: rect.y + rect.h }
}

/**
 * Vertical and horizontal target lines for a monitor move: the frame's edges
 * and center plus every other visible, active clip's transformed box. Targets
 * come from the quad's axis-aligned bounds, never the untransformed base.
 */
export function canvasSnapTargets(
  doc: Doc,
  activeSequencePath: readonly string[],
  playhead: number,
  excludeClipIds: readonly string[],
  measureText: TextMeasure,
): CanvasSnapTargets {
  const { width, height } = doc.project
  const vertical = [0, width / 2, width]
  const horizontal = [0, height / 2, height]
  const exclude = new Set(excludeClipIds)
  for (const track of activeTracks(doc, activeSequencePath)) {
    if (track.kind === 'audio' || track.visible === false) continue
    const clips = [...track.clips].sort((a, b) => a.start - b.start)
    const active = clips.filter(
      (clip) => playhead >= clip.start && playhead < clip.start + clip.duration,
    )
    for (let index = 0; index < active.length; index++) {
      const clip = active[index]
      if (exclude.has(clip.id)) continue
      if (track.kind === 'text' && clip.text === undefined) continue
      if (!eligibleAt(doc, clip, playhead)) continue
      const role = transitionRoleAt(active, index, playhead, width, height)
      if (role?.hidden) continue
      const asset = findMedia(doc, clip.mediaId)
      const base = baseRectForClip(clip, asset, width, height, measureText)
      if (!base) continue
      const transform = clipTransform(clip, playhead - clip.start) ?? IDENTITY_TRANSFORM
      const box = quadBounds(quadForClip(transform, base, width, height))
      // A slide/push translates the drawn picture; its snap lines move with it.
      const ox = role?.offset.x ?? 0
      const oy = role?.offset.y ?? 0
      vertical.push(box.x0 + ox, (box.x0 + box.x1) / 2 + ox, box.x1 + ox)
      horizontal.push(box.y0 + oy, (box.y0 + box.y1) / 2 + oy, box.y1 + oy)
    }
  }
  return { vertical, horizontal }
}

/**
 * The smallest shift that lands one of the box's left/center/right lines on a
 * vertical target, and one of its top/center/bottom lines on a horizontal
 * target. Each axis snaps independently; a guide is reported only for an axis
 * that matched. Non-finite values are ignored.
 */
export function snapBoxToTargets(
  box: Rect,
  targets: CanvasSnapTargets,
  threshold: number,
): CanvasSnapResult {
  const guides: CanvasSnapGuides = { x: null, y: null }
  if (!Number.isFinite(threshold) || threshold <= 0) return { dx: 0, dy: 0, guides }
  let dx = 0
  let dy = 0
  const xEdges = [box.x0, (box.x0 + box.x1) / 2, box.x1]
  let bestX = threshold
  for (const edge of xEdges) {
    if (!Number.isFinite(edge)) continue
    for (const target of targets.vertical) {
      if (!Number.isFinite(target)) continue
      const distance = Math.abs(target - edge)
      if (distance > bestX) continue
      bestX = distance
      dx = target - edge
      guides.x = target
    }
  }
  const yEdges = [box.y0, (box.y0 + box.y1) / 2, box.y1]
  let bestY = threshold
  for (const edge of yEdges) {
    if (!Number.isFinite(edge)) continue
    for (const target of targets.horizontal) {
      if (!Number.isFinite(target)) continue
      const distance = Math.abs(target - edge)
      if (distance > bestY) continue
      bestY = distance
      dy = target - edge
      guides.y = target
    }
  }
  return { dx, dy, guides }
}

/** Translates a rect, for a proposed move box. */
export function translateRect(rect: Rect, dx: number, dy: number): Rect {
  return { x0: rect.x0 + dx, y0: rect.y0 + dy, x1: rect.x1 + dx, y1: rect.y1 + dy }
}
