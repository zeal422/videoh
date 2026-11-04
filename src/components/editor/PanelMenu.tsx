'use client'

import { useRef } from 'react'
import { flushSync } from 'react-dom'
import { MoreHorizontal, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { PanelId } from '@/lib/editor/workspace'
import { useWorkspaceStore } from '@/lib/editor/workspace-store'

const TRIGGER_SELECTOR = '[data-testid^="panel-menu-"]'

/**
 * Desktop panel header menu. `Close Panel` removes the panel; Escape and
 * outside-click dismissals leave Radix's own trigger focus restoration intact.
 */
export function PanelMenu({ id, title }: { id: PanelId; title: string }) {
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  // Set only by Close Panel. Null means a dismissal, where the trigger still
  // exists and Radix should restore focus to it.
  const closeFocusRef = useRef<number | null>(null)

  const moveFocus = (savedIndex: number | null) => {
    const triggers = Array.from(document.querySelectorAll<HTMLElement>(TRIGGER_SELECTOR))
    if (triggers.length === 0) {
      document.querySelector<HTMLElement>('[data-testid="menubar-window"]')?.focus()
      return
    }
    const index = savedIndex === null || savedIndex >= triggers.length ? 0 : savedIndex
    triggers[index]?.focus()
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          ref={triggerRef}
          variant="ghost"
          size="icon"
          className="size-5"
          data-testid={`panel-menu-${id}`}
          aria-label={`${title} panel menu`}
          title={`${title} panel menu`}
        >
          <MoreHorizontal className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        onCloseAutoFocus={(event) => {
          const savedIndex = closeFocusRef.current
          if (savedIndex === null) return
          event.preventDefault()
          closeFocusRef.current = null
          moveFocus(savedIndex)
        }}
      >
        <DropdownMenuItem
          onSelect={() => {
            const triggers = Array.from(document.querySelectorAll<HTMLElement>(TRIGGER_SELECTOR))
            const index = triggerRef.current ? triggers.indexOf(triggerRef.current) : -1
            // A failed capture still moves focus to the first trigger rather
            // than leaving it on the removed element. The focus test asserts
            // the index is valid.
            closeFocusRef.current = index >= 0 ? index : 0
            flushSync(() => useWorkspaceStore.getState().setHidden(id, true))
          }}
        >
          <X className="size-3.5" />
          Close Panel
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
