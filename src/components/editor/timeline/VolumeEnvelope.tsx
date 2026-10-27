'use client'

import { useEffect, useMemo, useRef, useState } from 'react'

import { findClip } from '@/lib/editor/factories'
import { currentTransientToken, useEditorStore } from '@/lib/editor/store'
import { frameToTime } from '@/lib/editor/time'
import {
  addVolumeKeyframe,
  clampVolumeTime,
  dbToGain,
  formatDb,
  gainToDb,
  gainToUnit,
  moveVolumeKeyframe,
  removeVolumeKeyframe,
  sampleVolumeCurve,
  unitToGain,
  DB_CEIL,
  DB_FLOOR,
} from '@/lib/editor/volume-automation'
import type { Clip, Keyframe } from '@/lib/editor/types'
import { cn } from '@/lib/utils'

/** The trim handles are 8px wide; the envelope's plot starts clear of them. */
const TRIM_INSET = 8
/** Screen-space movement before a press becomes a drag. */
const DRAG_THRESHOLD_PX = 3
/** The visible dot is 6px inside a 12px hit target. */
const DOT_HIT = 12
/** Cap the sampled path: about one point every 2px, never more. */
const MAX_SAMPLES = 600

/**
 * The on-clip volume envelope: a white dB curve with draggable dots over an
 * audio-bearing clip. It is a presentation layer over `clip.keyframes.volume`;
 * the stored values stay linear and every edit goes through the normal
 * `setClipKeyframes` command (one undo entry per drag, add or remove).
 *
 * Pointer layering is deliberate. The root, plot box and SVG are
 * `pointer-events-none`, so an empty click still selects/drags the clip. Only
 * the dots and the 10px line hit path opt into pointer events. The dots sit
 * below the clip label and the z-10 trim handles, so a trim always wins an
 * overlap. With the razor active the whole envelope is inert.
 */
export function VolumeEnvelope({
  clip,
  widthPx,
  height,
  selected,
  razorActive,
}: {
  clip: Clip
  widthPx: number
  height: number
  /** Selected clips show a flat line even before a curve exists. */
  selected: boolean
  /** Razor tool: the envelope must not intercept the cut. */
  razorActive: boolean
}) {
  const apply = useEditorStore((s) => s.apply)
  const [hud, setHud] = useState<{ gain: number } | null>(null)
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
      if (ownsTransientRef.current) {
        ownsTransientRef.current = false
        useEditorStore.getState().cancelTransient()
      }
    },
    [],
  )

  const keyframes = clip.keyframes?.volume ?? []
  const hasCurve = keyframes.length > 0
  const duration = Math.max(1e-6, clip.duration)
  const plotTop = Math.min(14, Math.max(10, height * 0.34))
  const sampleCount = Math.max(
    2,
    Math.min(MAX_SAMPLES, Math.round(Math.max(0, widthPx - TRIM_INSET * 2) / 2)),
  )
  const samples = useMemo(
    () => sampleVolumeCurve(clip, sampleCount),
    // The clip object changes whenever its keyframes do, which is exactly when
    // the curve needs resampling.
    [clip, sampleCount],
  )

  if (!hasCurve && !selected) return null

  const fmt = (n: number) => n.toFixed(3)
  const path = samples
    .map((sample, index) => {
      const x = (sample.time / duration) * 100
      const y = 100 - sample.unit * 100
      return `${index === 0 ? 'M' : 'L'} ${fmt(x)},${fmt(y)}`
    })
    .join(' ')

  /** Apply one command for this clip's volume curve. */
  const writeCurve = (keyframesNext: Keyframe[]) => {
    apply({
      type: 'setClipKeyframes',
      clipId: clip.id,
      property: 'volume',
      keyframes: keyframesNext,
    })
  }

  /**
   * The live clip and its curve. An absent curve is an EMPTY array, not a
   * reason to bail: double-clicking a static clip must be able to seed the
   * very first point.
   */
  const liveCurve = () => {
    const live = useEditorStore.getState()
    const clipNow = findClip(live.doc, clip.id)?.clip
    if (!clipNow) return undefined
    return { live, clipNow, curve: clipNow.keyframes?.volume ?? [] }
  }

  /** Remove a point by index, clamped against the LIVE array. */
  const removeAt = (index: number) => {
    const found = liveCurve()
    if (!found) return
    if (index < 0 || index >= found.curve.length) return
    writeCurve(removeVolumeKeyframe(found.clipNow, index))
  }

  const addAt = (clientX: number) => {
    const rect = plotRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0) return
    const found = liveCurve()
    if (!found) return
    const time = clampVolumeTime(
      found.clipNow,
      ((clientX - rect.left) / rect.width) * found.clipNow.duration,
    )
    writeCurve(addVolumeKeyframe(found.clipNow, time))
  }

  /**
   * One dot gesture. The transient does not begin until the pointer crosses
   * 3px, so a plain press/release is a click that writes nothing. Alt-press
   * only ARMS removal on pointerdown: it removes on pointerup while still
   * under the threshold, and a threshold crossing neither removes nor drags.
   */
  const beginDotGesture = (e: React.PointerEvent, index: number) => {
    if (razorActive || e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    // A second pointerdown abandons the still-live gesture first: detach it
    // and roll its transient back, rather than folding two drags into one undo.
    detachRef.current?.()
    if (ownsTransientRef.current) {
      ownsTransientRef.current = false
      useEditorStore.getState().cancelTransient()
    }

    const startKey = keyframes[index]
    if (!startKey) return
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
      detachRef.current = null
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
      const time = clampVolumeTime(
        found.clipNow,
        ((ev.clientX - rect.left) / rect.width) * found.clipNow.duration,
      )
      const unit = Math.min(1, Math.max(0, 1 - (ev.clientY - rect.top) / rect.height))
      const gain = unitToGain(unit)
      // The stored array re-sorts the moment the grabbed point crosses a
      // neighbour, so the captured index stops naming it. Find it by the time
      // it last wrote, exactly like the Effect Controls graph.
      const target =
        found.curve[index]?.time === dragTime
          ? index
          : found.curve.findIndex((k) => k.time === dragTime)
      if (target < 0) return
      dragTime = time
      // A zero-size write is still one transient frame; the command layer
      // accepts the clamped array. One commit on release = one undo entry.
      found.live.applyTransient({
        type: 'setClipKeyframes',
        clipId: clip.id,
        property: 'volume',
        keyframes: moveVolumeKeyframe(found.clipNow, target, time, gain),
      })
      setHud({ gain })
    }

    function onUp(ev: PointerEvent) {
      if (ev.pointerId !== pointerId) return
      detach()
      if (altRemove) {
        if (!moved) {
          const found = liveCurve()
          if (found) {
            let target = found.curve.findIndex((k) => k.time === removeTime)
            if (target < 0) target = index
            removeAt(target)
          }
        }
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
  }

  const onDotKeyDown = (e: React.KeyboardEvent, index: number) => {
    if (razorActive) return
    const key = e.key
    if (key === 'Delete' || key === 'Backspace') {
      e.preventDefault()
      e.stopPropagation()
      const found = liveCurve()
      if (!found) return
      const current = found.curve[index]
      if (!current) return
      // The point under the focused dot is the live array's point at that
      // index: a crossing nudge re-sorts the array, and the DOM index follows
      // the sorted order the user sees.
      removeAt(index)
      return
    }
    if (key !== 'ArrowLeft' && key !== 'ArrowRight' && key !== 'ArrowUp' && key !== 'ArrowDown') {
      return
    }
    e.preventDefault()
    e.stopPropagation()
    const found = liveCurve()
    if (!found) return
    const current = found.curve[index]
    if (!current) return
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      const step = frameToTime(1, found.live.doc.project.fps) * (key === 'ArrowRight' ? 1 : -1)
      writeCurve(moveVolumeKeyframe(found.clipNow, index, current.time + step, current.value))
      return
    }
    // Up/down changes the gain by 0.5 dB. Silence has no finite dB: Up starts
    // just above the display floor, Down stays at true zero.
    const currentDb = gainToDb(current.value)
    const nextDb =
      currentDb === -Infinity
        ? key === 'ArrowUp'
          ? DB_FLOOR + 0.5
          : -Infinity
        : currentDb + (key === 'ArrowUp' ? 0.5 : -0.5)
    const nextGain = nextDb === -Infinity || nextDb <= DB_FLOOR ? 0 : dbToGain(nextDb)
    writeCurve(moveVolumeKeyframe(found.clipNow, index, current.time, nextGain))
  }

  return (
    <div
      data-testid="volume-envelope"
      className={cn(
        'pointer-events-none absolute inset-0',
        // A muted clip keeps its automation visible; unmuting must reveal it
        // unchanged, so dim it instead of hiding the data.
        clip.muted && 'opacity-50',
      )}
    >
      <div
        ref={plotRef}
        data-testid="volume-envelope-plot"
        className="pointer-events-none absolute"
        style={{ left: TRIM_INSET, right: TRIM_INSET, top: plotTop, bottom: 3 }}
      >
        <svg
          className="pointer-events-none absolute inset-0 size-full"
          aria-hidden="true"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
        >
          <path
            data-testid="volume-envelope-curve"
            d={path}
            fill="none"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
            className="stroke-white/90"
          />
          {/* Transparent 10px hit path: double-click adds a point. A single
              press is captured so it does not start a clip move. */}
          <path
            data-testid="volume-envelope-hit"
            d={path}
            fill="none"
            stroke="transparent"
            strokeWidth={10}
            vectorEffect="non-scaling-stroke"
            style={{ pointerEvents: razorActive ? 'none' : 'stroke' }}
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              addAt(e.clientX)
            }}
          />
        </svg>
        {keyframes.map((k, i) => {
          const left = (Math.min(Math.max(0, k.time), duration) / duration) * 100
          const bottom = gainToUnit(k.value) * 100
          const db = gainToDb(k.value)
          return (
            <div
              // Index key: a time-bearing key would remount the focused dot on
              // every nudge/drag frame and drop keyboard focus mid-use.
              key={i}
              data-testid={`volume-dot-${i}`}
              role="slider"
              tabIndex={razorActive ? -1 : 0}
              aria-label={`Volume keyframe ${i + 1}`}
              aria-valuemin={DB_FLOOR}
              aria-valuemax={DB_CEIL}
              aria-valuenow={Number.isFinite(db) ? Number(db.toFixed(1)) : DB_FLOOR}
              aria-valuetext={`${formatDb(k.value)} at ${k.time.toFixed(2)} seconds`}
              className={cn(
                'absolute z-[1] flex -translate-x-1/2 translate-y-1/2 items-center justify-center rounded-full',
                razorActive
                  ? 'pointer-events-none'
                  : 'pointer-events-auto cursor-ns-resize focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none',
              )}
              style={{ left: `${left}%`, bottom: `${bottom}%`, width: DOT_HIT, height: DOT_HIT }}
              onPointerDown={razorActive ? undefined : (e) => beginDotGesture(e, i)}
              onKeyDown={razorActive ? undefined : (e) => onDotKeyDown(e, i)}
            >
              <span aria-hidden="true" className="block size-1.5 rounded-full bg-white shadow-sm" />
            </div>
          )
        })}
      </div>
      {hud && (
        <div
          data-testid="volume-envelope-hud"
          className="pointer-events-none absolute top-0.5 right-1 rounded bg-black/70 px-1 text-[9px] tabular-nums text-white"
        >
          {formatDb(hud.gain)}
        </div>
      )}
    </div>
  )
}
