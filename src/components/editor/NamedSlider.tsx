'use client'

import * as React from 'react'
import * as SliderPrimitive from '@radix-ui/react-slider'

import {
  currentTransientToken,
  isTransientActive,
  ownsTransient,
  useEditorStore,
} from '@/lib/editor/store'
import { cn } from '@/lib/utils'

/**
 * NamedSlider: the editor's slider with an accessible name.
 *
 * Radix reads a thumb's accessible name from the THUMB's own props (the element
 * with `role="slider"` is the thumb, not the labelled root), and the generated
 * shadcn Slider spreads root props onto the root only: an `aria-label` handed
 * to it never reaches the element that announces. The generated file stays
 * untouched (see docs/design-system.md), so this wrapper composes the same
 * primitive with the same markup and puts the caller's `aria-label` on the
 * thumb of a single-value slider. A multi-value slider keeps Radix's own
 * per-thumb names ("Minimum" / "Maximum").
 */
function NamedSlider({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  'aria-label': ariaLabel,
  onValueChange,
  onValueCommit,
  onPointerDown,
  onPointerUp,
  onPointerCancel,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Root>) {
  const _values = React.useMemo(
    () => (Array.isArray(value) ? value : Array.isArray(defaultValue) ? defaultValue : [min, max]),
    [value, defaultValue, min, max],
  )
  const thumbLabel = _values.length === 1 ? ariaLabel : undefined
  // Radix commits a drag only on pointerup. A pointercancel (capture loss,
  // browser gesture) never reaches onValueCommit, so this slider would leave
  // the panel's pointerless transient open, pausing history and autosave.
  const previewing = React.useRef(false)
  // The token of the transient this slider opened. Null when the panel reused
  // a gesture another component already owned, which this slider must not end.
  const previewToken = React.useRef<number | null>(null)
  // True between pointerdown and pointerup/cancel. A keyboard step commits
  // without a pointer, so the preview it opens is not a drag.
  const pointerDown = React.useRef(false)
  const finishPreview = React.useCallback((mode: 'commit' | 'cancel') => {
    const token = previewToken.current
    const owns = previewing.current && ownsTransient(token)
    previewing.current = false
    previewToken.current = null
    if (!owns) return
    const store = useEditorStore.getState()
    if (mode === 'cancel') store.cancelTransient()
    else store.commitTransient()
  }, [])

  // A slider can unmount mid-drag (clip selection change, panel close), and a
  // detached element receives no pointercancel. Discard only this slider's
  // gesture: another control's transient must survive.
  React.useEffect(() => () => finishPreview('cancel'), [finishPreview])

  // A window blur (app switch, focus loss) can end a drag with no pointerup or
  // pointercancel. EditorShell commits the dangling store gesture on blur;
  // drop this slider's pointer ownership too, so the next keyboard step opens
  // and finalizes its own preview instead of being treated as a live drag.
  React.useEffect(() => {
    const resetPointer = () => {
      pointerDown.current = false
      previewing.current = false
      previewToken.current = null
    }
    window.addEventListener('blur', resetPointer)
    return () => window.removeEventListener('blur', resetPointer)
  }, [])

  return (
    <SliderPrimitive.Root
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      onValueChange={(next) => {
        const before = isTransientActive() ? currentTransientToken() : null
        // A frame may only write to a gesture this slider opened. Joining
        // another control's live gesture would overwrite its frames, and that
        // control's commit would roll the shared base back, dropping one of
        // the two edits. Drop the frame instead; once the owner releases, a
        // later frame here starts this slider's own gesture.
        if (before !== null && before !== previewToken.current) return
        onValueChange?.(next)
        previewing.current = true
        const after = isTransientActive() ? currentTransientToken() : null
        // The panel begins a gesture when none is live and reuses a live one,
        // so the slot this frame wrote to names its owner: a token that
        // appeared while this handler ran is this slider's; a slot that was
        // already live belongs to another control.
        previewToken.current =
          after !== null && (before === null || before === previewToken.current) ? after : null
        // Radix runs a controlled keyboard commit BEFORE this callback, so
        // `apply` has already recorded the step. The panel's preview still
        // opens a gesture here; finalize it after the event so a pointerless
        // transient cannot pause history and autosave. Pointer frames keep
        // their gesture until release.
        if (!pointerDown.current) queueMicrotask(() => finishPreview('commit'))
      }}
      onValueCommit={(next) => {
        const token = previewToken.current
        const owns = previewing.current && ownsTransient(token)
        // The panel's commit runs `apply`, which rolls the LIVE gesture back
        // first. A release that holds no gesture of its own (it lost the slot,
        // or previewed inside another control's) must not discard that
        // control's edit. A keyboard step arrives before its preview opens and
        // a local-draft slider has no gesture, so both still commit when no
        // foreign gesture is live.
        const foreign = isTransientActive() && !owns
        // A preview that owned the slot and lost it to a foreign edit must not
        // record its leftover value as a fresh entry after the slot closes.
        const stalePreview = previewing.current && token !== null && !owns
        previewing.current = false
        previewToken.current = null
        if (foreign || stalePreview) return
        onValueCommit?.(next)
      }}
      onPointerDown={(event) => {
        onPointerDown?.(event)
        if (!event.defaultPrevented) pointerDown.current = true
      }}
      onPointerUp={(event) => {
        pointerDown.current = false
        onPointerUp?.(event)
        // Radix's own pointerup handler runs after this one. A changed drag
        // commits there; a drag that returned to its starting value never
        // calls onValueCommit, so end its preview on the next microtask.
        // Cancel, not commit: an unchanged edit records no history.
        queueMicrotask(() => finishPreview('cancel'))
      }}
      onPointerCancel={(event) => {
        onPointerCancel?.(event)
        pointerDown.current = false
        // A cancelled drag is discarded, not committed: cancel restores the
        // pre-drag doc and records no history entry.
        finishPreview('cancel')
      }}
      className={cn(
        'relative flex w-full touch-none items-center select-none data-[disabled]:opacity-50 data-[orientation=vertical]:h-full data-[orientation=vertical]:min-h-44 data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col',
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Track
        data-slot="slider-track"
        className={cn(
          'bg-muted relative grow overflow-hidden rounded-full data-[orientation=horizontal]:h-1.5 data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-1.5',
        )}
      >
        <SliderPrimitive.Range
          data-slot="slider-range"
          className={cn(
            'bg-primary absolute data-[orientation=horizontal]:h-full data-[orientation=vertical]:w-full',
          )}
        />
      </SliderPrimitive.Track>
      {Array.from({ length: _values.length }, (_, index) => (
        <SliderPrimitive.Thumb
          data-slot="slider-thumb"
          key={index}
          aria-label={thumbLabel}
          className="border-primary bg-background ring-ring/50 block size-4 shrink-0 rounded-full border shadow-sm transition-[color,box-shadow] hover:ring-4 focus-visible:ring-4 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50"
        />
      ))}
    </SliderPrimitive.Root>
  )
}

export { NamedSlider }
