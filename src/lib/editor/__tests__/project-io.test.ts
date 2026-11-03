import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadProjectFile } from '../project-io'
import { createDoc } from '../factories'
import { parseSerializedDoc, serializeDoc } from '../serialization'

/**
 * loadProjectFile is the File > Open / toolbar-open entry: it receives the
 * File object a picker (or battery upload) chose. It must parse the file's
 * JSON text. The regression: it handed the raw TEXT to deserializeDoc, which
 * rejected every real file with "root is not an object" while the unit tests
 * (which call deserializeDoc with objects) stayed green. Autosave restore
 * used parseSerializedDoc and worked, so only the picker paths were broken.
 */

describe('loadProjectFile (picker path)', () => {
  it('round-trips a saved project FILE, not just an already-parsed object', async () => {
    const json = JSON.stringify(serializeDoc(createDoc()), null, 2)
    const file = new File([json], 'roundtrip.veproj.json', { type: 'application/json' })
    const doc = await loadProjectFile(file)
    const fresh = createDoc()
    expect(doc.project.name).toBe(fresh.project.name)
    expect(doc.project.tracks.length).toBe(fresh.project.tracks.length)
    expect(doc.media).toEqual([])
  })

  it('rejects non-JSON text with the parse error, not a validation error', async () => {
    const file = new File(['{nope'], 'broken.veproj.json', { type: 'application/json' })
    await expect(loadProjectFile(file)).rejects.toThrow('File is not valid JSON')
  })
})

describe('parity fixture (e2e/fixtures/editor-parity.veproj.json)', () => {
  it('parses to the selected demo structure the screenshots and battery rely on', () => {
    const raw = readFileSync(join(process.cwd(), 'e2e/fixtures/editor-parity.veproj.json'), 'utf8')
    const { doc, missingMediaIds } = parseSerializedDoc(raw)

    expect(doc.project.name).toBe('Editor Parity Demo')
    expect(doc.project.tracks).toHaveLength(9)
    expect(doc.project.tracks.map((track) => track.kind)).toEqual([
      'video',
      'video',
      'video',
      'video',
      'video',
      'audio',
      'audio',
      'audio',
      'audio',
    ])
    expect(doc.project.tracks.map((track) => track.clips.length)).toEqual([
      1, 2, 4, 3, 3, 3, 1, 1, 1,
    ])
    expect(doc.media.map((asset) => asset.name)).toEqual([
      'sample-video.mp4',
      'sample-audio.mp3',
      'sample-image.png',
    ])
    // The fixture stores no object URLs: every asset hydrates offline until
    // the user relinks it from the media bin.
    expect(missingMediaIds).toHaveLength(3)
    expect(doc.media.every((asset) => asset.missing === true)).toBe(true)
  })
})
