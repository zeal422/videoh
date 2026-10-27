import { filmstripCanvasFits, type FilmstripPlan } from '../filmstrip'
import type { MediaAsset } from '../types'

/**
 * Runtime filmstrip cache (0.12.0). Browser-bound: owns one hidden video
 * element per asset, seeks it sequentially, and stores strips as canvases, not
 * data URLs. Nothing here touches the Doc, autosave, or serialization.
 *
 * The cache is the single generation lane. Every clip that mounts asks for a
 * strip; requests dedupe by key, queue FIFO, and settle with either the strip
 * or null (poster fallback). The timeline root reads the pending subscription
 * to publish `data-filmstrips-ready`.
 */

/** LRU entry cap. */
export const FILMSTRIP_CACHE_ENTRIES = 40
/** LRU pixel budget, in capped backing pixels. */
export const FILMSTRIP_CACHE_PIXELS = 16_000_000
/** A seek that never settles must not block the single generation lane. */
const SEEK_TIMEOUT_MS = 8_000

export type FilmstripSettle = (source: CanvasImageSource | null) => void

export interface FilmstripRequest {
  clipId: string
  plan: FilmstripPlan
  asset: MediaAsset
}

interface ClipRequest {
  key: string
  plan: FilmstripPlan
  asset: MediaAsset
  onSettle: FilmstripSettle
}

interface Job {
  key: string
  plan: FilmstripPlan
  asset: MediaAsset
  cancelled: boolean
  generation: number
}

/** One cached strip. Entries own their backing store, never a mounted canvas. */
export interface FilmstripEntry {
  key: string
  assetId: string
  sourceKind: 'canvas' | 'bitmap'
  source: HTMLCanvasElement | ImageBitmap
  width: number
  height: number
  pixels: number
}

const entries = new Map<string, FilmstripEntry>()
let totalPixels = 0
const settledKeys = new Map<string, string>()
const pendingKeys = new Set<string>()
const readinessListeners = new Set<() => void>()
const clipRequests = new Map<string, ClipRequest>()
const jobs: Job[] = []
let active: Job | null = null
let cacheGeneration = 0
const videoElements = new Map<string, { el: HTMLVideoElement; url: string }>()
const knownAssetUrls = new Map<string, string>()
let currentProjectId: string | null = null

function notifyReadiness(): void {
  for (const listener of [...readinessListeners]) listener()
}

/** True when every mounted strip request has settled (or none exists). */
export function filmstripsReady(): boolean {
  return pendingKeys.size === 0
}

/** Subscribe to pending-count changes for the timeline root marker. */
export function subscribeFilmstripReadiness(listener: () => void): () => void {
  readinessListeners.add(listener)
  return () => {
    readinessListeners.delete(listener)
  }
}

function sameSource(request: ClipRequest, asset: MediaAsset): boolean {
  return request.asset.url === asset.url && request.asset.id === asset.id
}

function hasRequester(key: string): boolean {
  for (const request of clipRequests.values()) {
    if (request.key === key) return true
  }
  return false
}

/**
 * The first LIVE job for a key. A cancelled active job stays in `active` until
 * its current await unwinds, and a cancelled queued job may not have been
 * removed yet; neither may hide a fresh replacement for the same key.
 */
function findJob(key: string): Job | undefined {
  if (active && !active.cancelled && active.key === key) return active
  return jobs.find((job) => !job.cancelled && job.key === key)
}

function hasOtherRequester(key: string, exceptClipId: string): boolean {
  for (const [clipId, request] of clipRequests) {
    if (clipId !== exceptClipId && request.key === key) return true
  }
  return false
}

function touchEntry(key: string): FilmstripEntry | undefined {
  const entry = entries.get(key)
  if (!entry) return undefined
  // Map insertion order is the LRU order: move a read to the tail.
  entries.delete(key)
  entries.set(key, entry)
  return entry
}

/** Releases one entry's graphics memory. */
export function disposeEntry(entry: FilmstripEntry): void {
  if (entry.sourceKind === 'bitmap') {
    ;(entry.source as ImageBitmap).close()
    return
  }
  const canvas = entry.source as HTMLCanvasElement
  canvas.width = 0
  canvas.height = 0
}

function evictUntilRoom(pixels: number): void {
  while (entries.size >= FILMSTRIP_CACHE_ENTRIES || totalPixels + pixels > FILMSTRIP_CACHE_PIXELS) {
    const oldestKey = entries.keys().next().value as string | undefined
    if (oldestKey === undefined) break
    const oldest = entries.get(oldestKey)
    entries.delete(oldestKey)
    if (!oldest) continue
    totalPixels -= oldest.pixels
    disposeEntry(oldest)
  }
}

function insertEntry(entry: FilmstripEntry): void {
  const existing = entries.get(entry.key)
  if (existing) {
    entries.delete(entry.key)
    totalPixels -= existing.pixels
    disposeEntry(existing)
  }
  evictUntilRoom(entry.pixels)
  entries.set(entry.key, entry)
  totalPixels += entry.pixels
  settledKeys.delete(entry.key)
}

/** Test/inspection helper: whether a cached strip exists for a key. */
export function hasFilmstrip(key: string): boolean {
  return entries.has(key)
}

/** Test/inspection helper: number of cached entries. */
export function filmstripEntryCount(): number {
  return entries.size
}

function disposeVideoElement(assetId: string): void {
  const slot = videoElements.get(assetId)
  if (!slot) return
  videoElements.delete(assetId)
  slot.el.removeAttribute('src')
  slot.el.load()
  slot.el.remove()
}

/** Drops one asset's strips, element, and pending work (relink or removal). */
function dropAsset(assetId: string): void {
  disposeVideoElement(assetId)
  for (const [key, entry] of [...entries]) {
    if (entry.assetId !== assetId) continue
    entries.delete(key)
    totalPixels -= entry.pixels
    disposeEntry(entry)
    settledKeys.delete(key)
  }
  for (const [key, knownId] of [...settledKeys]) {
    if (knownId === assetId) settledKeys.delete(key)
  }
  for (const [clipId, request] of [...clipRequests]) {
    if (request.asset.id !== assetId) continue
    clipRequests.delete(clipId)
    request.onSettle(null)
  }
  for (let i = jobs.length - 1; i >= 0; i--) {
    if (jobs[i].asset.id !== assetId) continue
    jobs[i].cancelled = true
    const [removed] = jobs.splice(i, 1)
    pendingKeys.delete(removed.key)
  }
  if (active?.asset.id === assetId) {
    active.cancelled = true
    pendingKeys.delete(active.key)
  }
  knownAssetUrls.delete(assetId)
  notifyReadiness()
}

/**
 * Drops every strip, cancels every job, settles every mounted request, and
 * disposes every hidden element. Project replacement calls this unconditionally.
 */
export function disposeAll(): void {
  cacheGeneration++
  for (const entry of entries.values()) disposeEntry(entry)
  entries.clear()
  totalPixels = 0
  settledKeys.clear()
  for (const [assetId] of [...videoElements]) disposeVideoElement(assetId)
  for (const request of clipRequests.values()) request.onSettle(null)
  clipRequests.clear()
  for (const job of jobs) job.cancelled = true
  jobs.length = 0
  if (active) active.cancelled = true
  active = null
  pendingKeys.clear()
  knownAssetUrls.clear()
  notifyReadiness()
}

/**
 * Asset lifecycle hook for the editor root. The store update that installs a
 * project, removes media, or relinks a file lands here before React re-renders,
 * so stale strips and elements can never survive into the new render.
 */
export function syncFilmstrips(media: MediaAsset[], projectId: string): void {
  if (currentProjectId === null) {
    // First sync of this session: seed the identity only. The clips that
    // mounted a moment earlier have already queued their first strips.
    currentProjectId = projectId
    for (const asset of media) knownAssetUrls.set(asset.id, asset.url)
    return
  }
  if (currentProjectId !== projectId) {
    disposeAll()
    currentProjectId = projectId
    for (const asset of media) knownAssetUrls.set(asset.id, asset.url)
    return
  }
  const live = new Map(media.map((asset) => [asset.id, asset]))
  for (const [assetId, url] of [...knownAssetUrls]) {
    const asset = live.get(assetId)
    if (!asset) {
      dropAsset(assetId)
      continue
    }
    if (asset.url !== url) {
      dropAsset(assetId)
      knownAssetUrls.set(assetId, asset.url)
    }
  }
  for (const asset of media) {
    if (!knownAssetUrls.has(asset.id)) knownAssetUrls.set(asset.id, asset.url)
  }
}

/** The image decoder. Exported as a seam for the mocked browser harness. */
export type FilmstripImageLoader = (url: string) => Promise<CanvasImageSource>

async function loadImageElement(url: string): Promise<CanvasImageSource> {
  const image = new Image()
  image.src = url
  if (typeof image.decode === 'function') {
    await image.decode()
    return image
  }
  await new Promise<void>((resolve, reject) => {
    image.addEventListener('load', () => resolve(), { once: true })
    image.addEventListener('error', () => reject(new Error('Image load failed')), { once: true })
  })
  return image
}

let imageLoader: FilmstripImageLoader = loadImageElement

/** Replaces the image decoder (tests) or restores the browser one (null). */
export function setFilmstripImageLoader(loader: FilmstripImageLoader | null): void {
  imageLoader = loader ?? loadImageElement
}

function createStripCanvas(width: number, height: number): HTMLCanvasElement | null {
  if (!filmstripCanvasFits(width, height)) return null
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

/** Cover-crop one source frame into a cell, with no letterboxing. */
function drawCover(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
): void {
  if (!(dw > 0) || !(dh > 0)) return
  const width = sourceWidth > 0 ? sourceWidth : 1
  const height = sourceHeight > 0 ? sourceHeight : 1
  const scale = Math.max(dw / width, dh / height)
  const cropWidth = dw / scale
  const cropHeight = dh / scale
  const sx = Math.max(0, (width - cropWidth) / 2)
  const sy = Math.max(0, (height - cropHeight) / 2)
  ctx.drawImage(source, sx, sy, cropWidth, cropHeight, dx, dy, dw, dh)
}

function getVideoElement(asset: MediaAsset): HTMLVideoElement | null {
  if (typeof document === 'undefined') return null
  const existing = videoElements.get(asset.id)
  if (existing) {
    if (existing.url === asset.url) return existing.el
    disposeVideoElement(asset.id)
  }
  const el = document.createElement('video')
  el.preload = 'auto'
  el.muted = true
  el.playsInline = true
  el.setAttribute('aria-hidden', 'true')
  el.style.display = 'none'
  el.src = asset.url
  document.body.appendChild(el)
  videoElements.set(asset.id, { el, url: asset.url })
  return el
}

/** Seeks one hidden element and resolves when the frame is ready. */
function seekVideo(el: HTMLVideoElement, time: number): Promise<void> {
  // A repeat read of the same instant needs no second seek (and a mock
  // element would not emit `seeked` for an unchanged currentTime).
  if (Math.abs(el.currentTime - time) < 1e-6) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      el.removeEventListener('seeked', onSeeked)
      el.removeEventListener('error', onError)
      clearTimeout(timer)
    }
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      fn()
    }
    const onSeeked = () => finish(resolve)
    const onError = () => finish(() => reject(new Error('Media seek failed')))
    const timer = setTimeout(
      () => finish(() => reject(new Error('Media seek timed out'))),
      SEEK_TIMEOUT_MS,
    )
    el.addEventListener('seeked', onSeeked)
    el.addEventListener('error', onError)
    try {
      el.currentTime = time
    } catch (error) {
      finish(() => reject(error instanceof Error ? error : new Error(String(error))))
    }
  })
}

function makeEntry(
  key: string,
  assetId: string,
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
): FilmstripEntry {
  return {
    key,
    assetId,
    sourceKind: 'canvas',
    source: canvas,
    width,
    height,
    pixels: width * height,
  }
}

async function generateVideo(job: Job): Promise<FilmstripEntry | null> {
  const { widthBucket, heightBucket, frames } = job.plan
  const canvas = createStripCanvas(widthBucket, heightBucket)
  if (!canvas) return null
  const ctx = canvas.getContext('2d')
  const el = getVideoElement(job.asset)
  if (!ctx || !el || frames.length === 0) {
    canvas.width = 0
    canvas.height = 0
    return null
  }
  const cellWidth = widthBucket / frames.length
  try {
    for (const frame of frames) {
      if (job.cancelled || job.generation !== cacheGeneration) throw new Error('cancelled')
      await seekVideo(el, frame.sourceTime)
      if (job.cancelled || job.generation !== cacheGeneration) throw new Error('cancelled')
      drawCover(
        ctx,
        el,
        job.asset.width,
        job.asset.height,
        frame.x * widthBucket - cellWidth / 2,
        0,
        cellWidth,
        heightBucket,
      )
    }
  } catch {
    canvas.width = 0
    canvas.height = 0
    return null
  }
  return makeEntry(job.key, job.asset.id, canvas, widthBucket, heightBucket)
}

async function generateImage(job: Job): Promise<FilmstripEntry | null> {
  const { widthBucket, heightBucket } = job.plan
  const canvas = createStripCanvas(widthBucket, heightBucket)
  if (!canvas) return null
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    canvas.width = 0
    canvas.height = 0
    return null
  }
  let source: CanvasImageSource | null = null
  try {
    source = await imageLoader(job.asset.url)
    if (job.cancelled || job.generation !== cacheGeneration) {
      canvas.width = 0
      canvas.height = 0
      return null
    }
    drawCover(ctx, source, job.asset.width, job.asset.height, 0, 0, widthBucket, heightBucket)
  } catch {
    canvas.width = 0
    canvas.height = 0
    return null
  } finally {
    if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) source.close()
  }
  return makeEntry(job.key, job.asset.id, canvas, widthBucket, heightBucket)
}

function settleJob(job: Job, entry: FilmstripEntry | null): void {
  const generationMatches = job.generation === cacheGeneration
  if (!generationMatches || job.cancelled || !hasRequester(job.key)) {
    if (entry) disposeEntry(entry)
    // A release-then-re-request can leave a live replacement queued for the
    // same key; its pending count must stay open until that job settles.
    if (!findJob(job.key)) {
      pendingKeys.delete(job.key)
      notifyReadiness()
    }
    return
  }
  if (entry) insertEntry(entry)
  else settledKeys.set(job.key, job.asset.id)
  const requests = [...clipRequests.values()].filter((request) => request.key === job.key)
  for (const request of requests) request.onSettle(entry ? entry.source : null)
  if (!findJob(job.key)) {
    pendingKeys.delete(job.key)
    notifyReadiness()
  }
}

async function runJob(job: Job): Promise<void> {
  let result: FilmstripEntry | null = null
  try {
    result = job.plan.kind === 'image' ? await generateImage(job) : await generateVideo(job)
  } catch {
    result = null
  }
  if (active === job) active = null
  settleJob(job, result)
  if (job.generation === cacheGeneration) drainQueue()
}

function drainQueue(): void {
  if (active) return
  const next = jobs.shift()
  if (!next) return
  if (next.cancelled || next.generation !== cacheGeneration) {
    if (!findJob(next.key)) {
      pendingKeys.delete(next.key)
      notifyReadiness()
    }
    drainQueue()
    return
  }
  active = next
  void runJob(next)
}

function enqueueJob(request: ClipRequest): void {
  const job: Job = {
    key: request.key,
    plan: request.plan,
    asset: request.asset,
    cancelled: false,
    generation: cacheGeneration,
  }
  jobs.push(job)
  pendingKeys.add(job.key)
  notifyReadiness()
  drainQueue()
}

/**
 * Retargets a queued job for the same clip in place, so a trim or zoom does not
 * jump ahead of other clips. An active job is cancelled instead; its stale
 * result can never install.
 */
function rekeyJob(clipId: string, oldKey: string, request: ClipRequest): Job | null {
  if (oldKey === request.key) return null
  if (hasOtherRequester(oldKey, clipId)) return null
  const live = findJob(oldKey)
  if (!live) return null
  if (live === active) {
    live.cancelled = true
    if (!findJob(oldKey)) {
      pendingKeys.delete(oldKey)
      notifyReadiness()
    }
    return null
  }
  const index = jobs.indexOf(live)
  if (index < 0) return null
  if (findJob(request.key)) {
    jobs.splice(index, 1)
    if (!findJob(oldKey)) {
      pendingKeys.delete(oldKey)
      notifyReadiness()
    }
    return null
  }
  const job = jobs[index]
  job.key = request.key
  job.plan = request.plan
  job.asset = request.asset
  pendingKeys.delete(oldKey)
  pendingKeys.add(request.key)
  notifyReadiness()
  return job
}

/**
 * Registers one clip's strip request. The same clip may call this repeatedly
 * with a new key (trim, speed, reverse, curve, zoom); the cache supersedes its
 * previous request without disturbing other clips. The callback receives the
 * cached source or null for the poster fallback.
 */
export function requestFilmstrip(request: FilmstripRequest, onSettle: FilmstripSettle): void {
  const { clipId, plan, asset } = request
  const previous = clipRequests.get(clipId)
  if (previous && !sameSource(previous, asset)) {
    // Relink (or a new file handle): the old strips and element are stale.
    dropAsset(asset.id)
  }
  const fresh = clipRequests.get(clipId)
  const next: ClipRequest = { key: plan.key, plan, asset, onSettle }
  clipRequests.set(clipId, next)

  // Offline media has nothing to seek: settle immediately and keep the missing
  // styling, never a hidden element or a job.
  if (asset.missing || !asset.url) {
    pendingKeys.delete(plan.key)
    notifyReadiness()
    onSettle(null)
    return
  }

  if (!filmstripCanvasFits(plan.widthBucket, plan.heightBucket)) {
    // The poster fallback counts as settled: never allocate an oversized canvas.
    pendingKeys.delete(plan.key)
    notifyReadiness()
    onSettle(null)
    return
  }

  const retargeted = fresh && fresh.key !== plan.key ? rekeyJob(clipId, fresh.key, next) : null

  const cached = touchEntry(plan.key)
  if (cached) {
    // Zooming back to a cached bucket after a queued retarget leaves a job
    // that has nothing to generate. Drop only that job; another clip's job for
    // the same key is not ours to cancel.
    if (retargeted) {
      const index = jobs.indexOf(retargeted)
      if (index >= 0) {
        jobs.splice(index, 1)
        pendingKeys.delete(retargeted.key)
        notifyReadiness()
      }
    }
    pendingKeys.delete(plan.key)
    notifyReadiness()
    onSettle(cached.source)
    return
  }
  if (findJob(plan.key)) return
  if (settledKeys.has(plan.key)) {
    pendingKeys.delete(plan.key)
    notifyReadiness()
    onSettle(null)
    return
  }
  enqueueJob(next)
}

/** Drops one clip's request; other clips asking for the same key keep it. */
export function releaseFilmstrip(clipId: string): void {
  const request = clipRequests.get(clipId)
  if (!request) return
  clipRequests.delete(clipId)
  if (hasOtherRequester(request.key, clipId)) return
  const live = findJob(request.key)
  if (!live) return
  if (live === active) {
    live.cancelled = true
    if (!findJob(request.key)) {
      pendingKeys.delete(request.key)
      notifyReadiness()
    }
    return
  }
  const index = jobs.indexOf(live)
  if (index >= 0) {
    jobs.splice(index, 1)
    if (!findJob(request.key)) {
      pendingKeys.delete(request.key)
      notifyReadiness()
    }
  }
}
