'use client'

import { useEffect, useMemo, useRef, useState } from 'react'

import { filmstripCanvasFits, filmstripPlan, type FilmstripViewport } from '@/lib/editor/filmstrip'
import {
  filmstripProgressSnapshot,
  releaseFilmstrip,
  requestFilmstrip,
  subscribeFilmstripProgress,
  type FilmstripProgress,
} from '@/lib/editor/media/filmstrip-cache'
import type { Clip, MediaAsset } from '@/lib/editor/types'

/**
 * The staggered wait after a trim, rate stretch, zoom, or curve edit before a
 * strip is regenerated. A live gesture changes the key every frame; the
 * debounce keeps that from filling the single generation lane.
 */
export const FILMSTRIP_DEBOUNCE_MS = 140
/** Progress bars stay hidden for this long so a fast strip does not flash. */
export const FILMSTRIP_PROGRESS_DELAY_MS = 300
/** Viewport padding, so a small scroll reuses the same tile. */
const VIEWPORT_PAD = 0.25

/**
 * Filmstrip layer inside a clip (0.12.0): sampled source cells for video, the
 * image itself for an image clip, and the poster while the strip loads or when
 * it is unavailable. Never intercepts pointer events; the clip's label,
 * badges, waveform, trim handles, and context menu stay above it.
 *
 * 0.18.0: only the VISIBLE part of a long clip is generated, at layout density,
 * so a 71,000px clip no longer stretches a 4,096px strip. The previous tile
 * stays visible until the replacement lands.
 */
export function Filmstrip({
  clip,
  asset,
  widthPx,
  height,
  fps,
}: {
  clip: Clip
  asset: MediaAsset | undefined
  widthPx: number
  height: number
  /** Project fps, for the one-source-frame cache tolerance. */
  fps: number
}) {
  const [viewport, setViewport] = useState<FilmstripViewport | undefined>()
  const viewportRef = useRef<FilmstripViewport | undefined>(undefined)
  // The root mounts after the plan resolves (the component renders null until
  // then), so the effect must depend on the ELEMENT, not only on widthPx.
  const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null)

  // The visible tile. It is bucketed to 64px and padded, so a scroll inside one
  // bucket reuses the strip instead of re-queueing the same cells. The clip's
  // own box and the scroll viewport give the intersection directly, so the
  // track-header column never offsets the tile.
  useEffect(() => {
    const scrollEl = document.querySelector('[data-timeline-scroll]') as HTMLElement | null
    if (!scrollEl || !rootEl) return
    let raf = 0
    const compute = () => {
      const root = rootEl
      const clipRect = root.getBoundingClientRect()
      const scrollRect = scrollEl.getBoundingClientRect()
      const start = Math.max(0, scrollRect.left - clipRect.left)
      const end = Math.min(widthPx, scrollRect.right - clipRect.left)
      if (end <= start) {
        // No layout yet (jsdom, first paint): keep the untiled plan. A real
        // off-screen clip is different: never fall back to the whole clip, or
        // a 15-minute source decodes its entire width while nobody is looking
        // at it. Generate a bounded head tile instead, so the first scroll
        // into view is already warm.
        if (!(scrollRect.width > 0)) {
          if (viewportRef.current) {
            viewportRef.current = undefined
            setViewport(undefined)
          }
          return
        }
        const head = {
          startPx: 0,
          widthPx: Math.min(widthPx, Math.max(1, scrollRect.width)),
          prefetch: false,
        }
        const previous = viewportRef.current
        if (previous?.startPx === head.startPx && previous?.widthPx === head.widthPx) return
        viewportRef.current = head
        setViewport(head)
        return
      }
      const pad = (end - start) * VIEWPORT_PAD
      const paddedStart = Math.max(0, start - pad)
      const paddedEnd = Math.min(widthPx, end + pad)
      const bucketStart = Math.floor(paddedStart / 64) * 64
      const bucketWidth = Math.ceil((paddedEnd - bucketStart) / 64) * 64
      // A fully visible clip uses the untiled key, so existing caches and the
      // battery's ready marker stay byte-compatible.
      const next =
        bucketStart <= 0 && bucketWidth >= widthPx
          ? undefined
          : { startPx: bucketStart, widthPx: bucketWidth }
      const previous = viewportRef.current
      if (previous?.startPx === next?.startPx && previous?.widthPx === next?.widthPx) return
      viewportRef.current = next
      setViewport(next)
    }
    const schedule = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(compute)
    }
    compute()
    scrollEl.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    return () => {
      cancelAnimationFrame(raf)
      scrollEl.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
    }
  }, [widthPx, rootEl])

  const plan = useMemo(
    () => filmstripPlan(clip, asset, widthPx, height, viewport),
    [clip, asset, widthPx, height, viewport],
  )
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const lastDrawnSourceKey = useRef<string | null>(null)
  const [drawn, setDrawn] = useState<{
    key: string
    startPx: number
    widthPx: number
  } | null>(null)
  // The request identity is the key and the asset URL, not the clip object.
  // A move or a marker edit creates a new clip object but the same source
  // window, so it must reuse the strip without a new request.
  const planRef = useRef(plan)
  const assetRef = useRef(asset)
  useEffect(() => {
    planRef.current = plan
    assetRef.current = asset
  }, [plan, asset])
  const planKey = plan?.key ?? null
  const assetUrl = asset?.url ?? null

  // A new SOURCE window clears the old cells at once; a tile change keeps the
  // previous tile visible until the replacement lands.
  useEffect(() => {
    const sourceKey = plan?.sourceKey
    if (!sourceKey) return
    if (lastDrawnSourceKey.current === sourceKey) return
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height)
  }, [plan?.sourceKey])

  useEffect(() => {
    const activePlan = planRef.current
    const activeAsset = assetRef.current
    if (!activePlan || !activeAsset) {
      releaseFilmstrip(clip.id)
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      if (cancelled) return
      requestFilmstrip({ clipId: clip.id, plan: activePlan, asset: activeAsset, fps }, (source) => {
        if (cancelled) return
        const canvas = canvasRef.current
        if (source && canvas) {
          const ctx = canvas.getContext('2d')
          if (ctx) {
            if (canvas.width !== activePlan.widthBucket) canvas.width = activePlan.widthBucket
            if (canvas.height !== activePlan.heightBucket) canvas.height = activePlan.heightBucket
            ctx.clearRect(0, 0, activePlan.widthBucket, activePlan.heightBucket)
            ctx.drawImage(source, 0, 0)
            lastDrawnSourceKey.current = activePlan.sourceKey
            setDrawn({
              key: activePlan.key,
              startPx: activePlan.tileStartPx,
              widthPx: activePlan.tileWidthPx,
            })
            return
          }
        }
        // A poster fallback counts as settled so the timeline's ready marker
        // can advance even when the strip is unavailable.
        setDrawn({
          key: activePlan.key,
          startPx: activePlan.tileStartPx,
          widthPx: activePlan.tileWidthPx,
        })
      })
    }, FILMSTRIP_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [clip.id, planKey, assetUrl, fps])

  useEffect(() => () => releaseFilmstrip(clip.id), [clip.id])

  // Per-clip progress: the cache reports queued/decoding cells; the bar only
  // appears after a short delay so a fast strip never flashes.
  const [progress, setProgress] = useState<FilmstripProgress | null>(null)
  const [visibleProgressKey, setVisibleProgressKey] = useState<string | null>(null)
  useEffect(() => {
    if (!planKey) return
    const read = () => {
      setProgress(filmstripProgressSnapshot().find((entry) => entry.key === planKey) ?? null)
    }
    read()
    return subscribeFilmstripProgress(read)
  }, [planKey])
  useEffect(() => {
    if (!progress || progress.phase === 'ready') return
    const timer = setTimeout(() => setVisibleProgressKey(progress.key), FILMSTRIP_PROGRESS_DELAY_MS)
    return () => clearTimeout(timer)
  }, [progress?.key, progress?.phase])
  const showProgress =
    !!progress && progress.phase !== 'ready' && visibleProgressKey === progress.key

  if (!plan || !asset) return null

  const fits = filmstripCanvasFits(plan.widthBucket, plan.heightBucket)
  const ready = drawn?.key === plan.key

  return (
    <div
      ref={setRootEl}
      data-filmstrip-ready={ready ? 'true' : 'false'}
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      {asset.thumbnail ? (
        <img
          src={asset.thumbnail}
          alt=""
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-60"
        />
      ) : null}
      {fits ? (
        <canvas
          ref={canvasRef}
          data-testid="filmstrip-canvas"
          width={plan.widthBucket}
          height={plan.heightBucket}
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 h-full"
          style={{
            left: drawn?.startPx ?? plan.tileStartPx,
            width: drawn?.widthPx ?? plan.tileWidthPx,
          }}
        />
      ) : null}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/55 via-transparent to-black/25"
      />
      {showProgress && progress && progress.phase !== 'ready' ? (
        <div
          data-testid="filmstrip-progress"
          role="progressbar"
          aria-label="Thumbnails"
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={progress.completed}
          className="pointer-events-none absolute inset-x-1 bottom-1 z-[3] h-0.5 overflow-hidden rounded bg-black/50"
        >
          <div
            className="h-full bg-foreground/80 transition-[width] duration-150"
            style={{ width: `${(progress.completed / Math.max(1, progress.total)) * 100}%` }}
          />
        </div>
      ) : null}
    </div>
  )
}
