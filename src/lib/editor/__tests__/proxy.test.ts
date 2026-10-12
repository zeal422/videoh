import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  PROXY_MAX_LONG_EDGE,
  PROXY_VIDEO_BITRATE,
  planProxy,
  proxyDimensions,
  shouldProxy,
} from '../proxy'
import type { MediaAsset } from '../types'

function asset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: 'm1',
    name: 'a.mp4',
    kind: 'video',
    duration: 10,
    width: 3840,
    height: 2160,
    url: 'blob:x',
    ...overrides,
  }
}

describe('shouldProxy', () => {
  it('qualifies only a video whose long edge exceeds 1920', () => {
    expect(shouldProxy(asset())).toBe(true)
    expect(shouldProxy(asset({ width: 1920, height: 1080 }))).toBe(false)
    expect(shouldProxy(asset({ width: 1080, height: 1920 }))).toBe(false)
    expect(shouldProxy(asset({ width: 3840, height: 2160, kind: 'image' }))).toBe(false)
    expect(shouldProxy(asset({ width: 0, height: 0, kind: 'audio' }))).toBe(false)
  })
})

describe('proxyDimensions', () => {
  it('caps the long edge at 1280 and preserves aspect (landscape)', () => {
    expect(proxyDimensions(3840, 2160)).toEqual({ width: 1280, height: 720 })
  })

  it('caps the long edge at 1280 and preserves aspect (portrait)', () => {
    expect(proxyDimensions(2160, 3840)).toEqual({ width: 720, height: 1280 })
  })

  it('produces even dimensions for odd sources', () => {
    const { width, height } = proxyDimensions(3841, 2161)
    expect(width % 2).toBe(0)
    expect(height % 2).toBe(0)
    expect(Math.max(width, height)).toBe(PROXY_MAX_LONG_EDGE)
  })

  it('never upscales an already-small source', () => {
    expect(proxyDimensions(640, 360)).toEqual({ width: 640, height: 360 })
  })

  it('handles a zero dimension without throwing', () => {
    expect(proxyDimensions(0, 0)).toEqual({ width: 0, height: 0 })
  })
})

describe('planProxy', () => {
  it('returns null for a source that does not qualify', () => {
    expect(planProxy(asset({ width: 1280, height: 720 }))).toBeNull()
    expect(planProxy(asset({ kind: 'image' }))).toBeNull()
  })

  it('plans AVC at the low bitrate with the capped dimensions', () => {
    const plan = planProxy(asset())
    expect(plan).toMatchObject({
      width: 1280,
      height: 720,
      videoCodec: 'avc',
      videoBitrate: PROXY_VIDEO_BITRATE,
    })
  })

  it('includes an audio track when the source has sound', () => {
    expect(planProxy(asset({ hasAudio: true }))?.includeAudio).toBe(true)
    expect(planProxy(asset({ waveformPeaks: [0, 1] }))?.includeAudio).toBe(true)
  })

  it('omits the audio track when the source is silent', () => {
    expect(planProxy(asset({ hasAudio: false }))?.includeAudio).toBe(false)
  })
})

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')

describe('proxy builder source locks (media/proxies.ts)', () => {
  it('feeds each source frame timestamp and duration to CanvasSource.add', () => {
    expect(read('../media/proxies.ts')).toMatch(
      /videoSource\.add\(frame\.timestamp, frame\.duration\)/,
    )
  })

  it('detects the source audio track and muxes it when present', () => {
    const src = read('../media/proxies.ts')
    // The demuxed track, not the import-time hasAudio probe, decides.
    expect(src).toMatch(/input\.getAudioTracks\(\)/)
    expect(src).toMatch(/output\.addAudioTrack\(audioSource\)/)
  })

  it('fails the build rather than shipping a video-only proxy for a source with audio', () => {
    expect(read('../media/proxies.ts')).toMatch(
      /if \(!audioBuffer\) throw new Error\('Proxy audio could not be decoded'\)/,
    )
  })
})

describe('proxy drop ordering (static locks)', () => {
  it('drops the proxy only after a successful relink', () => {
    const src = read('../../../components/editor/MediaBin.tsx')
    const applyAt = src.indexOf("type: 'relinkMedia'")
    const dropAt = src.indexOf('dropProxy(asset.id)', applyAt)
    expect(applyAt).toBeGreaterThan(-1)
    expect(dropAt).toBeGreaterThan(applyAt)
  })
})

describe('proxy URL lifetime (static locks)', () => {
  it('revokes proxies before every project install path clears the doc', () => {
    for (const file of [
      '../../../components/editor/MenuBar.tsx',
      '../../../components/editor/EditorShell.tsx',
      '../project-io.ts',
    ]) {
      const src = read(file)
      const revokeAt = src.indexOf('revokeAllProxies()')
      const replaceAt = src.indexOf('.replaceDoc(')
      expect(revokeAt, `${file} revokes proxies`).toBeGreaterThan(-1)
      expect(replaceAt, `${file} installs the doc after revoking`).toBeGreaterThan(revokeAt)
    }
  })
})
