'use client'

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { ChevronDown, ChevronUp, Diamond, Plus } from 'lucide-react'

import { NamedSlider } from '@/components/editor/NamedSlider'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Separator } from '@/components/ui/separator'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

import { EditorCommandError } from '@/lib/editor/commands'
import {
  EASE_HANDLE_KEYBOARD_STEP,
  KEYFRAME_PROPERTY_BOUNDS,
  SPEED_MAX,
  SPEED_MIN,
} from '@/lib/editor/constants'
import {
  LINEAR_QUAD,
  mirrorQuad,
  presetControls,
  segmentControls,
  withEasing,
  withQuadHandle,
  withSegmentControls,
} from '@/lib/editor/ease-segment'
import {
  KEYFRAME_INTERPOLATIONS,
  animatedValue,
  clampPropertyValue,
  constantTimeScaleRate,
  hasTimeScaleCurve,
  keyframeDefaultEasing,
  staticPropertyValue,
  type KeyframeProperty,
} from '@/lib/editor/keyframes'
import {
  computeDuckingKeyframes,
  overlappingAudioClips,
  sanitizeDuckingOptions,
} from '@/lib/editor/ducking'
import { findClip, findMedia } from '@/lib/editor/factories'
import { AppliedEffectsSection } from '@/components/editor/effect-controls/AppliedEffectsSection'
import { linkedAudioTwin } from '@/lib/editor/links'
import { currentTransientToken, useEditorStore } from '@/lib/editor/store'
import { frameToTime } from '@/lib/editor/time'
import type { Clip, Keyframe, KeyframeInterpolation } from '@/lib/editor/types'

/**
 * Effect Controls, the keyframe + audio-shaping surface (0.5.0).
 *
 * One row per animatable property: value slider + a diamond toggle that adds or
 * removes a keyframe at the playhead, plus the property's keyframe list and a
 * light graph (dots + segments, drag a dot to move it; drag = one undo step).
 * Audio shaping (pan, EQ, compressor, auto-duck) lives in the same surface so
 * everything about the selected clip sits in one place.
 */

const VISUAL_PROPS: { key: KeyframeProperty; label: string }[] = [
  { key: 'opacity', label: 'Opacity' },
  { key: 'positionX', label: 'Position X' },
  { key: 'positionY', label: 'Position Y' },
  { key: 'scale', label: 'Scale' },
]

const COLOR_PROPS: { key: KeyframeProperty; label: string }[] = [
  { key: 'exposure', label: 'Exposure' },
  { key: 'contrast', label: 'Contrast' },
  { key: 'saturation', label: 'Saturation' },
  { key: 'brightness', label: 'Brightness' },
  { key: 'hue', label: 'Hue' },
]

const AUDIO_PROPS: { key: KeyframeProperty; label: string }[] = [{ key: 'volume', label: 'Volume' }]

/** The time-remap ramp row (0.6.0): a curve of speed multipliers. */
const TIME_PROPS: { key: KeyframeProperty; label: string }[] = [
  { key: 'timeScale', label: 'Time remapping' },
]

/**
 * Swallows the four arrow keys. The easing swatches and the keyframe-graph dots
 * are plain focusable elements, so the global editor shortcut handler (which
 * only skips form fields) would read an arrow as frame-step / jump-to-edit.
 * Their wrappers call this, the same guard the marker dialog's color group uses.
 */
function swallowArrows(e: ReactKeyboardEvent): void {
  if (
    e.key !== 'ArrowLeft' &&
    e.key !== 'ArrowRight' &&
    e.key !== 'ArrowUp' &&
    e.key !== 'ArrowDown'
  ) {
    return
  }
  e.preventDefault()
  e.stopPropagation()
}

/** Menu labels for the per-keyframe easing picker (interpolation of the next segment). */
const INTERPOLATION_LABELS: Record<KeyframeInterpolation, string> = {
  linear: 'Linear',
  easeIn: 'Ease in',
  easeOut: 'Ease out',
  easeInOut: 'Ease in/out',
}

/**
 * The easing name a keyframe's segment should DISPLAY as: the preset its stored
 * `easeOut` quad exactly matches when it has one, else its stored display name
 * (a subdivided sub-curve keeps its source preset's name), and null when a
 * quad under a linear name matches no preset. The segment's SHAPE is the truth
 * (every evaluator reads `easeOut ?? preset(name)`), so the dashed dot, the
 * pressed button and the clear path all follow this, and foreign data under a
 * linear name cannot masquerade as a linear segment.
 */
function displayedInterpolation(k: Keyframe | undefined): KeyframeInterpolation | null {
  if (!k) return 'linear'
  const name = k.interpolation ?? 'linear'
  const quad = k.easeOut
  if (!quad) return name
  const preset = KEYFRAME_INTERPOLATIONS.find((n) => {
    const controls = presetControls(n)
    return controls !== undefined && controls.every((v, i) => v === quad[i])
  })
  return preset ?? (name === 'linear' ? null : name)
}

export function EffectControlsPanel({ clip, trackKind }: { clip: Clip; trackKind: string }) {
  const doc = useEditorStore((s) => s.doc)
  const playhead = useEditorStore((s) => s.playhead)
  const asset = findMedia(doc, clip.mediaId)
  const isText = clip.text !== undefined && trackKind === 'text'
  const isVisual =
    isText ||
    (!!asset && asset.kind !== 'audio' && asset.kind !== 'image' ? true : asset?.kind === 'image')
  // The A/V twin is the pair's sole sound carrier, so audio edits go to it: on
  // the video half they would be inaudible (its own audio is shadowed).
  const audioClip = linkedAudioTwin(doc, clip) ?? clip
  const audioAsset = findMedia(doc, audioClip.mediaId)
  const hasAudio = !!audioAsset && (audioAsset.kind === 'audio' || audioAsset.kind === 'video')
  const local = Math.min(Math.max(0, playhead - clip.start), clip.duration)
  const audioLocal = Math.min(Math.max(0, playhead - audioClip.start), audioClip.duration)

  return (
    <div className="pb-6" data-testid="effect-controls">
      {isVisual && (
        <>
          <PropertyGroup
            title="Motion & opacity"
            clip={clip}
            props={VISUAL_PROPS}
            playheadLocal={local}
          />
          <Separator />
          <PropertyGroup title="Color" clip={clip} props={COLOR_PROPS} playheadLocal={local} />
          <Separator />
          <AppliedEffectsSection clip={clip} />
          <Separator />
        </>
      )}
      {hasAudio && (
        <>
          <PropertyGroup
            title="Volume"
            clip={audioClip}
            props={AUDIO_PROPS}
            playheadLocal={audioLocal}
          />
          <AudioShaping clip={audioClip} />
          <Separator />
        </>
      )}
      {/* A compound clip cannot be retimed (0.8.1): the speed/reverse commands
          refuse it, so the controls are not offered. */}
      {!isText && !clip.sequenceId && <SpeedSection clip={clip} />}
    </div>
  )
}

function PropertyGroup({
  title,
  clip,
  props,
  playheadLocal,
}: {
  title: string
  clip: Clip
  props: { key: KeyframeProperty; label: string }[]
  playheadLocal: number
}) {
  return (
    <div className="space-y-3 px-4 py-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {props.map(({ key, label }) => (
        <PropertyRow
          key={key}
          clip={clip}
          property={key}
          label={label}
          playheadLocal={playheadLocal}
        />
      ))}
    </div>
  )
}

function formatValue(property: KeyframeProperty, value: number): string {
  if (
    property === 'opacity' ||
    property === 'contrast' ||
    property === 'saturation' ||
    property === 'brightness'
  ) {
    return `${Math.round(value * 100)}%`
  }
  if (property === 'scale' || property === 'timeScale') return `${value.toFixed(2)}×`
  if (property === 'volume') return `${Math.round(value * 100)}%`
  if (property === 'hue') return `${Math.round(value)}°`
  if (property === 'positionX' || property === 'positionY') return `${Math.round(value)} px`
  return value.toFixed(2)
}

function sliderConfig(property: KeyframeProperty): { min: number; max: number; step: number } {
  switch (property) {
    case 'opacity':
      return { min: 0, max: 1, step: 0.01 }
    case 'volume':
      return { min: 0, max: 2, step: 0.01 }
    case 'scale':
      return {
        min: KEYFRAME_PROPERTY_BOUNDS.scale.min,
        max: KEYFRAME_PROPERTY_BOUNDS.scale.max,
        step: 0.01,
      }
    case 'positionX':
    case 'positionY':
      return { min: -600, max: 600, step: 1 }
    case 'exposure':
      return { min: 0.25, max: 4, step: 0.01 }
    case 'hue':
      return { min: -180, max: 180, step: 1 }
    case 'timeScale':
      return {
        min: KEYFRAME_PROPERTY_BOUNDS.timeScale.min,
        max: KEYFRAME_PROPERTY_BOUNDS.timeScale.max,
        step: 0.01,
      }
    default:
      return { min: 0, max: 2, step: 0.01 }
  }
}

/**
 * The active segment's start index for one row and playhead: the LAST stored
 * pair whose start sits at or before `at` (in row-axis time). A playhead
 * before the first keyframe takes the first pair (that region is
 * constant-extended), and a property with fewer than two keyframes has no
 * segment at all. The picker, the handles and `data-active-quad` all read
 * this one rule.
 */
function activeSegmentStart(keyframes: Keyframe[], at: number): number | null {
  if (keyframes.length < 2) return null
  let start = 0
  for (let i = 0; i < keyframes.length - 1; i++) {
    if (keyframes[i].time > at) break
    start = i
  }
  return start
}

/**
 * The per-property easing picker. With a curve it edits the active segment's
 * START keyframe (the same target the handles edit); without one it edits the
 * property's default easing for NEW keyframes, labelled so the two modes
 * cannot be confused.
 */
function EasingPicker({
  clip,
  property,
  playheadLocal,
  animated,
}: {
  clip: Clip
  property: KeyframeProperty
  playheadLocal: number
  animated: boolean
}) {
  const apply = useEditorStore((s) => s.apply)
  const defaults = useEditorStore((s) => s.doc.project.keyframeDefaults)
  const keyframes = clip.keyframes?.[property] ?? []
  const axis = rowAxis(clip, property)
  const targetIndex = activeSegmentStart(keyframes, axis(playheadLocal)) ?? 0
  const displayed = animated
    ? displayedInterpolation(keyframes[targetIndex])
    : keyframeDefaultEasing(defaults, property)

  const setInterpolation = (interpolation: KeyframeInterpolation) => {
    if (!animated) {
      // Default mode: a press on the already-pressed name is a no-op (no
      // history entry), and `linear` deletes the entry (absent reads linear).
      if (interpolation === keyframeDefaultEasing(defaults, property)) return
      apply({ type: 'setKeyframeDefault', property, interpolation })
      return
    }
    apply({
      type: 'setClipKeyframes',
      clipId: clip.id,
      property,
      keyframes: keyframes.map((k, i) => {
        if (i !== targetIndex) return k
        // A BOUNDED segment carries its exact sub-curve in `easeOut`, and the
        // picker presses the button that `displayedInterpolation` reports.
        // Picking that same NON-LINEAR value must be a no-op: the name is a
        // display shorthand, so overwriting the data with the full-span preset
        // would silently un-subdivide a split/trimmed curve on a click that
        // looks inert. The comparison is against the DISPLAYED value, not the
        // stored name: a foreign quad that matches a DIFFERENT preset is what
        // the picker shows pressed, and clicking the other name must stamp its
        // preset instead of no-opping on the stored name. Linear carries no
        // quad by definition, so picking it always normalizes: a foreign
        // `easeOut` under a linear name must be clearable, not protected by
        // the same-name rule.
        if (
          interpolation !== 'linear' &&
          interpolation === displayedInterpolation(k) &&
          k.easeOut
        ) {
          return k
        }
        // Stamp the preset's exact bezier data through the shared helper: a
        // later split/trim that subdivides this segment then starts from the
        // real shape, and the name stays the UI's display shorthand.
        return withEasing(k, interpolation)
      }),
    })
  }

  return (
    <div className="space-y-1">
      {!animated && (
        <span className="text-[10px] leading-none text-muted-foreground">Default easing</span>
      )}
      <div
        className="flex items-center gap-1"
        role="group"
        aria-label={animated ? `${property} easing` : `${property} default easing`}
        data-testid={`kf-ease-${property}`}
        onKeyDown={swallowArrows}
      >
        {KEYFRAME_INTERPOLATIONS.map((value) => (
          <Button
            key={value}
            size="sm"
            variant={value === displayed ? 'secondary' : 'ghost'}
            className="h-5 px-1.5 text-[10px]"
            aria-pressed={value === displayed}
            data-testid={`kf-ease-${property}-${value}`}
            onClick={() => setInterpolation(value)}
          >
            {INTERPOLATION_LABELS[value]}
          </Button>
        ))}
      </div>
    </div>
  )
}

function PropertyRow({
  clip,
  property,
  label,
  playheadLocal,
}: {
  clip: Clip
  property: KeyframeProperty
  label: string
  playheadLocal: number
}) {
  const apply = useEditorStore((s) => s.apply)
  const defaults = useEditorStore((s) => s.doc.project.keyframeDefaults)
  const keyframes = clip.keyframes?.[property] ?? []
  const animated = keyframes.length > 0
  // A reversed clip reads its `timeScale` curve in MIRRORED source-side local
  // time (`sourceTimeAt` integrates at duration - local), so that row's whole
  // axis is flipped to match (see rowAxis): a dot at the playhead then means
  // the rate the engine actually applies there. The flag rides to
  // KeyframeGraph as a prop; the axis itself comes from the shared helper.
  const mirrored = property === 'timeScale' && !!clip.reverse
  const axis = rowAxis(clip, property)
  const current = animatedValue(clip, property, axis(playheadLocal))
  const cfg = sliderConfig(property)

  const setCurve = (next: Keyframe[]) =>
    apply({ type: 'setClipKeyframes', clipId: clip.id, property, keyframes: next })

  const toggleKeyframe = () => {
    if (animated) {
      // Remove the keyframe at (or nearest) the playhead, measured on the row's
      // own axis (mirrored for a reversed clip's timeScale, like the seed and the
      // slider write below); clear when it is the last.
      const at = axis(playheadLocal)
      const nearest = keyframes.reduce<Keyframe | null>((best, k) => {
        if (!best) return k
        return Math.abs(k.time - at) < Math.abs(best.time - at) ? k : best
      }, null)
      if (!nearest) return
      const next = keyframes.filter((k) => k !== nearest)
      setCurve(next)
    } else {
      // First keyframe: pin the current static value at the playhead, carrying
      // the property's default easing when one is set.
      setCurve([
        withEasing(
          { time: axis(playheadLocal), value: staticPropertyValue(clip, property) },
          keyframeDefaultEasing(defaults, property),
        ),
      ])
    }
  }

  const onSlider = (v: number, commit: boolean) => {
    if (animated) {
      // Editing an animated property writes/updates a keyframe at the playhead.
      const at = axis(playheadLocal)
      const next = keyframes.filter((k) => Math.abs(k.time - at) > 1e-6)
      next.push(
        withEasing(
          { time: at, value: clampPropertyValue(property, v) },
          keyframeDefaultEasing(defaults, property),
        ),
      )
      const store = useEditorStore.getState()
      if (commit) setCurve(next)
      else {
        store.applyTransient({
          type: 'setClipKeyframes',
          clipId: clip.id,
          property,
          keyframes: next,
        })
      }
      return
    }
    // Static edit: opacity/volume keep their dedicated fields.
    const store = useEditorStore.getState()
    if (property === 'opacity') {
      if (commit) apply({ type: 'setClipOpacity', clipId: clip.id, opacity: v })
      else store.applyTransient({ type: 'setClipOpacity', clipId: clip.id, opacity: v })
      return
    }
    if (property === 'volume') {
      if (commit) apply({ type: 'setClipGain', clipId: clip.id, gain: v })
      else store.applyTransient({ type: 'setClipGain', clipId: clip.id, gain: v })
      return
    }
    // timeScale's static source is the clip's speed field (the ramp is only
    // created by the diamond; while it exists the slider writes keyframes).
    if (property === 'timeScale') {
      if (commit) apply({ type: 'setClipSpeed', clipId: clip.id, speed: v })
      else store.applyTransient({ type: 'setClipSpeed', clipId: clip.id, speed: v })
      return
    }
    if (commit) {
      apply({ type: 'setClipAnimStatic', clipId: clip.id, property, value: v })
    } else {
      store.applyTransient({ type: 'setClipAnimStatic', clipId: clip.id, property, value: v })
    }
  }

  return (
    <div data-testid={`prop-${property}`} className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-xs">{label}</Label>
        <div className="flex items-center gap-1.5">
          <span className="text-xs tabular-nums text-muted-foreground">
            {formatValue(property, current)}
          </span>
          <Button
            size="icon"
            variant="ghost"
            className="size-5"
            aria-label={`Keyframe ${label}`}
            data-testid={`kf-toggle-${property}`}
            data-active={animated ? 'true' : 'false'}
            onClick={toggleKeyframe}
          >
            <Diamond
              className={
                animated ? 'size-3 fill-current text-amber-500' : 'size-3 text-muted-foreground'
              }
            />
          </Button>
        </div>
      </div>
      <NamedSlider
        aria-label={`${label} value`}
        value={[current]}
        min={cfg.min}
        max={cfg.max}
        step={cfg.step}
        onValueChange={([v]) => onSlider(v, false)}
        onValueCommit={([v]) => onSlider(v, true)}
      />
      <EasingPicker
        clip={clip}
        property={property}
        playheadLocal={playheadLocal}
        animated={animated}
      />
      {animated && (
        <KeyframeGraph
          clip={clip}
          property={property}
          playheadLocal={playheadLocal}
          mirrored={mirrored}
        />
      )}
    </div>
  )
}

/** Light graph: keyframe dots over the clip duration; drag a dot to move it. */
function KeyframeGraph({
  clip,
  property,
  playheadLocal,
  mirrored,
}: {
  clip: Clip
  property: KeyframeProperty
  playheadLocal: number
  /** True for a reversed clip's `timeScale` row: the x axis is flipped. */
  mirrored: boolean
}) {
  const apply = useEditorStore((s) => s.apply)
  // One frame in the project's frame grid: the keyboard nudge's unit.
  const fps = useEditorStore((s) => s.doc.project.fps)
  const keyframes = clip.keyframes?.[property] ?? []
  const axis = rowAxis(clip, property)
  // Arrow nudging of the FOCUSED dot (the dots are the thumbs of the row's
  // `role="slider"` contract): one frame in the project's own frame grid, in
  // AXIS space so a reversed row's Left moves the dot left on screen. Each
  // dot carries its own handler (it knows its index), commits as one undo
  // step, and steps while the key is held the way a native slider thumb
  // does. Without this the wrapper's guard swallowed the keys and the
  // contract promised a keyboard path the dots did not have.
  const frame = frameToTime(1, fps)
  const nudgeDot = (index: number, key: string) => {
    const delta = (key === 'ArrowRight' ? 1 : -1) * frame
    const next = keyframes.map((k, i) => {
      if (i !== index) return k
      // Nudge in AXIS space (screen), clamp there, then convert back: `axis`
      // is its own inverse, and a mirrored row's time runs opposite to the
      // screen position the user sees and the clamps promise.
      const screen = Math.max(0, Math.min(clip.duration, axis(k.time) + delta))
      return { ...k, time: axis(screen) }
    })
    apply({ type: 'setClipKeyframes', clipId: clip.id, property, keyframes: next })
  }
  const wrapRef = useRef<HTMLDivElement>(null)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  // Initiating pointer of the active keyframe drag (multi-touch: ignore others).
  const [pointerId, setPointerId] = useState<number | null>(null)
  // Gesture token from beginTransient: a foreign commit bumps it and the drag
  // then refuses further frames (they would carry no undo entry).
  const tokenRef = useRef(-1)
  // The grabbed keyframe's current time. The store re-sorts the array the
  // moment a crossing frame lands, so the index captured below stops naming
  // the grabbed keyframe: the drag looks it up by the time it last wrote.
  const dragTimeRef = useRef(0)

  useEffect(() => {
    if (dragIndex === null) return
    const store = useEditorStore.getState()
    const onMove = (e: PointerEvent) => {
      // Only the initiating pointer drives the drag (multi-touch).
      if (e.pointerId !== pointerId) return
      if (currentTransientToken() !== tokenRef.current) return
      const rect = wrapRef.current?.getBoundingClientRect()
      if (!rect || rect.width <= 0) return
      const t = ((e.clientX - rect.left) / rect.width) * clip.duration
      const live = useEditorStore.getState().doc
      const clipNow = findClip(live, clip.id)?.clip
      const kfs = clipNow?.keyframes?.[property]
      if (!kfs || kfs.length === 0) return
      // Find the grabbed keyframe again: after it passes a neighbour the stored
      // array is sorted, so `dragIndex` names the keyframe it crossed and every
      // later frame would drive that one to the pointer while the grabbed dot
      // freezes. The captured index wins while it still matches (two keyframes
      // may legally share a time, e.g. both clamped to a clip end).
      const target =
        kfs[dragIndex]?.time === dragTimeRef.current
          ? dragIndex
          : kfs.findIndex((k) => k.time === dragTimeRef.current)
      if (target < 0) return
      const time = Math.max(0, Math.min(clip.duration, axis(t)))
      const next = kfs.map((k, i) => (i === target ? { ...k, time } : k))
      dragTimeRef.current = time
      store.applyTransient({ type: 'setClipKeyframes', clipId: clip.id, property, keyframes: next })
    }
    const onUp = (e: PointerEvent) => {
      // Only the initiating pointer ends this drag (multi-touch): a second
      // pointer lifting anywhere would otherwise commit a drag it does not own.
      // Capture phase, so this keeps the first word over the shell's
      // dangling-commit net (the marker and clip gestures work the same way).
      if (e.pointerId !== pointerId) return
      // The transparent base was snapshotted by the dot's pointerdown; committing
      // here turns the whole drag into exactly one undo step.
      try {
        useEditorStore.getState().commitTransient()
      } catch {
        useEditorStore.getState().cancelTransient()
      }
      setDragIndex(null)
      setPointerId(null)
    }
    const onCancel = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return
      // The browser took the pointer (touch pan, native drag): discard the drag
      // rather than leaving its transient live, which would block autosave.
      useEditorStore.getState().cancelTransient()
      setDragIndex(null)
      setPointerId(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onCancel, true)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('pointercancel', onCancel, true)
    }
    // `pointerId` is a dependency because the handlers read it: a re-grab of the
    // same dot by a second pointer must hand ownership over instead of leaving
    // the listeners filtering for the first one. `dragTimeRef` is read live and
    // mutates per frame, so it stays out of the dependency list on purpose.
  }, [dragIndex, clip.id, clip.duration, property, pointerId])

  const bounds = KEYFRAME_PROPERTY_BOUNDS[property]
  const span = Math.max(1e-6, bounds.max - bounds.min)

  const at = axis(playheadLocal)
  // The active segment; the picker, the handles and `data-active-quad` share
  // this one rule. A mirrored row compares in STORED time, because `at` is
  // already the axis reading of the playhead.
  const activeStart = activeSegmentStart(keyframes, at)

  // Screen mapping, the same one the dots use (percent of the strip, y from
  // the bottom). A mirrored row flips time only (`rowAxis`), so values plot
  // directly and the mirror lives in the segment's own box.
  const dotPoint = (k: Keyframe) => ({
    x: (Math.max(0, Math.min(clip.duration, axis(k.time))) / Math.max(1e-6, clip.duration)) * 100,
    y: Math.max(0, Math.min(100, ((k.value - bounds.min) / span) * 100)),
  })
  const fmt = (n: number) => n.toFixed(3)

  // One path per stored pair: linear draws a line, an eased pair draws its
  // exact box cubic. A mirrored row draws the stored pair's endpoints at their
  // screen positions with the control points of mirrorQuad(stored), so the
  // draw and the drag go through the one conversion the helper names.
  const segments = keyframes.slice(0, -1).map((a, i) => {
    const b = keyframes[i + 1]
    const left = mirrored ? dotPoint(b) : dotPoint(a)
    const right = mirrored ? dotPoint(a) : dotPoint(b)
    const raw = segmentControls(a)
    const quad = raw ? (mirrored ? mirrorQuad(raw) : raw) : undefined
    const box = (u: number, v: number) => ({
      x: left.x + u * (right.x - left.x),
      y: left.y + v * (right.y - left.y),
    })
    const svg = (p: { x: number; y: number }) => `${fmt(p.x)},${fmt(100 - p.y)}`
    const d = quad
      ? `M ${svg(left)} C ${svg(box(quad[0], quad[1]))} ${svg(box(quad[2], quad[3]))} ${svg(right)}`
      : `M ${svg(left)} L ${svg(right)}`
    return { i, d }
  })

  // The active segment's DRAWN quad (mirrored first for a reversed row) and
  // its two handle positions. mirrorQuad swaps the ends, so on a mirrored row
  // the stored `out` pair is drawn at point 1; the testid always names the
  // STORED pair the drag writes.
  const active =
    activeStart === null
      ? null
      : (() => {
          const a = keyframes[activeStart]
          const b = keyframes[activeStart + 1]
          const raw = segmentControls(a) ?? LINEAR_QUAD
          const quad = mirrored ? mirrorQuad(raw) : raw
          const left = mirrored ? dotPoint(b) : dotPoint(a)
          const right = mirrored ? dotPoint(a) : dotPoint(b)
          const point = (p: number) => ({
            x: left.x + quad[p * 2] * (right.x - left.x),
            y: left.y + quad[p * 2 + 1] * (right.y - left.y),
          })
          return {
            startIndex: activeStart,
            quadAttr: quad.map((n) => fmt(n)).join(','),
            out: point(mirrored ? 1 : 0),
            in: point(mirrored ? 0 : 1),
            storedOut: { x: raw[0], y: raw[1] },
            storedIn: { x: raw[2], y: raw[3] },
          }
        })()

  // Handle drag: the same window-listener protocol as the dot drag (token
  // check, `applyTransient` per move, commit on release, cancel on
  // pointercancel), so a handle drag is one undo step and cannot strand a
  // transient. The pointer is read in the drawn box with NO pre-flip; a
  // mirrored row applies the same single `mirrorQuad` conversion on the way to
  // storage, never a second one.
  const [handleDrag, setHandleDrag] = useState<{
    which: 'out' | 'in'
    startIndex: number
    pointerId: number
  } | null>(null)
  useEffect(() => {
    if (!handleDrag) return
    const store = useEditorStore.getState()
    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== handleDrag.pointerId) return
      if (currentTransientToken() !== tokenRef.current) return
      const rect = wrapRef.current?.getBoundingClientRect()
      if (!rect || rect.width <= 0 || rect.height <= 0) return
      const live = useEditorStore.getState().doc
      const clipNow = findClip(live, clip.id)?.clip
      const kfs = clipNow?.keyframes?.[property]
      const start = kfs?.[handleDrag.startIndex]
      const end = kfs?.[handleDrag.startIndex + 1]
      if (!start || !end) return
      // The drawn box: u across the span left to right, v from the drawn left
      // endpoint's value to the drawn right endpoint's.
      const bounds = KEYFRAME_PROPERTY_BOUNDS[property]
      const span = Math.max(1e-6, bounds.max - bounds.min)
      const axis = rowAxis(clip, property)
      const point = (k: Keyframe) => ({
        x:
          (Math.max(0, Math.min(clip.duration, axis(k.time))) / Math.max(1e-6, clip.duration)) *
          100,
        y: Math.max(0, Math.min(100, ((k.value - bounds.min) / span) * 100)),
      })
      const left = point(mirrored ? end : start)
      const right = point(mirrored ? start : end)
      const uRow = (e.clientX - rect.left) / rect.width
      const vRow = 1 - (e.clientY - rect.top) / rect.height
      const raw = segmentControls(start) ?? LINEAR_QUAD
      const current =
        handleDrag.which === 'out' ? { x: raw[0], y: raw[1] } : { x: raw[2], y: raw[3] }
      const spanX = right.x - left.x
      const spanY = right.y - left.y
      // BOTH axes read the drawn box: u across the segment's time span, v from
      // the drawn left endpoint's value to the right one's, the exact mapping
      // the path draws through. Reading u off the whole strip would agree only
      // on a full-width segment and would jump the handle on every partial one.
      const u = Math.abs(spanX) < 1e-9 ? current.x : (uRow * 100 - left.x) / spanX
      // A flat segment has no vertical box to read: keep the stored y.
      const v = Math.abs(spanY) < 1e-9 ? current.y : (vRow * 100 - left.y) / spanY
      const nextQuad = withQuadHandle(raw, handleDrag.which, {
        x: mirrored ? 1 - u : u,
        y: mirrored ? 1 - v : v,
      })
      const next = kfs.map((k, i) =>
        i === handleDrag.startIndex
          ? withSegmentControls<Keyframe>({ ...k, interpolation: 'linear' }, nextQuad)
          : k,
      )
      store.applyTransient({ type: 'setClipKeyframes', clipId: clip.id, property, keyframes: next })
    }
    const onUp = (e: PointerEvent) => {
      if (e.pointerId !== handleDrag.pointerId) return
      // Commit on release, so the whole drag is one undo step (the same
      // capture-phase ordering and dangling-commit net as the dot drag).
      try {
        useEditorStore.getState().commitTransient()
      } catch {
        useEditorStore.getState().cancelTransient()
      }
      setHandleDrag(null)
    }
    const onCancel = (e: PointerEvent) => {
      if (e.pointerId !== handleDrag.pointerId) return
      useEditorStore.getState().cancelTransient()
      setHandleDrag(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onCancel, true)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('pointercancel', onCancel, true)
    }
    // `handleDrag` carries the pointer id: a re-grab re-runs the effect with
    // the new owner, the same handover the dot drag gets from its state.
  }, [handleDrag, clip.id, clip.duration, property, mirrored])

  const onHandlePointerDown = (which: 'out' | 'in', e: ReactPointerEvent) => {
    e.stopPropagation()
    if (activeStart === null) return
    tokenRef.current = useEditorStore.getState().beginTransient(e.pointerId)
    setHandleDrag({ which, startIndex: activeStart, pointerId: e.pointerId })
  }

  const onHandleKeyDown = (which: 'out' | 'in', e: ReactKeyboardEvent) => {
    if (activeStart === null) return
    if (
      e.key !== 'ArrowLeft' &&
      e.key !== 'ArrowRight' &&
      e.key !== 'ArrowUp' &&
      e.key !== 'ArrowDown'
    ) {
      return
    }
    e.preventDefault()
    e.stopPropagation()
    const start = keyframes[activeStart]
    const raw = segmentControls(start) ?? LINEAR_QUAD
    const current = which === 'out' ? { x: raw[0], y: raw[1] } : { x: raw[2], y: raw[3] }
    const dx =
      e.key === 'ArrowLeft'
        ? -EASE_HANDLE_KEYBOARD_STEP
        : e.key === 'ArrowRight'
          ? EASE_HANDLE_KEYBOARD_STEP
          : 0
    const dy =
      e.key === 'ArrowUp'
        ? EASE_HANDLE_KEYBOARD_STEP
        : e.key === 'ArrowDown'
          ? -EASE_HANDLE_KEYBOARD_STEP
          : 0
    const nextQuad = withQuadHandle(raw, which, { x: current.x + dx, y: current.y + dy })
    // The same write rule as a drag: the name normalizes to linear, so a
    // hand-made shape shows no pressed preset.
    apply({
      type: 'setClipKeyframes',
      clipId: clip.id,
      property,
      keyframes: keyframes.map((k, i) =>
        i === activeStart
          ? withSegmentControls<Keyframe>({ ...k, interpolation: 'linear' }, nextQuad)
          : k,
      ),
    })
  }

  return (
    <div
      ref={wrapRef}
      data-testid={`kf-graph-${property}`}
      data-active-quad={active?.quadAttr}
      className="relative h-10 w-full rounded border border-border bg-muted/30"
      onKeyDown={swallowArrows}
    >
      <svg
        // `size-full` is required, not decorative: an absolutely positioned
        // REPLACED element with a square viewBox sizes itself from the 1:1
        // intrinsic ratio whenever a side is left to `auto`, so `inset-0` alone
        // makes the box as tall as the row is WIDE and `h-full` alone makes it
        // as narrow as the row is tall. Either way the viewBox stretches with
        // the box and the drawn curve stops meeting the percent-placed dots.
        className="pointer-events-none absolute inset-0 size-full"
        aria-hidden="true"
        data-testid={`kf-curve-${property}`}
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
      >
        {segments.map((seg) => (
          <path
            key={seg.i}
            data-testid={`kf-seg-${property}-${seg.i}`}
            d={seg.d}
            fill="none"
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
            className="stroke-amber-400"
          />
        ))}
      </svg>
      {active &&
        (['out', 'in'] as const).map((which) => {
          const pos = which === 'out' ? active.out : active.in
          const stored = which === 'out' ? active.storedOut : active.storedIn
          return (
            <div
              key={which}
              data-testid={`kf-handle-${property}-${which}`}
              role="slider"
              tabIndex={0}
              aria-label={`${property} ease handle ${
                which === 'out' ? 'outgoing' : 'incoming'
              } ${active.startIndex + 1}`}
              aria-valuenow={Number(stored.x.toFixed(2))}
              aria-valuemin={0}
              aria-valuemax={1}
              aria-valuetext={`x ${stored.x.toFixed(2)}, y ${stored.y.toFixed(2)}`}
              className="absolute size-2.5 -translate-x-1/2 translate-y-1/2 cursor-grab rounded-full border border-amber-600 bg-amber-400"
              style={{ left: `${pos.x}%`, bottom: `${pos.y}%` }}
              onPointerDown={(e) => onHandlePointerDown(which, e)}
              onKeyDown={(e) => onHandleKeyDown(which, e)}
            />
          )
        })}
      {keyframes.map((k, i) => {
        const left =
          (Math.max(0, Math.min(clip.duration, axis(k.time))) / Math.max(1e-6, clip.duration)) * 100
        const bottom = ((k.value - bounds.min) / span) * 100
        const eased = segmentControls(k) !== undefined
        return (
          <div
            // Index key, not `time`: a time-bearing key remounts the dot on
            // every nudge/drag frame, which drops keyboard focus mid-use
            // (the next press would fall through to the global shortcut).
            key={i}
            data-testid={`kf-dot-${property}-${i}`}
            data-interpolation={k.interpolation ?? 'linear'}
            role="slider"
            tabIndex={0}
            aria-label={`${property} keyframe ${i + 1}`}
            aria-valuenow={Number(k.time.toFixed(2))}
            aria-valuemin={0}
            aria-valuemax={clip.duration}
            className={`absolute size-2.5 -translate-x-1/2 translate-y-1/2 cursor-ew-resize rounded-full border bg-amber-400 ${
              eased ? 'border-dashed border-amber-700' : 'border-amber-600'
            }`}
            style={{ left: `${left}%`, bottom: `${Math.max(0, Math.min(100, bottom))}%` }}
            onPointerDown={(e) => {
              e.stopPropagation()
              tokenRef.current = useEditorStore.getState().beginTransient(e.pointerId)
              dragTimeRef.current = k.time
              setPointerId(e.pointerId)
              setDragIndex(i)
            }}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
              // One frame per keydown, OS repeat included: the same
              // step-on-hold behavior a native slider thumb has. The graph
              // wrapper's guard stops anything from reaching the global
              // shortcut either way (the wrapper runs first by bubbling).
              e.preventDefault()
              e.stopPropagation()
              nudgeDot(i, e.key)
            }}
          />
        )
      })}
    </div>
  )
}

function AudioShaping({ clip }: { clip: Clip }) {
  const apply = useEditorStore((s) => s.apply)
  const doc = useEditorStore((s) => s.doc)
  const [eqOpen, setEqOpen] = useState(false)
  const eq = clip.eq ?? { low: 0, mid: 0, high: 0 }

  const setEqBand = (band: 'low' | 'mid' | 'high', v: number, commit: boolean) => {
    const next = { ...eq, [band]: v }
    const store = useEditorStore.getState()
    if (commit) {
      apply({ type: 'setClipEq', clipId: clip.id, eq: next })
    } else {
      store.applyTransient({ type: 'setClipEq', clipId: clip.id, eq: next })
    }
  }

  return (
    <div className="space-y-3 px-4 py-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Audio shaping
      </h3>
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <Label className="text-xs">Pan</Label>
          <span className="text-xs tabular-nums text-muted-foreground">
            {clip.pan === undefined || clip.pan === 0
              ? 'C'
              : clip.pan < 0
                ? `L${Math.round(-clip.pan * 100)}`
                : `R${Math.round(clip.pan * 100)}`}
          </span>
        </div>
        <NamedSlider
          aria-label="Clip pan"
          value={[clip.pan ?? 0]}
          min={-1}
          max={1}
          step={0.05}
          onValueChange={([v]) =>
            useEditorStore
              .getState()
              .applyTransient({ type: 'setClipPan', clipId: clip.id, pan: v })
          }
          onValueCommit={([v]) => apply({ type: 'setClipPan', clipId: clip.id, pan: v })}
        />
      </div>

      <div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-full justify-between px-2 text-xs"
          aria-label="Toggle EQ"
          onClick={() => setEqOpen((o) => !o)}
        >
          EQ (3-band)
          {eqOpen ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
        </Button>
        {eqOpen && (
          <div className="mt-2 space-y-2">
            {(['low', 'mid', 'high'] as const).map((band) => (
              <div key={band}>
                <div className="flex items-center justify-between">
                  <Label className="text-[11px] capitalize">
                    {band} {band === 'low' ? '(200 Hz)' : band === 'mid' ? '(1 kHz)' : '(4 kHz)'}
                  </Label>
                  <span className="text-[11px] tabular-nums text-muted-foreground">
                    {eq[band] > 0 ? '+' : ''}
                    {eq[band]} dB
                  </span>
                </div>
                <NamedSlider
                  aria-label={`EQ ${band} dB`}
                  value={[eq[band]]}
                  min={-24}
                  max={24}
                  step={1}
                  onValueChange={([v]) => setEqBand(band, v, false)}
                  onValueCommit={([v]) => setEqBand(band, v, true)}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between">
        <Label className="text-xs">Compressor</Label>
        <Switch
          aria-label="Clip compressor"
          checked={!!clip.compressor}
          onCheckedChange={(checked) =>
            apply({ type: 'setClipCompressor', clipId: clip.id, enabled: checked })
          }
        />
      </div>

      <div className="flex items-center justify-between">
        <Label className="text-xs">Reduce noise</Label>
        <Switch
          aria-label="Reduce noise"
          checked={!!clip.denoise}
          onCheckedChange={(checked) =>
            apply({ type: 'setClipDenoise', clipId: clip.id, enabled: checked })
          }
        />
      </div>

      <AutoDuck clip={clip} doc={doc} />
    </div>
  )
}

function AutoDuck({
  clip,
  doc,
}: {
  clip: Clip
  doc: ReturnType<typeof useEditorStore.getState>['doc']
}) {
  const apply = useEditorStore((s) => s.apply)
  const activeSequencePath = useEditorStore((s) => s.activeSequencePath)
  const [sourceId, setSourceId] = useState<string>('auto')
  const candidates = overlappingAudioClips(
    doc,
    {
      start: clip.start,
      end: clip.start + clip.duration,
    },
    activeSequencePath,
  ).filter((c) => c.id !== clip.id)

  const duck = () => {
    const dialogue =
      sourceId === 'auto'
        ? candidates.filter((c) => !!findMedia(doc, c.mediaId)?.waveformPeaks)
        : candidates.filter((c) => c.id === sourceId)
    if (dialogue.length === 0) return
    const keyframes = computeDuckingKeyframes(doc, clip, dialogue, sanitizeDuckingOptions({}))
    try {
      apply({ type: 'setClipKeyframes', clipId: clip.id, property: 'volume', keyframes })
    } catch (error) {
      if (!(error instanceof EditorCommandError)) throw error
    }
  }

  return (
    <div className="space-y-2 rounded border border-border/60 p-2" data-testid="auto-duck">
      <div className="flex items-center justify-between">
        <Label className="text-xs">Auto-duck under dialogue</Label>
      </div>
      <Select value={sourceId} onValueChange={setSourceId}>
        <SelectTrigger className="h-8 text-xs" aria-label="Dialogue source">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="auto">Auto (all overlapping audio)</SelectItem>
          {candidates.map((c) => (
            <SelectItem key={c.id} value={c.id}>
              {findMedia(doc, c.mediaId)?.name ?? 'Clip'}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        size="sm"
        variant="secondary"
        className="h-7 w-full gap-1 text-xs"
        aria-label="Apply auto-duck"
        disabled={candidates.length === 0}
        onClick={duck}
      >
        <Plus className="size-3" /> Duck the music
      </Button>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Writes volume keyframes that dip this clip while the dialogue is loud. Undo removes them.
      </p>
    </div>
  )
}

/**
 * Curve time to on-screen axis time for one property row (its own inverse):
 * a reversed clip reads its `timeScale` curve in MIRRORED source-side local
 * time (`sourceTimeAt` integrates at duration - local), so that row's whole
 * axis is flipped to match. Every other property plots plain clip-local time.
 * Shared by PropertyRow and KeyframeGraph so the rule lives in one place.
 */
function rowAxis(clip: Clip, property: KeyframeProperty): (t: number) => number {
  const mirrored = property === 'timeScale' && !!clip.reverse
  return (t: number) => (mirrored ? clip.duration - t : t)
}

function SpeedSection({ clip }: { clip: Clip }) {
  const apply = useEditorStore((s) => s.apply)
  const playhead = useEditorStore((s) => s.playhead)
  const track = useEditorStore((s) => findClip(s.doc, clip.id)?.track)
  const kind = track?.kind
  const local = Math.min(Math.max(0, playhead - clip.start), clip.duration)
  // The curve, not the static rate, sets a ramped clip's speed, so the static
  // control is disabled rather than pretending to change something.
  const ramped = hasTimeScaleCurve(clip)
  // The rate playback and export apply: a flat curve's constant, or the
  // static speed when there is no curve or the curve is a real ramp (no
  // single value; the remap row owns it). The fallback also keeps the
  // readout finite on a ramped clip, where the constant is undefined.
  const effectiveSpeed = constantTimeScaleRate(clip) ?? clip.speed ?? 1
  // Time remapping and reverse are picture-only. A ramp drops its link group's
  // audio in both render paths, so on an audio-only clip the row could only ever
  // silence the pair (the curve's twin reads its OWN keyframes, so nothing else
  // changes), while the static Speed slider below still re-times the audio
  // element. `audioOnly` sits next to the video-track test because the A/V twin
  // still fits a video track (clipFitsTrack), where the picture-only rows must
  // stay hidden too.
  const pictureBearing = kind === 'video' && !clip.audioOnly

  return (
    <>
      <Separator />
      <div className="space-y-3 px-4 py-3" data-testid="speed-section">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Speed & direction
        </h3>
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <Label className="text-xs">Speed</Label>
            <span className="text-xs tabular-nums text-muted-foreground">
              {effectiveSpeed.toFixed(2)}×
            </span>
          </div>
          <NamedSlider
            aria-label="Clip speed"
            value={[effectiveSpeed]}
            min={SPEED_MIN}
            max={SPEED_MAX}
            step={0.05}
            disabled={ramped}
            onValueChange={([v]) =>
              useEditorStore
                .getState()
                .applyTransient({ type: 'setClipSpeed', clipId: clip.id, speed: v })
            }
            onValueCommit={([v]) => apply({ type: 'setClipSpeed', clipId: clip.id, speed: v })}
          />
          {ramped && (
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
              A time remapping curve sets this clip's speed. Edit its keyframes in the Time
              remapping row below to re-time the clip.
            </p>
          )}
        </div>
        {pictureBearing && (
          <div className="flex items-center justify-between">
            <Label className="text-xs">Reverse (picture only)</Label>
            <Switch
              aria-label="Reverse clip"
              checked={!!clip.reverse}
              onCheckedChange={(checked) =>
                apply({ type: 'setClipReverse', clipId: clip.id, reverse: checked })
              }
            />
          </div>
        )}
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Alt-drag a clip edge on the timeline to rate-stretch (a clip with a time remapping curve
          trims instead; its rate comes from the curve). Reversed clips play stepped in the preview
          and frame-accurate in the export; their audio is dropped.
        </p>
        {pictureBearing && (
          <>
            {TIME_PROPS.map(({ key, label }) => (
              <PropertyRow
                key={key}
                clip={clip}
                property={key}
                label={label}
                playheadLocal={local}
              />
            ))}
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Time remapping keyframes ramp the clip's speed without changing its timeline length:
              the diamond seeds a curve at the playhead, the slider then edits that keyframe. While
              no curve exists, the slider sets the clip's static speed instead, which may shorten
              the clip so it never needs source past the asset's end (it never grows). Ramped clips
              play stepped in the preview, render frame-accurate in the export, and drop their audio
              (both halves of a linked pair), like reversed clips. A flat curve that pushes one
              half's rate off the other's retimes the picture against it, so it silences the pair
              too; the identity seed (1x) and a solo clip's own constant keep the audio.
            </p>
          </>
        )}
      </div>
    </>
  )
}

export { PropertyRow as EffectControlsPropertyRow }
