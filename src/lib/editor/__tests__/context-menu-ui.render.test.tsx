// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { installBrowserMocks, type MockHarness } from './mocks/browser-mocks'

/**
 * A context menu opens on `contextmenu`, which the browser fires BEFORE the
 * button is released. Radix's menu items treat a pointerup with no preceding
 * pointerdown on the item as a click, so the release that opened the menu used
 * to activate whichever item sat under the cursor (right-click a clip and the
 * Copy item fired: "Copied 2 clips", menu gone). The shared
 * `ContextMenuContent` now swallows non-primary releases in the capture phase;
 * these tests lock both halves of that: the stray release does nothing, a real
 * click still selects.
 */

let h: MockHarness

beforeEach(() => {
  h = installBrowserMocks()
  document.body.innerHTML = ''
})

afterEach(() => {
  cleanup()
  h.uninstall()
})

function Menu({ onSelect }: { onSelect: () => void }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button type="button">target</button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem data-testid="menu-copy" onSelect={onSelect}>
          Copy
        </ContextMenuItem>
        <ContextMenuItem data-testid="menu-delete" onSelect={onSelect}>
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

function openMenu() {
  fireEvent.contextMenu(screen.getByRole('button', { name: 'target' }))
  return screen.getByTestId('menu-copy')
}

describe('context menu release guard', () => {
  it('the right-button release that opened the menu does not activate the item under it', () => {
    const onSelect = vi.fn()
    render(<Menu onSelect={onSelect} />)
    const item = openMenu()

    fireEvent.pointerUp(item, { button: 2 })

    expect(onSelect).not.toHaveBeenCalled()
    // The menu must stay open: the user has not chosen anything yet.
    expect(screen.getByTestId('menu-copy')).toBeInTheDocument()
  })

  it('releases of any non-primary button are ignored too', () => {
    const onSelect = vi.fn()
    render(<Menu onSelect={onSelect} />)
    const item = openMenu()

    fireEvent.pointerUp(item, { button: 1 })

    expect(onSelect).not.toHaveBeenCalled()
  })

  it('a real primary click still selects the item', () => {
    const onSelect = vi.fn()
    render(<Menu onSelect={onSelect} />)
    const item = openMenu()

    // What a browser sends for a genuine click: down, up, then click.
    fireEvent.pointerDown(item, { button: 0 })
    fireEvent.pointerUp(item, { button: 0 })
    fireEvent.click(item, { button: 0 })

    expect(onSelect).toHaveBeenCalledTimes(1)
  })
})
