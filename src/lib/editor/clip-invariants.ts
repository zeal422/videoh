/**
 * clip-invariants.ts: the shared shape/compound field invariants (0.28.2).
 *
 * A shape clip is a generated picture source, and a compound clip is a nested
 * sequence reference: neither may also carry media, text, or retiming fields.
 * The command layer and hydration enforce the same list, so the rules live here
 * once instead of drifting between the two trust boundaries.
 */

import type { Clip } from './types'

/** Incompatible field names on a shape clip, or null when the clip is valid. */
export function shapeClipViolations(clip: Clip): string[] | null {
  if (!clip.shape) return null
  const violations: string[] = []
  if (clip.mediaId !== undefined) violations.push('mediaId')
  if (clip.text !== undefined) violations.push('text')
  if (clip.style !== undefined) violations.push('style')
  if (clip.isCaption === true) violations.push('isCaption')
  if (clip.sequenceId !== undefined) violations.push('sequenceId')
  if (clip.audioOnly === true) violations.push('audioOnly')
  if (clip.linkId !== undefined) violations.push('linkId')
  if (clip.speed !== undefined) violations.push('speed')
  if (clip.reverse) violations.push('reverse')
  if (clip.lutId !== undefined) violations.push('lutId')
  if (clip.keyframes?.timeScale !== undefined) violations.push('keyframes.timeScale')
  return violations.length > 0 ? violations : null
}

/** Incompatible field names on a compound clip, or null when the clip is valid. */
export function compoundClipViolations(clip: Clip): string[] | null {
  if (!clip.sequenceId) return null
  const violations: string[] = []
  if (clip.mediaId !== undefined) violations.push('mediaId')
  if (clip.text !== undefined) violations.push('text')
  if (clip.audioOnly === true) violations.push('audioOnly')
  if (clip.speed !== undefined) violations.push('speed')
  if (clip.reverse) violations.push('reverse')
  if (clip.keyframes?.timeScale !== undefined) violations.push('keyframes.timeScale')
  return violations.length > 0 ? violations : null
}
