/** Time helpers. All values in seconds unless noted otherwise. */

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Formats seconds as a compact `m:ss.d` display string (e.g. `1:07.3`).
 * Used by the transport and timeline ruler.
 */
export function formatTime(seconds: number): string {
  const s = Math.max(0, seconds)
  const m = Math.floor(s / 60)
  const rest = s - m * 60
  const whole = Math.floor(rest)
  const tenth = Math.floor((rest - whole) * 10)
  return `${m}:${whole.toString().padStart(2, '0')}.${tenth}`
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
