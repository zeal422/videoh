import { WAVEFORM_BUCKETS } from '../constants'
import { uid } from '../factories'
import type { MediaAsset, MediaKind } from '../types'

/**
 * File import pipeline (browser-only).
 *
 * For every file we:
 * 1. create an in-memory object URL,
 * 2. probe duration / dimensions via media elements,
 * 3. capture a small JPEG thumbnail (video frames / images),
 * 4. try to decode the audio track and extract normalized waveform peaks.
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

/** Imports a File into a MediaAsset. Throws MediaImportError when unusable. */
export async function importFile(file: File): Promise<MediaAsset> {
  const kind = detectKind(file)
  if (!kind) throw new MediaImportError(`Unsupported file type: ${file.name}`)

  const url = URL.createObjectURL(file)
  try {
    if (kind === 'image') return await importImage(file, url)
    if (kind === 'video') return await importVideo(file, url)
    return await importAudio(file, url)
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
    thumbnail: makeThumbnail(img, img.naturalWidth, img.naturalHeight),
  }
}

async function importVideo(file: File, url: string): Promise<MediaAsset> {
  const el = document.createElement('video')
  el.preload = 'auto'
  el.muted = true
  el.src = url

  await waitForEvent(el, 'loadedmetadata', 15000)
  const duration = sanitizeDuration(el.duration)
  const width = el.videoWidth || 0
  const height = el.videoHeight || 0

  let thumbnail: string | undefined
  try {
    await seekTo(el, Math.min(1, duration / 3))
    thumbnail = makeThumbnail(el, width, height)
  } catch {
    // thumbnail is optional
  }

  const waveformPeaks = await tryDecodePeaks(file)
  el.src = ''
  el.load()

  return {
    id: uid('media'),
    name: file.name,
    kind: 'video',
    duration,
    width,
    height,
    url,
    ...(thumbnail ? { thumbnail } : {}),
    ...(waveformPeaks ? { waveformPeaks } : {}),
    // decodeAudioData succeeds exactly when the container has a decodable
    // audio track — that is the authoritative A/V split signal.
    hasAudio: waveformPeaks !== undefined,
  }
}

async function importAudio(file: File, url: string): Promise<MediaAsset> {
  const el = document.createElement('audio')
  el.preload = 'metadata'
  el.src = url
  await waitForEvent(el, 'loadedmetadata', 15000)
  const duration = sanitizeDuration(el.duration)
  el.src = ''
  el.load()

  const waveformPeaks = await tryDecodePeaks(file)
  return {
    id: uid('media'),
    name: file.name,
    kind: 'audio',
    duration,
    width: 0,
    height: 0,
    url,
    ...(waveformPeaks ? { waveformPeaks } : {}),
    hasAudio: true,
  }
}

// ————— probing helpers —————

function sanitizeDuration(d: number): number {
  return Number.isFinite(d) && d > 0 ? d : 0
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
 * Decodes the file's audio track and computes normalized peaks.
 * Returns undefined when the browser cannot decode (e.g. some containers).
 */
async function tryDecodePeaks(file: File): Promise<number[] | undefined> {
  try {
    const AudioCtx: typeof AudioContext | undefined =
      typeof AudioContext !== 'undefined'
        ? AudioContext
        : ((window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ??
          undefined)
    if (!AudioCtx) return undefined
    const ctx = new AudioCtx()
    const buffer = await ctx.decodeAudioData(await file.arrayBuffer())
    const peaks = computePeaks(buffer, WAVEFORM_BUCKETS)
    void ctx.close()
    return peaks
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
  const perBucket = Math.max(1, Math.floor(length / buckets))
  const peaks: number[] = new Array(buckets).fill(0)

  let max = 0
  for (let b = 0; b < buckets; b++) {
    const start = b * perBucket
    const end = Math.min(length, start + perBucket)
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
