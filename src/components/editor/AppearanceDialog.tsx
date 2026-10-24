'use client'

import { useEffect, useState } from 'react'

import { applyTheme, themeStorage } from '@/components/editor/apply-theme'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { readTheme, THEMES, writeTheme, type ThemeId } from '@/lib/editor/theme'

/**
 * View > Appearance. The component mounts only while the dialog is open, so the
 * state initializer reads the stored palette on each open. Selection applies
 * and persists immediately; the effect syncs the attribute, which is the one
 * external system involved. Radix renders the content in a portal at
 * document.body, so it resolves the tokens from `<html>` like the rest of the
 * app.
 */
export function AppearanceDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [selected, setSelected] = useState<ThemeId>(() => readTheme(themeStorage()))

  useEffect(() => {
    applyTheme(selected)
  }, [selected])

  function choose(id: ThemeId) {
    writeTheme(themeStorage(), id)
    setSelected(id)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Appearance</DialogTitle>
          <DialogDescription>Choose a palette. It applies right away.</DialogDescription>
        </DialogHeader>
        <div role="radiogroup" aria-label="Palette" className="flex flex-col gap-1 py-2">
          {THEMES.map((theme) => (
            <label
              key={theme.id}
              className="hover:bg-accent has-[:checked]:bg-accent flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm"
            >
              <input
                type="radio"
                name="appearance-palette"
                value={theme.id}
                checked={selected === theme.id}
                onChange={() => choose(theme.id)}
                className="accent-primary"
              />
              {theme.label}
            </label>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
