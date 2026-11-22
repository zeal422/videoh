import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { applyCommand, TrackLockedError } from '../commands'
import { createDoc, createShapeClip, createTextClip, createTrack } from '../factories'
import { useEditorStore } from '../store'
import {
  createBuiltinTemplates,
  mintTemplateSequence,
  parseTemplate,
  TemplateError,
  templateFromSequence,
  validateTemplateForDoc,
  type ProjectTemplate,
} from '../templates'
import type { Doc, Sequence } from '../types'

function rawTemplate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'tpl_test',
    name: 'Test',
    description: 'A test template.',
    version: 1,
    sequence: {
      id: 'seq_test',
      name: 'Test sequence',
      tracks: [
        {
          id: 'track_test_text',
          kind: 'text',
          name: 'Title',
          clips: [
            {
              id: 'clip_test_text',
              start: 0,
              duration: 3,
              text: 'Hello',
              style: { fontSize: 64, color: '#ffffff', fontFamily: 'Arial, sans-serif' },
            },
          ],
        },
      ],
    },
    ...overrides,
  }
}

function template(overrides: Record<string, unknown> = {}): ProjectTemplate {
  return parseTemplate(rawTemplate(overrides))
}

function docWithText(): { doc: Doc; sequence: Sequence } {
  const doc = createDoc()
  const textTrack = createTrack('text', 1, { id: 'track_text' })
  doc.project.tracks.unshift(textTrack)
  textTrack.clips = [
    createTextClip({ id: 'clip_text', text: 'Saved title', start: 0, duration: 4 }),
  ]
  return {
    doc,
    sequence: { id: 'seq_source', name: 'Source', tracks: doc.project.tracks },
  }
}

describe('local templates (0.26.0)', () => {
  it('ships three valid built-ins as fresh copies', () => {
    const first = createBuiltinTemplates()
    const second = createBuiltinTemplates()
    expect(first).toHaveLength(3)
    expect(new Set(first.map((entry) => entry.id)).size).toBe(3)
    for (const entry of first) {
      expect(() => parseTemplate(entry)).not.toThrow()
      expect(entry.sequence.tracks.some((track) => track.kind === 'text')).toBe(true)
    }
    first[0].name = 'Mutated'
    expect(second[0].name).not.toBe('Mutated')
  })

  it('refuses an unknown keyframe field instead of dropping it', () => {
    const raw = rawTemplate()
    const sequence = raw.sequence as {
      tracks: Array<{ clips: Array<Record<string, unknown>> }>
    }
    sequence.tracks[0].clips[0].keyframes = {
      opacity: [{ time: 0, value: 0.5, bogus: 1 }],
    }
    expect(() => parseTemplate(raw)).toThrow(/unknown field: bogus/)
  })

  it('accepts a template with repeated link ids and remaps one group', () => {
    const raw = rawTemplate({
      sequence: {
        id: 'seq_links',
        name: 'Links',
        tracks: [
          {
            id: 'track_links',
            kind: 'text',
            name: 'Lines',
            clips: [
              {
                id: 'clip_one',
                start: 0,
                duration: 1,
                linkId: 'link_shared',
                text: 'One',
                style: { fontFamily: 'Arial, sans-serif' },
              },
              {
                id: 'clip_two',
                start: 1,
                duration: 1,
                linkId: 'link_shared',
                text: 'Two',
                style: { fontFamily: 'Arial, sans-serif' },
              },
            ],
          },
        ],
      },
    })
    const parsed = parseTemplate(raw)
    const minted = mintTemplateSequence(parsed)
    const clips = minted.sequence.tracks[0].clips
    expect(clips).toHaveLength(2)
    expect(clips[0].linkId).toBeDefined()
    expect(clips[0].linkId).toBe(clips[1].linkId)
    expect(clips[0].linkId).not.toBe('link_shared')
  })

  it('mints fresh sequence, track, and clip ids on every application', () => {
    const parsed = template()
    const first = mintTemplateSequence(parsed)
    const second = mintTemplateSequence(parsed)
    expect(first.sequence.id).not.toBe(second.sequence.id)
    expect(first.sequence.tracks[0].id).not.toBe(second.sequence.tracks[0].id)
    expect(first.sequence.tracks[0].clips[0].id).not.toBe(second.sequence.tracks[0].clips[0].id)
    expect(first.sequence.id).not.toBe('seq_test')
    expect(first.sequence.tracks[0].id).not.toBe('track_test_text')
    expect(first.sequence.tracks[0].clips[0].id).not.toBe('clip_test_text')
  })

  it('refuses unknown versions and unknown fields', () => {
    expect(() => parseTemplate(rawTemplate({ version: 2 }))).toThrow(/Unsupported template version/)
    expect(() => parseTemplate(rawTemplate({ version: 0 }))).toThrow(/Unsupported template version/)
    expect(() => parseTemplate(rawTemplate({ surprise: true }))).toThrow(/unknown field/)
    const withUnknownClip = rawTemplate()
    ;(
      withUnknownClip.sequence as { tracks: { clips: Record<string, unknown>[] }[] }
    ).tracks[0].clips[0].mediaId = 'media_x'
    expect(() => parseTemplate(withUnknownClip)).toThrow(/unknown field/)
  })

  it('refuses duplicate track and clip ids before any remapping', () => {
    const duplicateTrack = rawTemplate()
    const tracks = (duplicateTrack.sequence as { tracks: unknown[] }).tracks
    tracks.push({ ...(tracks[0] as Record<string, unknown>) })
    expect(() => parseTemplate(duplicateTrack)).toThrow(/Duplicate template track id/)

    const duplicateClip = rawTemplate()
    const clipTrack = (duplicateClip.sequence as { tracks: { clips: unknown[] }[] }).tracks[0]
    clipTrack.clips.push({ ...(clipTrack.clips[0] as Record<string, unknown>) })
    expect(() => parseTemplate(duplicateClip)).toThrow(/Duplicate template clip id/)
  })

  it('refuses path-like names, malformed colors, and lane mismatches', () => {
    expect(() => parseTemplate(rawTemplate({ name: '../escape' }))).toThrow(/path/)
    expect(() => parseTemplate(rawTemplate({ name: 'nested/name' }))).toThrow(/path/)
    const badColor = rawTemplate()
    ;(
      badColor.sequence as { tracks: { clips: { style: Record<string, unknown> }[] }[] }
    ).tracks[0].clips[0].style.color = 'rgb(1,2,3)'
    expect(() => parseTemplate(badColor)).toThrow(/Template text clip has no text|invalid/i)
    const textOnVideo = rawTemplate()
    ;(textOnVideo.sequence as { tracks: { kind: string }[] }).tracks[0].kind = 'video'
    expect(() => parseTemplate(textOnVideo)).toThrow(/text tracks/)
    const shapeOnText = rawTemplate()
    ;(
      shapeOnText.sequence as { tracks: { clips: Record<string, unknown>[] }[] }
    ).tracks[0].clips[0] = {
      id: 'clip_shape',
      start: 0,
      duration: 2,
      shape: { kind: 'rectangle', fill: '#ffffff' },
    }
    expect(() => parseTemplate(shapeOnText)).toThrow(/shape clips live on video tracks/)

    const badOpacity = rawTemplate()
    ;(
      badOpacity.sequence as { tracks: { clips: Record<string, unknown>[] }[] }
    ).tracks[0].clips[0].opacity = Number.NaN
    expect(() => parseTemplate(badOpacity)).toThrow(/opacity is invalid/)

    const badStatic = rawTemplate()
    ;(
      badStatic.sequence as { tracks: { clips: Record<string, unknown>[] }[] }
    ).tracks[0].clips[0].animStatics = { opacity: 0.5 }
    expect(() => parseTemplate(badStatic)).toThrow(/unsupported static property/)

    const badCurve = rawTemplate()
    ;(
      badCurve.sequence as { tracks: { clips: Record<string, unknown>[] }[] }
    ).tracks[0].clips[0].keyframes = { volume: [{ time: 0, value: 1 }] }
    expect(() => parseTemplate(badCurve)).toThrow(/unsupported keyframe property/)
  })

  it('refuses an unknown shape kind and an empty template', () => {
    const unknownShape = rawTemplate()
    ;(
      unknownShape.sequence as { tracks: { clips: Record<string, unknown>[] }[] }
    ).tracks[0].clips[0] = {
      id: 'clip_shape',
      start: 0,
      duration: 2,
      shape: { kind: 'hexagon', fill: '#ffffff' },
    }
    ;(unknownShape.sequence as { tracks: { kind: string }[] }).tracks[0].kind = 'video'
    expect(() => parseTemplate(unknownShape)).toThrow(/shape clip is invalid/)
    expect(() =>
      parseTemplate(
        rawTemplate({
          sequence: { id: 'seq_empty', name: 'Empty', tracks: [] },
        }),
      ),
    ).toThrow(/no tracks/)
  })

  it('refuses oversized track, clip, text, and duration limits', () => {
    const tooManyTracks = rawTemplate()
    const trackList = (tooManyTracks.sequence as { tracks: unknown[] }).tracks
    for (let i = 0; i < 24; i++) {
      trackList.push({
        id: `track_extra_${i}`,
        kind: 'text',
        name: `T${i}`,
        clips: [],
      })
    }
    expect(() => parseTemplate(tooManyTracks)).toThrow(/more than 24 tracks/)

    const tooManyClips = rawTemplate()
    const clipTrack = (tooManyClips.sequence as { tracks: { clips: unknown[] }[] }).tracks[0]
    for (let i = 0; i < 200; i++) {
      clipTrack.clips.push({
        id: `clip_extra_${i}`,
        start: i,
        duration: 1,
        text: 'x',
        style: { fontFamily: 'Arial, sans-serif' },
      })
    }
    expect(() => parseTemplate(tooManyClips)).toThrow(/more than 200 clips/)

    const tooLongText = rawTemplate()
    ;(tooLongText.sequence as { tracks: { clips: { text: string }[] }[] }).tracks[0].clips[0].text =
      'x'.repeat(501)
    expect(() => parseTemplate(tooLongText)).toThrow(/text is too long/)

    const tooLong = rawTemplate()
    ;(
      tooLong.sequence as { tracks: { clips: { duration: number }[] }[] }
    ).tracks[0].clips[0].duration = 4000
    expect(() => parseTemplate(tooLong)).toThrow(/past the supported timeline range/)
  })

  it('refuses a template naming a font this project does not have', () => {
    const parsed = template()
    parsed.sequence.tracks[0].clips[0].style!.fontFamily = 'videoh-font-missing, Arial, sans-serif'
    expect(() => validateTemplateForDoc(parsed, createDoc())).toThrow(
      /font this project does not have/,
    )
    // The same primary family with different fallbacks still resolves.
    const fallback = template()
    fallback.sequence.tracks[0].clips[0].style!.fontFamily = '"Arial", serif'
    expect(() => validateTemplateForDoc(fallback, createDoc())).not.toThrow()
    const quotedBuiltin = template()
    quotedBuiltin.sequence.tracks[0].clips[0].style!.fontFamily = '"Times New Roman", Times, serif'
    expect(() => validateTemplateForDoc(quotedBuiltin, createDoc())).not.toThrow()
  })

  it('saves only text and shape clips, never media or group membership', () => {
    const { doc, sequence } = docWithText()
    const text = doc.project.tracks[0].clips[0]
    text.opacity = 0.5
    text.rotation = 15
    text.flipX = true
    text.animStatics = { positionX: 40, scale: 1.2 }
    text.keyframes = {
      opacity: [
        { time: 0, value: 0 },
        { time: 1, value: 1 },
      ],
    }
    const video = doc.project.tracks.find((track) => track.kind === 'video')!
    video.clips = [
      { id: 'clip_media', mediaId: 'media_x', start: 0, duration: 2, inPoint: 0 },
      createShapeClip({ id: 'clip_shape', start: 2, duration: 2 }),
    ]
    // Tag both source tracks as grouped: a template never stores membership.
    sequence.tracks[0].groupId = 'grp_source'
    const saved = templateFromSequence(sequence, { name: 'Saved', description: 'Only graphics' })
    const allClips = saved.sequence.tracks.flatMap((track) => track.clips)
    expect(allClips.map((clip) => clip.id).sort()).toEqual(['clip_shape', 'clip_text'])
    expect(allClips.every((clip) => !('mediaId' in clip))).toBe(true)
    expect(JSON.stringify(saved)).not.toContain('groupId')

    // Visual settings survive the template round trip.
    const savedText = allClips.find((clip) => clip.id === 'clip_text')!
    expect(savedText.opacity).toBe(0.5)
    expect(savedText.rotation).toBe(15)
    expect(savedText.flipX).toBe(true)
    expect(savedText.animStatics).toEqual({ positionX: 40, scale: 1.2 })
    expect(savedText.keyframes?.opacity).toHaveLength(2)
    const minted = mintTemplateSequence(saved)
    const mintedText = minted.sequence.tracks
      .flatMap((track) => track.clips)
      .find((clip) => clip.text !== undefined)!
    expect(mintedText.opacity).toBe(0.5)
    expect(mintedText.rotation).toBe(15)
    expect(mintedText.flipX).toBe(true)
    expect(mintedText.animStatics).toEqual({ positionX: 40, scale: 1.2 })
    expect(mintedText.keyframes?.opacity).toHaveLength(2)

    // The browser store reads, validates, patches, and writes in one transaction.
    const storeSource = readFileSync(
      join(process.cwd(), 'src/lib/editor/template-store.ts'),
      'utf8',
    )
    const update = storeSource.slice(
      storeSource.indexOf('export async function updateSavedTemplate'),
      storeSource.indexOf('/** Deletes one saved template. */'),
    )
    expect(update).toContain("'readwrite'")
    expect(update).not.toContain("'readonly'")
    expect(update).toContain('store.get(id)')
    expect(update).toContain('store.put(next)')
  })

  it('refuses to save a sequence with no text or shape clips', () => {
    const doc = createDoc()
    doc.project.tracks[0].clips = [
      { id: 'clip_media', mediaId: 'media_x', start: 0, duration: 2, inPoint: 0 },
    ]
    expect(() =>
      templateFromSequence(
        { id: 'seq_media', name: 'Media', tracks: doc.project.tracks },
        { name: 'Empty' },
      ),
    ).toThrow(/no text or shape clips/)
  })

  it('applies as one command that installs a fresh sequence and its container', () => {
    const doc = createDoc()
    const parsed = createBuiltinTemplates()[0]
    const next = applyCommand(doc, { type: 'applyTemplate', template: parsed, start: 2 })
    expect(next.project.sequences).toHaveLength(1)
    const sequence = next.project.sequences![0]
    expect(sequence.id).not.toBe(parsed.sequence.id)
    expect(sequence.tracks).toHaveLength(2)
    expect(sequence.tracks.every((track) => track.groupId === undefined)).toBe(true)
    const video = next.project.tracks.find((track) => track.kind === 'video')!
    const container = video.clips.find((clip) => clip.sequenceId === sequence.id)
    expect(container).toBeDefined()
    expect(container!.start).toBe(2)
    expect(container!.duration).toBeGreaterThan(0)
    expect(container!.mediaId).toBeUndefined()
    expect(sequence.tracks.flatMap((track) => track.clips).every((clip) => !clip.mediaId)).toBe(
      true,
    )
  })

  it('applies the same template twice with independent ids and containers', () => {
    const doc = createDoc()
    const parsed = createBuiltinTemplates()[0]
    const first = applyCommand(doc, { type: 'applyTemplate', template: parsed, start: 0 })
    const second = applyCommand(first, { type: 'applyTemplate', template: parsed, start: 6 })
    expect(second.project.sequences).toHaveLength(2)
    const [a, b] = second.project.sequences!
    expect(a.id).not.toBe(b.id)
    expect(a.tracks[0].id).not.toBe(b.tracks[0].id)
    expect(a.tracks[0].clips[0].id).not.toBe(b.tracks[0].clips[0].id)
    const containers = second.project.tracks
      .flatMap((track) => track.clips)
      .filter((clip) => clip.sequenceId)
    expect(containers.map((clip) => clip.sequenceId).sort()).toEqual([a.id, b.id].sort())
  })

  it('creates a destination video lane when the sequence has none', () => {
    const doc = createDoc()
    doc.project.tracks = [createTrack('audio', 1, { id: 'track_only_audio' })]
    const next = applyCommand(doc, {
      type: 'applyTemplate',
      template: createBuiltinTemplates()[1],
      start: 0,
    })
    const video = next.project.tracks.find((track) => track.kind === 'video')
    expect(video).toBeDefined()
    expect(video!.clips.some((clip) => clip.sequenceId)).toBe(true)
  })

  it('refuses a template the current build cannot support and a locked lane', () => {
    const parsed = template()
    parsed.sequence.tracks[0].clips[0].style!.fontFamily = 'videoh-font-missing, Arial, sans-serif'
    expect(() =>
      applyCommand(createDoc(), { type: 'applyTemplate', template: parsed, start: 0 }),
    ).toThrow(/font this project does not have/)

    const locked = createDoc()
    locked.project.tracks.find((track) => track.kind === 'video')!.locked = true
    expect(() =>
      applyCommand(locked, {
        type: 'applyTemplate',
        template: createBuiltinTemplates()[0],
        start: 0,
      }),
    ).toThrow(TrackLockedError)
  })

  it('undoes an applied template as one history entry', () => {
    useEditorStore.getState().replaceDoc(createDoc())
    const applied = useEditorStore
      .getState()
      .apply({ type: 'applyTemplate', template: createBuiltinTemplates()[0], start: 0 })
    expect(applied).toBe(true)
    expect(useEditorStore.getState().doc.project.sequences).toHaveLength(1)
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().doc.project.sequences).toBeUndefined()
  })
})

describe('template shape links and shape-only fields (0.28.2)', () => {
  function shapeRawClip(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'clip_shape',
      start: 0,
      duration: 2,
      shape: { kind: 'rectangle', fill: '#ffffff' },
      ...overrides,
    }
  }

  function rawShapeTemplate(clipOverrides: Record<string, unknown> = {}): Record<string, unknown> {
    return rawTemplate({
      sequence: {
        id: 'seq_shape',
        name: 'Shapes',
        tracks: [
          {
            id: 'track_shape',
            kind: 'video',
            name: 'Shapes',
            clips: [shapeRawClip(clipOverrides)],
          },
        ],
      },
    })
  }

  it('refuses a linkId on a shape clip', () => {
    expect(() => parseTemplate(rawShapeTemplate({ linkId: 'link_shape' }))).toThrow(TemplateError)
  })

  it('stops capturing a shape linkId from a live sequence', () => {
    const sequence: Sequence = {
      id: 'seq_live',
      name: 'Live',
      tracks: [
        createTrack('video', 1, {
          id: 'track_live',
          clips: [
            createShapeClip({ id: 'shape_live', linkId: 'link_live', start: 0, duration: 2 }),
          ],
        }),
      ],
    }
    const captured = templateFromSequence(sequence, { name: 'Live shape' })
    const clip = captured.sequence.tracks[0].clips[0]
    expect(clip.shape).toBeDefined()
    expect(clip.linkId).toBeUndefined()
  })

  it('applies a shape template that carries style without keeping text or style', () => {
    const parsed = parseTemplate(rawShapeTemplate({ style: { fontFamily: 'Arial, sans-serif' } }))
    const minted = mintTemplateSequence(parsed)
    const clip = minted.sequence.tracks[0].clips[0]
    expect(clip.shape).toBeDefined()
    expect(clip.text).toBeUndefined()
    expect(clip.style).toBeUndefined()
  })

  it('refuses shape-hostile clip fields through the known-key check', () => {
    for (const [field, value] of [
      ['speed', 2],
      ['audioOnly', true],
      ['reverse', true],
      ['lutId', 'lut_x'],
    ] as const) {
      expect(() => parseTemplate(rawShapeTemplate({ [field]: value }))).toThrow(/unknown field/i)
    }
  })

  it('refuses a timeScale curve on a shape template and never retains one', () => {
    expect(() =>
      parseTemplate(rawShapeTemplate({ keyframes: { timeScale: [{ time: 0, value: 1 }] } })),
    ).toThrow(/unsupported keyframe property/i)
    const minted = mintTemplateSequence(parseTemplate(rawShapeTemplate()))
    expect(minted.sequence.tracks[0].clips[0].keyframes?.timeScale).toBeUndefined()
  })
})

describe('template hostile matrix (0.29.0)', () => {
  const textClip = (over: Record<string, unknown> = {}) => ({
    id: 'clip_t',
    start: 0,
    duration: 1,
    text: 'Hi',
    style: { fontFamily: 'Arial, sans-serif' },
    ...over,
  })
  const withClip = (clip: unknown, kind: 'text' | 'video' = 'text') =>
    rawTemplate({
      sequence: {
        id: 'seq_t',
        name: 'S',
        tracks: [{ id: 'tr_t', kind, name: 'T', clips: [clip] }],
      },
    })

  it.each([
    [{ id: '' }, /id is invalid/],
    [{ id: 'bad id' }, /id is invalid/],
    [{ name: 7 }, /name must be a string/],
    [{ name: '   ' }, /name cannot be empty/],
    [{ name: 'x'.repeat(65) }, /name is too long/],
    [{ name: 'bad\u0001name' }, /control characters/],
    [{ description: 7 }, /description must be a string/],
    [{ description: 'x'.repeat(201) }, /description is too long/],
    [{ description: 'bad\u0001text' }, /description contains control/],
  ])('refuses root metadata %j', (overrides, message) => {
    expect(() => parseTemplate(rawTemplate(overrides))).toThrow(message)
  })

  it('defaults an absent description and accepts a normal one', () => {
    const raw = rawTemplate()
    delete raw.description
    expect(parseTemplate(raw).description).toBe('')
  })

  it.each([
    [withClip(textClip({ text: '' })), /has no text/],
    [withClip(textClip({ text: 'x'.repeat(501) })), /text is too long/],
    [withClip(textClip({ text: 'bad\u0001text' })), /text contains control/],
    [withClip(textClip({ style: undefined })), /has no style/],
    [withClip(textClip({ style: { fontFamily: 7 } })), /font family is invalid/],
  ])('refuses malformed text clips', (raw, message) => {
    expect(() => parseTemplate(raw)).toThrow(message)
  })

  it('falls a missing font family back to the default style', () => {
    const parsed = parseTemplate(withClip(textClip({ style: { fontSize: 40 } })))
    expect(parsed.sequence.tracks[0]!.clips[0]!.style!.fontFamily).toBeTruthy()
  })

  it.each([
    [withClip(textClip({ opacity: 'x' })), /opacity is invalid/],
    [withClip(textClip({ rotation: Number.NaN })), /rotation is invalid/],
    [withClip(textClip({ flipX: 1 })), /flip is invalid/],
    [withClip(textClip({ flipY: 'yes' })), /flip is invalid/],
    [withClip(textClip({ stretchX: '2' })), /stretch is invalid/],
    [withClip(textClip({ stretchY: Number.NaN })), /stretch is invalid/],
    [withClip(textClip({ animStatics: 5 })), /static values are invalid/],
    [withClip(textClip({ animStatics: { opacity: 0.5 } })), /unsupported static property/],
    [withClip(textClip({ animStatics: { scale: 'x' } })), /static value is invalid/],
    [withClip(textClip({ keyframes: 5 })), /keyframes are invalid/],
    [withClip(textClip({ keyframes: { opacity: 5 } })), /keyframes are invalid/],
    [withClip(textClip({ keyframes: { volume: [] } })), /unsupported keyframe property/],
    [withClip(textClip({ keyframes: { opacity: [null] } })), /keyframe is invalid/],
    [
      withClip(textClip({ keyframes: { opacity: [{ time: 'x', value: 0 }] } })),
      /keyframe is invalid/,
    ],
    [withClip(null), /clip is not an object/],
    [withClip({ ...textClip(), start: -1 }), /start must be a non-negative/],
    [withClip({ ...textClip(), start: 'x' }), /start must be a non-negative/],
    [withClip({ ...textClip(), duration: 0 }), /duration is too short/],
    [withClip({ ...textClip(), duration: 'x' }), /duration is too short/],
    [withClip({ id: 'clip_n', start: 0, duration: 1 }), /either a text clip or a shape clip/],
  ])('refuses malformed visual and timing fields', (raw, message) => {
    expect(() => parseTemplate(raw)).toThrow(message)
  })

  it('hydrates non-default visuals, flips, statics, and keyframes', () => {
    const parsed = parseTemplate(
      withClip(
        textClip({
          opacity: 0.5,
          rotation: 45,
          flipX: true,
          flipY: true,
          animStatics: { scale: 2, positionX: 0 },
          keyframes: {
            opacity: [
              {
                time: 0,
                value: 0.5,
                interpolation: 'easeInOut',
                easeOut: [0, 0, 1, 1],
              },
              { time: 1, value: 1, interpolation: 'bogus' },
            ],
          },
        }),
      ),
    )
    const clip = parsed.sequence.tracks[0]!.clips[0]!
    expect(clip).toMatchObject({ opacity: 0.5, rotation: 45, flipX: true, flipY: true })
    expect(clip.animStatics).toEqual({ scale: 2 })
    expect(clip.keyframes?.opacity).toHaveLength(2)
    expect(clip.keyframes?.opacity?.[0]?.easeOut).toEqual([0, 0, 1, 1])
    expect(clip.keyframes?.opacity?.[1]?.interpolation).toBe('linear')
  })

  it.each([
    [{ sequence: undefined }, /has no sequence/],
    [{ sequence: { id: 'seq_t', name: 'S' } }, /sequence has no tracks/],
    [{ sequence: { id: 'seq_t', name: 'S', tracks: [] } }, /Template has no tracks/],
    [{ sequence: { id: 'seq_t', name: 'S', tracks: [null] } }, /track is not an object/],
    [
      {
        sequence: {
          id: 'seq_t',
          name: 'S',
          tracks: [{ id: 'tr_t', kind: 'audio', name: 'A', clips: [] }],
        },
      },
      /video or text tracks/,
    ],
    [
      {
        sequence: {
          id: 'seq_t',
          name: 'S',
          tracks: [{ id: 'tr_t', kind: 'text', name: 'T' }],
        },
      },
      /track has no clips/,
    ],
    [
      {
        sequence: {
          id: 'seq_t',
          name: 'S',
          tracks: [{ id: 'tr_t', kind: 'text', name: 'T', clips: [] }],
        },
      },
      /Template has no clips/,
    ],
  ])('refuses malformed sequence shapes', (overrides, message) => {
    expect(() => parseTemplate(rawTemplate(overrides))).toThrow(message)
  })

  it('refuses a non-object template', () => {
    expect(() => parseTemplate(5)).toThrow(/not an object/)
    expect(() => parseTemplate(null)).toThrow(/not an object/)
  })

  it('captures and mints every visual field', () => {
    const doc = createDoc()
    const textTrack = createTrack('text', 1, { id: 'track_visual' })
    textTrack.clips = [
      createTextClip({
        id: 'clip_visual',
        text: 'Styled',
        start: 0,
        duration: 2,
        linkId: 'link_a',
        flipX: true,
        flipY: true,
        stretchX: 1.5,
        stretchY: 0.8,
        animStatics: { scale: 2, opacity: 0.5 } as never,
        keyframes: { opacity: [{ time: 0, value: 0.5 }], volume: [{ time: 0, value: 0.5 }] },
      } as never),
      createTextClip({
        id: 'clip_visual_2',
        text: 'Paired',
        start: 2,
        duration: 2,
        linkId: 'link_a',
      } as never),
    ]
    doc.project.tracks.unshift(textTrack)
    const template = templateFromSequence(
      { id: 'seq_visual', name: 'Visual', tracks: doc.project.tracks },
      { name: 'Captured' },
    )
    const clip = template.sequence.tracks[0]!.clips[0]!
    expect(clip.flipY).toBe(true)
    expect(clip.stretchX).toBe(1.5)
    expect(clip.stretchY).toBe(0.8)
    expect(clip.linkId).toBe('link_a')
    expect(clip.animStatics).toEqual({ scale: 2 })
    expect(clip.keyframes).toMatchObject({ opacity: [{ time: 0, value: 0.5 }] })
    const minted = mintTemplateSequence(template)
    const mintedClips = minted.sequence.tracks[0]!.clips
    expect(mintedClips[0]!.flipY).toBe(true)
    // Both halves mint to the same fresh link id, never the captured one.
    const freshLink = mintedClips[0]!.linkId
    expect(freshLink).toBeDefined()
    expect(freshLink).not.toBe('link_a')
    expect(mintedClips[1]!.linkId).toBe(freshLink)
  })
})

describe('template default visual fields (0.29.0)', () => {
  const withClip = (clip: unknown) =>
    rawTemplate({
      sequence: {
        id: 'seq_t',
        name: 'S',
        tracks: [{ id: 'tr_t', kind: 'text', name: 'T', clips: [clip] }],
      },
    })

  it('omits explicit defaults instead of storing them', () => {
    const parsed = parseTemplate(
      withClip({
        id: 'clip_defaults',
        start: 0,
        duration: 1,
        text: 'Hi',
        style: { fontFamily: 'Arial, sans-serif' },
        opacity: 1,
        rotation: 0,
        flipX: false,
        flipY: false,
        animStatics: { scale: 1 },
        keyframes: { opacity: [] },
      }),
    )
    const clip = parsed.sequence.tracks[0]!.clips[0]!
    expect(clip.opacity).toBeUndefined()
    expect(clip.rotation).toBeUndefined()
    expect(clip.flipX).toBeUndefined()
    expect(clip.flipY).toBeUndefined()
    expect(clip.animStatics).toBeUndefined()
    expect(clip.keyframes).toBeUndefined()
  })

  it('skips a project font whose family has no primary token', () => {
    const doc = createDoc()
    doc.project.fonts = [{ id: 'font_blank', name: 'Blank', family: '' } as never]
    const template = createBuiltinTemplates()[0]!
    expect(() => validateTemplateForDoc(template, doc)).not.toThrow()
  })
})

describe('template capture omits empty visual maps (0.29.0)', () => {
  it('drops invalid statics and unsupported curves instead of storing empty maps', () => {
    const doc = createDoc()
    const track = createTrack('text', 1, { id: 'track_capture' })
    track.clips = [
      createTextClip({
        id: 'clip_capture',
        text: 'Hi',
        start: 0,
        duration: 2,
        animStatics: { opacity: 0.5, scale: 'bad' },
        keyframes: { volume: [{ time: 0, value: 0.5 }] },
      } as never),
    ]
    doc.project.tracks.unshift(track)
    const template = templateFromSequence(
      { id: 'seq_capture', name: 'S', tracks: doc.project.tracks },
      { name: 'Capture' },
    )
    const clip = template.sequence.tracks[0]!.clips[0]!
    expect(clip.animStatics).toBeUndefined()
    expect(clip.keyframes).toBeUndefined()
  })
})

describe('template stretch bounds (0.29.5)', () => {
  it('clamps a hostile stretch and drops the neutral value', () => {
    const doc = createDoc()
    const track = createTrack('text', 1, { id: 'track_stretch_tpl' })
    track.clips = [createTextClip({ id: 'clip_stretch_tpl', start: 0, duration: 2 })]
    doc.project.tracks.unshift(track)
    const template = templateFromSequence(
      { id: 'seq_stretch_tpl', name: 'S', tracks: doc.project.tracks },
      { name: 'Stretch' },
    )
    const raw = structuredClone(template) as unknown as {
      sequence: { tracks: { clips: Record<string, unknown>[] }[] }
    }
    raw.sequence.tracks[0]!.clips[0]!.stretchX = 99
    raw.sequence.tracks[0]!.clips[0]!.stretchY = 1
    const parsed = parseTemplate(raw)
    const clip = parsed.sequence.tracks[0]!.clips[0]!
    expect(clip.stretchX).toBe(4)
    expect(clip.stretchY).toBeUndefined()
  })
})
