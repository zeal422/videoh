import { describe, expect, it } from 'vitest'

import {
  containRect,
  containerSpec,
  estimateExportBytesForOptions,
  EXPORT_BITRATE_MAX,
  EXPORT_BITRATE_MIN,
  EXPORT_CONTAINER_ORDER,
  EXPORT_MAX_DIMENSION,
  EXPORT_MIN_DIMENSION,
  isAudioOnlyContainer,
  resolveOutputSize,
  resolveVideoBitrate,
  type ExportContainer,
} from '../export/options'

describe('export container matrix', () => {
  it('maps every container to its extension, MIME type and audio-only flag', () => {
    expect(containerSpec('mp4')).toMatchObject({
      extension: '.mp4',
      mimeType: 'video/mp4',
      audioOnly: false,
    })
    expect(containerSpec('mov')).toMatchObject({
      extension: '.mov',
      mimeType: 'video/quicktime',
      audioOnly: false,
    })
    expect(containerSpec('mkv')).toMatchObject({
      extension: '.mkv',
      mimeType: 'video/x-matroska',
      audioOnly: false,
    })
    expect(containerSpec('wav')).toMatchObject({
      extension: '.wav',
      mimeType: 'audio/wav',
      audioOnly: true,
    })
    expect(containerSpec('mp3')).toMatchObject({
      extension: '.mp3',
      mimeType: 'audio/mpeg',
      audioOnly: true,
    })
    expect(containerSpec('m4a')).toMatchObject({
      extension: '.m4a',
      mimeType: 'audio/mp4',
      audioOnly: true,
    })
  })

  it('knows which containers are audio-only', () => {
    expect(isAudioOnlyContainer('wav')).toBe(true)
    expect(isAudioOnlyContainer('mp3')).toBe(true)
    expect(isAudioOnlyContainer('m4a')).toBe(true)
    expect(isAudioOnlyContainer('mp4')).toBe(false)
    expect(isAudioOnlyContainer('mov')).toBe(false)
    expect(isAudioOnlyContainer('mkv')).toBe(false)
  })

  it('rejects an unknown container instead of guessing a format', () => {
    expect(() => containerSpec('webm' as ExportContainer)).toThrow(/Unknown export container/)
  })

  it('lists containers in the dialog order', () => {
    expect(EXPORT_CONTAINER_ORDER).toEqual(['mp4', 'mov', 'mkv', 'wav', 'mp3', 'm4a'])
  })
})

describe('resolveOutputSize', () => {
  const project = { width: 1920, height: 1080 }

  it('falls back to the project size when both fields are absent', () => {
    expect(resolveOutputSize(undefined, undefined, project)).toEqual(project)
  })

  it('normalizes odd dimensions to even ones', () => {
    expect(resolveOutputSize(1921, 1081, project)).toEqual({ width: 1922, height: 1082 })
    expect(resolveOutputSize(101, 51, project)).toEqual({ width: 102, height: 52 })
  })

  it('accepts the documented bounds', () => {
    expect(resolveOutputSize(EXPORT_MIN_DIMENSION, EXPORT_MIN_DIMENSION, project)).toEqual({
      width: EXPORT_MIN_DIMENSION,
      height: EXPORT_MIN_DIMENSION,
    })
    expect(resolveOutputSize(EXPORT_MAX_DIMENSION, EXPORT_MAX_DIMENSION, project)).toEqual({
      width: EXPORT_MAX_DIMENSION,
      height: EXPORT_MAX_DIMENSION,
    })
  })

  it('rejects a missing half, non-finite, non-positive and over-cap values', () => {
    expect(resolveOutputSize(1280, undefined, project)).toBeNull()
    expect(resolveOutputSize(undefined, 720, project)).toBeNull()
    expect(resolveOutputSize(Number.NaN, 720, project)).toBeNull()
    expect(resolveOutputSize(1280, Number.POSITIVE_INFINITY, project)).toBeNull()
    expect(resolveOutputSize(0, 720, project)).toBeNull()
    expect(resolveOutputSize(1280, -2, project)).toBeNull()
    expect(resolveOutputSize(EXPORT_MAX_DIMENSION + 2, 720, project)).toBeNull()
    expect(resolveOutputSize(1280, EXPORT_MAX_DIMENSION + 2, project)).toBeNull()
  })
})

describe('resolveVideoBitrate', () => {
  it('keeps the quality preset when no override is given', () => {
    expect(resolveVideoBitrate(undefined)).toBeUndefined()
  })

  it('falls back to the preset for non-finite and non-positive values', () => {
    expect(resolveVideoBitrate(Number.NaN)).toBeUndefined()
    expect(resolveVideoBitrate(Number.POSITIVE_INFINITY)).toBeUndefined()
    expect(resolveVideoBitrate(0)).toBeUndefined()
    expect(resolveVideoBitrate(-5)).toBeUndefined()
  })

  it('clamps to the documented range', () => {
    expect(resolveVideoBitrate(1)).toBe(EXPORT_BITRATE_MIN)
    expect(resolveVideoBitrate(EXPORT_BITRATE_MAX * 2)).toBe(EXPORT_BITRATE_MAX)
    expect(resolveVideoBitrate(8_000_000.4)).toBe(8_000_000)
  })
})

describe('containRect', () => {
  it('letterboxes a wide picture in a tall frame without stretching', () => {
    const rect = containRect(1920, 1080, 1080, 1920)
    expect(rect.width).toBeCloseTo(1080, 5)
    expect(rect.height).toBeCloseTo(607.5, 5)
    expect(rect.x).toBeCloseTo(0, 5)
    expect(rect.y).toBeCloseTo(656.25, 5)
  })

  it('pillarboxes a tall picture in a wide frame', () => {
    const rect = containRect(1080, 1920, 1920, 1080)
    expect(rect.width).toBeCloseTo(607.5, 5)
    expect(rect.height).toBeCloseTo(1080, 5)
    expect(rect.x).toBeCloseTo(656.25, 5)
    expect(rect.y).toBeCloseTo(0, 5)
  })

  it('fills the destination exactly when the aspect ratio matches', () => {
    expect(containRect(1920, 1080, 1280, 720)).toEqual({ x: 0, y: 0, width: 1280, height: 720 })
  })

  it('falls back to the whole destination for invalid dimensions', () => {
    expect(containRect(0, 1080, 1280, 720)).toEqual({ x: 0, y: 0, width: 1280, height: 720 })
    expect(containRect(1920, 1080, 0, 720)).toEqual({ x: 0, y: 0, width: 0, height: 720 })
  })
})

describe('estimateExportBytesForOptions', () => {
  it('uses PCM bytes per second for WAV', () => {
    expect(
      estimateExportBytesForOptions({ duration: 10, container: 'wav', quality: 'medium' }),
    ).toBe(1_920_000)
  })

  it('uses the audio bitrate for MP3 and M4A', () => {
    expect(
      estimateExportBytesForOptions({ duration: 10, container: 'mp3', quality: 'medium' }),
    ).toBe(240_000)
    expect(
      estimateExportBytesForOptions({ duration: 10, container: 'm4a', quality: 'medium' }),
    ).toBe(240_000)
  })

  it('uses the quality preset by default and the override when given', () => {
    expect(
      estimateExportBytesForOptions({ duration: 10, container: 'mp4', quality: 'medium' }),
    ).toBe(7_740_000)
    expect(
      estimateExportBytesForOptions({
        duration: 10,
        container: 'mp4',
        quality: 'medium',
        videoBitrate: 10_000_000,
      }),
    ).toBe(12_740_000)
  })

  it('clamps an oversized override before estimating', () => {
    expect(
      estimateExportBytesForOptions({
        duration: 10,
        container: 'mp4',
        quality: 'low',
        videoBitrate: 100_000_000,
      }),
    ).toBe(50_240_000)
  })

  it('is zero for a non-positive duration', () => {
    expect(
      estimateExportBytesForOptions({ duration: 0, container: 'mp4', quality: 'medium' }),
    ).toBe(0)
    expect(
      estimateExportBytesForOptions({ duration: -2, container: 'wav', quality: 'medium' }),
    ).toBe(0)
  })
})
