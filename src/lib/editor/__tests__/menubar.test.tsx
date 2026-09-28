// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, render, screen } from '@testing-library/react'

import { MenuBar } from '@/components/editor/MenuBar'
import { installBrowserMocks, type MockHarness } from './mocks/browser-mocks'
import { useEditorStore } from '../store'
import { CURRENT_VERSION } from '../../releases'

/**
 * Menu-bar regression locks: the scrollbar fix and the version label.
 *
 * Scrollbar: the menubar root is h-8 (32px) while the shadcn Menubar
 * primitive pads p-1 and each trigger stands h-7 (28px): 28 + 4 + 4 = 36px
 * of content in a 32px box. The 4px invisible overflow, combined with the
 * bar's overflow-x-auto (CSS promotes the other axis to auto), made Chromium
 * paint a native vertical scrollbar (with up/down arrows) at the right end
 * of the menu bar. The component must keep the primitive's vertical padding
 * collapsed (py-0) and force overflow-y-hidden so no scrollbar can appear.
 *
 * The static-on-purpose cases use the source contract (jsdom applies no
 * stylesheets and reports no scrollbars), the same method as theme.test.ts.
 */

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

describe('menubar scrollbar lock', () => {
  it('collapses the primitive vertical padding and hides the vertical overflow', () => {
    const src = read('src/components/editor/MenuBar.tsx')
    const bar = src.match(/<Menubar[^>]*aria-label="Application menu"[^>]*>/)
    expect(bar, 'the application Menubar root element').not.toBeNull()
    expect(bar![0]).toContain('h-8')
    expect(bar![0]).toContain('py-0')
    expect(bar![0]).toContain('overflow-y-hidden')
    expect(bar![0]).toContain('overflow-x-auto')
  })
})

describe('menubar version label', () => {
  let h: MockHarness

  beforeEach(() => {
    h = installBrowserMocks()
    useEditorStore.setState(useEditorStore.getInitialState())
  })

  afterEach(() => {
    cleanup()
    h.uninstall()
  })

  it('shows the running version as a static muted label at the right edge', () => {
    render(
      <MenuBar onOpenExport={() => {}} onResetLayout={() => {}} onOpenReleaseNotes={() => {}} />,
    )
    const label = screen.getByTestId('menubar-version')
    // Value comes from the gate-locked releases.ts source (test 1 of
    // releases.test.ts ties it to package.json), not a hardcoded literal.
    expect(label).toHaveTextContent(`v${CURRENT_VERSION}`)
    expect(label.className).toContain('ml-auto')
    expect(label.className).toContain('text-muted-foreground')
    // Static: a plain span, not a button or a menu item.
    expect(label.tagName).toBe('SPAN')
  })
})
