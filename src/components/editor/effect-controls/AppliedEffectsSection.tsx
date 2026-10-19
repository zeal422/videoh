'use client'

import { useEffect, useState } from 'react'
import { ChevronDown, Diamond, Pipette, Plus, RotateCcw, Trash2 } from 'lucide-react'

import { NamedSlider } from '@/components/editor/NamedSlider'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/hooks/use-toast'

import { EditorCommandError } from '@/lib/editor/commands'

import { CHROMA_BOUNDS, EFFECT_KEYFRAME_BOUNDS, effectKeyframeValue } from '@/lib/editor/effects'
import type { EffectType } from '@/lib/editor/effects'
import { BLUR_SHUTTER_MAX, BLUR_SHUTTER_MIN } from '@/lib/editor/constants'
import { findClip, sequenceTracks } from '@/lib/editor/factories'
import { useEditorStore } from '@/lib/editor/store'
import type { Clip, EffectEntry, EffectKeyframeProperty } from '@/lib/editor/types'

const EFFECT_LABELS: Record<EffectType, string> = {
  crop: 'Crop',
  chromaKey: 'Chroma key',
  trackMatte: 'Track matte',
  motionBlur: 'Motion blur',
}

/** Destructive toast for refused effect edits (the InspectorPanel pattern). */
function showError(error: unknown) {
  toast({
    title: 'Update failed',
    description: error instanceof Error ? error.message : String(error),
    variant: 'destructive',
  })
}

/** Refusals surface as toasts; anything else is a bug and rethrows. */
function tryApply(fn: () => void) {
  try {
    fn()
  } catch (error) {
    if (error instanceof EditorCommandError) showError(error)
    else throw error
  }
}

/** Eligible matte sources for a clip: video/text lanes above it in its own sequence. */
function eligibleMatteTracks(
  doc: ReturnType<typeof useEditorStore.getState>['doc'],
  clipId: string,
) {
  const owner = findClip(doc, clipId)
  if (!owner) return []
  const tracks = sequenceTracks(doc, owner.sequenceId)
  const clipIndex = tracks.findIndex((t) => t.id === owner.track.id)
  if (clipIndex === -1) return []
  return tracks.filter((t, i) => i < clipIndex && (t.kind === 'video' || t.kind === 'text'))
}

/**
 * Applied effects list (0.8.6): the clip's stack top-first with per-effect
 * enable, expand, delete and reset. Insertion order is application order;
 * there is no reorder (Premiere has none either). New effects arrive through
 * the picker; the matte entry needs its source track at add time (there is
 * no valid default), so it opens a track submenu.
 */
export function AppliedEffectsSection({ clip }: { clip: Clip }) {
  const doc = useEditorStore((s) => s.doc)
  const playhead = useEditorStore((s) => s.playhead)
  const apply = useEditorStore((s) => s.apply)
  const eyedropper = useEditorStore((s) => s.eyedropper)
  const setEyedropper = useEditorStore((s) => s.setEyedropper)
  const local = Math.min(Math.max(0, playhead - clip.start), clip.duration)
  const entries = clip.effects ?? []
  const matteTargets = eligibleMatteTracks(doc, clip.id)

  // Escape disarms an armed eyedropper even when its card is collapsed or
  // disabled (the card-level listener unmounts with ChromaParams).
  useEffect(() => {
    if (!eyedropper) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setEyedropper(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [eyedropper, setEyedropper])

  const add = (type: EffectType, trackId?: string) =>
    tryApply(() =>
      apply(
        type === 'trackMatte' && trackId
          ? { type: 'addEffect', clipId: clip.id, effectType: type, trackId }
          : { type: 'addEffect', clipId: clip.id, effectType: type },
      ),
    )

  return (
    <div data-testid="applied-effects">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-medium">Effects</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Add effect" className="size-6">
              <Plus className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent aria-label="Add effect">
            <DropdownMenuItem onSelect={() => add('crop')}>Crop</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => add('chromaKey')}>Chroma key</DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Track matte</DropdownMenuSubTrigger>
              <DropdownMenuSubContent aria-label="Matte source track">
                <DropdownMenuLabel>Source track (above this clip)</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {matteTargets.length === 0 && (
                  <DropdownMenuItem disabled>No track above this clip</DropdownMenuItem>
                )}
                {matteTargets.map((t) => (
                  <DropdownMenuItem key={t.id} onSelect={() => add('trackMatte', t.id)}>
                    {t.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuItem onSelect={() => add('motionBlur')}>Motion blur</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {entries.length === 0 && (
        <p className="text-xs text-muted-foreground">No effects. Add one with the plus button.</p>
      )}
      {entries.map((entry) => (
        <EffectCard key={entry.id} clip={clip} entry={entry} playheadLocal={local} />
      ))}
    </div>
  )
}

function EffectCard({
  clip,
  entry,
  playheadLocal,
}: {
  clip: Clip
  entry: EffectEntry
  playheadLocal: number
}) {
  const apply = useEditorStore((s) => s.apply)
  const [open, setOpen] = useState(true)
  const enabled = entry.enabled !== false

  return (
    <div data-testid={`effect-${entry.id}`} className="mb-1 rounded border border-border">
      <div className="flex items-center gap-1 px-2 py-1">
        <Switch
          aria-label={`${EFFECT_LABELS[entry.type]} enabled`}
          checked={enabled}
          onCheckedChange={(v) =>
            tryApply(() =>
              apply({ type: 'setEffectEnabled', clipId: clip.id, effectId: entry.id, enabled: v }),
            )
          }
        />
        <button
          type="button"
          aria-label={`${open ? 'Collapse' : 'Expand'} ${EFFECT_LABELS[entry.type]}`}
          onClick={() => setOpen((o) => !o)}
          className="flex flex-1 items-center gap-1 text-left text-xs font-medium"
        >
          <ChevronDown className={`size-3.5 transition-transform ${open ? '' : '-rotate-90'}`} />
          {EFFECT_LABELS[entry.type]}
        </button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Reset ${EFFECT_LABELS[entry.type]}`}
          title="Reset parameters to defaults (keeps keyframes)"
          className="size-6"
          onClick={() =>
            tryApply(() => apply({ type: 'resetEffect', clipId: clip.id, effectId: entry.id }))
          }
        >
          <RotateCcw className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Remove ${EFFECT_LABELS[entry.type]}`}
          className="size-6"
          onClick={() =>
            tryApply(() => apply({ type: 'removeEffect', clipId: clip.id, effectId: entry.id }))
          }
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
      {open && enabled && (
        <div className="space-y-2 px-2 pb-2">
          {entry.type === 'crop' && (
            <CropParams clip={clip} entry={entry} playheadLocal={playheadLocal} />
          )}
          {entry.type === 'chromaKey' && <ChromaParams clip={clip} entry={entry} />}
          {entry.type === 'trackMatte' && <MatteParams clip={clip} entry={entry} />}
          {entry.type === 'motionBlur' && (
            <EffectKeyframeRow
              clip={clip}
              entry={entry}
              property="shutter"
              label="Shutter angle"
              min={BLUR_SHUTTER_MIN}
              max={BLUR_SHUTTER_MAX}
              step={1}
              unit="°"
              playheadLocal={playheadLocal}
            />
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Keyframable effect param (0.8.6): slider plus a diamond toggle that pins
 * the current value at the playhead or removes the nearest keyframe.
 * PropertyRow-style addressing, scoped to the effect entry (not the flat
 * KeyframeProperty path). No graph or easing picker: the diamond covers the
 * Premiere stopwatch behavior the grill locked.
 */
function EffectKeyframeRow({
  clip,
  entry,
  property,
  label,
  min,
  max,
  step,
  unit,
  playheadLocal,
}: {
  clip: Clip
  entry: EffectEntry
  property: EffectKeyframeProperty
  label: string
  min: number
  max: number
  step: number
  unit: string
  playheadLocal: number
}) {
  const apply = useEditorStore((s) => s.apply)
  const keyframes = entry.keyframes?.[property] ?? []
  const animated = keyframes.length > 0
  const current = effectKeyframeValue(entry, property, playheadLocal)
  const bounds = EFFECT_KEYFRAME_BOUNDS[property]

  const setStatic = (v: number, commit: boolean) => {
    const command = {
      type: 'setEffectParams' as const,
      clipId: clip.id,
      effectId: entry.id,
      params: { [property]: v },
    }
    // Refusals surface as toasts (a bare apply would rethrow into React).
    if (commit) tryApply(() => apply(command))
    else useEditorStore.getState().applyTransient(command)
  }

  // Keyframe writes route through the same surfacing: a vanished entry
  // mid-interaction refuses instead of rethrowing into React.
  const writeCurve = (next: { time: number; value: number }[]) =>
    tryApply(() =>
      apply({
        type: 'setEffectKeyframes',
        clipId: clip.id,
        effectId: entry.id,
        property,
        keyframes: next,
      }),
    )

  const toggleKeyframe = () => {
    if (animated) {
      const nearest = keyframes.reduce<(typeof keyframes)[number] | null>((best, k) => {
        if (!best) return k
        return Math.abs(k.time - playheadLocal) < Math.abs(best.time - playheadLocal) ? k : best
      }, null)
      if (!nearest) return
      writeCurve(keyframes.filter((k) => k !== nearest))
    } else {
      writeCurve([{ time: playheadLocal, value: current }])
    }
  }

  const onSlider = (v: number, commit: boolean) => {
    if (animated) {
      const at = playheadLocal
      const next = keyframes.filter((k) => Math.abs(k.time - at) > 1e-6)
      next.push({ time: at, value: Math.min(bounds.max, Math.max(bounds.min, v)) })
      if (commit) writeCurve(next)
      else {
        useEditorStore.getState().applyTransient({
          type: 'setEffectKeyframes',
          clipId: clip.id,
          effectId: entry.id,
          property,
          keyframes: next,
        })
      }
      return
    }
    setStatic(v, commit)
  }

  return (
    <div data-testid={`fx-prop-${entry.id}-${property}`} className="space-y-1">
      <div className="flex items-center justify-between">
        <Label className="text-xs">
          {label}{' '}
          <span className="text-muted-foreground">
            {current.toFixed(step < 1 ? 2 : 0)}
            {unit}
          </span>
        </Label>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`${animated ? 'Remove' : 'Add'} ${label} keyframe`}
          data-testid={`fx-kf-${entry.id}-${property}`}
          data-active={animated}
          className={`size-6 ${animated ? 'text-amber-500' : 'text-muted-foreground'}`}
          onClick={toggleKeyframe}
        >
          <Diamond className="size-3" fill={animated ? 'currentColor' : 'none'} />
        </Button>
      </div>
      <NamedSlider
        aria-label={`${label} value`}
        value={[current]}
        min={min}
        max={max}
        step={step}
        onValueChange={([v]) => onSlider(v, false)}
        onValueCommit={([v]) => onSlider(v, true)}
      />
    </div>
  )
}

/** Static (non-animated) effect param slider with transient drag + commit. */
function StaticSlider({
  clipId,
  effectId,
  label,
  value,
  display,
  min,
  max,
  step,
  param,
}: {
  clipId: string
  effectId: string
  label: string
  value: number
  display: string
  min: number
  max: number
  step: number
  param: string
}) {
  const apply = useEditorStore((s) => s.apply)
  const onSlider = (v: number, commit: boolean) => {
    const command = {
      type: 'setEffectParams' as const,
      clipId,
      effectId,
      params: { [param]: v },
    }
    if (commit) tryApply(() => apply(command))
    else useEditorStore.getState().applyTransient(command)
  }
  return (
    <div className="space-y-1" data-testid={`fx-static-${param}`}>
      <Label className="text-xs">
        {label} <span className="text-muted-foreground">{display}</span>
      </Label>
      <NamedSlider
        aria-label={`${label} value`}
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={([v]) => onSlider(v, false)}
        onValueCommit={([v]) => onSlider(v, true)}
      />
    </div>
  )
}

function CropParams({
  clip,
  entry,
  playheadLocal,
}: {
  clip: Clip
  entry: Extract<EffectEntry, { type: 'crop' }>
  playheadLocal: number
}) {
  const apply = useEditorStore((s) => s.apply)
  return (
    <>
      {(['left', 'right', 'top', 'bottom', 'feather'] as const).map((p) => (
        <EffectKeyframeRow
          key={p}
          clip={clip}
          entry={entry}
          property={p}
          label={p === 'feather' ? 'Feather' : p[0].toUpperCase() + p.slice(1)}
          min={EFFECT_KEYFRAME_BOUNDS[p].min}
          max={EFFECT_KEYFRAME_BOUNDS[p].max}
          step={0.5}
          unit="%"
          playheadLocal={playheadLocal}
        />
      ))}
      <div className="flex items-center justify-between">
        <Label className="text-xs">Zoom to fill</Label>
        <Switch
          aria-label="Crop zoom to fill"
          checked={entry.zoom === true}
          onCheckedChange={(v) =>
            tryApply(() =>
              apply({
                type: 'setEffectParams',
                clipId: clip.id,
                effectId: entry.id,
                params: { zoom: v },
              }),
            )
          }
        />
      </div>
    </>
  )
}

function ChromaParams({
  clip,
  entry,
}: {
  clip: Clip
  entry: Extract<EffectEntry, { type: 'chromaKey' }>
}) {
  const apply = useEditorStore((s) => s.apply)
  const setEyedropper = useEditorStore((s) => s.setEyedropper)
  const armed = useEditorStore((s) => s.eyedropper)
  const isArmed = armed?.clipId === clip.id && armed?.effectId === entry.id
  const [draft, setDraft] = useState<string | null>(null)

  // Escape disarms (sampling also disarms; doc edits disarm via the store).
  useEffect(() => {
    if (!isArmed) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setEyedropper(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isArmed, setEyedropper])

  const commitKey = (value: string) => {
    setDraft(null)
    tryApply(() =>
      apply({
        type: 'setEffectParams',
        clipId: clip.id,
        effectId: entry.id,
        params: { key: value },
      }),
    )
  }
  return (
    <>
      <div className="flex items-end gap-2">
        <div className="flex-1 space-y-1">
          <Label className="text-xs">Key color</Label>
          <Input
            aria-label="Key color hex"
            value={draft ?? entry.key ?? '#00ff00'}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              if (draft !== null) commitKey(draft)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && draft !== null) commitKey(draft)
            }}
            className="h-7 font-mono text-xs"
          />
        </div>
        <Button
          variant={isArmed ? 'default' : 'outline'}
          size="sm"
          aria-label={isArmed ? 'Cancel eyedropper' : 'Pick key color from monitor'}
          title={
            isArmed
              ? 'Click the monitor to sample (Esc cancels)'
              : 'Sample from the Program Monitor'
          }
          onClick={() => setEyedropper(isArmed ? null : { clipId: clip.id, effectId: entry.id })}
        >
          <Pipette className="size-3.5" />
        </Button>
      </div>
      {isArmed && (
        <p className="text-xs text-amber-400">
          Click the Program Monitor to sample the key color. Sampling reads the finished (already
          keyed) frame, so reset the key first to pick again.
        </p>
      )}
      <StaticSlider
        clipId={clip.id}
        effectId={entry.id}
        label="Similarity"
        value={entry.similarity ?? 0}
        display={(entry.similarity ?? 0).toFixed(2)}
        min={CHROMA_BOUNDS.similarity.min}
        max={CHROMA_BOUNDS.similarity.max}
        step={0.01}
        param="similarity"
      />
      <StaticSlider
        clipId={clip.id}
        effectId={entry.id}
        label="Blend"
        value={entry.blend ?? 0}
        display={(entry.blend ?? 0).toFixed(2)}
        min={CHROMA_BOUNDS.blend.min}
        max={CHROMA_BOUNDS.blend.max}
        step={0.01}
        param="blend"
      />
      <StaticSlider
        clipId={clip.id}
        effectId={entry.id}
        label="Clip black"
        value={entry.clipBlack ?? 0}
        display={(entry.clipBlack ?? 0).toFixed(2)}
        min={CHROMA_BOUNDS.clip.min}
        max={CHROMA_BOUNDS.clip.max}
        step={0.01}
        param="clipBlack"
      />
      <StaticSlider
        clipId={clip.id}
        effectId={entry.id}
        label="Clip white"
        value={entry.clipWhite ?? 1}
        display={(entry.clipWhite ?? 1).toFixed(2)}
        min={CHROMA_BOUNDS.clip.min}
        max={CHROMA_BOUNDS.clip.max}
        step={0.01}
        param="clipWhite"
      />
      <StaticSlider
        clipId={clip.id}
        effectId={entry.id}
        label="Despill"
        value={entry.despill ?? 0}
        display={(entry.despill ?? 0).toFixed(2)}
        min={CHROMA_BOUNDS.despill.min}
        max={CHROMA_BOUNDS.despill.max}
        step={0.01}
        param="despill"
      />
    </>
  )
}

function MatteParams({
  clip,
  entry,
}: {
  clip: Clip
  entry: Extract<EffectEntry, { type: 'trackMatte' }>
}) {
  const doc = useEditorStore((s) => s.doc)
  const apply = useEditorStore((s) => s.apply)
  const targets = eligibleMatteTracks(doc, clip.id)
  return (
    <>
      <div className="space-y-1">
        <Label className="text-xs">Source track</Label>
        <Select
          value={entry.trackId ?? ''}
          onValueChange={(v) =>
            tryApply(() =>
              apply({
                type: 'setEffectParams',
                clipId: clip.id,
                effectId: entry.id,
                params: { trackId: v },
              }),
            )
          }
        >
          <SelectTrigger aria-label="Matte source track" className="h-7 text-xs">
            <SelectValue placeholder="Select source track" />
          </SelectTrigger>
          <SelectContent>
            {targets.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Composite using</Label>
        <Select
          value={entry.mode ?? 'luma'}
          onValueChange={(v: 'luma' | 'alpha') =>
            tryApply(() =>
              apply({
                type: 'setEffectParams',
                clipId: clip.id,
                effectId: entry.id,
                params: { mode: v },
              }),
            )
          }
        >
          <SelectTrigger aria-label="Matte composite mode" className="h-7 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="luma">Luma</SelectItem>
            <SelectItem value="alpha">Alpha</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center justify-between">
        <Label className="text-xs">Reverse</Label>
        <Switch
          aria-label="Reverse matte"
          checked={entry.reverse === true}
          onCheckedChange={(v) =>
            tryApply(() =>
              apply({
                type: 'setEffectParams',
                clipId: clip.id,
                effectId: entry.id,
                params: { reverse: v },
              }),
            )
          }
        />
      </div>
    </>
  )
}
