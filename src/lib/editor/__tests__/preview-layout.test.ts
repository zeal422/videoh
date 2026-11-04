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
  it('wraps panel-preview in PanelShell with a bounded flex content wrapper', () => {
    const shell = read('src/components/editor/EditorShell.tsx')
    const at = shell.indexOf('id="preview"')
    expect(at, 'EditorShell must render the Program Monitor PanelShell').toBeGreaterThan(-1)
    expect(shell.slice(at - 100, at + 200)).toContain('title="Program Monitor"')
    // The PanelShell content wrapper is the flex column that lets the preview
    // section inherit a bounded height.
    const panelShell = read('src/components/editor/PanelShell.tsx')
    expect(panelShell).toMatch(/className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"/)
    // The Source Monitor must render before the Program Monitor: panel order is
    // load-bearing for the upper-row observer mapping.
    expect(shell.indexOf('id="source"')).toBeLessThan(shell.indexOf('id="preview"'))
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

  it('uses the padded transport clock, not the compact formatter', () => {
    const panel = read('src/components/editor/PreviewPanel.tsx')
    expect(panel).toContain('formatTransportTime(playhead)')
    expect(panel).toContain('formatTransportTime(duration)')
    expect(panel).not.toContain('formatTime(')
  })

  it('resets the workspace by imperatively resizing the live panels', () => {
    const shell = read('src/components/editor/EditorShell.tsx')
    // The imperative part — without it the reset only rewrites the store and
    // the squeezed layout stays on screen until reload.
    expect(shell).toContain('createResetTracker')
    expect(shell).toContain('issueResetResizes')
    expect(shell).toContain('.resize(PANEL_BOUNDS.media.default)')
    expect(shell).toContain('.resize(PANEL_BOUNDS.timeline.default)')
    expect(shell).toContain('getLayout()')
    const menuBar = read('src/components/editor/MenuBar.tsx')
    expect(menuBar).toMatch(/case 'window.resetLayout':\s*onResetLayout\(\)/)
  })
})
