// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { drawFrame, type MediaResolver } from '../playback/compositor'
import { createFake2DContext, installBrowserMocks, type MockHarness } from './mocks/browser-mocks'
import { createClip, createDoc, createMediaAsset, createTrack } from '../factories'
import type { Doc, MediaAsset } from '../types'

/**
 * Clip opacity (Premiere/Photoshop-style layering): opacity multiplies into
 * every draw of a clip and stacks with crossfade alphas, so higher tracks can
 * see through to lower ones.
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

describe('clip opacity compositing (mocked 2D context)', () => {
  it('applies clip opacity to video draws (0.5 → globalAlpha 0.5)', () => {
    const { doc, asset } = makeDoc()
    doc.project.tracks[0].clips.push(
      createClip({ id: 'c1', mediaId: asset.id, start: 0, duration: 4, inPoint: 0, opacity: 0.5 }),
    )
    const el = videoEl()
    const resolve: MediaResolver = () => ({ asset, el })
    const ctx = createFake2DContext()
    drawFrame({ ctx, doc, time: 1, resolve })

    const alphas = drawOps(ctx, 'set:globalAlpha').map((c) => c.args[0])
    expect(alphas).toContain(0.5)
    expect(drawOps(ctx, 'drawImage')).toHaveLength(1)
  })

  it('stacks with crossfade alpha (outgoing 0.75 × 0.5 = 0.375, incoming 0.25)', () => {
    const { doc, asset } = makeDoc()
    doc.project.tracks[0].clips.push(
      createClip({
        id: 'a',
        mediaId: asset.id,
        start: 0,
        duration: 4,
        inPoint: 0,
        opacity: 0.5,
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
    expect(alphas).toContain(0.375) // outgoing: 0.75 × 0.5
    expect(alphas).toContain(0.25) // incoming: 0.25 × 1
  })

  it('draws nothing for fully transparent clips (opacity 0)', () => {
    const { doc, asset } = makeDoc()
    doc.project.tracks[0].clips.push(
      createClip({ id: 'c1', mediaId: asset.id, start: 0, duration: 4, inPoint: 0, opacity: 0 }),
    )
    const el = videoEl()
    const resolve: MediaResolver = () => ({ asset, el })
    const ctx = createFake2DContext()
    drawFrame({ ctx, doc, time: 1, resolve })

    expect(drawOps(ctx, 'drawImage')).toHaveLength(0)
  })

  it('applies opacity to text draws', () => {
    const { doc } = makeDoc()
    doc.project.tracks.unshift(createTrack('text', 1, { id: 't-text' }))
    doc.project.tracks[0].clips.push(
      createClip({
        id: 'txt',
        text: 'Hi',
        start: 0,
        duration: 4,
        opacity: 0.25,
        style: {
          fontSize: 64,
          color: '#ffffff',
          fontFamily: 'Arial',
          bold: true,
          italic: false,
          align: 'center',
          x: 0.5,
          y: 0.5,
          shadow: true,
        },
      }),
    )
    const ctx = createFake2DContext()
    drawFrame({ ctx, doc, time: 1, resolve: () => undefined })

    const alphas = drawOps(ctx, 'set:globalAlpha').map((c) => c.args[0])
    expect(alphas).toContain(0.25)
    expect(drawOps(ctx, 'fillText').map((c) => c.args[0])).toEqual(['Hi'])
  })
})
