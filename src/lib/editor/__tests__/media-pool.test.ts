import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { isNativeFile, relinkPatchFrom } from '../media/relink'
import type { MediaAsset } from '../types'

/**
 * Media-pool regression locks (user bug reports: the bin list could not scroll
 * to reach items below the fold, and a relink could drop the source File the
 * exporter needs).
 *
 * The scroll half is a static wiring lock because jsdom cannot do real layout
 * (same rationale as preview-layout.test.ts / theme.test.ts):
 *
 * 1. PanelShell's content wrapper MUST be a flex column. react-resizable-
 *    panels renders a plain block box, so `flex-1` children (MediaBin,
 *    InspectorPanel) never inherited a height constraint — the list kept its
 *    content height, grew past the panel and was clipped by overflow:hidden
 *    with no scrollbar anywhere. `flex flex-col` makes flex-1 children fill
 *    the panel so their own overflow-y-auto actually scrolls.
 *
 * 2. The MediaBin list must keep `min-h-0 flex-1` + `overflow-y-auto` inside
 *    the (now flex) aside — it is the element that scrolls once heights are
 *    constrained. `editor-scroll` gives it the styled thin scrollbar.
 *
 * The relink hardening is locked here too: `relinkPatchFrom` keeps the source
 * File handle on a relinked asset so the WebCodecs export still has bytes to
 * read. The manual mode clears metadata a replacement file does not provide.
 */

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

describe('relinkPatchFrom (a relink keeps everything the exporter needs)', () => {
  const file = new File(['bytes'], 'clip.mp4', { type: 'video/mp4' })

  it('carries the source file handle, url, geometry, audio flag and waveform', () => {
    const fresh: MediaAsset = {
      id: 'media_probe',
      name: 'clip.mp4',
      kind: 'video',
      duration: 4,
      width: 1920,
      height: 1080,
      url: 'blob:fresh',
      file,
      hasAudio: true,
      waveformPeaks: [0, 1],
    }
    expect(relinkPatchFrom(fresh, 'manual')).toEqual({
      url: 'blob:fresh',
      duration: 4,
      width: 1920,
      height: 1080,
      file,
      hasAudio: true,
      waveformPeaks: [0, 1],
    })
  })

  it('sample mode omits extras a probe could not produce instead of clearing them', () => {
    // Recovery refetches the SAME bundled file, so its old thumbnail and
    // waveform are still the asset's own truth: a partial probe must not
    // erase them.
    const fresh: MediaAsset = {
      id: 'media_bare',
      name: 'clip.mp4',
      kind: 'video',
      duration: 4,
      width: 0,
      height: 0,
      url: 'blob:bare',
      file,
    }
    const patch = relinkPatchFrom(fresh, 'sample')
    expect(patch).toEqual({ url: 'blob:bare', duration: 4, width: 0, height: 0, file })
    expect('thumbnail' in patch).toBe(false)
    expect('waveformPeaks' in patch).toBe(false)
    expect('hasAudio' in patch).toBe(false)
  })

  it('manual mode clears metadata the replacement file does not provide', () => {
    // The user replaced the file: its old thumbnail, waveform and audio flag
    // describe pixels and sound that no longer exist. Clearing them (undefined
    // through the patch) keeps the UI honest and `assetHasAudio` truthful.
    const fresh: MediaAsset = {
      id: 'media_bare',
      name: 'clip.mp4',
      kind: 'video',
      duration: 4,
      width: 0,
      height: 0,
      url: 'blob:bare',
      file,
    }
    const patch = relinkPatchFrom(fresh, 'manual')
    // The patch explicitly CARRIES the keys with undefined values (they must
    // survive `Object.assign` in relinkMedia and reach the previous file's
    // data), so assert presence and value, not just shape.
    expect('thumbnail' in patch).toBe(true)
    expect('hasAudio' in patch).toBe(true)
    expect('waveformPeaks' in patch).toBe(true)
    expect(patch.thumbnail).toBeUndefined()
    expect(patch.hasAudio).toBeUndefined()
    expect(patch.waveformPeaks).toBeUndefined()
    expect(patch.url).toBe('blob:bare')
    expect(patch.file).toBe(file)
  })

  it('manual mode still carries metadata the replacement DOES provide', () => {
    const fresh: MediaAsset = {
      id: 'media_full',
      name: 'clip.mp4',
      kind: 'video',
      duration: 4,
      width: 1920,
      height: 1080,
      url: 'blob:full',
      file,
      thumbnail: 'data:image/jpeg;base64,xx',
      hasAudio: true,
      waveformPeaks: [0.5],
    }
    expect(relinkPatchFrom(fresh, 'manual')).toEqual({
      url: 'blob:full',
      duration: 4,
      width: 1920,
      height: 1080,
      file,
      thumbnail: 'data:image/jpeg;base64,xx',
      hasAudio: true,
      waveformPeaks: [0.5],
    })
  })
})

describe('isNativeFile (the relink handle boundary)', () => {
  it('accepts a real File', () => {
    expect(isNativeFile(new File(['bytes'], 'clip.mp4', { type: 'video/mp4' }))).toBe(true)
  })

  it('rejects a prototype spoof', () => {
    const spoof = Object.create(File.prototype) as Record<string, unknown>
    Object.defineProperty(spoof, 'size', { value: 5 })
    Object.defineProperty(spoof, 'arrayBuffer', { value: () => new ArrayBuffer(0) })
    expect(isNativeFile(spoof)).toBe(false)
  })

  it('rejects a plain Blob, the isolated proof of the File name check', () => {
    // A plain Blob passes the Blob slice, size, and arrayBuffer checks and
    // fails only the File-specific name getter. Bun returns undefined there;
    // Node throws a TypeError.
    expect(isNativeFile(new Blob(['bytes']))).toBe(false)
  })

  it('rejects a structural stub', () => {
    expect(isNativeFile({ size: 5, arrayBuffer: () => new ArrayBuffer(0) })).toBe(false)
  })

  it('rejects a File with a hostile size', () => {
    for (const size of [Number.NaN, Infinity, -1]) {
      const file = new File(['bytes'], 'clip.mp4')
      Object.defineProperty(file, 'size', { value: size })
      expect(isNativeFile(file)).toBe(false)
    }
  })

  it('rejects a native File whose arrayBuffer is shadowed with a non-function', () => {
    // The MP4 audio path calls file.arrayBuffer() and fails soft to no audio,
    // so a handle that cannot produce bytes must not enter the document.
    const file = new File(['bytes'], 'clip.mp4')
    Object.defineProperty(file, 'arrayBuffer', { value: 5 })
    expect(isNativeFile(file)).toBe(false)
  })

  it('rejects a real File when the Blob internal-slot check throws', () => {
    const file = new File(['bytes'], 'clip.mp4')
    const slice = vi.spyOn(Blob.prototype, 'slice').mockImplementation(() => {
      throw new Error('no Blob slot')
    })
    try {
      expect(isNativeFile(file)).toBe(false)
    } finally {
      slice.mockRestore()
    }
  })

  it('fails closed when File or Blob is absent', () => {
    const file = new File(['bytes'], 'clip.mp4')
    vi.stubGlobal('File', undefined)
    try {
      expect(isNativeFile(file)).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
    vi.stubGlobal('Blob', undefined)
    try {
      expect(isNativeFile(file)).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('media pool layout + dedup wiring', () => {
  it('makes PanelShell content a flex column so flex-1 children inherit height', () => {
    const shell = read('src/components/editor/PanelShell.tsx')
    // The wrapper div that hosts arbitrary panel children must constrain them.
    expect(shell).toMatch(/className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"/)
    // The collapsed flag must be reconciled against the library, or a refused
    // collapse leaves a strip drawn inside a full-width panel (0.7.3).
    expect(shell).toMatch(/isCollapsed\(\)/)
  })

  it('keeps the MediaBin list the scrollable, height-constrained element', () => {
    const bin = read('src/components/editor/MediaBin.tsx')
    expect(bin).toMatch(/editor-scroll[^"]*min-h-0 flex-1[^"]*overflow-y-auto/)
    // And the aside itself stays a height-aware flex column.
    expect(bin).toMatch(/'flex min-h-0 flex-col bg-card'/)
  })

  it('keeps both relink sites on the shared patch helper', () => {
    // One field list for the bin's manual relink and the import auto-relink: a
    // hand-rolled list once dropped `file`, which silently removes the media
    // from a WebCodecs export (mp4.ts skips assets without it).
    expect(read('src/components/editor/MediaBin.tsx')).toMatch(
      /patch: relinkPatchFrom\(fresh, 'manual'\)/,
    )
    expect(read('src/lib/editor/project-io.ts')).toMatch(/relinkPatchFrom\(asset, 'manual'\)/)
  })

  it('routes every project open through ONE shared coordinator', () => {
    // Two per-component counters only ordered loads through the SAME handler;
    // a toolbar open and a menu open could still clobber each other, and
    // neither counter covered File > New. The coordinator lives in project-io
    // and both entry points delegate to it: the menu through the picker
    // wrapper, the toolbar by handing over the File its input already chose.
    const io = read('src/lib/editor/project-io.ts')
    expect(io).toMatch(/let projectGeneration = 0/)
    expect(io).toMatch(/export function bumpProjectGeneration/)
    expect(io).toMatch(/export function isCurrentProjectLoad/)
    expect(io).toMatch(/export async function openProjectFile\(file: File\)/)
    expect(io).toMatch(/export async function openProjectFromPicker/)
    // The menu picks; the toolbar hands over the File it already has.
    expect(read('src/components/editor/MenuBar.tsx')).toMatch(/openProjectFromPicker\(\)/)
    expect(read('src/components/editor/Toolbar.tsx')).toMatch(/openProjectFile\(file\)/)
    for (const path of ['src/components/editor/Toolbar.tsx', 'src/components/editor/MenuBar.tsx']) {
      // No component may keep its own private load counter anymore.
      expect(read(path)).not.toMatch(/loadSequenceRef/)
    }
  })

  it('numbers a load only after the picker returns a file', () => {
    // Numbering on click would let a canceled picker invalidate a load that is
    // already in flight. The bump must live in openProjectFile, which a cancel
    // never reaches.
    const io = read('src/lib/editor/project-io.ts')
    const fnAt = io.indexOf('export async function openProjectFile(')
    const bumped = io.indexOf('const loadId = bumpProjectGeneration()')
    const cancelAt = io.indexOf('if (!file) return // canceled picker')
    expect(fnAt).toBeGreaterThan(-1)
    expect(bumped).toBeGreaterThan(fnAt) // inside openProjectFile
    expect(cancelAt).toBeGreaterThan(bumped) // in the picker wrapper, AFTER it
  })

  it('the toolbar opens the file it was given instead of picking again', () => {
    // The hidden input runs the ONLY picker on the toolbar path; a second
    // picker inside the coordinator made the user choose the same file twice.
    const toolbar = read('src/components/editor/Toolbar.tsx')
    expect(toolbar).toMatch(/await openProjectFile\(file\)/)
    expect(toolbar).not.toMatch(/openProjectFromPicker/)
    // And the File the input chose is what reaches the coordinator, not a
    // fresh pick.
    expect(toolbar).toMatch(/if \(file\) void handleLoadFile\(file\)/)
  })

  it('invalidates in-flight loads whenever a project is installed another way', () => {
    // File > New installs an empty project without an await of its own; the
    // bump stops a pending open from overwriting it. The restore path bumps
    // too, in the same step as its install.
    const menu = read('src/components/editor/MenuBar.tsx')
    const newCase = menu.indexOf("case 'file.newProject':")
    const bumpAt = menu.indexOf('bumpProjectGeneration()')
    const installAt = menu.indexOf('store.replaceDoc(createDoc())')
    expect(newCase).toBeGreaterThan(-1)
    expect(bumpAt).toBeGreaterThan(newCase)
    expect(installAt).toBeGreaterThan(bumpAt)

    const shell = read('src/components/editor/EditorShell.tsx')
    const shellBumpAt = shell.indexOf('bumpProjectGeneration()')
    const shellInstallAt = shell.indexOf('.replaceDoc(doc)')
    expect(shellBumpAt).toBeGreaterThan(-1)
    expect(shellInstallAt).toBeGreaterThan(shellBumpAt)
  })
})
