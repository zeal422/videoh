/**
 * Tests for the autosave persistence layer (persistence.ts) with a mocked
 * localStorage + fake timers: debounced writes, doc-change-only triggering,
 * and corrupt-payload rejection.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useEditorStore } from '../store'
import { createDoc, createMediaAsset } from '../factories'
import { serializeDoc } from '../serialization'

const storage = new Map<string, string>()

const localStorageMock = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
  clear: () => void storage.clear(),
}

beforeEach(() => {
  storage.clear()
  vi.useFakeTimers()
  vi.stubGlobal('localStorage', localStorageMock)
  useEditorStore.setState({
    doc: createDoc(),
    past: [],
    future: [],
    selection: null,
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('autosave', () => {
  it('writes the serialized doc after the debounce, without object URLs', async () => {
    const { initAutosave, writeAutosave, readValidAutosave, clearAutosave } =
      await import('../persistence')
    const unsubscribe = initAutosave()
    try {
      const asset = createMediaAsset({
        kind: 'audio',
        name: 'x.mp3',
        duration: 5,
        url: 'blob:x',
      })
      useEditorStore.getState().apply({ type: 'addMediaAsset', asset })

      // Not yet written (debounce pending)
      expect(storage.size).toBe(0)
      vi.advanceTimersByTime(1000)
      expect(storage.size).toBe(1)

      const saved = readValidAutosave()
      expect(saved).toBeTruthy()
      expect(saved).not.toContain('blob:x')
      expect(JSON.parse(saved!).media[0].name).toBe('x.mp3')

      clearAutosave()
      expect(readValidAutosave()).toBeNull()
    } finally {
      unsubscribe()
    }
    void writeAutosave
  })

  it('ignores playhead/zoom churn (doc unchanged → no write scheduled)', async () => {
    const { initAutosave } = await import('../persistence')
    const unsubscribe = initAutosave()
    try {
      useEditorStore.getState().setPlayhead(5)
      useEditorStore.getState().setPxPerSec(120)
      vi.advanceTimersByTime(3000)
      expect(storage.size).toBe(0)
    } finally {
      unsubscribe()
    }
  })

  it('skips transient frames and saves once on commit', async () => {
    const { initAutosave } = await import('../persistence')
    const { createClip } = await import('../factories')
    let writes = 0
    const countingStorage = {
      ...localStorageMock,
      setItem: (key: string, value: string) => {
        writes++
        localStorageMock.setItem(key, value)
      },
    }
    vi.stubGlobal('localStorage', countingStorage)
    const unsubscribe = initAutosave()
    try {
      const asset = createMediaAsset({ kind: 'video', name: 'v.mp4', duration: 10, url: 'blob:v' })
      const doc = useEditorStore.getState().doc
      const trackId = doc.project.tracks.filter((t) => t.kind === 'video')[0].id
      useEditorStore.getState().apply([
        { type: 'addMediaAsset', asset },
        {
          type: 'addClip',
          trackId,
          clip: createClip({ mediaId: asset.id, duration: 4 }),
        },
      ])
      const clipId = useEditorStore
        .getState()
        .doc.project.tracks.flatMap((t) => t.clips)
        .find((c) => c.mediaId === asset.id)!.id

      // flush the save scheduled by the initial apply
      vi.advanceTimersByTime(1000)
      const writesAfterSetup = writes
      expect(writesAfterSetup).toBe(1)

      // drag: transient updates must not schedule saves
      const store = useEditorStore.getState()
      store.beginTransient()
      for (let i = 1; i <= 10; i++) {
        store.applyTransient({ type: 'moveClip', clipId, trackId, start: i * 0.1 })
        vi.advanceTimersByTime(200)
      }
      expect(writes).toBe(writesAfterSetup)
      store.commitTransient()
      vi.advanceTimersByTime(1000)
      expect(writes).toBe(writesAfterSetup + 1)
      const saved = JSON.parse(storage.get('web-video-editor:autosave:v1')!)
      expect(
        saved.project.tracks.flatMap((t: { clips: { start: number }[] }) => t.clips)[0].start,
      ).toBe(1)
    } finally {
      unsubscribe()
    }
  })

  it('writeAutosave survives a throwing localStorage (quota)', async () => {
    const { writeAutosave } = await import('../persistence')
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
      removeItem: () => undefined,
      clear: () => undefined,
    })
    expect(writeAutosave(useEditorStore.getState().doc)).toBe(false)
  })

  it('readValidAutosave rejects corrupt payloads', async () => {
    const { readValidAutosave } = await import('../persistence')
    localStorageMock.setItem('web-video-editor:autosave:v1', '{broken json')
    expect(readValidAutosave()).toBeNull()
    localStorageMock.setItem(
      'web-video-editor:autosave:v1',
      JSON.stringify(serializeDoc(createDoc())),
    )
    expect(readValidAutosave()).toBeTruthy()
  })
})
