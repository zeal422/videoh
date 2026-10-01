import { describe, expect, it } from 'vitest'
import { applyCommand } from '../commands'
import { animatedValue } from '../keyframes'
import { buildColorFilter, COLOR_NEUTRAL } from '../color'
import { createClip, createTrack } from '../factories'
import type { Clip, Doc } from '../types'

/** Compositor-side evaluation contracts that do not need a canvas. */

function docWith(clip: Clip): Doc {
  const track = createTrack('video', 1, { id: 'track_1', clips: [clip] })
  return {
    project: { id: 'p', name: 'n', width: 1920, height: 1080, fps: 30, tracks: [track] },
    media: [],
  }
}

describe('animated opacity stacks into the compositor path', () => {
  it('a fade-out curve evaluates to 0 at the clip end', () => {
    const clip = createClip({
      id: 'c1',
      start: 0,
      duration: 4,
      keyframes: {
        opacity: [
          { time: 0, value: 1 },
          { time: 4, value: 0 },
        ],
      },
    })
    expect(animatedValue(clip, 'opacity', 0)).toBe(1)
    expect(animatedValue(clip, 'opacity', 2)).toBeCloseTo(0.5, 10)
    expect(animatedValue(clip, 'opacity', 4)).toBe(0)
  })

  it('static opacity still works without keyframes', () => {
    const clip = createClip({ id: 'c1', start: 0, duration: 4, opacity: 0.5 })
    expect(animatedValue(clip, 'opacity', 3)).toBe(0.5)
  })
})

describe('position/scale evaluation', () => {
  it('animates position across the clip', () => {
    const clip = createClip({
      id: 'c1',
      start: 1,
      duration: 4,
      keyframes: {
        positionX: [
          { time: 0, value: -100 },
          { time: 4, value: 100 },
        ],
      },
    })
    // clip-local evaluation: timeline time 3 = local 2 → midpoint
    expect(animatedValue(clip, 'positionX', 2)).toBe(0)
  })

  it('setClipAnimStatic holds a scale without curves', () => {
    let doc = docWith(createClip({ id: 'c1', start: 0, duration: 4 }))
    doc = applyCommand(doc, {
      type: 'setClipAnimStatic',
      clipId: 'c1',
      property: 'scale',
      value: 2,
    })
    const clip = doc.project.tracks[0].clips[0]
    expect(animatedValue(clip, 'scale', 1.5)).toBe(2)
  })
})

describe('buildColorFilter (color stack)', () => {
  // The builder moved to color.ts so both render paths share it; these cases
  // keep the compositor-side contracts (order, elision, exposure gamma).
  const filter = (
    exposure: number,
    contrast: number,
    saturation: number,
    brightness: number,
    hue: number,
  ) => buildColorFilter({ exposure, contrast, saturation, brightness, hue })

  it('is none when all parameters are neutral', () => {
    expect(filter(1, 1, 1, 1, 0)).toBe('none')
    expect(filter(COLOR_NEUTRAL.exposure, 1, 1, 1, 0)).toBe('none')
  })

  it('emits only the non-neutral parts', () => {
    const f = filter(1, 1.2, 0.5, 1, 90)
    expect(f).toContain('contrast(1.2)')
    expect(f).toContain('saturate(0.5)')
    expect(f).toContain('hue-rotate(90deg)')
    expect(f).not.toContain('brightness')
  })

  it('exposure applies as a gamma-shaped brightness', () => {
    expect(filter(4, 1, 1, 1, 0)).toBe('brightness(2)')
  })
})

describe('speed-aware source time (mirrors core.sourceTime)', () => {
  it('a 2x clip consumes double the source span', () => {
    const clip = createClip({ id: 'c1', start: 0, duration: 2, inPoint: 5, speed: 2 })
    const local1 = 1
    expect(clip.inPoint + local1 * (clip.speed ?? 1)).toBe(7)
  })
})
