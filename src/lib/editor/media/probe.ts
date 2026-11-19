import { WAVEFORM_BUCKETS } from '../constants'
import { uid } from '../factories'
import type { MediaAsset, MediaKind } from '../types'
import { readRecordingDuration } from './recorder'
import { hashFile } from './media-store'

/**
 * File import pipeline (browser-only).
 *
 * 1. create an in-memory object URL,
 * 2. probe duration / dimensions via media elements,
 * 3. capture a small JPEG thumbnail (video frames / images),
 * 4. try to decode the audio track and extract normalized waveform peaks.
 * 5. keep the source File on the asset, the WebCodecs exporter reads
 *    frame-accurate data from it (object URLs cannot), and serialization
 *    strips it like the URL.
 *
 * Failures in steps 3–4 degrade gracefully (missing thumbnail / peaks).
 * Step 4 also yields `hasAudio` — the A/V split signal that places a linked
 * audio twin on the timeline when a video with sound is dropped (links.ts).
 */

export class MediaImportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MediaImportError'
  }
}

const IMAGE_EXTENSIONS: Record<string, MediaKind> = {
  mp4: 'video',
  webm: 'video',
  mov: 'video',
  m4v: 'video',
  ogv: 'video',
  mkv: 'video',
  mp3: 'audio',
  wav: 'audio',
  m4a: 'audio',
  aac: 'audio',
  ogg: 'audio',
  oga: 'audio',
  flac: 'audio',
  opus: 'audio',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  avif: 'image',
  svg: 'image',
  bmp: 'image',
}

export function detectKind(file: File): MediaKind | null {
  if (file.type.startsWith('video/')) return 'video'
  if (file.type.startsWith('audio/')) return 'audio'
  if (file.type.startsWith('image/')) return 'image'
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  return IMAGE_EXTENSIONS[ext] ?? null
}

/** Optional probe settings. A recording's header can omit its duration. */
export interface ImportFileOptions {
  /**
   * A verified duration for a file whose container has none (MediaRecorder
   * WebM reports `Infinity`). Used only when the element's own duration is not
   * finite and positive, then still run through `sanitizeDuration`.
   */
  durationHint?: number
}

/** Imports a File into a MediaAsset. Throws MediaImportError when unusable. */
export async function importFile(file: File, options: ImportFileOptions = {}): Promise<MediaAsset> {
  const kind = detectKind(file)
  if (!kind) throw new MediaImportError(`Unsupported file type: ${file.name}`)

  const url = URL.createObjectURL(file)
  try {
    const asset =
      kind === 'image'
        ? await importImage(file, url)
        : kind === 'video'
          ? await importVideo(file, url, options.durationHint)
          : await importAudio(file, url, options.durationHint)
    // The content hash keys the durable store (0.23.0). Hashing is best-effort:
    // a runtime without `crypto.subtle` still gets a working session-only asset.
    return tryHashFile(file).then((contentHash) =>
      contentHash ? { ...asset, contentHash } : asset,
    )
  } catch (error) {
    URL.revokeObjectURL(url)
    throw error instanceof MediaImportError
      ? error
      : new MediaImportError(`Could not read ${file.name}`)
  }
}

async function importImage(file: File, url: string): Promise<MediaAsset> {
  const img = await loadImage(url)
  return {
    id: uid('media'),
    name: file.name,
    kind: 'image',
    duration: 0,
    width: img.naturalWidth,
    height: img.naturalHeight,
    url,
    file,
    thumbnail: makeThumbnail(img, img.naturalWidth, img.naturalHeight),
  }
}

async function importVideo(file: File, url: string, durationHint?: number): Promise<MediaAsset> {
  const el = document.createElement('video')
  el.preload = 'auto'
  el.muted = true
  el.src = url

  await waitForEvent(el, 'loadedmetadata', 15000)
  const probed = await probeDuration(file, el.duration, durationHint)
  const width = el.videoWidth || 0
  const height = el.videoHeight || 0
  // A MediaRecorder voiceover is an audio-only WebM. Browsers can report the
  // downloaded file as video/webm, so the missing video dimensions decide the
  // kind instead of the MIME type.
  const audioOnly = width === 0 && height === 0
  // Firefox writes audio-only WebM without a duration and cannot seek it, so
  // the generic repair returns nothing on a re-import. The waveform pass below
  // decodes the audio anyway, and that buffer knows its exact length.
  const audio = await tryDecodeAudio(file)
  const duration = probed > 0 ? probed : audioOnly ? (audio?.duration ?? 0) : 0

  let thumbnail: string | undefined
  if (!audioOnly) {
    try {
      await seekTo(el, Math.min(1, duration / 3))
      thumbnail = makeThumbnail(el, width, height)
    } catch {
      // thumbnail is optional
    }
  }

  el.src = ''
  el.load()

  return {
    id: uid('media'),
    name: file.name,
    kind: audioOnly ? 'audio' : 'video',
    duration,
    width,
    height,
    url,
    file,
    ...(thumbnail ? { thumbnail } : {}),
    ...(audio?.peaks ? { waveformPeaks: audio.peaks } : {}),
    // decodeAudioData succeeds exactly when the container has a decodable
    // audio track — that is the authoritative A/V split signal.
    hasAudio: audioOnly || audio !== undefined,
  }
}

async function importAudio(file: File, url: string, durationHint?: number): Promise<MediaAsset> {
  const el = document.createElement('audio')
  el.preload = 'metadata'
  el.src = url
  await waitForEvent(el, 'loadedmetadata', 15000)
  const probed = await probeDuration(file, el.duration, durationHint)
  // The same Firefox gap as the audio-only video path: no container duration
  // and no seek, but a decodable audio track with a known length.
  const audio = await tryDecodeAudio(file)
  const duration = probed > 0 ? probed : (audio?.duration ?? 0)
  el.src = ''
  el.load()

  return {
    id: uid('media'),
    name: file.name,
    kind: 'audio',
    duration,
    width: 0,
    height: 0,
    url,
    file,
    ...(audio?.peaks ? { waveformPeaks: audio.peaks } : {}),
    hasAudio: true,
  }
}

/** SHA-256 of the source bytes, or undefined when the runtime cannot hash. */
async function tryHashFile(file: File): Promise<string | undefined> {
  try {
    return await hashFile(file)
  } catch {
    return undefined
  }
}

// ————— probing helpers —————

function sanitizeDuration(d: number): number {
  return Number.isFinite(d) && d > 0 ? d : 0
}

/**
 * The element's own duration wins when it is finite and positive. A
 * MediaRecorder WebM reports `Infinity`, so the caller's verified hint fills the
 * gap; a zero, negative, or non-finite hint still sanitizes to zero.
 */
export function resolveDuration(raw: number, hint?: number): number {
  if (Number.isFinite(raw) && raw > 0) return raw
  return sanitizeDuration(hint ?? 0)
}

/** True for a WebM container, which can omit its duration header. */
function isWebmFile(file: File): boolean {
  return file.type.includes('webm') || file.name.toLowerCase().endsWith('.webm')
}

/**
 * The element's duration, with the MediaRecorder WebM repair applied when the
 * container has none and no verified hint was supplied. A downloaded recording
 * is re-imported through this path, so it must get the same duration repair as
 * the original take.
 */
async function probeDuration(file: File, raw: number, hint?: number): Promise<number> {
  const duration = resolveDuration(raw, hint)
  if (duration > 0 || !isWebmFile(file)) return duration
  const repaired = await readRecordingDuration(file)
  return repaired === null ? duration : sanitizeDuration(repaired)
}

function waitForEvent(el: HTMLMediaElement, event: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new MediaImportError('Timed out while reading media'))
    }, timeoutMs)
    const onOk = () => {
      cleanup()
      resolve()
    }
    const onErr = () => {
      cleanup()
      reject(new MediaImportError('Media could not be decoded by the browser'))
    }
    const cleanup = () => {
      clearTimeout(timer)
      el.removeEventListener(event, onOk)
      el.removeEventListener('error', onErr)
    }
    el.addEventListener(event, onOk, { once: true })
    el.addEventListener('error', onErr, { once: true })
  })
}

function seekTo(el: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSeeked = () => {
      cleanup()
      resolve()
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('seek timeout'))
    }, 5000)
    const cleanup = () => {
      clearTimeout(timer)
      el.removeEventListener('seeked', onSeeked)
    }
    el.addEventListener('seeked', onSeeked, { once: true })
    el.currentTime = Math.max(0, time)
  })
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new MediaImportError('Image could not be decoded'))
    img.src = url
  })
}

/** Draws the media into a small offscreen canvas and returns a JPEG dataURL. */
function makeThumbnail(
  source: CanvasImageSource,
  width: number,
  height: number,
  maxWidth = 160,
): string | undefined {
  if (!width || !height) return undefined
  const scale = Math.min(1, maxWidth / width)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) return undefined
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
  try {
    return canvas.toDataURL('image/jpeg', 0.7)
  } catch {
    return undefined
  }
}

/**
 * Decodes the file's audio track, returning normalized peaks and the decoded
 * length. The length is the only duration a Firefox audio-only WebM exposes:
 * its container has none and the element cannot seek it. Returns undefined when
 * the browser cannot decode (e.g. some containers).
 */
async function tryDecodeAudio(
  file: File,
): Promise<{ peaks: number[]; duration: number } | undefined> {
  try {
    const AudioCtx: typeof AudioContext | undefined =
      typeof AudioContext !== 'undefined'
        ? AudioContext
        : ((window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ??
          undefined)
    if (!AudioCtx) return undefined
    const ctx = new AudioCtx()
    try {
      const buffer = await ctx.decodeAudioData(await file.arrayBuffer())
      return { peaks: computePeaks(buffer, WAVEFORM_BUCKETS), duration: buffer.duration }
    } finally {
      void ctx.close()
    }
  } catch {
    return undefined
  }
}

/** Mixes all channels down and buckets max-abs into `buckets` normalized values. */
export function computePeaks(buffer: AudioBuffer, buckets = WAVEFORM_BUCKETS): number[] {
  const length = buffer.length
  const channelCount = Math.min(2, buffer.numberOfChannels)
  const ch0 = buffer.getChannelData(0)
  const ch1 = channelCount > 1 ? buffer.getChannelData(1) : null
  const peaks: number[] = new Array(buckets).fill(0)

  let max = 0
  for (let b = 0; b < buckets; b++) {
    // Proportional bucket boundaries cover every sample exactly once, including
    // the tail of a length that is not divisible by the bucket count.
    const start = Math.floor((b * length) / buckets)
    const end = Math.floor(((b + 1) * length) / buckets)
    let peak = 0
    for (let i = start; i < end; i++) {
      const v = ch1 ? Math.abs(ch0[i]) + Math.abs(ch1[i]) : Math.abs(ch0[i])
      if (v > peak) peak = v
    }
    peaks[b] = peak
    if (peak > max) max = peak
  }
  if (max > 0) {
    for (let b = 0; b < buckets; b++) peaks[b] = Math.round((peaks[b] / max) * 1000) / 1000
  }
  return peaks
}
