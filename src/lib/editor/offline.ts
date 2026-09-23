import { findMedia } from './factories'
import type { Doc } from './types'

/**
 * Offline-media detection for the monitor.
 *
 * A project load or a session restore hydrates every asset with an empty URL
 * and `missing: true` (object URLs cannot persist). The compositor draws black
 * for those clips and the engine plays no sound, so a frame that needs offline
 * media looks exactly like a broken preview. This is the fact the monitor
 * needs to say so instead: which file names the current frame is missing.
 *
 * - Text clips carry no media and are ignored.
 * - A clip whose `mediaId` no longer resolves is skipped too: there is no asset
 *   to name and no asset the Media bin could relink.
 * - Names are deduplicated, so an A/V pair of the same file reports once.
 */
export function offlineMediaAt(doc: Doc, time: number): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  for (const track of doc.project.tracks) {
    for (const clip of track.clips) {
      if (time < clip.start || time >= clip.start + clip.duration) continue
      const asset = findMedia(doc, clip.mediaId)
      if (!asset || !(asset.missing || !asset.url)) continue
      if (seen.has(asset.name)) continue
      seen.add(asset.name)
      names.push(asset.name)
    }
  }
  return names
}
