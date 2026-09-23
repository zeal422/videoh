import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { createClip, createDoc, createMediaAsset, createTextClip, createTrack } from '../factories'
import { offlineMediaAt } from '../offline'
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
    expect(panel).toMatch(/offlineMediaAt\(doc, playhead\)/)
    expect(panel).toMatch(/data-testid="media-offline-overlay"/)
    expect(panel).toMatch(/Media offline/)
    expect(panel).toMatch(/Relink in the Media bin/)
  })
})
