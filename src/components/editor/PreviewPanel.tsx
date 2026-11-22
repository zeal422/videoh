'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Volume2,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react'

import { NamedSlider } from '@/components/editor/NamedSlider'
import { Button } from '@/components/ui/button'
import { activeSequenceDuration, findClip, findMedia } from '@/lib/editor/factories'
import { offlineMediaAt } from '@/lib/editor/offline'
import { formatTransportTime } from '@/lib/editor/time'
import { attachPreviewEngine, detachPreviewEngine } from '@/lib/editor/playback/preview'
import { playbackRef } from '@/lib/editor/playback/engine-ref'
import { clamp01, measureTextBox } from '@/lib/editor/playback/text-box'
import { clipTransform } from '@/lib/editor/export/offline'
import {
  baseRectForClip,
  canvasSnapTargets,
  pickVisualClipAt,
  quadForClip,
  quadBounds,
  snapBoxToTargets,
  type CanvasSnapGuides,
  type CanvasSnapTargets,
  type TextMeasure,
} from '@/lib/editor/playback/monitor-geometry'
import { animatedValue, clampPropertyValue, keyframeDefaultEasing } from '@/lib/editor/keyframes'
import { withEasing } from '@/lib/editor/ease-segment'
import {
  angleDelta,
  angleFromCenter,
  IDENTITY_TRANSFORM,
  pointerProjectPoint,
  rotationHandleInBounds,
  scaleFromCornerDrag,
  scaleFromDrag,
  snapRotation,
  type ClipTransform,
  type Point,
  type Rect,
} from '@/lib/editor/transform'
import {
  ROTATION_MAX,
  ROTATION_MIN,
  ROTATION_SNAP_STEP,
  ROTATION_SNAP_THRESHOLD,
  SCALE_MAX,
  SCALE_MIN,
  SNAP_THRESHOLD_PX,
} from '@/lib/editor/constants'
import { currentTransientToken, useEditorStore } from '@/lib/editor/store'
import { lockedTrackForClip, trackLockMessage } from '@/lib/editor/tracks'
import { toast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import { ScopesPanel } from './ScopesPanel'
import { TransformGizmo, type GizmoMode } from './TransformGizmo'
import type { EditorCommand } from '@/lib/editor/commands'
import type { Clip, MediaAsset } from '@/lib/editor/types'

/** The injected text measurement for the monitor geometry module. */
const measureText: TextMeasure = (clip, width, height) => measureTextBox(clip, width, height)

/** True when one of the box's three lines on `axis` sits on `target`. */
function boxHasLine(box: Rect, axis: 'x' | 'y', target: number): boolean {
  const lines =
    axis === 'x' ? [box.x0, (box.x0 + box.x1) / 2, box.x1] : [box.y0, (box.y0 + box.y1) / 2, box.y1]
  return lines.some((line) => Math.abs(line - target) <= 1e-3)
}

interface SnappedTextArgs {
  clip: Clip
  asset: MediaAsset | undefined
  width: number
  height: number
  startX: number
  startY: number
  scaleX: number
  scaleY: number
  transform: ClipTransform
  dx: number
  dy: number
  targets: CanvasSnapTargets
  threshold: number
}

/**
 * The snapped normalized style anchor for a text move. The proposed box is
 * built from unclamped normalized coordinates, snapped, then clamped; the
 * clamped box is re-measured so a target the clamp blocked reports no guide.
 * The project-pixel delta converts through `width * scaleX` / `height * scaleY`
 * because the renderer scales the anchor around the frame center.
 */
function snappedTextAnchor(args: SnappedTextArgs): {
  x: number
  y: number
  guides: CanvasSnapGuides
} {
  const { clip, asset, width, height, startX, startY, scaleX, scaleY, transform } = args
  const proposedX = startX + args.dx / width / scaleX
  const proposedY = startY + args.dy / height / scaleY
  if (!clip.style) {
    return { x: clamp01(proposedX), y: clamp01(proposedY), guides: { x: null, y: null } }
  }
  const proposedClip = { ...clip, style: { ...clip.style, x: proposedX, y: proposedY } }
  const proposedBase = baseRectForClip(proposedClip, asset, width, height, measureText)
  if (!proposedBase) {
    return { x: clamp01(proposedX), y: clamp01(proposedY), guides: { x: null, y: null } }
  }
  const box = quadBounds(quadForClip(transform, proposedBase, width, height))
  const snap = snapBoxToTargets(box, args.targets, args.threshold)
  const x = clamp01(startX + (args.dx + snap.dx) / width / scaleX)
  const y = clamp01(startY + (args.dy + snap.dy) / height / scaleY)
  const guides = { ...snap.guides }
  const finalClip = { ...clip, style: { ...clip.style, x, y } }
  const finalBase = baseRectForClip(finalClip, asset, width, height, measureText)
  if (!finalBase) return { x, y, guides: { x: null, y: null } }
  const finalBox = quadBounds(quadForClip(transform, finalBase, width, height))
  if (guides.x !== null && !boxHasLine(finalBox, 'x', guides.x)) guides.x = null
  if (guides.y !== null && !boxHasLine(finalBox, 'y', guides.y)) guides.y = null
  return { x, y, guides }
}

type TextDragOrigin = {
  clipId: string
  px: number
  py: number
  x: number
  y: number
  scaleX: number
  scaleY: number
  transform: ClipTransform
  targets: CanvasSnapTargets
}

/** True while the drag's captured clip is still selected and under the playhead. */
function textDragStillValid(origin: TextDragOrigin): boolean {
  const live = useEditorStore.getState()
  const captured = findClip(live.doc, origin.clipId)
  return (
    !!captured &&
    live.selection === origin.clipId &&
    live.playhead >= captured.clip.start &&
    live.playhead < captured.clip.start + captured.clip.duration
  )
}

/**
 * Center panel: the program monitor (canvas composited by the playback engine)
 * plus transport controls (play/pause, skip, frame-step, time display, volume).
 *
 * Drag-to-position: when the selected TEXT clip is live at the playhead, the
 * monitor becomes a positioning surface — pointer drags update style.x/y via
 * transient commands (one undo step per gesture, committed on release) and a
 * dashed outline (measureTextBox, the compositor's geometry twin) shows what
 * is being moved. Precise/keyboard positioning stays in the Inspector sliders.
 */
export function PreviewPanel() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const doc = useEditorStore((s) => s.doc)
  const activeSequencePath = useEditorStore((s) => s.activeSequencePath)
  const playhead = useEditorStore((s) => s.playhead)
  const playing = useEditorStore((s) => s.playing)
  const mediaError = useEditorStore((s) => s.mediaError)
  const previewRecovering = useEditorStore((s) => s.previewRecovering)
  const selection = useEditorStore((s) => s.selection)
  const eyedropperArmed = useEditorStore((s) => s.eyedropper) !== null
  const [volume, setVolume] = useState(1)
  const [monitor, setMonitor] = useState<HTMLCanvasElement | null>(null)
  // Local to this panel by design: scopes are a view option, not workspace
  // state, so they add no PanelId, no sanitize case and no menu entry.
  const [scopesOpen, setScopesOpen] = useState(false)
  const [draggingText, setDraggingText] = useState(false)
  /** CSS pixels per project pixel, measured from the canvas box. */
  const [canvasScale, setCanvasScale] = useState<number | null>(null)
  const dragOrigin = useRef<TextDragOrigin | null>(null)
  /** Initiating pointer of the active text drag (multi-touch: ignore others). */
  const textDragPointerId = useRef<number | null>(null)
  /** Gesture token from beginTransient: a foreign commit bumps it and the
   *  drag then refuses further frames (they would carry no undo entry). */
  const textDragToken = useRef(-1)

  // Attach the engine once; canvas resolution follows project settings. The
  // element is mirrored into state so the scopes get a real node (a ref's
  // `.current` is null during the first render and never triggers one).
  useEffect(() => {
    if (!canvasRef.current) return
    setMonitor(canvasRef.current)
    attachPreviewEngine(canvasRef.current)
    return () => detachPreviewEngine()
  }, [])

  useEffect(() => {
    playbackRef.current?.setMasterVolume(volume)
  }, [volume])

  // Resolution changes follow project settings; the engine re-syncs on draw.
  useEffect(() => {
    const engine = canvasRef.current
    if (engine) {
      engine.width = doc.project.width
      engine.height = doc.project.height
    }
  }, [doc.project.width, doc.project.height])

  // The monitor's CSS scale keeps the handle size constant on screen. A real
  // browser uses ResizeObserver; without it, the immediate rect plus window
  // resize still measures. The project-relative fallback is only for an
  // unmeasured rect (jsdom) or the first paint before the observer fires.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const measure = () => {
      const rect = canvas.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) {
        setCanvasScale(null)
        return
      }
      const scale = Math.min(rect.width / doc.project.width, rect.height / doc.project.height)
      setCanvasScale(scale > 0 && Number.isFinite(scale) ? scale : null)
    }
    measure()
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(measure)
      observer.observe(canvas)
      return () => observer.disconnect()
    }
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [doc.project.width, doc.project.height])

  // Opening or leaving a sequence changes the timeline's coordinate space: the store
  // parks the playhead at the new sequence's start (see setActiveSequencePath),
  // and this mirror moves the engine there and redraws, so the monitor never
  // keeps showing the previous sequence's frame until the next tick. A playhead
  // written after the path change wins in the store, and this reads it live,
  // so explicit same-tick seeks survive. The ref starts at the current key so
  // the INITIAL render (panel mount) leaves the engine untouched; only a later
  // change acts.
  const activePathKey = activeSequencePath.join('/')
  const prevPathKeyRef = useRef(activePathKey)
  useEffect(() => {
    if (prevPathKeyRef.current === activePathKey) return
    prevPathKeyRef.current = activePathKey
    playbackRef.current?.seek(useEditorStore.getState().playhead)
  }, [activePathKey])

  const duration = activeSequenceDuration(doc, activeSequencePath)
  const isEmpty = duration <= 0
  // A frame that needs offline media renders black and silent; naming the file
  // is the difference between "broken" and "waiting for a relink".
  const offlineMedia = useMemo(
    () => offlineMediaAt(doc, playhead, activeSequencePath),
    [doc, playhead, activeSequencePath],
  )
  const mediaErrorCopy = useMemo(() => {
    if (!mediaError) return null
    if (mediaError.terminal) {
      return {
        title: 'Damaged media',
        body: `This media has a damaged section the browser cannot decode. Re-encode the file or trim around ${formatTransportTime(mediaError.time)}.`,
      }
    }
    const from = Math.min(mediaError.time, mediaError.skippedTo ?? mediaError.time)
    const to = Math.max(mediaError.time, mediaError.skippedTo ?? mediaError.time)
    return {
      title: 'Skipped damaged media',
      body: `from ${formatTransportTime(from)} to ${formatTransportTime(to)}. The browser could not decode that section.`,
    }
  }, [mediaError])

  // ————— drag-to-position (text) —————
  const selected = selection ? findClip(doc, selection) : undefined
  const textClip =
    selected && selected.clip.text !== undefined && selected.track.kind === 'text'
      ? selected.clip
      : undefined
  const textLive =
    !!textClip && playhead >= textClip.start && playhead < textClip.start + textClip.duration
  const canDragText = !!textClip && textLive

  const textBox =
    canDragText && textClip?.style
      ? measureTextBox(textClip, doc.project.width, doc.project.height)
      : null

  // ----- transform gizmo (0.24.0) -----
  const selectedAsset = selected?.clip ? findMedia(doc, selected.clip.mediaId) : undefined
  const gizmoClip = (() => {
    if (!selected || selected.track.kind === 'audio') return undefined
    const clip = selected.clip
    const visual =
      clip.text !== undefined || clip.sequenceId !== undefined || clip.shape !== undefined
        ? true
        : !!selectedAsset && selectedAsset.kind !== 'audio'
    if (!visual) return undefined
    if (playhead < clip.start || playhead >= clip.start + clip.duration) return undefined
    return clip
  })()
  const gizmoLocked = gizmoClip ? lockedTrackForClip(doc, gizmoClip.id) : null
  const gizmoBase: Rect | null = gizmoClip
    ? baseRectForClip(
        gizmoClip,
        findMedia(doc, gizmoClip.mediaId),
        doc.project.width,
        doc.project.height,
        measureText,
      )
    : null
  const gizmoTransform: ClipTransform | null =
    gizmoClip && gizmoBase
      ? (clipTransform(gizmoClip, playhead - gizmoClip.start) ?? IDENTITY_TRANSFORM)
      : null
  const gizmo =
    gizmoClip && gizmoBase && gizmoTransform && !gizmoLocked
      ? (() => {
          const quad = quadForClip(gizmoTransform, gizmoBase, doc.project.width, doc.project.height)
          const distance = Math.max(28, Math.min(doc.project.width, doc.project.height) * 0.06)
          // CSS-relative sizing: a 10px visible dot and a 24px hit target at
          // any monitor size. The project-relative pair is the unmeasured
          // fallback only (jsdom, or the first paint before measurement).
          const measured = canvasScale !== null && canvasScale > 0
          return {
            quad,
            handle: rotationHandleInBounds(quad, distance, doc.project.width, doc.project.height),
            visualRadius: measured ? 5 / canvasScale : Math.max(5, doc.project.width * 0.007),
            hitRadius: measured ? 12 / canvasScale : Math.max(10, doc.project.width * 0.014),
          }
        })()
      : null

  interface GizmoDrag {
    mode: GizmoMode
    pointerId: number
    token: number
    clipId: string
    /**
     * Clip-local time captured at pointer-down. Keyframe writes reuse this for
     * the whole gesture, so playback or a scrub landing mid-drag cannot scatter
     * one drag across several keyframe times.
     */
    at: number
    center: Point
    startPoint: Point
    startDistance: number
    /** Snap targets captured at pointer-down; the other clips do not move. */
    targets: CanvasSnapTargets
    /** The clip's untransformed box and transform at pointer-down. */
    baseRect: Rect
    transform: ClipTransform
    /** The playhead the gesture was captured at; any move cancels the drag. */
    playhead: number
    /**
     * Unwrapped rotation tracking: each move adds its shortest step to
     * `turned`, so crossing the half-turn opposite the grab point keeps
     * continuity (no 358-degree snap) and full revolutions add turns instead
     * of cancelling out. `lastAngle` is the previous frame's pointer angle.
     */
    lastAngle: number
    turned: number
    /** The grabbed corner (scale mode) and where inside its hit target the press landed. */
    corner: number
    cornerPoint: Point
    grabOffset: Point
    /** The last pointer position in project pixels, replayed on a Shift key event. */
    lastPoint: Point
    /** True while the live scale preview is non-uniform. */
    shiftHeld: boolean
    /** Window Shift listener owned by this gesture. */
    onShiftKey: (event: KeyboardEvent) => void
    start: {
      posX: number
      posY: number
      scale: number
      stretchX: number
      stretchY: number
      rotation: number
      x: number
      y: number
      scaleX: number
      scaleY: number
    }
  }
  const gizmoDrag = useRef<GizmoDrag | null>(null)
  const [gizmoActive, setGizmoActive] = useState(false)
  const [snapGuides, setSnapGuides] = useState<CanvasSnapGuides>({ x: null, y: null })

  const showSnapGuides = (next: CanvasSnapGuides) => {
    setSnapGuides((previous) => (previous.x === next.x && previous.y === next.y ? previous : next))
  }

  /**
   * One scale frame from the captured base. Shift writes per-axis stretch and
   * leaves the uniform (and any `scale` curve) alone; no Shift writes the
   * uniform scale through the existing command path.
   */
  const applyScaleFrame = (drag: GizmoDrag, point: Point, shift: boolean) => {
    const store = useEditorStore.getState()
    if (shift) {
      const ratios = scaleFromCornerDrag(
        drag.cornerPoint,
        drag.center,
        drag.startPoint,
        point,
        drag.start.rotation,
      )
      const stretchX = Math.min(SCALE_MAX, Math.max(SCALE_MIN, drag.start.stretchX * ratios.ratioX))
      const stretchY = Math.min(SCALE_MAX, Math.max(SCALE_MIN, drag.start.stretchY * ratios.ratioY))
      store.applyTransient({
        type: 'setClipStretch',
        clipId: drag.clipId,
        stretchX,
        stretchY,
      })
      return
    }
    const distance = Math.hypot(point.x - drag.center.x, point.y - drag.center.y)
    const scale = scaleFromDrag(
      drag.startDistance,
      distance,
      drag.start.scale,
      SCALE_MIN,
      SCALE_MAX,
    )
    store.applyTransient(gizmoCommand(drag, 'scale', scale))
  }

  const onGizmoPointerDown = (
    mode: GizmoMode,
    e: React.PointerEvent<SVGSVGElement>,
    cornerIndex?: number,
  ) => {
    if (!gizmoClip || !gizmo || e.button !== 0) return
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0 || rect.height === 0) return
    const live = useEditorStore.getState()
    const found = findClip(live.doc, gizmoClip.id)
    if (!found) return
    const locked = lockedTrackForClip(live.doc, gizmoClip.id)
    if (locked) {
      toast({
        title: 'Track locked',
        description: trackLockMessage(locked),
        variant: 'destructive',
      })
      return
    }
    const point = pointerProjectPoint(
      e.clientX,
      e.clientY,
      rect,
      live.doc.project.width,
      live.doc.project.height,
    )
    // Inside the selected box a topmost overlapping clip still wins the press:
    // the move polygon must not swallow a click meant to select it. Handles
    // (scale, rotate) keep owning their press.
    if (mode === 'move') {
      const hit = pickVisualClipAt(
        live.doc,
        live.activeSequencePath,
        live.playhead,
        point,
        measureText,
      )
      const modifier = e.shiftKey || e.ctrlKey || e.metaKey
      if (hit) {
        if (hit.id !== found.clip.id || modifier) {
          if (e.shiftKey) live.addSelection(hit.id)
          else if (e.ctrlKey || e.metaKey) live.toggleSelection(hit.id)
          else live.select(hit.id)
          return
        }
      } else {
        // The move polygon can sit over a clip the picker skips (a hidden
        // track or a fully transparent clip). That press is an empty monitor
        // click, never the start of a transform on an invisible clip.
        if (!(canDragText && textClip?.style) && !modifier) live.select(null)
        return
      }
    }
    const center = {
      x: (gizmo.quad[0].x + gizmo.quad[1].x + gizmo.quad[2].x + gizmo.quad[3].x) / 4,
      y: (gizmo.quad[0].y + gizmo.quad[1].y + gizmo.quad[2].y + gizmo.quad[3].y) / 4,
    }
    const local = live.playhead - found.clip.start
    const transform = clipTransform(found.clip, local) ?? IDENTITY_TRANSFORM
    // A monitor transform drag requires a paused transport: the cached target
    // set is captured once, so a playing playhead would make it stale.
    if (live.playing) playbackRef.current?.pause()
    const baseRect = baseRectForClip(
      found.clip,
      findMedia(live.doc, found.clip.mediaId),
      live.doc.project.width,
      live.doc.project.height,
      measureText,
    )
    if (!baseRect) return
    const targets = canvasSnapTargets(
      live.doc,
      live.activeSequencePath,
      live.playhead,
      [found.clip.id],
      measureText,
    )
    // A second drag cannot join the live gesture: the store refuses the begin
    // and leaves that gesture untouched, so this drag never starts.
    const token = live.beginTransient(e.pointerId)
    if (token === null) return
    const corner = mode === 'scale' ? (cornerIndex ?? 0) : 0
    const cornerPoint = mode === 'scale' ? (gizmo.quad[corner] ?? center) : center
    const grabOffset = { x: point.x - cornerPoint.x, y: point.y - cornerPoint.y }
    // Shift is a live preview modifier, not only a pointer flag: releasing it
    // with the mouse still down must return the preview to proportional.
    const onShiftKey = (event: KeyboardEvent) => {
      const drag = gizmoDrag.current
      if (!drag || drag.pointerId !== e.pointerId || drag.mode !== 'scale') return
      if (event.key !== 'Shift') return
      const shift = event.type === 'keydown'
      if (shift === drag.shiftHeld) return
      if (currentTransientToken() !== drag.token) return
      live.resetTransient()
      drag.shiftHeld = shift
      applyScaleFrame(drag, drag.lastPoint, shift)
    }
    window.addEventListener('keydown', onShiftKey)
    window.addEventListener('keyup', onShiftKey)
    gizmoDrag.current = {
      mode,
      pointerId: e.pointerId,
      token,
      clipId: gizmoClip.id,
      at: local,
      center,
      startPoint: point,
      lastAngle: angleFromCenter(center, point),
      turned: 0,
      startDistance: Math.hypot(point.x - center.x, point.y - center.y),
      targets,
      baseRect,
      transform,
      playhead: live.playhead,
      corner,
      cornerPoint,
      grabOffset,
      lastPoint: point,
      shiftHeld: e.shiftKey,
      onShiftKey,
      start: {
        posX: transform.posX,
        posY: transform.posY,
        // The proportional path writes the uniform property, so capture the
        // curve/static `scale` alone; `scaleX` already includes the stretch.
        scale: animatedValue(found.clip, 'scale', local),
        stretchX: found.clip.stretchX ?? 1,
        stretchY: found.clip.stretchY ?? 1,
        rotation: transform.rotation,
        x: found.clip.style?.x ?? 0.5,
        y: found.clip.style?.y ?? 0.5,
        scaleX: transform.scaleX,
        scaleY: transform.scaleY,
      },
    }
    setSnapGuides({ x: null, y: null })
    setGizmoActive(true)
  }

  /**
   * One Motion write for a gizmo frame: an existing curve gets a keyframe at the
   * captured drag time (the same command path the Effect Controls dot uses),
   * while an unanimated property writes its static field. Rotation has its own
   * field.
   */
  const gizmoCommand = (
    drag: GizmoDrag,
    property: 'positionX' | 'positionY' | 'scale' | 'rotation',
    value: number,
  ): EditorCommand => {
    const live = useEditorStore.getState()
    const found = findClip(live.doc, drag.clipId)
    const at = drag.at
    const curve = found?.clip.keyframes?.[property] ?? []
    if (curve.length > 0) {
      const next = curve.filter((keyframe) => Math.abs(keyframe.time - at) > 1e-6)
      next.push(
        withEasing(
          { time: at, value: clampPropertyValue(property, value) },
          keyframeDefaultEasing(live.doc.project.keyframeDefaults, property),
        ),
      )
      return { type: 'setClipKeyframes', clipId: drag.clipId, property, keyframes: next }
    }
    if (property === 'rotation') {
      return { type: 'setClipRotation', clipId: drag.clipId, rotation: value }
    }
    return { type: 'setClipAnimStatic', clipId: drag.clipId, property, value }
  }

  const onGizmoPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const drag = gizmoDrag.current
    if (!drag || e.pointerId !== drag.pointerId) return
    const store = useEditorStore.getState()
    if (currentTransientToken() !== drag.token) return
    // The target set was captured at pointer-down; a playhead move or a Play
    // press would make it stale, so it cancels the gesture instead.
    if (store.playhead !== drag.playhead || store.playing) {
      endGizmoDrag(false)
      return
    }
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0 || rect.height === 0) return
    const point = pointerProjectPoint(
      e.clientX,
      e.clientY,
      rect,
      store.doc.project.width,
      store.doc.project.height,
    )
    const found = findClip(store.doc, drag.clipId)
    if (!found) return
    const width = store.doc.project.width
    const height = store.doc.project.height
    const snapping = store.snapEnabled
    const threshold = SNAP_THRESHOLD_PX * (width / rect.width)
    if (drag.mode === 'move') {
      const dx = point.x - drag.startPoint.x
      const dy = point.y - drag.startPoint.y
      const asset = findMedia(store.doc, found.clip.mediaId)
      if (found.clip.text !== undefined) {
        const scaleX = drag.start.scaleX || 1
        const scaleY = drag.start.scaleY || 1
        const result = snapping
          ? snappedTextAnchor({
              clip: found.clip,
              asset,
              width,
              height,
              startX: drag.start.x,
              startY: drag.start.y,
              scaleX,
              scaleY,
              transform: drag.transform,
              dx,
              dy,
              targets: drag.targets,
              threshold,
            })
          : {
              x: clamp01(drag.start.x + dx / width / scaleX),
              y: clamp01(drag.start.y + dy / height / scaleY),
              guides: { x: null, y: null },
            }
        showSnapGuides(result.guides)
        store.applyTransient({
          type: 'setTextStyle',
          clipId: drag.clipId,
          style: { x: result.x, y: result.y },
        })
        return
      }
      let nextDx = dx
      let nextDy = dy
      let guides: CanvasSnapGuides = { x: null, y: null }
      if (snapping) {
        const proposed = quadBounds(
          quadForClip(
            {
              ...drag.transform,
              posX: drag.start.posX + dx,
              posY: drag.start.posY + dy,
            },
            drag.baseRect,
            width,
            height,
          ),
        )
        const snap = snapBoxToTargets(proposed, drag.targets, threshold)
        nextDx += snap.dx
        nextDy += snap.dy
        guides = snap.guides
      }
      showSnapGuides(guides)
      store.applyTransientBatch([
        gizmoCommand(drag, 'positionX', drag.start.posX + nextDx),
        gizmoCommand(drag, 'positionY', drag.start.posY + nextDy),
      ])
      return
    }
    if (drag.mode === 'scale') {
      drag.lastPoint = point
      const shift = e.shiftKey
      // Both transitions reset the transient first: the uniform preview must
      // not remain under the stretch preview (which would multiply it), and a
      // stretch preview must not linger after Shift is released.
      if (shift !== drag.shiftHeld) {
        store.resetTransient()
        drag.shiftHeld = shift
      }
      showSnapGuides({ x: null, y: null })
      applyScaleFrame(drag, point, shift)
      return
    }
    drag.lastPoint = point
    const angle = angleFromCenter(drag.center, point)
    // Successive shortest steps accumulate: crossing the half-turn cannot
    // snap, and circling the center adds real turns. Snap lands before the
    // bounds clamp, and 15 divides 3600 so the two grids cannot fight.
    drag.turned += angleDelta(drag.lastAngle, angle)
    drag.lastAngle = angle
    const raw = drag.start.rotation + drag.turned
    const snapped = snapping ? snapRotation(raw, ROTATION_SNAP_STEP, ROTATION_SNAP_THRESHOLD) : raw
    const rotation = Math.min(ROTATION_MAX, Math.max(ROTATION_MIN, snapped))
    showSnapGuides({ x: null, y: null })
    store.applyTransient(gizmoCommand(drag, 'rotation', rotation))
  }

  const endGizmoDrag = (commit: boolean, e?: React.PointerEvent<SVGSVGElement>) => {
    const drag = gizmoDrag.current
    if (!drag) return
    if (e && e.pointerId !== drag.pointerId) return
    window.removeEventListener('keydown', drag.onShiftKey)
    window.removeEventListener('keyup', drag.onShiftKey)
    // A pointerup can carry a Shift state the last pointermove never saw:
    // releasing Shift then the mouse (or pressing it then releasing) must
    // finalize the frame the release actually asks for.
    if (commit && e && drag.mode === 'scale' && e.shiftKey !== drag.shiftHeld) {
      const rect = canvasRef.current?.getBoundingClientRect()
      if (rect && rect.width > 0 && rect.height > 0) {
        const live = useEditorStore.getState()
        const point = pointerProjectPoint(
          e.clientX,
          e.clientY,
          rect,
          live.doc.project.width,
          live.doc.project.height,
        )
        if (currentTransientToken() === drag.token) {
          live.resetTransient()
          drag.shiftHeld = e.shiftKey
          applyScaleFrame(drag, point, e.shiftKey)
        }
      }
    }
    gizmoDrag.current = null
    setGizmoActive(false)
    setSnapGuides({ x: null, y: null })
    // Ownership: a foreign end (foreign apply/undo) or a replacement gesture
    // already closed or owns the slot, so committing here would finalize the
    // wrong gesture. Only the token owner commits or cancels.
    if (currentTransientToken() !== drag.token) return
    const store = useEditorStore.getState()
    if (commit) store.commitTransient()
    else store.cancelTransient()
  }

  // Playback can carry the playhead past the clip mid-drag, unmounting the
  // SVG (and its pointerup) while the gesture is still live. The shell's
  // global pointerup still finalizes the transient, but the stale ref and
  // highlight would linger, so clear them at this lifecycle boundary.
  useEffect(() => {
    const drag = gizmoDrag.current
    if (gizmo || !drag) return
    // The overlay can disappear without a Play/playhead cancel (for example a
    // foreign selection change). Close the gesture here or it would keep a
    // transient open and replay Shift key events into a dead drag.
    window.removeEventListener('keydown', drag.onShiftKey)
    window.removeEventListener('keyup', drag.onShiftKey)
    gizmoDrag.current = null
    setGizmoActive(false)
    setSnapGuides({ x: null, y: null })
    if (currentTransientToken() === drag.token) useEditorStore.getState().cancelTransient()
  })

  // Unmounting the panel (panel close, editor teardown) must close any live
  // gesture: no setState on an unmounted tree, but the transient and the
  // window Shift listener are shared state and would outlive the component.
  useEffect(() => {
    return () => {
      const gizmo = gizmoDrag.current
      if (gizmo) {
        window.removeEventListener('keydown', gizmo.onShiftKey)
        window.removeEventListener('keyup', gizmo.onShiftKey)
        gizmoDrag.current = null
        if (currentTransientToken() === gizmo.token) useEditorStore.getState().cancelTransient()
      }
      const origin = dragOrigin.current
      if (origin) {
        const token = textDragToken.current
        dragOrigin.current = null
        textDragPointerId.current = null
        if (currentTransientToken() === token) useEditorStore.getState().cancelTransient()
      }
    }
  }, [])

  // A monitor transform drag requires a paused transport: its snap targets are
  // captured once at pointer-down. Pressing Play or moving the playhead cancels
  // the gesture (and its text counterpart), so the targets cannot go stale.
  useEffect(() => {
    return useEditorStore.subscribe((state, previous) => {
      if (!gizmoDrag.current && !dragOrigin.current) return
      // Turning snapping off mid-drag clears the live guides even before the
      // next pointer frame; the gesture itself continues unsnapped.
      if (!state.snapEnabled && previous.snapEnabled) {
        setSnapGuides({ x: null, y: null })
      }
      const startedPlaying = state.playing && !previous.playing
      if (!startedPlaying && state.playhead === previous.playhead) return
      const gizmo = gizmoDrag.current
      if (gizmo) {
        window.removeEventListener('keydown', gizmo.onShiftKey)
        window.removeEventListener('keyup', gizmo.onShiftKey)
        gizmoDrag.current = null
        setGizmoActive(false)
        setSnapGuides({ x: null, y: null })
        if (currentTransientToken() === gizmo.token) useEditorStore.getState().cancelTransient()
      }
      if (dragOrigin.current) {
        const token = textDragToken.current
        dragOrigin.current = null
        textDragPointerId.current = null
        setDraggingText(false)
        setSnapGuides({ x: null, y: null })
        if (currentTransientToken() === token) useEditorStore.getState().cancelTransient()
      }
    })
  }, [])

  const onCanvasPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    // Armed chroma-key eyedropper (0.8.6) takes precedence over text drags:
    // sample the pixel under the cursor into the entry's key, then disarm.
    const store = useEditorStore.getState()
    const armed = store.eyedropper
    if (armed && e.button === 0) {
      const canvas = canvasRef.current
      const rect = canvas?.getBoundingClientRect()
      if (canvas && rect && rect.width > 0 && rect.height > 0) {
        // Clamped to the last pixel: a click on the exact monitor edge maps
        // to canvas.width/height, which getImageData rejects with an
        // IndexSizeError (misreported as an unreadable pixel below).
        const px = Math.min(
          canvas.width - 1,
          Math.max(0, Math.floor(((e.clientX - rect.left) / rect.width) * canvas.width)),
        )
        const py = Math.min(
          canvas.height - 1,
          Math.max(0, Math.floor(((e.clientY - rect.top) / rect.height) * canvas.height)),
        )
        try {
          const data = canvas.getContext('2d')?.getImageData(px, py, 1, 1).data
          if (!data) {
            // Null context (or an unreadable pixel): same notice as a taint,
            // instead of disarming silently with the old key still showing.
            throw new Error('unreadable pixel')
          }
          const hex = `#${[data[0], data[1], data[2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`
          store.apply({
            type: 'setEffectParams',
            clipId: armed.clipId,
            effectId: armed.effectId,
            params: { key: hex },
          })
        } catch {
          // Tainted canvas: keep the previous key (hex fallback stays).
          toast({
            title: 'Could not sample that pixel',
            description: 'Type the hex color instead.',
          })
        }
      }
      store.setEyedropper(null)
      return
    }
    if (e.button !== 0) return
    const canvas = canvasRef.current
    const rect = canvas?.getBoundingClientRect()
    if (!rect || rect.width === 0 || rect.height === 0) return
    const point = pointerProjectPoint(
      e.clientX,
      e.clientY,
      rect,
      store.doc.project.width,
      store.doc.project.height,
    )
    const modifier = e.shiftKey || e.ctrlKey || e.metaKey
    const hit = pickVisualClipAt(
      store.doc,
      store.activeSequencePath,
      store.playhead,
      point,
      measureText,
    )
    if (hit) {
      // A press on the already-selected live text clip starts the drag; a
      // first click on an unselected one only changes the selection.
      if (canDragText && textClip?.id === hit.id && !modifier) {
        startTextDrag(e)
        return
      }
      if (e.shiftKey) store.addSelection(hit.id)
      else if (e.ctrlKey || e.metaKey) store.toggleSelection(hit.id)
      else store.select(hit.id)
      return
    }
    // The existing canvas text drag starts from arbitrary coordinates, so a
    // selected live text clip keeps that surface. Only a click with no text
    // drag to own it clears the selection.
    if (canDragText && textClip?.style && !modifier) {
      startTextDrag(e)
      return
    }
    if (!modifier) store.select(null)
  }

  /** Starts the existing drag-to-position gesture for the selected text clip. */
  const startTextDrag = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!canDragText || !textClip?.style) return
    // Lock gate (0.14.0): a text drag writes the clip's style, so a locked
    // lane refuses it before the transient starts (the command layer agrees).
    const lockedTrack = lockedTrackForClip(useEditorStore.getState().doc, textClip.id)
    if (lockedTrack) {
      toast({
        title: 'Track locked',
        description: trackLockMessage(lockedTrack),
        variant: 'destructive',
      })
      return
    }
    const canvas = canvasRef.current
    const rect = canvas?.getBoundingClientRect()
    if (!rect || rect.width === 0 || rect.height === 0) return
    // Synthetic pointer events (automation) carry an inactive pointerId —
    // capture is a UX nicety, not required for the gesture to work.
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* headless/automation: proceed without capture */
    }
    const store = useEditorStore.getState()
    if (store.playing) playbackRef.current?.pause()
    const token = store.beginTransient(e.pointerId)
    if (token === null) return
    const transform = clipTransform(textClip, store.playhead - textClip.start) ?? IDENTITY_TRANSFORM
    dragOrigin.current = {
      // The gesture owns this clip for its whole life: a selection change or a
      // playhead move must cancel the drag, never retarget it at whatever text
      // clip the next render happens to derive.
      clipId: textClip.id,
      px: e.clientX,
      py: e.clientY,
      x: textClip.style.x,
      y: textClip.style.y,
      // The style anchor moves through the positionedCenter contract, like the
      // gizmo text move below: divide each pointer delta by its own axis scale.
      scaleX: transform.scaleX,
      scaleY: transform.scaleY,
      transform,
      // The same target set the gizmo uses, captured once for the gesture.
      targets: canvasSnapTargets(
        store.doc,
        store.activeSequencePath,
        store.playhead,
        [textClip.id],
        measureText,
      ),
    }
    textDragToken.current = token
    textDragPointerId.current = e.pointerId
    setDraggingText(true)
  }

  const onCanvasPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    // Only the initiating pointer drives the drag (multi-touch).
    if (dragOrigin.current && e.pointerId !== textDragPointerId.current) return
    const origin = dragOrigin.current
    const canvas = canvasRef.current
    if (!origin || !canvas) return
    // A foreign commit (keyboard delete, undo) ended the gesture slot: applying
    // further frames would mutate the doc with no undo entry behind them.
    if (currentTransientToken() !== textDragToken.current) return
    // The captured clip must still be the selected, live clip. Reading the
    // render's derived `textClip` here would follow a selection switch or throw
    // once the playhead left the clip.
    if (!textDragStillValid(origin)) {
      endTextDrag(false)
      return
    }
    const rect = canvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    const store = useEditorStore.getState()
    const found = findClip(store.doc, origin.clipId)
    if (!found) return
    const width = store.doc.project.width
    const height = store.doc.project.height
    const scaleX = origin.scaleX || 1
    const scaleY = origin.scaleY || 1
    // Client-pixel delta ÷ displayed canvas size × project size = project
    // pixels; the anchor conversion divides by its own axis scale.
    const dx = ((e.clientX - origin.px) / rect.width) * width
    const dy = ((e.clientY - origin.py) / rect.height) * height
    const result = store.snapEnabled
      ? snappedTextAnchor({
          clip: found.clip,
          asset: findMedia(store.doc, found.clip.mediaId),
          width,
          height,
          startX: origin.x,
          startY: origin.y,
          scaleX,
          scaleY,
          transform: origin.transform,
          dx,
          dy,
          targets: origin.targets,
          threshold: SNAP_THRESHOLD_PX * (width / rect.width),
        })
      : {
          x: clamp01(origin.x + dx / width / scaleX),
          y: clamp01(origin.y + dy / height / scaleY),
          guides: { x: null, y: null },
        }
    showSnapGuides(result.guides)
    store.applyTransient({
      type: 'setTextStyle',
      clipId: origin.clipId,
      style: { x: result.x, y: result.y },
    })
  }

  const endTextDrag = (commit: boolean, e?: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragOrigin.current) return
    // A second pointer must not end a drag it did not start (multi-touch).
    if (e && e.pointerId !== textDragPointerId.current) return
    const token = textDragToken.current
    dragOrigin.current = null
    textDragPointerId.current = null
    setDraggingText(false)
    setSnapGuides({ x: null, y: null })
    // Same ownership rule as the gizmo path: only the token owner commits or
    // cancels, so a stale release cannot finalize a replacement gesture.
    if (currentTransientToken() !== token) return
    const store = useEditorStore.getState()
    if (commit) store.commitTransient()
    else store.cancelTransient()
  }

  const onCanvasPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const origin = dragOrigin.current
    // A selection or playhead change can land after the last pointermove. The
    // release must recheck validity, or it commits the stale preview to a clip
    // that is no longer the gesture's target.
    if (origin && !textDragStillValid(origin)) {
      endTextDrag(false, e)
      return
    }
    endTextDrag(true, e)
  }

  useEffect(() => {
    const cancelInvalidOnRelease = (e: PointerEvent) => {
      const origin = dragOrigin.current
      if (!origin || e.pointerId !== textDragPointerId.current) return
      if (textDragStillValid(origin)) return
      // The canvas handler cannot see a release that lands outside it (capture
      // loss). Cancel in the capture phase, before the shell's bubble pointerup
      // safety net commits the stale transient.
      const token = textDragToken.current
      dragOrigin.current = null
      textDragPointerId.current = null
      setDraggingText(false)
      setSnapGuides({ x: null, y: null })
      if (currentTransientToken() === token) useEditorStore.getState().cancelTransient()
    }
    window.addEventListener('pointerup', cancelInvalidOnRelease, true)
    return () => window.removeEventListener('pointerup', cancelInvalidOnRelease, true)
  }, [])

  return (
    /* @container: the volume slider's visibility (@lg:) keys off THIS panel's
       width, not the viewport — a narrow panel hides the slider instead of
       letting the transport row overflow and clip its buttons. */
    <section
      aria-label="Preview"
      className="@container flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-zinc-950"
    >
      <div className="relative flex min-h-0 flex-1 items-center justify-center p-3">
        <div
          className="relative max-h-full max-w-full"
          style={{
            aspectRatio: `${doc.project.width} / ${doc.project.height}`,
          }}
        >
          <canvas
            ref={canvasRef}
            aria-label="Video preview canvas"
            data-testid="preview-canvas"
            className={cn(
              'block h-full max-h-full w-auto max-w-full rounded border border-zinc-800 bg-black shadow-2xl',
              canDragText && !draggingText && 'cursor-grab',
              draggingText && 'cursor-grabbing',
              eyedropperArmed && 'cursor-crosshair',
            )}
            style={{
              aspectRatio: `${doc.project.width} / ${doc.project.height}`,
            }}
            title={canDragText ? 'Drag to reposition the selected text' : undefined}
            onPointerDown={onCanvasPointerDown}
            onPointerMove={onCanvasPointerMove}
            onPointerUp={onCanvasPointerUp}
            onPointerCancel={(e) => endTextDrag(false, e)}
          />
          {textBox && (
            <div
              aria-hidden="true"
              data-testid="text-drag-outline"
              className={cn(
                'pointer-events-none absolute rounded-sm border border-dashed transition-colors',
                draggingText ? 'border-rose-400 bg-rose-400/5' : 'border-white/50',
              )}
              style={{
                left: `${Math.max(0, textBox.x0) * 100}%`,
                top: `${Math.max(0, textBox.y0) * 100}%`,
                width: `${(Math.min(1, textBox.x1) - Math.max(0, textBox.x0)) * 100}%`,
                height: `${(Math.min(1, textBox.y1) - Math.max(0, textBox.y0)) * 100}%`,
              }}
            />
          )}
          {/* The gizmo overlay swallows canvas clicks, so it hides while the
              eyedropper is armed and the canvas stays samplable. */}
          {gizmo && !eyedropperArmed && (
            <TransformGizmo
              projectWidth={doc.project.width}
              projectHeight={doc.project.height}
              quad={gizmo.quad}
              rotateHandle={gizmo.handle}
              visualRadius={gizmo.visualRadius}
              hitRadius={gizmo.hitRadius}
              snapGuides={snapGuides}
              active={gizmoActive}
              onPointerDown={onGizmoPointerDown}
              onPointerMove={onGizmoPointerMove}
              onPointerUp={(e) => endGizmoDrag(true, e)}
              onPointerCancel={(e) => endGizmoDrag(false, e)}
            />
          )}
          {isEmpty && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <p className="rounded-lg bg-black/60 px-4 py-2 text-sm text-zinc-300">
                Import media or press <kbd className="rounded bg-zinc-700 px-1">T</kbd> to add text
              </p>
            </div>
          )}
          {previewRecovering && !mediaErrorCopy && (
            <div
              data-testid="preview-recovering"
              className="pointer-events-none absolute inset-0 flex items-center justify-center p-4"
            >
              <p className="rounded-lg bg-black/60 px-4 py-2 text-sm text-zinc-300">
                Preview catching up
              </p>
            </div>
          )}
          {mediaErrorCopy ? (
            <div
              data-testid="media-decode-overlay"
              className="pointer-events-none absolute inset-0 flex items-center justify-center p-4"
            >
              <div className="max-w-full rounded-lg border border-amber-500/40 bg-black/70 px-4 py-3 text-center">
                <p className="text-sm font-medium text-amber-300">{mediaErrorCopy.title}</p>
                <p className="mt-1 text-xs text-amber-200/80">{mediaErrorCopy.body}</p>
                <Button
                  variant="secondary"
                  size="sm"
                  className="pointer-events-auto mt-2"
                  onClick={() => useEditorStore.getState().clearMediaError()}
                >
                  Dismiss
                </Button>
              </div>
            </div>
          ) : (
            !isEmpty &&
            offlineMedia.length > 0 && (
              <div
                data-testid="media-offline-overlay"
                className="pointer-events-none absolute inset-0 flex items-center justify-center p-4"
              >
                <div className="max-w-full rounded-lg border border-amber-500/40 bg-black/70 px-4 py-3 text-center">
                  <p className="text-sm font-medium text-amber-300">Media offline</p>
                  <p className="mt-1 truncate text-xs text-amber-200/80">
                    {offlineMedia.join(', ')}
                  </p>
                  <p className="mt-1 text-[11px] text-zinc-400">
                    Relink in the Media bin to bring this frame back
                  </p>
                </div>
              </div>
            )
          )}
        </div>
      </div>

      {/* Scopes sit between the monitor and the transport: the meters read the
          monitor canvas, and the transport stays pinned at the bottom. */}
      <ScopesPanel canvas={monitor} open={scopesOpen} onToggle={() => setScopesOpen((v) => !v)} />

      {/* transport — shrink-0 so it stays visible at any panel height; the
          canvas area above is the only part that gives up space. */}
      <div className="flex h-12 min-w-0 shrink-0 items-center justify-center gap-1 overflow-hidden border-t border-zinc-800 bg-zinc-900/60 px-3">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Go to start (Home)"
          onClick={() => playbackRef.current?.seek(0)}
        >
          <SkipBack className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Previous frame (←)"
          onClick={() => playbackRef.current?.stepFrames(-1)}
        >
          <ChevronLeft className="size-4" />
        </Button>
        <Button
          variant="default"
          size="icon"
          aria-label={playing ? 'Pause (Space)' : 'Play (Space)'}
          data-testid="play-pause"
          onClick={() => playbackRef.current?.toggle()}
          disabled={isEmpty}
          className="mx-1"
        >
          {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Next frame (→)"
          onClick={() => playbackRef.current?.stepFrames(1)}
        >
          <ChevronRight className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Go to end (End)"
          onClick={() => playbackRef.current?.seek(duration)}
        >
          <SkipForward className="size-4" />
        </Button>

        <div
          className="ml-3 whitespace-nowrap font-mono text-xs text-zinc-300"
          data-testid="time-display"
        >
          {formatTransportTime(playhead)}{' '}
          <span className="hidden text-zinc-500 @lg:inline">/ {formatTransportTime(duration)}</span>
        </div>

        <div className="ml-4 hidden items-center gap-2 @lg:flex">
          <Volume2 className="size-4 text-zinc-400" aria-hidden="true" />
          <NamedSlider
            aria-label="Master volume"
            value={[volume]}
            min={0}
            max={1}
            step={0.05}
            onValueChange={([v]) => setVolume(v)}
            className="w-24"
          />
        </div>
      </div>
    </section>
  )
}
