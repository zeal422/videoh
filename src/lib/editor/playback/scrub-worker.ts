/// <reference lib="webworker" />

/**
 * scrub-worker.ts — the module worker behind `scrub-source.ts` (0.18.0).
 *
 * One mediabunny `Input` per asset URL and one `CanvasSink` per clip. Decodes
 * are coalesced per clip (latest target wins) and frames leave as transferred
 * `ImageBitmap`s. The worker never reads the editor store; the main thread
 * sends the effective URL with every request.
 */

import {
  ALL_FORMATS,
  CanvasSink,
  EncodedPacketSink,
  Input,
  UrlSource,
  type InputVideoTrack,
} from 'mediabunny'

interface DecodeRequest {
  type: 'decode'
  requestId: number
  clipId: string
  assetId: string
  url: string
  sourceTime: number
  generation: number
}

type IncomingMessage =
  | DecodeRequest
  | { type: 'releaseClip'; clipId: string }
  | { type: 'releaseAsset'; assetId: string; url: string }
  | { type: 'reset' }
  | { type: 'dispose' }

interface AssetEntry {
  input: Input
  track: InputVideoTrack
  clips: Map<string, { sink: CanvasSink; packets: EncodedPacketSink }>
}

const scope = self as unknown as DedicatedWorkerGlobalScope
/** Safety net for a hung decoder; not a per-frame budget (see scrub-source). */
export const DECODE_TIMEOUT_MS = 10_000
const assets = new Map<string, AssetEntry>()
const latest = new Map<string, DecodeRequest>()
const running = new Set<string>()
/** Per-clip release epochs: a late frame from before a release is stale. */
const clipEpochs = new Map<string, number>()
/** Requests currently inside `decode`, for release invalidation. */
const active = new Map<string, DecodeRequest>()
/** Bumped by reset: an in-flight decode from before it must be dropped. */
let resetEpoch = 0
/** Concurrent opens for one asset share this attempt (0.18.0). */
const opening = new Map<string, { attempt: number; promise: Promise<AssetEntry> }>()
/** Bumped per open; a release or a newer attempt makes the old one stale. */
let nextAttempt = 1
/** Bumped by reset: an open that lands afterwards must not install. */
let generation = 0

function assetKey(assetId: string, url: string): string {
  return `${assetId}\u0000${url}`
}

/** Bounds an open or a frame decode; the underlying mediabunny work is not cancellable. */
function withTimeout<T>(promise: Promise<T>, ms: number, onLate?: (value: T) => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  if (onLate) {
    // A timeout does not stop the underlying promise. Close a frame that
    // arrives after the race, or the worker leaks an ImageBitmap nobody owns.
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
        reject(new Error('Scrub decode timed out'))
      }, ms)
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

async function getAsset(assetId: string, url: string): Promise<AssetEntry> {
  const key = assetKey(assetId, url)
  const existing = assets.get(key)
  if (existing) return existing
  const pending = opening.get(key)
  if (pending) return pending.promise
  const attempt = nextAttempt++
  const startedAt = generation
  const promise = (async () => {
    const input = new Input({ formats: ALL_FORMATS, source: new UrlSource(url) })
    try {
      // Track discovery can stall on a broken source. Bound it so the Input
      // is disposed and the worker queue does not stay stuck on this clip.
      const track = await withTimeout(input.getPrimaryVideoTrack(), DECODE_TIMEOUT_MS)
      if (!track) throw new Error('No video track')
      if (startedAt !== generation) throw new Error('Scrub worker reset')
      // A release deletes this entry; a newer attempt replaces it. Either way
      // this open is stale and must dispose instead of installing.
      if (opening.get(key)?.attempt !== attempt) throw new Error('Scrub worker asset released')
      const entry: AssetEntry = { input, track, clips: new Map() }
      assets.set(key, entry)
      return entry
    } catch (error) {
      input.dispose()
      throw error
    }
  })()
  opening.set(key, { attempt, promise })
  try {
    return await promise
  } finally {
    // A reset, a release, or a newer attempt may have replaced this entry;
    // never delete the replacement.
    if (opening.get(key)?.attempt === attempt) opening.delete(key)
  }
}

function getClip(entry: AssetEntry, clipId: string) {
  let clip = entry.clips.get(clipId)
  if (!clip) {
    clip = {
      sink: new CanvasSink(entry.track, { poolSize: 0 }),
      packets: new EncodedPacketSink(entry.track),
    }
    entry.clips.set(clipId, clip)
  }
  return clip
}

async function decodeAt(
  entry: AssetEntry,
  request: DecodeRequest,
  sourceTime: number,
): Promise<ImageBitmap> {
  const clip = getClip(entry, request.clipId)
  const wrapped = await withTimeout(clip.sink.getCanvas(sourceTime), DECODE_TIMEOUT_MS)
  if (!wrapped) throw new Error('No frame at that timestamp')
  if (typeof OffscreenCanvas !== 'undefined' && wrapped.canvas instanceof OffscreenCanvas) {
    return wrapped.canvas.transferToImageBitmap()
  }
  return createImageBitmap(wrapped.canvas)
}

async function decode(request: DecodeRequest): Promise<ImageBitmap> {
  const entry = await getAsset(request.assetId, request.url)
  try {
    return await decodeAt(entry, request, request.sourceTime)
  } catch (firstError) {
    // One retry from the preceding keyframe, then the main thread falls back
    // to the `<video>` element for this asset.
    const clip = getClip(entry, request.clipId)
    const key =
      (await clip.packets.getKeyPacket(request.sourceTime)) ??
      (await clip.packets.getFirstKeyPacket())
    if (!key) throw firstError
    return decodeAt(entry, request, key.timestamp)
  }
}

async function drain(clipId: string): Promise<void> {
  try {
    while (true) {
      const next = latest.get(clipId)
      if (!next) return
      latest.delete(clipId)
      const epoch = clipEpochs.get(clipId) ?? 0
      const resetAt = resetEpoch
      active.set(clipId, next)
      try {
        // Bound the COMPLETE attempt, including the keyframe retry. A stalled
        // getKeyPacket/getFirstKeyPacket used to leave `drain` stuck on this
        // clip forever, so later requests (even a replacement URL) never ran.
        const bitmap = await withTimeout(decode(next), DECODE_TIMEOUT_MS, (late) => late.close())
        // A release or reset happened while this decode ran: drop the frame
        // instead of posting it for a clip that no longer wants it.
        if ((clipEpochs.get(clipId) ?? 0) !== epoch || resetEpoch !== resetAt) {
          bitmap.close()
          continue
        }
        // A newer target arrived while this decode ran: drop this frame.
        if (latest.has(clipId)) {
          bitmap.close()
          continue
        }
        scope.postMessage(
          {
            type: 'frame',
            requestId: next.requestId,
            clipId: next.clipId,
            sourceTime: next.sourceTime,
            generation: next.generation,
            bitmap,
          },
          [bitmap],
        )
      } catch (error) {
        // A stale decode's failure must not reach the main thread, or a
        // release would report an error for a source it already dropped.
        if ((clipEpochs.get(clipId) ?? 0) !== epoch || resetEpoch !== resetAt) continue
        if (latest.has(clipId)) continue
        scope.postMessage({
          type: 'error',
          requestId: next.requestId,
          clipId: next.clipId,
          sourceTime: next.sourceTime,
          generation: next.generation,
          message: error instanceof Error ? error.message : String(error),
        })
      } finally {
        if (active.get(clipId) === next) active.delete(clipId)
      }
    }
  } finally {
    running.delete(clipId)
  }
}

function releaseClip(clipId: string): void {
  clipEpochs.set(clipId, (clipEpochs.get(clipId) ?? 0) + 1)
  latest.delete(clipId)
  active.delete(clipId)
  for (const entry of assets.values()) entry.clips.delete(clipId)
}

function releaseAsset(assetId: string, url: string): void {
  const key = assetKey(assetId, url)
  // Invalidate decodes still using the released URL. Their frames or errors
  // must not land after the Input is disposed.
  for (const [clipId, pending] of [...active]) {
    if (pending.assetId !== assetId || pending.url !== url) continue
    clipEpochs.set(clipId, (clipEpochs.get(clipId) ?? 0) + 1)
    active.delete(clipId)
  }
  for (const [clipId, pending] of [...latest]) {
    if (pending.assetId !== assetId || pending.url !== url) continue
    latest.delete(clipId)
  }
  // Invalidate the pending attempt and remove its entry: the next request
  // must start a fresh open instead of joining a promise that will reject.
  opening.delete(key)
  const entry = assets.get(key)
  if (!entry) return
  assets.delete(key)
  entry.clips.clear()
  entry.input.dispose()
}

function reset(): void {
  generation++
  resetEpoch++
  opening.clear()
  clipEpochs.clear()
  active.clear()
  for (const entry of assets.values()) entry.input.dispose()
  assets.clear()
  latest.clear()
}

scope.onmessage = (event: MessageEvent<IncomingMessage>) => {
  const data = event.data
  switch (data.type) {
    case 'decode':
      latest.set(data.clipId, data)
      if (running.has(data.clipId)) return
      running.add(data.clipId)
      void drain(data.clipId)
      return
    case 'releaseClip':
      releaseClip(data.clipId)
      return
    case 'releaseAsset':
      releaseAsset(data.assetId, data.url)
      return
    case 'reset':
      reset()
      return
    case 'dispose':
      reset()
      scope.close()
      return
  }
}
