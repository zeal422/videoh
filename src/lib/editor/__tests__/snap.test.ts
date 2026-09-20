import { describe, expect, it } from 'vitest'
import { applySnap, computeSnapPoints, snapMove } from '../snap'
import { createClip, createDoc, createMediaAsset } from '../factories'
import type { Doc } from '../types'

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
