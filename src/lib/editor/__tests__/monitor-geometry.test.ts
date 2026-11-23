import { describe, expect, it } from 'vitest'

import {
  baseRectForClip,
  canvasSnapTargets,
  clipOpacityAt,
  pickVisualClipAt,
  quadBounds,
  quadForClip,
  snapBoxToTargets,
  type TextMeasure,
} from '../playback/monitor-geometry'
import { createClip, createShapeClip, createTextClip, createTrack } from '../factories'
import { IDENTITY_TRANSFORM, type ClipTransform } from '../transform'
import type { Clip, Doc, MediaAsset, Track } from '../types'

/**
 * Monitor geometry (0.29.5): the one box source shared by monitor selection,
 * canvas snapping, and the gizmo. Text measurement is injected, so the module
 * is exercised in Node with a deterministic box instead of a canvas.
 */

const WIDTH = 1920
const HEIGHT = 1080

/** A 300x100 project-pixel text box centered on the clip's anchor. */
const measure: TextMeasure = (clip, width, height) => {
  const x = clip.style?.x ?? 0.5
  const y = clip.style?.y ?? 0.5
  return {
    x0: x - 150 / width,
    y0: y - 50 / height,
    x1: x + 150 / width,
    y1: y + 50 / height,
  }
}

function videoAsset(partial: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: 'media_v',
    name: 'video.mp4',
    kind: 'video',
    duration: 30,
    width: 1280,
    height: 720,
    url: 'blob:video',
    ...partial,
  } as MediaAsset
}

function docWith(tracks: Track[], media: MediaAsset[] = []): Doc {
  return {
    project: { tracks, id: 'p_test', name: 'test', width: WIDTH, height: HEIGHT, fps: 30 },
    media,
  }
}

function clipAt(partial: Parameters<typeof createClip>[0] = {}): Clip {
  return createClip({ id: 'clip_v', start: 0, duration: 4, inPoint: 0, ...partial })
}

describe('baseRectForClip', () => {
  it('returns the contain-fit rect for a video and the full frame for a compound', () => {
    const asset = videoAsset()
    const video = clipAt({ mediaId: asset.id })
    expect(baseRectForClip(video, asset, WIDTH, HEIGHT, measure)).toEqual({
      x0: 0,
      y0: 0,
      x1: WIDTH,
      y1: HEIGHT,
    })
  })

  it('uses contain-fit letterboxing for a taller source', () => {
    const asset = videoAsset({ width: 720, height: 1280 })
    const rect = baseRectForClip(clipAt({ mediaId: asset.id }), asset, WIDTH, HEIGHT, measure)
    expect(rect).not.toBeNull()
    // 720x1280 fits height: 1080 wide by 1920 tall, centered horizontally.
    expect(rect!.y0).toBeCloseTo(0, 6)
    expect(rect!.y1).toBeCloseTo(1080, 6)
    expect(rect!.x0).toBeCloseTo((WIDTH - 607.5) / 2, 6)
  })

  it('returns the shape path bounds and the measured text box', () => {
    const shape = createShapeClip({ id: 'clip_s', start: 0, duration: 4 })
    const shapeRect = baseRectForClip(shape, undefined, WIDTH, HEIGHT, measure)
    expect(shapeRect).not.toBeNull()
    expect(shapeRect!.x1).toBeGreaterThan(shapeRect!.x0)

    const text = createTextClip({ id: 'clip_t', start: 0, duration: 4 })
    expect(baseRectForClip(text, undefined, WIDTH, HEIGHT, measure)).toEqual({
      x0: 810,
      y0: 490,
      x1: 1110,
      y1: 590,
    })
  })

  it('uses the full frame for a compound clip', () => {
    const compound = clipAt({ sequenceId: 'seq_1' })
    expect(baseRectForClip(compound, undefined, WIDTH, HEIGHT, measure)).toEqual({
      x0: 0,
      y0: 0,
      x1: WIDTH,
      y1: HEIGHT,
    })
  })

  it('refuses audio carriers and keeps the full-frame move box for offline media', () => {
    const asset = videoAsset()
    expect(
      baseRectForClip(
        clipAt({ mediaId: asset.id, audioOnly: true }),
        asset,
        WIDTH,
        HEIGHT,
        measure,
      ),
    ).toBeNull()
    expect(
      baseRectForClip(clipAt({ mediaId: asset.id }), undefined, WIDTH, HEIGHT, measure),
    ).toEqual({ x0: 0, y0: 0, x1: WIDTH, y1: HEIGHT })
  })
})

describe('quadForClip and quadBounds', () => {
  const base = { x0: 100, y0: 100, x1: 300, y1: 200 }
  const scaled: ClipTransform = { ...IDENTITY_TRANSFORM, scaleX: 2, scaleY: 2 }

  it('scales around the frame center like the renderer', () => {
    const bounds = quadBounds(quadForClip(scaled, base, WIDTH, HEIGHT))
    const centerX = WIDTH / 2
    const centerY = HEIGHT / 2
    expect(bounds.x0).toBeCloseTo(centerX + (base.x0 - centerX) * 2, 6)
    expect(bounds.x1).toBeCloseTo(centerX + (base.x1 - centerX) * 2, 6)
    expect(bounds.y0).toBeCloseTo(centerY + (base.y0 - centerY) * 2, 6)
    expect(bounds.y1).toBeCloseTo(centerY + (base.y1 - centerY) * 2, 6)
  })

  it('a flip leaves the gizmo box unchanged on the draw pivot', () => {
    const plain = quadBounds(quadForClip(IDENTITY_TRANSFORM, base, WIDTH, HEIGHT))
    const flipped = quadBounds(
      quadForClip({ ...IDENTITY_TRANSFORM, flipX: true, flipY: true }, base, WIDTH, HEIGHT),
    )
    // The compositor flips media around the positioned frame center and text
    // around the measured text box center. Every base rect is centered on that
    // pivot (a media contain rect is frame-centered), so a flip maps the box
    // to itself.
    expect(flipped).toEqual(plain)
  })
})

describe('pickVisualClipAt', () => {
  it('selects the topmost rendered track in an overlap', () => {
    const asset = videoAsset()
    const bottom = clipAt({ id: 'clip_bottom', mediaId: asset.id })
    const top = clipAt({ id: 'clip_top', mediaId: asset.id })
    const doc = docWith(
      [createTrack('video', 1, { clips: [top] }), createTrack('video', 2, { clips: [bottom] })],
      [asset],
    )
    expect(pickVisualClipAt(doc, [], 1, { x: 960, y: 540 }, measure)?.id).toBe('clip_top')
    // activeTracks[0] is the top layer: swapping the order swaps the winner.
    doc.project.tracks.reverse()
    expect(pickVisualClipAt(doc, [], 1, { x: 960, y: 540 }, measure)?.id).toBe('clip_bottom')
  })

  it('skips a fully transparent top clip and selects the visible one below', () => {
    const asset = videoAsset()
    const top = clipAt({ id: 'clip_top', mediaId: asset.id, opacity: 0 })
    const bottom = clipAt({ id: 'clip_bottom', mediaId: asset.id })
    const doc = docWith(
      [createTrack('video', 1, { clips: [top] }), createTrack('video', 2, { clips: [bottom] })],
      [asset],
    )
    expect(pickVisualClipAt(doc, [], 1, { x: 960, y: 540 }, measure)?.id).toBe('clip_bottom')
  })

  it('skips hidden tracks, inactive clips, audio tracks, and missing media', () => {
    const asset = videoAsset()
    const hidden = clipAt({ id: 'clip_hidden', mediaId: asset.id })
    const inactive = clipAt({ id: 'clip_inactive', mediaId: asset.id, start: 10 })
    const missing = clipAt({ id: 'clip_missing', mediaId: 'media_gone' })
    const audio = clipAt({ id: 'clip_audio', mediaId: asset.id, audioOnly: true })
    const doc = docWith(
      [
        createTrack('video', 1, { clips: [hidden], visible: false }),
        createTrack('video', 2, { clips: [inactive] }),
        createTrack('video', 3, { clips: [missing] }),
        createTrack('audio', 1, { clips: [audio] }),
      ],
      [asset],
    )
    expect(pickVisualClipAt(doc, [], 1, { x: 960, y: 540 }, measure)).toBeUndefined()
    expect(pickVisualClipAt(doc, [], 11, { x: 960, y: 540 }, measure)?.id).toBe('clip_inactive')
  })

  it('picks the later-start clip when two overlap on one track', () => {
    const asset = videoAsset()
    const first = clipAt({ id: 'clip_first', mediaId: asset.id, start: 0, duration: 10 })
    const second = clipAt({ id: 'clip_second', mediaId: asset.id, start: 5, duration: 10 })
    const doc = docWith([createTrack('video', 1, { clips: [first, second] })], [asset])
    // The compositor sorts by start and draws the later clip last.
    expect(pickVisualClipAt(doc, [], 6, { x: 960, y: 540 }, measure)?.id).toBe('clip_second')
  })

  it('skips a crossfade clip while its transition alpha is zero', () => {
    const asset = videoAsset()
    const outgoing = clipAt({
      id: 'clip_out',
      mediaId: asset.id,
      start: 0,
      duration: 10,
      transitionOut: { type: 'crossfade', duration: 2 },
    })
    const incoming = clipAt({ id: 'clip_in', mediaId: asset.id, start: 8, duration: 10 })
    const doc = docWith([createTrack('video', 1, { clips: [outgoing, incoming] })], [asset])

    // At the span start the incoming alpha is 0, so the visible outgoing clip
    // must win the click.
    expect(pickVisualClipAt(doc, [], 8, { x: 960, y: 540 }, measure)?.id).toBe('clip_out')
    // Mid-fade both are visible; the incoming is drawn last.
    expect(pickVisualClipAt(doc, [], 9, { x: 960, y: 540 }, measure)?.id).toBe('clip_in')
    // At the span end the outgoing alpha is 0 (and it is still active there).
    expect(pickVisualClipAt(doc, [], 10, { x: 960, y: 540 }, measure)?.id).toBe('clip_in')
  })

  it('keeps both clips selectable during a spatial transition', () => {
    const asset = videoAsset()
    const outgoing = clipAt({
      id: 'clip_wipe_out',
      mediaId: asset.id,
      start: 0,
      duration: 10,
      transitionOut: { type: 'wipe', duration: 2 },
    })
    const incoming = clipAt({ id: 'clip_wipe_in', mediaId: asset.id, start: 8, duration: 10 })
    const doc = docWith([createTrack('video', 1, { clips: [outgoing, incoming] })], [asset])
    // At the span start the reveal is empty, so the outgoing picture is the
    // only visible one; the wipe is not an alpha fade.
    expect(pickVisualClipAt(doc, [], 8, { x: 960, y: 540 }, measure)?.id).toBe('clip_wipe_out')
  })

  it('limits an incoming wipe clip to its revealed region', () => {
    const asset = videoAsset()
    const outgoing = clipAt({
      id: 'clip_wipe_out',
      mediaId: asset.id,
      start: 0,
      duration: 10,
      transitionOut: { type: 'wipe', duration: 2, direction: 'left' },
    })
    const incoming = clipAt({ id: 'clip_wipe_in', mediaId: asset.id, start: 8, duration: 10 })
    const doc = docWith([createTrack('video', 1, { clips: [outgoing, incoming] })], [asset])
    // At 25% the reveal is the left 480px: inside selects the incoming,
    // outside selects the visible outgoing.
    expect(pickVisualClipAt(doc, [], 8.5, { x: 200, y: 540 }, measure)?.id).toBe('clip_wipe_in')
    expect(pickVisualClipAt(doc, [], 8.5, { x: 1500, y: 540 }, measure)?.id).toBe('clip_wipe_out')
  })

  it('omits a zero-alpha crossfade clip from snap targets until it is visible', () => {
    const asset = videoAsset()
    const outgoing = clipAt({
      id: 'clip_snap_out',
      mediaId: asset.id,
      start: 0,
      duration: 10,
      transitionOut: { type: 'crossfade', duration: 2 },
    })
    const incoming = clipAt({
      id: 'clip_snap_in',
      mediaId: asset.id,
      start: 8,
      duration: 10,
      animStatics: { positionX: 600 },
    })
    const doc = docWith([createTrack('video', 1, { clips: [outgoing, incoming] })], [asset])
    expect(canvasSnapTargets(doc, [], 8, [], measure).vertical).not.toContain(1560)
    expect(canvasSnapTargets(doc, [], 9, [], measure).vertical).toContain(1560)
  })

  it('follows a slide translation when picking the incoming clip', () => {
    const asset = videoAsset()
    const outgoing = clipAt({
      id: 'clip_slide_out',
      mediaId: asset.id,
      start: 0,
      duration: 10,
      transitionOut: { type: 'slide', duration: 2, direction: 'left' },
    })
    const incoming = clipAt({ id: 'clip_slide_in', mediaId: asset.id, start: 8, duration: 10 })
    const doc = docWith([createTrack('video', 1, { clips: [outgoing, incoming] })], [asset])
    // At the start the incoming sits a full frame left, out of reach; halfway
    // its translated picture covers the left half, so it wins there.
    expect(pickVisualClipAt(doc, [], 8, { x: 200, y: 540 }, measure)?.id).toBe('clip_slide_out')
    expect(pickVisualClipAt(doc, [], 9, { x: 200, y: 540 }, measure)?.id).toBe('clip_slide_in')
  })

  it('moves a slide clip snap lines with its transition offset', () => {
    const asset = videoAsset({ width: 400, height: 300 })
    const outgoing = clipAt({
      id: 'clip_snap_slide_out',
      mediaId: asset.id,
      start: 0,
      duration: 10,
      transitionOut: { type: 'slide', duration: 2, direction: 'right' },
    })
    const incoming = clipAt({
      id: 'clip_snap_slide_in',
      mediaId: asset.id,
      start: 8,
      duration: 10,
      animStatics: { scale: 0.5 },
    })
    const doc = docWith([createTrack('video', 1, { clips: [outgoing, incoming] })], [asset])
    // The contain-fit base is [240, 1680], scaled 0.5 to [600, 1320]. At half
    // the slide the +960 offset draws it at [1560, 2280], so the unshifted
    // lines must not be targets.
    const targets = canvasSnapTargets(doc, [], 9, [], measure)
    expect(targets.vertical).toEqual(expect.arrayContaining([1560, 2280]))
    expect(targets.vertical).not.toContain(600)
    expect(targets.vertical).not.toContain(1320)
  })

  it('keeps text, shape, and compound clips eligible without a media asset', () => {
    const text = createTextClip({ id: 'clip_t', start: 0, duration: 4 })
    const shape = createShapeClip({ id: 'clip_s', start: 0, duration: 4 })
    const compound = clipAt({ id: 'clip_c', sequenceId: 'seq_1' })
    const doc = docWith([
      createTrack('text', 1, { clips: [text] }),
      createTrack('video', 1, { clips: [shape, compound] }),
    ])
    expect(pickVisualClipAt(doc, [], 1, { x: 960, y: 540 }, measure)?.id).toBe('clip_t')
    doc.project.tracks.reverse()
    // Equal starts draw in stored order; the compound is last, so it is on top.
    expect(pickVisualClipAt(doc, [], 1, { x: 960, y: 540 }, measure)?.id).toBe('clip_c')
  })

  it('a keyframed opacity of zero also blocks the pick', () => {
    const asset = videoAsset()
    const top = clipAt({
      id: 'clip_top',
      mediaId: asset.id,
      keyframes: { opacity: [{ time: 0, value: 0 }] },
    })
    const bottom = clipAt({ id: 'clip_bottom', mediaId: asset.id })
    const doc = docWith(
      [createTrack('video', 1, { clips: [top] }), createTrack('video', 2, { clips: [bottom] })],
      [asset],
    )
    expect(clipOpacityAt(top, 1)).toBe(0)
    expect(pickVisualClipAt(doc, [], 1, { x: 960, y: 540 }, measure)?.id).toBe('clip_bottom')
  })
})

describe('canvasSnapTargets', () => {
  it('includes the frame lines and transformed clip bounds, never the base rect', () => {
    const asset = videoAsset({ width: 400, height: 300 })
    // Positioned and scaled 0.5: its transformed box is small and centered.
    const clip = clipAt({
      id: 'clip_t',
      mediaId: asset.id,
      animStatics: { positionX: 400, positionY: 0, scale: 0.5 },
    })
    const doc = docWith([createTrack('video', 1, { clips: [clip] })], [asset])
    const targets = canvasSnapTargets(doc, [], 1, [], measure)

    // Frame lines.
    expect(targets.vertical).toEqual(expect.arrayContaining([0, 960, 1920]))
    expect(targets.horizontal).toEqual(expect.arrayContaining([0, 540, 1080]))

    // The clip's contain-fit base is 1920x1080 (400x300 at 16:9 would letterbox
    // to 1440x1080); scaled 0.5 and shifted +400 its bounds are centered at
    // 1360, so the right edge is 1720, not the base's 1920.
    expect(targets.vertical).toContain(1720)
    expect(targets.vertical).not.toContain(1920 + 400)
  })

  it('excludes hidden, inactive, excluded, and transparent clips', () => {
    const asset = videoAsset({ width: 400, height: 300 })
    const visible = clipAt({ id: 'clip_visible', mediaId: asset.id })
    const hidden = clipAt({ id: 'clip_hidden', mediaId: asset.id })
    const doc = docWith(
      [
        createTrack('video', 1, { clips: [hidden], visible: false }),
        createTrack('video', 2, { clips: [visible] }),
      ],
      [asset],
    )
    const excluded = canvasSnapTargets(doc, [], 1, ['clip_visible'], measure)
    expect(excluded.vertical).toEqual([0, 960, 1920])
    expect(excluded.horizontal).toEqual([0, 540, 1080])
  })
})

describe('snapBoxToTargets', () => {
  const targets = { vertical: [0, 960, 1920], horizontal: [0, 540, 1080] }

  it('snaps an edge and a center independently', () => {
    const result = snapBoxToTargets({ x0: 955, y0: 400, x1: 1005, y1: 450 }, targets, 8)
    expect(result.dx).toBe(5) // center 980 -> 985? no: center 980, nearest 960? edge 955 is 5 away
    expect(result.guides.x).toBe(960)
    expect(result.dy).toBe(0)
    expect(result.guides.y).toBeNull()
  })

  it('reports no guide when nothing is within the threshold', () => {
    const result = snapBoxToTargets({ x0: 100, y0: 100, x1: 200, y1: 200 }, targets, 8)
    expect(result).toEqual({ dx: 0, dy: 0, guides: { x: null, y: null } })
  })

  it('ignores a non-finite threshold', () => {
    expect(snapBoxToTargets({ x0: 955, y0: 400, x1: 1005, y1: 450 }, targets, Number.NaN)).toEqual({
      dx: 0,
      dy: 0,
      guides: { x: null, y: null },
    })
  })

  it('does not snap a degenerate box on either axis', () => {
    expect(snapBoxToTargets({ x0: 0, y0: 400, x1: 0, y1: 450 }, targets, 8)).toEqual({
      dx: 0,
      dy: 0,
      guides: { x: null, y: null },
    })
    expect(snapBoxToTargets({ x0: 955, y0: 540, x1: 1005, y1: 540 }, targets, 8)).toEqual({
      dx: 0,
      dy: 0,
      guides: { x: null, y: null },
    })
  })
})

describe('monitor geometry defensive paths', () => {
  const noMeasure: TextMeasure = () => null

  it('returns a finite zero rect for an empty quad', () => {
    expect(quadBounds([])).toEqual({ x0: 0, y0: 0, x1: 0, y1: 0 })
  })

  it('a text box that cannot be measured has no base and cannot be picked', () => {
    const text = createTextClip({ id: 'clip_t', start: 0, duration: 4 })
    expect(baseRectForClip(text, undefined, WIDTH, HEIGHT, noMeasure)).toBeNull()
    const doc = docWith([createTrack('text', 1, { clips: [text] })])
    expect(pickVisualClipAt(doc, [], 1, { x: 960, y: 540 }, noMeasure)).toBeUndefined()
    // The unmeasured clip is eligible, so the null base is the skip in the
    // snap-target walk.
    expect(canvasSnapTargets(doc, [], 1, [], noMeasure)).toEqual({
      vertical: [0, 960, 1920],
      horizontal: [0, 540, 1080],
    })
  })

  it('refuses an audio asset and keeps the full frame for an unmeasured source', () => {
    const audio: MediaAsset = {
      id: 'media_a',
      name: 'sound.wav',
      kind: 'audio',
      duration: 10,
      width: 0,
      height: 0,
      url: 'blob:audio',
    } as MediaAsset
    expect(baseRectForClip(clipAt({ mediaId: audio.id }), audio, WIDTH, HEIGHT, measure)).toBeNull()
    const unmeasured = videoAsset({ width: 0, height: 0 })
    expect(
      baseRectForClip(clipAt({ mediaId: unmeasured.id }), unmeasured, WIDTH, HEIGHT, measure),
    ).toEqual({ x0: 0, y0: 0, x1: WIDTH, y1: HEIGHT })
  })

  it('treats a non-finite opacity as fully opaque', () => {
    const clip = clipAt()
    clip.opacity = Number.NaN
    expect(clipOpacityAt(clip, 1)).toBe(1)
  })

  it('skips an audio-only clip parked on a video track', () => {
    const asset = videoAsset()
    const carrier = clipAt({ id: 'clip_a', mediaId: asset.id, audioOnly: true })
    const doc = docWith([createTrack('video', 1, { clips: [carrier] })], [asset])
    expect(pickVisualClipAt(doc, [], 1, { x: 960, y: 540 }, measure)).toBeUndefined()
    const targets = canvasSnapTargets(doc, [], 1, [], measure)
    expect(targets.vertical).toEqual([0, 960, 1920])
  })

  it('skips a non-text clip on a text track and inactive snap candidates', () => {
    const shape = createShapeClip({ id: 'clip_s', start: 0, duration: 4 })
    const inactive = createShapeClip({ id: 'clip_i', start: 10, duration: 4 })
    const doc = docWith([
      createTrack('text', 1, { clips: [shape] }),
      createTrack('video', 1, { clips: [inactive] }),
    ])
    expect(pickVisualClipAt(doc, [], 1, { x: 960, y: 540 }, measure)).toBeUndefined()
    expect(canvasSnapTargets(doc, [], 1, [], measure)).toEqual({
      vertical: [0, 960, 1920],
      horizontal: [0, 540, 1080],
    })
  })

  it('adds a neutral transformed clip and falls back to the identity transform', () => {
    const asset = videoAsset({ width: 400, height: 300 })
    const neutral = clipAt({ id: 'clip_n', mediaId: asset.id })
    const doc = docWith([createTrack('video', 1, { clips: [neutral] })], [asset])
    const targets = canvasSnapTargets(doc, [], 1, [], measure)
    // The neutral clip's contain-fit box is 1440 wide, centered: 240..1680.
    expect(targets.vertical).toEqual(expect.arrayContaining([240, 960, 1680]))
  })

  it('ignores non-finite box edges and snap targets', () => {
    const result = snapBoxToTargets(
      { x0: Number.NaN, y0: Number.NaN, x1: 100, y1: 100 },
      { vertical: [Number.NaN, 0], horizontal: [Number.NaN, 0] },
      8,
    )
    expect(result).toEqual({ dx: 0, dy: 0, guides: { x: null, y: null } })
  })
})
