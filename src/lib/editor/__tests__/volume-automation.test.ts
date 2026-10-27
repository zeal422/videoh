import { describe, expect, it } from 'vitest'

import {
  addVolumeKeyframe,
  clipCarriesSound,
  clampVolumeTime,
  dbToGain,
  dbToUnit,
  formatDb,
  gainToDb,
  gainToUnit,
  moveVolumeKeyframe,
  removeVolumeKeyframe,
  sampleVolumeCurve,
  unitToDb,
  unitToGain,
  DB_CEIL,
  DB_FLOOR,
} from '../volume-automation'
import { animatedValue } from '../keyframes'
import { clipGainSchedule, planAudioFrame } from '../export/offline'
import { createClip, createMediaAsset, createTrack } from '../factories'
import type { Clip, Doc, MediaAsset } from '../types'

const TOL = 1e-6

function audioDoc(clip: Clip, asset: MediaAsset): Doc {
  const track = createTrack('audio', 1, { clips: [clip] })
  return {
    project: {
      id: 'p',
      name: 'volume test',
      width: 1920,
      height: 1080,
      fps: 30,
      tracks: [track],
    },
    media: [asset],
  }
}

describe('gain and dB conversion', () => {
  it('maps unity to 0 dB and half gain to about -6 dB', () => {
    expect(gainToDb(1)).toBe(0)
    expect(gainToDb(0.5)).toBeCloseTo(-6.0206, 4)
    expect(gainToDb(2)).toBeCloseTo(6.0206, 4)
  })

  it('maps silence to negative infinity', () => {
    expect(gainToDb(0)).toBe(-Infinity)
    expect(gainToDb(-1)).toBe(-Infinity)
  })

  it('maps dB back to linear gain', () => {
    expect(dbToGain(0)).toBe(1)
    expect(dbToGain(-6.0206)).toBeCloseTo(0.5, 6)
    expect(dbToGain(-Infinity)).toBe(0)
    expect(dbToGain(Infinity)).toBe(2)
  })

  it('clamps gain to the keyframe bounds', () => {
    expect(dbToGain(30)).toBe(2)
    expect(dbToGain(-200)).toBeGreaterThan(0)
    expect(dbToGain(-200)).toBeLessThan(0.001)
  })

  it('round-trips every legal gain within tolerance', () => {
    for (const gain of [0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.5, 1.99, 2]) {
      expect(dbToGain(gainToDb(gain))).toBeCloseTo(gain, 6)
    }
  })
})

describe('dB formatting', () => {
  it('shows one decimal with a consistent minus sign', () => {
    expect(formatDb(1)).toBe('0.0 dB')
    expect(formatDb(0.5)).toBe('-6.0 dB')
    expect(formatDb(2)).toBe('6.0 dB')
  })

  it('reads -inf at or below the -60 dB floor', () => {
    expect(formatDb(0.001)).toBe('-inf dB') // exactly -60 dB
    expect(formatDb(0.0005)).toBe('-inf dB')
    expect(formatDb(0)).toBe('-inf dB')
  })

  it('never writes a cosmetic negative zero', () => {
    expect(formatDb(1.0000001)).toBe('0.0 dB')
  })
})

describe('graph y mapping', () => {
  it('puts the floor, -6, 0 and +6 dB at the expected positions', () => {
    expect(dbToUnit(DB_FLOOR)).toBe(0)
    expect(dbToUnit(-6)).toBeCloseTo(54 / 66, 10)
    expect(dbToUnit(0)).toBeCloseTo(60 / 66, 10)
    expect(dbToUnit(DB_CEIL)).toBe(1)
  })

  it('round-trips a display position through dB', () => {
    for (const unit of [0, 0.1, 0.5, 0.818, 0.909, 1]) {
      expect(dbToUnit(unitToDb(unit))).toBeCloseTo(unit, 10)
    }
  })

  it('plots a gain of zero at the floor and unity at its dB position', () => {
    expect(gainToUnit(0)).toBe(0)
    expect(gainToUnit(1)).toBeCloseTo(60 / 66, 10)
    expect(gainToUnit(2)).toBe(1)
  })

  it('maps the very bottom to true silence and the top to +6 dB', () => {
    expect(unitToGain(0)).toBe(0)
    // The display top is +6 dB, slightly below the +6.02 dB gain bound of 2.
    expect(unitToGain(1)).toBeCloseTo(dbToGain(6), 10)
    expect(unitToGain(1)).toBeLessThan(2)
  })
})

describe('sampleVolumeCurve', () => {
  it('samples the full clip duration inclusively', () => {
    const clip = createClip({ id: 'c', duration: 4, gain: 0.5 })
    const samples = sampleVolumeCurve(clip, 5)
    expect(samples.map((s) => s.time)).toEqual([0, 1, 2, 3, 4])
    for (const sample of samples) {
      expect(sample.gain).toBe(0.5)
      expect(sample.db).toBeCloseTo(gainToDb(0.5), 10)
      expect(sample.unit).toBeCloseTo(gainToUnit(0.5), 10)
    }
  })

  it('matches animatedValue through an eased segment', () => {
    const clip = createClip({
      id: 'c',
      duration: 4,
      keyframes: {
        volume: [
          { time: 0, value: 1, interpolation: 'easeInOut' },
          { time: 4, value: 0.25, interpolation: 'linear' },
        ],
      },
    })
    for (const sample of sampleVolumeCurve(clip, 17)) {
      expect(sample.gain).toBeCloseTo(animatedValue(clip, 'volume', sample.time), 10)
    }
    const middle = sampleVolumeCurve(clip, 9)[4]
    expect(middle.gain).toBeLessThan(1)
    expect(middle.gain).toBeGreaterThan(0.25)
  })

  it('returns one sample at 0 for count 1 and none for count 0', () => {
    const clip = createClip({ id: 'c', duration: 4 })
    expect(sampleVolumeCurve(clip, 1)).toEqual([{ time: 0, gain: 1, db: 0, unit: 60 / 66 }])
    expect(sampleVolumeCurve(clip, 0)).toEqual([])
  })
})

describe('volume keyframe helpers', () => {
  it('seeds an empty curve at the click time with the static gain', () => {
    const clip = createClip({ id: 'c', duration: 4, gain: 0.5 })
    expect(addVolumeKeyframe(clip, 1.5)).toEqual([
      { time: 1.5, value: 0.5, interpolation: 'linear' },
    ])
  })

  it('adds an interpolated point to an existing curve', () => {
    const clip = createClip({
      id: 'c',
      duration: 4,
      keyframes: {
        volume: [
          { time: 0, value: 1 },
          { time: 4, value: 0.5 },
        ],
      },
    })
    const next = addVolumeKeyframe(clip, 2)
    expect(next).toHaveLength(3)
    expect(next[1].time).toBe(2)
    expect(next[1].value).toBeCloseTo(0.75, 10)
  })

  it('accepts and preserves a keyframe at exactly the clip duration', () => {
    const clip = createClip({ id: 'c', duration: 4, gain: 0.5 })
    const added = addVolumeKeyframe(clip, 4)
    expect(added[0].time).toBe(4)
    expect(clampVolumeTime(clip, 9)).toBe(4)
  })

  it('clamps an add past the end without epsilon subtraction', () => {
    const clip = createClip({ id: 'c', duration: 4 })
    expect(addVolumeKeyframe(clip, 9)[0].time).toBe(4)
  })

  it('updates an existing point at the same time instead of duplicating it', () => {
    const clip = createClip({
      id: 'c',
      duration: 4,
      keyframes: { volume: [{ time: 2, value: 1 }] },
    })
    const next = addVolumeKeyframe(clip, 2, 0.25)
    expect(next).toHaveLength(1)
    expect(next[0].value).toBe(0.25)
  })

  it('removes a point and clears the last one', () => {
    const clip = createClip({
      id: 'c',
      duration: 4,
      keyframes: {
        volume: [
          { time: 0, value: 1 },
          { time: 2, value: 0.5 },
        ],
      },
    })
    // The helper preserves the stored shape; the command sanitizes it.
    expect(removeVolumeKeyframe(clip, 0)).toEqual([{ time: 2, value: 0.5 }])
    const one = createClip({
      id: 'c',
      duration: 4,
      keyframes: { volume: [{ time: 2, value: 0.5 }] },
    })
    expect(removeVolumeKeyframe(one, 0)).toEqual([])
  })

  it('clamps a moved value and time', () => {
    const clip = createClip({
      id: 'c',
      duration: 4,
      keyframes: { volume: [{ time: 1, value: 1 }] },
    })
    const next = moveVolumeKeyframe(clip, 0, 9, 5)
    expect(next[0].time).toBe(4)
    expect(next[0].value).toBe(2)
    const low = moveVolumeKeyframe(clip, 0, -2, -1)
    expect(low[0].time).toBe(0)
    expect(low[0].value).toBe(0)
  })

  it('re-sorts a crossing and keeps the grabbed point', () => {
    const clip = createClip({
      id: 'c',
      duration: 6,
      keyframes: {
        volume: [
          { time: 1, value: 0.25 },
          { time: 3, value: 0.75 },
        ],
      },
    })
    const next = moveVolumeKeyframe(clip, 0, 4, 0.25)
    expect(next.map((k) => k.time)).toEqual([3, 4])
    expect(next.map((k) => k.value)).toEqual([0.75, 0.25])
  })

  it('never mutates the input clip or its keyframe array', () => {
    const original = createClip({
      id: 'c',
      duration: 4,
      keyframes: { volume: [{ time: 1, value: 1 }] },
    })
    const snapshot = structuredClone(original)
    addVolumeKeyframe(original, 2)
    removeVolumeKeyframe(original, 0)
    moveVolumeKeyframe(original, 0, 3, 0.5)
    sampleVolumeCurve(original, 5)
    expect(original).toEqual(snapshot)
  })
})

describe('clipCarriesSound', () => {
  it('is true for an audio asset and false for an image or text clip', () => {
    const audio = createMediaAsset({ id: 'a', kind: 'audio', duration: 10, url: 'blob:a' })
    const audioClip = createClip({ id: 'ca', mediaId: audio.id, duration: 4 })
    expect(clipCarriesSound(audioDoc(audioClip, audio), audioClip)).toBe(true)

    const image = createMediaAsset({ id: 'i', kind: 'image', duration: 0, url: 'blob:i' })
    const imageClip = createClip({ id: 'ci', mediaId: image.id, duration: 4 })
    expect(
      clipCarriesSound(
        { project: { ...audioDoc(audioClip, image).project }, media: [image] },
        imageClip,
      ),
    ).toBe(false)

    const text = createClip({ id: 'ct', text: 'hello', duration: 4 })
    expect(clipCarriesSound(audioDoc(text, audio), text)).toBe(false)
  })

  it('puts the envelope on the audio twin, not the linked video half', () => {
    const asset = createMediaAsset({
      id: 'v',
      kind: 'video',
      duration: 10,
      url: 'blob:v',
      hasAudio: true,
    })
    const video = createClip({ id: 'v1', mediaId: asset.id, duration: 4, linkId: 'L' })
    const twin = createClip({
      id: 'a1',
      mediaId: asset.id,
      duration: 4,
      linkId: 'L',
      audioOnly: true,
    })
    const videoTrack = createTrack('video', 1, { clips: [video] })
    const audioTrack = createTrack('audio', 1, { clips: [twin] })
    const doc: Doc = {
      project: {
        id: 'p',
        name: 'pair',
        width: 1920,
        height: 1080,
        fps: 30,
        tracks: [videoTrack, audioTrack],
      },
      media: [asset],
    }
    expect(clipCarriesSound(doc, video)).toBe(false)
    expect(clipCarriesSound(doc, twin)).toBe(true)
  })

  it('shows a solo video with embedded audio and hides one without', () => {
    const withAudio = createMediaAsset({
      id: 'v1',
      kind: 'video',
      duration: 10,
      url: 'blob:v1',
      hasAudio: true,
    })
    const withoutAudio = createMediaAsset({
      id: 'v2',
      kind: 'video',
      duration: 10,
      url: 'blob:v2',
      hasAudio: false,
    })
    const solo = createClip({ id: 'c1', mediaId: withAudio.id, duration: 4 })
    const quiet = createClip({ id: 'c2', mediaId: withoutAudio.id, duration: 4 })
    expect(clipCarriesSound(audioDoc(solo, withAudio), solo)).toBe(true)
    expect(clipCarriesSound(audioDoc(quiet, withoutAudio), quiet)).toBe(false)
  })

  it('checks a compound through its sequence', () => {
    const audio = createMediaAsset({ id: 'a', kind: 'audio', duration: 10, url: 'blob:a' })
    const image = createMediaAsset({ id: 'i', kind: 'image', duration: 0, url: 'blob:i' })
    const innerAudio = createClip({ id: 'ia', mediaId: audio.id, duration: 4 })
    const innerImage = createClip({ id: 'ii', mediaId: image.id, duration: 4 })
    const compound = createClip({ id: 'cp', sequenceId: 'seq', duration: 4 })
    const rootTrack = createTrack('video', 1, { clips: [compound] })
    const doc: Doc = {
      project: {
        id: 'p',
        name: 'compound',
        width: 1920,
        height: 1080,
        fps: 30,
        tracks: [rootTrack],
        sequences: [
          { id: 'seq', name: 'inner', tracks: [createTrack('audio', 1, { clips: [innerAudio] })] },
          {
            id: 'silent',
            name: 'silent',
            tracks: [createTrack('video', 1, { clips: [innerImage] })],
          },
        ],
      },
      media: [audio, image],
    }
    expect(clipCarriesSound(doc, compound)).toBe(true)
    const silent = createClip({ id: 'cp2', sequenceId: 'silent', duration: 4 })
    expect(clipCarriesSound(doc, silent)).toBe(false)
  })
})

describe('engine gain schedule after an edit', () => {
  it('preview plan, export schedule and the sampled curve agree', () => {
    const asset = createMediaAsset({
      id: 'a',
      kind: 'audio',
      duration: 10,
      url: 'blob:a',
    })
    const start = createClip({
      id: 'c',
      mediaId: asset.id,
      duration: 4,
      gain: 1,
      keyframes: { volume: [{ time: 0, value: 1 }] },
    })
    // The edit the envelope's double-click performs: add an interpolated point.
    const edited = createClip({
      ...start,
      keyframes: { volume: addVolumeKeyframe(start, 2, 0.25) },
    })
    const doc = audioDoc(edited, asset)

    expect(animatedValue(edited, 'volume', 2)).toBeCloseTo(0.25, 10)
    const exportEvent = clipGainSchedule(edited).find((e) => e.time === 2)
    expect(exportEvent?.value).toBeCloseTo(0.25, 10)
    const audible = planAudioFrame(doc, 2).audible.find((a) => a.clip.id === edited.id)
    expect(audible?.gain).toBeCloseTo(0.25, 10)

    const sampled = sampleVolumeCurve(edited, 9).find((s) => s.time === 2)
    expect(sampled?.gain).toBeCloseTo(0.25, 10)
    expect(gainToDb(sampled!.gain)).toBeCloseTo(gainToDb(0.25), 10)
  })
})
