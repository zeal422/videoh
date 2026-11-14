'use client'

import { Plus } from 'lucide-react'
import { toast } from '@/hooks/use-toast'

import { brandColorValue, nextBrandColorName } from '@/lib/editor/brand-kit'
import { BRAND_COLORS_MAX } from '@/lib/editor/constants'
import { uid } from '@/lib/editor/factories'
import { useEditorStore } from '@/lib/editor/store'

/**
 * Saved brand colors beside a color control (0.26.0). A swatch applies its
 * exact hex value through the caller's commit path; the plus button saves the
 * current value. Data-driven background colors are content, not theme tokens.
 */
export function BrandColorSwatches({
  value,
  onPick,
  label,
}: {
  value: string
  onPick: (hex: string) => void
  label: string
}) {
  const colors = useEditorStore((s) => s.doc.project.brandKit?.colors) ?? []
  const apply = useEditorStore((s) => s.apply)
  const current = brandColorValue(value)
  const saved = current ? colors.some((color) => color.value === current) : true
  const save = () => {
    if (!current) return
    if (colors.length >= BRAND_COLORS_MAX) {
      toast({
        title: `A brand kit holds at most ${BRAND_COLORS_MAX} colors`,
        variant: 'destructive',
      })
      return
    }
    try {
      apply({
        type: 'addBrandColor',
        color: { id: uid('brand'), name: nextBrandColorName(colors), value: current },
      })
    } catch (error) {
      toast({
        title: 'Color not saved',
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      })
    }
  }
  return (
    <div
      className="mt-1 flex flex-wrap items-center gap-1"
      data-testid={`brand-swatches-${label}`}
      aria-label={`${label} brand colors`}
    >
      {colors.map((color) => (
        <button
          key={color.id}
          type="button"
          title={color.name}
          aria-label={`Apply brand color ${color.name}`}
          className="size-4 rounded-sm border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          style={{ backgroundColor: color.value }}
          onClick={() => onPick(color.value)}
        />
      ))}
      {!saved && (
        <button
          type="button"
          title="Save current color to the brand kit"
          aria-label="Save current color to brand kit"
          className="flex size-4 items-center justify-center rounded-sm border border-dashed border-border text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={save}
        >
          <Plus className="size-3" />
        </button>
      )}
    </div>
  )
}
