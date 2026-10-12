import { assetHasAudio } from './links'
import type { MediaAsset } from './types'

/**
 * Proxy planning (0.8.0). A proxy is a lower-resolution A/V stand-in for a
 * heavy source, built once per session and used for preview only; export always
 * reads the original. This module is pure (no browser APIs) so the whole
 * configuration decision runs in Node: which assets qualify, the target size,
 * the codec and bitrate, and whether the transcode carries audio.
 *
 * The AUDIO codec (AAC or Opus) is deliberately NOT decided here: it depends on
 * `canEncodeAudio('aac')`, a browser capability the pure planner cannot see, so
 * the builder selects it at runtime exactly as the exporter does.
 */

/** A source whose long edge exceeds this is eligible for a proxy. */
export const PROXY_QUALIFY_LONG_EDGE = 1920

/** The proxy's maximum long edge, in pixels. */
export const PROXY_MAX_LONG_EDGE = 1280

/** The proxy video bitrate (bits per second), matching the export low tier. */
export const PROXY_VIDEO_BITRATE = 2_500_000

/** What a proxy transcode should produce. */
export interface ProxyPlan {
  width: number
  height: number
  videoCodec: 'avc'
  videoBitrate: number
  /** True when the source has sound, so the proxy must carry it. */
  includeAudio: boolean
}

/** The lifecycle of one asset's proxy. Session-only. */
export type ProxyStatus = 'none' | 'building' | 'ready' | 'failed'

/** One asset's session proxy state (held in the store, never in the Doc). */
export interface ProxyEntry {
  status: ProxyStatus
  /** The proxy object URL, present only while `status` is 'ready'. */
  url?: string
}

/** Rounds to the nearest even integer (>= 2), since H.264 needs even dimensions. */
function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2)
}

/**
 * Aspect-preserving proxy dimensions with the long edge capped at
 * `PROXY_MAX_LONG_EDGE`, both dimensions even. Never upscales.
 */
export function proxyDimensions(width: number, height: number): { width: number; height: number } {
  const long = Math.max(width, height)
  if (!(long > 0)) return { width: 0, height: 0 }
  const scale = Math.min(1, PROXY_MAX_LONG_EDGE / long)
  return { width: even(width * scale), height: even(height * scale) }
}

/** True when an asset is a video whose long edge exceeds the qualify threshold. */
export function shouldProxy(asset: Pick<MediaAsset, 'kind' | 'width' | 'height'>): boolean {
  return asset.kind === 'video' && Math.max(asset.width, asset.height) > PROXY_QUALIFY_LONG_EDGE
}

/** The transcode plan for an asset, or null when it does not qualify. */
export function planProxy(asset: MediaAsset): ProxyPlan | null {
  if (!shouldProxy(asset)) return null
  const { width, height } = proxyDimensions(asset.width, asset.height)
  return {
    width,
    height,
    videoCodec: 'avc',
    videoBitrate: PROXY_VIDEO_BITRATE,
    includeAudio: assetHasAudio(asset),
  }
}
