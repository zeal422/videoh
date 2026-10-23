'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from '@/hooks/use-toast'
import { useIsMobile } from '@/hooks/use-mobile'

import { NamedSlider } from '@/components/editor/NamedSlider'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { CheckIcon } from 'lucide-react'
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
  commandsToCreateCompoundClip,
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
import {
  activeSequenceDuration,
  activeTracks,
  createDoc,
  findClip,
  uid,
} from '@/lib/editor/factories'
import { cn } from '@/lib/utils'
import { GAIN_MAX, GAIN_MIN, PPS_MAX, PPS_MIN, TRACK_HEADER_WIDTH } from '@/lib/editor/constants'
import { buildMenus, type MenuActionId, type MenuContext } from '@/lib/editor/menus'
import { CURRENT_VERSION } from '@/lib/releases'
import { hasNavigableMarkers, markerSelectionExists, neighborMarker } from '@/lib/editor/markers'
import { playbackRef } from '@/lib/editor/playback/engine-ref'
import { revokeAllProxies } from '@/lib/editor/media/proxies'
import {
  downloadProjectJSON,
  importMediaFiles,
  openProjectFromPicker,
  pickFiles,
  bumpProjectGeneration,
} from '@/lib/editor/project-io'
import { PANEL_BOUNDS, PANEL_IDS } from '@/lib/editor/workspace'
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
/** The `sequenceId` field an addTrack command needs for the active sequence. */
function activeSequenceField(path: readonly string[]): { sequenceId?: string } {
  const id = path[path.length - 1]
  return id ? { sequenceId: id } : {}
}

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
  const proxiesEnabled = useEditorStore((s) => s.proxiesEnabled)
  const pxPerSec = useEditorStore((s) => s.pxPerSec)
  const doc = useEditorStore((s) => s.doc)
  const activeSequencePath = useEditorStore((s) => s.activeSequencePath)

  const panelHidden = useWorkspaceStore((s) => s.hidden)
  const isMobile = useIsMobile()
  const collapsed = useWorkspaceStore((s) => s.collapsed)
  const sizes = useWorkspaceStore((s) => s.sizes)
  const toggleHidden = useWorkspaceStore((s) => s.toggleHidden)

  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [gainOpen, setGainOpen] = useState(false)
  const [gainValue, setGainValue] = useState(1)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsDraft, setSettingsDraft] = useState({ name: '', width: '', height: '', fps: '' })

  const selectedClip = useMemo(
    () => (selections[0] ? findClip(doc, selections[0])?.clip : undefined),
    [doc, selections],
  )

  const allClipIds = useMemo(
    () => activeTracks(doc, activeSequencePath).flatMap((t) => t.clips.map((c) => c.id)),
    [doc, activeSequencePath],
  )

  // The doc identity is stable during playback (only `playhead` changes), and
  // this component re-renders on every frame through its playhead subscription:
  // without the memo, a full clip-and-marker walk plus a sort would run per
  // animation frame while playing. "Navigable" is the same predicate marker
  // navigation uses, so a marker past the sequence end does not light up a
  // jump that cannot happen.
  const hasMarkers = useMemo(
    () => hasNavigableMarkers(doc, activeSequencePath),
    [doc, activeSequencePath],
  )

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
    canCreateCompound: selections.length > 0,
    hasMarkers,
    hasSelectedMarker: !!selectedMarker && markerSelectionExists(doc, selectedMarker),
    canAddMarker: selections.length > 0 || activeSequencePath.length === 0,
    snapEnabled,
    proxiesEnabled,
    panelHidden,
    isMobile,
    workspaceDirty:
      PANEL_IDS.some((id) => panelHidden[id]) ||
      PANEL_IDS.some((id) => collapsed[id]) ||
      sizes.media !== PANEL_BOUNDS.media.default ||
      sizes.source !== PANEL_BOUNDS.source.default ||
      sizes.inspector !== PANEL_BOUNDS.inspector.default ||
      sizes.timeline !== PANEL_BOUNDS.timeline.default ||
      sizes.captions !== PANEL_BOUNDS.captions.default,
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
    const clip = sel ? findClip(state.doc, sel)?.clip : undefined
    // Gain lives on the audio side of a linked pair — edit that one.
    const audibleId = sel ? audibleClipId(state.doc, sel) : null
    const audible = audibleId ? findClip(state.doc, audibleId)?.clip : undefined
    setGainValue(audible?.gain ?? clip?.gain ?? 1)
    setGainOpen(true)
  }, [])

  // Premiere G: Audio Gain. The keyboard hook dispatches an app event so the
  // dialog (owned here) can be opened without coupling the hook to React.
  useEffect(() => {
    window.addEventListener('editor:audio-gain', openGainDialog)
    return () => window.removeEventListener('editor:audio-gain', openGainDialog)
  }, [openGainDialog])

  // Sequence > Sequence Settings: Premiere-style dialog over the shared
  // project settings (sequences carry no settings of their own). Draft lives
  // in local state; OK commits one undoable command, Cancel discards.
  const openSettingsDialog = useCallback(() => {
    const { doc } = useEditorStore.getState()
    setSettingsDraft({
      name: doc.project.name,
      width: String(doc.project.width),
      height: String(doc.project.height),
      fps: String(doc.project.fps),
    })
    setSettingsOpen(true)
  }, [])

  const saveSettingsDialog = useCallback(() => {
    const store = useEditorStore.getState()
    const current = store.doc.project
    const patch: Partial<Pick<typeof current, 'name' | 'width' | 'height' | 'fps'>> = {}
    const name = settingsDraft.name.trim()
    if (name && name !== current.name) patch.name = name
    const widthRaw = settingsDraft.width.trim()
    const width = Number(widthRaw)
    if (widthRaw !== '' && Number.isFinite(width) && Math.round(width) !== current.width)
      patch.width = width
    const heightRaw = settingsDraft.height.trim()
    const height = Number(heightRaw)
    if (heightRaw !== '' && Number.isFinite(height) && Math.round(height) !== current.height)
      patch.height = height
    const fpsRaw = settingsDraft.fps.trim()
    const fps = Number(fpsRaw)
    if (fpsRaw !== '' && Number.isFinite(fps) && Math.round(fps) !== current.fps) patch.fps = fps
    setSettingsOpen(false)
    if (Object.keys(patch).length === 0) return
    store.apply({ type: 'setProjectSettings', patch })
    toast({ title: 'Sequence settings updated' })
  }, [settingsDraft])

  const execute = useCallback(
    (action: MenuActionId) => {
      const store = useEditorStore.getState()
      const selectedIds =
        store.selections.length > 0 ? store.selections : store.selection ? [store.selection] : []
      const selectedClip = selectedIds[0] ? findClip(store.doc, selectedIds[0])?.clip : undefined

      try {
        switch (action) {
          case 'file.newProject': {
            // Installing a project by ANY means invalidates loads still in
            // flight: without the bump, a pending open could overwrite this
            // brand-new project when its hydration lands.
            bumpProjectGeneration()
            revokeAllProxies()
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
              : commandsToSplitAllAt(store.doc, store.playhead, store.activeSequencePath)
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
            const rippleCommands = commandsToRippleDeleteClips(
              store.doc,
              selectedIds,
              store.activeSequencePath,
            )
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
            const pasteCommands = commandsToPasteClips(
              store.doc,
              store.playhead,
              store.untargetedTracks,
              store.activeSequencePath[store.activeSequencePath.length - 1],
            )
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
            const audible = findClip(store.doc, audibleId)?.clip
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
            store.apply({
              type: 'addTrack',
              kind: 'video',
              trackId: uid('track'),
              ...activeSequenceField(store.activeSequencePath),
            })
            break
          case 'sequence.addAudioTrack':
            store.apply({
              type: 'addTrack',
              kind: 'audio',
              trackId: uid('track'),
              ...activeSequenceField(store.activeSequencePath),
            })
            break
          case 'sequence.addTextTrack':
            store.apply({
              type: 'addTrack',
              kind: 'text',
              trackId: uid('track'),
              ...activeSequenceField(store.activeSequencePath),
            })
            break
          case 'sequence.createCompound': {
            const commands = commandsToCreateCompoundClip(store.doc, selectedIds)
            if (!commands) {
              toast({
                title: 'Cannot create a compound clip',
                description: 'Select at least one clip on a video lane.',
                variant: 'destructive',
              })
              break
            }
            store.apply(commands)
            break
          }
          case 'sequence.settings':
            openSettingsDialog()
            break

          case 'marker.add': {
            const markerCommands = commandsToAddMarker(
              store.doc,
              store.playhead,
              selectedIds,
              store.activeSequencePath,
            )
            if (markerCommands) store.apply(markerCommands)
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
            const point = neighborMarker(
              store.doc,
              store.playhead,
              'next',
              store.activeSequencePath,
            )
            if (point) playbackRef.current?.seek(point.timelineTime)
            break
          }
          case 'marker.previous': {
            const point = neighborMarker(
              store.doc,
              store.playhead,
              'prev',
              store.activeSequencePath,
            )
            if (point) playbackRef.current?.seek(point.timelineTime)
            break
          }

          case 'graphics.newText':
            store.apply(
              commandsToAddText(
                store.doc,
                store.playhead,
                store.untargetedTracks,
                store.activeSequencePath[store.activeSequencePath.length - 1],
              ),
            )
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
          case 'view.useProxies':
            store.setProxiesEnabled(!store.proxiesEnabled)
            break

          case 'window.toggleMedia':
            toggleHidden('media')
            break
          case 'window.togglePreview':
            toggleHidden('preview')
            break
          case 'window.toggleSource':
            toggleHidden('source')
            break
          case 'window.toggleInspector':
            toggleHidden('inspector')
            break
          case 'window.toggleTimeline':
            toggleHidden('timeline')
            break
          case 'window.toggleCaptions':
            toggleHidden('captions')
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
      openSettingsDialog,
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
                  // Checkbox rows render as plain rows so every menu stays
                  // flush left: the checked state shows as a glyph after the
                  // label instead of a reserved tick slot that indents Mute.
                  <MenubarItem
                    key={item.spec.id}
                    role="menuitemcheckbox"
                    aria-checked={item.checked}
                    disabled={!item.enabled}
                    onSelect={() => item.spec.action && execute(item.spec.action)}
                  >
                    {item.spec.label}
                    {item.checked && <CheckIcon className="text-muted-foreground size-4" />}
                    {item.spec.shortcut && <MenubarShortcut>{item.spec.shortcut}</MenubarShortcut>}
                  </MenubarItem>
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
      <SequenceSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        draft={settingsDraft}
        onDraftChange={setSettingsDraft}
        onSave={saveSettingsDialog}
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
          <NamedSlider
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

/** Sequence > Sequence Settings… — Premiere-style modal over the shared
 * project settings (frame size, frame rate, name). Draft edits stay local;
 * OK commits a single undoable `setProjectSettings`, Cancel discards. */
function SequenceSettingsDialog({
  open,
  onOpenChange,
  draft,
  onDraftChange,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  draft: { name: string; width: string; height: string; fps: string }
  onDraftChange: (draft: { name: string; width: string; height: string; fps: string }) => void
  onSave: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Sequence Settings</DialogTitle>
          <DialogDescription>
            Frame size and frame rate apply to the whole project.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3 py-2"
          onSubmit={(e) => {
            e.preventDefault()
            onSave()
          }}
        >
          <div>
            <Label className="text-xs" htmlFor="sequence-settings-name">
              Name
            </Label>
            <Input
              id="sequence-settings-name"
              className="mt-1 h-8 text-xs"
              value={draft.name}
              onChange={(e) => onDraftChange({ ...draft, name: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs" htmlFor="sequence-settings-width">
                Width (px)
              </Label>
              <Input
                id="sequence-settings-width"
                type="number"
                className="mt-1 h-8 text-xs"
                value={draft.width}
                min={64}
                max={3840}
                step={2}
                onChange={(e) => onDraftChange({ ...draft, width: e.target.value })}
              />
            </div>
            <div>
              <Label className="text-xs" htmlFor="sequence-settings-height">
                Height (px)
              </Label>
              <Input
                id="sequence-settings-height"
                type="number"
                className="mt-1 h-8 text-xs"
                value={draft.height}
                min={64}
                max={2160}
                step={2}
                onChange={(e) => onDraftChange({ ...draft, height: e.target.value })}
              />
            </div>
          </div>
          <div>
            <Label className="text-xs" htmlFor="sequence-settings-fps">
              Frame rate (fps)
            </Label>
            <Input
              id="sequence-settings-fps"
              type="number"
              className="mt-1 h-8 text-xs tabular-nums"
              value={draft.fps}
              min={1}
              max={60}
              step={1}
              onChange={(e) => onDraftChange({ ...draft, fps: e.target.value })}
            />
          </div>
          <DialogFooter>
            <Button variant="secondary" type="button" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">OK</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** View > Zoom to Fit Sequence (Premiere \\): whole doc visible in the timeline. */
function zoomToFitSequence(store: ReturnType<typeof useEditorStore.getState>): void {
  const el = document.querySelector('[data-timeline-scroll]')
  const viewport = el ? el.clientWidth - TRACK_HEADER_WIDTH - 12 : 0
  const duration = activeSequenceDuration(store.doc, store.activeSequencePath)
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
  ['I / O', 'Mark source In / Out at the source playhead'],
  [', / .', 'Insert / overwrite the marked source at the playhead'],
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
            Timeline duration:{' '}
            {activeSequenceDuration(
              useEditorStore.getState().doc,
              useEditorStore.getState().activeSequencePath,
            ).toFixed(1)}
            s · {PANEL_IDS.length} workspace panels
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
