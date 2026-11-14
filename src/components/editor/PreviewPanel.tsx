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
import { containRect } from '@/lib/editor/playback/compositor'
import { shapeBounds } from '@/lib/editor/shapes'
import { animatedValue, clampPropertyValue, keyframeDefaultEasing } from '@/lib/editor/keyframes'
import { withEasing } from '@/lib/editor/ease-segment'
import {
  angleDelta,
  angleFromCenter,
  gizmoQuad,
  IDENTITY_TRANSFORM,
  pointerProjectPoint,
  rotationHandleInBounds,
  scaleFromDrag,
  type ClipTransform,
  type Point,
  type Rect,
} from '@/lib/editor/transform'
import { ROTATION_MAX, ROTATION_MIN, SCALE_MAX, SCALE_MIN } from '@/lib/editor/constants'
import { currentTransientToken, useEditorStore } from '@/lib/editor/store'
import { lockedTrackForClip, trackLockMessage } from '@/lib/editor/tracks'
import { toast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import { ScopesPanel } from './ScopesPanel'
import { TransformGizmo, type GizmoMode } from './TransformGizmo'
import type { EditorCommand } from '@/lib/editor/commands'

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
  const dragOrigin = useRef<{ px: number; py: number; x: number; y: number; scale: number } | null>(
    null,
  )
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
  const gizmoBase: Rect | null = (() => {
    if (!gizmoClip) return null
    const { width, height } = doc.project
    if (gizmoClip.shape) {
      // The generated path bounds are the selection and transform box: a star
      // or triangle does not fill the frame the way media does.
      return shapeBounds(gizmoClip.shape, width, height)
    }
    if (gizmoClip.text !== undefined) {
      const box = measureTextBox(gizmoClip, width, height)
      return box
        ? { x0: box.x0 * width, y0: box.y0 * height, x1: box.x1 * width, y1: box.y1 * height }
        : null
    }
    if (gizmoClip.sequenceId) return { x0: 0, y0: 0, x1: width, y1: height }
    const asset = findMedia(doc, gizmoClip.mediaId)
    if (asset && asset.width > 0 && asset.height > 0) {
      const rect = containRect(asset.width, asset.height, width, height, null)
      if (rect) {
        return { x0: rect.dx, y0: rect.dy, x1: rect.dx + rect.dw, y1: rect.dy + rect.dh }
      }
    }
    // Offline or unmeasured source: the frame is still a usable move box.
    return { x0: 0, y0: 0, x1: width, y1: height }
  })()
  const gizmoTransform: ClipTransform | null =
    gizmoClip && gizmoBase
      ? (clipTransform(gizmoClip, playhead - gizmoClip.start) ?? IDENTITY_TRANSFORM)
      : null
  const gizmo =
    gizmoClip && gizmoBase && gizmoTransform && !gizmoLocked
      ? (() => {
          const quad = gizmoQuad(gizmoBase, gizmoTransform, doc.project.width, doc.project.height)
          const distance = Math.max(28, Math.min(doc.project.width, doc.project.height) * 0.06)
          return {
            quad,
            handle: rotationHandleInBounds(quad, distance, doc.project.width, doc.project.height),
            // Project-pixel hit radius: CSS size cancels out of the pointer
            // mapping, so DPR and monitor letterboxing need no extra factor.
            hitRadius: Math.max(10, doc.project.width * 0.014),
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
    /**
     * Unwrapped rotation tracking: each move adds its shortest step to
     * `turned`, so crossing the half-turn opposite the grab point keeps
     * continuity (no 358-degree snap) and full revolutions add turns instead
     * of cancelling out. `lastAngle` is the previous frame's pointer angle.
     */
    lastAngle: number
    turned: number
    start: {
      posX: number
      posY: number
      scale: number
      rotation: number
      x: number
      y: number
    }
  }
  const gizmoDrag = useRef<GizmoDrag | null>(null)
  const [gizmoActive, setGizmoActive] = useState(false)

  const onGizmoPointerDown = (mode: GizmoMode, e: React.PointerEvent<SVGSVGElement>) => {
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
    const center = {
      x: (gizmo.quad[0].x + gizmo.quad[1].x + gizmo.quad[2].x + gizmo.quad[3].x) / 4,
      y: (gizmo.quad[0].y + gizmo.quad[1].y + gizmo.quad[2].y + gizmo.quad[3].y) / 4,
    }
    const local = live.playhead - found.clip.start
    const transform = clipTransform(found.clip, local) ?? IDENTITY_TRANSFORM
    gizmoDrag.current = {
      mode,
      pointerId: e.pointerId,
      token: live.beginTransient(e.pointerId),
      clipId: gizmoClip.id,
      at: local,
      center,
      startPoint: point,
      lastAngle: angleFromCenter(center, point),
      turned: 0,
      startDistance: Math.hypot(point.x - center.x, point.y - center.y),
      start: {
        posX: transform.posX,
        posY: transform.posY,
        scale: transform.scale,
        rotation: transform.rotation,
        x: found.clip.style?.x ?? 0.5,
        y: found.clip.style?.y ?? 0.5,
      },
    }
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
    if (drag.mode === 'move') {
      const dx = point.x - drag.startPoint.x
      const dy = point.y - drag.startPoint.y
      if (found.clip.text !== undefined) {
        // The style anchor moves through the positionedCenter contract: a
        // pointer delta in project pixels needs dividing by the captured scale,
        // or scaled text drifts faster than the pointer.
        const scale = drag.start.scale || 1
        store.applyTransient({
          type: 'setTextStyle',
          clipId: drag.clipId,
          style: {
            x: clamp01(drag.start.x + dx / store.doc.project.width / scale),
            y: clamp01(drag.start.y + dy / store.doc.project.height / scale),
          },
        })
        return
      }
      store.applyTransientBatch([
        gizmoCommand(drag, 'positionX', drag.start.posX + dx),
        gizmoCommand(drag, 'positionY', drag.start.posY + dy),
      ])
      return
    }
    if (drag.mode === 'scale') {
      const distance = Math.hypot(point.x - drag.center.x, point.y - drag.center.y)
      const scale = scaleFromDrag(
        drag.startDistance,
        distance,
        drag.start.scale,
        SCALE_MIN,
        SCALE_MAX,
      )
      store.applyTransient(gizmoCommand(drag, 'scale', scale))
      return
    }
    const angle = angleFromCenter(drag.center, point)
    // Successive shortest steps accumulate: crossing the half-turn cannot
    // snap, and circling the center adds real turns. Bounds still clamp.
    drag.turned += angleDelta(drag.lastAngle, angle)
    drag.lastAngle = angle
    const rotation = Math.min(
      ROTATION_MAX,
      Math.max(ROTATION_MIN, drag.start.rotation + drag.turned),
    )
    store.applyTransient(gizmoCommand(drag, 'rotation', rotation))
  }

  const endGizmoDrag = (commit: boolean, e?: React.PointerEvent<SVGSVGElement>) => {
    const drag = gizmoDrag.current
    if (!drag) return
    if (e && e.pointerId !== drag.pointerId) return
    gizmoDrag.current = null
    setGizmoActive(false)
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
    if (!gizmo && gizmoDrag.current) {
      gizmoDrag.current = null
      setGizmoActive(false)
    }
  })

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
    if (!canDragText || !textClip?.style || e.button !== 0) return
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
    dragOrigin.current = {
      px: e.clientX,
      py: e.clientY,
      x: textClip.style.x,
      y: textClip.style.y,
      // The style anchor moves through the positionedCenter contract, like the
      // gizmo text move below: divide the pointer delta by the captured scale.
      scale: clipTransform(textClip, store.playhead - textClip.start)?.scale ?? 1,
    }
    textDragToken.current = store.beginTransient(e.pointerId)
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
    const rect = canvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    // Client-pixel delta ÷ displayed canvas size = normalized project delta
    // (the monitor letterboxes to the project aspect, so this maps 1:1),
    // divided by the captured scale through the positionedCenter contract.
    const scale = origin.scale || 1
    const x = clamp01(origin.x + (e.clientX - origin.px) / rect.width / scale)
    const y = clamp01(origin.y + (e.clientY - origin.py) / rect.height / scale)
    useEditorStore.getState().applyTransient({
      type: 'setTextStyle',
      clipId: textClip!.id,
      style: { x, y },
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
    // Same ownership rule as the gizmo path: only the token owner commits or
    // cancels, so a stale release cannot finalize a replacement gesture.
    if (currentTransientToken() !== token) return
    const store = useEditorStore.getState()
    if (commit) store.commitTransient()
    else store.cancelTransient()
  }

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
            onPointerUp={(e) => endTextDrag(true, e)}
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
              hitRadius={gizmo.hitRadius}
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
