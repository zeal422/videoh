/**
 * stickers.ts: the bundled local sticker set (0.25.0).
 *
 * Stickers are ordinary image assets: the picker fetches one of these
 * same-origin SVGs, wraps it as a File, and imports it through the normal image
 * path, so it gets a thumbnail, a content hash, and OPFS persistence with no new
 * schema. The URLs are deliberately relative; nothing here contacts a remote
 * host.
 */

export interface StickerDef {
  id: string
  name: string
  /** File name under `public/stickers/`. */
  file: string
}

export const STICKERS: readonly StickerDef[] = [
  { id: 'star', name: 'Star', file: 'star.svg' },
  { id: 'heart', name: 'Heart', file: 'heart.svg' },
  { id: 'speech-bubble', name: 'Speech bubble', file: 'speech-bubble.svg' },
  { id: 'arrow', name: 'Arrow', file: 'arrow.svg' },
  { id: 'burst', name: 'Burst', file: 'burst.svg' },
  { id: 'check', name: 'Check', file: 'check.svg' },
]

/** Largest bundled sticker this build imports (bytes). */
export const STICKER_MAX_BYTES = 2 * 1024 * 1024

/**
 * Same-origin asset URL for a sticker thumbnail and import. Only the basename
 * is used, so a hostile or future `file` value such as `../secret` cannot
 * escape the sticker directory.
 */
export function stickerUrl(sticker: StickerDef): string {
  const file = sticker.file.split(/[\\/]/).pop() ?? ''
  return `/stickers/${encodeURIComponent(file)}`
}

export class StickerFetchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StickerFetchError'
  }
}

/** Fetches a bundled sticker and returns it as an importable image File. */
export async function fetchStickerFile(sticker: StickerDef): Promise<File> {
  let response: Response
  try {
    response = await fetch(stickerUrl(sticker))
  } catch {
    throw new StickerFetchError(`Could not load the ${sticker.name} sticker`)
  }
  if (!response.ok) throw new StickerFetchError(`Could not load the ${sticker.name} sticker`)
  const blob = await response.blob()
  // A host answering 200 with something else (an error page, a huge file) must
  // not become an image asset: the import path trusts the MIME type and size.
  const type = blob.type || 'image/svg+xml'
  if (!type.startsWith('image/')) {
    throw new StickerFetchError(`The ${sticker.name} sticker was not an image`)
  }
  if (blob.size === 0 || blob.size > STICKER_MAX_BYTES) {
    throw new StickerFetchError(`The ${sticker.name} sticker is empty or too large`)
  }
  return new File([blob], `sticker-${sticker.id}.svg`, { type })
}
