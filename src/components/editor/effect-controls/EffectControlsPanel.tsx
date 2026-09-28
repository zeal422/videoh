'use client'

import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Diamond, Plus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
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
import {
  animatedValue,
  clampPropertyValue,
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
import type { Clip, Keyframe } from '@/lib/editor/types'

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
  if (property === 'scale') return `${value.toFixed(2)}×`
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
  const current = animatedValue(clip, property, playheadLocal)
  const cfg = sliderConfig(property)

  const setCurve = (next: Keyframe[]) =>
    apply({ type: 'setClipKeyframes', clipId: clip.id, property, keyframes: next })

  const toggleKeyframe = () => {
    if (animated) {
      // Remove the keyframe at (or nearest) the playhead; clear when it is the last.
      const nearest = keyframes.reduce<Keyframe | null>((best, k) => {
        if (!best) return k
        return Math.abs(k.time - playheadLocal) < Math.abs(best.time - playheadLocal) ? k : best
      }, null)
      if (!nearest) return
      const next = keyframes.filter((k) => k !== nearest)
      setCurve(next)
    } else {
      // First keyframe: pin the current static value at the playhead.
      setCurve([{ time: playheadLocal, value: staticPropertyValue(clip, property) }])
    }
  }

  const onSlider = (v: number, commit: boolean) => {
    if (animated) {
      // Editing an animated property writes/updates a keyframe at the playhead.
      const next = keyframes.filter((k) => Math.abs(k.time - playheadLocal) > 1e-6)
      next.push({ time: playheadLocal, value: clampPropertyValue(property, v) })
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
      <Slider
        aria-label={`${label} value`}
        value={[current]}
        min={cfg.min}
        max={cfg.max}
        step={cfg.step}
        onValueChange={([v]) => onSlider(v, false)}
        onValueCommit={([v]) => onSlider(v, true)}
      />
      {animated && <KeyframeGraph clip={clip} property={property} />}
    </div>
  )
}

/** Light graph: keyframe dots over the clip duration; drag a dot to move it. */
function KeyframeGraph({ clip, property }: { clip: Clip; property: KeyframeProperty }) {
  const keyframes = clip.keyframes?.[property] ?? []
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
        i === dragIndex ? { ...k, time: Math.max(0, Math.min(clip.duration, t)) } : k,
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

  return (
    <div
      ref={wrapRef}
      data-testid={`kf-graph-${property}`}
      className="relative h-10 w-full rounded border border-border bg-muted/30"
    >
      {keyframes.map((k, i) => {
        const left =
          (Math.max(0, Math.min(clip.duration, k.time)) / Math.max(1e-6, clip.duration)) * 100
        const bottom = ((k.value - bounds.min) / span) * 100
        return (
          <div
            key={`${i}-${k.time}`}
            data-testid={`kf-dot-${property}-${i}`}
            role="slider"
            tabIndex={0}
            aria-label={`${property} keyframe ${i + 1}`}
            aria-valuenow={Number(k.time.toFixed(2))}
            aria-valuemin={0}
            aria-valuemax={clip.duration}
            className="absolute size-2.5 -translate-x-1/2 translate-y-1/2 cursor-ew-resize rounded-full border border-amber-600 bg-amber-400"
            style={{ left: `${left}%`, bottom: `${Math.max(0, Math.min(100, bottom))}%` }}
            onPointerDown={(e) => {
              e.stopPropagation()
              tokenRef.current = useEditorStore.getState().beginTransient(e.pointerId)
              setPointerId(e.pointerId)
              setDragIndex(i)
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
        <Slider
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
                <Slider
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
  const track = useEditorStore((s) =>
    s.doc.project.tracks.find((t) => t.clips.some((c) => c.id === clip.id)),
  )
  const kind = track?.kind

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
          <Slider
            aria-label="Clip speed"
            value={[clip.speed ?? 1]}
            min={SPEED_MIN}
            max={SPEED_MAX}
            step={0.05}
            onValueChange={([v]) =>
              useEditorStore
                .getState()
                .applyTransient({ type: 'setClipSpeed', clipId: clip.id, speed: v })
            }
            onValueCommit={([v]) => apply({ type: 'setClipSpeed', clipId: clip.id, speed: v })}
          />
        </div>
        {kind === 'video' && (
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
          Alt-drag a clip edge on the timeline to rate-stretch. Reversed clips play stepped in the
          preview and frame-accurate in the export; their audio is dropped.
        </p>
      </div>
    </>
  )
}

export { PropertyRow as EffectControlsPropertyRow }
