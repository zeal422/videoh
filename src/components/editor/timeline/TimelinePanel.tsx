'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Volume2, VolumeX, Video, AudioLines, Plus, Type as TypeIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { Input } from '@/components/ui/input'
import { toast } from '@/hooks/use-toast'

import { Ruler } from './Ruler'
import { ClipView, computeFadeIn } from './ClipView'
import { SequenceMarkers } from './SequenceMarkers'
import {
  commandsToAddMedia,
  commandsToAddMediaInNewTrack,
  trackKindForMedia,
} from '@/lib/editor/actions'
import { previewTrackName } from '@/lib/editor/commands'
import { computeTrackDropTarget, mediaKindFromDragEvent } from '@/lib/editor/timeline-drop'
import {
  marqueeHitClipIds,
  normalizeMarquee,
  resolveMarqueeSelection,
  type MarqueeMode,
  type MarqueeRect,
} from '@/lib/editor/marquee'
import { autoScrollStep, autoScrollStepX } from '@/lib/editor/timeline-scroll'
import { docDuration, uid } from '@/lib/editor/factories'
import { markersEnd } from '@/lib/editor/markers'
import { applySnap, computeSnapPoints } from '@/lib/editor/snap'
import { playbackRef } from '@/lib/editor/playback/engine-ref'
import { useEditorStore } from '@/lib/editor/store'
import { SNAP_THRESHOLD_PX, TRACK_HEADER_WIDTH } from '@/lib/editor/constants'
import type { Track, TrackKind } from '@/lib/editor/types'
import { cn } from '@/lib/utils'

/** Sticky header column width (moved to constants for cross-module reuse). */
export { TRACK_HEADER_WIDTH }

const TRACK_HEIGHT: Record<TrackKind, number> = {
  video: 64,
  audio: 56,
  text: 44,
}
const RULER_HEIGHT = 28
const TAIL_PADDING_SEC = 20

/** Lane highlight while dragged media hovers over the row itself (drop ONTO the track). */
const LANE_DROP_HIGHLIGHT: Record<TrackKind, string> = {
  video: 'bg-emerald-400/10 ring-1 ring-inset ring-emerald-400/50',
  audio: 'bg-amber-400/10 ring-1 ring-inset ring-amber-400/50',
  text: 'bg-violet-400/10 ring-1 ring-inset ring-violet-400/50',
}

/**
 * Transient drop feedback while media drags over the timeline (component
 * state — it never outlives the gesture, so it stays out of the store).
 * `insert` carries the boundary offset (px within the rows region), the kind
 * of track that would be created and its preview name ("+ V2").
 */
type DropIndicator =
  | { mode: 'lane'; index: number }
  | { mode: 'insert'; index: number; top: number; kind: 'video' | 'audio'; name: string }

/**
 * Multi-track timeline: sticky track headers, canvas ruler with scrubbing,
 * draggable/trimmable clips, playhead, snap guide and media-bin drop target.
 *
 * Stacking scale (all in the content div's stacking context) — the playhead
 * lives in CONTENT coordinates, so when the user scrolls it slides beneath
 * the sticky header column and must be PAINTED under it, never over:
 *   clips (auto, selected z-10) < marquee z-[12] < snap guide z-15
 *   < playhead line z-20 < track headers z-30 < ruler row z-40 (corner cell
 *   z-50 inside it).
 * The diamond and the sequence marker tabs live INSIDE the ruler row (z-30
 * and z-20, both under the corner z-50) so the sticky corner cell covers them
 * exactly like it covers the line.
 *
 * Two more artifact rules learned the hard way (user screenshots):
 * - The line/guide are confined to the track rows (top: RULER_HEIGHT,
 *   height: tracksHeight) — running to the content bottom painted a stray
 *   dot in the empty strip below the last row where no header can cover it.
 * - Row separators live on the lane + header cells, NOT on the row div:
 *   a row-level border-b is painted below the header's box, and the line
 *   (z-20) showed through it as one magenta dot per row boundary.
 *
 * Media drop zones (HTML5 DnD from the media bin): handlers live on the
 * CONTENT div and are guarded by the `application/x-media-id` payload type,
 * so pointer-driven clip gestures and OS file drags are untouched. The middle
 * of a row drops ONTO that track; a thin edge strip at each row boundary (and
 * the empty strip below the last row) INSERTS a new track at exactly that
 * z-position — geometry in lib/editor/timeline-drop.ts. The insertion line
 * renders at z-[25]: above clips/playhead, below the sticky headers (z-30).
 */
export function TimelinePanel() {
  const doc = useEditorStore((s) => s.doc)
  const pxPerSec = useEditorStore((s) => s.pxPerSec)
  const playhead = useEditorStore((s) => s.playhead)
  const playing = useEditorStore((s) => s.playing)
  const snapLine = useEditorStore((s) => s.snapLine)
  const activeTool = useEditorStore((s) => s.activeTool)

  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const scrubbingRef = useRef(false)
  const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(null)

  // Marquee (box) selection: the live rect while dragging, null when idle.
  // Deliberately component state, not store state: a drag in flight is not
  // undoable and must not outlive the gesture.
  const [marquee, setMarquee] = useState<MarqueeRect | null>(null)

  /** Active marquee drag (null when idle). Listeners live on `window`, like
   *  ClipView's, because the lanes re-render under the drag and element-bound
   *  handlers (or pointer capture) would die with the element they started on. */
  const marqueeRef = useRef<null | {
    mode: MarqueeMode
    /** Gesture anchor in lane coordinates: x after the header column, y after the ruler. */
    anchorX: number
    anchorY: number
    lastX: number
    lastY: number
    startX: number
    startY: number
    moved: boolean
    rect: MarqueeRect
    raf: number | null
    /** Initiating pointer; other pointers' events are ignored (multi-touch),
     *  because their move would steer the box and their release would commit a
     *  partial selection. */
    pointerId: number
    onMove: (ev: PointerEvent) => void
    onUp: (ev: PointerEvent) => void
    onCancel: (ev: PointerEvent) => void
  }>(null)

  const duration = docDuration(doc)
  // Sequence markers can sit past the last clip; the scrollable width must
  // reach them or a marker would be parked off-screen with no way to scroll
  // to it.
  const markerEnd = useMemo(() => markersEnd(doc.project), [doc.project])
  const contentWidth = Math.max(600, (Math.max(duration, markerEnd) + TAIL_PADDING_SEC) * pxPerSec)
  // Total pixel height of the track rows — bounds the playhead line and snap
  // guide so they never render in the empty strip below the last row.
  const tracksHeight = useMemo(
    () => doc.project.tracks.reduce((h, t) => h + TRACK_HEIGHT[t.kind], 0),
    [doc.project.tracks],
  )

  // ————— seeking —————
  const seekToClientX = useCallback(
    (clientX: number) => {
      const rulerEl = contentRef.current?.querySelector('[data-ruler]')
      if (!rulerEl) return
      const rect = rulerEl.getBoundingClientRect()
      const t = Math.max(0, (clientX - rect.left) / pxPerSec)
      playbackRef.current?.seek(t)
    },
    [pxPerSec],
  )

  // ————— playhead follow during playback —————
  useEffect(() => {
    if (!playing) return
    const el = scrollRef.current
    if (!el) return
    const x = playhead * pxPerSec
    const viewStart = el.scrollLeft
    const viewEnd = viewStart + el.clientWidth - TRACK_HEADER_WIDTH
    if (x > viewEnd - 60 || x < viewStart) {
      el.scrollLeft = Math.max(0, x - 120)
    }
  }, [playhead, playing, pxPerSec])

  // ————— ctrl+wheel zoom around the cursor (non-passive) —————
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const store = useEditorStore.getState()
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
      const next = Math.min(400, Math.max(10, Math.round(store.pxPerSec * factor)))
      if (next === store.pxPerSec) return
      // keep the time under the cursor stationary
      const rect = el.getBoundingClientRect()
      const cursorX = e.clientX - rect.left - TRACK_HEADER_WIDTH
      const cursorTime = (el.scrollLeft + cursorX) / store.pxPerSec
      store.setPxPerSec(next)
      requestAnimationFrame(() => {
        el.scrollLeft = Math.max(0, cursorTime * next - cursorX)
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // ----- marquee (box) selection -----

  /**
   * Pointer position in lane coordinates: x from the lanes' origin (after the
   * sticky header column), y from the top of the first row (after the ruler).
   * The content box is re-read on every call, so the mapping stays correct
   * while the view auto-scrolls under a stationary pointer.
   */
  const lanePointFromClient = useCallback((clientX: number, clientY: number) => {
    const contentEl = contentRef.current
    if (!contentEl) return null
    const rect = contentEl.getBoundingClientRect()
    return {
      x: clientX - rect.left - TRACK_HEADER_WIDTH,
      y: clientY - rect.top - RULER_HEIGHT,
    }
  }, [])

  /** Vertical span of every lane in lane coordinates, from the same row-height
   *  constants the lanes render with. */
  const laneBoxes = useCallback((tracks: Track[]) => {
    let top = 0
    return tracks.map((track) => {
      const box = { trackId: track.id, top, height: TRACK_HEIGHT[track.kind] }
      top += TRACK_HEIGHT[track.kind]
      return box
    })
  }, [])

  const updateMarqueeRect = (g: NonNullable<typeof marqueeRef.current>) => {
    const point = lanePointFromClient(g.lastX, g.lastY)
    if (!point) return
    g.rect = normalizeMarquee(g.anchorX, g.anchorY, point.x, point.y)
    setMarquee(g.rect)
  }

  /** The lane region's right edge: the scroll container's border box minus the
   *  vertical scrollbar gutter, which `getBoundingClientRect` includes. */
  const laneRightEdge = (el: HTMLDivElement, scrollRect: DOMRect) =>
    scrollRect.right - (el.offsetWidth - el.clientWidth)

  /**
   * One frame of edge auto-scroll: move the view, then re-derive the rect,
   * because the content slid under a stationary pointer and a scroll fires no
   * pointermove.
   */
  const marqueeTick = () => {
    const g = marqueeRef.current
    const el = scrollRef.current
    if (!g || !el) return
    g.raf = null
    const scrollRect = el.getBoundingClientRect()
    const dy = autoScrollStep(g.lastY, scrollRect)
    const dx = autoScrollStepX(g.lastX, {
      left: scrollRect.left + TRACK_HEADER_WIDTH,
      right: laneRightEdge(el, scrollRect),
    })
    if (dy === 0 && dx === 0) return
    const beforeTop = el.scrollTop
    const beforeLeft = el.scrollLeft
    el.scrollTop += dy
    el.scrollLeft += dx
    if (el.scrollTop === beforeTop && el.scrollLeft === beforeLeft) return
    // Queue the next frame before touching the overlay, so a re-entrant call
    // cannot stack a second loop on top of this one.
    g.raf = requestAnimationFrame(marqueeTick)
    updateMarqueeRect(g)
  }

  /** Run the auto-scroll loop only while the pointer holds an edge band. */
  const syncMarqueeAutoScroll = (g: NonNullable<typeof marqueeRef.current>) => {
    const el = scrollRef.current
    if (!el) return
    const scrollRect = el.getBoundingClientRect()
    const dy = autoScrollStep(g.lastY, scrollRect)
    const dx = autoScrollStepX(g.lastX, {
      left: scrollRect.left + TRACK_HEADER_WIDTH,
      right: laneRightEdge(el, scrollRect),
    })
    if (dy === 0 && dx === 0) {
      if (g.raf !== null) {
        cancelAnimationFrame(g.raf)
        g.raf = null
      }
      return
    }
    if (g.raf === null) g.raf = requestAnimationFrame(marqueeTick)
  }

  const moveMarquee = (clientX: number, clientY: number) => {
    const g = marqueeRef.current
    if (!g) return
    g.lastX = clientX
    g.lastY = clientY
    // A tiny wobble stays a click, so deselecting on empty space remains easy.
    if (!g.moved && Math.abs(clientX - g.startX) < 3 && Math.abs(clientY - g.startY) < 3) return
    g.moved = true
    updateMarqueeRect(g)
    syncMarqueeAutoScroll(g)
  }

  /**
   * A browser-cancelled gesture (touch pan, native drag) never completed as
   * intended, so it must not rewrite the selection: tear the gesture down
   * without committing. `pointerup` still commits via endMarquee.
   */
  const cancelMarquee = () => {
    const g = marqueeRef.current
    if (!g) return
    window.removeEventListener('pointermove', g.onMove)
    window.removeEventListener('pointerup', g.onUp, true)
    window.removeEventListener('pointercancel', g.onCancel, true)
    if (g.raf !== null) cancelAnimationFrame(g.raf)
    marqueeRef.current = null
    setMarquee(null)
  }

  const endMarquee = () => {
    const g = marqueeRef.current
    if (!g) return
    window.removeEventListener('pointermove', g.onMove)
    window.removeEventListener('pointerup', g.onUp, true)
    window.removeEventListener('pointercancel', g.onCancel, true)
    if (g.raf !== null) cancelAnimationFrame(g.raf)
    marqueeRef.current = null
    setMarquee(null)
    const store = useEditorStore.getState()
    if (!g.moved) {
      // A click on empty space clears the selection (the pre-marquee
      // behavior); a modifier click leaves it alone, since the user was
      // aiming at a selection edit they never completed.
      if (g.mode === 'replace') store.select(null)
      return
    }
    const hits = marqueeHitClipIds(
      store.doc,
      laneBoxes(store.doc.project.tracks),
      g.rect,
      store.pxPerSec,
    )
    store.setSelections(resolveMarqueeSelection(store.doc, hits, store.selections, g.mode))
  }

  /**
   * Pointer-down on empty lane space starts a box selection. Clips (their own
   * gesture), the ruler (scrubbing) and the track headers are excluded. With
   * the razor tool active a click on empty space keeps its old deselect
   * behavior instead of arming a marquee.
   */
  const beginMarquee = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const target = e.target as HTMLElement
    if (target.closest('[data-testid^="clip-"]')) return
    if (target.closest('[data-ruler]')) return
    if (target.closest('[data-testid^="track-header-"]')) return
    if (target !== e.currentTarget && !target.dataset.laneId) return
    const store = useEditorStore.getState()
    if (store.activeTool !== 'select') {
      if (!e.shiftKey && !e.ctrlKey && !e.metaKey) store.select(null)
      return
    }
    // One gesture at a time, like ClipView: a marquee whose pointerup was lost
    // (released outside the window) must not swallow the next drag. Close it
    // first, then start this one.
    if (marqueeRef.current) endMarquee()
    const anchor = lanePointFromClient(e.clientX, e.clientY)
    if (!anchor) return
    const mode: MarqueeMode = e.shiftKey ? 'add' : e.ctrlKey || e.metaKey ? 'toggle' : 'replace'
    const g = {
      mode,
      anchorX: anchor.x,
      anchorY: anchor.y,
      lastX: e.clientX,
      lastY: e.clientY,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      rect: normalizeMarquee(anchor.x, anchor.y, anchor.x, anchor.y),
      raf: null as number | null,
      pointerId: e.pointerId,
      onMove: (ev: PointerEvent) => {
        if (ev.pointerId !== marqueeRef.current?.pointerId) return
        moveMarquee(ev.clientX, ev.clientY)
      },
      onUp: (ev: PointerEvent) => {
        if (ev.pointerId !== marqueeRef.current?.pointerId) return
        endMarquee()
      },
      onCancel: (ev: PointerEvent) => {
        if (ev.pointerId !== marqueeRef.current?.pointerId) return
        cancelMarquee()
      },
    }
    marqueeRef.current = g
    // No overlay yet: a pointerdown that never travels must stay an invisible
    // click, not a zero-size flash of the rect.
    window.addEventListener('pointermove', g.onMove)
    // Capture phase, like ClipView's drags: EditorShell's dangling-gesture net
    // listens on bubble and must never pre-empt the owner's pointerup.
    window.addEventListener('pointerup', g.onUp, true)
    window.addEventListener('pointercancel', g.onCancel, true)
  }

  // Unmount safety net: never leave window listeners or a rAF loop behind.
  useEffect(
    () => () => {
      const g = marqueeRef.current
      if (!g) return
      window.removeEventListener('pointermove', g.onMove)
      window.removeEventListener('pointerup', g.onUp, true)
      window.removeEventListener('pointercancel', g.onCancel, true)
      if (g.raf !== null) cancelAnimationFrame(g.raf)
      marqueeRef.current = null
    },
    [],
  )

  // ————— media drop zones (onto a lane, or BETWEEN tracks) —————

  /** Resolves a drag position to the drop feedback to show (null = not a target). */
  const computeIndicator = useCallback(
    (e: React.DragEvent): DropIndicator | null => {
      const scrollEl = scrollRef.current
      const contentEl = contentRef.current
      if (!scrollEl || !contentEl) return null
      const scrollRect = scrollEl.getBoundingClientRect()
      const contentRect = contentEl.getBoundingClientRect()
      // The sticky ruler zone and the sticky header column are not drop
      // targets — this also rejects the ruler's home position when unscrolled.
      if (e.clientY < scrollRect.top + RULER_HEIGHT) return null
      if (e.clientX < scrollRect.left + TRACK_HEADER_WIDTH) return null
      const heights = doc.project.tracks.map((t) => TRACK_HEIGHT[t.kind])
      const target = computeTrackDropTarget(e.clientY - contentRect.top - RULER_HEIGHT, heights)
      if (!target) return null
      if (target.mode === 'lane') return { mode: 'lane', index: target.index }
      const dragKind = mediaKindFromDragEvent(e)
      const kind = dragKind ? trackKindForMedia(dragKind) : 'video'
      return {
        mode: 'insert',
        index: target.index,
        top: target.y,
        kind,
        name: previewTrackName(doc, kind),
      }
    },
    [doc],
  )

  const handleDragOver = (e: React.DragEvent) => {
    // React only to media-bin drags: clip move/trim gestures use pointer
    // events (no dataTransfer payload) and OS file drags keep their native
    // behavior (import happens via the media bin).
    if (!e.dataTransfer.types.includes('application/x-media-id')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDropIndicator(computeIndicator(e))
  }

  const handleDragLeave = (e: React.DragEvent) => {
    // Fires when moving BETWEEN children too — only clear when genuinely
    // leaving the timeline content (or the window).
    const next = e.relatedTarget as Node | null
    if (next && contentRef.current?.contains(next)) return
    setDropIndicator(null)
  }

  const handleDrop = (e: React.DragEvent) => {
    setDropIndicator(null)
    if (!e.dataTransfer.types.includes('application/x-media-id')) return
    e.preventDefault()
    const target = computeIndicator(e)
    const contentEl = contentRef.current
    if (!target || !contentEl) return
    const store = useEditorStore.getState()
    const mediaId = e.dataTransfer.getData('application/x-media-id')
    const asset = store.doc.media.find((m) => m.id === mediaId)
    if (!asset) return

    // Drop time from the content-frame x (lanes start after the header column).
    let t = Math.max(
      0,
      (e.clientX - contentEl.getBoundingClientRect().left - TRACK_HEADER_WIDTH) / store.pxPerSec,
    )
    if (store.snapEnabled) {
      const points = computeSnapPoints(store.doc, { includeTimelineEnd: false })
      t = applySnap(t, points, SNAP_THRESHOLD_PX / store.pxPerSec).time
    }

    if (target.mode === 'lane') {
      const track = doc.project.tracks[target.index]
      const commands = commandsToAddMedia(store.doc, asset, t, track.id)
      if (!commands) {
        toast({
          title: 'Incompatible track',
          description: `${asset.kind} material cannot go on a ${track.kind} track`,
          variant: 'destructive',
        })
        return
      }
      store.apply(commands)
      return
    }
    // Edge strip / empty area below the rows: create a layer at the exact
    // boundary the user pointed at (Premiere-style drop-between-tracks).
    store.apply(commandsToAddMediaInNewTrack(store.doc, asset, t, target.index))
  }

  // Safety net: drags that end outside the timeline (dropped back on the bin,
  // cancelled, Escape) never hit our drop/dragleave handlers — `dragend`
  // always fires on the drag source, so a window-level listener clears the
  // indicator no matter where the gesture ends.
  useEffect(() => {
    if (!dropIndicator) return
    const clear = () => setDropIndicator(null)
    window.addEventListener('dragend', clear)
    window.addEventListener('drop', clear)
    return () => {
      window.removeEventListener('dragend', clear)
      window.removeEventListener('drop', clear)
    }
  }, [dropIndicator])

  const addTrack = useCallback((kind: TrackKind) => {
    useEditorStore.getState().apply({ type: 'addTrack', kind, trackId: uid('track') })
  }, [])

  // ————— keep the view on the lanes you were looking at when a track is added —————
  // Only ~two rows fit in the track area, so a new lane takes its slot out of
  // the lanes below it — which is how "add an audio track" used to hide the very
  // clip you meant to drag onto it. Adding a lane shifts every lane below the
  // insertion down by exactly one row, so scrolling by that row cancels the
  // shift and leaves them where they were. The browser clamps, so when every lane
  // still fits nothing moves at all. The new lane is not force-scrolled into view
  // on purpose: the lanes you were working on win, and drag auto-scroll is what
  // reaches a lane that is off-screen.
  const trackIdsRef = useRef<string[]>([])
  useEffect(() => {
    const ids = doc.project.tracks.map((t) => t.id)
    const prev = trackIdsRef.current
    trackIdsRef.current = ids
    // Only a genuine ADD scrolls — project load, undo/redo and deletes must not
    // move the viewport under the user.
    if (prev.length === 0 || ids.length <= prev.length) return
    const added = ids.find((id) => !prev.includes(id))
    const scrollEl = scrollRef.current
    // Match on the dataset rather than interpolating the id into a selector:
    // a track id can arrive from a loaded project file and may contain quotes.
    const rowEl = added
      ? Array.from(scrollEl?.querySelectorAll<HTMLElement>('[data-track-row]') ?? []).find(
          (el) => el.dataset.trackRow === added,
        )
      : null
    if (!scrollEl || !rowEl) return
    scrollEl.scrollTop += rowEl.getBoundingClientRect().height
  }, [doc.project.tracks])

  return (
    <section aria-label="Timeline" className="flex min-h-0 flex-1 flex-col bg-background">
      <div
        ref={scrollRef}
        data-timeline-scroll
        className="editor-scroll relative min-h-0 flex-1 overflow-auto"
        onPointerDown={(e) => {
          // A click on the bare scroll surface (outside the content box, e.g.
          // right of a short timeline) deselects; lane clicks are owned by
          // beginMarquee on the content div.
          if (e.target === e.currentTarget) useEditorStore.getState().select(null)
        }}
      >
        <div
          ref={contentRef}
          className="relative"
          style={{
            width: TRACK_HEADER_WIDTH + contentWidth,
            minHeight: '100%',
          }}
          onPointerDown={beginMarquee}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {/* ruler row — z-40: covers clips, playhead line and track headers
              when they scroll beneath it vertically */}
          <div className="sticky top-0 z-40 flex bg-card" style={{ height: RULER_HEIGHT }}>
            <div
              className="sticky left-0 z-50 flex shrink-0 items-center justify-between border-b border-r bg-card py-1 pl-2 pr-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
              style={{ width: TRACK_HEADER_WIDTH }}
            >
              <span>Timeline</span>
              {/* Always-visible add-track affordance right where the tracks
                  live (the toolbar "+" dropdown alone was not discoverable —
                  user feedback: "I don't see a way to add another video"). */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6"
                    aria-label="Add track"
                    title="Add track (video / audio / text)"
                  >
                    <Plus className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => addTrack('video')}>
                    <Video className="mr-2 size-4 text-emerald-400" /> Video track
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => addTrack('audio')}>
                    <AudioLines className="mr-2 size-4 text-amber-400" /> Audio track
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => addTrack('text')}>
                    <TypeIcon className="mr-2 size-4 text-violet-400" /> Text track
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <div data-ruler className="relative border-b">
              <Ruler
                width={contentWidth}
                pxPerSec={pxPerSec}
                onScrubStart={(t) => {
                  scrubbingRef.current = true
                  // Scrubbing pauses playback, as in Premiere: dragging the
                  // playhead through a seek-latency storm (one force-seek per
                  // move with the clock running) is the one path that can
                  // starve every element of a decode and black out the preview.
                  playbackRef.current?.pause()
                  playbackRef.current?.seek(t)
                }}
                onScrub={(t) => playbackRef.current?.seek(t)}
                onScrubEnd={() => {
                  scrubbingRef.current = false
                }}
              />
              {/* Sequence markers: DOM overlay above the ruler canvas */}
              <SequenceMarkers pxPerSec={pxPerSec} />
            </div>
            {/* playhead diamond — inside the ruler row so the sticky corner
                cell paints over it when the playhead scrolls under the header
                column (it used to be a z-40 full-height element that sliced
                through the V1/A1 headers — user-reported visual bug) */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute top-0 z-30"
              style={{ left: TRACK_HEADER_WIDTH + playhead * pxPerSec }}
            >
              <div className="absolute -left-[5px] top-0 size-[11px] rotate-45 bg-rose-500" />
            </div>
          </div>

          {/* track rows — the row INDEX doubles as the z-position: index 0 is
              the topmost compositing layer (compositor draws last→first), so
              a drop between rows maps 1:1 to an addTrack atIndex insertion */}
          {doc.project.tracks.map((track, rowIndex) => (
            <div
              key={track.id}
              data-track-row={track.id}
              className="flex"
              style={{ height: TRACK_HEIGHT[track.kind] }}
            >
              <TrackHeader track={track} canDelete={doc.project.tracks.length > 1} />
              <div
                data-lane-id={track.id}
                data-lane-kind={track.kind}
                className={cn(
                  'relative flex-1 border-b border-border/60',
                  track.kind === 'video' && 'bg-emerald-950/20',
                  track.kind === 'audio' && 'bg-amber-950/20',
                  track.kind === 'text' && 'bg-violet-950/20',
                  dropIndicator?.mode === 'lane' &&
                    dropIndicator.index === rowIndex &&
                    LANE_DROP_HIGHLIGHT[track.kind],
                  // Razor tool (Premiere C): the blade cursor everywhere on
                  // the lanes — pointer-down on a clip now cuts it.
                  activeTool === 'razor' && 'cursor-crosshair',
                )}
                style={{ width: contentWidth }}
              >
                {track.clips.map((clip, i) => (
                  <ClipView
                    key={clip.id}
                    doc={doc}
                    clip={clip}
                    track={track}
                    pxPerSec={pxPerSec}
                    height={TRACK_HEIGHT[track.kind]}
                    fadeIn={computeFadeIn(track.clips, i)}
                    onSnapGuide={(t) => useEditorStore.getState().setSnapLine(t)}
                  />
                ))}
              </div>
            </div>
          ))}

          {/* playhead line — starts BELOW the ruler (the diamond lives in the
              ruler row above), spans exactly the track rows, and paints UNDER
              the sticky headers (z-30) so scrolling it beneath the header
              column hides it instead of slicing through the V1/A1 labels */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute z-20 w-px bg-rose-500/90"
            style={{
              left: TRACK_HEADER_WIDTH + playhead * pxPerSec,
              top: RULER_HEIGHT,
              height: tracksHeight,
            }}
          />

          {/* snap guide — above clips, below playhead/headers/ruler, and
              confined to the track rows like the playhead line */}
          {snapLine !== null && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute z-[15] w-px bg-amber-300"
              style={{
                left: TRACK_HEADER_WIDTH + snapLine * pxPerSec,
                top: RULER_HEIGHT,
                height: tracksHeight,
              }}
            />
          )}

          {/* marquee (box) selection: rose like the selection ring, above the
              clips (z-10) and under the snap guide (z-15). Pointer-events-none
              so the drag that draws it stays on the background. */}
          {marquee && (
            <div
              aria-hidden="true"
              data-testid="marquee-rect"
              className="pointer-events-none absolute z-[12] rounded-sm border border-rose-400/80 bg-rose-500/10"
              style={{
                left: TRACK_HEADER_WIDTH + marquee.left,
                top: RULER_HEIGHT + marquee.top,
                width: Math.max(0, marquee.right - marquee.left),
                height: Math.max(0, marquee.bottom - marquee.top),
              }}
            />
          )}

          {/* drop-between-tracks indicator: a kind-colored line at the exact
              boundary where a new track will be created, with a "+ V2" preview
              pill. Content-frame coordinates (scrolls with the rows); painted
              above clips and the playhead (z-[25]) but under the sticky
              headers (z-30) and ruler (z-40). */}
          {dropIndicator?.mode === 'insert' && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute z-[25]"
              style={{
                left: TRACK_HEADER_WIDTH,
                width: contentWidth,
                // Keep the 2px line fully inside the rows region — at the top
                // boundary it would otherwise hide under the sticky ruler.
                top: RULER_HEIGHT + Math.max(0, dropIndicator.top - 1),
              }}
            >
              <div
                data-testid="track-insert-line"
                className={cn(
                  'h-0.5 rounded-full',
                  dropIndicator.kind === 'video' ? 'bg-emerald-400' : 'bg-amber-400',
                )}
              />
              <div
                data-testid="track-insert-label"
                className={cn(
                  'absolute left-2 flex items-center gap-0.5 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-semibold shadow-md',
                  // Above the topmost boundary the pill would slide under the
                  // sticky ruler — flip it below the line instead.
                  dropIndicator.top === 0 ? 'top-1' : '-top-5',
                  dropIndicator.kind === 'video'
                    ? 'bg-emerald-500 text-emerald-50'
                    : 'bg-amber-500 text-amber-50',
                )}
              >
                <Plus className="size-3" />
                {dropIndicator.name}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

/**
 * A timeline lane's header: kind icon, name (double-click or the menu to
 * rename), clip count, track mute, and the track menu.
 *
 * The menu is where the track-level commands live — `renameTrack` and
 * `removeTrack` had no UI reachable from anywhere, so neither was usable.
 */
function TrackHeader({ track, canDelete }: { track: Track; canDelete: boolean }) {
  const KindIcon = track.kind === 'video' ? Video : track.kind === 'audio' ? AudioLines : TypeIcon
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(track.name)
  const renameInputRef = useRef<HTMLInputElement>(null)
  // Choosing “Rename Track…” has to out-race Radix's focus return: the field
  // mounts only once the menu unmounts, and the menu then hands focus back to
  // the header — which silently swallowed every keystroke. The flag lets us
  // suppress that one focus restore; the effect below focuses the field.
  const renameFromMenuRef = useRef(false)
  const toggleMute = () =>
    useEditorStore.getState().apply({ type: 'toggleTrackMute', trackId: track.id })
  const deleteTrack = () =>
    useEditorStore.getState().apply({ type: 'removeTrack', trackId: track.id })
  const startRename = () => {
    setDraft(track.name)
    setRenaming(true)
  }
  const commitRename = () => {
    const name = draft.trim()
    if (name && name !== track.name) {
      useEditorStore.getState().apply({ type: 'renameTrack', trackId: track.id, name })
    }
    setRenaming(false)
  }

  useEffect(() => {
    if (!renaming) return
    // A frame later, so this lands after Radix has finished closing the menu
    // and any of its focus juggling has settled.
    const id = requestAnimationFrame(() => renameInputRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [renaming])

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          data-testid={`track-header-${track.id}`}
          className="sticky left-0 z-30 flex shrink-0 items-center gap-2 border-b border-r border-b-border/60 bg-card px-2"
          style={{ width: TRACK_HEADER_WIDTH }}
        >
          <KindIcon
            className={cn(
              'size-3.5 shrink-0',
              track.kind === 'video' && 'text-emerald-400',
              track.kind === 'audio' && 'text-amber-400',
              track.kind === 'text' && 'text-violet-400',
            )}
          />
          {renaming ? (
            <Input
              ref={renameInputRef}
              aria-label={`Rename ${track.name}`}
              className="h-6 min-w-0 flex-1 px-1 text-xs"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  commitRename()
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  setRenaming(false)
                }
              }}
            />
          ) : (
            <span
              className="min-w-0 flex-1 truncate text-xs font-medium"
              title={track.name}
              onDoubleClick={startRename}
            >
              {track.name}
            </span>
          )}
          <span className="text-[10px] text-muted-foreground">{track.clips.length}</span>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label={track.muted ? `Unmute ${track.name}` : `Mute ${track.name}`}
            onClick={toggleMute}
          >
            {track.muted ? (
              <VolumeX className="size-3.5 text-rose-400" />
            ) : (
              <Volume2 className="size-3.5" />
            )}
          </Button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent
        data-testid="track-context-menu"
        onCloseAutoFocus={(event) => {
          if (!renameFromMenuRef.current) return
          renameFromMenuRef.current = false
          event.preventDefault()
        }}
      >
        <ContextMenuItem
          data-testid="track-menu-rename"
          onSelect={() => {
            renameFromMenuRef.current = true
            startRename()
          }}
        >
          Rename Track…
        </ContextMenuItem>
        <ContextMenuItem data-testid="track-menu-mute" onSelect={toggleMute}>
          {track.muted ? 'Unmute Track' : 'Mute Track'}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          data-testid="track-menu-delete"
          disabled={!canDelete}
          onSelect={deleteTrack}
        >
          Delete Track
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
