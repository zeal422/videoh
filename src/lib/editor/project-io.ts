'use client'

import { toast } from '@/hooks/use-toast'

import { importFile } from './media/probe'
import { deserializeDoc, projectFileName, serializeDoc } from './serialization'
import { useEditorStore } from './store'
import type { Doc } from './types'

/**
 * Project file I/O shared by the toolbar and the menu bar:
 * - `downloadProjectJSON()`  save the current project as `.veproj.json`
 * - `loadProjectFile()`      parse + validate a project JSON file
 * - `importMediaFiles()`     import media files with auto-relink (File > Import)
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

/** Parse a saved project file into a Doc (throws on invalid JSON/version). */
export async function loadProjectFile(file: File): Promise<Doc> {
  const text = await file.text()
  const { doc } = deserializeDoc(text)
  return doc
}

/**
 * Import media files into the project, auto-relinking assets whose name
 * matches an offline (missing) asset. Returns the number of files imported
 * (relinks count as imports). Never throws — failures surface as toasts.
 */
export async function importMediaFiles(files: FileList | File[]): Promise<number> {
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
          patch: {
            url: asset.url,
            duration: asset.duration,
            width: asset.width,
            height: asset.height,
            thumbnail: asset.thumbnail,
            waveformPeaks: asset.waveformPeaks,
          },
        })
        toast({ title: 'Media relinked', description: asset.name })
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
