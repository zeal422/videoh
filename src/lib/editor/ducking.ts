import { findMedia } from './factories'
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
  const samples: number[] = []
  const step = music.duration / SAMPLES
  for (let i = 0; i <= SAMPLES; i++) {
    const t = music.start + i * step // timeline time
    let level = 0
    for (const d of dialogueClips) {
      if (t < d.start || t >= d.start + d.duration) continue
      const asset = findMedia(doc, d.mediaId)
      if (!asset?.waveformPeaks) continue
      const sourceTime = d.inPoint + (t - d.start) * (d.speed ?? 1)
      level = Math.max(level, peakAt(asset.waveformPeaks, sourceTime, asset.duration))
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
 * stay at unity via constant extension.
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
      keyframes.push({ time: round3(t), value: 1 })
    }
  }
  if (keyframes.length === 0) {
    // Nothing to duck: an empty curve clears any previous ducking.
    return []
  }
  if (ducking) {
    // Still ducked at the end: release at the clip edge.
    keyframes.push({ time: round3(music.duration), value: 1 })
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
