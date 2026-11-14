'use client'

import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { toast } from '@/hooks/use-toast'

import { BRAND_COLOR_NAME_MAX, BRAND_COLORS_MAX } from '@/lib/editor/constants'
import { nextBrandColorName } from '@/lib/editor/brand-kit'
import { uid } from '@/lib/editor/factories'
import { BUILTIN_FONTS } from '@/lib/editor/fonts'
import { useEditorStore } from '@/lib/editor/store'
import type { EditorCommand } from '@/lib/editor/commands'

/**
 * Brand kit manager (0.26.0): saved hex colors and font family references.
 * Colors are added here or from the Inspector swatch row; fonts are added from
 * the built-in and project sets. A font this project no longer has stays listed
 * as unavailable instead of failing the project load.
 */
export function BrandKitPanel({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const kit = useEditorStore((s) => s.doc.project.brandKit)
  const projectFonts = useEditorStore((s) => s.doc.project.fonts) ?? []
  const apply = useEditorStore((s) => s.apply)
  const [colorName, setColorName] = useState('')
  const [colorValue, setColorValue] = useState('#ffffff')
  const [fontFamily, setFontFamily] = useState('')

  const colors = kit?.colors ?? []
  const families = kit?.fontFamilies ?? []
  const run = (command: EditorCommand) => {
    try {
      apply(command)
    } catch (error) {
      toast({
        title: 'Brand kit not changed',
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      })
    }
  }
  const renameColor = (colorId: string, next: string): string | null => {
    try {
      apply({ type: 'renameBrandColor', colorId, name: next })
      return null
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  const available = [
    ...BUILTIN_FONTS.map((font) => ({ family: font.family, label: font.label })),
    ...projectFonts.map((font) => ({ family: font.family, label: font.name })),
  ].filter(
    (entry) => !families.some((family) => family.toLowerCase() === entry.family.toLowerCase()),
  )
  const familyLabel = (family: string): string => {
    const builtin = BUILTIN_FONTS.find((font) => font.family === family)
    if (builtin) return builtin.label
    const project = projectFonts.find((font) => font.family === family)
    if (project) return project.name
    return `${family} (unavailable)`
  }
  const addColor = () => {
    if (colors.length >= BRAND_COLORS_MAX) {
      toast({
        title: `A brand kit holds at most ${BRAND_COLORS_MAX} colors`,
        variant: 'destructive',
      })
      return
    }
    run({
      type: 'addBrandColor',
      color: {
        id: uid('brand'),
        name: colorName.trim() || nextBrandColorName(colors),
        value: colorValue,
      },
    })
    setColorName('')
  }
  const addFont = () => {
    if (!fontFamily) return
    run({ type: 'addBrandFont', family: fontFamily })
    setFontFamily('')
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[85vh] overflow-y-auto sm:max-w-lg"
        data-testid="brand-kit-dialog"
      >
        <DialogHeader>
          <DialogTitle>Brand kit</DialogTitle>
          <DialogDescription>
            Saved colors appear beside every text and shape color control. Fonts stay available even
            when the project no longer contains them.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Colors
            </h3>
            {colors.length === 0 ? (
              <p className="text-xs text-muted-foreground">No saved colors yet.</p>
            ) : (
              <div
                className="max-h-56 space-y-2 overflow-y-auto pr-1"
                role="list"
                aria-label="Brand colors"
              >
                {colors.map((color) => (
                  <BrandColorRow
                    key={`${color.id}:${color.name}`}
                    color={color}
                    onRename={(next) => renameColor(color.id, next)}
                    onRemove={() => run({ type: 'removeBrandColor', colorId: color.id })}
                  />
                ))}
              </div>
            )}
            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <Label htmlFor="brand-color-name" className="text-xs">
                  Name
                </Label>
                <Input
                  id="brand-color-name"
                  data-testid="brand-color-name"
                  className="mt-1 h-8"
                  maxLength={BRAND_COLOR_NAME_MAX}
                  placeholder={nextBrandColorName(colors)}
                  value={colorName}
                  onChange={(event) => setColorName(event.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="brand-color-value" className="text-xs">
                  Color
                </Label>
                <Input
                  id="brand-color-value"
                  data-testid="brand-color-value"
                  type="color"
                  className="mt-1 h-8 w-14 cursor-pointer p-0.5"
                  value={colorValue}
                  onChange={(event) => setColorValue(event.target.value)}
                />
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 gap-1"
                data-testid="brand-color-add"
                onClick={addColor}
                disabled={colors.length >= BRAND_COLORS_MAX}
              >
                <Plus className="size-3.5" />
                Add color
              </Button>
            </div>
          </section>

          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Fonts
            </h3>
            {families.length === 0 ? (
              <p className="text-xs text-muted-foreground">No saved font families yet.</p>
            ) : (
              <div
                className="max-h-56 space-y-2 overflow-y-auto pr-1"
                role="list"
                aria-label="Brand fonts"
              >
                {families.map((family) => (
                  <div key={family} role="listitem" className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm">{familyLabel(family)}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-8 shrink-0"
                      aria-label={`Remove brand font ${familyLabel(family)}`}
                      onClick={() => run({ type: 'removeBrandFont', family })}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <Label className="text-xs">Available family</Label>
                <Select value={fontFamily} onValueChange={setFontFamily}>
                  <SelectTrigger className="mt-1 h-8" aria-label="Brand font family">
                    <SelectValue placeholder="Choose a family" />
                  </SelectTrigger>
                  <SelectContent>
                    {available.map((entry) => (
                      <SelectItem key={entry.family} value={entry.family}>
                        {entry.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 gap-1"
                data-testid="brand-font-add"
                onClick={addFont}
                disabled={!fontFamily}
              >
                <Plus className="size-3.5" />
                Add font
              </Button>
            </div>
          </section>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * One saved color with its own draft. The draft is controlled so a rejected
 * rename can restore the stored name immediately; a successful rename changes
 * the key above so the row remounts with the new stored value.
 */
function BrandColorRow({
  color,
  onRename,
  onRemove,
}: {
  color: { id: string; name: string; value: string }
  onRename: (next: string) => string | null
  onRemove: () => void
}) {
  const [draft, setDraft] = useState(color.name)
  const [error, setError] = useState<string | null>(null)
  const commit = () => {
    const next = draft.trim()
    if (next === color.name) {
      setDraft(color.name)
      setError(null)
      return
    }
    const failure = onRename(next)
    if (failure) {
      setDraft(color.name)
      setError(failure)
    } else {
      setError(null)
    }
  }
  return (
    <div role="listitem" className="space-y-1">
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className="size-6 shrink-0 rounded border border-border"
          style={{ backgroundColor: color.value }}
        />
        <Input
          aria-label={`Brand color name ${color.name}`}
          value={draft}
          maxLength={BRAND_COLOR_NAME_MAX}
          className="h-8"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
          }}
        />
        <span className="w-16 shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {color.value}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          aria-label={`Remove brand color ${color.name}`}
          onClick={onRemove}
        >
          <Trash2 className="size-4" />
        </Button>
      </div>
      {error && (
        <p
          role="alert"
          data-testid={`brand-color-error-${color.id}`}
          className="text-[11px] text-destructive"
        >
          {error}
        </p>
      )}
    </div>
  )
}
