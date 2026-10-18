import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  deserializeDoc,
  parseSerializedDoc,
  projectFileName,
  SerializationError,
  serializeDoc,
  SERIALIZATION_VERSION,
} from '../serialization'
import { createClip, createDoc, createMediaAsset, createTextClip } from '../factories'
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
  PROJECT_MAX_H,
  PROJECT_MAX_W,
  PROJECT_MIN_H,
  PROJECT_MIN_W,
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
    // round-trip contract is "this text is version 4", and a literal here
    // notices a silent constant change instead of restating it.
    expect(json.version).toBe(4)
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
    expect(json.version).toBe(4)
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
    expect(json.version).toBe(4)
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
