// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { drawFrame, type MediaResolver } from '../playback/compositor'
import { createFake2DContext, installBrowserMocks, type MockHarness } from './mocks/browser-mocks'
import { createClip, createDoc, createMediaAsset, createTrack } from '../factories'
import type { Clip, Doc, MediaAsset } from '../types'

/**
 * Canvas compositor against a recording fake 2D context ("B" side of the A/B
 * battery): compositing order, contain-fit geometry, crossfade alphas and
 * text styling become assertable call traces.
 */

let h: MockHarness

beforeEach(() => {
  h = installBrowserMocks()
})

afterEach(() => {
  h.uninstall()
})

function makeDoc(): { doc: Doc; asset: MediaAsset } {
  const doc = createDoc()
  doc.media.push(
    createMediaAsset({
      kind: 'video',
      name: 'v',
      duration: 10,
      width: 640,
      height: 360,
      url: 'blob:v',
    }),
  )
  return { doc, asset: doc.media[0] }
}

function videoEl(): HTMLVideoElement {
  const el = document.createElement('video')
  Object.defineProperty(el, 'readyState', { configurable: true, value: 2 })
  Object.defineProperty(el, 'videoWidth', { configurable: true, value: 640 })
  Object.defineProperty(el, 'videoHeight', { configurable: true, value: 360 })
  return el
}

const drawOps = (ctx: unknown, op: string) =>
  (ctx as { calls: { op: string; args: unknown[] }[] }).calls.filter((c) => c.op === op)

describe('compositor drawFrame (mocked 2D context)', () => {
  it('paints a black background before any layer', () => {
    const { doc } = makeDoc()
    const ctx = createFake2DContext()
    drawFrame({ ctx, doc, time: 0, resolve: () => undefined })

    const bg = (ctx as unknown as { calls: { op: string; args: unknown[] }[] }).calls.find(
      (c) => c.op === 'fillRect',
    )
    expect(bg?.args).toEqual([0, 0, 1920, 1080])
    expect((ctx as unknown as { props: Map<string, unknown> }).props.get('fillStyle')).toBe(
      '#000000',
    )
  })

  it('draws video contain-fit: 640×360 source fills 1920×1080 exactly', () => {
    const { doc, asset } = makeDoc()
    doc.project.tracks[0].clips.push(
      createClip({ id: 'c1', mediaId: asset.id, start: 0, duration: 4, inPoint: 0 }),
    )
    const el = videoEl()
    const resolve: MediaResolver = () => ({ asset, el })
    const ctx = createFake2DContext()
    drawFrame({ ctx, doc, time: 1, resolve })

    const draws = drawOps(ctx, 'drawImage')
    expect(draws).toHaveLength(1)
    expect(draws[0].args).toEqual([el, 0, 0, 1920, 1080])
  })

  it('scales from the frame center (offsets follow the scaled size)', () => {
    const { doc, asset } = makeDoc()
    doc.project.tracks[0].clips.push(
      createClip({
        id: 'c1',
        mediaId: asset.id,
        start: 0,
        duration: 4,
        inPoint: 0,
        animStatics: { scale: 2 },
      }),
    )
    const el = videoEl()
    const resolve: MediaResolver = () => ({ asset, el })
    const ctx = createFake2DContext()
    drawFrame({ ctx, doc, time: 1, resolve })

    const args = drawOps(ctx, 'drawImage')[0].args as unknown[]
    // fit = min(1920/640, 1080/360) = 3 → 1920x1080 at scale 1; x2 → 3840x2160,
    // still centered on the 1920x1080 frame (dx/dy come from the scaled size).
    expect(args).toEqual([el, -960, -540, 3840, 2160])
  })

  it('letterboxes mismatched aspect ratios (contain-fit centers the frame)', () => {
    const { doc, asset } = makeDoc()
    doc.project.tracks[0].clips.push(
      createClip({ id: 'c1', mediaId: asset.id, start: 0, duration: 4, inPoint: 0 }),
    )
    const el = document.createElement('video')
    Object.defineProperty(el, 'readyState', { configurable: true, value: 2 })
    Object.defineProperty(el, 'videoWidth', { configurable: true, value: 640 })
    Object.defineProperty(el, 'videoHeight', { configurable: true, value: 480 }) // 4:3 into 16:9
    const resolve: MediaResolver = () => ({ asset, el })
    const ctx = createFake2DContext()
    drawFrame({ ctx, doc, time: 1, resolve })

    const args = drawOps(ctx, 'drawImage')[0].args as unknown[]
    // scale = min(1920/640, 1080/480) = 2.25 → 1440×1080 centered horizontally.
    expect(args.slice(1)).toEqual([(1920 - 1440) / 2, 0, 1440, 1080])
  })

  it('composites bottom→top: tracks[0] is drawn last (topmost)', () => {
    const { doc, asset } = makeDoc()
    const top = createTrack('video', 1, { id: 't-top' })
    const bottom = createTrack('video', 2, { id: 't-bottom' })
    doc.project.tracks = [top, bottom]
    const eTop = videoEl()
    const eBottom = videoEl()
    top.clips.push(createClip({ id: 'ct', mediaId: asset.id, start: 0, duration: 4, inPoint: 0 }))
    bottom.clips.push(
      createClip({ id: 'cb', mediaId: asset.id, start: 0, duration: 4, inPoint: 0 }),
    )
    const resolve: MediaResolver = (clip) => ({
      asset,
      el: clip.id === 'ct' ? eTop : eBottom,
    })
    const ctx = createFake2DContext()
    drawFrame({ ctx, doc, time: 1, resolve })

    const draws = drawOps(ctx, 'drawImage')
    expect(draws).toHaveLength(2)
    expect(draws[0].args[0]).toBe(eBottom) // bottom track first…
    expect(draws[1].args[0]).toBe(eTop) // …top track last
  })

  it('blends crossfading clips with complementary alphas', () => {
    const { doc, asset } = makeDoc()
    doc.project.tracks[0].clips.push(
      createClip({
        id: 'a',
        mediaId: asset.id,
        start: 0,
        duration: 4,
        inPoint: 0,
        transitionOut: { type: 'crossfade', duration: 1 },
      }),
    )
    doc.project.tracks[0].clips.push(
      createClip({ id: 'b', mediaId: asset.id, start: 3, duration: 4, inPoint: 0 }),
    )
    const ea = videoEl()
    const eb = videoEl()
    const resolve: MediaResolver = (clip) => ({ asset, el: clip.id === 'a' ? ea : eb })
    const ctx = createFake2DContext()
    drawFrame({ ctx, doc, time: 3.25, resolve }) // p = 0.25

    const alphas = drawOps(ctx, 'set:globalAlpha').map((c) => c.args[0])
    expect(alphas).toContain(0.75)
    expect(alphas).toContain(0.25)
    const draws = drawOps(ctx, 'drawImage')
    expect(draws[0].args[0]).toBe(ea) // outgoing clip at 1-p
    expect(draws[1].args[0]).toBe(eb) // incoming clip at p
  })

  it('renders styled multi-line text with shadow settings', () => {
    const { doc } = makeDoc()
    doc.project.tracks.unshift(createTrack('text', 1, { id: 't-text' }))
    const clip: Clip = createClip({
      id: 'txt',
      text: 'Hello\nWorld',
      start: 0,
      duration: 4,
      style: {
        fontSize: 64,
        color: '#ff0000',
        fontFamily: 'Geist',
        bold: true,
        italic: true,
        align: 'center',
        x: 0.5,
        y: 0.5,
        shadow: true,
      },
    })
    doc.project.tracks[0].clips.push(clip)
    const ctx = createFake2DContext()
    drawFrame({ ctx, doc, time: 1, resolve: () => undefined })

    const props = (ctx as unknown as { props: Map<string, unknown> }).props
    expect(props.get('font')).toBe('italic 700 64px Geist')
    expect(props.get('textAlign')).toBe('center')
    expect(props.get('fillStyle')).toBe('#ff0000')
    expect(props.get('shadowBlur')).toBe(8) // max(4, 64/8)
    const texts = drawOps(ctx, 'fillText').map((c) => c.args[0])
    expect(texts).toEqual(['Hello', 'World'])
  })

  it('skips drawing when the video is not decodable (readyState < 2)', () => {
    const { doc, asset } = makeDoc()
    doc.project.tracks[0].clips.push(
      createClip({ id: 'c1', mediaId: asset.id, start: 0, duration: 4, inPoint: 0 }),
    )
    const el = document.createElement('video') // readyState 0
    const resolve: MediaResolver = () => ({ asset, el })
    const ctx = createFake2DContext()
    drawFrame({ ctx, doc, time: 1, resolve })
    expect(drawOps(ctx, 'drawImage')).toHaveLength(0)
    void h
  })
})
