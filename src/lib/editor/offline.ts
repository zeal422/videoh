import { activeTracks, findMedia, findSequence } from './factories'
import { assetHasAudio, hasLinkedAudioTwin, linkGroupChangesRateIgnoringPlayability } from './links'
import { audibleTrackIds } from './tracks'
import type { Clip, Doc, MediaAsset, Track } from './types'

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
 * One clip reachable from the project root, with the source it would read and
 * the audibility set of the sequence that owns its track.
 */
interface OfflineScanEntry {
  clip: Clip
  track: Track
  asset: MediaAsset | undefined
  audibleTracks: Set<string>
}

/**
 * Walks every clip the root timeline renders, descending into compound
 * sequences only over the span the container actually shows. Both export
 * gates share this walk so their time windows cannot drift; their per-clip
 * predicates stay separate.
 *
 * `descend` lets the audio gate stop at a muted compound (or one whose track
 * is soloed out) before visiting its children, exactly like the old inline
 * loop did. The visual gate always descends.
 *
 * @internal exported for tests
 */
export function scanOfflineClips(
  doc: Doc,
  visit: (entry: OfflineScanEntry) => boolean | void,
  descend: (entry: OfflineScanEntry) => boolean = () => true,
): void {
  // A valid sequence graph may share a child sequence through several
  // compounds. Do not walk the same child window twice: the visible clips and
  // audibility set are identical, so the first scan already answered for it.
  const seen = new Set<string>()
  let done = false
  const scan = (
    tracks: readonly Track[],
    windowEnd: number = Number.POSITIVE_INFINITY,
    sequenceId?: string,
  ): void => {
    if (done) return
    if (sequenceId !== undefined) {
      // A compound always renders its child from child time zero (it has no
      // source window), so a sequence's visible span is [0, windowEnd]. Key by
      // the LOCAL end: the same child window at different root positions is
      // one scan, while a partially visible window stays distinct from a full
      // one.
      const key = `${sequenceId}\u0000${windowEnd}`
      if (seen.has(key)) return
      seen.add(key)
    }
    const audibleTracks = audibleTrackIds(tracks)
    for (const track of tracks) {
      if (done) return
      for (const clip of track.clips) {
        if (done) return
        // A nested clip outside its container's visible span is never
        // rendered or mixed, so its missing bytes cannot matter.
        if (clip.start >= windowEnd) continue
        const entry: OfflineScanEntry = {
          clip,
          track,
          asset: findMedia(doc, clip.mediaId),
          audibleTracks,
        }
        if (clip.sequenceId) {
          const sequence = findSequence(doc, clip.sequenceId)
          if (sequence && descend(entry)) {
            // The child starts at local zero; the parent's remaining visible
            // span caps how much of it renders.
            scan(sequence.tracks, Math.min(clip.duration, windowEnd - clip.start), sequence.id)
          }
          continue
        }
        if (visit(entry) === true) {
          done = true
          return
        }
      }
    }
  }
  scan(doc.project.tracks)
}

/**
 * True when any USED clip's media cannot render: its asset is offline (a
 * restored session's url-less entry), or its `mediaId` no longer resolves at
 * all. Per-clip on purpose: an offline asset nothing uses must not block an
 * export, and a dangling mediaId is not an asset the bin could relink. The
 * export dialog shares this predicate for video containers; audio-only
 * containers use `offlineAudibleMedia` instead.
 */
export function hasOfflineMedia(doc: Doc): boolean {
  let offline = false
  scanOfflineClips(doc, ({ clip, asset }) => {
    if (!clip.mediaId) return
    if (!asset || asset.missing || !asset.url) {
      offline = true
      return true
    }
  })
  return offline
}

/**
 * The files an audio-only export would silently lose: offline media that the
 * mix would schedule if the asset were online. Unlike `hasOfflineMedia`, this
 * ignores images, silent video, muted or soloed-out clips, reversed clips and
 * clips the rate rule drops, so those cannot block a WAV, MP3 or M4A export.
 * An unresolved mediaId carries no kind or audio flag, so it cannot be proven
 * silent; it is treated as a possible audio source and named by its id.
 */
export function offlineAudibleMedia(doc: Doc): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  scanOfflineClips(
    doc,
    ({ clip, track, asset, audibleTracks }) => {
      if (clip.muted || !audibleTracks.has(track.id)) return
      if (!clip.mediaId) return
      if (asset && !asset.missing && asset.url) return
      if (asset?.kind === 'image') return
      const audible = !asset
        ? true
        : asset.kind === 'audio' ||
          clip.audioOnly ||
          (asset.kind === 'video' && assetHasAudio(asset) && !hasLinkedAudioTwin(doc, clip))
      if (!audible) return
      if (clip.reverse) return
      if (linkGroupChangesRateIgnoringPlayability(doc, clip)) return
      const name = asset?.name ?? clip.mediaId
      if (seen.has(name)) return
      seen.add(name)
      names.push(name)
    },
    ({ clip, track, audibleTracks }) => !clip.muted && audibleTracks.has(track.id),
  )
  return names
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
