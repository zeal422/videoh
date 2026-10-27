'use client'

import { useEffect, useMemo, useRef, useState } from 'react'

import { filmstripCanvasFits, filmstripPlan } from '@/lib/editor/filmstrip'
import { releaseFilmstrip, requestFilmstrip } from '@/lib/editor/media/filmstrip-cache'
import type { Clip, MediaAsset } from '@/lib/editor/types'

/**
 * The staggered wait after a trim, rate stretch, zoom, or curve edit before a
 * strip is regenerated. A live gesture changes the key every frame; the
 * debounce keeps that from filling the single generation lane.
 */
export const FILMSTRIP_DEBOUNCE_MS = 140

/**
 * Filmstrip layer inside a clip (0.12.0): sampled source cells for video, the
 * image itself for an image clip, and the poster while the strip loads or when
 * it is unavailable. Never intercepts pointer events; the clip's label,
 * badges, waveform, trim handles, and context menu stay above it.
 */
export function Filmstrip({
  clip,
  asset,
  widthPx,
  height,
}: {
  clip: Clip
  asset: MediaAsset | undefined
  widthPx: number
  height: number
}) {
  const plan = useMemo(
    () => filmstripPlan(clip, asset, widthPx, height),
    [clip, asset, widthPx, height],
  )
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const lastDrawnSourceKey = useRef<string | null>(null)
  const [readyKey, setReadyKey] = useState<string | null>(null)
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

  // A new source window clears the old cells at once; a bucket-only zoom keeps
  // the previous strip stretched under the new width until the replacement
  // lands (fallback order 2).
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
      requestFilmstrip({ clipId: clip.id, plan: activePlan, asset: activeAsset }, (source) => {
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
            setReadyKey(activePlan.key)
            return
          }
        }
        // A poster fallback counts as settled so the timeline's ready marker
        // can advance even when the strip is unavailable.
        setReadyKey(activePlan.key)
      })
    }, FILMSTRIP_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
      // The canvas is remounted for a null plan, so a returning key must not
      // inherit the old "ready" flag while the new strip is still loading.
      setReadyKey(null)
    }
  }, [clip.id, planKey, assetUrl])

  useEffect(() => () => releaseFilmstrip(clip.id), [clip.id])

  if (!plan || !asset) return null

  const fits = filmstripCanvasFits(plan.widthBucket, plan.heightBucket)
  const ready = readyKey === plan.key

  return (
    <div
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
          width={plan.widthBucket}
          height={plan.heightBucket}
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 h-full w-full"
        />
      ) : null}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/55 via-transparent to-black/25"
      />
    </div>
  )
}
