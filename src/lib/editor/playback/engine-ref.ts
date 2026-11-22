import type { Doc } from '../types'

/**
 * Module-level reference to the active playback controller (see
 * `playback/core.ts`). UI code everywhere goes through this ref so there is
 * exactly one preview engine instance per app, independent of React lifecycles.
 */
export interface PlaybackController {
  /** Starts playback from the current playhead (or resumes). */
  play(): void
  pause(): void
  toggle(): void
  /** Moves the playhead (works while playing or paused); redraws when paused. */
  seek(t: number): void
  /** Retries muted audio; no id re-arms every muted clip. Never moves the playhead. */
  retryAudio(clipId?: string): void
  /**
   * Synchronous removed-clip cleanup on every doc change (playing or paused).
   * Clears a deleted clip's mute before an immediate undo can restore it.
   */
  noteDocChanged(doc: Doc): void
  /** Nudges by N frames (negative = backwards), clamped to [0, duration]. */
  stepFrames(n: number): void
  /** Master output volume 0..1 (preview only; export always uses full mix). */
  setMasterVolume(v: number): void
}

export const playbackRef: { current: PlaybackController | null } = {
  current: null,
}
