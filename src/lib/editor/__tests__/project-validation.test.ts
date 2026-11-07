import { describe, expect, it } from 'vitest'

import {
  THUMBNAIL_MAX_CHARS,
  isValidWaveformPeaks,
  sanitizeGain,
  sanitizeThumbnail,
  sanitizeTransitionDuration,
} from '../project-validation'
import { GAIN_MAX, GAIN_MIN, TRANSITION_MAX, TRANSITION_MIN, WAVEFORM_BUCKETS } from '../constants'

const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='

describe('sanitizeThumbnail', () => {
  it('accepts the canonical JPEG data URL under the cap', () => {
    expect(sanitizeThumbnail(JPEG)).toBe(JPEG)
    // The largest valid payload under the cap is four-character aligned:
    // the prefix is 23 characters, so the total lands one character short.
    const nearCap = `data:image/jpeg;base64,${'A'.repeat(THUMBNAIL_MAX_CHARS - 23 - 1)}`
    expect(nearCap).toHaveLength(THUMBNAIL_MAX_CHARS - 1)
    expect(sanitizeThumbnail(nearCap)).toBe(nearCap)
  })

  it('requires complete four-character groups and valid trailing padding', () => {
    for (const payload of ['A', 'AAAA==', 'AAA', 'AAAAA', 'AAAA=', 'A===', '====']) {
      expect(sanitizeThumbnail(`data:image/jpeg;base64,${payload}`)).toBeUndefined()
    }
    for (const payload of ['AA==', 'AAA=', 'AAAA']) {
      expect(sanitizeThumbnail(`data:image/jpeg;base64,${payload}`)).toBe(
        `data:image/jpeg;base64,${payload}`,
      )
    }
  })

  it('rejects external, protocol-relative, blob, and SVG sources', () => {
    for (const value of [
      'https://attacker.example/x.png',
      '//attacker.example/x.png',
      'blob:https://videoh.vercel.app/123',
      'data:image/svg+xml;base64,PHN2Zz4=',
      'javascript:alert(1)',
      'data:image/png;base64,AAAA',
    ]) {
      expect(sanitizeThumbnail(value)).toBeUndefined()
    }
  })

  it('rejects a payload outside the base64 alphabet', () => {
    for (const payload of [
      'AAAA<script>',
      'AAAA BBBB',
      'AAAA\nBBBB',
      'AAAA-BBBB',
      'AAAA_BBBB',
      'AAAA=BBBB',
      'AAAA====',
      '====',
    ]) {
      expect(sanitizeThumbnail(`data:image/jpeg;base64,${payload}`)).toBeUndefined()
    }
  })

  it('rejects an empty payload, an oversized payload, and a non-string', () => {
    expect(sanitizeThumbnail('data:image/jpeg;base64,')).toBeUndefined()
    const oversized = `data:image/jpeg;base64,${'A'.repeat(THUMBNAIL_MAX_CHARS)}`
    expect(sanitizeThumbnail(oversized)).toBeUndefined()
    expect(sanitizeThumbnail(undefined)).toBeUndefined()
    expect(sanitizeThumbnail(null)).toBeUndefined()
    expect(sanitizeThumbnail({ thumbnail: JPEG })).toBeUndefined()
  })
})

describe('sanitizeGain', () => {
  it('keeps a finite value and clamps it to the command range', () => {
    expect(sanitizeGain(0.5)).toBe(0.5)
    expect(sanitizeGain(1)).toBe(1)
    expect(sanitizeGain(-5)).toBe(GAIN_MIN)
    expect(sanitizeGain(9)).toBe(GAIN_MAX)
  })

  it('rejects Infinity, NaN, and non-numbers', () => {
    expect(sanitizeGain(Infinity)).toBeUndefined()
    expect(sanitizeGain(Number.NaN)).toBeUndefined()
    expect(sanitizeGain('1')).toBeUndefined()
  })
})

describe('sanitizeTransitionDuration', () => {
  it('keeps a duration inside the bounds and clamps the edges', () => {
    expect(sanitizeTransitionDuration(0.5)).toBe(0.5)
    expect(sanitizeTransitionDuration(100)).toBe(TRANSITION_MAX)
    expect(sanitizeTransitionDuration(0.05)).toBe(TRANSITION_MIN)
  })

  it('drops a non-finite or non-positive duration', () => {
    expect(sanitizeTransitionDuration(Infinity)).toBeUndefined()
    expect(sanitizeTransitionDuration(Number.NaN)).toBeUndefined()
    expect(sanitizeTransitionDuration(0)).toBeUndefined()
    expect(sanitizeTransitionDuration(-1)).toBeUndefined()
    expect(sanitizeTransitionDuration('1')).toBeUndefined()
  })
})

describe('isValidWaveformPeaks', () => {
  it('accepts the exact dense 0..1 shape', () => {
    const peaks = Array.from({ length: WAVEFORM_BUCKETS }, (_, i) => i / WAVEFORM_BUCKETS)
    expect(isValidWaveformPeaks(peaks)).toBe(true)
  })

  it('rejects a wrong length, a hole, a non-finite value, and an out-of-range value', () => {
    const good = Array.from({ length: WAVEFORM_BUCKETS }, () => 0.5)
    expect(isValidWaveformPeaks(good.slice(0, -1))).toBe(false)
    const sparse = [...good]
    delete sparse[10]
    expect(isValidWaveformPeaks(sparse)).toBe(false)
    const infinite = [...good]
    infinite[0] = Infinity
    expect(isValidWaveformPeaks(infinite)).toBe(false)
    const high = [...good]
    high[0] = 1.1
    expect(isValidWaveformPeaks(high)).toBe(false)
    expect(isValidWaveformPeaks('peaks')).toBe(false)
  })
})
