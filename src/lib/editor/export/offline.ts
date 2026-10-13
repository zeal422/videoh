import { clipFilter } from '../color'
import {
  docDuration,
  findMedia,
  findSequence,
  rootReachableSequences,
  sourceTimeAt,
} from '../factories'
import { blendPartnerTime } from '../frame-blend'
import { findLut } from '../lut'
import { crossfadeFactor, getTransitionSpan, transitionAlphas } from '../transition'
import { animatedValue } from '../keyframes'
import { segmentControls } from '../ease-segment'
import { clipRendersAudio, linkGroupChangesRate } from '../links'
import { clamp } from '../time'
import type { Clip, Doc, MediaAsset, Track } from '../types'

/**
 * Offline render plan, pure timeline math for the WebCodecs export pipeline.
 *
 * Given a doc, produces the frame-by-frame draw plan (which clips are visible
 * with which opacity/filter/transform) and the audio mix plan (which audible
 * clips contribute at which gain). The browser-side exporter (mp4.ts) executes
 * this plan against decoded frames; tests verify it in Node.
 *
 * The sub-frame-rate blend pair it plans is shared math, not export-only: the
 * preview engine parks its second element from the same function, so a slow
 * clip cannot be stepped in the monitor and blended in the file. That math
 * lives in frame-blend.ts; `blendWeight` is re-exported here because the plan
 * carries the pair.
 */

export { blendWeight } from '../frame-blend'

export interface ClipDraw {
  clip: Clip
  asset: MediaAsset | undefined
  /** Source timestamp (seconds in the asset) this frame should show. */
  sourceTime: number
  /**
   * The source timestamp one OUTPUT frame later, when the clip plays below the
   * frame rate (0.7.0). It is the partner the exporter blends the decoded frame
   * with, so a slow clip reads a weighted pair instead of a held frame.
   *
   * Set for VIDEO draws only, and only when that read is strictly ahead (see
   * blendPartnerTime in frame-blend.ts): a still image, a text clip, a clip
   * playing at or above realtime and a reversed clip (whose read walks
   * backwards) all keep their single sample.
   */
  blendTime?: number
  alpha: number
  filter: string
  transform: { posX: number; posY: number; scale: number } | null
  /**
   * For a compound clip (0.8.1): the nested plan of its referenced sequence at
   * container-local time. The exporter renders this into a transparent scratch
   * surface and composites that single surface with the container's alpha,
   * filter and transform (a GROUP composite, not a per-child fan-out).
   */
  nested?: FramePlan
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

// The filter string comes from the ONE shared builder in color.ts, so the plan
// and the preview compositor cannot drift apart (see the static lock and the
// cross-path agreement test in color.test.ts).

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

/**
 * Video/image clips visible at `t`, one draw per active clip (transition-aware).
 * Recurses through compound clips (0.8.1): a compound draw carries the nested
 * plan of its referenced sequence at container-local time, rendered as a group
 * by the exporter. The export ALWAYS starts from the project root tracks; the
 * `tracks` parameter is the recursion's own child-track list, never the active
 * sequence path.
 */
export function planVideoFrame(
  doc: Doc,
  t: number,
  tracks: readonly Track[] = doc.project.tracks,
): FramePlan {
  const draws: ClipDraw[] = []
  // Tracks composite bottom→top: last track first.
  for (let i = tracks.length - 1; i >= 0; i--) {
    const track: Track = tracks[i]
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
      const filter = clipFilter(clip, local, findLut(doc.project.luts, clip.lutId))
      const transform = clipTransform(clip, local)
      if (clip.sequenceId) {
        const sequence = findSequence(doc, clip.sequenceId)
        if (!sequence) continue
        draws.push({
          clip,
          asset: undefined,
          sourceTime: 0,
          alpha: alpha * animatedValue(clip, 'opacity', local),
          filter,
          transform,
          nested: planVideoFrame(doc, local, sequence.tracks),
        })
        continue
      }
      const drawAsset = findMedia(doc, clip.mediaId)
      draws.push({
        clip,
        asset: drawAsset,
        sourceTime: sourceTimeAt(clip, local),
        blendTime: blendPartnerTime(clip, local, drawAsset, doc.project.fps),
        alpha: alpha * animatedValue(clip, 'opacity', local),
        // The clip's LUT is resolved here so both render paths hand `clipFilter`
        // the same entry: a 1D shaper lands in this string, a 3D cube is applied
        // to the decoded frames by the renderer instead.
        filter,
        transform,
      })
    }
  }
  return { time: t, draws }
}

/** Every draw in a plan tree, nested compound draws included (for decoding). */
export function flattenDraws(plan: FramePlan, out: ClipDraw[] = []): ClipDraw[] {
  for (const draw of plan.draws) {
    out.push(draw)
    if (draw.nested) flattenDraws(draw.nested, out)
  }
  return out
}

/**
 * Audible audio contributions at `t`, gain/pan resolved. Recurses through
 * compound clips (0.8.1): a compound's children contribute at their
 * container-local time, and every enclosing container's gain multiplies in
 * once (`ancestorGain`). The live mix uses `renderAudioMix`; this plan mirrors
 * it for tests and the offline plan.
 */
export function planAudioFrame(
  doc: Doc,
  t: number,
  tracks: readonly Track[] = doc.project.tracks,
  offset = 0,
  ancestorGain = 1,
): AudioFramePlan {
  const audible: AudioContribution[] = []
  const seqT = t - offset
  for (const track of tracks) {
    if (track.kind === 'text') continue
    for (const clip of track.clips) {
      if (clip.sequenceId) {
        const sequence = findSequence(doc, clip.sequenceId)
        if (!sequence) continue
        // The container's own mute OR its owning track's mute silences the mix.
        if (!isActive(clip, seqT) || clip.muted || track.muted) continue
        const containerGain =
          animatedValue(clip, 'volume', seqT - clip.start) * crossfadeFactor(track, clip, seqT)
        audible.push(
          ...planAudioFrame(
            doc,
            t,
            sequence.tracks,
            offset + clip.start,
            ancestorGain * containerGain,
          ).audible,
        )
        continue
      }
      if (!isActive(clip, seqT)) continue
      const asset = findMedia(doc, clip.mediaId)
      if (!asset) continue
      if (!clipRendersAudio(doc, clip)) continue
      // The skip is DERIVED from the rates (linkGroupChangesRate): both halves
      // of an A/V pair go silent together, while a manual link with no carrier
      // keeps its own audio; the reverse skip it mirrors is a plain stored flag.
      if (clip.muted || track.muted || clip.reverse || linkGroupChangesRate(doc, clip)) continue

      const local = seqT - clip.start
      let gain = animatedValue(clip, 'volume', local)
      // Crossfade ramp within the transition span on this track.
      const clips = [...track.clips].sort((a, b) => a.start - b.start)
      for (let i = 0; i < clips.length - 1; i++) {
        const a = clips[i]
        const b = clips[i + 1]
        if (!a.transitionOut) continue
        const span = getTransitionSpan(a, b)
        if (!span || seqT < span.start || seqT > span.end) continue
        const p = (seqT - span.start) / Math.max(1e-9, span.duration)
        if (clip.id === a.id) gain *= 1 - p
        else if (clip.id === b.id) gain *= p
      }
      audible.push({
        clip,
        asset,
        sourceTime: sourceTimeAt(clip, local),
        gain: clamp(gain * ancestorGain, 0, 2),
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

/** Samples per eased segment: enough to follow the curve, cheap to schedule. */
const GAIN_EASE_SAMPLES = 16

/**
 * The gain automation a clip's volume needs in the offline mix, in timeline
 * seconds. Keyframed clips ramp through the curve and constant-extend at the
 * clip edges; static clips hold one value. A clip that starts at 0:00 gets no
 * pre-start zero event: the event would land on the same instant as the clip's
 * own gain and silence the whole clip. A segment whose outgoing keyframe eases
 * is sampled into short linear ramps, because the Web Audio automation the
 * exporter schedules has no easing primitive: without the samples the export
 * would flatten every eased volume curve the preview plays.
 *
 * Returned in chronological order. The Web Audio spec keeps a time-ordered
 * event list, so browsers normalize insertion order, but the contract is
 * explicit here rather than assumed of every engine.
 */
export function clipGainSchedule(clip: Clip): GainEvent[] {
  const events: GainEvent[] = []
  const kfs = clip.keyframes?.volume
  if (kfs && kfs.length > 0) {
    for (let i = 0; i < kfs.length; i++) {
      const k = kfs[i]
      events.push({ time: clip.start + k.time, value: k.value, kind: 'ramp' })
      const next = kfs[i + 1]
      // `linearRampToValueAtTime` cannot express a preset easing, so an eased
      // segment is sampled into short linear ramps: the export then follows the
      // same `animatedValue` curve the preview plays instead of flattening it.
      // The gate is the SEGMENT SHAPE (segmentControls), not the keyframe's
      // display name: sanitizeKeyframes normalizes an absent name to linear
      // while KEEPING a valid easeOut quad, so a project file can carry real
      // easing under the linear name, and the preview evaluates that shape.
      if (next && segmentControls(k) !== undefined) {
        const span = next.time - k.time
        for (let s = 1; s < GAIN_EASE_SAMPLES; s++) {
          const local = k.time + (span * s) / GAIN_EASE_SAMPLES
          events.push({
            time: clip.start + local,
            value: animatedValue(clip, 'volume', local),
            kind: 'ramp',
          })
        }
      }
    }
    const last = kfs[kfs.length - 1]
    events.push({ time: clip.start + clip.duration, value: last.value, kind: 'ramp' })
    events.push({ time: clip.start, value: kfs[0].value, kind: 'set' })
  } else {
    events.push({ time: clip.start, value: clip.gain ?? 1, kind: 'set' })
  }
  if (clip.start > 0) events.push({ time: clip.start - 0.001, value: 0, kind: 'set' })
  return events.sort((a, b) => a.time - b.time)
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
    for (const draw of flattenDraws(frame)) {
      if (draw.asset && draw.asset.kind === 'video') ids.add(draw.asset.id)
    }
  }
  return ids
}

/** True when any planned draw needs a reversed source read (root or nested). */
export function needsReverse(doc: Doc): boolean {
  const tracks = [...doc.project.tracks, ...rootReachableSequences(doc).flatMap((s) => s.tracks)]
  return tracks.some((t) => t.clips.some((c) => c.reverse))
}

/**
 * Video bitrate per quality tier (bits per second). The single source shared by
 * the exporter's encoder and the dialog's size estimate, so the two cannot
 * disagree about what a tier costs.
 */
export const EXPORT_VIDEO_BITRATES = {
  low: 2_500_000,
  medium: 6_000_000,
  high: 12_000_000,
} as const

/** The MP4 audio bitrate (bits per second), matching the exporter's audio track. */
export const EXPORT_AUDIO_BITRATE = 192_000

/**
 * Estimated MP4 size in bytes for a duration and quality tier, from the same
 * bitrates the exporter encodes at. A hint for the dialog, not a guarantee:
 * the real file size varies with encoder decisions.
 */
export function estimateExportBytes(
  duration: number,
  quality: keyof typeof EXPORT_VIDEO_BITRATES,
): number {
  if (!(duration > 0)) return 0
  const bits = duration * (EXPORT_VIDEO_BITRATES[quality] + EXPORT_AUDIO_BITRATE)
  return Math.round(bits / 8)
}
