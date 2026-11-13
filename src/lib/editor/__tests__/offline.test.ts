import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { createClip, createDoc, createMediaAsset, createTextClip, createTrack } from '../factories'
import { hasOfflineMedia, offlineAudibleMedia, offlineMediaAt } from '../offline'
import type { Clip, Doc, MediaAsset, TrackKind } from '../types'

/**
 * offline.ts locks the restored-session UX fix: a frame whose media is offline
 * used to render black with no explanation, which reads as a broken preview.
 * The monitor now names the missing files, so this decides exactly when that
 * overlay may appear.
 */

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

const video = (name: string, overrides: Partial<MediaAsset> = {}): MediaAsset =>
  createMediaAsset({ kind: 'video', name, duration: 6, ...overrides })

/** One track of `kind` holding `clips`, plus the given assets. */
function buildDoc(media: MediaAsset[], clips: Clip[], kind: TrackKind = 'video'): Doc {
  const doc = createDoc()
  return { project: { ...doc.project, tracks: [createTrack(kind, 1, { clips })] }, media }
}

describe('offlineMediaAt', () => {
  it('names the asset a frame needs when it is offline', () => {
    const asset = video('restored.mp4', { url: '', missing: true })
    const doc = buildDoc([asset], [createClip({ mediaId: asset.id, start: 0, duration: 4 })])
    expect(offlineMediaAt(doc, 1)).toEqual(['restored.mp4'])
  })

  it('stays quiet once the asset is online again', () => {
    const asset = video('relinked.mp4', { url: 'blob:http://localhost/x' })
    const doc = buildDoc([asset], [createClip({ mediaId: asset.id, start: 0, duration: 4 })])
    expect(offlineMediaAt(doc, 1)).toEqual([])
  })

  it('stays quiet in a gap between clips', () => {
    const asset = video('gone.mp4', { url: '', missing: true })
    const doc = buildDoc([asset], [createClip({ mediaId: asset.id, start: 4, duration: 2 })])
    expect(offlineMediaAt(doc, 1)).toEqual([])
  })

  it('reports an A/V pair of one file a single time', () => {
    const asset = video('pair.mp4', { url: '', missing: true })
    const doc = buildDoc(
      [asset],
      [
        createClip({ mediaId: asset.id, start: 0, duration: 5 }),
        createClip({ mediaId: asset.id, start: 0, duration: 5, audioOnly: true }),
      ],
    )
    expect(offlineMediaAt(doc, 2)).toEqual(['pair.mp4'])
  })

  it('covers silent offline audio too', () => {
    const asset = createMediaAsset({
      kind: 'audio',
      name: 'score.mp3',
      duration: 8,
      url: '',
      missing: true,
    })
    const doc = buildDoc(
      [asset],
      [createClip({ mediaId: asset.id, start: 1, duration: 4 })],
      'audio',
    )
    expect(offlineMediaAt(doc, 2)).toEqual(['score.mp3'])
  })

  it('ignores text clips and clips whose asset vanished entirely', () => {
    const doc = buildDoc(
      [],
      [
        createTextClip({ start: 0, duration: 4 }),
        createClip({ mediaId: 'media_gone', start: 0, duration: 4 }),
      ],
    )
    expect(offlineMediaAt(doc, 1)).toEqual([])
  })
})

describe('preview offline overlay wiring', () => {
  it('renders the overlay from the playhead frame', () => {
    const panel = read('src/components/editor/PreviewPanel.tsx')
    expect(panel).toMatch(/offlineMediaAt\(doc, playhead, activeSequencePath\)/)
    expect(panel).toMatch(/data-testid="media-offline-overlay"/)
    expect(panel).toMatch(/Media offline/)
    expect(panel).toMatch(/Relink in the Media bin/)
  })
})

describe('hasOfflineMedia (the export gate predicate)', () => {
  it('blocks when a used clip no longer resolves', () => {
    // A dangling mediaId is not an asset at all: the old media-bin predicate
    // passed it through and the export rendered that clip black and silent.
    const online = video('online.mp4', { url: 'blob:x' })
    const doc = buildDoc([online], [createClip({ mediaId: 'media_gone', start: 0, duration: 4 })])
    expect(hasOfflineMedia(doc)).toBe(true)
  })

  it('does not block on an offline asset nothing uses', () => {
    // The mirror over-block: an offline asset sitting in the bin must not
    // refuse an export whose every used clip is online.
    const used = video('used.mp4', { url: 'blob:x' })
    const doc = buildDoc(
      [used, video('unused.mp4', { url: '', missing: true })],
      [createClip({ mediaId: used.id, start: 0, duration: 4 })],
    )
    expect(hasOfflineMedia(doc)).toBe(false)
  })

  it('passes a fully online doc', () => {
    const asset = video('online.mp4', { url: 'blob:x' })
    const doc = buildDoc([asset], [createClip({ mediaId: asset.id, start: 0, duration: 4 })])
    expect(hasOfflineMedia(doc)).toBe(false)
  })
})

describe('offlineAudibleMedia (the audio-only export gate)', () => {
  const audioAsset = (name: string, overrides: Partial<MediaAsset> = {}): MediaAsset =>
    createMediaAsset({ kind: 'audio', name, duration: 4, ...overrides })

  function docWithTracks(tracks: Doc['project']['tracks'], media: MediaAsset[]): Doc {
    const doc = createDoc()
    return { project: { ...doc.project, tracks }, media }
  }

  it('ignores an offline image beside an online audio clip', () => {
    const image = createMediaAsset({
      kind: 'image',
      name: 'still.png',
      duration: 0,
      url: '',
      missing: true,
    })
    const song = audioAsset('song.mp3', { url: 'blob:song' })
    const doc = docWithTracks(
      [
        createTrack('audio', 1, {
          id: 'a1',
          clips: [createClip({ id: 'song', mediaId: song.id, duration: 4, audioOnly: true })],
        }),
        createTrack('video', 1, {
          id: 'v1',
          clips: [createClip({ id: 'still', mediaId: image.id, duration: 4 })],
        }),
      ],
      [image, song],
    )
    expect(offlineAudibleMedia(doc)).toEqual([])
  })

  it('ignores an offline video without audio', () => {
    const mute = video('mute.mp4', { url: '', missing: true, hasAudio: false })
    const doc = docWithTracks(
      [createTrack('video', 1, { id: 'v1', clips: [createClip({ mediaId: mute.id })] })],
      [mute],
    )
    expect(offlineAudibleMedia(doc)).toEqual([])
  })

  it('names an offline video that carries embedded audio', () => {
    const movie = video('gone.mp4', { url: '', missing: true, hasAudio: true })
    const doc = docWithTracks(
      [createTrack('video', 1, { id: 'v1', clips: [createClip({ mediaId: movie.id })] })],
      [movie],
    )
    expect(offlineAudibleMedia(doc)).toEqual(['gone.mp4'])
  })

  it('ignores muted, reversed and rate-dropped offline audio', () => {
    const muted = audioAsset('muted.mp3', { missing: true, url: '' })
    const reversed = audioAsset('reversed.mp3', { missing: true, url: '' })
    const ramped = audioAsset('ramped.mp3', { missing: true, url: '' })
    const doc = docWithTracks(
      [
        createTrack('audio', 1, {
          id: 'a1',
          clips: [
            createClip({ mediaId: muted.id, audioOnly: true, muted: true }),
            createClip({ mediaId: reversed.id, audioOnly: true, reverse: true }),
            createClip({
              mediaId: ramped.id,
              audioOnly: true,
              keyframes: {
                timeScale: [
                  { time: 0, value: 1 },
                  { time: 4, value: 2 },
                ],
              },
            }),
          ],
        }),
      ],
      [muted, reversed, ramped],
    )
    expect(offlineAudibleMedia(doc)).toEqual([])
  })

  it('ignores offline audio on a muted or soloed-out track', () => {
    const hushed = audioAsset('hushed.mp3', { missing: true, url: '' })
    const soloed = audioAsset('soloed.mp3', { url: 'blob:soloed' })
    const doc = docWithTracks(
      [
        createTrack('audio', 1, {
          id: 'a1',
          muted: true,
          clips: [createClip({ mediaId: hushed.id, audioOnly: true })],
        }),
        createTrack('audio', 2, {
          id: 'a2',
          solo: true,
          clips: [createClip({ mediaId: soloed.id, audioOnly: true })],
        }),
      ],
      [hushed, soloed],
    )
    expect(offlineAudibleMedia(doc)).toEqual([])
  })

  it('names an offline carrier whose video half is online', () => {
    const carrier = audioAsset('voice.mp3', { missing: true, url: '' })
    const picture = video('picture.mp4', { url: 'blob:picture', hasAudio: true })
    const doc = docWithTracks(
      [
        createTrack('video', 1, {
          id: 'v1',
          clips: [createClip({ mediaId: picture.id, linkId: 'g' })],
        }),
        createTrack('audio', 1, {
          id: 'a1',
          clips: [createClip({ mediaId: carrier.id, audioOnly: true, linkId: 'g' })],
        }),
      ],
      [carrier, picture],
    )
    expect(offlineAudibleMedia(doc)).toEqual(['voice.mp3'])
  })

  it('ignores offline audio inside a muted container', () => {
    const song = audioAsset('nested.mp3', { missing: true, url: '' })
    const doc = docWithTracks(
      [
        createTrack('video', 1, {
          id: 'v1',
          clips: [createClip({ id: 'comp', sequenceId: 'seq1', duration: 4, muted: true })],
        }),
      ],
      [song],
    )
    doc.project.sequences = [
      {
        id: 'seq1',
        name: 'Nested',
        tracks: [
          createTrack('audio', 1, {
            clips: [createClip({ mediaId: song.id, audioOnly: true })],
          }),
        ],
      },
    ]
    expect(offlineAudibleMedia(doc)).toEqual([])
  })

  it('treats an unresolved media reference as possibly audible', () => {
    const doc = docWithTracks(
      [createTrack('audio', 1, { clips: [createClip({ mediaId: 'ghost', audioOnly: true })] })],
      [],
    )
    expect(offlineAudibleMedia(doc)).toEqual(['ghost'])
  })

  it('ignores a nested offline clip outside its container span', () => {
    const inside = audioAsset('inside.mp3', { missing: true, url: '' })
    const outside = audioAsset('outside.mp3', { missing: true, url: '' })
    const doc = docWithTracks(
      [
        createTrack('video', 1, {
          id: 'v1',
          clips: [createClip({ id: 'comp', sequenceId: 'seq1', start: 2, duration: 2 })],
        }),
      ],
      [inside, outside],
    )
    doc.project.sequences = [
      {
        id: 'seq1',
        name: 'Nested',
        tracks: [
          createTrack('audio', 1, {
            id: 'a1',
            clips: [
              createClip({ id: 'in', mediaId: inside.id, audioOnly: true, start: 0, duration: 4 }),
              createClip({
                id: 'out',
                mediaId: outside.id,
                audioOnly: true,
                start: 4,
                duration: 2,
              }),
            ],
          }),
        ],
      },
    ]
    // The container is 2s..4s. The first child spans into it; the second starts
    // at 6s, after the container ends, so the mix never schedules it.
    expect(offlineAudibleMedia(doc)).toEqual(['inside.mp3'])
  })
})

describe('offline media across compound clips (0.8.1)', () => {
  function compoundDoc(media: MediaAsset[]): Doc {
    const doc = buildDoc(media, [
      createClip({ id: 'comp', sequenceId: 'seq1', start: 0, duration: 4 }),
    ])
    doc.project.sequences = [
      {
        id: 'seq1',
        name: 'C',
        tracks: [
          createTrack('video', 1, {
            clips: [createClip({ id: 'child', mediaId: media[0].id, start: 0, duration: 4 })],
          }),
        ],
      },
    ]
    return doc
  }

  it('names a nested offline clip only while its container is active', () => {
    const asset = video('nested.mp4', { url: '', missing: true })
    const doc = compoundDoc([asset])
    expect(offlineMediaAt(doc, 1)).toEqual(['nested.mp4'])
    expect(offlineMediaAt(doc, 5)).toEqual([])
  })

  it('hasOfflineMedia sees a nested offline clip', () => {
    const asset = video('nested.mp4', { url: '', missing: true })
    expect(hasOfflineMedia(compoundDoc([asset]))).toBe(true)
  })

  it('ignores an offline clip in an unreachable (orphan) sequence', () => {
    const asset = video('orphan.mp4', { url: '', missing: true })
    const doc = buildDoc([asset], [])
    // A sequence no root container references: export never renders it.
    doc.project.sequences = [
      {
        id: 'orphan',
        name: 'Orphan',
        tracks: [
          createTrack('video', 1, {
            clips: [createClip({ mediaId: asset.id, start: 0, duration: 4 })],
          }),
        ],
      },
    ]
    expect(hasOfflineMedia(doc)).toBe(false)
  })
})
