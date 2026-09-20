import type { EditorCommand } from './commands'
import { findTrack, firstCompatibleTrack, uid } from './factories'
import { resolveSelectionGroups } from './links'
import type { Clip, Doc, TrackKind } from './types'

/**
 * In-memory clip clipboard (Premiere-style Cut / Copy / Paste).
 *
 * Entries snapshot the clip PLUS the track kind it lived on, so paste can
 * re-resolve a compatible lane even if the original track was removed. A
 * copied link group stays linked on paste — with a FRESH link id, so the
 * paste is independent of the source pair. Paste targets the playhead time.
 *
 * The clipboard is session memory (module scope), NOT editor state: it never
 * participates in undo, autosave or serialization, exactly like an OS
 * clipboard.
 */

interface ClipboardEntry {
  clip: Clip
  trackKind: TrackKind
  trackId: string | null
}

let clipboard: ClipboardEntry[] | null = null

/** True when something can be pasted (menu/context-menu enablement). */
export function hasClipboardContent(): boolean {
  return clipboard !== null && clipboard.length > 0
}

/** Drops the clipboard contents (session memory hygiene; used by tests). */
export function clearClipboard(): void {
  clipboard = null
}

/**
 * Copies the whole link group of every given clip into the clipboard
 * (multi-selection aware — groups union, deduped). Returns the number of
 * clips copied (0 when none exist).
 */
export function copyClips(doc: Doc, clipIds: string[]): number {
  const members = resolveSelectionGroups(doc, clipIds)
  if (members.length === 0) return 0
  clipboard = members.map((clip) => ({
    clip: structuredClone(clip),
    trackKind: trackKindOf(doc, clip.id),
    trackId: trackIdOf(doc, clip.id),
  }))
  return clipboard.length
}

/**
 * Cut = copy + group delete, expressed as commands so the caller applies them
 * as ONE undoable step. Returns null when there is nothing to cut.
 */
export function commandsToCutClips(doc: Doc, clipIds: string[]): EditorCommand[] | null {
  const copied = copyClips(doc, clipIds)
  if (copied === 0) return null
  return resolveSelectionGroups(doc, clipIds).map((clip) => ({
    type: 'deleteClip',
    clipId: clip.id,
  }))
}

/**
 * Commands that paste the clipboard at `atTime`. Each entry prefers its
 * original track (when it still exists and fits), then the first compatible
 * track, then a new track of that kind. Link bonds survive paste with FRESH
 * ids — one fresh group per ORIGINAL group, so a multi-group clipboard
 * (e.g. a linked pair + an independent clip) pastes as exactly that: the pair
 * re-linked to each other, the independent clip still unlinked. Fresh ids
 * everywhere — paste never reuses clip ids.
 * Returns null when the clipboard is empty.
 */
export function commandsToPasteClips(doc: Doc, atTime: number): EditorCommand[] | null {
  if (!clipboard || clipboard.length === 0) return null
  // Original group id → fresh group id (one fresh group per original group).
  const freshLinkByOriginal = new Map<string, string>()

  const out: EditorCommand[] = []
  for (const entry of clipboard) {
    const targetTrackId = resolvePasteTrackId(doc, entry)
    let linkId: string | undefined
    if (entry.clip.linkId) {
      let fresh = freshLinkByOriginal.get(entry.clip.linkId)
      if (!fresh) {
        fresh = uid('link')
        freshLinkByOriginal.set(entry.clip.linkId, fresh)
      }
      linkId = fresh
    }
    const clip: Clip = {
      ...structuredClone(entry.clip),
      id: uid('clip'),
      start: Math.max(0, atTime),
      ...(linkId ? { linkId } : {}),
    }
    if (!targetTrackId) {
      // No compatible lane anywhere: create one of the entry's kind first.
      const newTrackId = uid('track')
      out.push({
        type: 'addTrack',
        kind: fallbackKind(entry),
        trackId: newTrackId,
      })
      out.push({ type: 'addClip', trackId: newTrackId, clip })
    } else {
      out.push({ type: 'addClip', trackId: targetTrackId, clip })
    }
  }
  return out
}

function resolvePasteTrackId(doc: Doc, entry: ClipboardEntry): string | undefined {
  if (entry.trackId) {
    const original = findTrack(doc, entry.trackId)
    if (original && kindFitsEntry(original.kind, entry)) return original.id
  }
  const kind = fallbackKind(entry)
  // fallbackKind is a TRACK kind (text entries belong on text tracks), while
  // firstCompatibleTrack works on MEDIA kinds — resolve text separately.
  if (kind === 'text') {
    return doc.project.tracks.find((t) => t.kind === 'text')?.id
  }
  const compatible = firstCompatibleTrack(doc, kind)
  if (compatible && kindFitsEntry(compatible.kind, entry)) return compatible.id
  return undefined
}

function fallbackKind(entry: ClipboardEntry): 'video' | 'audio' | 'text' {
  if (entry.clip.text !== undefined) return 'text'
  if (entry.clip.audioOnly || entry.trackKind === 'audio') return 'audio'
  return 'video'
}

function kindFitsEntry(trackKind: TrackKind, entry: ClipboardEntry): boolean {
  if (entry.clip.text !== undefined) return trackKind === 'text'
  // audioOnly occurrences of a video asset belong on audio tracks.
  if (entry.clip.audioOnly) return trackKind === 'audio'
  if (trackKind === 'text') return false
  return trackKind === entry.trackKind
}

function trackKindOf(doc: Doc, clipId: string): TrackKind {
  const track = doc.project.tracks.find((t) => t.clips.some((c) => c.id === clipId))
  return track?.kind ?? 'video'
}

function trackIdOf(doc: Doc, clipId: string): string | null {
  return doc.project.tracks.find((t) => t.clips.some((c) => c.id === clipId))?.id ?? null
}
