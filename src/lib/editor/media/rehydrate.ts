/**
 * rehydrate.ts: restore object URLs and File handles before a project install
 * (0.23.0).
 *
 * Parsing stays synchronous; this is the one async step between parsing and
 * `installProject`. Each asset with a content hash reads its stored bytes back,
 * verifies them through the store, and rebuilds the `File` from the serialized
 * name plus the sidecar MIME type. Assets without a hash, and entries whose
 * bytes are missing or damaged, stay `missing` and use the existing relink path.
 *
 * Browser-bound.
 */

import type { Doc, MediaAsset } from '../types'
import { isValidContentHash } from '../project-validation'
import { readMediaFile } from './media-store'
import { endMediaActivity, beginMediaActivityWhenIdle } from './persist'

export interface MediaRehydration {
  doc: Doc
  warnings: string[]
  /** Assets whose bytes were restored. */
  hydrated: number
  /** Assets that named a hash but whose bytes were missing or damaged. */
  unreadable: number
  /** Object URLs created by this run, so a superseded request can revoke them. */
  urls: string[]
}

/** Extension to MIME fallback when the sidecar is missing or malformed. */
const MIME_BY_EXTENSION: Record<string, string> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  ogv: 'video/ogg',
  mkv: 'video/x-matroska',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  flac: 'audio/flac',
  opus: 'audio/opus',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
}

export function mimeTypeForName(name: string): string {
  const extension = name.split('.').pop()?.toLowerCase() ?? ''
  return MIME_BY_EXTENSION[extension] ?? 'application/octet-stream'
}

/**
 * Rebuilds media handles for a parsed doc. Never throws: a store failure leaves
 * the asset missing, which is the same state a v4 project already handles.
 */
export async function rehydrateMedia(doc: Doc): Promise<MediaRehydration> {
  const warnings: string[] = []
  const urls: string[] = []
  let hydrated = 0
  let unreadable = 0
  let sidecarFallbacks = 0

  await beginMediaActivityWhenIdle()
  try {
    const media: MediaAsset[] = []
    for (const asset of doc.media) {
      if (!isValidContentHash(asset.contentHash)) {
        media.push(asset)
        continue
      }
      let stored: Awaited<ReturnType<typeof readMediaFile>> = null
      try {
        stored = await readMediaFile(doc.project.id, asset.contentHash)
      } catch {
        stored = null
      }
      if (!stored) {
        unreadable += 1
        media.push(asset)
        continue
      }
      const type = stored.type || mimeTypeForName(asset.name)
      if (!stored.hasSidecar) sidecarFallbacks += 1
      const file = new File([stored.file], asset.name, { type })
      const url = URL.createObjectURL(file)
      urls.push(url)
      hydrated += 1
      media.push({ ...asset, file, url, missing: false })
    }
    if (sidecarFallbacks > 0) {
      warnings.push(
        `Rebuilt ${sidecarFallbacks} media file${sidecarFallbacks === 1 ? '' : 's'} from the file extension because its stored type was missing.`,
      )
    }
    return { doc: { ...doc, media }, warnings, hydrated, unreadable, urls }
  } finally {
    endMediaActivity()
  }
}

/** Revokes object URLs created by a rehydration that is being discarded. */
export function revokeRehydratedUrls(urls: readonly string[]): void {
  for (const url of urls) {
    try {
      URL.revokeObjectURL(url)
    } catch {
      // A revoked or invalid URL is already harmless.
    }
  }
}
