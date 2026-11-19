import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  deserializeDoc,
  parseSerializedDoc,
  projectFileName,
  SerializationError,
  serializeDoc,
  SERIALIZATION_VERSION,
} from '../serialization'
import { recoveredProjectId } from '../project-validation'
import { createClip, createDoc, createMediaAsset, createTextClip } from '../factories'
import { createDefaultTextStyle, createShapeClip, createTrack } from '../factories'
import { createShapeStyle } from '../shapes'
import { fontFamilyForId } from '../fonts'
import { parseCubeLut } from '../lut'

/** An identity cube of the given size, in `.cube` row order (red fastest). */
function identityCubeText(size: number): string {
  const rows = [`LUT_3D_SIZE ${size}`]
  const last = size - 1
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        rows.push(`${(r / last).toFixed(6)} ${(g / last).toFixed(6)} ${(b / last).toFixed(6)}`)
      }
    }
  }
  return rows.join('\n')
}
import {
  FPS_MAX,
  FPS_MIN,
  GAIN_MAX,
  GAIN_MIN,
  MAX_SEQUENCE_DEPTH,
  MAX_TIMELINE_SECONDS,
  PROJECT_MAX_H,
  PROJECT_MAX_W,
  PROJECT_MIN_H,
  PROJECT_MIN_W,
  TRANSITION_MAX,
  TRANSITION_MIN,
  WAVEFORM_BUCKETS,
} from '../constants'

afterEach(() => {
  vi.restoreAllMocks()
})

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
    // Pin the WIRE value, not the constant serializeDoc itself stamps: the
    // round-trip contract is "this text is version 7", and a literal here
    // notices a silent constant change instead of restating it.
    expect(json.version).toBe(8)
    expect(json.project.tracks[0].clips[0].transitionOut).toEqual({
      type: 'crossfade',
      duration: 0.5,
    })
  })
})

describe('keyframeDefaults', () => {
  it('round-trips the defaults map', () => {
    const doc = makeDoc()
    doc.project.keyframeDefaults = { opacity: 'easeIn', volume: 'easeInOut' }
    const { doc: loaded } = deserializeDoc(JSON.parse(JSON.stringify(serializeDoc(doc))))
    expect(loaded.project.keyframeDefaults).toEqual({ opacity: 'easeIn', volume: 'easeInOut' })
  })

  it('an absent field hydrates to nothing, and a v1 doc without it still loads', () => {
    const doc = makeDoc()
    const { doc: loaded } = deserializeDoc(JSON.parse(JSON.stringify(serializeDoc(doc))))
    expect(loaded.project.keyframeDefaults).toBeUndefined()
    expect('keyframeDefaults' in loaded.project).toBe(false)

    const v1 = JSON.parse(JSON.stringify(serializeDoc(doc))) as { version: number }
    v1.version = 1
    expect(deserializeDoc(v1).doc.project.keyframeDefaults).toBeUndefined()
  })

  it('drops unknown property keys and unknown names from a hand-edited file', () => {
    const json = JSON.parse(JSON.stringify(serializeDoc(makeDoc()))) as {
      project: Record<string, unknown>
    }
    json.project.keyframeDefaults = {
      opacity: 'easeIn',
      bogus: 'easeIn',
      volume: 'nope',
      hue: 7,
    }
    const { doc } = deserializeDoc(json)
    expect(doc.project.keyframeDefaults).toEqual({ opacity: 'easeIn' })
  })

  it('an all-invalid map hydrates to nothing at all (no empty object)', () => {
    const json = JSON.parse(JSON.stringify(serializeDoc(makeDoc()))) as {
      project: Record<string, unknown>
    }
    json.project.keyframeDefaults = { bogus: 'nope' }
    const { doc } = deserializeDoc(json)
    expect(doc.project.keyframeDefaults).toBeUndefined()
    expect('keyframeDefaults' in doc.project).toBe(false)
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

  it('round-trips a dip-to-black transition', () => {
    const data = JSON.parse(JSON.stringify(serializeDoc(makeDoc())))
    data.project.tracks[0].clips[0].transitionOut = { type: 'dipToBlack', duration: 0.5 }
    const { doc } = deserializeDoc(data)
    expect(doc.project.tracks[0].clips[0].transitionOut).toEqual({
      type: 'dipToBlack',
      duration: 0.5,
    })
  })

  it('falls back to crossfade for unknown transition types', () => {
    const data = JSON.parse(JSON.stringify(serializeDoc(makeDoc())))
    data.project.tracks[0].clips[0].transitionOut = { type: 'spinWipe', duration: 1 }
    const { doc } = deserializeDoc(data)
    expect(doc.project.tracks[0].clips[0].transitionOut).toEqual({
      type: 'crossfade',
      duration: 1,
    })
  })

  it('keeps known transition direction, edge and feather on load', () => {
    const data = JSON.parse(JSON.stringify(serializeDoc(makeDoc())))
    data.project.tracks[0].clips[0].transitionOut = {
      type: 'wipe',
      duration: 1,
      direction: 'right',
      edge: 'feathered',
      feather: 0.25,
    }
    const { doc } = deserializeDoc(data)
    expect(doc.project.tracks[0].clips[0].transitionOut).toEqual({
      type: 'wipe',
      duration: 1,
      direction: 'right',
      edge: 'feathered',
      feather: 0.25,
    })
  })

  it('drops unknown direction and edge values so readers default them', () => {
    const data = JSON.parse(JSON.stringify(serializeDoc(makeDoc())))
    data.project.tracks[0].clips[0].transitionOut = {
      type: 'wipe',
      duration: 1,
      direction: 'diagonal',
      edge: 'dotted',
    }
    const { doc } = deserializeDoc(data)
    expect(doc.project.tracks[0].clips[0].transitionOut).toEqual({
      type: 'wipe',
      duration: 1,
    })
  })

  it('pins hostile feather values to exact outcomes', () => {
    const data = JSON.parse(JSON.stringify(serializeDoc(makeDoc())))
    const load = (feather: unknown) => {
      const d = JSON.parse(JSON.stringify(data))
      d.project.tracks[0].clips[0].transitionOut = { type: 'wipe', duration: 1, feather }
      return deserializeDoc(d).doc.project.tracks[0].clips[0].transitionOut?.feather
    }
    expect(load('huge')).toBe(0.1)
    expect(load(-1)).toBe(0)
    expect(load(2)).toBe(0.5)
    // NaN cannot ride JSON (it stringifies to null), so it goes in direct.
    const nanData = serializeDoc(makeDoc())
    nanData.project.tracks[0].clips[0].transitionOut = { type: 'wipe', duration: 1, feather: NaN }
    expect(deserializeDoc(nanData).doc.project.tracks[0].clips[0].transitionOut?.feather).toBe(0.1)
  })

  it('loads a v4 file without the new transition keys with those keys absent', () => {
    const data = JSON.parse(JSON.stringify(serializeDoc(makeDoc())))
    data.project.tracks[0].clips[0].transitionOut = { type: 'wipe', duration: 1 }
    const { doc } = deserializeDoc(data)
    expect(doc.project.tracks[0].clips[0].transitionOut).toEqual({
      type: 'wipe',
      duration: 1,
    })
  })

  it('clamps hostile fps and dimensions to the command-layer bounds', () => {
    const { doc } = deserializeDoc({
      version: 1,
      project: {
        fps: 1e308,
        width: 100000,
        height: 50000,
        tracks: [{ kind: 'video', clips: [] }],
      },
    })
    // The same clamp `setProjectSettings` applies: a file can never install a
    // value the UI could not set (a huge fps makes the export frame count
    // Infinity, which hangs the render loop).
    expect(doc.project.fps).toBe(FPS_MAX)
    expect(doc.project.width).toBe(PROJECT_MAX_W)
    expect(doc.project.height).toBe(PROJECT_MAX_H)

    // Values below the bounds clamp too, and non-finite junk falls back.
    const low = deserializeDoc({
      version: 1,
      project: { fps: 0, width: 8, height: 8, tracks: [{ kind: 'video', clips: [] }] },
    }).doc.project
    expect(low.fps).toBe(FPS_MIN)
    expect(low.width).toBe(PROJECT_MIN_W)
    expect(low.height).toBe(PROJECT_MIN_H)
    const junk = deserializeDoc({
      version: 1,
      project: { fps: 'x', tracks: [{ kind: 'video', clips: [] }] },
    }).doc.project
    expect(junk.fps).toBe(30)
  })

  it('survives partial/corrupt payloads with defaults', () => {
    const { doc } = deserializeDoc({
      version: 1,
      project: {
        tracks: [
          {
            kind: 'text',
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

  it('hydrates track mute only from an explicit true, like solo and lock', () => {
    const hydrate = (muted: unknown) =>
      deserializeDoc({
        version: 1,
        project: { tracks: [{ kind: 'video', muted, clips: [] }] },
      }).doc.project.tracks[0].muted

    expect(hydrate(true)).toBe(true)
    expect(hydrate(false)).toBe(false)
    expect(hydrate(undefined)).toBe(false)
    // Hostile values used to coerce to true through `!!`.
    expect(hydrate('yes')).toBe(false)
    expect(hydrate(2)).toBe(false)
  })

  it('hydrates autoName from the flag, the name pattern, and hostile values (0.18.0)', () => {
    const hydrate = (track: Record<string, unknown>) =>
      deserializeDoc({
        version: 1,
        project: { tracks: [{ kind: 'audio', ...track, clips: [] }] },
      }).doc.project.tracks[0]

    // Legacy auto name with no flag: classified as auto (flag omitted).
    expect(hydrate({ name: 'A2' }).autoName).toBeUndefined()
    // Legacy custom name: pinned as custom so a later save keeps it.
    expect(hydrate({ name: 'Music' }).autoName).toBe(false)
    // Explicit false wins even when the name matches the auto pattern.
    expect(hydrate({ name: 'A2', autoName: false }).autoName).toBe(false)
    // A non-boolean flag is ignored; the name decides.
    expect(hydrate({ name: 'A2', autoName: 'false' }).autoName).toBeUndefined()
    expect(hydrate({ name: 'Music', autoName: true }).autoName).toBe(false)
    // Names are trimmed at the trust boundary.
    expect(hydrate({ name: '  Music  ' }).name).toBe('Music')
    expect(hydrate({ name: '   ' }).name).toBe('Track')
  })

  it('round-trips an explicit custom name that matches the auto pattern', () => {
    const doc = createDoc()
    doc.project.tracks[0].autoName = false
    doc.project.tracks[0].name = 'A2'
    const restored = deserializeDoc(JSON.parse(JSON.stringify(serializeDoc(doc)))).doc
    expect(restored.project.tracks[0].autoName).toBe(false)
    expect(restored.project.tracks[0].name).toBe('A2')
  })

  it('drops a foreign timeScale curve on picture-less clips, keeps the picture half', () => {
    // A hand-edited or imported file can put a timeScale curve on a clip that
    // carries no picture (the A/V twin or a clip of an audio asset). The
    // engines then drop the whole link group's audio while the UI hides every
    // row that could clear the curve, so hydration must not admit it. The
    // picture half of a pair keeps its curve: remapping is picture-only, so a
    // fix that dropped EVERY clip's curve would fail the first assertion.
    const curve = [{ time: 1, value: 2, interpolation: 'linear' }]
    const data = {
      version: 1,
      project: {
        fps: 30,
        tracks: [
          {
            kind: 'video',
            clips: [
              { id: 'cv', mediaId: 'mv', start: 0, duration: 4, keyframes: { timeScale: curve } },
            ],
          },
          {
            kind: 'audio',
            clips: [
              {
                id: 'ct',
                mediaId: 'mv',
                audioOnly: true,
                start: 0,
                duration: 4,
                keyframes: { timeScale: curve },
              },
              { id: 'ca', mediaId: 'ma', start: 0, duration: 4, keyframes: { timeScale: curve } },
            ],
          },
        ],
      },
      media: [
        { id: 'mv', name: 'v.mp4', kind: 'video', duration: 10 },
        { id: 'ma', name: 'a.mp3', kind: 'audio', duration: 10 },
      ],
    }
    const { doc } = deserializeDoc(JSON.parse(JSON.stringify(data)))
    const video = doc.project.tracks[0].clips[0]
    const twin = doc.project.tracks[1].clips[0]
    const audio = doc.project.tracks[1].clips[1]
    // The picture half keeps its curve (and a clean round-trip stays exact).
    expect(video.keyframes?.timeScale).toEqual(curve)
    // The twin: audioOnly === true, dropped.
    expect(twin.keyframes).toBeUndefined()
    // The audio-asset clip carries no audioOnly flag but resolves to audio:
    // also picture-less, also dropped.
    expect(audio.keyframes).toBeUndefined()
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

  it('clamps a hostile clip font size at hydration', () => {
    // The preset path already clamps; the clip path used to accept any finite
    // number, which reaches ctx.font and the shadow math.
    const doc = createDoc()
    doc.project.tracks[0].kind = 'text'
    doc.project.tracks[0].clips = [
      createTextClip({ id: 't_big', start: 0, style: { fontSize: 1e9 } } as never),
      createTextClip({ id: 't_small', start: 10, style: { fontSize: -50 } } as never),
    ]
    const { doc: restored } = deserializeDoc(JSON.parse(JSON.stringify(serializeDoc(doc))))
    expect(restored.project.tracks[0].clips.map((clip) => clip.style?.fontSize)).toEqual([400, 8])
  })
})

describe('trust-boundary validation', () => {
  it('keeps a JPEG data thumbnail and drops an external one', () => {
    const data = {
      version: 1,
      project: { tracks: [{ kind: 'video', clips: [] }] },
      media: [
        {
          id: 'good',
          kind: 'video',
          name: 'good.mp4',
          duration: 10,
          thumbnail: 'data:image/jpeg;base64,AAAA',
        },
        {
          id: 'bad',
          kind: 'video',
          name: 'bad.mp4',
          duration: 10,
          thumbnail: 'https://attacker.example/x.png',
        },
      ],
    }
    const { doc } = deserializeDoc(data)
    expect(doc.media[0].thumbnail).toBe('data:image/jpeg;base64,AAAA')
    expect(doc.media[1].thumbnail).toBeUndefined()
  })

  it('keeps a valid waveform and drops a wrong-length or hostile one', () => {
    const good = Array.from({ length: WAVEFORM_BUCKETS }, () => 0.5)
    const data = {
      version: 1,
      project: { tracks: [{ kind: 'audio', clips: [] }] },
      media: [
        { id: 'good', kind: 'audio', name: 'good.mp3', duration: 10, waveformPeaks: good },
        { id: 'short', kind: 'audio', name: 'short.mp3', duration: 10, waveformPeaks: [0.5] },
        {
          id: 'hole',
          kind: 'audio',
          name: 'hole.mp3',
          duration: 10,
          waveformPeaks: good.map((value, i) => (i === 3 ? undefined : value)),
        },
        {
          id: 'wild',
          kind: 'audio',
          name: 'wild.mp3',
          duration: 10,
          waveformPeaks: good.map((value, i) => (i === 3 ? 2 : value)),
        },
      ],
    }
    const { doc } = deserializeDoc(data)
    expect(doc.media[0].waveformPeaks).toEqual(good)
    expect(doc.media[1].waveformPeaks).toBeUndefined()
    expect(doc.media[2].waveformPeaks).toBeUndefined()
    expect(doc.media[3].waveformPeaks).toBeUndefined()
  })

  it('clamps a finite gain and drops a non-finite one', () => {
    const load = (gain: unknown) =>
      deserializeDoc({
        version: 1,
        project: {
          tracks: [{ kind: 'video', clips: [{ id: 'c1', mediaId: 'm1', gain }] }],
        },
        media: [{ id: 'm1', kind: 'video', duration: 10 }],
      }).doc.project.tracks[0].clips[0]
    expect(load(-5).gain).toBe(GAIN_MIN)
    expect(load(9).gain).toBe(GAIN_MAX)
    expect(load(0.5).gain).toBe(0.5)
    expect(load(1).gain).toBe(1)
    expect(load(Infinity).gain).toBeUndefined()
  })

  it('clamps a finite transition duration and drops a non-finite one', () => {
    const load = (duration: unknown) =>
      deserializeDoc({
        version: 1,
        project: {
          tracks: [
            {
              kind: 'video',
              clips: [{ id: 'c1', transitionOut: { type: 'wipe', duration } }],
            },
          ],
        },
      }).doc.project.tracks[0].clips[0].transitionOut
    expect(load(100)?.duration).toBe(TRANSITION_MAX)
    expect(load(0.05)?.duration).toBe(TRANSITION_MIN)
    expect(load(0.5)?.duration).toBe(0.5)
    expect(load(Infinity)).toBeUndefined()
    expect(load(0)).toBeUndefined()
  })

  it('clamps a known asset inPoint to the asset duration', () => {
    const { doc } = deserializeDoc({
      version: 1,
      project: {
        tracks: [{ kind: 'video', clips: [{ id: 'c1', mediaId: 'm1', inPoint: 1e308 }] }],
      },
      media: [{ id: 'm1', kind: 'video', duration: 10 }],
    })
    expect(doc.project.tracks[0].clips[0].inPoint).toBe(10)
  })
})

describe('timeline cap migration', () => {
  const clip = (overrides: Record<string, unknown>) => ({
    id: `clip_${String(overrides.id ?? 'x')}`,
    start: 0,
    duration: 1,
    ...overrides,
  })
  const load = (clips: Record<string, unknown>[], markers?: Record<string, unknown>[]) =>
    deserializeDoc({
      version: 1,
      project: { tracks: [{ kind: 'video', clips }], ...(markers ? { markers } : {}) },
    })

  it('clamps a legacy 30-hour clip to the cap and warns once', () => {
    const { doc, warnings } = load([clip({ id: 'long', start: 0, duration: 30 * 3600 })])
    expect(doc.project.tracks[0].clips).toHaveLength(1)
    expect(doc.project.tracks[0].clips[0].duration).toBe(MAX_TIMELINE_SECONDS)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('24-hour')
    expect(warnings[0]).toContain('1 clip')
  })

  it('clamps a finite over-cap end when the clip starts before the cap', () => {
    const { doc, warnings } = load([
      clip({ id: 'near', start: MAX_TIMELINE_SECONDS - 100, duration: 1000 }),
    ])
    expect(doc.project.tracks[0].clips[0].duration).toBe(100)
    expect(doc.project.tracks[0].clips[0].start).toBe(MAX_TIMELINE_SECONDS - 100)
    expect(warnings).toHaveLength(1)
  })

  it('drops a clip that starts at or past the cap and keeps the rest', () => {
    const { doc, warnings } = load([
      clip({ id: 'past', start: MAX_TIMELINE_SECONDS + 1, duration: 10 }),
      clip({ id: 'ok', start: 1, duration: 2 }),
    ])
    expect(doc.project.tracks[0].clips.map((c) => c.id)).toEqual(['ok'])
    expect(warnings).toEqual([expect.stringContaining('Dropped 1 clip')])
  })

  it('drops a non-finite end from overflow instead of retaining it uncapped', () => {
    const { doc, warnings } = load([clip({ id: 'overflow', start: 1e308, duration: 1e308 })])
    expect(doc.project.tracks[0].clips).toHaveLength(0)
    expect(warnings).toEqual([expect.stringContaining('overflowed')])
  })

  it('drops markers above the cap in both scopes with a warning', () => {
    const data = {
      version: 1,
      project: {
        tracks: [
          {
            kind: 'video',
            clips: [
              {
                id: 'c1',
                start: 0,
                duration: 1,
                markers: [
                  { id: 'clip_in', time: 1 },
                  { id: 'clip_out', time: MAX_TIMELINE_SECONDS + 1 },
                ],
              },
            ],
          },
        ],
        markers: [
          { id: 'project_in', time: 1 },
          { id: 'project_out', time: MAX_TIMELINE_SECONDS + 1 },
        ],
      },
    }
    const { doc, warnings } = deserializeDoc(data)
    expect(doc.project.markers?.map((m) => m.id)).toEqual(['project_in'])
    expect(doc.project.tracks[0].clips[0].markers?.map((m) => m.id)).toEqual(['clip_in'])
    expect(warnings).toEqual([expect.stringContaining('Dropped 2 markers')])
  })

  it('leaves a normal project with an empty warning list', () => {
    const { warnings } = load([clip({ id: 'ok', start: 0, duration: 2 })])
    expect(warnings).toEqual([])
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

describe('clip transform serialization (0.24.0)', () => {
  it('loads a v5 fixture with neutral rotation and flips', () => {
    const data = JSON.parse(JSON.stringify(serializeDoc(makeDoc())))
    data.version = 5
    delete data.project.tracks[0].clips[0].rotation
    delete data.project.tracks[0].clips[0].flipX
    delete data.project.tracks[0].clips[0].flipY
    const { doc } = deserializeDoc(data)
    const clip = doc.project.tracks[0].clips[0]
    expect(clip.rotation).toBeUndefined()
    expect(clip.flipX).toBeUndefined()
    expect(clip.flipY).toBeUndefined()
  })

  it('round-trips rotation, both flips, and a rotation curve', () => {
    const doc = makeDoc()
    const clip = doc.project.tracks[0].clips[0]
    clip.rotation = 725
    clip.flipX = true
    clip.flipY = true
    clip.keyframes = {
      rotation: [
        { time: 0, value: 0, interpolation: 'linear' },
        { time: 2, value: 180, interpolation: 'easeIn' },
      ],
    }
    const { doc: restored } = deserializeDoc(JSON.parse(JSON.stringify(serializeDoc(doc))))
    const loaded = restored.project.tracks[0].clips[0]
    expect(loaded.rotation).toBe(725)
    expect(loaded.flipX).toBe(true)
    expect(loaded.flipY).toBe(true)
    expect(loaded.keyframes?.rotation).toEqual([
      { time: 0, value: 0, interpolation: 'linear' },
      { time: 2, value: 180, interpolation: 'easeIn' },
    ])
  })

  it('sanitizes hostile rotation and flip values', () => {
    const data = JSON.parse(JSON.stringify(serializeDoc(makeDoc())))
    const clip = data.project.tracks[0].clips[0]
    clip.rotation = 10000
    clip.flipX = 1
    clip.flipY = 'yes'
    const { doc } = deserializeDoc(data)
    // Out of range clamps to ten turns; truthy non-booleans are not flips.
    expect(doc.project.tracks[0].clips[0].rotation).toBe(3600)
    expect(doc.project.tracks[0].clips[0].flipX).toBeUndefined()
    expect(doc.project.tracks[0].clips[0].flipY).toBeUndefined()

    clip.rotation = '45'
    const { doc: doc2 } = deserializeDoc(data)
    expect(doc2.project.tracks[0].clips[0].rotation).toBeUndefined()

    clip.rotation = Number.POSITIVE_INFINITY
    const { doc: doc3 } = deserializeDoc(data)
    expect(doc3.project.tracks[0].clips[0].rotation).toBeUndefined()
  })

  it('drops a rotation value in animStatics, which is not its static source', () => {
    const data = JSON.parse(JSON.stringify(serializeDoc(makeDoc())))
    data.project.tracks[0].clips[0].animStatics = { rotation: 90 }
    const { doc } = deserializeDoc(data)
    expect(doc.project.tracks[0].clips[0].animStatics).toBeUndefined()
  })
})

describe('marker serialization (0.5.5)', () => {
  function docWithMarkers() {
    const doc = makeDoc()
    doc.project.markers = [
      { id: 'm_seq', time: 1.5, name: 'Cue', color: 'red', notes: 'fix audio' },
      { id: 'm_plain', time: 4 },
    ]
    doc.project.tracks[0].clips[0].markers = [
      { id: 'm_clip', time: 2.25, name: 'Beat' },
      // green is the default and must collapse to an absent field
      { id: 'm_green', time: 3, color: 'green' },
    ]
    return doc
  }

  it('round-trips sequence and clip markers with their fields', () => {
    const { doc: restored } = deserializeDoc(
      JSON.parse(JSON.stringify(serializeDoc(docWithMarkers()))),
    )
    expect(restored.project.markers).toEqual([
      { id: 'm_seq', time: 1.5, name: 'Cue', color: 'red', notes: 'fix audio' },
      { id: 'm_plain', time: 4 },
    ])
    const clip = restored.project.tracks[0].clips[0]
    expect(clip.markers).toEqual([
      { id: 'm_clip', time: 2.25, name: 'Beat' },
      { id: 'm_green', time: 3 },
    ])
  })

  it('loads v1 files with no markers attached', () => {
    const v1 = {
      version: 1,
      project: {
        tracks: [{ kind: 'video', clips: [{ id: 'c1', start: 0, duration: 1, inPoint: 0 }] }],
      },
    }
    const { doc } = deserializeDoc(v1)
    expect(doc.project.markers).toBeUndefined()
    expect(doc.project.tracks[0].clips[0].markers).toBeUndefined()
  })

  it('drops malformed markers and invalid colors, dedupes ids per scope', () => {
    const v2 = {
      version: SERIALIZATION_VERSION,
      project: {
        markers: [
          { id: 'm1', time: 1 },
          { id: 'm1', time: 2 },
          { id: 'm2', time: -1 },
          { id: 'm3', time: 'x' },
          { id: 'm4', time: 3, color: 'chartreuse', name: '  spaced  ' },
          null,
        ],
        tracks: [
          {
            kind: 'video',
            clips: [{ id: 'c1', start: 0, duration: 1, inPoint: 0, markers: 'nope' }],
          },
        ],
      },
    }
    const { doc } = deserializeDoc(v2)
    expect(doc.project.markers).toEqual([
      { id: 'm1', time: 1 },
      { id: 'm4', time: 3, name: 'spaced' },
    ])
    expect(doc.project.tracks[0].clips[0].markers).toBeUndefined()
  })

  it('collapses empty marker arrays to absent on load', () => {
    const { doc } = deserializeDoc({
      version: SERIALIZATION_VERSION,
      project: { markers: [], tracks: [{ kind: 'video', clips: [] }] },
    })
    expect(doc.project.markers).toBeUndefined()
  })

  it('refuses files from a newer app version', () => {
    expect(() => deserializeDoc({ version: SERIALIZATION_VERSION + 1 })).toThrow(SerializationError)
  })

  it('drops preset ids reserved by built-ins and trims loaded names', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { doc } = deserializeDoc({
      version: SERIALIZATION_VERSION,
      project: {
        textPresets: [
          { id: 'preset_builtin_title', name: 'Shadow', style: {} },
          { id: 'preset_user_1', name: '  Opener  ', style: {} },
          { id: 'preset_user_2', name: 'opener', style: {} },
          { id: 'preset_user_3', name: '   ', style: {} },
          { id: 'preset_user_4', name: ' Title ', style: {} },
        ],
        tracks: [{ kind: 'video', clips: [] }],
      },
    })
    // The built-in id is dropped, the survivor is trimmed, and the
    // post-trim duplicate and the blank name are dropped with one warning.
    expect(doc.project.textPresets?.map((p) => p.id)).toEqual(['preset_user_1'])
    expect(doc.project.textPresets?.[0].name).toBe('Opener')
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('clamps finite out-of-range preset style values to the UI bounds', () => {
    const { doc } = deserializeDoc({
      version: SERIALIZATION_VERSION,
      project: {
        textPresets: [
          {
            id: 'preset_user_1',
            name: 'Wild',
            style: { fontSize: -1e300, x: 5, y: -2 },
          },
        ],
        tracks: [{ kind: 'video', clips: [] }],
      },
    })
    // The entry is kept (every value was finite), but font size and
    // position collapse into the ranges the Inspector itself enforces.
    expect(doc.project.textPresets?.[0].style.fontSize).toBe(8)
    expect(doc.project.textPresets?.[0].style.x).toBe(1)
    expect(doc.project.textPresets?.[0].style.y).toBe(0)
  })

  it('round-trips the title preset library', () => {
    const doc = makeDoc()
    doc.project.textPresets = [
      {
        id: 'preset_user_1',
        name: 'Opener',
        style: {
          fontSize: 96,
          color: '#ff0000',
          fontFamily: 'Arial, sans-serif',
          bold: true,
          italic: false,
          align: 'left',
          x: 0.1,
          y: 0.2,
          shadow: false,
        },
      },
    ]
    const json = serializeDoc(doc)
    expect(json.version).toBe(8)
    expect(json.project.textPresets).toEqual(doc.project.textPresets)
    const back = deserializeDoc(json)
    expect(back.doc.project.textPresets).toEqual(doc.project.textPresets)
  })

  it('reads a file without title presets as an empty user list', () => {
    const v1 = { version: 1, project: { tracks: [{ kind: 'video', clips: [] }] } }
    expect(deserializeDoc(v1).doc.project.textPresets).toBeUndefined()
  })

  it('falls corrupt preset fields back per-field and drops broken entries once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const good = {
      id: 'preset_ok',
      name: 'ok',
      style: {
        fontSize: 96,
        color: '#ff0000',
        fontFamily: 'Arial, sans-serif',
        bold: true,
        italic: false,
        align: 'left',
        x: 0.1,
        y: 0.2,
        shadow: false,
      },
    }
    const { doc } = deserializeDoc({
      version: SERIALIZATION_VERSION,
      project: {
        textPresets: [
          null,
          'nope',
          { id: '', name: 'no id' },
          { id: 'preset_noname' },
          { ...good, id: 'preset_dup', name: 'dup' },
          { ...good, id: 'preset_dup', name: 'dup' },
          {
            id: 'preset_partial',
            name: 'partial',
            style: { fontSize: 'huge', align: 'justify', bold: 'yes', x: Number.NaN },
          },
          good,
        ],
        tracks: [{ kind: 'video', clips: [] }],
      },
    })
    expect(doc.project.textPresets?.map((p) => p.id)).toEqual([
      'preset_dup',
      'preset_partial',
      'preset_ok',
    ])
    // Corrupt fields fall back per-field and the entry is kept.
    expect(doc.project.textPresets?.[1].style).toEqual({
      fontSize: 64,
      color: '#ffffff',
      fontFamily: 'Arial, sans-serif',
      bold: true,
      italic: false,
      align: 'center',
      x: 0.5,
      y: 0.5,
      shadow: true,
    })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toMatch(/dropped a broken title preset entry/)
  })

  it('round-trips the LUT library and the clips that reference it', () => {
    const lut = parseCubeLut(identityCubeText(2), { id: 'lut_fixed', name: 'Identity' })
    const doc = makeDoc()
    doc.project.luts = [lut]
    doc.project.tracks[0].clips[0].lutId = 'lut_fixed'
    const json = serializeDoc(doc)
    expect(json.version).toBe(8)
    expect(json.project.luts).toEqual([lut])
    const back = deserializeDoc(json)
    expect(back.doc.project.luts).toEqual([lut])
    expect(back.doc.project.tracks[0].clips[0].lutId).toBe('lut_fixed')
  })

  it('drops malformed LUT entries without throwing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const good = parseCubeLut(identityCubeText(2), { id: 'lut_ok', name: 'ok' })
    const { doc } = deserializeDoc({
      version: SERIALIZATION_VERSION,
      project: {
        luts: [
          null,
          'nope',
          { id: 'lut_ok' }, // no kind/size/data
          { ...good, id: '' },
          { ...good, kind: 'weird' },
          { ...good, size: 3 }, // grid does not decode to size^3*3
          { ...good, data: 'not base64!' },
          { ...good, data: 'AAAA' }, // decodes, but to the wrong length
          { ...good, id: 'lut_dup' },
          { ...good, id: 'lut_dup' },
          good,
        ],
        tracks: [{ kind: 'video', clips: [] }],
      },
    })
    expect(doc.project.luts?.map((l) => l.id)).toEqual(['lut_dup', 'lut_ok'])
    expect(doc.project.luts?.[0]).toEqual({ ...good, id: 'lut_dup' })
    // The drops are reported once for the whole load, naming the count.
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toMatch(/dropped 9 LUT library entries/)
  })

  it('drops an oversized LUT payload instead of trusting it', () => {
    // A hand-edited file could otherwise inject a multi-megabyte string that
    // every render pass would try to decode. The drop is reported, not silent.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { doc } = deserializeDoc({
      version: SERIALIZATION_VERSION,
      project: {
        luts: [{ id: 'huge', name: 'huge', kind: '3d', size: 2, data: 'A'.repeat(3_000_001) }],
        tracks: [{ kind: 'video', clips: [] }],
      },
    })
    expect(doc.project.luts).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toMatch(/dropped 1 LUT library entry/)
  })

  it('counts every dropped entry in one warning and stays silent on a clean load', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const good = parseCubeLut(identityCubeText(2), { id: 'lut_ok', name: 'ok' })
    const { doc } = deserializeDoc({
      version: SERIALIZATION_VERSION,
      project: {
        luts: [
          { id: 'huge', name: 'huge', kind: '3d', size: 2, data: 'A'.repeat(3_000_001) },
          { ...good, id: '' },
          good,
        ],
        tracks: [{ kind: 'video', clips: [] }],
      },
    })
    expect(doc.project.luts?.map((l) => l.id)).toEqual(['lut_ok'])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toMatch(/dropped 2 LUT library entries/)

    // One warning per load, and a load with nothing dropped is silent.
    deserializeDoc({
      version: SERIALIZATION_VERSION,
      project: { luts: [good], tracks: [{ kind: 'video', clips: [] }] },
    })
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('hydrates a dangling clip lutId to nothing and loads tables-less docs', () => {
    const withId = (lutId: unknown) => ({
      version: SERIALIZATION_VERSION,
      project: {
        tracks: [
          { kind: 'video', clips: [{ id: 'c1', start: 0, duration: 1, inPoint: 0, lutId }] },
        ],
      },
    })
    expect(
      deserializeDoc(withId('lut_missing')).doc.project.tracks[0].clips[0].lutId,
    ).toBeUndefined()
    expect(deserializeDoc(withId(42)).doc.project.tracks[0].clips[0].lutId).toBeUndefined()
    expect(deserializeDoc(withId(undefined)).doc.project.luts).toBeUndefined()
    // A v1/v2 file has no field at all and must keep loading untouched.
    const v1 = { version: 1, project: { tracks: [{ kind: 'video', clips: [] }] } }
    expect(deserializeDoc(v1).doc.project.luts).toBeUndefined()
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

  it('round-trips the 0.5.0 re-timing, shaping and keyframe fields', () => {
    const doc = makeDoc()
    const track = doc.project.tracks.find((t) => t.kind === 'video')!
    track.clips[0] = {
      ...track.clips[0],
      speed: 2,
      reverse: true,
      temperature: 35,
      tint: -12,
      pan: -0.4,
      eq: { low: 3, mid: -6, high: 1.5 },
      compressor: true,
      denoise: true,
      animStatics: { scale: 1.25, positionX: 40 },
      keyframes: {
        volume: [
          { time: 0, value: 1 },
          { time: 1.5, value: 0.2 },
        ],
      },
    }

    const { doc: restored } = deserializeDoc(JSON.parse(JSON.stringify(serializeDoc(doc))))
    const clip = restored.project.tracks.flatMap((t) => t.clips).find((c) => c.id === 'clip_fixed')!
    expect(clip.speed).toBe(2)
    expect(clip.reverse).toBe(true)
    expect(clip.temperature).toBe(35)
    expect(clip.tint).toBe(-12)
    expect(clip.pan).toBe(-0.4)
    expect(clip.eq).toEqual({ low: 3, mid: -6, high: 1.5 })
    expect(clip.compressor).toBe(true)
    expect(clip.denoise).toBe(true)
    expect(clip.animStatics).toEqual({ scale: 1.25, positionX: 40 })
    expect(clip.keyframes?.volume).toEqual([
      { time: 0, value: 1, interpolation: 'linear' },
      { time: 1.5, value: 0.2, interpolation: 'linear' },
    ])
  })

  it('drops neutral shaping values and clamps out-of-range ones on load', () => {
    const doc = makeDoc()
    const track = doc.project.tracks.find((t) => t.kind === 'video')!
    track.clips[0] = {
      ...track.clips[0],
      speed: 1,
      pan: 0,
      eq: { low: 0, mid: 0, high: 0 },
      animStatics: { scale: 1 },
    }
    const json = JSON.parse(JSON.stringify(serializeDoc(doc))) as {
      project: { tracks: { clips: Record<string, unknown>[] }[] }
    }
    const saved = json.project.tracks.flatMap((t) => t.clips)[0]
    // Out-of-range values are clamped into the property's bounds, never rejected.
    saved.speed = 99
    saved.pan = 5
    saved.eq = { low: 100, mid: -100, high: 0 }
    saved.keyframes = { volume: [{ time: 0, value: 999 }], bogus: [{ time: 0, value: 1 }] }
    saved.temperature = 400
    saved.tint = -400
    // A truthy non-boolean is not a switch: the flag is dropped, not coerced.
    saved.denoise = 'yes'

    const { doc: restored } = deserializeDoc(json)
    const clip = restored.project.tracks.flatMap((t) => t.clips).find((c) => c.id === 'clip_fixed')!
    expect(clip.speed).toBe(4)
    // The grade clamps into its documented bounds too.
    expect(clip.temperature).toBe(100)
    expect(clip.tint).toBe(-100)
    expect(clip.pan).toBe(1)
    expect(clip.eq).toEqual({ low: 24, mid: -24, high: 0 })
    expect(clip.denoise).toBeUndefined()
    expect(clip.animStatics).toBeUndefined()
    expect(clip.keyframes?.volume).toEqual([{ time: 0, value: 2, interpolation: 'linear' }])
    expect(Object.keys(clip.keyframes ?? {})).toEqual(['volume'])
  })

  it('round-trips the exact easeOut quad and drops a malformed one', () => {
    // The subdivided bezier data (see ease-segment.ts) must survive save/load:
    // losing it would silently re-approximate every split curve on reopen.
    const doc = makeDoc()
    const track = doc.project.tracks.find((t) => t.kind === 'video')!
    track.clips[0] = {
      ...track.clips[0],
      keyframes: {
        opacity: [
          { time: 0, value: 1, interpolation: 'easeInOut', easeOut: [0.31, 0.05, 0.67, 0.44] },
          { time: 2, value: 0.2, interpolation: 'linear', easeOut: [1.5, 0, 0.5, 2] as never },
        ],
      },
    }
    const json = JSON.parse(JSON.stringify(serializeDoc(doc))) as {
      project: { tracks: { clips: Record<string, unknown>[] }[] }
    }
    const raw = (
      json.project.tracks.flatMap((t) => t.clips)[0].keyframes as {
        opacity: { easeOut?: number[] }[]
      }
    ).opacity
    // A valid quad rides along on the save side.
    expect(raw[0].easeOut).toEqual([0.31, 0.05, 0.67, 0.44])

    const { doc: restored } = deserializeDoc(json)
    const clip = restored.project.tracks.flatMap((t) => t.clips).find((c) => c.id === 'clip_fixed')!
    const kfs = clip.keyframes!.opacity!
    // The valid quad survives the round-trip; the malformed one is dropped
    // (the segment then reads through the preset name, which is linear here).
    expect(kfs[0].easeOut).toEqual([0.31, 0.05, 0.67, 0.44])
    expect(kfs[1].easeOut).toBeUndefined()
  })

  it('round-trips eased keyframe interpolation and falls back on unknown names', () => {
    const doc = makeDoc()
    const track = doc.project.tracks.find((t) => t.kind === 'video')!
    track.clips[0] = {
      ...track.clips[0],
      keyframes: {
        opacity: [
          { time: 0, value: 1, interpolation: 'easeInOut' },
          { time: 2, value: 0.2, interpolation: 'easeOut' },
        ],
      },
    }
    const json = JSON.parse(JSON.stringify(serializeDoc(doc))) as {
      project: { tracks: { clips: Record<string, unknown>[] }[] }
    }
    // The save side keeps the field, so easing is not silently lost on save.
    expect(json.project.tracks.flatMap((t) => t.clips)[0].keyframes).toEqual({
      opacity: [
        { time: 0, value: 1, interpolation: 'easeInOut' },
        { time: 2, value: 0.2, interpolation: 'easeOut' },
      ],
    })

    const { doc: restored } = deserializeDoc(json)
    const clip = restored.project.tracks.flatMap((t) => t.clips).find((c) => c.id === 'clip_fixed')!
    expect(clip.keyframes?.opacity).toEqual([
      { time: 0, value: 1, interpolation: 'easeInOut' },
      { time: 2, value: 0.2, interpolation: 'easeOut' },
    ])

    // A name from a future build must not break the load: it reads as linear.
    const future = JSON.parse(JSON.stringify(serializeDoc(doc))) as typeof json
    future.project.tracks.flatMap((t) => t.clips)[0].keyframes = {
      opacity: [{ time: 0, value: 1, interpolation: 'wobble' }],
    }
    const { doc: futureRestored } = deserializeDoc(future)
    const futureClip = futureRestored.project.tracks
      .flatMap((t) => t.clips)
      .find((c) => c.id === 'clip_fixed')!
    expect(futureClip.keyframes?.opacity).toEqual([{ time: 0, value: 1, interpolation: 'linear' }])
  })

  it('drops an animStatics entry for timeScale (its static source is clip.speed)', () => {
    const doc = makeDoc()
    const track = doc.project.tracks.find((t) => t.kind === 'video')!
    track.clips[0] = { ...track.clips[0], animStatics: { scale: 1.5 } }
    const json = JSON.parse(JSON.stringify(serializeDoc(doc))) as {
      project: { tracks: { clips: Record<string, unknown>[] }[] }
    }
    json.project.tracks.flatMap((t) => t.clips)[0].animStatics = { scale: 1.5, timeScale: 2 }

    const { doc: restored } = deserializeDoc(json)
    const clip = restored.project.tracks.flatMap((t) => t.clips).find((c) => c.id === 'clip_fixed')!
    expect(clip.animStatics).toEqual({ scale: 1.5 })
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

describe('caption flag serialization (0.8.5)', () => {
  const withFlag = (isCaption: unknown) => ({
    version: SERIALIZATION_VERSION,
    project: {
      tracks: [
        {
          kind: 'text',
          clips: [{ id: 'c1', start: 0, duration: 1, text: 'Hi', isCaption }],
        },
      ],
    },
  })

  it('round-trips true and drops anything else', () => {
    expect(deserializeDoc(withFlag(true)).doc.project.tracks[0].clips[0].isCaption).toBe(true)
    expect(deserializeDoc(withFlag(false)).doc.project.tracks[0].clips[0].isCaption).toBeUndefined()
    expect(deserializeDoc(withFlag(1)).doc.project.tracks[0].clips[0].isCaption).toBeUndefined()
    expect(deserializeDoc(withFlag('yes')).doc.project.tracks[0].clips[0].isCaption).toBeUndefined()
    // Absent stays absent: old files read identically.
    const noField = withFlag(undefined)
    delete (noField.project.tracks[0].clips[0] as Record<string, unknown>).isCaption
    expect(deserializeDoc(noField).doc.project.tracks[0].clips[0].isCaption).toBeUndefined()
  })

  it('saves the flag as-is through serializeDoc', () => {
    const doc = makeDoc()
    doc.project.tracks.push({
      id: 'track_cap',
      kind: 'text',
      name: 'Captions',
      clips: [
        createTextClip({ id: 'clip_cap', start: 0, duration: 1, text: 'Hi', isCaption: true }),
      ],
    })
    const { doc: loaded } = deserializeDoc(JSON.parse(JSON.stringify(serializeDoc(doc))))
    expect(loaded.project.tracks.find((t) => t.id === 'track_cap')!.clips[0].isCaption).toBe(true)
  })
})

describe('effects serialization (0.8.6)', () => {
  /** V1 on top, V2 below, one clip on V2. */
  function fxWireDoc() {
    const doc = createDoc()
    const v1 = { ...doc.project.tracks[0], id: 'v1' }
    const v2 = { ...doc.project.tracks[1], id: 'v2', kind: 'video' as const }
    v2.clips = [{ ...createClip({ id: 'clip1' }), duration: 4 }]
    doc.project.tracks = [v1, v2]
    return doc
  }

  it('round-trips effects, blend mode and visibility at v8', () => {
    const doc = fxWireDoc()
    doc.project.tracks[1].clips[0].effects = [
      { id: 'fx_crop', type: 'crop', left: 10, feather: 5 },
      { id: 'fx_blur', type: 'motionBlur', shutter: 90 },
    ]
    doc.project.tracks[1].clips[0].blendMode = 'multiply'
    doc.project.tracks[1].visible = false
    const json = serializeDoc(doc)
    expect(json.version).toBe(8)
    const { doc: loaded } = deserializeDoc(JSON.parse(JSON.stringify(json)))
    expect(loaded.project.tracks[1].clips[0].effects).toEqual([
      { id: 'fx_crop', type: 'crop', left: 10, right: 0, top: 0, bottom: 0, feather: 5 },
      { id: 'fx_blur', type: 'motionBlur', shutter: 90 },
    ])
    expect(loaded.project.tracks[1].clips[0].blendMode).toBe('multiply')
    expect(loaded.project.tracks[1].visible).toBe(false)
    expect(loaded.project.tracks[0].visible).toBeUndefined()
  })

  it('drops unknown effect types and clamps hostile params', () => {
    const doc = fxWireDoc()
    const wire = JSON.parse(JSON.stringify(serializeDoc(doc)))
    wire.project.tracks[1].clips[0].effects = [
      { id: 'fx_bloom', type: 'bloom' },
      { id: 'fx_crop', type: 'crop', left: 500, feather: -20, zoom: 'yes' },
      { id: 'fx_key', type: 'chromaKey', key: 'green' },
      { id: 'fx_blend', type: 'clip', blendMode: 'vividLight' },
    ]
    wire.project.tracks[1].clips[0].blendMode = 'dissolve'
    const { doc: loaded } = deserializeDoc(wire)
    const effects = loaded.project.tracks[1].clips[0].effects ?? []
    expect(effects.map((e) => e.id)).toEqual(['fx_crop'])
    expect(effects[0]).toMatchObject({ left: 100, feather: 0 })
    expect('zoom' in (effects[0] as object)).toBe(false)
    expect(loaded.project.tracks[1].clips[0].blendMode).toBeUndefined()
  })

  it('drops chroma entries with inverted thresholds and trims stored keys', () => {
    const doc = fxWireDoc()
    const wire = JSON.parse(JSON.stringify(serializeDoc(doc)))
    wire.project.tracks[1].clips[0].effects = [
      { id: 'fx inverted', type: 'chromaKey', key: '#00ff00', clipBlack: 0.8, clipWhite: 0.2 },
      { id: 'fx_spaced', type: 'chromaKey', key: '  #ff0000  ' },
    ]
    const { doc: loaded } = deserializeDoc(wire)
    const effects = loaded.project.tracks[1].clips[0].effects ?? []
    expect(effects.map((e) => e.id)).toEqual(['fx_spaced'])
    expect(effects[0]).toMatchObject({ key: '#ff0000' })
  })

  it('regenerates duplicate effect ids within the clip', () => {
    const doc = fxWireDoc()
    const wire = JSON.parse(JSON.stringify(serializeDoc(doc)))
    wire.project.tracks[1].clips[0].effects = [
      { id: 'fx_dup', type: 'crop' },
      { id: 'fx_dup', type: 'motionBlur' },
    ]
    const { doc: loaded } = deserializeDoc(wire)
    const ids = loaded.project.tracks[1].clips[0].effects?.map((e) => e.id) ?? []
    expect(ids).toHaveLength(2)
    expect(ids[0]).toBe('fx_dup')
    expect(ids[1]).not.toBe('fx_dup')
  })

  it('drops matte entries whose track is unknown, elsewhere, or below', () => {
    const doc = fxWireDoc()
    const wire = JSON.parse(JSON.stringify(serializeDoc(doc)))
    wire.project.tracks[1].clips[0].effects = [
      { id: 'fx_good', type: 'trackMatte', trackId: 'v1' },
      { id: 'fx_ghost', type: 'trackMatte', trackId: 'nope' },
      { id: 'fx_below', type: 'trackMatte', trackId: 'v2' },
      { id: 'fx_empty', type: 'trackMatte' },
    ]
    const { doc: loaded } = deserializeDoc(wire)
    expect(loaded.project.tracks[1].clips[0].effects?.map((e) => e.id)).toEqual(['fx_good'])
  })

  it('sanitizes per-effect keyframes and drops foreign curves', () => {
    const doc = fxWireDoc()
    const wire = JSON.parse(JSON.stringify(serializeDoc(doc)))
    wire.project.tracks[1].clips[0].effects = [
      {
        id: 'fx_crop',
        type: 'crop',
        keyframes: {
          left: [
            { time: 0, value: 500 },
            { time: -2, value: 10 },
          ],
          zoom: [{ time: 0, value: 1 }],
        },
      },
    ]
    const { doc: loaded } = deserializeDoc(wire)
    expect(loaded.project.tracks[1].clips[0].effects?.[0].keyframes).toEqual({
      left: [{ time: 0, value: 100, interpolation: 'linear' }],
    })
  })
})

describe('track solo and lock serialization (0.14.0)', () => {
  function flagsDoc() {
    const doc = createDoc()
    const [video, audio] = doc.project.tracks
    video.locked = true
    audio.solo = true
    audio.locked = true
    return doc
  }

  it('round-trips solo and locked at v8 without a schema bump', () => {
    const json = serializeDoc(flagsDoc())
    expect(json.version).toBe(8)
    const { doc } = deserializeDoc(JSON.parse(JSON.stringify(json)))
    expect(doc.project.tracks[0].locked).toBe(true)
    expect(doc.project.tracks[0].solo).toBeUndefined()
    expect(doc.project.tracks[1].solo).toBe(true)
    expect(doc.project.tracks[1].locked).toBe(true)
  })

  it('reads absent flags as false', () => {
    const { doc } = deserializeDoc(JSON.parse(JSON.stringify(serializeDoc(createDoc()))))
    for (const track of doc.project.tracks) {
      expect(track.solo).toBeUndefined()
      expect(track.locked).toBeUndefined()
    }
  })

  it('drops hostile values, and a solo flag on a video or text lane', () => {
    const wire = JSON.parse(JSON.stringify(serializeDoc(createDoc())))
    wire.project.tracks[0].solo = true // video lane: never a valid solo
    wire.project.tracks[0].locked = 'yes'
    wire.project.tracks[1].solo = 1
    wire.project.tracks[1].locked = true
    const extra = {
      id: 't_text',
      kind: 'text',
      name: 'T1',
      solo: true,
      locked: false,
      clips: [],
    }
    wire.project.tracks.push(extra)
    const { doc } = deserializeDoc(wire)
    expect(doc.project.tracks[0].solo).toBeUndefined()
    expect(doc.project.tracks[0].locked).toBeUndefined()
    expect(doc.project.tracks[1].solo).toBeUndefined()
    expect(doc.project.tracks[1].locked).toBe(true)
    expect(doc.project.tracks[2].solo).toBeUndefined()
    expect(doc.project.tracks[2].locked).toBeUndefined()
  })

  it('reads version 1 to 3 files with no flags as false', () => {
    const base = JSON.parse(JSON.stringify(serializeDoc(createDoc())))
    for (const version of [1, 2, 3]) {
      const wire = { ...base, version }
      const { doc } = deserializeDoc(wire)
      for (const track of doc.project.tracks) {
        expect(track.solo, `v${version}`).toBeUndefined()
        expect(track.locked, `v${version}`).toBeUndefined()
      }
    }
  })
})

describe('media content hash serialization (0.23.0)', () => {
  const HASH = 'a'.repeat(64)

  it('round-trips a valid content hash and writes schema version 8', () => {
    const doc = makeDoc()
    doc.media[0].contentHash = HASH
    const wire = serializeDoc(doc)
    expect(wire.version).toBe(8)
    expect(wire.media[0].contentHash).toBe(HASH)
    const { doc: restored } = deserializeDoc(JSON.parse(JSON.stringify(wire)))
    expect(restored.media[0].contentHash).toBe(HASH)
    // Hydration still marks the asset offline until rehydration restores bytes.
    expect(restored.media[0].missing).toBe(true)
  })

  it('loads a v4 asset with no hash as missing and relinkable', () => {
    const wire = JSON.parse(JSON.stringify(serializeDoc(makeDoc())))
    wire.version = 4
    delete wire.media[0].contentHash
    const { doc } = deserializeDoc(wire)
    expect(doc.media[0].contentHash).toBeUndefined()
    expect(doc.media[0].missing).toBe(true)
  })

  it('drops hostile hash values instead of naming a path', () => {
    const base = JSON.parse(JSON.stringify(serializeDoc(makeDoc())))
    const hostile: unknown[] = [
      '../../evil',
      1,
      HASH.toUpperCase(),
      'g'.repeat(64),
      'a'.repeat(65),
      null,
      { hash: HASH },
    ]
    for (const contentHash of hostile) {
      const wire = JSON.parse(JSON.stringify(base))
      wire.media[0].contentHash = contentHash
      const { doc } = deserializeDoc(wire)
      expect(doc.media[0].contentHash, JSON.stringify(contentHash)).toBeUndefined()
      expect(doc.media[0].missing).toBe(true)
    }
  })

  it('never serializes an invalid in-memory hash', () => {
    const doc = makeDoc()
    doc.media[0].contentHash = '../evil'
    expect(serializeDoc(doc).media[0].contentHash).toBeUndefined()
  })
})

describe('fonts and shapes at schema v7 (0.25.0)', () => {
  const FONT_ID = 'font_123e4567-e89b-12d3-a456-426614174000'
  const HASH = 'a'.repeat(64)
  const font = () => ({
    id: FONT_ID,
    name: 'Inter',
    family: fontFamilyForId(FONT_ID),
    contentHash: HASH,
    weight: 700,
    style: 'italic' as const,
  })

  function docWithFontAndShape() {
    const doc = makeDoc()
    doc.project.fonts = [font()]
    const text = createTrack('text', 1, { name: 'T1' })
    text.clips.push(
      createTextClip({
        id: 'clip_text',
        text: 'Title',
        style: { ...createDefaultTextStyle(), fontFamily: font().family },
      }),
    )
    doc.project.tracks.unshift(text)
    const video = doc.project.tracks.find((track) => track.kind === 'video')!
    video.clips.push(
      createShapeClip({
        id: 'clip_shape',
        start: 6,
        duration: 3,
        shape: {
          ...createShapeStyle('star'),
          fill: '#ff0000',
          stroke: '#000000',
          strokeWidth: 8,
          points: 6,
        },
      }),
    )
    return doc
  }

  it('writes version 8 and round-trips a project font and a shape clip', () => {
    const doc = docWithFontAndShape()
    const wire = serializeDoc(doc)
    expect(wire.version).toBe(8)
    expect(wire.project.fonts).toEqual([font()])
    const { doc: loaded } = deserializeDoc(JSON.parse(JSON.stringify(wire)))
    expect(loaded.project.fonts).toEqual([font()])
    const shape = loaded.project.tracks
      .flatMap((track) => track.clips)
      .find((clip) => clip.id === 'clip_shape')
    expect(shape?.shape).toEqual({
      kind: 'star',
      fill: '#ff0000',
      stroke: '#000000',
      strokeWidth: 8,
      points: 6,
    })
    const text = loaded.project.tracks
      .flatMap((track) => track.clips)
      .find((clip) => clip.id === 'clip_text')
    expect(text?.style?.fontFamily).toBe(font().family)
  })

  it('loads a v6 project with no font library and no shapes', () => {
    const doc = makeDoc()
    const wire = serializeDoc(doc) as unknown as Record<string, unknown> & {
      project: Record<string, unknown>
    }
    wire.version = 6
    delete wire.project.fonts
    const { doc: loaded, warnings } = deserializeDoc(wire)
    expect(loaded.project.fonts).toBeUndefined()
    expect(loaded.project.tracks.flatMap((track) => track.clips).some((clip) => clip.shape)).toBe(
      false,
    )
    expect(warnings).toEqual([])
  })

  it('refuses a duplicate font id and drops a hostile family entry', () => {
    const doc = makeDoc()
    const wire = serializeDoc(doc) as unknown as {
      project: Record<string, unknown>
    }
    wire.project.fonts = [font(), font()]
    expect(() => deserializeDoc(wire)).toThrow(SerializationError)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    wire.project.fonts = [
      font(),
      { ...font(), id: 'font_other' },
      { ...font(), family: 'Arial; background: url(x)' },
      { ...font(), contentHash: '../hash' },
    ]
    const { doc: loaded } = deserializeDoc(wire)
    expect(loaded.project.fonts).toEqual([font()])
    expect(warn).toHaveBeenCalledWith('[serialization] dropped a broken project font entry')
  })

  it('refuses generated families that differ only by case (CSS matches them as one)', () => {
    const doc = makeDoc()
    const wire = serializeDoc(doc) as unknown as {
      project: Record<string, unknown>
    }
    const upper = { ...font(), id: 'font_A', family: fontFamilyForId('font_A') }
    const lower = { ...font(), id: 'font_a', family: fontFamilyForId('font_a') }
    expect(upper.family).not.toBe(lower.family)
    wire.project.fonts = [upper, lower]
    expect(() => deserializeDoc(wire)).toThrow(/Duplicate project font/)
  })

  it('drops a malformed shape clip with one warning', () => {
    const doc = makeDoc()
    const video = doc.project.tracks.find((track) => track.kind === 'video')!
    const shape = createShapeClip({ id: 'clip_bad_shape' })
    ;(shape as unknown as { shape: unknown }).shape = { kind: 'rectangle', fill: 'url(#x)' }
    video.clips.push(shape)
    const wire = serializeDoc(doc)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { doc: loaded, warnings } = deserializeDoc(JSON.parse(JSON.stringify(wire)))
    expect(
      loaded.project.tracks
        .flatMap((track) => track.clips)
        .some((clip) => clip.id === 'clip_bad_shape'),
    ).toBe(false)
    expect(warnings).toContain('Dropped 1 malformed shape clip.')
    expect(warn).not.toHaveBeenCalled()
  })

  it('drops a well-formed shape parked on a non-video lane with one warning', () => {
    const doc = makeDoc()
    const text = createTrack('text', 1, { name: 'T1' })
    text.clips.push(createShapeClip({ id: 'clip_misplaced_shape' }))
    doc.project.tracks.push(text)
    const wire = serializeDoc(doc)
    const { doc: loaded, warnings } = deserializeDoc(JSON.parse(JSON.stringify(wire)))
    expect(
      loaded.project.tracks
        .flatMap((track) => track.clips)
        .some((clip) => clip.id === 'clip_misplaced_shape'),
    ).toBe(false)
    expect(warnings).toContain('Dropped 1 malformed shape clip.')
  })

  it('refuses a shape that also carries media, text, compound, LUT, or retiming fields', () => {
    for (const patch of [
      { mediaId: 'media_fixed' },
      { text: 'both', style: createTextClip().style },
      { sequenceId: 'seq_x' },
      { speed: 2 },
      { reverse: true },
      { isCaption: true },
      { linkId: 'link_x' },
      { lutId: 'lut_x' },
    ]) {
      const doc = makeDoc()
      const video = doc.project.tracks.find((track) => track.kind === 'video')!
      video.clips.push(createShapeClip({ id: 'clip_bad_shape', ...patch }))
      expect(() => deserializeDoc(JSON.parse(JSON.stringify(serializeDoc(doc))))).toThrow(
        /Shape clip carries incompatible/,
      )
    }
  })

  it('sanitizes shape fields at hydration and clamps hostile values', () => {
    const doc = makeDoc()
    const video = doc.project.tracks.find((track) => track.kind === 'video')!
    video.clips.push(createShapeClip({ id: 'clip_shape' }))
    const wire = serializeDoc(doc) as unknown as {
      project: { tracks: { clips: { id: string; shape?: Record<string, unknown> }[] }[] }
    }
    const rawShape = wire.project.tracks
      .flatMap((track) => track.clips)
      .find((clip) => clip.id === 'clip_shape')!.shape!
    rawShape.fill = '#ABCDEF'
    rawShape.stroke = undefined
    rawShape.strokeWidth = -10
    rawShape.radius = 10_000
    rawShape.points = 500
    const { doc: loaded } = deserializeDoc(wire)
    expect(
      loaded.project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === 'clip_shape')
        ?.shape,
    ).toEqual({
      kind: 'rectangle',
      fill: '#abcdef',
      radius: 400,
    })
  })

  it('refuses a schema newer than this build', () => {
    const wire = serializeDoc(makeDoc()) as unknown as { version: number }
    wire.version = SERIALIZATION_VERSION + 1
    expect(() => deserializeDoc(wire)).toThrow(/Unsupported project version/)
  })
})

describe('track groups and brand kit at schema v8 (0.26.0)', () => {
  function v8Doc() {
    const doc = createDoc()
    doc.project.tracks[0].groupId = 'grp_pair'
    doc.project.tracks[1].groupId = 'grp_pair'
    doc.project.trackGroups = [{ id: 'grp_pair', name: 'Pair' }]
    doc.project.brandKit = {
      colors: [
        { id: 'brand_ink', name: 'Ink', value: '#112233' },
        { id: 'brand_paper', name: 'Paper', value: '#fefefe' },
      ],
      fontFamilies: ['Arial, sans-serif'],
    }
    return doc
  }

  it('round-trips a two-track group and a brand kit at v8', () => {
    const wire = serializeDoc(v8Doc())
    expect(wire.version).toBe(8)
    const { doc } = deserializeDoc(JSON.parse(JSON.stringify(wire)))
    expect(doc.project.trackGroups).toEqual([{ id: 'grp_pair', name: 'Pair' }])
    expect(doc.project.tracks.map((track) => track.groupId)).toEqual(['grp_pair', 'grp_pair'])
    expect(doc.project.brandKit).toEqual({
      colors: [
        { id: 'brand_ink', name: 'Ink', value: '#112233' },
        { id: 'brand_paper', name: 'Paper', value: '#fefefe' },
      ],
      fontFamilies: ['Arial, sans-serif'],
    })
  })

  it('loads a v7 file with neither surface', () => {
    const wire = JSON.parse(JSON.stringify(serializeDoc(v8Doc()))) as {
      version: number
      project: Record<string, unknown>
    }
    wire.version = 7
    delete wire.project.trackGroups
    delete wire.project.brandKit
    for (const track of wire.project.tracks as Record<string, unknown>[]) delete track.groupId
    const { doc } = deserializeDoc(wire)
    expect(doc.project.trackGroups).toBeUndefined()
    expect(doc.project.brandKit).toBeUndefined()
    expect(doc.project.tracks.every((track) => track.groupId === undefined)).toBe(true)
  })

  it('refuses duplicate group ids', () => {
    const wire = JSON.parse(JSON.stringify(serializeDoc(v8Doc())))
    wire.project.trackGroups = [
      { id: 'grp_pair', name: 'Pair' },
      { id: 'grp_pair', name: 'Other' },
    ]
    expect(() => deserializeDoc(wire)).toThrow(/Duplicate track group id/)
  })

  it('clears a dangling group id and drops an empty group', () => {
    const doc = createDoc()
    doc.project.tracks[0].groupId = 'grp_missing'
    doc.project.trackGroups = [{ id: 'grp_empty', name: 'Empty' }]
    const wire = JSON.parse(JSON.stringify(serializeDoc(doc)))
    const { doc: loaded } = deserializeDoc(wire)
    expect(loaded.project.tracks[0].groupId).toBeUndefined()
    expect(loaded.project.trackGroups).toBeUndefined()
  })

  it('keeps the first owner of a group spanning sequences and clears the foreign members', () => {
    const doc = createDoc()
    doc.project.tracks[0].groupId = 'grp_span'
    doc.project.trackGroups = [{ id: 'grp_span', name: 'Span' }]
    doc.project.sequences = [
      {
        id: 'seq_child',
        name: 'Child',
        tracks: [createTrack('video', 2, { id: 'track_child', groupId: 'grp_span' })],
      },
    ]
    const wire = JSON.parse(JSON.stringify(serializeDoc(doc)))
    const { doc: loaded } = deserializeDoc(wire)
    expect(loaded.project.tracks[0].groupId).toBe('grp_span')
    expect(loaded.project.sequences![0].tracks[0].groupId).toBeUndefined()
    expect(loaded.project.trackGroups).toHaveLength(1)
  })

  it('drops a group whose name carries control characters', () => {
    const doc = createDoc()
    doc.project.tracks[0].groupId = 'grp_bad'
    doc.project.trackGroups = [{ id: 'grp_bad', name: 'bad\u0000name' }]
    const wire = JSON.parse(JSON.stringify(serializeDoc(doc)))
    const { doc: loaded } = deserializeDoc(wire)
    expect(loaded.project.trackGroups).toBeUndefined()
    expect(loaded.project.tracks[0].groupId).toBeUndefined()
  })

  it('sanitizes hostile brand colors and font references without failing the load', () => {
    const doc = createDoc()
    doc.project.brandKit = {
      colors: [
        { id: 'brand_ok', name: 'Ok', value: '#ABCDEF' },
        { id: 'brand_ok', name: 'Duplicate id', value: '#111111' },
        { id: 'brand_dup', name: 'Duplicate value', value: '#abcdef' },
        { id: 'brand_css', name: 'Css', value: 'javascript:alert(1)' },
        { id: 'brand_rgb', name: 'Rgb', value: 'rgb(1,2,3)' },
      ],
      fontFamilies: ['Arial, sans-serif', 'bad;family'],
    }
    const wire = JSON.parse(JSON.stringify(serializeDoc(doc)))
    const { doc: loaded } = deserializeDoc(wire)
    expect(loaded.project.brandKit!.colors).toEqual([
      { id: 'brand_ok', name: 'Ok', value: '#abcdef' },
    ])
    expect(loaded.project.brandKit!.fontFamilies).toEqual(['Arial, sans-serif'])
  })

  it('caps an oversized palette and keeps a missing font reference', () => {
    const doc = createDoc()
    doc.project.brandKit = {
      colors: Array.from({ length: 30 }, (_, i) => ({
        id: `brand_${i}`,
        name: `Color ${i}`,
        value: `#0000${String(i).padStart(2, '0')}`,
      })),
      fontFamilies: ['videoh-font-missing, Arial, sans-serif'],
    }
    const wire = JSON.parse(JSON.stringify(serializeDoc(doc)))
    const { doc: loaded } = deserializeDoc(wire)
    expect(loaded.project.brandKit!.colors).toHaveLength(24)
    expect(loaded.project.brandKit!.fontFamilies).toEqual([
      'videoh-font-missing, Arial, sans-serif',
    ])
  })
})

describe('structural and media id hydration trust boundary (0.28.2)', () => {
  function wire(): Record<string, unknown> {
    return JSON.parse(JSON.stringify(serializeDoc(makeDoc()))) as Record<string, unknown>
  }

  function tracksOf(raw: Record<string, unknown>): Record<string, unknown>[] {
    const project = raw.project as Record<string, unknown>
    return project.tracks as Record<string, unknown>[]
  }

  it('refuses duplicate media ids', () => {
    const raw = wire()
    const media = raw.media as Record<string, unknown>[]
    media.push({ ...media[0] })
    expect(() => deserializeDoc(raw)).toThrow(SerializationError)
  })

  it('refuses an empty media id', () => {
    const raw = wire()
    ;(raw.media as Record<string, unknown>[])[0].id = ''
    expect(() => deserializeDoc(raw)).toThrow(SerializationError)
  })

  it('clears an empty clip mediaId', () => {
    const raw = wire()
    const clip = tracksOf(raw)[0].clips as Record<string, unknown>[]
    clip[0].mediaId = ''
    const { doc } = deserializeDoc(raw)
    expect(doc.project.tracks[0].clips[0].mediaId).toBeUndefined()
  })

  it('refuses empty or blank track, clip, and sequence ids', () => {
    const emptyTrack = wire()
    tracksOf(emptyTrack)[0].id = ''
    expect(() => deserializeDoc(emptyTrack)).toThrow(SerializationError)

    const emptyClip = wire()
    const clip = tracksOf(emptyClip)[0].clips as Record<string, unknown>[]
    clip[0].id = ''
    expect(() => deserializeDoc(emptyClip)).toThrow(SerializationError)

    const blankTrack = wire()
    tracksOf(blankTrack)[0].id = '   '
    expect(() => deserializeDoc(blankTrack)).toThrow(SerializationError)

    const emptySequence = wire()
    ;(emptySequence.project as Record<string, unknown>).sequences = [
      { id: '', name: 'Empty', tracks: [] },
    ]
    expect(() => deserializeDoc(emptySequence)).toThrow(SerializationError)
  })

  it('still parses a valid project', () => {
    const { doc } = deserializeDoc(wire())
    expect(doc.project.tracks[0].clips).toHaveLength(1)
    expect(doc.media[0].id).toBe('media_fixed')
  })

  it('drops clips that do not fit their lane kind and warns once', () => {
    const { doc, warnings } = deserializeDoc({
      version: SERIALIZATION_VERSION,
      project: {
        id: 'proj_lanes',
        name: 'Lanes',
        width: 1920,
        height: 1080,
        fps: 30,
        tracks: [
          {
            id: 'v1',
            kind: 'video',
            name: 'V1',
            clips: [
              { id: 'text_on_video', start: 0, duration: 1, text: 'Hi' },
              { id: 'audio_on_video', start: 0, duration: 1, mediaId: 'ma' },
              { id: 'valid_video', start: 0, duration: 1, mediaId: 'mv' },
            ],
          },
          {
            id: 't1',
            kind: 'text',
            name: 'T1',
            clips: [{ id: 'valid_text', start: 0, duration: 1, text: 'Hi' }],
          },
          {
            id: 'a1',
            kind: 'audio',
            name: 'A1',
            clips: [
              { id: 'compound_on_audio', start: 0, duration: 1, sequenceId: 'seq1' },
              { id: 'valid_audio', start: 0, duration: 1, mediaId: 'ma' },
            ],
          },
        ],
        sequences: [
          {
            id: 'seq1',
            name: 'S1',
            tracks: [{ id: 'sv', kind: 'video', name: 'V1', clips: [] }],
          },
        ],
      },
      media: [
        { id: 'ma', kind: 'audio', name: 'a.mp3', duration: 10 },
        { id: 'mv', kind: 'video', name: 'v.mp4', duration: 10 },
      ],
    })
    expect(doc.project.tracks.find((track) => track.id === 'v1')!.clips.map((c) => c.id)).toEqual([
      'valid_video',
    ])
    expect(doc.project.tracks.find((track) => track.id === 't1')!.clips.map((c) => c.id)).toEqual([
      'valid_text',
    ])
    expect(doc.project.tracks.find((track) => track.id === 'a1')!.clips.map((c) => c.id)).toEqual([
      'valid_audio',
    ])
    expect(warnings).toEqual([expect.stringContaining('track kind')])
  })

  it('keeps dangling media and empty text while dropping material lane mismatches', () => {
    const { doc, warnings } = deserializeDoc({
      version: SERIALIZATION_VERSION,
      project: {
        id: 'proj_lane_edges',
        name: 'Lane edges',
        width: 1920,
        height: 1080,
        fps: 30,
        tracks: [
          {
            id: 'v1',
            kind: 'video',
            name: 'V1',
            clips: [
              { id: 'dangling', start: 0, duration: 1, mediaId: 'gone' },
              { id: 'text_with_media', start: 0, duration: 1, mediaId: 'mv', text: 'Hi' },
              { id: 'audio_only_video', start: 0, duration: 1, mediaId: 'mv', audioOnly: true },
              { id: 'image_on_video', start: 0, duration: 1, mediaId: 'mi' },
            ],
          },
          {
            id: 't1',
            kind: 'text',
            name: 'T1',
            clips: [{ id: 'empty_text', start: 0, duration: 1, text: '' }],
          },
          {
            id: 'a1',
            kind: 'audio',
            name: 'A1',
            clips: [
              { id: 'audio_only_on_audio', start: 0, duration: 1, mediaId: 'mv', audioOnly: true },
              { id: 'image_on_audio', start: 0, duration: 1, mediaId: 'mi' },
            ],
          },
        ],
      },
      media: [
        { id: 'mv', kind: 'video', name: 'v.mp4', duration: 10 },
        { id: 'mi', kind: 'image', name: 'i.png', duration: 0 },
      ],
    })
    const ids = (trackId: string) =>
      doc.project.tracks.find((track) => track.id === trackId)!.clips.map((clip) => clip.id)
    // The dangling mediaId is cleared and the clip is kept for a relink; an
    // empty text clip stays on its text lane. Both are existing hydration
    // contracts, so the lane pass must not treat them as material mismatches.
    expect(ids('v1')).toEqual(['dangling', 'audio_only_video', 'image_on_video'])
    expect(ids('t1')).toEqual(['empty_text'])
    // A text clip carrying media is still text material; an image is not audio.
    expect(ids('a1')).toEqual(['audio_only_on_audio'])
    expect(warnings).toEqual([expect.stringContaining('track kind')])
  })
})

describe('hostile hydration boundaries (M2)', () => {
  function serialized(): Record<string, any> {
    const doc = makeDoc()
    doc.project.tracks.unshift(
      createTrack('text', 1, {
        id: 'text_track',
        clips: [createTextClip({ id: 'text_clip' })],
      }),
    )
    return JSON.parse(JSON.stringify(serializeDoc(doc))) as Record<string, any>
  }

  it('clamps negative media geometry and out-of-range text anchors', () => {
    const json = serialized()
    json.media[0].duration = -5
    json.media[0].width = -10
    json.media[0].height = -1
    const text = (json.project.tracks as Array<Record<string, any>>)
      .flatMap((track) => track.clips ?? [])
      .find((clip) => clip.id === 'text_clip')
    text.style.x = 1.5
    text.style.y = -0.25
    const { doc } = deserializeDoc(json)
    expect(doc.media[0]).toMatchObject({ duration: 0, width: 0, height: 0 })
    const loadedText = doc.project.tracks
      .flatMap((track) => track.clips)
      .find((clip) => clip.id === 'text_clip')
    expect(loadedText?.style?.x).toBe(1)
    expect(loadedText?.style?.y).toBe(0)
  })

  it('keeps proj_loaded only for a missing id and recovers invalid ids distinctly', () => {
    const missing = serialized()
    delete missing.project.id
    expect(deserializeDoc(missing).doc.project.id).toBe('proj_loaded')

    const first = serialized()
    first.project.id = '../escape'
    const second = serialized()
    second.project.id = 'bad id'
    const firstId = deserializeDoc(first).doc.project.id
    const secondId = deserializeDoc(second).doc.project.id
    expect(firstId).toMatch(/^proj_recovered_[0-9a-f]{16}$/)
    expect(secondId).toMatch(/^proj_recovered_[0-9a-f]{16}$/)
    expect(firstId).not.toBe(secondId)
    expect(firstId).not.toBe('proj_loaded')

    // A JSON array/object id and the string of its JSON text are different
    // invalid ids. The recovery must not collapse them onto one store key.
    const arrayId = serialized()
    arrayId.project.id = []
    const arrayTextId = serialized()
    arrayTextId.project.id = '[]'
    const objectId = serialized()
    objectId.project.id = {}
    const objectTextId = serialized()
    objectTextId.project.id = '{}'
    const arrayRecovered = deserializeDoc(arrayId).doc.project.id
    const arrayTextRecovered = deserializeDoc(arrayTextId).doc.project.id
    const objectRecovered = deserializeDoc(objectId).doc.project.id
    const objectTextRecovered = deserializeDoc(objectTextId).doc.project.id
    expect(arrayRecovered).toMatch(/^proj_recovered_[0-9a-f]{16}$/)
    expect(arrayRecovered).not.toBe(arrayTextRecovered)
    expect(objectRecovered).not.toBe(objectTextRecovered)
  })

  it('keeps special invalid ids distinct in the recovered hash', () => {
    // JSON.stringify writes null, NaN, and both infinities as "null" and writes
    // -0 as 0. Each pair here is a different invalid id, so a recovered store
    // key must not collapse them.
    const distinct: Array<[unknown, unknown]> = [
      [null, Infinity],
      [null, Number.NaN],
      [-0, 0],
      [[null], [Infinity]],
      [{ value: -0 }, { value: 0 }],
      ['Infinity', Infinity],
    ]
    for (const [first, second] of distinct) {
      expect(recoveredProjectId(first)).not.toBe(recoveredProjectId(second))
    }
  })

  it('separates distinct unreadable ids without coercing them', () => {
    const unreadable = () =>
      new Proxy(
        {},
        {
          getPrototypeOf: () => {
            throw new Error('no prototype')
          },
          get: () => {
            throw new Error('no properties')
          },
        },
      )
    const first = unreadable()
    const second = unreadable()
    expect(recoveredProjectId(first)).toMatch(/^proj_recovered_[0-9a-f]{16}$/)
    // The same value keeps its identity, and two distinct values never share
    // the generic "[object Object]" fallback.
    expect(recoveredProjectId(first)).toBe(recoveredProjectId(first))
    expect(recoveredProjectId(first)).not.toBe(recoveredProjectId(second))
  })

  it('recovers a value JSON cannot serialize without throwing', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(recoveredProjectId(circular)).toMatch(/^proj_recovered_[0-9a-f]{16}$/)
    expect(recoveredProjectId(circular)).toBe(recoveredProjectId(circular))
  })

  it('counts the depth of an unreachable sequence chain', () => {
    const json = serialized()
    json.project.sequences = Array.from({ length: MAX_SEQUENCE_DEPTH + 1 }, (_, index) => ({
      id: `seq_${index}`,
      name: `S${index}`,
      tracks: [
        {
          id: `trk_${index}`,
          kind: 'video',
          name: 'V1',
          clips:
            index < MAX_SEQUENCE_DEPTH
              ? [
                  {
                    id: `clip_${index}`,
                    start: 0,
                    duration: 1,
                    inPoint: 0,
                    sequenceId: `seq_${index + 1}`,
                  },
                ]
              : [],
        },
      ],
    }))
    expect(() => deserializeDoc(json)).toThrow(/nesting is too deep/)
  })

  it('refuses a 20k-deep chain with SerializationError instead of overflowing the stack', () => {
    const json = serialized()
    const depth = 20_000
    json.project.sequences = Array.from({ length: depth }, (_, index) => ({
      id: `seq_${index}`,
      name: `S${index}`,
      tracks: [
        {
          id: `trk_${index}`,
          kind: 'video',
          name: 'V1',
          clips:
            index < depth - 1
              ? [
                  {
                    id: `clip_${index}`,
                    start: 0,
                    duration: 1,
                    inPoint: 0,
                    sequenceId: `seq_${index + 1}`,
                  },
                ]
              : [],
        },
      ],
    }))
    expect(() => deserializeDoc(json)).toThrow(SerializationError)
    expect(() => deserializeDoc(json)).toThrow(/nesting is too deep/)
  })
})
