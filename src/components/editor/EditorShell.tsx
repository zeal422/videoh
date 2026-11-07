'use client'

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RotateCcw, X } from 'lucide-react'
import type { ImperativePanelGroupHandle, ImperativePanelHandle } from 'react-resizable-panels'

import { Button } from '@/components/ui/button'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { PanelShell } from './PanelShell'
import { ColorFilterDefs } from './ColorFilterDefs'
import { MenuBar } from './MenuBar'
import { Toolbar } from './Toolbar'
import { MediaBin } from './MediaBin'
import { PreviewPanel } from './PreviewPanel'
import { SourcePanel } from './SourcePanel'
import { InspectorPanel } from './InspectorPanel'
import { CaptionsPanel } from './CaptionsPanel'
import { TimelinePanel } from './timeline/TimelinePanel'
import { MarkerDialog } from './timeline/MarkerDialog'
import { StatusBar } from './StatusBar'
import { ExportDialog } from './ExportDialog'
import { ReleaseNotesModal } from './ReleaseNotesModal'
import { CURRENT_VERSION } from '@/lib/releases'
import { useEditorKeyboard } from '@/hooks/editor/useEditorKeyboard'
import { useIsMobile } from '@/hooks/use-mobile'
import { refreshPausedPreview } from '@/lib/editor/playback/preview'
import {
  activeTransientPointerId,
  isTransientActive,
  useEditorStore,
  useStableDoc,
} from '@/lib/editor/store'
import {
  createResetTracker,
  isExpectedPanelLayout,
  PANEL_BOUNDS,
  RESET_GROUP_SPECS,
  type ExpectedPanelSlot,
  type PanelId,
  type ResetGroupId,
} from '@/lib/editor/workspace'
import { useWorkspaceStore } from '@/lib/editor/workspace-store'
import {
  clearAutosave,
  initAutosave,
  parseAutosave,
  readValidAutosave,
} from '@/lib/editor/persistence'
import { projectFileName, serializeDoc } from '@/lib/editor/serialization'
import { bumpProjectGeneration } from '@/lib/editor/project-io'
import { revokeAllProxies } from '@/lib/editor/media/proxies'
import { disposeAll, syncFilmstrips } from '@/lib/editor/media/filmstrip-cache'
import { toast } from '@/hooks/use-toast'

/**
 * App shell — Premiere-style workspace layout:
 *
 *   menubar (top) · toolbar · [ (media | source | preview | inspector) over (timeline | captions) ] · status bar
 *
 * Desktop (≥768px): every region is a resizable panel
 * (react-resizable-panels). Sizes persist to localStorage; the Window menu
 * and each panel header menu show/hide panels; double-clicking a resize handle
 * resets its neighbor. The inspector shares the top row, so the timeline spans
 * the full width below it. Mobile: fixed stacked layout (panels fall back to
 * their pre-workspace form). The status bar acts as the always-pinned footer of
 * the application.
 */
export function EditorShell() {
  const [exportOpen, setExportOpen] = useState(false)
  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false)
  // False until the mount effect finished the autosave discovery; the greeting
  // effect holds back until this flips (see the scan comment below).
  const [autosaveScanned, setAutosaveScanned] = useState(false)
  const isMobile = useIsMobile()
  const doc = useStableDoc()
  const pendingRestore = useEditorStore((s) => s.pendingRestore)
  const lockNotice = useEditorStore((s) => s.lockNotice)
  const hidden = useWorkspaceStore((s) => s.hidden)
  const sizes = useWorkspaceStore((s) => s.sizes)
  const setSize = useWorkspaceStore((s) => s.setSize)
  const resetWorkspace = useWorkspaceStore((s) => s.resetWorkspace)
  const upperRowPanelCount =
    Number(!hidden.media) + Number(!hidden.source) + Number(!hidden.preview)
  const bottomRowPanelCount = Number(!hidden.timeline) + Number(!hidden.captions)
  const showUpperRow = !hidden.media || !hidden.preview || !hidden.source
  const showUpperArea = showUpperRow || !hidden.inspector
  const showBottomArea = !hidden.timeline || !hidden.captions

  // Imperative handles for "double-click handle → reset neighbor to default".
  const panelRefs = useRef<Partial<Record<PanelId, ImperativePanelHandle | null>>>({})
  // The bottom group panel is a bare panel (no PanelShell chrome), so it
  // carries its own ref: resetting the bottom height targets the group, not
  // the timeline's width share inside it.
  const bottomPanelRef = useRef<ImperativePanelHandle | null>(null)
  // Group refs feed the reset tracker's post-issue `getLayout()` reads, which
  // count an already-default layout that emits no onLayout change.
  const upperGroupRef = useRef<ImperativePanelGroupHandle | null>(null)
  const topRowGroupRef = useRef<ImperativePanelGroupHandle | null>(null)
  const bottomGroupRef = useRef<ImperativePanelGroupHandle | null>(null)
  const verticalGroupRef = useRef<ImperativePanelGroupHandle | null>(null)
  const resetWriteRef = useRef(false)

  const registerRef = useCallback((id: PanelId, ref: ImperativePanelHandle | null) => {
    panelRefs.current[id] = ref
  }, [])

  const issueResetResizes = useCallback((groups: ResetGroupId[]) => {
    const wanted = new Set(groups)
    if (wanted.has('upper') && (upperGroupRef.current?.getLayout().length ?? 0) >= 2) {
      panelRefs.current.media?.resize(PANEL_BOUNDS.media.default)
      panelRefs.current.source?.resize(PANEL_BOUNDS.source.default)
    }
    if (wanted.has('top') && (topRowGroupRef.current?.getLayout().length ?? 0) === 2) {
      panelRefs.current.inspector?.resize(PANEL_BOUNDS.inspector.default)
    }
    if (wanted.has('bottom') && (bottomGroupRef.current?.getLayout().length ?? 0) === 2) {
      panelRefs.current.captions?.resize(PANEL_BOUNDS.captions.default)
    }
    if (wanted.has('vertical') && (verticalGroupRef.current?.getLayout().length ?? 0) === 2) {
      bottomPanelRef.current?.resize(PANEL_BOUNDS.timeline.default)
    }
  }, [])

  const readResetLayouts = useCallback(
    (): Partial<Record<ResetGroupId, number[]>> => ({
      upper: upperGroupRef.current?.getLayout(),
      top: topRowGroupRef.current?.getLayout(),
      bottom: bottomGroupRef.current?.getLayout(),
      vertical: verticalGroupRef.current?.getLayout(),
    }),
    [],
  )

  const resetTracker = useMemo(
    () =>
      createResetTracker({
        groups: RESET_GROUP_SPECS,
        hooks: { issueResizes: issueResetResizes, readLayouts: readResetLayouts },
        scheduleFrame: (callback) => requestAnimationFrame(callback),
        cancelFrame: (handle) => cancelAnimationFrame(handle),
        scheduleTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
        cancelTimer: (handle) => window.clearTimeout(handle),
      }),
    [issueResetResizes, readResetLayouts],
  )

  // A user hide/show supersedes a pending reset. The reset's own store write is
  // guarded so it does not cancel its own token.
  useEffect(
    () =>
      useWorkspaceStore.subscribe((state, previous) => {
        if (state.hidden === previous.hidden) return
        if (resetWriteRef.current) return
        resetTracker.cancel()
      }),
    [resetTracker],
  )

  // Cancel a pending reset when the shell unmounts: its timer and frame must
  // not touch refs from a dead tree.
  useEffect(() => () => resetTracker.cancel(), [resetTracker])

  const resetPanel = useCallback(
    (id: PanelId) => {
      const bounds = PANEL_BOUNDS[id as keyof typeof PANEL_BOUNDS]
      if (!bounds) return
      if (id === 'timeline') return
      if ((id === 'media' || id === 'source') && upperRowPanelCount < 2) return
      if (id === 'inspector' && (!showUpperRow || hidden.inspector)) return
      if (id === 'captions' && (hidden.timeline || hidden.captions)) return
      panelRefs.current[id]?.resize(bounds.default)
    },
    [hidden.captions, hidden.inspector, hidden.timeline, showUpperRow, upperRowPanelCount],
  )

  const resetBottomRow = useCallback(() => {
    if (!showUpperArea || !showBottomArea) return
    bottomPanelRef.current?.resize(PANEL_BOUNDS.timeline.default)
  }, [showBottomArea, showUpperArea])

  const cancelPendingReset = useCallback(() => resetTracker.cancel(), [resetTracker])

  /** Window › Reset Workspace Layout: persist defaults, then let the tracker
   *  apply them to the live panels and wait for a post-issue layout per group. */
  const handleResetLayout = useCallback(() => {
    resetWriteRef.current = true
    try {
      resetWorkspace()
    } finally {
      resetWriteRef.current = false
    }
    resetTracker.begin()
  }, [resetTracker, resetWorkspace])

  // Layout observers. Only persist while the measured panel is actually
  // rendered — otherwise group indices shift and would store the wrong panel.
  const handleTopRowLayout = useCallback(
    (layout: number[]) => {
      const token = resetTracker.pendingToken()
      if (token !== null) {
        resetTracker.noteLayout(token, 'top', layout)
        return
      }
      const expectedLength = showUpperRow ? 2 : 1
      const entries: ExpectedPanelSlot[] = showUpperRow
        ? [{ index: 1, bounds: PANEL_BOUNDS.inspector }]
        : []
      if (!isExpectedPanelLayout(layout, expectedLength, entries)) return
      if (showUpperRow) setSize('inspector', layout[1])
    },
    [resetTracker, setSize, showUpperRow],
  )

  const handleTimelineLayout = useCallback(
    (layout: number[]) => {
      const token = resetTracker.pendingToken()
      if (token !== null) {
        resetTracker.noteLayout(token, 'vertical', layout)
        return
      }
      const bothRows = showUpperArea && showBottomArea
      const entries: ExpectedPanelSlot[] = bothRows
        ? [{ index: 1, bounds: PANEL_BOUNDS.timeline }]
        : []
      if (!isExpectedPanelLayout(layout, bothRows ? 2 : 1, entries)) return
      if (bothRows) setSize('timeline', layout[1])
    },
    [resetTracker, setSize, showBottomArea, showUpperArea],
  )

  const handleBottomRowLayout = useCallback(
    (layout: number[]) => {
      const token = resetTracker.pendingToken()
      if (token !== null) {
        resetTracker.noteLayout(token, 'bottom', layout)
        return
      }
      const bothVisible = !hidden.timeline && !hidden.captions
      const entries: ExpectedPanelSlot[] = bothVisible
        ? [{ index: 1, bounds: PANEL_BOUNDS.captions }]
        : []
      if (!isExpectedPanelLayout(layout, bottomRowPanelCount, entries)) return
      if (bothVisible) setSize('captions', layout[1])
    },
    [bottomRowPanelCount, hidden.captions, hidden.timeline, resetTracker, setSize],
  )

  const handleUpperRowLayout = useCallback(
    (layout: number[]) => {
      const token = resetTracker.pendingToken()
      if (token !== null) {
        resetTracker.noteLayout(token, 'upper', layout)
        return
      }
      // Without the preview's auto remainder the fixed panels normalize to the
      // full row, and a lone panel is forced to fill it. Neither value is the
      // user's chosen width, so persist nothing while the preview is hidden.
      if (hidden.preview) return
      const entries: ExpectedPanelSlot[] = []
      if (!hidden.media) entries.push({ index: 0, bounds: PANEL_BOUNDS.media })
      if (!hidden.source) {
        entries.push({ index: hidden.media ? 0 : 1, bounds: PANEL_BOUNDS.source })
      }
      if (!isExpectedPanelLayout(layout, upperRowPanelCount, entries)) return
      if (!hidden.media) setSize('media', layout[0])
      if (!hidden.source) setSize('source', layout[hidden.media ? 0 : 1])
    },
    [hidden.media, hidden.preview, hidden.source, resetTracker, setSize, upperRowPanelCount],
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

  // When the doc changes while paused, refresh the preview frame. A transient
  // drag frame (0.18.0) only moves clips; seeking the preview on every one of
  // them was a large part of the drag cost. The commit/cancel that follows
  // ends the transient, so its doc change still refreshes.
  useEffect(() => {
    if (isTransientActive()) return
    refreshPausedPreview()
  }, [doc])

  // One lock refusal message, from any dispatch path (0.14.0). The command
  // layer is the authority; the store records the refusal instead of throwing
  // so a keyboard repeat or a slider commit reports it here exactly once.
  useEffect(() => {
    if (!lockNotice) return
    toast({
      title: 'Track locked',
      description: lockNotice.message,
      variant: 'destructive',
    })
  }, [lockNotice])

  // Filmstrip asset lifecycle: the store update that installs a project,
  // removes media, or relinks a file runs this BEFORE React re-renders, so a
  // stale strip or hidden element cannot survive into the new render. The
  // first sync only seeds the project identity: it must not dispose requests
  // the just-mounted clips already queued.
  useEffect(() => {
    const sync = (state: ReturnType<typeof useEditorStore.getState>) => {
      syncFilmstrips(state.doc.media, state.doc.project.id)
    }
    sync(useEditorStore.getState())
    const unsubscribe = useEditorStore.subscribe((state, previous) => {
      if (
        state.doc.media !== previous.doc.media ||
        state.doc.project.id !== previous.doc.project.id
      )
        sync(state)
    })
    return () => {
      unsubscribe()
      disposeAll()
    }
  }, [])

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
      const { doc, warnings } = parseAutosave(json)
      // Installing a project invalidates any in-flight project load; the bump
      // and the install are one step, so no load can land in between them.
      bumpProjectGeneration()
      revokeAllProxies()
      useEditorStore.getState().replaceDoc(doc)
      useEditorStore.getState().setPendingRestore(null)
      const remaining = doc.media.filter((asset) => asset.missing).length
      const description = [
        remaining > 0
          ? `${remaining} media file(s) need relinking.`
          : doc.media.length > 0
            ? `All ${doc.media.length} media file(s) are back online.`
            : undefined,
        ...warnings,
      ]
        .filter(Boolean)
        .join(' ')
      toast({
        title: 'Session restored',
        description: description || undefined,
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

  return (
    /* Theme lives on <html> (layout.tsx) so Radix portals — menubar dropdowns,
       dialogs, selects, toasts — inherit the dark tokens too, not just this div. */
    <div className="flex h-dvh w-full flex-col overflow-hidden bg-background text-foreground">
      {/* Temperature/tint grades live in one hidden svg: both render paths
          reference these filter ids as url(#...) inside ctx.filter. */}
      <ColorFilterDefs />
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
      ) : !showUpperArea && !showBottomArea ? (
        <div
          data-testid="workspace-empty"
          className="text-muted-foreground flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center"
        >
          <p className="text-sm font-medium">No panels are open</p>
          <p className="text-xs">
            Open a panel from the Window menu or use Reset Workspace Layout.
          </p>
        </div>
      ) : (
        /* Root: top row (workspace | inspector) over the bottom row
           (timeline | captions). The inspector shares the top row, so the
           timeline spans the full width below it. */
        <ResizablePanelGroup
          direction="vertical"
          ref={verticalGroupRef}
          className="min-h-0 flex-1"
          onLayout={handleTimelineLayout}
        >
          {showUpperArea && (
            <ResizablePanel key="upper" id="panel-upper" order={1} className="min-h-0">
              <ResizablePanelGroup
                direction="horizontal"
                ref={topRowGroupRef}
                className="min-h-0"
                onLayout={handleTopRowLayout}
              >
                {/* Workspace column: the upper row (media | source | preview).
                    The inspector's width comes out of this row, not the timeline
                    below. */}
                {showUpperRow && (
                  <ResizablePanel
                    key="workspace"
                    id="panel-workspace"
                    order={1}
                    className="min-h-0 min-w-0"
                  >
                    <ResizablePanelGroup
                      // The library keeps the previous layout array when the
                      // auto-sized preview panel unmounts. Hiding it after
                      // Hiding it after Media closed left a stale 3-panel layout
                      // and crashed in callPanelCallbacks ("Panel data not found
                      // for index 2") at the battery's short viewport. Remount on
                      // the preview flag only, so the layout is rebuilt from the
                      // persisted default sizes; Media/Source hides keep the group
                      // mounted.
                      key={`upper-${Number(!hidden.preview)}`}
                      ref={upperGroupRef}
                      direction="horizontal"
                      className="min-h-0"
                      onLayout={handleUpperRowLayout}
                    >
                      {!hidden.media && (
                        <Fragment key="media">
                          <PanelShell
                            id="media"
                            title="Media"
                            order={1}
                            minSize={PANEL_BOUNDS.media.min}
                            maxSize={PANEL_BOUNDS.media.max}
                            defaultSize={sizes.media}
                            registerRef={registerRef}
                            className="bg-card"
                          >
                            <MediaBin heading={false} className="min-h-0 flex-1" />
                          </PanelShell>
                          {(!hidden.source || !hidden.preview) && (
                            <HandleWithReset
                              ariaLabel="Resize media panel (double-click to reset)"
                              onReset={() => resetPanel('media')}
                              onGestureStart={cancelPendingReset}
                            />
                          )}
                        </Fragment>
                      )}
                      {!hidden.source && (
                        <PanelShell
                          key="source"
                          id="source"
                          title="Source Monitor"
                          order={2}
                          minSize={PANEL_BOUNDS.source.min}
                          maxSize={PANEL_BOUNDS.source.max}
                          defaultSize={sizes.source}
                          registerRef={registerRef}
                          className="bg-card"
                        >
                          <SourcePanel className="flex-1" />
                        </PanelShell>
                      )}
                      {!hidden.source && !hidden.preview && (
                        <HandleWithReset
                          key="source-handle"
                          ariaLabel="Resize source panel (double-click to reset)"
                          onReset={() => resetPanel('source')}
                          onGestureStart={cancelPendingReset}
                        />
                      )}
                      {!hidden.preview && (
                        <PanelShell
                          key="preview"
                          id="preview"
                          title="Program Monitor"
                          order={3}
                          minSize={0}
                          registerRef={registerRef}
                        >
                          <PreviewPanel />
                        </PanelShell>
                      )}
                    </ResizablePanelGroup>
                  </ResizablePanel>
                )}

                {showUpperRow && !hidden.inspector && (
                  <HandleWithReset
                    key="inspector-handle"
                    ariaLabel="Resize inspector panel (double-click to reset)"
                    onReset={() => resetPanel('inspector')}
                    onGestureStart={cancelPendingReset}
                  />
                )}
                {!hidden.inspector && (
                  <PanelShell
                    key="inspector"
                    id="inspector"
                    title="Inspector"
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
            </ResizablePanel>
          )}

          {showBottomArea && (
            <Fragment key="bottom">
              {showUpperArea && (
                <HandleWithReset
                  key="vertical-handle"
                  ariaLabel="Resize timeline panel (double-click to reset)"
                  onReset={resetBottomRow}
                  onGestureStart={cancelPendingReset}
                />
              )}
              <ResizablePanel
                id="panel-bottom"
                order={2}
                ref={bottomPanelRef}
                minSize={PANEL_BOUNDS.timeline.min}
                maxSize={showUpperArea ? PANEL_BOUNDS.timeline.max : undefined}
                defaultSize={sizes.timeline}
                className="min-h-0"
              >
                {/* Bottom row: timeline | captions. The timeline fills the
                    remainder horizontally (no defaultSize, like the preview
                    upstairs); sizes.timeline keeps meaning the bottom group's
                    vertical share. */}
                <ResizablePanelGroup
                  direction="horizontal"
                  ref={bottomGroupRef}
                  className="min-h-0"
                  onLayout={handleBottomRowLayout}
                >
                  {!hidden.timeline && (
                    <PanelShell
                      key="timeline"
                      id="timeline"
                      title="Timeline"
                      order={1}
                      minSize={PANEL_BOUNDS.timeline.min}
                      registerRef={registerRef}
                    >
                      <TimelinePanel />
                    </PanelShell>
                  )}
                  {!hidden.timeline && !hidden.captions && (
                    <HandleWithReset
                      key="captions-handle"
                      ariaLabel="Resize captions panel (double-click to reset)"
                      onReset={() => resetPanel('captions')}
                      onGestureStart={cancelPendingReset}
                    />
                  )}
                  {!hidden.captions && (
                    <PanelShell
                      key="captions"
                      id="captions"
                      title="Captions"
                      order={2}
                      minSize={PANEL_BOUNDS.captions.min}
                      maxSize={!hidden.timeline ? PANEL_BOUNDS.captions.max : undefined}
                      defaultSize={hidden.timeline ? undefined : sizes.captions}
                      registerRef={registerRef}
                    >
                      <CaptionsPanel />
                    </PanelShell>
                  )}
                </ResizablePanelGroup>
              </ResizablePanel>
            </Fragment>
          )}
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
function HandleWithReset({
  ariaLabel,
  onReset,
  onGestureStart,
}: {
  ariaLabel: string
  onReset: () => void
  onGestureStart?: () => void
}) {
  return (
    <ResizableHandle
      aria-label={ariaLabel}
      title={ariaLabel}
      onDoubleClick={onReset}
      onPointerDown={onGestureStart}
      onKeyDown={onGestureStart}
      className="w-1.5 after:w-1.5 data-[panel-group-direction=vertical]:h-1.5 data-[panel-group-direction=vertical]:after:h-1.5"
    />
  )
}

export default EditorShell
