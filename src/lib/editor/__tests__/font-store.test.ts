import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  FontUploadError,
  activateProjectFonts,
  activateStagedProjectFonts,
  commitStagedFont,
  discardStagedFont,
  ensureProjectFontsReady,
  isFontFamilyActive,
  loadProjectFonts,
  resetFontRegistryForTests,
  stageProjectFontFaces,
  stageProjectFont,
  unregisterProjectFonts,
} from '../media/font-store'
import { isMediaActivityActive } from '../media/persist'
import { sha256Hex, writeMediaFile } from '../media/media-store'
import { FONT_FILE_MAX_BYTES } from '../constants'
import { fontFaceFamily, fontFamilyForId } from '../fonts'
import { createFakeOpfs, type FakeOpfs } from './mocks/opfs'
import type { Doc, ProjectFont } from '../types'

const PROJECT = 'proj_fonts'
const FONT_ID = 'font_123e4567-e89b-12d3-a456-426614174000'
const FAMILY = fontFamilyForId(FONT_ID)

class FakeFontFace {
  readonly family: string
  readonly source: unknown
  readonly descriptors: FontFaceDescriptors
  static failNext = 0
  static constructed: FakeFontFace[] = []
  constructor(family: string, source: unknown, descriptors: FontFaceDescriptors = {}) {
    this.family = family
    this.source = source
    this.descriptors = descriptors
    FakeFontFace.constructed.push(this)
  }
  async load(): Promise<FakeFontFace> {
    if (FakeFontFace.failNext > 0) {
      FakeFontFace.failNext -= 1
      throw new Error('parse failed')
    }
    return this
  }
}

interface FakeFontSet {
  faces: Set<FakeFontFace>
  add: (face: FakeFontFace) => void
  delete: (face: FakeFontFace) => void
  ready: Promise<void>
}

let fontSet: FakeFontSet
let fake: FakeOpfs

function fontBytes(header = [0x77, 0x4f, 0x46, 0x32]): Uint8Array<ArrayBuffer> {
  return new Uint8Array([...header, 1, 2, 3, 4, 5, 6, 7, 8])
}

function font(overrides: Partial<ProjectFont> = {}): ProjectFont {
  return {
    id: FONT_ID,
    name: 'Inter',
    family: FAMILY,
    contentHash: 'a'.repeat(64),
    ...overrides,
  }
}

function docWith(fonts: ProjectFont[], projectId = PROJECT): Doc {
  return {
    project: {
      id: projectId,
      name: 'Fonts',
      width: 1920,
      height: 1080,
      fps: 30,
      tracks: [],
      fonts,
    },
    media: [],
  }
}

async function storeFont(
  projectId: string,
  data: Uint8Array<ArrayBuffer>,
  id = FONT_ID,
): Promise<ProjectFont> {
  const hash = await sha256Hex(data)
  await writeMediaFile(
    projectId,
    hash,
    new File([data], 'inter.woff2', { type: 'font/woff2' }),
    'fonts',
  )
  return font({ id, family: fontFamilyForId(id), contentHash: hash })
}

function stubBrowser(): void {
  fontSet = {
    faces: new Set(),
    add(face) {
      this.faces.add(face)
    },
    delete(face) {
      this.faces.delete(face)
    },
    ready: Promise.resolve(),
  }
  vi.stubGlobal('FontFace', FakeFontFace)
  vi.stubGlobal('document', { fonts: fontSet })
}

beforeEach(() => {
  fake = createFakeOpfs()
  vi.stubGlobal('navigator', {
    storage: { getDirectory: async () => fake.root },
  })
  FakeFontFace.failNext = 0
  FakeFontFace.constructed = []
  resetFontRegistryForTests()
  stubBrowser()
})

afterEach(() => {
  resetFontRegistryForTests()
  vi.unstubAllGlobals()
})

describe('project font loading (0.25.0)', () => {
  it('loads stored font bytes, registers the face, and reports none missing', async () => {
    const stored = await storeFont(PROJECT, fontBytes())
    const result = await loadProjectFonts(docWith([stored]))
    expect(result).toMatchObject({ loaded: 1, missing: 0, warnings: [] })
    expect(fontSet.faces.size).toBe(1)
    expect(isFontFamilyActive(FAMILY)).toBe(true)
    // FontFace must carry the bare generated token, not the fallback stack:
    // canvas resolves the first family in `TextStyle.fontFamily`, and a face
    // registered under the whole stack would never answer it.
    expect(FakeFontFace.constructed[0].family).toBe(fontFaceFamily(FONT_ID))
    expect([...fontSet.faces][0].family).toBe(fontFaceFamily(FONT_ID))
  })

  it('warns and falls back when the bytes are missing', async () => {
    const result = await loadProjectFonts(docWith([font()]))
    expect(result.loaded).toBe(0)
    expect(result.missing).toBe(1)
    expect(result.warnings[0]).toMatch(/missing from this browser/)
    expect(fontSet.faces.size).toBe(0)
  })

  it('warns and falls back when the stored bytes are not a font', async () => {
    const stored = await storeFont(PROJECT, fontBytes([0x50, 0x4b, 0x03, 0x04]))
    const result = await loadProjectFonts(docWith([stored]))
    expect(result.warnings[0]).toMatch(/damaged/)
    expect(fontSet.faces.size).toBe(0)
  })

  it('warns when FontFace rejects the file', async () => {
    const stored = await storeFont(PROJECT, fontBytes())
    FakeFontFace.failNext = 1
    const result = await loadProjectFonts(docWith([stored]))
    expect(result.warnings[0]).toMatch(/could not be loaded/)
    expect(fontSet.faces.size).toBe(0)
  })

  it('warns instead of throwing when the stored bytes cannot be read', async () => {
    const stored = await storeFont(PROJECT, fontBytes())
    const arrayBuffer = vi.spyOn(File.prototype, 'arrayBuffer')
    try {
      // readMediaFile hashes the file first, then loadFace reads the bytes:
      // only the second read throws.
      arrayBuffer.mockImplementationOnce(() =>
        Promise.resolve(new Uint8Array(fontBytes()).buffer as ArrayBuffer),
      )
      arrayBuffer.mockImplementationOnce(() => Promise.reject(new Error('unreadable')))
      const result = await loadProjectFonts(docWith([stored]))
      expect(result).toMatchObject({ loaded: 0, missing: 1 })
      expect(result.warnings[0]).toMatch(/could not be loaded/)
      expect(fontSet.faces.size).toBe(0)
    } finally {
      arrayBuffer.mockRestore()
    }
  })

  it('removes the previous project faces before registering the next project', async () => {
    const first = await storeFont(PROJECT, fontBytes())
    await loadProjectFonts(docWith([first]))
    expect(fontSet.faces.size).toBe(1)

    const second = await storeFont(
      'proj_second',
      fontBytes([0x77, 0x4f, 0x46, 0x46]),
      'font_second',
    )
    const secondDoc = docWith([second], 'proj_second')
    const result = await loadProjectFonts(secondDoc)
    expect(result.loaded).toBe(1)
    // The new project's family answers; the previous project's face is gone.
    expect(fontSet.faces.size).toBe(1)
    expect(isFontFamilyActive(second.family)).toBe(true)
    expect(isFontFamilyActive(FAMILY)).toBe(false)
  })

  it('drops a superseded project load without touching the active project', async () => {
    const first = await storeFont(PROJECT, fontBytes())
    await loadProjectFonts(docWith([first]))
    unregisterProjectFonts('proj_other')
    expect(fontSet.faces.size).toBe(1)
    unregisterProjectFonts(PROJECT)
    expect(fontSet.faces.size).toBe(0)
  })

  it('a superseded concurrent load registers nothing after the switch', async () => {
    const first = await storeFont(PROJECT, fontBytes())
    const second = await storeFont(
      'proj_second',
      fontBytes([0x77, 0x4f, 0x46, 0x46]),
      'font_second',
    )
    // Both loads start in the same tick: the second claims the registry
    // before the first load's reads resolve.
    const pendingA = loadProjectFonts(docWith([first]))
    const pendingB = loadProjectFonts(docWith([second], 'proj_second'))
    const [resultA, resultB] = await Promise.all([pendingA, pendingB])
    expect(resultB).toMatchObject({ loaded: 1, missing: 0 })
    // Only the winning project's face is registered. The superseded load
    // stops at its generation guard instead of leaving a stale face that the
    // id-based cleanup cannot remove (it only touches the active project).
    expect(fontSet.faces.size).toBe(1)
    expect(isFontFamilyActive(second.family)).toBe(true)
    expect(isFontFamilyActive(FAMILY)).toBe(false)
    expect(resultA.loaded).toBe(0)
  })

  it('a superseded concurrent load cannot collide on a shared generated family', async () => {
    // The same font id in two projects generates the same family string, so
    // a stale registration would collide with (or overwrite) the winner.
    const first = await storeFont(PROJECT, fontBytes())
    const second = await storeFont('proj_second', fontBytes(), FONT_ID)
    expect(second.family).toBe(first.family)
    const pendingA = loadProjectFonts(docWith([first]))
    const pendingB = loadProjectFonts(docWith([second], 'proj_second'))
    await Promise.all([pendingA, pendingB])
    expect(fontSet.faces.size).toBe(1)
    expect(isFontFamilyActive(FAMILY)).toBe(true)
  })

  it('staging an incoming project leaves the installed registry untouched', async () => {
    const installed = await storeFont(PROJECT, fontBytes())
    await loadProjectFonts(docWith([installed]))
    expect(fontSet.faces.size).toBe(1)

    const incoming = await storeFont(
      'proj_second',
      fontBytes([0x77, 0x4f, 0x46, 0x46]),
      'font_second',
    )
    const staged = await stageProjectFontFaces(docWith([incoming], 'proj_second'))
    expect(staged).toMatchObject({ loaded: 1, missing: 0, warnings: [] })
    expect(staged.faces).toHaveLength(1)
    // Nothing staged reaches the live registry: no replacement, no removal.
    expect(fontSet.faces.size).toBe(1)
    expect(isFontFamilyActive(FAMILY)).toBe(true)
    expect(isFontFamilyActive(incoming.family)).toBe(false)
  })

  it('activating a staged set replaces the registry in one step', async () => {
    const installed = await storeFont(PROJECT, fontBytes())
    await loadProjectFonts(docWith([installed]))
    const incoming = await storeFont(
      'proj_second',
      fontBytes([0x77, 0x4f, 0x46, 0x46]),
      'font_second',
    )
    const staged = await stageProjectFontFaces(docWith([incoming], 'proj_second'))
    activateStagedProjectFonts(staged)
    expect(fontSet.faces.size).toBe(1)
    expect(isFontFamilyActive(incoming.family)).toBe(true)
    expect(isFontFamilyActive(FAMILY)).toBe(false)
  })

  it('staging races a live load without planting a stale face', async () => {
    const installed = await storeFont(PROJECT, fontBytes())
    await loadProjectFonts(docWith([installed]))
    const incoming = await storeFont(
      'proj_second',
      fontBytes([0x77, 0x4f, 0x46, 0x46]),
      'font_second',
    )
    // A live load claims the registry while a stage for another project is
    // still reading: neither may disturb the other.
    const stagedPromise = stageProjectFontFaces(docWith([incoming], 'proj_second'))
    const livePromise = loadProjectFonts(docWith([incoming], 'proj_second'))
    const [staged, live] = await Promise.all([stagedPromise, livePromise])
    expect(live.loaded).toBe(1)
    expect(staged.loaded).toBe(1)
    expect(fontSet.faces.size).toBe(1)
    expect(isFontFamilyActive(incoming.family)).toBe(true)
    expect(isFontFamilyActive(FAMILY)).toBe(false)
  })

  it('a background load racing the ready retry registers one face and leaves no orphan', async () => {
    const first = await storeFont(PROJECT, fontBytes())
    // The background preload starts first; the export/preview barrier runs
    // before its reads resolve, so both load the same missing face.
    const loading = loadProjectFonts(docWith([first]))
    const ensuring = ensureProjectFontsReady(docWith([first]))
    const [loaded, warnings] = await Promise.all([loading, ensuring])
    expect(loaded.loaded).toBe(1)
    expect(warnings).toEqual([])
    // Both loads built their own Face object; only one may stay registered.
    expect(fontSet.faces.size).toBe(1)

    // A next project reusing the same generated family must render its own
    // bytes: an orphaned first face would keep answering the family.
    const second = await storeFont('proj_second', fontBytes([0x77, 0x4f, 0x46, 0x46]), FONT_ID)
    expect(second.family).toBe(first.family)
    await loadProjectFonts(docWith([second], 'proj_second'))
    expect(fontSet.faces.size).toBe(1)
    expect([...fontSet.faces][0]).toBe(
      FakeFontFace.constructed[FakeFontFace.constructed.length - 1],
    )
    expect(isFontFamilyActive(FAMILY)).toBe(true)
  })

  it('retries a missing face for a project that is already active', async () => {
    const stored = await storeFont(PROJECT, fontBytes())
    const doc = docWith([stored])
    await loadProjectFonts(doc)
    fontSet.faces.clear()
    resetFontRegistryForTests()
    const warnings = await ensureProjectFontsReady(doc)
    expect(warnings).toEqual([])
    expect(fontSet.faces.size).toBe(1)
  })

  it('waits for fonts on a project whose faces are not active', async () => {
    const stored = await storeFont(PROJECT, fontBytes())
    const doc = docWith([stored])
    const warnings = await ensureProjectFontsReady(doc)
    expect(warnings).toEqual([])
    expect(fontSet.faces.size).toBe(1)
  })
})

describe('font upload staging (0.25.0)', () => {
  it('validates, hashes, loads, and stores a font without adding it yet', async () => {
    const staged = await stageProjectFont({
      projectId: PROJECT,
      id: FONT_ID,
      name: '  Inter  ',
      file: new File([fontBytes()], 'Inter.woff2', { type: 'font/woff2' }),
      weight: 700,
      style: 'italic',
    })
    expect(staged.font).toMatchObject({
      id: FONT_ID,
      name: 'Inter',
      family: FAMILY,
      weight: 700,
      style: 'italic',
    })
    expect(fontSet.faces.size).toBe(0)
    expect(isFontFamilyActive(FAMILY)).toBe(false)
    expect(await sha256Hex(fontBytes())).toBe(staged.font.contentHash)
    // The bytes were written to the font namespace, not the media root.
    expect([...fake.files.keys()].some((path) => path.includes('/fonts/'))).toBe(true)
  })

  it('commits the staged face only for the still-active project', async () => {
    const stored = await storeFont(PROJECT, fontBytes())
    await loadProjectFonts(docWith([stored]))
    const staged = await stageProjectFont({
      projectId: PROJECT,
      id: 'font_second',
      name: 'Second',
      file: new File([fontBytes([0x77, 0x4f, 0x46, 0x46])], 'Second.woff', {
        type: 'font/woff',
      }),
    })
    expect(commitStagedFont(staged, 'proj_other')).toBe(false)
    expect(fontSet.faces.size).toBe(1)
    expect(commitStagedFont(staged, PROJECT)).toBe(true)
    expect(fontSet.faces.size).toBe(2)
    expect(isFontFamilyActive(staged.font.family)).toBe(true)
    discardStagedFont(staged)
  })

  it('evicts the previous face when a new face commits for the same family', async () => {
    const stored = await storeFont(PROJECT, fontBytes())
    await loadProjectFonts(docWith([stored]))
    const previous = [...fontSet.faces][0]!
    const staged = await stageProjectFont({
      projectId: PROJECT,
      id: stored.id,
      name: 'Inter again',
      file: new File([fontBytes([0x77, 0x4f, 0x46, 0x46])], 'Inter.woff', {
        type: 'font/woff',
      }),
    })
    expect(commitStagedFont(staged, PROJECT)).toBe(true)
    // One face answers the family: the orphan that a later unregister could
    // not delete is gone.
    expect(fontSet.faces.has(previous)).toBe(false)
    expect(fontSet.faces.size).toBe(1)
    expect(isFontFamilyActive(stored.family)).toBe(true)
  })

  it('holds the media reservation across the whole file read', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const file = new File([fontBytes()], 'Inter.woff2', { type: 'font/woff2' })
    const read = file.arrayBuffer.bind(file)
    Object.defineProperty(file, 'arrayBuffer', {
      value: async () => {
        await gate
        return read()
      },
    })
    const staging = stageProjectFont({
      projectId: PROJECT,
      id: FONT_ID,
      name: 'Inter',
      file,
    })
    // The reservation is taken before the read, not only around the write.
    expect(isMediaActivityActive()).toBe(true)
    release()
    await staging
    expect(isMediaActivityActive()).toBe(false)
  })

  it('keeps the active face tracked when a same-family stage is discarded', async () => {
    const stored = await storeFont(PROJECT, fontBytes())
    await loadProjectFonts(docWith([stored]))
    const activeFace = [...fontSet.faces][0]!
    const staged = await stageProjectFont({
      projectId: PROJECT,
      id: stored.id,
      name: 'Discarded',
      file: new File([fontBytes([0x77, 0x4f, 0x46, 0x46])], 'Discarded.woff', {
        type: 'font/woff',
      }),
    })
    // The staged face was never registered, so discarding it must leave the
    // active family tracked; deleting the entry would orphan the live face in
    // document.fonts and a project switch could no longer remove it.
    discardStagedFont(staged)
    expect(fontSet.faces.has(activeFace)).toBe(true)
    expect(isFontFamilyActive(stored.family)).toBe(true)

    await activateProjectFonts(docWith([], 'proj_other'))
    expect(fontSet.faces.has(activeFace)).toBe(false)
    expect(fontSet.faces.size).toBe(0)
  })

  it('resolves activateProjectFonts only after the project faces register', async () => {
    const stored = await storeFont(PROJECT, fontBytes())
    const activation = activateProjectFonts(docWith([stored]))
    expect(isFontFamilyActive(stored.family)).toBe(false)
    await activation
    expect(isFontFamilyActive(stored.family)).toBe(true)
  })

  it('rejects an empty, oversized, renamed, or unparseable file before writing', async () => {
    const cases: [string, Uint8Array<ArrayBuffer>, number][] = [
      ['empty', new Uint8Array(), 0],
      ['renamed', new Uint8Array([0x77, 0x4f, 0x46, 0x32, 1]), 0],
      ['parse', fontBytes(), 1],
    ]
    for (const [label, data, failures] of cases) {
      FakeFontFace.failNext = failures
      const file =
        label === 'renamed'
          ? new File([data], 'Inter.svg', { type: 'image/svg+xml' })
          : new File([data], 'Inter.woff2', { type: 'font/woff2' })
      await expect(
        stageProjectFont({ projectId: PROJECT, id: FONT_ID, name: 'Inter', file }),
      ).rejects.toBeInstanceOf(FontUploadError)
    }
    expect(fake.files.size).toBe(0)
  })

  it('rejects an oversized file from its reported size without reading it', async () => {
    const file = new File([fontBytes()], 'Inter.woff2', { type: 'font/woff2' })
    // Valid bytes, lying metadata: the byte-length check alone would pass,
    // so only the pre-check can refuse this file.
    Object.defineProperty(file, 'size', { value: FONT_FILE_MAX_BYTES + 1 })
    const read = vi.spyOn(file, 'arrayBuffer')
    try {
      await expect(
        stageProjectFont({ projectId: PROJECT, id: FONT_ID, name: 'Inter', file }),
      ).rejects.toThrow(/MB or smaller/)
      expect(read).not.toHaveBeenCalled()
    } finally {
      read.mockRestore()
    }
    expect(fake.files.size).toBe(0)
  })

  it('rejects a font the store cannot write', async () => {
    fake.failWrites = 1
    await expect(
      stageProjectFont({
        projectId: PROJECT,
        id: FONT_ID,
        name: 'Inter',
        file: new File([fontBytes()], 'Inter.woff2', { type: 'font/woff2' }),
      }),
    ).rejects.toBeInstanceOf(FontUploadError)
    expect(fontSet.faces.size).toBe(0)
  })

  it('rejects an empty display name', async () => {
    await expect(
      stageProjectFont({
        projectId: PROJECT,
        id: FONT_ID,
        name: '   ',
        file: new File([fontBytes()], 'Inter.woff2', { type: 'font/woff2' }),
      }),
    ).rejects.toBeInstanceOf(FontUploadError)
  })
})
