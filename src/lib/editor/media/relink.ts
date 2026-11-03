import type { MediaAsset } from '../types'

/**
 * Patch fields a fresh probe contributes when an offline asset is relinked.
 *
 * One source of truth because several call sites patch the same asset shapes
 * (the media bin's manual relink and the import auto-relink), and because the
 * fields here are not cosmetic: `file` is the source handle
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
 * - `'sample'` preserves them for a same-file recovery, so whatever the probe
 *   could not regenerate is still the old file's own truth. The bundled sample
 *   flow that used it was removed in 0.18.0, so it has no production caller.
 */
export type RelinkMode = 'manual' | 'sample'

/**
 * The command boundary's native-handle check, kept here because the pure
 * command core may not read `File`/`Blob` (AGENTS rule 2).
 *
 * A relink handle must be a real `File`, not just something that quacks like
 * one:
 * - the File-specific `name` getter returns a string (a plain `Blob` fails
 *   here; it is the clean isolate for this check because it passes every other
 *   one),
 * - `Blob.prototype.slice` accepts it, proving the Blob internal slot,
 * - `size` is finite and non-negative,
 * - `arrayBuffer` is callable. `mp4.ts` decodes the export audio mix through
 *   `file.arrayBuffer()`, and its catch returns no audio, so a native `File`
 *   with a shadowed non-function handle would silently lose sound.
 *
 * `instanceof File` is deliberately not used: in Bun it is a brand check that
 * rejects a prototype spoof before the getter can run, which would hide which
 * check refused. `arrayBuffer` is not invoked: the check is a shape guard, not
 * a decode probe.
 *
 * This is a structural check against the host's Web `File`/`Blob`
 * implementations. The editor is client-only; a non-browser host with a
 * different `File` implementation would need this guard re-examined rather
 * than assumed compatible.
 */
export function isNativeFile(value: unknown): boolean {
  if (typeof File === 'undefined' || typeof Blob === 'undefined') return false
  const nameGetter = Object.getOwnPropertyDescriptor(File.prototype, 'name')?.get
  if (!nameGetter) return false
  try {
    if (typeof nameGetter.call(value) !== 'string') return false
    Blob.prototype.slice.call(value, 0, 0)
    const size = (value as Blob).size
    if (!Number.isFinite(size) || size < 0) return false
    if (typeof (value as Blob).arrayBuffer !== 'function') return false
    return true
  } catch {
    return false
  }
}

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
