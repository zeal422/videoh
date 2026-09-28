'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from '@/hooks/use-toast'

import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Menubar,
  MenubarCheckboxItem,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarSeparator,
  MenubarShortcut,
  MenubarTrigger,
} from '@/components/ui/menubar'

import {
  commandsToAddMarker,
  commandsToAddText,
  commandsToDeleteClips,
  commandsToDeleteMarker,
  commandsToDuplicateClips,
  commandsToLinkClips,
  commandsToRippleDeleteClips,
  commandsToSplitAllAt,
  commandsToSplitClipsAt,
  commandsToUnlinkClips,
} from '@/lib/editor/actions'
import {
  commandsToCutClips,
  commandsToPasteClips,
  copyClips,
  hasClipboardContent,
} from '@/lib/editor/clipboard'
import {
  audibleClipId,
  anySelectionLinked,
  canLinkClips,
  canSplitAnySelectedAt,
  linkedAudioTwin,
} from '@/lib/editor/links'
import { EditorCommandError } from '@/lib/editor/commands'
import { createDoc, docDuration, uid } from '@/lib/editor/factories'
import { cn } from '@/lib/utils'
import { GAIN_MAX, GAIN_MIN, PPS_MAX, PPS_MIN, TRACK_HEADER_WIDTH } from '@/lib/editor/constants'
import { buildMenus, type MenuActionId, type MenuContext } from '@/lib/editor/menus'
import { CURRENT_VERSION } from '@/lib/releases'
import { hasNavigableMarkers, markerSelectionExists, neighborMarker } from '@/lib/editor/markers'
import { playbackRef } from '@/lib/editor/playback/engine-ref'
import {
  downloadProjectJSON,
  importMediaFiles,
  openProjectFromPicker,
  pickFiles,
  bumpProjectGeneration,
} from '@/lib/editor/project-io'
import { PANEL_BOUNDS, PANEL_IDS, type PanelId } from '@/lib/editor/workspace'
import { useWorkspaceStore } from '@/lib/editor/workspace-store'
import { useEditorStore } from '@/lib/editor/store'

/**
 * Application menu bar (Premiere Pro–style): File · Edit · Clip · Sequence ·
 * Marker · Graphics · View · Window · Help.
 *
 * The structure lives in `menus.ts` (pure + unit-tested); this component only
 * maps action ids to real editor operations. Items whose precondition is not
 * met render disabled — there are no dead menu entries.
 */
export function MenuBar({
  onOpenExport,
  onResetLayout,
  onOpenReleaseNotes,
}: {
  onOpenExport: () => void
  /** Full reset: clears the workspace store AND imperatively resizes the live
   * panels (mounted panels never re-read defaultSize on their own). */
  onResetLayout: () => void
  /** Opens the shell's single ReleaseNotesModal. One instance lives in
   * EditorShell so the auto-open greeting and the menu entry share it. */
  onOpenReleaseNotes: () => void
}) {
  const past = useEditorStore((s) => s.past)
  const future = useEditorStore((s) => s.future)
  const selections = useEditorStore((s) => s.selections)
  const selectedMarker = useEditorStore((s) => s.selectedMarker)
  const playhead = useEditorStore((s) => s.playhead)
  const snapEnabled = useEditorStore((s) => s.snapEnabled)
  const pxPerSec = useEditorStore((s) => s.pxPerSec)
  const doc = useEditorStore((s) => s.doc)

  const panelHidden = useWorkspaceStore((s) => s.hidden)
  const collapsed = useWorkspaceStore((s) => s.collapsed)
  const sizes = useWorkspaceStore((s) => s.sizes)
  const toggleHidden = useWorkspaceStore((s) => s.toggleHidden)
  const setHidden = useWorkspaceStore((s) => s.setHidden)

  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [gainOpen, setGainOpen] = useState(false)
  const [gainValue, setGainValue] = useState(1)

  const selectedClip = useMemo(
    () =>
      selections[0]
        ? doc.project.tracks.flatMap((t) => t.clips).find((c) => c.id === selections[0])
        : undefined,
    [doc, selections],
  )

  const allClipIds = useMemo(
    () => doc.project.tracks.flatMap((t) => t.clips.map((c) => c.id)),
    [doc],
  )

  // The doc identity is stable during playback (only `playhead` changes), and
  // this component re-renders on every frame through its playhead subscription:
  // without the memo, a full clip-and-marker walk plus a sort would run per
  // animation frame while playing. "Navigable" is the same predicate marker
  // navigation uses, so a marker past the sequence end does not light up a
  // jump that cannot happen.
  const hasMarkers = useMemo(() => hasNavigableMarkers(doc), [doc])

  const ctx: MenuContext = {
    canUndo: past.length > 0,
    canRedo: future.length > 0,
    hasSelection: selections.length > 0,
    selectionCount: selections.length,
    hasClips: allClipIds.length > 0,
    canSplit: selections.length > 0 && canSplitAnySelectedAt(doc, selections, playhead),
    // Text clips have no audio track; every media clip does.
    selectionHasAudio: !!selectedClip && selectedClip.mediaId !== undefined,
    // Mute state lives on the audio side of a linked pair.
    selectionMuted:
      !!selectedClip && !!(linkedAudioTwin(doc, selectedClip)?.muted ?? selectedClip.muted),
    canPaste: hasClipboardContent(),
    selectionLinked: selections.length > 0 && anySelectionLinked(doc, selections),
    canLink: canLinkClips(doc, selections),
    hasMarkers,
    hasSelectedMarker: !!selectedMarker && markerSelectionExists(doc, selectedMarker),
    snapEnabled,
    panelHidden,
    workspaceDirty:
      PANEL_IDS.some((id) => panelHidden[id]) ||
      PANEL_IDS.some((id) => collapsed[id]) ||
      sizes.media !== PANEL_BOUNDS.media.default ||
      sizes.inspector !== PANEL_BOUNDS.inspector.default ||
      sizes.timeline !== PANEL_BOUNDS.timeline.default,
  }

  const showError = useCallback((error: unknown) => {
    toast({
      title: 'Action failed',
      description: error instanceof Error ? error.message : String(error),
      variant: 'destructive',
    })
  }, [])

  const openGainDialog = useCallback(() => {
    const state = useEditorStore.getState()
    const sel = state.selections[0] ?? state.selection
    const clip = sel
      ? state.doc.project.tracks.flatMap((t) => t.clips).find((c) => c.id === sel)
      : undefined
    // Gain lives on the audio side of a linked pair — edit that one.
    const audibleId = sel ? audibleClipId(state.doc, sel) : null
    const audible = audibleId
      ? state.doc.project.tracks.flatMap((t) => t.clips).find((c) => c.id === audibleId)
      : undefined
    setGainValue(audible?.gain ?? clip?.gain ?? 1)
    setGainOpen(true)
  }, [])

  // Premiere G: Audio Gain. The keyboard hook dispatches an app event so the
  // dialog (owned here) can be opened without coupling the hook to React.
  useEffect(() => {
    window.addEventListener('editor:audio-gain', openGainDialog)
    return () => window.removeEventListener('editor:audio-gain', openGainDialog)
  }, [openGainDialog])

  const execute = useCallback(
    (action: MenuActionId) => {
      const store = useEditorStore.getState()
      const selectedIds =
        store.selections.length > 0 ? store.selections : store.selection ? [store.selection] : []
      const selectedClip = selectedIds[0]
        ? store.doc.project.tracks.flatMap((t) => t.clips).find((c) => c.id === selectedIds[0])
        : undefined

      try {
        switch (action) {
          case 'file.newProject': {
            // Installing a project by ANY means invalidates loads still in
            // flight: without the bump, a pending open could overwrite this
            // brand-new project when its hydration lands.
            bumpProjectGeneration()
            store.replaceDoc(createDoc())
            toast({ title: 'New project created' })
            break
          }
          case 'file.openProject': {
            // The shared coordinator owns the whole flow (pick, parse, sample
            // hydration, install) and its generation guard: menu opens and
            // toolbar opens invalidate each other the same way.
            void openProjectFromPicker()
            break
          }
          case 'file.importMedia': {
            void pickFiles('video/*,audio/*,image/*', true).then(async (files) => {
              if (files.length === 0) return
              const count = await importMediaFiles(files)
              if (count > 0) toast({ title: `Imported ${count} file(s)` })
            })
            break
          }
          case 'file.saveProject': {
            const filename = downloadProjectJSON()
            toast({ title: 'Project saved', description: `${filename} downloaded` })
            break
          }
          case 'file.exportMedia':
            onOpenExport()
            break

          case 'edit.undo':
            store.undo()
            break
          case 'edit.redo':
            store.redo()
            break
          case 'edit.selectAll':
            store.selectAll()
            break
          case 'edit.deselectAll':
            store.deselectAll()
            break

          case 'clip.split': {
            // Premiere "Add Edit": with no selection, split ALL tracks the
            // playhead crosses; otherwise split the whole selection.
            const splitCommands = selectedIds.length
              ? commandsToSplitClipsAt(store.doc, selectedIds, store.playhead)
              : commandsToSplitAllAt(store.doc, store.playhead)
            if (!splitCommands) return
            store.apply(splitCommands)
            break
          }
          case 'clip.duplicate': {
            if (selectedIds.length === 0) return
            const dupCommands = commandsToDuplicateClips(store.doc, selectedIds)
            if (!dupCommands) return
            store.apply(dupCommands)
            break
          }
          case 'clip.delete': {
            if (selectedIds.length === 0) return
            // Linked A/V pairs die together — until explicitly unlinked.
            store.apply(commandsToDeleteClips(store.doc, selectedIds))
            store.deselectAll()
            break
          }
          case 'clip.rippleDelete': {
            if (selectedIds.length === 0) return
            const rippleCommands = commandsToRippleDeleteClips(store.doc, selectedIds)
            if (!rippleCommands) return
            store.apply(rippleCommands)
            store.deselectAll()
            break
          }
          case 'clip.cut': {
            if (selectedIds.length === 0) return
            const cutCommands = commandsToCutClips(store.doc, selectedIds)
            if (!cutCommands) return
            store.apply(cutCommands)
            store.deselectAll()
            break
          }
          case 'clip.copy': {
            if (selectedIds.length === 0) return
            const copied = copyClips(store.doc, selectedIds)
            if (copied > 0) toast({ title: `Copied ${copied} clip${copied > 1 ? 's' : ''}` })
            break
          }
          case 'clip.paste': {
            const pasteCommands = commandsToPasteClips(store.doc, store.playhead)
            if (!pasteCommands) return
            store.apply(pasteCommands)
            break
          }
          case 'clip.link': {
            if (selectedIds.length < 2) return
            const linkCommands = commandsToLinkClips(store.doc, selectedIds)
            if (!linkCommands) return
            store.apply(linkCommands)
            toast({ title: 'Clips linked' })
            break
          }
          case 'clip.unlink': {
            if (selectedIds.length === 0) return
            const unlinkCommands = commandsToUnlinkClips(store.doc, selectedIds)
            if (!unlinkCommands) return
            store.apply(unlinkCommands)
            toast({ title: 'Audio and video unlinked' })
            break
          }
          case 'clip.toggleMute': {
            if (!selectedClip) return
            // Mute is an AUDIO property: always target the linked pair's
            // audio twin, whichever half is selected.
            const audibleId = audibleClipId(store.doc, selectedClip.id)
            const audible = store.doc.project.tracks
              .flatMap((t) => t.clips)
              .find((c) => c.id === audibleId)
            store.apply({
              type: 'setClipMuted',
              clipId: audibleId,
              muted: !(audible?.muted ?? false),
            })
            break
          }
          case 'clip.audioGain':
            openGainDialog()
            break

          case 'sequence.addVideoTrack':
            store.apply({ type: 'addTrack', kind: 'video', trackId: uid('track') })
            break
          case 'sequence.addAudioTrack':
            store.apply({ type: 'addTrack', kind: 'audio', trackId: uid('track') })
            break
          case 'sequence.addTextTrack':
            store.apply({ type: 'addTrack', kind: 'text', trackId: uid('track') })
            break
          case 'sequence.settings': {
            // Premiere opens a modal; the MVP keeps settings in the Inspector,
            // so surface the Inspector and deselect to reveal project settings.
            store.deselectAll()
            setHidden('inspector' satisfies PanelId, false)
            break
          }

          case 'marker.add': {
            store.apply(commandsToAddMarker(store.doc, store.playhead, selectedIds))
            break
          }
          case 'marker.edit':
            window.dispatchEvent(new CustomEvent('editor:marker-edit'))
            break
          case 'marker.delete': {
            if (!store.selectedMarker) return
            const deleteMarkerCommands = commandsToDeleteMarker(store.doc, store.selectedMarker)
            if (!deleteMarkerCommands) return
            store.apply(deleteMarkerCommands)
            store.selectMarker(null)
            break
          }
          case 'marker.next': {
            const point = neighborMarker(store.doc, store.playhead, 'next')
            if (point) playbackRef.current?.seek(point.timelineTime)
            break
          }
          case 'marker.previous': {
            const point = neighborMarker(store.doc, store.playhead, 'prev')
            if (point) playbackRef.current?.seek(point.timelineTime)
            break
          }

          case 'graphics.newText':
            store.apply(commandsToAddText(store.doc, store.playhead))
            break

          case 'view.zoomIn':
            store.setPxPerSec(Math.min(PPS_MAX, Math.round(store.pxPerSec * 1.4)))
            break
          case 'view.zoomOut':
            store.setPxPerSec(Math.max(PPS_MIN, Math.round(store.pxPerSec / 1.4)))
            break
          case 'view.zoomFit':
            zoomToFitSequence(store)
            break
          case 'view.toggleSnap':
            store.toggleSnap()
            break

          case 'window.toggleMedia':
            toggleHidden('media')
            break
          case 'window.togglePreview':
            toggleHidden('preview')
            break
          case 'window.toggleInspector':
            toggleHidden('inspector')
            break
          case 'window.toggleTimeline':
            toggleHidden('timeline')
            break
          case 'window.resetLayout':
            onResetLayout()
            toast({ title: 'Workspace layout reset' })
            break

          case 'help.releaseNotes':
            onOpenReleaseNotes()
            break
          case 'help.shortcuts':
            setShortcutsOpen(true)
            break
          case 'help.about':
            setAboutOpen(true)
            break
        }
      } catch (error) {
        if (error instanceof EditorCommandError) {
          showError(error)
        } else {
          throw error
        }
      }
    },
    [
      onOpenExport,
      onOpenReleaseNotes,
      onResetLayout,
      openGainDialog,
      setHidden,
      showError,
      toggleHidden,
    ],
  )

  const menus = buildMenus(ctx)
  return (
    <>
      <Menubar
        role="menubar"
        aria-label="Application menu"
        className="bg-card h-8 w-full max-w-full overflow-x-auto overflow-y-hidden rounded-none border-x-0 border-t-0 px-1 py-0 shadow-none"
      >
        {menus.map((menu) => (
          <MenubarMenu key={menu.spec.id}>
            <MenubarTrigger className="h-7 shrink-0 px-2.5 text-[13px]">
              {menu.spec.label}
            </MenubarTrigger>
            <MenubarContent>
              {menu.items.map((item) =>
                item.spec.kind === 'separator' ? (
                  <MenubarSeparator key={item.spec.id} />
                ) : item.spec.kind === 'checkbox' ? (
                  <MenubarCheckboxItem
                    key={item.spec.id}
                    checked={item.checked}
                    disabled={!item.enabled}
                    onSelect={() => item.spec.action && execute(item.spec.action)}
                  >
                    {item.spec.label}
                    {item.spec.shortcut && (
                      <MenubarShortcut className="ml-auto pl-4">
                        {item.spec.shortcut}
                      </MenubarShortcut>
                    )}
                  </MenubarCheckboxItem>
                ) : (
                  <MenubarItem
                    key={item.spec.id}
                    disabled={!item.enabled}
                    onSelect={() => item.spec.action && execute(item.spec.action)}
                    className={cn(
                      item.spec.tinted &&
                        // Release-notes row: light emerald at rest, deeper when
                        // highlighted. The /focus classes also override the
                        // primitive's focus:bg-accent via tailwind-merge, so the
                        // highlight stays green instead of switching to the
                        // neutral accent.
                        'bg-emerald-500/15 focus:bg-emerald-500/25 focus:text-emerald-50',
                    )}
                  >
                    {item.spec.label}
                    {item.spec.shortcut && <MenubarShortcut>{item.spec.shortcut}</MenubarShortcut>}
                  </MenubarItem>
                ),
              )}
            </MenubarContent>
          </MenubarMenu>
        ))}

        {/* Running version, static muted label at the right edge: the space
            the stray scrollbar used to occupy. The value comes from
            releases.ts, the same gate-locked source as the welcome modal, so
            it cannot drift from package.json. */}
        <span
          data-testid="menubar-version"
          className="text-muted-foreground ml-auto shrink-0 pr-2 text-[11px] tabular-nums"
        >
          v{CURRENT_VERSION}
        </span>
      </Menubar>

      <AudioGainDialog
        open={gainOpen}
        onOpenChange={setGainOpen}
        value={gainValue}
        onValueChange={setGainValue}
      />
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      <AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} />
    </>
  )
}

/** Clip > Audio Gain… — commit-on-release slider so drags create one undo step. */
function AudioGainDialog({
  open,
  onOpenChange,
  value,
  onValueChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  value: number
  onValueChange: (value: number) => void
}) {
  const dbLabel =
    value <= 0 ? '−∞ dB (silent)' : `${value === 1 ? '0' : (20 * Math.log10(value)).toFixed(1)} dB`

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Audio Gain</DialogTitle>
          <DialogDescription>Adjust the loudness of the selected clip.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="text-center text-sm font-medium tabular-nums">
            {Math.round(value * 100)}% <span className="text-muted-foreground">({dbLabel})</span>
          </div>
          <Slider
            aria-label="Clip audio gain"
            min={GAIN_MIN}
            max={GAIN_MAX}
            step={0.05}
            value={[value]}
            onValueChange={([v]) => onValueChange(v)}
            onValueCommit={([v]) => {
              const store = useEditorStore.getState()
              if (!store.selection) return
              // Route gain to the audio side of a linked pair.
              store.apply({
                type: 'setClipGain',
                clipId: audibleClipId(store.doc, store.selection),
                gain: v,
              })
            }}
          />
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** View > Zoom to Fit Sequence (Premiere \\): whole doc visible in the timeline. */
function zoomToFitSequence(store: ReturnType<typeof useEditorStore.getState>): void {
  const el = document.querySelector('[data-timeline-scroll]')
  const viewport = el ? el.clientWidth - TRACK_HEADER_WIDTH - 12 : 0
  const duration = docDuration(store.doc)
  if (viewport > 40 && duration > 0.25) {
    store.setPxPerSec(Math.min(PPS_MAX, Math.max(PPS_MIN, Math.round(viewport / duration))))
  }
}

/** Help > Keyboard Shortcuts… — mirrors useEditorKeyboard.ts (single source). */
const SHORTCUT_ROWS: [string, string][] = [
  ['V / C', 'Selection tool / Razor tool (Escape returns to V)'],
  ['Space', 'Play / pause'],
  ['J / K / L', 'Shuttle stop / stop / play'],
  ['← / →', 'Step 1 frame (Shift: 5 frames)'],
  ['↑ / ↓', 'Previous / next edit point'],
  ['Home / End', 'Jump to start / end'],
  ['S', 'Toggle snapping'],
  ['Ctrl+K', 'Add Edit — split selection (or all tracks) at playhead'],
  ['Delete / Backspace', 'Delete selection (whole link groups)'],
  ['Shift+Delete', 'Ripple delete — delete and close the gap'],
  ['Ctrl+X / Ctrl+C / Ctrl+V', 'Cut / copy / paste the selection'],
  ['Ctrl+A / Ctrl+Shift+A', 'Select all / deselect all'],
  ['Shift+click / Ctrl+click', 'Add / toggle clip (its link group) in the selection'],
  ['Ctrl+L', 'Link selection — or unlink when already linked'],
  ['D / Ctrl+Shift+/', 'Duplicate selection'],
  ['M', 'Add marker at playhead (clip marker when a clip is selected)'],
  ['Shift+M / Ctrl+Shift+M', 'Go to next / previous marker'],
  ['Shift+E', 'Mute / unmute the selected clip’s audio side'],
  ['G', 'Audio Gain dialog'],
  ['T', 'Add text clip at playhead (Type tool)'],
  ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / redo'],
  ['Ctrl+S', 'Save project JSON'],
  ['+ / − / \\', 'Zoom in / out / fit sequence'],
]

function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard Shortcuts</DialogTitle>
          <DialogDescription>Shortcuts are ignored while typing in text fields.</DialogDescription>
        </DialogHeader>
        <dl className="divide-y">
          {SHORTCUT_ROWS.map(([keys, action]) => (
            <div key={keys} className="flex items-center justify-between gap-4 py-2 text-sm">
              <dt className="text-muted-foreground">{action}</dt>
              <dd className="font-mono text-xs whitespace-nowrap">{keys}</dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  )
}

function AboutDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Web Video Editor</DialogTitle>
          <DialogDescription>MVP · browser-based video editing</DialogDescription>
        </DialogHeader>
        <div className="space-y-2 text-sm">
          <p>
            A minimal timeline editor: import media, arrange clips on multi-track timelines, add
            crossfades and text, mix audio, and export to WebM — entirely in your browser.
          </p>
          <p className="text-muted-foreground">
            Timeline duration: {docDuration(useEditorStore.getState().doc).toFixed(1)}s ·{' '}
            {PANEL_IDS.length} workspace panels
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
