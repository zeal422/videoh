'use client'

import { useEffect, useMemo, useRef, useState } from 'react'

import { findClip } from '@/lib/editor/factories'
import { keyframeDefaultEasing } from '@/lib/editor/keyframes'
import {
  addKeyframeAt,
  automationKeyframes,
  automationUnitForValue,
  automationValueAt,
  automationValueForUnit,
  clampAutomationTime,
  formatAutomationValue,
  nudgeKeyframe,
  removeKeyframeAt,
  sampleAutomationCurve,
  type AutomationProperty,
} from '@/lib/editor/pen'
import { currentTransientToken, useEditorStore } from '@/lib/editor/store'
import { frameToTime } from '@/lib/editor/time'
import { lockedTrackForClip, trackLockMessage } from '@/lib/editor/tracks'
import { dbToGain, gainToDb, DB_CEIL, DB_FLOOR } from '@/lib/editor/volume-automation'
import type { Clip, Keyframe } from '@/lib/editor/types'
import { toast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'

/** The trim handles are 8px wide; the envelope's plot starts clear of them. */
const TRIM_INSET = 8
/** Screen-space movement before a press becomes a drag. */
const DRAG_THRESHOLD_PX = 3
/** The visible dot is 6px inside a 12px hit target. */
const DOT_HIT = 12
/** Cap the sampled path: about one point every 2px, never more. */
const MAX_SAMPLES = 600
/** One press of Up/Down on an opacity dot. */
const OPACITY_KEY_STEP = 0.05

/**
 * The on-clip automation envelope: a white curve with draggable dots over a
 * clip. It renders ONE property per instance, volume (dB domain) or opacity
 * (0..1), and is a presentation layer over `clip.keyframes[property]`. Every
 * edit goes through the normal `setClipKeyframes` command (one undo entry per
 * drag, add or remove).
 *
 * The Pen makes this curve its editing target: a selected clip shows a flat
 * line even before the first point, a single click on the line adds a point,
 * and the line cursor is a crosshair. With the select tool, volume keeps the
 * direct behavior (double-click adds); opacity is display-only unless
 * the Pen owns it. A solo video under the Pen keeps opacity as its Pen curve,
 * while its volume envelope stays directly draggable through its dots: that
 * second instance sets `dotsOnly`, which leaves the line to the Pen curve.
 *
 * Pointer layering is deliberate. The root, plot box and SVG are
 * `pointer-events-none`, so an empty click still selects/drags the clip. Only
 * the dots and the 10px line hit path opt into pointer events. The dots sit
 * below the clip label and the z-10 trim handles, so a trim always wins an
 * overlap. With razor, ripple, or slip active the whole envelope is inert.
 */
export function AutomationEnvelope({
  clip,
  property,
  widthPx,
  height,
  selected,
  inert = false,
  penTarget = false,
  dotsOnly = false,
}: {
  clip: Clip
  property: AutomationProperty
  widthPx: number
  height: number
  /** Selected clips show a flat line before a volume curve exists. */
  selected: boolean
  /** A modal edit tool other than the Pen is active. */
  inert?: boolean
  /** The Pen owns this clip's property: single-click add and a crosshair. */
  penTarget?: boolean
  /** Keep the dots live but leave the line to the Pen's own curve. */
  dotsOnly?: boolean
}) {
  const apply = useEditorStore((s) => s.apply)
  const [hud, setHud] = useState<{ value: number } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<HTMLDivElement>(null)
  const detachRef = useRef<(() => void) | null>(null)
  const ownsTransientRef = useRef(false)

  // A mid-drag unmount (the clip was deleted by a shortcut, or its lane
  // remounted) must cancel this gesture's transient, not leave it live: an
  // abandoned transient blocks autosave and folds later edits into a snapshot
  // no undo can reach. Only cancel a gesture THIS component owns.
  useEffect(
    () => () => {
      detachRef.current?.()
      // A pending press owns the tool keys even before a transient starts; an
      // unmount must release that marker with the gesture.
      rootRef.current?.removeAttribute('data-automation-gesture')
      if (ownsTransientRef.current) {
        ownsTransientRef.current = false
        useEditorStore.getState().cancelTransient()
      }
    },
    [],
  )

  const isVolume = property === 'volume'
  const prefix = isVolume ? 'volume-envelope' : 'opacity-envelope'
  const dotPrefix = isVolume ? 'volume-dot' : 'opacity-dot'
  const keyframes = automationKeyframes(clip, property)
  const hasCurve = keyframes.length > 0
  const duration = Math.max(1e-6, clip.duration)
  const plotTop = Math.min(14, Math.max(10, height * 0.34))
  const sampleCount = Math.max(
    2,
    Math.min(MAX_SAMPLES, Math.round(Math.max(0, widthPx - TRIM_INSET * 2) / 2)),
  )
  const samples = useMemo(
    () => sampleAutomationCurve(clip, property, sampleCount),
    // The clip object changes whenever its keyframes do, which is exactly when
    // the curve needs resampling.
    [clip, property, sampleCount],
  )

  // Volume is directly editable; opacity is editable only while the
  // Pen owns it, so an idle video shows its existing curve without handles.
  const editable = !inert && (isVolume || penTarget)
  const penEditing = editable && penTarget
  const directEditing = editable && isVolume && !penEditing
  const lineInteractive = (penEditing || directEditing) && !dotsOnly

  // Volume keeps its rule (a selected clip shows a flat line); opacity
  // shows a flat line only while the Pen owns it, so an idle video selection
  // does not grow a second line. A dots-only volume overlay (a solo video
  // under the Pen) exists only for its points.
  if (dotsOnly && !hasCurve) return null
  if (!hasCurve && !(isVolume ? selected : penTarget)) return null

  const fmt = (n: number) => n.toFixed(3)
  const path = samples
    .map((sample, index) => {
      const x = (sample.time / duration) * 100
      const y = 100 - sample.unit * 100
      return `${index === 0 ? 'M' : 'L'} ${fmt(x)},${fmt(y)}`
    })
    .join(' ')

  /** Apply one command for this clip's curve. */
  const writeCurve = (keyframesNext: Keyframe[]) => {
    apply({
      type: 'setClipKeyframes',
      clipId: clip.id,
      property,
      keyframes: keyframesNext,
    })
  }

  /**
   * Lock gate (0.14.0): every envelope edit (dot drag, double-click add,
   * Alt-click remove, keyboard nudge or delete) is a clip edit, so a locked
   * lane refuses it before anything is written. The command layer enforces the
   * same rule; this only supplies the early message and stops the gesture.
   */
  const refuseIfLocked = (): boolean => {
    // The envelope writes only THIS clip's curve, so its own lane is the lock
    // that matters; a locked partner lane blocks group geometry (move/trim/
    // split), not this clip's automation.
    const locked = lockedTrackForClip(useEditorStore.getState().doc, clip.id)
    if (!locked) return false
    toast({
      title: 'Track locked',
      description: trackLockMessage(locked),
      variant: 'destructive',
    })
    return true
  }

  /**
   * The live clip and its curve. An absent curve is an EMPTY array, not a
   * reason to bail: clicking a static clip must be able to seed the very
   * first point.
   */
  const liveCurve = () => {
    const live = useEditorStore.getState()
    const clipNow = findClip(live.doc, clip.id)?.clip
    if (!clipNow) return undefined
    return { live, clipNow, curve: automationKeyframes(clipNow, property) }
  }

  /** Remove a point by its curve time, clamped against the LIVE array. */
  const removeAtTime = (time: number) => {
    const found = liveCurve()
    if (!found) return
    writeCurve(removeKeyframeAt(found.clipNow, property, time, found.live.doc.project.fps))
  }

  const addAt = (clientX: number) => {
    if (refuseIfLocked()) return
    const rect = plotRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0) return
    const found = liveCurve()
    if (!found) return
    const local = ((clientX - rect.left) / rect.width) * Math.max(0, found.clipNow.duration)
    const value = automationValueAt(found.clipNow, property, local)
    const easing = keyframeDefaultEasing(found.live.doc.project.keyframeDefaults, property)
    writeCurve(
      addKeyframeAt(found.clipNow, property, local, value, found.live.doc.project.fps, easing),
    )
  }

  /**
   * One dot gesture. The transient does not begin until the pointer crosses
   * 3px, so a plain press/release is a click that writes nothing. Alt-press
   * only ARMS removal on pointerdown: it removes on pointerup while still
   * under the threshold, and a threshold crossing neither removes nor drags.
   */
  const beginDotGesture = (e: React.PointerEvent, index: number) => {
    if (!editable || e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    if (refuseIfLocked()) return
    // A second pointerdown abandons the still-live gesture first: detach it
    // and roll its transient back, rather than folding two drags into one undo.
    detachRef.current?.()
    if (ownsTransientRef.current) {
      ownsTransientRef.current = false
      useEditorStore.getState().cancelTransient()
    }

    const startKey = keyframes[index]
    if (!startKey) return
    // The tool keys read this marker: a pending press or Alt-click is a live
    // gesture even though no transient starts until the 3px threshold.
    rootRef.current?.setAttribute('data-automation-gesture', 'true')
    const pointerId = e.pointerId
    const startX = e.clientX
    const startY = e.clientY
    const altRemove = e.altKey
    const removeTime = startKey.time
    let dragTime = startKey.time
    let moved = false
    let began = false
    let token = -1
    ;(e.currentTarget as HTMLElement).focus()

    function detach() {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('pointercancel', onCancel, true)
      window.removeEventListener('blur', onBlur)
      detachRef.current = null
      rootRef.current?.removeAttribute('data-automation-gesture')
    }

    // A window blur loses the pointer. The editor shell's dangling-gesture net
    // commits a live transient; this clears the pending-press marker and closes
    // the gesture's own listeners so a stuck marker cannot hold the tool keys.
    function onBlur() {
      detach()
      if (began) {
        const live = useEditorStore.getState()
        try {
          live.commitTransient()
        } catch {
          live.cancelTransient()
        }
      }
      ownsTransientRef.current = false
      setHud(null)
    }

    function onMove(ev: PointerEvent) {
      if (ev.pointerId !== pointerId) return
      if (
        !moved &&
        Math.abs(ev.clientX - startX) < DRAG_THRESHOLD_PX &&
        Math.abs(ev.clientY - startY) < DRAG_THRESHOLD_PX
      ) {
        return
      }
      moved = true
      // An Alt-press that moves is neither a removal nor a drag.
      if (altRemove) return
      if (!began) {
        began = true
        ownsTransientRef.current = true
        token = useEditorStore.getState().beginTransient(pointerId)
      }
      if (currentTransientToken() !== token) return
      const rect = plotRef.current?.getBoundingClientRect()
      if (!rect || rect.width <= 0 || rect.height <= 0) return
      const found = liveCurve()
      if (!found) return
      const time = Math.min(
        Math.max(0, ((ev.clientX - rect.left) / rect.width) * found.clipNow.duration),
        Math.max(0, found.clipNow.duration),
      )
      const unit = Math.min(1, Math.max(0, 1 - (ev.clientY - rect.top) / rect.height))
      const value = automationValueForUnit(property, unit)
      // The stored array re-sorts the moment the grabbed point crosses a
      // neighbour, so the captured index stops naming it. Find it by the time
      // it last wrote, exactly like the Effect Controls graph.
      const target =
        found.curve[index]?.time === dragTime
          ? index
          : found.curve.findIndex((k) => k.time === dragTime)
      if (target < 0) return
      const current = found.curve[target]
      if (!current) return
      // nudgeKeyframe writes clampAutomationTime(current.time + delta), NOT the
      // raw pointer time: `a + (b - a)` can differ from `b` by one ULP, and the
      // next frame's exact lookup would then miss the grabbed point and freeze
      // the drag. Track the exact value the nudge writes. setClipKeyframes
      // preserves times (it only filters non-finite values and sorts), so no
      // read-back is needed.
      const delta = time - current.time
      const nextTime = clampAutomationTime(found.clipNow, current.time + delta)
      // A zero-size write is still one transient frame; the command layer
      // accepts the clamped array. One commit on release = one undo entry.
      found.live.applyTransient({
        type: 'setClipKeyframes',
        clipId: clip.id,
        property,
        keyframes: nudgeKeyframe(found.clipNow, property, target, delta, value - current.value),
      })
      dragTime = nextTime
      setHud({ value })
    }

    function onUp(ev: PointerEvent) {
      if (ev.pointerId !== pointerId) return
      detach()
      if (altRemove) {
        if (!moved) removeAtTime(removeTime)
      } else if (began) {
        const live = useEditorStore.getState()
        try {
          live.commitTransient()
        } catch {
          live.cancelTransient()
        }
      }
      ownsTransientRef.current = false
      setHud(null)
    }

    function onCancel(ev: PointerEvent) {
      if (ev.pointerId !== pointerId) return
      detach()
      if (began) {
        ownsTransientRef.current = false
        useEditorStore.getState().cancelTransient()
      }
      setHud(null)
    }

    detachRef.current = detach
    window.addEventListener('pointermove', onMove)
    // Capture phase, so a gesture end gets the first word over the shell's
    // dangling-commit net (the marker and clip gestures do the same).
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onCancel, true)
    window.addEventListener('blur', onBlur)
  }

  const onDotKeyDown = (e: React.KeyboardEvent, index: number) => {
    if (!editable) return
    const key = e.key
    if (key === 'Delete' || key === 'Backspace') {
      e.preventDefault()
      e.stopPropagation()
      if (refuseIfLocked()) return
      const found = liveCurve()
      const current = found?.curve[index]
      if (!found || !current) return
      // The point under the focused dot is the live array's point at that
      // index: a crossing nudge re-sorts the array, and the DOM index follows
      // the sorted order the user sees.
      writeCurve(
        removeKeyframeAt(found.clipNow, property, current.time, found.live.doc.project.fps),
      )
      return
    }
    if (key !== 'ArrowLeft' && key !== 'ArrowRight' && key !== 'ArrowUp' && key !== 'ArrowDown') {
      return
    }
    e.preventDefault()
    e.stopPropagation()
    if (refuseIfLocked()) return
    const found = liveCurve()
    const current = found?.curve[index]
    if (!found || !current) return
    const fps = found.live.doc.project.fps
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      const step = frameToTime(1, fps) * (key === 'ArrowRight' ? 1 : -1)
      writeCurve(nudgeKeyframe(found.clipNow, property, index, step, 0))
      return
    }
    // Up/down changes volume by 0.5 dB (silence has no finite dB: Up starts
    // just above the display floor, Down stays at true zero) and opacity by 5%.
    let valueDelta: number
    if (isVolume) {
      const currentDb = gainToDb(current.value)
      const nextDb =
        currentDb === -Infinity
          ? key === 'ArrowUp'
            ? DB_FLOOR + 0.5
            : -Infinity
          : currentDb + (key === 'ArrowUp' ? 0.5 : -0.5)
      const nextGain = nextDb === -Infinity || nextDb <= DB_FLOOR ? 0 : dbToGain(nextDb)
      valueDelta = nextGain - current.value
    } else {
      valueDelta = key === 'ArrowUp' ? OPACITY_KEY_STEP : -OPACITY_KEY_STEP
    }
    writeCurve(nudgeKeyframe(found.clipNow, property, index, 0, valueDelta))
  }

  const valueText = (value: number, time: number) =>
    `${formatAutomationValue(property, value)} at ${time.toFixed(2)} seconds`

  return (
    <div
      ref={rootRef}
      data-testid={prefix}
      className={cn(
        'pointer-events-none absolute inset-0',
        // A muted clip keeps its automation visible; unmuting must reveal it
        // unchanged, so dim it instead of hiding the data. Opacity is not an
        // audio property and never dims on mute.
        isVolume && clip.muted && 'opacity-50',
      )}
    >
      <div
        ref={plotRef}
        data-testid={`${prefix}-plot`}
        className="pointer-events-none absolute"
        style={{ left: TRIM_INSET, right: TRIM_INSET, top: plotTop, bottom: 3 }}
      >
        <svg
          className="pointer-events-none absolute inset-0 size-full"
          aria-hidden="true"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
        >
          {!dotsOnly && (
            <path
              data-testid={`${prefix}-curve`}
              d={path}
              fill="none"
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              className="stroke-white/90"
            />
          )}
          {/* Transparent 10px hit path: a single click adds a point under the
              Pen; double-click adds under the select tool. A press is captured
              so it does not start a clip move. */}
          <path
            data-testid={`${prefix}-hit`}
            d={path}
            fill="none"
            stroke="transparent"
            strokeWidth={10}
            vectorEffect="non-scaling-stroke"
            style={{
              pointerEvents: lineInteractive ? 'stroke' : 'none',
              cursor: penEditing ? 'crosshair' : undefined,
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              if (!penEditing) return
              e.preventDefault()
              e.stopPropagation()
              // A double-click fires two click events. The first adds the
              // point; the second would replace it and push a history entry
              // with no visible change.
              if (e.detail > 1) return
              addAt(e.clientX)
            }}
            onDoubleClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              if (directEditing) addAt(e.clientX)
            }}
          />
        </svg>
        {keyframes.map((k, i) => {
          const left = (Math.min(Math.max(0, k.time), duration) / duration) * 100
          // Volume plots through the dB domain; opacity plots 0..1 directly.
          const unit = automationUnitForValue(property, k.value)
          const db = gainToDb(k.value)
          const ariaMin = isVolume ? DB_FLOOR : 0
          const ariaMax = isVolume ? DB_CEIL : 1
          const ariaValue = isVolume
            ? Number.isFinite(db)
              ? Number(db.toFixed(1))
              : DB_FLOOR
            : Number(k.value.toFixed(2))
          return (
            <div
              // Index key: a time-bearing key would remount the focused dot on
              // every nudge/drag frame and drop keyboard focus mid-use.
              key={i}
              data-testid={`${dotPrefix}-${i}`}
              role="slider"
              tabIndex={editable ? 0 : -1}
              aria-label={`${isVolume ? 'Volume' : 'Opacity'} keyframe ${i + 1}`}
              aria-valuemin={ariaMin}
              aria-valuemax={ariaMax}
              aria-valuenow={ariaValue}
              aria-valuetext={valueText(k.value, k.time)}
              aria-disabled={editable ? undefined : true}
              className={cn(
                'absolute z-[1] flex -translate-x-1/2 translate-y-1/2 items-center justify-center rounded-full',
                editable
                  ? 'pointer-events-auto cursor-ns-resize focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none'
                  : 'pointer-events-none',
              )}
              style={{
                left: `${left}%`,
                bottom: `${unit * 100}%`,
                width: DOT_HIT,
                height: DOT_HIT,
              }}
              onPointerDown={editable ? (e) => beginDotGesture(e, i) : undefined}
              onKeyDown={editable ? (e) => onDotKeyDown(e, i) : undefined}
            >
              <span aria-hidden="true" className="block size-1.5 rounded-full bg-white shadow-sm" />
            </div>
          )
        })}
      </div>
      {hud && (
        <div
          data-testid={`${prefix}-hud`}
          className="pointer-events-none absolute top-0.5 right-1 rounded bg-black/70 px-1 text-[9px] tabular-nums text-white"
        >
          {formatAutomationValue(property, hud.value)}
        </div>
      )}
    </div>
  )
}
