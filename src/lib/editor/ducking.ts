import { findMedia, mediaPlayable, sourceTimeAt } from './factories'
import { linkGroupChangesRate } from './links'
import { clampPropertyValue } from './keyframes'
import type { Clip, Doc, Keyframe } from './types'

/**
 * Auto-ducking, computes a gain keyframe curve for a music clip that dips
 * under an estimated dialogue loudness curve.
 *
 * Estimation uses the asset's waveform peaks (already normalized 0..1 at
 * import). The dialogue curve is sampled over the overlap window in music-clip
 * local time, smoothed, inverted around the duck amount, and returned as
 * keyframes ready for `setClipKeyframes`. Pure analysis: no browser APIs.
 */

export interface DuckingOptions {
  /** How deep the music ducks when dialogue is loud (0..1, 0.6 = dip to 40%). */
  amount: number
  /** Peak level (0..1) above which dialogue is considered present. */
  threshold: number
  /** Gain ramp in/out around each duck (seconds, clip-local). */
  attackRelease: number
}

export const DUCKING_DEFAULTS: DuckingOptions = {
  amount: 0.6,
  threshold: 0.25,
  attackRelease: 0.15,
}

const DUCK_MIN = 0.1
const DUCK_MAX = 1
const ATTACK_MIN = 0.02
const ATTACK_MAX = 1
const SAMPLES = 96

function peakAt(peaks: number[], sourceTime: number, sourceDuration: number): number {
  if (peaks.length === 0 || sourceDuration <= 0) return 0
  const index = Math.min(
    peaks.length - 1,
    Math.max(0, Math.floor((sourceTime / sourceDuration) * peaks.length)),
  )
  return peaks[index]
}

/** Samples the dialogue level over the music clip's overlap window, smoothed. */
function dialogueCurve(doc: Doc, dialogueClips: Clip[], music: Clip): number[] {
  // Resolve each clip ONCE: a clip the rate predicate silences (a
  // rate-disagreeing A/V pair, or a clip with its own real ramp) is SILENT in
  // both render paths, and so is a REVERSED clip (both paths drop its audio);
  // none may drive the duck either, or the music would dip against source
  // that is never heard. An unplayable asset is equally silent: restoring a
  // session keeps the waveformPeaks while the file is offline (url cleared,
  // missing set), so playability is required before sampling the peaks. Every
  // check is per-clip (loop-invariant across the SAMPLES sample points), so
  // the eligible sources are built once here instead of per sample.
  const sources: { clip: Clip; peaks: number[]; duration: number }[] = []
  for (const d of dialogueClips) {
    if (d.reverse || linkGroupChangesRate(doc, d)) continue
    const asset = findMedia(doc, d.mediaId)
    if (!mediaPlayable(asset) || !asset.waveformPeaks) continue
    sources.push({ clip: d, peaks: asset.waveformPeaks, duration: asset.duration })
  }
  const samples: number[] = []
  const step = music.duration / SAMPLES
  for (let i = 0; i <= SAMPLES; i++) {
    const t = music.start + i * step // timeline time
    let level = 0
    for (const source of sources) {
      const d = source.clip
      if (t < d.start || t >= d.start + d.duration) continue
      // The single source-time mapping (speed, reverse, ramp integral), the
      // same one the preview and the export read. The old inline
      // `inPoint + local * speed` ignored a ramp and sampled the wrong part
      // of the waveform.
      const sourceTime = sourceTimeAt(d, t - d.start)
      level = Math.max(level, peakAt(source.peaks, sourceTime, source.duration))
    }
    samples.push(level)
  }
  // 3-tap smoothing so peak buckets do not produce jagged ducks.
  return samples.map((v, i) => {
    const prev = samples[Math.max(0, i - 1)]
    const next = samples[Math.min(samples.length - 1, i + 1)]
    return (prev + v * 2 + next) / 4
  })
}

/**
 * Builds the ducked gain keyframes for `music` (clip-local times). Keyframes
 * are only produced where the level crosses the threshold; clean stretches
 * stay at unity via constant extension. A duck holds the floor for as long as
 * dialogue is loud, then releases over `attackRelease` after it ends. A duck
 * still active at the clip edge just keeps holding (constant extension), since
 * there is no quiet span left to release into.
 */
export function computeDuckingKeyframes(
  doc: Doc,
  music: Clip,
  dialogueClips: Clip[],
  opts: Partial<DuckingOptions> = {},
): Keyframe[] {
  const options = { ...DUCKING_DEFAULTS, ...opts }
  const amount = clampPropertyValue('volume', 1 - Math.min(1, Math.max(0, options.amount)))
  const floor = Math.max(0.001, amount)
  const keyframes: Keyframe[] = []
  const curve = dialogueCurve(doc, dialogueClips, music)
  const step = music.duration / SAMPLES

  let ducking = false
  for (let i = 0; i < curve.length; i++) {
    const loud = curve[i] >= options.threshold
    const t = i * step
    if (loud && !ducking) {
      ducking = true
      const attackStart = Math.max(0, t - options.attackRelease)
      keyframes.push({ time: round3(attackStart), value: 1 })
      keyframes.push({ time: round3(t), value: floor })
    } else if (!loud && ducking) {
      ducking = false
      // Hold the floor at the release point, THEN ramp to unity. The hold is
      // what makes this a release: a ramp interpolates from the previous
      // keyframe, so without it the rise would start back at the duck instead
      // of at the end of the dialogue.
      keyframes.push({ time: round3(t), value: floor })
      // The release endpoint is clamped to the clip edge: when the quiet
      // transition lands at (or within attackRelease of) the end, the release
      // would reach past the clip, and a keyframe beyond the clip leaks its
      // value into clipGainSchedule's edge constant-extension. Round BEFORE
      // the clamp: rounding a value already pinned to a fractional edge can
      // push it back outside the clip (8.066666... -> 8.067), so the clamp has
      // to be the last step. When it collapses the release onto the hold, skip
      // it: the duck then just holds the floor to the edge, like a duck still
      // active at the clip end.
      const releaseTime = Math.min(round3(t + options.attackRelease), music.duration)
      if (releaseTime > t) {
        keyframes.push({ time: releaseTime, value: 1 })
      }
    }
  }
  if (keyframes.length === 0) {
    // Nothing to duck: an empty curve clears any previous ducking.
    return []
  }
  return keyframes
}

/** Clamps user-provided ducking options into legal ranges. */
export function sanitizeDuckingOptions(opts: Partial<DuckingOptions>): DuckingOptions {
  return {
    amount: Math.min(1, Math.max(0, opts.amount ?? DUCKING_DEFAULTS.amount)),
    threshold: Math.min(1, Math.max(0.01, opts.threshold ?? DUCKING_DEFAULTS.threshold)),
    attackRelease: Math.min(
      ATTACK_MAX,
      Math.max(ATTACK_MIN, opts.attackRelease ?? DUCKING_DEFAULTS.attackRelease),
    ),
  }
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

/** Finds audio-bearing clips that overlap the given timeline window. */
export function overlappingAudioClips(doc: Doc, window: { start: number; end: number }): Clip[] {
  const out: Clip[] = []
  for (const track of doc.project.tracks) {
    if (track.kind === 'text') continue
    for (const clip of track.clips) {
      if (clip === undefined) continue
      const clipEnd = clip.start + clip.duration
      if (clipEnd <= window.start || clip.start >= window.end) continue
      const asset = findMedia(doc, clip.mediaId)
      if (!asset) continue
      if (asset.kind === 'audio' || clip.audioOnly) out.push(clip)
    }
  }
  return out
}
