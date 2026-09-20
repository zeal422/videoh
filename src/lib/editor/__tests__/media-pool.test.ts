import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { SAMPLES, filterNewSamples } from '../sample-media'

/**
 * Media-pool regression locks (user bug report: "Load sample media" spammed
 * duplicates into the bin, and the bin list could not scroll to reach items
 * below the fold).
 *
 * The scroll half is a static wiring lock because jsdom cannot do real layout
 * (same rationale as preview-layout.test.ts / theme.test.ts):
 *
 * 1. PanelShell's content wrapper MUST be a flex column. react-resizable-
 *    panels renders a plain block box, so `flex-1` children (MediaBin,
 *    InspectorPanel) never inherited a height constraint — the list kept its
 *    content height, grew past the panel and was clipped by overflow:hidden
 *    with no scrollbar anywhere. `flex flex-col` makes flex-1 children fill
 *    the panel so their own overflow-y-auto actually scrolls.
 *
 * 2. The MediaBin list must keep `min-h-0 flex-1` + `overflow-y-auto` inside
 *    the (now flex) aside — it is the element that scrolls once heights are
 *    constrained. `editor-scroll` gives it the styled thin scrollbar.
 *
 * The dedup half is covered by real unit tests for `filterNewSamples` plus a
 * wiring lock that loadSamples actually consults it and guards re-entrancy.
 */

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

describe('filterNewSamples (idempotent sample loading)', () => {
  it('returns all samples when the bin is empty', () => {
    expect(filterNewSamples(SAMPLES, [])).toEqual(SAMPLES)
  })

  it('filters out samples whose name is already in the bin', () => {
    const existing = ['sample-video.mp4', 'sample-image.png']
    const fresh = filterNewSamples(SAMPLES, existing)
    expect(fresh).toEqual([{ path: '/samples/sample-audio.mp3', name: 'sample-audio.mp3' }])
  })

  it('returns nothing when every sample is already loaded', () => {
    expect(
      filterNewSamples(
        SAMPLES,
        SAMPLES.map((s) => s.name),
      ),
    ).toEqual([])
  })

  it('is not confused by user-imported files with different names', () => {
    const existing = ['holiday.mp4', 'song.mp3']
    expect(filterNewSamples(SAMPLES, existing)).toEqual(SAMPLES)
  })

  it('does not mutate its inputs', () => {
    const existing = ['sample-video.mp4']
    const snapshot = [...existing]
    filterNewSamples(SAMPLES, existing)
    expect(existing).toEqual(snapshot)
  })
})

describe('media pool layout + dedup wiring', () => {
  it('makes PanelShell content a flex column so flex-1 children inherit height', () => {
    const shell = read('src/components/editor/PanelShell.tsx')
    // The wrapper div that hosts arbitrary panel children must constrain them.
    expect(shell).toMatch(/className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"/)
  })

  it('keeps the MediaBin list the scrollable, height-constrained element', () => {
    const bin = read('src/components/editor/MediaBin.tsx')
    expect(bin).toMatch(/editor-scroll[^"]*min-h-0 flex-1[^"]*overflow-y-auto/)
    // And the aside itself stays a height-aware flex column.
    expect(bin).toMatch(/'flex min-h-0 flex-col bg-card'/)
  })

  it('dedups sample loading and guards against in-flight re-presses', () => {
    const bin = read('src/components/editor/MediaBin.tsx')
    expect(bin).toMatch(/filterNewSamples\(SAMPLES, existingNames\)/)
    expect(bin).toMatch(/loadingSamplesRef\.current = true/)
    expect(bin).toMatch(/Sample media already loaded/)
    expect(bin).toMatch(/disabled=\{importing > 0\}/)
  })
})
