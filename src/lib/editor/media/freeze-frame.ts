/**
 * freeze-frame.ts: the browser half of Freeze Frame (0.23.0).
 *
 * Renders the composited frame at the playhead into an offscreen canvas at the
 * project size, using the SAME compositor the preview and export use, then
 * encodes an opaque PNG. No third renderer: `drawFrame` runs twice, once with a
 * resolver that only records which clips ask for a source frame (compounds
 * resolve their children with their own local time), then once with the loaded
 * elements. The plan pass already refused an empty playhead and offline media.
 */

import { activeTracks, sourceTimeAt } from '../factories'
import { drawFrame } from '../playback/compositor'
import type { Clip, Doc } from '../types'

const DECODE_TIMEOUT_MS = 10_000

export class FreezeFrameError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FreezeFrameError'
  }
}

interface FrameRequest {
  clip: Clip
  localTime: number
}

/**
 * A child clip inside a compound can appear in two overlapping instances of the
 * same sequence, at different local times. The instance context is exactly the
 * `(clip, local time)` pair the compositor resolves with, so both the request
 * and the resolved frame are keyed by it; keying by clip id alone would reuse
 * one instance's frame for the other.
 */
function frameKey(clip: Clip, localTime: number): string {
  return `${clip.id}@${localTime}`
}

function waitFor(target: EventTarget, event: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new FreezeFrameError('The frame took too long to decode'))
    }, timeoutMs)
    const onOk = () => {
      cleanup()
      resolve()
    }
    const onError = () => {
      cleanup()
      reject(new FreezeFrameError('The frame could not be decoded'))
    }
    const cleanup = () => {
      clearTimeout(timer)
      target.removeEventListener(event, onOk)
      target.removeEventListener('error', onError)
    }
    target.addEventListener(event, onOk, { once: true })
    target.addEventListener('error', onError, { once: true })
  })
}

async function loadImage(url: string): Promise<HTMLImageElement> {
  const image = new Image()
  image.src = url
  await waitFor(image, 'load', DECODE_TIMEOUT_MS)
  return image
}

async function loadVideoFrame(url: string, time: number): Promise<HTMLVideoElement> {
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  try {
    video.src = url
    await waitFor(video, 'loadeddata', DECODE_TIMEOUT_MS)
    const target = Math.max(0, time)
    // A seek to the position the element already shows never fires `seeked`
    // (the clip-start/inPoint-0 freeze case), so skip the wait instead of
    // timing out on an unchanged currentTime.
    if (Math.abs(video.currentTime - target) >= 1e-6) {
      video.currentTime = target
      await waitFor(video, 'seeked', DECODE_TIMEOUT_MS)
    }
    return video
  } catch (error) {
    // A decode that never loads or seeks still owns an element and its blob.
    // Release it here: the caller's `videos` list only tracks successes.
    releaseVideo(video)
    throw error
  }
}

function releaseVideo(video: HTMLVideoElement): void {
  try {
    video.pause()
    video.removeAttribute('src')
    video.load()
  } catch {
    // A detached element is already harmless.
  }
}

/**
 * Renders and encodes the still. Throws `FreezeFrameError` on an offline source
 * and on an encode failure; the caller adds no clip in that case.
 */
export async function renderFreezeFrame(
  doc: Doc,
  activeSequencePath: readonly string[],
  time: number,
): Promise<File> {
  if (typeof document === 'undefined') {
    throw new FreezeFrameError('Freezing a frame needs a browser')
  }
  const { width, height } = doc.project
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  // `alpha: false` flattens the still against the black frame background, so a
  // lower source layer can never show through or blend with it again.
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) throw new FreezeFrameError('Could not create the frame surface')
  const tracks = activeTracks(doc, activeSequencePath)

  // Pass 1: record every clip that asks for a source frame. Compound clips
  // resolve their children with the clip-local time, so this sees them too.
  const requests = new Map<string, FrameRequest>()
  drawFrame({
    ctx,
    doc,
    time,
    tracks,
    resolve: (clip, localTime) => {
      requests.set(frameKey(clip, localTime), { clip, localTime })
      return undefined
    },
  })

  const frames = new Map<string, HTMLImageElement | HTMLVideoElement>()
  const videos: HTMLVideoElement[] = []
  try {
    for (const [key, request] of requests) {
      const asset = doc.media.find((candidate) => candidate.id === request.clip.mediaId)
      if (!asset || asset.missing || !asset.url) {
        throw new FreezeFrameError('A visible clip has no playable source')
      }
      if (asset.kind === 'image') {
        frames.set(key, await loadImage(asset.url))
      } else if (asset.kind === 'video') {
        const video = await loadVideoFrame(asset.url, sourceTimeAt(request.clip, request.localTime))
        videos.push(video)
        frames.set(key, video)
      }
      // Audio has no pixels; the compositor never asks for it.
    }

    // Pass 2: the real composite.
    drawFrame({
      ctx,
      doc,
      time,
      tracks,
      resolve: (clip, localTime) => {
        const asset = doc.media.find((candidate) => candidate.id === clip.mediaId)
        const el = frames.get(frameKey(clip, localTime))
        return asset && el ? { asset, el } : undefined
      },
    })

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/png')
    })
    if (!blob) throw new FreezeFrameError('The still image could not be encoded')
    return new File([blob], 'Freeze Frame.png', { type: 'image/png' })
  } finally {
    for (const video of videos) releaseVideo(video)
  }
}
