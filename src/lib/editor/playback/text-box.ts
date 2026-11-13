import type { Clip } from '../types'

/**
 * Text bounding-box measurement — the geometry twin of the compositor's
 * `drawTextClip`. Used by the preview panel to draw the dashed selection
 * outline and make "drag the text in the monitor" feel tangible.
 *
 * Mirrors drawTextClip EXACTLY: same font string, same 1.2 line-height,
 * same anchor semantics (canvas textAlign: left/center/right around
 * `style.x * width`), same vertical centering around `style.y * height`.
 * Padding covers the drop shadow so the outline never clips the glow.
 *
 * Returns NORMALIZED coordinates (0..1 of project size) so the UI can
 * position the outline with percentages regardless of canvas scaling.
 * Returns null when measurement is impossible (SSR/jsdom, no 2D context).
 */

export interface NormalizedBox {
  x0: number
  y0: number
  x1: number
  y1: number
}

let measureCtx: CanvasRenderingContext2D | null | undefined

function getMeasureCtx(): CanvasRenderingContext2D | null {
  if (measureCtx === undefined) {
    try {
      measureCtx = document.createElement('canvas').getContext('2d')
    } catch {
      measureCtx = null
    }
  }
  return measureCtx
}

export interface TextLayoutBox {
  x0: number
  y0: number
  x1: number
  y1: number
  /** Box center in project pixels: the rotation and flip origin. */
  centerX: number
  centerY: number
}

/**
 * The text's UNPADDED layout box, in project pixels. `measure` must return the
 * width of one line in the same font the renderer uses. Shared by the dashed
 * outline, the compositor's rotation origin, and the gizmo, so all three place
 * the box identically; shadow padding is added only where the outline needs it.
 */
export function textLayoutBox(
  clip: Pick<Clip, 'text' | 'style'>,
  width: number,
  height: number,
  measure: (line: string) => number,
): TextLayoutBox | null {
  if (clip.text === undefined || !clip.style || width <= 0 || height <= 0) return null
  const style = clip.style
  const lines = clip.text.split('\n')
  const lineHeight = style.fontSize * 1.2
  const totalHeight = lines.length * lineHeight
  const anchorX = style.x * width
  const centerY = style.y * height

  let x0 = Infinity
  let x1 = -Infinity
  for (const line of lines) {
    const w = measure(line)
    const left =
      style.align === 'left' ? anchorX : style.align === 'right' ? anchorX - w : anchorX - w / 2
    x0 = Math.min(x0, left)
    x1 = Math.max(x1, left + w)
  }
  if (!Number.isFinite(x0) || x1 <= x0) return null
  return {
    x0,
    y0: centerY - totalHeight / 2,
    x1,
    y1: centerY + totalHeight / 2,
    centerX: (x0 + x1) / 2,
    centerY,
  }
}

export function measureTextBoxCenter(
  clip: Pick<Clip, 'text' | 'style'>,
  width: number,
  height: number,
): { x: number; y: number } | null {
  const mctx = getMeasureCtx()
  if (!mctx) return null
  const style = clip.style
  if (!style) return null
  mctx.font = `${style.italic ? 'italic ' : ''}${style.bold ? '700' : '400'} ${style.fontSize}px ${style.fontFamily}`
  const box = textLayoutBox(clip, width, height, (line) => mctx.measureText(line).width)
  return box ? { x: box.centerX, y: box.centerY } : null
}

export function measureTextBox(
  clip: Pick<Clip, 'text' | 'style'>,
  width: number,
  height: number,
): NormalizedBox | null {
  const mctx = getMeasureCtx()
  const style = clip.style
  if (!mctx || !style) return null
  mctx.font = `${style.italic ? 'italic ' : ''}${style.bold ? '700' : '400'} ${style.fontSize}px ${style.fontFamily}`
  const box = textLayoutBox(clip, width, height, (line) => mctx.measureText(line).width)
  if (!box) return null

  const pad = style.shadow ? Math.max(4, style.fontSize / 8) + 2 : 2
  return {
    x0: (box.x0 - pad) / width,
    y0: (box.y0 - pad) / height,
    x1: (box.x1 + pad) / width,
    y1: (box.y1 + pad) / height,
  }
}

/** Clamps any value into 0..1 (drag + slider share this contract). */
export function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}
