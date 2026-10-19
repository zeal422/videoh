/**
 * Anti-regression tests for the effect stack (effects.ts): order rule,
 * sample derivation, keyframe evaluation/sanitization, crop geometry,
 * blur windows, and matte resolution incl. hostile references. Pure.
 */
import { describe, expect, it } from 'vitest'

import {
  blendCompositeOperation,
  blurSampleTimes,
  blurWindowSeconds,
  clampEffectPropertyValue,
  createEffectEntry,
  cropFeatherPx,
  cropRect,
  effectKeyframeValue,
  effectSamples,
  enabledEffects,
  findEffect,
  isBlendMode,
  isCropConsumed,
  isEffectKeyframable,
  resolveMatteTrack,
  sanitizeEffectKeyframes,
  splitEffectKeyframes,
} from '../effects'
import { MAX_BLUR_SAMPLES } from '../constants'
import { createClip, createDoc, createTrack } from '../factories'
import type { Clip, Doc, EffectEntry } from '../types'

const crop = (over: Partial<Extract<EffectEntry, { type: 'crop' }>> = {}) => ({
  id: 'fx_crop',
  type: 'crop' as const,
  ...over,
})

describe('enabledEffects / findEffect', () => {
  it('reads an absent stack as empty and skips disabled entries', () => {
    expect(enabledEffects(createClip())).toEqual([])
    const clip = createClip({
      effects: [crop({}), { ...crop({ id: 'fx_off' }), enabled: false }],
    })
    expect(enabledEffects(clip).map((e) => e.id)).toEqual(['fx_crop'])
    expect(findEffect(clip, 'fx_off')?.enabled).toBe(false)
    expect(findEffect(clip, 'nope')).toBeUndefined()
  })
})

describe('isEffectKeyframable', () => {
  it('allows crop edges/feather and shutter only', () => {
    for (const p of ['left', 'right', 'top', 'bottom', 'feather']) {
      expect(isEffectKeyframable('crop', p)).toBe(true)
    }
    expect(isEffectKeyframable('crop', 'zoom')).toBe(false)
    expect(isEffectKeyframable('motionBlur', 'shutter')).toBe(true)
    expect(isEffectKeyframable('chromaKey', 'similarity')).toBe(false)
    expect(isEffectKeyframable('trackMatte', 'trackId')).toBe(false)
  })
})

describe('clampEffectPropertyValue / sanitizeEffectKeyframes', () => {
  it('clamps into bounds and neutralizes non-finite input', () => {
    expect(clampEffectPropertyValue('left', 150)).toBe(100)
    expect(clampEffectPropertyValue('left', -5)).toBe(0)
    expect(clampEffectPropertyValue('shutter', Number.NaN)).toBe(180)
    expect(clampEffectPropertyValue('shutter', 500)).toBe(360)
  })

  it('drops negative times and non-finite values, sorts, keeps quads', () => {
    const clean = sanitizeEffectKeyframes('left', [
      { time: 2, value: 150 },
      { time: -1, value: 10 },
      { time: 1, value: Number.NaN },
      { time: 0, value: 10, interpolation: 'nope' as never },
    ])
    expect(clean).toEqual([
      { time: 0, value: 10, interpolation: 'linear' },
      { time: 2, value: 100, interpolation: 'linear' },
    ])
  })

  it('reads hostile input as empty or drops it without throwing', () => {
    expect(sanitizeEffectKeyframes('left', 'nope' as never)).toEqual([])
    expect(sanitizeEffectKeyframes('left', null as never)).toEqual([])
    expect(
      sanitizeEffectKeyframes('left', [
        null,
        42,
        'x',
        { time: 0, value: 10 },
        { time: Number.NaN, value: 5 },
        { value: 5 },
      ] as never),
    ).toEqual([{ time: 0, value: 10, interpolation: 'linear' }])
  })
})

describe('effectKeyframeValue', () => {
  it('prefers the curve, then the static param, then the default', () => {
    const entry = crop({
      keyframes: {
        left: [
          { time: 0, value: 10 },
          { time: 4, value: 20 },
        ],
      },
    })
    expect(effectKeyframeValue(entry, 'left', 2)).toBe(15)
    expect(effectKeyframeValue(crop({ left: 30 }), 'left', 0)).toBe(30)
    expect(effectKeyframeValue(crop({}), 'left', 0)).toBe(0)
  })
})

describe('splitEffectKeyframes', () => {
  it('subdivides at the cut front-to-back like flat curves', () => {
    const [left, right] = splitEffectKeyframes(
      {
        left: [
          { time: 0, value: 0 },
          { time: 4, value: 40 },
        ],
      },
      1,
    )
    expect(left?.left?.map((k) => k.time)).toEqual([0, 1])
    expect(right?.left?.map((k) => k.time)).toEqual([0, 3])
    expect(right?.left?.[0].value).toBe(10)
  })

  it('returns undefined halves for empty maps', () => {
    expect(splitEffectKeyframes(undefined, 1)).toEqual([undefined, undefined])
  })
})

describe('effectSamples / blur windows', () => {
  it('caps samples at MAX_BLUR_SAMPLES and bypasses at zero', () => {
    expect(MAX_BLUR_SAMPLES).toBe(8)
    expect(effectSamples(0)).toBe(0)
    expect(effectSamples(-10)).toBe(0)
    expect(effectSamples(Number.NaN)).toBe(0)
    expect(effectSamples(45)).toBe(1)
    expect(effectSamples(180)).toBe(4)
    expect(effectSamples(360)).toBe(8)
  })

  it('derives the window from shutter over fps, trailing and inclusive', () => {
    expect(blurWindowSeconds(180, 30)).toBeCloseTo(180 / 360 / 30, 12)
    expect(blurWindowSeconds(0, 30)).toBe(0)
    expect(blurWindowSeconds(180, 0)).toBe(0)
    const times = blurSampleTimes(10, 180, 30)
    expect(times).toHaveLength(4)
    expect(times[3]).toBe(10)
    expect(times[0]).toBeCloseTo(10 - 180 / 360 / 30 + 180 / 360 / 30 / 4, 12)
    expect(blurSampleTimes(10, 0, 30)).toEqual([])
  })
})

describe('crop geometry', () => {
  const frame = { w: 1920, h: 1080 }

  it('converts percent edges to a pixel rect', () => {
    const rect = cropRect(crop({ left: 10, right: 10, top: 25, bottom: 25 }), 0, frame.w, frame.h)
    expect(rect).toEqual({ x: 192, y: 270, w: 1536, h: 540 })
  })

  it('skips the draw when opposing edges consume the frame', () => {
    expect(isCropConsumed(crop({ left: 60, right: 40 }), 0)).toBe(true)
    expect(isCropConsumed(crop({ top: 50, bottom: 50 }), 0)).toBe(true)
    expect(isCropConsumed(crop({ left: 10, right: 10 }), 0)).toBe(false)
  })

  it('detects a consumed crop mid-animation', () => {
    const entry = crop({
      keyframes: {
        left: [
          { time: 0, value: 0 },
          { time: 4, value: 100 },
        ],
      },
      right: 10,
    })
    expect(isCropConsumed(entry, 0)).toBe(false)
    expect(isCropConsumed(entry, 4)).toBe(true)
  })

  it('converts feather percent to pixels of the smaller dimension', () => {
    expect(cropFeatherPx(crop({ feather: 10 }), 0, frame.w, frame.h)).toBe(108)
    expect(cropFeatherPx(crop({}), 0, frame.w, frame.h)).toBe(0)
    // The band never inverts the rect: a 100-wide remainder caps the band at 50.
    expect(cropFeatherPx(crop({ left: 47.5, right: 47.5, feather: 100 }), 0, 1920, 1080)).toBe(48)
  })
})

describe('isBlendMode', () => {
  it('accepts the canvas intersection only', () => {
    expect(isBlendMode('multiply')).toBe(true)
    expect(isBlendMode('softLight')).toBe(true)
    expect(isBlendMode('linearDodge')).toBe(true)
    expect(isBlendMode('normal')).toBe(true)
    expect(isBlendMode('vividLight')).toBe(false)
    expect(isBlendMode('dissolve')).toBe(false)
    expect(isBlendMode(null)).toBe(false)
  })
})

describe('blendCompositeOperation', () => {
  it('maps every mode to its canvas operation', () => {
    expect(blendCompositeOperation(undefined)).toBe('source-over')
    expect(blendCompositeOperation('normal')).toBe('source-over')
    expect(blendCompositeOperation('multiply')).toBe('multiply')
    expect(blendCompositeOperation('screen')).toBe('screen')
    expect(blendCompositeOperation('overlay')).toBe('overlay')
    expect(blendCompositeOperation('softLight')).toBe('soft-light')
    expect(blendCompositeOperation('hardLight')).toBe('hard-light')
    expect(blendCompositeOperation('darken')).toBe('darken')
    expect(blendCompositeOperation('lighten')).toBe('lighten')
    expect(blendCompositeOperation('colorDodge')).toBe('color-dodge')
    expect(blendCompositeOperation('colorBurn')).toBe('color-burn')
    expect(blendCompositeOperation('linearDodge')).toBe('lighter')
    expect(blendCompositeOperation('difference')).toBe('difference')
    expect(blendCompositeOperation('exclusion')).toBe('exclusion')
    expect(blendCompositeOperation('hue')).toBe('hue')
    expect(blendCompositeOperation('saturation')).toBe('saturation')
    expect(blendCompositeOperation('color')).toBe('color')
    expect(blendCompositeOperation('luminosity')).toBe('luminosity')
  })
})

describe('createEffectEntry', () => {
  it('builds default entries with fresh ids', () => {
    const a = createEffectEntry('crop')
    const b = createEffectEntry('crop')
    expect(a.id).not.toBe(b.id)
    expect(a).toMatchObject({ type: 'crop', enabled: true })
    expect(createEffectEntry('chromaKey')).toMatchObject({ key: '#00ff00' })
  })
})

/** Two video tracks: V1 on top (index 0), V2 below (index 1). */
function matteDoc(): { doc: Doc; v1: string; v2: string; clipId: string } {
  const doc = createDoc()
  const v1 = createTrack('video', 1)
  const v2 = createTrack('video', 2)
  const clip = createClip({ id: 'clip_matted' })
  v2.clips.push(clip)
  doc.project.tracks = [v1, v2]
  return { doc, v1: v1.id, v2: v2.id, clipId: clip.id }
}

const matte = (trackId: string) => ({
  id: 'fx_matte',
  type: 'trackMatte' as const,
  trackId,
})

describe('resolveMatteTrack', () => {
  it('resolves a track above the clip in the same sequence', () => {
    const { doc, v1, clipId } = matteDoc()
    expect(resolveMatteTrack(doc, clipId, matte(v1))?.id).toBe(v1)
  })

  it('refuses audio lanes even above the clip', () => {
    const doc = createDoc()
    const audio = createTrack('audio', 1)
    const video = createTrack('video', 1)
    const clip = createClip({ id: 'clip_aud' })
    video.clips.push(clip)
    doc.project.tracks = [audio, video]
    expect(resolveMatteTrack(doc, clip.id, matte(audio.id))).toBeUndefined()
  })

  it('refuses the clip track itself, tracks below, and unknown ids', () => {
    const { doc, v2, clipId } = matteDoc()
    expect(resolveMatteTrack(doc, clipId, matte(v2))).toBeUndefined()
    expect(resolveMatteTrack(doc, clipId, matte('nope'))).toBeUndefined()
    expect(resolveMatteTrack(doc, clipId, { ...matte(v2), trackId: '' })).toBeUndefined()
    expect(resolveMatteTrack(doc, 'ghost', matte(v2))).toBeUndefined()
  })

  it('refuses a matte whose source sits below after the clip moves up', () => {
    const { doc, v1, v2, clipId } = matteDoc()
    // Clip on V1 (top) naming V2 (below) never resolves.
    const top = createClip({ id: 'clip_top' })
    doc.project.tracks[0].clips.push(top)
    expect(resolveMatteTrack(doc, top.id, matte(v2))).toBeUndefined()
    expect(resolveMatteTrack(doc, clipId, matte(v1))?.id).toBe(v1)
  })
})
