import { describe, expect, it } from 'vitest'
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
import { closeDecodedFrames, pickAudioCodec, preloadImage } from '../export/mp4'
import { createClip, createTextClip, createTrack } from '../factories'
import type { Clip, Doc, MediaAsset } from '../types'

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
