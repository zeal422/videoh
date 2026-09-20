'use client'

import { useRef, useState } from 'react'
import {
  Copy,
  CopyPlus,
  Link2,
  Scissors,
  Split,
  Trash2,
  Unlink,
  ClipboardPaste,
} from 'lucide-react'
import { MIN_CLIP_DURATION } from '@/lib/editor/constants'
import { findMedia } from '@/lib/editor/factories'
import { SNAP_THRESHOLD_PX } from '@/lib/editor/constants'
import { applySnap, computeSnapPoints } from '@/lib/editor/snap'
import {
  commandsToDeleteClips,
  commandsToDuplicateClips,
  commandsToLinkClips,
  commandsToRippleDeleteClips,
  commandsToSplitClipsAt,
  commandsToUnlinkClips,
} from '@/lib/editor/actions'
import {
  commandsToCutClips,
  commandsToPasteClips,
  copyClips,
  hasClipboardContent,
} from '@/lib/editor/clipboard'
import {
  anySelectionLinked,
  canLinkClips,
  canSplitAnySelectedAt,
  clipIsSelected,
  linkedClips,
  resolveSelectionGroups,
} from '@/lib/editor/links'
import { useEditorStore } from '@/lib/editor/store'
import type { Clip, Doc, MediaAsset, Track } from '@/lib/editor/types'
import { toast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import { Waveform } from './Waveform'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'

/**
 * A single clip on the timeline: drag to move (across compatible tracks),
 * edge-handles to trim, click to select, right-click for the clip menu.
 * All gestures run as transient store updates and commit exactly ONE undo
 * entry per gesture.
 *
 * Selection (Premiere-style): plain click selects the clip's link group,
 * Shift+click ADDS another clip's group to the selection, Ctrl+click toggles
 * it. Every group op (move/delete/cut/split/link…) runs on the WHOLE
 * selection.
 *
 * Tools (Premiere V/C): with the razor tool active (press C), pointer-down
 * cuts the clip at the pointer position instead of starting a move.
 */
export function ClipView({
  doc,
  clip,
  track,
  pxPerSec,
  height,
  fadeIn,
  onSnapGuide,
}: {
  doc: Doc
  clip: Clip
  track: Track
  pxPerSec: number
  height: number
  /** Effective crossfade-in duration (previous clip overlaps this one's head). */
  fadeIn: number
  onSnapGuide: (t: number | null) => void
}) {
  const selections = useEditorStore((s) => s.selections)
  const activeTool = useEditorStore((s) => s.activeTool)
  const snapEnabled = useEditorStore((s) => s.snapEnabled)
  // Right-click must (a) select the clip BEFORE any menu action runs and
  // (b) re-evaluate clipboard/split enablement at open time — both are
  // store-external facts (module clipboard, live playhead) that a plain
  // render could leave stale, so opening the menu bumps a re-render tick.
  const [, setMenuTick] = useState(0)
  // Group-aware selection: a clip highlights when IT or a link-group partner
  // is selected (Premiere highlights both halves of an A/V pair).
  const isSelected = clipIsSelected(doc, selections, clip)

  const asset: MediaAsset | undefined = findMedia(doc, clip.mediaId)
  const isMedia = !!asset && asset.kind !== 'image' && track.kind !== 'text'
  const widthPx = Math.max(6, clip.duration * pxPerSec)
  const leftPx = clip.start * pxPerSec
  const isLinked = !!clip.linkId && linkedClips(doc, clip.id).length > 1

  // ————— gesture state —————
  const gesture = useRef<null | {
    mode: 'move' | 'trim-start' | 'trim-end'
    startX: number
    startY: number
    orig: Clip
    origTrackId: string
    lanes: { id: string; kind: string; top: number; bottom: number }[]
    /** Every OTHER selected clip: follows the move with the same time delta
     *  (and the same track-index offset when the dragged clip changes lane). */
    partners: { id: string; trackIndex: number; kind: string; origStart: number }[]
    moved: boolean
  }>(null)

  const thresholdSec = () => (snapEnabled ? SNAP_THRESHOLD_PX / pxPerSec : 0)

  const snapPoints = (excludeId: string) =>
    computeSnapPoints(doc, {
      excludeClipIds: [excludeId],
      includeTimelineEnd: false,
    })

  /** Razor tool: cut this clip (its link group) exactly at the pointer. */
  const razorCut = (e: React.PointerEvent) => {
    e.stopPropagation()
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const at = clip.start + (e.clientX - rect.left) / pxPerSec
    const store = useEditorStore.getState()
    try {
      const commands = commandsToSplitClipsAt(store.doc, [clip.id], at)
      if (!commands) {
        toast({ title: 'Too close to the clip edge to cut' })
        return
      }
      store.apply(commands)
    } catch (error) {
      toast({
        title: 'Cut failed',
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      })
    }
  }

  const beginGesture = (e: React.PointerEvent, mode: 'move' | 'trim-start' | 'trim-end') => {
    e.stopPropagation()
    // Premiere tools: with the razor active a pointer-down cuts instead of
    // moving (the selection stays untouched, exactly like the razor blade).
    if (activeTool === 'razor' && mode === 'move') {
      razorCut(e)
      return
    }
    if (e.button !== 0) {
      // Right-click: the context menu's open logic decides selection (it
      // selects only when the clip is NOT part of the current selection) —
      // collapsing here would destroy an existing multi-selection.
      return
    }
    const live = useEditorStore.getState()
    if (e.shiftKey) live.addSelection(clip.id)
    else if (e.ctrlKey || e.metaKey) live.toggleSelection(clip.id)
    else if (!clipIsSelected(live.doc, live.selections, clip)) live.select(clip.id)
    // Dragging an ALREADY-selected clip keeps the selection intact — that is
    // what makes a shift-selected multi-drag move every selected clip.

    const scrollEl = document.querySelector('[data-timeline-scroll]')
    const laneEls = scrollEl?.querySelectorAll<HTMLElement>('[data-lane-id]') ?? []
    const lanes = Array.from(laneEls).map((el) => {
      const r = el.getBoundingClientRect()
      return {
        id: el.dataset.laneId ?? '',
        kind: el.dataset.laneKind ?? '',
        top: r.top,
        bottom: r.bottom,
      }
    })
    // Capture EVERY other selected clip (whole link groups) so a MOVE drags
    // the full selection in sync — same time delta, each keeps its own lane
    // unless the whole selection shifts by the same track-index offset.
    const fresh = useEditorStore.getState()
    const tracks = fresh.doc.project.tracks
    const trackIndexOf = (clipId: string) =>
      tracks.findIndex((t) => t.clips.some((c) => c.id === clipId))
    const selIds = fresh.selections.length > 0 ? fresh.selections : [clip.id]
    const partners = resolveSelectionGroups(fresh.doc, selIds)
      .filter((c) => c.id !== clip.id)
      .map((c) => {
        const idx = trackIndexOf(c.id)
        return {
          id: c.id,
          trackIndex: idx,
          kind: tracks[idx]?.kind ?? '',
          origStart: c.start,
        }
      })
    gesture.current = {
      mode,
      startX: e.clientX,
      startY: e.clientY,
      orig: structuredClone(clip),
      origTrackId: track.id,
      lanes,
      partners,
      moved: false,
    }
    useEditorStore.getState().beginTransient()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const g = gesture.current
    if (!g) return
    const store = useEditorStore.getState()
    const dxSec = (e.clientX - g.startX) / pxPerSec
    if (!g.moved && Math.abs(e.clientX - g.startX) < 2 && Math.abs(e.clientY - g.startY) < 2) return
    g.moved = true

    const points = snapPoints(clip.id)
    const thr = thresholdSec()

    if (g.mode === 'move') {
      // Track change: find the lane under the pointer (compatible kinds only).
      let targetTrackId = g.origTrackId
      const lane = g.lanes.find((l) => e.clientY >= l.top && e.clientY <= l.bottom)
      if (lane && lane.id !== g.origTrackId) {
        const target = doc.project.tracks.find((t) => t.id === lane.id)
        const origTrack = doc.project.tracks.find((t) => t.id === g.origTrackId)
        if (target && origTrack) {
          const fits =
            (target.kind === 'video' && origTrack.kind === 'video') ||
            (target.kind === 'audio' && origTrack.kind === 'audio')
          if (fits) targetTrackId = target.id
        }
      }

      let start = Math.max(0, g.orig.start + dxSec)
      let snapped: number | null = null
      if (snapEnabled) {
        const head = applySnap(start, points, thr)
        const tail = applySnap(start + g.orig.duration, points, thr)
        if (
          head.snapped !== null &&
          (tail.snapped === null ||
            Math.abs(head.time - start) <= Math.abs(tail.time - (start + g.orig.duration)))
        ) {
          start = head.time
          snapped = head.snapped
        } else if (tail.snapped !== null) {
          start = Math.max(0, tail.time - g.orig.duration)
          snapped = tail.snapped
        }
      }
      store.applyTransient({
        type: 'moveClip',
        clipId: clip.id,
        trackId: targetTrackId,
        start,
      })
      // The whole selection follows: same time delta; when the dragged clip
      // changed lane, partners shift by the SAME track-index offset (skipped
      // when the destination lane is missing or a different kind).
      const delta = start - g.orig.start
      const tracks = doc.project.tracks
      const dIndex =
        tracks.findIndex((t) => t.id === targetTrackId) -
        tracks.findIndex((t) => t.id === g.origTrackId)
      for (const p of g.partners) {
        let partnerTrackId = tracks[p.trackIndex]?.id
        if (dIndex !== 0) {
          const candidate = tracks[p.trackIndex + dIndex]
          if (candidate && candidate.kind === p.kind) partnerTrackId = candidate.id
        }
        if (!partnerTrackId) continue
        store.applyTransient({
          type: 'moveClip',
          clipId: p.id,
          trackId: partnerTrackId,
          start: Math.max(0, p.origStart + delta),
        })
      }
      onSnapGuide(snapped)
      return
    }

    if (g.mode === 'trim-start') {
      let delta = dxSec
      const minDelta = -g.orig.inPoint // media cannot reveal source before 0
      const maxDelta = g.orig.duration - MIN_CLIP_DURATION
      // Images/text: inPoint stays 0 → cannot pull source, only shrink/grow via start
      const isUnbounded = !asset || asset.kind === 'image'
      delta = Math.min(
        Math.max(
          delta,
          isUnbounded ? -(g.orig.start + g.orig.duration - MIN_CLIP_DURATION) : minDelta,
        ),
        maxDelta,
      )
      let newStart = Math.max(0, g.orig.start + delta)
      let newIn = isUnbounded ? 0 : Math.max(0, g.orig.inPoint + (newStart - g.orig.start))
      let newDuration = g.orig.start + g.orig.duration - newStart
      if (snapEnabled) {
        const s = applySnap(newStart, points, thr)
        if (s.snapped !== null) {
          newStart = s.time
          newIn = isUnbounded ? 0 : Math.max(0, g.orig.inPoint + (newStart - g.orig.start))
          newDuration = Math.max(MIN_CLIP_DURATION, g.orig.start + g.orig.duration - newStart)
          onSnapGuide(s.snapped)
        } else onSnapGuide(null)
      }
      try {
        store.applyTransient({
          type: 'trimClip',
          clipId: clip.id,
          start: newStart,
          inPoint: newIn,
          duration: newDuration,
        })
      } catch {
        // transient clamp violation — ignore
      }
      return
    }

    // trim-end
    let newDuration = g.orig.duration + dxSec
    const maxDur = isMedia
      ? Math.max(MIN_CLIP_DURATION, (asset?.duration ?? 0) - clip.inPoint)
      : Infinity
    newDuration = Math.min(Math.max(newDuration, MIN_CLIP_DURATION), maxDur)
    if (snapEnabled) {
      const end = clip.start + newDuration
      const s = applySnap(end, points, thr)
      if (s.snapped !== null) {
        newDuration = Math.max(MIN_CLIP_DURATION, s.time - clip.start)
        onSnapGuide(s.snapped)
      } else onSnapGuide(null)
    }
    try {
      store.applyTransient({
        type: 'trimClip',
        clipId: clip.id,
        start: clip.start,
        inPoint: clip.inPoint,
        duration: newDuration,
      })
    } catch {
      // ignore
    }
  }

  const endGesture = () => {
    if (!gesture.current) return
    useEditorStore.getState().commitTransient()
    gesture.current = null
    onSnapGuide(null)
  }

  // ————— clip context menu (Premiere-style: cut/copy/paste/split/link/unlink/delete) —————
  const runMenuAction = (fn: () => void) => {
    try {
      fn()
    } catch (error) {
      toast({
        title: 'Action failed',
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      })
    }
  }

  /** The whole selection this menu acts on (falls back to THIS clip). */
  const menuSelectionIds = (): string[] => {
    const store = useEditorStore.getState()
    return store.selections.length > 0 ? store.selections : [clip.id]
  }

  const onMenuCut = () =>
    runMenuAction(() => {
      const store = useEditorStore.getState()
      const commands = commandsToCutClips(store.doc, menuSelectionIds())
      if (!commands) return
      store.apply(commands)
      store.deselectAll()
    })

  const onMenuCopy = () =>
    runMenuAction(() => {
      const store = useEditorStore.getState()
      const count = copyClips(store.doc, menuSelectionIds())
      if (count > 0) toast({ title: `Copied ${count} clip${count > 1 ? 's' : ''}` })
    })

  const onMenuPaste = () =>
    runMenuAction(() => {
      const store = useEditorStore.getState()
      const commands = commandsToPasteClips(store.doc, store.playhead)
      if (!commands) return
      store.apply(commands)
    })

  const onMenuSplit = () =>
    runMenuAction(() => {
      const store = useEditorStore.getState()
      const commands = commandsToSplitClipsAt(store.doc, menuSelectionIds(), store.playhead)
      if (!commands) {
        toast({ title: 'Playhead is not over the selection' })
        return
      }
      store.apply(commands)
    })

  const onMenuDuplicate = () =>
    runMenuAction(() => {
      const store = useEditorStore.getState()
      const commands = commandsToDuplicateClips(store.doc, menuSelectionIds())
      if (!commands) return
      store.apply(commands)
    })

  const onMenuLink = () =>
    runMenuAction(() => {
      const store = useEditorStore.getState()
      const commands = commandsToLinkClips(store.doc, menuSelectionIds())
      if (!commands) return
      store.apply(commands)
      toast({ title: 'Clips linked' })
    })

  const onMenuUnlink = () =>
    runMenuAction(() => {
      const store = useEditorStore.getState()
      const commands = commandsToUnlinkClips(store.doc, menuSelectionIds())
      if (!commands) return
      store.apply(commands)
      toast({ title: 'Audio and video unlinked' })
    })

  const onMenuRippleDelete = () =>
    runMenuAction(() => {
      const store = useEditorStore.getState()
      const commands = commandsToRippleDeleteClips(store.doc, menuSelectionIds())
      if (!commands) return
      store.apply(commands)
      store.deselectAll()
    })

  const onMenuDelete = () =>
    runMenuAction(() => {
      const store = useEditorStore.getState()
      store.apply(commandsToDeleteClips(store.doc, menuSelectionIds()))
      store.deselectAll()
    })

  // ————— visuals —————
  const palette = paletteFor(track.kind, asset, clip.text !== undefined, clip.audioOnly)
  const prevTransition = clip.transitionOut
  const clipboardHasContent = hasClipboardContent()
  const { playhead: menuPlayhead } = useEditorStore.getState()
  const selIds = selections.length > 0 ? selections : [clip.id]
  const canSplitHere = canSplitAnySelectedAt(doc, selIds, menuPlayhead)
  const canLink = canLinkClips(doc, selIds)
  const canUnlink = anySelectionLinked(doc, selIds)

  return (
    <ContextMenu
      onOpenChange={(open) => {
        if (open) {
          // Right-click selects the clip — but NEVER collapses an existing
          // multi-selection (Premiere acts on the whole selection).
          const live = useEditorStore.getState()
          if (!clipIsSelected(live.doc, live.selections, clip)) live.select(clip.id)
          setMenuTick((n) => n + 1)
        }
      }}
    >
      <ContextMenuTrigger asChild>
        <div
          data-testid={`clip-${clip.id}`}
          role="button"
          aria-label={`Clip ${clip.text ?? asset?.name ?? 'text'} from ${clip.start.toFixed(2)} to ${(clip.start + clip.duration).toFixed(2)} seconds`}
          tabIndex={0}
          className={cn(
            'absolute inset-y-1 select-none overflow-hidden rounded-md border text-[11px] shadow-sm transition-colors',
            palette.body,
            isSelected && 'z-10 ring-2 ring-rose-400 ring-offset-1 ring-offset-background',
            !asset && clip.mediaId && 'border-dashed border-red-500/60 bg-red-950/40',
            activeTool === 'razor' && 'cursor-crosshair',
          )}
          style={{ left: leftPx, width: widthPx, touchAction: 'none' }}
          onPointerDown={(e) => beginGesture(e, 'move')}
          onPointerMove={onPointerMove}
          onPointerUp={endGesture}
          onPointerCancel={endGesture}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') useEditorStore.getState().select(clip.id)
          }}
        >
          {/* fade-in overlay when the previous clip crossfades into this one */}
          {fadeIn > 0 ? (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 left-0 bg-gradient-to-r from-background/80 to-transparent"
              style={{ width: Math.min(widthPx, fadeIn * pxPerSec) }}
            />
          ) : null}
          {/* crossfade-out overlay on this clip's tail */}
          {prevTransition ? (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 right-0 bg-gradient-to-l from-background/80 to-transparent"
              style={{
                width: Math.min(widthPx, prevTransition.duration * pxPerSec),
              }}
            />
          ) : null}

          {/* waveform (audio-bearing clips) */}
          {asset?.waveformPeaks && asset.kind !== 'image' && (
            <Waveform
              peaks={asset.waveformPeaks}
              assetDuration={asset.duration || clip.duration}
              inPoint={clip.inPoint}
              duration={clip.duration}
              widthPx={widthPx}
              height={height}
              muted={!!clip.muted}
            />
          )}

          {/* label */}
          <div className="pointer-events-none absolute inset-x-1 top-0.5 flex items-center gap-1 truncate font-medium text-white/95 drop-shadow">
            {clip.text !== undefined ? (
              <span className="truncate">{clip.text || '(empty text)'}</span>
            ) : (
              <span className="truncate">{asset?.name ?? 'missing media'}</span>
            )}
            {/* A/V link marker: this clip moves/deletes/splits with its twin */}
            {isLinked && (
              <span
                aria-label="Linked with audio"
                title="Linked with the audio track — right-click to unlink"
                data-testid="clip-link-badge"
                className="shrink-0 rounded bg-black/40 p-0.5"
              >
                <Link2 className="size-3" />
              </span>
            )}
            {clip.muted && (
              <span className="shrink-0 rounded bg-black/40 px-1 text-[9px]">MUTED</span>
            )}
            {prevTransition && (
              <span className="shrink-0 rounded bg-black/40 px-1 text-[9px]">
                ⤬{prevTransition.duration.toFixed(1)}s
              </span>
            )}
          </div>

          {/* trim handles */}
          <div
            aria-label="Trim clip start"
            className="absolute inset-y-0 left-0 z-10 w-2 cursor-ew-resize opacity-0 transition-opacity hover:opacity-100 group-hover:opacity-100"
            style={{
              background: 'linear-gradient(90deg, rgba(255,255,255,.45), transparent)',
            }}
            onPointerDown={(e) => beginGesture(e, 'trim-start')}
            onPointerMove={onPointerMove}
            onPointerUp={endGesture}
            onPointerCancel={endGesture}
          />
          <div
            aria-label="Trim clip end"
            className="absolute inset-y-0 right-0 z-10 w-2 cursor-ew-resize opacity-0 transition-opacity hover:opacity-100 group-hover:opacity-100"
            style={{
              background: 'linear-gradient(270deg, rgba(255,255,255,.45), transparent)',
            }}
            onPointerDown={(e) => beginGesture(e, 'trim-end')}
            onPointerMove={onPointerMove}
            onPointerUp={endGesture}
            onPointerCancel={endGesture}
          />
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent data-testid="clip-context-menu">
        <ContextMenuItem data-testid="menu-cut" onSelect={onMenuCut}>
          <Scissors className="mr-2 size-4" /> Cut
          <ContextMenuShortcut>Ctrl+X</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem data-testid="menu-copy" onSelect={onMenuCopy}>
          <Copy className="mr-2 size-4" /> Copy
          <ContextMenuShortcut>Ctrl+C</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem
          data-testid="menu-paste"
          disabled={!clipboardHasContent}
          onSelect={onMenuPaste}
        >
          <ClipboardPaste className="mr-2 size-4" /> Paste
          <ContextMenuShortcut>Ctrl+V</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem data-testid="menu-split" disabled={!canSplitHere} onSelect={onMenuSplit}>
          <Split className="mr-2 size-4" /> Split at Playhead
          <ContextMenuShortcut>Ctrl+K</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem data-testid="menu-duplicate" onSelect={onMenuDuplicate}>
          <CopyPlus className="mr-2 size-4" /> Duplicate
          <ContextMenuShortcut>D</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem data-testid="menu-link" disabled={!canLink} onSelect={onMenuLink}>
          <Link2 className="mr-2 size-4" /> Link
          <ContextMenuShortcut>Ctrl+L</ContextMenuShortcut>
        </ContextMenuItem>
        {canUnlink && (
          <ContextMenuItem data-testid="menu-unlink" onSelect={onMenuUnlink}>
            <Unlink className="mr-2 size-4" /> Unlink Audio/Video
            <ContextMenuShortcut>Ctrl+L</ContextMenuShortcut>
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem data-testid="menu-delete" variant="destructive" onSelect={onMenuDelete}>
          <Trash2 className="mr-2 size-4" /> Delete
          <ContextMenuShortcut>Del</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem
          data-testid="menu-ripple-delete"
          variant="destructive"
          onSelect={onMenuRippleDelete}
        >
          <Trash2 className="mr-2 size-4" /> Ripple Delete
          <ContextMenuShortcut>Shift+Del</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

/**
 * Clip body palette. `audioOnly` occurrences (the A/V pair's audio part)
 * render with the audio palette even though they reference a video asset —
 * the lane they live on is amber, and the clip should match.
 */
export function paletteFor(
  kind: string,
  asset: MediaAsset | undefined,
  isText: boolean,
  audioOnly = false,
) {
  if (isText) return { body: 'border-violet-400/40 bg-violet-800/70' }
  if (!asset) return { body: 'border-red-500/50 bg-red-950/50' }
  if (audioOnly) return { body: 'border-amber-400/40 bg-amber-900/70' }
  if (asset.kind === 'video') return { body: 'border-emerald-400/40 bg-emerald-900/70' }
  if (asset.kind === 'image') return { body: 'border-teal-400/40 bg-teal-900/70' }
  return { body: 'border-amber-400/40 bg-amber-900/70' }
}

/** Computes the effective fade-in duration for a clip (previous clip's crossfade overlap). */
export function computeFadeIn(clips: Clip[], index: number): number {
  if (index === 0) return 0
  const prev = clips[index - 1]
  if (!prev?.transitionOut) return 0
  const overlap = prev.start + prev.duration - clips[index].start
  return Math.max(0, Math.min(prev.transitionOut.duration, overlap))
}
