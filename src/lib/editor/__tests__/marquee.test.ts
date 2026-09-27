/**
 * Marquee (box) selection tests.
 *
 * The rect math and the selection resolution are pure, so the gesture's
 * contract is pinned here in Node: what a box catches (positive overlap only,
 * never a mere edge touch), how link groups expand, and what each modifier
 * does to the existing selection.
 */
import { describe, expect, it } from 'vitest'
import {
  marqueeHitClipIds,
  normalizeMarquee,
  resolveMarqueeSelection,
  type MarqueeLane,
} from '../marquee'
import { createClip, createDoc, createTrack } from '../factories'
import type { Doc } from '../types'

/** Docs for these tests: two video rows, clips added per test. */
function docWithTracks(): Doc {
  const doc = createDoc()
  doc.project.tracks = [createTrack('video', 1), createTrack('video', 2)]
  return doc
}

function lanesOf(doc: Doc, heights: number[] = [64, 64]): MarqueeLane[] {
  let top = 0
  return doc.project.tracks.map((track, i) => {
    const lane = { trackId: track.id, top, height: heights[i] ?? 64 }
    top += lane.height
    return lane
  })
}

const PPS = 80

describe('normalizeMarquee', () => {
  it('normalizes a drag in any direction into a rect', () => {
    const right = normalizeMarquee(10, 20, 90, 80)
    expect(right).toEqual({ left: 10, top: 20, right: 90, bottom: 80 })
    expect(normalizeMarquee(90, 80, 10, 20)).toEqual(right)
    expect(normalizeMarquee(90, 20, 10, 80)).toEqual(right)
  })

  it('keeps a zero-size anchor as a zero-size rect', () => {
    expect(normalizeMarquee(5, 5, 5, 5)).toEqual({ left: 5, top: 5, right: 5, bottom: 5 })
  })
})

describe('marqueeHitClipIds', () => {
  it('selects a clip the rect overlaps with positive area', () => {
    const doc = docWithTracks()
    const clip = createClip({ start: 1, duration: 2 })
    doc.project.tracks[0].clips = [clip]
    const rect = normalizeMarquee(60, 10, 200, 40)
    expect(marqueeHitClipIds(doc, lanesOf(doc), rect, PPS)).toEqual([clip.id])
  })

  it('does not select on a mere edge touch', () => {
    const doc = docWithTracks()
    const clip = createClip({ start: 1, duration: 2 }) // 80px..240px at 80pps
    doc.project.tracks[0].clips = [clip]
    // rect.right === clip.left
    expect(marqueeHitClipIds(doc, lanesOf(doc), normalizeMarquee(0, 0, 80, 20), PPS)).toEqual([])
    // rect.left === clip.right
    expect(marqueeHitClipIds(doc, lanesOf(doc), normalizeMarquee(240, 0, 300, 20), PPS)).toEqual([])
    // one pixel of real overlap selects
    expect(marqueeHitClipIds(doc, lanesOf(doc), normalizeMarquee(0, 0, 81, 20), PPS)).toEqual([
      clip.id,
    ])
  })

  it('requires vertical overlap with the clip row', () => {
    const doc = docWithTracks()
    const rowOne = createClip({ start: 0, duration: 2 })
    doc.project.tracks[1].clips = [rowOne]
    const lanes = lanesOf(doc)
    // Rect confined to the first row (0..64) and touching the second row at y=64.
    expect(marqueeHitClipIds(doc, lanes, normalizeMarquee(0, 0, 200, 64), PPS)).toEqual([])
    expect(marqueeHitClipIds(doc, lanes, normalizeMarquee(0, 0, 200, 65), PPS)).toEqual([rowOne.id])
  })

  it('a horizontal line exactly on a row boundary selects the row below it', () => {
    const doc = docWithTracks()
    const top = createClip({ id: 'top', start: 2, duration: 1 })
    const bottom = createClip({ id: 'bottom', start: 2, duration: 1 })
    doc.project.tracks[0].clips = [top]
    doc.project.tracks[1].clips = [bottom]
    const lanes = lanesOf(doc) // rows: 0..64, 64..128
    // y = 64 is the shared boundary: half-open puts the line in row 2.
    expect(marqueeHitClipIds(doc, lanes, normalizeMarquee(170, 64, 250, 64), PPS)).toEqual([
      bottom.id,
    ])
    // y = 0 (row 1's top) is row 1's line.
    expect(marqueeHitClipIds(doc, lanes, normalizeMarquee(170, 0, 250, 0), PPS)).toEqual([top.id])
    // y = 128 (past the last row) selects nothing.
    expect(marqueeHitClipIds(doc, lanes, normalizeMarquee(170, 128, 250, 128), PPS)).toEqual([])
  })

  it('returns hits in track order then clip order', () => {
    const doc = docWithTracks()
    const top = createClip({ start: 0, duration: 1 })
    const bottom = createClip({ start: 0, duration: 1 })
    doc.project.tracks[0].clips = [top]
    doc.project.tracks[1].clips = [bottom]
    expect(marqueeHitClipIds(doc, lanesOf(doc), normalizeMarquee(0, 0, 100, 128), PPS)).toEqual([
      top.id,
      bottom.id,
    ])
  })

  it('catches a clip at time zero from a rect with a negative left edge', () => {
    const doc = docWithTracks()
    const clip = createClip({ start: 0, duration: 1 })
    doc.project.tracks[0].clips = [clip]
    // Pointer positions left of the lanes clamp to nothing; the rect itself may
    // carry a negative left edge when the drag starts past the origin.
    expect(marqueeHitClipIds(doc, lanesOf(doc), normalizeMarquee(-50, 0, 10, 30), PPS)).toEqual([
      clip.id,
    ])
  })

  it('a zero-size rect (a click) selects nothing', () => {
    const doc = docWithTracks()
    doc.project.tracks[0].clips = [createClip({ start: 0, duration: 5 })]
    expect(marqueeHitClipIds(doc, lanesOf(doc), normalizeMarquee(100, 20, 100, 20), PPS)).toEqual(
      [],
    )
  })

  it('a horizontal drag (zero height) still selects on its row only', () => {
    const doc = docWithTracks()
    const top = createClip({ id: 'top', start: 2, duration: 1 }) // 160px..240px
    const bottom = createClip({ id: 'bottom', start: 2, duration: 1 })
    doc.project.tracks[0].clips = [top]
    doc.project.tracks[1].clips = [bottom]
    // A line through row 0 (y = 10) crossing the clip's span.
    const rect = normalizeMarquee(100, 10, 250, 10)
    expect(marqueeHitClipIds(doc, lanesOf(doc), rect, PPS)).toEqual([top.id])
  })

  it('a vertical drag (zero width) selects what the line crosses', () => {
    const doc = docWithTracks()
    const top = createClip({ id: 'top', start: 2, duration: 1 }) // 160px..240px
    const bottom = createClip({ id: 'bottom', start: 2, duration: 1 })
    doc.project.tracks[0].clips = [top]
    doc.project.tracks[1].clips = [bottom]
    // x = 170 is inside both clips; the line spans both rows.
    expect(marqueeHitClipIds(doc, lanesOf(doc), normalizeMarquee(170, 0, 170, 128), PPS)).toEqual([
      top.id,
      bottom.id,
    ])
    // x = 100 is in the gap before the clips: nothing.
    expect(marqueeHitClipIds(doc, lanesOf(doc), normalizeMarquee(100, 0, 100, 128), PPS)).toEqual(
      [],
    )
  })

  it('scales clip boxes with pxPerSec', () => {
    const doc = docWithTracks()
    const clip = createClip({ start: 2, duration: 2 })
    doc.project.tracks[0].clips = [clip]
    const rect = normalizeMarquee(0, 0, 100, 30)
    expect(marqueeHitClipIds(doc, lanesOf(doc), rect, 40)).toEqual([clip.id])
    expect(marqueeHitClipIds(doc, lanesOf(doc), rect, 160)).toEqual([])
  })

  it('skips tracks with no lane geometry', () => {
    const doc = docWithTracks()
    const clip = createClip({ start: 0, duration: 2 })
    doc.project.tracks[0].clips = [clip]
    expect(marqueeHitClipIds(doc, [], normalizeMarquee(0, 0, 200, 200), PPS)).toEqual([])
  })
})

describe('resolveMarqueeSelection', () => {
  it('replace: the hit group becomes the whole selection', () => {
    const doc = docWithTracks()
    const a = createClip({ id: 'a', start: 0, duration: 1 })
    const b = createClip({ id: 'b', start: 2, duration: 1 })
    doc.project.tracks[0].clips = [a, b]
    expect(resolveMarqueeSelection(doc, ['b', 'a'], ['zzz'], 'replace')).toEqual(['b', 'a'])
  })

  it('replace: an empty rect clears the selection', () => {
    const doc = docWithTracks()
    expect(resolveMarqueeSelection(doc, [], ['a', 'b'], 'replace')).toEqual([])
  })

  it('add: appends the groups and keeps the current order (primary survives)', () => {
    const doc = docWithTracks()
    const a = createClip({ id: 'a', start: 0, duration: 1 })
    const b = createClip({ id: 'b', start: 2, duration: 1 })
    doc.project.tracks[0].clips = [a, b]
    expect(resolveMarqueeSelection(doc, ['b'], ['a'], 'add')).toEqual(['a', 'b'])
    // Already-selected hits are not duplicated.
    expect(resolveMarqueeSelection(doc, ['a', 'b'], ['a'], 'add')).toEqual(['a', 'b'])
  })

  it('add: an empty rect keeps the selection', () => {
    const doc = docWithTracks()
    expect(resolveMarqueeSelection(doc, [], ['a'], 'add')).toEqual(['a'])
  })

  it('toggle: adds a group that is not fully selected', () => {
    const doc = docWithTracks()
    const a = createClip({ id: 'a', start: 0, duration: 1 })
    doc.project.tracks[0].clips = [a]
    expect(resolveMarqueeSelection(doc, ['a'], [], 'toggle')).toEqual(['a'])
  })

  it('toggle: removes a group entirely when every member is selected', () => {
    const doc = docWithTracks()
    const a = createClip({ id: 'a', start: 0, duration: 1 })
    doc.project.tracks[0].clips = [a]
    expect(resolveMarqueeSelection(doc, ['a'], ['a'], 'toggle')).toEqual([])
  })

  it('expands an A/V pair from either half, in both directions', () => {
    const doc = docWithTracks()
    const linkId = 'link_1'
    const video = createClip({ id: 'v', linkId, start: 0, duration: 1 })
    const audio = createClip({ id: 'a', linkId, start: 0, duration: 1, audioOnly: true })
    doc.project.tracks[0].clips = [video]
    doc.project.tracks[1].clips = [audio]
    expect(resolveMarqueeSelection(doc, ['v'], [], 'replace')).toEqual(['v', 'a'])
    expect(resolveMarqueeSelection(doc, ['a'], ['v', 'a'], 'toggle')).toEqual([])
  })

  it('toggle: a partially selected pair gains its missing half instead of dropping', () => {
    const doc = docWithTracks()
    const linkId = 'link_1'
    const video = createClip({ id: 'v', linkId, start: 0, duration: 1 })
    const audio = createClip({ id: 'a', linkId, start: 0, duration: 1, audioOnly: true })
    doc.project.tracks[0].clips = [video]
    doc.project.tracks[1].clips = [audio]
    expect(resolveMarqueeSelection(doc, ['v'], ['v'], 'toggle')).toEqual(['v', 'a'])
  })

  it('handles several groups at once with mixed states', () => {
    const doc = docWithTracks()
    const linkId = 'link_1'
    const video = createClip({ id: 'v', linkId, start: 0, duration: 1 })
    const audio = createClip({ id: 'a', linkId, start: 0, duration: 1, audioOnly: true })
    const solo = createClip({ id: 's', start: 2, duration: 1 })
    doc.project.tracks[0].clips = [video, solo]
    doc.project.tracks[1].clips = [audio]
    // Pair is fully selected (removed), solo is not (added).
    expect(resolveMarqueeSelection(doc, ['v', 's'], ['v', 'a'], 'toggle')).toEqual(['s'])
  })

  it('ignores hit ids that no longer exist', () => {
    const doc = docWithTracks()
    const a = createClip({ id: 'a', start: 0, duration: 1 })
    doc.project.tracks[0].clips = [a]
    expect(resolveMarqueeSelection(doc, ['ghost', 'a'], [], 'replace')).toEqual(['a'])
  })
})
