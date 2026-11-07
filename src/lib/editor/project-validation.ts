import { GAIN_MAX, GAIN_MIN, TRANSITION_MAX, TRANSITION_MIN, WAVEFORM_BUCKETS } from './constants'
import { clamp } from './time'

/**
 * Trust-boundary validators shared by project hydration and the relink
 * command. Both paths accept a value a user did not create in this session, so
 * both must apply the same rules; a validator that lives only in one path is a
 * bypass for the other.
 */

/** Largest thumbnail data URL the loader will keep (characters). */
export const THUMBNAIL_MAX_CHARS = 512 * 1024

const THUMBNAIL_PREFIX = 'data:image/jpeg;base64,'

/**
 * Only the JPEG data URL `makeThumbnail` produces survives a load or relink.
 * External, protocol-relative, blob, SVG, and non-image URLs are rejected so a
 * crafted project cannot make the browser contact another host.
 */
export function sanitizeThumbnail(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.startsWith(THUMBNAIL_PREFIX)) return undefined
  if (value.length > THUMBNAIL_MAX_CHARS) return undefined
  const payload = value.slice(THUMBNAIL_PREFIX.length)
  if (payload.length === 0) return undefined
  // Standard base64 in complete four-character groups, with only the final
  // group allowed to carry padding (`AA==` or `AAA=`). This rejects HTML,
  // whitespace, URL-safe alphabet variants, `A`, and misplaced padding such as
  // `AAAA==` that would otherwise ride into an `<img src>`.
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload)) {
    return undefined
  }
  return value
}

/** A dense WAVEFORM_BUCKETS array of finite 0..1 numbers. */
export function isValidWaveformPeaks(value: unknown): value is number[] {
  if (!Array.isArray(value) || value.length !== WAVEFORM_BUCKETS) return false
  for (let i = 0; i < WAVEFORM_BUCKETS; i++) {
    // `every` skips holes, so a sparse array would slip through; an explicit
    // own-index check makes a missing entry fail.
    if (!Object.prototype.hasOwnProperty.call(value, i)) return false
    const peak = value[i]
    if (typeof peak !== 'number' || !Number.isFinite(peak) || peak < 0 || peak > 1) return false
  }
  return true
}

/** Finite gain clamped to the range the gain command and the mixer apply. */
export function sanitizeGain(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return clamp(value, GAIN_MIN, GAIN_MAX)
}

/**
 * A positive finite transition duration clamped to the command bounds. A
 * non-finite or non-positive value drops the transition instead of clamping
 * it: a zero duration has no meaning and would leave a dead entry in the
 * inspector.
 */
export function sanitizeTransitionDuration(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return clamp(value, TRANSITION_MIN, TRANSITION_MAX)
}
