/**
 * Marker engine tests (markers.ts): the source-relative clip mapping (the
 * inverse of sourceTimeAt), visibility filtering, navigation, selection
 * lookups, staggering and patch semantics.
 */
import { describe, expect, it } from 'vitest'

import {
  allMarkersOnTimeline,
  applyMarkerPatch,
  clipMarkerLocalTime,
  clipMarkerTimelineTime,
  createMarker,
  DEFAULT_MARKER_COLOR,
  isMarkerColor,
  MARKER_COLORS,
  markerColorValue,
  MARKER_COLOR_VALUES,
  markerFromSelection,
  markerSelectionExists,
  markersEnd,
  markerTooltip,
  hasNavigableMarkers,
  navigableMarkers,
  neighborMarker,
  sequenceMarkers,
  sourceTimeForClipMarker,
  staggerMarkerPositions,
  visibleClipMarkers,
} from '../markers'
import { createClip, createDoc, createTextClip, sourceTimeAt } from '../factories'
import type { Clip } from '../types'

/** Forward reference clip: starts at 2s, 4s long, reading source 1..5. */
function clip(partial: Partial<Clip> = {}): Clip {
  return createClip({ id: 'c1', start: 2, duration: 4, inPoint: 1, ...partial })
}

describe('clip marker mapping (source seconds -> clip-local timeline)', () => {
  it('maps a forward clip linearly', () => {
    const c = clip()
    expect(clipMarkerLocalTime(c, 1)).toBe(0)
    expect(clipMarkerLocalTime(c, 3)).toBe(2)
    expect(clipMarkerLocalTime(c, 5)).toBe(4)
  })

  it('hides source times outside the visible span', () => {
    const c = clip()
    expect(clipMarkerLocalTime(c, 0.5)).toBeNull()
    expect(clipMarkerLocalTime(c, 5.01)).toBeNull()
  })

  it('scales with speed (the source span grows, the local span does not)', () => {
    const c = clip({ speed: 2 }) // visible source 1..9, local 0..4
    expect(clipMarkerLocalTime(c, 3)).toBe(1)
    expect(clipMarkerLocalTime(c, 9)).toBe(4)
    expect(clipMarkerLocalTime(c, 9.5)).toBeNull()
  })

  it('mirrors with reverse', () => {
    const c = clip({ reverse: true })
    expect(clipMarkerLocalTime(c, 1)).toBe(4)
    expect(clipMarkerLocalTime(c, 3)).toBe(2)
    expect(clipMarkerLocalTime(c, 5)).toBe(0)
  })

  it('inverts a timeScale ramp through its integral, not the static speed', () => {
    // 1x -> 2x over 4s consumes 6s of source, so source 5 is INSIDE the span.
    // Dividing by the speed would put it past `duration * speed` of source and
    // drop the marker, and every other placement drifted by the curve's area.
    const c = clip({
      inPoint: 0,
      keyframes: {
        timeScale: [
          { time: 0, value: 1 },
          { time: 4, value: 2 },
        ],
      },
    })
    for (const sourceTime of [0.5, 2, 3, 4, 5, 6]) {
      const local = clipMarkerLocalTime(c, sourceTime)
      expect(local).not.toBeNull()
      expect(sourceTimeAt(c, local!)).toBeCloseTo(sourceTime, 6)
    }
    expect(clipMarkerLocalTime(c, 6.5)).toBeNull()
    expect(clipMarkerLocalTime(c, -0.5)).toBeNull()
  })

  it('treats text clips as clip-local (inPoint 0, speed fixed)', () => {
    const text = createTextClip({ id: 't1', start: 1, duration: 4 })
    expect(clipMarkerLocalTime(text, 0)).toBe(0)
    expect(clipMarkerLocalTime(text, 2.5)).toBe(2.5)
    expect(clipMarkerLocalTime(text, 5)).toBeNull()
  })

  it('resolves through the clip start into timeline seconds', () => {
    expect(clipMarkerTimelineTime(clip(), createMarker(3))).toBe(4)
    expect(clipMarkerTimelineTime(clip(), createMarker(99))).toBeNull()
  })

  it('visibleClipMarkers keeps only on-screen markers, sorted by position', () => {
    const c = clip({
      markers: [createMarker(5), createMarker(1.5), createMarker(3), createMarker(9)],
    })
    expect(visibleClipMarkers(c).map((v) => v.marker.time)).toEqual([1.5, 3, 5])
    expect(visibleClipMarkers(c).map((v) => v.timelineTime)).toEqual([2.5, 4, 6])
  })
})

describe('sourceTimeForClipMarker (add-at-playhead clamping)', () => {
  it('maps a playhead inside the clip', () => {
    expect(sourceTimeForClipMarker(clip(), 4)).toBe(3)
  })

  it('clamps a playhead before/after the clip to the visible edges', () => {
    expect(sourceTimeForClipMarker(clip(), 0)).toBe(1)
    expect(sourceTimeForClipMarker(clip(), 99)).toBe(5)
  })

  it('honors speed and reverse', () => {
    expect(sourceTimeForClipMarker(clip({ speed: 2 }), 4)).toBe(5)
    expect(sourceTimeForClipMarker(clip({ reverse: true }), 4)).toBe(3)
    // reverse: the playhead at the clip's head reads the span's LAST frame
    expect(sourceTimeForClipMarker(clip({ reverse: true }), 2)).toBe(5)
  })
})

describe('sequence markers and navigation', () => {
  function docWithMarkers() {
    const doc = createDoc()
    const track = doc.project.tracks.find((t) => t.kind === 'video')!
    const c = clip({ duration: 8, markers: [createMarker(3)] }) // timeline 2..10, marker at 4
    track.clips = [c]
    doc.project.markers = [createMarker(10), createMarker(1)]
    return doc
  }

  it('sequenceMarkers sorts by time and markersEnd reports the last one', () => {
    const doc = docWithMarkers()
    expect(sequenceMarkers(doc.project).map((m) => m.time)).toEqual([1, 10])
    expect(markersEnd(doc.project)).toBe(10)
    expect(markersEnd(createDoc().project)).toBe(0)
  })

  it('allMarkersOnTimeline merges sequence and visible clip markers in order', () => {
    const doc = docWithMarkers()
    const refs = allMarkersOnTimeline(doc)
    expect(refs.map((r) => r.timelineTime)).toEqual([1, 4, 10])
    expect(refs.map((r) => r.scope)).toEqual(['sequence', 'clip', 'sequence'])
    expect(refs[1].clipId).toBe('c1')
  })

  it('excludes hidden clip markers from navigation', () => {
    const doc = docWithMarkers()
    doc.project.tracks[0].clips[0].markers!.push(createMarker(99))
    expect(allMarkersOnTimeline(doc).map((r) => r.timelineTime)).toEqual([1, 4, 10])
  })

  it('neighborMarker walks forward and backward without wrapping', () => {
    const doc = docWithMarkers()
    expect(neighborMarker(doc, 0, 'next')?.timelineTime).toBe(1)
    expect(neighborMarker(doc, 1, 'next')?.timelineTime).toBe(4)
    expect(neighborMarker(doc, 4, 'next')?.timelineTime).toBe(10)
    expect(neighborMarker(doc, 10, 'next')).toBeNull()
    expect(neighborMarker(doc, 0, 'prev')).toBeNull()
    expect(neighborMarker(doc, 10, 'prev')?.timelineTime).toBe(4)
    expect(neighborMarker(doc, 4, 'prev')?.timelineTime).toBe(1)
  })

  it('a playhead exactly on a marker is skipped (strict comparison)', () => {
    const doc = docWithMarkers()
    expect(neighborMarker(doc, 1, 'next')?.timelineTime).toBe(4)
    expect(neighborMarker(doc, 1, 'prev')).toBeNull()
  })

  it('navigableMarkers keeps only markers the playhead can reach', () => {
    const doc = createDoc()
    const track = doc.project.tracks.find((t) => t.kind === 'video')!
    track.clips = [clip()] // 2..6: the sequence ends at 6
    // A marker exactly at the end is reachable; one past it is not.
    doc.project.markers = [createMarker(1), createMarker(6), createMarker(20)]
    expect(allMarkersOnTimeline(doc).map((r) => r.timelineTime)).toEqual([1, 6, 20])
    expect(navigableMarkers(doc).map((r) => r.timelineTime)).toEqual([1, 6])
    expect(hasNavigableMarkers(doc)).toBe(true)

    // The menu's enabled state follows the SAME predicate navigation uses, so a
    // sequence whose markers all sit past the end offers no lit dead jump.
    doc.project.markers = [createMarker(20)]
    expect(allMarkersOnTimeline(doc)).toHaveLength(1)
    expect(navigableMarkers(doc)).toEqual([])
    expect(hasNavigableMarkers(doc)).toBe(false)
  })

  it('co-timed markers share one navigation stop (time-based navigation)', () => {
    const doc = createDoc()
    const track = doc.project.tracks.find((t) => t.kind === 'video')!
    track.clips = [clip({ duration: 8 })] // 2..10: the sequence covers 4s
    doc.project.markers = [createMarker(4), createMarker(4), createMarker(4)]
    // Shift+M is a TIME walk: the first press lands on 4s (where all three
    // markers sit) and the next press moves past it. Stepping through co-timed
    // markers individually would need navigation state (which marker the walk
    // is on), which a playhead position alone cannot express, so the tabs
    // remain reachable by click and the walk is one stop per marker time.
    expect(allMarkersOnTimeline(doc)).toHaveLength(3)
    expect(neighborMarker(doc, 0, 'next')?.timelineTime).toBe(4)
    expect(neighborMarker(doc, 4, 'next')).toBeNull()
  })

  it('ignores a marker past the sequence end so navigation cannot loop', () => {
    const doc = createDoc()
    const track = doc.project.tracks.find((t) => t.kind === 'video')!
    track.clips = [clip()] // 2..6: the sequence ends at 6
    doc.project.markers = [createMarker(20)]
    // The marker still renders (it is in allMarkersOnTimeline and markersEnd),
    // but it is never a seek target: the playhead clamps back to 6, so the same
    // marker would come back on every press of Shift+M.
    expect(allMarkersOnTimeline(doc)).toHaveLength(1)
    expect(neighborMarker(doc, 0, 'next')).toBeNull()
    expect(neighborMarker(doc, 6, 'next')).toBeNull()
  })
})

describe('marker patches and colors', () => {
  it('trims name and notes, and clears them when emptied', () => {
    const marker = createMarker(1, { name: '  Cue  ', notes: '  fix audio  ' })
    expect(marker.name).toBe('Cue')
    expect(marker.notes).toBe('fix audio')
    applyMarkerPatch(marker, { name: '   ', notes: '' })
    expect(marker.name).toBeUndefined()
    expect(marker.notes).toBeUndefined()
  })

  it('collapses the default green so saved files stay clean', () => {
    const marker = createMarker(1)
    applyMarkerPatch(marker, { color: 'green' })
    expect(marker.color).toBeUndefined()
    applyMarkerPatch(marker, { color: 'red' })
    expect(marker.color).toBe('red')
    applyMarkerPatch(marker, { color: 'green' })
    expect(marker.color).toBeUndefined()
  })

  it('ignores unknown colors and undefined patches', () => {
    const marker = createMarker(1, { name: 'keep' })
    applyMarkerPatch(marker, { color: 'chartreuse' as never, name: undefined })
    expect(marker.color).toBeUndefined()
    expect(marker.name).toBe('keep')
    expect(isMarkerColor('chartreuse')).toBe(false)
    expect(isMarkerColor('cyan')).toBe(true)
  })

  it('has a swatch value for every palette entry and green by default', () => {
    for (const color of MARKER_COLORS) {
      expect(MARKER_COLOR_VALUES[color]).toMatch(/^#[0-9a-f]{6}$/)
    }
    expect(markerColorValue()).toBe(MARKER_COLOR_VALUES[DEFAULT_MARKER_COLOR])
    expect(markerColorValue('magenta')).toBe(MARKER_COLOR_VALUES.magenta)
  })

  it('createMarker clamps the time at 0', () => {
    expect(createMarker(-3).time).toBe(0)
  })

  it('createMarker clamps NaN and infinities to 0 instead of passing them through', () => {
    expect(createMarker(Number.NaN).time).toBe(0)
    expect(createMarker(Number.POSITIVE_INFINITY).time).toBe(0)
    expect(createMarker(Number.NEGATIVE_INFINITY).time).toBe(0)
  })
})

describe('marker selection lookups', () => {
  function docWithMarkers() {
    const doc = createDoc()
    const track = doc.project.tracks.find((t) => t.kind === 'video')!
    doc.project.markers = [createMarker(1)]
    doc.project.markers[0].id = 'm_seq'
    const c = clip({ markers: [createMarker(3)] })
    c.markers![0].id = 'm_clip'
    track.clips = [c]
    return doc
  }

  it('resolves sequence and clip selections', () => {
    const doc = docWithMarkers()
    expect(markerFromSelection(doc, { scope: 'sequence', markerId: 'm_seq' })?.time).toBe(1)
    expect(
      markerFromSelection(doc, { scope: 'clip', clipId: 'c1', markerId: 'm_clip' })?.time,
    ).toBe(3)
    expect(markerSelectionExists(doc, { scope: 'sequence', markerId: 'm_seq' })).toBe(true)
  })

  it('reports missing markers and unknown clips', () => {
    const doc = docWithMarkers()
    expect(markerSelectionExists(doc, { scope: 'sequence', markerId: 'nope' })).toBe(false)
    expect(markerSelectionExists(doc, { scope: 'clip', clipId: 'c1', markerId: 'nope' })).toBe(
      false,
    )
    expect(markerSelectionExists(doc, { scope: 'clip', clipId: 'nope', markerId: 'm_clip' })).toBe(
      false,
    )
  })
})

describe('staggerMarkerPositions', () => {
  it('leaves distant markers at their exact positions', () => {
    expect(staggerMarkerPositions([1, 3], 80)).toEqual([80, 240])
  })

  it('pushes tabs closer than the gap right so every one stays clickable', () => {
    expect(staggerMarkerPositions([1, 1.01, 1.02], 80)).toEqual([80, 92, 104])
  })

  it('handles an empty list', () => {
    expect(staggerMarkerPositions([], 80)).toEqual([])
  })
})

describe('markerTooltip', () => {
  it('shows the timecode alone for an unnamed marker', () => {
    expect(markerTooltip(createMarker(0), 5)).toBe('0:05.0')
  })

  it('shows the name, timecode and notes', () => {
    expect(markerTooltip(createMarker(0, { name: 'Cue' }), 5)).toBe('Cue · 0:05.0')
    expect(markerTooltip(createMarker(0, { name: 'Cue', notes: 'fix audio' }), 5)).toBe(
      'Cue · 0:05.0 · fix audio',
    )
  })
})
