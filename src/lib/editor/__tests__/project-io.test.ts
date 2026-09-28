import { describe, expect, it } from 'vitest'
import { loadProjectFile } from '../project-io'
import { createDoc } from '../factories'
import { serializeDoc } from '../serialization'

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
