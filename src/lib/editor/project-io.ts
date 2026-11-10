'use client'

import { toast } from '@/hooks/use-toast'

import { relinkPatchFrom } from './media/relink'
import { importFile } from './media/probe'
import { buildProxy, revokeAllProxies } from './media/proxies'
import { shouldProxy } from './proxy'
import { parseSerializedDoc, projectFileName, serializeDoc } from './serialization'
import { useEditorStore } from './store'
import type { Doc, MediaAsset } from './types'

/**
 * Project file I/O shared by the toolbar, the menu bar and the media bin:
 * - `downloadProjectJSON()`     save the current project as `.veproj.json`
 * - `loadProjectFile()`         parse + validate a project JSON file
 * - `importMediaFiles()`        import media files with auto-relink (File > Import)
 * - `openProjectFile(file)`     THE project open: parse, install, report
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
export async function loadProjectFile(file: File): Promise<{ doc: Doc; warnings: string[] }> {
  const text = await file.text()
  // Parse the text HERE: deserializeDoc validates an already-parsed value, and
  // feeding it the raw string failed every real open with "root is not an
  // object" (autosave restore used parseSerializedDoc and worked).
  const { doc, warnings } = parseSerializedDoc(text)
  return { doc, warnings }
}

/**
 * Import media files into the project, auto-relinking assets whose name
 * matches an offline (missing) asset. Returns the number of files imported
 * (relinks count as imports). Never throws — failures surface as toasts.
 */
export async function importMediaFiles(files: FileList | File[]): Promise<number> {
  let imported = 0
  const heavy: MediaAsset[] = []
  for (const file of Array.from(files)) {
    try {
      const asset = await importFile(file)
      const store = useEditorStore.getState()
      const missing = store.doc.media.find((m) => m.missing && m.name === asset.name)
      if (missing) {
        if (
          !store.apply({
            type: 'relinkMedia',
            mediaId: missing.id,
            patch: relinkPatchFrom(asset, 'manual'),
          })
        )
          continue
        toast({ title: 'Media relinked', description: asset.name })
      } else {
        store.apply({ type: 'addMediaAsset', asset })
        if (shouldProxy(asset)) heavy.push(asset)
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
  // Heavy sources: build a proxy now when proxies are on, else prompt once.
  if (heavy.length > 0) {
    if (useEditorStore.getState().proxiesEnabled) {
      for (const asset of heavy) void buildProxy(asset)
    } else {
      toast({
        title: 'Heavy source imported',
        description: `${heavy.map((a) => a.name).join(', ')} exceeds 1920 px. Enable View > Use Proxies for smoother preview.`,
      })
    }
  }
  return imported
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
 * A project load is not one step: pick the file, parse it, mark unresolved
 * assets missing, install. Between the pick and the install, the user can
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
 * THE project install path (0.20.0): invalidate in-flight loads, revoke the
 * old project's proxy URLs, replace the doc, and clear any restore banner.
 * Every installer routes through this, so no path can leave a stale autosave
 * prompt over a project that is already live. Callers keep their warnings and
 * toasts.
 */
export function installProject(doc: Doc): void {
  bumpProjectGeneration()
  revokeAllProxies()
  const store = useEditorStore.getState()
  store.replaceDoc(doc)
  store.clearPendingRestore()
}

/**
 * The one project-open implementation, shared by the menu and the toolbar:
 * parse the chosen file, install, report.
 *
 * A load request is numbered as it ENTERS this function, and parsing,
 * install and error reporting all check the generation, so a load that a
 * newer request (or a new project) has superseded writes nothing and reports
 * nothing. Canceling a picker never reaches here, so it can never invalidate
 * a load that is already in flight.
 */
export async function openProjectFile(file: File): Promise<void> {
  const loadId = bumpProjectGeneration()
  // `installProject` bumps the generation itself, so after it starts a load can
  // no longer look "current". Track that transition explicitly: a stale id
  // means superseded only while installation has not started; a failure after
  // that point must still be reported.
  let installStarted = false
  try {
    const { doc, warnings } = await loadProjectFile(file)
    if (!isCurrentProjectLoad(loadId)) return // a newer request superseded this one
    // The old project's proxy object URLs belong to it; installProject
    // revokes them, installs the doc, and clears any restore banner.
    installStarted = true
    installProject(doc)
    const remaining = doc.media.filter((asset) => asset.missing).length
    const description = [
      remaining > 0 ? `${remaining} media file(s) need relinking.` : undefined,
      ...warnings,
    ]
      .filter(Boolean)
      .join(' ')
    toast({
      title: 'Project loaded',
      description: description || undefined,
    })
  } catch (error) {
    if (!installStarted && !isCurrentProjectLoad(loadId)) return
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
