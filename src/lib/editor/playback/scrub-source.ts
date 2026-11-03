/**
 * scrub-source.ts — the WebCodecs frame source for paused and scrubbing
 * preview (0.18.0).
 *
 * The preview keeps `<video>` elements for playback and audio; this module
 * supplies the frame the compositor draws while paused. A decode is requested
 * per clip and coalesced (one in flight, latest target wins), and the last
 * good frame stays cached so a scrub never clears the canvas to black.
 *
 * Browser-bound: the worker path is preferred, the main-thread sink is the
 * fallback, and `<video>` remains the final fallback in PlaybackCore when
 * WebCodecs is unavailable.
 */

import {
  ALL_FORMATS,
  CanvasSink,
  EncodedPacketSink,
  Input,
  UrlSource,
  type InputVideoTrack,
} from 'mediabunny'

export interface ScrubFrameRequest {
  clipId: string
  assetId: string
  /** The proxy-aware URL playback and export use. */
  effectiveUrl: string
  sourceTime: number
  generation: number
}

export interface ScrubFrameResult {
  clipId: string
  frame: CanvasImageSource
  sourceTime: number
  generation: number
}

export type ScrubFrameListener = (result: ScrubFrameResult) => void
export type ScrubFallbackListener = (assetId: string, effectiveUrl: string) => void

/** The decoder seam: the worker transport or the main-thread mediabunny sink. */
export interface ScrubDecoder {
  decode(request: ScrubFrameRequest): Promise<CanvasImageSource>
  releaseClip(clipId: string): void
  releaseAsset(assetId: string, effectiveUrl: string): void
  reset(): void
  dispose(): void
}

export interface ScrubFrameSource {
  /** False after this asset's WebCodecs decode failed; the caller falls back. */
  hasSink(assetId: string, effectiveUrl: string): boolean
  /** The last good frame for the clip, when its generation still matches. */
  peek(clipId: string, sourceTime: number, generation: number): CanvasImageSource | undefined
  request(request: ScrubFrameRequest, onFrame: ScrubFrameListener): void
  releaseClip(clipId: string): void
  releaseAsset(assetId: string, effectiveUrl: string): void
  reset(): void
  dispose(): void
  /** Fires once per failed asset URL, so PlaybackCore can switch to `<video>`. */
  onFallback(listener: ScrubFallbackListener): () => void
}

interface CachedFrame {
  frame: CanvasImageSource
  sourceTime: number
  generation: number
  url: string
}

interface PendingRequest {
  request: ScrubFrameRequest
  onFrame: ScrubFrameListener
  /** Per-clip release epoch stamped when the request is dequeued. */
  clipEpoch: number
  /** Reset epoch stamped when the request is dequeued. */
  resetEpoch: number
}

function assetKey(assetId: string, url: string): string {
  return `${assetId}\u0000${url}`
}

/** Releases an ImageBitmap; canvases are GC-managed. */
function closeFrame(frame: CanvasImageSource): void {
  if (typeof ImageBitmap !== 'undefined' && frame instanceof ImageBitmap) frame.close()
}

/**
 * A hung WebCodecs decode must not freeze a clip's queue forever. This is a
 * safety net, not a frame budget: a 127 MB long-GOP source can legitimately
 * take several seconds to fetch and decode its first target.
 */
export const SCRUB_DECODE_TIMEOUT_MS = 10_000

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Scrub decode timed out')), ms)
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/**
 * The queue and cache around a decoder. Both the worker and the main-thread
 * sink use this one implementation, so the latest-wins and last-good-frame
 * rules are tested once.
 */
export class ScrubFrameCacheSource implements ScrubFrameSource {
  private cache = new Map<string, CachedFrame>()
  private latest = new Map<string, PendingRequest>()
  private running = new Set<string>()
  private failed = new Set<string>()
  private fallbackListeners = new Set<ScrubFallbackListener>()
  private disposed = false
  /** Per-clip release epochs: a late frame from before a release is stale. */
  private clipEpochs = new Map<string, number>()
  /** Bumped by reset: an in-flight decode from before it must be dropped. */
  private resetEpoch = 0
  /** Requests currently inside `decoder.decode`, for release invalidation. */
  private active = new Map<string, PendingRequest>()

  constructor(private decoder: ScrubDecoder) {}

  hasSink(assetId: string, effectiveUrl: string): boolean {
    return !this.failed.has(assetKey(assetId, effectiveUrl))
  }

  peek(clipId: string, _sourceTime: number, generation: number): CanvasImageSource | undefined {
    const cached = this.cache.get(clipId)
    if (!cached || cached.generation !== generation) return undefined
    return cached.frame
  }

  request(request: ScrubFrameRequest, onFrame: ScrubFrameListener): void {
    if (this.disposed) return
    this.latest.set(request.clipId, {
      request,
      onFrame,
      // Re-stamped at dequeue: this request can wait behind another URL's
      // decode, and releasing that other URL bumps the clip epoch.
      clipEpoch: this.clipEpochs.get(request.clipId) ?? 0,
      resetEpoch: this.resetEpoch,
    })
    if (this.running.has(request.clipId)) return
    this.running.add(request.clipId)
    void this.drain(request.clipId)
  }

  /** True when a release or reset happened after this request was dequeued. */
  private isStale(clipId: string, pending: PendingRequest): boolean {
    return (
      (this.clipEpochs.get(clipId) ?? 0) !== pending.clipEpoch ||
      this.resetEpoch !== pending.resetEpoch
    )
  }

  private async drain(clipId: string): Promise<void> {
    try {
      while (true) {
        const next = this.latest.get(clipId)
        if (!next) break
        this.latest.delete(clipId)
        // Stamp at dequeue, not enqueue. A request can wait behind another
        // decode for the same clip, and releasing that other URL bumps the
        // clip epoch. Only a release after this point makes THIS request stale;
        // a release of its own URL removes it from `latest` above.
        next.clipEpoch = this.clipEpochs.get(clipId) ?? 0
        next.resetEpoch = this.resetEpoch
        this.active.set(clipId, next)
        try {
          const frame = await withTimeout(
            this.decoder.decode(next.request),
            SCRUB_DECODE_TIMEOUT_MS,
          )
          // A release or reset happened while this decode was in flight: drop
          // the frame instead of caching it for a clip that no longer wants it.
          if (this.isStale(clipId, next)) {
            closeFrame(frame)
            continue
          }
          // A newer target arrived while this decode was in flight: drop this
          // frame (closing a bitmap) and decode the latest one instead.
          if (this.latest.has(clipId)) {
            closeFrame(frame)
            continue
          }
          this.replaceCached(clipId, {
            frame,
            sourceTime: next.request.sourceTime,
            generation: next.request.generation,
            url: next.request.effectiveUrl,
          })
          next.onFrame({
            clipId,
            frame,
            sourceTime: next.request.sourceTime,
            generation: next.request.generation,
          })
        } catch {
          // A stale decode's failure must not mark the asset failed, or a
          // release would poison the next URL with a false fallback.
          if (this.isStale(clipId, next)) continue
          if (this.latest.has(clipId)) continue
          const key = assetKey(next.request.assetId, next.request.effectiveUrl)
          if (!this.failed.has(key)) {
            // This URL is on the `<video>` fallback now. Release the decoder's
            // Input so a hung open or decode does not retain it, and so a late
            // frame is dropped instead of leaking.
            this.decoder.releaseAsset(next.request.assetId, next.request.effectiveUrl)
            this.failed.add(key)
            for (const listener of [...this.fallbackListeners]) {
              listener(next.request.assetId, next.request.effectiveUrl)
            }
          }
        } finally {
          if (this.active.get(clipId) === next) this.active.delete(clipId)
        }
      }
    } finally {
      this.running.delete(clipId)
    }
  }

  private replaceCached(clipId: string, next: CachedFrame): void {
    const previous = this.cache.get(clipId)
    if (previous && previous.frame !== next.frame) closeFrame(previous.frame)
    this.cache.set(clipId, next)
  }

  private dropCached(clipId: string): void {
    const previous = this.cache.get(clipId)
    if (!previous) return
    this.cache.delete(clipId)
    closeFrame(previous.frame)
  }

  releaseClip(clipId: string): void {
    this.clipEpochs.set(clipId, (this.clipEpochs.get(clipId) ?? 0) + 1)
    this.latest.delete(clipId)
    this.active.delete(clipId)
    this.dropCached(clipId)
    this.decoder.releaseClip(clipId)
  }

  releaseAsset(assetId: string, effectiveUrl: string): void {
    const key = assetKey(assetId, effectiveUrl)
    this.failed.delete(key)
    for (const [clipId, cached] of [...this.cache]) {
      if (cached.url !== effectiveUrl) continue
      this.cache.delete(clipId)
      closeFrame(cached.frame)
    }
    // Invalidate decodes still using the released URL. Their frames or errors
    // must not land after the Input is disposed or poison the next URL.
    for (const [clipId, pending] of [...this.latest]) {
      if (pending.request.assetId !== assetId) continue
      if (pending.request.effectiveUrl !== effectiveUrl) continue
      this.clipEpochs.set(clipId, (this.clipEpochs.get(clipId) ?? 0) + 1)
      this.latest.delete(clipId)
    }
    for (const [clipId, pending] of [...this.active]) {
      if (pending.request.assetId !== assetId) continue
      if (pending.request.effectiveUrl !== effectiveUrl) continue
      this.clipEpochs.set(clipId, (this.clipEpochs.get(clipId) ?? 0) + 1)
      this.active.delete(clipId)
    }
    this.decoder.releaseAsset(assetId, effectiveUrl)
  }

  reset(): void {
    this.resetEpoch++
    this.clipEpochs.clear()
    this.active.clear()
    for (const cached of this.cache.values()) closeFrame(cached.frame)
    this.cache.clear()
    this.latest.clear()
    this.failed.clear()
    this.decoder.reset()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.reset()
    this.decoder.dispose()
    this.fallbackListeners.clear()
  }

  onFallback(listener: ScrubFallbackListener): () => void {
    this.fallbackListeners.add(listener)
    return () => {
      this.fallbackListeners.delete(listener)
    }
  }
}

/** One mediabunny `Input` per asset URL, one `CanvasSink` per clip. */
class MediabunnyScrubDecoder implements ScrubDecoder {
  private assets = new Map<string, { input: Input; track: InputVideoTrack }>()
  private clips = new Map<string, { sink: CanvasSink; packets: EncodedPacketSink; asset: string }>()
  /** Concurrent opens for one asset share this attempt (0.18.0). */
  private opening = new Map<
    string,
    { attempt: number; promise: Promise<{ key: string; input: Input; track: InputVideoTrack }> }
  >()
  /** Bumped per open; a release or a newer attempt makes the old one stale. */
  private nextAttempt = 1
  /** Bumped by reset: an open that lands afterwards must not install. */
  private generation = 0

  private async getAsset(assetId: string, url: string) {
    const key = assetKey(assetId, url)
    const existing = this.assets.get(key)
    if (existing) return { key, ...existing }
    const pending = this.opening.get(key)
    if (pending) return pending.promise
    const attempt = this.nextAttempt++
    const generation = this.generation
    const promise = (async () => {
      const input = new Input({ formats: ALL_FORMATS, source: new UrlSource(url) })
      try {
        // Bound track discovery. The outer decode race stops waiting at the
        // same deadline, but without this the Input would stay open.
        const track = await withTimeout(input.getPrimaryVideoTrack(), SCRUB_DECODE_TIMEOUT_MS)
        if (!track) throw new Error('No video track')
        if (generation !== this.generation) throw new Error('Scrub source reset')
        // A release deletes this entry; a newer attempt replaces it. Either
        // way this open is stale and must dispose instead of installing.
        if (this.opening.get(key)?.attempt !== attempt) {
          throw new Error('Scrub source asset released')
        }
        this.assets.set(key, { input, track })
        return { key, input, track }
      } catch (error) {
        input.dispose()
        throw error
      }
    })()
    this.opening.set(key, { attempt, promise })
    try {
      return await promise
    } finally {
      // A reset, a release, or a newer attempt may have replaced this entry;
      // never delete the replacement.
      if (this.opening.get(key)?.attempt === attempt) this.opening.delete(key)
    }
  }

  private getClip(asset: string, track: InputVideoTrack, clipId: string) {
    const key = `${asset}\u0000${clipId}`
    const existing = this.clips.get(key)
    if (existing) return existing
    const entry = {
      sink: new CanvasSink(track, { poolSize: 0 }),
      packets: new EncodedPacketSink(track),
      asset,
    }
    this.clips.set(key, entry)
    return entry
  }

  async decode(request: ScrubFrameRequest): Promise<CanvasImageSource> {
    const asset = await this.getAsset(request.assetId, request.effectiveUrl)
    const clip = this.getClip(asset.key, asset.track, request.clipId)
    let wrapped = await clip.sink.getCanvas(request.sourceTime)
    if (!wrapped) {
      // Retry from the preceding keyframe, the one decode policy retry. A
      // source whose first frame starts after 0 has no preceding keyframe:
      // fall back to the first key packet so the clip's head is not a miss.
      const key =
        (await clip.packets.getKeyPacket(request.sourceTime)) ??
        (await clip.packets.getFirstKeyPacket())
      if (key) wrapped = await clip.sink.getCanvas(key.timestamp)
    }
    if (!wrapped) throw new Error('No frame at that timestamp')
    return wrapped.canvas
  }

  releaseClip(clipId: string): void {
    for (const [key, entry] of [...this.clips]) {
      if (key.endsWith(`\u0000${clipId}`)) this.clips.delete(key)
      void entry
    }
  }

  releaseAsset(assetId: string, url: string): void {
    const key = assetKey(assetId, url)
    // Invalidate the pending attempt and remove its entry: the next request
    // must start a fresh open instead of joining a promise that will reject.
    this.opening.delete(key)
    for (const [clipKey, entry] of [...this.clips]) {
      if (entry.asset === key) this.clips.delete(clipKey)
    }
    const asset = this.assets.get(key)
    if (!asset) return
    this.assets.delete(key)
    asset.input.dispose()
  }

  reset(): void {
    this.generation++
    this.opening.clear()
    for (const asset of this.assets.values()) asset.input.dispose()
    this.assets.clear()
    this.clips.clear()
  }

  dispose(): void {
    this.reset()
  }
}

interface WorkerMessage {
  type: 'frame' | 'error'
  requestId: number
  clipId: string
  sourceTime: number
  generation: number
  bitmap?: ImageBitmap
  message?: string
}

interface PendingDecode {
  clipId: string
  assetId: string
  url: string
  resolve: (frame: CanvasImageSource) => void
  reject: (error: Error) => void
}

/** Posts decode requests to the module worker and resolves the bitmaps. */
class WorkerScrubDecoder implements ScrubDecoder {
  private pending = new Map<number, PendingDecode>()
  private nextId = 1

  constructor(private worker: Worker) {
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const data = event.data
      const pending = this.pending.get(data.requestId)
      if (!pending) {
        if (data.bitmap) data.bitmap.close()
        return
      }
      this.pending.delete(data.requestId)
      if (data.type === 'frame' && data.bitmap) {
        pending.resolve(data.bitmap)
      } else {
        pending.reject(new Error(data.message ?? 'Scrub decode failed'))
      }
    }
    worker.onerror = () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error('Scrub worker failed'))
      }
      this.pending.clear()
    }
  }

  /**
   * Reject requests the worker will drop. Without this, a released decode's
   * promise and its pending entry outlive the release until the timeout, and
   * a late frame resolves a promise nobody can close.
   */
  private abortMatching(match: (pending: PendingDecode) => boolean, message: string): void {
    for (const [requestId, pending] of [...this.pending]) {
      if (!match(pending)) continue
      this.pending.delete(requestId)
      pending.reject(new Error(message))
    }
  }

  decode(request: ScrubFrameRequest): Promise<CanvasImageSource> {
    const requestId = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, {
        clipId: request.clipId,
        assetId: request.assetId,
        url: request.effectiveUrl,
        resolve,
        reject,
      })
      this.worker.postMessage({
        type: 'decode',
        requestId,
        clipId: request.clipId,
        assetId: request.assetId,
        url: request.effectiveUrl,
        sourceTime: request.sourceTime,
        generation: request.generation,
      })
    })
  }

  releaseClip(clipId: string): void {
    this.abortMatching((pending) => pending.clipId === clipId, 'Scrub source clip released')
    this.worker.postMessage({ type: 'releaseClip', clipId })
  }

  releaseAsset(assetId: string, url: string): void {
    this.abortMatching(
      (pending) => pending.assetId === assetId && pending.url === url,
      'Scrub source asset released',
    )
    this.worker.postMessage({ type: 'releaseAsset', assetId, url })
  }

  reset(): void {
    this.abortMatching(() => true, 'Scrub source reset')
    this.worker.postMessage({ type: 'reset' })
  }

  dispose(): void {
    this.worker.postMessage({ type: 'dispose' })
    this.worker.terminate()
    this.abortMatching(() => true, 'Scrub source disposed')
  }
}

/**
 * The app's scrub source. Returns null when WebCodecs is unavailable, which
 * keeps the existing `<video>` behavior. The worker path needs OffscreenCanvas;
 * browsers without it use the main-thread sink, and a browser with neither
 * falls back to `<video>` in PlaybackCore.
 */
export function createScrubFrameSource(): ScrubFrameSource | null {
  if (typeof window === 'undefined') return null
  if (typeof VideoDecoder === 'undefined') return null
  if (typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined') {
    try {
      const worker = new Worker(new URL('./scrub-worker.ts', import.meta.url), { type: 'module' })
      return new ScrubFrameCacheSource(new WorkerScrubDecoder(worker))
    } catch {
      // Bundler or worker construction failed: use the main-thread sink.
    }
  }
  return new ScrubFrameCacheSource(new MediabunnyScrubDecoder())
}
