/**
 * Chroma-key math (0.8.6): Ultra-Key-lite. Pure functions over RGBA buffers,
 * shared by the preview compositor and the export executor (the `lut.ts`
 * precedent). Pure TypeScript, no browser APIs.
 *
 * Pipeline per pixel: RGB to YCbCr (BT.601 full range), euclidean distance
 * in the (Cb,Cr) plane normalized by the plane maximum, similarity/blend
 * smoothstep ramp with a hard-step fallback on degenerate intervals, the
 * clip-black/clip-white remap (hard step on equal thresholds), then despill.
 */
import { CHROMA_EPS, CHROMA_PLANE_MAX } from './constants'

const EPS = CHROMA_EPS

/** Parse `#rrggbb` (or short `#rgb`) to 0..255 channels. Undefined when malformed. */
export function parseKeyColor(key: string): [number, number, number] | undefined {
  if (typeof key !== 'string') return undefined
  const m = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/.exec(key.trim())
  if (!m) return undefined
  const hex = m[1]
  const full =
    hex.length === 3
      ? hex
          .split('')
          .map((c) => c + c)
          .join('')
      : hex
  const n = parseInt(full, 16)
  if (!Number.isFinite(n)) return undefined
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** BT.601 full-range luma. */
export function rgbToY(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b
}

/** BT.601 full-range chroma, centered on 128. */
export function rgbToCbCr(r: number, g: number, b: number): [number, number] {
  return [128 - 0.168736 * r - 0.331264 * g + 0.5 * b, 128 + 0.5 * r - 0.418688 * g - 0.081312 * b]
}

/** Chroma-plane distance, normalized to 0..1. */
export function chromaDistance(
  r: number,
  g: number,
  b: number,
  keyR: number,
  keyG: number,
  keyB: number,
): number {
  const [cb, cr] = rgbToCbCr(r, g, b)
  const [kcb, kcr] = rgbToCbCr(keyR, keyG, keyB)
  return Math.hypot(cb - kcb, cr - kcr) / CHROMA_PLANE_MAX
}

/** Smoothstep in 0..1, clamped. */
function smooth01(x: number): number {
  const t = Math.min(1, Math.max(0, x))
  return t * t * (3 - 2 * t)
}

/**
 * Key alpha for a normalized distance: transparent at or below similarity,
 * opaque at or above similarity + blend * (1 - similarity), smooth between.
 * A degenerate interval (blend zero, or similarity one) is a hard step.
 */
export function keyAlpha(dN: number, similarity: number, blend: number): number {
  const a0 = similarity
  const a1 = similarity + blend * (1 - similarity)
  if (a1 <= a0) return dN <= a0 ? 0 : 1
  return smooth01((dN - a0) / (a1 - a0))
}

/**
 * Clip-black/clip-white remap of a key alpha. Equal thresholds are a hard
 * step by definition; tests assert the step, not the epsilon arithmetic.
 */
export function applyClipRange(alpha: number, clipBlack: number, clipWhite: number): number {
  if (clipWhite <= clipBlack) return alpha > clipBlack ? 1 : 0
  return Math.min(1, Math.max(0, (alpha - clipBlack) / Math.max(clipWhite - clipBlack, EPS)))
}

export interface ChromaKeyParams {
  key: [number, number, number]
  similarity: number
  blend: number
  clipBlack: number
  clipWhite: number
  despill: number
}

/**
 * Key one RGBA buffer in place: alpha scales by the key alpha, green spills
 * toward max(r, b) proportional to despill * excess * (1 - alpha).
 * A malformed key color is a no-op (callers validate; this never throws).
 */
export function applyChromaKeyToRgba(data: Uint8ClampedArray, params: ChromaKeyParams): void {
  const [keyR, keyG, keyB] = params.key
  const { similarity, blend, clipBlack, clipWhite, despill } = params
  for (let i = 0; i + 3 < data.length; i += 4) {
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    const dN = chromaDistance(r, g, b, keyR, keyG, keyB)
    const ramp = keyAlpha(dN, similarity, blend)
    const alpha = applyClipRange(ramp, clipBlack, clipWhite)
    data[i + 3] = Math.round(data[i + 3] * alpha)
    if (despill > 0 && alpha < 1) {
      const excess = Math.max(0, g - Math.max(r, b))
      data[i + 1] = Math.max(0, Math.min(255, Math.round(g - despill * excess * (1 - alpha))))
    }
  }
}

/**
 * Build a mask value (0..255) from a rendered source pixel.
 * Reverse flips the mask. Pure, shared by both paths.
 */
export function maskValue(
  r: number,
  g: number,
  b: number,
  a: number,
  mode: 'luma' | 'alpha',
  reverse: boolean,
): number {
  const v = mode === 'luma' ? rgbToY(r, g, b) : a
  return reverse ? 255 - v : v
}

/**
 * Turn a rendered source buffer into a white silhouette mask in place: RGB
 * to white, alpha from the mask value. The source channels MUST be read
 * before the write (a write-then-read loop would key on its own white and
 * every mask would come out fully opaque). Shared by both render paths.
 */
export function buildMatteMask(
  data: Uint8ClampedArray,
  mode: 'luma' | 'alpha',
  reverse: boolean,
): void {
  for (let i = 0; i + 3 < data.length; i += 4) {
    const m = maskValue(data[i], data[i + 1], data[i + 2], data[i + 3], mode, reverse)
    data[i] = 255
    data[i + 1] = 255
    data[i + 2] = 255
    data[i + 3] = m
  }
}
