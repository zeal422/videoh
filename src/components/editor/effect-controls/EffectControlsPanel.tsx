'use client'

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
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
import { KEYFRAME_PROPERTY_BOUNDS, SPEED_MAX, SPEED_MIN } from '@/lib/editor/constants'
import { presetControls } from '@/lib/editor/ease-segment'
import {
  KEYFRAME_INTERPOLATIONS,
  animatedValue,
  clampPropertyValue,
  hasTimeScaleCurve,
  staticPropertyValue,
  type KeyframeProperty,
} from '@/lib/editor/keyframes'
import {
  computeDuckingKeyframes,
  overlappingAudioClips,
  sanitizeDuckingOptions,
} from '@/lib/editor/ducking'
import { findMedia } from '@/lib/editor/factories'
import { linkedAudioTwin } from '@/lib/editor/links'
import { currentTransientToken, useEditorStore } from '@/lib/editor/store'
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
      {!isText && <SpeedSection clip={clip} />}
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
  const keyframes = clip.keyframes?.[property] ?? []
  const animated = keyframes.length > 0
  // A reversed clip reads its `timeScale` curve in MIRRORED source-side local
  // time (`sourceTimeAt` integrates at duration - local), so that row's whole
  // axis is flipped to match: a dot at the playhead then means the rate the
  // engine actually applies there. `axis` is its own inverse. Every other
  // property is evaluated at the plain clip-local time, so this is timeScale
  // only.
  const mirrored = property === 'timeScale' && !!clip.reverse
  const axis = (t: number) => (mirrored ? clip.duration - t : t)
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
      // First keyframe: pin the current static value at the playhead.
      setCurve([{ time: axis(playheadLocal), value: staticPropertyValue(clip, property) }])
    }
  }

  const onSlider = (v: number, commit: boolean) => {
    if (animated) {
      // Editing an animated property writes/updates a keyframe at the playhead.
      const at = axis(playheadLocal)
      const next = keyframes.filter((k) => Math.abs(k.time - at) > 1e-6)
      next.push({ time: at, value: clampPropertyValue(property, v) })
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
  // Curve time -> on-screen axis time (its own inverse); see PropertyRow.
  const axis = (t: number) => (mirrored ? clip.duration - t : t)
  // Arrow nudging of the FOCUSED dot (the dots are the thumbs of the row's
  // `role="slider"` contract): one frame in the project's own frame grid, in
  // AXIS space so a reversed row's Left moves the dot left on screen. Each
  // dot carries its own handler (it knows its index), commits as one undo
  // step, and steps while the key is held the way a native slider thumb
  // does. Without this the wrapper's guard swallowed the keys and the
  // contract promised a keyboard path the dots did not have.
  const frame = 1 / fps
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
      const clipNow = live.project.tracks.flatMap((tr) => tr.clips).find((c) => c.id === clip.id)
      const kfs = clipNow?.keyframes?.[property]
      if (!kfs || !kfs[dragIndex]) return
      const next = kfs.map((k, i) =>
        i === dragIndex ? { ...k, time: Math.max(0, Math.min(clip.duration, axis(t))) } : k,
      )
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
    // the listeners filtering for the first one.
  }, [dragIndex, clip.id, clip.duration, property, pointerId])

  const bounds = KEYFRAME_PROPERTY_BOUNDS[property]
  const span = Math.max(1e-6, bounds.max - bounds.min)

  // The easing picker targets the keyframe nearest the playhead, the same one
  // the diamond toggle removes: both measure on the row's own axis, mirrored for
  // a reversed clip's timeScale. The interpolation belongs to the segment that
  // STARTS at a keyframe, so editing the last keyframe changes nothing visible
  // until another keyframe follows it.
  const at = axis(playheadLocal)
  const activeIndex = keyframes.reduce(
    (best, k, i) => (Math.abs(k.time - at) < Math.abs(keyframes[best].time - at) ? i : best),
    0,
  )
  const activeInterpolation = keyframes[activeIndex]?.interpolation ?? 'linear'
  const setInterpolation = (interpolation: KeyframeInterpolation) => {
    apply({
      type: 'setClipKeyframes',
      clipId: clip.id,
      property,
      keyframes: keyframes.map((k, i) => {
        if (i !== activeIndex) return k
        // A BOUNDED segment carries its exact sub-curve in `easeOut`, and the
        // picker renders its `interpolation` NAME as the pressed button. Picking
        // that same name must be a no-op: the name is a display shorthand, so
        // overwriting the data with the full-span preset would silently
        // un-subdivide a split/trimmed curve on a click that looks inert.
        if (interpolation === k.interpolation && k.easeOut) return k
        // Stamp the preset's exact bezier data: a later split/trim that
        // subdivides this segment then starts from the real shape, and the
        // name stays the UI's display shorthand.
        const controls = presetControls(interpolation)
        const next: Keyframe = { ...k, interpolation }
        if (controls) next.easeOut = [...controls]
        else delete next.easeOut
        return next
      }),
    })
  }

  return (
    <div className="space-y-1">
      <div
        className="flex items-center gap-1"
        role="group"
        aria-label={`${property} easing`}
        data-testid={`kf-ease-${property}`}
        onKeyDown={swallowArrows}
      >
        {KEYFRAME_INTERPOLATIONS.map((value) => (
          <Button
            key={value}
            size="sm"
            variant={value === activeInterpolation ? 'secondary' : 'ghost'}
            className="h-5 px-1.5 text-[10px]"
            aria-pressed={value === activeInterpolation}
            data-testid={`kf-ease-${property}-${value}`}
            onClick={() => setInterpolation(value)}
          >
            {INTERPOLATION_LABELS[value]}
          </Button>
        ))}
      </div>
      <div
        ref={wrapRef}
        data-testid={`kf-graph-${property}`}
        className="relative h-10 w-full rounded border border-border bg-muted/30"
        onKeyDown={swallowArrows}
      >
        {keyframes.map((k, i) => {
          const left =
            (Math.max(0, Math.min(clip.duration, axis(k.time))) / Math.max(1e-6, clip.duration)) *
            100
          const bottom = ((k.value - bounds.min) / span) * 100
          const eased = (k.interpolation ?? 'linear') !== 'linear'
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
  const [sourceId, setSourceId] = useState<string>('auto')
  const candidates = overlappingAudioClips(doc, {
    start: clip.start,
    end: clip.start + clip.duration,
  }).filter((c) => c.id !== clip.id)

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

function SpeedSection({ clip }: { clip: Clip }) {
  const apply = useEditorStore((s) => s.apply)
  const playhead = useEditorStore((s) => s.playhead)
  const track = useEditorStore((s) =>
    s.doc.project.tracks.find((t) => t.clips.some((c) => c.id === clip.id)),
  )
  const kind = track?.kind
  const local = Math.min(Math.max(0, playhead - clip.start), clip.duration)
  // The curve, not the static rate, sets a ramped clip's speed, so the static
  // control is disabled rather than pretending to change something.
  const ramped = hasTimeScaleCurve(clip)
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
              {(clip.speed ?? 1).toFixed(2)}×
            </span>
          </div>
          <NamedSlider
            aria-label="Clip speed"
            value={[clip.speed ?? 1]}
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
              (both halves of a linked pair), like reversed clips.
            </p>
          </>
        )}
      </div>
    </>
  )
}

export { PropertyRow as EffectControlsPropertyRow }
