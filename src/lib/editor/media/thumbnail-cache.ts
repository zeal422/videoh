/**
 * thumbnail-cache.ts — per-asset source-time thumbnail cache (0.18.0).
 *
 * The old filmstrip cache keyed strips by clip `inPoint`/`duration`, so a split
 * threw both halves' strips away. This cache stores decoded thumbnails by
 * asset and SOURCE time, so a split can reuse the frames it already has and
 * only decode the missing cells.
 *
 * Browser-bound: it uses mediabunny's `CanvasSink` on the main thread. The
 * decode itself runs through WebCodecs asynchronously; the compose loop yields
 * between cells so the UI stays responsive.
 */

import { ALL_FORMATS, CanvasSink, Input, UrlSource, type InputVideoTrack } from 'mediabunny'

/** Cache height. A thumbnail is a filmstrip cell, not a full frame. */
export const THUMBNAIL_HEIGHT = 72
/** Cache budget in backing pixels (about 32 MB at 4 bytes per pixel). */
export const THUMBNAIL_CACHE_PIXELS = 8_000_000
/** How many frames one asset may hold before the oldest are evicted. */
export const THUMBNAIL_ASSET_FRAMES = 512
/**
 * Safety net for a decoder that never settles. The filmstrip queue runs one
 * job at a time, so a hung track lookup or timestamp iterator must not block
 * every later strip. This is not a per-cell budget.
 */
export const THUMBNAIL_DECODE_TIMEOUT_MS = 15_000

export interface ThumbnailFrame {
  sourceTime: number
  frame: CanvasImageSource
  width: number
  height: number
  pixels: number
}

export interface ThumbnailProgress {
  completed: number
  total: number
}

/**
 * The source-time range a clip actually reads. Reuse never reaches outside it:
 * a trimmed clip must not borrow a frame from the material its head cut away.
 */
export interface SourceWindow {
  start: number
  end: number
}

interface AssetEntry {
  url: string
  frames: ThumbnailFrame[]
}

function frameSize(frame: CanvasImageSource): { width: number; height: number } {
  const sized = frame as { width?: number; height?: number }
  return { width: sized.width ?? 0, height: sized.height ?? 0 }
}

function closeFrame(frame: CanvasImageSource): void {
  if (typeof ImageBitmap !== 'undefined' && frame instanceof ImageBitmap) frame.close()
}

type ThumbnailInputEntry = {
  input: Input
  track: InputVideoTrack
  sink: CanvasSink
}

/**
 * One decode run's ownership of the Input it opens. Mediabunny cancels
 * ongoing reads when an Input is disposed, so a timeout or reset must be able
 * to dispose it before the track lookup registers it in the shared map.
 */
class DecodeRun {
  cancelled = false
  private owned: { input: Input; registered: boolean } | null = null

  constructor(
    readonly assetId: string,
    private inputs: Map<string, ThumbnailInputEntry>,
    private isLatest: () => boolean,
  ) {}

  /** Claims the Input before its track lookup is awaited. */
  claim(input: Input): void {
    this.owned = { input, registered: false }
  }

  /** The shared map owns the Input now; reset or eviction disposes it. */
  registered(input: Input): void {
    if (this.owned?.input === input) this.owned.registered = true
  }

  /**
   * Cancels this run. An unregistered Input is disposed at once, which also
   * cancels its pending lookup. A registered Input is disposed only while this
   * is still the newest run, so a replacement decode can keep using it.
   */
  cancel(): void {
    this.cancelled = true
    const owned = this.owned
    this.owned = null
    if (!owned || (owned.registered && !this.isLatest())) return
    if (this.inputs.get(this.assetId)?.input === owned.input) this.inputs.delete(this.assetId)
    owned.input.dispose()
  }

  /** The run settled normally; the shared cache keeps the Input. */
  finish(): void {
    this.owned = null
  }
}

/** The run was cancelled by a drop or reset, not by a decode fault. */
class ThumbnailDecodeCancelledError extends Error {
  constructor() {
    super('Thumbnail decode cancelled')
    this.name = 'ThumbnailDecodeCancelledError'
  }
}

/** The run exceeded its bound. Unlike cancellation, this is a real failure. */
class ThumbnailDecodeTimeoutError extends Error {
  constructor() {
    super('Thumbnail decode timed out')
    this.name = 'ThumbnailDecodeTimeoutError'
  }
}

/** Bounds one decode run; a late result is closed instead of leaking frames. */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onLate?: (value: T) => void,
  onTimeout?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  if (onLate) {
    void promise
      .then((value) => {
        if (timedOut) onLate(value)
      })
      .catch(() => undefined)
  }
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        onTimeout?.()
        reject(new ThumbnailDecodeTimeoutError())
      }, ms)
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/** The cache. `null` decoder support means the caller keeps the old path. */
export class ThumbnailCache {
  private assets = new Map<string, AssetEntry>()
  private inputs = new Map<string, ThumbnailInputEntry>()
  /** Decode runs that may still own an unregistered Input. */
  private runs = new Set<DecodeRun>()
  private totalPixels = 0
  /** Bumped by dropAsset: a decode from before the drop must not insert. */
  private assetEpochs = new Map<string, number>()
  /** Bumped by reset: every decode from before it must not insert. */
  private resetEpoch = 0
  /** The newest ensure per asset; an older run drops its late frames. */
  private nextRun = 1
  private latestRun = new Map<string, number>()

  constructor(
    private decodeFrame: (
      assetId: string,
      url: string,
      sourceTimes: readonly number[],
      inputs: Map<string, ThumbnailInputEntry>,
      run?: DecodeRun,
    ) => Promise<ThumbnailFrame[]> = decodeThumbnailFrame,
    private enabled = typeof VideoDecoder !== 'undefined',
  ) {}

  /** True when this environment can decode thumbnails with WebCodecs. */
  get available(): boolean {
    return this.enabled
  }

  private releaseAsset(assetId: string): void {
    const entry = this.assets.get(assetId)
    if (entry) {
      for (const frame of entry.frames) {
        this.totalPixels -= frame.pixels
        closeFrame(frame.frame)
      }
      this.assets.delete(assetId)
    }
    const input = this.inputs.get(assetId)
    if (input) {
      this.inputs.delete(assetId)
      input.input.dispose()
    }
  }

  /** Drops one asset's frames and Input (relink, proxy change, removal). */
  dropAsset(assetId: string, url?: string): void {
    const entry = this.assets.get(assetId)
    if (url !== undefined && entry && entry.url !== url) return
    this.assetEpochs.set(assetId, (this.assetEpochs.get(assetId) ?? 0) + 1)
    for (const run of [...this.runs]) {
      if (run.assetId === assetId) run.cancel()
    }
    this.releaseAsset(assetId)
  }

  /** True when this ensure is still the newest run and nothing dropped it. */
  private isCurrentRun(
    assetId: string,
    runId: number,
    assetEpoch: number,
    resetEpoch: number,
  ): boolean {
    return (
      this.latestRun.get(assetId) === runId &&
      (this.assetEpochs.get(assetId) ?? 0) === assetEpoch &&
      this.resetEpoch === resetEpoch
    )
  }

  private evict(): void {
    while (this.totalPixels > THUMBNAIL_CACHE_PIXELS || this.assets.size > 16) {
      const oldest = this.assets.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.releaseAsset(oldest)
    }
  }

  private insert(assetId: string, url: string, frame: ThumbnailFrame): void {
    let entry = this.assets.get(assetId)
    if (entry && entry.url !== url) {
      this.releaseAsset(assetId)
      entry = undefined
    }
    if (!entry) {
      entry = { url, frames: [] }
      this.assets.set(assetId, entry)
    }
    // A repeat read of the same source time replaces the old frame.
    const index = entry.frames.findIndex(
      (existing) => Math.abs(existing.sourceTime - frame.sourceTime) < 1e-6,
    )
    if (index >= 0) {
      const previous = entry.frames[index]
      this.totalPixels -= previous.pixels
      closeFrame(previous.frame)
      entry.frames[index] = frame
    } else {
      entry.frames.push(frame)
      entry.frames.sort((a, b) => a.sourceTime - b.sourceTime)
    }
    this.totalPixels += frame.pixels
    // Evict the frame farthest in SOURCE time from the one just inserted, not
    // the lowest time. A forward clip that hits the cap must keep the frames
    // around the playhead it is currently sampling; shift() threw those away
    // from the head first and made the cache churn on the visible region.
    while (entry.frames.length > THUMBNAIL_ASSET_FRAMES) {
      let farthest = 0
      for (let index = 1; index < entry.frames.length; index++) {
        const distance = Math.abs(entry.frames[index].sourceTime - frame.sourceTime)
        const best = Math.abs(entry.frames[farthest].sourceTime - frame.sourceTime)
        if (distance > best) farthest = index
      }
      const [removed] = entry.frames.splice(farthest, 1)
      if (!removed) break
      this.totalPixels -= removed.pixels
      closeFrame(removed.frame)
    }
    this.evict()
  }

  /** The nearest cached frame within `tolerance` seconds, or undefined. */
  nearest(
    assetId: string,
    url: string,
    sourceTime: number,
    tolerance: number,
    window?: SourceWindow,
  ): ThumbnailFrame | undefined {
    const entry = this.assets.get(assetId)
    if (!entry || entry.url !== url || entry.frames.length === 0) return undefined
    let best: ThumbnailFrame | undefined
    let bestDistance = Infinity
    for (const frame of entry.frames) {
      if (window && (frame.sourceTime < window.start || frame.sourceTime > window.end)) continue
      const distance = Math.abs(frame.sourceTime - sourceTime)
      if (distance < bestDistance) {
        best = frame
        bestDistance = distance
      }
      if (frame.sourceTime > sourceTime && distance > bestDistance) break
    }
    return bestDistance <= tolerance ? best : undefined
  }

  /**
   * Decodes the requested source times that are not already cached. Missing
   * times are grouped into contiguous runs, so one keyframe-to-cell sweep
   * serves a whole run.
   */
  async ensure(
    assetId: string,
    url: string,
    sourceTimes: readonly number[],
    tolerance: number,
    onProgress?: (progress: ThumbnailProgress) => void,
    window?: SourceWindow,
  ): Promise<void> {
    if (!this.available || sourceTimes.length === 0) return
    const entry = this.assets.get(assetId)
    if (entry && entry.url !== url) this.releaseAsset(assetId)
    // A newer ensure supersedes this one. A drop or reset invalidates it too.
    const runId = this.nextRun++
    this.latestRun.set(assetId, runId)
    const assetEpoch = this.assetEpochs.get(assetId) ?? 0
    const resetEpoch = this.resetEpoch
    const missing = sourceTimes
      .filter((time) => !this.nearest(assetId, url, time, tolerance, window))
      .sort((a, b) => a - b)
    if (missing.length === 0) return

    // Contiguous runs: a gap of more than one second starts a new decode.
    const runs: number[][] = []
    for (const time of missing) {
      const current = runs[runs.length - 1]
      if (current && time - current[current.length - 1] <= 1) current.push(time)
      else runs.push([time])
    }
    let completed = 0
    const total = missing.length
    for (const times of runs) {
      const decodeRun = new DecodeRun(
        assetId,
        this.inputs,
        () => this.latestRun.get(assetId) === runId,
      )
      this.runs.add(decodeRun)
      let frames: ThumbnailFrame[]
      try {
        frames = await withTimeout(
          this.decodeFrame(assetId, url, times, this.inputs, decodeRun),
          THUMBNAIL_DECODE_TIMEOUT_MS,
          (late) => {
            for (const frame of late) closeFrame(frame.frame)
          },
          () => decodeRun.cancel(),
        )
      } catch (error) {
        // A drop or reset cancels the run; the caller no longer wants these
        // frames. That is not a decode failure, so a stale run resolves. A
        // timeout or a genuine decode error still rejects.
        if (
          error instanceof ThumbnailDecodeCancelledError &&
          !this.isCurrentRun(assetId, runId, assetEpoch, resetEpoch)
        ) {
          return
        }
        throw error
      } finally {
        this.runs.delete(decodeRun)
        decodeRun.finish()
      }
      // The asset was dropped or relinked, or a newer ensure started, while
      // this decode ran. Inserting now would repopulate the old URL and can
      // evict the new URL's entry, so close the frames and stop.
      if (!this.isCurrentRun(assetId, runId, assetEpoch, resetEpoch)) {
        for (const frame of frames) closeFrame(frame.frame)
        return
      }
      for (const frame of frames) {
        this.insert(assetId, url, frame)
      }
      completed += times.length
      onProgress?.({ completed, total })
    }
  }

  reset(): void {
    this.resetEpoch++
    for (const run of [...this.runs]) run.cancel()
    this.runs.clear()
    for (const assetId of [...this.assets.keys()]) this.releaseAsset(assetId)
    for (const input of this.inputs.values()) input.input.dispose()
    this.inputs.clear()
    this.totalPixels = 0
    this.assetEpochs.clear()
    this.latestRun.clear()
  }

  dispose(): void {
    this.reset()
  }
}

/**
 * The main-thread mediabunny decoder. One `Input` and `CanvasSink` per asset;
 * `canvasesAtTimestamps` decodes a sorted run with one packet pass.
 */
async function decodeThumbnailFrame(
  assetId: string,
  url: string,
  sourceTimes: readonly number[],
  inputs: Map<string, ThumbnailInputEntry>,
  run?: DecodeRun,
): Promise<ThumbnailFrame[]> {
  try {
    let entry = inputs.get(assetId)
    if (entry && entry.input.source instanceof UrlSource) {
      // The URL is the cache identity; a changed URL is a new Input.
      const sourceUrl = (entry.input.source as { url?: string }).url
      if (sourceUrl !== undefined && sourceUrl !== url) {
        entry.input.dispose()
        inputs.delete(assetId)
        entry = undefined
      }
    }
    if (!entry) {
      if (run?.cancelled) throw new ThumbnailDecodeCancelledError()
      const input = new Input({ formats: ALL_FORMATS, source: new UrlSource(url) })
      // Own the Input across the lookup, before it is registered in the shared
      // map. A timeout or reset can then dispose it, which cancels the lookup
      // and stops a late result from installing a dead Input.
      run?.claim(input)
      try {
        const track = await input.getPrimaryVideoTrack()
        if (run?.cancelled) throw new ThumbnailDecodeCancelledError()
        if (!track) throw new Error('No video track')
        const sink = new CanvasSink(track, { height: THUMBNAIL_HEIGHT, fit: 'cover', poolSize: 0 })
        entry = { input, track, sink }
        inputs.set(assetId, entry)
        run?.registered(input)
      } catch (error) {
        input.dispose()
        throw error
      }
    }

    const frames: ThumbnailFrame[] = []
    let index = 0
    for await (const wrapped of entry.sink.canvasesAtTimestamps(sourceTimes)) {
      if (run?.cancelled) break
      const requested = sourceTimes[index]
      index += 1
      if (!wrapped) continue
      const { width, height } = frameSize(wrapped.canvas)
      frames.push({
        sourceTime: requested,
        frame: wrapped.canvas,
        width,
        height,
        pixels: width * height,
      })
    }
    return frames
  } catch (error) {
    if (run?.cancelled) throw new ThumbnailDecodeCancelledError()
    throw error
  }
}
