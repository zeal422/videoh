'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { RotateCcw, X } from 'lucide-react'
import type { ImperativePanelHandle } from 'react-resizable-panels'

import { Button } from '@/components/ui/button'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { PanelShell } from './PanelShell'
import { MenuBar } from './MenuBar'
import { Toolbar } from './Toolbar'
import { MediaBin } from './MediaBin'
import { PreviewPanel } from './PreviewPanel'
import { InspectorPanel } from './InspectorPanel'
import { TimelinePanel } from './timeline/TimelinePanel'
import { MarkerDialog } from './timeline/MarkerDialog'
import { StatusBar } from './StatusBar'
import { ExportDialog } from './ExportDialog'
import { ReleaseNotesModal } from './ReleaseNotesModal'
import { CURRENT_VERSION } from '@/lib/releases'
import { useEditorKeyboard } from '@/hooks/editor/useEditorKeyboard'
import { useIsMobile } from '@/hooks/use-mobile'
import { refreshPausedPreview } from '@/lib/editor/playback/preview'
import { activeTransientPointerId, useEditorStore } from '@/lib/editor/store'
import { PANEL_BOUNDS, type PanelId, PANEL_IDS } from '@/lib/editor/workspace'
import { useWorkspaceStore } from '@/lib/editor/workspace-store'
import {
  clearAutosave,
  initAutosave,
  parseAutosave,
  readValidAutosave,
} from '@/lib/editor/persistence'
import { projectFileName, serializeDoc } from '@/lib/editor/serialization'
import { hydrateSampleMedia, bumpProjectGeneration } from '@/lib/editor/project-io'
import { toast } from '@/hooks/use-toast'

/**
 * App shell — Premiere-style workspace layout:
 *
 *   menubar (top) · toolbar · [ media | preview | inspector ] · timeline · status bar
 *
 * Desktop (≥768px): every region is a resizable, collapsible panel
 * (react-resizable-panels). Sizes persist to localStorage; the Window menu
 * shows/hides panels; double-clicking a resize handle resets its neighbor.
 * Mobile: fixed stacked layout (panels fall back to their pre-workspace form).
 * The status bar acts as the always-pinned footer of the application.
 */
export function EditorShell() {
  const [exportOpen, setExportOpen] = useState(false)
  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false)
  // False until the mount effect finished the autosave discovery; the greeting
  // effect holds back until this flips (see the scan comment below).
  const [autosaveScanned, setAutosaveScanned] = useState(false)
  const isMobile = useIsMobile()
  const doc = useEditorStore((s) => s.doc)
  const pendingRestore = useEditorStore((s) => s.pendingRestore)
  const hidden = useWorkspaceStore((s) => s.hidden)
  const sizes = useWorkspaceStore((s) => s.sizes)
  const setSize = useWorkspaceStore((s) => s.setSize)
  const resetWorkspace = useWorkspaceStore((s) => s.resetWorkspace)

  // Imperative handles for "double-click handle → reset neighbor to default".
  const panelRefs = useRef<Partial<Record<PanelId, ImperativePanelHandle | null>>>({})
  const registerRef = useCallback((id: PanelId, ref: ImperativePanelHandle | null) => {
    panelRefs.current[id] = ref
  }, [])
  const resetPanel = useCallback((id: PanelId) => {
    const bounds = PANEL_BOUNDS[id as keyof typeof PANEL_BOUNDS]
    if (bounds) panelRefs.current[id]?.resize(bounds.default)
  }, [])

  /** Window › Reset Workspace Layout: clear the persisted workspace AND apply
   * the defaults to the live panels. Mounted panels never re-read their
   * defaultSize prop, so without the imperative resize the visible layout
   * would stay squeezed and the layout engine would re-persist the old sizes
   * over the reset. Panels hidden before the reset simply re-mount at their
   * defaults (their refs are null until then). */
  const handleResetLayout = useCallback(() => {
    resetWorkspace()
    for (const id of PANEL_IDS) {
      const bounds = PANEL_BOUNDS[id as keyof typeof PANEL_BOUNDS]
      const ref = panelRefs.current[id]
      if (!bounds || !ref) continue
      ref.expand()
      ref.resize(bounds.default)
    }
  }, [resetWorkspace])

  // Layout observers. Only persist while the measured panel is actually
  // rendered — otherwise group indices shift and would store the wrong panel.
  const handleMediaLayout = useCallback(
    (layout: number[]) => {
      if (!hidden.media && layout[0] !== undefined) setSize('media', layout[0])
    },
    [hidden.media, setSize],
  )
  const handleTimelineLayout = useCallback(
    (layout: number[]) => {
      if (!hidden.timeline && layout[1] !== undefined) setSize('timeline', layout[1])
    },
    [hidden.timeline, setSize],
  )
  const handleInspectorLayout = useCallback(
    (layout: number[]) => {
      if (!hidden.inspector && !hidden.preview && layout[1] !== undefined) {
        setSize('inspector', layout[1])
      }
    },
    [hidden.inspector, hidden.preview, setSize],
  )

  // Autosave lifecycle: subscribe once; check for a restorable session on mount.
  useEffect(() => {
    const unsubscribe = initAutosave()
    const saved = readValidAutosave()
    if (saved) useEditorStore.getState().setPendingRestore(saved)
    // Effect order is not a memory barrier: the greeting effect below shares
    // this commit and would read its stale pendingRestore (null) closure,
    // greeting over a discovered restore before the banner ever renders. Flip
    // the scan flag in a microtask so the greeting re-runs AFTER the scan with
    // fresh state (a microtask also keeps the cascading-render lint happy).
    queueMicrotask(() => setAutosaveScanned(true))

    // Safety net: commit any dangling drag gesture (e.g. pointer released
    // outside the clip after capture loss) so history never stays open.
    // Pointer-scoped: a pointerup from a DIFFERENT pointer than the one that
    // started the live gesture must not end it (multi-touch); pointerless
    // events (blur) and pointerless synthetic events always apply.
    const commitDangling = (ev?: PointerEvent) => {
      const state = useEditorStore.getState()
      const owner = activeTransientPointerId()
      if (ev && owner !== null && ev.pointerId !== owner) return
      state.commitTransient()
    }
    // One function object for add + remove: two inline closures would never
    // match, so the blur listener would leak past the unmount.
    const onBlur = () => commitDangling()
    window.addEventListener('pointerup', commitDangling)
    window.addEventListener('blur', onBlur)
    return () => {
      unsubscribe()
      window.removeEventListener('pointerup', commitDangling)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  // When the doc changes while paused, refresh the preview frame.
  useEffect(() => {
    refreshPausedPreview()
  }, [doc])

  // Welcome: once per new version, AFTER the autosave scan finished AND the
  // restore prompt resolved, so two dialogs never stack. The restore banner is
  // inline (not a dialog), but the same one-decision-at-a-time rule applies:
  // while it waits, the release notes hold back; the moment it is gone
  // (restored, discarded, or never there), a version the user has not been
  // greeted with opens the modal once and is recorded. Help > What's new opens
  // the same modal any time.
  useEffect(() => {
    if (!autosaveScanned || pendingRestore) return
    let seen: string | null = null
    try {
      seen = window.localStorage.getItem('releases:lastSeen')
    } catch {
      /* private mode: greet every visit rather than crash */
    }
    if (seen === CURRENT_VERSION) return
    // Defer the setState out of the effect body: opening synchronously inside
    // the effect trips the cascading-render lint rule, and a microtask keeps
    // the greeting one paint later without observable difference.
    queueMicrotask(() => setReleaseNotesOpen(true))
    try {
      window.localStorage.setItem('releases:lastSeen', CURRENT_VERSION)
    } catch {
      /* storage unavailable: the greeting just repeats, harmless */
    }
  }, [pendingRestore, autosaveScanned])

  const handleSave = useCallback(() => {
    const state = useEditorStore.getState()
    const json = JSON.stringify(serializeDoc(state.doc), null, 2)
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = projectFileName(state.doc.project.name)
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
  }, [])

  useEditorKeyboard(handleSave)

  const restoreAutosave = async () => {
    try {
      const json = pendingRestore
      if (!json) return
      const { doc: restored } = parseAutosave(json)
      // Bundled samples are the only media the app can refetch by itself, so
      // they are merged into the doc BEFORE it is installed: the restore stays
      // one undo step instead of appending a history entry per relinked file.
      const { doc, relinked, remaining, failed } = await hydrateSampleMedia(restored)
      // Installing a project invalidates any in-flight project load; the bump
      // and the install are one step, so no load can land in between them.
      bumpProjectGeneration()
      useEditorStore.getState().replaceDoc(doc)
      useEditorStore.getState().setPendingRestore(null)
      // Hydration returns failures instead of toasting them, so they are
      // reported here, against the session that actually got installed.
      for (const name of failed) {
        toast({ title: 'Sample unavailable', description: name, variant: 'destructive' })
      }
      toast({
        title: 'Session restored',
        description:
          remaining > 0
            ? `${remaining} media file(s) need relinking`
            : relinked > 0
              ? `${relinked} sample file(s) relinked automatically`
              : doc.media.length > 0
                ? `All ${doc.media.length} media file(s) are back online`
                : undefined,
      })
    } catch {
      toast({ title: 'Restore failed', variant: 'destructive' })
      clearAutosave()
      useEditorStore.getState().setPendingRestore(null)
    }
  }

  const discardAutosave = () => {
    clearAutosave()
    useEditorStore.getState().setPendingRestore(null)
  }

  const showUpperRow = !hidden.preview || !hidden.inspector

  return (
    /* Theme lives on <html> (layout.tsx) so Radix portals — menubar dropdowns,
       dialogs, selects, toasts — inherit the dark tokens too, not just this div. */
    <div className="flex h-dvh w-full flex-col overflow-hidden bg-background text-foreground">
      <MenuBar
        onOpenExport={() => setExportOpen(true)}
        onResetLayout={handleResetLayout}
        onOpenReleaseNotes={() => setReleaseNotesOpen(true)}
      />
      <Toolbar onOpenExport={() => setExportOpen(true)} />

      {pendingRestore && (
        <div
          role="status"
          className="flex items-center justify-between gap-2 border-b bg-amber-500/10 px-3 py-1.5 text-xs text-amber-200"
        >
          <span>Found an autosaved session from your last visit.</span>
          <span className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant="secondary"
              className="h-6 gap-1 px-2 text-xs"
              onClick={() => void restoreAutosave()}
            >
              <RotateCcw className="size-3" /> Restore
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 gap-1 px-2 text-xs"
              onClick={discardAutosave}
            >
              <X className="size-3" /> Discard
            </Button>
          </span>
        </div>
      )}

      {isMobile ? (
        <CompactLayout />
      ) : (
        /* Root: media pool | main area */
        <ResizablePanelGroup
          direction="horizontal"
          className="min-h-0 flex-1"
          onLayout={handleMediaLayout}
        >
          {!hidden.media && (
            <>
              <PanelShell
                id="media"
                title="Media"
                side="left"
                order={1}
                minSize={PANEL_BOUNDS.media.min}
                maxSize={PANEL_BOUNDS.media.max}
                defaultSize={sizes.media}
                registerRef={registerRef}
                className="bg-card"
              >
                <MediaBin heading={false} className="min-h-0 flex-1" />
              </PanelShell>
              <HandleWithReset
                ariaLabel="Resize media panel (double-click to reset)"
                onReset={() => resetPanel('media')}
              />
            </>
          )}

          {/* Main area: fills the rest of the root group */}
          <ResizablePanel id="panel-main" order={2} className="min-h-0 min-w-0">
            {/* Vertical split: upper row | timeline */}
            <ResizablePanelGroup
              direction="vertical"
              className="min-h-0"
              onLayout={handleTimelineLayout}
            >
              <ResizablePanel id="panel-upper" order={1} className="min-h-0">
                {showUpperRow ? (
                  /* Upper row: program monitor | inspector */
                  <ResizablePanelGroup
                    direction="horizontal"
                    className="min-h-0"
                    onLayout={handleInspectorLayout}
                  >
                    {!hidden.preview && (
                      /* `flex` on the Panel div is required: react-resizable-panels
                         renders a plain block box, so without it PreviewPanel's
                         flex column never inherits the panel height and the
                         transport row gets clipped when this row is resized short. */
                      <ResizablePanel id="panel-preview" order={1} className="flex min-h-0 min-w-0">
                        <PreviewPanel />
                      </ResizablePanel>
                    )}
                    {!hidden.preview && !hidden.inspector && (
                      <HandleWithReset
                        ariaLabel="Resize inspector panel (double-click to reset)"
                        onReset={() => resetPanel('inspector')}
                      />
                    )}
                    {!hidden.inspector && (
                      <PanelShell
                        id="inspector"
                        title="Inspector"
                        side="right"
                        order={2}
                        minSize={PANEL_BOUNDS.inspector.min}
                        maxSize={PANEL_BOUNDS.inspector.max}
                        defaultSize={sizes.inspector}
                        registerRef={registerRef}
                        className="bg-card"
                      >
                        <InspectorPanel className="flex-1" />
                      </PanelShell>
                    )}
                  </ResizablePanelGroup>
                ) : (
                  <div className="flex-1" />
                )}
              </ResizablePanel>

              {!hidden.timeline && (
                <>
                  <HandleWithReset
                    ariaLabel="Resize timeline panel (double-click to reset)"
                    onReset={() => resetPanel('timeline')}
                  />
                  <PanelShell
                    id="timeline"
                    title="Timeline"
                    side="bottom"
                    order={2}
                    minSize={PANEL_BOUNDS.timeline.min}
                    maxSize={PANEL_BOUNDS.timeline.max}
                    defaultSize={sizes.timeline}
                    registerRef={registerRef}
                  >
                    <TimelinePanel />
                  </PanelShell>
                </>
              )}
            </ResizablePanelGroup>
          </ResizablePanel>
        </ResizablePanelGroup>
      )}

      <StatusBar />
      <MarkerDialog />
      <ExportDialog open={exportOpen} onOpenChange={setExportOpen} />
      <ReleaseNotesModal open={releaseNotesOpen} onOpenChange={setReleaseNotesOpen} />
    </div>
  )
}

/**
 * Fixed (pre-workspace) stacked layout for small screens: media bin hidden
 * below md, inspector hidden below lg, timeline at a fixed fraction.
 */
function CompactLayout() {
  return (
    <>
      <div className="flex min-h-0 flex-1">
        <MediaBin className="hidden w-60 shrink-0 border-r md:flex" />
        <PreviewPanel />
        <InspectorPanel className="hidden w-80 shrink-0 border-l lg:flex" />
      </div>
      <div className="flex h-[38vh] min-h-[220px] shrink-0 flex-col border-t">
        <TimelinePanel />
      </div>
    </>
  )
}

/** Resize handle with the double-click-to-reset affordance. */
function HandleWithReset({ ariaLabel, onReset }: { ariaLabel: string; onReset: () => void }) {
  return (
    <ResizableHandle
      aria-label={ariaLabel}
      title={ariaLabel}
      onDoubleClick={onReset}
      className="w-1.5 after:w-1.5 data-[panel-group-direction=vertical]:h-1.5 data-[panel-group-direction=vertical]:after:h-1.5"
    />
  )
}

export default EditorShell
