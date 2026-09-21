import { getTransitionSpan, transitionAlphas } from '../transition'
import { animatedValue } from '../keyframes'
import type { Clip, Doc, MediaAsset, Track } from '../types'

/**
 * Canvas compositor — draws one frame of the doc at time `t`.
 *
 * Rendering rules:
 * - Tracks composite bottom→top (tracks[0] is the topmost layer).
 * - Video/image clips are drawn contain-fit (black bars preserved), with
 *   position/scale transform and the color filter stack applied per clip.
 * - Text clips render their styled text (position/scale/opacity animated).
 * - Crossfades: when clip A (with transitionOut) overlaps clip B, both are
 *   drawn with complementary alpha across the transition span.
 * - Clip `opacity` (0..1, default 1, keyframe-able) multiplies into every
 *   draw and stacks with crossfade alphas.
 *
 * Pure w.r.t. app state: media frames come in via the `resolve` callback.
 */

export type MediaResolver = (
  clip: Clip,
) => { asset: MediaAsset; el?: HTMLVideoElement | HTMLImageElement } | undefined

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
    drawTrack(ctx, tracks[i], time, resolve, width, height)
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
): void {
  if (track.kind === 'audio') return // audio tracks have no visual
  const clips = [...track.clips].sort((a, b) => a.start - b.start)
  const active = clips.filter((c) => t >= c.start && t < c.start + c.duration)
  if (active.length === 0) return

  if (active.length === 1) {
    drawClip(ctx, active[0], t, resolve, 1, width, height)
    return
  }

  // Two overlapping clips: crossfade when the earlier one has a transitionOut.
  const a = active[0]
  const b = active[1]
  const span = a.transitionOut ? getTransitionSpan(a, b) : null
  if (span && t >= span.start) {
    const { aAlpha, bAlpha } = transitionAlphas(span, t)
    drawClip(ctx, a, t, resolve, aAlpha, width, height)
    drawClip(ctx, b, t, resolve, bAlpha, width, height)
    return
  }
  // Plain overlap: the later clip wins.
  for (const clip of active) drawClip(ctx, clip, t, resolve, 1, width, height)
}

function drawClip(
  ctx: CanvasRenderingContext2D,
  clip: Clip,
  t: number,
  resolve: MediaResolver,
  alpha: number,
  width: number,
  height: number,
): void {
  // Clip-local time for keyframe evaluation (0 = clip start).
  const local = t - clip.start
  // Clip opacity stacks with the transition alpha — a 50%-opaque clip inside a
  // crossfade draws at alpha*0.5 on every layer (Premiere-style compositing).
  const effective = alpha * animatedValue(clip, 'opacity', local)
  if (effective <= 0) return

  // Color stack: exposure/contrast/saturation/brightness/hue, animated or static.
  const exposure = animatedValue(clip, 'exposure', local)
  const contrast = animatedValue(clip, 'contrast', local)
  const saturation = animatedValue(clip, 'saturation', local)
  const brightness = animatedValue(clip, 'brightness', local)
  const hue = animatedValue(clip, 'hue', local)
  const filter = buildFilter(exposure, contrast, saturation, brightness, hue)

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
    )
    return
  }
  const video = el as HTMLVideoElement
  if (video.readyState >= 2) {
    drawContain(
      ctx,
      video,
      width,
      height,
      effective,
      filter,
      transformed ? { posX, posY, scale } : null,
    )
  }
}

/**
 * The ctx.filter string for the color stack. `none` when every parameter is
 * neutral so the browser skips the filter pass entirely.
 */
export function buildFilter(
  exposure: number,
  contrast: number,
  saturation: number,
  brightness: number,
  hue: number,
): string {
  const parts: string[] = []
  if (brightness !== 1) parts.push(`brightness(${round3(brightness)})`)
  if (contrast !== 1) parts.push(`contrast(${round3(contrast)})`)
  if (saturation !== 1) parts.push(`saturate(${round3(saturation)})`)
  if (hue !== 0) parts.push(`hue-rotate(${round3(hue)}deg)`)
  if (exposure !== 1) parts.push(`brightness(${round3(Math.pow(exposure, 0.5))})`)
  return parts.length === 0 ? 'none' : parts.join(' ')
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

function drawContain(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  width: number,
  height: number,
  alpha: number,
  filter: string,
  transform: { posX: number; posY: number; scale: number } | null,
): void {
  const sw =
    source instanceof HTMLVideoElement
      ? source.videoWidth
      : (source as HTMLImageElement).naturalWidth
  const sh =
    source instanceof HTMLVideoElement
      ? source.videoHeight
      : (source as HTMLImageElement).naturalHeight
  if (!sw || !sh) return
  const scale = transform?.scale ?? 1
  const fit = Math.min(width / sw, height / sh)
  const dw = sw * fit * scale
  const dh = sh * fit * scale
  // Scale grows from the frame center: the offsets come from the SCALED size,
  // so a 2x clip stays centered instead of drifting right and down.
  const dx = (width - dw) / 2 + (transform?.posX ?? 0)
  const dy = (height - dh) / 2 + (transform?.posY ?? 0)
  ctx.save()
  ctx.globalAlpha = alpha
  if (filter !== 'none') ctx.filter = filter
  ctx.drawImage(source, dx, dy, dw, dh)
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
