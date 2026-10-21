// @vitest-environment jsdom
/**
 * Export effect-stack execution against the mocked 2D canvas
 * (export/mp4.ts): consumed crops, blend composites, motion-blur
 * accumulation and matte skip behavior. Needs a document for the export
 * scratch surfaces, so it lives here rather than in offline-plan.test.ts
 * (plain Node, no canvas).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { compositeFrame } from '../export/mp4'
import { planVideoFrame } from '../export/offline'
import { createFake2DContext, installBrowserMocks, type MockHarness } from './mocks/browser-mocks'
import { createTextClip, createTrack } from '../factories'
import type { Clip, Doc, MediaAsset } from '../types'

let h: MockHarness

/**
 * Every detached scratch canvas the exporter mints (pools never attach to
 * the document, so the suite tracks creation instead of querying the DOM).
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

function doc(tracks: { kind: 'video' | 'audio' | 'text'; clips: Clip[] }[]): Doc {
  return {
    project: {
      id: 'p',
      name: 'n',
      width: 1920,
      height: 1080,
      fps: 30,
      tracks: tracks.map((t, i) =>
        createTrack(t.kind, i + 1, { id: `track_${i}`, clips: t.clips }),
      ),
    },
    media: [] as MediaAsset[],
  }
}

const textClip = (over: Partial<Clip> = {}) =>
  createTextClip({ id: 'tx', start: 0, duration: 4, text: 'Hi', ...over })

function composite(d: Doc): { op: string; args: unknown[] }[] {
  const ctx = createFake2DContext()
  compositeFrame(
    ctx as unknown as CanvasRenderingContext2D,
    d,
    planVideoFrame(d, 0),
    new Map(),
    1920,
    1080,
    new Map(),
  )
  return ctx.calls as { op: string; args: unknown[] }[]
}

describe('export effect execution (0.8.6, mocked 2D context)', () => {
  it('skips consumed crops and composites blends with the mode', () => {
    const eaten = textClip({
      id: 'eaten',
      effects: [{ id: 'fx', type: 'crop', left: 50, right: 50 }],
    })
    const dblend = doc([
      { kind: 'text', clips: [textClip({ id: 'blended', blendMode: 'multiply' })] },
    ])
    const calls = composite(dblend)
    expect(
      calls.filter((c) => c.op === 'set:globalCompositeOperation').map((c) => c.args[0]),
    ).toContain('multiply')
    // Text draws offscreen in the effect path: one composite on the canvas.
    expect(calls.filter((c) => c.op === 'drawImage')).toHaveLength(1)

    const deaten = doc([{ kind: 'text', clips: [eaten] }])
    expect(composite(deaten).filter((c) => c.op === 'drawImage')).toHaveLength(0)
  })

  it('accumulates motion blur offscreen into one composite', () => {
    const blurred = textClip({
      id: 'blur',
      effects: [{ id: 'fx', type: 'motionBlur', shutter: 360 }],
    })
    const calls = composite(doc([{ kind: 'text', clips: [blurred] }]))
    // One composite on the export canvas; the 8 samples accumulate on scratch.
    expect(calls.filter((c) => c.op === 'drawImage')).toHaveLength(1)
  })

  it('skips unresolvable mattes without crashing', () => {
    const matted = textClip({
      id: 'mat',
      effects: [{ id: 'fx', type: 'trackMatte', trackId: 'ghost' }],
    })
    const calls = composite(doc([{ kind: 'text', clips: [matted] }]))
    expect(calls.filter((c) => c.op === 'drawImage')).toHaveLength(1)
  })

  it('accumulates blur samples additively at 1/N (exact mean with transparency)', () => {
    const blurred = textClip({
      id: 'blur',
      keyframes: {
        positionX: [
          { time: 0, value: 0, interpolation: 'linear' },
          { time: 4, value: 400, interpolation: 'linear' },
        ],
      },
      effects: [{ id: 'fx', type: 'motionBlur', shutter: 360 }],
    })
    resetScratchCalls()
    // Frame 1: the trailing window samples locals around 1, where the ramp
    // runs (at the helper's frame 0 the window would sit on the flat head).
    const ctx = createFake2DContext()
    const d = doc([{ kind: 'text', clips: [blurred] }])
    compositeFrame(
      ctx as unknown as CanvasRenderingContext2D,
      d,
      planVideoFrame(d, 1),
      new Map(),
      1920,
      1080,
      new Map(),
    )
    // Shutter 360 takes 8 samples: the accumulator must sum them at 1/8
    // under 'lighter', mirroring the preview (source-over would leave
    // transparent samples uncounted while counting their weight).
    const accumSurfaces = scratchOps().filter((calls) => {
      const gcos = calls
        .filter((c) => c.op === 'set:globalCompositeOperation')
        .map((c) => c.args[0])
      const alphas = calls.filter((c) => c.op === 'set:globalAlpha').map((c) => c.args[0])
      return gcos.includes('lighter') && alphas.includes(1 / 8)
    })
    expect(accumSurfaces.length).toBeGreaterThan(0)
  })

  it('a single-sample shutter skips the accumulator entirely', () => {
    const blurred = textClip({
      id: 'blur',
      animStatics: { positionX: 100 },
      effects: [{ id: 'fx', type: 'motionBlur', shutter: 30 }],
    })
    resetScratchCalls()
    const calls = composite(doc([{ kind: 'text', clips: [blurred] }]))
    // One sample at t is identical to no blur: the frame still composites
    // once, but no accumulator surface may run.
    const draws = calls.filter((c) => c.op === 'drawImage')
    expect(draws).toHaveLength(1)
    const gcos = scratchOps()
      .flat()
      .filter((c) => c.op === 'set:globalCompositeOperation')
      .map((c) => c.args[0])
    expect(gcos).not.toContain('lighter')
    // The collapsed image is untransformed, so Motion must still land via
    // the transformed blit (a bare 3-arg draw would silently drop positionX).
    expect(draws[0].args).toEqual([expect.any(HTMLCanvasElement), -960, -540, 1920, 1080])
  })

  it('a static multi-sample window skips the accumulator (static bypass)', () => {
    const still = textClip({
      id: 'still',
      animStatics: { positionX: 100 },
      effects: [{ id: 'fx', type: 'motionBlur', shutter: 360 }],
    })
    resetScratchCalls()
    const calls = composite(doc([{ kind: 'text', clips: [still] }]))
    // Static window: identical to the collapsed path, so the frame still
    // composites once but no accumulator surface may run.
    const draws = calls.filter((c) => c.op === 'drawImage')
    expect(draws).toHaveLength(1)
    const gcos = scratchOps()
      .flat()
      .filter((c) => c.op === 'set:globalCompositeOperation')
      .map((c) => c.args[0])
    expect(gcos).not.toContain('lighter')
    // The bypassed image is untransformed, so Motion must still land via
    // the transformed blit.
    expect(draws[0].args).toEqual([expect.any(HTMLCanvasElement), -960, -540, 1920, 1080])
  })

  it('a static outer level over an animated inner level keeps the flag (raw composite)', () => {
    const mixed = textClip({
      id: 'mixed',
      keyframes: {
        positionX: [
          { time: 0, value: 0, interpolation: 'linear' },
          { time: 4, value: 400, interpolation: 'linear' },
        ],
      },
      effects: [
        { id: 'fx0', type: 'motionBlur', shutter: 90 },
        { id: 'fx1', type: 'motionBlur', shutter: 360 },
      ],
    })
    resetScratchCalls()
    // Frame 1, not the helper's frame 0: the trailing windows sample local
    // times around 1, where the ramp runs. At frame 0 the windows would
    // reach negative locals where the curve constant-extends to 0.
    const ctx = createFake2DContext()
    const d = doc([{ kind: 'text', clips: [mixed] }])
    compositeFrame(
      ctx as unknown as CanvasRenderingContext2D,
      d,
      planVideoFrame(d, 1),
      new Map(),
      1920,
      1080,
      new Map(),
    )
    const calls = ctx.calls as { op: string; args: unknown[] }[]
    // The animated inner level accumulates, so the flag stays true and the
    // frame composites the baked accumulation raw (no Motion blit).
    const draws = calls.filter((c) => c.op === 'drawImage')
    expect(draws).toHaveLength(1)
    const gcos = scratchOps()
      .flat()
      .filter((c) => c.op === 'set:globalCompositeOperation')
      .map((c) => c.args[0])
    expect(gcos).toContain('lighter')
    expect(draws[0].args).toEqual([expect.any(HTMLCanvasElement), 0, 0])
  })

  it('a feathered wipe composites the incoming draw with its blend mode', () => {
    const a = textClip({ id: 'a', duration: 4 })
    a.transitionOut = { type: 'wipe', duration: 1, direction: 'left', edge: 'feathered' }
    const b = textClip({ id: 'b', start: 3, duration: 4, blendMode: 'multiply' })
    const d = doc([{ kind: 'text', clips: [a, b] }])
    const ctx = createFake2DContext()
    compositeFrame(
      ctx as unknown as CanvasRenderingContext2D,
      d,
      planVideoFrame(d, 3.5),
      new Map(),
      1920,
      1080,
      new Map(),
    )
    const calls = ctx.calls as { op: string; args: unknown[] }[]
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

  it('a zero-shutter blur takes the direct draw (no scratch round-trip)', () => {
    const inert = textClip({
      id: 'inert',
      effects: [{ id: 'fx', type: 'motionBlur', shutter: 0 }],
    })
    const calls = composite(doc([{ kind: 'text', clips: [inert] }]))
    // Inert stack: text draws directly (fillText), no scratch canvas blit.
    expect(calls.filter((c) => c.op === 'drawImage')).toHaveLength(0)
    expect(calls.filter((c) => c.op === 'fillText').length).toBeGreaterThan(0)
  })
})
