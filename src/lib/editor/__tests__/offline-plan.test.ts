import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  clipCrossfadeSchedule,
  clipGainSchedule,
  exportFrameTimes,
  needsReverse,
  planAudioFrame,
  planVideoFrame,
  videoAssetIds,
} from '../export/offline'
import { closeDecodedFrames, pickAudioCodec, preloadImage, renderAudioMix } from '../export/mp4'
import { blendWeight } from '../export/offline'
import { addBlendLayer, beginBlendPair } from '../playback/compositor'
import { createFake2DContext } from './mocks/browser-mocks'
import { clampSourceTime, createClip, createTextClip, createTrack } from '../factories'
import { animatedValue } from '../keyframes'
import type { Clip, Doc, MediaAsset } from '../types'

/** Minimal AudioBuffer stand-in for the OfflineAudioContext stub. */
function fakeBuffer(): AudioBuffer {
  return {
    sampleRate: 48000,
    length: 48000,
    duration: 1,
    numberOfChannels: 1,
    getChannelData: () => new Float32Array(48000),
  } as unknown as AudioBuffer
}

function doc(
  tracks: { kind: 'video' | 'audio' | 'text'; clips: Clip[] }[],
  media: MediaAsset[],
): Doc {
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
    media,
  }
}

function asset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: 'm1',
    name: 'a.mp4',
    kind: 'video',
    duration: 10,
    width: 640,
    height: 360,
    url: 'blob:x',
    ...overrides,
  }
}

const videoClip = (over: Partial<Clip> = {}) =>
  createClip({ id: 'cv', mediaId: 'm1', start: 0, duration: 4, ...over })
const audioClip = (over: Partial<Clip> = {}) =>
  createClip({ id: 'ca', mediaId: 'ma', audioOnly: true, start: 0, duration: 4, ...over })

describe('exportFrameTimes', () => {
  it('quantizes to the project fps', () => {
    const d = doc([{ kind: 'video', clips: [videoClip({ duration: 1 })] }], [])
    const times = exportFrameTimes(d)
    expect(times).toEqual([
      0,
      1 / 30,
      2 / 30,
      3 / 30,
      4 / 30,
      5 / 30,
      6 / 30,
      7 / 30,
      8 / 30,
      9 / 30,
      10 / 30,
      11 / 30,
      12 / 30,
      13 / 30,
      14 / 30,
      15 / 30,
      16 / 30,
      17 / 30,
      18 / 30,
      19 / 30,
      20 / 30,
      21 / 30,
      22 / 30,
      23 / 30,
      24 / 30,
      25 / 30,
      26 / 30,
      27 / 30,
      28 / 30,
      29 / 30,
    ])
  })

  it('an empty timeline renders no frames', () => {
    const d = doc([{ kind: 'video', clips: [] }], [])
    expect(exportFrameTimes(d)).toEqual([])
  })
})

describe('planVideoFrame', () => {
  it('draws the active clip with speed-aware source time', () => {
    const a = asset()
    const d = doc([{ kind: 'video', clips: [videoClip({ inPoint: 1, speed: 2 })] }], [a])
    const plan = planVideoFrame(d, 2)
    expect(plan.draws).toHaveLength(1)
    expect(plan.draws[0].sourceTime).toBe(1 + 2 * 2) // inPoint + local*speed
    expect(plan.draws[0].alpha).toBe(1)
    expect(plan.draws[0].filter).toBe('none')
    expect(plan.draws[0].transform).toBeNull()
  })

  it('applies keyframed opacity to the draw alpha', () => {
    const d = doc(
      [
        {
          kind: 'video',
          clips: [
            videoClip({
              keyframes: {
                opacity: [
                  { time: 0, value: 1 },
                  { time: 4, value: 0 },
                ],
              },
            }),
          ],
        },
      ],
      [],
    )
    expect(planVideoFrame(d, 2).draws[0].alpha).toBeCloseTo(0.5, 10)
  })

  it('emits the color filter when statics are non-neutral', () => {
    const d = doc(
      [{ kind: 'video', clips: [videoClip({ animStatics: { saturation: 0.5, hue: 90 } })] }],
      [],
    )
    const f = planVideoFrame(d, 0).draws[0].filter
    expect(f).toContain('saturate(0.5)')
    expect(f).toContain('hue-rotate(90deg)')
  })

  it('emits a transform when position/scale are non-neutral', () => {
    const d = doc(
      [{ kind: 'video', clips: [videoClip({ animStatics: { positionX: 120, scale: 1.5 } })] }],
      [],
    )
    const t = planVideoFrame(d, 0).draws[0].transform
    expect(t).toEqual({ posX: 120, posY: 0, scale: 1.5 })
  })

  it('crossfade overlaps produce complementary alphas', () => {
    const a = videoClip({
      id: 'a1',
      start: 0,
      duration: 4,
      transitionOut: { type: 'crossfade', duration: 1 },
    })
    const b = videoClip({ id: 'a2', start: 3, duration: 4 })
    const d = doc([{ kind: 'video', clips: [a, b] }], [])
    const plan = planVideoFrame(d, 3.5)
    const alphaA = plan.draws.find((x) => x.clip.id === 'a1')!.alpha
    const alphaB = plan.draws.find((x) => x.clip.id === 'a2')!.alpha
    expect(alphaA).toBeCloseTo(0.5, 5)
    expect(alphaB).toBeCloseTo(0.5, 5)
  })

  it('track order: bottom track draws first', () => {
    const top = videoClip({ id: 'top' })
    const bottom = videoClip({ id: 'bot' })
    // tracks[0] is the TOPMOST layer; draws[] must list bottom first.
    const d = doc(
      [
        { kind: 'video', clips: [top] },
        { kind: 'video', clips: [bottom] },
      ],
      [],
    )
    const ids = planVideoFrame(d, 0).draws.map((x) => x.clip.id)
    expect(ids).toEqual(['bot', 'top'])
  })
})

describe('planAudioFrame', () => {
  it('includes audio-bearing clips with gain and pan', () => {
    const ma = asset({ id: 'ma', kind: 'audio' })
    const d = doc([{ kind: 'audio', clips: [audioClip({ gain: 1.5, pan: -0.5 })] }], [ma])
    const plan = planAudioFrame(d, 1)
    expect(plan.audible).toHaveLength(1)
    expect(plan.audible[0].gain).toBe(1.5)
    expect(plan.audible[0].pan).toBe(-0.5)
    expect(plan.audible[0].sourceTime).toBe(1)
  })

  it('drops reversed clips from the audio plan', () => {
    const ma = asset({ id: 'ma', kind: 'audio' })
    const d = doc([{ kind: 'audio', clips: [audioClip({ reverse: true })] }], [ma])
    expect(planAudioFrame(d, 1).audible).toHaveLength(0)
  })

  it('shadows the video part when an audio twin exists', () => {
    const a = asset()
    const video = videoClip({ id: 'v', linkId: 'L' })
    const twin = audioClip({ id: 't', mediaId: 'm1', linkId: 'L' })
    const d = doc(
      [
        { kind: 'video', clips: [video] },
        { kind: 'audio', clips: [twin] },
      ],
      [a],
    )
    // The video part has a twin → silent; the twin is audible.
    const plan = planAudioFrame(d, 1)
    expect(plan.audible.map((x) => x.clip.id)).toEqual(['t'])
  })

  it('includes the embedded audio of a solo video clip with no twin', () => {
    // Finding 1: computeGain only shadows a video part WHILE a linked twin
    // exists, so with the twin gone the preview plays the embedded audio; the
    // plan must report the same source or the export goes silent.
    const a = asset({ hasAudio: true })
    const d = doc([{ kind: 'video', clips: [videoClip({ id: 'v' })] }], [a])
    expect(planAudioFrame(d, 1).audible.map((x) => x.clip.id)).toEqual(['v'])
  })

  it('keeps a manual link video part audible beside its kind-audio partner', () => {
    // A manual link has no audioOnly carrier, so no shadow applies and every
    // member keeps its own sound (the preview's rule; the export used to drop
    // the video part).
    const movie = asset({ id: 'mv', hasAudio: true })
    const song = asset({ id: 'ma', kind: 'audio', name: 's.mp3' })
    const video = videoClip({ id: 'vm', mediaId: 'mv', linkId: 'L' })
    const music = createClip({ id: 'am', mediaId: 'ma', duration: 4, linkId: 'L' })
    const d = doc(
      [
        { kind: 'video', clips: [video] },
        { kind: 'audio', clips: [music] },
      ],
      [movie, song],
    )
    expect(planAudioFrame(d, 1).audible.map((x) => x.clip.id)).toEqual(['vm', 'am'])
  })

  it('keeps offline media out of the audio plan', () => {
    // The mix skips a file-less asset at its `asset.file` gate, so the plan
    // requires playability in every branch (solo video, kind-audio, carrier);
    // otherwise the plan would promise an audible clip the mix can never render.
    const missing = asset({ hasAudio: true, missing: true })
    const gone = doc([{ kind: 'video', clips: [videoClip({ id: 'v' })] }], [missing])
    expect(planAudioFrame(gone, 1).audible).toHaveLength(0)

    const urlLess = asset({ hasAudio: true, url: '' })
    const blank = doc([{ kind: 'video', clips: [videoClip({ id: 'v' })] }], [urlLess])
    expect(planAudioFrame(blank, 1).audible).toHaveLength(0)

    const offlineSong = asset({ id: 'ma', kind: 'audio', name: 'gone.mp3', missing: true, url: '' })
    const song = createClip({ id: 'ca', mediaId: 'ma', duration: 4 })
    const music = doc([{ kind: 'audio', clips: [song] }], [offlineSong])
    expect(planAudioFrame(music, 1).audible).toHaveLength(0)
  })
})

describe('time-remap ramps', () => {
  /** Linear 1x → 2x over 4 s: rate(t) = 1 + t/4, so I(x) = x + x²/8. */
  const ramp = [
    { time: 0, value: 1 },
    { time: 4, value: 2 },
  ]

  it('plans ramped source times without changing the clip or the frame count', () => {
    const a = asset()
    const d = doc([{ kind: 'video', clips: [videoClip({ keyframes: { timeScale: ramp } })] }], [a])
    expect(planVideoFrame(d, 2).draws[0].sourceTime).toBeCloseTo(2.5, 6)
    expect(planVideoFrame(d, 4 - 1 / 30).draws[0].sourceTime).toBeLessThan(6)
    // Timeline length (and therefore the export's frame count) is untouched.
    expect(exportFrameTimes(d)).toHaveLength(120)
  })

  it('clamps an over-consuming ramp to the last readable frame', () => {
    const a = asset({ duration: 3 })
    const d = doc(
      [
        {
          kind: 'video',
          clips: [videoClip({ keyframes: { timeScale: [{ time: 0, value: 4 }] } })],
        },
      ],
      [a],
    )
    // 4x over 4 s asks for 16 s of a 3 s asset: the plan reports the raw value,
    // and both render paths read it through the same clamp.
    expect(planVideoFrame(d, 3.9).draws[0].sourceTime).toBeCloseTo(15.6, 6)
    expect(clampSourceTime(15.6, a)).toBeCloseTo(2.99, 6)
    expect(clampSourceTime(-1, a)).toBe(0)
    expect(clampSourceTime(5, undefined)).toBe(5)
  })

  it('keeps a flat timeScale curve (identity seed or constant) audible in the mix', () => {
    // The audio policy keys on the curve SHAPE: a flat curve is a constant
    // rate the buffer source resamples, so it is not "ramped" for the audio
    // decision. The identity diamond seed used to mute the pair for nothing.
    const a = asset({ id: 'ma', kind: 'audio', duration: 60 })
    const flat = [{ time: 0, value: 1 }]
    const d = doc([{ kind: 'audio', clips: [audioClip({ keyframes: { timeScale: flat } })] }], [a])
    expect(planAudioFrame(d, 1).audible.length).toBe(1)

    // A REAL ramp still drops the clip.
    const ramp = [
      { time: 0, value: 1 },
      { time: 4, value: 2 },
    ]
    const d2 = doc([{ kind: 'audio', clips: [audioClip({ keyframes: { timeScale: ramp } })] }], [a])
    expect(planAudioFrame(d2, 1).audible.length).toBe(0)
  })

  it('drops a ramped clip from the audio plan', () => {
    const a = asset()
    const d = doc([{ kind: 'video', clips: [videoClip({ keyframes: { timeScale: ramp } })] }], [a])
    expect(planAudioFrame(d, 2).audible).toHaveLength(0)
  })

  it('silences BOTH halves of a ramped A/V pair', () => {
    const a = asset()
    const base = { linkId: 'L1', start: 0, duration: 4 }
    const d = doc(
      [
        {
          kind: 'video',
          clips: [videoClip({ ...base, id: 'cv', keyframes: { timeScale: ramp } })],
        },
        { kind: 'audio', clips: [audioClip({ ...base, id: 'ca', mediaId: 'ma' })] },
      ],
      [a, asset({ id: 'ma', kind: 'audio', name: 'a.wav' })],
    )
    // The twin carries NO curve of its own, so only the link-group predicate
    // can keep it silent; a per-clip ramp check would let it play at the old rate.
    expect(d.project.tracks[1].clips[0].keyframes).toBeUndefined()
    expect(planAudioFrame(d, 2).audible).toHaveLength(0)

    // Control: with the video's ramp gone the twin is audible again.
    const noRamp = structuredClone(d)
    noRamp.project.tracks[0].clips[0].keyframes = undefined
    expect(planAudioFrame(noRamp, 2).audible.map((c) => c.clip.id)).toEqual(['ca'])
  })
})

describe('reversed source reads', () => {
  it('mirrors the source span (local 0 shows the span end)', () => {
    const a = asset()
    const d = doc(
      [
        {
          kind: 'video',
          clips: [videoClip({ reverse: true, inPoint: 1, start: 0, duration: 2 })],
        },
      ],
      [a],
    )
    expect(planVideoFrame(d, 0).draws[0].sourceTime).toBe(3)
    expect(planVideoFrame(d, 0.5).draws[0].sourceTime).toBe(2.5)
    expect(planVideoFrame(d, 1.5).draws[0].sourceTime).toBe(1.5)
  })

  it('mirrors and re-times together (reverse + speed)', () => {
    const a = asset()
    const d = doc(
      [
        {
          kind: 'video',
          clips: [videoClip({ reverse: true, speed: 2, inPoint: 1, start: 0, duration: 2 })],
        },
      ],
      [a],
    )
    expect(planVideoFrame(d, 0).draws[0].sourceTime).toBe(5)
    expect(planVideoFrame(d, 1).draws[0].sourceTime).toBe(3)
  })
})

describe('frame blending for sub-frame-rate playback (0.7.0)', () => {
  it('emits the source time one output frame later as the blend pair', () => {
    const d = doc([{ kind: 'video', clips: [videoClip({ speed: 0.5 })] }], [asset()])
    const draw = planVideoFrame(d, 1).draws[0]
    expect(draw.sourceTime).toBeCloseTo(0.5, 10)
    // local 1 + 1/30 at 0.5x = 0.51667 source seconds: the NEXT output frame's
    // read, which is what brackets the source frame this one straddles.
    expect(draw.blendTime).toBeCloseTo(0.5 + 0.5 / 30, 10)
  })

  it('emits no blend pair at or above realtime, or for a still/text clip', () => {
    const realtime = doc([{ kind: 'video', clips: [videoClip()] }], [asset()])
    expect(planVideoFrame(realtime, 1).draws[0].blendTime).toBeUndefined()

    const faster = doc([{ kind: 'video', clips: [videoClip({ speed: 2 })] }], [asset()])
    expect(planVideoFrame(faster, 1).draws[0].blendTime).toBeUndefined()

    const still = doc(
      [{ kind: 'video', clips: [videoClip({ speed: 0.5 })] }],
      [asset({ kind: 'image' })],
    )
    expect(planVideoFrame(still, 1).draws[0].blendTime).toBeUndefined()

    const text = doc([{ kind: 'text', clips: [createTextClip({ start: 0, duration: 4 })] }], [])
    expect(planVideoFrame(text, 1).draws[0].blendTime).toBeUndefined()
  })

  it('blends only the slow half of a ramp', () => {
    // 2x -> 0.5x over the clip: the early span is faster than realtime, the tail
    // is below it, so only there does the plan ask for a second sample.
    const ramp: Clip = videoClip({
      keyframes: {
        timeScale: [
          { time: 0, value: 2 },
          { time: 4, value: 0.5 },
        ],
      },
    })
    const d = doc([{ kind: 'video', clips: [ramp] }], [asset()])
    expect(planVideoFrame(d, 0.2).draws[0].blendTime).toBeUndefined()
    expect(planVideoFrame(d, 3.8).draws[0].blendTime).toBeDefined()
  })

  it('derives the blend weight from two sample timestamps, with no nominal fps', () => {
    expect(blendWeight(0.5, 0.4, 0.6)).toBeCloseTo(0.5, 10)
    expect(blendWeight(0.45, 0.4, 0.6)).toBeCloseTo(0.25, 10)
    // A pair the decoder did not advance (or a backwards one) has no weight to
    // give: the frame is drawn once, unblended.
    expect(blendWeight(0.5, 0.4, 0.4)).toBe(0)
    expect(blendWeight(0.5, 0.6, 0.4)).toBe(0)
    // The read can sit outside the pair (a clamped source): the weight clamps.
    expect(blendWeight(2, 0.4, 0.6)).toBe(1)
    expect(blendWeight(0, 0.4, 0.6)).toBe(0)
  })
})

describe('frame blend composition (export draw)', () => {
  it('composes the pair ADDITIVELY over black, then composites once', () => {
    const ctx = createFake2DContext()
    beginBlendPair(ctx, 100, 50)
    addBlendLayer(ctx, 'A' as unknown as CanvasImageSource, 0.4, 100, 50)
    addBlendLayer(ctx, 'B' as unknown as CanvasImageSource, 0.6, 100, 50)
    const ops = ctx.calls.map((c) => c.op)
    expect(ops).toEqual([
      'save',
      'set:globalCompositeOperation',
      'set:globalAlpha',
      'set:fillStyle',
      'fillRect',
      'set:globalCompositeOperation',
      'set:globalAlpha',
      'drawImage',
      'set:globalAlpha',
      'drawImage',
    ])
    // The base is black and opaquely painted, and the layers go on with
    // 'lighter': two plain source-over draws would NOT average, each landing on
    // whatever the previous one left (0.6 over red lands at 0.360, not 0.600).
    expect(ctx.props.get('fillStyle')).toBe('#000000')
    expect(ctx.props.get('globalCompositeOperation')).toBe('lighter')
    expect(ctx.props.get('globalAlpha')).toBe(0.6)
    expect(ctx.calls[4].args).toEqual([0, 0, 100, 50])
    expect(ctx.calls[7].args).toEqual(['A', 0, 0, 100, 50])
    expect(ctx.calls[9].args).toEqual(['B', 0, 0, 100, 50])
  })
})

describe('clipGainSchedule', () => {
  it('never zeroes a clip that starts at 0:00', () => {
    const events = clipGainSchedule(createClip({ id: 'c', start: 0, duration: 2, gain: 0.8 }))
    expect(events).toEqual([{ time: 0, value: 0.8, kind: 'set' }])
  })

  it('keeps the pre-start zero guard for later clips', () => {
    const events = clipGainSchedule(createClip({ id: 'c', start: 2, duration: 2 }))
    expect(events).toEqual([
      { time: 1.999, value: 0, kind: 'set' },
      { time: 2, value: 1, kind: 'set' },
    ])
  })

  it('ramps through a volume curve and constant-extends at the clip edge', () => {
    const clip = createClip({
      id: 'c',
      start: 0,
      duration: 4,
      keyframes: {
        volume: [
          { time: 1, value: 1 },
          { time: 2, value: 0.2 },
        ],
      },
    })
    expect(clipGainSchedule(clip)).toEqual([
      { time: 0, value: 1, kind: 'set' },
      { time: 1, value: 1, kind: 'ramp' },
      { time: 2, value: 0.2, kind: 'ramp' },
      { time: 4, value: 0.2, kind: 'ramp' },
    ])
  })

  it('samples eased data even when the keyframe is NAMED linear', () => {
    // The gate must be the SEGMENT SHAPE (segmentControls), not the display
    // name: sanitizeKeyframes normalizes an absent name to linear while KEEPING
    // a valid easeOut quad, so a project file can carry real easing under the
    // linear name. The preview evaluates the shape, so the export must too.
    const clip = createClip({
      id: 'c',
      start: 0,
      duration: 4,
      keyframes: {
        volume: [
          {
            time: 0,
            value: 0,
            interpolation: 'linear',
            easeOut: [0.3, 0.9, 0.5, 1],
          },
          { time: 4, value: 1 },
        ],
      },
    })
    const events = clipGainSchedule(clip)
    // 16 samples + both keyframes + the end hold.
    expect(events.filter((e) => e.kind === 'ramp').length).toBe(18)
    // And the sampled values follow the SHAPE (the preview's curve), which for
    // this quad sits far above the straight line at the quarter point.
    const quarter = events.find((e) => Math.abs(e.time - 1) < 1e-9)
    expect(quarter).toBeDefined()
    expect(quarter!.value).toBeCloseTo(animatedValue(clip, 'volume', 1), 6)
  })

  it('decodes a shared audio asset once per export, not once per clip', async () => {
    // 20 placements of one music file: decodeAudioData must run once for the
    // asset, not once per clip (each call allocates a full float32 buffer).
    const file = new File([new Uint8Array([1, 2, 3])], 'm.mp3', { type: 'audio/mpeg' })
    const music = { ...asset({ id: 'ma', kind: 'audio', duration: 60, url: 'blob:m' }), file }
    const placements = Array.from({ length: 20 }, (_, i) =>
      audioClip({ id: `ca${i}`, start: i, duration: 1 }),
    )
    const d = doc([{ kind: 'audio', clips: placements }], [music])

    let decodes = 0
    class FakeParam {
      value = 1
      setValueAtTime = () => undefined
      linearRampToValueAtTime = () => undefined
    }
    class FakeOfflineContext {
      destination = {}
      sampleRate = 48000
      currentTime = 0
      createGain() {
        return { gain: new FakeParam(), connect: () => undefined }
      }
      createStereoPanner() {
        return { pan: new FakeParam(), connect: () => undefined }
      }
      createBiquadFilter() {
        return {
          type: '',
          frequency: new FakeParam(),
          Q: new FakeParam(),
          gain: new FakeParam(),
          connect: () => undefined,
        }
      }
      createDynamicsCompressor() {
        return {
          threshold: new FakeParam(),
          knee: new FakeParam(),
          ratio: new FakeParam(),
          attack: new FakeParam(),
          release: new FakeParam(),
          connect: () => undefined,
        }
      }
      createBufferSource() {
        return {
          buffer: null,
          playbackRate: new FakeParam(),
          connect: () => undefined,
          start: () => undefined,
        }
      }
      decodeAudioData(): Promise<AudioBuffer> {
        decodes++
        return Promise.resolve(fakeBuffer())
      }
      startRendering(): Promise<AudioBuffer> {
        return Promise.resolve(fakeBuffer())
      }
    }
    vi.stubGlobal('OfflineAudioContext', FakeOfflineContext)
    try {
      const buffer = await renderAudioMix(d, 20)
      expect(buffer).not.toBeNull()
      expect(decodes).toBe(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('spans flat-curve export audio at the curve rate, not the static speed', async () => {
    // The duration handed to AudioBufferSourceNode.start is in SOURCE seconds
    // and is consumed at playbackRate: covering a 4s clip at the 0.5x flat
    // curve rate takes 4 * 0.5 = 2 source seconds, not the static 4. Reading
    // the static speed plays 4 source seconds at half rate = 8 timeline
    // seconds of audio, bleeding over the next clip (the mirror case ends
    // early in silence).
    const file = new File([new Uint8Array([1, 2, 3])], 'm.mp3', { type: 'audio/mpeg' })
    const music = { ...asset({ id: 'ma', kind: 'audio', duration: 60, url: 'blob:m' }), file }
    const clip = audioClip({
      id: 'cflat',
      start: 0,
      duration: 4,
      keyframes: { timeScale: [{ time: 0, value: 0.5, interpolation: 'linear' }] },
    })
    const d = doc([{ kind: 'audio', clips: [clip] }], [music])

    const sources: { playbackRate: { value: number } }[] = []
    let started: { offset: number; duration: number } | undefined
    class FakeParam {
      value = 1
      setValueAtTime = () => undefined
      linearRampToValueAtTime = () => undefined
    }
    class FakeOfflineContext {
      destination = {}
      sampleRate = 48000
      currentTime = 0
      createGain() {
        return { gain: new FakeParam(), connect: () => undefined }
      }
      createStereoPanner() {
        return { pan: new FakeParam(), connect: () => undefined }
      }
      createBufferSource() {
        const src = {
          buffer: null,
          playbackRate: new FakeParam(),
          connect: () => undefined,
          start: (_when: number, offset: number, duration: number) => {
            started = { offset, duration }
          },
        }
        sources.push(src)
        return src
      }
      decodeAudioData(): Promise<AudioBuffer> {
        return Promise.resolve(fakeBuffer())
      }
      startRendering(): Promise<AudioBuffer> {
        return Promise.resolve(fakeBuffer())
      }
    }
    vi.stubGlobal('OfflineAudioContext', FakeOfflineContext)
    try {
      const buffer = await renderAudioMix(d, 20)
      expect(buffer).not.toBeNull()
      // duration = 4s clip * 0.5x curve rate = 2 source seconds.
      expect(started).toEqual({ offset: 0, duration: 2 })
      // The same constant drives the resampling rate.
      expect(sources[0]?.playbackRate.value).toBe(0.5)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('follows an eased segment instead of flattening it', () => {
    // Web Audio has no easing primitive, so mp4.ts schedules one `linearRamp`
    // per event. An eased segment must therefore be SAMPLED, or the export
    // would render a straight line where the preview eases: the exact
    // preview/export divergence the shared color filter exists to prevent.
    const clip = createClip({
      id: 'c',
      start: 0,
      duration: 4,
      keyframes: {
        volume: [
          { time: 0, value: 0, interpolation: 'easeIn' },
          { time: 4, value: 1 },
        ],
      },
    })
    const events = clipGainSchedule(clip)
    // Replay the schedule the way the exporter feeds the AudioParam: a `set`
    // jumps, a `ramp` interpolates linearly from the previous event.
    const gainAt = (t: number) => {
      let lastT = 0
      let lastV = 1
      for (const ev of events) {
        if (ev.kind === 'set') {
          if (ev.time > t) return lastV
          lastV = ev.value
          lastT = ev.time
        } else {
          if (ev.time >= t) {
            const span = ev.time - lastT
            return span <= 0 ? ev.value : lastV + (ev.value - lastV) * ((t - lastT) / span)
          }
          lastV = ev.value
          lastT = ev.time
        }
      }
      return lastV
    }
    let worst = 0
    for (let t = 0; t <= clip.duration; t += 0.017) {
      worst = Math.max(worst, Math.abs(animatedValue(clip, 'volume', t) - gainAt(t)))
    }
    // 16 samples per segment land within half a percent of gain everywhere,
    // where the un-sampled schedule diverges by up to 18 points on this curve.
    expect(worst).toBeLessThan(0.005)
    expect(events.length).toBeGreaterThan(2) // the segment really was sampled
  })

  it('returns events in chronological order even for a late-start keyframed clip', () => {
    // Insertion order puts the set events (clip start, pre-start guard) last.
    const clip = createClip({
      id: 'c',
      start: 2,
      duration: 4,
      keyframes: { volume: [{ time: 1, value: 0.5 }] },
    })
    const events = clipGainSchedule(clip)
    for (let i = 1; i < events.length; i++) {
      expect(events[i].time).toBeGreaterThanOrEqual(events[i - 1].time)
    }
    expect(events.map((e) => e.time)).toEqual([1.999, 2, 3, 6])
  })
})

describe('renderAudioMix (solo video embedded audio)', () => {
  it('mixes the embedded audio of a solo video clip with no twin', async () => {
    // Finding 1: the mix's audibility rule skipped a video part with no twin,
    // so deleting the twin clip exported a silent file while the preview kept
    // playing. The shared predicate must let the file decode like the twin's.
    const file = new File([new Uint8Array([1, 2, 3])], 'm.mp4', { type: 'video/mp4' })
    const movie = { ...asset({ hasAudio: true, url: 'blob:v' }), file }
    // A skipped sibling (muted here) must not stop the audible clip: the
    // early-out asks whether ANY clip schedules, not whether all do.
    const muted = videoClip({ id: 'cm', start: 4, duration: 2, muted: true })
    const d = doc([{ kind: 'video', clips: [videoClip({ id: 'cv' }), muted] }], [movie])

    let decodes = 0
    let sources = 0
    class FakeParam {
      value = 1
      setValueAtTime = () => undefined
      linearRampToValueAtTime = () => undefined
    }
    class FakeOfflineContext {
      destination = {}
      sampleRate = 48000
      currentTime = 0
      createGain() {
        return { gain: new FakeParam(), connect: () => undefined }
      }
      createStereoPanner() {
        return { pan: new FakeParam(), connect: () => undefined }
      }
      createBufferSource() {
        sources++
        return {
          buffer: null,
          playbackRate: new FakeParam(),
          connect: () => undefined,
          start: () => undefined,
        }
      }
      decodeAudioData(): Promise<AudioBuffer> {
        decodes++
        return Promise.resolve(fakeBuffer())
      }
      startRendering(): Promise<AudioBuffer> {
        return Promise.resolve(fakeBuffer())
      }
    }
    vi.stubGlobal('OfflineAudioContext', FakeOfflineContext)
    try {
      const buffer = await renderAudioMix(d, 20)
      expect(buffer).not.toBeNull()
      expect(decodes).toBe(1)
      expect(sources).toBe(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('returns no audio track when every clip is skipped by the loop gates', async () => {
    // Regression: the early-out used to run only `clipRendersAudio`, so a
    // muted, reversed or rate-dropped clip passed the gate, the loop scheduled
    // nothing, and the MP4 got a silent AAC track instead of no track at all.
    // The gate now shares the loop's predicate; assert through renderAudioMix.
    const file = new File([new Uint8Array([1, 2, 3])], 'm.mp4', { type: 'video/mp4' })
    const movie = { ...asset({ hasAudio: true, url: 'blob:v' }), file }
    const shaped = (setup: (c: Clip) => void): Doc => {
      const clip = videoClip({ id: 'cv' })
      setup(clip)
      return doc([{ kind: 'video', clips: [clip] }], [movie])
    }
    const mutedTrack = shaped(() => undefined)
    mutedTrack.project.tracks[0].muted = true
    const cases: [string, Doc][] = [
      [
        'muted clip',
        shaped((c) => {
          c.muted = true
        }),
      ],
      [
        'reversed clip',
        shaped((c) => {
          c.reverse = true
        }),
      ],
      [
        'rate-changing curve',
        shaped((c) => {
          c.keyframes = {
            timeScale: [
              { time: 0, value: 1 },
              { time: 2, value: 2 },
            ],
          }
        }),
      ],
      ['muted track', mutedTrack],
    ]

    let contexts = 0
    class FakeOfflineContext {
      constructor() {
        contexts++
      }
    }
    vi.stubGlobal('OfflineAudioContext', FakeOfflineContext)
    try {
      for (const [name, d] of cases) expect(await renderAudioMix(d, 20), name).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
    // Every shape short-circuited before a mix context was built.
    expect(contexts).toBe(0)
  })
})

describe('clipCrossfadeSchedule', () => {
  const crossfaded = () => {
    // A (0..3, 1 s transitionOut) overlaps B (2..5) by 1 s: span 2..3.
    const a = audioClip({
      id: 'ca',
      start: 0,
      duration: 3,
      transitionOut: { type: 'crossfade' as const, duration: 1 },
    })
    const b = audioClip({ id: 'cb', start: 2, duration: 3 })
    return createTrack('audio', 1, { id: 'track_a', clips: [a, b] })
  }

  it('ramps the outgoing clip 1 to 0 across the span', () => {
    const track = crossfaded()
    expect(clipCrossfadeSchedule(track.clips[0], track)).toEqual([
      { time: 2, value: 1, kind: 'set' },
      { time: 3, value: 0, kind: 'ramp' },
    ])
  })

  it('ramps the incoming clip 0 to 1 across the same span', () => {
    const track = crossfaded()
    expect(clipCrossfadeSchedule(track.clips[1], track)).toEqual([
      { time: 2, value: 0, kind: 'set' },
      { time: 3, value: 1, kind: 'ramp' },
    ])
  })

  it('stays silent for clips with no crossfade on either side', () => {
    const a = audioClip({ id: 'ca', start: 0, duration: 2 })
    const b = audioClip({ id: 'cb', start: 2, duration: 2 })
    const track = createTrack('audio', 1, { id: 'track_a', clips: [a, b] })
    expect(clipCrossfadeSchedule(track.clips[0], track)).toEqual([])
    expect(clipCrossfadeSchedule(track.clips[1], track)).toEqual([])
  })
})

describe('text in the export', () => {
  it('plans a draw for text clips (they have no decoded frame)', () => {
    const d = doc(
      [{ kind: 'text', clips: [createTextClip({ id: 't1', start: 0, duration: 4 })] }],
      [],
    )
    expect(planVideoFrame(d, 1).draws.map((x) => x.clip.id)).toEqual(['t1'])
  })

  it('renders text through the shared compositor drawer (static lock)', () => {
    const src = readFileSync(new URL('../export/mp4.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/drawTextClip\(ctx, draw\.clip/)
  })

  it('releases the encoder on cancel/error through Output.cancel in the finally (static lock)', () => {
    const src = readFileSync(new URL('../export/mp4.ts', import.meta.url), 'utf8')
    // The finally must call output.cancel() guarded by the finalize flag:
    // mediabunny releases encoders only via cancel() or finalize().
    expect(src).toMatch(/let finalized = false/)
    expect(src).toMatch(/finalized = true/)
    expect(src).toMatch(/if \(!finalized\) \{\s*try \{\s*await output\.cancel\(\)/)
  })
})

describe('preloadImage', () => {
  it('drops a failed decode through the failure callback and still resolves', async () => {
    const failures: string[] = []
    const img = { decode: () => Promise.reject(new Error('broken')) }
    await expect(
      preloadImage(img as never, () => failures.push('dropped')),
    ).resolves.toBeUndefined()
    expect(failures).toEqual(['dropped'])
  })

  it('keeps a successful decode cached', async () => {
    const failures: string[] = []
    const img = { decode: () => Promise.resolve() }
    await preloadImage(img as never, () => failures.push('dropped'))
    expect(failures).toEqual([])
  })

  it('drops failed images from the export cache (call-site lock)', () => {
    const src = readFileSync(new URL('../export/mp4.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/preloadImage\(img, \(\) => imageCache\.delete\(asset\.id\)\)/)
  })

  it('uses the load/error fallback where decode() is unavailable', async () => {
    const handlers = new Map<string, () => void>()
    const img = {
      addEventListener: (type: string, fn: () => void) => handlers.set(type, fn),
    }
    const failures: string[] = []
    const load = preloadImage(img as never, () => failures.push('dropped'))
    handlers.get('load')?.()
    await load
    expect(failures).toEqual([])

    const error = preloadImage(img as never, () => failures.push('dropped'))
    handlers.get('error')?.()
    await expect(error).resolves.toBeUndefined()
    expect(failures).toEqual(['dropped'])
  })
})

describe('closeDecodedFrames', () => {
  it('closes decoded surfaces, skips images and swallows double closes', () => {
    const closed: string[] = []
    const frames = new Map<string, unknown>([
      ['a', { close: () => closed.push('a') }],
      ['b', {}], // image element: nothing to close
      [
        'c',
        {
          close: () => {
            throw new Error('already closed')
          },
        },
      ],
    ])
    expect(() => closeDecodedFrames(frames as never)).not.toThrow()
    expect(closed).toEqual(['a'])
  })
})

describe('pickAudioCodec', () => {
  it('uses AAC when the browser can encode it', async () => {
    expect(await pickAudioCodec(async () => true)).toBe('aac')
  })

  it('falls back to Opus where AAC encoding is unavailable (desktop Linux, Firefox)', async () => {
    expect(await pickAudioCodec(async () => false)).toBe('opus')
  })
})

describe('videoAssetIds + needsReverse', () => {
  it('collects decoded-asset ids and detects reverse', () => {
    const a = asset()
    const d = doc([{ kind: 'video', clips: [videoClip()] }], [a])
    const plan = Array.from({ length: 3 }, (_, i) => planVideoFrame(d, i))
    expect(videoAssetIds(plan)).toEqual(new Set(['m1']))
    expect(needsReverse(d)).toBe(false)
    const d2 = doc([{ kind: 'video', clips: [videoClip({ reverse: true })] }], [a])
    expect(needsReverse(d2)).toBe(true)
  })
})
