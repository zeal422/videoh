/**
 * Anti-regression tests for the command layer (commands.ts).
 * Every command is validated: happy path + rejection + immutability of the input doc.
 */
import { describe, expect, it } from 'vitest'
import { applyCommand, applyCommands, EditorCommandError } from '../commands'
import {
  createClip,
  createDoc,
  createMediaAsset,
  createTextClip,
  docDuration,
  sourceTimeAt,
} from '../factories'
import { decideTrimStart, trimRooms } from '../clip-gesture'
import { evaluateKeyframes, integrateKeyframes } from '../keyframes'
import { LUT_LIBRARY_MAX_CHARS, lutLibraryChars, parseCubeLut } from '../lut'
import type { Clip, Doc, Keyframe, MediaAsset, ProjectLut, Track } from '../types'
import { MIN_CLIP_DURATION } from '../constants'

/** A 2-cube in `.cube` row order (red fastest): enough to exercise the model. */
const CUBE_3D = [
  'LUT_3D_SIZE 2',
  '0 0 0',
  '1 0 0',
  '0 1 0',
  '1 1 0',
  '0 0 1',
  '1 0 1',
  '0 1 1',
  '1 1 1',
].join('\n')

/** Deterministic test doc: V1 (video track) + A1 (audio track), one video + one audio asset. */
function makeDoc(): {
  doc: Doc
  videoAsset: MediaAsset
  audioAsset: MediaAsset
} {
  const doc = createDoc()
  const videoAsset = createMediaAsset({
    kind: 'video',
    name: 'clipA.mp4',
    duration: 10,
    width: 640,
    height: 360,
    url: 'blob:video',
  })
  const audioAsset = createMediaAsset({
    kind: 'audio',
    name: 'song.mp3',
    duration: 30,
    url: 'blob:audio',
  })
  doc.media = [videoAsset, audioAsset]
  return { doc, videoAsset, audioAsset }
}

function videoTrack(doc: Doc): Track {
  return doc.project.tracks.filter((t) => t.kind === 'video')[0]
}
function audioTrack(doc: Doc): Track {
  return doc.project.tracks.filter((t) => t.kind === 'audio')[0]
}

describe('addMediaAsset / removeMediaAsset / relinkMedia', () => {
  it('adds an asset and rejects duplicates', () => {
    const { doc, videoAsset } = makeDoc()
    const fresh = {
      ...structuredClone(videoAsset),
      id: 'media_extra',
      name: 'extra.mp4',
    }
    const next = applyCommand(doc, { type: 'addMediaAsset', asset: fresh })
    expect(next.media).toHaveLength(3)
    expect(() => applyCommand(next, { type: 'addMediaAsset', asset: fresh })).toThrow(
      EditorCommandError,
    )
  })

  it('removes an asset; clips keep their dangling mediaId', () => {
    const { doc, videoAsset } = makeDoc()
    const withClip = applyCommand(doc, {
      type: 'addClip',
      trackId: videoTrack(doc).id,
      clip: createClip({ mediaId: videoAsset.id, duration: 5 }),
    })
    const next = applyCommand(withClip, {
      type: 'removeMediaAsset',
      mediaId: videoAsset.id,
    })
    expect(next.media).toHaveLength(1)
    expect(videoTrack(next).clips[0].mediaId).toBe(videoAsset.id)
  })

  it('relink restores url + clears missing flag', () => {
    const { doc, videoAsset } = makeDoc()
    const missingDoc: Doc = {
      ...doc,
      media: [{ ...structuredClone(videoAsset), url: '', missing: true }],
    }
    const next = applyCommand(missingDoc, {
      type: 'relinkMedia',
      mediaId: videoAsset.id,
      patch: { url: 'blob:new', duration: 12 },
    })
    expect(next.media[0].url).toBe('blob:new')
    expect(next.media[0].missing).toBe(false)
    expect(next.media[0].duration).toBe(12)
  })
})

describe('tracks', () => {
  it('adds tracks following the text→video→audio convention, newest on top', () => {
    const { doc } = makeDoc()
    let next = applyCommand(doc, { type: 'addTrack', kind: 'text' })
    next = applyCommand(next, { type: 'addTrack', kind: 'video' })
    next = applyCommand(next, { type: 'addTrack', kind: 'audio' })
    expect(next.project.tracks.map((t) => t.kind)).toEqual([
      'text',
      'video',
      'video',
      'audio',
      'audio',
    ])
    expect(next.project.tracks[0].name).toBe('T1')
    // Premiere/Photoshop layering semantics: the newest track of a kind stacks
    // ABOVE the older ones — V2 renders on top of V1, A2 above A1.
    expect(next.project.tracks[1].name).toBe('V2')
    expect(next.project.tracks[2].name).toBe('V1')
    expect(next.project.tracks[3].name).toBe('A2')
    expect(next.project.tracks[4].name).toBe('A1')
  })

  it('addTrack with atIndex inserts at an exact z-position (drop-between-tracks)', () => {
    const { doc } = makeDoc() // [V1, A1]
    const next = applyCommand(doc, { type: 'addTrack', kind: 'video', atIndex: 1 })
    expect(next.project.tracks.map((t) => t.name)).toEqual(['V1', 'V2', 'A1'])
  })

  it('addTrack atIndex 0 stacks the new track on top of everything', () => {
    const { doc } = makeDoc()
    const next = applyCommand(doc, { type: 'addTrack', kind: 'video', atIndex: 0 })
    expect(next.project.tracks.map((t) => t.name)).toEqual(['V2', 'V1', 'A1'])
  })

  it('addTrack atIndex skips the convention sort — explicit intent wins', () => {
    const { doc } = makeDoc()
    // an audio track BETWEEN V1 and A1 stays exactly there
    const next = applyCommand(doc, { type: 'addTrack', kind: 'audio', atIndex: 1 })
    expect(next.project.tracks.map((t) => t.kind)).toEqual(['video', 'audio', 'audio'])
  })

  it('addTrack clamps atIndex into [0, tracks.length]', () => {
    const { doc } = makeDoc()
    const low = applyCommand(doc, { type: 'addTrack', kind: 'video', atIndex: -5 })
    expect(low.project.tracks[0].kind).toBe('video')
    const high = applyCommand(doc, { type: 'addTrack', kind: 'video', atIndex: 99 })
    expect(high.project.tracks[high.project.tracks.length - 1].kind).toBe('video')
  })

  it('renames and mutes tracks; refuses to remove the last track', () => {
    const { doc } = makeDoc()
    const next = applyCommand(doc, {
      type: 'renameTrack',
      trackId: videoTrack(doc).id,
      name: '  Main  ',
    })
    expect(videoTrack(next).name).toBe('Main')
    const muted = applyCommand(next, {
      type: 'toggleTrackMute',
      trackId: videoTrack(next).id,
    })
    expect(videoTrack(muted).muted).toBe(true)

    const single: Doc = {
      ...doc,
      project: { ...doc.project, tracks: [videoTrack(doc)] },
    }
    expect(() =>
      applyCommand(single, {
        type: 'removeTrack',
        trackId: videoTrack(single).id,
      }),
    ).toThrow(EditorCommandError)
  })
})

describe('addClip', () => {
  it('adds a clip and clamps it to source duration', () => {
    const { doc, videoAsset } = makeDoc()
    const next = applyCommand(doc, {
      type: 'addClip',
      trackId: videoTrack(doc).id,
      clip: createClip({ mediaId: videoAsset.id, duration: 999, inPoint: 8 }),
    })
    expect(videoTrack(next).clips[0].duration).toBe(2) // 10 - 8
  })

  it('rejects material on incompatible tracks', () => {
    const { doc, audioAsset } = makeDoc()
    expect(() =>
      applyCommand(doc, {
        type: 'addClip',
        trackId: videoTrack(doc).id,
        clip: createClip({ mediaId: audioAsset.id, duration: 4 }),
      }),
    ).toThrow(EditorCommandError)
    expect(() =>
      applyCommand(doc, {
        type: 'addClip',
        trackId: audioTrack(doc).id,
        clip: createClip({ mediaId: audioAsset.id, duration: 4 }),
      }),
    ).not.toThrow()
  })

  it('rejects too-short clips and keeps input doc untouched', () => {
    const { doc, videoAsset } = makeDoc()
    const before = JSON.stringify(doc)
    expect(() =>
      applyCommand(doc, {
        type: 'addClip',
        trackId: videoTrack(doc).id,
        clip: createClip({ mediaId: videoAsset.id, duration: 0.01 }),
      }),
    ).toThrow(EditorCommandError)
    expect(JSON.stringify(doc)).toBe(before)
  })
})

describe('moveClip', () => {
  it('moves within a track and clamps start at 0', () => {
    const { doc, videoAsset } = makeDoc()
    const withClip = applyCommand(doc, {
      type: 'addClip',
      trackId: videoTrack(doc).id,
      clip: createClip({ mediaId: videoAsset.id, duration: 4 }),
    })
    const clipId = videoTrack(withClip).clips[0].id
    const next = applyCommand(withClip, {
      type: 'moveClip',
      clipId,
      trackId: videoTrack(withClip).id,
      start: -5,
    })
    expect(videoTrack(next).clips[0].start).toBe(0)
  })

  it('moves across compatible tracks', () => {
    const { doc, videoAsset } = makeDoc()
    const v1 = videoTrack(doc)
    v1.id = 'track_v1'
    const secondVideo = structuredClone(v1)
    secondVideo.id = 'track_v2'
    secondVideo.name = 'V2'
    secondVideo.clips = []
    doc.project.tracks = [secondVideo, v1]
    const withClip = applyCommand(doc, {
      type: 'addClip',
      trackId: 'track_v1',
      clip: createClip({ mediaId: videoAsset.id, duration: 4 }),
    })
    const clipId = withClip.project.tracks.find((t) => t.id === 'track_v1')!.clips[0].id
    const next = applyCommand(withClip, {
      type: 'moveClip',
      clipId,
      trackId: 'track_v2',
      start: 2,
    })
    expect(next.project.tracks.find((t) => t.id === 'track_v1')!.clips).toHaveLength(0)
    expect(next.project.tracks.find((t) => t.id === 'track_v2')!.clips[0].start).toBe(2)
  })

  it('rejects moving audio onto a video track', () => {
    const { doc, audioAsset } = makeDoc()
    const withClip = applyCommand(doc, {
      type: 'addClip',
      trackId: audioTrack(doc).id,
      clip: createClip({ mediaId: audioAsset.id, duration: 4 }),
    })
    const clipId = audioTrack(withClip).clips[0].id
    expect(() =>
      applyCommand(withClip, {
        type: 'moveClip',
        clipId,
        trackId: videoTrack(withClip).id,
        start: 0,
      }),
    ).toThrow(EditorCommandError)
  })
})

describe('trimClip', () => {
  function clipWithMedia(): {
    doc: Doc
    clipId: string
    videoAsset: MediaAsset
  } {
    const { doc, videoAsset } = makeDoc()
    const next = applyCommand(doc, {
      type: 'addClip',
      trackId: videoTrack(doc).id,
      clip: createClip({
        mediaId: videoAsset.id,
        start: 2,
        inPoint: 1,
        duration: 4,
      }),
    })
    return { doc: next, clipId: videoTrack(next).clips[0].id, videoAsset }
  }

  it('trims within source bounds', () => {
    const { doc, clipId } = clipWithMedia()
    const next = applyCommand(doc, {
      type: 'trimClip',
      clipId,
      start: 3,
      inPoint: 2,
      duration: 5,
      edge: 'head',
    })
    const clip = videoTrack(next).clips[0]
    expect(clip).toMatchObject({ start: 3, inPoint: 2, duration: 5 })
  })

  it('rejects negative inPoint and source overrun', () => {
    const { doc, clipId, videoAsset } = clipWithMedia()
    expect(() =>
      applyCommand(doc, {
        type: 'trimClip',
        clipId,
        start: 0,
        inPoint: -1,
        duration: 2,
        edge: 'head',
      }),
    ).toThrow(EditorCommandError)
    expect(() =>
      applyCommand(doc, {
        type: 'trimClip',
        clipId,
        start: 0,
        inPoint: 0,
        duration: videoAsset.duration + 1,
        edge: 'head',
      }),
    ).toThrow(EditorCommandError)
  })

  it('rejects too-short results and unknown clips', () => {
    const { doc, clipId } = clipWithMedia()
    expect(() =>
      applyCommand(doc, {
        type: 'trimClip',
        clipId,
        start: 0,
        inPoint: 0,
        duration: MIN_CLIP_DURATION / 2,
        edge: 'head',
      }),
    ).toThrow(EditorCommandError)
    expect(() =>
      applyCommand(doc, {
        type: 'trimClip',
        clipId: 'nope',
        start: 0,
        inPoint: 0,
        duration: 1,
        edge: 'head',
      }),
    ).toThrow(EditorCommandError)
  })

  it('image clips ignore inPoint (unbounded trim)', () => {
    const { doc } = makeDoc()
    const image = createMediaAsset({
      kind: 'image',
      name: 'img.png',
      width: 100,
      height: 100,
    })
    doc.media.push(image)
    const withClip = applyCommand(doc, {
      type: 'addClip',
      trackId: videoTrack(doc).id,
      clip: createClip({ mediaId: image.id, duration: 4 }),
    })
    const clipId = videoTrack(withClip).clips[0].id
    const next = applyCommand(withClip, {
      type: 'trimClip',
      clipId,
      start: 10,
      inPoint: 99,
      duration: 60,
      edge: 'head',
    })
    const clip = videoTrack(next).clips[0]
    expect(clip.duration).toBe(60)
    expect(clip.inPoint).toBe(0)
  })

  /** 2x clip reading source [4, 10] on the 10s fixture asset, start 5. */
  function speedClip(partial: Partial<Clip> = {}) {
    const { doc, videoAsset } = makeDoc()
    const next = applyCommand(doc, {
      type: 'addClip',
      trackId: videoTrack(doc).id,
      clip: createClip({
        mediaId: videoAsset.id,
        start: 5,
        inPoint: 4,
        duration: 3,
        speed: 2,
        ...partial,
      }),
    })
    return { doc: next, clipId: videoTrack(next).clips[0].id }
  }

  it('a constant-rate head trim carries the anchor at the clip rate', () => {
    // A timeline second of head move consumes two source seconds at 2x, so a 1s
    // head trim advances inPoint by 2; using the caller's raw timeline delta
    // re-cut the kept span by the difference.
    const { doc, clipId } = speedClip()
    const before = videoTrack(doc).clips[0]
    const shrunk = applyCommand(doc, {
      type: 'trimClip',
      clipId,
      start: 6,
      inPoint: 5,
      duration: 2,
      edge: 'head',
    })
    const clip = videoTrack(shrunk).clips[0]
    expect(clip.inPoint).toBe(6)
    for (const local of [0, 0.5, 1, 1.5, 2]) {
      expect(sourceTimeAt(clip, local)).toBeCloseTo(sourceTimeAt(before, 1 + local), 6)
    }
    // An extension gives the source back at the same rate, and the revealed
    // head reads the frames just before the old head.
    const extended = applyCommand(doc, {
      type: 'trimClip',
      clipId,
      start: 4,
      inPoint: 3,
      duration: 4,
      edge: 'head',
    })
    const wide = videoTrack(extended).clips[0]
    expect(wide.inPoint).toBe(2)
    expect(sourceTimeAt(wide, 0)).toBeCloseTo(2, 6)
    for (const local of [0, 0.5, 1, 1.5, 2]) {
      expect(sourceTimeAt(wide, 1 + local)).toBeCloseTo(sourceTimeAt(before, local), 6)
    }
    // A 3s reveal from inPoint 4 would need 6 source seconds and only 4 exist.
    expect(() =>
      applyCommand(doc, {
        type: 'trimClip',
        clipId,
        start: 2,
        inPoint: 1,
        duration: 6,
        edge: 'head',
      }),
    ).toThrow('Trim exceeds the start of the source')
  })

  it('a constant-rate tail trim keeps the anchor and reads to the asset end', () => {
    // The forward window ends at inPoint + duration * speed, so the tail gives
    // up or reveals source without moving the anchor: duration 4 at 2x from
    // inPoint 2 reads exactly the 10s asset's last frame, and nothing past it.
    const { doc, clipId } = speedClip({ inPoint: 2 })
    const before = videoTrack(doc).clips[0]
    const shrunk = applyCommand(doc, {
      type: 'trimClip',
      clipId,
      start: 5,
      inPoint: 2,
      duration: 2,
      edge: 'tail',
    })
    const clip = videoTrack(shrunk).clips[0]
    expect(clip.inPoint).toBe(2)
    for (const local of [0, 1, 2]) {
      expect(sourceTimeAt(clip, local)).toBeCloseTo(sourceTimeAt(before, local), 6)
    }
    const extended = applyCommand(doc, {
      type: 'trimClip',
      clipId,
      start: 5,
      inPoint: 2,
      duration: 4,
      edge: 'tail',
    })
    const wide = videoTrack(extended).clips[0]
    expect(wide.inPoint).toBe(2)
    expect(sourceTimeAt(wide, wide.duration)).toBeCloseTo(10, 6)
    expect(() =>
      applyCommand(doc, {
        type: 'trimClip',
        clipId,
        start: 5,
        inPoint: 2,
        duration: 4.5,
        edge: 'tail',
      }),
    ).toThrow('Trim exceeds the end of the source')
  })
})

describe('setClipColorParams (temperature/tint grade)', () => {
  function clipInDoc() {
    const { doc, videoAsset } = makeDoc()
    const withClip = applyCommand(doc, {
      type: 'addClip',
      trackId: videoTrack(doc).id,
      clip: createClip({ mediaId: videoAsset.id, start: 0, duration: 4 }),
    })
    return { doc: withClip, clipId: videoTrack(withClip).clips[0].id }
  }

  it('clamps the grade into -100..100 and collapses neutral to absent', () => {
    const { doc, clipId } = clipInDoc()
    const warm = applyCommand(doc, {
      type: 'setClipColorParams',
      clipId,
      temperature: 500,
      tint: -30,
    })
    const clip = videoTrack(warm).clips[0]
    expect(clip.temperature).toBe(100)
    expect(clip.tint).toBe(-30)

    const reset = applyCommand(warm, {
      type: 'setClipColorParams',
      clipId,
      temperature: 0,
      tint: 0,
    })
    const cleared = videoTrack(reset).clips[0]
    expect(cleared.temperature).toBeUndefined()
    expect(cleared.tint).toBeUndefined()
    expect('temperature' in cleared).toBe(true) // cleared, not deleted
  })

  it('toggles noise reduction through setClipDenoise', () => {
    const { doc, clipId } = clipInDoc()
    const on = applyCommand(doc, { type: 'setClipDenoise', clipId, enabled: true })
    expect(videoTrack(on).clips[0].denoise).toBe(true)

    const off = applyCommand(on, { type: 'setClipDenoise', clipId, enabled: false })
    expect(videoTrack(off).clips[0].denoise).toBe(false)

    expect(() =>
      applyCommand(doc, { type: 'setClipDenoise', clipId: 'nope', enabled: true }),
    ).toThrow(EditorCommandError)
  })

  it('rejects an unknown clip', () => {
    const { doc } = clipInDoc()
    expect(() =>
      applyCommand(doc, {
        type: 'setClipColorParams',
        clipId: 'nope',
        temperature: 10,
        tint: 0,
      }),
    ).toThrow(EditorCommandError)
  })
})

describe('LUT library commands', () => {
  function clipInDoc() {
    const { doc, videoAsset } = makeDoc()
    const withClip = applyCommand(doc, {
      type: 'addClip',
      trackId: videoTrack(doc).id,
      clip: createClip({ mediaId: videoAsset.id, start: 0, duration: 4 }),
    })
    return { doc: withClip, clipId: videoTrack(withClip).clips[0].id }
  }

  it('imports a LUT into the project library and references it from a clip', () => {
    const { doc, clipId } = clipInDoc()
    const lut = parseCubeLut(CUBE_3D, { id: 'lut_warm', name: 'warm' })
    const withLut = applyCommand(doc, { type: 'importProjectLut', lut })
    expect(withLut.project.luts).toEqual([lut])
    // The input doc is never mutated.
    expect(doc.project.luts).toBeUndefined()

    const assigned = applyCommand(withLut, { type: 'setClipLut', clipId, lutId: 'lut_warm' })
    expect(videoTrack(assigned).clips[0].lutId).toBe('lut_warm')

    const cleared = applyCommand(assigned, { type: 'setClipLut', clipId, lutId: null })
    expect(videoTrack(cleared).clips[0].lutId).toBeUndefined()
  })

  it('rejects a duplicate LUT id and a clip reference to no entry', () => {
    const { doc, clipId } = clipInDoc()
    const lut = parseCubeLut(CUBE_3D, { id: 'lut_warm', name: 'warm' })
    const withLut = applyCommand(doc, { type: 'importProjectLut', lut })
    expect(() => applyCommand(withLut, { type: 'importProjectLut', lut })).toThrow(
      EditorCommandError,
    )
    expect(() =>
      applyCommand(withLut, { type: 'setClipLut', clipId, lutId: 'lut_missing' }),
    ).toThrow(EditorCommandError)
    expect(() =>
      applyCommand(withLut, { type: 'setClipLut', clipId: 'nope', lutId: 'lut_warm' }),
    ).toThrow(EditorCommandError)
  })

  it('refuses an import that would cross the library budget, naming both sizes', () => {
    const { doc } = clipInDoc()
    // A payload that fits on its own, then a library pushed to the edge.
    const big = parseCubeLut(CUBE_3D, { id: 'lut_big', name: 'big' })
    const filler: ProjectLut = {
      id: 'lut_filler',
      name: 'filler',
      kind: '1d',
      size: 2,
      data: 'A'.repeat(LUT_LIBRARY_MAX_CHARS - big.data.length),
    }
    const loaded = applyCommand(doc, { type: 'importProjectLut', lut: big })
    const full = applyCommand(loaded, { type: 'importProjectLut', lut: filler })
    expect(lutLibraryChars(full.project.luts!)).toBe(LUT_LIBRARY_MAX_CHARS)

    let message = ''
    try {
      applyCommand(full, { type: 'importProjectLut', lut: { ...big, id: 'lut_again' } })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toMatch(/LUT library is full/)
    expect(message).toMatch(/3,000,000/)
  })
})

describe('timeScale ramps', () => {
  /** Linear 1x → 2x over 4 s: rate(t) = 1 + t/4, so I(x) = x + x²/8. */
  const ramp: Keyframe[] = [
    { time: 0, value: 1 },
    { time: 4, value: 2 },
  ]

  function rampedClip(partial: Partial<Clip> = {}) {
    const { doc, videoAsset } = makeDoc()
    videoAsset.duration = 30
    const withClip = applyCommand(doc, {
      type: 'addClip',
      trackId: videoTrack(doc).id,
      clip: createClip({ mediaId: videoAsset.id, start: 0, inPoint: 0, duration: 4, ...partial }),
    })
    const clipId = videoTrack(withClip).clips[0].id
    const ramped = applyCommand(withClip, {
      type: 'setClipKeyframes',
      clipId,
      property: 'timeScale',
      keyframes: ramp,
    })
    return { doc: ramped, clipId, videoAsset }
  }

  /** Same fixture with a different OUTGOING interpolation on the first keyframe. */
  function rampedClipWith(interpolation: Keyframe['interpolation'], partial: Partial<Clip> = {}) {
    const { doc, videoAsset } = makeDoc()
    videoAsset.duration = 30
    const withClip = applyCommand(doc, {
      type: 'addClip',
      trackId: videoTrack(doc).id,
      clip: createClip({ mediaId: videoAsset.id, start: 0, inPoint: 0, duration: 4, ...partial }),
    })
    const clipId = videoTrack(withClip).clips[0].id
    const ramped = applyCommand(withClip, {
      type: 'setClipKeyframes',
      clipId,
      property: 'timeScale',
      keyframes: [
        { time: 0, value: 1, interpolation },
        { time: 4, value: 2 },
      ],
    })
    return { doc: ramped, clipId }
  }

  it('consumes the curve integral instead of local * speed', () => {
    const { doc } = rampedClip()
    const clip = videoTrack(doc).clips[0]
    expect(sourceTimeAt(clip, 0)).toBe(0)
    // Integral of 1 + t/4 over 0..2 is 2.5, over the whole 4 s span it is 6:
    // 1.5x the timeline span, with the clip's own duration unchanged.
    expect(sourceTimeAt(clip, 2)).toBeCloseTo(2.5, 6)
    expect(sourceTimeAt(clip, 4)).toBeCloseTo(6, 6)
    expect(docDuration(doc)).toBe(4)
  })

  it('a flat curve reproduces the constant-rate formula exactly', () => {
    const plain = createClip({ inPoint: 1.5, duration: 4, speed: 2 })
    const flat = createClip({
      inPoint: 1.5,
      duration: 4,
      speed: 1,
      keyframes: { timeScale: [{ time: 0, value: 2 }] },
    })
    for (const local of [0, 1, 3, 4]) {
      expect(sourceTimeAt(flat, local)).toBeCloseTo(sourceTimeAt(plain, local), 10)
    }
  })

  it('integrates an eased ramp through the bezier solver', () => {
    const eased = createClip({
      duration: 1,
      speed: 1,
      keyframes: {
        timeScale: [
          { time: 0, value: 0, interpolation: 'easeIn' },
          { time: 1, value: 1 },
        ],
      },
    })
    // The integral across the whole segment is the curve's MEAN: easeIn
    // averages 0.374 over its domain (computed independently).
    expect(sourceTimeAt(eased, 1)).toBeCloseTo(0.374, 6)
  })

  it('constant-extends a ramp outside its keyframes', () => {
    const clip = createClip({
      duration: 6,
      speed: 1,
      keyframes: { timeScale: [{ time: 2, value: 3 }] },
    })
    expect(sourceTimeAt(clip, 2)).toBeCloseTo(6, 6) // 2 s at 3x
    expect(sourceTimeAt(clip, 6)).toBeCloseTo(18, 6) // then 4 s more at 3x
  })

  it('mirrors the ramp for a reversed clip', () => {
    const { doc } = rampedClip({ reverse: true })
    const clip = videoTrack(doc).clips[0]
    // Reverse reads the mirrored offset, so local 0 is the span's far end.
    expect(sourceTimeAt(clip, 0)).toBeCloseTo(6, 6)
    expect(sourceTimeAt(clip, 2)).toBeCloseTo(2.5, 6)
    expect(sourceTimeAt(clip, 4)).toBe(0)
  })

  it('clamps ramp values into the speed bounds', () => {
    const { doc, clipId } = rampedClip()
    const next = applyCommand(doc, {
      type: 'setClipKeyframes',
      clipId,
      property: 'timeScale',
      keyframes: [{ time: 0, value: 99 }],
    })
    expect(videoTrack(next).clips[0].keyframes?.timeScale?.[0].value).toBe(4)
  })

  it('accepts an over-consuming ramp (render clamps, the command does not)', () => {
    const { doc } = rampedClip()
    const clip = videoTrack(doc).clips[0]
    // 16 s of source from a 30 s asset: legal, and evaluated as written.
    const flatOut = createClip({
      ...clip,
      speed: 1,
      keyframes: { timeScale: [{ time: 0, value: 4 }] },
    })
    expect(sourceTimeAt(flatOut, 4)).toBeCloseTo(16, 6)
    expect(flatOut.keyframes?.timeScale).toHaveLength(1)
  })

  it('trim validates a fitting kept span through the ramp integral', () => {
    const { doc, clipId } = rampedClip()
    // The 4 s span consumes 6 s, so it fits the 10 s asset...
    expect(() =>
      applyCommand(doc, {
        type: 'trimClip',
        clipId,
        start: 0,
        inPoint: 0,
        duration: 4,
        edge: 'tail',
      }),
    ).not.toThrow()
  })

  it('a clip whose CURRENT span over-consumes is clamped, not rejected', () => {
    // An over-consuming ramp is a legal saved state (the render freezes on the
    // last readable frame), and the trim used to throw on it, making the clip
    // untrimmable in the whole 0.1..asset/rate range. The command now clamps
    // the requested duration to the source-reachable length instead.
    const { doc, clipId } = rampedClip()
    const tight = structuredClone(doc)
    tight.media[0].duration = 5
    const next = applyCommand(tight, {
      type: 'trimClip',
      clipId,
      start: 0,
      inPoint: 0,
      duration: 4,
      edge: 'tail',
    })
    const clip = videoTrack(next).clips[0]
    expect(clip.duration).toBeLessThan(4)
    // The clamped span fits the asset exactly through the integral.
    expect(clip.inPoint + sourceTimeAt(clip, clip.duration) - clip.inPoint).toBeLessThanOrEqual(
      5 + 1e-6,
    )
    // A request BELOW the reachable length passes through untouched.
    const short = applyCommand(tight, {
      type: 'trimClip',
      clipId,
      start: 0,
      inPoint: 0,
      duration: 1,
      edge: 'tail',
    })
    expect(videoTrack(short).clips[0].duration).toBe(1)
  })

  it('a fitting trim that would OVERSHOOT the asset still throws', () => {
    // The clamp above is for a clip that ALREADY over-consumes. A healthy clip
    // whose requested span would newly exceed the asset is still rejected.
    const { doc, clipId } = rampedClip()
    // A 3s span consumes 4.125s (rate 1..2 linear). Give the asset 4.5s: the
    // current state fits. Requesting the full 4s span (6s of source) must throw.
    const medium = structuredClone(doc)
    medium.media[0].duration = 4.5
    const healthy = applyCommand(medium, {
      type: 'trimClip',
      clipId,
      start: 0,
      inPoint: 0,
      duration: 3,
      edge: 'tail',
    })
    expect(() =>
      applyCommand(healthy, {
        type: 'trimClip',
        clipId,
        start: 0,
        inPoint: 0,
        duration: 4,
        edge: 'tail',
      }),
    ).toThrow('Trim exceeds the end of the source')
  })

  it('an over-consuming ramp even MIN_CLIP_DURATION cannot fit is rejected', () => {
    // Extending the clamp: when even the minimum length still over-consumes,
    // no trim can make the state valid, so the command throws instead of
    // clamping to a frozen 0.1s stub that still over-consumes.
    let doc = createDoc()
    doc.media = [createMediaAsset({ id: 'm1', kind: 'video', duration: 3.2, url: 'blob:v' })]
    doc = applyCommand(doc, {
      type: 'addClip',
      trackId: videoTrack(doc).id,
      clip: createClip({
        id: 'c_ovr',
        mediaId: 'm1',
        duration: 3.2,
        inPoint: 3,
        keyframes: { timeScale: [{ time: 0, value: 4 }] },
      }),
    })
    // Minimum trim consumes 3 + 4 * 0.1 = 3.4 > 3.2: nothing fits.
    expect(() =>
      applyCommand(doc, {
        type: 'trimClip',
        clipId: 'c_ovr',
        start: 0,
        inPoint: 3,
        duration: 1,
        edge: 'tail',
      }),
    ).toThrow('Trim exceeds the end of the source')
  })

  it('clamping a head trim keeps the right edge anchored', () => {
    // A trim-start drag whose duration gets clamped must not detach the clip's
    // right edge from where the drag anchored it: start slides so
    // start + duration lands where the command put it.
    let doc = createDoc()
    doc.media = [createMediaAsset({ id: 'm1', kind: 'video', duration: 5, url: 'blob:v' })]
    doc = applyCommand(doc, {
      type: 'addClip',
      trackId: videoTrack(doc).id,
      clip: createClip({
        id: 'c_edge',
        mediaId: 'm1',
        start: 0,
        duration: 5,
        inPoint: 3,
        keyframes: { timeScale: [{ time: 0, value: 4 }] },
      }),
    })
    // The drag wants start 2, duration 1.2 (right edge 3.2); the clamp shortens
    // the duration to the reachable 0.5s, so start moves to 3.2 - 0.5 = 2.7.
    // `edge: 'tail'` because the caller passes the clip's own inPoint (only the
    // start moved): this exercises the clamp's right-edge rebase, not the ramp
    // REBASE a head trim runs, which assumes the caller's inPoint tracks the head.
    const next = applyCommand(doc, {
      type: 'trimClip',
      clipId: 'c_edge',
      start: 2,
      inPoint: 3,
      duration: 1.2,
      edge: 'tail',
    })
    const clip = videoTrack(next).clips[0]
    expect(clip.start + clip.duration).toBeCloseTo(3.2, 6)
    // The clamped span fits the asset through the integral.
    expect(
      clip.inPoint + integrateKeyframes(clip.keyframes!.timeScale!, clip.duration, clip.speed ?? 1),
    ).toBeLessThanOrEqual(5 + 1e-6)
  })

  it('splits inside a forward ramp; both halves read the unsplit frames', () => {
    const { doc, clipId } = rampedClip()
    const original = videoTrack(doc).clips[0]
    const next = applyCommand(doc, { type: 'splitClip', clipId, atTime: 2 })
    const [left, right] = videoTrack(next).clips
    expect(left).toMatchObject({ duration: 2, inPoint: 0 })
    expect(right).toMatchObject({ duration: 2, inPoint: 2.5 }) // I(2)
    for (const local of [0, 0.5, 1, 1.5, 2]) {
      expect(sourceTimeAt(left, local)).toBeCloseTo(sourceTimeAt(original, local), 6)
      expect(sourceTimeAt(right, local)).toBeCloseTo(sourceTimeAt(original, 2 + local), 6)
    }
  })

  it('splits inside a reversed ramp; the halves mirror the same source span', () => {
    const { doc, clipId } = rampedClip({ inPoint: 2, reverse: true })
    const original = videoTrack(doc).clips[0]
    const next = applyCommand(doc, { type: 'splitClip', clipId, atTime: 2 })
    const [left, right] = videoTrack(next).clips
    // Read backwards, the LEFT half owns the source span's tail: it moves up by
    // the right half's consumption. The right half keeps the original inPoint.
    expect(right).toMatchObject({ duration: 2, inPoint: 2 })
    expect(left).toMatchObject({ duration: 2, inPoint: 4.5 }) // 2 + I(2)
    for (const local of [0.25, 0.5, 1, 1.5, 2]) {
      expect(sourceTimeAt(left, local)).toBeCloseTo(sourceTimeAt(original, local), 6)
      expect(sourceTimeAt(right, local)).toBeCloseTo(sourceTimeAt(original, 2 + local), 6)
    }
  })

  it('an eased ramp splits EXACTLY: the segments subdivide at the cut', () => {
    // The eased shape is DATA (an `easeOut` bezier quad on the segment's
    // starting keyframe), so a cut SUBDIVIDES the curve with de Casteljau and
    // both halves re-time the original exactly, instead of re-applying the
    // preset name over the shortened span (which re-timed the interior by up
    // to ~0.4s of source on this fixture).
    for (const interpolation of ['easeIn', 'easeOut', 'easeInOut'] as const) {
      const { doc, clipId } = rampedClipWith(interpolation)
      const original = videoTrack(doc).clips[0]
      const next = applyCommand(doc, { type: 'splitClip', clipId, atTime: 2 })
      const [left, right] = videoTrack(next).clips
      let worst = 0
      for (const local of [0.25, 0.5, 1, 1.5, 1.75]) {
        worst = Math.max(worst, Math.abs(sourceTimeAt(left, local) - sourceTimeAt(original, local)))
        worst = Math.max(
          worst,
          Math.abs(sourceTimeAt(right, local) - sourceTimeAt(original, 2 + local)),
        )
      }
      expect(worst).toBeLessThan(1e-6)
    }
  })

  it('a forward head trim rebases the ramp so the kept span reads the same frames', () => {
    const { doc, clipId } = rampedClip()
    const original = videoTrack(doc).clips[0]
    const next = applyCommand(doc, {
      type: 'trimClip',
      clipId,
      start: 1,
      inPoint: 1,
      duration: 3,
      edge: 'head',
    })
    const clip = videoTrack(next).clips[0]
    // Old local 1..3 must equal new local 0..2 (same source frames).
    for (const local of [0, 0.5, 1, 1.5, 2, 3]) {
      expect(sourceTimeAt(clip, local)).toBeCloseTo(sourceTimeAt(original, 1 + local), 6)
    }
    // The boundary rate is pinned at local 0; the tail keyframe keeps its value.
    expect(clip.keyframes?.timeScale).toMatchObject([
      { time: 0, value: 1.25 }, // the rate at the cut (evaluate at local 1)
      { time: 3, value: 2 },
    ])
  })

  it('an EASED head trim is exact too: the boundary carries the subdivided shape', () => {
    // Same cut on an eased ramp: the boundary keyframe stamps the crossing
    // segment's de Casteljau right piece, so the rebased span re-times the
    // original exactly instead of re-applying the preset name (which used to
    // drift the interior).
    for (const interpolation of ['easeIn', 'easeOut', 'easeInOut'] as const) {
      const { doc, clipId } = rampedClipWith(interpolation)
      const original = videoTrack(doc).clips[0]
      const next = applyCommand(doc, {
        type: 'trimClip',
        clipId,
        start: 1,
        inPoint: 1,
        duration: 3,
        edge: 'head',
      })
      const clip = videoTrack(next).clips[0]
      let worst = 0
      for (const local of [0.25, 0.5, 1, 1.5, 2, 2.75]) {
        worst = Math.max(
          worst,
          Math.abs(sourceTimeAt(clip, local) - sourceTimeAt(original, 1 + local)),
        )
      }
      expect(worst).toBeLessThan(1e-5)
      // The shape data rode along.
      expect(clip.keyframes!.timeScale![0].easeOut).toBeDefined()
    }
  })

  it('a forward head trim pins the boundary when the cut lands exactly halfway', () => {
    // The rebase's boundary test used to inspect the END of `kept`, but the
    // forward branch appends its boundary at the START (local 0): a survivor at
    // exactly 2 * cut shifted onto `cut`, the guard read that as "boundary
    // present", and the kept span lost its rate pin (flat 2x here, up to
    // 0.75 s of wrong source by the tail). The cut at 2 is the collision
    // (the fixture's last keyframe sits at 4); the cut at 1 above is not.
    const { doc, clipId } = rampedClip()
    const original = videoTrack(doc).clips[0]
    const next = applyCommand(doc, {
      type: 'trimClip',
      clipId,
      start: 2,
      inPoint: 2,
      duration: 2,
      edge: 'head',
    })
    const clip = videoTrack(next).clips[0]
    // Old local 2..4 must equal new local 0..2 (same source frames).
    for (const local of [0, 0.5, 1, 1.5, 2]) {
      expect(sourceTimeAt(clip, local)).toBeCloseTo(sourceTimeAt(original, 2 + local), 6)
    }
    // The boundary rate (1.5x) is pinned at local 0.
    expect(clip.keyframes?.timeScale).toMatchObject([
      { time: 0, value: 1.5 },
      { time: 2, value: 2 },
    ])
  })

  it('a multi-frame head shrink with a frozen gesture origin lands on the one-shot anchor', () => {
    // ClipView freezes `orig` at pointerdown and derives every pointermove's
    // inPoint from that snapshot, so after the first frame the caller's inPoint
    // is no longer inPointBefore + spanDelta. Anchoring the rebase off the
    // caller's value re-added each prior frame's delta on top of an already
    // rebased anchor: the kept span read the previous frame's
    // (integral - spanDelta) of wrong source, so the same gesture differed
    // between 30 and 120 Hz (measured ~1.5 frames of source here, ~19 on a
    // 0.25x..2x ramp). The anchor now advances by the consumed integral, and
    // the increments compose back to the one-shot result.
    const { doc, clipId } = rampedClip({ start: 0, inPoint: 2 })
    const orig = videoTrack(doc).clips[0]
    const single = applyCommand(doc, {
      type: 'trimClip',
      clipId,
      start: 1,
      inPoint: 3,
      duration: 3,
      edge: 'head',
    })
    let stepped = doc
    for (let i = 1; i <= 120; i++) {
      const inc = i / 120
      const d = decideTrimStart({
        orig,
        isUnbounded: false,
        headRoom: trimRooms({
          bounded: true,
          reverse: false,
          inPoint: orig.inPoint,
          duration: orig.duration,
          speed: orig.speed ?? 1,
          assetDuration: 10,
        }).head,
        clientX: inc,
        startX: 0,
        scale: 1,
        snapping: false,
        snapPoints: [],
      })
      stepped = applyCommand(stepped, {
        type: 'trimClip',
        clipId,
        start: d.start,
        inPoint: d.inPoint,
        duration: d.duration,
        edge: 'head',
      })
    }
    const one = videoTrack(single).clips[0]
    const many = videoTrack(stepped).clips[0]
    // One frame is already exact, so the assertion needs the stepped drag.
    expect(many.inPoint).toBeCloseTo(one.inPoint, 9)
    expect(many.keyframes!.timeScale!.length).toBe(one.keyframes!.timeScale!.length)
    for (const local of [0, 0.5, 1, 2, 2.9]) {
      expect(sourceTimeAt(many, local)).toBeCloseTo(sourceTimeAt(one, local), 6)
      expect(sourceTimeAt(many, local)).toBeCloseTo(sourceTimeAt(orig, 1 + local), 6)
    }
  })

  it('a head trim of an over-consuming ramp recovers a fitting window', () => {
    // An over-consuming ramp is a legal saved state (a relink leaves windows
    // untouched), but the rebase pins the kept span's read END to what the
    // untrimmed clip read, so a head trim alone cannot heal the over-run: the
    // clamp and the rebase used to compose into a third window that neither
    // fit (read end 5.657 on the 5s asset here) nor stayed continuous. The
    // recovered window slides onto the asset's readable tail; the kept span's
    // curve shape and its right edge survive.
    const { doc, clipId } = rampedClip({ inPoint: 1 })
    const tight = structuredClone(doc)
    tight.media[0].duration = 5 // the span reads [1, 7]: over by 2
    const next = applyCommand(tight, {
      type: 'trimClip',
      clipId,
      start: 1,
      inPoint: 2,
      duration: 3,
      edge: 'head',
    })
    const clip = videoTrack(next).clips[0]
    // The result fits through the integral, and lands exactly on the tail.
    const readEnd =
      clip.inPoint + integrateKeyframes(clip.keyframes!.timeScale!, clip.duration, clip.speed ?? 1)
    expect(readEnd).toBeLessThanOrEqual(5 + 1e-6)
    expect(readEnd).toBeCloseTo(5, 6)
    expect(clip.inPoint).toBeGreaterThanOrEqual(0)
    // The clamp kept the right edge where the drag anchored it.
    expect(clip.start + clip.duration).toBeCloseTo(4, 6)
    // The rebased curve shape survives the slide: the boundary rate the cut
    // landed on (1 + cut/4) stays pinned at local 0 and the tail keeps 2x.
    expect(clip.keyframes!.timeScale![0].time).toBeCloseTo(0, 6)
    expect(clip.keyframes!.timeScale![0].value).toBeCloseTo(1.4189, 3)
    expect(clip.keyframes!.timeScale![clip.keyframes!.timeScale!.length - 1].value).toBeCloseTo(
      2,
      6,
    )
  })

  it('a clamped head trim at start 0 still recovers the window onto the readable tail', () => {
    // Same recovery when the trim cannot slide the start (start == clip.start
    // keeps it): the clamp shortens the span, the rebase rebases it, and the
    // slide alone must still land the read end on the asset's last frame.
    const { doc, clipId } = rampedClip({ inPoint: 1 })
    const tight = structuredClone(doc)
    tight.media[0].duration = 5
    const next = applyCommand(tight, {
      type: 'trimClip',
      clipId,
      start: 0,
      inPoint: 1,
      duration: 4,
      edge: 'head',
    })
    const clip = videoTrack(next).clips[0]
    const readEnd =
      clip.inPoint + integrateKeyframes(clip.keyframes!.timeScale!, clip.duration, clip.speed ?? 1)
    expect(readEnd).toBeCloseTo(5, 6)
    expect(clip.start).toBe(0)
    expect(clip.duration).toBeGreaterThan(MIN_CLIP_DURATION)
  })

  it('an over-consuming head trim that does not move the head never drives inPoint negative', () => {
    // The over-consume clamp shortens a window that already read past the
    // asset, and `spanDelta` picks that clamp up. The head rebase used to read
    // it as a head shrink and move the anchor; on a curve slower than 1x,
    // `integral - span` is negative, so the clip ended up reading source from
    // before 0 (measured -0.2667 here). The head never moved, so the anchor
    // must stay put and the shortened span alone is what fits the asset.
    const { doc, clipId } = rampedClip({ inPoint: 0 })
    const slow = applyCommand(doc, {
      type: 'setClipKeyframes',
      clipId,
      property: 'timeScale',
      keyframes: [
        { time: 0, value: 0.6 },
        { time: 4, value: 0.6 },
      ],
    })
    const tight = structuredClone(slow)
    tight.media[0].duration = 2 // the 4s span reads [0, 2.4]: over by 0.4
    const next = applyCommand(tight, {
      type: 'trimClip',
      clipId,
      start: 0,
      inPoint: 0,
      duration: 4,
      edge: 'head',
    })
    const clip = videoTrack(next).clips[0]
    expect(clip.inPoint).toBe(0)
    // The window shrank to what the asset holds: 0.6x of 3.3333s is 2s.
    expect(clip.duration).toBeCloseTo(10 / 3, 6)
    expect(
      clip.inPoint + integrateKeyframes(clip.keyframes!.timeScale!, clip.duration, clip.speed ?? 1),
    ).toBeLessThanOrEqual(2 + 1e-6)
  })

  it('a reversed tail trim of an over-consuming ramp recovers the high anchor', () => {
    // The mirror: a reversed tail move re-derives the LOW anchor upward after
    // the guard ran, which can push the high anchor past the end the guard
    // validated. The recovered window slides down onto the readable tail.
    const { doc, clipId } = rampedClip({ reverse: true, inPoint: 1 })
    const tight = structuredClone(doc)
    tight.media[0].duration = 5
    const next = applyCommand(tight, {
      type: 'trimClip',
      clipId,
      start: 0,
      inPoint: 1,
      duration: 3,
      edge: 'tail',
    })
    const clip = videoTrack(next).clips[0]
    const readEnd =
      clip.inPoint + integrateKeyframes(clip.keyframes!.timeScale!, clip.duration, clip.speed ?? 1)
    expect(readEnd).toBeCloseTo(5, 6)
    // A reversed clip reads its low anchor at the tail end.
    expect(sourceTimeAt(clip, clip.duration)).toBeCloseTo(clip.inPoint, 6)
    expect(clip.inPoint).toBeGreaterThanOrEqual(0)
  })

  it('a reversed tail extension can keep a high end that sits on the asset end', () => {
    // A reversed tail move pins the HIGH end and re-derives the low anchor, so
    // the window to validate is the pinned end. The guard used to check the
    // caller's inPoint at the NEW duration ([4, 12] here), rejecting a legal
    // reveal below the low anchor even though the pinned end sits at 10.
    const { doc, clipId } = rampedClip({ reverse: true, inPoint: 4 })
    const tight = structuredClone(doc)
    tight.media[0].duration = 10 // the clip reads [4, 10]: exactly the asset
    const before = videoTrack(tight).clips[0]
    const next = applyCommand(tight, {
      type: 'trimClip',
      clipId,
      start: 0,
      inPoint: 4,
      duration: 5,
      edge: 'tail',
    })
    const clip = videoTrack(next).clips[0]
    expect(clip.duration).toBe(5)
    // 1s revealed at the curve's origin rate (1x): the low anchor moves to 3.
    expect(clip.inPoint).toBeCloseTo(3, 6)
    // The kept head still reads the asset's last instant, and every kept local
    // reads the frame it showed before.
    expect(sourceTimeAt(clip, 0)).toBeCloseTo(10, 6)
    for (const local of [0, 0.5, 1, 2, 3, 4]) {
      expect(sourceTimeAt(clip, local)).toBeCloseTo(sourceTimeAt(before, local), 6)
    }
    expect(sourceTimeAt(clip, clip.duration)).toBeCloseTo(3, 6)
  })

  it('a forward head extension rebases the ramp so the kept span reads the same frames', () => {
    // The rebase used to fire only on a SHRINK, so extending a ramped head
    // applied the caller's raw inPoint (timeline delta, not the source the
    // reveal consumes) and the picture re-cut: measured on a 1x..4x ramp at
    // inPoint 10, a 1s extension read [9, 23] where the kept span holds
    // [10, 20]. Mirror of the head-trim tests above: the curve shifts right
    // by the revealed head, the old head rate is pinned at local 0 (its
    // constant extension plays the reveal), and the anchor keeps the old
    // head's frame minus the reveal consumed at that rate. Exact for any
    // easing: a shift asks nothing of the curve's shape.
    const { doc, clipId } = rampedClip({ start: 10, inPoint: 10 })
    const original = videoTrack(doc).clips[0]
    const next = applyCommand(doc, {
      type: 'trimClip',
      clipId,
      start: 9,
      inPoint: 9,
      duration: 5,
      edge: 'head',
    })
    const clip = videoTrack(next).clips[0]
    // Old local 0..4 must equal new local 1..5 (same source frames).
    for (const local of [0, 0.5, 1, 2, 3, 4]) {
      expect(sourceTimeAt(clip, 1 + local)).toBeCloseTo(sourceTimeAt(original, local), 6)
    }
    // The revealed head second reads the source just before the old head.
    expect(sourceTimeAt(clip, 0)).toBeCloseTo(9, 6)
    // The curve is the two original keyframes, shifted right by the revealed
    // second. No pin is stored at 0: the old head rate (1x) is what the curve
    // constant-extends across the reveal, so an extra point there would change
    // no rendered value and only grow the array on every drag frame.
    expect(clip.keyframes!.timeScale).toMatchObject([
      { time: 1, value: 1 },
      { time: 5, value: 2 },
    ])
  })

  it('a head extension is idempotent: N steps match one step and do not grow the curve', () => {
    // A drag dispatches one trimClip per pointermove, and each frame rebased the
    // curve on top of the previous one while unshifting a redundant pin: a 1s
    // drag in 60 steps left 62 keyframes and grew without bound (every later
    // sourceTimeAt then scanned 60 extra segments). The shifts compose once the
    // pin is gone, so the incremental path has to land on the one-shot curve.
    const { doc, clipId } = rampedClip({ start: 10, inPoint: 10 })
    const single = applyCommand(doc, {
      type: 'trimClip',
      clipId,
      start: 9,
      inPoint: 9,
      duration: 5,
      edge: 'head',
    })
    let stepped = doc
    for (let i = 1; i <= 60; i++) {
      const inc = i / 60
      stepped = applyCommand(stepped, {
        type: 'trimClip',
        clipId,
        start: 10 - inc,
        inPoint: 10 - inc,
        duration: 4 + inc,
        edge: 'head',
      })
    }
    const one = videoTrack(single).clips[0]
    const many = videoTrack(stepped).clips[0]
    // The count does not grow with N, and the curve is the one-shot curve.
    expect(many.keyframes!.timeScale!.length).toBe(one.keyframes!.timeScale!.length)
    for (let i = 0; i < one.keyframes!.timeScale!.length; i++) {
      expect(many.keyframes!.timeScale![i].time).toBeCloseTo(one.keyframes!.timeScale![i].time, 9)
      expect(many.keyframes!.timeScale![i].value).toBe(one.keyframes!.timeScale![i].value)
    }
    expect(many.inPoint).toBeCloseTo(one.inPoint, 9)
    for (const local of [0, 0.5, 1, 2, 3, 4]) {
      expect(sourceTimeAt(many, local)).toBeCloseTo(sourceTimeAt(one, local), 6)
    }
  })

  it('a REVERSED head extension already reads the kept frames (control)', () => {
    // The asymmetry that proves the forward bug: a reversed head move cannot
    // move the low anchor (pinned by the head rule) and the mirrored read
    // integrates the longer duration by itself, so the extension was already
    // exact. This must keep passing unchanged.
    const { doc, clipId } = rampedClip({ start: 10, inPoint: 10, reverse: true })
    const original = videoTrack(doc).clips[0]
    const next = applyCommand(doc, {
      type: 'trimClip',
      clipId,
      start: 9,
      inPoint: 9,
      duration: 5,
      edge: 'head',
    })
    const clip = videoTrack(next).clips[0]
    for (const local of [0, 0.5, 1, 2, 3, 4]) {
      expect(sourceTimeAt(clip, 1 + local)).toBeCloseTo(sourceTimeAt(original, local), 6)
    }
    expect(clip.inPoint).toBe(10)
  })

  it('a forward head extension that would rebase past the source start is rejected', () => {
    // The rebase moves the anchor down by the OLD head rate's consumption of
    // the reveal. The gesture's room assumes the static rate, so a 2x ramp
    // head can ask for more reveal than the source holds: inPoint 1 extended
    // by 1s at 2x would land the anchor at -1. The command is the exact check
    // and rejects instead of writing a negative source window.
    const { doc, clipId } = rampedClip({ start: 5, inPoint: 1 })
    const steep = applyCommand(doc, {
      type: 'setClipKeyframes',
      clipId,
      property: 'timeScale',
      keyframes: [
        { time: 0, value: 2 },
        { time: 4, value: 4 },
      ],
    })
    expect(() =>
      applyCommand(steep, {
        type: 'trimClip',
        clipId,
        start: 4,
        inPoint: 0,
        duration: 5,
        edge: 'head',
      }),
    ).toThrow('Trim exceeds the start of the source')
  })

  it('an unbounded ramped head move keeps inPoint at zero', () => {
    // An image (or a clip whose asset is gone) has no source window: the guard
    // pins its inPoint at 0, so neither the shrink's rebased anchor nor the
    // extension's negative-anchor rejection applies. The ramp itself still
    // rebases with the head.
    let doc = createDoc()
    doc.media = [createMediaAsset({ id: 'img', kind: 'image', name: 'p.png', url: 'blob:img' })]
    doc = applyCommand(doc, {
      type: 'addClip',
      trackId: videoTrack(doc).id,
      clip: createClip({ id: 'c_img', mediaId: 'img', start: 0, inPoint: 0, duration: 4 }),
    })
    const ramped = applyCommand(doc, {
      type: 'setClipKeyframes',
      clipId: 'c_img',
      property: 'timeScale',
      keyframes: [
        { time: 0, value: 1 },
        { time: 4, value: 2 },
      ],
    })
    // Extension: the rebased anchor would land at -1.
    const extended = applyCommand(ramped, {
      type: 'trimClip',
      clipId: 'c_img',
      start: 0,
      inPoint: 0,
      duration: 5,
      edge: 'head',
    })
    expect(videoTrack(extended).clips[0].inPoint).toBe(0)
    expect(videoTrack(extended).clips[0].duration).toBe(5)
    // Shrink: the anchor correction would land at 0.125.
    const shrunk = applyCommand(ramped, {
      type: 'trimClip',
      clipId: 'c_img',
      start: 1,
      inPoint: 0,
      duration: 3,
      edge: 'head',
    })
    expect(videoTrack(shrunk).clips[0].inPoint).toBe(0)
    expect(videoTrack(shrunk).clips[0].duration).toBe(3)
    // A clip whose asset is gone is unbounded too, and must not throw.
    const dangling = applyCommand(ramped, { type: 'removeMediaAsset', mediaId: 'img' })
    const next = applyCommand(dangling, {
      type: 'trimClip',
      clipId: 'c_img',
      start: 0,
      inPoint: 0,
      duration: 5,
      edge: 'head',
    })
    expect(videoTrack(next).clips[0].inPoint).toBe(0)
  })

  it('every over-consuming head trim lands a fitting window (sweep, linear and eased)', () => {
    // The recovery must hold for ANY cut position and easing: the rebased
    // window is always slid onto the asset's readable tail, never left
    // over-consuming (the guard's clamp ran against the pre-rebase anchor and
    // cannot see the rebase's raise).
    for (const interpolation of ['linear', 'easeInOut'] as const) {
      for (const cut of [0.5, 1, 1.5, 2, 2.5, 3, 3.5]) {
        const { doc, clipId } = rampedClip({ inPoint: 1 })
        const withEase = applyCommand(doc, {
          type: 'setClipKeyframes',
          clipId,
          property: 'timeScale',
          keyframes: [
            { time: 0, value: 1, interpolation },
            { time: 4, value: 2 },
          ],
        })
        const tight = structuredClone(withEase)
        tight.media[0].duration = 5 // the span reads [1, 7]: over by 2
        const next = applyCommand(tight, {
          type: 'trimClip',
          clipId,
          start: cut,
          inPoint: 1 + cut,
          duration: 4 - cut,
          edge: 'head',
        })
        const clip = videoTrack(next).clips[0]
        const readEnd =
          clip.inPoint +
          integrateKeyframes(clip.keyframes!.timeScale!, clip.duration, clip.speed ?? 1)
        expect(readEnd).toBeLessThanOrEqual(5 + 1e-6)
        // A head drag's right edge stays where the drag anchored it.
        expect(clip.start + clip.duration).toBeCloseTo(4, 6)
        expect(clip.duration).toBeGreaterThanOrEqual(MIN_CLIP_DURATION)
      }
    }
  })

  it('a reversed head trim keeps the frames the kept locals showed', () => {
    // A reversed clip's head edge shows the span's HIGH end, so a head move
    // removes source from the top: inPoint (the LOW anchor, read at the clip's
    // tail) stays put and the shortened duration carries the change. The
    // caller's inPoint delta is timeline-local and must NOT re-cut the span,
    // which would slide the whole surviving window one head-length up the
    // source. The same rule covers the constant-rate reversed sibling, which
    // shares the branch.
    const trim = { type: 'trimClip', start: 1, inPoint: 1, duration: 3, edge: 'head' } as const
    const ramped = rampedClip({ reverse: true })
    const next = applyCommand(ramped.doc, { ...trim, clipId: ramped.clipId })
    const clip = videoTrack(next).clips[0]
    const original = videoTrack(ramped.doc).clips[0]
    for (const local of [0, 0.5, 1, 1.5, 2, 3]) {
      expect(sourceTimeAt(clip, local)).toBeCloseTo(sourceTimeAt(original, 1 + local), 6)
    }
    expect(clip.inPoint).toBe(original.inPoint)
    // The boundary rate is pinned at the cut in mirrored time (3 = 4 - 1).
    expect(clip.keyframes?.timeScale).toMatchObject([
      { time: 0, value: 1 },
      { time: 3, value: 1.75 },
    ])
    // Strip the curve from the control so it reads constant-rate material.
    const constant = rampedClip({ reverse: true, speed: 1 })
    delete constant.doc.project.tracks[0].clips[0].keyframes
    const constantNext = applyCommand(constant.doc, { ...trim, clipId: constant.clipId })
    const constantClip = videoTrack(constantNext).clips[0]
    const constantOriginal = videoTrack(constant.doc).clips[0]
    for (const local of [0, 1, 2, 3]) {
      expect(sourceTimeAt(constantClip, local)).toBeCloseTo(
        sourceTimeAt(constantOriginal, 1 + local),
        6,
      )
    }
  })

  it('an EASED reversed head trim subdivides the mirrored crossing segment', () => {
    // The mirrored read integrates the kept curve from the source-side origin,
    // so the segment the cut crosses ENDS at the boundary: its left sub-curve
    // rides on the last surviving keyframe and the boundary append is linear.
    // Re-applying the preset name over the shortened span (pieces.right on a
    // boundary no segment starts at) drifted the interior; the linear sibling
    // above could never catch it.
    const trim = { type: 'trimClip', start: 1, inPoint: 1, duration: 3, edge: 'head' } as const
    for (const interpolation of ['easeIn', 'easeOut', 'easeInOut'] as const) {
      const { doc, clipId } = rampedClipWith(interpolation, { reverse: true })
      const original = videoTrack(doc).clips[0]
      const next = applyCommand(doc, { ...trim, clipId })
      const clip = videoTrack(next).clips[0]
      let worst = 0
      for (const local of [0.25, 0.5, 1, 1.5, 2, 2.75]) {
        worst = Math.max(
          worst,
          Math.abs(sourceTimeAt(clip, local) - sourceTimeAt(original, 1 + local)),
        )
      }
      expect(worst).toBeLessThan(1e-5)
      // The shape data rode along on the survivor, not the boundary.
      expect(clip.keyframes!.timeScale![0].easeOut).toBeDefined()
      expect(clip.keyframes!.timeScale![1].easeOut).toBeUndefined()
    }
  })

  it('a forward tail trim leaves the curve and inPoint untouched', () => {
    const { doc, clipId } = rampedClip()
    const before = videoTrack(doc).clips[0]
    const next = applyCommand(doc, {
      type: 'trimClip',
      clipId,
      start: 0,
      inPoint: 0,
      duration: 3,
      edge: 'tail',
    })
    const clip = videoTrack(next).clips[0]
    expect(clip.inPoint).toBe(before.inPoint)
    expect(clip.keyframes?.timeScale).toEqual(before.keyframes?.timeScale)
  })

  it('a reversed tail trim keeps the frames the kept locals showed', () => {
    // The mirror of the reversed HEAD rule above: a reversed clip's tail edge is
    // the span's LOW source end, so dragging it has to hold the HIGH end (what
    // the head shows) still and re-derive the low anchor. Leaving inPoint alone
    // instead slid the whole picture under the drag, because the reversed read
    // maps local time to `duration - local`: a shrunk duration moved every kept
    // frame up the source by the trimmed amount.
    const constant = rampedClip({ reverse: true, speed: 1 })
    delete constant.doc.project.tracks[0].clips[0].keyframes
    const before = videoTrack(constant.doc).clips[0]
    const next = applyCommand(constant.doc, {
      type: 'trimClip',
      clipId: constant.clipId,
      start: 0,
      inPoint: 0,
      duration: 3,
      edge: 'tail',
    })
    const clip = videoTrack(next).clips[0]
    for (const local of [0, 0.5, 1, 1.5, 2, 3]) {
      expect(sourceTimeAt(clip, local)).toBeCloseTo(sourceTimeAt(before, local), 6)
    }
    // The tail gave up 1s of source, so the low anchor moved up by exactly that.
    expect(clip.inPoint).toBeCloseTo(before.inPoint + 1, 6)
    expect(clip.duration).toBe(3)
  })

  it('a reversed tail trim rebases the ramp so its kept span reads the same frames', () => {
    // With a curve the low end moves by the curve's INTEGRAL over the timeline
    // the tail gave up, and the curve itself has to shift down onto the new
    // origin (its offset 0 is what the clip's tail reads), pinning the rate at
    // the cut as the new first keyframe. Same boundary pattern as the forward
    // head: exact for a linear ramp.
    const { doc, clipId } = rampedClip({ reverse: true })
    const before = videoTrack(doc).clips[0]
    const next = applyCommand(doc, {
      type: 'trimClip',
      clipId,
      start: 0,
      inPoint: 0,
      duration: 3,
      edge: 'tail',
    })
    const clip = videoTrack(next).clips[0]
    for (const local of [0, 0.5, 1, 1.5, 2, 3]) {
      expect(sourceTimeAt(clip, local)).toBeCloseTo(sourceTimeAt(before, local), 6)
    }
    // 1s of timeline at the mirrored low end consumes the curve's first second:
    // the 1x..2x ramp integrates to 1.125 source seconds.
    expect(clip.inPoint).toBeCloseTo(before.inPoint + 1.125, 6)
    expect(clip.keyframes?.timeScale).toMatchObject([
      { time: 0, value: 1.25 }, // the rate at the cut (offset 1)
      { time: 3, value: 2 },
    ])
  })

  it('an EASED reversed tail trim subdivides the mirrored crossing segment', () => {
    // The tail branch shifts the curve down onto the new origin and pins the
    // cut's rate at 0 with the crossing segment's right sub-curve, so the kept
    // span re-times the original exactly whatever the easing. The extension
    // mirror reveals source below the low anchor at the curve's origin rate and
    // needs no subdivision.
    for (const interpolation of ['easeIn', 'easeOut', 'easeInOut'] as const) {
      const { doc, clipId } = rampedClipWith(interpolation, { reverse: true })
      const original = videoTrack(doc).clips[0]
      const shrunk = applyCommand(doc, {
        type: 'trimClip',
        clipId,
        start: 0,
        inPoint: 0,
        duration: 3,
        edge: 'tail',
      })
      const clip = videoTrack(shrunk).clips[0]
      let worst = 0
      for (const local of [0.25, 0.5, 1, 1.5, 2, 2.75]) {
        worst = Math.max(worst, Math.abs(sourceTimeAt(clip, local) - sourceTimeAt(original, local)))
      }
      expect(worst).toBeLessThan(1e-5)
      expect(clip.keyframes!.timeScale![0].easeOut).toBeDefined()
      // Extension: inPoint 2 leaves source below the low anchor to reveal.
      const ext = rampedClipWith(interpolation, { reverse: true, inPoint: 2 })
      const extOriginal = videoTrack(ext.doc).clips[0]
      const extended = applyCommand(ext.doc, {
        type: 'trimClip',
        clipId: ext.clipId,
        start: 0,
        inPoint: 2,
        duration: 5,
        edge: 'tail',
      })
      const wide = videoTrack(extended).clips[0]
      let extWorst = 0
      for (const local of [0, 0.5, 1, 2, 3, 4]) {
        extWorst = Math.max(
          extWorst,
          Math.abs(sourceTimeAt(wide, local) - sourceTimeAt(extOriginal, local)),
        )
      }
      expect(extWorst).toBeLessThan(1e-5)
      expect(wide.inPoint).toBeCloseTo(1, 6)
      expect(sourceTimeAt(wide, 5)).toBeCloseTo(1, 6)
    }
  })

  it('a reversed tail trim cannot reveal source before the asset start', () => {
    // The mirrored room is what sits BELOW inPoint, so a clip whose low anchor is
    // already at source 0 has no tail extension left, and the command says so
    // instead of sliding the window down past the material.
    const { doc, clipId } = rampedClip({ reverse: true, inPoint: 0, speed: 1 })
    const bare = structuredClone(doc)
    delete bare.project.tracks[0].clips[0].keyframes
    expect(() =>
      applyCommand(bare, {
        type: 'trimClip',
        clipId,
        start: 0,
        inPoint: 0,
        duration: 5,
        edge: 'tail',
      }),
    ).toThrow('Trim exceeds the start of the source')
  })

  it('leaves other curves on a reversed clip splitting front-to-back', () => {
    const { doc, clipId } = rampedClip({ reverse: true })
    const faded = applyCommand(doc, {
      type: 'setClipKeyframes',
      clipId,
      property: 'opacity',
      keyframes: [
        { time: 0, value: 1 },
        { time: 4, value: 0 },
      ],
    })
    const next = applyCommand(faded, { type: 'splitClip', clipId, atTime: 2 })
    const [left, right] = videoTrack(next).clips
    // Opacity is read at plain local time, never mirrored.
    expect(left.keyframes?.opacity).toMatchObject([
      { time: 0, value: 1 },
      { time: 2, value: 0.5 },
    ])
    expect(right.keyframes?.opacity).toMatchObject([
      { time: 0, value: 0.5 },
      { time: 2, value: 0 },
    ])
  })
})

describe('splitClip', () => {
  function splitSetup() {
    const { doc, videoAsset } = makeDoc()
    const withClip = applyCommand(doc, {
      type: 'addClip',
      trackId: videoTrack(doc).id,
      clip: createClip({
        mediaId: videoAsset.id,
        start: 1,
        inPoint: 2,
        duration: 6,
      }),
    })
    return { doc: withClip, clipId: videoTrack(withClip).clips[0].id }
  }

  it('splits into two clips with correct inPoints', () => {
    const { doc, clipId } = splitSetup()
    const next = applyCommand(doc, { type: 'splitClip', clipId, atTime: 4 })
    const clips = videoTrack(next).clips
    expect(clips).toHaveLength(2)
    expect(clips[0]).toMatchObject({ start: 1, duration: 3, inPoint: 2 })
    expect(clips[1]).toMatchObject({ start: 4, duration: 3, inPoint: 5 })
    expect(clips[1].id).not.toBe(clips[0].id)
  })

  it('splits a reversed clip without breaking the source traversal', () => {
    const { doc, videoAsset } = makeDoc()
    videoAsset.duration = 60 // room for the 6 s clip at 2x (12 s of source)
    const withClip = applyCommand(doc, {
      type: 'addClip',
      trackId: videoTrack(doc).id,
      clip: createClip({
        mediaId: videoAsset.id,
        start: 1,
        inPoint: 2,
        duration: 6,
        speed: 2,
        reverse: true,
      }),
    })
    const original = videoTrack(withClip).clips[0]
    const next = applyCommand(withClip, { type: 'splitClip', clipId: original.id, atTime: 3 })
    const [left, right] = videoTrack(next).clips

    // Split at local 2: the left half owns the span tail, so it moves up by the
    // RIGHT half's source span (4 s x 2 = 8); the right half keeps inPoint 2.
    expect(left).toMatchObject({ start: 1, duration: 2, inPoint: 10 })
    expect(right).toMatchObject({ start: 3, duration: 4, inPoint: 2 })

    // The halves read exactly the frames the unsplit clip did.
    expect(sourceTimeAt(left, 0)).toBe(sourceTimeAt(original, 0))
    expect(sourceTimeAt(left, left.duration)).toBe(sourceTimeAt(right, 0))
    expect(sourceTimeAt(right, right.duration)).toBe(sourceTimeAt(original, original.duration))
  })

  it('rejects splits too close to edges or outside the clip', () => {
    const { doc, clipId } = splitSetup()
    expect(() => applyCommand(doc, { type: 'splitClip', clipId, atTime: 1.05 })).toThrow(
      EditorCommandError,
    )
    expect(() => applyCommand(doc, { type: 'splitClip', clipId, atTime: 6.95 })).toThrow(
      EditorCommandError,
    )
    expect(() => applyCommand(doc, { type: 'splitClip', clipId, atTime: 20 })).toThrow(
      EditorCommandError,
    )
  })

  it('splits a transition holder and the right part inherits the transition', () => {
    const { doc, videoAsset } = makeDoc()
    const trackId = videoTrack(doc).id
    let next = applyCommand(doc, {
      type: 'addClip',
      trackId,
      clip: createClip({ mediaId: videoAsset.id, start: 0, duration: 6 }),
    })
    next = applyCommand(next, {
      type: 'addClip',
      trackId,
      clip: createClip({
        mediaId: videoAsset.id,
        start: 6,
        inPoint: 0,
        duration: 4,
      }),
    })
    const first = videoTrack(next).clips[0].id
    next = applyCommand(next, {
      type: 'addTransition',
      clipId: first,
      duration: 1,
    })
    expect(videoTrack(next).clips[1].start).toBe(5) // pulled left by 1s

    next = applyCommand(next, { type: 'splitClip', clipId: first, atTime: 3 })
    const clips = videoTrack(next).clips
    expect(clips[0].transitionOut).toBeUndefined()
    expect(clips[1].transitionOut?.duration).toBe(1)
  })
})

describe('transitions', () => {
  function twoClips() {
    const { doc, videoAsset } = makeDoc()
    const trackId = videoTrack(doc).id
    let next = applyCommand(doc, {
      type: 'addClip',
      trackId,
      clip: createClip({ mediaId: videoAsset.id, start: 0, duration: 6 }),
    })
    next = applyCommand(next, {
      type: 'addClip',
      trackId,
      clip: createClip({ mediaId: videoAsset.id, start: 6, duration: 4 }),
    })
    return {
      doc: next,
      a: videoTrack(next).clips[0],
      b: videoTrack(next).clips[1],
      trackId,
    }
  }

  it('addTransition creates overlap by pulling the next clip left', () => {
    const { doc, a } = twoClips()
    const next = applyCommand(doc, {
      type: 'addTransition',
      clipId: a.id,
      duration: 1,
    })
    const [na, nb] = videoTrack(next).clips
    expect(na.transitionOut).toEqual({ type: 'crossfade', duration: 1 })
    expect(nb.start).toBe(5) // 6 - 1
  })

  it('addTransition stamps the requested dip type', () => {
    const { doc, a } = twoClips()
    const next = applyCommand(doc, {
      type: 'addTransition',
      clipId: a.id,
      duration: 1,
      transitionType: 'dipToBlack',
    })
    const [na, nb] = videoTrack(next).clips
    expect(na.transitionOut).toEqual({ type: 'dipToBlack', duration: 1 })
    expect(nb.start).toBe(5) // 6 - 1
  })

  it('duration-only re-dispatch preserves an existing dip type', () => {
    const { doc, a } = twoClips()
    const dipped = applyCommand(doc, {
      type: 'addTransition',
      clipId: a.id,
      duration: 1,
      transitionType: 'dipToBlack',
    })
    // Slider drags dispatch duration only; the dip must survive them.
    const next = applyCommand(dipped, {
      type: 'addTransition',
      clipId: a.id,
      duration: 2,
    })
    expect(videoTrack(next).clips[0].transitionOut).toEqual({
      type: 'dipToBlack',
      duration: 2,
    })
  })

  it('type-only re-dispatch preserves the next clip placement', () => {
    const { doc, a, b, trackId } = twoClips()
    const dipped = applyCommand(doc, {
      type: 'addTransition',
      clipId: a.id,
      duration: 1,
      transitionType: 'dipToBlack',
    })
    // Shorten the overlap without touching the stored duration, then
    // switch the type: the clips must stay where the user put them.
    const moved = applyCommand(dipped, { type: 'moveClip', clipId: b.id, trackId, start: 3.5 })
    expect(videoTrack(moved).clips[1].start).toBe(3.5)
    const next = applyCommand(moved, {
      type: 'addTransition',
      clipId: a.id,
      duration: 1,
      transitionType: 'crossfade',
    })
    expect(videoTrack(next).clips[1].start).toBe(3.5)
    expect(videoTrack(next).clips[0].transitionOut).toEqual({
      type: 'crossfade',
      duration: 1,
    })
  })

  it('clamps duration to the shorter clip', () => {
    const { doc, a } = twoClips()
    const next = applyCommand(doc, {
      type: 'addTransition',
      clipId: a.id,
      duration: 50,
    })
    expect(videoTrack(next).clips[0].transitionOut?.duration).toBe(4) // min(6,4, TRANSITION_MAX)
  })

  it('throws without a following clip', () => {
    const { doc, a } = twoClips()
    const withoutB: Doc = {
      ...structuredClone(doc),
      project: {
        ...doc.project,
        tracks: doc.project.tracks.map((t) =>
          t.kind === 'video' ? { ...t, clips: [structuredClone(a)] } : t,
        ),
      },
    }
    expect(() =>
      applyCommand(withoutB, {
        type: 'addTransition',
        clipId: a.id,
        duration: 1,
      }),
    ).toThrow(EditorCommandError)
  })

  it('removeTransition clears the property but keeps positions', () => {
    const { doc, a } = twoClips()
    const withT = applyCommand(doc, {
      type: 'addTransition',
      clipId: a.id,
      duration: 1,
    })
    const removed = applyCommand(withT, {
      type: 'removeTransition',
      clipId: a.id,
    })
    expect(videoTrack(removed).clips[0].transitionOut).toBeUndefined()
    expect(videoTrack(removed).clips[1].start).toBe(5)
  })
})

describe('clip audio + text properties', () => {
  it('clamps gain into [0, 2] and toggles mute', () => {
    const { doc, videoAsset } = makeDoc()
    const withClip = applyCommand(doc, {
      type: 'addClip',
      trackId: videoTrack(doc).id,
      clip: createClip({ mediaId: videoAsset.id, duration: 4 }),
    })
    const clipId = videoTrack(withClip).clips[0].id
    const g1 = applyCommand(withClip, { type: 'setClipGain', clipId, gain: 5 })
    expect(videoTrack(g1).clips[0].gain).toBe(2)
    const g2 = applyCommand(g1, { type: 'setClipGain', clipId, gain: -1 })
    expect(videoTrack(g2).clips[0].gain).toBe(0)
    const m = applyCommand(g2, { type: 'setClipMuted', clipId, muted: true })
    expect(videoTrack(m).clips[0].muted).toBe(true)
  })

  it('updates text content and style', () => {
    const { doc } = makeDoc()
    const textTrack = structuredClone(doc.project.tracks[0])
    textTrack.kind = 'text'
    textTrack.name = 'T1'
    doc.project.tracks = [
      textTrack,
      ...doc.project.tracks.filter((t) => t !== doc.project.tracks[0]),
    ]
    const textClip = createTextClip({ duration: 3 })
    const withClip = applyCommand(doc, {
      type: 'addClip',
      trackId: textTrack.id,
      clip: textClip,
    })
    const clipId = clipIdOf(withClip)
    const next = applyCommand(withClip, {
      type: 'setTextStyle',
      clipId,
      style: { fontSize: 120, color: '#ff0000' },
    })
    const clip = textTrackOf(next).clips[0]
    expect(clip.text).toBe('Your text here')
    expect(clip.style?.fontSize).toBe(120)
    expect(clip.style?.color).toBe('#ff0000')
    expect(clip.style?.align).toBe('center') // untouched
  })

  it('rejects text commands on media clips', () => {
    const { doc, videoAsset } = makeDoc()
    const withClip = applyCommand(doc, {
      type: 'addClip',
      trackId: videoTrack(doc).id,
      clip: createClip({ mediaId: videoAsset.id, duration: 4 }),
    })
    const clipId = videoTrack(withClip).clips[0].id
    expect(() => applyCommand(withClip, { type: 'setTextContent', clipId, text: 'nope' })).toThrow(
      EditorCommandError,
    )
  })
})

describe('setProjectSettings + batch', () => {
  it('clamps project settings', () => {
    const { doc } = makeDoc()
    const next = applyCommand(doc, {
      type: 'setProjectSettings',
      patch: { width: 999999, height: -5, fps: 1000, name: 'My Film' },
    })
    expect(next.project).toMatchObject({
      name: 'My Film',
      width: 3840,
      height: 64,
      fps: 60,
    })
  })

  it('applyCommands applies a sequence atomically (one clone)', () => {
    const { doc, videoAsset } = makeDoc()
    const trackId = videoTrack(doc).id
    const next = applyCommands(doc, [
      {
        type: 'addClip',
        trackId,
        clip: createClip({ mediaId: videoAsset.id, duration: 4 }),
      },
      { type: 'addTrack', kind: 'text' },
    ])
    expect(videoTrack(next).clips).toHaveLength(1)
    expect(next.project.tracks[0].kind).toBe('text')
  })
})

describe('docDuration', () => {
  it('returns the latest out-point', () => {
    const { doc, videoAsset } = makeDoc()
    expect(docDuration(doc)).toBe(0)
    const next = applyCommand(doc, {
      type: 'addClip',
      trackId: videoTrack(doc).id,
      clip: createClip({
        mediaId: videoAsset.id,
        start: 2,
        duration: 4,
      }) as Clip,
    })
    expect(docDuration(next)).toBe(6)
  })
})

// helpers
function clipIdOf(doc: Doc): string {
  for (const t of doc.project.tracks) if (t.clips.length) return t.clips[0].id
  throw new Error('no clip')
}
function textTrackOf(doc: Doc): Track {
  return doc.project.tracks.filter((t) => t.kind === 'text')[0]
}

describe('setClipOpacity', () => {
  it('sets opacity, clamps into 0..1 and rejects unknown clips', () => {
    const { doc, videoAsset } = makeDoc()
    const withClip = applyCommand(doc, {
      type: 'addClip',
      trackId: videoTrack(doc).id,
      clip: createClip({ mediaId: videoAsset.id, duration: 5 }),
    })
    const clipId = clipIdOf(withClip)
    const half = applyCommand(withClip, { type: 'setClipOpacity', clipId, opacity: 0.5 })
    expect(videoTrack(half).clips[0].opacity).toBe(0.5)
    // > 1 clamps to fully opaque, < 0 to invisible
    const high = applyCommand(half, { type: 'setClipOpacity', clipId, opacity: 5 })
    expect(videoTrack(high).clips[0].opacity).toBe(1)
    const low = applyCommand(high, { type: 'setClipOpacity', clipId, opacity: -1 })
    expect(videoTrack(low).clips[0].opacity).toBe(0)
    expect(() =>
      applyCommand(low, { type: 'setClipOpacity', clipId: 'clip_nope', opacity: 0.5 }),
    ).toThrow(EditorCommandError)
  })
})

describe('markers (0.5.5)', () => {
  function docWithClip(): { doc: Doc; clipId: string } {
    const { doc, videoAsset } = makeDoc()
    const withClip = applyCommand(doc, {
      type: 'addClip',
      trackId: videoTrack(doc).id,
      clip: createClip({
        id: 'clip_m1',
        mediaId: videoAsset.id,
        start: 2,
        duration: 4,
        inPoint: 1,
      }),
    })
    return { doc: withClip, clipId: 'clip_m1' }
  }

  it('addSequenceMarker adds, sorts by time and rejects duplicates', () => {
    const { doc } = docWithClip()
    const next = applyCommand(doc, {
      type: 'addSequenceMarker',
      marker: { id: 'm_late', time: 9, name: '  Late  ' },
    })
    const sorted = applyCommand(next, {
      type: 'addSequenceMarker',
      marker: { id: 'm_early', time: 1 },
    })
    expect(sorted.project.markers!.map((m) => m.id)).toEqual(['m_early', 'm_late'])
    expect(sorted.project.markers![1].name).toBe('Late')
    expect(() =>
      applyCommand(sorted, {
        type: 'addSequenceMarker',
        marker: { id: 'm_early', time: 5 },
      }),
    ).toThrow(EditorCommandError)
    // Input doc untouched.
    expect(doc.project.markers).toBeUndefined()
  })

  it('rejects negative, non-finite and id-less markers', () => {
    const { doc } = docWithClip()
    expect(() =>
      applyCommand(doc, { type: 'addSequenceMarker', marker: { id: 'm', time: -1 } }),
    ).toThrow(EditorCommandError)
    expect(() =>
      applyCommand(doc, { type: 'addSequenceMarker', marker: { id: 'm', time: Number.NaN } }),
    ).toThrow(EditorCommandError)
    expect(() =>
      applyCommand(doc, { type: 'addSequenceMarker', marker: { id: '', time: 1 } }),
    ).toThrow(EditorCommandError)
  })

  it('move/update/delete a sequence marker; deleting the last collapses the array', () => {
    const { doc } = docWithClip()
    const withTwo = applyCommands(doc, [
      { type: 'addSequenceMarker', marker: { id: 'm1', time: 1 } },
      { type: 'addSequenceMarker', marker: { id: 'm2', time: 2 } },
    ])
    const moved = applyCommand(withTwo, { type: 'moveSequenceMarker', markerId: 'm1', time: 5 })
    expect(moved.project.markers!.map((m) => m.id)).toEqual(['m2', 'm1'])
    const updated = applyCommand(moved, {
      type: 'updateSequenceMarker',
      markerId: 'm2',
      patch: { name: 'Cue', color: 'red', notes: 'check' },
    })
    expect(updated.project.markers![0]).toMatchObject({ name: 'Cue', color: 'red', notes: 'check' })
    const one = applyCommand(updated, { type: 'deleteSequenceMarker', markerId: 'm1' })
    const none = applyCommand(one, { type: 'deleteSequenceMarker', markerId: 'm2' })
    expect(none.project.markers).toBeUndefined()
    expect(() => applyCommand(none, { type: 'deleteSequenceMarker', markerId: 'm2' })).toThrow(
      EditorCommandError,
    )
  })

  it('clip markers live on the clip and reject unknown clips/markers', () => {
    const { doc, clipId } = docWithClip()
    const withMarker = applyCommand(doc, {
      type: 'addClipMarker',
      clipId,
      marker: { id: 'cm1', time: 3, name: 'Beat' },
    })
    expect(videoTrack(withMarker).clips[0].markers).toHaveLength(1)
    const moved = applyCommand(withMarker, {
      type: 'moveClipMarker',
      clipId,
      markerId: 'cm1',
      time: 4.5,
    })
    expect(videoTrack(moved).clips[0].markers![0].time).toBe(4.5)
    const updated = applyCommand(moved, {
      type: 'updateClipMarker',
      clipId,
      markerId: 'cm1',
      patch: { notes: 'here' },
    })
    expect(videoTrack(updated).clips[0].markers![0].notes).toBe('here')
    const removed = applyCommand(updated, {
      type: 'deleteClipMarker',
      clipId,
      markerId: 'cm1',
    })
    expect(videoTrack(removed).clips[0].markers).toBeUndefined()
    expect(() =>
      applyCommand(removed, {
        type: 'addClipMarker',
        clipId: 'nope',
        marker: { id: 'x', time: 1 },
      }),
    ).toThrow(EditorCommandError)
    expect(() =>
      applyCommand(removed, { type: 'moveClipMarker', clipId, markerId: 'cm1', time: 1 }),
    ).toThrow(EditorCommandError)
  })

  it('split keeps source-relative markers on both halves, with FRESH ids on the right', () => {
    const { doc, clipId } = docWithClip()
    const withMarkers = applyCommands(doc, [
      { type: 'addClipMarker', clipId, marker: { id: 'cm1', time: 2 } },
      { type: 'addClipMarker', clipId, marker: { id: 'cm2', time: 4.5 } },
    ])
    const split = applyCommand(withMarkers, { type: 'splitClip', clipId, atTime: 4 })
    const clips = videoTrack(split).clips
    expect(clips).toHaveLength(2)
    // Source-anchored: both halves keep the FULL marker data (hidden cues are
    // data, not deleted, so extending a half brings them back) with unchanged
    // source times; visibility filtering is render-time.
    expect(clips.map((c) => c.markers!.map((m) => m.time).sort())).toEqual([
      [2, 4.5],
      [2, 4.5],
    ])
    // The halves coexist, so the ids must not collide: a delete/edit on one
    // half would otherwise leave the twin behind (and extending the half
    // later resurrects it), and snap exclusion matches by id alone.
    const [left, right] = clips
    expect(left.markers!.map((m) => m.id)).toEqual(['cm1', 'cm2'])
    const rightIds = new Set(right.markers!.map((m) => m.id))
    expect(rightIds.size).toBe(2)
    for (const id of left.markers!.map((m) => m.id)) {
      expect(rightIds.has(id)).toBe(false)
    }
  })
})
