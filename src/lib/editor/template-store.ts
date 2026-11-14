/**
 * template-store.ts: the browser-bound IndexedDB library for user-saved
 * templates (0.26.0).
 *
 * Templates live outside the project file and outside `Doc`: they are
 * deterministic sequence descriptions with no media. Every value crossing this
 * boundary is re-parsed by `parseTemplate`, so a hand-edited IndexedDB record
 * can never inject an invalid sequence into the editor.
 */

import { parseTemplate, type ProjectTemplate } from './templates'

const DB_NAME = 'videoh-template-library'
const DB_VERSION = 1
const STORE_NAME = 'templates'

/** True when this runtime exposes IndexedDB. */
export function templatesSupported(): boolean {
  return typeof indexedDB !== 'undefined'
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!templatesSupported()) {
      reject(new Error('This browser cannot store templates'))
      return
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'id' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () =>
      reject(request.error ?? new Error('Could not open the template library'))
  })
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | undefined> {
  const database = await openDatabase()
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode)
      const store = transaction.objectStore(STORE_NAME)
      const request = run(store)
      transaction.oncomplete = () => resolve(request ? request.result : undefined)
      transaction.onerror = () => reject(transaction.error ?? new Error('Template storage failed'))
      transaction.onabort = () => reject(transaction.error ?? new Error('Template storage aborted'))
    })
  } finally {
    database.close()
  }
}

/** Every valid saved template, in IndexedDB key order. */
export async function listSavedTemplates(): Promise<ProjectTemplate[]> {
  const raw = await withStore<unknown[]>('readonly', (store) => store.getAll())
  if (!Array.isArray(raw)) return []
  const templates: ProjectTemplate[] = []
  for (const entry of raw) {
    try {
      templates.push(parseTemplate(entry))
    } catch {
      // A corrupt record is skipped, not deleted: the user can still inspect
      // the library after a failed save without losing unrelated entries.
    }
  }
  return templates
}

/** Validates and stores one template, replacing a record with the same id. */
export async function saveTemplate(template: ProjectTemplate): Promise<void> {
  const parsed = parseTemplate(template)
  await withStore('readwrite', (store) => store.put(parsed))
}

/**
 * Renames or re-describes a saved template. The read, validation, patch, and
 * write share ONE readwrite transaction: a concurrent delete or save cannot
 * land between the read and the write, and an absent record writes nothing.
 */
export async function updateSavedTemplate(
  id: string,
  patch: { name?: string; description?: string },
): Promise<void> {
  const database = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite')
      const store = transaction.objectStore(STORE_NAME)
      const get = store.get(id)
      let failure: Error | null = null
      get.onsuccess = () => {
        const saved = get.result as unknown
        if (!saved) {
          failure = new Error('Template no longer exists')
          return
        }
        try {
          const parsed = parseTemplate(saved)
          const next = parseTemplate({
            ...parsed,
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.description !== undefined ? { description: patch.description } : {}),
          })
          store.put(next)
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error))
        }
      }
      transaction.oncomplete = () => {
        if (failure) reject(failure)
        else resolve()
      }
      transaction.onerror = () => reject(transaction.error ?? new Error('Template storage failed'))
      transaction.onabort = () => reject(transaction.error ?? new Error('Template storage aborted'))
    })
  } finally {
    database.close()
  }
}

/** Deletes one saved template. */
export async function deleteSavedTemplate(id: string): Promise<void> {
  await withStore('readwrite', (store) => store.delete(id))
}
