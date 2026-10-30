/** Time helpers. All values in seconds unless noted otherwise. */

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

const pad2 = (n: number) => n.toString().padStart(2, '0')

/**
 * Whole tenths in a non-negative time, floored from the clamped total with a
 * fixed 1e-9 second tolerance. Splitting the total once avoids the
 * binary-subtraction underflow that made 2.3 read as 2.2, but a computed total
 * can still land a few ULPs below a tenth (0.3 - 0.1 is 0.19999999999999998).
 * The epsilon is `1e-8` in the tenths domain, which is 1e-9 seconds: a fixed
 * tolerance for a computed total, not an ULP-relative correction. A value more
 * than 1e-9 seconds below a tenth stays a real sub-tenth. At very large times
 * the fixed epsilon can fall below one ULP; media times under a few hours keep
 * it far above one.
 */
function toTenths(seconds: number): number {
  return Math.floor(Math.max(0, seconds) * 10 + 1e-8)
}

/**
 * Formats seconds as a compact `m:ss.d` display string (e.g. `1:07.3`).
 * Used by the status bar, inspector, markers, tooltips, and export dialog.
 */
export function formatTime(seconds: number): string {
  const tenths = toTenths(seconds)
  const m = Math.floor(tenths / 600)
  const rest = tenths % 600
  const whole = Math.floor(rest / 10)
  const tenth = rest % 10
  return `${m}:${pad2(whole)}.${tenth}`
}

/**
 * Transport clock: padded total minutes and seconds with one decimal
 * (`00:02.7`, `61:01.2`). Total minutes stay whole: an hour is `60:00.0`,
 * never `1:00:00.0`, which also keeps the battery's readout parsers simple.
 */
export function formatTransportTime(seconds: number): string {
  const tenths = toTenths(seconds)
  const minutes = Math.floor(tenths / 600)
  const rest = tenths % 600
  const whole = Math.floor(rest / 10)
  const tenth = rest % 10
  return `${pad2(minutes)}:${pad2(whole)}.${tenth}`
}

/**
 * Ruler label: padded `mm:ss` under an hour, `h:mm:ss` at or over one hour.
 * No decimal, because ruler labels sit close together.
 */
export function formatRulerTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  if (hours > 0) return `${hours}:${pad2(minutes)}:${pad2(secs)}`
  return `${pad2(minutes)}:${pad2(secs)}`
}

/**
 * Status-bar range endpoint: padded `mm:ss`, with a tenth only when the
 * endpoint is not on a whole second (`00:04`, `00:04.2`).
 */
export function formatRangeTime(seconds: number): string {
  const tenths = toTenths(seconds)
  const minutes = Math.floor(tenths / 600)
  const rest = tenths % 600
  const whole = Math.floor(rest / 10)
  const tenth = rest % 10
  const base = `${pad2(minutes)}:${pad2(whole)}`
  return tenth === 0 ? base : `${base}.${tenth}`
}

/** Status-bar duration: one decimal, with a trailing `.0` trimmed (`4s`, `4.2s`). */
export function formatDurationSeconds(seconds: number): string {
  const tenths = toTenths(seconds)
  const whole = Math.floor(tenths / 10)
  const tenth = tenths % 10
  return tenth === 0 ? `${whole}s` : `${whole}.${tenth}s`
}

/** Formats seconds as SMPTE-like timecode `hh:mm:ss:ff` (frames derived from fps). */
export function formatTimecode(seconds: number, fps: number): string {
  const s = Math.max(0, seconds)
  const totalFrames = Math.round(s * fps)
  const ff = totalFrames % fps
  const totalSeconds = Math.floor(totalFrames / fps)
  const ss = totalSeconds % 60
  const mm = Math.floor(totalSeconds / 60) % 60
  const hh = Math.floor(totalSeconds / 3600)
  const p2 = (n: number) => n.toString().padStart(2, '0')
  return `${p2(hh)}:${p2(mm)}:${p2(ss)}:${p2(ff)}`
}

/** Converts seconds to a frame index (rounded). */
export function timeToFrame(seconds: number, fps: number): number {
  return Math.round(seconds * fps)
}

/** Converts a frame index to seconds. */
export function frameToTime(frames: number, fps: number): number {
  return frames / fps
}

/** Nudges `seconds` by ±1 frame relative to zero (used by frame-stepping). */
export function stepFrames(seconds: number, fps: number, steps: number): number {
  return Math.max(0, timeToFrame(seconds, fps) + steps) / fps
}

/** Chooses a "nice" ruler tick step (seconds) so labels are >= `minPx` apart at `pxPerSec`. */
export function rulerStep(pxPerSec: number, minPx = 80): number {
  const candidates = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]
  for (const c of candidates) {
    if (c * pxPerSec >= minPx) return c
  }
  return 900
}
