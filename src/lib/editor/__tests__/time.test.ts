import { describe, expect, it } from 'vitest'
import {
  clamp,
  formatTime,
  formatTimecode,
  frameToTime,
  rulerStep,
  stepFrames,
  timeToFrame,
} from '../time'

describe('formatTime', () => {
  it('formats compact m:ss.d strings', () => {
    expect(formatTime(0)).toBe('0:00.0')
    expect(formatTime(4.27)).toBe('0:04.2')
    expect(formatTime(67.89)).toBe('1:07.8')
    expect(formatTime(-3)).toBe('0:00.0')
  })
})

describe('formatTimecode', () => {
  it('formats SMPTE-like timecode at 30fps', () => {
    expect(formatTimecode(0, 30)).toBe('00:00:00:00')
    expect(formatTimecode(1 / 30, 30)).toBe('00:00:00:01')
    expect(formatTimecode(3.5, 30)).toBe('00:00:03:15')
    expect(formatTimecode(3661, 30)).toBe('01:01:01:00')
  })
})

describe('frames', () => {
  it('converts both ways and steps safely above zero', () => {
    expect(timeToFrame(1.5, 30)).toBe(45)
    expect(frameToTime(45, 30)).toBe(1.5)
    expect(stepFrames(0, 30, -10)).toBe(0)
    expect(stepFrames(1, 30, -1)).toBeCloseTo(29 / 30, 10)
    expect(stepFrames(1, 30, 1)).toBeCloseTo(31 / 30, 10)
  })
})

describe('clamp + rulerStep', () => {
  it('clamps', () => {
    expect(clamp(5, 0, 2)).toBe(2)
    expect(clamp(-5, 0, 2)).toBe(0)
  })

  it('picks readable ruler steps', () => {
    expect(rulerStep(80)).toBe(1) // 0.5*80=40 < 80 → 1s
    expect(rulerStep(200)).toBe(0.5)
    expect(rulerStep(10)).toBe(10)
  })
})
