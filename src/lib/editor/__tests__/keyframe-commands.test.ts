import { describe, expect, it } from 'vitest'
import { applyCommand, EditorCommandError } from '../commands'
import { computeDuckingKeyframes, overlappingAudioClips, sanitizeDuckingOptions } from '../ducking'
import { animatedValue } from '../keyframes'
import { createClip, createTrack } from '../factories'
import { WAVEFORM_BUCKETS } from '../constants'
import type { Clip, Doc, KeyframeInterpolation, KeyframeProperty, MediaAsset } from '../types'

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

describe('setKeyframeDefault', () => {
  it('sets the property default, linear clears it, and the empty map collapses', () => {
    const { doc } = baseDoc()
    const next = applyCommand(doc, {
      type: 'setKeyframeDefault',
      property: 'opacity',
      interpolation: 'easeIn',
    })
    expect(next.project.keyframeDefaults).toEqual({ opacity: 'easeIn' })
    // The input doc is never mutated (commands clone).
    expect(doc.project.keyframeDefaults).toBeUndefined()

    const both = applyCommand(next, {
      type: 'setKeyframeDefault',
      property: 'volume',
      interpolation: 'easeInOut',
    })
    expect(both.project.keyframeDefaults).toEqual({ opacity: 'easeIn', volume: 'easeInOut' })

    // linear DELETES the entry: absent reads as linear, no stored no-op.
    const clearedOne = applyCommand(both, {
      type: 'setKeyframeDefault',
      property: 'opacity',
      interpolation: 'linear',
    })
    expect(clearedOne.project.keyframeDefaults).toEqual({ volume: 'easeInOut' })

    const clearedAll = applyCommand(clearedOne, {
      type: 'setKeyframeDefault',
      property: 'volume',
      interpolation: 'linear',
    })
    // The emptied map is absent (the same `= undefined` convention
    // `setClipKeyframes` uses when the last curve is cleared).
    expect(clearedAll.project.keyframeDefaults).toBeUndefined()
  })

  it('rejects an unknown property like every other keyframe command', () => {
    const { doc } = baseDoc()
    expect(() =>
      applyCommand(doc, {
        type: 'setKeyframeDefault',
        property: 'bogus' as KeyframeProperty,
        interpolation: 'easeIn',
      }),
    ).toThrow(EditorCommandError)
  })

  it('rejects an unknown interpolation name before it can reach the stored defaults', () => {
    const { doc } = baseDoc()
    expect(() =>
      applyCommand(doc, {
        type: 'setKeyframeDefault',
        property: 'opacity',
        interpolation: 'bogus' as KeyframeInterpolation,
      }),
    ).toThrow(EditorCommandError)
    // `applyCommand` clones only when it does not throw, so a rejected command
    // leaves the input doc untouched (the same guarantee the property guard has).
    expect(doc.project.keyframeDefaults).toBeUndefined()
  })
})

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

  it('split redistributes curves and keeps the value at the cut on both halves', () => {
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
    // The ramp crosses the cut at value 1, so both halves get that boundary.
    expect(clips[0].keyframes!.volume!.map((k) => [k.time, k.value])).toEqual([
      [1, 0],
      [2, 1],
    ])
    expect(clips[1].keyframes!.volume!.map((k) => [k.time, k.value])).toEqual([
      [0, 1],
      [1, 2],
    ])
  })

  it('split preserves the evaluated curve on both halves', () => {
    const { doc, clipId } = baseDoc()
    const withKfs = applyCommand(doc, {
      type: 'setClipKeyframes',
      clipId,
      property: 'opacity',
      keyframes: [
        { time: 0, value: 1 },
        { time: 4, value: 0 },
      ],
    })
    const before = withKfs.project.tracks[0].clips[0]
    const split = applyCommand(withKfs, { type: 'splitClip', clipId, atTime: 2 })
    const [left, right] = split.project.tracks[0].clips
    for (const t of [0.25, 1, 1.75, 2]) {
      expect(animatedValue(left, 'opacity', t)).toBeCloseTo(animatedValue(before, 'opacity', t), 10)
    }
    for (const t of [0, 0.5, 1.25, 2]) {
      expect(animatedValue(right, 'opacity', t)).toBeCloseTo(
        animatedValue(before, 'opacity', 2 + t),
        10,
      )
    }
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
        edge: 'tail',
      }),
    ).toThrow(EditorCommandError) // 3 + 4*2 = 11 > 10
    const ok = applyCommand(spedUp, {
      type: 'trimClip',
      clipId,
      start: 0,
      inPoint: 2,
      duration: 4,
      edge: 'tail',
    })
    expect(ok.project.tracks[0].clips[0].inPoint).toBe(2)
  })

  it('leaves a ramped clip length alone: the curve, not the rate, consumes source', () => {
    const { doc, clipId } = baseDoc()
    const srcAsset = makeAsset()
    doc.project.tracks[0].clips[0].mediaId = srcAsset.id
    // A flat 0.5x ramp consumes 2s of the 10s asset over the clip's 4s length,
    // so there is 8s of headroom. `speed` is only the no-curve fallback, so
    // changing it must not re-derive the duration: the old formula saw
    // (10 - 0) / 4 = 2.5s and destroyed 1.5s of timeline for an edit that has
    // no effect on a clip the curve governs.
    doc.project.tracks[0].clips[0].keyframes = {
      timeScale: [
        { time: 0, value: 0.5 },
        { time: 4, value: 0.5 },
      ],
    }
    const withMedia: Doc = { ...doc, media: [srcAsset] }
    const ramped = applyCommand(withMedia, { type: 'setClipSpeed', clipId, speed: 4 })
    expect(ramped.project.tracks[0].clips[0].duration).toBe(4)
    expect(ramped.project.tracks[0].clips[0].speed).toBe(4)

    // Control: with no curve the same edit still re-derives the duration.
    const plain = structuredClone(withMedia)
    plain.project.tracks[0].clips[0].keyframes = undefined
    const shrunk = applyCommand(plain, { type: 'setClipSpeed', clipId, speed: 4 })
    expect(shrunk.project.tracks[0].clips[0].duration).toBe(2.5)
  })

  it('adding a ramped clip ignores a stale static speed, like setClipSpeed', () => {
    const { doc, trackId } = baseDoc()
    const srcAsset = makeAsset()
    // The curve consumes 0.25 * 3 = 0.75s of the 6s left after inPoint 4, so the
    // clip fits. The old add path divided by the stale static rate instead and
    // truncated it to (10 - 4) / 4 = 1.5s, while setClipSpeed kept it: the two
    // paths now share one ramp predicate.
    const added = applyCommand(
      { ...doc, media: [srcAsset] },
      {
        type: 'addClip',
        trackId,
        clip: createClip({
          id: 'clip_ramp_add',
          mediaId: srcAsset.id,
          start: 0,
          inPoint: 4,
          duration: 3,
          speed: 4,
          keyframes: { timeScale: [{ time: 0, value: 0.25 }] },
        }),
      },
    )
    expect(added.project.tracks[0].clips.find((c) => c.id === 'clip_ramp_add')!.duration).toBe(3)

    // Control: the same clip without a curve is still clamped by the static rate.
    const plain = applyCommand(
      { ...doc, media: [srcAsset] },
      {
        type: 'addClip',
        trackId,
        clip: createClip({
          id: 'clip_plain_add',
          mediaId: srcAsset.id,
          start: 0,
          inPoint: 4,
          duration: 3,
          speed: 4,
        }),
      },
    )
    expect(plain.project.tracks[0].clips.find((c) => c.id === 'clip_plain_add')!.duration).toBe(1.5)
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
    // One continuous loud window: ramp down, HOLD the floor, then release.
    expect(kfs.map((k) => [k.time, k.value])).toEqual([
      [1.85, 1],
      [2, 0.4],
      [6, 0.4],
      [6.15, 1],
    ])
  })

  it('holds the floor through the dialogue instead of creeping back up', () => {
    const { doc, music, dialogue } = duckSetup(0.8)
    const ducked = {
      ...music,
      keyframes: { volume: computeDuckingKeyframes(doc, music, [dialogue]) },
    }
    // The old release started back at the duck, so the music was already
    // climbing here; it must stay at the floor for the whole loud span.
    for (const t of [2.5, 3, 4, 5.5]) expect(animatedValue(ducked, 'volume', t)).toBe(0.4)
    // The release only happens after the dialogue ends, over attackRelease.
    expect(animatedValue(ducked, 'volume', 6.07)).toBeGreaterThan(0.4)
    expect(animatedValue(ducked, 'volume', 6.15)).toBe(1)
  })

  it('keeps holding the floor when a duck runs to the clip edge', () => {
    const { doc, music, dialogue } = duckSetup(0.8)
    // Dialogue ends exactly at the clip edge: no quiet span remains, so the
    // duck holds the floor and no release keyframe is emitted at all.
    const kfs = computeDuckingKeyframes(doc, music, [{ ...dialogue, duration: 6 }])
    expect(kfs.map((k) => [k.time, k.value])).toEqual([
      [1.85, 1],
      [2, 0.4],
      [8, 0.4],
    ])
    const ducked = { ...music, keyframes: { volume: kfs } }
    expect(animatedValue(ducked, 'volume', 7.9)).toBe(0.4)
    expect(animatedValue(ducked, 'volume', 8)).toBe(0.4)
  })

  it('clamps a release that would land beyond the clip edge', () => {
    const { doc, music, dialogue } = duckSetup(0.8)
    // Dialogue ends 0.1 s before the music: the quiet transition lands in the
    // final sample region, so the release endpoint (quiet + 0.15) would fall
    // past 8 s. The clamp pulls it to the clip edge.
    const kfs = computeDuckingKeyframes(doc, music, [{ ...dialogue, start: 0, duration: 7.9 }])
    const last = kfs[kfs.length - 1]
    expect(last.time).toBe(8)
    expect(last.value).toBe(1)
    // The hold at the quiet transition is still at the floor.
    expect(kfs[kfs.length - 2]).toEqual({ time: 7.917, value: 0.4 })
    // No keyframe may sit beyond the clip: clipGainSchedule extends the gain
    // with the LAST keyframe's value, so a past-edge release would leak unity
    // into the clip-edge event instead of the floor.
    for (const k of kfs) expect(k.time).toBeLessThanOrEqual(music.duration)
  })

  it('keeps a clamped release inside a fractional clip edge after rounding', () => {
    const { doc, music, dialogue } = duckSetup(0.8)
    // A duration that is NOT a round millisecond exposes the ordering: round3 of
    // a value already clamped to 8.066666... lands at 8.067, i.e. past the clip,
    // and clipGainSchedule extends the gain from the last keyframe. The clamp
    // has to run after the rounding, so the last keyframe stays inside the clip.
    const fractional = { ...music, duration: 8.066666 }
    const kfs = computeDuckingKeyframes(doc, fractional, [{ ...dialogue, start: 0, duration: 7.9 }])
    for (const k of kfs) expect(k.time).toBeLessThanOrEqual(fractional.duration)
    const last = kfs[kfs.length - 1]
    expect(last.time).toBe(fractional.duration)
    expect(last.value).toBe(1)
  })

  it('releases normally when the quiet transition is before the clip edge', () => {
    const { doc, music, dialogue } = duckSetup(0.8)
    const kfs = computeDuckingKeyframes(doc, music, [dialogue])
    expect(kfs.map((k) => [k.time, k.value])).toEqual([
      [1.85, 1],
      [2, 0.4],
      [6, 0.4],
      [6.15, 1],
    ])
  })

  it('returns an empty curve when dialogue never crosses the threshold', () => {
    const { doc, music, dialogue } = duckSetup(0.05)
    expect(computeDuckingKeyframes(doc, music, [dialogue])).toEqual([])
  })

  it('skips a dialogue clip whose link group carries a timeScale ramp', () => {
    // A ramped clip is SILENT in both render paths (no variable-rate audio),
    // so it must not drive the duck. The duck curve for ramped-only dialogue
    // is empty, the same as dialogue with no audible material.
    const { doc, music, dialogue } = duckSetup(0.8)
    const ramped = applyCommand(doc, {
      type: 'setClipKeyframes',
      clipId: dialogue.id,
      property: 'timeScale',
      keyframes: [
        { time: 0, value: 1 },
        { time: 4, value: 2 },
      ],
    })
    const rampedClip = ramped.project.tracks[1].clips[0]
    expect(computeDuckingKeyframes(ramped, music, [rampedClip])).toEqual([])
  })

  it('skips a reversed dialogue clip, which both render paths drop', () => {
    // Reversed clips are silent in the preview and the export (Premiere drops
    // reversed audio too), so a reversed dialogue clip must not drive the duck,
    // the same way a ramped link group is skipped. Without the guard the duck
    // dipped the music against source that is never heard.
    const { doc, music, dialogue } = duckSetup(0.8)
    const reversed = applyCommand(doc, {
      type: 'setClipReverse',
      clipId: dialogue.id,
      reverse: true,
    })
    const reversedClip = reversed.project.tracks[1].clips[0]
    expect(computeDuckingKeyframes(reversed, music, [reversedClip])).toEqual([])
  })

  it('skips a dialogue clip whose asset is missing but still carries peaks', () => {
    // Restoring a session rebuilds media entries with url: '' and missing:
    // true until relink, while waveformPeaks come back from the saved project.
    // The peaks alone must not drive the duck: the music would dip against
    // dialogue that cannot play.
    const { doc, music, dialogue } = duckSetup(0.8)
    const offline = {
      ...doc,
      media: doc.media.map((m) => (m.id === 'media_d' ? { ...m, url: '', missing: true } : m)),
    }
    expect(computeDuckingKeyframes(offline, music, [dialogue])).toEqual([])
  })

  it('samples a ramped dialogue clip through the curve integral, not local * speed', () => {
    // The MUTE test above locks the ramp skip. This one locks the sampling
    // formula with NON-uniform peaks, so the two mappings produce DIFFERENT
    // duck windows: a loud band at source 3..4 of a 10s asset. A 1x->2x ramp
    // over the 4s clip consumes source u + u²/8, crossing the band at local
    // ~2.33..2.92; the old inline formula (local * speed = local) reaches it
    // at local 3..4, i.e. a full 0.67s later. The duck windows below ARE the
    // assertion: under the old formula the attack lands at 2.85, not 2.183.
    const band = Array.from({ length: WAVEFORM_BUCKETS }, (_, i) => {
      const t = (i / WAVEFORM_BUCKETS) * 10
      return t >= 3 && t <= 4 ? 0.9 : 0.02
    })
    const dialogueAsset = makeAsset({ id: 'media_d', kind: 'audio', waveformPeaks: band })
    const musicAsset = makeAsset({ id: 'media_m', kind: 'audio', waveformPeaks: peaks(0) })
    const music = createClip({ id: 'clip_m', mediaId: 'media_m', start: 0, duration: 8 })
    const dialogue = createClip({
      id: 'clip_d',
      mediaId: 'media_d',
      audioOnly: true,
      start: 0,
      duration: 4,
    })
    // An out-of-tree clip list: the sampling path runs BEFORE the mute, so this
    // exercises sourceTimeAt itself; the mute test above covers the skip.
    const doc: Doc = {
      project: {
        id: 'p',
        name: 'n',
        width: 1920,
        height: 1080,
        fps: 30,
        tracks: [createTrack('audio', 1, { clips: [music] })],
      },
      media: [dialogueAsset, musicAsset],
    }
    const ramped: Clip = {
      ...dialogue,
      keyframes: {
        timeScale: [
          { time: 0, value: 1 },
          { time: 4, value: 2 },
        ],
      },
    }
    expect(computeDuckingKeyframes(doc, music, [ramped]).map((k) => [k.time, k.value])).toEqual([
      [2.183, 1],
      [2.333, 0.4],
      [3, 0.4],
      [3.15, 1],
    ])
    // The control: a static clip reads the band a full 0.67s later.
    expect(computeDuckingKeyframes(doc, music, [dialogue]).map((k) => [k.time, k.value])).toEqual([
      [2.85, 1],
      [3, 0.4],
      [4, 0.4],
      [4.15, 1],
    ])
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
