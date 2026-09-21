import { docDuration, findMedia, sourceTimeAt } from '../factories'
import { getTransitionSpan, transitionAlphas } from '../transition'
import { animatedValue } from '../keyframes'
import { hasLinkedAudioTwin } from '../links'
import { clamp } from '../time'
import type { Clip, Doc, MediaAsset, Track } from '../types'

/**
 * Offline render plan, pure timeline math for the WebCodecs export pipeline.
 *
 * Given a doc, produces the frame-by-frame draw plan (which clips are visible
 * with which opacity/filter/transform) and the audio mix plan (which audible
 * clips contribute at which gain). The browser-side exporter (mp4.ts) executes
 * this plan against decoded frames; tests verify it in Node.
 */

export interface ClipDraw {
  clip: Clip
  asset: MediaAsset | undefined
  /** Source timestamp (seconds in the asset) this frame should show. */
  sourceTime: number
  alpha: number
  filter: string
  transform: { posX: number; posY: number; scale: number } | null
}

export interface FramePlan {
  time: number
  /** Clips to draw, bottom track first (compositor order). */
  draws: ClipDraw[]
}

export interface AudioContribution {
  clip: Clip
  asset: MediaAsset | undefined
  /** Source time window [start, end) this clip covers at frame time t. */
  sourceTime: number
  gain: number
  pan: number
}

export interface AudioFramePlan {
  time: number
  audible: AudioContribution[]
}

export const COLOR_NEUTRAL = { exposure: 1, contrast: 1, saturation: 1, brightness: 1, hue: 0 }

export function clipFilter(clip: Clip, local: number): string {
  const exposure = animatedValue(clip, 'exposure', local)
  const contrast = animatedValue(clip, 'contrast', local)
  const saturation = animatedValue(clip, 'saturation', local)
  const brightness = animatedValue(clip, 'brightness', local)
  const hue = animatedValue(clip, 'hue', local)
  const parts: string[] = []
  if (brightness !== 1) parts.push(`brightness(${brightness})`)
  if (contrast !== 1) parts.push(`contrast(${contrast})`)
  if (saturation !== 1) parts.push(`saturate(${saturation})`)
  if (hue !== 0) parts.push(`hue-rotate(${hue}deg)`)
  if (exposure !== 1) parts.push(`brightness(${Math.pow(exposure, 0.5)})`)
  return parts.length === 0 ? 'none' : parts.join(' ')
}

function clipTransform(
  clip: Clip,
  local: number,
): { posX: number; posY: number; scale: number } | null {
  const posX = animatedValue(clip, 'positionX', local)
  const posY = animatedValue(clip, 'positionY', local)
  const scale = animatedValue(clip, 'scale', local)
  const transformed = posX !== 0 || posY !== 0 || scale !== 1
  return transformed ? { posX, posY, scale } : null
}

/** True when the clip shows a frame at timeline time `t` (text tracks excluded). */
function isActive(clip: Clip, t: number): boolean {
  return t >= clip.start && t < clip.start + clip.duration
}

/** Video/image clips visible at `t`, one draw per active clip (transition-aware). */
export function planVideoFrame(doc: Doc, t: number): FramePlan {
  const draws: ClipDraw[] = []
  // Tracks composite bottom→top: last track first.
  for (let i = doc.project.tracks.length - 1; i >= 0; i--) {
    const track: Track = doc.project.tracks[i]
    if (track.kind === 'audio') continue
    const clips = [...track.clips].sort((a, b) => a.start - b.start)
    const active = clips.filter((c) => isActive(c, t))
    if (active.length === 0) continue

    const alphas = new Map<string, number>()
    if (active.length === 1) {
      alphas.set(active[0].id, 1)
    } else {
      const a = active[0]
      const b = active[1]
      const span = a.transitionOut ? getTransitionSpan(a, b) : null
      if (span && t >= span.start) {
        const { aAlpha, bAlpha } = transitionAlphas(span, t)
        alphas.set(a.id, aAlpha)
        alphas.set(b.id, bAlpha)
      } else {
        for (const clip of active) alphas.set(clip.id, 1)
      }
    }

    for (const clip of active) {
      const alpha = alphas.get(clip.id)
      if (alpha === undefined || alpha <= 0) continue
      const local = t - clip.start
      draws.push({
        clip,
        asset: findMedia(doc, clip.mediaId),
        sourceTime: sourceTimeAt(clip, local),
        alpha: alpha * animatedValue(clip, 'opacity', local),
        filter: clipFilter(clip, local),
        transform: clipTransform(clip, local),
      })
    }
  }
  return { time: t, draws }
}

/** Audible audio contributions at `t`, gain/pan resolved. */
export function planAudioFrame(doc: Doc, t: number): AudioFramePlan {
  const audible: AudioContribution[] = []
  for (const track of doc.project.tracks) {
    if (track.kind === 'text') continue
    for (const clip of track.clips) {
      if (!isActive(clip, t)) continue
      const asset = findMedia(doc, clip.mediaId)
      if (!asset) continue
      const audioBearing = asset.kind === 'audio' || clip.audioOnly
      const videoSilent = asset.kind === 'video' && hasLinkedAudioTwin(doc, clip)
      if (!audioBearing || videoSilent) continue
      if (clip.muted || track.muted || clip.reverse) continue

      const local = t - clip.start
      let gain = animatedValue(clip, 'volume', local)
      // Crossfade ramp within the transition span on this track.
      const clips = [...track.clips].sort((a, b) => a.start - b.start)
      for (let i = 0; i < clips.length - 1; i++) {
        const a = clips[i]
        const b = clips[i + 1]
        if (!a.transitionOut) continue
        const span = getTransitionSpan(a, b)
        if (!span || t < span.start || t > span.end) continue
        const p = (t - span.start) / Math.max(1e-9, span.duration)
        if (clip.id === a.id) gain *= 1 - p
        else if (clip.id === b.id) gain *= p
      }
      audible.push({
        clip,
        asset,
        sourceTime: sourceTimeAt(clip, local),
        gain: clamp(gain, 0, 2),
        pan: clamp(clip.pan ?? 0, -1, 1),
      })
    }
  }
  return { time: t, audible }
}

/** One scheduled AudioParam event for a clip's gain (timeline seconds). */
export interface GainEvent {
  time: number
  value: number
  kind: 'set' | 'ramp'
}

/**
 * The gain automation a clip's volume needs in the offline mix, in timeline
 * seconds. Keyframed clips ramp through the curve and constant-extend at the
 * clip edges; static clips hold one value. A clip that starts at 0:00 gets no
 * pre-start zero event: the event would land on the same instant as the clip's
 * own gain and silence the whole clip.
 */
export function clipGainSchedule(clip: Clip): GainEvent[] {
  const events: GainEvent[] = []
  const kfs = clip.keyframes?.volume
  if (kfs && kfs.length > 0) {
    for (const k of kfs) events.push({ time: clip.start + k.time, value: k.value, kind: 'ramp' })
    const last = kfs[kfs.length - 1]
    events.push({ time: clip.start + clip.duration, value: last.value, kind: 'ramp' })
    events.push({ time: clip.start, value: kfs[0].value, kind: 'set' })
  } else {
    events.push({ time: clip.start, value: clip.gain ?? 1, kind: 'set' })
  }
  if (clip.start > 0) events.push({ time: clip.start - 0.001, value: 0, kind: 'set' })
  return events
}

/**
 * The crossfade automation for one clip on its track: the preview mixer
 * multiplies crossfade alphas into the clip gain, so the offline mix has to
 * ramp the same way or an exported dissolve would cut instead of blend. The
 * outgoing clip ramps 1 → 0 across the span, the incoming one 0 → 1. Both ride
 * a separate gain node, so they stay multiplicative with the volume curve.
 */
export function clipCrossfadeSchedule(clip: Clip, track: Track): GainEvent[] {
  const clips = [...track.clips].sort((a, b) => a.start - b.start)
  const index = clips.findIndex((c) => c.id === clip.id)
  if (index < 0) return []
  const events: GainEvent[] = []

  const next = clips[index + 1]
  if (clip.transitionOut && next) {
    const span = getTransitionSpan(clip, next)
    if (span) {
      events.push({ time: span.start, value: 1, kind: 'set' })
      events.push({ time: span.end, value: 0, kind: 'ramp' })
    }
  }

  const prev = clips[index - 1]
  if (prev?.transitionOut) {
    const span = getTransitionSpan(prev, clip)
    if (span) {
      events.push({ time: span.start, value: 0, kind: 'set' })
      events.push({ time: span.end, value: 1, kind: 'ramp' })
    }
  }
  return events
}

/** All frame times the export renders (frame-quantized). */
export function exportFrameTimes(doc: Doc): number[] {
  const duration = docDuration(doc)
  const fps = doc.project.fps
  const total = Math.max(0, Math.round(duration * fps))
  const times: number[] = []
  for (let i = 0; i < total; i++) times.push(i / fps)
  return times
}

/** All frame plans for the export (video + audio), in order. */
export function planExport(doc: Doc): { video: FramePlan[]; audio: AudioFramePlan[] } {
  const times = exportFrameTimes(doc)
  return {
    video: times.map((t) => planVideoFrame(doc, t)),
    audio: times.map((t) => planAudioFrame(doc, t)),
  }
}

/** Asset ids referenced by video draws (for the decode warmup). */
export function videoAssetIds(plan: FramePlan[]): Set<string> {
  const ids = new Set<string>()
  for (const frame of plan) {
    for (const draw of frame.draws) {
      if (draw.asset && draw.asset.kind === 'video') ids.add(draw.asset.id)
    }
  }
  return ids
}

/** True when any planned draw needs a reversed source read. */
export function needsReverse(doc: Doc): boolean {
  return doc.project.tracks.some((t) => t.clips.some((c) => c.reverse))
}
