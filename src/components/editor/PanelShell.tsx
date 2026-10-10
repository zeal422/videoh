'use client'

import { useEffect, useRef } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from 'lucide-react'
import type { ImperativePanelHandle } from 'react-resizable-panels'

import { Button } from '@/components/ui/button'
import { ResizablePanel } from '@/components/ui/resizable'
import { cn } from '@/lib/utils'

import { COLLAPSED_SIZE_PCT, type PanelId } from '@/lib/editor/workspace'
import { useWorkspaceStore } from '@/lib/editor/workspace-store'

/**
 * A workspace panel frame: slim header (title + actions + collapse chevron)
 * wrapped in a resizable, collapsible `Panel`.
 *
 * Collapse behavior: the chevron (or dragging the resize handle past the
 * minimum) collapses the panel to a slim strip that shows the title rotated
 * (vertical panels) or inline (bottom panel); clicking it expands the panel
 * again. Collapse/expand state lives in the workspace store and is persisted.
 *
 * A collapsible panel only collapses cleanly when the space it frees can be
 * absorbed by the panel to its right: `react-resizable-panels` flows the
 * collapse delta that way, so a panel placed in the middle depends on its
 * neighbour's headroom. When the delta cannot be absorbed the library refuses
 * and leaves the layout untouched, which is why the effect below reconciles the
 * store against the library's real state. Prefer placing collapsible panels
 * first in a group rather than in the middle.
 *
 * The parent registers the imperative panel handle so a double-click on a
 * resize handle can reset the neighboring panel to its default size.
 */
export function PanelShell({
  id,
  title,
  side,
  minSize,
  maxSize,
  defaultSize,
  order,
  headerActions,
  children,
  registerRef,
  className,
}: {
  id: PanelId
  title: string
  /** Which edge the panel hugs — decides chevron direction + strip orientation. */
  side: 'left' | 'right' | 'bottom'
  minSize: number
  maxSize?: number
  defaultSize?: number
  /** Stable position within its group (required for dynamically rendered panels). */
  order?: number
  /** Optional controls rendered at the end of the header row. */
  headerActions?: React.ReactNode
  children: React.ReactNode
  registerRef?: (id: PanelId, ref: ImperativePanelHandle | null) => void
  className?: string
}) {
  const collapsed = useWorkspaceStore((s) => s.collapsed[id])
  const setCollapsed = useWorkspaceStore((s) => s.setCollapsed)
  const panelRef = useRef<ImperativePanelHandle | null>(null)
  // Tracks the previous store value so the imperative call only runs on change
  // (calling collapse() during mount with a persisted collapsed state is a no-op).
  const prevCollapsed = useRef<boolean | null>(null)
  // Mount directly at the collapsed size when restored collapsed — no flash.
  const initialSize = collapsed ? COLLAPSED_SIZE_PCT : defaultSize

  useEffect(() => {
    registerRef?.(id, panelRef.current)
    return () => registerRef?.(id, null)
  }, [id, registerRef])

  useEffect(() => {
    if (prevCollapsed.current === collapsed) return
    // On the mount pass the panel already mounts at the right size via
    // `initialSize`, so there is nothing to reconcile, and the library has no
    // computed layout yet (jsdom never has one, and `isCollapsed()` asserts).
    // Only a real transition can be refused, so only it needs the check.
    const isMount = prevCollapsed.current === null
    prevCollapsed.current = collapsed

    if (collapsed) panelRef.current?.collapse()
    else panelRef.current?.expand()

    if (isMount) return

    // The library owns the geometry and can refuse: its layout math falls back to
    // the previous layout when the delta has nowhere to go. Read its answer back
    // and correct ours, or the store claims a collapse that never happened.
    const actuallyCollapsed = panelRef.current?.isCollapsed() === true
    if (actuallyCollapsed !== collapsed) setCollapsed(id, actuallyCollapsed)
  }, [collapsed, id, setCollapsed])

  const expand = () => {
    setCollapsed(id, false)
    // Restore the last known expanded size if the panel never had one.
    if (!panelRef.current?.isExpanded()) panelRef.current?.expand()
  }

  const CollapseIcon = side === 'left' ? ChevronLeft : side === 'right' ? ChevronRight : ChevronDown
  const ExpandIcon = side === 'left' ? ChevronRight : side === 'right' ? ChevronLeft : ChevronUp
  const vertical = side !== 'bottom'

  return (
    <ResizablePanel
      ref={panelRef}
      id={`panel-${id}`}
      order={order}
      collapsible
      collapsedSize={COLLAPSED_SIZE_PCT}
      minSize={minSize}
      maxSize={maxSize}
      defaultSize={initialSize}
      onCollapse={() => setCollapsed(id, true)}
      onExpand={() => setCollapsed(id, false)}
      className={cn('min-h-0 min-w-0', className)}
    >
      {collapsed ? (
        <button
          type="button"
          onClick={expand}
          aria-label={`Expand ${title} panel`}
          title={`Expand ${title}`}
          className={cn(
            'text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring flex h-full w-full items-center justify-center gap-1 overflow-hidden bg-card focus-visible:ring-1 focus-visible:outline-none',
            vertical ? 'flex-col py-1' : 'flex-row px-2',
          )}
        >
          <ExpandIcon className={vertical ? 'size-3.5' : 'size-3.5 rotate-90'} />
          <span
            className={cn(
              'text-[11px] font-medium tracking-wide select-none',
              vertical && '[writing-mode:vertical-rl]',
            )}
          >
            {title}
          </span>
        </button>
      ) : (
        <div className="flex h-full min-h-0 min-w-0 flex-col">
          <div className="bg-card flex h-7 shrink-0 items-center justify-between gap-1 border-b px-2">
            <h2 className="text-muted-foreground truncate text-[11px] font-semibold tracking-wide uppercase">
              {title}
            </h2>
            <div className="flex items-center gap-0.5">
              {headerActions}
              <Button
                variant="ghost"
                size="icon"
                className="size-5"
                aria-label={`Collapse ${title} panel`}
                title={`Collapse ${title}`}
                onClick={() => setCollapsed(id, true)}
              >
                <CollapseIcon className="size-3.5" />
              </Button>
            </div>
          </div>
          {/* `flex flex-col` is required: react-resizable-panels renders a plain
              block box, so children with flex-1/overflow-y-auto (MediaBin list,
              InspectorPanel) never inherited a height constraint — the content
              just grew past the panel and got clipped with no scrollbar. */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{children}</div>
        </div>
      )}
    </ResizablePanel>
  )
}
