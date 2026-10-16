'use client'

import { useRef } from 'react'
import { Crosshair, Link2, Loader2 } from 'lucide-react'

import { NamedSlider } from '@/components/editor/NamedSlider'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { toast } from '@/hooks/use-toast'

import { EditorCommandError } from '@/lib/editor/commands'
import {
  createBuiltinTextPresets,
  findClip,
  findMedia,
  nextClipOnTrack,
  uid,
} from '@/lib/editor/factories'
import { linkedAudioTwin } from '@/lib/editor/links'
import { parseCubeLut } from '@/lib/editor/lut'
import { formatTime } from '@/lib/editor/time'
import {
  TEMPERATURE_MAX,
  TEMPERATURE_MIN,
  TINT_MAX,
  TINT_MIN,
  TRANSITION_MAX,
  TRANSITION_MIN,
} from '@/lib/editor/constants'
import { useEditorStore } from '@/lib/editor/store'
import type { Clip, TextPreset, TextStyle, Transition } from '@/lib/editor/types'
import { useState } from 'react'
import { EffectControlsPanel } from '@/components/editor/effect-controls/EffectControlsPanel'
import { cn } from '@/lib/utils'

/**
 * Right panel: properties of the selected clip (audio gain/mute, text styling,
 * crossfade transition) or project settings when nothing is selected. When a
 * clip is selected the panel gains an Effect Controls tab (keyframes + audio
 * shaping + speed/reverse).
 */
export function InspectorPanel({ className }: { className?: string }) {
  const doc = useEditorStore((s) => s.doc)
  const selection = useEditorStore((s) => s.selection)

  const selected = selection ? findClip(doc, selection)?.clip : undefined
  const selectedTrack = selected ? findClip(doc, selected.id)?.track : undefined
  return (
    <aside aria-label="Inspector" className={cn('flex min-w-0 flex-col bg-card', className)}>
      {selected && selectedTrack ? (
        <ClipPanel key={selected.id} clip={selected} trackKind={selectedTrack.kind} />
      ) : (
        <div className="editor-scroll min-h-0 flex-1 overflow-y-auto">
          <ProjectInspector />
        </div>
      )}
    </aside>
  )
}

/** Two-tab strip: Clip properties / Effect Controls (keyframes + audio + speed). */
function ClipPanel({ clip, trackKind }: { clip: Clip; trackKind: string }) {
  const [tab, setTab] = useState<'clip' | 'effects'>('clip')
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        role="tablist"
        aria-label="Inspector tabs"
        className="mx-4 mt-3 grid shrink-0 grid-cols-2 rounded-md bg-muted p-0.5 text-xs"
      >
        {(
          [
            ['clip', 'Clip'],
            ['effects', 'Effect Controls'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            role="tab"
            aria-selected={tab === value}
            data-testid={`inspector-tab-${value}`}
            className={cn(
              'rounded px-2 py-1 font-medium transition-colors',
              tab === value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground',
            )}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="editor-scroll min-h-0 flex-1 overflow-y-auto">
        {tab === 'clip' ? (
          <ClipInspector clip={clip} trackKind={trackKind} />
        ) : (
          <EffectControlsPanel clip={clip} trackKind={trackKind} />
        )}
      </div>
    </div>
  )
}

/** Radix Select cannot carry an empty value, so "no LUT" gets a sentinel. */
const LUT_NONE = '__none__'

/** The two static color-grade controls and their bounds (0 = neutral). */
const GRADE_CONTROLS = [
  { key: 'temperature', label: 'Temperature', min: TEMPERATURE_MIN, max: TEMPERATURE_MAX },
  { key: 'tint', label: 'Tint', min: TINT_MIN, max: TINT_MAX },
] as const

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3 px-4 py-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </div>
  )
}

function ClipInspector({ clip, trackKind }: { clip: Clip; trackKind: string }) {
  const doc = useEditorStore((s) => s.doc)
  const apply = useEditorStore((s) => s.apply)
  const asset = findMedia(doc, clip.mediaId)
  const isText = clip.text !== undefined && trackKind === 'text'
  const hasAudio =
    !!asset && (asset.kind === 'audio' || (asset.kind === 'video' && trackKind === 'video'))
  // Opacity applies to every visually rendered clip (video/image/text).
  const isVisual = isText || (!!asset && asset.kind !== 'audio')
  // Linked A/V pair: gain/mute live on the AUDIO twin, whichever half is
  // selected (muting the video half would unmask its embedded audio and
  // double-play against the twin).
  const audibleTwin = linkedAudioTwin(doc, clip)
  const audioClip = audibleTwin ?? clip

  const track = findClip(doc, clip.id)?.track
  const nextClip = track ? nextClipOnTrack(track, clip) : undefined
  const luts = doc.project.luts ?? []
  const lutFileRef = useRef<HTMLInputElement>(null)

  const showError = (error: unknown) =>
    toast({
      title: 'Update failed',
      description: error instanceof Error ? error.message : String(error),
      variant: 'destructive',
    })

  const tryApply = (fn: () => void) => {
    try {
      fn()
    } catch (error) {
      if (error instanceof EditorCommandError) showError(error)
      else throw error
    }
  }

  // Import and assignment ride ONE command batch, so a load is one undo step and
  // a refusal (an unreadable file, a full library) writes nothing at all.
  const onLutFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // re-picking the same file must fire again
    if (!file) return
    // The id is captured BEFORE the await. Reading a .cube is async, so the
    // clip can be deleted while it is in flight; dispatching then would fail on
    // a clip that is gone and toast a failure for a benign race, so the whole
    // batch (import + assign) is skipped instead.
    const clipId = clip.id
    try {
      const lut = parseCubeLut(await file.text(), {
        name: file.name.replace(/\.cube$/i, ''),
      })
      if (!findClip(useEditorStore.getState().doc, clipId)) return
      apply([
        { type: 'importProjectLut', lut },
        { type: 'setClipLut', clipId, lutId: lut.id },
      ])
    } catch (error) {
      showError(error)
    }
  }

  return (
    <div className="pb-6">
      <Section title={isText ? 'Text clip' : asset ? asset.name : 'Clip'}>
        <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
          {asset && (
            <>
              <span>Source: {formatTime(asset.duration)}</span>
              <span>
                {asset.width}×{asset.height}
              </span>
            </>
          )}
          <span>Track: {trackKind}</span>
          <span>Trim: {formatTime(clip.inPoint)} in</span>
        </div>
        {audioClip.id !== clip.id && (
          <p
            data-testid="linked-av-hint"
            className="flex items-center gap-1.5 text-[11px] leading-relaxed text-muted-foreground"
          >
            <Link2 className="size-3.5 shrink-0" aria-hidden="true" />
            Linked with the audio clip — audio edits (gain, mute) apply to the pair. Right-click the
            clip to unlink.
          </p>
        )}
      </Section>
      <Separator />

      <Section title="Timing">
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label="Start (s)"
            value={clip.start}
            step={0.1}
            onCommit={(v) =>
              tryApply(() =>
                apply({
                  type: 'moveClip',
                  clipId: clip.id,
                  trackId: track?.id ?? '',
                  start: v,
                }),
              )
            }
          />
          <NumberField
            label="Duration (s)"
            value={clip.duration}
            step={0.1}
            onCommit={(v) =>
              tryApply(() =>
                apply({
                  type: 'trimClip',
                  clipId: clip.id,
                  start: clip.start,
                  inPoint: clip.inPoint,
                  duration: v,
                  // The start stays put, so this is the tail edge gaining or
                  // giving back source (see TrimEdge).
                  edge: 'tail',
                }),
              )
            }
          />
        </div>
      </Section>
      <Separator />

      {isVisual && (
        <>
          <Section title="Opacity">
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <Label htmlFor="opacity" className="text-xs">
                  Opacity
                </Label>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {Math.round((clip.opacity ?? 1) * 100)}%
                </span>
              </div>
              <NamedSlider
                id="opacity"
                aria-label="Clip opacity percent"
                value={[Math.round((clip.opacity ?? 1) * 100)]}
                min={0}
                max={100}
                step={5}
                onValueChange={([v]) =>
                  useEditorStore.getState().applyTransient({
                    type: 'setClipOpacity',
                    clipId: clip.id,
                    opacity: v / 100,
                  })
                }
                onValueCommit={([v]) =>
                  apply({
                    type: 'setClipOpacity',
                    clipId: clip.id,
                    opacity: v / 100,
                  })
                }
              />
              <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                Lower it to see through to the tracks below — layering works like Photoshop: higher
                tracks render on top of lower ones.
              </p>
            </div>
          </Section>
          <Separator />

          <Section title="Color grade">
            <div className="space-y-3">
              {GRADE_CONTROLS.map(({ key, label, min, max }) => {
                const value = clip[key] ?? 0
                const setGrade = (next: number, commit: boolean) => {
                  const values = {
                    temperature: clip.temperature ?? 0,
                    tint: clip.tint ?? 0,
                    [key]: next,
                  }
                  const command = {
                    type: 'setClipColorParams' as const,
                    clipId: clip.id,
                    ...values,
                  }
                  if (commit) apply(command)
                  else useEditorStore.getState().applyTransient(command)
                }
                return (
                  <div key={key}>
                    <div className="mb-1.5 flex items-center justify-between">
                      <Label htmlFor={`grade-${key}`} className="text-xs">
                        {label}
                      </Label>
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {value > 0 ? `+${Math.round(value)}` : Math.round(value)}
                      </span>
                    </div>
                    <NamedSlider
                      id={`grade-${key}`}
                      aria-label={label}
                      value={[value]}
                      min={min}
                      max={max}
                      step={1}
                      onValueChange={([v]) => setGrade(v, false)}
                      onValueCommit={([v]) => setGrade(v, true)}
                    />
                  </div>
                )
              })}
              {!isText && (
                <div>
                  <div className="mb-1.5 flex items-center justify-between">
                    <Label htmlFor="clip-lut" className="text-xs">
                      LUT (.cube)
                    </Label>
                    <span className="text-[11px] text-muted-foreground">
                      {clip.lutId
                        ? (luts.find((l) => l.id === clip.lutId)?.name ?? 'missing')
                        : 'None'}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Select
                      value={clip.lutId ?? LUT_NONE}
                      onValueChange={(value) =>
                        tryApply(() =>
                          apply({
                            type: 'setClipLut',
                            clipId: clip.id,
                            lutId: value === LUT_NONE ? null : value,
                          }),
                        )
                      }
                    >
                      <SelectTrigger
                        id="clip-lut"
                        aria-label="Clip LUT"
                        data-testid="lut-select"
                        className="h-8 text-xs"
                      >
                        <SelectValue placeholder="None" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={LUT_NONE}>None</SelectItem>
                        {luts.map((lut) => (
                          <SelectItem key={lut.id} value={lut.id}>
                            {lut.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      data-testid="lut-load"
                      className="h-8 shrink-0 text-xs"
                      onClick={() => lutFileRef.current?.click()}
                    >
                      Load .cube
                    </Button>
                    <input
                      ref={lutFileRef}
                      type="file"
                      accept=".cube"
                      aria-label="Load .cube file"
                      data-testid="lut-file"
                      className="hidden"
                      onChange={onLutFile}
                    />
                  </div>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                    Loading a cube adds it to the project library and assigns it to this clip. A 1D
                    cube applies as per-channel shapers through the shared filter; a 3D cube runs a
                    pixel pass in both the preview and the export.
                  </p>
                </div>
              )}
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Temperature warms (right) or cools (left) the picture; tint shifts it between green
                and magenta. Both grade the preview and the export through one shared SVG matrix, so
                what you see is what renders.
              </p>
            </div>
          </Section>
          <Separator />
        </>
      )}

      {hasAudio && (
        <>
          <Section title="Audio">
            <div className="space-y-3">
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <Label htmlFor="gain" className="text-xs">
                    Gain
                  </Label>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {Math.round((audioClip.gain ?? 1) * 100)}%
                  </span>
                </div>
                <NamedSlider
                  id="gain"
                  aria-label="Clip gain percent"
                  value={[Math.round((audioClip.gain ?? 1) * 100)]}
                  min={0}
                  max={200}
                  step={5}
                  onValueChange={([v]) =>
                    useEditorStore.getState().applyTransient({
                      type: 'setClipGain',
                      clipId: audioClip.id,
                      gain: v / 100,
                    })
                  }
                  onValueCommit={([v]) =>
                    apply({
                      type: 'setClipGain',
                      clipId: audioClip.id,
                      gain: v / 100,
                    })
                  }
                />
              </div>
              <div className="flex items-center justify-between">
                <Label htmlFor="mute" className="text-xs">
                  Mute clip
                </Label>
                <Switch
                  id="mute"
                  aria-label="Mute clip"
                  checked={!!audioClip.muted}
                  onCheckedChange={(checked) =>
                    apply({
                      type: 'setClipMuted',
                      clipId: audioClip.id,
                      muted: checked,
                    })
                  }
                />
              </div>
            </div>
          </Section>
          <Separator />
        </>
      )}

      {isText && <TextFields clip={clip} />}

      <Section title="Transition out">
        {nextClip ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label htmlFor="transition" className="text-xs">
                Transition to next clip
              </Label>
              <Switch
                id="transition"
                aria-label="Enable transition"
                checked={!!clip.transitionOut}
                onCheckedChange={(checked) => {
                  tryApply(() => {
                    if (checked) {
                      apply({
                        type: 'addTransition',
                        clipId: clip.id,
                        duration: 0.5,
                      })
                    } else {
                      apply({ type: 'removeTransition', clipId: clip.id })
                    }
                  })
                }}
              />
            </div>
            {clip.transitionOut && (
              <div>
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <Label htmlFor="transition-type" className="text-xs">
                    Type
                  </Label>
                  <Select
                    value={clip.transitionOut.type}
                    onValueChange={(v) => {
                      const current = clip.transitionOut
                      if (!current) return
                      tryApply(() =>
                        apply({
                          type: 'addTransition',
                          clipId: clip.id,
                          duration: current.duration,
                          transitionType: v as Transition['type'],
                        }),
                      )
                    }}
                  >
                    <SelectTrigger
                      id="transition-type"
                      className="h-8 w-36"
                      aria-label="Transition type"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="crossfade">Cross dissolve</SelectItem>
                      <SelectItem value="dipToBlack">Dip to black</SelectItem>
                      <SelectItem value="wipe">Wipe</SelectItem>
                      <SelectItem value="slide">Slide</SelectItem>
                      <SelectItem value="push">Push</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {(clip.transitionOut.type === 'wipe' ||
                  clip.transitionOut.type === 'slide' ||
                  clip.transitionOut.type === 'push') && (
                  <div className="mb-1.5 flex items-center justify-between gap-2">
                    <Label htmlFor="transition-direction" className="text-xs">
                      Direction
                    </Label>
                    <Select
                      value={clip.transitionOut.direction ?? 'left'}
                      onValueChange={(v) => {
                        const current = clip.transitionOut
                        if (!current) return
                        tryApply(() =>
                          apply({
                            type: 'addTransition',
                            clipId: clip.id,
                            duration: current.duration,
                            transitionType: current.type,
                            direction: v as Transition['direction'],
                          }),
                        )
                      }}
                    >
                      <SelectTrigger
                        id="transition-direction"
                        className="h-8 w-36"
                        aria-label="Transition direction"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="left">From left</SelectItem>
                        <SelectItem value="right">From right</SelectItem>
                        <SelectItem value="up">From top</SelectItem>
                        <SelectItem value="down">From bottom</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}
                {clip.transitionOut.type === 'wipe' && (
                  <div className="mb-1.5 flex items-center justify-between gap-2">
                    <Label htmlFor="transition-edge" className="text-xs">
                      Edge
                    </Label>
                    <Select
                      value={clip.transitionOut.edge ?? 'hard'}
                      onValueChange={(v) => {
                        const current = clip.transitionOut
                        if (!current) return
                        tryApply(() =>
                          apply({
                            type: 'addTransition',
                            clipId: clip.id,
                            duration: current.duration,
                            transitionType: current.type,
                            direction: current.direction ?? 'left',
                            edge: v as Transition['edge'],
                          }),
                        )
                      }}
                    >
                      <SelectTrigger
                        id="transition-edge"
                        className="h-8 w-36"
                        aria-label="Wipe edge"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="hard">Hard</SelectItem>
                        <SelectItem value="feathered">Feathered</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}
                {clip.transitionOut.type === 'wipe' &&
                  (clip.transitionOut.edge ?? 'hard') === 'feathered' && (
                    <div>
                      <div className="mb-1.5 flex items-center justify-between">
                        <Label htmlFor="transition-feather" className="text-xs">
                          Feather
                        </Label>
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {((clip.transitionOut.feather ?? 0.1) * 100).toFixed(0)}%
                        </span>
                      </div>
                      <NamedSlider
                        id="transition-feather"
                        aria-label="Wipe feather width"
                        value={[clip.transitionOut.feather ?? 0.1]}
                        min={0}
                        max={0.5}
                        step={0.01}
                        onValueChange={([v]) =>
                          useEditorStore.getState().applyTransient({
                            type: 'addTransition',
                            clipId: clip.id,
                            duration: clip.transitionOut?.duration ?? 0.5,
                            transitionType: clip.transitionOut?.type ?? 'wipe',
                            direction: clip.transitionOut?.direction ?? 'left',
                            edge: 'feathered',
                            feather: v,
                          })
                        }
                        onValueCommit={([v]) =>
                          tryApply(() =>
                            apply({
                              type: 'addTransition',
                              clipId: clip.id,
                              duration: clip.transitionOut?.duration ?? 0.5,
                              transitionType: clip.transitionOut?.type ?? 'wipe',
                              direction: clip.transitionOut?.direction ?? 'left',
                              edge: 'feathered',
                              feather: v,
                            }),
                          )
                        }
                      />
                    </div>
                  )}
                <div className="mb-1.5 flex items-center justify-between">
                  <Label htmlFor="transition-duration" className="text-xs">
                    Duration
                  </Label>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {clip.transitionOut.duration.toFixed(2)}s
                  </span>
                </div>
                <NamedSlider
                  id="transition-duration"
                  aria-label="Transition duration seconds"
                  value={[clip.transitionOut.duration]}
                  min={TRANSITION_MIN}
                  max={Math.min(TRANSITION_MAX, clip.duration, nextClip.duration)}
                  step={0.05}
                  onValueChange={([v]) =>
                    useEditorStore.getState().applyTransient({
                      type: 'addTransition',
                      clipId: clip.id,
                      duration: v,
                    })
                  }
                  onValueCommit={([v]) =>
                    tryApply(() =>
                      apply({
                        type: 'addTransition',
                        clipId: clip.id,
                        duration: v,
                      }),
                    )
                  }
                />
                <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                  The next clip is pulled left to create the transition overlap. Cross dissolve
                  blends the pictures; dip to black fades the pair through black while lower tracks
                  stay visible. A wipe reveals the next picture from one edge, a slide moves it over
                  the current one, and a push moves both pictures together. Video/audio ramp
                  automatically during the fade.
                </p>
              </div>
            )}
          </div>
        ) : (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Add another clip after this one on the same track to create a cross-dissolve.
          </p>
        )}
      </Section>
    </div>
  )
}

function TextFields({ clip }: { clip: Clip }) {
  const apply = useEditorStore((s) => s.apply)
  const style = clip.style!

  const setStyle = (patch: Partial<TextStyle>) =>
    apply({ type: 'setTextStyle', clipId: clip.id, style: patch })

  return (
    <>
      <Section title="Text content">
        <Textarea
          aria-label="Text content"
          value={clip.text ?? ''}
          rows={3}
          onChange={(e) =>
            apply({
              type: 'setTextContent',
              clipId: clip.id,
              text: e.target.value,
            })
          }
        />
      </Section>
      <Separator />
      <Section title="Text style">
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <NumberField
              label="Size (px)"
              value={style.fontSize}
              min={8}
              max={400}
              step={2}
              onCommit={(v) => setStyle({ fontSize: v })}
            />
            <div>
              <Label htmlFor="text-color" className="text-xs">
                Color
              </Label>
              <Input
                id="text-color"
                type="color"
                value={style.color}
                onChange={(e) => setStyle({ color: e.target.value })}
                className="mt-1 h-8 w-full cursor-pointer p-0.5"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-xs">Align</Label>
              <Select
                value={style.align}
                onValueChange={(v) => setStyle({ align: v as TextStyle['align'] })}
              >
                <SelectTrigger className="mt-1 h-8" aria-label="Text align">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="left">Left</SelectItem>
                  <SelectItem value="center">Center</SelectItem>
                  <SelectItem value="right">Right</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5 pt-4">
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={style.bold}
                  onChange={(e) => setStyle({ bold: e.target.checked })}
                  className="accent-foreground"
                />
                Bold
              </label>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={style.italic}
                  onChange={(e) => setStyle({ italic: e.target.checked })}
                  className="accent-foreground"
                />
                Italic
              </label>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={style.shadow}
                  onChange={(e) => setStyle({ shadow: e.target.checked })}
                  className="accent-foreground"
                />
                Shadow
              </label>
            </div>
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between">
              <Label className="text-xs">Position X</Label>
              <span className="text-xs text-muted-foreground">{Math.round(style.x * 100)}%</span>
            </div>
            <NamedSlider
              aria-label="Text position X percent"
              value={[style.x]}
              min={0}
              max={1}
              step={0.01}
              onValueChange={([v]) => setStyle({ x: v })}
            />
            <div className="mb-1 mt-2 flex items-center justify-between">
              <Label className="text-xs">Position Y</Label>
              <span className="text-xs text-muted-foreground">{Math.round(style.y * 100)}%</span>
            </div>
            <NamedSlider
              aria-label="Text position Y percent"
              value={[style.y]}
              min={0}
              max={1}
              step={0.01}
              onValueChange={([v]) => setStyle({ y: v })}
            />
          </div>
        </div>
      </Section>
      <Separator />
      <TextPresetFields clip={clip} />
      <Separator />
    </>
  )
}

/**
 * Title preset library (0.8.3): apply a built-in or user preset to this
 * clip, save this clip's style under a new name, rename or delete a user
 * preset. The only management surface (plan decision 7): it renders only
 * with a text clip selected, so no selection means no preset UI.
 */
function TextPresetFields({ clip }: { clip: Clip }) {
  const doc = useEditorStore((s) => s.doc)
  const apply = useEditorStore((s) => s.apply)
  const builtins = createBuiltinTextPresets()
  const user = doc.project.textPresets ?? []
  const [selectedId, setSelectedId] = useState<TextPreset['id']>(builtins[0].id)
  const [saveName, setSaveName] = useState('')
  const [renameName, setRenameName] = useState('')
  const selected = [...builtins, ...user].find((p) => p.id === selectedId) ?? builtins[0]
  const isUserPreset = user.some((p) => p.id === selected.id)

  const showError = (error: unknown) =>
    toast({
      title: 'Preset failed',
      description: error instanceof Error ? error.message : String(error),
      variant: 'destructive',
    })

  const tryApply = (fn: () => void) => {
    try {
      fn()
    } catch (error) {
      if (error instanceof EditorCommandError) showError(error)
      else throw error
    }
  }

  return (
    <Section title="Presets">
      <div className="space-y-3">
        <div>
          <Label className="text-xs">Title preset</Label>
          <Select
            value={selected.id}
            onValueChange={(id) => {
              // A typed rename belongs to the preset it was typed for:
              // switching presets with stale text would rename the wrong one.
              setSelectedId(id)
              setRenameName('')
            }}
          >
            <SelectTrigger className="mt-1 h-8" aria-label="Title preset">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>Built-in</SelectLabel>
                {builtins.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectGroup>
              {user.length > 0 && (
                <SelectGroup>
                  <SelectLabel>Saved</SelectLabel>
                  {user.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}
            </SelectContent>
          </Select>
        </div>
        <Button
          variant="secondary"
          size="sm"
          className="w-full"
          onClick={() =>
            tryApply(() => apply({ type: 'setTextStyle', clipId: clip.id, style: selected.style }))
          }
        >
          Apply preset
        </Button>
        <div>
          <Label htmlFor="preset-save-name" className="text-xs">
            Save current style
          </Label>
          <div className="mt-1 flex gap-2">
            <Input
              id="preset-save-name"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              placeholder="Preset name"
              className="h-8"
            />
            <Button
              size="sm"
              onClick={() =>
                tryApply(() => {
                  if (!clip.style) throw new EditorCommandError('Not a text clip')
                  apply({
                    type: 'saveTextPreset',
                    preset: { id: uid('preset'), name: saveName, style: clip.style },
                  })
                  setSaveName('')
                })
              }
            >
              Save
            </Button>
          </div>
        </div>
        {isUserPreset && (
          <div className="space-y-2">
            <div className="flex gap-2">
              <Input
                aria-label="Preset name"
                value={renameName}
                onChange={(e) => setRenameName(e.target.value)}
                placeholder={selected.name}
                className="h-8"
              />
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  tryApply(() => {
                    apply({ type: 'renameTextPreset', presetId: selected.id, name: renameName })
                    setRenameName('')
                  })
                }
              >
                Rename
              </Button>
            </div>
            <Button
              size="sm"
              variant="destructive"
              className="w-full"
              onClick={() =>
                tryApply(() => {
                  apply({ type: 'deleteTextPreset', presetId: selected.id })
                  setSelectedId(builtins[0].id)
                  setRenameName('')
                })
              }
            >
              Delete preset
            </Button>
          </div>
        )}
      </div>
    </Section>
  )
}

function ProjectInspector() {
  const doc = useEditorStore((s) => s.doc)
  const apply = useEditorStore((s) => s.apply)
  const missing = doc.media.filter((m) => m.missing)

  return (
    <div className="pb-6">
      <Section title="Project settings">
        <div className="space-y-3">
          <NumberField
            label="Width (px)"
            value={doc.project.width}
            min={64}
            max={3840}
            step={2}
            onCommit={(v) => apply({ type: 'setProjectSettings', patch: { width: v } })}
          />
          <NumberField
            label="Height (px)"
            value={doc.project.height}
            min={64}
            max={2160}
            step={2}
            onCommit={(v) => apply({ type: 'setProjectSettings', patch: { height: v } })}
          />
          <NumberField
            label="Frame rate (fps)"
            value={doc.project.fps}
            min={1}
            max={60}
            step={1}
            onCommit={(v) => apply({ type: 'setProjectSettings', patch: { fps: v } })}
          />
        </div>
      </Section>
      <Separator />
      {missing.length > 0 && (
        <>
          <Section title="Offline media">
            <ul className="space-y-2">
              {missing.map((m) => (
                <li key={m.id} className="flex items-center gap-2 text-xs">
                  <Link2 className="size-3.5 shrink-0 text-amber-500" />
                  <span className="min-w-0 flex-1 truncate">{m.name}</span>
                  <span className="text-[10px] text-muted-foreground">relink in Media bin</span>
                </li>
              ))}
            </ul>
          </Section>
          <Separator />
        </>
      )}
      <Section title="Shortcuts">
        <ul className="space-y-1 text-[11px] leading-relaxed text-muted-foreground">
          <li>
            <Kbd>Space</Kbd> play / pause
          </li>
          <li>
            <Kbd>S</Kbd> snapping · <Kbd>D</Kbd> duplicate
          </li>
          <li>
            <Kbd>Ctrl+K</Kbd> split at playhead · <Kbd>M</Kbd> add marker
          </li>
          <li>
            <Kbd>Del</Kbd> delete clip · <Kbd>Shift+E</Kbd> mute
          </li>
          <li>
            <Kbd>T</Kbd> add text · <Kbd>←→</Kbd> step frame
          </li>
          <li>
            <Kbd>Ctrl+Z</Kbd> undo · <Kbd>Ctrl+Shift+Z</Kbd> redo
          </li>
          <li>
            <Kbd>Ctrl+S</Kbd> save project · <Kbd>Ctrl+Wheel</Kbd> zoom
          </li>
        </ul>
      </Section>
    </div>
  )
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">{children}</kbd>
}

function NumberField({
  label,
  value,
  onCommit,
  min,
  max,
  step = 1,
}: {
  label: string
  value: number
  onCommit: (v: number) => void
  min?: number
  max?: number
  step?: number
}) {
  const ref = useRef<HTMLInputElement>(null)
  return (
    <div>
      <Label className="text-xs">{label}</Label>
      <Input
        ref={ref}
        type="number"
        defaultValue={Number(value.toFixed(2))}
        key={`${value}`}
        min={min}
        max={max}
        step={step}
        className="mt-1 h-8 text-xs"
        onBlur={(e) => {
          const v = Number(e.target.value)
          if (Number.isFinite(v) && v !== value) onCommit(v)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
      />
    </div>
  )
}
