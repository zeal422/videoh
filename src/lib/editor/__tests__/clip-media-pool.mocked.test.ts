// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ClipMediaPool } from '../media/elements'
import {
  FakeAudioContext,
  installBrowserMocks,
  setMediaError,
  type MockHarness,
} from './mocks/browser-mocks'
import { createClip, createMediaAsset } from '../factories'
import type { MediaAsset } from '../types'

/**
 * ClipMediaPool against mocked media elements ("B" side of the A/B battery):
 * per-clip element identity, relink re-creation, source-node caching and
 * container cleanup.
 */

let h: MockHarness

beforeEach(() => {
  h = installBrowserMocks()
  // jsdom keeps ONE document per file — drop pooled elements from prior tests.
  document.body.innerHTML = ''
})

afterEach(() => {
  h.uninstall()
})

function asset(kind: MediaAsset['kind'] = 'video'): MediaAsset {
  return createMediaAsset({ id: 'm1', kind, name: `${kind}.f`, duration: 9, url: `blob:${kind}` })
}

function clip(id = 'c1', audioOnly = false) {
  return createClip({ id, mediaId: 'm1', start: 0, duration: 2, inPoint: 0, audioOnly })
}

describe('ClipMediaPool (mocked browser)', () => {
  it('creates one video element per clip, parked in a hidden container', () => {
    const pool = new ClipMediaPool()
    const el = pool.get(clip('c1'), asset())
    expect(el).toBeInstanceOf(HTMLVideoElement)
    expect(el.src).toContain('blob:video')
    expect(el.preload).toBe('auto')
    expect(el.dataset.assetId).toBe('m1')
    expect(el.parentElement).not.toBeNull()
    expect(el.parentElement?.getAttribute('aria-hidden')).toBe('true')
    expect(document.body.contains(el)).toBe(true)
  })

  it('reuses the element while the asset is unchanged', () => {
    const pool = new ClipMediaPool()
    const c = clip('c1')
    const a = asset()
    const first = pool.get(c, a)
    expect(pool.get(c, a)).toBe(first)
  })

  it('re-creates the element after a relink (asset url change) and drops the old one', () => {
    const pool = new ClipMediaPool()
    const c = clip('c1')
    const first = pool.get(c, asset())
    const relinked = createMediaAsset({
      kind: 'video',
      name: 'new',
      duration: 9,
      url: 'blob:fixed',
    })
    const second = pool.get(c, relinked)
    expect(second).not.toBe(first)
    expect(document.body.contains(first)).toBe(false)
    expect(document.body.contains(second)).toBe(true)
  })

  it('creates separate elements for two clips sharing one asset', () => {
    const pool = new ClipMediaPool()
    const a = asset()
    const e1 = pool.get(clip('c1'), a)
    const e2 = pool.get(clip('c2'), a)
    expect(e1).not.toBe(e2)
  })

  it('re-creates the element when the effective URL changes (proxy toggle)', () => {
    const pool = new ClipMediaPool()
    const c = clip('c1')
    const a = asset()
    const original = pool.get(c, a)
    expect(original.src).toContain('blob:video')
    const proxied = pool.get(c, a, 'blob:proxy')
    expect(proxied).not.toBe(original)
    expect(proxied.src).toContain('blob:proxy')
    expect(document.body.contains(original)).toBe(false)
    // Reverting the toggle restores the original URL.
    const back = pool.get(c, a)
    expect(back).not.toBe(proxied)
    expect(back.src).toContain('blob:video')
  })

  it('routes the parked blend partner through the same effective URL', () => {
    const pool = new ClipMediaPool()
    const c = clip('c1')
    const a = asset()
    const first = pool.getNext(c, a)
    expect(first?.src).toContain('blob:video')
    const proxied = pool.getNext(c, a, 'blob:proxy')
    expect(proxied).not.toBe(first)
    expect(proxied?.src).toContain('blob:proxy')
  })

  it('creates an audio element for audio assets', () => {
    const pool = new ClipMediaPool()
    const el = pool.get(clip('c1'), asset('audio'))
    expect(el).toBeInstanceOf(HTMLAudioElement)
    expect(el).not.toBeInstanceOf(HTMLVideoElement)
  })

  it('creates one video and one audio element for an A/V pair', () => {
    const pool = new ClipMediaPool()
    const a = asset('video')
    const picture = pool.get(clip('v1'), a)
    const twin = pool.get(clip('a1', true), a)
    expect(picture).toBeInstanceOf(HTMLVideoElement)
    expect(twin).toBeInstanceOf(HTMLAudioElement)
    expect(twin).not.toBeInstanceOf(HTMLVideoElement)
    expect(pool.getNext(clip('a1', true), a)).toBeUndefined()
    expect(pool.getNext(clip('v1'), a)).toBeInstanceOf(HTMLVideoElement)
  })

  it('recreates the element and drops the partner when audioOnly changes', () => {
    const pool = new ClipMediaPool()
    const a = asset('video')
    const videoClip = clip('c1')
    const audioClip = clip('c1', true)

    const videoEl = pool.get(videoClip, a)
    const partner = pool.getNext(videoClip, a)
    expect(videoEl).toBeInstanceOf(HTMLVideoElement)
    expect(partner).toBeInstanceOf(HTMLVideoElement)

    const audioEl = pool.get(audioClip, a)
    expect(audioEl).toBeInstanceOf(HTMLAudioElement)
    expect(audioEl).not.toBe(videoEl)
    expect(document.body.contains(videoEl)).toBe(false)
    // get() itself drops the parked partner when the clip becomes audio-only.
    expect(pool.peekNext('c1')).toBeUndefined()

    expect(pool.getNext(audioClip, a)).toBeUndefined()
    expect(pool.peekNext('c1')).toBeUndefined()
    expect(document.body.contains(partner!)).toBe(false)

    // Toggling back recreates the video element.
    const videoAgain = pool.get(videoClip, a)
    expect(videoAgain).toBeInstanceOf(HTMLVideoElement)
    expect(videoAgain).not.toBe(audioEl)
    expect(document.body.contains(audioEl)).toBe(false)
  })

  it('detaches the error listener before teardown loads the empty source', () => {
    const seen: string[] = []
    const pool = new ClipMediaPool((clipId) => seen.push(clipId))
    const el = pool.get(clip('c1'), asset())
    el.load = () => {
      el.dispatchEvent(new Event('error'))
    }

    pool.release('c1')

    expect(seen).toEqual([])
    expect(pool.peek('c1')).toBeUndefined()
  })

  it('drops the pool entry even when teardown throws', () => {
    const pool = new ClipMediaPool()
    const el = pool.get(clip('c1'), asset())
    el.pause = () => {
      throw new Error('detached')
    }

    expect(() => pool.release('c1')).not.toThrow()
    expect(pool.peek('c1')).toBeUndefined()
  })

  it('contains teardown throws and still removes the element', () => {
    const pool = new ClipMediaPool()
    const el = pool.get(clip('c1'), asset())
    let removed = false
    el.removeAttribute = () => {
      throw new Error('detached')
    }
    el.remove = () => {
      removed = true
      throw new Error('detached')
    }

    expect(() => pool.release('c1')).not.toThrow()
    expect(removed).toBe(true)
    expect(pool.peek('c1')).toBeUndefined()
  })

  it('reuses elements whose relative source resolves to an absolute URL', () => {
    const pool = new ClipMediaPool()
    const relative = createMediaAsset({
      kind: 'video',
      id: 'm1',
      name: 'relative.mp4',
      duration: 9,
      url: 'samples/relative.mp4',
    })
    const c = clip('c1')

    const primary = pool.get(c, relative)
    expect(pool.get(c, relative)).toBe(primary)
    const partner = pool.getNext(c, relative)
    expect(pool.getNext(c, relative)).toBe(partner)
  })

  it('attaches one error callback to primaries and partners', () => {
    const seen: { clipId: string; el: HTMLMediaElement }[] = []
    const pool = new ClipMediaPool((clipId, el) => seen.push({ clipId, el }))
    const a = asset('video')
    const primary = pool.get(clip('c1'), a)
    const partner = pool.getNext(clip('c1'), a)
    setMediaError(primary, 3)
    setMediaError(partner!, 4)
    expect(seen).toEqual([
      { clipId: 'c1', el: primary },
      { clipId: 'c1', el: partner },
    ])
  })

  it('caches one MediaElementAudioSourceNode per element per context', () => {
    const pool = new ClipMediaPool()
    const el = pool.get(clip('c1'), asset())
    const ctx = new FakeAudioContext() // engines create their own context
    const n1 = pool.getSourceNode(el, ctx as unknown as AudioContext)
    const n2 = pool.getSourceNode(el, ctx as unknown as AudioContext)
    expect(n1).toBe(n2)
  })

  it('pauseAll pauses only playing elements', async () => {
    const pool = new ClipMediaPool()
    const el = pool.get(clip('c1'), asset())
    await el.play()
    const idle = pool.get(clip('c2'), asset())
    pool.pauseAll()
    expect(el.paused).toBe(true)
    expect(idle.paused).toBe(true) // never started → stays paused
  })

  it('release() detaches and disposes a single clip element', async () => {
    const pool = new ClipMediaPool()
    const el = pool.get(clip('c1'), asset())
    await el.play()
    pool.release('c1')
    expect(el.paused).toBe(true)
    expect(document.body.contains(el)).toBe(false)
    // Idempotent
    expect(() => pool.release('c1')).not.toThrow()
  })

  it('dispose() clears every element and the container itself', () => {
    const pool = new ClipMediaPool()
    pool.get(clip('c1'), asset())
    pool.get(clip('c2'), asset('audio'))
    pool.dispose()
    expect(document.querySelectorAll('video, audio').length).toBe(0)
    // Pool is reusable after dispose (container is re-created lazily).
    expect(pool.get(clip('c3'), asset())).toBeInstanceOf(HTMLVideoElement)
    void h
  })
})
