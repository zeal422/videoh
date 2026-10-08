import { clipFilter } from '../color'
import { applyLut3dToRgba, decodeLutGrid, findLut } from '../lut'
import { getTransitionSpan, transitionAlphas } from '../transition'
import { animatedValue } from '../keyframes'
import type { Clip, Doc, MediaAsset, ProjectLut, Track } from '../types'

/**
 * Canvas compositor — draws one frame of the doc at time `t`.
 *
 * Rendering rules:
 * - Tracks composite bottom→top (tracks[0] is the topmost layer).
 * - Video/image clips are drawn contain-fit (black bars preserved), with
 *   position/scale transform and the color filter stack applied per clip
 *   (built by the shared `clipFilter` in color.ts).
 * - Text clips render their styled text (position/scale/opacity animated).
 * - Crossfades: when clip A (with transitionOut) overlaps clip B, both are
 *   drawn with complementary alpha across the transition span.
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

export type MediaResolver = (clip: Clip) =>
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
}

export function drawFrame({ ctx, doc, time, resolve }: DrawFrameInput): void {
  const { width, height } = doc.project
  ctx.save()
  ctx.globalAlpha = 1
  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, width, height)

  const tracks = doc.project.tracks
  for (let i = tracks.length - 1; i >= 0; i--) {
    drawTrack(ctx, tracks[i], time, resolve, width, height, doc)
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
): void {
  if (track.kind === 'audio') return // audio tracks have no visual
  const clips = [...track.clips].sort((a, b) => a.start - b.start)
  const active = clips.filter((c) => t >= c.start && t < c.start + c.duration)
  if (active.length === 0) return

  if (active.length === 1) {
    drawClip(ctx, active[0], t, resolve, 1, width, height, doc)
    return
  }

  // Two overlapping clips: crossfade when the earlier one has a transitionOut.
  const a = active[0]
  const b = active[1]
  const span = a.transitionOut ? getTransitionSpan(a, b) : null
  if (span && t >= span.start) {
    const { aAlpha, bAlpha } = transitionAlphas(span, t)
    drawClip(ctx, a, t, resolve, aAlpha, width, height, doc)
    drawClip(ctx, b, t, resolve, bAlpha, width, height, doc)
    return
  }
  // Plain overlap: the later clip wins.
  for (const clip of active) drawClip(ctx, clip, t, resolve, 1, width, height, doc)
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
): void {
  // Clip-local time for keyframe evaluation (0 = clip start).
  const local = t - clip.start
  // Clip opacity stacks with the transition alpha — a 50%-opaque clip inside a
  // crossfade draws at alpha*0.5 on every layer (Premiere-style compositing).
  const effective = alpha * animatedValue(clip, 'opacity', local)
  if (effective <= 0) return

  // Color stack: exposure/contrast/saturation/brightness/hue, animated or static.
  // One filter builder for both render paths (color.ts), plus the clip's LUT:
  // a 1D shaper rides the filter string, a 3D cube is applied to the decoded
  // pixels below.
  const lut = findLut(doc.project.luts, clip.lutId)
  const filter = clipFilter(clip, local, lut)

  const posX = animatedValue(clip, 'positionX', local)
  const posY = animatedValue(clip, 'positionY', local)
  const scale = animatedValue(clip, 'scale', local)
  const transformed = posX !== 0 || posY !== 0 || scale !== 1

  if (clip.text !== undefined && clip.style) {
    drawTextClip(
      ctx,
      clip,
      width,
      height,
      effective,
      filter,
      transformed ? { posX, posY, scale } : null,
    )
    return
  }

  const resolved = resolve(clip)
  if (!resolved) return // missing media → black
  const { asset, el } = resolved
  if (!el) return

  if (asset.kind === 'image') {
    drawContain(
      ctx,
      el as HTMLImageElement,
      width,
      height,
      effective,
      filter,
      transformed ? { posX, posY, scale } : null,
      lut,
    )
    return
  }
  const video = el as HTMLVideoElement
  if (video.readyState >= 2) {
    const geometry = transformed ? { posX, posY, scale } : null
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
        alpha: effective,
        filter,
        transform: geometry,
        lut,
      })
      return
    }
    drawContain(ctx, video, width, height, effective, filter, geometry, lut)
  }
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
