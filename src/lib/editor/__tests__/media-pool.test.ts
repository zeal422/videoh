import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { SAMPLES, planSampleLoad, sampleImportAction } from '../sample-media'
import { relinkPatchFrom } from '../media/relink'
import type { MediaAsset } from '../types'

/**
 * Media-pool regression locks (user bug reports: "Load sample media" spammed
 * duplicates into the bin, the bin list could not scroll to reach items below
 * the fold, and a restored session left the samples offline with no way back).
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
 * The sample half is covered by real unit tests for `planSampleLoad` plus
 * wiring locks: loadSamples consults it (through loadSampleMedia) and guards
 * re-entrancy, and every restore/load path refetches bundled samples.
 *
 * The 0.5.3 relink hardening is locked here too: `sampleImportAction` is what
 * stops an overlapping load from twinning a sample (user report: duplicates in
 * the bin), and `relinkPatchFrom` is what keeps the source File handle on a
 * relinked asset so the WebCodecs export still has bytes to read. The manual
 * mode clears metadata a replacement file does not provide; the sample mode
 * preserves it (a recovery refetches the same bundled file).
 */

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

describe('planSampleLoad (sample loading + offline relink)', () => {
  it('marks every sample fresh when the bin is empty', () => {
    expect(planSampleLoad([])).toEqual({ fresh: SAMPLES, relink: [] })
  })

  it('skips samples already in the bin and online', () => {
    const online = SAMPLES.map((s) => ({ name: s.name }))
    expect(planSampleLoad(online)).toEqual({ fresh: [], relink: [] })
  })

  it('targets offline samples for relink instead of skipping them', () => {
    // The restored-session case: every asset hydrates missing, so a name that
    // is present but offline must be refetched, not treated as loaded.
    const restored = SAMPLES.map((s) => ({ name: s.name, missing: true }))
    const plan = planSampleLoad(restored)
    expect(plan.fresh).toEqual([])
    expect(plan.relink).toEqual(SAMPLES)
  })

  it('splits a mixed bin into fresh adds and offline relinks', () => {
    const mixed = [{ name: 'sample-video.mp4' }, { name: 'sample-audio.mp3', missing: true }]
    const plan = planSampleLoad(mixed)
    expect(plan.fresh).toEqual([{ path: '/samples/sample-image.png', name: 'sample-image.png' }])
    expect(plan.relink).toEqual([{ path: '/samples/sample-audio.mp3', name: 'sample-audio.mp3' }])
  })

  it('is not confused by user-imported files with different names', () => {
    const existing = [{ name: 'holiday.mp4' }, { name: 'song.mp3', missing: true }]
    expect(planSampleLoad(existing)).toEqual({ fresh: SAMPLES, relink: [] })
  })

  it('does not mutate its inputs', () => {
    const existing = [{ name: 'sample-video.mp4', missing: true }]
    const snapshot = structuredClone(existing)
    planSampleLoad(existing)
    expect(existing).toEqual(snapshot)
  })
})

describe('sampleImportAction (the duplicate guard)', () => {
  it('adds a sample the bin does not have', () => {
    expect(sampleImportAction([], 'sample-video.mp4')).toBe('add')
  })

  it('relinks a sample the bin has but lost the bytes for', () => {
    const bin = [{ name: 'sample-video.mp4', missing: true }]
    expect(sampleImportAction(bin, 'sample-video.mp4')).toBe('relink')
  })

  it('skips a sample an overlapping load already brought in', () => {
    // The twin-asset case: a plan read before the first load landed would
    // otherwise add a second asset with the same name and the same bytes.
    const bin = [{ name: 'sample-video.mp4' }]
    expect(sampleImportAction(bin, 'sample-video.mp4')).toBe('skip')
  })
})

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

describe('media pool layout + dedup wiring', () => {
  it('makes PanelShell content a flex column so flex-1 children inherit height', () => {
    const shell = read('src/components/editor/PanelShell.tsx')
    // The wrapper div that hosts arbitrary panel children must constrain them.
    expect(shell).toMatch(/className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"/)
  })

  it('keeps the MediaBin list the scrollable, height-constrained element', () => {
    const bin = read('src/components/editor/MediaBin.tsx')
    expect(bin).toMatch(/editor-scroll[^"]*min-h-0 flex-1[^"]*overflow-y-auto/)
    // And the aside itself stays a height-aware flex column.
    expect(bin).toMatch(/'flex min-h-0 flex-col bg-card'/)
  })

  it('dedups sample loading and guards against in-flight re-presses', () => {
    const bin = read('src/components/editor/MediaBin.tsx')
    expect(bin).toMatch(/await loadSampleMedia\(\)/)
    expect(bin).toMatch(/loadingSamplesRef\.current = true/)
    expect(bin).toMatch(/Sample media already loaded/)
    expect(bin).toMatch(/disabled=\{importing > 0\}/)
  })

  it('refetches bundled samples before every restore / project load installs the doc', () => {
    // The restore path hydrates inline. The two open entry points delegate to
    // openProjectFromPicker, which does the hydrate-before-install inside the
    // coordinator (locked separately there via the file>install ordering).
    const shell = read('src/components/editor/EditorShell.tsx')
    expect(shell).toMatch(/await hydrateSampleMedia\(restored\)/)
    const hydrateAt = shell.indexOf('await hydrateSampleMedia(restored)')
    const installAt = shell.indexOf('.replaceDoc(doc)')
    expect(installAt).toBeGreaterThan(hydrateAt)

    const io = read('src/lib/editor/project-io.ts')
    const ioHydrateAt = io.indexOf('await hydrateSampleMedia(loaded)')
    const ioInstallAt = io.indexOf('.replaceDoc(doc)')
    expect(ioHydrateAt).toBeGreaterThan(-1)
    expect(ioInstallAt).toBeGreaterThan(ioHydrateAt)
  })

  it('keeps both relink sites on the shared patch helper', () => {
    // One field list for the bin's manual relink and the sample import: a
    // hand-rolled list once dropped `file`, which silently removes the media
    // from a WebCodecs export (mp4.ts skips assets without it).
    expect(read('src/components/editor/MediaBin.tsx')).toMatch(
      /patch: relinkPatchFrom\(fresh, 'manual'\)/,
    )
    expect(read('src/lib/editor/project-io.ts')).toMatch(/relinkPatchFrom\(asset, sampleMode\)/)
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

  it('hydration reports failures through its caller, gated on the generation', () => {
    // A load superseded mid-hydration must stay silent end to end: if the
    // hydration toasted its own fetch failures, a stale load could still raise
    // destructive toasts after a newer open won (violating "writes nothing and
    // reports nothing"). Failures ride back as data; the CALLER reports them
    // behind the same generation check as the install.
    const io = read('src/lib/editor/project-io.ts')
    // No toast call inside the hydration path itself (slice ends at the next
    // top-level export so the caller's toasts cannot leak into the match).
    const start = io.indexOf('export async function hydrateSampleMedia')
    const end = io.indexOf('export function pickFiles')
    const hydrate = io.slice(start, end)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(hydrate).not.toMatch(/toast\(/)
    // The helper it calls is silent too.
    const fetchStart = io.indexOf('async function fetchSampleFiles')
    const fetchEnd = io.indexOf('async function importPlannedSamples')
    expect(io.slice(fetchStart, fetchEnd)).not.toMatch(/toast\(/)
    // ...failures are part of the result...
    expect(io).toMatch(/failed: string\[\]/)
    // ...and openProjectFile reports them AFTER the generation check (search
    // inside openProjectFile only: importPlannedSamples also has a `failed`
    // loop, but that one reports immediately for the button path by design).
    const openFn = io.slice(io.indexOf('export async function openProjectFile'))
    const gate = openFn.indexOf(
      'if (!isCurrentProjectLoad(loadId)) return // a newer request superseded',
    )
    const report = openFn.indexOf('for (const name of failed)')
    expect(gate).toBeGreaterThan(-1)
    expect(report).toBeGreaterThan(gate)
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
    const hydrateAt = shell.indexOf('await hydrateSampleMedia(restored)')
    const shellBumpAt = shell.indexOf('bumpProjectGeneration()')
    const shellInstallAt = shell.indexOf('.replaceDoc(doc)')
    expect(shellBumpAt).toBeGreaterThan(hydrateAt)
    expect(shellInstallAt).toBeGreaterThan(shellBumpAt)
  })

  it('binds a sample import to the project that planned it', () => {
    const io = read('src/lib/editor/project-io.ts')
    // Concurrent loads coalesce into one run...
    expect(io).toMatch(/if \(sampleLoadInFlight\) return sampleLoadInFlight/)
    // ...and the batch stops the moment the project that planned it is gone.
    expect(io).toMatch(/doc\.project\.id !== projectId\) break/)
    // Failures are also silent once the project changed: the re-check sits
    // BEFORE the failure-reporting loop (stale toasts would read as the new
    // project being broken).
    const planned = io.slice(
      io.indexOf('async function importPlannedSamples'),
      io.indexOf('/** In-flight sample load'),
    )
    const recheck = planned.indexOf('doc.project.id !== projectId) return 0')
    const report = planned.indexOf("toast({ title: 'Sample unavailable'")
    expect(recheck).toBeGreaterThan(-1)
    expect(report).toBeGreaterThan(recheck)
    // Every sample write re-checks the live bin first (the twin guard).
    expect(io).toMatch(/options\?\.sample && sampleImportAction\(/)
  })
})
