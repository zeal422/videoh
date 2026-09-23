import type { MediaAsset } from '../types'

/**
 * Patch fields a fresh probe contributes when an offline asset is relinked.
 *
 * One source of truth because several call sites patch the same asset shapes
 * (the media bin's manual relink, the sample import and the sample recovery),
 * and because the fields here are not cosmetic: `file` is the source handle
 * the WebCodecs exporter reads frame-accurate bytes from (`mp4.ts` skips any
 * video asset without it), and `hasAudio` is the A/V split signal. A relink
 * that dropped them would leave the asset playing in the preview but silently
 * missing from an MP4 export.
 *
 * The `mode` decides what happens to optional metadata the probe did NOT
 * produce (thumbnail, waveform peaks, `hasAudio`):
 * - `'manual'` clears them, so replacing a file with a different one never
 *   pairs the new bytes with the old file's thumbnail, waveform or audio
 *   flag (a silent replacement would keep claiming to have sound).
 * - `'sample'` preserves them: a recovery refetches the SAME bundled file,
 *   so whatever the probe could not regenerate is still the old file's own
 *   truth and must not be lost to a partial probe.
 */
export type RelinkMode = 'manual' | 'sample'

export function relinkPatchFrom(fresh: MediaAsset, mode: RelinkMode): Partial<MediaAsset> {
  const clearStale = mode === 'manual'
  return {
    url: fresh.url,
    duration: fresh.duration,
    width: fresh.width,
    height: fresh.height,
    ...(fresh.file ? { file: fresh.file } : {}),
    ...(fresh.thumbnail || clearStale ? { thumbnail: fresh.thumbnail } : {}),
    ...(fresh.hasAudio !== undefined || clearStale ? { hasAudio: fresh.hasAudio } : {}),
    ...(fresh.waveformPeaks || clearStale ? { waveformPeaks: fresh.waveformPeaks } : {}),
  }
}
