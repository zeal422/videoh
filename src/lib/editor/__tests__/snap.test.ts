import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { applySnap, computeSnapPoints, snapGuide, snapMove } from '../snap'
import { createClip, createDoc, createMediaAsset } from '../factories'
import type { Doc } from '../types'

/** Static-source reads resolve from the repo root, not the vitest cwd. */
const ROOT = resolve(__dirname, '..', '..', '..', '..')
const readSrc = (p: string) => readFileSync(resolve(ROOT, p), 'utf8')

function makeDoc(): Doc {
  const doc = createDoc()
  const asset = createMediaAsset({ kind: 'video', duration: 100 })
  const videoTrack = doc.project.tracks.filter((t) => t.kind === 'video')[0]
  videoTrack.clips = [
    createClip({ id: 'c1', mediaId: asset.id, start: 2, duration: 4 }),
    createClip({ id: 'c2', mediaId: asset.id, start: 8, duration: 3 }),
  ]
  return doc
}

describe('computeSnapPoints', () => {
  it('collects clip edges, zero, playhead and timeline end', () => {
    const doc = makeDoc()
    const points = computeSnapPoints(doc, {
      playhead: 5.5,
      includeTimelineEnd: true,
    })
    expect(points).toEqual([0, 2, 5.5, 6, 8, 11])
  })

  it('excludes the edges of excluded clips', () => {
    const doc = makeDoc()
    const points = computeSnapPoints(doc, { excludeClipIds: ['c1'] })
    expect(points).toEqual([0, 8, 11])
  })
})

describe('applySnap', () => {
  const points = [0, 2, 6, 8]

  it('snaps to the nearest point within threshold', () => {
    expect(applySnap(2.2, points, 0.3)).toEqual({ time: 2, snapped: 2 })
    expect(applySnap(5.8, points, 0.3)).toEqual({ time: 6, snapped: 6 })
  })

  it('leaves the target untouched when nothing is in range', () => {
    expect(applySnap(4, points, 0.3)).toEqual({ time: 4, snapped: null })
  })

  it('never returns negative times', () => {
    expect(applySnap(-1, points, 0.3).time).toBe(0)
  })
})

describe('snapMove', () => {
  const points = [0, 2, 6, 10]

  it('prefers the head edge when it snaps', () => {
    expect(snapMove(2.1, 3, points, 0.2)).toEqual({ start: 2, snapped: 2 })
  })

  it('falls back to the tail edge', () => {
    // head 8.9 is 0.9 away from 10? no: tail = 8.9+3 = 11.9 → dist 1.9. Use closer values:
    expect(snapMove(4.15, 2, points, 0.2)).toEqual({ start: 4, snapped: 6 })
  })

  it('returns unsnapped when nothing is near', () => {
    expect(snapMove(4, 1, points, 0.1)).toEqual({ start: 4, snapped: null })
  })
})

describe('marker snap points (0.5.5)', () => {
  it('includes sequence markers and visible clip markers', () => {
    const doc = makeDoc() // clips: c1 2..6, c2 8..11, inPoint 0
    doc.project.markers = [{ id: 'm_seq', time: 7 }]
    // Source 3 on a clip starting at 2 renders at timeline 5 (inPoint 0).
    doc.project.tracks[0].clips[0].markers = [{ id: 'm_clip', time: 3 }]
    expect(computeSnapPoints(doc)).toEqual([0, 2, 5, 6, 7, 8, 11])
  })

  it('excludes hidden clip markers and the marker being dragged', () => {
    const doc = makeDoc()
    doc.project.markers = [{ id: 'm_seq', time: 7 }]
    doc.project.tracks[0].clips[0].markers = [
      { id: 'm_hidden', time: 99 },
      { id: 'm_visible', time: 3 },
    ]
    // Hidden markers cannot be reached by navigation or by clips, so they
    // must not attract a snap; the dragged marker must not stick to itself.
    expect(computeSnapPoints(doc)).toEqual([0, 2, 5, 6, 7, 8, 11])
    expect(computeSnapPoints(doc, { excludeMarkerId: 'm_seq' })).toEqual([0, 2, 5, 6, 8, 11])
    expect(computeSnapPoints(doc, { excludeMarkerId: 'm_visible' })).toEqual([0, 2, 6, 7, 8, 11])
  })

  it('excludes the markers of excluded clips (a dragged clip must not snap to its own)', () => {
    const doc = makeDoc()
    doc.project.tracks[0].clips[0].markers = [{ id: 'm_own', time: 3 }] // renders at 5
    // c1 is being dragged: its own marker keeps a constant offset to its own
    // edges, so one snap would stick for the whole move and the clip would
    // land away from where the user aimed. Other clips' markers stay targets.
    expect(computeSnapPoints(doc, { excludeClipIds: ['c1'] })).toEqual([0, 8, 11])
    doc.project.tracks[0].clips[1].markers = [{ id: 'm_other', time: 2 }] // renders at 10
    expect(computeSnapPoints(doc, { excludeClipIds: ['c1'] })).toEqual([0, 8, 10, 11])
  })
})

describe('snapGuide', () => {
  it('shows a snap the drag actually took', () => {
    expect(snapGuide(4, 4)).toBe(4)
  })

  it('shows no guide when clamping moved the drag off the snapped point', () => {
    // A clip-marker drag snaps at the clip edge, then clamps back inside the
    // span: the guide must not advertise the discarded snap.
    expect(snapGuide(4, 3.7)).toBeNull()
    expect(snapGuide(4, 4.2)).toBeNull()
  })

  it('shows no guide when nothing snapped', () => {
    expect(snapGuide(null, 4)).toBeNull()
  })

  it('the ClipMarkers drag wires the guide through snapGuide (not the raw snap)', () => {
    const src = readSrc('src/components/editor/timeline/ClipMarkers.tsx')
    expect(src).toContain('snapGuide(snapped.snapped, clip.start + local)')
    expect(src).not.toContain('setSnapLine(snapped.snapped)')
  })

  it('the clip move excludes every MOVING clip from the snap targets, not just the dragged one', () => {
    // Partners travel with the same delta (decideMove), so their edges and
    // markers keep a constant distance to the dragged clip's edges: leaving
    // them snapable reintroduces the sticky-snap bug for linked pairs. A trim
    // leaves partners stationary, so the exclusion must be move-mode only.
    const src = readSrc('src/components/editor/timeline/ClipView.tsx')
    expect(src).toContain(
      "g.mode === 'move' ? [clip.id, ...g.partners.map((p) => p.id)] : [clip.id]",
    )
  })
})
