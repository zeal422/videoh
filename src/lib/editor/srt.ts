/**
 * SRT subtitles codec (0.8.5): parse, serialize, and the doc-to-cues
 * collector behind the captions export. Pure and browser-free, so the
 * whole module runs in Vitest's Node environment. Integer milliseconds
 * throughout: SRT's native resolution, exact at every magnitude inside
 * the supported range.
 */
import { MIN_CLIP_DURATION } from './constants'
import type { Doc } from './types'

/**
 * A cue in integer milliseconds (SRT's native resolution). Integer math
 * keeps every comparison exact inside the supported range below; floats
 * cannot hold millisecond precision at arbitrary magnitudes (doubles are
 * doubles: 1e14 s already exceeds MAX_SAFE_INTEGER in milliseconds), so
 * the range is bounded deliberately instead of pretending otherwise.
 */
export interface SrtCue {
  startMs: number
  endMs: number
  text: string
}

/**
 * Supported timestamp bound: 1e9 s (~31.7 years). Millisecond values
 * stay within MAX_SAFE_INTEGER with ample float precision left for the
 * seconds conversions at the command boundary. The bound applies to the
 * rounded millisecond values, not the raw floats: start 999999999.8505
 * with duration 0.1495 stores end exactly 1000000000 (passing a raw
 * check) but rounds to endMs 1000000000001, past the millisecond limit
 * of 1000000000000.
 */
export const MAX_SRT_TIME_SECONDS = 1_000_000_000

/** Millisecond form of the bound: the value rounded cues compare against. */
const MAX_MS = MAX_SRT_TIME_SECONDS * 1000

/** Cues must last at least the engine minimum: 0.1 s in milliseconds. */
const MIN_CUE_MS = 100

/** Thrown when an otherwise eligible clip cannot be represented in SRT. */
export class SrtRangeError extends Error {}

/** `HH:MM:SS,mmm`, also accepting a `.` millisecond separator on import. */
const TIMESTAMP_RE = /^(\d+):(\d{1,2}):(\d{1,2})[,.](\d{3})$/
// Minutes and seconds accept one or two digits on purpose: the timestamp is
// still an exact millisecond value either way, so a sloppy file parses
// instead of dropping its cue. Output is always canonical two-digit.

/** Parse one timestamp to integer milliseconds, or null when malformed. */
function parseTimestamp(raw: string): number | null {
  const match = TIMESTAMP_RE.exec(raw.trim())
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  const seconds = Number(match[3])
  const millis = Number(match[4])
  if (minutes >= 60 || seconds >= 60) return null
  const total = ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis
  return Number.isFinite(total) ? Math.round(total) : null
}

/** Parse a full `start --> end` line, or null when either side is malformed. */
function parseStampLine(line: string): { startMs: number; endMs: number } | null {
  // Exactly one arrow: trailing segments (`... --> ... --> ...`) are garbage,
  // not a longer cue, so the block drops instead of silently truncating.
  if (line.split('-->').length !== 2) return null
  const [rawStart, rawEnd] = line.split('-->')
  const startMs = parseTimestamp(rawStart ?? '')
  const endMs = parseTimestamp(rawEnd ?? '')
  return startMs === null || endMs === null ? null : { startMs, endMs }
}

/**
 * Strip real SRT inline tags (`<i>`, `</b>`, `<font …>`) to plain text.
 * The name must start with a letter: literal comparisons like `x < 5 > 3`
 * are caption text, not markup, and survive the import. Brace blocks
 * (`{…}`, SSA-style overrides) strip to a fixpoint so nested runs like
 * `{a{b}c}` vanish entirely instead of leaving a stray `c}`.
 */
function stripTags(text: string): string {
  let out = text.replace(/<\/?[a-zA-Z][^>]*>/g, '')
  // Innermost brace runs first (`[^{}]*` cannot span a boundary), so nested
  // override blocks vanish layer by layer instead of leaving a stray `c}`.
  let prev = ''
  while (out !== prev) {
    prev = out
    out = out.replace(/\{[^{}]*\}/g, '')
  }
  return out
}

/**
 * Cue order: by start, then end, then text in code-unit order. Shared by
 * the parser, the collector and the captions panel, so the file and the
 * list cannot disagree about what "start order" means.
 */
export function compareSrtCues(a: SrtCue, b: SrtCue): number {
  if (a.startMs !== b.startMs) return a.startMs - b.startMs
  if (a.endMs !== b.endMs) return a.endMs - b.endMs
  if (a.text < b.text) return -1
  if (a.text > b.text) return 1
  return 0
}

/**
 * Parse SRT text into cues. Malformed blocks (no timestamp, inverted or
 * negative times, non-finite or out-of-range timestamps, blank text,
 * durations under 100 ms) are skipped and counted in `dropped`; cues come
 * back sorted by start, then end, then text in code-unit order.
 */
export function parseSrt(input: string): { cues: SrtCue[]; dropped: number } {
  const cues: SrtCue[] = []
  let dropped = 0
  const normalized = input
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trim()
  // Runs of blank lines collapse into one separator, so a cue after two or
  // more of them never inherits a leading empty line and drops.
  for (const block of normalized.split(/\n\s*\n/)) {
    const lines = block.split('\n')
    // A numeric first line counts as a sequence id only when the next line
    // parses as a timestamp; a timestamp-first block has no id at all.
    let stamps = parseStampLine(lines[0] ?? '')
    let cursor = 0
    if (stamps === null && lines.length > 1 && /^\d+$/.test((lines[0] ?? '').trim())) {
      stamps = parseStampLine(lines[1] ?? '')
      cursor = 1
    }
    if (stamps === null) {
      if (block.trim() !== '') dropped += 1
      continue
    }
    const { startMs, endMs } = stamps
    const text = stripTags(lines.slice(cursor + 1).join('\n')).trim()
    if (
      startMs < 0 ||
      endMs <= startMs ||
      endMs - startMs < MIN_CUE_MS ||
      startMs > MAX_MS ||
      endMs > MAX_MS ||
      text === ''
    ) {
      dropped += 1
      continue
    }
    cues.push({ startMs, endMs, text })
  }
  cues.sort(compareSrtCues)
  return { cues, dropped }
}

/** Format integer milliseconds as `HH:MM:SS,mmm` (no float math). */
function formatTimestamp(ms: number): string {
  const hours = Math.floor(ms / 3600000)
  const minutes = Math.floor((ms % 3600000) / 60000)
  const seconds = Math.floor((ms % 60000) / 1000)
  const millis = ms % 1000
  const pad = (v: number, len: number) => String(v).padStart(len, '0')
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)},${pad(millis, 3)}`
}

/**
 * Serialize cues to SRT, numbered sequentially from 1 in emitted order.
 * Blank cues are dropped (mirroring the export skip, so no blank flashes
 * are ever written); an end before start clamps to start + 1 ms so a cue
 * never inverts. Valid input only: cues inside the supported range with
 * end at or past start (the export path filters through
 * `collectCaptionCues` first, so out-of-range or inverted input reaching
 * the formatter directly is a programmer error, not a file case).
 */
export function serializeSrt(cues: SrtCue[]): string {
  let out = ''
  let n = 0
  for (const cue of cues) {
    if (cue.text.trim() === '') continue
    const endMs = Math.max(cue.endMs, cue.startMs + 1)
    n += 1
    out += `${n}\n${formatTimestamp(cue.startMs)} --> ${formatTimestamp(endMs)}\n${cue.text}\n\n`
  }
  return out
}

/**
 * Gather the export cue list from the doc in one place: flagged clips on
 * ROOT project tracks with text and duration of at least
 * `MIN_CLIP_DURATION`, start-ordered with the end-then-text tiebreak.
 * Flagged clips inside compound sequences stay out (container-relative
 * timing, while the cue list is absolute). Throws `SrtRangeError` when an
 * otherwise eligible clip rounds past the millisecond limit: refusing with
 * a message beats dropping it silently. Milliseconds round from the
 * stored start and duration, never from a float endpoint difference, so
 * the emitted span keeps the clip's full length at every magnitude.
 */
export function collectCaptionCues(doc: Doc): SrtCue[] {
  const cues: SrtCue[] = []
  for (const track of doc.project.tracks) {
    // Text tracks only, matching the panel's cue list: a flagged clip a
    // hand-made file strands on another kind never reaches the file.
    if (track.kind !== 'text') continue
    for (const clip of track.clips) {
      if (!clip.isCaption) continue
      // Non-string text (programmatic docs only; hydration keeps strings)
      // reads as blank, so it takes the textless skip instead of throwing
      // on .trim().
      const text = typeof clip.text === 'string' ? clip.text.trim() : ''
      if (text === '' || clip.duration < MIN_CLIP_DURATION) continue
      // No command stores non-finite times anymore (moveClip refuses them),
      // but raw file data can still carry them, and NaN passes every range
      // comparison below: finiteness is checked outright so a poisoned clip
      // refuses the export instead of downloading garbage.
      if (!Number.isFinite(clip.start) || !Number.isFinite(clip.duration)) {
        throw new SrtRangeError(`Caption "${text.slice(0, 40)}" has a non-finite time`)
      }
      const startMs = Math.round(clip.start * 1000)
      const endMs = startMs + Math.round(clip.duration * 1000)
      // The raw-seconds sign is checked too: Math.round(-0.4) is -0, and
      // -0 < 0 is false, so the millisecond check alone passes a negative
      // sub-millisecond start (matching importCaptions' cue.start < 0).
      if (clip.start < 0 || startMs < 0 || startMs > MAX_MS || endMs > MAX_MS) {
        throw new SrtRangeError(
          `Caption "${text.slice(0, 40)}" falls past the supported export range`,
        )
      }
      cues.push({ startMs, endMs, text })
    }
  }
  cues.sort(compareSrtCues)
  return cues
}
