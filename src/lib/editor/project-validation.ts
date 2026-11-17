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

/** Largest project id the media store accepts as a directory name. */
export const PROJECT_ID_MAX = 128

/**
 * A project id becomes a directory name, a lock name, and an install key. Only
 * characters a generated id can contain survive, so a crafted project cannot
 * traverse the store.
 */
export function isValidProjectId(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length <= PROJECT_ID_MAX && /^[A-Za-z0-9_-]+$/.test(value)
  )
}

/**
 * Deterministic fallback for a present-but-invalid project id. The value keys
 * the OPFS directory, claims, lock, and install records, so distinct invalid
 * ids must not collapse onto one store (or onto `proj_loaded`). The type tag
 * keeps an array/object id distinct from the string of its JSON text.
 */
export function recoveredProjectId(value: unknown): string {
  return `proj_recovered_${stableIdHash(recoveredIdText(value))}`
}

/** Per-object identities for values the encoder cannot read. */
const unencodableIds = new WeakMap<object, number>()
let nextUnencodableId = 0

/** Type-tag and encode a value for the recovered-id hash. */
function recoveredIdText(value: unknown): string {
  try {
    return encodeRecoveredId(value, new Set<object>())
  } catch {
    // A revoked proxy or an object with a throwing accessor cannot be read.
    // Objects get a per-value identity, so two distinct unencodable ids stay
    // distinct without invoking coercion; the tag keeps the result apart from
    // a string that spells the same text.
    if ((typeof value === 'object' && value !== null) || typeof value === 'function') {
      const key = value as object
      let id = unencodableIds.get(key)
      if (id === undefined) {
        id = ++nextUnencodableId
        unencodableIds.set(key, id)
      }
      return `raw:${typeof value}:identity:${id}`
    }
    // Primitives do not throw during encoding, so this is defensive only.
    return `raw:${typeof value}:${String(value)}`
  }
}

/**
 * A type-preserving encoding for the recovered-id hash. JSON alone is not
 * enough: it writes null, NaN, and both infinities as `null`, and writes -0 as
 * `0`, so distinct invalid ids would share one store key. Each primitive is
 * tagged, special numbers keep their spelling, and arrays and objects encode
 * recursively. A circular reference gets a marker instead of throwing.
 */
function encodeRecoveredId(value: unknown, seen: Set<object>): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return `string:${JSON.stringify(value)}`
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'number:NaN'
    if (value === Infinity) return 'number:Infinity'
    if (value === -Infinity) return 'number:-Infinity'
    return `number:${Object.is(value, -0) ? '-0' : String(value)}`
  }
  if (typeof value === 'bigint') return `bigint:${value.toString()}`
  if (typeof value === 'boolean') return `boolean:${String(value)}`
  if (typeof value === 'undefined') return 'undefined'
  if (typeof value === 'symbol') return `symbol:${JSON.stringify(String(value.description))}`
  if (typeof value === 'function') return `function:${JSON.stringify(String(value))}`

  if (seen.has(value)) return 'circular'
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      return `array:[${value.map((item) => encodeRecoveredId(item, seen)).join(',')}]`
    }
    if (value instanceof Date) {
      return `date:${Number.isNaN(value.getTime()) ? 'Invalid' : value.toISOString()}`
    }
    if (value instanceof RegExp) return `regexp:${JSON.stringify(String(value))}`
    if (value instanceof Map) {
      const entries = [...value].map(
        ([key, item]) => `${encodeRecoveredId(key, seen)}=>${encodeRecoveredId(item, seen)}`,
      )
      return `map:{${entries.join(',')}}`
    }
    if (value instanceof Set) {
      return `set:{${[...value].map((item) => encodeRecoveredId(item, seen)).join(',')}}`
    }
    const prototype = Object.getPrototypeOf(value) as object | null
    const tag =
      prototype === null
        ? 'null-proto'
        : prototype === Object.prototype
          ? 'object'
          : `object:${(prototype.constructor as { name?: string } | undefined)?.name ?? 'anonymous'}`
    const entries = Object.keys(value).map(
      (key) =>
        `${JSON.stringify(key)}:${encodeRecoveredId((value as Record<string, unknown>)[key], seen)}`,
    )
    return `${tag}:{${entries.join(',')}}`
  } finally {
    seen.delete(value)
  }
}

/** Two FNV-1a 32-bit lanes, hex, for a 64-bit stable id suffix. */
function stableIdHash(value: string): string {
  const lane = (seed: number) => {
    let hash = seed
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
    return hash.toString(16).padStart(8, '0')
  }
  return lane(0x811c9dc5) + lane(0x050c5d1f)
}

/**
 * A stored media revision key: exactly 64 lowercase hex characters, the shape
 * of a SHA-256 digest. The value becomes an OPFS path segment, so uppercase,
 * slashes, dots, non-hex characters, and the empty string are all rejected.
 * Hydration and the store both call this, so a crafted project cannot reach the
 * file system with a path-like value.
 */
export function isValidContentHash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}
