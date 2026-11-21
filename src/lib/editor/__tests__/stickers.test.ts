import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  STICKERS,
  STICKER_MAX_BYTES,
  StickerFetchError,
  fetchStickerFile,
  stickerUrl,
} from '../media/stickers'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('bundled stickers (0.25.0)', () => {
  it('ships six same-origin assets with unique ids and files', () => {
    expect(STICKERS.map((sticker) => sticker.id)).toEqual([
      'star',
      'heart',
      'speech-bubble',
      'arrow',
      'burst',
      'check',
    ])
    expect(new Set(STICKERS.map((sticker) => sticker.file)).size).toBe(STICKERS.length)
    for (const sticker of STICKERS) {
      const url = stickerUrl(sticker)
      expect(url).toBe(`/stickers/${sticker.file}`)
      expect(url.startsWith('/')).toBe(true)
      expect(url).not.toMatch(/^https?:/)
    }
  })

  it('fetches a sticker into an importable image File', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>', {
          status: 200,
          headers: { 'content-type': 'image/svg+xml' },
        }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const file = await fetchStickerFile(STICKERS[0])
    expect(fetchMock).toHaveBeenCalledWith('/stickers/star.svg')
    expect(file.name).toBe('sticker-star.svg')
    expect(file.type).toBe('image/svg+xml')
    expect(await file.text()).toContain('<svg')
  })

  it('reports a failed or missing local asset instead of throwing a raw fetch error', async () => {
    vi.stubGlobal('fetch', async () => new Response('missing', { status: 404 }))
    await expect(fetchStickerFile(STICKERS[0])).rejects.toBeInstanceOf(StickerFetchError)
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('network down')
    })
    await expect(fetchStickerFile(STICKERS[0])).rejects.toBeInstanceOf(StickerFetchError)
  })

  it('keeps a hostile file value inside the sticker directory', () => {
    // Only the basename is used, so a traversal cannot escape public/stickers.
    expect(stickerUrl({ id: 'x', name: 'X', file: '../../etc/passwd' })).toBe('/stickers/passwd')
    expect(stickerUrl({ id: 'x', name: 'X', file: 'a b.svg' })).toBe('/stickers/a%20b.svg')
  })

  it('ships every referenced file under public/stickers', () => {
    for (const sticker of STICKERS) {
      expect(
        existsSync(join(process.cwd(), 'public/stickers', sticker.file)),
        `${sticker.file} is missing`,
      ).toBe(true)
    }
  })

  it('refuses a response that is not an image or is oversized', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response('<html>nope</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    )
    await expect(fetchStickerFile(STICKERS[0])).rejects.toBeInstanceOf(StickerFetchError)

    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(new Uint8Array(STICKER_MAX_BYTES + 1), {
          status: 200,
          headers: { 'content-type': 'image/svg+xml' },
        }),
    )
    await expect(fetchStickerFile(STICKERS[0])).rejects.toBeInstanceOf(StickerFetchError)

    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(new Uint8Array(), {
          status: 200,
          headers: { 'content-type': 'image/svg+xml' },
        }),
    )
    await expect(fetchStickerFile(STICKERS[0])).rejects.toBeInstanceOf(StickerFetchError)
  })

  it('never names a remote host in the sticker module', () => {
    const source = readFileSync(join(process.cwd(), 'src/lib/editor/media/stickers.ts'), 'utf8')
    expect(source).not.toMatch(/https?:\/\//)
  })
})

describe('sticker MIME fallback (0.29.0)', () => {
  it('uses the SVG default when the response has no MIME type', async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])])
    const response = { ok: true, blob: async () => blob }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response),
    )
    const file = await fetchStickerFile(STICKERS[0]!)
    expect(file.type).toBe('image/svg+xml')
  })
})
