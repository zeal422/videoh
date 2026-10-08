// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { ColorFilterDefs } from '@/components/editor/ColorFilterDefs'
import { ScopesPanel } from '@/components/editor/ScopesPanel'
import { installBrowserMocks, type MockHarness } from './mocks/browser-mocks'
import { useEditorStore } from '../store'
import { createClip, createMediaAsset, createTrack } from '../factories'
import { parseCubeLut } from '../lut'
import type { Clip, Doc, ProjectLut } from '../types'

/**
 * jsdom tests for the 0.6.0 color UI: the scopes meters (bounded downsample,
 * ~10 Hz read, collapsible) and the hidden SVG host that carries the
 * temperature/tint feColorMatrix nodes both render paths reference.
 *
 * jsdom has no rasterizer, so the mocked 2D context records calls instead; the
 * point of these tests is the WIRING (what is read, how often, how big) rather
 * than pixel math, which color.test.ts covers directly.
 */

let h: MockHarness

beforeEach(() => {
  h = installBrowserMocks()
  document.body.innerHTML = ''
  useEditorStore.setState(useEditorStore.getInitialState())
})

afterEach(() => {
  cleanup()
  h.uninstall()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

interface ContextCall {
  op: string
  args: unknown[]
}

/** The fake 2D context the mock harness attaches to every canvas. */
function callsOf(el: HTMLCanvasElement): ContextCall[] {
  return (el as unknown as { __fakeCtx: { calls: ContextCall[] } }).__fakeCtx.calls
}

/** Captures every canvas the component creates (includes the offscreen scratch). */
function captureCanvases(): HTMLCanvasElement[] {
  const created: HTMLCanvasElement[] = []
  const original = document.createElement.bind(document)
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string, opts?: unknown) => {
    const el = original(tag as never, opts as never)
    if (tag === 'canvas') created.push(el as HTMLCanvasElement)
    return el
  }) as unknown as typeof document.createElement)
  return created
}

function Toggler({ canvas }: { canvas: HTMLCanvasElement }) {
  const [open, setOpen] = useState(false)
  return <ScopesPanel canvas={canvas} open={open} onToggle={() => setOpen((v) => !v)} />
}

function docWith(clip: Clip): Doc {
  return {
    project: {
      id: 'p',
      name: 'n',
      width: 1920,
      height: 1080,
      fps: 30,
      tracks: [createTrack('video', 1, { id: 'track_1', clips: [clip] })],
    },
    media: [createMediaAsset({ id: 'm1', kind: 'video', duration: 10, name: 'a.mp4' })],
  }
}

describe('ScopesPanel', () => {
  it('stays collapsed until toggled, then shows both meters', () => {
    const monitor = document.createElement('canvas')
    render(<Toggler canvas={monitor} />)
    expect(screen.queryByTestId('scopes-meters')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('scopes-toggle'))
    expect(screen.getByTestId('scopes-meters')).toBeInTheDocument()
    expect(screen.getByTestId('scopes-luma')).toBeInTheDocument()
    expect(screen.getByTestId('scopes-balance')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('scopes-toggle'))
    expect(screen.queryByTestId('scopes-meters')).not.toBeInTheDocument()
  })

  it('mounts the waveform and vectorscope meters and paints them from the sample', () => {
    vi.useFakeTimers()
    const monitor = document.createElement('canvas')
    monitor.width = 1920
    monitor.height = 1080
    render(<Toggler canvas={monitor} />)
    expect(screen.queryByTestId('scopes-waveform')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('scopes-toggle'))
    expect(screen.getByTestId('scopes-waveform')).toBeInTheDocument()
    expect(screen.getByTestId('scopes-vectorscope')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(150)
    })
    // jsdom has no rasterizer, so the draw is proven by the ops recorded on the
    // meter canvases. Both drawers stick to fillRect, which the mocked 2D op
    // list already records (an unrecorded method would silently no-op).
    const wave = callsOf(screen.getByTestId('scopes-waveform') as HTMLCanvasElement)
    expect(wave.filter((c) => c.op === 'fillRect').length).toBeGreaterThan(0)
    const vector = callsOf(screen.getByTestId('scopes-vectorscope') as HTMLCanvasElement)
    expect(vector.filter((c) => c.op === 'fillRect').length).toBeGreaterThan(0)
  })

  it('tiles the waveform canvas edge to edge for a sample narrower than the canvas', () => {
    // A square project downsamples to 144 columns (144x144) while the waveform
    // canvas is 256 px wide. Integer bar widths printed 144 one-pixel bars and
    // left 112 px blank on the right; the columns must span the full width.
    vi.useFakeTimers()
    const monitor = document.createElement('canvas')
    monitor.width = 1080
    monitor.height = 1080
    render(<Toggler canvas={monitor} />)
    fireEvent.click(screen.getByTestId('scopes-toggle'))
    act(() => {
      vi.advanceTimersByTime(150)
    })

    const wave = screen.getByTestId('scopes-waveform') as HTMLCanvasElement
    const fills = callsOf(wave).filter((c) => c.op === 'fillRect')
    expect(fills.length).toBeGreaterThan(0)
    // The trace starts at the left edge and its rightmost painted edge reaches
    // the canvas edge, so no strip is left unpainted.
    const left = Math.min(...fills.map((c) => Number(c.args[0])))
    const right = Math.max(...fills.map((c) => Number(c.args[0]) + Number(c.args[2])))
    expect(left).toBeLessThanOrEqual(0.5)
    expect(right).toBeGreaterThanOrEqual(255.5)
  })

  it('reads a bounded downsample of the monitor at ~10 Hz, not per frame', () => {
    vi.useFakeTimers()
    const created = captureCanvases()
    const monitor = document.createElement('canvas')
    monitor.width = 1920
    monitor.height = 1080
    render(<Toggler canvas={monitor} />)
    fireEvent.click(screen.getByTestId('scopes-toggle'))

    // The offscreen scratch (created by the component, not by the test).
    const scratch = created.find((c) => c !== monitor)
    expect(scratch).toBeDefined()
    expect([scratch!.width, scratch!.height]).toEqual([256, 144])

    act(() => {
      vi.advanceTimersByTime(1000)
    })
    const calls = callsOf(scratch!)
    const reads = calls.filter((c) => c.op === 'getImageData')
    // ~10 Hz over one second: never the 60 per-frame reads a rAF loop would do.
    expect(reads.length).toBeGreaterThanOrEqual(9)
    expect(reads.length).toBeLessThanOrEqual(11)
    // Each read draws the monitor down into the scratch, not the full frame.
    const drawn = calls.filter((c) => c.op === 'drawImage')
    expect(drawn).toHaveLength(reads.length)
    expect(drawn[0].args.slice(1)).toEqual([0, 0, 256, 144])

    // The meters are painted from the sampled buffer.
    expect(callsOf(screen.getByTestId('scopes-luma') as HTMLCanvasElement).length).toBeGreaterThan(
      0,
    )
    expect(
      callsOf(screen.getByTestId('scopes-balance') as HTMLCanvasElement).length,
    ).toBeGreaterThan(0)
  })

  it('reports unavailable instead of throwing when the canvas cannot be sampled', () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const monitor = document.createElement('canvas')
    render(<Toggler canvas={monitor} />)
    fireEvent.click(screen.getByTestId('scopes-toggle'))

    // The read throws the way a tainted canvas does. A context that throws on
    // read is enough: the throw happens before any meter is painted.
    const original = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = (() => ({
      drawImage: () => undefined,
      getImageData: () => {
        throw new Error('tainted')
      },
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext
    try {
      act(() => {
        vi.advanceTimersByTime(200)
      })
      expect(screen.getByText(/Meters unavailable/)).toBeInTheDocument()
      expect(warn).toHaveBeenCalled()
    } finally {
      // Restore even when an assertion fails: a leaked stub breaks every later
      // canvas-context creation in the file (the meters would read nothing).
      HTMLCanvasElement.prototype.getContext = original
    }
  })

  it('recovers from unavailable: closing the scopes resets the taint state', () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const monitor = document.createElement('canvas')
    render(<Toggler canvas={monitor} />)
    const toggle = () => fireEvent.click(screen.getByTestId('scopes-toggle'))
    toggle() // open: the interval only runs while the scopes are open

    // Recovery contract: a canvas that failed to sample once (tainted by
    // unlinked media) must not keep the scopes disabled forever. Closing the
    // scopes resets the failure, and reopening re-arms sampling, because the
    // project under the panel may have changed (relink, reload).

    // Phase 1: the canvas is tainted (the same throwing stub as above:
    // a context whose getImageData throws, the shape a tainted canvas has),
    // so the meters hide.
    const original = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = (() => ({
      drawImage: () => undefined,
      getImageData: () => {
        throw new Error('tainted')
      },
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext
    try {
      act(() => {
        vi.advanceTimersByTime(250)
      })
      expect(screen.getByText(/Meters unavailable/)).toBeInTheDocument()
    } finally {
      // Restore even when an assertion fails, like the two neighbouring tests:
      // a leaked stub breaks every later canvas-context creation in the file.
      HTMLCanvasElement.prototype.getContext = original
    }

    // Phase 2: close (the failure state resets), reopen, canvas is healthy.
    toggle()
    expect(screen.queryByText(/Meters unavailable/)).not.toBeInTheDocument()
    toggle()
    act(() => {
      vi.advanceTimersByTime(150)
    })
    // Healthy sampling: the meters painted and no warning fired again.
    expect(callsOf(screen.getByTestId('scopes-luma') as HTMLCanvasElement).length).toBeGreaterThan(
      0,
    )
    expect(warn).toHaveBeenCalledTimes(1) // the phase-1 warning only
  })

  it('recovers while open when the canvas can be sampled again', () => {
    // A resize resets a canvas's origin-clean flag, so the monitor can become
    // readable again with the panel still open. The interval has to keep
    // running while the banner is up and clear the latch on its own: keying the
    // effect on `unavailable` left the meters dead until a close/reopen cycle.
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const monitor = document.createElement('canvas')
    render(<Toggler canvas={monitor} />)
    fireEvent.click(screen.getByTestId('scopes-toggle'))

    const original = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = (() => ({
      drawImage: () => undefined,
      getImageData: () => {
        throw new Error('tainted')
      },
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext
    try {
      act(() => {
        vi.advanceTimersByTime(250)
      })
      expect(screen.getByText(/Meters unavailable/)).toBeInTheDocument()
    } finally {
      HTMLCanvasElement.prototype.getContext = original
    }

    // No close, no reopen, no canvas swap: the next tick samples the readable
    // canvas, clears the banner and paints the meters.
    act(() => {
      vi.advanceTimersByTime(250)
    })
    expect(screen.queryByText(/Meters unavailable/)).not.toBeInTheDocument()
    expect(callsOf(screen.getByTestId('scopes-luma') as HTMLCanvasElement).length).toBeGreaterThan(
      0,
    )
    expect(warn).toHaveBeenCalledTimes(1) // the latch warns once, not per tick
  })

  it('recovers from unavailable: swapping the canvas resets the taint state while open', () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const tainted = document.createElement('canvas')
    const { rerender } = render(<Toggler canvas={tainted} />)
    fireEvent.click(screen.getByTestId('scopes-toggle'))

    // The first canvas is tainted: the meters hide while the panel stays open.
    const original = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = (() => ({
      drawImage: () => undefined,
      getImageData: () => {
        throw new Error('tainted')
      },
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext
    try {
      act(() => {
        vi.advanceTimersByTime(250)
      })
      expect(screen.getByText(/Meters unavailable/)).toBeInTheDocument()
    } finally {
      HTMLCanvasElement.prototype.getContext = original
    }

    // A healthy canvas replaces the tainted one (a parent may swap the monitor
    // node) while the panel REMAINS open: the taint verdict about the old
    // element must not keep the new one unsampled.
    const healthy = document.createElement('canvas')
    rerender(<Toggler canvas={healthy} />)
    expect(screen.queryByText(/Meters unavailable/)).not.toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(250)
    })
    // The new canvas is sampled and the meters repaint from it.
    expect(callsOf(screen.getByTestId('scopes-luma') as HTMLCanvasElement).length).toBeGreaterThan(
      0,
    )
    expect(warn).toHaveBeenCalledTimes(1) // the tainted-canvas warning only
  })
})

describe('ColorFilterDefs with LUT shapers', () => {
  const shaper = () => parseCubeLut('LUT_1D_SIZE 2\n0 0 0\n1 1 1', { id: 'shaper' })
  const cube = () =>
    parseCubeLut(
      [
        'LUT_3D_SIZE 2',
        '0 0 0',
        '1 0 0',
        '0 1 0',
        '1 1 0',
        '0 0 1',
        '1 0 1',
        '0 1 1',
        '1 1 1',
      ].join('\n'),
      { id: 'cube' },
    )
  const docWithLuts = (clip: Clip, luts: ProjectLut[]): Doc => {
    const doc = docWith(clip)
    doc.project.luts = luts
    return doc
  }

  it('mounts one shaper node per unique 1D LUT, shared by every clip using it', () => {
    useEditorStore.setState({
      doc: docWithLuts(createClip({ id: 'c1', mediaId: 'm1', duration: 4, lutId: 'shaper' }), [
        shaper(),
      ]),
    })
    const { container, rerender } = render(<ColorFilterDefs />)
    const filters = container.querySelectorAll('filter')
    expect(filters).toHaveLength(1)
    expect(filters[0].id).toBe('lut-shaper')
    const funcs = filters[0].querySelectorAll('feFuncR, feFuncG, feFuncB')
    expect(funcs).toHaveLength(3)
    for (const fn of funcs) {
      expect(fn.getAttribute('type')).toBe('table')
      expect((fn.getAttribute('tableValues') ?? '').split(' ')).toHaveLength(2)
    }

    // A second clip on the same LUT shares the node: a 1D table is keyed by the
    // library entry, not by the clip, so a big tableValues is never mounted twice.
    const shared = docWithLuts(
      createClip({ id: 'c1', mediaId: 'm1', duration: 4, lutId: 'shaper' }),
      [shaper()],
    )
    shared.project.tracks[0].clips.push(
      createClip({ id: 'c2', mediaId: 'm1', start: 4, duration: 4, lutId: 'shaper' }),
    )
    useEditorStore.setState({ doc: shared })
    rerender(<ColorFilterDefs />)
    expect(container.querySelectorAll('filter')).toHaveLength(1)
  })

  it('mounts nothing for a 3D cube (its pixel pass rides no SVG node)', () => {
    useEditorStore.setState({
      doc: docWithLuts(createClip({ id: 'c1', mediaId: 'm1', duration: 4, lutId: 'cube' }), [
        cube(),
      ]),
    })
    const { container } = render(<ColorFilterDefs />)
    expect(container.querySelector('svg')).toBeNull()
  })

  it('keeps the clip matrix node beside the shaper node', () => {
    useEditorStore.setState({
      doc: docWithLuts(
        createClip({
          id: 'c1',
          mediaId: 'm1',
          duration: 4,
          lutId: 'shaper',
          temperature: 40,
        }),
        [shaper()],
      ),
    })
    const { container } = render(<ColorFilterDefs />)
    const ids = [...container.querySelectorAll('filter')].map((f) => f.id)
    expect(ids.sort()).toEqual(['clip-grade-c1', 'lut-shaper'])
  })
})

describe('ColorFilterDefs', () => {
  it('mounts one filter per graded clip and none for neutral clips', () => {
    useEditorStore.setState({ doc: docWith(createClip({ id: 'c1', mediaId: 'm1', duration: 4 })) })
    const { container, rerender } = render(<ColorFilterDefs />)
    expect(container.querySelector('svg')).toBeNull()

    useEditorStore.setState({
      doc: docWith(
        createClip({ id: 'c1', mediaId: 'm1', duration: 4, temperature: 60, tint: -30 }),
      ),
    })
    rerender(<ColorFilterDefs />)
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg!.getAttribute('aria-hidden')).toBe('true')

    const filter = container.querySelector('filter')!
    expect(filter.id).toBe('clip-grade-c1')
    // sRGB keeps the gains on the canvas's gamma, so export matches preview
    // (React lowercases SVG attribute names in the DOM).
    expect(filter.outerHTML).toMatch(/color-interpolation-filters="sRGB"/)
    const values = container.querySelector('feColorMatrix')!.getAttribute('values') ?? ''
    expect(values.split(' ')).toHaveLength(20)
  })
})

/**
 * jsdom cannot prove the browser ever mounts these (the shell is client-only),
 * so the mount points are locked against the source, the way theme.test.ts
 * locks the shell's other global hosts.
 */
describe('color UI mount points (static locks)', () => {
  const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

  it('the editor shell carries the hidden SVG grade host', () => {
    expect(read('src/components/editor/EditorShell.tsx')).toMatch(/<ColorFilterDefs \/>/)
  })

  it('the preview panel hosts the scopes between monitor and transport', () => {
    const panel = read('src/components/editor/PreviewPanel.tsx')
    // Local state, default OFF, reading the monitor canvas (no workspace panel).
    expect(panel).toMatch(/const \[scopesOpen, setScopesOpen\] = useState\(false\)/)
    expect(panel).toMatch(/<ScopesPanel canvas=\{monitor\} open=\{scopesOpen\}/)
  })
})
