// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ClipMediaPool } from '../media/elements'
import { FakeAudioContext, installBrowserMocks, type MockHarness } from './mocks/browser-mocks'
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

function clip(id = 'c1') {
  return createClip({ id, mediaId: 'm1', start: 0, duration: 2, inPoint: 0 })
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

  it('creates an audio element for audio assets', () => {
    const pool = new ClipMediaPool()
    const el = pool.get(clip('c1'), asset('audio'))
    expect(el).toBeInstanceOf(HTMLAudioElement)
    expect(el).not.toBeInstanceOf(HTMLVideoElement)
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
