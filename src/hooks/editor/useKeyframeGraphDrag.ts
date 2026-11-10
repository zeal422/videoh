'use client'

import { useEffect, useRef, useState, type RefObject } from 'react'

import { KEYFRAME_PROPERTY_BOUNDS } from '@/lib/editor/constants'
import { findClip } from '@/lib/editor/factories'
import { dragKeyframeDot } from '@/lib/editor/keyframe-graph-gesture'
import { currentTransientToken, useEditorStore } from '@/lib/editor/store'
import type { Keyframe, KeyframeProperty } from '@/lib/editor/types'

interface KeyframeGraphDragOptions {
  clipId: string
  property: KeyframeProperty
  duration: number
  mirrored: boolean
  scale: 'linear' | 'db'
  wrapRef: RefObject<HTMLDivElement | null>
}

interface DragState {
  index: number
  pointerId: number
  token: number
  startY: number
  startValue: number
}

/**
 * The keyframe graph's dot-drag gesture (0.20.0): owns the pointer id, the
 * transient token, the grabbed dot's last time, and the window listeners.
 * The pure `keyframe-graph-gesture.ts` owns the math; the panel keeps the
 * rendering and keyboard nudging.
 */
export function useKeyframeGraphDrag({
  clipId,
  property,
  duration,
  mirrored,
  scale,
  wrapRef,
}: KeyframeGraphDragOptions) {
  const [drag, setDrag] = useState<DragState | null>(null)
  // The grabbed keyframe's current time. The store re-sorts the array the
  // moment a crossing frame lands, so the index captured at pointerdown stops
  // naming the grabbed keyframe: the drag looks it up by the time it last wrote.
  const dragTimeRef = useRef(0)

  const beginDrag = (
    index: number,
    keyframe: Keyframe,
    pointer: { pointerId: number; clientY: number },
  ) => {
    const token = useEditorStore.getState().beginTransient(pointer.pointerId)
    dragTimeRef.current = keyframe.time
    setDrag({
      index,
      pointerId: pointer.pointerId,
      token,
      startY: pointer.clientY,
      startValue: keyframe.value,
    })
  }

  useEffect(() => {
    if (!drag) return
    const onMove = (e: PointerEvent) => {
      // Only the initiating pointer drives the drag (multi-touch).
      if (e.pointerId !== drag.pointerId) return
      if (currentTransientToken() !== drag.token) return
      const rect = wrapRef.current?.getBoundingClientRect()
      if (!rect || rect.width <= 0 || rect.height <= 0) return
      const live = useEditorStore.getState().doc
      const kfs = findClip(live, clipId)?.clip.keyframes?.[property]
      if (!kfs || kfs.length === 0) return
      // Find the grabbed keyframe again: after it passes a neighbour the stored
      // array is sorted. The captured index wins while it still matches (two
      // keyframes may legally share a time, e.g. both clamped to a clip end).
      const target =
        kfs[drag.index]?.time === dragTimeRef.current
          ? drag.index
          : kfs.findIndex((k) => k.time === dragTimeRef.current)
      if (target < 0) return

      const next = dragKeyframeDot({
        rect: { left: rect.left, width: rect.width, height: rect.height },
        clientX: e.clientX,
        clientY: e.clientY,
        start: { y: drag.startY, value: drag.startValue },
        duration,
        property,
        bounds: KEYFRAME_PROPERTY_BOUNDS[property],
        scale,
        mirrored,
      })
      dragTimeRef.current = next.time
      useEditorStore.getState().applyTransient({
        type: 'setClipKeyframes',
        clipId,
        property,
        keyframes: kfs.map((k, i) => (i === target ? { ...k, ...next } : k)),
      })
    }
    const onUp = (e: PointerEvent) => {
      // Only the initiating pointer ends this drag (multi-touch): a second
      // pointer lifting anywhere would otherwise commit a drag it does not own.
      // Capture phase, so this keeps the first word over the shell's
      // dangling-commit net.
      if (e.pointerId !== drag.pointerId) return
      try {
        try {
          useEditorStore.getState().commitTransient()
        } catch {
          useEditorStore.getState().cancelTransient()
        }
      } finally {
        setDrag(null)
      }
    }
    const onCancel = (e: PointerEvent) => {
      if (e.pointerId !== drag.pointerId) return
      // The browser took the pointer (touch pan, native drag): discard the drag
      // rather than leaving its transient live, which would block autosave.
      try {
        useEditorStore.getState().cancelTransient()
      } finally {
        setDrag(null)
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onCancel, true)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('pointercancel', onCancel, true)
    }
  }, [drag, clipId, property, duration, mirrored, scale, wrapRef])

  return { beginDrag }
}
