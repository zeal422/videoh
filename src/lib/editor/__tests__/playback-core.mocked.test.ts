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
    expect(el.currentTime).toBeCloseTo(1.125, 5)

    // The next tick seeks again (stepped preview), still parked.
    h.lastAudioContext().currentTime += 1
    await h.pump.pump(1)
    expect(el.paused).toBe(true)
    expect(el.currentTime).toBeCloseTo(2.5, 5)
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
    // follow it — but its constant then retimes the picture against a twin
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
    expect(el.currentTime).toBeCloseTo(0.5, 5) // positioned at inPoint

    // One second of audio-clock time: the element "drifted" (stayed at 0.5),
    // so the DRIFT_THRESHOLD (0.4 s) guard must resync it to the expected
    // source time.
    h.lastAudioContext().currentTime += 1
    await h.pump.pump(1)
    expect(core.currentTime).toBeCloseTo(1, 5)
    expect(frames.at(-1)).toBeCloseTo(1, 5)
    expect(el.currentTime).toBeCloseTo(1.5, 5) // inPoint 0.5 + 1s

    // Small drift inside the threshold must NOT be corrected.
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

  it('rewires the audio chain to the relinked element', async () => {
    const { doc, asset } = makeDoc()
    addVideoClip(doc, { mediaId: asset.id, start: 0, duration: 4, inPoint: 0 })
    const { core } = makeCore(doc)
    await core.play()
    await h.pump.pump(1)

    const before = core['pool'].peek(doc.project.tracks[0].clips[0].id)
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
