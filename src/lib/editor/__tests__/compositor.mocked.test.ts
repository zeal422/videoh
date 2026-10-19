// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { drawFrame, type MediaResolver } from '../playback/compositor'
import { parseCubeLut } from '../lut'
import { createFake2DContext, installBrowserMocks, type MockHarness } from './mocks/browser-mocks'
import { createClip, createDoc, createMediaAsset, createTextClip, createTrack } from '../factories'
import type { Clip, Doc, MediaAsset } from '../types'

/** An identity cube of the given size, in `.cube` row order (red fastest). */
function identityCubeText(size: number): string {
  const rows = [`LUT_3D_SIZE ${size}`]
  const last = size - 1
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        rows.push(`${(r / last).toFixed(6)} ${(g / last).toFixed(6)} ${(b / last).toFixed(6)}`)
      }
    }
  }
  return rows.join('\n')
}

/**
 * Canvas compositor against a recording fake 2D context ("B" side of the A/B
 * battery): compositing order, contain-fit geometry, crossfade alphas and
 * text styling become assertable call traces.
 */

let h: MockHarness

/**
 * Every detached scratch canvas the compositor mints (the pools never attach
 * to the document, so the suite tracks creation instead of querying the DOM).
 * A direct assignment (not vi.spyOn, whose re-spy returns the same stacked
 * mock and recursed) captured once at import, restored after every test.
 */
const mintedCanvases: HTMLCanvasElement[] = []
const pristineCreateElement = document.createElement.bind(document)

function trackCanvases(tagName: string, options?: ElementCreationOptions): HTMLElement {
  const el = pristineCreateElement(tagName, options)
  if (tagName === 'canvas' && !mintedCanvases.includes(el as unknown as HTMLCanvasElement)) {
    mintedCanvases.push(el as unknown as HTMLCanvasElement)
  }
  return el
}

beforeEach(() => {
  h = installBrowserMocks()
  // The list is NOT cleared here: the compositor's pools persist across
  // tests and reuse their canvases, so re-tracking happens only for
  // genuinely new surfaces. Tests clear recorded CALLS via
  // resetScratchCalls instead.
  document.createElement = trackCanvases as typeof document.createElement
})

afterEach(() => {
  h.uninstall()
  document.createElement = pristineCreateElement
})

/** Clear recorded calls on all minted scratch canvases. */
function resetScratchCalls(): void {
  for (const c of mintedCanvases) {
    const fake = (c as unknown as { __fakeCtx?: { calls: unknown[] } }).__fakeCtx
    if (fake) fake.calls.length = 0
  }
}

type ScratchCall = { op: string; args: unknown[] }

/** Recorded calls per minted scratch canvas. */
function scratchOps(): ScratchCall[][] {
  return mintedCanvases.map(
    (c) => (c as unknown as { __fakeCtx?: { calls: ScratchCall[] } }).__fakeCtx?.calls ?? [],
  )
}

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

  it('dips through black at the midpoint: neither clip draws', () => {
    const { doc, asset } = makeDoc()
    doc.project.tracks[0].clips.push(
      createClip({
        id: 'a',
        mediaId: asset.id,
        start: 0,
        duration: 4,
        inPoint: 0,
        transitionOut: { type: 'dipToBlack', duration: 1 },
      }),
    )
    doc.project.tracks[0].clips.push(
      createClip({ id: 'b', mediaId: asset.id, start: 3, duration: 4, inPoint: 0 }),
    )
    const ea = videoEl()
    const eb = videoEl()
    const resolve: MediaResolver = (clip) => ({ asset, el: clip.id === 'a' ? ea : eb })
    const ctx = createFake2DContext()
    drawFrame({ ctx, doc, time: 3.5, resolve }) // midpoint: both alphas 0

    expect(drawOps(ctx, 'drawImage')).toEqual([])
  })

  it('dip midpoint with a visible lower track draws only the lower clip', () => {
    const { doc, asset } = makeDoc()
    const top = createTrack('video', 1, { id: 't-top' })
    const bottom = createTrack('video', 2, { id: 't-bottom' })
    doc.project.tracks = [top, bottom]
    top.clips.push(
      createClip({
        id: 'a',
        mediaId: asset.id,
        start: 0,
        duration: 4,
        inPoint: 0,
        transitionOut: { type: 'dipToBlack', duration: 1 },
      }),
      createClip({ id: 'b', mediaId: asset.id, start: 3, duration: 4, inPoint: 0 }),
    )
    bottom.clips.push(createClip({ id: 'c', mediaId: asset.id, start: 0, duration: 8, inPoint: 0 }))
    const els = new Map([
      ['a', videoEl()],
      ['b', videoEl()],
      ['c', videoEl()],
    ])
    const resolve: MediaResolver = (clip) => ({ asset, el: els.get(clip.id) })
    const ctx = createFake2DContext()
    drawFrame({ ctx, doc, time: 3.5, resolve })

    const draws = drawOps(ctx, 'drawImage')
    expect(draws).toHaveLength(1)
    expect(draws[0].args[0]).toBe(els.get('c'))
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

  it('grades a 3D cube clip through the shared pixel pass, not the filter string', () => {
    const { doc, asset } = makeDoc()
    doc.project.luts = [parseCubeLut(identityCubeText(2), { id: 'cube', name: 'Cube' })]
    doc.project.tracks[0].clips.push(
      createClip({
        id: 'c1',
        mediaId: asset.id,
        start: 0,
        duration: 4,
        inPoint: 0,
        lutId: 'cube',
      }),
    )
    const el = videoEl()
    const ctx = createFake2DContext()
    drawFrame({ ctx, doc, time: 1, resolve: () => ({ asset, el }) })

    // The draw receives the GRADED scratch canvas, never the element and never
    // a filter string: a url() naming no mounted node would invalidate the whole
    // ctx.filter chain, which is why a cube carries no reference at all.
    const draws = drawOps(ctx, 'drawImage')
    expect(draws).toHaveLength(1)
    expect(draws[0].args[0]).not.toBe(el)
    expect(draws[0].args[0]).toBeInstanceOf(HTMLCanvasElement)
    // Geometry is untouched by the pass: still contain-fit 640x360 -> 1920x1080.
    expect(draws[0].args.slice(1)).toEqual([0, 0, 1920, 1080])
    expect(drawOps(ctx, 'set:filter')).toHaveLength(0)
    // The scratch canvas's own context (the harness hangs it off the element).
    const scratch = draws[0].args[0] as HTMLCanvasElement
    const scratchCtx = (scratch as unknown as { __fakeCtx: CanvasRenderingContext2D }).__fakeCtx
    expect(drawOps(scratchCtx, 'getImageData')[0].args).toEqual([0, 0, 640, 360])
    expect(drawOps(scratchCtx, 'putImageData')).toHaveLength(1)
  })

  it('rides a 1D shaper on the filter string without a pixel pass', () => {
    const { doc, asset } = makeDoc()
    doc.project.luts = [
      parseCubeLut('LUT_1D_SIZE 2\n0 0 0\n1 1 1', { id: 'shaper', name: 'Shaper' }),
    ]
    doc.project.tracks[0].clips.push(
      createClip({
        id: 'c1',
        mediaId: asset.id,
        start: 0,
        duration: 4,
        inPoint: 0,
        lutId: 'shaper',
      }),
    )
    const el = videoEl()
    const ctx = createFake2DContext()
    drawFrame({ ctx, doc, time: 1, resolve: () => ({ asset, el }) })

    // A shaper is exact as an SVG table, so it costs no read of the frame.
    expect(drawOps(ctx, 'drawImage')[0].args[0]).toBe(el)
    expect(drawOps(ctx, 'getImageData')).toHaveLength(0)
    expect(drawOps(ctx, 'set:filter').map((c) => c.args[0])).toEqual(['url(#lut-shaper)'])
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

/**
 * Sub-frame-rate blending, the draw half (0.7.0): the resolver hands over the
 * partner frame and its weight, and the pair is composited through the SAME
 * scratch composite the exporter uses (drawBlendedContain).
 */
describe('compositor frame blending (mocked 2D context)', () => {
  const scratchCtxOf = (scratch: unknown) =>
    (scratch as { __fakeCtx: CanvasRenderingContext2D }).__fakeCtx

  function slowClip(doc: Doc, asset: MediaAsset) {
    doc.project.tracks[0].clips.push(
      createClip({
        id: 'c1',
        mediaId: asset.id,
        start: 0,
        duration: 4,
        inPoint: 0,
        speed: 0.5,
      }),
    )
  }

  it('composites the weighted pair once, at the clip geometry and alpha', () => {
    const { doc, asset } = makeDoc()
    slowClip(doc, asset)
    const first = videoEl()
    const second = videoEl()
    const resolve: MediaResolver = () => ({ asset, el: first, blend: { el: second, weight: 0.25 } })
    const ctx = createFake2DContext()
    drawFrame({ ctx, doc, time: 1, resolve })

    // One draw, and it is the scratch canvas, not either source frame.
    const draws = drawOps(ctx, 'drawImage')
    expect(draws).toHaveLength(1)
    const scratch = draws[0].args[0] as HTMLCanvasElement
    expect(scratch).not.toBe(first)
    expect(scratch).toBeInstanceOf(HTMLCanvasElement)
    // Geometry is untouched by the blend: contain-fit 640x360 -> 1920x1080.
    expect(draws[0].args.slice(1)).toEqual([0, 0, 1920, 1080])

    // Additively over black, at 1-w then w, so the pair averages instead of
    // attenuating (see beginBlendPair).
    const sctx = scratchCtxOf(scratch) as unknown as { calls: { op: string; args: unknown[] }[] }
    const composite = drawOps(sctx, 'set:globalCompositeOperation').map((c) => c.args[0])
    expect(composite.slice(-2)).toEqual(['source-over', 'lighter'])
    const layers = drawOps(sctx, 'drawImage')
    expect(layers.slice(-2).map((c) => c.args[0])).toEqual([first, second])
    const alphas = drawOps(sctx, 'set:globalAlpha').map((c) => c.args[0])
    expect(alphas.slice(-3)).toEqual([1, 0.75, 0.25])
  })

  it('grades each blend layer separately when the clip carries a 3D cube', () => {
    const { doc, asset } = makeDoc()
    doc.project.luts = [parseCubeLut(identityCubeText(2), { id: 'cube', name: 'Cube' })]
    slowClip(doc, asset)
    doc.project.tracks[0].clips[0].lutId = 'cube'
    const first = videoEl()
    const second = videoEl()
    const resolve: MediaResolver = () => ({ asset, el: first, blend: { el: second, weight: 0.5 } })
    const ctx = createFake2DContext()
    // Both shared scratches persist across draws and tests, so the first draw
    // only serves to find them; their traces are cleared before the draw that
    // is actually asserted.
    drawFrame({ ctx, doc, time: 1, resolve })
    const scratch = drawOps(ctx, 'drawImage')[0].args[0]
    const handles = drawOps(scratchCtxOf(scratch), 'drawImage')
    const lutScratch = handles[handles.length - 1].args[0]
    const clearCalls = (target: unknown) => {
      ;(target as { calls: unknown[] }).calls.length = 0
    }
    ctx.calls.length = 0
    clearCalls(scratchCtxOf(scratch))
    clearCalls(scratchCtxOf(lutScratch))
    drawFrame({ ctx, doc, time: 1, resolve })

    // Both layers reach the scratch GRADED, through the one shared LUT scratch:
    // the pass is applied layer by layer because that scratch is reused.
    const layers = drawOps(scratchCtxOf(scratch), 'drawImage')
    expect(layers.map((c) => c.args[0])).not.toContain(first)
    expect(layers.map((c) => c.args[0])).not.toContain(second)
    expect(layers[0].args[0]).toBeInstanceOf(HTMLCanvasElement)
    expect(layers[0].args[0]).toBe(layers[1].args[0]) // one shared LUT scratch
    expect(drawOps(scratchCtxOf(lutScratch), 'getImageData')).toHaveLength(2)
  })

  it('draws a single frame when the weight sits at an end of the pair', () => {
    const { doc, asset } = makeDoc()
    slowClip(doc, asset)
    const first = videoEl()
    const second = videoEl()
    const resolve: MediaResolver = () => ({ asset, el: first, blend: { el: second, weight: 0 } })
    const ctx = createFake2DContext()
    drawFrame({ ctx, doc, time: 1, resolve })

    // Weight 0 means "the frame did not advance": the step the preview always
    // had, and no scratch pass for a pair that is one frame.
    const draws = drawOps(ctx, 'drawImage')
    expect(draws).toHaveLength(1)
    expect(draws[0].args[0]).toBe(first)
  })

  it('keeps the stepped draw when the partner frame is not decodable', () => {
    const { doc, asset } = makeDoc()
    slowClip(doc, asset)
    const first = videoEl()
    const second = document.createElement('video') // readyState 0
    const resolve: MediaResolver = () => ({ asset, el: first, blend: { el: second, weight: 0.5 } })
    const ctx = createFake2DContext()
    drawFrame({ ctx, doc, time: 1, resolve })

    expect(drawOps(ctx, 'drawImage')[0].args[0]).toBe(first)
  })

  it('composites a compound clip as a group (child into a scratch surface)', () => {
    const { doc, asset } = makeDoc()
    const child = createClip({ id: 'child', mediaId: asset.id, start: 0, duration: 4, inPoint: 0 })
    doc.project.sequences = [
      {
        id: 'seq1',
        name: 'Compound',
        tracks: [createTrack('video', 1, { id: 'st', clips: [child] })],
      },
    ]
    doc.project.tracks[0].clips.push(
      createClip({ id: 'comp', sequenceId: 'seq1', start: 0, duration: 4 }),
    )
    const el = videoEl()
    const seen: string[] = []
    const resolve: MediaResolver = (clip) => {
      seen.push(clip.id)
      return { asset, el }
    }
    const ctx = createFake2DContext()
    drawFrame({ ctx, doc, time: 1, resolve })

    // The child clip was resolved and drawn into the scratch surface, and the
    // MAIN frame received exactly one draw of that group surface (not the raw
    // element), which is what makes overlapping children composite as a unit.
    expect(seen).toEqual(['child'])
    const draws = drawOps(ctx, 'drawImage')
    expect(draws).toHaveLength(1)
    expect(draws[0].args[0]).not.toBe(el)
    // The scratch surface is CLEARED before reuse (no stale pixels between
    // sibling compounds) and the child element is drawn into it.
    const scratch = draws[0].args[0] as HTMLCanvasElement
    const sctx = scratch.getContext('2d') as unknown as {
      calls: { op: string; args: unknown[] }[]
    }
    expect(sctx.calls.some((c) => c.op === 'clearRect')).toBe(true)
    expect(sctx.calls.some((c) => c.op === 'drawImage')).toBe(true)
  })

  it('renders a compound inside a compound, preserving each parent surface', () => {
    const { doc, asset } = makeDoc()
    const innermost = createClip({
      id: 'innermost',
      mediaId: asset.id,
      start: 0,
      duration: 4,
      inPoint: 0,
    })
    doc.project.sequences = [
      {
        id: 'S1',
        name: 'Mid',
        tracks: [
          createTrack('video', 1, {
            id: 'i1',
            clips: [createClip({ id: 'mid', sequenceId: 'S2', start: 0, duration: 4 })],
          }),
        ],
      },
      {
        id: 'S2',
        name: 'Inner',
        tracks: [createTrack('video', 1, { id: 'i2', clips: [innermost] })],
      },
    ]
    doc.project.tracks = [
      createTrack('video', 1, {
        id: 'rt',
        clips: [createClip({ id: 'outer', sequenceId: 'S1', start: 0, duration: 4 })],
      }),
    ]
    const el = videoEl()
    const resolve: MediaResolver = () => ({ asset, el })
    const ctx = createFake2DContext()
    drawFrame({ ctx, doc, time: 1, resolve })

    const lastDrawSource = (c: unknown): unknown => {
      const calls = (c as { calls: { op: string; args: unknown[] }[] }).calls
      const draws = calls.filter((call) => call.op === 'drawImage')
      return draws[draws.length - 1].args[0]
    }
    // Each level draws the NEXT surface (the parent surface survives recursion),
    // and the innermost level draws the element.
    const outer = drawOps(ctx, 'drawImage')
    expect(outer).toHaveLength(1)
    const outerSurface = outer[0].args[0] as HTMLCanvasElement
    const midSurface = lastDrawSource(outerSurface.getContext('2d')) as HTMLCanvasElement
    expect(midSurface).not.toBe(outerSurface)
    expect(lastDrawSource(midSurface.getContext('2d'))).toBe(el)
  })

  it('draws a hard wipe at full opacity through the shared clip region', () => {
    const { doc, asset } = makeDoc()
    doc.project.tracks[0].clips.push(
      createClip({
        id: 'a',
        mediaId: asset.id,
        start: 0,
        duration: 4,
        inPoint: 0,
        transitionOut: { type: 'wipe', duration: 1, direction: 'left' },
      }),
    )
    doc.project.tracks[0].clips.push(
      createClip({ id: 'b', mediaId: asset.id, start: 3, duration: 4, inPoint: 0 }),
    )
    const ea = videoEl()
    const eb = videoEl()
    const resolve: MediaResolver = (clip) => ({ asset, el: clip.id === 'a' ? ea : eb })
    const ctx = createFake2DContext()
    drawFrame({ ctx, doc, time: 3.5, resolve }) // p = 0.5 on a 1920x1080 frame

    // The mocked context receives the planner's region: left half revealed.
    expect(drawOps(ctx, 'rect')).toEqual([{ op: 'rect', args: [0, 0, 960, 1080] }])
    expect(drawOps(ctx, 'clip')).toHaveLength(1)
    // Full-opacity rule: no alpha below 1 anywhere in the frame.
    const alphas = drawOps(ctx, 'set:globalAlpha').map((c) => c.args[0])
    expect(alphas.length).toBeGreaterThan(0)
    for (const alpha of alphas) expect(alpha).toBe(1)
    const draws = drawOps(ctx, 'drawImage')
    expect(draws.map((d) => d.args[0])).toEqual([ea, eb])
  })
})

describe('effect stack compositing (0.8.6, mocked 2D context)', () => {
  /** Doc with one video asset; tests push clips onto track 0. */
  function fxDoc(): { doc: Doc; asset: MediaAsset } {
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

  const fxClip = (asset: MediaAsset, over: Partial<Clip> = {}) =>
    createClip({ id: 'c1', mediaId: asset.id, start: 0, duration: 4, inPoint: 0, ...over })

  const resolveEl =
    (asset: MediaAsset, el: HTMLVideoElement): MediaResolver =>
    () => ({
      asset,
      el,
    })

  it('skips hidden tracks in the video composite', () => {
    const { doc, asset } = fxDoc()
    doc.project.tracks[0].clips = [
      createClip({ id: 'c1', mediaId: asset.id, start: 0, duration: 4, inPoint: 0 }),
    ]
    doc.project.tracks[0].visible = false
    const ctx = createFake2DContext()
    drawFrame({ ctx, doc, time: 1, resolve: resolveEl(asset, videoEl()) })
    expect(drawOps(ctx, 'drawImage')).toHaveLength(0)
  })

  it('skips the draw when a crop consumes the frame', () => {
    const { doc, asset } = fxDoc()
    doc.project.tracks[0].clips = [
      createClip({
        id: 'c1',
        mediaId: asset.id,
        start: 0,
        duration: 4,
        inPoint: 0,
        effects: [{ id: 'fx', type: 'crop', left: 60, right: 40 }],
      }),
    ]
    const ctx = createFake2DContext()
    drawFrame({ ctx, doc, time: 1, resolve: resolveEl(asset, videoEl()) })
    expect(drawOps(ctx, 'drawImage')).toHaveLength(0)
  })

  it('composites blended clips with the canvas blend mode at clip opacity', () => {
    const { doc, asset } = fxDoc()
    doc.project.tracks[0].clips = [
      createClip({
        id: 'c1',
        mediaId: asset.id,
        start: 0,
        duration: 4,
        inPoint: 0,
        opacity: 0.5,
        blendMode: 'multiply',
      }),
    ]
    const ctx = createFake2DContext()
    drawFrame({ ctx, doc, time: 1, resolve: resolveEl(asset, videoEl()) })
    const gcos = drawOps(ctx, 'set:globalCompositeOperation').map((c) => c.args[0])
    expect(gcos).toContain('multiply')
    // Blend-then-opacity: one composite carrying both.
    expect(drawOps(ctx, 'set:globalAlpha').map((c) => c.args[0])).toContain(0.5)
    expect(drawOps(ctx, 'drawImage')).toHaveLength(1)
  })

  it('routes effected clips through a scratch surface and masks crops in place', () => {
    const { doc, asset } = fxDoc()
    doc.project.tracks[0].clips = [
      createClip({
        id: 'c1',
        mediaId: asset.id,
        start: 0,
        duration: 4,
        inPoint: 0,
        effects: [{ id: 'fx', type: 'crop', left: 10, right: 10 }],
      }),
    ]
    resetScratchCalls()
    const ctx = createFake2DContext()
    drawFrame({ ctx, doc, time: 1, resolve: resolveEl(asset, videoEl()) })
    // Main composite blits a canvas, not the element.
    const mains = drawOps(ctx, 'drawImage')
    expect(mains).toHaveLength(1)
    expect(mains[0].args[0]).toBeInstanceOf(HTMLCanvasElement)
    // The crop mask ran on a scratch surface (destination-in keeps the rect).
    const all = scratchOps().flat()
    const gcos = all.filter((c) => c.op === 'set:globalCompositeOperation').map((c) => c.args[0])
    expect(gcos).toContain('destination-in')
  })

  it('evaluates the stack in stored order: swapping entries swaps operations', () => {
    const key = { id: 'fx_key', type: 'chromaKey' as const, key: '#00ff00' }
    const cropEntry = { id: 'fx_crop', type: 'crop' as const, left: 10 }
    const orderOf = (effects: Clip['effects']): number => {
      const { doc, asset } = fxDoc()
      doc.project.tracks[0].clips = [
        createClip({ id: 'c1', mediaId: asset.id, start: 0, duration: 4, inPoint: 0, effects }),
      ]
      resetScratchCalls()
      const ctx = createFake2DContext()
      drawFrame({ ctx, doc, time: 1, resolve: resolveEl(asset, videoEl()) })
      // The base scratch holds the core draw plus both entries: find the
      // canvas whose trace has the crop rect fill AND the keyer pixel read.
      const traces = scratchOps()
      const base = traces.find(
        (calls) =>
          calls.some((c) => c.op === 'fillRect') && calls.some((c) => c.op === 'getImageData'),
      )
      expect(base).toBeDefined()
      const ops = base!.map((c) => c.op)
      return ops.indexOf('fillRect') - ops.indexOf('getImageData')
    }
    // Crop-then-key fills before reading; key-then-crop reads before filling.
    expect(orderOf([cropEntry, key])).toBeLessThan(0)
    expect(orderOf([key, cropEntry])).toBeGreaterThan(0)
  })

  it('evaluates the stack before Motion: core draws identity, Motion lands at composite', () => {
    const { doc, asset } = fxDoc()
    doc.project.tracks[0].clips = [
      createClip({
        id: 'c1',
        mediaId: asset.id,
        start: 0,
        duration: 4,
        inPoint: 0,
        animStatics: { positionX: 100, scale: 2 },
        effects: [{ id: 'fx', type: 'crop', left: 10, right: 10 }],
      }),
    ]
    resetScratchCalls()
    const ctx = createFake2DContext()
    drawFrame({ ctx, doc, time: 1, resolve: resolveEl(asset, videoEl()) })
    // Core drew the source contain-fit with NO Motion (640x360 into
    // 1920x1080 is exactly full-frame): the crop saw untransformed content.
    const traces = scratchOps()
    const core = traces.find((calls) =>
      calls.some((c) => c.op === 'drawImage' && (c.args[0] as object) instanceof HTMLVideoElement),
    )
    expect(core).toBeDefined()
    const coreDraw = core!.find((c) => c.op === 'drawImage')
    expect((coreDraw!.args as unknown[]).slice(1)).toEqual([0, 0, 1920, 1080])
    // The final composite carries Motion instead: centered scale-2 blit
    // (drawImage at -960,-540 size 1920x1080; translate/scale ride the ctx).
    const mains = drawOps(ctx, 'drawImage')
    expect(mains).toHaveLength(1)
    expect(mains[0].args).toEqual([expect.any(HTMLCanvasElement), -960, -540, 1920, 1080])
  })

  it('skips unresolvable mattes instead of crashing', () => {
    const { doc, asset } = fxDoc()
    doc.project.tracks[0].clips = [
      createClip({
        id: 'c1',
        mediaId: asset.id,
        start: 0,
        duration: 4,
        inPoint: 0,
        effects: [{ id: 'fx', type: 'trackMatte', trackId: 'ghost' }],
      }),
    ]
    const ctx = createFake2DContext()
    drawFrame({ ctx, doc, time: 1, resolve: resolveEl(asset, videoEl()) })
    expect(drawOps(ctx, 'drawImage')).toHaveLength(1)
  })

  it('renders motion blur as one accumulated composite', () => {
    const { doc, asset } = fxDoc()
    doc.project.tracks[0].clips = [
      createClip({
        id: 'c1',
        mediaId: asset.id,
        start: 0,
        duration: 4,
        inPoint: 0,
        animStatics: { positionX: 100 },
        effects: [{ id: 'fx', type: 'motionBlur', shutter: 360 }],
      }),
    ]
    resetScratchCalls()
    const ctx = createFake2DContext()
    drawFrame({ ctx, doc, time: 1, resolve: resolveEl(asset, videoEl()) })
    // One composite on the main context; the 8 samples accumulate offscreen.
    expect(drawOps(ctx, 'drawImage')).toHaveLength(1)
    const all = scratchOps().flat()
    const draws = all.filter((c) => c.op === 'drawImage')
    expect(draws.length).toBeGreaterThanOrEqual(8)
  })

  it('accumulates blur samples additively at 1/N (exact mean with transparency)', () => {
    const { doc, asset } = fxDoc()
    doc.project.tracks[0].clips = [
      createClip({
        id: 'c1',
        mediaId: asset.id,
        start: 0,
        duration: 4,
        inPoint: 0,
        animStatics: { positionX: 100 },
        effects: [{ id: 'fx', type: 'motionBlur', shutter: 360 }],
      }),
    ]
    resetScratchCalls()
    const ctx = createFake2DContext()
    drawFrame({ ctx, doc, time: 1, resolve: resolveEl(asset, videoEl()) })
    // Shutter 360 at 30fps takes 8 samples: the accumulator must sum them
    // at 1/8 under 'lighter'. Source-over at 1/(k+1) is exact only for opaque
    // pixels; transparent samples would leave the pixel untouched while still
    // counting their weight, accumulating too opaque at temporal edges.
    const accumSurfaces = scratchOps().filter((calls) => {
      const gcos = calls
        .filter((c) => c.op === 'set:globalCompositeOperation')
        .map((c) => c.args[0])
      const alphas = calls.filter((c) => c.op === 'set:globalAlpha').map((c) => c.args[0])
      return gcos.includes('lighter') && alphas.includes(1 / 8)
    })
    expect(accumSurfaces.length).toBeGreaterThan(0)
  })

  it('a zero-shutter blur takes the direct draw (no scratch round-trip)', () => {
    const { doc, asset } = fxDoc()
    doc.project.tracks[0].clips = [
      createClip({
        id: 'c1',
        mediaId: asset.id,
        start: 0,
        duration: 4,
        inPoint: 0,
        effects: [{ id: 'fx', type: 'motionBlur', shutter: 0 }],
      }),
    ]
    const el = videoEl()
    const ctx = createFake2DContext()
    drawFrame({ ctx, doc, time: 1, resolve: resolveEl(asset, el) })
    // Inert stack (nothing to evaluate): the frame draws the element
    // directly instead of compositing a scratch canvas.
    const mains = drawOps(ctx, 'drawImage')
    expect(mains).toHaveLength(1)
    expect(mains[0].args[0]).toBe(el)
  })

  it('a single-sample shutter skips the accumulator entirely', () => {
    const { doc, asset } = fxDoc()
    doc.project.tracks[0].clips = [
      createClip({
        id: 'c1',
        mediaId: asset.id,
        start: 0,
        duration: 4,
        inPoint: 0,
        animStatics: { positionX: 100 },
        effects: [{ id: 'fx', type: 'motionBlur', shutter: 30 }],
      }),
    ]
    resetScratchCalls()
    const ctx = createFake2DContext()
    drawFrame({ ctx, doc, time: 1, resolve: resolveEl(asset, videoEl()) })
    // Shutter 30 takes exactly one sample at t: identical to no blur, so no
    // accumulator surface may run, while the frame still composites once.
    expect(drawOps(ctx, 'drawImage')).toHaveLength(1)
    const gcos = scratchOps()
      .flat()
      .filter((c) => c.op === 'set:globalCompositeOperation')
      .map((c) => c.args[0])
    expect(gcos).not.toContain('lighter')
    // The collapsed image is untransformed, so Motion must still land via
    // the transformed blit (a bare 3-arg draw would silently drop positionX).
    const mains = drawOps(ctx, 'drawImage')
    expect(mains[0].args).toEqual([expect.any(HTMLCanvasElement), -960, -540, 1920, 1080])
  })

  it('a feathered wipe composites the incoming clip with its blend mode', () => {
    const { doc, asset } = fxDoc()
    doc.project.tracks[0].clips.push(
      createClip({
        id: 'a',
        mediaId: asset.id,
        start: 0,
        duration: 4,
        inPoint: 0,
        transitionOut: { type: 'wipe', duration: 1, direction: 'left', edge: 'feathered' },
      }),
    )
    doc.project.tracks[0].clips.push(
      createClip({
        id: 'b',
        mediaId: asset.id,
        start: 3,
        duration: 4,
        inPoint: 0,
        blendMode: 'multiply',
      }),
    )
    const ea = videoEl()
    const eb = videoEl()
    const resolve: MediaResolver = (clip) => ({ asset, el: clip.id === 'a' ? ea : eb })
    const ctx = createFake2DContext()
    drawFrame({ ctx, doc, time: 3.5, resolve })
    // The masked incoming scratch must land blended, not source-over: the
    // last composite op before a canvas-sourced draw is the incoming blend.
    const calls = (ctx as unknown as { calls: ScratchCall[] }).calls
    let lastGco: unknown = 'source-over'
    const canvasComposites: unknown[] = []
    for (const call of calls) {
      if (call.op === 'set:globalCompositeOperation') lastGco = call.args[0]
      else if (call.op === 'drawImage' && call.args[0] instanceof HTMLCanvasElement) {
        canvasComposites.push(lastGco)
      }
    }
    expect(canvasComposites).toContain('multiply')
  })
})

describe('hidden matte sources (0.8.6, mocked 2D context)', () => {
  it('a hidden source track still masks (visibility skips the composite, not the mask)', () => {
    const { doc, asset } = makeDoc()
    const upper = createTrack('text', 1, { id: 't_up', visible: false })
    upper.clips = [createTextClip({ id: 'mask', start: 0, duration: 4, text: 'Hi' })]
    const lower = createTrack('video', 2, { id: 't_lo' })
    lower.clips = [
      createClip({
        id: 'c1',
        mediaId: asset.id,
        start: 0,
        duration: 4,
        inPoint: 0,
        effects: [{ id: 'fx', type: 'trackMatte', trackId: 't_up' }],
      }),
    ]
    doc.project.tracks = [upper, lower]
    resetScratchCalls()
    const el = videoEl()
    const ctx = createFake2DContext()
    drawFrame({ ctx, doc, time: 1, resolve: () => ({ asset, el }) })
    // Effect path ran and composited (no skip, no crash on the hidden source).
    expect(drawOps(ctx, 'drawImage')).toHaveLength(1)
    // The mask render drew the hidden track's text: a fillText on scratch
    // proves the visibility bypass (without it the mask stays empty).
    const scratchTexts = scratchOps()
      .flat()
      .filter((call) => call.op === 'fillText')
    expect(scratchTexts.length).toBeGreaterThan(0)
  })

  it('stacked mattes keep distinct mask canvases (no pooled overwrite)', () => {
    const { doc, asset } = makeDoc()
    const src2 = createTrack('text', 1, { id: 't_src2' })
    src2.clips = [createTextClip({ id: 'mask2', start: 0, duration: 4, text: 'Two' })]
    const src1 = createTrack('text', 2, { id: 't_src1' })
    src1.clips = [createTextClip({ id: 'mask1', start: 0, duration: 4, text: 'One' })]
    const lower = createTrack('video', 3, { id: 't_lo' })
    lower.clips = [
      createClip({
        id: 'c1',
        mediaId: asset.id,
        start: 0,
        duration: 4,
        inPoint: 0,
        effects: [
          { id: 'fx1', type: 'trackMatte', trackId: 't_src1' },
          { id: 'fx2', type: 'trackMatte', trackId: 't_src2' },
        ],
      }),
    ]
    doc.project.tracks = [src2, src1, lower]
    resetScratchCalls()
    const el = videoEl()
    const ctx = createFake2DContext()
    drawFrame({ ctx, doc, time: 1, resolve: () => ({ asset, el }) })
    // Each destination-in draw must reference its own mask canvas: a shared
    // pooled build canvas would hand the same object to both entries, so the
    // second mask would overwrite the first.
    const masked: unknown[] = []
    for (const calls of scratchOps()) {
      let armed = false
      for (const call of calls) {
        if (call.op === 'set:globalCompositeOperation') armed = call.args[0] === 'destination-in'
        else if (call.op === 'drawImage' && armed) {
          masked.push(call.args[0])
          armed = false
        } else if (call.op === 'save' || call.op === 'restore') {
          // Composite state boundaries do not disarm the pending draw.
        } else if (call.op !== 'set:globalCompositeOperation') armed = false
      }
    }
    expect(masked).toHaveLength(2)
    expect(masked[0]).not.toBe(masked[1])
  })
})
