import { activeTracks, findMedia, findSequence, rootReachableSequences } from './factories'
import type { Doc, Track } from './types'

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
/**
 * True when any USED clip's media cannot render: its asset is offline (a
 * restored session's url-less entry), or its `mediaId` no longer resolves at
 * all. Per-clip on purpose: an offline asset nothing uses must not block an
 * export, and a dangling mediaId is not an asset the bin could relink. The
 * export dialog shares this predicate, so the gate and the preview's
 * `offlineMediaAt` describe the same condition.
 */
export function hasOfflineMedia(doc: Doc): boolean {
  // Root plus every ROOT-REACHABLE compound sequence (0.8.1): a nested clip
  // that cannot render blocks the export, but an orphan sequence the export
  // never renders must not.
  const tracks = [...doc.project.tracks, ...rootReachableSequences(doc).flatMap((s) => s.tracks)]
  return tracks.some((t) =>
    t.clips.some((c) => {
      if (!c.mediaId) return false
      const asset = findMedia(doc, c.mediaId)
      return !asset || asset.missing || !asset.url
    }),
  )
}

export function offlineMediaAt(
  doc: Doc,
  time: number,
  activeSequencePath: readonly string[] = [],
): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  // Starts at the ACTIVE sequence (its own local clock) and follows only the
  // compounds active at the current local time (0.8.1).
  const visit = (tracks: readonly Track[], offset: number): void => {
    for (const track of tracks) {
      for (const clip of track.clips) {
        const start = offset + clip.start
        if (clip.sequenceId) {
          if (time >= start && time < start + clip.duration) {
            const sequence = findSequence(doc, clip.sequenceId)
            if (sequence) visit(sequence.tracks, start)
          }
          continue
        }
        if (time < start || time >= start + clip.duration) continue
        const asset = findMedia(doc, clip.mediaId)
        if (!asset || !(asset.missing || !asset.url)) continue
        if (seen.has(asset.name)) continue
        seen.add(asset.name)
        names.push(asset.name)
      }
    }
  }
  visit(activeTracks(doc, activeSequencePath), 0)
  return names
}
