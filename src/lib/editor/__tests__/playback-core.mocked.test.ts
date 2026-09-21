// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PlaybackCore } from '../playback/core'
import {
  FakeAudioContext,
  FakeBiquadFilterNode,
  FakeGainNode,
  FakeStereoPannerNode,
  installBrowserMocks,
  installRAFPump,
  type MockHarness,
} from './mocks/browser-mocks'
import {
  createClip,
  createDoc,
  createMediaAsset,
  createTextClip,
  createTrack,
  uid,
} from '../factories'
import type { Clip, Doc, MediaAsset } from '../types'

/**
 * PlaybackCore against a fully mocked browser ("B" side of the A/B battery).
 * The fake AudioContext clock drives every frame, so timing, drift
 * correction, gain math and end-of-timeline behavior are deterministic.
 */

let h: MockHarness

beforeEach(() => {
  h = installBrowserMocks()
  // jsdom keeps ONE document per file — drop pooled elements from prior tests.
  document.body.innerHTML = ''
})

afterEach(() => {
  h.uninstall()
})

function makeDoc(): { doc: Doc; asset: MediaAsset } {
  const doc = createDoc()
  const asset = createMediaAsset({
    kind: 'video',
    name: 'v.mp4',
    duration: 10,
    width: 640,
    height: 360,
    url: 'blob:video',
  })
  doc.media.push(asset)
  return { doc, asset }
}

function addVideoClip(
  doc: Doc,
  partial: Partial<Clip> & { mediaId: string; start: number; duration: number },
): Clip {
  const clip = createClip(partial)
  doc.project.tracks[0].clips.push(clip)
  return clip
}

/** A fake video element the compositor will actually draw (readyState ≥ 2). */
function primeVideoElement(el: HTMLVideoElement): void {
  Object.defineProperty(el, 'readyState', { configurable: true, value: 2 })
  Object.defineProperty(el, 'videoWidth', { configurable: true, value: 640 })
  Object.defineProperty(el, 'videoHeight', { configurable: true, value: 360 })
}

function makeCore(doc: Doc, hooks: { onEnd?: () => void } = {}) {
  const canvas = document.createElement('canvas')
  const frames: number[] = []
  const core = new PlaybackCore({
    canvas,
    getDoc: () => doc,
    onFrame: (t) => frames.push(t),
    onPlayingChange: () => undefined,
    onEnd: hooks.onEnd,
  })
  const ctx = canvas.getContext('2d') as unknown as { calls: { op: string; args: unknown[] }[] }
  return { core, canvas, frames, ctx }
}

/** Master gain: the only node feeding the destination (reverse edge). */
function masterGainOf(ctx: FakeAudioContext): FakeGainNode {
  const master = ctx.destination.inputs[0]
  if (!(master instanceof FakeGainNode)) throw new Error('audio graph missing master gain')
  return master
}

const closeTo = (value: number) => (actual: unknown) =>
  typeof actual === 'number' && Math.abs(actual - value) < 1e-5

describe('PlaybackCore (mocked browser)', () => {
  it('sizes the canvas to the project resolution on construction', () => {
    const { doc } = makeDoc()
    const { canvas } = makeCore(doc)
    expect(canvas.width).toBe(1920)
    expect(canvas.height).toBe(1080)
  })

  it('prepare() builds the audio graph: master gain → destination + stream dest', async () => {
    const { doc } = makeDoc()
    const { core } = makeCore(doc)
    await core.prepare()

    const ctx = h.lastAudioContext()
    const master = masterGainOf(ctx)
    expect(master.gain.value).toBe(1)
    expect(master.connections).toContain(ctx.destination)
    // The stream destination (used by the exporter) is fed from the master too.
    expect(master.connections.length).toBeGreaterThanOrEqual(2)
    expect(core.audioStream?.getAudioTracks().length).toBe(1)
  })

  it('rebuilds a clip audio chain when EQ, compressor or pan change', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { mediaId: asset.id, start: 0, duration: 4, inPoint: 0 })
    const { core } = makeCore(doc)
    await core.play()
    await h.pump.pump(1)

    const ctx = h.lastAudioContext()
    // Flat shaping: only the per-clip gain node exists.
    expect(ctx.shapingNodes).toHaveLength(0)

    // EQ arrives after the graph is live: the chain is rebuilt with it.
    doc.project.tracks[0].clips[0].eq = { low: 6, mid: 0, high: 0 }
    await h.pump.pump(1)
    expect(ctx.shapingNodes).toHaveLength(3)
    const low = ctx.shapingNodes[0] as FakeBiquadFilterNode
    expect(low.type).toBe('lowshelf')
    expect(low.gain.value).toBe(6)

    // Moving a band rebuilds again: the old biquads baked the old value in.
    doc.project.tracks[0].clips[0].eq = { low: -4, mid: 0, high: 0 }
    await h.pump.pump(1)
    expect(ctx.shapingNodes).toHaveLength(6)
    expect((ctx.shapingNodes[3] as FakeBiquadFilterNode).gain.value).toBe(-4)

    // Pan and the compressor join the chain on the next shaping change.
    doc.project.tracks[0].clips[0].compressor = true
    doc.project.tracks[0].clips[0].pan = 0.5
    await h.pump.pump(1)
    expect(ctx.shapingNodes).toHaveLength(11)
    expect(ctx.shapingNodes[9].constructor.name).toBe('FakeDynamicsCompressorNode')
    expect((ctx.shapingNodes[10] as FakeStereoPannerNode).pan.value).toBe(0.5)
  })

  it('applies a speed change to an element that is already playing', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { mediaId: asset.id, start: 0, duration: 4, inPoint: 0 })
    const { core } = makeCore(doc)
    await core.play()
    await h.pump.pump(1)

    const el = document.querySelector('video') as HTMLVideoElement
    expect(el.paused).toBe(false)
    expect(el.playbackRate).toBe(1)

    doc.project.tracks[0].clips[0].speed = 2
    await h.pump.pump(1)
    expect(el.playbackRate).toBe(2)

    // Reversed clips stay stepped: no rate on the parked element beyond the clamp.
    doc.project.tracks[0].clips[0].reverse = true
    await h.pump.pump(1)
    expect(el.paused).toBe(true)
  })

  it('leaves the chain alone when only the gain value changes', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { mediaId: asset.id, start: 0, duration: 4, inPoint: 0 })
    const { core } = makeCore(doc)
    await core.play()
    await h.pump.pump(1)

    const ctx = h.lastAudioContext()
    doc.project.tracks[0].clips[0].gain = 0.5
    await h.pump.pump(2)
    expect(ctx.shapingNodes).toHaveLength(0)
    const clipGain = masterGainOf(ctx).inputs[0] as FakeGainNode
    expect(clipGain.gain.last?.value).toBeCloseTo(0.5, 5)
  })

  it('play() on an empty timeline never starts', async () => {
    const { doc } = makeDoc()
    doc.project.tracks[0].clips.length = 0
    const { core } = makeCore(doc)
    await core.play()
    expect(core.isPlaying).toBe(false)
    expect(h.pump.queued()).toBe(0)
  })

  it('play() at the end of the timeline restarts from zero', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { mediaId: asset.id, start: 0, duration: 4, inPoint: 0 })
    const { core } = makeCore(doc)
    core.seek(4)
    await core.play(4)
    expect(core.currentTime).toBeCloseTo(0, 5)
    expect(core.isPlaying).toBe(true)
  })

  it('play() starts elements at inPoint, advances with the audio clock and corrects drift', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { mediaId: asset.id, start: 0, duration: 4, inPoint: 0.5 })
    const { core, frames } = makeCore(doc)
    await core.play()

    expect(core.isPlaying).toBe(true)
    const el = document.querySelector('video') as HTMLVideoElement
    expect(el.src).toContain('blob:video')
    expect(el.currentTime).toBeCloseTo(0.5, 5) // positioned at inPoint

    // One second of audio-clock time: the element "drifted" (stayed at 0.5),
    // so the >120ms drift guard must resync it to the expected source time.
    h.lastAudioContext().currentTime += 1
    await h.pump.pump(1)
    expect(core.currentTime).toBeCloseTo(1, 5)
    expect(frames.at(-1)).toBeCloseTo(1, 5)
    expect(el.currentTime).toBeCloseTo(1.5, 5) // inPoint 0.5 + 1s

    // Small drift inside the 120ms threshold must NOT be corrected.
    el.currentTime = 1.45
    await h.pump.pump(1)
    expect(el.currentTime).toBeCloseTo(1.45, 5)
  })

  it('routes element audio through per-clip gains and applies gain × mute', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { mediaId: asset.id, start: 0, duration: 4, inPoint: 0, gain: 0.5 })
    const { core } = makeCore(doc)
    await core.play()
    await h.pump.pump(1)

    const master = masterGainOf(h.lastAudioContext())
    const clipGain = master.inputs[0] as FakeGainNode
    expect(clipGain).toBeInstanceOf(FakeGainNode)
    expect(clipGain.gain.last?.value).toBeCloseTo(0.5, 5)

    // Clip mute → 0
    doc.project.tracks[0].clips[0].muted = true
    await h.pump.pump(1)
    expect((master.inputs[0] as FakeGainNode).gain.last?.value).toBe(0)
    doc.project.tracks[0].clips[0].muted = false

    // Track mute → 0
    doc.project.tracks[0].muted = true
    await h.pump.pump(1)
    expect((master.inputs[0] as FakeGainNode).gain.last?.value).toBe(0)
    void core
  })

  it('shadows the video part of an A/V pair — the audio twin is the sole carrier', async () => {
    const { doc, asset } = makeDoc()
    // Video part linked to an audio-only twin on the audio track.
    addVideoClip(doc, { mediaId: asset.id, start: 0, duration: 4, inPoint: 0, linkId: 'L1' })
    doc.project.tracks[1].clips.push(
      createClip({
        mediaId: asset.id,
        start: 0,
        duration: 4,
        inPoint: 0,
        linkId: 'L1',
        audioOnly: true,
        gain: 0.8,
      }),
    )
    const { core } = makeCore(doc)
    await core.play()
    await h.pump.pump(1)

    const master = masterGainOf(h.lastAudioContext())
    const gains = master.inputs.map((n) => (n as FakeGainNode).gain.last?.value)
    expect(gains).toHaveLength(2)
    // Video part: silent (its embedded audio would double-play against the twin).
    expect(gains.some((g) => g === 0)).toBe(true)
    // Twin: carries the pair's sound at its own gain.
    expect(gains.some((g) => Math.abs((g ?? 1) - 0.8) < 1e-5)).toBe(true)

    // Unlink (remove the twin) → the video part's embedded audio unmasks.
    // (The stale twin GainNode stays connected with its last value — only
    // the video part's node is expected to move to unity.)
    doc.project.tracks[1].clips.length = 0
    await h.pump.pump(1)
    expect((master.inputs[0] as FakeGainNode).gain.last?.value).toBeCloseTo(1, 5)
    void core
  })

  it('ramps crossfade gains across the transition span', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, {
      mediaId: asset.id,
      start: 0,
      duration: 4,
      inPoint: 0,
      transitionOut: { type: 'crossfade', duration: 1 },
    })
    addVideoClip(doc, { mediaId: asset.id, start: 3, duration: 4, inPoint: 0 })
    const { core } = makeCore(doc)
    await core.play()

    h.lastAudioContext().currentTime = 3.25 // p = 0.25 through the fade
    await h.pump.pump(1)

    const master = masterGainOf(h.lastAudioContext())
    const gains = master.inputs.map((n) => (n as FakeGainNode).gain.last?.value)
    expect(gains).toHaveLength(2)
    expect(gains.some(closeTo(0.75))).toBe(true)
    expect(gains.some(closeTo(0.25))).toBe(true)
    void core
  })

  it('stops at the end of the timeline and fires onEnd exactly once', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { mediaId: asset.id, start: 0, duration: 4, inPoint: 0 })
    let ended = 0
    const { core, frames } = makeCore(doc, { onEnd: () => ended++ })
    await core.play()

    h.lastAudioContext().currentTime = 100
    await h.pump.pump(2)
    expect(core.isPlaying).toBe(false)
    expect(core.currentTime).toBe(4)
    expect(frames.at(-1)).toBe(4)
    expect(ended).toBe(1)
    const el = document.querySelector('video') as HTMLVideoElement
    expect(el.paused).toBe(true)
  })

  it('seek while paused repositions the element and renders a still frame', () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { mediaId: asset.id, start: 0, duration: 4, inPoint: 0.5 })
    const { core, ctx } = makeCore(doc)
    core.seek(2)

    const el = document.querySelector('video') as HTMLVideoElement
    expect(el.currentTime).toBeCloseTo(2.5, 5)
    // The element becomes decodable; the registered one-shot `seeked` listener
    // redraws the still frame with the frame now available.
    primeVideoElement(el)
    el.dispatchEvent(new Event('seeked'))
    expect(ctx.calls.some((c) => c.op === 'drawImage')).toBe(true)
  })

  it('seek clamps to the timeline bounds', () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { mediaId: asset.id, start: 0, duration: 4, inPoint: 0 })
    const { core, frames } = makeCore(doc)
    core.seek(100)
    expect(core.currentTime).toBe(4)
    core.seek(-5)
    expect(core.currentTime).toBe(0)
    expect(frames.at(-1)).toBe(0)
  })

  it('stepFrames pauses and moves the playhead by whole frames', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { mediaId: asset.id, start: 0, duration: 4, inPoint: 0 })
    const { core, frames } = makeCore(doc)
    await core.play()
    core.stepFrames(1) // paused; playhead at 0 → 1/30
    expect(core.isPlaying).toBe(false)
    expect(core.currentTime).toBeCloseTo(1 / 30, 5)
    core.stepFrames(2)
    expect(core.currentTime).toBeCloseTo(3 / 30, 5)
    expect(frames.at(-1)).toBeCloseTo(3 / 30, 5)
  })

  it('setMasterVolume clamps and schedules on the master gain', async () => {
    const { doc } = makeDoc()
    const { core } = makeCore(doc)
    await core.prepare()
    core.setMasterVolume(0.5)
    expect(masterGainOf(h.lastAudioContext()).gain.last?.value).toBe(0.5)
    core.setMasterVolume(42)
    expect(masterGainOf(h.lastAudioContext()).gain.last?.value).toBe(1)
    core.setMasterVolume(-1)
    expect(masterGainOf(h.lastAudioContext()).gain.last?.value).toBe(0)
  })

  it('falls back to element volume when Web Audio is unavailable', async () => {
    h.uninstall() // drop the AudioContext stub; keep a manual rAF pump
    vi.stubGlobal('AudioContext', undefined)
    const raf = installRAFPump()

    const { doc, asset } = makeDoc()
    addVideoClip(doc, { mediaId: asset.id, start: 0, duration: 4, inPoint: 0, gain: 0.5 })
    const { core } = makeCore(doc)
    await core.play()

    expect(core.audioStream).toBeNull()
    await raf.pump(1)
    const el = document.querySelector('video') as HTMLVideoElement
    expect(el.volume).toBeCloseTo(0.5, 5)
  })

  it('dispose() closes the audio context and removes pooled elements from the DOM', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { mediaId: asset.id, start: 0, duration: 4, inPoint: 0 })
    const { core } = makeCore(doc)
    await core.play()
    expect(document.querySelectorAll('video').length).toBe(1)

    core.dispose()
    expect(h.lastAudioContext().state).toBe('closed')
    expect(document.querySelectorAll('video').length).toBe(0)
    expect(core.isPlaying).toBe(false)
  })

  it('syncResolution follows changed project settings', () => {
    const { doc } = makeDoc()
    const { core, canvas } = makeCore(doc)
    doc.project.width = 960
    doc.project.height = 540
    core.syncResolution()
    expect(canvas.width).toBe(960)
    expect(canvas.height).toBe(540)
  })

  it('ignores text tracks when syncing media (no elements, text still renders)', async () => {
    const { doc } = makeDoc()
    doc.project.tracks.unshift(createTrack('text', 1, { id: uid('t-text') }))
    doc.project.tracks[0].clips.push(
      createTextClip({ id: uid('clip'), text: 'Hi', start: 0, duration: 2 }),
    )
    const { core, ctx } = makeCore(doc)
    await core.play()
    await h.pump.pump(1)

    expect(document.querySelectorAll('video, audio').length).toBe(0)
    expect(ctx.calls.some((c) => c.op === 'fillText' && c.args[0] === 'Hi')).toBe(true)
    void core
  })
})
