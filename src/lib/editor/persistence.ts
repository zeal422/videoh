import { isTransientActive, editorStore } from './store'
import { parseSerializedDoc, serializeDoc } from './serialization'
import type { Doc } from './types'

/**
 * Local autosave: debounced writes of the serialized doc to localStorage.
 * Object URLs are never persisted; restored assets start "missing" and can be
 * relinked from the media bin.
 */

const AUTOSAVE_KEY = 'web-video-editor:autosave:v1'
const DEBOUNCE_MS = 800

/** Writes the doc to localStorage. Returns false on quota/serialization errors. */
export function writeAutosave(doc: Doc): boolean {
  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(serializeDoc(doc)))
    return true
  } catch {
    return false
  }
}

/** Reads the raw autosaved JSON (or null). */
export function readAutosave(): string | null {
  try {
    return localStorage.getItem(AUTOSAVE_KEY)
  } catch {
    return null
  }
}

export function clearAutosave(): void {
  try {
    localStorage.removeItem(AUTOSAVE_KEY)
  } catch {
    // ignore
  }
}

/** Validates autosaved JSON. Returns the text if usable, else null. */
export function readValidAutosave(): string | null {
  const json = readAutosave()
  if (!json) return null
  try {
    parseSerializedDoc(json)
    return json
  } catch {
    return null
  }
}

/**
 * Subscribes to the store and autosaves (debounced) after every committed change.
 * Transient drag frames are skipped; the final commit triggers one save.
 * Returns an unsubscribe function (call on unmount).
 */
export function initAutosave(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null

  const unsubscribe = editorStore.subscribe((state, prevState) => {
    // Save when the doc changes (commands) OR when a transient gesture commits
    // (commitTransient only moves `past` — the doc reference is already final).
    const docChanged =
      state.doc !== prevState.doc ||
      state.past !== prevState.past ||
      state.future !== prevState.future
    if (!docChanged) return // ignore playhead/selection/zoom churn
    if (isTransientActive()) return
    if (timer) clearTimeout(timer)
    editorStore.getState().setAutosaveStatus('pending')
    timer = setTimeout(() => {
      const ok = writeAutosave(editorStore.getState().doc)
      editorStore.getState().setAutosaveStatus(ok ? 'saved' : 'error')
      if (ok) editorStore.getState().markAutosaved()
    }, DEBOUNCE_MS)
  })

  return () => {
    if (timer) clearTimeout(timer)
    unsubscribe()
  }
}

/** Parsers autosave JSON into a doc (throws if corrupt). */
export function parseAutosave(json: string): ReturnType<typeof parseSerializedDoc> {
  return parseSerializedDoc(json)
}
