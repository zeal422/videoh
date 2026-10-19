import { clipFilter } from '../color'
import { findSequence, sequenceTracks } from '../factories'
import { applyLut3dToRgba, decodeLutGrid, findLut } from '../lut'
import {
  featherGradient,
  getTransitionSpan,
  transitionAlphas,
  transitionGeometry,
} from '../transition'
import type { TransitionGeometry } from '../transition'
import { animatedValue } from '../keyframes'
import { clipTransform } from '../export/offline'
import {
  blendCompositeOperation,
  blurSampleTimes,
  cropFeatherPx,
  cropRect,
  effectKeyframeValue,
  effectSamples,
  enabledEffects,
  isCropConsumed,
  resolveMatteTrack,
} from '../effects'
import { applyChromaKeyToRgba, buildMatteMask, parseKeyColor } from '../chroma-key'
import type { Clip, Doc, EffectEntry, MediaAsset, ProjectLut, Track } from '../types'

/**
 * Canvas compositor — draws one frame of the doc at time `t`.
 *
 * Rendering rules:
 * - Tracks composite bottom→top (tracks[0] is the topmost layer).
 * - Video/image clips are drawn contain-fit (black bars preserved), with
 *   position/scale transform and the color filter stack applied per clip
 *   (built by the shared `clipFilter` in color.ts).
 * - Text clips render their styled text (position/scale/opacity animated).
 * - Transitions: when clip A (with transitionOut) overlaps clip B, both are
 *   drawn across the transition span — complementary alpha for a crossfade,
 *   out-then-in through black for a dip to black (both alphas 0 at the
 *   midpoint, so lower tracks show through there like under any transparency),
 *   and full-opacity geometry for wipe/slide/push (a clip region, picture
 *   offsets, or both, with the wipe edge optionally feathered).
 * - Clip `opacity` (0..1, default 1, keyframe-able) multiplies into every
 *   draw and stacks with crossfade alphas.
 * - Sub-frame-rate reads blend: a clip playing below realtime combines its
 *   source frame with the next one at the weight the resolver reports, using
 *   the SAME `drawBlendedContain` the exporter calls, so a slow clip cannot be
 *   stepped in the monitor and blended in the file.
 *
 * Pure w.r.t. app state: media frames come in via the `resolve` callback.
 */

/** The second source frame of a sub-frame-rate read, and the weight to blend it at. */
export interface FrameBlendSource {
  el: HTMLVideoElement
  /** 0..1 weight of `el` against the primary frame (see `blendWeight`). */
  weight: number
}

export type MediaResolver = (
  clip: Clip,
  localTime: number,
) =>
  | {
      asset: MediaAsset
      el?: HTMLVideoElement | HTMLImageElement
      /**
       * Present only when the clip reads strictly below the source frame rate
       * and the partner frame is decodable. The engine resolves the partner
       * time with the shared `blendPartnerTime` and weights the pair from its
       * elements' presented-frame timestamps, the way the exporter weights it
       * from the decoder's sample timestamps.
       */
      blend?: FrameBlendSource
    }
  | undefined

export interface DrawFrameInput {
  ctx: CanvasRenderingContext2D
  doc: Doc
  time: number
  resolve: MediaResolver
  /**
   * The ACTIVE sequence's tracks (0.8.1). Defaults to the project root tracks.
   * The preview passes the open sequence's lanes; nested compound clips recurse
   * from here regardless of the active path.
   */
  tracks?: readonly Track[]
}

/**
 * Transparent scratch surfaces for compound group composites, indexed by
 * recursion depth. Lazily allocated and reused across frames and clips; the
 * depth is bounded by the nesting limit and every surface is cleared before
 * reuse, so sibling compounds never show stale pixels.
 */
const sequenceSurfaces: HTMLCanvasElement[] = []

function sequenceSurface(
  depth: number,
  width: number,
  height: number,
): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') return null
  const canvas = (sequenceSurfaces[depth] ??= document.createElement('canvas'))
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }
  return canvas.getContext('2d')
}

export function drawFrame({ ctx, doc, time, resolve, tracks }: DrawFrameInput): void {
  const { width, height } = doc.project
  ctx.save()
  ctx.globalAlpha = 1
  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, width, height)

  const list = tracks ?? doc.project.tracks
  for (let i = list.length - 1; i >= 0; i--) {
    drawTrack(ctx, list[i], time, resolve, width, height, doc, 0)
  }
  ctx.restore()
}

function drawTrack(
  ctx: CanvasRenderingContext2D,
  track: Track,
  t: number,
  resolve: MediaResolver,
  width: number,
  height: number,
  doc: Doc,
  depth: number,
  ignoreVisibility = false,
): void {
  if (track.kind === 'audio') return // audio tracks have no visual
  // Hidden tracks skip the video composite — except when rendered AS a matte
  // mask: visibility affects the main composite only, never the mask (a
  // hidden source that rendered nothing would erase the matted picture).
  if (track.visible === false && !ignoreVisibility) return
  const clips = [...track.clips].sort((a, b) => a.start - b.start)
  const active = clips.filter((c) => t >= c.start && t < c.start + c.duration)
  if (active.length === 0) return

  if (active.length === 1) {
    drawClip(ctx, active[0], t, resolve, 1, width, height, doc, depth)
    return
  }

  // Two overlapping clips: transition when the earlier one has a transitionOut.
  const a = active[0]
  const b = active[1]
  const span = a.transitionOut ? getTransitionSpan(a, b) : null
  if (span && t >= span.start) {
    const geo = transitionGeometry(span, t, width, height)
    if (geo) {
      drawSpatialTransition(ctx, span, geo, t, resolve, width, height, doc, depth)
      return
    }
    const { aAlpha, bAlpha } = transitionAlphas(span, t)
    drawClip(ctx, a, t, resolve, aAlpha, width, height, doc, depth)
    drawClip(ctx, b, t, resolve, bAlpha, width, height, doc, depth)
    return
  }
  // Plain overlap: the later clip wins.
  for (const clip of active) drawClip(ctx, clip, t, resolve, 1, width, height, doc, depth)
}

/** Reused scratch surfaces for feathered-wipe masking, one per nesting depth. */
const spatialScratch: HTMLCanvasElement[] = []

function spatialSurface(
  depth: number,
  width: number,
  height: number,
): { canvas: HTMLCanvasElement; sctx: CanvasRenderingContext2D } | null {
  if (typeof document === 'undefined') return null
  const canvas = (spatialScratch[depth] ??= document.createElement('canvas'))
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }
  const sctx = canvas.getContext('2d')
  return sctx ? { canvas, sctx } : null
}

/**
 * Wipe/slide/push draw: both pictures at full opacity, placed by the shared
 * geometry. The outgoing draws full-frame (translated for push); the
 * incoming draws through the wipe region or translated. A feathered wipe
 * masks the incoming through a scratch surface: the outgoing already
 * underneath acts as the complementary gradient, so the band cross-blends
 * the pair with the frame fully covered.
 */
function drawSpatialTransition(
  ctx: CanvasRenderingContext2D,
  span: { a: Clip; b: Clip },
  geo: TransitionGeometry,
  t: number,
  resolve: MediaResolver,
  width: number,
  height: number,
  doc: Doc,
  depth: number,
): void {
  const { a, b } = span
  if (geo.aOffset.x === 0 && geo.aOffset.y === 0) {
    drawClip(ctx, a, t, resolve, 1, width, height, doc, depth)
  } else {
    ctx.save()
    ctx.translate(geo.aOffset.x, geo.aOffset.y)
    drawClip(ctx, a, t, resolve, 1, width, height, doc, depth)
    ctx.restore()
  }
  if (geo.wipeRect && !geo.featherBand) {
    const r = geo.wipeRect
    ctx.save()
    ctx.beginPath()
    ctx.rect(r.x, r.y, r.w, r.h)
    ctx.clip()
    drawClip(ctx, b, t, resolve, 1, width, height, doc, depth)
    ctx.restore()
    return
  }
  if (geo.wipeRect && geo.featherBand) {
    // Depth-routed scratch: the incoming picture may itself be a compound
    // clip whose nested tracks carry another feathered wipe, which masks
    // into its own depth surface instead of this one.
    const surface = spatialSurface(depth, width, height)
    if (!surface) {
      // No scratch (or no 2D context): fall back to the hard region.
      const r = geo.wipeRect
      ctx.save()
      ctx.beginPath()
      ctx.rect(r.x, r.y, r.w, r.h)
      ctx.clip()
      drawClip(ctx, b, t, resolve, 1, width, height, doc, depth)
      ctx.restore()
      return
    }
    const { canvas, sctx } = surface
    sctx.save()
    sctx.globalAlpha = 1
    sctx.clearRect(0, 0, width, height)
    drawClip(sctx, b, t, resolve, 1, width, height, doc, depth)
    paintSpatialMask(sctx, geo, width, height)
    sctx.restore()
    // The incoming clip's blend mode travels with the reveal (both
    // spatial-transition roles blend, per the plan): compositing the masked
    // scratch source-over would blend against nothing and drop the mode.
    const gco = blendCompositeOperation(b.blendMode)
    ctx.save()
    if (gco !== 'source-over') ctx.globalCompositeOperation = gco
    ctx.drawImage(canvas, 0, 0)
    ctx.restore()
    return
  }
  ctx.save()
  ctx.translate(geo.bOffset.x, geo.bOffset.y)
  drawClip(ctx, b, t, resolve, 1, width, height, doc, depth)
  ctx.restore()
}

/**
 * Applies the feathered-wipe mask to a scratch surface holding the incoming
 * picture full-frame: erases the unrevealed region, then keeps the revealed
 * region through a destination-in gradient that is opaque up to the feather
 * band and fades to transparent at the wipe boundary. Filling only the band
 * would erase the revealed interior (destination-in clears everything the
 * new shape does not cover). Shared by the preview compositor and the
 * exporter, so the band cannot differ between monitor and file. No-op
 * without a feather band.
 */
export function paintSpatialMask(
  sctx: CanvasRenderingContext2D,
  geo: TransitionGeometry,
  width: number,
  height: number,
): void {
  const rect = geo.wipeRect
  if (!rect || !featherGradient(geo)) return
  if (geo.direction === 'left') sctx.clearRect(rect.x + rect.w, 0, width - rect.x - rect.w, height)
  else if (geo.direction === 'right') sctx.clearRect(0, 0, rect.x, height)
  else if (geo.direction === 'up')
    sctx.clearRect(0, rect.y + rect.h, width, height - rect.y - rect.h)
  else sctx.clearRect(0, 0, width, rect.y)
  const g = featherGradient(geo)
  if (!g) return
  const grad = sctx.createLinearGradient(g.x0, g.y0, g.x1, g.y1)
  for (const stop of g.stops) grad.addColorStop(stop.at, `rgba(0,0,0,${stop.opacity})`)
  sctx.globalCompositeOperation = 'destination-in'
  sctx.fillStyle = grad
  sctx.fillRect(rect.x, rect.y, rect.w, rect.h)
}

/**
 * Four-side soft-rect mask for crop feather (0.8.6): keeps the rect through
 * destination-in, then erases a feather band along each edge with
 * destination-out gradients (opaque at the boundary, transparent inward).
 * Shared by the preview compositor and the exporter, so feather cannot
 * differ between monitor and file. The wipe-only `paintSpatialMask` above is
 * NOT reused here: it takes TransitionGeometry and feathers one direction,
 * while crop needs all four sides.
 */
export function paintSoftRectMask(
  sctx: CanvasRenderingContext2D,
  rect: { x: number; y: number; w: number; h: number },
  featherPx: number,
): void {
  sctx.save()
  sctx.globalCompositeOperation = 'destination-in'
  sctx.fillStyle = '#000000'
  sctx.fillRect(rect.x, rect.y, rect.w, rect.h)
  if (featherPx > 0 && rect.w > 0 && rect.h > 0) {
    // One gradient band per edge. Corners erase twice (box-feather
    // approximation); the band clamps to the rect so edges never cross.
    const bands: {
      x0: number
      y0: number
      x1: number
      y1: number
      x: number
      y: number
      w: number
      h: number
    }[] = [
      {
        x0: rect.x,
        y0: 0,
        x1: rect.x + featherPx,
        y1: 0,
        x: rect.x,
        y: rect.y,
        w: featherPx,
        h: rect.h,
      },
      {
        x0: rect.x + rect.w,
        y0: 0,
        x1: rect.x + rect.w - featherPx,
        y1: 0,
        x: rect.x + rect.w - featherPx,
        y: rect.y,
        w: featherPx,
        h: rect.h,
      },
      {
        x0: 0,
        y0: rect.y,
        x1: 0,
        y1: rect.y + featherPx,
        x: rect.x,
        y: rect.y,
        w: rect.w,
        h: featherPx,
      },
      {
        x0: 0,
        y0: rect.y + rect.h,
        x1: 0,
        y1: rect.y + rect.h - featherPx,
        x: rect.x,
        y: rect.y + rect.h - featherPx,
        w: rect.w,
        h: featherPx,
      },
    ]
    sctx.globalCompositeOperation = 'destination-out'
    for (const band of bands) {
      if (band.w <= 0 || band.h <= 0) continue
      const grad = sctx.createLinearGradient(band.x0, band.y0, band.x1, band.y1)
      grad.addColorStop(0, 'rgba(0,0,0,1)')
      grad.addColorStop(1, 'rgba(0,0,0,0)')
      sctx.fillStyle = grad
      sctx.fillRect(band.x, band.y, band.w, band.h)
    }
  }
  sctx.restore()
}

/**
 * Blits a frame-sized effect image with the clip's Motion transform.
 * Matches containRect's geometry exactly (scale grows from the frame center,
 * then the position offset applies), so the effect path composites the same
 * picture the fast path draws: the stack evaluates on untransformed
 * contain-fit content (crop precedes Motion, Premiere's fixed-effects-last
 * order) and Motion lands here, once, at composite time. Shared by the
 * preview compositor and the exporter.
 */
export function blitTransformed(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  width: number,
  height: number,
  transform: { posX: number; posY: number; scale: number } | null,
): void {
  if (!transform) {
    ctx.drawImage(image, 0, 0)
    return
  }
  ctx.save()
  ctx.translate(width / 2 + transform.posX, height / 2 + transform.posY)
  ctx.scale(transform.scale, transform.scale)
  ctx.drawImage(image, -width / 2, -height / 2, width, height)
  ctx.restore()
}

function drawClip(
  ctx: CanvasRenderingContext2D,
  clip: Clip,
  t: number,
  resolve: MediaResolver,
  alpha: number,
  width: number,
  height: number,
  doc: Doc,
  depth: number,
): void {
  // Clip-local time for keyframe evaluation (0 = clip start).
  const local = t - clip.start
  const stack = enabledEffects(clip)
  const gco = blendCompositeOperation(clip.blendMode)
  // Fast path: no stack, no blend. A stack of only zero-sample blurs is
  // equally inert (shutter 0 or disabled-at-this-frame evaluates nothing),
  // so it takes the same direct draw instead of a scratch round-trip.
  // Bit-identical to the pre-effects draw.
  const inertBlur =
    stack.length > 0 &&
    stack.every(
      (e) =>
        e.type === 'motionBlur' && effectSamples(effectKeyframeValue(e, 'shutter', local)) <= 0,
    )
  if ((stack.length === 0 || inertBlur) && gco === 'source-over') {
    // Clip opacity stacks with the transition alpha — a 50%-opaque clip inside a
    // crossfade draws at alpha*0.5 on every layer (Premiere-style compositing).
    const effective = alpha * animatedValue(clip, 'opacity', local)
    if (effective <= 0) return
    const lut = findLut(doc.project.luts, clip.lutId)
    drawClipCore(
      ctx,
      clip,
      local,
      resolve,
      effective,
      clipFilter(clip, local, lut),
      clipTransform(clip, local),
      width,
      height,
      doc,
      depth,
      lut,
    )
    return
  }
  if (alpha <= 0) return
  // Effect path: opacity and grading freeze at frame time (applied once at
  // the composite below); the core draws UNTRANSFORMED contain-fit content so
  // the stack evaluates before Motion (crop precedes Motion); Motion lands at
  // composite time, per sub-sample inside blur, once outside it. Matte pixels
  // freeze at frame time; chroma params freeze, but the key pass re-evaluates
  // per sub-sample in stored order (animated crop upstream changes its input).
  const effective = alpha * animatedValue(clip, 'opacity', local)
  if (effective <= 0) return
  const lut = findLut(doc.project.luts, clip.lutId)
  const blurs = stack.filter((e) => e.type === 'motionBlur')
  // "Blurred" means some level actually ran its accumulator (2+ samples):
  // single-sample levels collapse to the unblurred stack, whose image is
  // untransformed and still needs its Motion blit below. Aligned with the
  // collapse decision in renderEffectImage (length <= 1 skips).
  const blurred =
    blurs.length > 0 &&
    blurs.some(
      (e) =>
        blurSampleTimes(t, effectKeyframeValue(e, 'shutter', local), doc.project.fps).length > 1,
    )
  const image = renderEffectImage(doc, resolve, clip, t, local, width, height, depth, {
    filter: clipFilter(clip, local, lut),
    lut,
  })
  if (!image) return
  ctx.save()
  if (gco !== 'source-over') ctx.globalCompositeOperation = gco
  ctx.globalAlpha = effective
  if (blurred) {
    // Sub-sample transforms are already baked into the accumulation.
    ctx.drawImage(image, 0, 0)
  } else {
    blitTransformed(ctx, image, width, height, clipTransform(clip, local))
  }
  ctx.restore()
}

/**
 * The pre-effects clip draw (the old drawClip body): content with caller
 * chosen alpha/filter/transform. `resolveLocal` drives source resolve,
 * compound nesting and text; the transform arrives precomputed, so
 * motion-blur sub-samples reposition without re-resolving (the parked source
 * frame is frozen; only the transform varies — the same approximation class
 * as the stepped preview, and Premiere's Transform blur likewise blurs the
 * transform, not content motion).
 */
function drawClipCore(
  ctx: CanvasRenderingContext2D,
  clip: Clip,
  resolveLocal: number,
  resolve: MediaResolver,
  alpha: number,
  filter: string,
  transform: { posX: number; posY: number; scale: number } | null,
  width: number,
  height: number,
  doc: Doc,
  depth: number,
  lut: ProjectLut | undefined,
): void {
  // Compound clip (0.8.1): composite the referenced sequence into a transparent
  // scratch surface, then draw that single surface with the container's alpha,
  // filter and transform (a GROUP composite, matching the exporter).
  if (clip.sequenceId) {
    const sequence = findSequence(doc, clip.sequenceId)
    if (!sequence) return
    const sctx = sequenceSurface(depth, width, height)
    if (!sctx) return
    sctx.save()
    sctx.globalAlpha = 1
    sctx.clearRect(0, 0, width, height)
    const childTracks = sequence.tracks
    for (let i = childTracks.length - 1; i >= 0; i--) {
      drawTrack(sctx, childTracks[i], resolveLocal, resolve, width, height, doc, depth + 1)
    }
    sctx.restore()
    drawContain(ctx, sequenceSurfaces[depth], width, height, alpha, filter, transform, lut)
    return
  }

  if (clip.text !== undefined && clip.style) {
    drawTextClip(ctx, clip, width, height, alpha, filter, transform)
    return
  }

  const resolved = resolve(clip, resolveLocal)
  if (!resolved) return // missing media → black
  const { asset, el } = resolved
  if (!el) return

  if (asset.kind === 'image') {
    drawContain(ctx, el as HTMLImageElement, width, height, alpha, filter, transform, lut)
    return
  }
  const video = el as HTMLVideoElement
  if (video.readyState >= 2) {
    const blend = resolved.blend
    // Gate on a weight strictly inside (0, 1): at the ends the pair reduces to
    // one of the two frames, and the export skips the pair there too. A partner
    // the decoder has not delivered yet (readyState < 2) keeps the stepped draw
    // rather than blending against a frame that is not there.
    if (blend && blend.weight > 0 && blend.weight < 1 && blend.el.readyState >= 2) {
      drawBlendedContain(ctx, {
        blend: { first: video, second: blend.el, weight: blend.weight },
        width,
        height,
        alpha,
        filter,
        transform,
        lut,
      })
      return
    }
    drawContain(ctx, video, width, height, alpha, filter, transform, lut)
  }
}

/**
 * Depth-indexed scratch surfaces for the effect pipeline (0.8.6), following
 * the sequenceSurfaces/spatialScratch pattern: lazily allocated, reused
 * across frames, cleared before reuse. Matte mask renders recurse at
 * depth + 1, so a matted clip never shares surfaces with its own mask.
 * Mask builds pool by depth and matte slot, so two mattes on one clip keep
 * distinct canvases; the transient mask render stays shared per depth.
 */
const effectScratch: HTMLCanvasElement[] = []
const effectZoom: HTMLCanvasElement[] = []
const effectAccum: HTMLCanvasElement[][] = []
const effectMaskRender: HTMLCanvasElement[] = []
const effectMaskBuild: HTMLCanvasElement[][] = []
/** Transparent frame for null blur samples (consumed crop mid-shutter keeps its weight). */
const effectClear: HTMLCanvasElement[] = []

function effectSurface(
  pool: HTMLCanvasElement[],
  depth: number,
  width: number,
  height: number,
): { canvas: HTMLCanvasElement; sctx: CanvasRenderingContext2D } | null {
  if (typeof document === 'undefined') return null
  const canvas = (pool[depth] ??= document.createElement('canvas'))
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }
  const sctx = canvas.getContext('2d')
  return sctx ? { canvas, sctx } : null
}

function effectAccumSurface(
  depth: number,
  level: number,
  width: number,
  height: number,
): { canvas: HTMLCanvasElement; sctx: CanvasRenderingContext2D } | null {
  if (typeof document === 'undefined') return null
  const byDepth = (effectAccum[depth] ??= [])
  const canvas = (byDepth[level] ??= document.createElement('canvas'))
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }
  const sctx = canvas.getContext('2d')
  return sctx ? { canvas, sctx } : null
}

function effectMaskBuildSurface(
  depth: number,
  slot: number,
  width: number,
  height: number,
): { canvas: HTMLCanvasElement; sctx: CanvasRenderingContext2D } | null {
  if (typeof document === 'undefined') return null
  const byDepth = (effectMaskBuild[depth] ??= [])
  const canvas = (byDepth[slot] ??= document.createElement('canvas'))
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }
  const sctx = canvas.getContext('2d')
  return sctx ? { canvas, sctx } : null
}

interface FrozenEffectParams {
  filter: string
  lut: ProjectLut | undefined
}

/**
 * Builds a track-matte mask surface once (0.8.6): renders the source track
 * at frame time, then rewrites it to a white silhouette whose alpha is the
 * mask value. Returns null when the source is unresolvable or no surface
 * exists (callers skip the effect, never crash). The mask is frame-time
 * frozen by construction, so blur sub-samples reuse one build instead of
 * re-rendering identical pixels per sample.
 */
function buildMatteSurface(
  doc: Doc,
  resolve: MediaResolver,
  clip: Clip,
  entry: Extract<EffectEntry, { type: 'trackMatte' }>,
  timelineT: number,
  width: number,
  height: number,
  depth: number,
  slot: number,
): HTMLCanvasElement | null {
  const source = resolveMatteTrack(doc, clip.id, entry)
  if (!source) return null
  const render = effectSurface(effectMaskRender, depth, width, height)
  const build = effectMaskBuildSurface(depth, slot, width, height)
  if (!render || !build) return null
  // The above-track rule is acyclic, so a mask render cannot recurse back
  // into this clip (no cycle guard needed).
  render.sctx.save()
  render.sctx.globalAlpha = 1
  render.sctx.clearRect(0, 0, width, height)
  drawTrack(render.sctx, source, timelineT, resolve, width, height, doc, depth + 1, true)
  render.sctx.restore()
  try {
    build.sctx.save()
    build.sctx.globalAlpha = 1
    build.sctx.clearRect(0, 0, width, height)
    build.sctx.drawImage(render.canvas, 0, 0)
    const img = build.sctx.getImageData(0, 0, width, height)
    buildMatteMask(img.data, entry.mode ?? 'luma', entry.reverse === true)
    build.sctx.putImageData(img, 0, 0)
    build.sctx.restore()
  } catch {
    try {
      build.sctx.restore()
    } catch {
      // Unbalanced save from the failed block above; ignore.
    }
    return null
  }
  return build.canvas
}
function applyStackEntry(
  canvas: HTMLCanvasElement,
  sctx: CanvasRenderingContext2D,
  doc: Doc,
  resolve: MediaResolver,
  clip: Clip,
  timelineT: number,
  frameLocal: number,
  motionLocal: number,
  width: number,
  height: number,
  depth: number,
  entry: EffectEntry,
  masks: Map<string, HTMLCanvasElement | null>,
): boolean {
  if (entry.type === 'crop') {
    if (isCropConsumed(entry, motionLocal)) return false
    const rect = cropRect(entry, motionLocal, width, height)
    paintSoftRectMask(sctx, rect, cropFeatherPx(entry, motionLocal, width, height))
    if (entry.zoom === true && rect.w > 0 && rect.h > 0) {
      // Zoom refills the frame with the cropped remainder (Premiere's Zoom).
      const zoom = effectSurface(effectZoom, depth, width, height)
      if (!zoom) return true
      zoom.sctx.save()
      zoom.sctx.globalAlpha = 1
      zoom.sctx.clearRect(0, 0, width, height)
      zoom.sctx.drawImage(canvas, rect.x, rect.y, rect.w, rect.h, 0, 0, width, height)
      zoom.sctx.restore()
      sctx.save()
      sctx.globalAlpha = 1
      sctx.clearRect(0, 0, width, height)
      sctx.drawImage(zoom.canvas, 0, 0)
      sctx.restore()
    }
    return true
  }
  if (entry.type === 'chromaKey') {
    const rgb = parseKeyColor(entry.key ?? '#00ff00')
    if (!rgb) return true
    try {
      const img = sctx.getImageData(0, 0, width, height)
      applyChromaKeyToRgba(img.data, {
        key: [rgb[0], rgb[1], rgb[2]],
        similarity: entry.similarity ?? 0,
        blend: entry.blend ?? 0,
        clipBlack: entry.clipBlack ?? 0,
        clipWhite: entry.clipWhite ?? 1,
        despill: entry.despill ?? 0,
      })
      sctx.putImageData(img, 0, 0)
    } catch {
      // Tainted canvas: leave the pixels (same posture as the LUT pass).
    }
    return true
  }
  // Track matte: keep the content through the prebuilt frame-time mask.
  // (Motion blur never reaches here: the caller applies non-blur entries.)
  if (entry.type !== 'trackMatte') return true
  const mask = masks.get(entry.id)
  // Absent from the map means unresolvable (or no surface): skip the effect.
  if (!mask) return true
  sctx.save()
  sctx.globalCompositeOperation = 'destination-in'
  sctx.drawImage(mask, 0, 0)
  sctx.restore()
  return true
}

/**
 * Clip content plus the non-blur stack at one motion time: core draw opaque
 * (UNTRANSFORMED contain-fit, so the stack evaluates before Motion) into the
 * base scratch, then each enabled non-blur entry in stored order. Crop
 * geometry evaluates at `motionLocal`; chroma params are static and the
 * matte mask arrives prebuilt at frame time. Returns null when a crop
 * consumes the frame (or no surface exists).
 */
function renderStackImage(
  doc: Doc,
  resolve: MediaResolver,
  clip: Clip,
  timelineT: number,
  frameLocal: number,
  motionLocal: number,
  width: number,
  height: number,
  depth: number,
  frozen: FrozenEffectParams,
  masks: Map<string, HTMLCanvasElement | null>,
): HTMLCanvasElement | null {
  const base = effectSurface(effectScratch, depth, width, height)
  if (!base) return null
  base.sctx.save()
  base.sctx.globalAlpha = 1
  base.sctx.clearRect(0, 0, width, height)
  drawClipCore(
    base.sctx,
    clip,
    frameLocal,
    resolve,
    1,
    frozen.filter,
    null,
    width,
    height,
    doc,
    depth,
    frozen.lut,
  )
  for (const entry of enabledEffects(clip)) {
    if (entry.type === 'motionBlur') continue
    const kept = applyStackEntry(
      base.canvas,
      base.sctx,
      doc,
      resolve,
      clip,
      timelineT,
      frameLocal,
      motionLocal,
      width,
      height,
      depth,
      entry,
      masks,
    )
    if (!kept) {
      base.sctx.restore()
      return null
    }
  }
  base.sctx.restore()
  return base.canvas
}

/**
 * The full effect image: blur entries apply in stored order, each
 * accumulating the previous level's renders over its own shutter window
 * (duplicates converge naturally: re-averaging an average). Level -1 is the
 * unblurred stack. Accumulation is additive at 1/N ('lighter'), the exact
 * uniform mean including transparency; null samples (consumed crop
 * mid-shutter) dilute at full weight.
 */
function renderEffectImage(
  doc: Doc,
  resolve: MediaResolver,
  clip: Clip,
  timelineT: number,
  frameLocal: number,
  width: number,
  height: number,
  depth: number,
  frozen: FrozenEffectParams,
): HTMLCanvasElement | null {
  const blurs = enabledEffects(clip).filter((e) => e.type === 'motionBlur')
  // Matte masks build once at frame time and are reused by every sub-sample:
  // the mask inputs are frozen (source track rendered at frameLocal), so a
  // rebuild per sample would redo identical pixel work.
  const masks = new Map<string, HTMLCanvasElement | null>()
  let matteSlot = 0
  for (const entry of enabledEffects(clip)) {
    if (entry.type !== 'trackMatte') continue
    masks.set(
      entry.id,
      buildMatteSurface(doc, resolve, clip, entry, timelineT, width, height, depth, matteSlot++),
    )
  }
  const renderLevel = (level: number, tTimeline: number): HTMLCanvasElement | null => {
    if (level < 0)
      return renderStackImage(
        doc,
        resolve,
        clip,
        timelineT,
        frameLocal,
        tTimeline - clip.start,
        width,
        height,
        depth,
        frozen,
        masks,
      )
    const shutter = effectKeyframeValue(blurs[level], 'shutter', frameLocal)
    const times = blurSampleTimes(tTimeline, shutter, doc.project.fps)
    // A single sample lands exactly at t (blurSampleTimes), so the
    // accumulator would copy the level below through one 'lighter' blit:
    // collapse to the unblurred path and skip the surface entirely.
    if (times.length <= 1) return renderLevel(level - 1, tTimeline)
    const acc = effectAccumSurface(depth, level, width, height)
    if (!acc) return renderLevel(level - 1, tTimeline)
    // Exact uniform mean via additive accumulation (the beginBlendPair
    // precedent): every sample lands at 1/N under 'lighter', so premultiplied
    // color AND alpha sum into the mean. The old incremental scheme drew each
    // sample source-over at 1/(k+1): exact for fully-opaque pixels, but a
    // transparent sample left the pixel untouched while still counting its
    // weight, so edges alternating opaque/transparent accumulated too opaque.
    const clear = effectSurface(effectClear, depth, width, height)
    if (!clear) return renderLevel(level - 1, tTimeline)
    clear.sctx.save()
    clear.sctx.globalAlpha = 1
    clear.sctx.clearRect(0, 0, width, height)
    clear.sctx.restore()
    acc.sctx.save()
    acc.sctx.globalAlpha = 1
    acc.sctx.clearRect(0, 0, width, height)
    acc.sctx.globalCompositeOperation = 'lighter'
    acc.sctx.globalAlpha = 1 / times.length
    for (const tau of times) {
      // Null samples (consumed crop mid-shutter) contribute transparent
      // black at full weight, diluting the mean honestly. Each sample blits
      // with its own Motion transform (crop precedes Motion: the stack image
      // is untransformed, Motion lands here per sub-sample).
      const img = renderLevel(level - 1, tau) ?? clear.canvas
      blitTransformed(acc.sctx, img, width, height, clipTransform(clip, tau - clip.start))
    }
    acc.sctx.restore()
    return acc.canvas
  }
  return renderLevel(blurs.length - 1, timelineT)
}

/**
 * Contain-fit geometry: the rect a source is drawn into. ONE implementation so
 * the preview, the blended draw and the exporter cannot drift apart.
 * Returns null when the source has no usable intrinsic size.
 */
export function containRect(
  sw: number,
  sh: number,
  width: number,
  height: number,
  transform: { posX: number; posY: number; scale: number } | null,
): { dx: number; dy: number; dw: number; dh: number } | null {
  if (!sw || !sh) return null
  const scale = transform?.scale ?? 1
  const fit = Math.min(width / sw, height / sh)
  const dw = sw * fit * scale
  const dh = sh * fit * scale
  // Scale grows from the frame center: the offsets come from the SCALED size,
  // so a 2x clip stays centered instead of drifting right and down.
  const dx = (width - dw) / 2 + (transform?.posX ?? 0)
  const dy = (height - dh) / 2 + (transform?.posY ?? 0)
  return { dx, dy, dw, dh }
}

/**
 * Intrinsic size of a decoded source. The exporter draws VideoFrames and
 * ImageBitmaps while the preview draws elements, so the four cases live here
 * instead of at each call site.
 */
export function sourceSize(source: CanvasImageSource): { width: number; height: number } {
  if (source instanceof HTMLVideoElement) {
    return { width: source.videoWidth, height: source.videoHeight }
  }
  if (source instanceof HTMLImageElement) {
    return { width: source.naturalWidth, height: source.naturalHeight }
  }
  if ('displayWidth' in source) {
    return { width: source.displayWidth, height: source.displayHeight }
  }
  const sized = source as { width?: number; height?: number }
  return { width: sized.width ?? 0, height: sized.height ?? 0 }
}

/**
 * Draws one source contain-fit with the clip's alpha, filter and geometry.
 * Exported so the exporter renders a decoded frame through the same geometry
 * and grading the preview does (its sources are VideoFrames; the geometry is
 * shared, see `containRect`).
 */
export function drawContain(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  width: number,
  height: number,
  alpha: number,
  filter: string,
  transform: { posX: number; posY: number; scale: number } | null,
  lut?: ProjectLut,
): void {
  const { width: sw, height: sh } = sourceSize(source)
  const rect = containRect(sw, sh, width, height, transform)
  if (!rect) return
  // A 3D cube grades the SOURCE PIXELS, so it runs before the ctx.filter
  // chain below (which carries the color set, the animated values and a 1D
  // shaper). A 1D shaper and a 3D cube therefore apply in the same order in
  // both render paths.
  const source2 = lut?.kind === '3d' ? applyLut3d(source, sw, sh, lut) : source
  ctx.save()
  ctx.globalAlpha = alpha
  if (filter !== 'none') ctx.filter = filter
  ctx.drawImage(source2, rect.dx, rect.dy, rect.dw, rect.dh)
  ctx.restore()
}

/**
 * Scratch canvas for the 3D LUT pixel pass, reused across draws. Sized to the
 * SOURCE frame, so it costs source-resolution RGBA (7.9 MB at 1080p, 31.6 MB at
 * 4K) and only while a 3D cube is actually assigned. Draws are sequential, so
 * one canvas is enough for every clip in a frame.
 */
let lutScratch: HTMLCanvasElement | null = null

/**
 * Applies a 3D cube to a decoded source, returning the graded scratch canvas.
 *
 * Shared by the preview compositor and the exporter, so a cube cannot look
 * different in the export. Returns the source untouched when the grid cannot be
 * decoded, the canvas cannot be created, or the read fails (a tainted source),
 * which keeps one broken LUT from blanking the frame.
 */
export function applyLut3d(
  source: CanvasImageSource,
  width: number,
  height: number,
  lut: ProjectLut,
): CanvasImageSource {
  if (width <= 0 || height <= 0 || typeof document === 'undefined') return source
  const grid = decodeLutGrid(lut)
  if (grid.length === 0) return source
  const canvas = (lutScratch ??= document.createElement('canvas'))
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }
  const scratchCtx = canvas.getContext('2d')
  if (!scratchCtx) return source
  try {
    scratchCtx.drawImage(source, 0, 0, width, height)
    const image = scratchCtx.getImageData(0, 0, width, height)
    applyLut3dToRgba(image.data, grid, lut.size)
    scratchCtx.putImageData(image, 0, 0)
  } catch {
    return source
  }
  return canvas
}

/** The two decoded frames of a sub-frame-rate read, and the weight between them. */
export interface FrameBlend {
  /** The frame for the primary read. */
  first: CanvasImageSource
  /** The frame one output frame later (the blend partner). */
  second: CanvasImageSource
  /** Weight of `second`, 0..1 (see `blendWeight` in frame-blend.ts). */
  weight: number
}

export interface BlendedDrawInput {
  blend: FrameBlend
  width: number
  height: number
  alpha: number
  filter: string
  transform: { posX: number; posY: number; scale: number } | null
  lut?: ProjectLut
}

/**
 * Begins a frame-blend pair on a scratch context: a black, opaque base with the
 * additive composite mode armed.
 *
 * The base matters. Two `globalAlpha` draws are NOT a weighted average: each is
 * attenuated by whatever is already on the canvas, so 0.6/0.4 weights over two
 * frames land at 0.360 where the correct blend is 0.600. Additively over black,
 * the two layers SUM into the weighted average instead.
 */
export function beginBlendPair(
  sctx: CanvasRenderingContext2D,
  width: number,
  height: number,
): void {
  sctx.save()
  sctx.globalCompositeOperation = 'source-over'
  sctx.globalAlpha = 1
  sctx.fillStyle = '#000000'
  sctx.fillRect(0, 0, width, height)
  sctx.globalCompositeOperation = 'lighter'
}

/**
 * Adds one weighted layer of a blend pair (see `beginBlendPair`). The caller
 * pairs this with a later `sctx.restore()` and composites the scratch target
 * ONCE at the clip's own alpha.
 */
export function addBlendLayer(
  sctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  alpha: number,
  width: number,
  height: number,
): void {
  sctx.globalAlpha = alpha
  sctx.drawImage(source, 0, 0, width, height)
}

/**
 * Scratch target for frame blending, sized to the DRAWN rect (up to project
 * size: 7.9 MB of RGBA at 1080p, 31.6 MB at 4K) and reused across clips and
 * frames. Distinct from the LUT scratch, which holds a SOURCE-sized buffer.
 */
let blendScratch: HTMLCanvasElement | null = null

/**
 * Draws one clip whose decoded frame straddles two source frames: both are
 * composited additively into a scratch target and the result is composited once
 * at the clip's alpha, filter and geometry (so the clip can carry a 3D LUT and
 * the color grade exactly as an unblended draw does).
 *
 * Shared by the preview compositor and the exporter, so the monitor and the
 * file blend a pair identically. Callers gate on a weight strictly inside
 * (0, 1), and fall back to `drawContain` when the scratch context is missing.
 */
export function drawBlendedContain(ctx: CanvasRenderingContext2D, input: BlendedDrawInput): void {
  const { blend, width, height, alpha, filter, transform, lut } = input
  const { width: sw, height: sh } = sourceSize(blend.first)
  const rect = containRect(sw, sh, width, height, transform)
  if (!rect) return
  const canvas = (blendScratch ??= document.createElement('canvas'))
  const rw = Math.max(1, Math.round(rect.dw))
  const rh = Math.max(1, Math.round(rect.dh))
  if (canvas.width !== rw || canvas.height !== rh) {
    canvas.width = rw
    canvas.height = rh
  }
  const sctx = canvas.getContext('2d')
  if (!sctx) {
    drawContain(ctx, blend.first, width, height, alpha, filter, transform, lut)
    return
  }
  // Each layer is graded (a 3D cube) IMMEDIATELY before it is drawn into the
  // scratch: the LUT pass reuses one source-sized canvas, so grading both
  // sources up front would leave the first one overwritten.
  const grade = (source: CanvasImageSource) =>
    lut?.kind === '3d' ? applyLut3d(source, sw, sh, lut) : source
  beginBlendPair(sctx, rw, rh)
  addBlendLayer(sctx, grade(blend.first), 1 - blend.weight, rw, rh)
  addBlendLayer(sctx, grade(blend.second), blend.weight, rw, rh)
  sctx.restore()
  ctx.save()
  ctx.globalAlpha = alpha
  if (filter !== 'none') ctx.filter = filter
  ctx.drawImage(canvas, rect.dx, rect.dy, rect.dw, rect.dh)
  ctx.restore()
}

/**
 * Draws one styled text clip onto a canvas. Exported so the offline exporter
 * renders titles through the same code path as the preview compositor.
 */
export function drawTextClip(
  ctx: CanvasRenderingContext2D,
  clip: Clip,
  width: number,
  height: number,
  alpha: number,
  filter: string,
  transform: { posX: number; posY: number; scale: number } | null,
): void {
  const style = clip.style!
  const text = clip.text ?? ''
  ctx.save()
  ctx.globalAlpha = alpha
  if (filter !== 'none') ctx.filter = filter
  if (transform) {
    ctx.translate(width / 2 + transform.posX, height / 2 + transform.posY)
    ctx.scale(transform.scale, transform.scale)
    ctx.translate(-width / 2, -height / 2)
  }
  ctx.font = `${style.italic ? 'italic ' : ''}${style.bold ? '700' : '400'} ${style.fontSize}px ${style.fontFamily}`
  ctx.textAlign = style.align
  ctx.textBaseline = 'middle'
  if (style.shadow) {
    ctx.shadowColor = 'rgba(0,0,0,0.75)'
    ctx.shadowBlur = Math.max(4, style.fontSize / 8)
    ctx.shadowOffsetY = Math.max(1, style.fontSize / 24)
  }
  ctx.fillStyle = style.color

  const lines = text.split('\n')
  const lineHeight = style.fontSize * 1.2
  const totalHeight = lines.length * lineHeight
  const anchorX = style.x * width
  const centerY = style.y * height

  lines.forEach((line, i) => {
    const y = centerY - totalHeight / 2 + lineHeight * (i + 0.5)
    ctx.fillText(line, anchorX, y)
  })
  ctx.restore()
}
