import { getTransitionSpan, transitionAlphas } from '../transition'
import type { Clip, Doc, MediaAsset, Track } from '../types'

/**
 * Canvas compositor — draws one frame of the doc at time `t`.
 *
 * Rendering rules:
 * - Tracks composite bottom→top (tracks[0] is the topmost layer).
 * - Video/image clips are drawn contain-fit (black bars preserved).
 * - Text clips render their styled text.
 * - Crossfades: when clip A (with transitionOut) overlaps clip B, both are
 *   drawn with complementary alpha across the transition span.
 * - Clip `opacity` (0..1, default 1) multiplies into every draw and stacks
 *   with crossfade alphas — higher tracks can see through to lower ones.
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
  // Clip opacity stacks with the transition alpha — a 50%-opaque clip inside a
  // crossfade draws at alpha*0.5 on every layer (Premiere-style compositing).
  const effective = alpha * (clip.opacity ?? 1)
  if (effective <= 0) return

  if (clip.text !== undefined && clip.style) {
    drawTextClip(ctx, clip, width, height, effective)
    return
  }

  const resolved = resolve(clip)
  if (!resolved) return // missing media → black
  const { asset, el } = resolved
  if (!el) return

  if (asset.kind === 'image') {
    drawContain(ctx, el as HTMLImageElement, width, height, effective)
    return
  }
  const video = el as HTMLVideoElement
  if (video.readyState >= 2) {
    drawContain(ctx, video, width, height, effective)
  }
}

function drawContain(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  width: number,
  height: number,
  alpha: number,
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
  const scale = Math.min(width / sw, height / sh)
  const dw = sw * scale
  const dh = sh * scale
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.drawImage(source, (width - dw) / 2, (height - dh) / 2, dw, dh)
  ctx.restore()
}

function drawTextClip(
  ctx: CanvasRenderingContext2D,
  clip: Clip,
  width: number,
  height: number,
  alpha: number,
): void {
  const style = clip.style!
  const text = clip.text ?? ''
  ctx.save()
  ctx.globalAlpha = alpha
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
