import { describe, expect, it } from 'vitest'
import {
  deserializeDoc,
  parseSerializedDoc,
  projectFileName,
  SerializationError,
  serializeDoc,
} from '../serialization'
import { createClip, createDoc, createMediaAsset, createTextClip } from '../factories'

function makeDoc() {
  const doc = createDoc()
  const asset = createMediaAsset({
    id: 'media_fixed',
    kind: 'video',
    name: 'a.mp4',
    duration: 10,
    width: 640,
    height: 360,
    url: 'blob:should-not-persist',
    thumbnail: 'data:image/jpeg;base64,xxx',
    waveformPeaks: [0.1, 0.5, 0.9],
  })
  doc.media = [asset]
  const videoTrack = doc.project.tracks.filter((t) => t.kind === 'video')[0]
  videoTrack.clips = [
    createClip({
      id: 'clip_fixed',
      mediaId: asset.id,
      start: 1,
      duration: 4,
      inPoint: 2,
      gain: 0.5,
      transitionOut: { type: 'crossfade', duration: 0.5 },
    }),
  ]
  return doc
}

describe('serializeDoc', () => {
  it('strips object URLs but keeps metadata, peaks and thumbnails', () => {
    const json = serializeDoc(makeDoc())
    const raw = JSON.stringify(json)
    expect(raw).not.toContain('blob:should-not-persist')
    expect(json.media[0].waveformPeaks).toEqual([0.1, 0.5, 0.9])
    expect(json.media[0].thumbnail).toBeTruthy()
    expect(json.version).toBe(1)
    expect(json.project.tracks[0].clips[0].transitionOut).toEqual({
      type: 'crossfade',
      duration: 0.5,
    })
  })
})

describe('deserializeDoc', () => {
  it('round-trips a serialized doc and flags all media as missing', () => {
    const { doc, missingMediaIds } = deserializeDoc(
      JSON.parse(JSON.stringify(serializeDoc(makeDoc()))),
    )
    expect(missingMediaIds).toEqual(['media_fixed'])
    const clip = doc.project.tracks[0].clips[0]
    expect(clip).toMatchObject({
      id: 'clip_fixed',
      start: 1,
      duration: 4,
      inPoint: 2,
      gain: 0.5,
    })
    expect(doc.media[0]).toMatchObject({
      id: 'media_fixed',
      url: '',
      missing: true,
    })
  })

  it('drops clip references to media that no longer exists', () => {
    const data = JSON.parse(JSON.stringify(serializeDoc(makeDoc())))
    data.media = []
    const { doc } = deserializeDoc(data)
    expect(doc.project.tracks[0].clips[0].mediaId).toBeUndefined()
  })

  it('survives partial/corrupt payloads with defaults', () => {
    const { doc } = deserializeDoc({
      version: 1,
      project: {
        tracks: [
          {
            kind: 'video',
            clips: [{ start: 'x', duration: null, text: 'hello' }],
          },
          { kind: 'audio' },
        ],
      },
    })
    expect(doc.project.name).toBe('Imported Project')
    expect(doc.project.tracks[0].clips[0].text).toBe('hello')
    expect(doc.project.tracks[0].clips[0].start).toBe(0)
    expect(doc.project.tracks[1].clips).toEqual([])
  })

  it('hydrates text clip styles', () => {
    const doc = createDoc()
    doc.project.tracks[0].kind = 'text'
    doc.project.tracks[0].clips = [createTextClip({ id: 't1', style: { fontSize: 99 } } as never)]
    const { doc: restored } = deserializeDoc(JSON.parse(JSON.stringify(serializeDoc(doc))))
    const style = restored.project.tracks[0].clips[0].style!
    expect(style.fontSize).toBe(99)
    expect(style.color).toBe('#ffffff')
    expect(style.align).toBe('center')
  })
})

describe('parseSerializedDoc', () => {
  it('throws SerializationError on broken JSON', () => {
    expect(() => parseSerializedDoc('{nope')).toThrow(SerializationError)
  })

  it('throws on unknown versions', () => {
    expect(() => parseSerializedDoc(JSON.stringify({ version: 99 }))).toThrow(SerializationError)
    expect(() => parseSerializedDoc('null')).toThrow(SerializationError)
  })
})

describe('projectFileName', () => {
  it('sanitizes the project name', () => {
    expect(projectFileName('My: Cool/ Film?')).toBe('My-Cool-Film.veproj.json')
    expect(projectFileName('   ')).toBe('project.veproj.json')
  })
})

describe('clip opacity serialization', () => {
  it('round-trips clip opacity', () => {
    const doc = makeDoc()
    doc.project.tracks[0].clips[0].opacity = 0.3
    const { doc: restored } = deserializeDoc(JSON.parse(JSON.stringify(serializeDoc(doc))))
    expect(restored.project.tracks[0].clips[0].opacity).toBe(0.3)
  })

  it('clamps out-of-range opacity and ignores non-numeric values', () => {
    const data = JSON.parse(JSON.stringify(serializeDoc(makeDoc())))
    data.project.tracks[0].clips[0].opacity = 7
    const { doc } = deserializeDoc(data)
    // clamped to the 1 default → field stays absent (clean files)
    expect(doc.project.tracks[0].clips[0].opacity).toBeUndefined()
    data.project.tracks[0].clips[0].opacity = 'x'
    const { doc: doc2 } = deserializeDoc(data)
    expect(doc2.project.tracks[0].clips[0].opacity).toBeUndefined()
  })
})

describe('track order serialization', () => {
  it('preserves non-conventional track order — z-order is user intent', () => {
    // Drop-between-tracks can create orders the text→video→audio convention
    // would never produce (e.g. an audio layer between two video layers).
    // tracks[0] is the TOP compositing layer, so the array order must survive
    // save/load verbatim — re-sorting here would silently change the render.
    const doc = makeDoc()
    const [v1, a1] = doc.project.tracks
    v1.name = 'V1'
    a1.name = 'A1'
    doc.project.tracks = [a1, v1] // audio layer ON TOP of the video layer
    const { doc: restored } = deserializeDoc(JSON.parse(JSON.stringify(serializeDoc(doc))))
    expect(restored.project.tracks.map((t) => t.name)).toEqual(['A1', 'V1'])
  })
})

describe('A/V link serialization', () => {
  it('round-trips linkId, audioOnly and the asset hasAudio flag', () => {
    const doc = makeDoc()
    doc.media[0].hasAudio = true
    const videoTrack = doc.project.tracks.filter((t) => t.kind === 'video')[0]
    const audioTrack = doc.project.tracks.filter((t) => t.kind === 'audio')[0]
    videoTrack.clips = [
      createClip({
        id: 'clip_v',
        mediaId: 'media_fixed',
        start: 0,
        duration: 4,
        linkId: 'link_abc',
      }),
    ]
    audioTrack.clips = [
      createClip({
        id: 'clip_a',
        mediaId: 'media_fixed',
        start: 0,
        duration: 4,
        linkId: 'link_abc',
        audioOnly: true,
      }),
    ]

    const json = JSON.parse(JSON.stringify(serializeDoc(doc)))
    expect(json.media[0].hasAudio).toBe(true)

    const { doc: restored } = deserializeDoc(json)
    const v = restored.project.tracks.flatMap((t) => t.clips).find((c) => c.id === 'clip_v')!
    const a = restored.project.tracks.flatMap((t) => t.clips).find((c) => c.id === 'clip_a')!
    expect(v.linkId).toBe('link_abc')
    expect(a.linkId).toBe('link_abc')
    expect(a.audioOnly).toBe(true)
    expect(v.audioOnly).toBeUndefined()
    expect(restored.media[0].hasAudio).toBe(true)
  })

  it('omits hasAudio when the asset never probed audio', () => {
    const doc = makeDoc()
    delete doc.media[0].waveformPeaks
    const raw = JSON.parse(JSON.stringify(serializeDoc(doc)))
    expect('hasAudio' in raw.media[0]).toBe(false)
    const { doc: restored } = deserializeDoc(raw)
    expect(restored.media[0].hasAudio).toBeUndefined()
  })
})
