// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { applyTheme, themeStorage } from '@/components/editor/apply-theme'
import { AppearanceDialog } from '@/components/editor/AppearanceDialog'
import { DEFAULT_THEME, readTheme, THEMES, THEME_STORAGE_KEY } from '@/lib/editor/theme'

/**
 * Appearance dialog locks: native radios, one per THEMES entry, reading and
 * applying the stored palette on open, and applying plus persisting a click.
 * The attribute lives on document.documentElement, which is where Radix
 * portals and the rest of the tree resolve their custom properties from.
 */

function openDialog() {
  return render(<AppearanceDialog open onOpenChange={() => {}} />)
}

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  delete document.documentElement.dataset.palette
})

describe('applyTheme', () => {
  it('sets the palette attribute and removes it for the default', () => {
    applyTheme('midnight')
    expect(document.documentElement.dataset.palette).toBe('midnight')
    applyTheme(DEFAULT_THEME)
    expect(document.documentElement.dataset.palette).toBeUndefined()
  })
})

describe('theme storage access', () => {
  it('yields null when the storage getter itself throws', () => {
    const denied = () => {
      throw new Error('storage access denied')
    }
    expect(themeStorage(denied)).toBeNull()
    applyTheme(readTheme(themeStorage(denied)))
    expect(document.documentElement.dataset.palette).toBeUndefined()
  })
})

describe('appearance dialog', () => {
  it('renders one radio per theme and checks the stored one', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'forest')
    openDialog()
    expect(screen.getAllByRole('radio')).toHaveLength(THEMES.length)
    expect(screen.getByRole('radio', { name: 'Forest' })).toBeChecked()
  })

  it('applies the stored palette when it opens', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'plum')
    openDialog()
    expect(document.documentElement.dataset.palette).toBe('plum')
    expect(screen.getByRole('radio', { name: 'Plum' })).toBeChecked()
  })

  it('applies and persists a selection immediately', () => {
    openDialog()
    fireEvent.click(screen.getByRole('radio', { name: 'Midnight' }))
    expect(document.documentElement.dataset.palette).toBe('midnight')
    expect(readTheme(window.localStorage)).toBe('midnight')
    expect(screen.getByRole('radio', { name: 'Midnight' })).toBeChecked()
  })
})
