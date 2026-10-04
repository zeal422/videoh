'use client'

import {
  ALL_FORMATS,
  AudioBufferSource,
  BlobSource,
  BufferTarget,
  canEncodeAudio,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
  VideoSampleSink,
  VideoSampleSource,
} from 'mediabunny'
import { EQ_DB_MAX, EQ_DB_MIN } from '../constants'
import { clampSourceTime, docDuration, findMedia } from '../factories'
import { constantTimeScaleRate } from '../keyframes'
import { clipRendersAudio, linkGroupChangesRate } from '../links'
import { drawTextClip } from '../playback/compositor'
import { denoiseFilters } from '../playback/denoise'
import { clamp } from '../time'
import { clipCrossfadeSchedule, clipGainSchedule, planVideoFrame, type ClipDraw } from './offline'
import type { Clip, Doc, Track } from '../types'

/**
 * WebCodecs/MP4 export, offline (no realtime capture), frame-accurate.
 *
 * Wall time tracks source decode: roughly realtime for 1080p H.264 decoded in
 * software, faster where the browser can decode on the GPU.
 *
 * Video: the offline plan (offline.ts) drives an offscreen canvas; each frame
 * is composited from decoded source frames (Mediabunny VideoSampleSink) and
 * encoded to H.264 via CanvasSource. Reversed clips read source frames
 * backwards, which element-based playback cannot do.
 *
 * Audio: one OfflineAudioContext renders the whole mix (gain/pan/EQ/compressor
 * per clip), and the rendered buffer is encoded to AAC where the browser can
 * (Opus otherwise, see pickAudioCodec). EQ/compressor are NOT
 * re-applied here (they are baked into nothing): the offline mix applies gain
 * keyframes + pan natively; EQ/compression ride on the OfflineAudioContext
 * graph exactly like the preview graph.
 *
 * The old MediaRecorder/WebM path is retired: this pipeline needs WebCodecs
 * (Chromium, Edge, Firefox 130+, Safari 26+).
 */

export interface ExportHandle {
  cancelled: boolean
}

export interface ExportResult {
  blob: Blob
  mimeType: string
  duration: number
}

export interface ExportOptions {
  onProgress?: (t: number, duration: number) => void
  quality?: 'low' | 'medium' | 'high'
}

const BITRATES: Record<NonNullable<ExportOptions['quality']>, number> = {
  low: 2_500_000,
  medium: 6_000_000,
  high: 12_000_000,
}

const AUDIO_SAMPLE_RATE = 48_000

export function webCodecsSupported(): boolean {
  return typeof window !== 'undefined' && 'VideoEncoder' in window && 'VideoFrame' in window
}

/** Decoded-frame provider per video asset, keyed by asset id. */
interface DecodeContext {
  sinks: Map<string, VideoSampleSink>
}

async function createDecodeContext(doc: Doc): Promise<DecodeContext> {
  const sinks = new Map<string, VideoSampleSink>()
  for (const asset of doc.media) {
    if (asset.kind !== 'video' || !asset.file) continue
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(asset.file) })
    const track = await input.getPrimaryVideoTrack()
    if (!track) continue
    sinks.set(asset.id, new VideoSampleSink(track))
  }
  return { sinks }
}

/** Draws one composited frame from the draw plan onto the export canvas. */
function compositeFrame(
  ctx: CanvasRenderingContext2D,
  doc: Doc,
  drawPlan: ReturnType<typeof planVideoFrame>,
  frames: Map<string, VideoFrame | ImageBitmap | HTMLImageElement>,
  width: number,
  height: number,
): void {
  ctx.save()
  ctx.globalAlpha = 1
  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, width, height)
  ctx.restore()

  for (const draw of drawPlan.draws) {
    // Text clips have no decoded frame: they are drawn by the same helper the
    // preview compositor uses, so exported titles match the program monitor.
    if (draw.clip.text !== undefined && draw.clip.style) {
      drawTextClip(ctx, draw.clip, width, height, draw.alpha, draw.filter, draw.transform)
      continue
    }
    const source = frames.get(draw.clip.id)
    if (!source) continue
    drawPlannedClip(ctx, draw, source, width, height)
  }
  void doc
}

function drawPlannedClip(
  ctx: CanvasRenderingContext2D,
  draw: ClipDraw,
  source: VideoFrame | ImageBitmap | HTMLImageElement,
  width: number,
  height: number,
): void {
  const sw =
    source instanceof HTMLImageElement
      ? source.naturalWidth
      : 'displayWidth' in source
        ? (source as VideoFrame).displayWidth
        : (source as ImageBitmap).width
  const sh =
    source instanceof HTMLImageElement
      ? source.naturalHeight
      : 'displayHeight' in source
        ? (source as VideoFrame).displayHeight
        : (source as ImageBitmap).height
  if (!sw || !sh) return

  const scale = draw.transform?.scale ?? 1
  const fit = Math.min(width / sw, height / sh)
  const dw = sw * fit * scale
  const dh = sh * fit * scale
  // Same geometry as the preview compositor: offsets from the scaled size.
  const dx = (width - dw) / 2 + (draw.transform?.posX ?? 0)
  const dy = (height - dh) / 2 + (draw.transform?.posY ?? 0)

  ctx.save()
  ctx.globalAlpha = Math.min(1, Math.max(0, draw.alpha))
  if (draw.filter !== 'none') ctx.filter = draw.filter
  ctx.drawImage(source as CanvasImageSource, dx, dy, dw, dh)
  ctx.restore()
}

/**
 * Builds the OfflineAudioContext graph mirroring the preview mixer and renders
 * the full audio mix. Returns null when the timeline has no audible audio.
 * @internal exported for tests
 */
export async function renderAudioMix(doc: Doc, duration: number): Promise<AudioBuffer | null> {
  if (duration <= 0 || !docHasAudibleClips(doc)) return null

  const offline = new OfflineAudioContext({
    numberOfChannels: 2,
    length: Math.ceil(duration * AUDIO_SAMPLE_RATE),
    sampleRate: AUDIO_SAMPLE_RATE,
  })
  const master = offline.createGain()
  master.connect(offline.destination)
  // One decode per ASSET, shared by every clip that references it: a music bed
  // placed 20 times would otherwise decode the identical file 20 times inside
  // this render, multiplying both decode cost and peak memory by the placement
  // count. Negative results are cached too, so a broken file fails once.
  const audioBuffers = new Map<string, AudioBuffer | null>()

  for (const track of doc.project.tracks) {
    for (const clip of track.clips) {
      const scheduled = scheduledAudioSource(doc, track, clip)
      if (!scheduled) continue

      let buffer = audioBuffers.get(scheduled.assetId)
      if (buffer === undefined) {
        buffer = await decodeAudio(scheduled.file, offline)
        audioBuffers.set(scheduled.assetId, buffer)
      }
      if (!buffer) continue

      const source = offline.createBufferSource()
      source.buffer = buffer

      const gain = offline.createGain()
      // Crossfade ramps live on their own node: the preview mixer multiplies
      // them into the clip gain, and two gain nodes multiply the same way.
      const xfade = offline.createGain()
      const panner = offline.createStereoPanner()
      panner.pan.value = clampPan(clip.pan ?? 0)

      // Volume automation: one pure schedule (plan side) applied here.
      for (const ev of clipGainSchedule(clip)) {
        if (ev.kind === 'ramp') gain.gain.linearRampToValueAtTime(ev.value, ev.time)
        else gain.gain.setValueAtTime(ev.value, ev.time)
      }
      for (const ev of clipCrossfadeSchedule(clip, track)) {
        if (ev.kind === 'ramp') xfade.gain.linearRampToValueAtTime(ev.value, ev.time)
        else xfade.gain.setValueAtTime(ev.value, ev.time)
      }

      // EQ + compressor chain (same topology as the preview graph). The band
      // gains are clamped to the shared limits exactly like the preview, so a
      // malformed doc (a hand-edited file) cannot render two different mixes.
      let head: AudioNode = source
      if (clip.eq) {
        const low = offline.createBiquadFilter()
        low.type = 'lowshelf'
        low.frequency.value = 200
        low.gain.value = clamp(clip.eq.low, EQ_DB_MIN, EQ_DB_MAX)
        const mid = offline.createBiquadFilter()
        mid.type = 'peaking'
        mid.frequency.value = 1000
        mid.Q.value = 1
        mid.gain.value = clamp(clip.eq.mid, EQ_DB_MIN, EQ_DB_MAX)
        const high = offline.createBiquadFilter()
        high.type = 'highshelf'
        high.frequency.value = 4000
        high.gain.value = clamp(clip.eq.high, EQ_DB_MIN, EQ_DB_MAX)
        head.connect(low)
        low.connect(mid)
        mid.connect(high)
        head = high
      }
      if (clip.denoise) {
        for (const filter of denoiseFilters(offline)) {
          head.connect(filter)
          head = filter
        }
      }
      if (clip.compressor) {
        const comp = offline.createDynamicsCompressor()
        comp.threshold.value = -24
        comp.knee.value = 12
        comp.ratio.value = 4
        comp.attack.value = 0.005
        comp.release.value = 0.18
        head.connect(comp)
        head = comp
      }

      head.connect(gain)
      gain.connect(xfade)
      xfade.connect(panner)
      panner.connect(master)

      // The curve (any shape) overrides the static rate; a flat curve's rate
      // is a constant the buffer source resamples exactly like a speed.
      const constantRate = constantTimeScaleRate(clip) ?? clip.speed ?? 1
      // The start duration is in SOURCE seconds and is consumed at the rate
      // below, so both must read the SAME constant: a static-speed duration
      // makes a flat curve's audio span duration * static / curve timeline
      // seconds and bleed over the next clip (the mirror case ends early).
      source.start(clip.start, clip.inPoint, clip.duration * constantRate)
      if (constantRate !== 1) source.playbackRate.value = constantRate
    }
  }

  return offline.startRendering()
}

/**
 * The decodable source a clip contributes to the mix, or null when the loop
 * would skip it: no file to decode, the shared audibility rule says silent, a
 * mute on the clip or its track, a reversed clip, or the derived rate rule
 * (a real ramp on the clip itself or a rate-disagreeing A/V pair; see
 * linkGroupChangesRate). ONE gate for the scheduling loop and the early-out:
 * when they disagree, a clip the early-out counts but the loop skips renders
 * a silent audio track instead of no track at all.
 */
function scheduledAudioSource(
  doc: Doc,
  track: Track,
  clip: Clip,
): { assetId: string; file: File } | null {
  const asset = findMedia(doc, clip.mediaId)
  if (!asset?.file) return null
  if (!clipRendersAudio(doc, clip)) return null
  if (clip.muted || track.muted || clip.reverse || linkGroupChangesRate(doc, clip)) return null
  return { assetId: asset.id, file: asset.file }
}

/**
 * True when any clip will be scheduled into the mix. The same
 * `scheduledAudioSource` gate the per-clip loop uses, so the early-out and
 * the loop cannot disagree: a doc whose only clips are skipped (muted,
 * reversed or rate-dropped) returns null and gets no audio track at all
 * instead of a silent one. A solo video's embedded audio still makes the doc
 * audible, unlike the old asset-kind scan.
 */
function docHasAudibleClips(doc: Doc): boolean {
  return doc.project.tracks.some((track) =>
    track.clips.some((clip) => scheduledAudioSource(doc, track, clip) !== null),
  )
}

function clampPan(p: number): number {
  return Math.min(1, Math.max(-1, p))
}

/** Decodes an audio file into an AudioBuffer via the offline context. */
async function decodeAudio(file: File, ctx: BaseAudioContext): Promise<AudioBuffer | null> {
  try {
    const data = await file.arrayBuffer()
    return await ctx.decodeAudioData(data)
  } catch {
    return null
  }
}

/** Renders the whole timeline to an MP4 blob (H.264 + AAC/Opus). Throws on unsupported browsers. */
export async function exportTimeline(
  doc: Doc,
  opts: ExportOptions = {},
  handle: ExportHandle = { cancelled: false },
): Promise<ExportResult> {
  if (!webCodecsSupported()) {
    throw new Error(
      'This browser does not support WebCodecs export (use a current Chromium, Edge, Firefox 130+, or Safari 26+)',
    )
  }
  const duration = docDuration(doc)
  if (duration <= 0) throw new Error('Timeline is empty, nothing to export')

  const { width, height, fps } = doc.project

  // Offscreen export canvas.
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D context unavailable')

  // MP4 output (H.264 + AAC/Opus, in memory; timelines here are MVP-scale).
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new BufferTarget(),
  })
  const videoSource = new CanvasSource(canvas, {
    codec: 'avc',
    quality: new Quality({ bitrate: BITRATES[opts.quality ?? 'medium'] }),
  })
  output.addVideoTrack(videoSource, { frameRate: fps })

  // Decode contexts per video asset (frame-accurate reads).
  const decode = await createDecodeContext(doc)

  // Audio mix first (fast, offline). Every track must exist before the output
  // is started, Mediabunny rejects `addTrack` afterwards, so the audio
  // source is created and attached here, then fed after the video loop.
  const audioBuffer = await renderAudioMix(doc, duration)
  const audioSource = audioBuffer ? await createAudioSource() : null
  if (audioSource) output.addAudioTrack(audioSource)

  await output.start()

  const totalFrames = Math.max(0, Math.round(duration * fps))
  const frames = new Map<string, VideoFrame | ImageBitmap | HTMLImageElement>()

  // Image elements once (they never decode per-frame). Await the decode before
  // the loop: a still-decoding image would leave the first frames blank. A
  // failed decode only drops that image, it never aborts the export.
  const imageCache = new Map<string, HTMLImageElement>()
  const pendingImages: Promise<void>[] = []
  for (const asset of doc.media) {
    if (asset.kind !== 'image' || !asset.url) continue
    const img = new Image()
    img.src = asset.url
    imageCache.set(asset.id, img)
    // A failed decode drops the entry: the cache only ever holds drawable
    // images, so the export does not have to defend against broken ones.
    pendingImages.push(preloadImage(img, () => imageCache.delete(asset.id)))
  }
  await Promise.all(pendingImages)

  // Set once `finalize()` resolves: a finalized output must not be cancelled
  // (cancel on it is a harmless no-op, but the flag keeps the intent exact).
  let finalized = false

  try {
    for (let i = 0; i < totalFrames; i++) {
      if (handle.cancelled) throw new Error('Export cancelled')
      const t = i / fps
      const plan = planVideoFrame(doc, t)

      // Resolve every needed source frame for this timeline frame. Release the
      // previous frame's decoded surfaces first: they hold memory until closed.
      closeDecodedFrames(frames)
      frames.clear()
      for (const draw of plan.draws) {
        const asset = draw.asset
        if (!asset) continue
        if (asset.kind === 'image') {
          const img = imageCache.get(asset.id)
          if (img?.complete) frames.set(draw.clip.id, img)
          continue
        }
        if (asset.kind !== 'video') continue
        const sink = decode.sinks.get(asset.id)
        if (!sink) continue
        // Reversed reads go backwards in source time, the whole point of
        // frame-accurate decode: the plan already mirrors the source position
        // (`sourceTimeAt`), and the query snaps to the frame boundary so each
        // rendered frame reads a distinct decoded sample.
        // A time-remap ramp can consume more source than the asset holds. The
        // excess freezes on the last frame (clamped here, exactly like the
        // preview transport clamps before an element seek) instead of asking
        // the decoder for a frame past the end.
        const sourceTime = clampSourceTime(draw.sourceTime, asset)
        const sample = await sink.getSample(
          draw.clip.reverse ? nextLowerFrame(sourceTime, fps) : sourceTime,
        )
        if (sample) {
          const bitmap = await createImageBitmap(sample.toCanvasImageSource() as CanvasImageSource)
          sample.close()
          frames.set(draw.clip.id, bitmap)
        }
      }

      compositeFrame(ctx, doc, plan, frames, width, height)
      await videoSource.add(t, 1 / fps)
      opts.onProgress?.(t + 1 / fps, duration)
    }
    if (audioSource && audioBuffer) {
      await audioSource.add(audioBuffer)
      audioSource.close()
    }

    await output.finalize()
    finalized = true
  } finally {
    closeDecodedFrames(frames)
    // A cancel, an encoder error, or any throw leaves the Output holding a
    // live VideoEncoder; `Output.cancel()` is what force-closes the track
    // sources and releases it (mediabunny reaches `_flushOrWaitForOngoingClose`
    // only through cancel or finalize). Without this, one abandoned export
    // per attempt pins a hardware encoder until the tab dies.
    if (!finalized) {
      try {
        await output.cancel()
      } catch {
        // already cancelled or closed
      }
    }
  }

  if (handle.cancelled) throw new Error('Export cancelled')

  const buffer = (output.target as BufferTarget).buffer
  if (!buffer) throw new Error('Export produced no data')
  return {
    blob: new Blob([buffer], { type: 'video/mp4' }),
    mimeType: 'video/mp4',
    duration,
  }
}

/**
 * Which audio codec the MP4 track uses: AAC when this browser can encode it,
 * Opus otherwise. WebCodecs has no AAC encoder on desktop Linux and none at
 * all in Firefox, so the fallback is what keeps export working there; Opus is
 * a valid MP4 audio codec and plays in every browser that can encode it.
 * @internal exported for tests
 */
export async function pickAudioCodec(
  canEncodeAac: () => Promise<boolean>,
): Promise<'aac' | 'opus'> {
  return (await canEncodeAac()) ? 'aac' : 'opus'
}

/** Opens the audio track's source (feeds the mix once the video loop is done). */
async function createAudioSource(): Promise<AudioBufferSource> {
  return new AudioBufferSource({
    codec: await pickAudioCodec(() => canEncodeAudio('aac')),
    quality: new Quality({ bitrate: 192_000 }),
  })
}

/** The MP4 sample right at or before `sourceTime`, for reversed reads. */
function nextLowerFrame(sourceTime: number, fps: number): number {
  return Math.floor(sourceTime * fps) / fps
}

/**
 * Resolves once an image is decodable, calling `onFailure` when it is not. The
 * decode path is preferred; environments without `decode()` fall back to the
 * load/error events. Either way the promise always resolves, so one broken
 * image never aborts the export.
 * @internal exported for tests
 */
export function preloadImage(img: HTMLImageElement, onFailure: () => void): Promise<void> {
  if (typeof img.decode === 'function') {
    return img.decode().catch(() => {
      onFailure()
    })
  }
  return new Promise<void>((resolve) => {
    img.addEventListener('load', () => resolve(), { once: true })
    img.addEventListener(
      'error',
      () => {
        onFailure()
        resolve()
      },
      { once: true },
    )
  })
}

/**
 * Closes the decoded surfaces (VideoFrame / ImageBitmap) held by a frame map.
 * Image elements and environments without those types are left alone, and an
 * already-closed surface is not an error.
 * @internal exported for tests
 */
export function closeDecodedFrames(
  frames: Map<string, VideoFrame | ImageBitmap | HTMLImageElement>,
): void {
  for (const frame of frames.values()) {
    const closable = frame as { close?: () => void }
    if (typeof closable.close !== 'function') continue
    try {
      closable.close()
    } catch {
      // already closed
    }
  }
}

/** Triggers a browser download for an exported blob. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}
