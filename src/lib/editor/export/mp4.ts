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
  StreamTarget,
  type StreamTargetChunk,
  VideoSampleSink,
  VideoSampleSource,
} from 'mediabunny'
import { EQ_DB_MAX, EQ_DB_MIN } from '../constants'
import { clampSourceTime, docDuration, findMedia, findSequence } from '../factories'
import { constantTimeScaleRate } from '../keyframes'
import { clipRendersAudio, linkGroupChangesRate } from '../links'
import { findLut } from '../lut'
import {
  drawBlendedContain,
  drawContain,
  drawTextClip,
  paintSpatialMask,
} from '../playback/compositor'
import { denoiseFilters } from '../playback/denoise'
import { clamp } from '../time'
import {
  blendWeight,
  clipCrossfadeSchedule,
  clipGainSchedule,
  EXPORT_AUDIO_BITRATE,
  EXPORT_VIDEO_BITRATES,
  flattenDraws,
  planVideoFrame,
  type ClipDraw,
} from './offline'
import type { Clip, Doc, ProjectLut, Track } from '../types'

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

/**
 * The outcome of an export: a Blob for the in-memory Download, or the file
 * name and byte count for a streamed Export to file (no Blob exists there).
 */
export type ExportResult =
  | { kind: 'blob'; blob: Blob; mimeType: string; duration: number }
  | { kind: 'file'; fileName: string; bytes: number; mimeType: string; duration: number }

/**
 * The file-like sink a streamed export writes to. A `FileSystemWritableFileStream`
 * satisfies this structurally; keeping it minimal keeps the streamed target
 * Node-testable.
 */
export interface ExportFileSink {
  write(chunk: StreamTargetChunk): Promise<void>
  close(): Promise<void>
  abort(reason?: unknown): Promise<void>
}

export interface ExportOptions {
  onProgress?: (t: number, duration: number) => void
  quality?: 'low' | 'medium' | 'high'
  /** Stream the MP4 to this file sink instead of buffering it in memory. */
  fileStream?: ExportFileSink
  /** The name reported for a streamed export. */
  fileName?: string
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

/**
 * Transparent scratch surfaces for compound group composites, indexed by
 * recursion depth. Lazily allocated and reused across frames; the stack depth
 * is bounded by the nesting limit, and each level is cleared before reuse so no
 * stale pixels leak between sibling compounds.
 */
const compoundScratch: HTMLCanvasElement[] = []

function scratchContext(
  depth: number,
  width: number,
  height: number,
): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') return null
  const canvas = (compoundScratch[depth] ??= document.createElement('canvas'))
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }
  return canvas.getContext('2d')
}

/**
 * Draws one composited frame from the draw plan onto the export canvas.
 *
 * A compound clip's `nested` plan is composited into a transparent scratch
 * surface at this recursion level, then that single surface is drawn with the
 * container's alpha, filter and transform (a GROUP composite). `depth` is the
 * scratch index for compounds drawn at THIS level; the root call (depth 0)
 * fills the frame black, nested surfaces are cleared instead.
 */
export function compositeFrame(
  ctx: CanvasRenderingContext2D,
  doc: Doc,
  drawPlan: ReturnType<typeof planVideoFrame>,
  frames: Map<string, VideoFrame | ImageBitmap | HTMLImageElement>,
  width: number,
  height: number,
  blends: Map<string, BlendSample>,
  depth = 0,
): void {
  ctx.save()
  ctx.globalAlpha = 1
  if (depth === 0) {
    ctx.fillStyle = '#000000'
    ctx.fillRect(0, 0, width, height)
  } else {
    ctx.clearRect(0, 0, width, height)
  }
  ctx.restore()

  for (const draw of drawPlan.draws) {
    const spatial = draw.spatial
    if (spatial?.role === 'incoming' && spatial.geometry.wipeRect && spatial.geometry.featherBand) {
      paintFeatheredIncoming(ctx, doc, draw, frames, width, height, blends, depth)
      continue
    }
    ctx.save()
    if (spatial) {
      const geo = spatial.geometry
      if (spatial.role === 'outgoing') {
        ctx.translate(geo.aOffset.x, geo.aOffset.y)
      } else if (geo.wipeRect) {
        ctx.beginPath()
        ctx.rect(geo.wipeRect.x, geo.wipeRect.y, geo.wipeRect.w, geo.wipeRect.h)
        ctx.clip()
      } else {
        ctx.translate(geo.bOffset.x, geo.bOffset.y)
      }
    }
    paintExportDraw(ctx, doc, draw, frames, width, height, blends, depth)
    ctx.restore()
  }
}

/** Dedicated scratch surfaces for feathered-wipe masking, one per nesting depth (never the compound scratch). */
const featherScratch: HTMLCanvasElement[] = []

/**
 * Feathered incoming picture: renders the draw into a scratch surface, masks
 * it with the shared `paintSpatialMask`, and blits the result. The outgoing
 * picture is already underneath at full opacity, so the band cross-blends
 * the pair with the frame fully covered.
 */
function paintFeatheredIncoming(
  ctx: CanvasRenderingContext2D,
  doc: Doc,
  draw: ClipDraw,
  frames: Map<string, VideoFrame | ImageBitmap | HTMLImageElement>,
  width: number,
  height: number,
  blends: Map<string, BlendSample>,
  depth: number,
): void {
  const geo = draw.spatial?.geometry
  if (typeof document === 'undefined' || !geo) {
    ctx.save()
    if (geo?.wipeRect) {
      ctx.beginPath()
      ctx.rect(geo.wipeRect.x, geo.wipeRect.y, geo.wipeRect.w, geo.wipeRect.h)
      ctx.clip()
    }
    paintExportDraw(ctx, doc, draw, frames, width, height, blends, depth)
    ctx.restore()
    return
  }
  const canvas = (featherScratch[depth] ??= document.createElement('canvas'))
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }
  const sctx = canvas.getContext('2d')
  if (!sctx) {
    ctx.save()
    if (geo.wipeRect) {
      ctx.beginPath()
      ctx.rect(geo.wipeRect.x, geo.wipeRect.y, geo.wipeRect.w, geo.wipeRect.h)
      ctx.clip()
    }
    paintExportDraw(ctx, doc, draw, frames, width, height, blends, depth)
    ctx.restore()
    return
  }
  sctx.save()
  sctx.globalAlpha = 1
  sctx.clearRect(0, 0, width, height)
  paintExportDraw(sctx, doc, draw, frames, width, height, blends, depth)
  paintSpatialMask(sctx, geo, width, height)
  sctx.restore()
  ctx.drawImage(canvas, 0, 0)
}

/** One plan entry onto the target context (extracted body of the draw loop). */
function paintExportDraw(
  ctx: CanvasRenderingContext2D,
  doc: Doc,
  draw: ClipDraw,
  frames: Map<string, VideoFrame | ImageBitmap | HTMLImageElement>,
  width: number,
  height: number,
  blends: Map<string, BlendSample>,
  depth: number,
): void {
  if (draw.nested) {
    const sctx = scratchContext(depth, width, height)
    if (!sctx) return
    compositeFrame(sctx, doc, draw.nested, frames, width, height, blends, depth + 1)
    const lut = findLut(doc.project.luts, draw.clip.lutId)
    const alpha = Math.min(1, Math.max(0, draw.alpha))
    drawContain(ctx, compoundScratch[depth], width, height, alpha, draw.filter, draw.transform, lut)
    return
  }
  // Text clips have no decoded frame: they are drawn by the same helper the
  // preview compositor uses, so exported titles match the program monitor.
  if (draw.clip.text !== undefined && draw.clip.style) {
    drawTextClip(ctx, draw.clip, width, height, draw.alpha, draw.filter, draw.transform)
    return
  }
  const source = frames.get(draw.clip.id)
  if (!source) return
  // The clip's LUT, resolved exactly the way the preview compositor resolves
  // it: a 1D shaper already rides `draw.filter`, a 3D cube is applied here.
  const lut = findLut(doc.project.luts, draw.clip.lutId)
  // Alpha is clamped here: the plan carries the clip's own opacity stack and
  // a malformed doc must not draw outside 0..1. Both paths then share the
  // geometry, the grading and the blend compositing (playback/compositor.ts).
  const alpha = Math.min(1, Math.max(0, draw.alpha))
  const blend = blends.get(draw.clip.id)
  if (blend && blend.frame !== source) {
    drawBlendedContain(ctx, {
      blend: { first: source, second: blend.frame, weight: blend.weight },
      width,
      height,
      alpha,
      filter: draw.filter,
      transform: draw.transform,
      lut,
    })
    return
  }
  drawContain(ctx, source, width, height, alpha, draw.filter, draw.transform, lut)
}

/** The second decoded frame of a sub-frame-rate draw, with its blend weight. */
interface BlendSample {
  frame: VideoFrame | ImageBitmap | HTMLImageElement
  weight: number
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

  await scheduleTracks(offline, master, doc, doc.project.tracks, 0, audioBuffers)
  return offline.startRendering()
}

/**
 * Schedules one sequence's tracks into the offline graph, recursing through
 * compound clips (0.8.1). A compound's child sequence mixes into a container
 * gain node that carries the container's gain, mute and volume-keyframe curve
 * ONCE (the group's automation); `offset` is the absolute timeline time of the
 * sequence's local 0, so a nested clip's automation lands at the right instant.
 */
async function scheduleTracks(
  ctx: OfflineAudioContext,
  master: AudioNode,
  doc: Doc,
  tracks: readonly Track[],
  offset: number,
  audioBuffers: Map<string, AudioBuffer | null>,
  /** Absolute timeline end of the innermost container (Infinity at the root). */
  limitEnd: number = Number.POSITIVE_INFINITY,
): Promise<void> {
  for (const track of tracks) {
    for (const clip of track.clips) {
      if (clip.sequenceId) {
        const sequence = findSequence(doc, clip.sequenceId)
        if (!sequence) continue
        const containerGain = ctx.createGain()
        const containerXfade = ctx.createGain()
        // The container's own mute OR its owning track's mute silences the mix.
        if (clip.muted || track.muted) {
          containerGain.gain.value = 0
        } else {
          for (const ev of clipGainSchedule(clip)) {
            const t = ev.time + offset
            if (ev.kind === 'ramp') containerGain.gain.linearRampToValueAtTime(ev.value, t)
            else containerGain.gain.setValueAtTime(ev.value, t)
          }
        }
        // The container's own crossfade ramps its nested audio too, matching the
        // preview mixer (which multiplies the ancestor crossfade factor).
        for (const ev of clipCrossfadeSchedule(clip, track)) {
          const t = ev.time + offset
          if (ev.kind === 'ramp') containerXfade.gain.linearRampToValueAtTime(ev.value, t)
          else containerXfade.gain.setValueAtTime(ev.value, t)
        }
        containerGain.connect(containerXfade)
        containerXfade.connect(master)
        const containerStart = offset + clip.start
        await scheduleTracks(
          ctx,
          containerGain,
          doc,
          sequence.tracks,
          containerStart,
          audioBuffers,
          Math.min(limitEnd, containerStart + clip.duration),
        )
        continue
      }

      const scheduled = scheduledAudioSource(doc, track, clip)
      if (!scheduled) continue
      // Clip the child to its enclosing container's visible interval (0.8.1):
      // nested audio must not outlast the container that owns it.
      const startAt = offset + clip.start
      const timelineSpan = Math.min(clip.duration, limitEnd - startAt)
      if (timelineSpan <= 0) continue

      let buffer = audioBuffers.get(scheduled.assetId)
      if (buffer === undefined) {
        buffer = await decodeAudio(scheduled.file, ctx)
        audioBuffers.set(scheduled.assetId, buffer)
      }
      if (!buffer) continue

      const source = ctx.createBufferSource()
      source.buffer = buffer

      const gain = ctx.createGain()
      // Crossfade ramps live on their own node: the preview mixer multiplies
      // them into the clip gain, and two gain nodes multiply the same way.
      const xfade = ctx.createGain()
      const panner = ctx.createStereoPanner()
      panner.pan.value = clampPan(clip.pan ?? 0)

      // Volume automation: one pure schedule (plan side) applied here, shifted
      // into the sequence's absolute timeline by `offset`.
      for (const ev of clipGainSchedule(clip)) {
        const t = ev.time + offset
        if (ev.kind === 'ramp') gain.gain.linearRampToValueAtTime(ev.value, t)
        else gain.gain.setValueAtTime(ev.value, t)
      }
      for (const ev of clipCrossfadeSchedule(clip, track)) {
        const t = ev.time + offset
        if (ev.kind === 'ramp') xfade.gain.linearRampToValueAtTime(ev.value, t)
        else xfade.gain.setValueAtTime(ev.value, t)
      }

      // EQ + compressor chain (same topology as the preview graph). The band
      // gains are clamped to the shared limits exactly like the preview, so a
      // malformed doc (a hand-edited file) cannot render two different mixes.
      let head: AudioNode = source
      if (clip.eq) {
        const low = ctx.createBiquadFilter()
        low.type = 'lowshelf'
        low.frequency.value = 200
        low.gain.value = clamp(clip.eq.low, EQ_DB_MIN, EQ_DB_MAX)
        const mid = ctx.createBiquadFilter()
        mid.type = 'peaking'
        mid.frequency.value = 1000
        mid.Q.value = 1
        mid.gain.value = clamp(clip.eq.mid, EQ_DB_MIN, EQ_DB_MAX)
        const high = ctx.createBiquadFilter()
        high.type = 'highshelf'
        high.frequency.value = 4000
        high.gain.value = clamp(clip.eq.high, EQ_DB_MIN, EQ_DB_MAX)
        head.connect(low)
        low.connect(mid)
        mid.connect(high)
        head = high
      }
      if (clip.denoise) {
        for (const filter of denoiseFilters(ctx)) {
          head.connect(filter)
          head = filter
        }
      }
      if (clip.compressor) {
        const comp = ctx.createDynamicsCompressor()
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
      // seconds and bleed over the next clip (the mirror case ends early). The
      // span is the timeline span clamped to the container's end, converted to
      // source seconds at that same rate.
      source.start(startAt, clip.inPoint, timelineSpan * constantRate)
      if (constantRate !== 1) source.playbackRate.value = constantRate
    }
  }
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
  const scan = (tracks: readonly Track[]): boolean =>
    tracks.some((track) =>
      track.clips.some((clip) => {
        if (clip.sequenceId) {
          const sequence = findSequence(doc, clip.sequenceId)
          return sequence ? scan(sequence.tracks) : false
        }
        return scheduledAudioSource(doc, track, clip) !== null
      }),
    )
  return scan(doc.project.tracks)
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

/**
 * The muxer target for an export: an in-memory BufferTarget by default, or a
 * chunked StreamTarget over the caller's file sink. Node-constructible so the
 * streamed target shape is testable.
 *
 * The wrapper's `close()` deliberately does NOT touch the file: mediabunny
 * closes unfinalized targets in `Output.finalize()`'s `finally` even when
 * finalization threw, so a wrapper that committed on close would commit a
 * partial file on failure. The caller commits the file only after finalize
 * resolves.
 */
export function createExportOutput(fileStream?: ExportFileSink): {
  output: Output
  target: BufferTarget | StreamTarget
  streamed: boolean
} {
  if (!fileStream) {
    const target = new BufferTarget()
    return {
      output: new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target }),
      target,
      streamed: false,
    }
  }
  const writable = new WritableStream<StreamTargetChunk>({
    write: (chunk) => fileStream.write(chunk),
  })
  const target = new StreamTarget(writable, { chunked: true })
  return {
    output: new Output({ format: new Mp4OutputFormat(), target }),
    target,
    streamed: true,
  }
}

/** Aborts a file sink, ignoring one that is already closed. */
async function safeAbort(sink: ExportFileSink | undefined): Promise<void> {
  if (!sink) return
  try {
    await sink.abort()
  } catch {
    // already closed or aborted
  }
}

/** Renders the whole timeline to an MP4 blob (H.264 + AAC/Opus). Throws on unsupported browsers. */
export async function exportTimeline(
  doc: Doc,
  opts: ExportOptions = {},
  handle: ExportHandle = { cancelled: false },
): Promise<ExportResult> {
  // Create the output (and any streamed sink) FIRST: every failure below,
  // including the preflight, must be able to abort a sink the caller opened.
  const { output, target, streamed } = createExportOutput(opts.fileStream)
  // The final file size, from the target's write ranges (the largest end offset).
  let bytes = 0
  if (streamed) {
    target.on('write', ({ end }) => {
      bytes = Math.max(bytes, end)
    })
  }

  const frames = new Map<string, VideoFrame | ImageBitmap | HTMLImageElement>()
  // The second decoded frame of a blended draw, keyed by clip id like `frames`
  // (which the blend never extends: a blended clip keeps its primary sample).
  const blends = new Map<string, BlendSample>()
  // Set once `finalize()` resolves: a finalized output must not be cancelled
  // (cancel on it is a harmless no-op, but the flag keeps the intent exact).
  let finalized = false

  try {
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

    const totalFrames = Math.max(0, Math.round(duration * fps))

    const videoSource = new CanvasSource(canvas, {
      codec: 'avc',
      quality: new Quality({ bitrate: EXPORT_VIDEO_BITRATES[opts.quality ?? 'medium'] }),
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

    for (let i = 0; i < totalFrames; i++) {
      if (handle.cancelled) throw new Error('Export cancelled')
      const t = i / fps
      const plan = planVideoFrame(doc, t)

      // Resolve every needed source frame for this timeline frame. Release the
      // previous frame's decoded surfaces first: they hold memory until closed.
      closeDecodedFrames(frames)
      frames.clear()
      for (const blend of blends.values()) closeDecodedFrame(blend.frame)
      blends.clear()
      for (const draw of flattenDraws(plan)) {
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
          const primaryTimestamp = sample.timestamp
          const bitmap = await createImageBitmap(sample.toCanvasImageSource() as CanvasImageSource)
          sample.close()
          frames.set(draw.clip.id, bitmap)
          if (draw.blendTime !== undefined) {
            // One extra sample per blended frame, and only when the decoder
            // actually advanced: a pair that snaps to the same frame has no
            // weight to give, so it is closed again and nothing is stored.
            const blendTime = clampSourceTime(draw.blendTime, asset)
            const second = await sink.getSample(
              draw.clip.reverse ? nextLowerFrame(blendTime, fps) : blendTime,
            )
            if (second) {
              const weight = blendWeight(sourceTime, primaryTimestamp, second.timestamp)
              if (weight > 0 && weight < 1) {
                const blendBitmap = await createImageBitmap(
                  second.toCanvasImageSource() as CanvasImageSource,
                )
                blends.set(draw.clip.id, { frame: blendBitmap, weight })
              }
              second.close()
            }
          }
        }
      }

      compositeFrame(ctx, doc, plan, frames, width, height, blends)
      await videoSource.add(t, 1 / fps)
      opts.onProgress?.(t + 1 / fps, duration)
    }
    if (audioSource && audioBuffer) {
      await audioSource.add(audioBuffer)
      audioSource.close()
    }

    await output.finalize()
    finalized = true

    if (handle.cancelled) throw new Error('Export cancelled')

    if (streamed && opts.fileStream) {
      // finalize resolved: NOW commit the file (close, not abort).
      await opts.fileStream.close()
      return {
        kind: 'file',
        fileName: opts.fileName ?? 'export.mp4',
        bytes,
        mimeType: 'video/mp4',
        duration,
      }
    }

    const buffer = (target as BufferTarget).buffer
    if (!buffer) throw new Error('Export produced no data')
    return {
      kind: 'blob',
      blob: new Blob([buffer], { type: 'video/mp4' }),
      mimeType: 'video/mp4',
      duration,
    }
  } catch (error) {
    // Any failure discards the destination: a streamed file is aborted, never
    // committed (the wrapper's close() is a no-op, so nothing partial lands).
    if (streamed) await safeAbort(opts.fileStream)
    throw error
  } finally {
    closeDecodedFrames(frames)
    for (const blend of blends.values()) closeDecodedFrame(blend.frame)
    blends.clear()
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
    quality: new Quality({ bitrate: EXPORT_AUDIO_BITRATE }),
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
  for (const frame of frames.values()) closeDecodedFrame(frame)
}

/**
 * Closes one decoded surface (a no-op for an image element, and for an already
 * closed surface). Frame blending holds a SECOND surface per blended clip, so
 * the single-surface form is what the blend map can reuse.
 * @internal exported for tests
 */
export function closeDecodedFrame(frame: VideoFrame | ImageBitmap | HTMLImageElement): void {
  const closable = frame as { close?: () => void }
  if (typeof closable.close !== 'function') return
  try {
    closable.close()
  } catch {
    // already closed
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
