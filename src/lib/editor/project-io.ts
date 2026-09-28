'use client'

import { toast } from '@/hooks/use-toast'

import { relinkPatchFrom, type RelinkMode } from './media/relink'
import { importFile } from './media/probe'
import {
  planSampleLoad,
  sampleImportAction,
  type SampleFile,
  type SampleLoadPlan,
} from './sample-media'
import { parseSerializedDoc, projectFileName, serializeDoc } from './serialization'
import { useEditorStore } from './store'
import type { Doc, MediaAsset } from './types'

/**
 * Project file I/O shared by the toolbar, the menu bar and the media bin:
 * - `downloadProjectJSON()`     save the current project as `.veproj.json`
 * - `loadProjectFile()`         parse + validate a project JSON file
 * - `importMediaFiles()`        import media files with auto-relink (File > Import)
 * - `loadSampleMedia()`         load the bundled samples (plus relink any offline)
 * - `hydrateSampleMedia()`      merge refetched samples into a doc being loaded
 * - `openProjectFile(file)`     THE project open: parse, hydrate, install, report
 * - `openProjectFromPicker()`   picker + `openProjectFile` (the File > Open path)
 * - `bumpProjectGeneration()`   invalidate in-flight loads when a project installs
 */

/** Serialize the current doc and trigger a browser download. Returns filename. */
export function downloadProjectJSON(): string {
  const state = useEditorStore.getState()
  const json = JSON.stringify(serializeDoc(state.doc), null, 2)
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const filename = projectFileName(state.doc.project.name)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
  return filename
}

/** Parse + validate a saved project file into a Doc (throws on invalid JSON/version). */
export async function loadProjectFile(file: File): Promise<Doc> {
  const text = await file.text()
  // Parse the text HERE: deserializeDoc validates an already-parsed value, and
  // feeding it the raw string failed every real open with "root is not an
  // object" (autosave restore used parseSerializedDoc and worked).
  const { doc } = parseSerializedDoc(text)
  return doc
}

/**
 * Import media files into the project, auto-relinking assets whose name
 * matches an offline (missing) asset. Returns the number of files imported
 * (relinks count as imports). Never throws — failures surface as toasts.
 *
 * `sample: true` marks an import whose bytes are the app's own bundled
 * samples: those may only be ADDED when the bin does not already hold the
 * name, so an import that overlaps another load (or a restore) can never
 * leave a twin asset behind. `sampleMode` picks the relink patch mode: a
 * mid-session button press probes freshly enough for `'sample'`-preserving
 * recovery (the default), while the post-restore hydration passes the mode
 * down from `hydrateSampleMedia`.
 */
export async function importMediaFiles(
  files: FileList | File[],
  options?: { sample?: boolean; sampleMode?: RelinkMode },
): Promise<number> {
  const sampleMode = options?.sampleMode ?? 'sample'
  let imported = 0
  for (const file of Array.from(files)) {
    try {
      const asset = await importFile(file)
      const store = useEditorStore.getState()
      const missing = store.doc.media.find((m) => m.missing && m.name === asset.name)
      if (missing) {
        store.apply({
          type: 'relinkMedia',
          mediaId: missing.id,
          patch: relinkPatchFrom(asset, sampleMode),
        })
        toast({ title: 'Media relinked', description: asset.name })
      } else if (options?.sample && sampleImportAction(store.doc.media, asset.name) !== 'add') {
        // The bin changed while this file was probing: another load or a
        // restore already brought the sample in, so there is nothing to add.
        continue
      } else {
        store.apply({ type: 'addMediaAsset', asset })
      }
      imported += 1
    } catch (error) {
      toast({
        title: `Could not import ${file.name}`,
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      })
    }
  }
  return imported
}

/**
 * Fetches the bundled sample files into `File`s. A sample that cannot be
 * fetched is skipped and returned in `failed`, so the caller decides whether
 * and when to report it: `loadSampleMedia` toasts immediately (its batch is
 * a user action against the current project), while `hydrateSampleMedia`
 * collects the names and only surfaces them if its load is still current (a
 * load superseded mid-fetch must not report anything, same rule as the
 * install in `openProjectFile`).
 */
async function fetchSampleFiles(samples: readonly SampleFile[]): Promise<{
  files: File[]
  failed: string[]
}> {
  const files: File[] = []
  const failed: string[] = []
  for (const sample of samples) {
    try {
      const res = await fetch(sample.path)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blob = await res.blob()
      files.push(new File([blob], sample.name, { type: blob.type }))
    } catch {
      failed.push(sample.name)
    }
  }
  return { files, failed }
}

/**
 * Fetches a plan's files and imports each one, in order.
 *
 * The run is bound to the project that produced the plan: if another project
 * is opened or restored while the samples are downloading, NOTHING lands:
 * no files are imported and no failures are reported. A stale "Sample
 * unavailable" toast for the old project would read as the new project
 * being broken (same rule as a superseded load in `openProjectFile`).
 */
async function importPlannedSamples(plan: SampleLoadPlan, projectId: string): Promise<number> {
  const { files, failed } = await fetchSampleFiles([...plan.fresh, ...plan.relink])
  // Fetches take time: re-check the binding BEFORE reporting anything.
  if (useEditorStore.getState().doc.project.id !== projectId) return 0
  for (const name of failed) {
    // Still the planning project, so reporting immediately is correct here.
    toast({ title: 'Sample unavailable', description: name, variant: 'destructive' })
  }
  let imported = 0
  for (const file of files) {
    if (useEditorStore.getState().doc.project.id !== projectId) break
    imported += await importMediaFiles([file], { sample: true })
  }
  return imported
}

/** In-flight sample load, shared by every caller (see `loadSampleMedia`). */
let sampleLoadInFlight: Promise<SampleLoadResult> | null = null

export interface SampleLoadResult {
  /** Sample files handed to the importer: new assets plus relinks. */
  imported: number
  /** True when every bundled sample is already in the bin and online. */
  upToDate: boolean
}

/**
 * "Load sample media": imports the samples the bin lacks and refetches the
 * ones that came back offline, so the button is a recovery path after a
 * restore instead of a dead end that only reports "already loaded".
 *
 * Overlapping calls share ONE run. The plan is read once, so a second press
 * while the fetches are still in flight would otherwise race the first and
 * import the same files twice; here the second caller just gets the same
 * promise, and `importMediaFiles` re-checks the live bin before every write.
 */
export function loadSampleMedia(): Promise<SampleLoadResult> {
  if (sampleLoadInFlight) return sampleLoadInFlight
  const run = runSampleLoad().finally(() => {
    sampleLoadInFlight = null
  })
  sampleLoadInFlight = run
  return run
}

async function runSampleLoad(): Promise<SampleLoadResult> {
  const state = useEditorStore.getState()
  const plan = planSampleLoad(state.doc.media)
  if (plan.fresh.length === 0 && plan.relink.length === 0) {
    return { imported: 0, upToDate: true }
  }
  return { imported: await importPlannedSamples(plan, state.doc.project.id), upToDate: false }
}

export interface SampleHydration {
  /** The doc with recovered sample bytes merged in (same doc when none were offline). */
  doc: Doc
  /** Offline bundled samples refetched and merged. */
  relinked: number
  /** Media assets still offline after the merge (they need the user's file). */
  remaining: number
  /** Bundled samples whose refetch or probe failed. The CALLER reports these, only when its load is still current. */
  failed: string[]
}

/**
 * Call BEFORE installing a loaded project or a restored session. Every asset
 * hydrates offline (object URLs cannot persist) and bundled samples are the
 * only bytes the app still has, so they are refetched and merged into the doc
 * that is about to be installed.
 *
 * Merging into the doc itself, rather than running `relinkMedia` commands
 * afterwards, keeps the load one undoable operation: post-install commands
 * each push their own history entry, so one Ctrl+Z would drop a single sample
 * back to offline and black out the preview again.
 */
export async function hydrateSampleMedia(doc: Doc): Promise<SampleHydration> {
  const remainingIn = (media: readonly MediaAsset[]) => media.filter((m) => m.missing).length
  const failedIn = (...groups: string[][]) => groups.flat()
  const plan = planSampleLoad(doc.media)
  if (plan.relink.length === 0) {
    return { doc, relinked: 0, remaining: remainingIn(doc.media), failed: [] }
  }

  const { files, failed } = await fetchSampleFiles(plan.relink)
  const probes = new Map<string, MediaAsset>()
  const probeFailed: string[] = []
  for (const file of files) {
    try {
      probes.set(file.name, await importFile(file))
    } catch {
      probeFailed.push(file.name)
    }
  }
  if (probes.size === 0) {
    return {
      doc,
      relinked: 0,
      remaining: remainingIn(doc.media),
      failed: failedIn(failed, probeFailed),
    }
  }

  let relinked = 0
  const media = doc.media.map((asset) => {
    if (!asset.missing) return asset
    const fresh = probes.get(asset.name)
    if (!fresh) return asset
    relinked += 1
    return { ...asset, ...relinkPatchFrom(fresh, 'sample'), missing: false }
  })
  return {
    doc: { ...doc, media },
    relinked,
    remaining: remainingIn(media),
    failed: failedIn(failed, probeFailed),
  }
}

/** Trigger the browser file picker and resolve with the selected files. */
export function pickFiles(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.multiple = multiple
    input.style.display = 'none'
    input.addEventListener('change', () => {
      resolve(input.files ? Array.from(input.files) : [])
      input.remove()
    })
    // If the user cancels, `change` never fires — resolve empty on focus return.
    window.addEventListener('focus', () => setTimeout(() => resolve([]), 300), { once: true })
    document.body.appendChild(input)
    input.click()
  })
}

/**
 * Project-install coordination.
 *
 * A project load is not one step: pick the file, parse it, fetch the bundled
 * samples, merge, install. Between the pick and the install, the user can
 * start another load from EITHER entry point (toolbar button, File > Open),
 * or install a project in some other way (File > New). Whichever lands last
 * wins, so every loader asks the shared generation before it installs, and
 * every installer invalidates the loads that are still in flight.
 *
 * This lives here and not in a component: MenuBar and Toolbar each held their
 * own counter, which only ordered loads that passed through the SAME handler.
 * A toolbar open and a menu open could still clobber each other, and neither
 * counter was bumped by `file.newProject`, so a pending load could overwrite
 * a brand-new empty project.
 */
let projectGeneration = 0

/** Invalidates every project load still in flight. Call when a project is installed by any means. */
export function bumpProjectGeneration(): number {
  return ++projectGeneration
}

/** True when `loadId` is still the newest project request. */
export function isCurrentProjectLoad(loadId: number): boolean {
  return loadId === projectGeneration
}

/**
 * The one project-open implementation, shared by the menu and the toolbar:
 * parse the chosen file, merge the bundled samples, install, report.
 *
 * A load request is numbered as it ENTERS this function, and parsing,
 * hydration, install and error reporting all check the generation, so a load
 * that a newer request (or a new project) has superseded writes nothing and
 * reports nothing. Canceling a picker never reaches here, so it can never
 * invalidate a load that is already in flight.
 */
export async function openProjectFile(file: File): Promise<void> {
  const loadId = bumpProjectGeneration()
  try {
    const loaded = await loadProjectFile(file)
    // Bundled samples refetch themselves, merged into the doc before it is
    // installed so the load stays one undo step; the toast reports what
    // still needs the user's file.
    const { doc, relinked, remaining, failed } = await hydrateSampleMedia(loaded)
    if (!isCurrentProjectLoad(loadId)) return // a newer request superseded this one
    useEditorStore.getState().replaceDoc(doc)
    for (const name of failed) {
      // Hydration failures are REPORTED here, not toasted mid-fetch by the
      // hydration itself, so a superseded load stays silent end to end.
      toast({ title: 'Sample unavailable', description: name, variant: 'destructive' })
    }
    toast({
      title: 'Project loaded',
      description:
        remaining > 0
          ? `${remaining} media file(s) need relinking`
          : relinked > 0
            ? `${relinked} sample file(s) relinked automatically`
            : undefined,
    })
  } catch (error) {
    if (!isCurrentProjectLoad(loadId)) return
    toast({
      title: 'Load failed',
      description: error instanceof Error ? error.message : String(error),
      variant: 'destructive',
    })
  }
}

/**
 * File > Open with the picker: choose a file, then hand it to `openProjectFile`.
 * A canceled picker returns without touching the generation, so an in-flight
 * load stays current.
 */
export async function openProjectFromPicker(accept = '.json,application/json'): Promise<void> {
  const files = await pickFiles(accept)
  const file = files[0]
  if (!file) return // canceled picker: an in-flight load stays current
  return openProjectFile(file)
}
