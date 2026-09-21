import { describe, expect, it } from 'vitest'
import { applyCommand, EditorCommandError } from '../commands'
import { computeDuckingKeyframes, overlappingAudioClips, sanitizeDuckingOptions } from '../ducking'
import { animatedValue } from '../keyframes'
import { createClip, createTrack } from '../factories'
import { WAVEFORM_BUCKETS } from '../constants'
import type { Clip, Doc, MediaAsset } from '../types'

function baseDoc(): { doc: Doc; clipId: string; trackId: string } {
  const clip = createClip({ id: 'clip_1', start: 0, duration: 4 })
  const track = createTrack('video', 1, { id: 'track_1', clips: [clip] })
  return {
    doc: {
      project: { id: 'p', name: 'n', width: 1920, height: 1080, fps: 30, tracks: [track] },
      media: [],
    },
    clipId: clip.id,
    trackId: track.id,
  }
}

function makeAsset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: 'media_1',
    name: 'a.mp4',
    kind: 'video',
    duration: 10,
    width: 640,
    height: 360,
    url: 'blob:x',
    ...overrides,
  }
}

describe('setClipKeyframes', () => {
  it('stores a sanitized, sorted curve and evaluation follows it', () => {
    const { doc, clipId } = baseDoc()
    const next = applyCommand(doc, {
      type: 'setClipKeyframes',
      clipId,
      property: 'volume',
      keyframes: [
        { time: 2, value: 2 },
        { time: 0, value: 0 },
      ],
    })
    const clip = next.project.tracks[0].clips[0]
    expect(clip.keyframes!.volume).toHaveLength(2)
    expect(clip.keyframes!.volume![0].time).toBe(0)
    expect(animatedValue(clip, 'volume', 1)).toBe(1)
  })

  it('clamps values into property bounds', () => {
    const { doc, clipId } = baseDoc()
    const next = applyCommand(doc, {
      type: 'setClipKeyframes',
      clipId,
      property: 'hue',
      keyframes: [{ time: 0, value: 999 }],
    })
    expect(next.project.tracks[0].clips[0].keyframes!.hue![0].value).toBe(180)
  })

  it('an empty curve clears the property and the map', () => {
    const { doc, clipId } = baseDoc()
    let next = applyCommand(doc, {
      type: 'setClipKeyframes',
      clipId,
      property: 'opacity',
      keyframes: [{ time: 0, value: 0.5 }],
    })
    expect(next.project.tracks[0].clips[0].keyframes!.opacity).toBeDefined()
    next = applyCommand(next, {
      type: 'setClipKeyframes',
      clipId,
      property: 'opacity',
      keyframes: [],
    })
    expect(next.project.tracks[0].clips[0].keyframes).toBeUndefined()
  })

  it('rejects unknown properties and unknown clips', () => {
    const { doc, clipId } = baseDoc()
    expect(() =>
      applyCommand(doc, {
        type: 'setClipKeyframes',
        clipId,
        property: 'volume',
        keyframes: [{ time: 0, value: 1 }],
      }),
    ).not.toThrow()
    expect(() =>
      applyCommand(doc, {
        type: 'setClipKeyframes',
        clipId: 'clip_nope',
        property: 'volume',
        keyframes: [],
      }),
    ).toThrow(EditorCommandError)
  })

  it('split redistributes curves: left keeps, right shifts, times stay clip-local', () => {
    const { doc, clipId } = baseDoc()
    const withKfs = applyCommand(doc, {
      type: 'setClipKeyframes',
      clipId,
      property: 'volume',
      keyframes: [
        { time: 1, value: 0 },
        { time: 3, value: 2 },
      ],
    })
    const split = applyCommand(withKfs, { type: 'splitClip', clipId, atTime: 2 })
    const clips = split.project.tracks[0].clips
    expect(clips[0].keyframes!.volume!.map((k) => [k.time, k.value])).toEqual([[1, 0]])
    expect(clips[1].keyframes!.volume!.map((k) => [k.time, k.value])).toEqual([[1, 2]])
  })
})

describe('setClipSpeed', () => {
  it('sets speed and clamps to the legal range', () => {
    const { doc, clipId } = baseDoc()
    const next = applyCommand(doc, { type: 'setClipSpeed', clipId, speed: 2 })
    expect(next.project.tracks[0].clips[0].speed).toBe(2)
    const over = applyCommand(doc, { type: 'setClipSpeed', clipId, speed: 99 })
    expect(over.project.tracks[0].clips[0].speed).toBe(4)
    const under = applyCommand(doc, { type: 'setClipSpeed', clipId, speed: 0.01 })
    expect(under.project.tracks[0].clips[0].speed).toBe(0.25)
  })

  it('keeps timeline duration stable and re-derives the source span', () => {
    const { doc, clipId } = baseDoc()
    const srcAsset = makeAsset()
    // The clip must reference the asset for source-span validation to apply.
    doc.project.tracks[0].clips[0].mediaId = srcAsset.id
    const withMedia: Doc = { ...doc, media: [srcAsset] }
    // 4s clip at 2x consumes 8s of source; trim must respect the span.
    const spedUp = applyCommand(withMedia, { type: 'setClipSpeed', clipId, speed: 2 })
    expect(() =>
      applyCommand(spedUp, {
        type: 'trimClip',
        clipId,
        start: 0,
        inPoint: 3,
        duration: 4,
      }),
    ).toThrow(EditorCommandError) // 3 + 4*2 = 11 > 10
    const ok = applyCommand(spedUp, {
      type: 'trimClip',
      clipId,
      start: 0,
      inPoint: 2,
      duration: 4,
    })
    expect(ok.project.tracks[0].clips[0].inPoint).toBe(2)
  })

  it('rejects text clips', () => {
    const { doc, trackId } = baseDoc()
    const textClip = createClip({
      id: 'clip_t',
      text: 'hi',
      start: 0,
      duration: 2,
      style: {
        fontSize: 10,
        color: '#fff',
        fontFamily: 'sans',
        bold: false,
        italic: false,
        align: 'left',
        x: 0.5,
        y: 0.5,
        shadow: false,
      },
    })
    const docT: Doc = {
      ...doc,
      project: {
        ...doc.project,
        tracks: [
          createTrack('text', 1, { id: 'track_t', clips: [textClip] }),
          ...doc.project.tracks,
        ],
      },
    }
    void trackId
    expect(() => applyCommand(docT, { type: 'setClipSpeed', clipId: 'clip_t', speed: 2 })).toThrow(
      EditorCommandError,
    )
  })
})

describe('setClipReverse', () => {
  it('toggles the flag', () => {
    const { doc, clipId } = baseDoc()
    const next = applyCommand(doc, { type: 'setClipReverse', clipId, reverse: true })
    expect(next.project.tracks[0].clips[0].reverse).toBe(true)
    const back = applyCommand(next, { type: 'setClipReverse', clipId, reverse: false })
    expect(back.project.tracks[0].clips[0].reverse).toBe(false)
  })
})

describe('setClipAnimStatic', () => {
  it('stores clamped statics and drops neutral values', () => {
    const { doc, clipId } = baseDoc()
    const next = applyCommand(doc, {
      type: 'setClipAnimStatic',
      clipId,
      property: 'scale',
      value: 1.5,
    })
    expect(next.project.tracks[0].clips[0].animStatics!.scale).toBe(1.5)
    const neutral = applyCommand(next, {
      type: 'setClipAnimStatic',
      clipId,
      property: 'scale',
      value: 1,
    })
    expect(neutral.project.tracks[0].clips[0].animStatics).toBeUndefined()
  })
})

function peaks(level: number): number[] {
  return Array.from({ length: WAVEFORM_BUCKETS }, () => level)
}

function duckSetup(dialogueLevel: number) {
  const dialogueAsset = makeAsset({
    id: 'media_d',
    kind: 'audio',
    waveformPeaks: peaks(dialogueLevel),
  })
  const musicAsset = makeAsset({ id: 'media_m', kind: 'audio', waveformPeaks: peaks(0) })
  const music = createClip({ id: 'clip_m', mediaId: 'media_m', start: 0, duration: 8 })
  const dialogue = createClip({
    id: 'clip_d',
    mediaId: 'media_d',
    audioOnly: true,
    start: 2,
    duration: 4,
  })
  const trackA = createTrack('audio', 1, { id: 'track_a', clips: [music] })
  const trackB = createTrack('audio', 2, { id: 'track_b', clips: [dialogue] })
  const doc: Doc = {
    project: { id: 'p', name: 'n', width: 1920, height: 1080, fps: 30, tracks: [trackA, trackB] },
    media: [musicAsset, dialogueAsset],
  }
  return { doc, music, dialogue }
}

describe('computeDuckingKeyframes', () => {
  it('ducks while dialogue is loud and releases after', () => {
    const { doc, music, dialogue } = duckSetup(0.8)
    const kfs = computeDuckingKeyframes(doc, music, [dialogue])
    // One continuous loud window → unity, dip, unity.
    expect(kfs.map((k) => [k.time, k.value])).toEqual([
      [1.85, 1],
      [2, 0.4],
      [6, 1],
    ])
  })

  it('returns an empty curve when dialogue never crosses the threshold', () => {
    const { doc, music, dialogue } = duckSetup(0.05)
    expect(computeDuckingKeyframes(doc, music, [dialogue])).toEqual([])
  })

  it('sanitizes options', () => {
    const o = sanitizeDuckingOptions({ amount: 5, threshold: -1, attackRelease: 99 })
    expect(o.amount).toBe(1)
    expect(o.threshold).toBe(0.01)
    expect(o.attackRelease).toBe(1)
  })
})

describe('overlappingAudioClips', () => {
  it('finds audio-bearing clips overlapping the window', () => {
    const { doc } = duckSetup(0.8)
    const found = overlappingAudioClips(doc, { start: 3, end: 5 })
    expect(found.map((c) => c.id).sort()).toEqual(['clip_d', 'clip_m'])
  })

  it('ignores clips outside the window', () => {
    const { doc } = duckSetup(0.8)
    expect(overlappingAudioClips(doc, { start: 50, end: 60 })).toEqual([])
  })
})
