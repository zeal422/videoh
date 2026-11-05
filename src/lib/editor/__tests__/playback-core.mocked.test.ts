// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PlaybackCore, SCRUB_FALLBACK_TIMEOUT_MS, type MediaErrorInfo } from '../playback/core'
import type {
  ScrubFrameRequest,
  ScrubFrameResult,
  ScrubFrameSource,
} from '../playback/scrub-source'
import {
  FakeAudioContext,
  FakeBiquadFilterNode,
  FakeGainNode,
  FakeStereoPannerNode,
  installBrowserMocks,
  installRAFPump,
  presentFrame,
  setMediaError,
  type MockHarness,
} from './mocks/browser-mocks'
import {
  clampSourceTime,
  createClip,
  createDoc,
  createMediaAsset,
  createTextClip,
  createTrack,
  sourceTimeAt,
  uid,
} from '../factories'
import { planVideoFrame } from '../export/offline'
import { DENOISE_HIGHPASS_HZ, DENOISE_HISS_DB } from '../constants'
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

function makeCore(
  doc: Doc,
  hooks: {
    onEnd?: () => void
    onMediaError?: (info: MediaErrorInfo | null, clipId?: string) => void
    onPreviewRecovering?: (recovering: boolean) => void
    nextKeyframe?: (url: string, sourceTime: number) => Promise<number | undefined>
    getProjectEpoch?: () => number
    resolveMediaUrl?: (asset: MediaAsset) => string
    createScrubSource?: () => ScrubFrameSource | null
  } = {},
) {
  const canvas = document.createElement('canvas')
  const frames: number[] = []
  const playingChanges: boolean[] = []
  const core = new PlaybackCore({
    canvas,
    getDoc: () => doc,
    resolveMediaUrl: hooks.resolveMediaUrl,
    getProjectEpoch: hooks.getProjectEpoch,
    nextKeyframe: hooks.nextKeyframe,
    onMediaError: hooks.onMediaError,
    onPreviewRecovering: hooks.onPreviewRecovering,
    createScrubSource: hooks.createScrubSource,
    onFrame: (t) => frames.push(t),
    onPlayingChange: (playing) => playingChanges.push(playing),
    onEnd: hooks.onEnd,
  })
  const ctx = canvas.getContext('2d') as unknown as { calls: { op: string; args: unknown[] }[] }
  return { core, canvas, frames, ctx, playingChanges }
}

/** A scrub source stub; individual tests override the parts they drive. */
function scrubSource(overrides: Partial<ScrubFrameSource> = {}): ScrubFrameSource {
  return {
    hasSink: () => false,
    peek: () => undefined,
    request: vi.fn(),
    releaseClip: vi.fn(),
    releaseAsset: vi.fn(),
    reset: vi.fn(),
    dispose: vi.fn(),
    onFallback: () => () => undefined,
    ...overrides,
  }
}

function renderSpy(core: PlaybackCore) {
  return vi.spyOn(core as unknown as { render: (t: number) => void }, 'render')
}

/** Master gain: the only node feeding the destination (reverse edge). */
function masterGainOf(ctx: FakeAudioContext): FakeGainNode {
  const master = ctx.destination.inputs[0]
  if (!(master instanceof FakeGainNode)) throw new Error('audio graph missing master gain')
  return master
}

const closeTo = (value: number) => (actual: unknown) =>
  typeof actual === 'number' && Math.abs(actual - value) < 1e-5

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * The engine parks an element a hair PAST the read it was asked for
 * (SEEK_FRAME_NUDGE): a read that sits exactly on a source frame's start
 * timestamp has to land inside the frame that starts there, because the
 * exporter's sample lookup resolves that timestamp to that frame (`<=`) while a
 * bare element seek can present the frame before it. Both bounds still catch a
 * position that drifted by a step.
 */
const PARK_NUDGE = 1e-4
function expectParkedOn(el: HTMLVideoElement, read: number, what = 'read'): void {
  expect(el.currentTime, `parked past the ${what}`).toBeGreaterThanOrEqual(read)
  expect(el.currentTime - read, `parked on the ${what}`).toBeLessThanOrEqual(1e-3)
}

/** The source frame index a real element would show at `t` (30 fps fixture): a
 * seek to a frame's exact start can present the frame BEFORE it. */
const shownFrame = (t: number, fps = 30) => Math.floor((t - 1e-9) * fps)

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

    // Noise reduction is a shaping setting too: toggling it rebuilds the chain
    // with the three biquads denoiseFilters builds (denoise.test.ts locks their
    // parameters; this proves the mixer actually wires them in).
    doc.project.tracks[0].clips[0].denoise = true
    await h.pump.pump(1)
    // EQ (3) + denoise (3) + compressor + panner.
    expect(ctx.shapingNodes).toHaveLength(19)
    const denoiseNodes = ctx.shapingNodes.slice(14, 17) as FakeBiquadFilterNode[]
    expect(denoiseNodes.map((n) => n.type)).toEqual(['highpass', 'lowpass', 'peaking'])
    expect(denoiseNodes[0].frequency.value).toBe(DENOISE_HIGHPASS_HZ)
    expect(denoiseNodes[2].gain.value).toBe(DENOISE_HISS_DB)
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

  it('steps a ramped clip: parked element, per-tick seek, no rate from the curve', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { mediaId: asset.id, start: 0, duration: 4, inPoint: 0 })
    const { core } = makeCore(doc)
    await core.play()
    await h.pump.pump(1)

    const el = document.querySelector('video') as HTMLVideoElement
    expect(el.paused).toBe(false)

    doc.project.tracks[0].clips[0].keyframes = {
      timeScale: [
        { time: 0, value: 1 },
        { time: 4, value: 2 },
      ],
    }
    // One second of clock: the ramp's integral (1.125 s of source) is far past
    // the 1/60 seek threshold, so the element must be PARKED and seeked rather
    // than left playing at a rate it cannot follow.
    h.lastAudioContext().currentTime += 1
    await h.pump.pump(1)
    expect(el.paused).toBe(true)
    expect(el.playbackRate).toBe(1) // the curve never reaches playbackRate
    expectParkedOn(el, 1.125, 'ramp read')

    // The next tick seeks again (stepped preview), still parked.
    h.lastAudioContext().currentTime += 1
    await h.pump.pump(1)
    expect(el.paused).toBe(true)
    expectParkedOn(el, 2.5, 'ramp read')
  })

  it('silences both halves of a ramped A/V pair in the preview mixer', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { mediaId: asset.id, start: 0, duration: 4, inPoint: 0, linkId: 'L1' })
    doc.project.tracks[1].clips.push(
      createClip({
        id: 'twin',
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
    const gains = () =>
      masterGainOf(h.lastAudioContext()).inputs.map(
        (n) => (n as FakeGainNode).gain.last?.value ?? 1,
      )
    // Control: the twin is the pair's sole sound carrier.
    expect(gains().some((g) => Math.abs(g - 0.8) < 1e-5)).toBe(true)

    // A ramp on the VIDEO half only. The twin holds no curve of its own, so
    // only the derived link-group predicate can silence it: without that the
    // pair would play at the old rate against a re-timed picture.
    doc.project.tracks[0].clips[0].keyframes = {
      timeScale: [
        { time: 0, value: 1 },
        { time: 4, value: 2 },
      ],
    }
    await h.pump.pump(1)
    expect(gains()).toEqual([0, 0])
  })

  it('silences both halves of an A/V pair under a FLAT non-identity curve', async () => {
    // A flat constant curve is resamplable, so the video half's element can
    // follow it, but its constant then retimes the picture against a twin
    // playing at its own rate: the same desync a ramp causes, and only the
    // derived link-group predicate can catch it. Only the identity value
    // (flat at 1) keeps the pair audible.
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { mediaId: asset.id, start: 0, duration: 4, inPoint: 0, linkId: 'L1' })
    doc.project.tracks[1].clips.push(
      createClip({
        id: 'twin',
        mediaId: asset.id,
        start: 0,
        duration: 4,
        inPoint: 0,
        linkId: 'L1',
        audioOnly: true,
        gain: 0.8,
      }),
    )
    doc.project.tracks[0].clips[0].keyframes = { timeScale: [{ time: 0, value: 0.5 }] }
    const { core } = makeCore(doc)
    await core.play()
    await h.pump.pump(1)
    const gains = () =>
      masterGainOf(h.lastAudioContext()).inputs.map(
        (n) => (n as FakeGainNode).gain.last?.value ?? 1,
      )
    expect(gains()).toEqual([0, 0])
  })

  it('silences both halves of a statically mismatched A/V pair in the preview mixer', async () => {
    // A plain speed difference set by the Speed slider, no curve anywhere: the
    // picture retimes against a twin playing at its own rate. The derived
    // predicate must drop both halves exactly like a curve disagreement.
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { mediaId: asset.id, start: 0, duration: 4, inPoint: 0, linkId: 'L1' })
    doc.project.tracks[1].clips.push(
      createClip({
        id: 'twin',
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
    const gains = () =>
      masterGainOf(h.lastAudioContext()).inputs.map(
        (n) => (n as FakeGainNode).gain.last?.value ?? 1,
      )
    expect(gains().some((g) => Math.abs(g - 0.8) < 1e-5)).toBe(true)

    doc.project.tracks[0].clips[0].speed = 2
    await h.pump.pump(1)
    expect(gains()).toEqual([0, 0])
    void core
  })

  it('keeps both clips audible when a manual link disagrees on speed', async () => {
    // No `audioOnly` carrier means no A/V pair: the shared sound contract does
    // not exist, so a plain speed difference must not mute either member.
    const { doc, asset } = makeDoc()
    addVideoClip(doc, {
      mediaId: asset.id,
      start: 0,
      duration: 4,
      inPoint: 0,
      linkId: 'L1',
      speed: 2,
    })
    addVideoClip(doc, { mediaId: asset.id, start: 0, duration: 4, inPoint: 0, linkId: 'L1' })
    const { core } = makeCore(doc)
    await core.play()
    await h.pump.pump(1)
    const gains = () =>
      masterGainOf(h.lastAudioContext()).inputs.map(
        (n) => (n as FakeGainNode).gain.last?.value ?? 1,
      )
    expect(gains()).toEqual([1, 1])
    void core
  })

  it('keeps a pair silent when the carrier media is gone: the video half never takes over', async () => {
    // Decision: a dead twin still shadows the video half, so the pair stays
    // silent until the asset returns instead of unmasking embedded audio that
    // the export mixer never renders. Locked here against future
    // media-playability changes.
    const { doc, asset } = makeDoc()
    const twinAsset = createMediaAsset({
      kind: 'audio',
      name: 'twin.mp3',
      duration: 4,
      url: 'blob:twin',
    })
    doc.media.push(twinAsset)
    addVideoClip(doc, { mediaId: asset.id, start: 0, duration: 4, inPoint: 0, linkId: 'L1' })
    doc.project.tracks[1].clips.push(
      createClip({
        id: 'twin',
        mediaId: twinAsset.id,
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
    const gains = () => master.inputs.map((n) => (n as FakeGainNode).gain.last?.value ?? 1)
    expect(gains()).toHaveLength(2)
    expect(gains().some((g) => Math.abs(g - 0.8) < 1e-5)).toBe(true)

    doc.media = doc.media.filter((m) => m.id !== twinAsset.id)
    await h.pump.pump(1)
    // The video half stays muted (the twin is still the carrier) and the
    // released twin cannot play: the pair is silent.
    expect(gains()).toEqual([0])
    void core
  })

  it('keeps a manually merged audio clip audible in the preview mixer (not shadowed)', async () => {
    // The shadow hides the video part's EMBEDDED audio. A separate audio clip
    // linked into the pair's group has its own track and keeps its own sound,
    // exactly as the export mix renders it; shadowing it here alone made the
    // two paths disagree.
    const { doc, asset } = makeDoc()
    const song = createMediaAsset({
      kind: 'audio',
      name: 'song.mp3',
      duration: 4,
      url: 'blob:song',
    })
    doc.media.push(song)
    addVideoClip(doc, { mediaId: asset.id, start: 0, duration: 4, inPoint: 0, linkId: 'L1' })
    doc.project.tracks[1].clips.push(
      createClip({
        id: 'twin',
        mediaId: asset.id,
        start: 0,
        duration: 4,
        inPoint: 0,
        linkId: 'L1',
        audioOnly: true,
        gain: 0.8,
      }),
      createClip({
        id: 'song',
        mediaId: song.id,
        start: 0,
        duration: 4,
        inPoint: 0,
        linkId: 'L1',
        gain: 0.5,
      }),
    )
    const { core } = makeCore(doc)
    await core.play()
    await h.pump.pump(1)
    const master = masterGainOf(h.lastAudioContext())
    const gains = master.inputs.map((n) => (n as FakeGainNode).gain.last?.value ?? 1)
    expect(gains).toHaveLength(3)
    // The video half is shadowed; the twin and the merged song both sound.
    expect([...gains].sort()).toEqual([0, 0.5, 0.8])
    void core
  })

  it('keeps a merged kind-audio clip audible: the rate rule binds only A/V members', async () => {
    // Merged group: video + its audio twin + a separately linked song. The
    // twin and the video half agree on 1x, so the shadow silences only the
    // video part. The song is KIND AUDIO: it has no picture to follow, so its
    // own static 2x is renderable by resampling and must not fold into the
    // pair's rate comparison (that fold used to silence the song and the pair
    // alike).
    const { doc, asset } = makeDoc()
    const twinAsset = createMediaAsset({
      kind: 'audio',
      name: 'twin.mp3',
      duration: 4,
      url: 'blob:twin',
    })
    const song = createMediaAsset({
      kind: 'audio',
      name: 'song.mp3',
      duration: 4,
      url: 'blob:song',
    })
    doc.media.push(twinAsset, song)
    addVideoClip(doc, { mediaId: asset.id, start: 0, duration: 4, inPoint: 0, linkId: 'L1' })
    doc.project.tracks[1].clips.push(
      createClip({
        id: 'twin',
        mediaId: twinAsset.id,
        start: 0,
        duration: 4,
        inPoint: 0,
        linkId: 'L1',
        audioOnly: true,
        gain: 0.8,
      }),
      createClip({
        id: 'song',
        mediaId: song.id,
        start: 0,
        duration: 4,
        inPoint: 0,
        linkId: 'L1',
        gain: 0.5,
        speed: 2,
      }),
    )
    const { core } = makeCore(doc)
    await core.play()
    await h.pump.pump(1)
    const master = masterGainOf(h.lastAudioContext())
    const gains = () => master.inputs.map((n) => (n as FakeGainNode).gain.last?.value ?? 1)
    // Control: the video half is shadowed, the twin and the song sound.
    expect([...gains()].sort()).toEqual([0, 0.5, 0.8])

    // The carrier's asset goes missing: its node is released, the video half
    // stays shadowed (a dead twin still holds the pair together), and the
    // song keeps its own sound.
    doc.media = doc.media.filter((m) => m.id !== twinAsset.id)
    await h.pump.pump(1)
    expect(gains()).toHaveLength(2)
    expect([...gains()].sort()).toEqual([0, 0.5])
    void core
  })

  it('plays an identity-seeded curve and resamples a flat 2x (not ramps)', async () => {
    // The diamond's first click seeds [{time, value: 1}]: a flat curve a
    // constant playbackRate follows exactly. It must neither park the element
    // nor drop the audio, or one click would silence the clip for nothing.
    const { doc, asset } = makeDoc()
    const clip = addVideoClip(doc, { mediaId: asset.id, start: 0, duration: 4, inPoint: 0 })
    clip.keyframes = { timeScale: [{ time: 0, value: clip.speed ?? 1 }] }
    const { core } = makeCore(doc)
    await core.play()
    await h.pump.pump(1)
    const el = document.querySelector('video') as HTMLVideoElement
    expect(el.paused).toBe(false) // playing, not parked
    expect(el.playbackRate).toBe(1)
    core.dispose()

    // A flat 2x curve retimes the picture at a constant 2x: resamplable.
    const doc2 = makeDoc().doc
    const clip2 = addVideoClip(doc2, {
      mediaId: doc2.media[0].id,
      start: 0,
      duration: 4,
      inPoint: 0,
    })
    clip2.keyframes = { timeScale: [{ time: 0, value: 2 }] }
    const core2 = new PlaybackCore({
      canvas: document.createElement('canvas'),
      getDoc: () => doc2,
    })
    await core2.play()
    await h.pump.pump(1)
    const el2 = document.querySelector('video') as HTMLVideoElement
    expect(el2.paused).toBe(false)
    expect(el2.playbackRate).toBe(2) // the flat curve's rate drives the element
    core2.dispose()
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
    expectParkedOn(el, 0.5, 'inPoint') // positioned at inPoint

    // One second of audio-clock time: the element "drifted" (stayed at 0.5),
    // so the DRIFT_THRESHOLD (0.4 s) guard must resync it to the expected
    // source time.
    h.lastAudioContext().currentTime += 1
    await h.pump.pump(1)
    expect(core.currentTime).toBeCloseTo(1, 5)
    expect(frames.at(-1)).toBeCloseTo(1, 5)
    expectParkedOn(el, 1.5, 'resynced read') // inPoint 0.5 + 1s

    // Small drift inside the threshold must NOT be corrected.
    el.currentTime = 1.45
    await h.pump.pump(1)
    expect(el.currentTime).toBe(1.45)
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
    expectParkedOn(el, 2.5, 'still read')
    // The element becomes decodable; the registered one-shot `seeked` listener
    // redraws the still frame with the frame now available.
    primeVideoElement(el)
    el.dispatchEvent(new Event('seeked'))
    expect(ctx.calls.some((c) => c.op === 'drawImage')).toBe(true)
  })

  it('a WebCodecs scrub requests a frame and never seeks the video element (0.18.0)', () => {
    const { doc, asset } = makeDoc()
    const clip = addVideoClip(doc, { mediaId: asset.id, start: 0, duration: 4, inPoint: 0.5 })
    const requests: {
      request: ScrubFrameRequest
      onFrame: (result: {
        clipId: string
        frame: CanvasImageSource
        sourceTime: number
        generation: number
      }) => void
    }[] = []
    let cached: CanvasImageSource | undefined
    const source: ScrubFrameSource = {
      hasSink: () => true,
      peek: () => cached,
      request: (request, onFrame) => {
        requests.push({
          request,
          onFrame: (result) => {
            cached = result.frame
            onFrame(result)
          },
        })
      },
      releaseClip: vi.fn(),
      releaseAsset: vi.fn(),
      reset: vi.fn(),
      dispose: vi.fn(),
      onFallback: () => () => undefined,
    }
    const { core, ctx } = makeCore(doc, { createScrubSource: () => source })
    const setSpy = vi.spyOn(HTMLMediaElement.prototype, 'currentTime', 'set')

    core.seek(2)
    expect(requests).toHaveLength(1)
    expect(requests[0].request.clipId).toBe(clip.id)
    expect(requests[0].request.sourceTime).toBeCloseTo(2.5, 5)
    // No element seek on the WebCodecs path.
    expect(setSpy).not.toHaveBeenCalled()

    const frame = document.createElement('canvas')
    frame.width = 640
    frame.height = 360
    requests[0].onFrame({
      clipId: clip.id,
      frame,
      sourceTime: 2.5,
      generation: requests[0].request.generation,
    })
    expect(ctx.calls.some((c) => c.op === 'drawImage' && c.args[0] === frame)).toBe(true)
    setSpy.mockRestore()
  })

  it('keeps the last scrub frame visible while the fallback video seeks (0.18.0)', () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { mediaId: asset.id, start: 0, duration: 4, inPoint: 0 })
    const frame = document.createElement('canvas')
    frame.width = 640
    frame.height = 360
    const source: ScrubFrameSource = {
      hasSink: () => false,
      peek: () => frame,
      request: vi.fn(),
      releaseClip: vi.fn(),
      releaseAsset: vi.fn(),
      reset: vi.fn(),
      dispose: vi.fn(),
      onFallback: () => () => undefined,
    }
    const { core, ctx } = makeCore(doc, { createScrubSource: () => source })
    core.seek(1)
    const video = document.querySelector('video') as HTMLVideoElement
    // The fallback element has not landed yet: the compositor draws the cached
    // WebCodecs frame, so the monitor never clears to black.
    expect(video.readyState).toBeLessThan(2)
    expect(ctx.calls.some((c) => c.op === 'drawImage' && c.args[0] === frame)).toBe(true)
  })

  it('hands the fallback frame back to the video once the seek lands (0.18.0)', () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { mediaId: asset.id, start: 0, duration: 4, inPoint: 0 })
    const frame = document.createElement('canvas')
    frame.width = 640
    frame.height = 360
    const source: ScrubFrameSource = {
      hasSink: () => false,
      peek: () => frame,
      request: vi.fn(),
      releaseClip: vi.fn(),
      releaseAsset: vi.fn(),
      reset: vi.fn(),
      dispose: vi.fn(),
      onFallback: () => () => undefined,
    }
    const { core, ctx } = makeCore(doc, { createScrubSource: () => source })
    core.seek(1)
    const video = document.querySelector('video') as HTMLVideoElement
    primeVideoElement(video)
    const before = ctx.calls.length
    core.refresh(1)
    const drawn = ctx.calls.slice(before).filter((call) => call.op === 'drawImage')
    // The element is ready now, so it is the frame; the cached frame is no
    // longer allowed to mask it.
    expect(drawn.some((call) => call.args[0] === video)).toBe(true)
    expect(drawn.some((call) => call.args[0] === frame)).toBe(false)
  })

  it('does not request scrub frames for an audio-only clip (0.18.0)', () => {
    const { doc, asset } = makeDoc()
    const audioTrack = createTrack('audio', 1)
    doc.project.tracks.push(audioTrack)
    audioTrack.clips.push(
      createClip({
        id: 'clip-audio',
        mediaId: asset.id,
        start: 0,
        duration: 4,
        inPoint: 0,
        audioOnly: true,
      }),
    )
    const source: ScrubFrameSource = {
      hasSink: () => true,
      peek: () => undefined,
      request: vi.fn(),
      releaseClip: vi.fn(),
      releaseAsset: vi.fn(),
      reset: vi.fn(),
      dispose: vi.fn(),
      onFallback: () => () => undefined,
    }
    const { core } = makeCore(doc, { createScrubSource: () => source })
    core.seek(1)
    // The audio element still exists for its decode-error path, but no video
    // frame request is made for a clip that has no picture.
    expect(source.request).not.toHaveBeenCalled()
  })

  it('keeps scrub retries on the neutral notice path and clears it on dispose (0.18.0)', () => {
    vi.useFakeTimers()
    try {
      const { doc, asset } = makeDoc()
      addVideoClip(doc, { mediaId: asset.id, start: 0, duration: 4, inPoint: 0 })
      const recovering: boolean[] = []
      const mediaErrors: (MediaErrorInfo | null)[] = []
      const source: ScrubFrameSource = {
        hasSink: () => false,
        peek: () => undefined,
        request: vi.fn(),
        releaseClip: vi.fn(),
        releaseAsset: vi.fn(),
        reset: vi.fn(),
        dispose: vi.fn(),
        onFallback: () => () => undefined,
      }
      const { core } = makeCore(doc, {
        createScrubSource: () => source,
        onPreviewRecovering: (value) => recovering.push(value),
        onMediaError: (info) => mediaErrors.push(info),
      })
      core.seek(1)
      const el = document.querySelector('video') as HTMLVideoElement
      Object.defineProperty(el, 'error', { configurable: true, value: { code: 3 } })

      // The first draw sees the error while the scrub is in progress and
      // schedules a retry. Two more retries exhaust the budget and raise the
      // neutral notice; none of them may enter damaged-media recovery.
      core.seek(1)
      vi.advanceTimersByTime(SCRUB_FALLBACK_TIMEOUT_MS)
      vi.advanceTimersByTime(SCRUB_FALLBACK_TIMEOUT_MS)
      expect(mediaErrors).toEqual([])
      expect(recovering.at(-1)).toBe(true)

      core.dispose()
      expect(recovering.at(-1)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps an asynchronous fallback error on the neutral retry path (0.18.0)', () => {
    vi.useFakeTimers()
    try {
      const { doc, asset } = makeDoc()
      addVideoClip(doc, { mediaId: asset.id, start: 0, duration: 4, inPoint: 0 })
      const recovering: boolean[] = []
      const mediaErrors: (MediaErrorInfo | null)[] = []
      const source: ScrubFrameSource = {
        hasSink: () => false,
        peek: () => undefined,
        request: vi.fn(),
        releaseClip: vi.fn(),
        releaseAsset: vi.fn(),
        reset: vi.fn(),
        dispose: vi.fn(),
        onFallback: () => () => undefined,
      }
      const { core } = makeCore(doc, {
        createScrubSource: () => source,
        onPreviewRecovering: (value) => recovering.push(value),
        onMediaError: (info) => mediaErrors.push(info),
      })
      core.seek(1)
      const el = document.querySelector('video') as HTMLVideoElement
      // The fallback draw has already returned; the error event lands later,
      // when `scrubInProgress` is false.
      setMediaError(el, 3)
      expect(mediaErrors).toEqual([])
      vi.advanceTimersByTime(SCRUB_FALLBACK_TIMEOUT_MS)
      vi.advanceTimersByTime(SCRUB_FALLBACK_TIMEOUT_MS)
      // The neutral retry budget ran out: the preview notice appears, and no
      // damaged-media report was made.
      expect(mediaErrors).toEqual([])
      expect(recovering.at(-1)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
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

  it('a landing seek redraws the current playhead, not the time its seek was issued for', () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { mediaId: asset.id, start: 0, duration: 4, inPoint: 0 })
    addVideoClip(doc, { mediaId: asset.id, start: 0.515, duration: 1, inPoint: 0 })
    const { core, ctx } = makeCore(doc)

    // Hold the one-shot `seeked` listeners so the first seek's decode can be
    // made to land only after the playhead has moved on, which is what a slow
    // decode does in a real browser.
    const held: { el: HTMLMediaElement; fn: () => void }[] = []
    const realAdd = HTMLMediaElement.prototype.addEventListener
    const spy = vi
      .spyOn(HTMLMediaElement.prototype, 'addEventListener')
      .mockImplementation(function (
        this: HTMLMediaElement,
        type: string,
        fn: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
      ) {
        if (type === 'seeked' && typeof fn === 'function') {
          held.push({ el: this, fn: fn as () => void })
          return
        }
        realAdd.call(this, type, fn, options)
      })

    try {
      core.seek(0.5) // clip A is positioned; its seek listener is held
      const elA = document.querySelector('video') as HTMLVideoElement
      expectParkedOn(elA, 0.5, 'still read')
      expect(held.filter((h) => h.el === elA)).toHaveLength(1)

      // 0.015 s on: inside clip A's 0.02 s dead zone, so no new seek (and so no
      // new listener) is issued for it, while the second clip becomes active.
      // Only the held listener can repaint A, and a captured time would put the
      // stale 0.5 s frame back on screen after this newer seek already drew.
      core.seek(0.515)
      // Both elements have to be decodable for the compositor to draw them, the
      // same readiness gate the app passes in a browser.
      for (const v of document.querySelectorAll('video')) primeVideoElement(v as HTMLVideoElement)
      ctx.calls.length = 0
      held.filter((h) => h.el === elA)[0].fn()
      // Both clips are live at the CURRENT playhead; 0.5 s draws only the first.
      expect(ctx.calls.filter((c) => c.op === 'drawImage')).toHaveLength(2)
    } finally {
      spy.mockRestore()
    }
  })

  it('keeps a stepped slow clip on the frame the read falls in', () => {
    const { doc, asset } = makeDoc()
    const clip = addVideoClip(doc, {
      mediaId: asset.id,
      start: 0,
      duration: 4,
      inPoint: 0,
      speed: 0.25,
    })
    const { core } = makeCore(doc)

    // One output frame at 0.25x moves the source read by 1/120 s, well inside the
    // flat 0.02 s dead zone the still path used to carry. The element has to
    // follow every step, or the monitor holds a frame the export has moved past.
    for (let k = 0; k <= 11; k++) {
      const t = k / 30
      core.seek(t)
      const el = document.querySelector('video') as HTMLVideoElement
      const expected = clampSourceTime(sourceTimeAt(clip, t - clip.start), asset)
      expectParkedOn(el, expected, `output frame ${k}`)
    }

    // The dead zone still exists: a move smaller than half an output frame's
    // read must not restart a decode.
    const el = document.querySelector('video') as HTMLVideoElement
    const at = el.currentTime
    core.seek(11 / 30 + 1 / 300)
    expect(el.currentTime).toBe(at)
    core.dispose()
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

  it('never interrupts a pending seek, so scrub lag cannot starve the element', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { mediaId: asset.id, start: 0, duration: 10, inPoint: 0 })
    const { core } = makeCore(doc)
    await core.play()
    await h.pump.pump(1)

    const el = document.querySelector('video') as HTMLVideoElement
    // Model Chrome's seek: the readback position updates immediately, but the
    // decoded frame arrives later (seeking stays true until the event fires).
    let pending = false
    let seeks = 0
    let resumeClock = 0
    const audio = () => h.lastAudioContext()
    Object.defineProperty(el, 'currentTime', {
      configurable: true,
      get() {
        return pending ? 5 : 5 + (audio().currentTime - resumeClock)
      },
      set() {
        seeks++
        pending = true // a seek has been requested and is now in flight
      },
    })
    Object.defineProperty(el, 'seeking', {
      configurable: true,
      get: () => pending,
    })

    // A scrub while playing: forceSeek to 5s, a >1s jump that a real decoder
    // needs hundreds of ms to land.
    core.seek(5)
    expect(pending).toBe(true)
    const before = seeks

    // Half a second of frames while the seek is in flight: the old code saw
    // drift > threshold every frame (readback already at target, data not
    // moving) and re-seeked, restarting the decode forever: black preview,
    // no audio, playhead advancing.
    audio().currentTime += 0.5
    await h.pump.pump(15)
    expect(seeks).toBe(before)
    expect(el.paused).toBe(false)

    // The seek lands: Chrome fires `seeked` once the frame is decodable.
    pending = false
    resumeClock = audio().currentTime
    el.dispatchEvent(new Event('seeked'))
    await h.pump.pump(6)
    // Live playback resumes: at most a couple of settling corrections (the
    // sim's paused getter keeps reading the pre-seek position for a frame),
    // never a per-frame storm.
    expect(seeks).toBeLessThanOrEqual(before + 3)
    expect(el.paused).toBe(false)
  })

  it('creates no elements for missing (restored) assets', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { mediaId: asset.id, start: 0, duration: 4, inPoint: 0 })
    // What a restored session looks like: the asset survived, its object URL
    // did not.
    asset.missing = true
    asset.url = ''
    const { core } = makeCore(doc)
    await core.play()
    await h.pump.pump(2)

    // The old code built an element with src "" (error 4) and "played" it.
    expect(document.querySelectorAll('video, audio')).toHaveLength(0)
    expect(core.isPlaying).toBe(true)
  })

  it('creates no elements for missing assets when drawing a still frame', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { mediaId: asset.id, start: 0, duration: 4, inPoint: 0 })
    asset.missing = true
    asset.url = ''
    const { core } = makeCore(doc)
    // Scrub while paused: drawStill is the paused-render path.
    core.seek(2)
    await h.pump.pump(2)

    // The old code let drawStill materialize a phantom <video src="">.
    expect(document.querySelectorAll('video, audio')).toHaveLength(0)
  })

  it('relink swaps the element in when a missing asset regains its URL', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { mediaId: asset.id, start: 0, duration: 4, inPoint: 0 })
    asset.missing = true
    asset.url = ''
    const { core } = makeCore(doc)
    await core.play()
    await h.pump.pump(1)
    expect(document.querySelectorAll('video')).toHaveLength(0)

    // relinkMedia restores the URL mid-session: the very next frame must have
    // a real element with the new source, playing.
    asset.missing = false
    asset.url = 'blob:relinked'
    await h.pump.pump(2)
    const el = document.querySelector('video') as HTMLVideoElement
    expect(el).toBeTruthy()
    expect(el.src).toContain('blob:relinked')
    expect(el.paused).toBe(false)
    void core
  })

  it('stops a pooled element whose clip loses its media (dangling mediaId)', async () => {
    // removeMediaAsset leaves the clip in the doc on purpose (undo/relink
    // recover it), so the live-set keeps the element alive: it kept PLAYING
    // against a source that no longer resolves. The element must go the
    // moment the clip stops resolving, and come back if the media returns.
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { mediaId: asset.id, start: 0, duration: 4, inPoint: 0 })
    const { core } = makeCore(doc)
    await core.play()
    await h.pump.pump(1)
    expect(document.querySelectorAll('video')).toHaveLength(1)

    doc.media.length = 0
    await h.pump.pump(2)
    expect(document.querySelectorAll('video, audio')).toHaveLength(0)
    expect(core.isPlaying).toBe(true) // playback continues, silently clean

    // Undo (or a relink) restores the asset: the very next frame re-acquires
    // an element and plays it, like the missing-asset relink path.
    doc.media.push(asset)
    await h.pump.pump(2)
    const el = document.querySelector('video') as HTMLVideoElement
    expect(el).toBeTruthy()
    expect(el.paused).toBe(false)
  })

  it('releases the element when the asset kind flips to image mid-play', async () => {
    // TO_FIX item 12: the live set checked absent/missing only, while
    // syncMedia also skips url-less and image assets. No UI path flips a kind,
    // but the next person who adds one inherits a silent audio leak; the two
    // predicates must not be able to drift.
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { mediaId: asset.id, start: 0, duration: 4, inPoint: 0 })
    const { core } = makeCore(doc)
    await core.play()
    await h.pump.pump(1)
    expect(document.querySelectorAll('video')).toHaveLength(1)

    asset.kind = 'image'
    await h.pump.pump(2)
    expect(document.querySelectorAll('video, audio')).toHaveLength(0)
  })

  it('releases the element when the url empties while missing stays false', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { mediaId: asset.id, start: 0, duration: 4, inPoint: 0 })
    const { core } = makeCore(doc)
    await core.play()
    await h.pump.pump(1)
    expect(document.querySelectorAll('video')).toHaveLength(1)

    asset.url = ''
    await h.pump.pump(2)
    expect(document.querySelectorAll('video, audio')).toHaveLength(0)
  })

  it('still pauses a clip whose pending seek is in flight once it goes inactive', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { mediaId: asset.id, start: 0, duration: 4, inPoint: 0 })
    addVideoClip(doc, { mediaId: asset.id, start: 4, duration: 4, inPoint: 0 })
    const { core } = makeCore(doc)
    await core.play()
    await h.pump.pump(1)
    const els = document.querySelectorAll('video')
    const active = els[0] as HTMLVideoElement
    const next = els[1] as HTMLVideoElement

    // A seek on the active clip is in flight (never resolved).
    Object.defineProperty(active, 'seeking', { configurable: true, get: () => true })
    Object.defineProperty(active, 'currentTime', {
      configurable: true,
      get: () => 0,
      set: () => undefined,
    })

    // The playhead crosses into the next clip: the guard protects ACTIVE
    // elements only: the outgoing clip must still be paused promptly.
    h.lastAudioContext().currentTime += 4.2
    await h.pump.pump(1)
    expect(active.paused).toBe(true)
    expect(next.paused).toBe(false)
    void core
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

  it('silences and releases a clip deleted while it plays', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { mediaId: asset.id, start: 0, duration: 6, inPoint: 0 })
    const music = createMediaAsset({ kind: 'audio', name: 'm.mp3', duration: 60, url: 'blob:m' })
    doc.media.push(music)
    const musicClip = createClip({ id: 'twin-music', mediaId: music.id, start: 0, duration: 60 })
    doc.project.tracks[1].clips.push(musicClip)
    const { core } = makeCore(doc)
    await core.play()
    await h.pump.pump(1)

    const musicEl = core['pool'].peek('twin-music')!
    expect(musicEl.paused).toBe(false)
    const musicSrc = core['pool'].getSourceNode(musicEl, h.lastAudioContext() as never)

    // Delete the playing clip (the Delete command replaces the doc's tracks).
    doc.project.tracks[1].clips = doc.project.tracks[1].clips.filter((c) => c.id !== 'twin-music')
    await h.pump.pump(2)

    expect(musicEl.paused).toBe(true) // no longer audible
    expect(core['pool'].peek('twin-music')).toBeUndefined() // released
    expect(core['clipGains'].has('twin-music')).toBe(false) // chain torn down
    expect(masterGainOf(h.lastAudioContext()).inputs.length).toBe(1) // only the video chain remains
    expect((musicSrc as unknown as { inputs: unknown[] }).inputs.length).toBe(0) // source disconnected

    // The growth path stays flat: repeated add/delete cycles must not accumulate.
    for (let i = 0; i < 5; i++) {
      const c = createClip({ id: `burst-${i}`, mediaId: music.id, start: 0, duration: 60 })
      doc.project.tracks[1].clips.push(c)
      await h.pump.pump(1)
      doc.project.tracks[1].clips = doc.project.tracks[1].clips.filter((x) => x.id !== c.id)
      await h.pump.pump(1)
    }
    expect(core['pool'].ids().length).toBe(1)
    expect(core['clipGains'].size).toBe(1)
    core.dispose()
  })

  it('disconnects the audio chain when the element is already released', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { id: 'c1', mediaId: asset.id, start: 0, duration: 4, inPoint: 0 })
    const { core } = makeCore(doc)
    await core.play()
    await h.pump.pump(1)

    const el = core['pool'].peek('c1')!
    const src = core['pool'].getSourceNode(el, h.lastAudioContext() as never) as unknown as {
      connections: unknown[]
    }
    expect(src.connections.length).toBeGreaterThan(0)

    // The element is gone from the pool, but the gain entry still owns the
    // old source node. releaseClip must disconnect that node anyway.
    core['pool'].release('c1')
    core['releaseClip']('c1')

    expect(src.connections).toHaveLength(0)
    expect(core['clipGains'].has('c1')).toBe(false)
    core.dispose()
  })

  it('rewires the audio chain to the relinked element', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { mediaId: asset.id, start: 0, duration: 4, inPoint: 0 })
    const { core } = makeCore(doc)
    await core.play()
    await h.pump.pump(1)

    const before = core['pool'].peek(doc.project.tracks[0].clips[0].id)
    const oldSrc = core['pool'].getSourceNode(
      before!,
      h.lastAudioContext() as never,
    ) as unknown as {
      connections: unknown[]
    }
    expect(masterGainOf(h.lastAudioContext()).inputs.length).toBe(1)

    // Relink: the asset's url changes; the pool rebuilds the element on the
    // next tick, and the audio chain must follow it.
    asset.url = 'blob:two'
    await h.pump.pump(1)

    const after = core['pool'].peek(doc.project.tracks[0].clips[0].id)
    expect(after).not.toBe(before) // the pool rebuilt the element
    const master = masterGainOf(h.lastAudioContext())
    expect(master.inputs.length).toBe(1) // ONE chain (old torn down, new built)
    // And that chain consumes the NEW element: walk the chain back from
    // masterGain through the gain node to the element source node.
    const feeder = master.inputs[0] as unknown as {
      inputs: { mediaElement?: HTMLMediaElement }[]
    }
    expect(feeder.inputs.some((n) => n.mediaElement === after)).toBe(true)
    expect(oldSrc.connections).toHaveLength(0) // the old source is detached
    core.dispose()
  })

  it('does not rebuild the chain when the element is unchanged (sig only compares when needed)', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { mediaId: asset.id, start: 0, duration: 4, inPoint: 0 })
    const { core } = makeCore(doc)
    await core.play()
    await h.pump.pump(2) // two ticks with the same element

    // No duplicate chains accumulated from identical ticks.
    expect(masterGainOf(h.lastAudioContext()).inputs.length).toBe(1)
    core.dispose()
  })
})

/**
 * Sub-frame-rate frame blending, the engine half (0.7.0): a slow clip parks a
 * muted second element on the following source read, and the pair the
 * compositor draws is weighted from the frames the decoder PRESENTED (the
 * preview's counterpart of the exporter's sample timestamps).
 */
describe('PlaybackCore sub-frame-rate blending (mocked browser)', () => {
  const drawOps = (ctx: unknown, op: string) =>
    (ctx as { calls: { op: string; args: unknown[] }[] }).calls.filter((c) => c.op === op)

  const slowClip = (doc: Doc, asset: MediaAsset): Clip =>
    addVideoClip(doc, {
      mediaId: asset.id,
      start: 0,
      duration: 4,
      inPoint: 0,
      speed: 0.5,
    })

  it('parks a muted partner on the following source read, outside the audio graph', async () => {
    const { doc, asset } = makeDoc()
    const clip = slowClip(doc, asset)
    const { core } = makeCore(doc)
    await core.play()
    await h.pump.pump(1)

    const primary = document.querySelector('video') as HTMLVideoElement
    const partner = core['pool'].peekNext(clip.id)
    expect(partner).toBeDefined()
    expect(partner).not.toBe(primary)
    // Muted: a partner that kept the clip's audio would double it.
    expect(partner!.muted).toBe(true)
    expect(primary.muted).toBe(false)
    // Parked on the read one output frame later: local 0 + 1/30 at 0.5x = 1/60 s.
    expectParkedOn(partner!, 0.5 / 30, 'partner read')
    expect(partner!.paused).toBe(true)
    // And it is NOT in the audio graph: only the clip's own element is routed.
    expect(h.lastAudioContext().elementSources).toEqual([primary])
    core.dispose()
  })

  it('parks the partner on the source read the export plan asks for', () => {
    const { doc, asset } = makeDoc()
    const clip = slowClip(doc, asset)
    const { core } = makeCore(doc)

    // The pair both paths blend is the plan's `blendTime`, so the parked element
    // must hold the frame that timestamp names at every position: a drift here is
    // a monitor that blends a different pair than the exported file. The frame,
    // not the raw position, is the contract (the park sits a hair inside it).
    for (const k of [0, 3, 7, 11]) {
      const t = k / 30
      const planned = planVideoFrame(doc, t).draws[0].blendTime
      expect(planned, `plan at ${t}`).toBeDefined()
      const read = clampSourceTime(planned!, asset)
      core.seek(t)
      const partner = core['pool'].peekNext(clip.id)
      expect(partner, `partner at ${t}`).toBeDefined()
      expectParkedOn(partner!, read, 'planned partner read')
      expect(shownFrame(partner!.currentTime), `frame at ${t}`).toBe(shownFrame(read + PARK_NUDGE))
    }
    core.dispose()
  })

  it('parks a frame-boundary read inside the frame the export plan names', () => {
    // 0.5x over a 30 fps source: the plan's pair straddles a source frame at
    // k = 1, 5, 9, ... (local 1/30, 5/30, 9/30), where `blendTime` is EXACTLY a
    // source frame start. The exporter's sample lookup keeps the last sample with
    // `timestamp <= t`, so its frame is the one that STARTS there, and the
    // monitor has to park inside that same frame: on the bare boundary a real
    // element can present the frame before it, which collapses the pair.
    const { doc, asset } = makeDoc()
    const clip = slowClip(doc, asset)
    const { core } = makeCore(doc)

    for (const k of [1, 5, 9]) {
      const t = k / 30
      const plan = planVideoFrame(doc, t).draws[0]
      expect(plan.blendTime, `plan at ${t}`).toBeDefined()
      core.seek(t)
      const primary = document.querySelector('video') as HTMLVideoElement
      const partner = core['pool'].peekNext(clip.id)!
      expect(shownFrame(primary.currentTime), `primary frame at ${t}`).toBe(
        Math.floor(plan.sourceTime * 30 + 1e-9),
      )
      expect(shownFrame(partner.currentTime), `partner frame at ${t}`).toBe(
        Math.floor(clampSourceTime(plan.blendTime!, asset) * 30 + 1e-9),
      )
    }
    core.dispose()
  })

  it('blends the planned pair when the read lands on a frame boundary', () => {
    // The browser half of the same rule: an element seeked to a frame's exact
    // start can present the frame before it (float rounding at the edge), which
    // is what made the parked monitor hold one frame where the file blends two.
    // The frames presented here are the ones such an element would show.
    const { doc, asset } = makeDoc()
    const clip = slowClip(doc, asset)
    const { core, ctx } = makeCore(doc)
    const t = 1 / 30 // 0.5x: read 1/60 s, partner read 1/30 s (a boundary)
    core.seek(t)

    const primary = document.querySelector('video') as HTMLVideoElement
    const partner = core['pool'].peekNext(clip.id)!
    primeVideoElement(primary)
    primeVideoElement(partner)
    expect(primary.currentTime).toBeGreaterThan(1 / 60)
    expect(partner.currentTime).toBeGreaterThan(1 / 30)

    // Present what a boundary-ambiguous element shows for each parked position.
    presentFrame(primary, shownFrame(primary.currentTime) / 30)
    presentFrame(partner, shownFrame(partner.currentTime) / 30)
    ctx.calls.length = 0
    core.seek(t)

    // The pair must still blend, at the plan's weight (1/60 between 0 and 1/30).
    const draws = drawOps(ctx, 'drawImage')
    expect(draws).toHaveLength(1)
    const scratch = draws[0].args[0] as HTMLCanvasElement
    expect(scratch).toBeInstanceOf(HTMLCanvasElement)
    const sctx = (scratch as unknown as { __fakeCtx: unknown }).__fakeCtx
    ;(sctx as { calls: unknown[] }).calls.length = 0
    core.seek(t)
    const layers = drawOps(sctx, 'drawImage')
    expect(layers.map((c) => c.args[0])).toEqual([primary, partner])
    const alphas = drawOps(sctx, 'set:globalAlpha').map((c) => c.args[0]) as number[]
    expect(alphas[0]).toBe(1)
    expect(alphas[1]).toBeCloseTo(0.5, 12)
    expect(alphas[2]).toBeCloseTo(0.5, 12)
    core.dispose()
  })

  it('uses the blend path for a paused scrub instead of one WebCodecs frame (0.18.0)', () => {
    const { doc, asset } = makeDoc()
    const clip = slowClip(doc, asset)
    const frame = document.createElement('canvas')
    frame.width = 640
    frame.height = 360
    const request = vi.fn()
    const source: ScrubFrameSource = {
      hasSink: () => true,
      // A blend clip never requests a frame, so the cache stays empty. The
      // render preflight must not wait for one.
      peek: () => undefined,
      request,
      releaseClip: vi.fn(),
      releaseAsset: vi.fn(),
      reset: vi.fn(),
      dispose: vi.fn(),
      onFallback: () => () => undefined,
    }
    const { core, ctx } = makeCore(doc, { createScrubSource: () => source })
    const t = 1 / 30
    core.seek(t)

    // The clip needs a pair. The single-frame WebCodecs shortcut must not run.
    expect(request).not.toHaveBeenCalled()
    const primary = core['pool'].peek(clip.id) as HTMLVideoElement
    const partner = core['pool'].peekNext(clip.id)
    expect(primary).toBeDefined()
    expect(partner).toBeDefined()

    primeVideoElement(primary)
    primeVideoElement(partner!)
    presentFrame(primary, shownFrame(primary.currentTime) / 30)
    presentFrame(partner!, shownFrame(partner!.currentTime) / 30)
    ctx.calls.length = 0
    core.seek(t)

    const draws = drawOps(ctx, 'drawImage')
    expect(draws).toHaveLength(1)
    const scratch = draws[0].args[0] as HTMLCanvasElement
    expect(scratch).toBeInstanceOf(HTMLCanvasElement)
    const sctx = (scratch as unknown as { __fakeCtx: unknown }).__fakeCtx
    // The scratch is reused across renders; the last pair is this draw's.
    const layers = drawOps(sctx, 'drawImage').slice(-2)
    expect(layers.map((call) => call.args[0])).toEqual([primary, partner])
    expect(draws.some((call) => call.args[0] === frame)).toBe(false)
    core.dispose()
  })

  it('does not mark a blend clip as a scrub fallback while its sink is available (0.18.0)', () => {
    const { doc, asset } = makeDoc()
    const clip = slowClip(doc, asset)
    const source: ScrubFrameSource = {
      hasSink: () => true,
      peek: () => undefined,
      request: vi.fn(),
      releaseClip: vi.fn(),
      releaseAsset: vi.fn(),
      reset: vi.fn(),
      dispose: vi.fn(),
      onFallback: () => () => undefined,
    }
    const { core } = makeCore(doc, { createScrubSource: () => source })
    const note = vi.spyOn(
      core as unknown as { noteScrubFallback: (...args: unknown[]) => void },
      'noteScrubFallback',
    )
    core.seek(1 / 30)
    const el = core['pool'].peek(clip.id) as HTMLVideoElement
    expect(el).toBeDefined()
    // The blend path is deliberate, not a WebCodecs fallback: its element
    // must not inherit the neutral scrub-retry budget or the fallback map.
    expect(core['scrubFallbackElements'].has(el)).toBe(false)

    Object.defineProperty(el, 'error', { configurable: true, value: { code: 3 } })
    core.seek(1 / 30)
    expect(note).not.toHaveBeenCalled()
    core.dispose()
  })

  it('still marks a blend clip as a scrub fallback when its sink is unavailable (0.18.0)', () => {
    const { doc, asset } = makeDoc()
    const clip = slowClip(doc, asset)
    const source: ScrubFrameSource = {
      hasSink: () => false,
      peek: () => undefined,
      request: vi.fn(),
      releaseClip: vi.fn(),
      releaseAsset: vi.fn(),
      reset: vi.fn(),
      dispose: vi.fn(),
      onFallback: () => () => undefined,
    }
    const { core } = makeCore(doc, { createScrubSource: () => source })
    core.seek(1 / 30)
    const el = core['pool'].peek(clip.id) as HTMLVideoElement
    expect(core['scrubFallbackElements'].has(el)).toBe(true)
    core.dispose()
  })

  it('re-seeks the partner for a step below the primary element dead zone', () => {
    const { doc, asset } = makeDoc()
    const clip = slowClip(doc, asset)
    const { core } = makeCore(doc)

    // Two consecutive output frames at 0.5x move the partner read by 1/60 s,
    // which is below the 0.02 s dead zone the PRIMARY element uses. The partner
    // must move anyway: its whole job is to hold the frame next to the read, and
    // a partner left behind collapses the pair onto one frame. The browser
    // measurement that found this read a blended sum the collapsed pair could
    // not produce, so the parked path gets the tighter threshold.
    // The first step lands exactly on source frame 16's start (32/60 = 16/30 at
    // 0.5x), the tightest case for the park: inside that frame, not on its edge.
    core.seek(31 / 30)
    const partner = core['pool'].peekNext(clip.id)!
    expectParkedOn(partner, 32 / 60, 'partner step')
    expect(shownFrame(partner.currentTime)).toBe(16)

    core.seek(32 / 30)
    expectParkedOn(partner, 33 / 60, 'partner step')
    expect(shownFrame(partner.currentTime)).toBe(16)
    core.dispose()
  })

  it('drops the parked partner when the clip stops reading below realtime', async () => {
    const { doc, asset } = makeDoc()
    const clip = slowClip(doc, asset)
    const { core } = makeCore(doc)
    await core.play()
    await h.pump.pump(1)
    expect(core['pool'].peekNext(clip.id)).toBeDefined()

    // A speed edit back to realtime: the pair nothing will ask for is released
    // instead of holding a second decode alive.
    doc.project.tracks[0].clips[0].speed = 2
    await h.pump.pump(1)
    expect(core['pool'].peekNext(clip.id)).toBeUndefined()
    core.dispose()
  })

  it('blends the pair at the weight its presented frames report', () => {
    const { doc, asset } = makeDoc()
    const clip = slowClip(doc, asset)
    const { core, ctx } = makeCore(doc)
    // Source 30 fps, timeline 30 fps, 0.5x: this output frame reads 0.516667 s
    // and its partner 0.533333 s, so the read sits between source frames 15 and
    // 16. The export's plan asks for the same pair at the same weights.
    const t = 31 / 30
    core.seek(t)

    const primary = document.querySelector('video') as HTMLVideoElement
    const partner = core['pool'].peekNext(clip.id)!
    primeVideoElement(primary)
    primeVideoElement(partner)
    expectParkedOn(primary, 0.5 + 0.5 / 30, 'primary read')
    expectParkedOn(partner, 0.5 + 1 / 30, 'partner read')

    // No frame presented yet, so neither element can vouch for what it shows:
    // the draw stays the single stepped frame.
    core.seek(t)
    expect(drawOps(ctx, 'drawImage')[0].args[0]).toBe(primary)

    // Present the pair as a decoder would: frame 15 at 0.5 s, frame 16 at
    // 0.533333 s. The read 0.516667 s sits exactly halfway between them.
    presentFrame(primary, 0.5)
    presentFrame(partner, 0.5 + 1 / 30)
    ctx.calls.length = 0
    core.seek(t)

    const draws = drawOps(ctx, 'drawImage')
    expect(draws).toHaveLength(1)
    const scratch = draws[0].args[0] as HTMLCanvasElement
    expect(scratch).not.toBe(primary)
    expect(scratch).toBeInstanceOf(HTMLCanvasElement)
    // Geometry is untouched by the blend: contain-fit 640x360 -> 1920x1080.
    expect(draws[0].args.slice(1)).toEqual([0, 0, 1920, 1080])

    // Clear the scratch's trace so the composite can be read exactly: the pair
    // goes in additively at 1-w / w, and the result composites once.
    const sctx = (scratch as unknown as { __fakeCtx: unknown }).__fakeCtx
    ;(sctx as { calls: unknown[] }).calls.length = 0
    core.seek(t)
    const layers = drawOps(sctx, 'drawImage')
    expect(layers.map((c) => c.args[0])).toEqual([primary, partner])
    expect(drawOps(sctx, 'set:globalCompositeOperation').map((c) => c.args[0])).toEqual([
      'source-over',
      'lighter',
    ])
    const alphas = drawOps(sctx, 'set:globalAlpha').map((c) => c.args[0]) as number[]
    expect(alphas[0]).toBe(1) // the black base of the pair
    expect(alphas[1]).toBeCloseTo(0.5, 12) // 1 - w for the frame the read is on
    expect(alphas[2]).toBeCloseTo(0.5, 12) // w for the partner frame
    core.dispose()
  })

  it('falls back to the single frame when the partner is latched', () => {
    const { doc, asset } = makeDoc()
    const clip = slowClip(doc, asset)
    const { core, ctx } = makeCore(doc)
    const t = 31 / 30
    core.seek(t)

    const primary = document.querySelector('video') as HTMLVideoElement
    const partner = core['pool'].peekNext(clip.id)!
    primeVideoElement(primary)
    primeVideoElement(partner)
    presentFrame(primary, 0.5)
    presentFrame(partner, 0.5 + 1 / 30)

    // The pair blends before the latch.
    ctx.calls.length = 0
    core.seek(t)
    expect(drawOps(ctx, 'drawImage')[0].args[0]).not.toBe(primary)

    // A partner error latches it. The next draw must use the primary alone,
    // not the failed partner's stale presented frame.
    setMediaError(partner, 3)
    expect(core['failedPartners'].has(partner)).toBe(true)
    ctx.calls.length = 0
    core.seek(t)
    expect(drawOps(ctx, 'drawImage')[0].args[0]).toBe(primary)
    core.dispose()
  })

  it('repaints the parked pair when the presented frame lands after seeked', () => {
    // `seeked` fires when the position lands, which can be before the decoded
    // frame reaches the compositor. A draw at that moment pairs the new frame
    // with the old one, or falls back to a single frame, and the parked canvas
    // had nothing left to revisit it: the monitor kept showing one frame where
    // the file blends two. The presented frame itself has to repaint.
    const { doc, asset } = makeDoc()
    const clip = slowClip(doc, asset)
    const { core, ctx } = makeCore(doc)
    const t = 1 / 30
    core.seek(t)

    const primary = document.querySelector('video') as HTMLVideoElement
    const partner = core['pool'].peekNext(clip.id)!
    primeVideoElement(primary)
    primeVideoElement(partner)

    // The primary's frame is already on record; the partner still reports the
    // frame from before its seek landed. No blend is possible yet.
    presentFrame(primary, 0)
    presentFrame(partner, 0)
    ctx.calls.length = 0
    core.seek(t)
    expect(drawOps(ctx, 'drawImage')[0].args[0]).toBe(primary)

    // The partner's own frame arrives. Presenting it must repaint the parked
    // canvas, because nothing else will: the read is parked, so no clock tick
    // and no further seek is coming.
    ctx.calls.length = 0
    presentFrame(partner, 1 / 30)
    const draws = drawOps(ctx, 'drawImage')
    expect(draws.length).toBeGreaterThanOrEqual(1)
    expect(draws[0].args[0]).toBeInstanceOf(HTMLCanvasElement)
    expect(draws[0].args[0]).not.toBe(primary)
    core.dispose()
  })

  it('steps rather than blending against a frame the element cannot vouch for', () => {
    const { doc, asset } = makeDoc()
    const clip = slowClip(doc, asset)
    const { core, ctx } = makeCore(doc)
    const t = 31 / 30
    core.seek(t)
    const primary = document.querySelector('video') as HTMLVideoElement
    const partner = core['pool'].peekNext(clip.id)!
    primeVideoElement(primary)
    primeVideoElement(partner)

    // The partner still SHOWS a frame from further down the clip, left over
    // from the position it held before this seek landed. Blending against it
    // would ghost a distant part of the clip, so the draw stays the single
    // stepped frame.
    presentFrame(primary, 0.5)
    presentFrame(partner, 0.9)
    ctx.calls.length = 0
    core.seek(t)
    expect(drawOps(ctx, 'drawImage')[0].args[0]).toBe(primary)

    // And the other side of the same rule: the PRIMARY's frame is more than a
    // frame behind the read, so it cannot be the frame the pair starts from
    // either (a weight measured against it would blend in the wrong content).
    presentFrame(primary, 0.2)
    presentFrame(partner, 0.5 + 1 / 30)
    ctx.calls.length = 0
    core.seek(t)
    expect(drawOps(ctx, 'drawImage')[0].args[0]).toBe(primary)

    // And the third: a seek still in flight. The element keeps displaying its
    // old frame until the decode lands, so the pair is not usable yet even
    // though the timestamps on record look plausible.
    presentFrame(primary, 0.5)
    presentFrame(partner, 0.5 + 1 / 30)
    Object.defineProperty(partner, 'seeking', { configurable: true, value: true })
    ctx.calls.length = 0
    core.seek(t)
    expect(drawOps(ctx, 'drawImage')[0].args[0]).toBe(primary)
    Object.defineProperty(partner, 'seeking', { configurable: true, value: false })
    core.dispose()
  })

  it('routes a nested clip through the container gain exactly once', async () => {
    const { doc, asset } = makeDoc()
    const child = createClip({
      id: 'child',
      mediaId: asset.id,
      start: 0,
      duration: 4,
      inPoint: 0,
      audioOnly: true,
      gain: 0.5,
    })
    doc.project.sequences = [
      {
        id: 'seq1',
        name: 'Compound',
        tracks: [createTrack('audio', 1, { id: 'st', clips: [child] })],
      },
    ]
    doc.project.tracks[0].clips.push(
      createClip({ id: 'comp', sequenceId: 'seq1', start: 0, duration: 4, gain: 0.5 }),
    )
    const { core } = makeCore(doc)
    await core.play()
    await h.pump.pump(1)
    const gains = () =>
      masterGainOf(h.lastAudioContext()).inputs.map(
        (n) => (n as FakeGainNode).gain.last?.value ?? 1,
      )
    // The child's 0.5 multiplies the container's 0.5 once.
    expect(gains().some((g) => Math.abs(g - 0.25) < 1e-5)).toBe(true)
    core.dispose()
  })

  it('mutes a nested clip when its container is muted', async () => {
    const { doc, asset } = makeDoc()
    const child = createClip({
      id: 'child',
      mediaId: asset.id,
      start: 0,
      duration: 4,
      inPoint: 0,
      audioOnly: true,
    })
    doc.project.sequences = [
      {
        id: 'seq1',
        name: 'Compound',
        tracks: [createTrack('audio', 1, { id: 'st', clips: [child] })],
      },
    ]
    doc.project.tracks[0].clips.push(
      createClip({ id: 'comp', sequenceId: 'seq1', start: 0, duration: 4, muted: true }),
    )
    const { core } = makeCore(doc)
    await core.play()
    await h.pump.pump(1)
    const gains = masterGainOf(h.lastAudioContext()).inputs.map(
      (n) => (n as FakeGainNode).gain.last?.value ?? 1,
    )
    // The container's mute zeroes the nested clip's gain.
    expect(gains.some((g) => Math.abs(g) < 1e-9)).toBe(true)
    core.dispose()
  })

  it('applies a container volume curve to the nested gain', async () => {
    const { doc, asset } = makeDoc()
    const child = createClip({
      id: 'child',
      mediaId: asset.id,
      start: 0,
      duration: 4,
      inPoint: 0,
      audioOnly: true,
    })
    doc.project.sequences = [
      {
        id: 'seq1',
        name: 'Compound',
        tracks: [createTrack('audio', 1, { id: 'st', clips: [child] })],
      },
    ]
    doc.project.tracks[0].clips.push(
      createClip({
        id: 'comp',
        sequenceId: 'seq1',
        start: 0,
        duration: 4,
        keyframes: { volume: [{ time: 0, value: 0.3 }] },
      }),
    )
    const { core } = makeCore(doc)
    await core.play()
    await h.pump.pump(1)
    const gains = masterGainOf(h.lastAudioContext()).inputs.map(
      (n) => (n as FakeGainNode).gain.last?.value ?? 1,
    )
    // The container's volume curve (0.3) multiplies the child's own gain once.
    expect(gains.some((g) => Math.abs(g - 0.3) < 1e-5)).toBe(true)
    core.dispose()
  })

  it('materializes an element for a nested video clip', () => {
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
    const created: string[] = []
    const orig = document.createElement.bind(document)
    const spy = vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      if (tag === 'video') created.push(tag)
      return orig(tag)
    }) as typeof document.createElement)
    const { core } = makeCore(doc)
    core.seek(1)
    expect(created.length).toBeGreaterThan(0)
    core.dispose()
    spy.mockRestore()
  })
})

describe('track solo in the preview mixer (0.14.0)', () => {
  const AUDIO = createMediaAsset({
    id: 'msolo',
    kind: 'audio',
    name: 's.mp3',
    duration: 10,
    url: 'blob:solo',
    waveformPeaks: [0.4, 0.6],
  })

  function soloDoc(
    a1: { solo?: boolean; muted?: boolean } = {},
    a2: { solo?: boolean; muted?: boolean } = {},
    gains: { one?: number; two?: number } = {},
  ): Doc {
    const doc = createDoc()
    doc.media = [AUDIO]
    const video = createTrack('video', 1, { id: 'sv' })
    const one = createTrack('audio', 1, {
      id: 'sa1',
      ...a1,
      clips: [
        createClip({
          id: 's1',
          mediaId: AUDIO.id,
          start: 0,
          duration: 4,
          audioOnly: true,
          gain: gains.one,
        }),
      ],
    })
    const two = createTrack('audio', 2, {
      id: 'sa2',
      ...a2,
      clips: [
        createClip({
          id: 's2',
          mediaId: AUDIO.id,
          start: 0,
          duration: 4,
          audioOnly: true,
          gain: gains.two,
        }),
      ],
    })
    doc.project.tracks = [video, one, two]
    return doc
  }

  const gainsOf = () =>
    masterGainOf(h.lastAudioContext()).inputs.map((n) => (n as FakeGainNode).gain.last?.value ?? 1)

  it('no solo keeps both audio lanes audible', async () => {
    const { core } = makeCore(soloDoc())
    await core.play()
    await h.pump.pump(1)
    expect(gainsOf()).toEqual([1, 1])
    core.dispose()
  })

  it('soloing A1 silences A2 in the preview graph', async () => {
    const { core } = makeCore(soloDoc({ solo: true }))
    await core.play()
    await h.pump.pump(1)
    expect(gainsOf()).toEqual([1, 0])
    core.dispose()
  })

  it('two solos stay audible, and gain still multiplies', async () => {
    const { core } = makeCore(soloDoc({ solo: true }, { solo: true }, { one: 0.5, two: 0.25 }))
    await core.play()
    await h.pump.pump(1)
    const gains = gainsOf()
    expect(gains[0]).toBeCloseTo(0.5)
    expect(gains[1]).toBeCloseTo(0.25)
    core.dispose()
  })

  it('a soloed track that is muted stays silent', async () => {
    const { core } = makeCore(soloDoc({ solo: true, muted: true }))
    await core.play()
    await h.pump.pump(1)
    expect(gainsOf()).toEqual([0, 0])
    core.dispose()
  })

  it("silences a solo video's embedded audio while an audio lane is soloed", async () => {
    const { doc, asset } = makeDoc()
    doc.project.tracks = [
      createTrack('video', 1, {
        id: 'vv',
        clips: [createClip({ id: 'vv1', mediaId: asset.id, start: 0, duration: 4, inPoint: 0 })],
      }),
      createTrack('audio', 1, {
        id: 'sa1',
        solo: true,
        clips: [
          createClip({
            id: 'sa1clip',
            mediaId: AUDIO.id,
            start: 0,
            duration: 4,
            audioOnly: true,
          }),
        ],
      }),
    ]
    doc.media.push(AUDIO)
    const { core } = makeCore(doc)
    await core.play()
    await h.pump.pump(1)
    const gains = gainsOf()
    expect(gains).toHaveLength(2)
    expect(gains[0]).toBe(0)
    expect(gains[1]).toBe(1)
    core.dispose()
  })
})

describe('decode recovery (mocked browser)', () => {
  it('reloads, skips to the mapped keyframe, and reports the range when paused', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { id: 'c1', mediaId: asset.id, start: 0, duration: 10, inPoint: 0 })
    const notices: (MediaErrorInfo | null)[] = []
    const lookups: { url: string; time: number }[] = []
    const { core } = makeCore(doc, {
      onMediaError: (info) => notices.push(info),
      nextKeyframe: async (url, time) => {
        lookups.push({ url, time })
        return 5
      },
    })

    core.seek(2)
    const el = document.querySelector('video') as HTMLVideoElement
    expect(el).not.toBeNull()
    setMediaError(el, 3)

    await vi.waitFor(() => expect(notices).toHaveLength(1))
    expect(lookups).toHaveLength(1)
    expect(lookups[0].time).toBeCloseTo(2, 5)
    expect(lookups[0].url).toContain('blob:video')
    expect(core.currentTime).toBeCloseTo(5, 5)
    expect(el.currentTime).toBeGreaterThanOrEqual(5)
    expect(el.error).toBeNull()
    expect(notices[0]).toEqual({
      clipId: 'c1',
      code: 3,
      time: 2,
      skippedTo: 5,
      terminal: false,
    })
    expect(core.isPlaying).toBe(false)
    core.dispose()
  })

  it('parks a reloaded video element on the keyframe when the scrub path owns the still', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { id: 'c1', mediaId: asset.id, start: 0, duration: 10, inPoint: 0 })
    const notices: (MediaErrorInfo | null)[] = []
    const source: ScrubFrameSource = {
      hasSink: () => true,
      peek: () => undefined,
      request: vi.fn(),
      releaseClip: vi.fn(),
      releaseAsset: vi.fn(),
      reset: vi.fn(),
      dispose: vi.fn(),
      onFallback: () => () => undefined,
    }
    const { core } = makeCore(doc, {
      onMediaError: (info) => notices.push(info),
      nextKeyframe: async () => 5,
      createScrubSource: () => source,
    })

    // Materialize the playback element, then hand the paused still to WebCodecs.
    await core.play()
    await h.pump.pump(1)
    core.pause()
    core.seek(2)
    const el = core['pool'].peek('c1') as HTMLVideoElement
    // A browser load() resets the element to zero; the fake does not, so make
    // the reload mimic the real state machine.
    const load = el.load.bind(el)
    el.load = () => {
      load()
      el.currentTime = 0
    }
    setMediaError(el, 3)

    await vi.waitFor(() => expect(notices).toHaveLength(1))
    expect(notices[0]).toMatchObject({ time: 2, skippedTo: 5, terminal: false })
    expect(core.currentTime).toBeCloseTo(5, 5)
    expect(el.currentTime).toBeGreaterThanOrEqual(5)
    core.dispose()
  })

  it('uses a verified keyframe that is less than one frame ahead', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { id: 'c1', mediaId: asset.id, start: 0, duration: 10, inPoint: 0 })
    const notices: (MediaErrorInfo | null)[] = []
    const { core } = makeCore(doc, {
      onMediaError: (info) => notices.push(info),
      nextKeyframe: async () => 5.01,
    })

    core.seek(5)
    const el = core['pool'].peek('c1') as HTMLVideoElement
    setMediaError(el, 3)

    await vi.waitFor(() => expect(notices).toHaveLength(1))
    expect(notices[0]).toMatchObject({ time: 5, terminal: false })
    expect(notices[0]?.skippedTo).toBeCloseTo(5.01, 5)
    expect(core.currentTime).toBeCloseTo(5.01, 5)
    // The keyframe is inside the still seek dead zone, so the commit has to
    // force the element to it instead of accepting the old read.
    expect(el.currentTime).toBeCloseTo(5.01, 3)
    core.dispose()
  })

  it('forces a near-start keyframe seek after the reload', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { id: 'c1', mediaId: asset.id, start: 0, duration: 10, inPoint: 0 })
    const notices: (MediaErrorInfo | null)[] = []
    const { core } = makeCore(doc, {
      onMediaError: (info) => notices.push(info),
      nextKeyframe: async () => 0.01,
    })

    core.seek(0)
    const el = core['pool'].peek('c1') as HTMLVideoElement
    expect(el.currentTime).toBeCloseTo(0, 5)
    setMediaError(el, 3)

    await vi.waitFor(() => expect(notices).toHaveLength(1))
    expect(notices[0]).toMatchObject({ time: 0, terminal: false })
    expect(notices[0]?.skippedTo).toBeCloseTo(0.01, 5)
    // The reload left the element at zero, and the keyframe is inside the still
    // seek dead zone. The commit must seek instead of accepting the old read.
    expect(el.currentTime).toBeCloseTo(0.01, 3)
    core.dispose()
  })

  it('resumes when the error arrived during playback', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { id: 'c1', mediaId: asset.id, start: 0, duration: 10, inPoint: 0 })
    const notices: (MediaErrorInfo | null)[] = []
    const { core, playingChanges } = makeCore(doc, {
      onMediaError: (info) => notices.push(info),
      nextKeyframe: async () => 5,
    })

    await core.play()
    await h.pump.pump(1)
    core.seek(2)
    await h.pump.pump(1)
    const el = document.querySelector('video') as HTMLVideoElement
    setMediaError(el, 3)

    await vi.waitFor(() => expect(notices).toHaveLength(1))
    expect(core.isPlaying).toBe(true)
    expect(core.currentTime).toBeCloseTo(5, 5)
    expect(playingChanges).toContain(false)
    expect(playingChanges[playingChanges.length - 1]).toBe(true)
    core.dispose()
  })

  it('ignores an error from a clip that is not active at the playhead', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { id: 'c1', mediaId: asset.id, start: 0, duration: 2, inPoint: 0 })
    const secondTrack = createTrack('video', 2)
    doc.project.tracks.push(secondTrack)
    secondTrack.clips.push(
      createClip({ id: 'c2', mediaId: asset.id, start: 8, duration: 2, inPoint: 0 }),
    )
    const notices: (MediaErrorInfo | null)[] = []
    const lookups: number[] = []
    const { core } = makeCore(doc, {
      onMediaError: (info) => notices.push(info),
      nextKeyframe: async () => {
        lookups.push(1)
        return 9
      },
    })

    await core.play()
    await h.pump.pump(1)
    core.pause()
    const videos = document.querySelectorAll('video')
    expect(videos).toHaveLength(2)
    setMediaError(videos[1] as HTMLVideoElement, 3)
    await Promise.resolve()

    expect(notices).toHaveLength(0)
    expect(lookups).toHaveLength(0)
    expect(core.currentTime).toBe(0)
    core.dispose()
  })

  it('a pause during the lookup cancels without jumping or reporting', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { id: 'c1', mediaId: asset.id, start: 0, duration: 10, inPoint: 0 })
    const gate = deferred<number | undefined>()
    const notices: (MediaErrorInfo | null)[] = []
    let lookups = 0
    const { core } = makeCore(doc, {
      onMediaError: (info) => notices.push(info),
      nextKeyframe: () => {
        lookups++
        return gate.promise
      },
    })

    core.seek(2)
    const el = document.querySelector('video') as HTMLVideoElement
    setMediaError(el, 3)
    await Promise.resolve()
    expect(lookups).toBe(1)

    core.pause()
    gate.resolve(5)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(core.currentTime).toBe(2)
    expect(notices).toHaveLength(0)
    expect(lookups).toBe(1)
    core.dispose()
  })

  it('a pause after the skip leaves the pending WebCodecs frame as the paint owner', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { id: 'c1', mediaId: asset.id, start: 0, duration: 10, inPoint: 0 })
    let cached: CanvasImageSource | undefined
    let requested: {
      request: ScrubFrameRequest
      onFrame: (result: ScrubFrameResult) => void
    } | null = null
    const source = scrubSource({
      hasSink: () => true,
      peek: () => cached,
      request: (request, onFrame) => {
        requested = { request, onFrame }
      },
    })
    const { core, frames, ctx } = makeCore(doc, {
      createScrubSource: () => source,
      nextKeyframe: async () => 5,
    })

    await core.play()
    await h.pump.pump(1)
    core.seek(2)
    await h.pump.pump(1)
    const el = document.querySelector('video') as HTMLVideoElement
    primeVideoElement(el)
    await h.pump.pump(1)
    const audio = h.lastAudioContext()
    audio.state = 'suspended'
    const gate = deferred<void>()
    FakeAudioContext.resumeGate = gate.promise

    const drawsBeforeError = ctx.calls.filter((call) => call.op === 'drawImage').length
    expect(drawsBeforeError).toBeGreaterThan(0)
    setMediaError(el, 3)
    await vi.waitFor(() => expect(core.currentTime).toBeCloseTo(5, 5))
    expect(requested).not.toBeNull()
    // The skip moved the playhead and its frame callback to 5, but the
    // WebCodecs target has not arrived, so the canvas still holds the
    // pre-error composite.
    expect(frames.at(-1)).toBeCloseTo(5, 5)
    expect(ctx.calls.filter((call) => call.op === 'drawImage')).toHaveLength(drawsBeforeError)

    // The pause lands after the skip but before the 5 s frame decodes. It is a
    // no-op for the paint: the recovery owns the redraw, and the canvas stays
    // on the last composite until that frame lands.
    core.pause()
    expect(core.currentTime).toBeCloseTo(5, 5)
    expect(core.isPlaying).toBe(false)
    expect(ctx.calls.filter((call) => call.op === 'drawImage')).toHaveLength(drawsBeforeError)

    // The pending frame still paints the committed target after the pause.
    const frame = document.createElement('canvas')
    cached = frame
    requested!.onFrame({
      clipId: 'c1',
      frame,
      sourceTime: requested!.request.sourceTime,
      generation: requested!.request.generation,
    })
    expect(ctx.calls.some((call) => call.op === 'drawImage' && call.args[0] === frame)).toBe(true)

    gate.resolve()
    await vi.waitFor(() => expect(core['recoveryInFlight']).toBeNull())
    FakeAudioContext.resumeGate = null
    core.dispose()
  })

  it('serializes two clip errors and drains the deferred one once', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { id: 'c1', mediaId: asset.id, start: 0, duration: 10, inPoint: 0 })
    const secondTrack = createTrack('video', 2)
    doc.project.tracks.push(secondTrack)
    secondTrack.clips.push(
      createClip({ id: 'c2', mediaId: asset.id, start: 0, duration: 10, inPoint: 0 }),
    )
    const notices: (MediaErrorInfo | null)[] = []
    let lookups = 0
    const { core } = makeCore(doc, {
      onMediaError: (info) => notices.push(info),
      nextKeyframe: async () => {
        lookups++
        return lookups === 1 ? 5 : 8
      },
    })

    core.seek(2)
    const videos = document.querySelectorAll('video')
    expect(videos).toHaveLength(2)
    setMediaError(videos[0] as HTMLVideoElement, 3)
    setMediaError(videos[1] as HTMLVideoElement, 3)

    await vi.waitFor(() => expect(notices).toHaveLength(2))
    expect(lookups).toBe(2)
    expect(notices.map((n) => n?.clipId)).toEqual(['c1', 'c2'])
    expect(core.currentTime).toBeCloseTo(8, 5)
    core.dispose()
  })

  it('ignores a duplicate code 3 from the clip already recovering', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { id: 'c1', mediaId: asset.id, start: 0, duration: 10, inPoint: 0 })
    const gate = deferred<number | undefined>()
    const notices: (MediaErrorInfo | null)[] = []
    let lookups = 0
    const { core } = makeCore(doc, {
      onMediaError: (info) => notices.push(info),
      nextKeyframe: () => {
        lookups++
        return gate.promise
      },
    })

    core.seek(2)
    const el = document.querySelector('video') as HTMLVideoElement
    setMediaError(el, 3)
    await Promise.resolve()
    setMediaError(el, 3)
    gate.resolve(5)

    await vi.waitFor(() => expect(notices).toHaveLength(1))
    expect(lookups).toBe(1)
    expect(notices[0]?.terminal).toBe(false)
    expect(core.currentTime).toBeCloseTo(5, 5)
    core.dispose()
  })

  it('terminalizes an in-flight code 4 without a success notice', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { id: 'c1', mediaId: asset.id, start: 0, duration: 10, inPoint: 0 })
    const gate = deferred<number | undefined>()
    const notices: (MediaErrorInfo | null)[] = []
    const { core } = makeCore(doc, {
      onMediaError: (info) => notices.push(info),
      nextKeyframe: () => gate.promise,
    })

    core.seek(2)
    const el = document.querySelector('video') as HTMLVideoElement
    setMediaError(el, 3)
    await Promise.resolve()
    setMediaError(el, 4)
    gate.resolve(5)

    await vi.waitFor(() => expect(notices).toHaveLength(1))
    expect(notices[0]).toEqual({
      clipId: 'c1',
      code: 4,
      time: 2,
      terminal: true,
    })
    expect(core.currentTime).toBeCloseTo(2, 5)
    expect(core.isPlaying).toBe(false)

    // The element is latched: another code 4 does not report again.
    setMediaError(el, 4)
    await Promise.resolve()
    expect(notices).toHaveLength(1)
    core.dispose()
  })

  it('a code 4 during the resume prepare cancels playback and applies failedFrom', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { id: 'c1', mediaId: asset.id, start: 0, duration: 10, inPoint: 0 })
    const notices: (MediaErrorInfo | null)[] = []
    const { core, playingChanges } = makeCore(doc, {
      onMediaError: (info) => notices.push(info),
      nextKeyframe: async () => 5,
    })

    await core.play()
    await h.pump.pump(1)
    core.seek(2)
    await h.pump.pump(1)
    const ctx = h.lastAudioContext()
    ctx.state = 'suspended'
    const gate = deferred<void>()
    FakeAudioContext.resumeGate = gate.promise

    const el = document.querySelector('video') as HTMLVideoElement
    setMediaError(el, 3)
    // The recovery pauses, skips to 5, and is now held inside prepare().
    await vi.waitFor(() => expect(core.currentTime).toBeCloseTo(5, 5))
    setMediaError(el, 4)

    await vi.waitFor(() => expect(notices).toHaveLength(1))
    expect(notices[0]).toEqual({
      clipId: 'c1',
      code: 4,
      time: 2,
      terminal: true,
    })
    expect(core.currentTime).toBeCloseTo(2, 5)
    expect(core.isPlaying).toBe(false)

    gate.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(core.isPlaying).toBe(false)
    expect(notices).toHaveLength(1)
    expect(playingChanges[playingChanges.length - 1]).toBe(false)
    FakeAudioContext.resumeGate = null
    core.dispose()
  })

  it('does not emit a skip notice when an edit removes the clip during the resume', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { id: 'c1', mediaId: asset.id, start: 0, duration: 10, inPoint: 0 })
    // Keep the timeline non-empty so removing c1 does not end playback (and
    // bump the recovery epoch) before the pending resume returns.
    const secondTrack = createTrack('video', 2)
    doc.project.tracks.push(secondTrack)
    secondTrack.clips.push(
      createClip({ id: 'c2', mediaId: asset.id, start: 0, duration: 20, inPoint: 0 }),
    )
    const notices: (MediaErrorInfo | null)[] = []
    const { core } = makeCore(doc, {
      onMediaError: (info) => notices.push(info),
      nextKeyframe: async () => 5,
    })

    await core.play()
    await h.pump.pump(1)
    core.seek(2)
    await h.pump.pump(1)
    const ctx = h.lastAudioContext()
    ctx.state = 'suspended'
    const gate = deferred<void>()
    FakeAudioContext.resumeGate = gate.promise

    const el = document.querySelector('video') as HTMLVideoElement
    setMediaError(el, 3)
    // The recovery pauses, skips to 5, and is now held inside prepare().
    await vi.waitFor(() => expect(core.currentTime).toBeCloseTo(5, 5))

    // An ordinary edit deletes the clip while the resume is pending. The edit
    // refresh drops its record and clears its notice.
    doc.project.tracks[0].clips = []
    core.refresh(core.currentTime)
    expect(core['recoveryRecords'].has('c1')).toBe(false)
    expect(notices).toContainEqual(null)

    gate.resolve()
    await vi.waitFor(() => expect(core['recoveryInFlight']).toBeNull())
    expect(notices.some((n) => n?.clipId === 'c1' && n.skippedTo !== undefined)).toBe(false)
    FakeAudioContext.resumeGate = null
    core.dispose()
  })

  it('does not emit a stale skip notice when an edit retimes the clip during the resume', async () => {
    const { doc, asset } = makeDoc()
    const clip = addVideoClip(doc, {
      id: 'c1',
      mediaId: asset.id,
      start: 0,
      duration: 10,
      inPoint: 0,
    })
    const notices: (MediaErrorInfo | null)[] = []
    const { core } = makeCore(doc, {
      onMediaError: (info) => notices.push(info),
      nextKeyframe: async () => 5,
    })

    await core.play()
    await h.pump.pump(1)
    core.seek(2)
    await h.pump.pump(1)
    const ctx = h.lastAudioContext()
    ctx.state = 'suspended'
    const gate = deferred<void>()
    FakeAudioContext.resumeGate = gate.promise

    const el = document.querySelector('video') as HTMLVideoElement
    setMediaError(el, 3)
    await vi.waitFor(() => expect(core.currentTime).toBeCloseTo(5, 5))

    // Move the clip by two seconds. Timeline 5 now maps to source 3, not the
    // committed source 5, so the old failed range no longer describes it.
    clip.start = 2
    core.refresh(core.currentTime)
    expect(core['recoveryRecords'].has('c1')).toBe(true)

    gate.resolve()
    await vi.waitFor(() => expect(core['recoveryInFlight']).toBeNull())
    // The resumed sync respects the new mapping, and no stale range is shown.
    expect(el.currentTime).toBeCloseTo(3, 3)
    expect(notices.some((n) => n?.clipId === 'c1' && n.skippedTo !== undefined)).toBe(false)
    // The committed range and attempt budget belonged to the old mapping.
    expect(core['recoveryRecords'].has('c1')).toBe(false)
    FakeAudioContext.resumeGate = null
    core.dispose()
  })

  it('code 4 outside recovery stops, seeks to failedFrom, and does not reload', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { id: 'c1', mediaId: asset.id, start: 0, duration: 10, inPoint: 0 })
    const notices: (MediaErrorInfo | null)[] = []
    let lookups = 0
    const { core } = makeCore(doc, {
      onMediaError: (info) => notices.push(info),
      nextKeyframe: async () => {
        lookups++
        return 5
      },
    })

    core.seek(2)
    const el = document.querySelector('video') as HTMLVideoElement
    setMediaError(el, 4)

    await vi.waitFor(() => expect(notices).toHaveLength(1))
    expect(notices[0]).toEqual({
      clipId: 'c1',
      code: 4,
      time: 2,
      terminal: true,
    })
    expect(core.currentTime).toBeCloseTo(2, 5)
    expect(core.isPlaying).toBe(false)
    expect(lookups).toBe(0)
    core.dispose()
  })

  it('code 4 on an existing record preserves failedFrom and merges the range', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { id: 'c1', mediaId: asset.id, start: 0, duration: 10, inPoint: 0 })
    const notices: (MediaErrorInfo | null)[] = []
    const { core } = makeCore(doc, {
      onMediaError: (info) => notices.push(info),
      nextKeyframe: async () => 5,
    })

    core.seek(2)
    const el = document.querySelector('video') as HTMLVideoElement
    setMediaError(el, 3)
    await vi.waitFor(() => expect(notices).toHaveLength(1))
    expect(notices[0]?.terminal).toBe(false)

    setMediaError(el, 4)
    await vi.waitFor(() => expect(notices).toHaveLength(2))
    expect(notices[1]).toEqual({
      clipId: 'c1',
      code: 4,
      time: 2,
      terminal: true,
    })

    // The merged range still covers 3; only a seek outside 2..5 clears it.
    core.seek(3)
    expect(notices).toHaveLength(2)
    core.seek(6)
    expect(notices).toHaveLength(3)
    expect(notices[2]).toBeNull()
    core.dispose()
  })

  it('merges a reverse clip terminal range in timeline time', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, {
      id: 'c1',
      mediaId: asset.id,
      start: 0,
      duration: 10,
      inPoint: 0,
      reverse: true,
    })
    const notices: (MediaErrorInfo | null)[] = []
    const { core } = makeCore(doc, { onMediaError: (info) => notices.push(info) })

    core.seek(1)
    const el = core['pool'].peek('c1') as HTMLVideoElement
    setMediaError(el, 3)
    await vi.waitFor(() => expect(notices).toHaveLength(1))
    expect(notices[0]).toMatchObject({ time: 1, skippedTo: 7, terminal: false })
    expect(core['recoveryRecords'].get('c1')).toMatchObject({ failedFrom: 1, failedTo: 7 })

    // A code 4 later in timeline time, still inside the range, must not shrink
    // the recorded failure range.
    core.seek(6.5)
    setMediaError(el, 4)
    await vi.waitFor(() => expect(notices).toHaveLength(2))
    expect(notices[1]).toMatchObject({ time: 1, terminal: true })
    expect(core['recoveryRecords'].get('c1')?.failedTo).toBeCloseTo(7, 5)

    // 6.8 was inside the original 1..7 range, so the latch must survive.
    core.seek(6.8)
    expect(notices).toHaveLength(2)
    expect(core['recoveryRecords'].get('c1')?.terminal).toBe(true)
    core.dispose()
  })

  it('a terminal record keeps priority over a deferred overlapping clip', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { id: 'c1', mediaId: asset.id, start: 0, duration: 10, inPoint: 0 })
    const secondTrack = createTrack('video', 2)
    doc.project.tracks.push(secondTrack)
    secondTrack.clips.push(
      createClip({ id: 'c2', mediaId: asset.id, start: 0, duration: 10, inPoint: 0 }),
    )
    const gate = deferred<number | undefined>()
    const notices: (MediaErrorInfo | null)[] = []
    let lookups = 0
    const { core } = makeCore(doc, {
      onMediaError: (info) => notices.push(info),
      nextKeyframe: () => {
        lookups++
        if (lookups === 1) return gate.promise
        return Promise.resolve(8)
      },
    })

    core.seek(2)
    const videos = document.querySelectorAll('video')
    setMediaError(videos[0] as HTMLVideoElement, 3)
    await Promise.resolve()
    setMediaError(videos[1] as HTMLVideoElement, 3)
    setMediaError(videos[0] as HTMLVideoElement, 4)
    gate.resolve(5)

    await vi.waitFor(() => expect(notices).toHaveLength(1))
    expect(notices[0]).toEqual({
      clipId: 'c1',
      code: 4,
      time: 2,
      terminal: true,
    })
    expect(core.currentTime).toBeCloseTo(2, 5)
    expect(lookups).toBe(1)

    // Let the cancelled recovery release its lock before the user seeks.
    await new Promise((resolve) => setTimeout(resolve, 0))
    core.seek(6)
    await vi.waitFor(() => expect(notices).toHaveLength(3))
    expect(notices[1]).toBeNull()
    expect(notices[2]).toMatchObject({ clipId: 'c2', terminal: false })
    expect(core.currentTime).toBeCloseTo(8, 5)
    core.dispose()
  })

  it('does not replay a deferred error after its own recovery starts', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { id: 'c1', mediaId: asset.id, start: 0, duration: 10, inPoint: 0 })
    const long = createMediaAsset({
      kind: 'video',
      name: 'long.mp4',
      duration: 20,
      url: 'blob:long',
    })
    doc.media.push(long)
    doc.project.tracks[1].clips.push(
      createClip({
        id: 'c2',
        mediaId: long.id,
        start: 0,
        duration: 20,
        inPoint: 0,
        audioOnly: true,
      }),
    )
    const notices: (MediaErrorInfo | null)[] = []
    let loads = 0
    const { core } = makeCore(doc, {
      onMediaError: (info) => notices.push(info),
    })

    core.seek(2)
    const c1El = core['pool'].peek('c1') as HTMLVideoElement
    const c2El = core['pool'].peek('c2') as HTMLAudioElement
    c2El.load = () => {
      loads++
      // The media error survives the successful reload.
      Object.defineProperty(c2El, 'error', { configurable: true, value: { code: 3 } })
      c2El.dispatchEvent(new Event('loadedmetadata'))
    }

    // c1 terminalizes with no recovery in flight, so no recovery finally can
    // clear the queue. c2's error is then deferred behind the terminal.
    setMediaError(c1El, 4)
    await vi.waitFor(() => expect(notices).toHaveLength(1))
    expect(notices[0]).toMatchObject({ clipId: 'c1', terminal: true })
    setMediaError(c2El, 3)
    expect(core['deferredErrors'].size).toBe(1)

    // The seek clears the terminal and starts c2's recovery. The stale entry
    // must not start a second recovery after the first one drains.
    core.seek(4)
    await vi.waitFor(() => expect(loads).toBe(1))
    await new Promise((resolve) => setTimeout(resolve, 0))

    // The deferred error was handled once, in place: no timeline skip, no
    // damaged-media notice, and no second reload.
    const c2Notices = notices.filter((n) => n?.clipId === 'c2')
    expect(c2Notices).toHaveLength(0)
    expect(core.currentTime).toBeCloseTo(4, 5)
    expect(loads).toBe(1)
    expect(core['audioRecovery'].size).toBe(0)
    expect(core['deferredErrors'].size).toBe(0)
    core.dispose()
  })

  it('clears errors requeued by the terminal repaint', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { id: 'c1', mediaId: asset.id, start: 0, duration: 10, inPoint: 0 })
    const secondTrack = createTrack('video', 2)
    doc.project.tracks.push(secondTrack)
    secondTrack.clips.push(
      createClip({ id: 'c2', mediaId: asset.id, start: 0, duration: 10, inPoint: 0 }),
    )
    const notices: (MediaErrorInfo | null)[] = []
    const { core } = makeCore(doc, { onMediaError: (info) => notices.push(info) })

    core.seek(2)
    const first = core['pool'].peek('c1') as HTMLVideoElement
    const second = core['pool'].peek('c2') as HTMLVideoElement
    // The second element already carries an error, but its event was handled
    // before the terminal record existed, so it is not queued yet.
    Object.defineProperty(second, 'error', { configurable: true, value: { code: 3 } })

    // The terminal repaint encounters the second element and would queue it.
    setMediaError(first, 4)
    await vi.waitFor(() => expect(notices).toHaveLength(1))
    expect(notices[0]).toMatchObject({ clipId: 'c1', terminal: true })
    expect(core['deferredErrors'].size).toBe(0)
    core.dispose()
  })

  it('fallback exhaustion terminalizes before the reload', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { id: 'c1', mediaId: asset.id, start: 0, duration: 10, inPoint: 0 })
    const notices: (MediaErrorInfo | null)[] = []
    let loads = 0
    const { core } = makeCore(doc, {
      onMediaError: (info) => notices.push(info),
      nextKeyframe: async () => undefined,
    })

    core.seek(9.99)
    const el = document.querySelector('video') as HTMLVideoElement
    el.load = () => {
      loads++
    }
    setMediaError(el, 3)

    await vi.waitFor(() => expect(notices).toHaveLength(1))
    expect(notices[0]).toEqual({
      clipId: 'c1',
      code: 3,
      time: 9.99,
      terminal: true,
    })
    expect(loads).toBe(0)
    expect(core.currentTime).toBeCloseTo(9.99, 5)
    core.dispose()
  })

  it('a failed reload resumes on a fresh element and lets it recover', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { id: 'c1', mediaId: asset.id, start: 0, duration: 10, inPoint: 0 })
    const notices: (MediaErrorInfo | null)[] = []
    const { core } = makeCore(doc, {
      onMediaError: (info) => notices.push(info),
      nextKeyframe: async () => 5,
    })

    await core.play()
    await h.pump.pump(1)
    core.seek(2)
    await h.pump.pump(1)
    const el = document.querySelector('video') as HTMLVideoElement
    let loads = 0
    el.load = () => {
      loads++
      setMediaError(el, 3)
    }
    setMediaError(el, 3)

    await vi.waitFor(() => expect(loads).toBeGreaterThan(0))
    // The failed reload releases the old element and resumes playback; the
    // next sync creates a fresh element at the current read.
    await vi.waitFor(() => expect(core.isPlaying).toBe(true))
    const fresh = document.querySelector('video') as HTMLVideoElement
    expect(fresh).not.toBe(el)
    expect(document.body.contains(el)).toBe(false)
    expect(notices).toHaveLength(0)

    setMediaError(fresh, 3)
    await vi.waitFor(() => expect(notices).toHaveLength(1))
    expect(notices[0]?.terminal).toBe(false)
    expect(notices[0]?.skippedTo).toBeCloseTo(5, 5)
    expect(core.currentTime).toBeCloseTo(5, 5)
    core.dispose()
  })

  it('keeps the attempt budget across a resumed failed reload', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { id: 'c1', mediaId: asset.id, start: 0, duration: 10, inPoint: 0 })
    const notices: (MediaErrorInfo | null)[] = []
    const { core } = makeCore(doc, {
      onMediaError: (info) => notices.push(info),
      nextKeyframe: async () => 5,
    })

    await core.play()
    await h.pump.pump(1)
    core.seek(2)
    await h.pump.pump(1)
    const failReload = (): HTMLVideoElement => {
      const current = document.querySelector('video') as HTMLVideoElement
      current.load = () => setMediaError(current, 3)
      return current
    }

    let el = failReload()
    setMediaError(el, 3)

    // Each failed reload resumes; the fresh element then advances past
    // failedTo and errors again. The record must survive that advance.
    for (let i = 0; i < 2; i++) {
      await vi.waitFor(() => expect(core.isPlaying).toBe(true))
      h.lastAudioContext().currentTime += 0.1
      await h.pump.pump(1)
      el = failReload()
      setMediaError(el, 3)
    }

    await vi.waitFor(() => expect(core.isPlaying).toBe(true))
    h.lastAudioContext().currentTime += 0.1
    await h.pump.pump(1)
    el = document.querySelector('video') as HTMLVideoElement
    setMediaError(el, 3)

    // Three failed attempts are allowed; the fourth error is terminal and
    // keeps the first error position.
    await vi.waitFor(() => expect(notices).toHaveLength(1))
    expect(notices[0]).toMatchObject({
      clipId: 'c1',
      code: 3,
      terminal: true,
    })
    expect(notices[0]?.time).toBeCloseTo(2, 5)
    expect(core.isPlaying).toBe(false)
    core.dispose()
  })

  it('allows three attempts and terminalizes the fourth error', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { id: 'c1', mediaId: asset.id, start: 0, duration: 10, inPoint: 0 })
    const notices: (MediaErrorInfo | null)[] = []
    const { core } = makeCore(doc, {
      onMediaError: (info) => notices.push(info),
      nextKeyframe: async (_url, sourceTime) => sourceTime + 2,
    })

    core.seek(2)
    const el = document.querySelector('video') as HTMLVideoElement
    for (let i = 0; i < 3; i++) {
      setMediaError(el, 3)
      await vi.waitFor(() => expect(notices).toHaveLength(i + 1))
      expect(notices[i]?.terminal).toBe(false)
    }
    expect(core.currentTime).toBeCloseTo(8, 5)

    setMediaError(el, 3)
    await vi.waitFor(() => expect(notices).toHaveLength(4))
    expect(notices[3]).toEqual({
      clipId: 'c1',
      code: 3,
      time: 2,
      terminal: true,
    })
    expect(core.currentTime).toBeCloseTo(2, 5)
    core.dispose()
  })

  it('reads the proxy URL the element is actually using', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { id: 'c1', mediaId: asset.id, start: 0, duration: 10, inPoint: 0 })
    const urls: string[] = []
    const { core } = makeCore(doc, {
      resolveMediaUrl: () => 'blob:proxy',
      nextKeyframe: async (url) => {
        urls.push(url)
        return 5
      },
    })

    core.seek(2)
    const el = document.querySelector('video') as HTMLVideoElement
    expect(el.src).toContain('blob:proxy')
    setMediaError(el, 3)
    await vi.waitFor(() => expect(urls).toHaveLength(1))
    expect(urls[0]).toBe(el.src)
    core.dispose()
  })

  it('recovers an audio-only element in place and never moves the playhead', async () => {
    const { doc } = makeDoc()
    const audio = createMediaAsset({
      kind: 'audio',
      name: 'a.m4a',
      duration: 10,
      url: 'blob:audio',
    })
    doc.media.push(audio)
    doc.project.tracks[1].clips.push(
      createClip({ id: 'a1', mediaId: audio.id, start: 0, duration: 10, inPoint: 0 }),
    )
    const notices: (MediaErrorInfo | null)[] = []
    let lookups = 0
    const { core } = makeCore(doc, {
      onMediaError: (info) => notices.push(info),
      nextKeyframe: async () => {
        lookups++
        return 5
      },
    })

    await core.play()
    await h.pump.pump(1)
    core.pause()
    const before = core.currentTime
    const el = document.querySelector('audio') as HTMLAudioElement
    expect(el).toBeInstanceOf(HTMLAudioElement)
    setMediaError(el, 3)

    await vi.waitFor(() => expect(core['audioRecovery'].size).toBe(0))
    expect(lookups).toBe(0)
    expect(notices).toEqual([])
    expect(core.currentTime).toBeCloseTo(before, 5)
    expect(el.error).toBeNull()
    expect(el.currentTime).toBeCloseTo(before, 3)
    core.dispose()
  })

  it('mutes a repeatedly failing audio-only element without a timeline skip', async () => {
    const { doc } = makeDoc()
    const audio = createMediaAsset({
      kind: 'audio',
      name: 'a.m4a',
      duration: 10,
      url: 'blob:audio',
    })
    doc.media.push(audio)
    doc.project.tracks[1].clips.push(
      createClip({ id: 'a1', mediaId: audio.id, start: 0, duration: 10, inPoint: 0 }),
    )
    const notices: (MediaErrorInfo | null)[] = []
    const { core } = makeCore(doc, { onMediaError: (info) => notices.push(info) })

    await core.play()
    await h.pump.pump(1)
    core.pause()
    const before = core.currentTime
    const el = document.querySelector('audio') as HTMLAudioElement
    setMediaError(el, 3)
    await vi.waitFor(() => expect(core['audioRecovery'].size).toBe(0))
    setMediaError(el, 3)

    await vi.waitFor(() => expect(notices).toHaveLength(1))
    expect(notices[0]).toMatchObject({
      clipId: 'a1',
      time: before,
      terminal: false,
      audioOnly: true,
    })
    expect(core.currentTime).toBeCloseTo(before, 5)
    expect(core['failedAudioClips'].has('a1')).toBe(true)

    // A later paused repaint skips the muted clip instead of restarting it.
    core.refresh(before)
    expect(notices).toHaveLength(1)
    core.dispose()
  })

  it('recovers audio while a video recovery is in flight', async () => {
    const { doc, asset } = makeDoc()
    const audio = createMediaAsset({
      kind: 'audio',
      name: 'a.m4a',
      duration: 10,
      url: 'blob:audio',
    })
    doc.media.push(audio)
    addVideoClip(doc, { id: 'c1', mediaId: asset.id, start: 0, duration: 10, inPoint: 0 })
    doc.project.tracks[1].clips.push(
      createClip({ id: 'a1', mediaId: audio.id, start: 0, duration: 10, inPoint: 0 }),
    )
    const notices: (MediaErrorInfo | null)[] = []
    const keyframe = deferred<number | undefined>()
    const { core } = makeCore(doc, {
      onMediaError: (info) => notices.push(info),
      nextKeyframe: () => keyframe.promise,
    })

    // Playback materializes both elements; a paused still alone only builds
    // the video path for the picture.
    await core.play()
    await h.pump.pump(1)
    core.pause()
    core.seek(1)
    const video = core['pool'].peek('c1') as HTMLVideoElement
    const audioEl = core['pool'].peek('a1') as HTMLAudioElement
    setMediaError(video, 3)
    await vi.waitFor(() => expect(core['recoveryInFlight']).toBe('c1'))

    // Audio recovery must not join the video single-flight queue: the
    // picture recovery is still held, so a deferred audio error would never
    // reload. It retries in place and leaves the clock where it is.
    setMediaError(audioEl, 3)
    await vi.waitFor(() => expect(core['audioRecovery'].size).toBe(0))

    expect(core['recoveryInFlight']).toBe('c1')
    expect(core['deferredErrors'].has('a1')).toBe(false)
    expect(audioEl.error).toBeNull()
    expect(notices).toEqual([])
    expect(core.currentTime).toBeCloseTo(1, 5)

    keyframe.resolve(5)
    await vi.waitFor(() => expect(notices).toHaveLength(1))
    expect(notices[0]).toMatchObject({ clipId: 'c1', skippedTo: 5, terminal: false })
    core.dispose()
  })

  it('clears a committed skip notice when playback reaches the timeline end', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { id: 'c1', mediaId: asset.id, start: 0, duration: 10, inPoint: 0 })
    const notices: (MediaErrorInfo | null)[] = []
    const { core } = makeCore(doc, {
      onMediaError: (info) => notices.push(info),
      nextKeyframe: async () => 9.5,
    })

    await core.play()
    await h.pump.pump(1)
    h.lastAudioContext().currentTime = 9
    await h.pump.pump(1)
    const el = document.querySelector('video') as HTMLVideoElement
    setMediaError(el, 3)

    await vi.waitFor(() => expect(notices).toHaveLength(1))
    expect(core.isPlaying).toBe(true)
    expect(core.currentTime).toBeCloseTo(9.5, 5)

    // The end is inside the one-second linger window. Playback stops there,
    // so the final sync has to clear the committed notice.
    h.lastAudioContext().currentTime = 10
    await h.pump.pump(1)
    await vi.waitFor(() => expect(notices).toContainEqual(null))
    expect(core.isPlaying).toBe(false)
    expect(core.currentTime).toBeCloseTo(10, 5)
    expect(core['recoveryRecords'].has('c1')).toBe(false)
    core.dispose()
  })

  it('mutes an unsupported audio source without retrying it', async () => {
    const { doc } = makeDoc()
    const audio = createMediaAsset({
      kind: 'audio',
      name: 'a.m4a',
      duration: 10,
      url: 'blob:audio',
    })
    doc.media.push(audio)
    doc.project.tracks[1].clips.push(
      createClip({ id: 'a1', mediaId: audio.id, start: 0, duration: 10, inPoint: 0 }),
    )
    const notices: (MediaErrorInfo | null)[] = []
    const { core } = makeCore(doc, { onMediaError: (info) => notices.push(info) })

    await core.play()
    await h.pump.pump(1)
    core.pause()
    const el = document.querySelector('audio') as HTMLAudioElement
    const load = vi.spyOn(el, 'load')
    setMediaError(el, 4)

    await vi.waitFor(() => expect(notices).toHaveLength(1))
    expect(notices[0]).toMatchObject({
      clipId: 'a1',
      code: 4,
      terminal: false,
      audioOnly: true,
    })
    expect(load).not.toHaveBeenCalled()
    expect(core['audioRecovery'].size).toBe(0)
    expect(core['failedAudioClips'].has('a1')).toBe(true)
    core.dispose()
  })

  it('stays paused at the sequence end instead of restarting at zero', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { id: 'c1', mediaId: asset.id, start: 0, duration: 10, inPoint: 0 })
    const notices: (MediaErrorInfo | null)[] = []
    const { core } = makeCore(doc, {
      onMediaError: (info) => notices.push(info),
      nextKeyframe: async () => 10,
    })

    await core.play()
    await h.pump.pump(1)
    core.seek(9.5)
    await h.pump.pump(1)
    const el = document.querySelector('video') as HTMLVideoElement
    setMediaError(el, 3)

    await vi.waitFor(() => expect(notices).toHaveLength(1))
    expect(core.isPlaying).toBe(false)
    expect(core.currentTime).toBeCloseTo(10, 5)
    core.dispose()
  })

  it('project replacement clears the latch and overlay, while an ordinary edit does not', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { id: 'c1', mediaId: asset.id, start: 0, duration: 10, inPoint: 0 })
    let epoch = 0
    const notices: (MediaErrorInfo | null)[] = []
    const { core } = makeCore(doc, {
      getProjectEpoch: () => epoch,
      onMediaError: (info) => notices.push(info),
    })

    core.seek(2)
    const el = document.querySelector('video') as HTMLVideoElement
    setMediaError(el, 4)
    await vi.waitFor(() => expect(notices).toHaveLength(1))
    expect(notices[0]?.terminal).toBe(true)

    // An ordinary command clones the doc but leaves the epoch alone.
    doc.project.tracks[0].clips[0].opacity = 0.5
    core.refresh(2)
    expect(notices).toHaveLength(1)

    // Project replacement changes the epoch and removes the old clip.
    doc.project.tracks[0].clips = []
    epoch = 1
    core.refresh(0)
    expect(notices[notices.length - 1]).toBeNull()
    core.dispose()
  })

  it('project replacement clears the deferred error queue', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { id: 'c1', mediaId: asset.id, start: 0, duration: 10, inPoint: 0 })
    const secondTrack = createTrack('video', 2)
    doc.project.tracks.push(secondTrack)
    secondTrack.clips.push(
      createClip({ id: 'c2', mediaId: asset.id, start: 0, duration: 10, inPoint: 0 }),
    )
    let epoch = 0
    const notices: (MediaErrorInfo | null)[] = []
    const { core } = makeCore(doc, {
      getProjectEpoch: () => epoch,
      onMediaError: (info) => notices.push(info),
    })

    core.seek(2)
    const videos = document.querySelectorAll('video')
    setMediaError(videos[0] as HTMLVideoElement, 4)
    await vi.waitFor(() => expect(notices).toHaveLength(1))
    setMediaError(videos[1] as HTMLVideoElement, 3)
    expect(core['deferredErrors'].size).toBe(1)

    // Project replacement drops the old clips and their deferred entry.
    doc.project.tracks[0].clips = []
    secondTrack.clips = []
    epoch = 1
    core.refresh(0)
    expect(core['deferredErrors'].size).toBe(0)
    core.dispose()
  })

  it('recovers a new project error queued behind a stale recovery', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { id: 'c1', mediaId: asset.id, start: 0, duration: 10, inPoint: 0 })
    let epoch = 0
    const gate = deferred<number | undefined>()
    const notices: (MediaErrorInfo | null)[] = []
    let lookups = 0
    const { core } = makeCore(doc, {
      getProjectEpoch: () => epoch,
      onMediaError: (info) => notices.push(info),
      nextKeyframe: () => {
        lookups++
        return lookups === 1 ? gate.promise : Promise.resolve(undefined)
      },
    })

    core.seek(2)
    const oldEl = core['pool'].peek('c1') as HTMLVideoElement
    setMediaError(oldEl, 3)
    await vi.waitFor(() => expect(core['recoveryInFlight']).toBe('c1'))
    expect(lookups).toBe(1)

    // Replace the project while the old recovery is still awaiting the lookup.
    const next = createDoc()
    next.media.push(asset)
    next.project.tracks[0].clips.push(
      createClip({ id: 'c2', mediaId: asset.id, start: 0, duration: 10, inPoint: 0 }),
    )
    doc.media = next.media
    doc.project = next.project
    epoch = 1
    core.refresh(0)

    const newEl = core['pool'].peek('c2') as HTMLVideoElement
    expect(newEl).toBeDefined()
    setMediaError(newEl, 3)
    expect(core['deferredErrors'].size).toBe(1)

    // The stale recovery must hand the queued error to the new project.
    gate.resolve(5)
    await vi.waitFor(() =>
      expect(notices.some((n) => n?.clipId === 'c2' && n.terminal === false)).toBe(true),
    )
    expect(lookups).toBe(2)
    expect(core.currentTime).toBeCloseTo(6, 5)
    core.dispose()
  })

  it('re-syncs a same-id clip after the project changes', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { id: 'c1', mediaId: asset.id, start: 0, duration: 10, inPoint: 0 })
    let epoch = 0
    const gate = deferred<number | undefined>()
    const notices: (MediaErrorInfo | null)[] = []
    let lookups = 0
    const { core } = makeCore(doc, {
      getProjectEpoch: () => epoch,
      onMediaError: (info) => notices.push(info),
      nextKeyframe: () => {
        lookups++
        return lookups === 1 ? gate.promise : Promise.resolve(undefined)
      },
    })

    core.seek(2)
    const el = core['pool'].peek('c1') as HTMLVideoElement
    setMediaError(el, 3)
    await vi.waitFor(() => expect(core['recoveryInFlight']).toBe('c1'))

    // Reopen a project that reuses c1 and its source.
    const next = createDoc()
    next.media.push(asset)
    next.project.tracks[0].clips.push(
      createClip({ id: 'c1', mediaId: asset.id, start: 0, duration: 10, inPoint: 0 }),
    )
    doc.media = next.media
    doc.project = next.project
    epoch = 1
    core.refresh(0)

    // The refresh must still inspect the clip even though the stale recovery
    // still names c1, and queue its error for the new project.
    expect(core['pool'].peek('c1')).toBe(el)
    expect(core['deferredErrors'].size).toBe(1)

    gate.resolve(5)
    await vi.waitFor(() =>
      expect(notices.some((n) => n?.clipId === 'c1' && n.terminal === false)).toBe(true),
    )
    expect(lookups).toBe(2)
    expect(core.currentTime).toBeCloseTo(6, 5)
    core.dispose()
  })

  it('a pause during a replaced project discards the deferred error', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { id: 'c1', mediaId: asset.id, start: 0, duration: 10, inPoint: 0 })
    let epoch = 0
    const gate = deferred<number | undefined>()
    const notices: (MediaErrorInfo | null)[] = []
    let lookups = 0
    const { core } = makeCore(doc, {
      getProjectEpoch: () => epoch,
      onMediaError: (info) => notices.push(info),
      nextKeyframe: () => {
        lookups++
        return lookups === 1 ? gate.promise : Promise.resolve(undefined)
      },
    })

    core.seek(2)
    const el = core['pool'].peek('c1') as HTMLVideoElement
    setMediaError(el, 3)
    await vi.waitFor(() => expect(core['recoveryInFlight']).toBe('c1'))

    // The user pauses, then opens a project that reuses c1 and its source.
    core.pause()
    const next = createDoc()
    next.media.push(asset)
    next.project.tracks[0].clips.push(
      createClip({ id: 'c1', mediaId: asset.id, start: 0, duration: 10, inPoint: 0 }),
    )
    doc.media = next.media
    doc.project = next.project
    epoch = 1
    core.refresh(0)
    expect(core['deferredErrors'].size).toBe(1)

    gate.resolve(5)
    await vi.waitFor(() => expect(core['recoveryInFlight']).toBeNull())
    await new Promise((resolve) => setTimeout(resolve, 0))

    // The pause owns the cancellation: the stale recovery must not start a
    // new recovery for the replaced project.
    expect(lookups).toBe(1)
    expect(notices.some((n) => n?.clipId === 'c1' && n.terminal === false)).toBe(false)
    expect(core['deferredErrors'].size).toBe(0)

    // A later refresh rediscovers the error.
    core.refresh(0)
    await vi.waitFor(() =>
      expect(notices.some((n) => n?.clipId === 'c1' && n.terminal === false)).toBe(true),
    )
    expect(lookups).toBe(2)
    core.dispose()
  })

  it('terminalizes an in-flight code 4 even when the record is gone', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { id: 'c1', mediaId: asset.id, start: 0, duration: 10, inPoint: 0 })
    const gate = deferred<number | undefined>()
    const notices: (MediaErrorInfo | null)[] = []
    const { core } = makeCore(doc, {
      onMediaError: (info) => notices.push(info),
      nextKeyframe: () => gate.promise,
    })

    core.seek(2)
    const el = core['pool'].peek('c1') as HTMLVideoElement
    setMediaError(el, 3)
    await vi.waitFor(() => expect(core['recoveryInFlight']).toBe('c1'))
    core['recoveryRecords'].delete('c1')

    setMediaError(el, 4)
    await vi.waitFor(() => expect(notices).toHaveLength(1))
    expect(notices[0]).toMatchObject({ clipId: 'c1', code: 4, terminal: true })

    gate.resolve(5)
    await vi.waitFor(() => expect(core['recoveryInFlight']).toBeNull())
    core.dispose()
  })

  it('recovers a same-clip error after a seek during recovery', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { id: 'c1', mediaId: asset.id, start: 0, duration: 10, inPoint: 0 })
    const gate = deferred<number | undefined>()
    const notices: (MediaErrorInfo | null)[] = []
    let lookups = 0
    const { core } = makeCore(doc, {
      onMediaError: (info) => notices.push(info),
      nextKeyframe: () => {
        lookups++
        return lookups === 1 ? gate.promise : Promise.resolve(undefined)
      },
    })

    core.seek(2)
    const oldEl = core['pool'].peek('c1') as HTMLVideoElement
    setMediaError(oldEl, 3)
    await vi.waitFor(() => expect(core['recoveryInFlight']).toBe('c1'))

    // Seek past the failed range: the old element is released and a fresh one
    // is created at the new position while the stale recovery still awaits.
    core.seek(6)
    const newEl = core['pool'].peek('c1') as HTMLVideoElement
    expect(newEl).not.toBe(oldEl)
    setMediaError(newEl, 3)
    expect(core['deferredErrors'].size).toBe(1)

    gate.resolve(5)
    await vi.waitFor(() =>
      expect(notices.some((n) => n?.clipId === 'c1' && n.terminal === false)).toBe(true),
    )
    expect(lookups).toBe(2)
    core.dispose()
  })

  it('releases the recovery lock and reports an unexpected failure', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { id: 'c1', mediaId: asset.id, start: 0, duration: 10, inPoint: 0 })
    const calls: (MediaErrorInfo | null)[] = []
    const boom = new Error('boom')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const { core } = makeCore(doc, {
        onMediaError: (info) => {
          calls.push(info)
          if (info?.skippedTo !== undefined) throw boom
        },
        nextKeyframe: async () => 5,
      })

      core.seek(2)
      const el = core['pool'].peek('c1') as HTMLVideoElement
      setMediaError(el, 3)
      await vi.waitFor(() => expect(core['recoveryInFlight']).toBeNull())
      expect(calls.some((info) => info?.skippedTo !== undefined)).toBe(true)
      expect(errorSpy).toHaveBeenCalledWith('[playback] decode recovery failed', 'c1', boom)
      core.dispose()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('does not resolve a terminal element for the compositor', async () => {
    const { doc, asset } = makeDoc()
    const clip = addVideoClip(doc, {
      id: 'c1',
      mediaId: asset.id,
      start: 0,
      duration: 10,
      inPoint: 0,
    })
    const notices: (MediaErrorInfo | null)[] = []
    const { core } = makeCore(doc, { onMediaError: (info) => notices.push(info) })

    core.seek(2)
    const el = core['pool'].peek('c1') as HTMLVideoElement
    primeVideoElement(el)
    setMediaError(el, 4)
    await vi.waitFor(() => expect(notices).toHaveLength(1))

    const resolved = core['resolveClip'](clip, 0)
    expect(resolved?.el).toBeUndefined()
    core.dispose()
  })

  it('releases the blend partner when the primary terminalizes', async () => {
    const { doc, asset } = makeDoc()
    const clip = addVideoClip(doc, {
      id: 'c1',
      mediaId: asset.id,
      start: 0,
      duration: 4,
      inPoint: 0,
      speed: 0.5,
    })
    const notices: (MediaErrorInfo | null)[] = []
    const { core } = makeCore(doc, { onMediaError: (info) => notices.push(info) })

    core.seek(0)
    const partner = core['pool'].peekNext(clip.id) as HTMLVideoElement
    expect(partner).toBeDefined()
    const primary = core['pool'].peek(clip.id) as HTMLVideoElement
    setMediaError(primary, 4)
    await vi.waitFor(() => expect(notices).toHaveLength(1))

    expect(core['pool'].peekNext(clip.id)).toBeUndefined()
    expect(document.body.contains(partner)).toBe(false)
    core.dispose()
  })

  it('pauses a failed blend partner', async () => {
    const { doc, asset } = makeDoc()
    const clip = addVideoClip(doc, {
      id: 'c1',
      mediaId: asset.id,
      start: 0,
      duration: 4,
      inPoint: 0,
      speed: 0.5,
    })
    const { core } = makeCore(doc)

    core.seek(0)
    const partner = core['pool'].peekNext(clip.id) as HTMLVideoElement
    expect(partner).toBeDefined()
    await partner.play()
    expect(partner.paused).toBe(false)

    setMediaError(partner, 4)
    expect(partner.paused).toBe(true)
    core.dispose()
  })

  it('paints the terminal frame after a paused repaint, not the pre-error time', () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { id: 'c1', mediaId: asset.id, start: 0, duration: 10, inPoint: 0 })
    const { core } = makeCore(doc)

    core.seek(2)
    const el = core['pool'].peek('c1') as HTMLVideoElement
    // A record whose failedFrom is behind the current playhead: the terminal
    // path must move the playhead back to 0 and repaint there.
    core['recoveryRecords'].set('c1', {
      attempts: 1,
      failedFrom: 0,
      failedTo: 0,
      terminal: false,
      committed: false,
    })
    // Set the error without dispatching: this is the paused drawStill path,
    // not the pool listener path.
    Object.defineProperty(el, 'error', {
      configurable: true,
      value: { code: 4, message: 'bad' },
    })
    const renderSpy = vi.spyOn(core as unknown as { render: (t: number) => void }, 'render')

    core.refresh(2)

    expect(core.currentTime).toBeCloseTo(0, 5)
    expect(core['terminalElements'].has(el)).toBe(true)
    expect(renderSpy).toHaveBeenLastCalledWith(0)
    renderSpy.mockRestore()
    core.dispose()
  })

  it('drops terminal recovery state when its clip is deleted', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { id: 'c1', mediaId: asset.id, start: 0, duration: 10, inPoint: 0 })
    const notices: (MediaErrorInfo | null)[] = []
    const { core } = makeCore(doc, { onMediaError: (info) => notices.push(info) })

    core.seek(2)
    const el = core['pool'].peek('c1') as HTMLVideoElement
    setMediaError(el, 4)
    await vi.waitFor(() => expect(notices).toHaveLength(1))
    expect(core['recoveryRecords'].has('c1')).toBe(true)

    doc.project.tracks[0].clips = []
    core.refresh(0)

    expect(core['recoveryRecords'].has('c1')).toBe(false)
    expect(core['noticeRanges'].has('c1')).toBe(false)
    expect(notices[notices.length - 1]).toBeNull()
    core.dispose()
  })

  it('drops a deferred error when its clip is deleted', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { id: 'c1', mediaId: asset.id, start: 0, duration: 10, inPoint: 0 })
    const secondTrack = createTrack('video', 2)
    doc.project.tracks.push(secondTrack)
    secondTrack.clips.push(
      createClip({ id: 'c2', mediaId: asset.id, start: 0, duration: 10, inPoint: 0 }),
    )
    const gate = deferred<number | undefined>()
    const { core } = makeCore(doc, { nextKeyframe: () => gate.promise })

    core.seek(0)
    const first = core['pool'].peek('c1') as HTMLVideoElement
    const second = core['pool'].peek('c2') as HTMLVideoElement
    setMediaError(first, 3)
    await vi.waitFor(() => expect(core['recoveryInFlight']).toBe('c1'))
    setMediaError(second, 3)
    expect(core['deferredErrors'].has('c2')).toBe(true)

    secondTrack.clips = []
    core.refresh(0)
    expect(core['deferredErrors'].has('c2')).toBe(false)

    gate.resolve(5)
    await vi.waitFor(() => expect(core['recoveryInFlight']).toBeNull())
    core.dispose()
  })

  it('a blend-partner error latches without pausing, seeking, or reporting', async () => {
    const { doc, asset } = makeDoc()
    const clip = addVideoClip(doc, {
      id: 'c1',
      mediaId: asset.id,
      start: 0,
      duration: 4,
      inPoint: 0,
      speed: 0.5,
    })
    const notices: (MediaErrorInfo | null)[] = []
    const { core } = makeCore(doc, { onMediaError: (info) => notices.push(info) })

    await core.play()
    await h.pump.pump(1)
    const partner = core['pool'].peekNext(clip.id) as HTMLVideoElement
    expect(partner).toBeDefined()
    const time = core.currentTime
    setMediaError(partner, 3)
    await Promise.resolve()

    expect(core.isPlaying).toBe(true)
    expect(core.currentTime).toBe(time)
    expect(notices).toHaveLength(0)
    core.dispose()
  })

  it('ignores an error from an element that is no longer pooled', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { id: 'c1', mediaId: asset.id, start: 0, duration: 10, inPoint: 0 })
    const notices: (MediaErrorInfo | null)[] = []
    const { core } = makeCore(doc, { onMediaError: (info) => notices.push(info) })

    core.seek(2)
    const el = document.querySelector('video') as HTMLVideoElement
    core['pool'].release('c1')
    setMediaError(el, 3)
    await Promise.resolve()

    expect(notices).toHaveLength(0)
    expect(core.currentTime).toBe(2)
    core.dispose()
  })

  it('a refresh during the reload wait does not reposition the recovering element', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { id: 'c1', mediaId: asset.id, start: 0, duration: 10, inPoint: 0 })
    const notices: (MediaErrorInfo | null)[] = []
    const { core } = makeCore(doc, {
      onMediaError: (info) => notices.push(info),
      nextKeyframe: async () => 5,
    })

    core.seek(2)
    const el = document.querySelector('video') as HTMLVideoElement
    let loads = 0
    el.load = () => {
      loads++
      Object.defineProperty(el, 'error', { configurable: true, value: null })
    }
    setMediaError(el, 3)
    await vi.waitFor(() => expect(loads).toBe(1))

    let writes = 0
    let pos = el.currentTime
    Object.defineProperty(el, 'currentTime', {
      configurable: true,
      get: () => pos,
      set: (v: number) => {
        writes++
        pos = v
      },
    })

    core.refresh(2)
    expect(writes).toBe(0)

    el.dispatchEvent(new Event('loadedmetadata'))
    await vi.waitFor(() => expect(notices).toHaveLength(1))
    expect(writes).toBe(1)
    expect(pos).toBeGreaterThanOrEqual(5)
    expect(notices[0]?.terminal).toBe(false)
    core.dispose()
  })

  it('a code 4 during the reload wait terminalizes and never resumes', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { id: 'c1', mediaId: asset.id, start: 0, duration: 10, inPoint: 0 })
    const notices: (MediaErrorInfo | null)[] = []
    const { core } = makeCore(doc, {
      onMediaError: (info) => notices.push(info),
      nextKeyframe: async () => 5,
    })

    core.seek(2)
    const el = document.querySelector('video') as HTMLVideoElement
    let loads = 0
    el.load = () => {
      loads++
      Object.defineProperty(el, 'error', { configurable: true, value: null })
    }
    setMediaError(el, 3)
    await vi.waitFor(() => expect(loads).toBe(1))

    setMediaError(el, 4)
    await vi.waitFor(() => expect(notices).toHaveLength(1))
    expect(notices[0]).toEqual({
      clipId: 'c1',
      code: 4,
      time: 2,
      terminal: true,
    })
    el.dispatchEvent(new Event('loadedmetadata'))
    await Promise.resolve()
    await Promise.resolve()
    expect(notices).toHaveLength(1)
    expect(core.currentTime).toBeCloseTo(2, 5)
    core.dispose()
  })

  it('a reversed clip uses a source-time fallback', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, {
      id: 'c1',
      mediaId: asset.id,
      start: 0,
      duration: 4,
      inPoint: 0,
      reverse: true,
    })
    const notices: (MediaErrorInfo | null)[] = []
    let lookups = 0
    const { core } = makeCore(doc, {
      onMediaError: (info) => notices.push(info),
      nextKeyframe: async () => {
        lookups++
        return 2
      },
    })

    core.seek(1)
    const el = document.querySelector('video') as HTMLVideoElement
    setMediaError(el, 3)
    await vi.waitFor(() => expect(notices).toHaveLength(1))

    expect(lookups).toBe(0)
    expect(notices[0]).toMatchObject({
      clipId: 'c1',
      time: 1,
      skippedTo: 4,
      terminal: false,
    })
    expect(core.currentTime).toBeCloseTo(4, 5)
    core.dispose()
  })

  it('clears a committed reverse-clip record as timeline time passes failedTo', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, {
      id: 'c1',
      mediaId: asset.id,
      start: 0,
      duration: 10,
      inPoint: 0,
      reverse: true,
    })
    const notices: (MediaErrorInfo | null)[] = []
    const { core } = makeCore(doc, {
      onMediaError: (info) => notices.push(info),
    })

    core.seek(1)
    let el = document.querySelector('video') as HTMLVideoElement
    setMediaError(el, 3)
    await vi.waitFor(() => expect(notices).toHaveLength(1))
    expect(notices[0]).toMatchObject({
      clipId: 'c1',
      time: 1,
      skippedTo: 7,
      terminal: false,
    })
    expect(core['recoveryRecords'].get('c1')?.committed).toBe(true)

    // The timeline still advances toward larger sequence times on a reverse
    // clip, so passing failedTo clears the committed record.
    await core.play()
    h.lastAudioContext().currentTime += 1.5
    await h.pump.pump(1)
    expect(core.currentTime).toBeCloseTo(8.5, 5)
    expect(core['recoveryRecords'].has('c1')).toBe(false)
    expect(notices[notices.length - 1]).toBeNull()

    // A later error starts a fresh attempt budget instead of inheriting the
    // old one.
    el = document.querySelector('video') as HTMLVideoElement
    setMediaError(el, 3)
    await vi.waitFor(() => expect(notices).toHaveLength(3))
    expect(notices[2]?.terminal).toBe(false)
    expect(notices[2]?.time).toBeCloseTo(8.5, 5)
    expect(core['recoveryRecords'].get('c1')?.attempts).toBe(1)
    core.dispose()
  })

  it('a ramped clip crosses six seconds of source, not six of timeline', async () => {
    const { doc, asset } = makeDoc()
    const clip = addVideoClip(doc, {
      id: 'c1',
      mediaId: asset.id,
      start: 0,
      duration: 10,
      inPoint: 0,
      keyframes: {
        timeScale: [
          { time: 0, value: 0.5 },
          { time: 10, value: 1 },
        ],
      },
    })
    const notices: (MediaErrorInfo | null)[] = []
    let lookups = 0
    const { core } = makeCore(doc, {
      onMediaError: (info) => notices.push(info),
      nextKeyframe: async () => {
        lookups++
        return 5
      },
    })

    core.seek(1)
    const el = document.querySelector('video') as HTMLVideoElement
    setMediaError(el, 3)
    await vi.waitFor(() => expect(notices).toHaveLength(1))

    expect(lookups).toBe(0)
    const skippedTo = notices[0]?.skippedTo ?? 0
    const sourceAtSkip = sourceTimeAt(clip, skippedTo - clip.start)
    expect(sourceAtSkip).toBeCloseTo(0.525 + 6, 4)
    core.dispose()
  })

  it('a doc edit that moves the clip away during the lookup bails without a notice', async () => {
    const { doc, asset } = makeDoc()
    const clip = addVideoClip(doc, {
      id: 'c1',
      mediaId: asset.id,
      start: 0,
      duration: 10,
      inPoint: 0,
    })
    const gate = deferred<number | undefined>()
    const notices: (MediaErrorInfo | null)[] = []
    const { core } = makeCore(doc, {
      onMediaError: (info) => notices.push(info),
      nextKeyframe: () => gate.promise,
    })

    core.seek(2)
    const el = document.querySelector('video') as HTMLVideoElement
    setMediaError(el, 3)
    await Promise.resolve()
    clip.start = 20
    gate.resolve(5)
    await Promise.resolve()
    await Promise.resolve()

    expect(notices).toHaveLength(0)
    expect(core.currentTime).toBe(2)
    core.dispose()
  })

  it('does not re-seek a paused element already within the start threshold', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { id: 'c1', mediaId: asset.id, start: 0, duration: 10, inPoint: 0 })
    const { core } = makeCore(doc)

    core.seek(2)
    const el = document.querySelector('video') as HTMLVideoElement
    let writes = 0
    let pos = 2.04
    Object.defineProperty(el, 'currentTime', {
      configurable: true,
      get: () => pos,
      set: (v: number) => {
        writes++
        pos = v
      },
    })

    await core.play()
    // 0.04 s is inside the start threshold: the clock can start without a
    // decode that would blank the monitor or delay the linked audio twin.
    expect(writes).toBe(0)
    expect(el.paused).toBe(false)
    core.dispose()
  })

  it('warms the active element before starting the clock', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { id: 'c1', mediaId: asset.id, start: 0, duration: 10, inPoint: 0 })
    const source: ScrubFrameSource = {
      hasSink: () => false,
      peek: () => undefined,
      request: vi.fn(),
      releaseClip: vi.fn(),
      releaseAsset: vi.fn(),
      reset: vi.fn(),
      dispose: vi.fn(),
      onFallback: () => () => undefined,
    }
    const { core } = makeCore(doc, { createScrubSource: () => source })
    core.seek(1)
    const el = document.querySelector('video') as HTMLVideoElement
    // A paused scrub can leave the element behind the playhead. Play must wait
    // for it instead of starting the audio clock against a black canvas.
    Object.defineProperty(el, 'currentTime', {
      configurable: true,
      get: () => 0,
      set: () => undefined,
    })
    Object.defineProperty(el, 'readyState', { configurable: true, value: 0 })
    Object.defineProperty(el, 'seeking', { configurable: true, value: false })

    const playPromise = core.play()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(core.isPlaying).toBe(false)

    el.dispatchEvent(new Event('canplay'))
    await playPromise
    expect(core.isPlaying).toBe(true)
    core.dispose()
  })

  it('corrects a stale in-flight seek before starting the clock', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { id: 'c1', mediaId: asset.id, start: 0, duration: 10, inPoint: 0 })
    const source: ScrubFrameSource = {
      hasSink: () => false,
      peek: () => undefined,
      request: vi.fn(),
      releaseClip: vi.fn(),
      releaseAsset: vi.fn(),
      reset: vi.fn(),
      dispose: vi.fn(),
      onFallback: () => () => undefined,
    }
    const { core } = makeCore(doc, { createScrubSource: () => source })
    core.seek(1)
    const el = document.querySelector('video') as HTMLVideoElement
    let pos = 0
    let seeking = true
    let writes = 0
    Object.defineProperty(el, 'currentTime', {
      configurable: true,
      get: () => pos,
      set: (v: number) => {
        writes++
        pos = v
        seeking = true
      },
    })
    Object.defineProperty(el, 'seeking', { configurable: true, get: () => seeking })
    Object.defineProperty(el, 'readyState', { configurable: true, value: 2 })

    const playPromise = core.play()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(core.isPlaying).toBe(false)
    expect(writes).toBe(0)

    // The stale seek lands at 0, away from the playhead at 1. Play must issue
    // one corrective seek and wait for it before the clock starts.
    seeking = false
    el.dispatchEvent(new Event('seeked'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(writes).toBe(1)
    expect(core.isPlaying).toBe(false)

    seeking = false
    el.dispatchEvent(new Event('seeked'))
    await playPromise
    expect(core.isPlaying).toBe(true)
    core.dispose()
  })

  it('does not reassign currentTime when play starts at the parked position', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { id: 'c1', mediaId: asset.id, start: 0, duration: 10, inPoint: 0 })
    const { core } = makeCore(doc)

    core.seek(2)
    const el = document.querySelector('video') as HTMLVideoElement
    let writes = 0
    let pos = el.currentTime
    Object.defineProperty(el, 'currentTime', {
      configurable: true,
      get: () => pos,
      set: (v: number) => {
        writes++
        pos = v
      },
    })

    await core.play()
    expect(writes).toBe(0)

    pos = 3
    core.pause()
    await core.play()
    expect(writes).toBe(1)
    core.dispose()
  })

  it('terminalizes when the skip seek cannot be applied', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { id: 'c1', mediaId: asset.id, start: 0, duration: 10, inPoint: 0 })
    const notices: (MediaErrorInfo | null)[] = []
    const { core } = makeCore(doc, {
      onMediaError: (info) => notices.push(info),
      nextKeyframe: async () => 5,
    })

    core.seek(2)
    const el = document.querySelector('video') as HTMLVideoElement
    Object.defineProperty(el, 'currentTime', {
      configurable: true,
      get: () => 2.0001,
      set: () => {
        throw new Error('seek refused')
      },
    })
    setMediaError(el, 3)

    await vi.waitFor(() => expect(notices).toHaveLength(1))
    expect(notices[0]).toEqual({
      clipId: 'c1',
      code: 3,
      time: 2,
      terminal: true,
    })
    expect(core.currentTime).toBeCloseTo(2, 5)
    core.dispose()
  })

  it('keeps terminalization in the shared helper and uses the marker inverse', () => {
    const source = readFileSync('src/lib/editor/playback/core.ts', 'utf8')
    expect(source.match(/record\.terminal = true/g)).toHaveLength(1)
    expect(source).toContain('private terminalizeRecovery(')
    expect(source).toContain('clampedClipLocalTime(')
    expect(source.match(/terminalizeRecovery\(/g)?.length ?? 0).toBeGreaterThanOrEqual(5)
  })
})

describe('paused preview recovery (mocked browser)', () => {
  it('retries play when a seek never leaves the seeking state', async () => {
    const { doc, asset } = makeDoc()
    const clip = addVideoClip(doc, {
      id: 'c1',
      mediaId: asset.id,
      start: 0,
      duration: 10,
      inPoint: 0,
    })
    const { core } = makeCore(doc, { createScrubSource: () => scrubSource() })
    core.seek(0)
    const el = core['pool'].peek(clip.id) as HTMLVideoElement
    primeVideoElement(el)
    Object.defineProperty(el, 'seeking', { configurable: true, get: () => true })
    Object.defineProperty(el, 'currentTime', {
      configurable: true,
      get: () => 0,
      set: () => undefined,
    })
    const playSpy = vi.spyOn(el, 'play')

    await core.play()
    await h.pump.pump(1)
    const playsBefore = playSpy.mock.calls.length
    await vi.waitFor(
      async () => {
        await h.pump.pump(1)
        expect(playSpy.mock.calls.length).toBeGreaterThan(playsBefore)
      },
      { timeout: 6_000, interval: 25 },
    )

    expect(el.paused).toBe(false)
    core.dispose()
  }, 15_000)

  it('clears a tracked seek when a user pause stops playback', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, {
      id: 'c1',
      mediaId: asset.id,
      start: 0,
      duration: 10,
      inPoint: 0,
    })
    const inactive = addVideoClip(doc, {
      id: 'c2',
      mediaId: asset.id,
      start: 5,
      duration: 5,
      inPoint: 0,
    })
    const { core } = makeCore(doc)
    const el = core['pool'].get(inactive, asset, asset.url) as HTMLVideoElement
    const onSeeked = vi.fn()
    el.addEventListener('seeked', onSeeked)
    core['seekingEls'].set(el, { started: performance.now(), onSeeked })
    const removeSpy = vi.spyOn(el, 'removeEventListener')

    await core.play()
    await h.pump.pump(1)
    expect(core.isPlaying).toBe(true)
    core.pause()

    expect(removeSpy).toHaveBeenCalledWith('seeked', onSeeked)
    expect(core['seekingEls'].size).toBe(0)
    expect(core['seekingSince'].size).toBe(0)
    core.dispose()
  })

  it('clears tracked seek state when pause arrives during play warmup', async () => {
    const { doc, asset } = makeDoc()
    const clip = addVideoClip(doc, {
      id: 'c1',
      mediaId: asset.id,
      start: 0,
      duration: 10,
      inPoint: 0,
    })
    const { core } = makeCore(doc)
    const el = core['pool'].get(clip, asset, asset.url) as HTMLVideoElement
    const onSeeked = vi.fn()
    el.addEventListener('seeked', onSeeked)
    core['seekingEls'].set(el, { started: performance.now(), onSeeked })

    const playPromise = core.play()
    core.pause()
    await playPromise

    expect(core.isPlaying).toBe(false)
    expect(core['seekingEls'].size).toBe(0)
    expect(core['seekingSince'].size).toBe(0)
    core.dispose()
  })

  it('clears tracked seek listeners when playback reaches the sequence end', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, {
      id: 'c1',
      mediaId: asset.id,
      start: 0,
      duration: 10,
      inPoint: 0,
    })
    addVideoClip(doc, {
      id: 'c2',
      mediaId: asset.id,
      start: 0,
      duration: 1,
      inPoint: 0,
    })
    const { core } = makeCore(doc)

    await core.play()
    h.lastAudioContext().currentTime = 1.5
    await h.pump.pump(1)
    const el = core['pool'].peek('c2') as HTMLVideoElement
    expect(el).toBeDefined()
    expect(el.paused).toBe(true)
    const onSeeked = vi.fn()
    el.addEventListener('seeked', onSeeked)
    core['seekingEls'].set(el, { started: performance.now(), onSeeked })
    const removeSpy = vi.spyOn(el, 'removeEventListener')

    h.lastAudioContext().currentTime = 10
    await h.pump.pump(1)

    expect(core.isPlaying).toBe(false)
    expect(removeSpy).toHaveBeenCalledWith('seeked', onSeeked)
    expect(core['seekingEls'].size).toBe(0)
    expect(core['seekingSince'].size).toBe(0)
    core.dispose()
  })

  it('waits for a tracked seek before accepting a ready frame at the start', async () => {
    const { doc, asset } = makeDoc()
    const clip = addVideoClip(doc, {
      id: 'c1',
      mediaId: asset.id,
      start: 0,
      duration: 10,
      inPoint: 0,
    })
    const { core } = makeCore(doc, { createScrubSource: () => scrubSource() })
    core.seek(0)
    const el = core['pool'].peek(clip.id) as HTMLVideoElement
    primeVideoElement(el)
    Object.defineProperty(el, 'seeking', { configurable: true, value: false })
    Object.defineProperty(el, 'currentTime', {
      configurable: true,
      get: () => 0,
      set: () => undefined,
    })
    core['seekingEls'].set(el, { started: performance.now(), onSeeked: () => undefined })

    const playPromise = core.play()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(core.isPlaying).toBe(false)

    await playPromise
    expect(core.isPlaying).toBe(true)
    core.dispose()
  })

  it('repaints once on a user pause and not at the sequence end', async () => {
    const makePlaying = async () => {
      const { doc, asset } = makeDoc()
      addVideoClip(doc, {
        mediaId: asset.id,
        start: 0,
        duration: 10,
        inPoint: 0,
      })
      const made = makeCore(doc)
      await made.core.play()
      await h.pump.pump(1)
      expect(made.core.isPlaying).toBe(true)
      return made
    }

    const first = await makePlaying()
    const firstRender = renderSpy(first.core)
    first.core.pause()
    expect(firstRender).toHaveBeenCalledTimes(1)
    expect(firstRender).toHaveBeenLastCalledWith(first.core.currentTime)
    first.core.dispose()

    const second = await makePlaying()
    h.lastAudioContext().currentTime = 2
    await h.pump.pump(1)
    const secondRender = renderSpy(second.core)
    second.core.pause()
    expect(secondRender).toHaveBeenCalledTimes(1)
    expect(secondRender).toHaveBeenLastCalledWith(second.core.currentTime)
    second.core.dispose()

    const third = await makePlaying()
    const thirdRender = renderSpy(third.core)
    h.lastAudioContext().currentTime = 10
    await h.pump.pump(1)
    expect(third.core.isPlaying).toBe(false)
    expect(thirdRender).toHaveBeenCalledTimes(1)
    third.core.pause()
    expect(thirdRender).toHaveBeenCalledTimes(1)
    third.core.dispose()
  }, 15_000)

  it('clears play-path seek tracking before a paused seek', () => {
    const { doc, asset } = makeDoc()
    const clip = addVideoClip(doc, {
      id: 'c1',
      mediaId: asset.id,
      start: 0,
      duration: 10,
      inPoint: 0,
    })
    const { core } = makeCore(doc)
    const el = core['pool'].get(clip, asset, asset.url) as HTMLVideoElement
    primeVideoElement(el)
    el.currentTime = 2.0001
    const onSeeked = vi.fn()
    el.addEventListener('seeked', onSeeked)
    core['seekingEls'].set(el, { started: performance.now(), onSeeked })
    const removeSpy = vi.spyOn(el, 'removeEventListener')

    core.refresh(2)

    expect(removeSpy).toHaveBeenCalledWith('seeked', onSeeked)
    expect(core['seekingEls'].size).toBe(0)
    core.dispose()
  })

  it('does not repaint an older time when a paused seek is superseded', () => {
    const { doc, asset } = makeDoc()
    const clip = addVideoClip(doc, {
      id: 'c1',
      mediaId: asset.id,
      start: 0,
      duration: 10,
      inPoint: 0,
    })
    const { core } = makeCore(doc)
    const el = core['pool'].get(clip, asset, asset.url) as HTMLVideoElement
    primeVideoElement(el)
    let position = 0
    Object.defineProperty(el, 'currentTime', {
      configurable: true,
      get: () => position,
      set: (v: number) => {
        position = v
      },
    })
    const listeners: Array<() => void> = []
    const add = el.addEventListener.bind(el)
    el.addEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) => {
      if (type === 'seeked') listeners.push(listener as () => void)
      add(type, listener, options)
    }) as typeof el.addEventListener
    const renders: number[] = []
    const render = renderSpy(core).mockImplementation((t) => {
      renders.push(t)
    })

    core.refresh(2)
    core.refresh(4)
    expect(listeners.length).toBeGreaterThanOrEqual(2)
    listeners[0]()

    expect(renders[renders.length - 1]).toBeCloseTo(4, 5)
    render.mockRestore()
    core.dispose()
  })

  it('a pause drops a stale cached frame and paints the requested one when it lands', async () => {
    const { doc, asset } = makeDoc()
    const clip = addVideoClip(doc, {
      id: 'c1',
      mediaId: asset.id,
      start: 0,
      duration: 10,
      inPoint: 0,
    })
    let requested: {
      request: ScrubFrameRequest
      onFrame: (result: ScrubFrameResult) => void
    } | null = null
    let cached: CanvasImageSource | undefined
    const staleFrame = document.createElement('canvas')
    cached = staleFrame
    const source = scrubSource({
      hasSink: () => true,
      peek: () => cached,
      releaseCachedFrame: () => {
        cached = undefined
      },
      request: (request, onFrame) => {
        requested = { request, onFrame }
      },
    })
    const { core, ctx } = makeCore(doc, { createScrubSource: () => source })
    const el = core['pool'].get(clip, asset, asset.url) as HTMLVideoElement
    primeVideoElement(el)

    await core.play()
    await h.pump.pump(1)
    presentFrame(el, 0.2)
    const render = renderSpy(core)
    const before = ctx.calls.length
    core.pause()

    expect(core.currentTime).toBeCloseTo(0.2, 5)
    expect(render).toHaveBeenCalledTimes(1)
    expect(requested).not.toBeNull()
    expect(cached).toBeUndefined()
    expect(ctx.calls.length).toBe(before)
    expect(ctx.calls.some((call) => call.op === 'drawImage' && call.args[0] === staleFrame)).toBe(
      false,
    )

    const frame = document.createElement('canvas')
    cached = frame
    requested!.onFrame({
      clipId: clip.id,
      frame,
      sourceTime: requested!.request.sourceTime,
      generation: requested!.request.generation,
    })

    expect(ctx.calls.length).toBeGreaterThan(before)
    expect(ctx.calls.some((call) => call.op === 'drawImage')).toBe(true)
    core.dispose()

    const second = makeDoc()
    const ended = addVideoClip(second.doc, {
      id: 'ended',
      mediaId: second.asset.id,
      start: 0,
      duration: 0.1,
      inPoint: 0,
    })
    const activeTrack = createTrack('video', 2)
    second.doc.project.tracks.push(activeTrack)
    const active = createClip({
      id: 'active',
      mediaId: second.asset.id,
      start: 0,
      duration: 10,
      inPoint: 0,
    })
    activeTrack.clips.push(active)
    const secondCore = makeCore(second.doc).core
    secondCore.seek(0.2)
    const endedEl = secondCore['pool'].get(
      ended,
      second.asset,
      second.asset.url,
    ) as HTMLVideoElement
    secondCore['watchPresentedFrames'](endedEl)
    presentFrame(endedEl, 0.1)
    const activeEl = secondCore['pool'].peek(active.id) as HTMLVideoElement
    secondCore['watchPresentedFrames'](activeEl)
    presentFrame(activeEl, 0.2)

    await secondCore.play()
    secondCore.pause()

    // The ended clip is first in activeClipList, but it is not active at the
    // pause time; its 0.1 frame must not supply the pause time.
    expect(secondCore.currentTime).toBeCloseTo(0.2, 5)
    secondCore.dispose()
  })

  it('recovers the picture when a seek lasts longer than the stall bound', async () => {
    const { doc, asset } = makeDoc()
    const clip = addVideoClip(doc, {
      id: 'c1',
      mediaId: asset.id,
      start: 0,
      duration: 10,
      inPoint: 0,
    })
    const { core, frames, ctx } = makeCore(doc, { createScrubSource: () => scrubSource() })
    core.seek(0)
    const el = core['pool'].peek(clip.id) as HTMLVideoElement
    primeVideoElement(el)
    let seeking = true
    Object.defineProperty(el, 'seeking', { configurable: true, get: () => seeking })
    const playSpy = vi.spyOn(el, 'play')

    await core.play()
    // The first tick after the warmup starts the stall interval and must not
    // play yet. The retry lands after SEEK_STALL_MS (2,000 ms), so wait past
    // it and assert a new play call, not just one that was already there.
    await h.pump.pump(1)
    const playsBefore = playSpy.mock.calls.length
    const deadline = Date.now() + 2_600
    while (Date.now() < deadline) {
      await h.pump.pump(1)
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(playSpy.mock.calls.length).toBeGreaterThan(playsBefore)

    // The seek now lands. Advance the clock so the engine's drift correction
    // seeks the element itself; the fake setter fires `seeked` on the move.
    // Assert the composited frame, never a position the test wrote.
    seeking = false
    h.lastAudioContext().currentTime = 5
    const drawsBefore = ctx.calls.filter((call) => call.op === 'drawImage').length
    await h.pump.pump(1)

    expect(frames.at(-1)).toBeCloseTo(5, 5)
    expect(el.currentTime).toBeCloseTo(5, 3)
    expect(ctx.calls.filter((call) => call.op === 'drawImage').length).toBeGreaterThan(drawsBefore)
    core.dispose()
  }, 15_000)
})
