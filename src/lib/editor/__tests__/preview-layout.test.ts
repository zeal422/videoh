import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Preview/transport layout regression locks.
 *
 * jsdom cannot do real layout, so — like theme.test.ts — these are static
 * wiring locks for invariants that were once broken and browser-verified:
 *
 * 1. `panel-preview` MUST be a flex container. react-resizable-panels renders
 *    its Panel as a plain block box, so PreviewPanel's flex column never
 *    inherits the panel height otherwise. The transport row then overflows
 *    and gets clipped (overflow: hidden) whenever the timeline panel is
 *    resized taller — the "play buttons disappear" bug.
 *
 * 2. The transport row must be `shrink-0` with a fixed height so it stays
 *    visible at any panel height; only the canvas area gives up space.
 *
 * 3. The volume slider's visibility must key off the PANEL's width via a
 *    container query (`@lg:`), not the viewport (`sm:`) — a narrow preview
 *    (media + inspector maxed) must hide the slider instead of overflowing
 *    the row and clipping the buttons.
 *
 * 4. "Reset Workspace Layout" must imperatively resize the live panels
 *    (mounted panels never re-read their defaultSize prop) — otherwise the
 *    reset only fixes the persisted store and the visible layout stays put.
 */

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

describe('preview panel layout wiring', () => {
  it('mounts panel-preview as a flex container so the section inherits its height', () => {
    const shell = read('src/components/editor/EditorShell.tsx')
    const at = shell.indexOf('panel-preview')
    expect(at, 'EditorShell must render a panel-preview ResizablePanel').toBeGreaterThan(-1)
    const element = shell.slice(at, shell.indexOf('/>', at))
    expect(element).toMatch(/className="flex min-h-0 min-w-0"/)
  })

  it('keeps the transport row fixed-height and shrink-0 (always visible)', () => {
    const panel = read('src/components/editor/PreviewPanel.tsx')
    expect(panel).toMatch(/h-12[^"]*shrink-0|shrink-0[^"]*h-12/)
    // The canvas area is the flexible part that yields space.
    expect(panel).toMatch(/min-h-0[^"]*flex-1|flex-1[^"]*min-h-0/)
    // Never let the section grow past the panel box (panels clip overflow).
    expect(panel).toMatch(/overflow-hidden/)
  })

  it('gates the volume slider on the container width, not the viewport', () => {
    const panel = read('src/components/editor/PreviewPanel.tsx')
    expect(panel).toMatch(/@container/) // section establishes the container
    expect(panel).toMatch(/@lg:flex/) // volume appears when the panel is wide
    expect(panel).not.toMatch(/\bsm:flex\b/) // viewport variant must not return
  })

  it('resets the workspace by imperatively resizing the live panels', () => {
    const shell = read('src/components/editor/EditorShell.tsx')
    // The imperative part — without it the reset only rewrites the store and
    // the squeezed layout stays on screen until reload.
    expect(shell).toMatch(/handleResetLayout[\s\S]*?ref\.expand\(\)[\s\S]*?ref\.resize\(/)
    const menuBar = read('src/components/editor/MenuBar.tsx')
    expect(menuBar).toMatch(/case 'window.resetLayout':\s*onResetLayout\(\)/)
  })
})
