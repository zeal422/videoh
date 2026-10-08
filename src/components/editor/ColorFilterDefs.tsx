'use client'

import { buildColorMatrix, colorFilterId, hasColorMatrix, lutFilterId } from '@/lib/editor/color'
import { lutShaperValues } from '@/lib/editor/lut'
import { useEditorStore } from '@/lib/editor/store'
import type { ProjectLut } from '@/lib/editor/types'

/**
 * Hidden SVG host for the temperature/tint grades and the 1D LUT shapers
 * (0.6.0, LUTs 0.7.0).
 *
 * A canvas cannot apply a white-balance shift by itself (ctx.filter has no such
 * primitive), so each graded clip gets one `<filter>` node here whose id the
 * preview compositor and the export planner both reference as
 * `url(#clip-grade-<clipId>)`. One definition, two render paths.
 *
 * A 1D `.cube` is the same trick with a different primitive: three per-channel
 * shaper tables in one `feComponentTransfer`, which is EXACT for a 1D LUT and
 * needs no pixel pass. That node is keyed by the LIBRARY ENTRY
 * (`url(#lut-<lutId>)`), so many clips sharing one shaper share one node, and
 * every clip's chain references it BEFORE the grade (a LUT grades the source,
 * then the color set and the matrix run). A 3D `.cube` never appears here: a
 * general function of three inputs is not expressible as an SVG primitive, so
 * it runs the shared pixel pass instead.
 *
 * Only clips that actually carry a grade or a shaper mount a node, so an
 * ungraded project renders nothing at all. `colorInterpolationFilters="sRGB"`
 * keeps the channel gains operating on the same gamma the canvas uses (SVG
 * defaults to linear RGB), which is what makes the exported frame match the
 * preview.
 */
export function ColorFilterDefs() {
  // Select the doc (a stable reference) and derive per render: a selector that
  // returned a fresh array would re-render forever under zustand v5.
  const doc = useEditorStore((s) => s.doc)
  const clips = doc.project.tracks.flatMap((t) => t.clips)
  const graded = clips.filter(hasColorMatrix)
  // One node per unique 1D entry a clip actually references, so a LUT sitting
  // in the library unused mounts nothing.
  const shapers: ProjectLut[] = []
  for (const clip of clips) {
    if (!clip.lutId || shapers.some((l) => l.id === clip.lutId)) continue
    const lut = doc.project.luts?.find((l) => l.id === clip.lutId)
    if (lut?.kind === '1d') shapers.push(lut)
  }
  if (graded.length === 0 && shapers.length === 0) return null

  return (
    <svg
      aria-hidden="true"
      data-testid="color-filter-defs"
      className="pointer-events-none absolute size-0"
    >
      <defs>
        {shapers.map((lut) => {
          const tables = lutShaperValues(lut)
          if (!tables) return null
          return (
            <filter
              key={lut.id}
              id={lutFilterId(lut)}
              colorInterpolationFilters="sRGB"
              x="0"
              y="0"
              width="100%"
              height="100%"
            >
              <feComponentTransfer>
                <feFuncR type="table" tableValues={tables.r} />
                <feFuncG type="table" tableValues={tables.g} />
                <feFuncB type="table" tableValues={tables.b} />
              </feComponentTransfer>
            </filter>
          )
        })}
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
