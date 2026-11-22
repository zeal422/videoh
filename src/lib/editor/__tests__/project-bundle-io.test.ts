import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  BundleExportError,
  BundleImportError,
  assertBundleFitsBlob,
  bumpProjectGeneration,
  discardPendingBundleExport,
  exportProjectBundle,
  openBundleFile,
  prepareProjectBundle,
} from '../project-io'
import { createFakeOpfs, FakeLockManager, type FakeOpfs } from './mocks/opfs'
import { createClip, createDoc } from '../factories'
import { parseSerializedDoc, serializeDoc, SERIALIZATION_VERSION } from '../serialization'
import {
  deleteMediaFile,
  ensureProjectMedia,
  readMediaClaimShards,
  readMediaFile,
  recoverOrphanedClaimShards,
  sha256Hex,
  writeMediaClaim,
  writeMediaFile,
} from '../media/media-store'
import {
  AUTOSAVE_LOCK_NAME,
  hasPendingInstall,
  initAutosave,
  markInstallPending,
  queueAutosaveRetry,
  resetAutosaveCoordinationForTests,
  readAutosave,
} from '../persistence'
import {
  clearInstalledRegistry,
  isInstallHistoryLost,
  newInstallId,
  readInstalledRegistry,
  readPendingInstallRecords,
  recordInstalledImport,
} from '../media/installed-registry'
import { fontFamilyForId } from '../fonts'
import {
  BUNDLE_MANIFEST_PATH,
  BUNDLE_MAX_BLOB_BYTES,
  BUNDLE_MAX_ENTRY_BYTES,
  BUNDLE_PROJECT_PATH,
  BUNDLE_VERSION,
} from '../project-bundle'
import { FONT_FILE_MAX_BYTES } from '../constants'
import { zipBlob } from '../bundle-zip'
import { useEditorStore } from '../store'
import type { BundleManifest } from '../project-bundle'
import type { Doc, MediaAsset, ProjectFont } from '../types'

const probeState = vi.hoisted(() => ({
  duration: 0,
  fail: false,
  calls: 0,
  hold: null as Promise<void> | null,
}))
const serializeState = vi.hoisted(() => ({ fail: false, unique: false, stamp: 0 }))

vi.mock('../serialization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../serialization')>()
  return {
    ...actual,
    serializeDoc: (doc: Doc) => {
      if (serializeState.fail) throw new Error('serialize failed')
      return actual.serializeDoc(
        doc,
        serializeState.unique
          ? new Date(1_700_000_000_000 + serializeState.stamp++).toISOString()
          : undefined,
      )
    },
  }
})

const zipReads = vi.hoisted(() => ({ paths: [] as string[] }))
vi.mock('../bundle-zip', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../bundle-zip')>()
  return {
    ...actual,
    readZipEntry: (blob: Blob, entry: Parameters<typeof actual.readZipEntry>[1]) => {
      zipReads.paths.push(entry.path)
      return actual.readZipEntry(blob, entry)
    },
  }
})

vi.mock('../media/probe', () => ({
  importFile: vi.fn(async (file: File) => {
    probeState.calls += 1
    if (probeState.hold) await probeState.hold
    if (probeState.fail) throw new Error('probe failed')
    return {
      id: 'media_probed',
      name: file.name,
      kind: file.type.startsWith('audio/') ? 'audio' : 'video',
      duration: probeState.duration,
      width: 640,
      height: 360,
      hasAudio: true,
      url: `blob:probed/${file.name}`,
      file,
    }
  }),
}))

const PROJECT = 'proj_bundle'
const VIDEO_BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
const FONT_BYTES = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 1, 2, 3, 4, 5])
const FONT_ID = 'font_123e4567-e89b-12d3-a456-426614174000'

let opfs: FakeOpfs
const storage = new Map<string, string>()

function localStorageMock() {
  return {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
    clear: () => void storage.clear(),
  }
}

const sessionStorageMock = localStorageMock()

function pendingFor(projectId: string) {
  return readPendingInstallRecords().find((record) => record.projectId === projectId) ?? null
}

function bundleDoc(media: MediaAsset[], fonts: ProjectFont[] = []): Doc {
  const doc = createDoc()
  doc.project.id = PROJECT
  doc.project.name = 'Bundle Demo'
  doc.project.fonts = fonts
  doc.media = media
  return doc
}

async function videoAsset(): Promise<MediaAsset> {
  return {
    id: 'media_a',
    name: 'clip.mp4',
    kind: 'video',
    duration: 3,
    width: 640,
    height: 360,
    url: 'blob:old',
    contentHash: await sha256Hex(VIDEO_BYTES),
    file: new File([VIDEO_BYTES], 'clip.mp4', { type: 'video/mp4' }),
  }
}

function projectFont(): ProjectFont {
  return {
    id: FONT_ID,
    name: 'Brand.woff2',
    family: fontFamilyForId(FONT_ID),
    contentHash: '',
  }
}

async function fontFont(): Promise<ProjectFont> {
  return { ...projectFont(), contentHash: await sha256Hex(FONT_BYTES) }
}

async function bundleFile(doc: Doc): Promise<File> {
  const prepared = await prepareProjectBundle(doc, { confirmMissingFonts: true })
  if (prepared.status !== 'prepared') throw new Error('expected a prepared bundle')
  return new File([await zipBlob(prepared.bundle.entries)], 'bundle.vebundle.zip', {
    type: 'application/zip',
  })
}

function manifestFor(project: Doc, overrides: Partial<BundleManifest> = {}): BundleManifest {
  return {
    bundleVersion: BUNDLE_VERSION,
    createdAt: '2026-11-14T12:00:00.000Z',
    project: BUNDLE_PROJECT_PATH,
    assets: project.media.map((asset) => ({
      id: asset.id,
      path: `media/${asset.id}/${asset.name}`,
      name: asset.name,
      type: 'video/mp4',
      size: VIDEO_BYTES.length,
      sha256: asset.contentHash!,
    })),
    fonts: (project.project.fonts ?? []).map((font) => ({
      id: font.id,
      path: `fonts/${font.id}/${font.name}`,
      name: font.name,
      size: FONT_BYTES.length,
      sha256: font.contentHash ?? ('' as string),
    })),
    ...overrides,
  }
}

async function handmadeBundle(
  manifest: BundleManifest,
  project: Doc,
  entries: { path: string; bytes: Uint8Array }[] = [],
  projectVersion = 8,
): Promise<File> {
  const json = JSON.parse(JSON.stringify(serializeDoc(project))) as Record<string, unknown>
  json.version = projectVersion
  return new File(
    [
      await zipBlob([
        {
          path: BUNDLE_MANIFEST_PATH,
          data: new Blob([JSON.stringify(manifest)]),
        },
        { path: BUNDLE_PROJECT_PATH, data: new Blob([JSON.stringify(json)]) },
        ...entries.map((entry) => ({
          path: entry.path,
          data: new Blob([entry.bytes as BlobPart]),
        })),
      ]),
    ],
    'handmade.vebundle.zip',
    { type: 'application/zip' },
  )
}

beforeEach(() => {
  storage.clear()
  vi.stubGlobal('localStorage', localStorageMock())
  vi.stubGlobal('sessionStorage', sessionStorageMock)
  opfs = createFakeOpfs()
  vi.stubGlobal('navigator', {
    storage: { getDirectory: async () => opfs.root },
    locks: new FakeLockManager(),
  })
  resetAutosaveCoordinationForTests()
  clearInstalledRegistry()
  useEditorStore.setState({
    doc: createDoc(),
    past: [],
    future: [],
    projectEpoch: 0,
    pendingRestore: null,
    autosaveStatus: 'idle',
    autosavedAt: null,
    autosavePaused: false,
  })
  probeState.duration = 0
  probeState.fail = false
  probeState.calls = 0
  probeState.hold = null
  serializeState.fail = false
  serializeState.unique = false
  serializeState.stamp = 0
  zipReads.paths.length = 0
})

afterEach(() => {
  resetAutosaveCoordinationForTests()
  vi.unstubAllGlobals()
})

describe('bundle export preparation (0.28.0)', () => {
  it('bundles stored media and a project font', async () => {
    const font = await fontFont()
    await writeMediaFile(PROJECT, font.contentHash, new File([FONT_BYTES], 'Brand.woff2'), 'fonts')
    const asset = await videoAsset()
    const doc = bundleDoc([asset], [font])
    const prepared = await prepareProjectBundle(doc)
    expect(prepared.status).toBe('prepared')
    if (prepared.status !== 'prepared') return
    const paths = prepared.bundle.entries.map((entry) => entry.path)
    expect(paths).toContain(BUNDLE_MANIFEST_PATH)
    expect(paths).toContain(BUNDLE_PROJECT_PATH)
    expect(paths).toContain(`media/media_a/clip.mp4`)
    expect(paths).toContain(`fonts/${FONT_ID}/Brand.woff2`)
    const manifestEntry = prepared.bundle.entries[0]!
    const manifest = JSON.parse(await manifestEntry.data.text()) as BundleManifest
    expect(manifest.assets[0]?.sha256).toBe(asset.contentHash)
    expect(manifest.fonts[0]?.sha256).toBe(font.contentHash)
  })

  it('refuses the in-memory fallback above the blob budget before building', () => {
    expect(() => assertBundleFitsBlob(BUNDLE_MAX_BLOB_BYTES)).not.toThrow()
    expect(() => assertBundleFitsBlob(BUNDLE_MAX_BLOB_BYTES + 1)).toThrow('cannot stream the save')
  })

  it('counts ZIP metadata in the in-memory budget estimate', async () => {
    const prepared = await prepareProjectBundle(bundleDoc([]))
    if (prepared.status !== 'prepared') throw new Error('expected a prepared bundle')
    expect(prepared.bundle.bytes).toBe((await zipBlob(prepared.bundle.entries)).size)
  })

  it('refuses a project with more entries than the bundle cap before reading bytes', async () => {
    const media = Array.from({ length: 4096 }, (_, index) => ({
      id: `media_${index}`,
      name: `clip-${index}.mp4`,
      kind: 'video' as const,
      duration: 1,
      width: 1,
      height: 1,
      url: '',
    }))
    await expect(prepareProjectBundle(bundleDoc(media))).rejects.toThrow('more than 4096')
  })

  it('refuses the export when stored sizes cannot be listed', async () => {
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: async () => {
          throw new Error('storage unavailable')
        },
      },
    })
    await expect(prepareProjectBundle(bundleDoc([]))).rejects.toThrow('Cannot inspect')
  })

  it('refuses an oversized session file before hashing it', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'big.mp4', { type: 'video/mp4' })
    Object.defineProperty(file, 'size', { value: BUNDLE_MAX_ENTRY_BYTES + 1 })
    let reads = 0
    const original = file.arrayBuffer.bind(file)
    Object.defineProperty(file, 'arrayBuffer', {
      value: async () => {
        reads += 1
        return original()
      },
    })
    const asset: MediaAsset = {
      id: 'media_big',
      name: 'big.mp4',
      kind: 'video',
      duration: 1,
      width: 1,
      height: 1,
      url: '',
      file,
    }
    await expect(prepareProjectBundle(bundleDoc([asset]))).rejects.toThrow('per-entry limit')
    expect(reads).toBe(0)
  })

  it('refuses an oversized stored entry before hashing it', async () => {
    const bytes = new Uint8Array([9, 9, 9])
    const hash = await sha256Hex(bytes)
    expect(await ensureProjectMedia(PROJECT)).toBe('ready')
    opfs.files.set(`/${PROJECT}/${hash}`, {
      bytes,
      type: 'video/mp4',
      size: BUNDLE_MAX_ENTRY_BYTES + 1,
    })
    const asset: MediaAsset = {
      id: 'media_big',
      name: 'big.mp4',
      kind: 'video',
      duration: 1,
      width: 1,
      height: 1,
      url: '',
      contentHash: hash,
    }
    await expect(prepareProjectBundle(bundleDoc([asset]))).rejects.toThrow('per-entry limit')
  })

  it('keeps the largest stored size when media and fonts share a hash', async () => {
    const bytes = new Uint8Array([0x77, 0x4f, 0x46, 0x32])
    const hash = await sha256Hex(bytes)
    expect(await ensureProjectMedia(PROJECT)).toBe('ready')
    // A damaged media copy that reports an oversized length under the same
    // hash as a small, valid font copy.
    opfs.files.set(`/${PROJECT}/${hash}`, {
      bytes: new Uint8Array([1, 2, 3]),
      type: 'video/mp4',
      size: BUNDLE_MAX_ENTRY_BYTES + 1,
    })
    await writeMediaFile(PROJECT, hash, new File([bytes], 'Brand.woff2'), 'fonts')
    const font: ProjectFont = {
      id: FONT_ID,
      name: 'Brand.woff2',
      family: fontFamilyForId(FONT_ID),
      contentHash: hash,
    }
    const asset: MediaAsset = {
      id: 'media_shared',
      name: 'clip.mp4',
      kind: 'video',
      duration: 1,
      width: 1,
      height: 1,
      url: '',
      contentHash: hash,
    }
    await expect(prepareProjectBundle(bundleDoc([asset], [font]))).rejects.toThrow(
      'per-entry limit',
    )
  })

  it('refuses a project with a media asset that has no bytes', async () => {
    const asset = await videoAsset()
    delete asset.file
    const doc = bundleDoc([asset])
    await expect(prepareProjectBundle(doc)).rejects.toThrow(BundleExportError)
    await expect(prepareProjectBundle(doc)).rejects.toThrow('no stored or session copy')
  })

  it('refuses a session file whose bytes do not match the recorded hash', async () => {
    const asset = await videoAsset()
    asset.file = new File([new Uint8Array([9, 9, 9])], 'clip.mp4', { type: 'video/mp4' })
    const doc = bundleDoc([asset])
    await expect(prepareProjectBundle(doc)).rejects.toThrow('do not match the recorded hash')
  })

  it('refuses a stored font above the 8 MiB font cap before reading it', async () => {
    const bytes = new Uint8Array([0x77, 0x4f, 0x46, 0x32])
    const hash = await sha256Hex(bytes)
    expect(await ensureProjectMedia(PROJECT)).toBe('ready')
    opfs.put(`/${PROJECT}/fonts/${hash}`, bytes, 'font/woff2')
    opfs.files.get(`/${PROJECT}/fonts/${hash}`)!.size = FONT_FILE_MAX_BYTES + 1
    const font: ProjectFont = {
      id: FONT_ID,
      name: 'Brand.woff2',
      family: fontFamilyForId(FONT_ID),
      contentHash: hash,
    }
    await expect(prepareProjectBundle(bundleDoc([], [font]))).rejects.toThrow(/font.*8 MB/i)
  })

  it('still exports a font at the cap and media above 8 MiB', async () => {
    const fontBytes = new Uint8Array([0x77, 0x4f, 0x46, 0x32])
    const fontHash = await sha256Hex(fontBytes)
    expect(await ensureProjectMedia(PROJECT)).toBe('ready')
    opfs.files.set(`/${PROJECT}/fonts/${fontHash}`, {
      bytes: fontBytes,
      type: 'font/woff2',
      size: FONT_FILE_MAX_BYTES,
    })
    const font: ProjectFont = {
      id: FONT_ID,
      name: 'Brand.woff2',
      family: fontFamilyForId(FONT_ID),
      contentHash: fontHash,
    }

    const asset = await videoAsset()
    const assetHash = asset.contentHash!
    opfs.files.set(`/${PROJECT}/${assetHash}`, {
      bytes: VIDEO_BYTES,
      type: 'video/mp4',
      size: 9 * 1024 * 1024,
    })
    asset.file = undefined

    const prepared = await prepareProjectBundle(bundleDoc([asset], [font]))
    expect(prepared.status).toBe('prepared')
  })

  it('asks before bundling a missing font the project uses, then warns', async () => {
    const font = await fontFont()
    const doc = bundleDoc([], [font])
    doc.project.tracks[0]!.clips.push({
      id: 'clip_text',
      start: 0,
      duration: 2,
      inPoint: 0,
      text: 'Title',
      style: {
        fontSize: 48,
        color: '#ffffff',
        fontFamily: font.family,
        bold: false,
        italic: false,
        align: 'center',
        x: 0.5,
        y: 0.5,
        shadow: false,
      },
    })
    const first = await prepareProjectBundle(doc)
    expect(first).toEqual({ status: 'needs-font-confirmation', fonts: ['Brand.woff2'] })
    const confirmed = await prepareProjectBundle(doc, { confirmMissingFonts: true })
    expect(confirmed.status).toBe('prepared')
    if (confirmed.status === 'prepared') {
      expect(confirmed.bundle.warnings.join(' ')).toContain('falls back to Arial')
    }
  })

  it('leaves an unused missing font out with a warning only', async () => {
    const font = await fontFont()
    const prepared = await prepareProjectBundle(bundleDoc([], [font]))
    expect(prepared.status).toBe('prepared')
    if (prepared.status === 'prepared') {
      expect(prepared.bundle.entries.map((entry) => entry.path)).not.toContain(
        `fonts/${FONT_ID}/Brand.woff2`,
      )
      expect(prepared.bundle.warnings.join(' ')).toContain('left out')
    }
  })
})

describe('bundle export picker (0.28.0)', () => {
  it('opens the picker before preparation and reuses it after font confirmation', async () => {
    const writes: Uint8Array[] = []
    let closed = false
    const handle = {
      createWritable: async () => ({
        write: async (chunk: Uint8Array) => {
          writes.push(chunk)
        },
        close: async () => {
          closed = true
        },
        abort: async () => undefined,
      }),
    }
    const picker = vi.fn(async () => handle)
    vi.stubGlobal('window', { showSaveFilePicker: picker })
    const font = await fontFont()
    const doc = bundleDoc([], [font])
    doc.project.tracks[0]!.clips.push({
      id: 'clip_text',
      start: 0,
      duration: 2,
      inPoint: 0,
      text: 'Title',
      style: {
        fontSize: 48,
        color: '#ffffff',
        fontFamily: font.family,
        bold: false,
        italic: false,
        align: 'center',
        x: 0.5,
        y: 0.5,
        shadow: false,
      },
    })
    useEditorStore.setState({ doc })

    const first = await exportProjectBundle()
    expect(first).toEqual({ status: 'needs-font-confirmation', fonts: ['Brand.woff2'] })
    expect(picker).toHaveBeenCalledTimes(1)

    const second = await exportProjectBundle({ confirmMissingFonts: true })
    expect(second.status).toBe('saved')
    expect(picker).toHaveBeenCalledTimes(1)
    expect(closed).toBe(true)
    expect(writes.length).toBeGreaterThan(0)
    discardPendingBundleExport()
  })

  it('does not reuse a font-confirmation handle for another project', async () => {
    const writesA: Uint8Array[] = []
    const writesB: Uint8Array[] = []
    const handleFor = (writes: Uint8Array[]) => ({
      createWritable: async () => ({
        write: async (chunk: Uint8Array) => {
          writes.push(chunk)
        },
        close: async () => undefined,
        abort: async () => undefined,
      }),
    })
    const picker = vi
      .fn()
      .mockResolvedValueOnce(handleFor(writesA))
      .mockResolvedValueOnce(handleFor(writesB))
    vi.stubGlobal('window', { showSaveFilePicker: picker })
    const font = await fontFont()
    const doc = bundleDoc([], [font])
    doc.project.tracks[0]!.clips.push({
      id: 'clip_text',
      start: 0,
      duration: 2,
      inPoint: 0,
      text: 'Title',
      style: {
        fontSize: 48,
        color: '#ffffff',
        fontFamily: font.family,
        bold: false,
        italic: false,
        align: 'center',
        x: 0.5,
        y: 0.5,
        shadow: false,
      },
    })
    useEditorStore.setState({ doc })
    const first = await exportProjectBundle()
    expect(first.status).toBe('needs-font-confirmation')
    // A different project becomes live before the confirmation.
    useEditorStore.setState({ doc: createDoc() })
    const second = await exportProjectBundle({ confirmMissingFonts: true })
    expect(second.status).toBe('saved')
    // The stale destination is discarded and a fresh one is requested.
    expect(picker).toHaveBeenCalledTimes(2)
    expect(writesA).toHaveLength(0)
    expect(writesB.length).toBeGreaterThan(0)
    discardPendingBundleExport()
  })

  it('drops a handle whose menu unmounted before preparation returned', async () => {
    const handle = {
      createWritable: async () => ({
        write: async () => undefined,
        close: async () => undefined,
        abort: async () => undefined,
      }),
    }
    const picker = vi.fn(async () => handle)
    vi.stubGlobal('window', { showSaveFilePicker: picker })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let listed = false
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: async () => {
          listed = true
          await gate
          return opfs.root
        },
      },
      locks: new FakeLockManager(),
    })
    const font = await fontFont()
    const doc = bundleDoc([], [font])
    doc.project.tracks[0]!.clips.push({
      id: 'clip_text',
      start: 0,
      duration: 2,
      inPoint: 0,
      text: 'Title',
      style: {
        fontSize: 48,
        color: '#ffffff',
        fontFamily: font.family,
        bold: false,
        italic: false,
        align: 'center',
        x: 0.5,
        y: 0.5,
        shadow: false,
      },
    })
    useEditorStore.setState({ doc })
    const first = exportProjectBundle()
    await vi.waitFor(() => expect(listed).toBe(true))
    discardPendingBundleExport()
    release()
    expect((await first).status).toBe('needs-font-confirmation')
    expect((await exportProjectBundle({ confirmMissingFonts: true })).status).toBe('saved')
    expect(picker).toHaveBeenCalledTimes(2)
  })
})

describe('bundle import (0.28.0)', () => {
  it('round-trips media and a font, installs once, and writes a claim and the slot', async () => {
    const font = await fontFont()
    expect(await ensureProjectMedia(PROJECT)).toBe('ready')
    await writeMediaFile(PROJECT, font.contentHash, new File([FONT_BYTES], 'Brand.woff2'), 'fonts')
    const asset = await videoAsset()
    const doc = bundleDoc([asset], [font])
    const file = await bundleFile(doc)
    const epochBefore = useEditorStore.getState().projectEpoch
    const outcome = await openBundleFile(file)
    expect(outcome.status).toBe('opened')
    const state = useEditorStore.getState()
    expect(state.projectEpoch).toBe(epochBefore + 1)
    expect(state.doc.project.name).toBe('Bundle Demo')
    expect(state.doc.media).toHaveLength(1)
    expect(state.doc.media[0]?.id).toBe('media_a')
    expect(state.doc.media[0]?.missing).toBe(false)
    expect(state.doc.media[0]?.contentHash).toBe(asset.contentHash)
    expect(state.doc.media[0]?.url).toContain('probed/clip.mp4')
    expect(state.doc.project.fonts?.[0]?.contentHash).toBe(font.contentHash)
    const stored = await readMediaFile(PROJECT, asset.contentHash!)
    expect(stored).not.toBeNull()
    const claims = await readMediaClaimShards(PROJECT)
    expect(claims?.shards).toHaveLength(1)
    expect(claims?.shards[0]?.installId).toMatch(/^install-/)
    expect(readInstalledRegistry()?.[PROJECT]).toHaveLength(1)
    const slot = readAutosave()
    expect(slot).not.toBeNull()
    expect(parseSerializedDoc(slot!).doc.media[0]?.name).toBe('clip.mp4')
  })

  it('imports a font whose display name has no file extension', async () => {
    const font = { ...(await fontFont()), name: 'Brand Font' }
    await writeMediaFile(PROJECT, font.contentHash, new File([FONT_BYTES], 'Brand.woff2'), 'fonts')
    const file = await bundleFile(bundleDoc([], [font]))
    // The bundle must carry the bytes, not rely on this browser's store copy.
    await deleteMediaFile(PROJECT, font.contentHash, 'fonts')
    const outcome = await openBundleFile(file)
    expect(outcome.status).toBe('opened')
    expect(outcome.warnings.join(' ')).not.toContain('damaged')
    expect(useEditorStore.getState().doc.project.fonts?.[0]?.name).toBe('Brand Font')
    expect(await readMediaFile(PROJECT, font.contentHash, 'fonts')).not.toBeNull()
  })

  it('refuses a font-only project whose claims record is missing', async () => {
    const font = await fontFont()
    await writeMediaFile(PROJECT, font.contentHash, new File([FONT_BYTES], 'Brand.woff2'), 'fonts')
    const file = await bundleFile(bundleDoc([], [font]))
    await expect(openBundleFile(file)).rejects.toThrow(
      'stored media records are missing or unreadable',
    )
  })

  it('stops probing remaining entries when a newer open supersedes the import', async () => {
    const first = await videoAsset()
    const second: MediaAsset = { ...first, id: 'media_b', name: 'clip-b.mp4' }
    const file = await bundleFile(bundleDoc([first, second]))
    let release!: () => void
    probeState.hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const pending = openBundleFile(file)
    await vi.waitFor(() => expect(probeState.calls).toBe(1))
    bumpProjectGeneration()
    release()
    const outcome = await pending
    expect(outcome.status).toBe('cancelled')
    expect(probeState.calls).toBe(1)
  })

  it('marks autosave error when the install record cannot be written', async () => {
    const store = localStorageMock()
    const setItem = store.setItem
    store.setItem = (key, value) => {
      if (key === 'web-video-editor:installed-installs:v1') throw new Error('quota')
      setItem(key, value)
    }
    vi.stubGlobal('localStorage', store)
    const asset = await videoAsset()
    const outcome = await openBundleFile(await bundleFile(bundleDoc([asset])))
    expect(outcome.status).toBe('opened')
    expect(outcome.warnings.join(' ')).toContain('install record could not be saved')
    expect(useEditorStore.getState().autosaveStatus).toBe('error')
    expect(useEditorStore.getState().doc.project.id).toBe(PROJECT)
  })

  it('marks autosave error when the imported slot cannot be written', async () => {
    const store = localStorageMock()
    const setItem = store.setItem
    store.setItem = (key, value) => {
      if (key === 'web-video-editor:autosave:v1') throw new Error('quota')
      setItem(key, value)
    }
    vi.stubGlobal('localStorage', store)
    const asset = await videoAsset()
    const outcome = await openBundleFile(await bundleFile(bundleDoc([asset])))
    expect(outcome.status).toBe('opened')
    expect(outcome.warnings.join(' ')).toContain('shared autosave copy could not be updated')
    expect(useEditorStore.getState().autosaveStatus).toBe('error')
  })

  it('round-trips a rich project: shape, group, brand kit, unused asset, and font', async () => {
    const font = await fontFont()
    expect(await ensureProjectMedia(PROJECT)).toBe('ready')
    await writeMediaFile(PROJECT, font.contentHash, new File([FONT_BYTES], 'Brand.woff2'), 'fonts')
    const used = await videoAsset()
    const unused = {
      ...used,
      id: 'media_unused',
      name: 'unused.mp4',
      contentHash: await sha256Hex(new Uint8Array([5, 4, 3, 2])),
      file: new File([new Uint8Array([5, 4, 3, 2])], 'unused.mp4', { type: 'video/mp4' }),
    }
    const doc = bundleDoc([used, unused], [font])
    doc.project.trackGroups = [{ id: 'group_a', name: 'Group A' }]
    doc.project.tracks[0]!.groupId = 'group_a'
    doc.project.brandKit = {
      colors: [{ id: 'color_a', name: 'Brand', value: '#112233' }],
      fontFamilies: [font.family],
    }
    doc.project.tracks[0]!.clips.push({
      id: 'clip_shape',
      start: 0,
      duration: 2,
      inPoint: 0,
      shape: { kind: 'rectangle', fill: '#112233', radius: 8 },
    })
    await openBundleFile(await bundleFile(doc))
    const state = useEditorStore.getState()
    expect(state.doc.media.map((asset) => asset.id).sort()).toEqual(['media_a', 'media_unused'])
    expect(state.doc.media.every((asset) => asset.missing === false)).toBe(true)
    expect(state.doc.project.trackGroups?.[0]?.name).toBe('Group A')
    expect(state.doc.project.tracks[0]?.groupId).toBe('group_a')
    expect(state.doc.project.brandKit?.colors[0]?.value).toBe('#112233')
    expect(state.doc.project.brandKit?.fontFamilies?.[0]).toBe(font.family)
    expect(
      state.doc.project.tracks[0]?.clips.find((clip) => clip.id === 'clip_shape')?.shape?.kind,
    ).toBe('rectangle')
    expect(state.doc.project.fonts?.[0]?.contentHash).toBe(font.contentHash)
  })

  it('keeps the installed project when post-install bookkeeping fails', async () => {
    const asset = await videoAsset()
    const file = await bundleFile(bundleDoc([asset]))
    serializeState.fail = true
    try {
      const outcome = await openBundleFile(file)
      expect(outcome.status).toBe('opened')
      expect(outcome.warnings.join(' ')).toContain('Autosave will retry')
      const state = useEditorStore.getState()
      expect(state.doc.project.id).toBe(PROJECT)
      expect(state.doc.media[0]?.url).toBe('blob:probed/clip.mp4')
      // The install record is pending: the claim must survive recovery.
      const recovery = await recoverOrphanedClaimShards(PROJECT)
      expect(recovery.removed).toBe(0)
    } finally {
      serializeState.fail = false
    }
  })

  it('completes the install registry and slot after a serialization failure clears', async () => {
    vi.useFakeTimers()
    try {
      const asset = await videoAsset()
      const file = await bundleFile(bundleDoc([asset]))
      serializeState.fail = true
      const outcome = await openBundleFile(file)
      expect(outcome.status).toBe('opened')
      expect(useEditorStore.getState().autosaveStatus).toBe('error')
      // Clearing the failure completes everything with no further edit: the
      // retry serializes the live doc when it fires, then records the install
      // and writes the slot.
      serializeState.fail = false
      await vi.advanceTimersByTimeAsync(3_000)
      expect(readInstalledRegistry()?.[PROJECT] ?? []).toHaveLength(1)
      expect(useEditorStore.getState().autosaveStatus).toBe('saved')
      expect(readAutosave()).not.toBeNull()
    } finally {
      serializeState.fail = false
      vi.useRealTimers()
    }
  })

  it('writes an edit made during the install record append to the slot', async () => {
    const locks = (navigator as unknown as { locks: FakeLockManager }).locks
    const originalRequest = locks.request.bind(locks)
    // The first autosave-lock request is the ownership claim; gate only the
    // second (the registry append) so the edit below lands inside its window.
    // The slot write must proceed normally once the append is released.
    let autosaveCalls = 0
    let releaseAutosave: (() => void) | null = null
    locks.request = ((name: string, options: never, callback: never) => {
      if (name === AUTOSAVE_LOCK_NAME) {
        autosaveCalls += 1
        if (autosaveCalls === 2) {
          return new Promise<unknown>((resolve, reject) => {
            releaseAutosave = () => {
              void originalRequest(name, options, callback).then(resolve, reject)
            }
          })
        }
      }
      return originalRequest(name, options, callback)
    }) as typeof locks.request
    const asset = await videoAsset()
    const file = await bundleFile(bundleDoc([asset]))
    const pending = openBundleFile(file)
    try {
      // Wait for the install to land, then edit before the gated append runs.
      await vi.waitFor(() => expect(useEditorStore.getState().doc.project.id).toBe(PROJECT))
      const live = useEditorStore.getState().doc
      useEditorStore.setState({
        doc: { ...live, project: { ...live.project, name: 'Edited After Install' } },
      })
      await vi.waitFor(() => expect(releaseAutosave).not.toBeNull())
      releaseAutosave!()
      const outcome = await pending
      expect(outcome.status).toBe('opened')
      const slot = parseSerializedDoc(readAutosave()!).doc
      expect(slot.project.name).toBe('Edited After Install')
      expect(useEditorStore.getState().autosaveStatus).not.toBe('error')
    } finally {
      releaseAutosave = null
    }
  })

  it('leaves the slot alone when another project becomes live during the record append', async () => {
    const locks = (navigator as unknown as { locks: FakeLockManager }).locks
    const originalRequest = locks.request.bind(locks)
    let autosaveCalls = 0
    let releaseAutosave: (() => void) | null = null
    locks.request = ((name: string, options: never, callback: never) => {
      if (name === AUTOSAVE_LOCK_NAME) {
        autosaveCalls += 1
        if (autosaveCalls === 2) {
          return new Promise<unknown>((resolve, reject) => {
            releaseAutosave = () => {
              void originalRequest(name, options, callback).then(resolve, reject)
            }
          })
        }
      }
      return originalRequest(name, options, callback)
    }) as typeof locks.request
    storage.set('web-video-editor:autosave:v1', '{"newer":true}')
    const asset = await videoAsset()
    const file = await bundleFile(bundleDoc([asset]))
    const pending = openBundleFile(file)
    try {
      await vi.waitFor(() => expect(useEditorStore.getState().doc.project.id).toBe(PROJECT))
      // The user opens another project while the install record is appended.
      useEditorStore.setState({ doc: createDoc(), autosaveStatus: 'idle' })
      await vi.waitFor(() => expect(releaseAutosave).not.toBeNull())
      releaseAutosave!()
      const outcome = await pending
      expect(outcome.status).toBe('opened')
      // The imported snapshot must not replace the newer project's slot.
      expect(readAutosave()).toBe('{"newer":true}')
      expect(useEditorStore.getState().autosaveStatus).not.toBe('saved')
    } finally {
      releaseAutosave = null
    }
  })

  it('drops a retry whose same project was renamed before it fired', async () => {
    vi.useFakeTimers()
    try {
      const live = bundleDoc([])
      useEditorStore.setState({ doc: live, autosaveStatus: 'idle' })
      const stale = JSON.stringify(serializeDoc(live))
      queueAutosaveRetry(stale, undefined, PROJECT)
      useEditorStore.setState({
        doc: { ...live, project: { ...live.project, name: 'Renamed Before Retry' } },
      })
      await vi.advanceTimersByTimeAsync(3_000)
      expect(readAutosave()).toBeNull()
      expect(useEditorStore.getState().autosaveStatus).not.toBe('saved')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not mark another live project error when the install record fails', async () => {
    const locks = (navigator as unknown as { locks: FakeLockManager }).locks
    const originalRequest = locks.request.bind(locks)
    let autosaveCalls = 0
    let releaseAutosave: (() => void) | null = null
    locks.request = ((name: string, options: never, callback: never) => {
      if (name === AUTOSAVE_LOCK_NAME) {
        autosaveCalls += 1
        if (autosaveCalls === 2) {
          return new Promise<unknown>((resolve, reject) => {
            releaseAutosave = () => {
              void originalRequest(name, options, callback).then(resolve, reject)
            }
          })
        }
      }
      return originalRequest(name, options, callback)
    }) as typeof locks.request
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (key === 'web-video-editor:installed-installs:v1') throw new Error('quota')
        storage.set(key, value)
      },
      removeItem: (key: string) => void storage.delete(key),
      clear: () => void storage.clear(),
    })
    const asset = await videoAsset()
    const file = await bundleFile(bundleDoc([asset]))
    const pending = openBundleFile(file)
    try {
      await vi.waitFor(() => expect(useEditorStore.getState().doc.project.id).toBe(PROJECT))
      useEditorStore.setState({ doc: createDoc(), autosaveStatus: 'idle' })
      await vi.waitFor(() => expect(releaseAutosave).not.toBeNull())
      releaseAutosave!()
      const outcome = await pending
      expect(outcome.status).toBe('opened')
      // Project B owns the status now; A's registry retry stays queued.
      expect(useEditorStore.getState().autosaveStatus).not.toBe('error')
      expect(pendingFor(PROJECT)?.projectId).toBe(PROJECT)
    } finally {
      releaseAutosave = null
    }
  })

  it('drops a bundle slot retry once another project is live', async () => {
    vi.useFakeTimers()
    try {
      const stale = JSON.stringify(serializeDoc(bundleDoc([])))
      queueAutosaveRetry(stale, undefined, PROJECT)
      // The live doc is the beforeEach project, not the retry's project.
      await vi.advanceTimersByTimeAsync(3_000)
      expect(readAutosave()).toBeNull()
      expect(useEditorStore.getState().autosaveStatus).not.toBe('saved')
    } finally {
      vi.useRealTimers()
    }
  })

  it('completes a pending install across reload without overwriting another session', async () => {
    vi.useFakeTimers()
    let unsubscribe: (() => void) | null = null
    try {
      const otherHash = await sha256Hex(new Uint8Array([6, 6, 6]))
      // A complete registry that omits this install: without durable state,
      // recovery would retire the shard after a reload.
      expect(recordInstalledImport(PROJECT, newInstallId())).toBe(true)
      expect(await ensureProjectMedia(PROJECT)).toBe('ready')
      const installId = newInstallId()
      await writeMediaClaim(PROJECT, [otherHash], installId)
      await markInstallPending(PROJECT, installId, true)
      expect(pendingFor(PROJECT)?.installId).toBe(installId)
      // The slot still holds the session that was open before the import: the
      // failed slot write is exactly what makes the pending install durable.
      storage.set('web-video-editor:autosave:v1', '{"prior":true}')
      // A reload drops the in-memory pending install but keeps storage.
      resetAutosaveCoordinationForTests()
      expect(await recoverOrphanedClaimShards(PROJECT)).toMatchObject({
        removed: 0,
        kept: 1,
        ambiguous: true,
      })
      // Startup restores the durable pending install and records it. The live
      // boot doc is a different project, so the retry must leave the slot and
      // the saved status alone.
      unsubscribe = initAutosave()
      await vi.advanceTimersByTimeAsync(3_000)
      expect(readInstalledRegistry()?.[PROJECT] ?? []).toContain(installId)
      expect(pendingFor(PROJECT)).toBeNull()
      expect(readAutosave()).toBe('{"prior":true}')
      expect(useEditorStore.getState().autosaveStatus).not.toBe('saved')
    } finally {
      unsubscribe?.()
      vi.useRealTimers()
    }
  })

  it('keeps two failed installs pending across a reload and records both', async () => {
    vi.useFakeTimers()
    let unsubscribe: (() => void) | null = null
    const OTHER = 'proj_bundle_other'
    try {
      const hashA = await sha256Hex(new Uint8Array([7, 7, 7]))
      const hashB = await sha256Hex(new Uint8Array([8, 8, 8]))
      // A complete registry that omits both installs: only the pending
      // records stand between recovery and the two claim shards.
      expect(recordInstalledImport(PROJECT, newInstallId())).toBe(true)
      expect(recordInstalledImport(OTHER, newInstallId())).toBe(true)
      expect(await ensureProjectMedia(PROJECT)).toBe('ready')
      expect(await ensureProjectMedia(OTHER)).toBe('ready')
      const installA = newInstallId()
      const installB = newInstallId()
      await writeMediaClaim(PROJECT, [hashA], installA)
      await writeMediaClaim(OTHER, [hashB], installB)
      await markInstallPending(PROJECT, installA, true)
      await markInstallPending(OTHER, installB, true)
      expect(pendingFor(PROJECT)?.installId).toBe(installA)
      expect(pendingFor(OTHER)?.installId).toBe(installB)
      // A reload drops the in-memory records but keeps the durable map.
      resetAutosaveCoordinationForTests()
      expect(await recoverOrphanedClaimShards(PROJECT)).toMatchObject({
        removed: 0,
        kept: 1,
        ambiguous: true,
      })
      expect(await recoverOrphanedClaimShards(OTHER)).toMatchObject({
        removed: 0,
        kept: 1,
        ambiguous: true,
      })
      // Startup flushes every record, not just the last one, and touches no
      // slot because neither project is live.
      unsubscribe = initAutosave()
      await vi.advanceTimersByTimeAsync(3_000)
      expect(readInstalledRegistry()?.[PROJECT] ?? []).toContain(installA)
      expect(readInstalledRegistry()?.[OTHER] ?? []).toContain(installB)
      expect(readPendingInstallRecords()).toEqual([])
      expect(readAutosave()).toBeNull()
    } finally {
      unsubscribe?.()
      vi.useRealTimers()
    }
  })

  it('reads a 0.28.0 pending install record after an upgrade', async () => {
    vi.useFakeTimers()
    let unsubscribe: (() => void) | null = null
    try {
      const hash = await sha256Hex(new Uint8Array([9, 9, 9]))
      // A complete registry that omits this install: without the old record,
      // recovery would retire the shard after an upgrade.
      expect(recordInstalledImport(PROJECT, newInstallId())).toBe(true)
      expect(await ensureProjectMedia(PROJECT)).toBe('ready')
      const installId = newInstallId()
      await writeMediaClaim(PROJECT, [hash], installId)
      // 0.28.0 wrote one flat record under the same key.
      storage.set(
        'web-video-editor:pending-install:v1',
        JSON.stringify({ projectId: PROJECT, installId, hadInstallClaims: true }),
      )
      expect(readPendingInstallRecords()).toEqual([
        { projectId: PROJECT, installId, hadInstallClaims: true },
      ])
      resetAutosaveCoordinationForTests()
      expect(await recoverOrphanedClaimShards(PROJECT)).toMatchObject({
        removed: 0,
        kept: 1,
        ambiguous: true,
      })
      unsubscribe = initAutosave()
      await vi.advanceTimersByTimeAsync(3_000)
      expect(readInstalledRegistry()?.[PROJECT] ?? []).toContain(installId)
      expect(readPendingInstallRecords()).toEqual([])
      expect(readAutosave()).toBeNull()
    } finally {
      unsubscribe?.()
      vi.useRealTimers()
    }
  })

  it('writes the import marker when the debounced save wins the race', async () => {
    vi.useFakeTimers()
    let unsubscribe: (() => void) | null = null
    let registryWrites = 0
    try {
      vi.stubGlobal('localStorage', {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          if (key === 'web-video-editor:installed-installs:v1') {
            registryWrites += 1
            if (registryWrites === 1) throw new Error('quota')
          }
          storage.set(key, value)
        },
        removeItem: (key: string) => void storage.delete(key),
        clear: () => void storage.clear(),
      })
      const asset = await videoAsset()
      const file = await bundleFile(bundleDoc([asset]))
      unsubscribe = initAutosave()
      const outcome = await openBundleFile(file)
      expect(outcome.status).toBe('opened')
      // The install record failed, so the project-scoped slot write never ran.
      expect(pendingFor(PROJECT)?.projectId).toBe(PROJECT)
      // The ordinary debounce fires before the 3 s pending retry.
      await vi.advanceTimersByTimeAsync(800)
      expect(storage.get('web-video-editor:autosave-import:v1')).toBeTruthy()
      expect(parseSerializedDoc(readAutosave()!).doc.project.id).toBe(PROJECT)
    } finally {
      unsubscribe?.()
      vi.useRealTimers()
    }
  })

  it('writes the slot when the pending install is the live project', async () => {
    vi.useFakeTimers()
    let unsubscribe: (() => void) | null = null
    try {
      const live = createDoc()
      useEditorStore.setState({
        doc: { ...live, project: { ...live.project, id: PROJECT } },
        autosaveStatus: 'idle',
      })
      const installId = newInstallId()
      await markInstallPending(PROJECT, installId, false)
      // A reload drops the in-memory pending install but keeps storage.
      resetAutosaveCoordinationForTests()
      unsubscribe = initAutosave()
      await vi.advanceTimersByTimeAsync(3_000)
      expect(readInstalledRegistry()?.[PROJECT] ?? []).toContain(installId)
      expect(pendingFor(PROJECT)).toBeNull()
      expect(parseSerializedDoc(readAutosave()!).doc.project.id).toBe(PROJECT)
      expect(useEditorStore.getState().autosaveStatus).toBe('saved')
    } finally {
      unsubscribe?.()
      vi.useRealTimers()
    }
  })

  it('retries an unchanged pending install after the first attempt fails', async () => {
    vi.useFakeTimers()
    let unsubscribe: (() => void) | null = null
    let failSlot = true
    try {
      vi.stubGlobal('localStorage', {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          if (failSlot && key === 'web-video-editor:autosave:v1') throw new Error('quota')
          storage.set(key, value)
        },
        removeItem: (key: string) => void storage.delete(key),
        clear: () => void storage.clear(),
      })
      const live = bundleDoc([])
      useEditorStore.setState({ doc: live, autosaveStatus: 'idle' })
      const installId = newInstallId()
      await markInstallPending(PROJECT, installId, false)
      // A reload drops the in-memory pending install but keeps storage.
      resetAutosaveCoordinationForTests()
      unsubscribe = initAutosave()
      await vi.advanceTimersByTimeAsync(3_000)
      // The first attempt appended the record but could not write the slot.
      expect(readAutosave()).toBeNull()
      failSlot = false
      await vi.advanceTimersByTimeAsync(3_000)
      // The document is unchanged apart from its serialization timestamp, so
      // the second attempt must write it instead of dropping it as stale.
      expect(parseSerializedDoc(readAutosave()!).doc.project.id).toBe(PROJECT)
      expect(readInstalledRegistry()?.[PROJECT] ?? []).toContain(installId)
      expect(pendingFor(PROJECT)).toBeNull()
      expect(useEditorStore.getState().autosaveStatus).toBe('saved')
    } finally {
      unsubscribe?.()
      vi.useRealTimers()
    }
  })

  it('keeps pending when an edit lands during the pending slot write', async () => {
    vi.useFakeTimers()
    let unsubscribe: (() => void) | null = null
    try {
      const live = bundleDoc([])
      useEditorStore.setState({ doc: live, autosaveStatus: 'idle' })
      const installId = newInstallId()
      await markInstallPending(PROJECT, installId, false)
      // A reload drops the in-memory record but keeps the durable one.
      resetAutosaveCoordinationForTests()
      const edited = { ...live }
      vi.stubGlobal('localStorage', {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value)
          if (key === 'web-video-editor:autosave:v1') {
            // The edit lands while the retry's slot write is in flight.
            useEditorStore.setState({ doc: edited })
          }
        },
        removeItem: (key: string) => void storage.delete(key),
        clear: () => void storage.clear(),
      })
      unsubscribe = initAutosave()
      await vi.advanceTimersByTimeAsync(3_000)
      // The retry wrote the imported doc, but the newer edit owns its own save.
      expect(useEditorStore.getState().autosaveStatus).toBe('pending')
      expect(parseSerializedDoc(readAutosave()!).doc.project.id).toBe(PROJECT)
    } finally {
      unsubscribe?.()
      vi.useRealTimers()
    }
  })

  it('preserves a newer pending install that replaces one during its append', async () => {
    vi.useFakeTimers()
    let unsubscribe: (() => void) | null = null
    try {
      const hash = await sha256Hex(new Uint8Array([10, 10, 10]))
      expect(recordInstalledImport(PROJECT, newInstallId())).toBe(true)
      expect(await ensureProjectMedia(PROJECT)).toBe('ready')
      const oldId = newInstallId()
      await writeMediaClaim(PROJECT, [hash], oldId)
      await markInstallPending(PROJECT, oldId, true)
      resetAutosaveCoordinationForTests()
      const locks = navigator.locks as unknown as FakeLockManager
      let release!: () => void
      const hold = new Promise<void>((resolve) => {
        release = resolve
      })
      const held = locks.request(AUTOSAVE_LOCK_NAME, { mode: 'exclusive' }, () => hold)
      unsubscribe = initAutosave()
      await vi.advanceTimersByTimeAsync(3_000)
      const newId = newInstallId()
      const replacement = markInstallPending(PROJECT, newId, true)
      release()
      await held
      await replacement
      await vi.advanceTimersByTimeAsync(0)
      // The old append completes, but the newer record still owns the project.
      expect(readInstalledRegistry()?.[PROJECT] ?? []).toContain(oldId)
      expect(pendingFor(PROJECT)?.installId).toBe(newId)
      expect(hasPendingInstall()).toBe(true)
    } finally {
      unsubscribe?.()
      vi.useRealTimers()
    }
  })

  it('reports saved after an import whose live doc did not change', async () => {
    serializeState.unique = true
    try {
      const asset = await videoAsset()
      await openBundleFile(await bundleFile(bundleDoc([asset])))
      expect(useEditorStore.getState().autosaveStatus).toBe('saved')
    } finally {
      serializeState.unique = false
    }
  })

  it('keeps the serialized duration when the probe reports zero', async () => {
    const asset = await videoAsset()
    const doc = bundleDoc([asset])
    probeState.duration = 0
    await openBundleFile(await bundleFile(doc))
    expect(useEditorStore.getState().doc.media[0]?.duration).toBe(3)
  })

  it('keeps a pre-import saved copy when the registry is lost before a new import', async () => {
    const oldHash = await sha256Hex(new Uint8Array([7, 7, 7]))
    const oldInstall = newInstallId()
    expect(recordInstalledImport(PROJECT, oldInstall)).toBe(true)
    expect(await ensureProjectMedia(PROJECT)).toBe('ready')
    await writeMediaClaim(PROJECT, [oldHash], oldInstall)
    localStorage.removeItem('web-video-editor:installed-installs:v1')

    const asset = await videoAsset()
    await openBundleFile(await bundleFile(bundleDoc([asset])))

    const shards = await readMediaClaimShards(PROJECT)
    expect(shards?.shards.map((shard) => shard.installId)).toContain(oldInstall)
    const recovery = await recoverOrphanedClaimShards(PROJECT)
    expect(recovery.ambiguous).toBe(true)
    // Re-read after recovery: the snapshot above was taken before it ran.
    const after = await readMediaClaimShards(PROJECT)
    expect(after?.shards).toHaveLength(2)
    expect(after?.shards.map((shard) => shard.installId)).toContain(oldInstall)
  })

  it("keeps another project's install claims when a lost registry is recreated", async () => {
    const otherProject = 'proj_other'
    const otherHash = await sha256Hex(new Uint8Array([5, 5, 5]))
    const otherInstall = newInstallId()
    expect(await ensureProjectMedia(otherProject)).toBe('ready')
    await writeMediaClaim(otherProject, [otherHash], otherInstall)
    localStorage.removeItem('web-video-editor:installed-installs:v1')

    const asset = await videoAsset()
    await openBundleFile(await bundleFile(bundleDoc([asset])))

    expect(isInstallHistoryLost()).toBe(true)
    const recovery = await recoverOrphanedClaimShards(otherProject)
    expect(recovery).toMatchObject({ removed: 0, kept: 1, ambiguous: true })
    expect((await readMediaClaimShards(otherProject))?.shards[0]?.installId).toBe(otherInstall)
  })

  it('refuses a manifest entry whose bytes do not match its hash', async () => {
    const asset = await videoAsset()
    const doc = bundleDoc([asset])
    const wrong = await sha256Hex(new Uint8Array([7, 7]))
    doc.media[0] = { ...doc.media[0]!, contentHash: wrong }
    const manifest = manifestFor(doc)
    const before = useEditorStore.getState().doc
    await expect(
      openBundleFile(
        await handmadeBundle(manifest, doc, [
          { path: `media/media_a/clip.mp4`, bytes: VIDEO_BYTES },
        ]),
      ),
    ).rejects.toThrow('damaged')
    expect(useEditorStore.getState().doc).toBe(before)
  })

  it('refuses an entry above the 512 MiB memory budget before reading it', async () => {
    const asset = await videoAsset()
    const doc = bundleDoc([asset])
    const manifest = manifestFor(doc)
    manifest.assets[0] = { ...manifest.assets[0]!, size: 600 * 1024 * 1024 }
    await expect(openBundleFile(await handmadeBundle(manifest, doc))).rejects.toThrow(
      'invalid size',
    )
  })

  it('refuses a font entry above the 8 MiB font cap before reading its bytes', async () => {
    const font = await fontFont()
    const doc = bundleDoc([], [font])
    const manifest = manifestFor(doc)
    const oversized = new Uint8Array(FONT_FILE_MAX_BYTES + 1)
    manifest.fonts[0] = { ...manifest.fonts[0]!, size: oversized.length }
    const fontPath = manifest.fonts[0]!.path

    await expect(
      openBundleFile(await handmadeBundle(manifest, doc, [{ path: fontPath, bytes: oversized }])),
    ).rejects.toThrow('invalid size')
    expect(zipReads.paths).not.toContain(fontPath)
  })

  it('rejects a font entry whose central size disagrees with the manifest before reading it', async () => {
    const font = await fontFont()
    const doc = bundleDoc([], [font])
    const manifest = manifestFor(doc)
    const fontPath = manifest.fonts[0]!.path

    await expect(
      openBundleFile(
        await handmadeBundle(manifest, doc, [
          { path: fontPath, bytes: new Uint8Array(FONT_BYTES.length + 8) },
        ]),
      ),
    ).rejects.toThrow(/wrong size|is missing/i)
    expect(zipReads.paths).not.toContain(fontPath)
  })

  it('refuses a directory entry whose size disagrees with the manifest before reading it', async () => {
    const asset = await videoAsset()
    const doc = bundleDoc([asset])
    await expect(
      openBundleFile(
        await handmadeBundle(manifestFor(doc), doc, [
          { path: 'media/media_a/clip.mp4', bytes: new Uint8Array(16) },
        ]),
      ),
    ).rejects.toThrow('wrong size')
  })

  it('refuses a project that lists media the bundle does not carry', async () => {
    const asset = await videoAsset()
    const doc = bundleDoc([asset])
    const manifest = manifestFor(doc, { assets: [] })
    await expect(openBundleFile(await handmadeBundle(manifest, doc))).rejects.toThrow(
      'missing media',
    )
  })

  it('refuses an extra bundle entry', async () => {
    const asset = await videoAsset()
    const doc = bundleDoc([asset])
    const manifest = manifestFor(doc)
    await expect(
      openBundleFile(
        await handmadeBundle(manifest, doc, [
          { path: 'media/media_a/clip.mp4', bytes: VIDEO_BYTES },
          { path: 'extra.txt', bytes: new TextEncoder().encode('nope') },
        ]),
      ),
    ).rejects.toThrow('unexpected entry')
  })

  it('loads a v8 bundle with stretch 1 and round-trips v9 stretch', async () => {
    const asset = await videoAsset()
    const legacy = bundleDoc([asset])
    legacy.project.tracks[0].clips = [
      createClip({ id: 'clip_legacy', mediaId: asset.id, start: 0, duration: 2 }),
    ]
    const v8 = await handmadeBundle(
      manifestFor(legacy),
      legacy,
      [{ path: 'media/media_a/clip.mp4', bytes: VIDEO_BYTES }],
      8,
    )
    expect((await openBundleFile(v8)).status).toBe('opened')
    const legacyClip = useEditorStore.getState().doc.project.tracks[0].clips[0]
    expect(legacyClip.stretchX).toBeUndefined()
    expect(legacyClip.stretchY).toBeUndefined()

    const current = bundleDoc([asset])
    current.project.tracks[0].clips = [
      createClip({
        id: 'clip_stretched',
        mediaId: asset.id,
        start: 0,
        duration: 2,
        stretchX: 1.5,
        stretchY: 0.75,
      }),
    ]
    const v9 = await handmadeBundle(
      manifestFor(current),
      current,
      [{ path: 'media/media_a/clip.mp4', bytes: VIDEO_BYTES }],
      SERIALIZATION_VERSION,
    )
    expect((await openBundleFile(v9)).status).toBe('opened')
    const stretched = useEditorStore.getState().doc.project.tracks[0].clips[0]
    expect(stretched.stretchX).toBe(1.5)
    expect(stretched.stretchY).toBe(0.75)
  })

  it('refuses a newer project version inside the bundle', async () => {
    const asset = await videoAsset()
    const doc = bundleDoc([asset])
    await expect(
      openBundleFile(
        await handmadeBundle(
          manifestFor(doc),
          doc,
          [{ path: 'media/media_a/clip.mp4', bytes: VIDEO_BYTES }],
          99,
        ),
      ),
    ).rejects.toThrow('Unsupported project version')
  })

  it('warns about a missing bundled font and still installs', async () => {
    const font = await fontFont()
    const asset = await videoAsset()
    const doc = bundleDoc([asset], [font])
    const file = await bundleFile(doc)
    const outcome = await openBundleFile(file)
    expect(outcome.status).toBe('opened')
    expect(outcome.warnings.join(' ')).toContain('not in this bundle')
    expect(useEditorStore.getState().doc.project.fonts?.[0]?.contentHash).toBe(font.contentHash)
  })

  it('leaves no claim shard when the install fails', async () => {
    const asset = await videoAsset()
    const doc = bundleDoc([asset])
    const file = await bundleFile(doc)
    const original = useEditorStore.getState().replaceDoc
    useEditorStore.setState({
      replaceDoc: () => {
        throw new Error('install exploded')
      },
    })
    try {
      await expect(openBundleFile(file)).rejects.toThrow('install exploded')
    } finally {
      useEditorStore.setState({ replaceDoc: original })
    }
    expect(await readMediaClaimShards(PROJECT)).toEqual({ hashes: [], shards: [] })
    expect(readInstalledRegistry()?.[PROJECT] ?? []).toHaveLength(0)
    // Promoted bytes stay for the clean action.
    expect(await readMediaFile(PROJECT, asset.contentHash!)).not.toBeNull()
  })
})
