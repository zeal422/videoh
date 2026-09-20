/**
 * Anti-regression tests for the command layer (commands.ts).
 * Every command is validated: happy path + rejection + immutability of the input doc.
 */
import { describe, expect, it } from 'vitest'
import { applyCommand, applyCommands, EditorCommandError } from '../commands'
import { createClip, createDoc, createMediaAsset, createTextClip, docDuration } from '../factories'
import type { Clip, Doc, MediaAsset, Track } from '../types'
import { MIN_CLIP_DURATION } from '../constants'

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
      }),
    ).toThrow(EditorCommandError)
    expect(() =>
      applyCommand(doc, {
        type: 'trimClip',
        clipId,
        start: 0,
        inPoint: 0,
        duration: videoAsset.duration + 1,
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
      }),
    ).toThrow(EditorCommandError)
    expect(() =>
      applyCommand(doc, {
        type: 'trimClip',
        clipId: 'nope',
        start: 0,
        inPoint: 0,
        duration: 1,
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
    })
    const clip = videoTrack(next).clips[0]
    expect(clip.duration).toBe(60)
    expect(clip.inPoint).toBe(0)
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
