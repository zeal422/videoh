import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Timeline stacking-order regression locks.
 *
 * jsdom cannot do real layout, so — like theme.test.ts / preview-layout.test.ts
 * / media-pool.test.ts — these are static wiring locks for an invariant that
 * was once broken and browser-verified (user bug report): the playhead lived
 * in content coordinates at z-40, so horizontal scrolling slid it beneath the
 * sticky V1/A1 header column while still PAINTING it over the headers (and
 * over the ruler's sticky corner cell).
 *
 * The layer scale that must hold (one shared stacking context):
 *   clips (auto, selected z-10) < snap guide z-[15] < playhead line z-20
 *   < track headers z-30 < ruler row z-40 (diamond z-30 + corner z-50 inside)
 *
 * The diamond must live INSIDE the ruler row: sticky elements always create
 * their own stacking context, so no z-index inside the row can ever lose to
 * an outside element — the corner cell can only cover markers that are its
 * siblings.
 */

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

describe('timeline stacking order', () => {
  const panel = read('src/components/editor/timeline/TimelinePanel.tsx')

  it('no longer renders a full-height z-40 playhead (the bug signature)', () => {
    expect(panel).not.toMatch(/z-40 w-px/)
    expect(panel).not.toMatch(/bottom-0 top-0 z-40/)
  })

  it('playhead line starts below the ruler, spans only the track rows, paints under headers', () => {
    expect(panel).toMatch(/z-20 w-px bg-rose-500\/90/)
    expect(panel).toMatch(/top: RULER_HEIGHT,/)
    // Confined to the rows: no bottom-0, explicit rows height. A full-height
    // line leaked a stray dot into the empty strip below the last row.
    expect(panel).toMatch(/height: tracksHeight,\n              \}\}/)
    expect(panel).not.toMatch(/bottom-0 z-20 w-px/)
    expect(panel).toMatch(/const tracksHeight = useMemo/)
  })

  it('playhead diamond is rendered inside the sticky ruler row', () => {
    const rowStart = panel.indexOf('sticky top-0 z-40')
    const diamond = panel.indexOf('size-[11px] rotate-45')
    // anchor on the START of the track-rows comment (its wording may evolve)
    const rows = panel.indexOf('{/* track rows')
    expect(rowStart, 'ruler row must be z-40 sticky top').toBeGreaterThan(-1)
    expect(diamond, 'diamond marker missing').toBeGreaterThan(-1)
    expect(diamond).toBeGreaterThan(rowStart)
    expect(diamond).toBeLessThan(rows)
  })

  it('corner cell paints above the diamond (z-50 > z-30 inside the row)', () => {
    const corner = panel.indexOf('sticky left-0 z-50')
    const diamond = panel.indexOf('absolute top-0 z-30')
    expect(corner).toBeGreaterThan(-1)
    expect(diamond).toBeGreaterThan(corner)
  })

  it('track headers cover the playhead line (z-30 > z-20)', () => {
    expect(panel).toMatch(/sticky left-0 z-30 flex shrink-0 items-center gap-2/)
  })

  it('snap guide stays under the playhead line and the headers, also row-confined', () => {
    expect(panel).toMatch(/z-\[15\] w-px bg-amber-300/)
    expect(panel).not.toMatch(/bottom-0 top-0 z-\[15\]/)
  })

  it('row separators live on lane + header cells so the line cannot leak through borders', () => {
    // The row div itself must NOT carry border-b: it paints below the sticky
    // header's box and the z-20 playhead line showed through it as one
    // magenta dot per row boundary (user-reported artifact).
    expect(panel).not.toMatch(/"flex border-b/)
    expect(panel).toMatch(/'relative flex-1 border-b border-border\/60'/)
    expect(panel).toMatch(/sticky left-0 z-30[^"]*border-b border-r border-b-border\/60/)
  })
})
