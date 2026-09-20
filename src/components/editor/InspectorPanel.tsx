'use client'

import { useRef } from 'react'
import { Crosshair, Link2, Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { toast } from '@/hooks/use-toast'

import { EditorCommandError } from '@/lib/editor/commands'
import { findMedia, nextClipOnTrack } from '@/lib/editor/factories'
import { linkedAudioTwin } from '@/lib/editor/links'
import { formatTime } from '@/lib/editor/time'
import { TRANSITION_MAX, TRANSITION_MIN } from '@/lib/editor/constants'
import { useEditorStore } from '@/lib/editor/store'
import type { Clip, TextStyle } from '@/lib/editor/types'
import { cn } from '@/lib/utils'

/**
 * Right panel: properties of the selected clip (audio gain/mute, text styling,
 * crossfade transition) or project settings when nothing is selected.
 */
export function InspectorPanel({ className }: { className?: string }) {
  const doc = useEditorStore((s) => s.doc)
  const selection = useEditorStore((s) => s.selection)

  const selected = selection
    ? doc.project.tracks.flatMap((t) => t.clips).find((c) => c.id === selection)
    : undefined
  const selectedTrack = selected
    ? doc.project.tracks.find((t) => t.clips.some((c) => c.id === selected.id))
    : undefined
  return (
    <aside
      aria-label="Inspector"
      className={cn('editor-scroll flex min-w-0 flex-col overflow-y-auto bg-card', className)}
    >
      {selected && selectedTrack ? (
        <ClipInspector key={selected.id} clip={selected} trackKind={selectedTrack.kind} />
      ) : (
        <ProjectInspector />
      )}
    </aside>
  )
}

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

  const track = doc.project.tracks.find((t) => t.clips.some((c) => c.id === clip.id))
  const nextClip = track ? nextClipOnTrack(track, clip) : undefined

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
              <Slider
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
                <Slider
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

      <Section title="Transition out (cross-dissolve)">
        {nextClip ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label htmlFor="transition" className="text-xs">
                Crossfade to next clip
              </Label>
              <Switch
                id="transition"
                aria-label="Enable crossfade transition"
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
                <div className="mb-1.5 flex items-center justify-between">
                  <Label htmlFor="transition-duration" className="text-xs">
                    Duration
                  </Label>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {clip.transitionOut.duration.toFixed(2)}s
                  </span>
                </div>
                <Slider
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
                  The next clip is pulled left to create the dissolve overlap. Video/audio ramp
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
            <Slider
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
            <Slider
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
    </>
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
            <Kbd>S</Kbd> split at playhead · <Kbd>D</Kbd> duplicate
          </li>
          <li>
            <Kbd>Del</Kbd> delete clip · <Kbd>M</Kbd> mute
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
