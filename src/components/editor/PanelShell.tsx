'use client'

import { useEffect, useRef } from 'react'
import type { ImperativePanelHandle } from 'react-resizable-panels'

import { ResizablePanel } from '@/components/ui/resizable'
import { cn } from '@/lib/utils'

import type { PanelId } from '@/lib/editor/workspace'
import { PanelMenu } from './PanelMenu'

/**
 * A workspace panel frame: a slim header (title and panel menu)
 * wrapped in a resizable `Panel`. Closing is handled by the panel menu and the
 * Window menu; there is no strip state. The parent registers the imperative
 * panel handle so a double-click on a resize handle can reset the neighboring
 * panel to its default size.
 */
export function PanelShell({
  id,
  title,
  minSize,
  maxSize,
  defaultSize,
  order,
  children,
  registerRef,
  className,
}: {
  id: PanelId
  title: string
  minSize: number
  maxSize?: number
  defaultSize?: number
  /** Stable position within its group (required for dynamically rendered panels). */
  order?: number
  children: React.ReactNode
  registerRef?: (id: PanelId, ref: ImperativePanelHandle | null) => void
  className?: string
}) {
  const panelRef = useRef<ImperativePanelHandle | null>(null)

  useEffect(() => {
    registerRef?.(id, panelRef.current)
    return () => registerRef?.(id, null)
  }, [id, registerRef])

  return (
    <ResizablePanel
      ref={panelRef}
      id={`panel-${id}`}
      order={order}
      minSize={minSize}
      maxSize={maxSize}
      defaultSize={defaultSize}
      className={cn('min-h-0 min-w-0', className)}
    >
      <div className="flex h-full min-h-0 min-w-0 flex-col">
        <div className="bg-card flex h-7 shrink-0 items-center justify-between gap-1 border-b px-2">
          <h2 className="text-muted-foreground truncate text-[11px] font-semibold tracking-wide uppercase">
            {title}
          </h2>
          <div className="flex items-center gap-0.5">
            <PanelMenu id={id} title={title} />
          </div>
        </div>
        {/* `flex flex-col` is required: react-resizable-panels renders a plain
            block box, so children with flex-1/overflow-y-auto (MediaBin list,
            InspectorPanel) never inherited a height constraint — the content
            just grew past the panel and got clipped with no scrollbar. */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{children}</div>
      </div>
    </ResizablePanel>
  )
}
