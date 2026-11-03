import { clampSourceTime, sourceTimeAt } from './factories'
import { clamp } from './time'
import type { Clip, MediaAsset } from './types'

/**
 * Filmstrip planning (0.12.0), pure and browser-free.
 *
 * A strip is a fixed sample of the clip's SOURCE window, never a repeated
 * poster: `sourceTimeAt` folds speed, reverse, and the time-remap curve into
 * every cell. The planner only describes the cells and the bounded backing
 * canvas; the runtime cache in `media/filmstrip-cache.ts` draws them.
 */

/** Hard safety bound for a strip's backing width, in pixels. */
export const MAX_STRIP_WIDTH = 4096
/** Hard safety bound for a strip's backing height, in pixels. */
export const MAX_STRIP_HEIGHT = 64
/** One strip may never allocate more than this many backing pixels. */
export const MAX_STRIP_PIXELS = MAX_STRIP_WIDTH * MAX_STRIP_HEIGHT

/** Below this layout width the clip is too narrow to show any cells. */
const MIN_STRIP_WIDTH_PX = 24
/** Width buckets quantize zoom, so a small zoom change reuses the strip. */
const WIDTH_BUCKET_STEP = 64
const MIN_CELLS = 4
const MAX_CELLS = 24

export interface FilmstripBuckets {
  widthBucket: number
  heightBucket: number
}

export interface FilmstripFrame {
  /** Clip-local time (seconds) the cell samples. */
  local: number
  /** Source time (seconds), clamped into the asset. */
  sourceTime: number
  /** Normalized 0..1 center of the cell. */
  x: number
}

export interface FilmstripSamples extends FilmstripBuckets {
  frames: FilmstripFrame[]
  /** Tile left relative to the clip, in layout pixels (0 when not tiled). */
  tileStartPx: number
  /** Tile width in layout pixels. */
  tileWidthPx: number
  /** Ordered source-time window this clip reads (0.18.0). */
  sourceStart: number
  sourceEnd: number
  /**
   * Split-reuse tolerance: just over half one cell's source span (0.18.0).
   * A split re-phases the cell grid, so an exact one-frame lookup would miss
   * every cell of the right half. Half a cell is the sampling granularity the
   * strip already has, and the window above keeps reuse inside the clip.
   */
  cacheTolerance: number
  /** Whether to decode one tile ahead for a future split (0.18.0). */
  prefetch: boolean
}

/** What one clip needs from the runtime cache. */
export interface FilmstripPlan extends FilmstripBuckets {
  kind: 'video' | 'image'
  /** Cache key: source identity plus the capped backing buckets. */
  key: string
  /** Key without the buckets, for the previous-strip fallback. */
  sourceKey: string
  frames: FilmstripFrame[]
  /** Tile left relative to the clip, in layout pixels (0 when not tiled). */
  tileStartPx: number
  /** Tile width in layout pixels. */
  tileWidthPx: number
  /** Ordered source-time window this clip reads (0.18.0). */
  sourceStart: number
  sourceEnd: number
  /** Split-reuse tolerance in source seconds (0.18.0). */
  cacheTolerance: number
  /** Whether to decode one tile ahead for a future split (0.18.0). */
  prefetch: boolean
}

/** The visible part of a clip, relative to its own left edge (0.18.0). */
export interface FilmstripViewport {
  startPx: number
  widthPx: number
  /**
   * False for the bounded head tile of an off-screen clip: nobody can split
   * there yet, so decoding a tile ahead would only delay the ready marker.
   */
  prefetch?: boolean
}

const num = (value: number) => (Number.isFinite(value) ? value.toFixed(4) : '0')

/**
 * Capped backing buckets for a layout size. Width rounds to 64px steps so a
 * zoom inside one step reuses the strip; height is the track row height. Null
 * when the clip is too narrow or the input is not finite.
 */
export function filmstripBuckets(widthPx: number, heightPx: number): FilmstripBuckets | null {
  if (!Number.isFinite(widthPx) || !Number.isFinite(heightPx)) return null
  if (widthPx < MIN_STRIP_WIDTH_PX) return null
  const widthBucket = Math.min(
    MAX_STRIP_WIDTH,
    Math.max(WIDTH_BUCKET_STEP, Math.round(widthPx / WIDTH_BUCKET_STEP) * WIDTH_BUCKET_STEP),
  )
  const heightBucket = Math.min(MAX_STRIP_HEIGHT, Math.max(1, Math.round(heightPx)))
  return { widthBucket, heightBucket }
}

/**
 * Number of cells for a layout width. The bucket is capped BEFORE the count,
 * so a one-hour clip at 400 px/s asks for 24 cells on a 4096px canvas, never a
 * 1,440,000px strip.
 */
export function filmstripFrameCount(widthPx: number): number {
  if (!Number.isFinite(widthPx) || widthPx < MIN_STRIP_WIDTH_PX) return 0
  const widthBucket = Math.min(
    MAX_STRIP_WIDTH,
    Math.max(WIDTH_BUCKET_STEP, Math.round(widthPx / WIDTH_BUCKET_STEP) * WIDTH_BUCKET_STEP),
  )
  return clamp(widthBucket / WIDTH_BUCKET_STEP, MIN_CELLS, MAX_CELLS)
}

/**
 * Video sampling plan. Returns null for anything that has no honest strip:
 * missing/offline media, audio, images (one source frame, handled by the image
 * path), text and compound clips, a zero-length clip, or a clip too narrow to
 * show cells.
 */
export function filmstripSamples(
  clip: Clip,
  asset: MediaAsset | undefined,
  widthPx: number,
  heightPx: number,
  viewport?: FilmstripViewport,
): FilmstripSamples | null {
  if (!asset || asset.missing || asset.kind !== 'video') return null
  if (clip.audioOnly || clip.text !== undefined || clip.sequenceId) return null
  if (!(clip.duration > 0)) return null
  const tile = viewportTile(widthPx, viewport)
  const buckets = filmstripBuckets(tile.widthPx, heightPx)
  if (!buckets) return null
  const count = filmstripFrameCount(tile.widthPx)
  if (count === 0) return null

  const frames: FilmstripFrame[] = []
  for (let i = 0; i < count; i++) {
    const layout = tile.startPx + ((i + 0.5) / count) * tile.widthPx
    const local = clamp((layout / widthPx) * clip.duration, 0, clip.duration)
    frames.push({
      local,
      sourceTime: clampSourceTime(sourceTimeAt(clip, local), asset),
      x: (i + 0.5) / count,
    })
  }
  // The clip's own source window, ordered for reverse clips. Reuse never
  // reaches outside it, so a trimmed head cannot borrow the cut material.
  const sourceStart = clampSourceTime(sourceTimeAt(clip, 0), asset)
  const sourceEnd = clampSourceTime(sourceTimeAt(clip, clip.duration), asset)
  // The visible tile's source span, not the whole clip's: a split keeps the
  // same viewport and zoom, so this span (and the tolerance derived from it)
  // barely moves and the right half's re-phased grid still lands on the left
  // half's cached cells.
  const tileLocalStart = (tile.startPx / widthPx) * clip.duration
  const tileLocalEnd = ((tile.startPx + tile.widthPx) / widthPx) * clip.duration
  const tileSourceStart = clampSourceTime(sourceTimeAt(clip, tileLocalStart), asset)
  const tileSourceEnd = clampSourceTime(sourceTimeAt(clip, tileLocalEnd), asset)
  const cellSpan = Math.abs(tileSourceEnd - tileSourceStart) / count
  return {
    frames,
    widthBucket: buckets.widthBucket,
    heightBucket: buckets.heightBucket,
    tileStartPx: tile.startPx,
    tileWidthPx: tile.widthPx,
    sourceStart: Math.min(sourceStart, sourceEnd),
    sourceEnd: Math.max(sourceStart, sourceEnd),
    cacheTolerance: cellSpan * 0.55,
    prefetch: viewport?.prefetch ?? true,
  }
}

/** The visible tile, clamped into the clip. A bad viewport falls back to full. */
function viewportTile(widthPx: number, viewport?: FilmstripViewport): FilmstripViewport {
  if (!viewport) return { startPx: 0, widthPx }
  const startPx = Math.max(0, Math.min(widthPx, viewport.startPx))
  const width = Math.max(0, Math.min(widthPx - startPx, viewport.widthPx))
  if (!(width > 0)) return { startPx: 0, widthPx }
  return { startPx, widthPx: width }
}

/**
 * A canvas of these buckets must hold no more than MAX_STRIP_PIXELS. The
 * component and the cache both call this before allocating anything.
 */
export function filmstripCanvasFits(widthBucket: number, heightBucket: number): boolean {
  return (
    Number.isFinite(widthBucket) &&
    Number.isFinite(heightBucket) &&
    widthBucket > 0 &&
    heightBucket > 0 &&
    widthBucket * heightBucket <= MAX_STRIP_PIXELS
  )
}

/**
 * Source times to decode beyond the visible tile (0.18.0). A split's right
 * half starts inside the visible tile and reads one tile width further, so
 * the first generation prefetches that span; without it the split seeks the
 * source for every cell past the tile edge.
 */
export function filmstripPrefetchTimes(plan: FilmstripPlan): number[] {
  const frames = plan.frames
  if (frames.length < 2) return []
  const first = frames[0].sourceTime
  const last = frames[frames.length - 1].sourceTime
  const step = Math.abs(last - first) / (frames.length - 1)
  if (!(step > 0)) return []
  const forward = last >= first
  const times: number[] = []
  for (let i = 1; i <= frames.length; i++) {
    const time = forward ? last + step * i : last - step * i
    if (time < plan.sourceStart || time > plan.sourceEnd) break
    times.push(time)
  }
  return times
}

/** The curve identity that changes a video strip when a time remap changes. */
function timeScaleKey(clip: Clip): string {
  const curve = clip.keyframes?.timeScale
  if (!curve || curve.length === 0) return 'none'
  return curve
    .map((keyframe) => {
      const ease = keyframe.easeOut ? keyframe.easeOut.map(num).join('/') : '-'
      return `${num(keyframe.time)}:${num(keyframe.value)}:${keyframe.interpolation ?? 'linear'}:${ease}`
    })
    .join(';')
}

/** Source identity for a strip, without the backing buckets. */
export function filmstripSourceKey(clip: Clip, asset: MediaAsset): string {
  if (asset.kind === 'image') return `image:${asset.id}`
  return [
    'video',
    asset.id,
    num(clip.inPoint),
    num(clip.duration),
    num(clip.speed ?? 1),
    clip.reverse ? '1' : '0',
    timeScaleKey(clip),
  ].join(':')
}

/** Normalize a backing dimension to the capped bucket it belongs to. */
function capWidth(widthBucket: number): number {
  return Math.min(
    MAX_STRIP_WIDTH,
    Math.max(WIDTH_BUCKET_STEP, Math.round(widthBucket / WIDTH_BUCKET_STEP) * WIDTH_BUCKET_STEP),
  )
}

function capHeight(heightBucket: number): number {
  return Math.min(MAX_STRIP_HEIGHT, Math.max(1, Math.round(heightBucket)))
}

/**
 * Runtime cache key. Width and height are normalized to their capped buckets,
 * so two layout widths in one 64px step, and two widths above the cap, share a
 * key. An image key ignores trim, speed, reverse, and curves because one
 * source frame is the honest result.
 */
export function filmstripCacheKey(
  clip: Clip,
  asset: MediaAsset,
  widthBucket: number,
  heightBucket: number,
  tileStartPx = 0,
  tileWidthPx = widthBucket,
): string {
  const base = `${filmstripSourceKey(clip, asset)}:${capWidth(widthBucket)}x${capHeight(heightBucket)}`
  // The untiled key stays byte-identical for existing caches and tests.
  if (tileStartPx === 0 && tileWidthPx === widthBucket) return base
  const startBucket = Math.max(0, Math.round(tileStartPx / WIDTH_BUCKET_STEP) * WIDTH_BUCKET_STEP)
  return `${base}:${startBucket}:${Math.max(1, Math.round(tileWidthPx))}`
}

/**
 * One plan for both media kinds. Video samples the source window; an image
 * (one source frame) reports an empty frame list so the cache draws it once.
 */
export function filmstripPlan(
  clip: Clip,
  asset: MediaAsset | undefined,
  widthPx: number,
  heightPx: number,
  viewport?: FilmstripViewport,
): FilmstripPlan | null {
  if (!asset || asset.missing) return null
  if (clip.audioOnly || clip.text !== undefined || clip.sequenceId) return null
  if (asset.kind === 'image') {
    const buckets = filmstripBuckets(widthPx, heightPx)
    if (!buckets) return null
    return {
      kind: 'image',
      key: filmstripCacheKey(clip, asset, buckets.widthBucket, buckets.heightBucket),
      sourceKey: filmstripSourceKey(clip, asset),
      frames: [],
      ...buckets,
      tileStartPx: 0,
      tileWidthPx: widthPx,
      sourceStart: 0,
      sourceEnd: 0,
      cacheTolerance: 0,
      prefetch: false,
    }
  }
  const samples = filmstripSamples(clip, asset, widthPx, heightPx, viewport)
  if (!samples) return null
  return {
    kind: 'video',
    key: filmstripCacheKey(
      clip,
      asset,
      samples.widthBucket,
      samples.heightBucket,
      // An untiled plan passes the bucketed width, so two clips whose layout
      // widths share a bucket share the base key. A real viewport keeps its
      // tile start and raw tile width.
      viewport ? samples.tileStartPx : 0,
      viewport ? samples.tileWidthPx : samples.widthBucket,
    ),
    sourceKey: filmstripSourceKey(clip, asset),
    ...samples,
  }
}
