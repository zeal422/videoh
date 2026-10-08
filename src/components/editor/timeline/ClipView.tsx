'use client'

import { useEffect, useRef, useState } from 'react'
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
import { applyCommands } from '@/lib/editor/commands'
import { MIN_CLIP_DURATION } from '@/lib/editor/constants'
import { findMedia } from '@/lib/editor/factories'
import { hasTimeScaleCurve } from '@/lib/editor/keyframes'
import { computeSnapPoints } from '@/lib/editor/snap'
import {
  decideMove,
  decideRateStretch,
  decideTrimEnd,
  decideTrimStart,
  trimRooms,
} from '@/lib/editor/clip-gesture'
import { autoScrollStep } from '@/lib/editor/timeline-scroll'
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
import { currentTransientToken, isTransientActive, useEditorStore } from '@/lib/editor/store'
import type { Clip, Doc, MediaAsset, Track } from '@/lib/editor/types'
import { toast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import { Waveform } from './Waveform'
import { ClipMarkers } from './ClipMarkers'
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
    /** Alt-drag on an edge re-times the clip (rate stretch) instead of trimming. */
    rateStretch: boolean
    startX: number
    startY: number
    orig: Clip
    origTrackId: string
    lanes: { id: string; kind: string; top: number; bottom: number; el: HTMLElement }[]
    /** Lane under the pointer that cannot host this clip (shown blocked). */
    blockedLane: { id: string; kind: string } | null
    /** Latest pointer position. The auto-scroll tick replays the move from here,
     *  because a scroll produces no further pointermove events. */
    lastX: number
    lastY: number
    /** Window listeners that drive this drag — see beginGesture for why the drag
     *  is not bound to the clip element. */
    onMove: (ev: PointerEvent) => void
    /** Shared by the pointerup and pointercancel listeners, so it takes the
     *  event and filters on the owning pointer. */
    onUp: (ev: PointerEvent) => void
    /** Every OTHER selected clip: follows the move with the same time delta
     *  (and the same track-index offset when the dragged clip changes lane). */
    partners: { id: string; trackIndex: number; kind: string; origStart: number }[]
    moved: boolean
    /** A rejected rate stretch already toasted once this drag: later moves stay
     *  silent, or a held drag over an unreachable span spams a toast per frame. */
    stretchToastShown: boolean
    /** The `!fits` corner's validation verdict for this drag ('pending' until
     *  the first corner frame validates the pair). The clamped span is constant
     *  for the whole drag, so the verdict cannot change mid-gesture: 'ok' lets
     *  later moves dispatch without re-paying the whole-document clone, and
     *  'rejected' applies nothing for the rest of the drag. */
    stretchVerdict: 'pending' | 'ok' | 'rejected'
    /** Store gesture token captured at pointerdown; a mismatch means the slot
     *  was ended underneath us (foreign commit) and frames must stop. */
    token: number
    /** Initiating pointer; other pointers' events are ignored (multi-touch). */
    pointerId: number
  }>(null)

  /**
   * Live lane boxes in viewport coordinates. Must be re-read after ANY scroll —
   * the rows move under a stationary pointer, so cached boxes would point at the
   * wrong lane.
   */
  const readLanes = () => {
    const scrollEl = document.querySelector('[data-timeline-scroll]')
    const laneEls = scrollEl?.querySelectorAll<HTMLElement>('[data-lane-id]') ?? []
    return Array.from(laneEls).map((el) => {
      const r = el.getBoundingClientRect()
      return {
        id: el.dataset.laneId ?? '',
        kind: el.dataset.laneKind ?? '',
        top: r.top,
        bottom: r.bottom,
        el,
      }
    })
  }

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
    // One gesture at a time. A second pointer (multi-touch) would otherwise
    // overwrite `gesture.current` and orphan the first drag's window listeners,
    // which would then never be removed.
    if (gesture.current) endGesture()
    // `gesture` is a per-instance ref, so a drag running on a DIFFERENT clip (a
    // different ClipView) is invisible to the check above — yet the store holds
    // ONE transient base, and beginning another overwrites it, leaving the
    // gesture already running to push a base that is not its own. The store's
    // flag is the shared truth; ask it and refuse. The click still selects below,
    // it just does not start a second drag on top of the first one.
    const transientOwnedElsewhere = isTransientActive()
    const live = useEditorStore.getState()
    if (e.shiftKey) live.addSelection(clip.id)
    else if (e.ctrlKey || e.metaKey) live.toggleSelection(clip.id)
    else if (!clipIsSelected(live.doc, live.selections, clip)) live.select(clip.id)
    // Dragging an ALREADY-selected clip keeps the selection intact — that is
    // what makes a shift-selected multi-drag move every selected clip.
    if (transientOwnedElsewhere) return

    const lanes = readLanes()
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
    // The drag is driven by listeners on `window` rather than by handlers on the
    // clip element. A clip that moves to another lane is rendered inside THAT
    // lane's clip list, so React unmounts this component and mounts a new one in
    // its place — element handlers (and the pointer capture bound to the element)
    // die with it, which is what made a drag stop at the first lane it crossed,
    // leaving a one-lane move as the only thing that ever worked. These listeners
    // outlive the element and remove themselves when the gesture ends.
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== gesture.current?.pointerId) return
      moveTo(ev.clientX, ev.clientY)
    }
    const onUp = (ev: PointerEvent) => {
      // One pointer owns the gesture: a second pointer lifting (multi-touch)
      // must not commit a clip the user is still dragging. Both the pointerup
      // and the pointercancel listeners below are this same handler, so a
      // foreign cancel is ignored for the same reason.
      if (ev.pointerId !== gesture.current?.pointerId) return
      endGesture()
    }
    gesture.current = {
      mode,
      rateStretch: e.altKey && mode !== 'move',
      startX: e.clientX,
      startY: e.clientY,
      orig: structuredClone(clip),
      origTrackId: track.id,
      lanes,
      blockedLane: null,
      lastX: e.clientX,
      lastY: e.clientY,
      partners,
      moved: false,
      stretchToastShown: false,
      stretchVerdict: 'pending',
      token: useEditorStore.getState().beginTransient(e.pointerId),
      pointerId: e.pointerId,
      onMove,
      onUp,
    }
    window.addEventListener('pointermove', onMove)
    // Capture phase on purpose. EditorShell registers a "commit any dangling
    // gesture" safety net on window at mount, so in the BUBBLE order it is
    // registered earlier than this listener and therefore runs first — it would
    // commit before this gesture gets to decide anything, and a refused drop
    // (which must cancel) would be frozen into history. Capture listeners on an
    // ancestor always run before bubble listeners, so the gesture's own end
    // handler gets the first word; the net then sees a closed transient.
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onUp, true)
  }

  const autoScrollRaf = useRef<number | null>(null)

  const stopAutoScroll = () => {
    if (autoScrollRaf.current !== null) {
      cancelAnimationFrame(autoScrollRaf.current)
      autoScrollRaf.current = null
    }
  }

  /**
   * One frame of drag auto-scroll: move the rows, then replay the drag from the
   * last known pointer position so the clip follows onto whatever lane is now
   * under it. Scrolling fires no pointermove, so without this replay the clip
   * would stay behind on the lane it came from.
   */
  const autoScrollTick = () => {
    const g = gesture.current
    const el = document.querySelector('[data-timeline-scroll]')
    const dy = g && el ? autoScrollStep(g.lastY, el.getBoundingClientRect()) : 0
    if (!g || !el || dy === 0) {
      // Pointer left the band (or the timeline went away): let the loop stop.
      autoScrollRaf.current = null
      return
    }
    const before = el.scrollTop
    el.scrollTop = before + dy
    if (el.scrollTop === before) {
      autoScrollRaf.current = null // already at the end of the track list
      return
    }
    // Queue the next frame BEFORE replaying the move: the replay calls
    // syncAutoScroll, and leaving the ref null there would queue a second loop
    // on top of this one — which compounds every frame into runaway scrolling.
    autoScrollRaf.current = requestAnimationFrame(autoScrollTick)
    // The rows slid under a stationary pointer, so the lane boxes now point at
    // the wrong lanes — moveTo re-reads them before resolving the drop.
    moveTo(g.lastX, g.lastY)
  }

  /**
   * Run the auto-scroll loop only while the pointer holds an edge band. The band
   * is the whole visible track area (the ruler strip is part of it), because the
   * pointer sits over that strip when a drag is pushed to the very top.
   */
  const syncAutoScroll = (g: NonNullable<typeof gesture.current>) => {
    const el = document.querySelector('[data-timeline-scroll]')
    if (!el || autoScrollStep(g.lastY, el.getBoundingClientRect()) === 0) {
      stopAutoScroll()
      return
    }
    if (autoScrollRaf.current === null)
      autoScrollRaf.current = requestAnimationFrame(autoScrollTick)
  }

  /**
   * The drag updater, keyed on raw pointer coordinates instead of an event — the
   * auto-scroll tick replays it from the last known position.
   */
  const moveTo = (clientX: number, clientY: number) => {
    const g = gesture.current
    if (!g) return
    // The gesture's window listeners are registered once, at pointer-down, so
    // anything this closure read from props or selectors would be frozen for the
    // whole drag. Read the live doc, zoom and snap flag from the store instead:
    // the doc changes under the drag (selected partners move with it) and the
    // snap guides must be computed from where the clips are NOW.
    const store = useEditorStore.getState()
    const liveDoc = store.doc
    const scale = store.pxPerSec || pxPerSec
    const snapping = store.snapEnabled
    // A foreign commit (keyboard delete, undo) ended the gesture slot: further
    // frames would mutate the doc with no undo entry. The next onUp is a no-op
    // too, so the stale drag dies silently, exactly like the real world where
    // the clip it was dragging no longer exists.
    if (g.token !== currentTransientToken()) return
    if (!g.moved && Math.abs(clientX - g.startX) < 2 && Math.abs(clientY - g.startY) < 2) return
    g.moved = true
    g.lastX = clientX
    g.lastY = clientY

    // Every clip that travels with the pointer must be excluded, not just the
    // one under it: in a MOVE the partners shift by the same delta
    // (decideMove), so their edges and markers keep a constant distance to the
    // dragged clip's edges, and one snap against them would stick for the
    // whole move. A TRIM leaves partners stationary, so their edges and
    // markers stay legitimate targets — exclude them in move mode only.
    const points = computeSnapPoints(liveDoc, {
      excludeClipIds: g.mode === 'move' ? [clip.id, ...g.partners.map((p) => p.id)] : [clip.id],
      includeTimelineEnd: false,
    })

    if (g.mode === 'move') {
      // Re-read the lane boxes every move: the rows can have moved under the
      // pointer since the last event (auto-scroll, a wheel scroll, a resized
      // timeline), and a stale box would resolve the drop onto the wrong lane.
      g.lanes = readLanes()
      // The whole move decision (lane compatibility, snap edge choice, partner
      // shifts) is pure math in clip-gesture.ts — this is only the dispatch.
      const decision = decideMove({
        orig: g.orig,
        origTrackId: g.origTrackId,
        origTrackKind: track.kind,
        clientX,
        clientY,
        startX: g.startX,
        lanes: g.lanes,
        tracks: liveDoc.project.tracks,
        scale,
        snapping,
        snapPoints: points,
        partners: g.partners,
      })
      // Mark an incompatible lane while the pointer is over it. Without this a
      // refused drop looks identical to a drag that simply did nothing.
      for (const l of g.lanes) {
        if (decision.blockedLane && l.id === decision.blockedLane.id)
          l.el.setAttribute('data-drop-blocked', 'true')
        else l.el.removeAttribute('data-drop-blocked')
      }
      g.blockedLane = decision.blockedLane

      store.applyTransient({
        type: 'moveClip',
        clipId: clip.id,
        trackId: decision.targetTrackId,
        start: decision.start,
      })
      for (const p of decision.partnerUpdates) {
        store.applyTransient({
          type: 'moveClip',
          clipId: p.clipId,
          trackId: p.trackId,
          start: p.start,
        })
      }
      onSnapGuide(decision.snapped)
      // Keep the edge scroll running while the pointer holds a band, and stop it
      // the moment it leaves.
      syncAutoScroll(g)
      return
    }

    if (g.mode === 'trim-start' || g.mode === 'trim-end') {
      if (g.rateStretch && isMedia && !hasTimeScaleCurve(clip)) {
        // Alt-drag rate stretch: source span fixed, speed re-derives. Dispatched
        // as speed-then-trim so the trim validates against the NEW speed.
        // A clip with a `timeScale` ramp is skipped: the curve, not the static
        // rate, sets its speed, so there is no rate to stretch. The drag falls
        // through to the plain trim below, which still works.
        const s = decideRateStretch({
          mode: g.mode,
          origStart: g.orig.start,
          origDuration: g.orig.duration,
          origInPoint: g.orig.inPoint,
          origSpeed: g.orig.speed ?? 1,
          clientX,
          startX: g.startX,
          scale,
          // A relink can leave the clip over-consuming this asset; the decision
          // clamps the span to what still fits so the pair stays applicable.
          assetDuration: asset?.duration ?? 0,
        })
        onSnapGuide(null)
        const speedCommand = { type: 'setClipSpeed', clipId: clip.id, speed: s.speed } as const
        const trimCommand = {
          type: 'trimClip',
          clipId: clip.id,
          start: s.start,
          inPoint: s.inPoint,
          duration: s.duration,
          // The decision already holds the SOURCE SPAN fixed and re-derives the
          // speed, so no source anchor moves: the command must not apply an
          // edge's anchor rule (a reversed clip's tail would shift the window).
          edge: 'span',
        } as const
        if (!s.fits) {
          // Even the minimum window overruns the asset (almost no readable
          // source remains): validate the pair to surface the command layer's
          // own message. `fits` is the decision's guarantee that the trim will
          // accept the window, so only this corner pays the validation clone;
          // `applyTransient` still swallows command errors (slider previews
          // rely on it), which is why a rejection is validated up front. The
          // corner's outcome cannot change mid-drag (the clamped span is
          // pointer-independent), so the clone is paid once and the verdict
          // rules the rest of the gesture.
          if (g.stretchVerdict === 'pending') {
            try {
              applyCommands(useEditorStore.getState().doc, [speedCommand, trimCommand])
              g.stretchVerdict = 'ok'
            } catch (error) {
              g.stretchVerdict = 'rejected'
              // A rate stretch the command layer rejects must not die
              // silently: say why ONCE, the way a refused drop does.
              if (!g.stretchToastShown) {
                g.stretchToastShown = true
                toast({
                  title: 'Cannot rate-stretch that far',
                  description: error instanceof Error ? error.message : String(error),
                  variant: 'destructive',
                })
              }
            }
          }
          if (g.stretchVerdict === 'rejected') return
          // Verdict 'ok': the pair is legal for every later frame too, so it
          // dispatches below without a second validation clone.
        }
        store.applyTransient(speedCommand)
        store.applyTransient(trimCommand)
        return
      }
    }

    if (g.mode === 'trim-start') {
      // Pure decision in clip-gesture.ts; this is the dispatch. The rooms are
      // mirrored for a reversed clip, whose head shows the span's HIGH source end
      // (see trimRooms).
      const rooms = trimRooms({
        bounded: isMedia,
        reverse: !!clip.reverse,
        inPoint: clip.inPoint,
        duration: clip.duration,
        speed: clip.speed ?? 1,
        assetDuration: asset?.duration ?? 0,
      })
      const d = decideTrimStart({
        orig: g.orig,
        isUnbounded: !asset || asset.kind === 'image',
        headRoom: rooms.head,
        clientX,
        startX: g.startX,
        scale,
        snapping,
        snapPoints: points,
      })
      onSnapGuide(snapping ? d.snapped : null)
      try {
        store.applyTransient({
          type: 'trimClip',
          clipId: clip.id,
          start: d.start,
          inPoint: d.inPoint,
          duration: d.duration,
          edge: 'head',
        })
      } catch {
        // transient clamp violation — ignore
      }
      return
    }

    // trim-end: the same rooms, read from the other side for a reversed clip.
    const maxDur = trimRooms({
      bounded: isMedia,
      reverse: !!clip.reverse,
      inPoint: clip.inPoint,
      duration: clip.duration,
      speed: clip.speed ?? 1,
      assetDuration: asset?.duration ?? 0,
    }).maxDuration
    const d = decideTrimEnd({
      origStart: clip.start,
      origDuration: g.orig.duration,
      maxDuration: maxDur,
      clientX,
      startX: g.startX,
      scale,
      snapping,
      snapPoints: points,
    })
    onSnapGuide(snapping ? d.snapped : null)
    try {
      store.applyTransient({
        type: 'trimClip',
        clipId: clip.id,
        start: clip.start,
        inPoint: clip.inPoint,
        duration: d.duration,
        edge: 'tail',
      })
    } catch {
      // ignore
    }
  }

  // Unmounting does NOT end a drag: a lane change remounts this component with
  // the gesture still running, so tearing it down here would kill exactly the
  // move the drag is in the middle of. Only clean up an idle instance (the
  // listeners own their own removal, in endGesture).
  useEffect(
    () => () => {
      if (gesture.current) return
      if (autoScrollRaf.current !== null) cancelAnimationFrame(autoScrollRaf.current)
    },
    [],
  )

  const endGesture = () => {
    stopAutoScroll()
    const g = gesture.current
    if (!g) return
    window.removeEventListener('pointermove', g.onMove)
    window.removeEventListener('pointerup', g.onUp, true)
    window.removeEventListener('pointercancel', g.onUp, true)
    // Releasing over an incompatible lane is refused — say why, so the clip
    // snapping back is explained rather than silent.
    if (g.blockedLane) {
      const what =
        clip.text !== undefined
          ? 'Text clips'
          : asset?.kind === 'audio' || clip.audioOnly
            ? 'Audio clips'
            : 'Video and image clips'
      toast({
        title: 'Not a valid drop target',
        description: `${what} cannot be placed on a ${g.blockedLane.kind} track`,
        variant: 'destructive',
      })
    }
    for (const l of g.lanes) l.el.removeAttribute('data-drop-blocked')
    // A refused drop is refused in full. While the pointer sat over the blocked
    // lane the drag kept applying the legal half of the gesture (the time shift,
    // on the original lane), so committing here would move the clip to a new
    // time under a toast saying the drop was invalid. Cancel restores the base
    // doc instead, so the clip goes back to where it started.
    const store = useEditorStore.getState()
    if (g.blockedLane) store.cancelTransient()
    else store.commitTransient()
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
      const commands = commandsToPasteClips(store.doc, store.playhead, store.untargetedTracks)
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
            {(clip.speed ?? 1) !== 1 && !hasTimeScaleCurve(clip) && (
              <span
                data-testid="clip-speed-badge"
                title="Playback speed"
                className="shrink-0 rounded bg-black/40 px-1 text-[9px]"
              >
                {(clip.speed ?? 1).toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}×
              </span>
            )}
            {clip.reverse && (
              <span
                data-testid="clip-reverse-badge"
                title="Reversed (picture only)"
                className="shrink-0 rounded bg-black/40 px-1 text-[9px]"
              >
                ◀
              </span>
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
          />
          <div
            aria-label="Trim clip end"
            className="absolute inset-y-0 right-0 z-10 w-2 cursor-ew-resize opacity-0 transition-opacity hover:opacity-100 group-hover:opacity-100"
            style={{
              background: 'linear-gradient(270deg, rgba(255,255,255,.45), transparent)',
            }}
            onPointerDown={(e) => beginGesture(e, 'trim-end')}
          />

          {/* clip markers: source-anchored tabs on the bottom strip */}
          <ClipMarkers clip={clip} pxPerSec={pxPerSec} />
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
