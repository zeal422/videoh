import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  bumpProjectGeneration,
  installProject,
  isCurrentProjectLoad,
  loadProjectFile,
  openProjectFile,
} from '../project-io'
import { createDoc } from '../factories'
import { parseSerializedDoc, serializeDoc } from '../serialization'
import { useEditorStore } from '../store'

const toastMock = vi.hoisted(() => vi.fn())

vi.mock('@/hooks/use-toast', () => ({ toast: toastMock }))

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
    const { doc } = await loadProjectFile(file)
    const fresh = createDoc()
    expect(doc.project.name).toBe(fresh.project.name)
    expect(doc.project.tracks.length).toBe(fresh.project.tracks.length)
    expect(doc.media).toEqual([])
  })

  it('returns the timeline migration warnings with the parsed doc', async () => {
    const json = JSON.stringify({
      version: 1,
      project: {
        tracks: [{ kind: 'video', clips: [{ id: 'long', start: 0, duration: 30 * 3600 }] }],
      },
    })
    const file = new File([json], 'legacy.veproj.json', { type: 'application/json' })
    const { doc, warnings } = await loadProjectFile(file)
    expect(doc.project.tracks[0].clips[0].duration).toBe(86_400)
    expect(warnings).toEqual([expect.stringContaining('24-hour')])
  })

  it('rejects non-JSON text with the parse error, not a validation error', async () => {
    const file = new File(['{nope'], 'broken.veproj.json', { type: 'application/json' })
    await expect(loadProjectFile(file)).rejects.toThrow('File is not valid JSON')
  })
})

describe('openProjectFile warning surface', () => {
  it('shows the migration warning in the project-loaded toast', async () => {
    toastMock.mockClear()
    const json = JSON.stringify({
      version: 1,
      project: {
        tracks: [{ kind: 'video', clips: [{ id: 'long', start: 0, duration: 30 * 3600 }] }],
      },
    })
    const file = new File([json], 'legacy.veproj.json', { type: 'application/json' })
    await openProjectFile(file)
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Project loaded',
        description: expect.stringContaining('24-hour'),
      }),
    )
  })

  it('reports a failure after installation started even though the generation moved', async () => {
    const original = useEditorStore.getState().replaceDoc
    const json = JSON.stringify(serializeDoc(createDoc()), null, 2)
    const file = new File([json], 'install-fail.veproj.json', { type: 'application/json' })
    useEditorStore.setState({
      replaceDoc: () => {
        throw new Error('install exploded')
      },
    })
    try {
      toastMock.mockClear()
      await openProjectFile(file)
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Load failed', description: 'install exploded' }),
      )
    } finally {
      useEditorStore.setState({ replaceDoc: original })
    }
  })

  it('separates the relink notice from the migration warning', async () => {
    toastMock.mockClear()
    const json = JSON.stringify({
      version: 1,
      project: {
        tracks: [
          {
            kind: 'video',
            clips: [{ id: 'long', mediaId: 'm1', start: 0, duration: 30 * 3600 }],
          },
        ],
      },
      media: [{ id: 'm1', kind: 'video', name: 'a.mp4', duration: 10 }],
    })
    const file = new File([json], 'legacy-media.veproj.json', { type: 'application/json' })
    await openProjectFile(file)
    const description = toastMock.mock.calls[0]?.[0]?.description as string
    expect(description).toContain('1 media file(s) need relinking. Trimmed')
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

describe('installProject (runtime)', () => {
  it('bumps the epoch, clears the restore banner, and invalidates the previous load', () => {
    const before = useEditorStore.getState()
    const restoreDoc = createDoc()
    const nextDoc = createDoc()
    nextDoc.project.name = 'installed-project'
    const epochBefore = before.projectEpoch
    const previousLoadId = bumpProjectGeneration()
    useEditorStore.setState({ pendingRestore: { doc: restoreDoc, warnings: [] } })
    try {
      installProject(nextDoc)
      const after = useEditorStore.getState()
      expect(after.pendingRestore).toBeNull()
      expect(after.projectEpoch).toBeGreaterThan(epochBefore)
      expect(after.doc).toBe(nextDoc)
      expect(isCurrentProjectLoad(previousLoadId)).toBe(false)
    } finally {
      useEditorStore.setState({
        doc: before.doc,
        projectEpoch: before.projectEpoch,
        pendingRestore: before.pendingRestore,
      })
    }
  })
})
