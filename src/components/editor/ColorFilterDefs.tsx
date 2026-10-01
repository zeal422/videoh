'use client'

import { buildColorMatrix, colorFilterId, hasColorGrade } from '@/lib/editor/color'
import { useEditorStore } from '@/lib/editor/store'

/**
 * Hidden SVG host for the temperature/tint grades (0.6.0).
 *
 * A canvas cannot apply a white-balance shift by itself (ctx.filter has no such
 * primitive), so each graded clip gets one `<filter>` node here whose id the
 * preview compositor and the export planner both reference as
 * `url(#clip-grade-<clipId>)`. One definition, two render paths.
 *
 * Only clips that actually carry a grade mount a node, so an ungraded project
 * renders nothing at all. `colorInterpolationFilters="sRGB"` keeps the channel
 * gains operating on the same gamma the canvas uses (SVG defaults to linear
 * RGB), which is what makes the exported frame match the preview.
 */
export function ColorFilterDefs() {
  // Select the doc (a stable reference) and derive per render: a selector that
  // returned a fresh array would re-render forever under zustand v5.
  const doc = useEditorStore((s) => s.doc)
  const graded = doc.project.tracks.flatMap((t) => t.clips).filter(hasColorGrade)
  if (graded.length === 0) return null

  return (
    <svg
      aria-hidden="true"
      data-testid="color-filter-defs"
      className="pointer-events-none absolute size-0"
    >
      <defs>
        {graded.map((clip) => (
          <filter
            key={clip.id}
            id={colorFilterId(clip)}
            colorInterpolationFilters="sRGB"
            x="0"
            y="0"
            width="100%"
            height="100%"
          >
            <feColorMatrix
              type="matrix"
              values={buildColorMatrix(clip.temperature ?? 0, clip.tint ?? 0)}
            />
          </filter>
        ))}
      </defs>
    </svg>
  )
}
