import { describe, expect, it } from 'vitest'
import {
  clamp,
  formatDurationSeconds,
  formatRangeTime,
  formatRulerTime,
  formatTime,
  formatTimecode,
  formatTransportTime,
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
    expect(formatTime(2.3)).toBe('0:02.3')
    expect(formatTime(10.1)).toBe('0:10.1')
    expect(formatTime(59.9)).toBe('0:59.9')
    expect(formatTime(-3)).toBe('0:00.0')
  })
})

describe('tenths tolerance for a computed total', () => {
  it('absorbs a total just below a tenth but keeps a real sub-tenth', () => {
    // The original underflow: 0.3 - 0.1 is about 2e-17 below 0.2.
    expect(formatTime(0.3 - 0.1)).toBe('0:00.2')
    // Inside the fixed 1e-9 second tolerance.
    expect(formatTime(0.2 - 1e-10)).toBe('0:00.2')
    // Outside it: this is a real sub-tenth and must not round up.
    expect(formatTime(0.2 - 1e-8)).toBe('0:00.1')
    // Coarse boundary guard, 1e-6 below the tenth.
    expect(formatTime(0.199999)).toBe('0:00.1')

    expect(formatDurationSeconds(0.3 - 0.1)).toBe('0.2s')
    expect(formatRangeTime(0.3 - 0.1)).toBe('00:00.2')
  })
})

describe('formatTransportTime', () => {
  it.each([
    [0, '00:00.0'],
    [4.27, '00:04.2'],
    [67.89, '01:07.8'],
    [60, '01:00.0'],
    [3667.89, '61:07.8'],
    [10.1, '00:10.1'],
  ])('formats %s seconds as %s', (seconds, expected) => {
    expect(formatTransportTime(seconds as number)).toBe(expected)
  })
})

describe('formatRulerTime', () => {
  it('pads mm:ss under an hour', () => {
    expect(formatRulerTime(0)).toBe('00:00')
    expect(formatRulerTime(59.9)).toBe('00:59')
    expect(formatRulerTime(60)).toBe('01:00')
    expect(formatRulerTime(3599)).toBe('59:59')
  })

  it('switches to h:mm:ss at one hour', () => {
    expect(formatRulerTime(3600)).toBe('1:00:00')
    expect(formatRulerTime(3661)).toBe('1:01:01')
  })
})

describe('status-bar time', () => {
  it('pads range endpoints and trims a whole-second tenth', () => {
    expect(formatRangeTime(0)).toBe('00:00')
    expect(formatRangeTime(4)).toBe('00:04')
    expect(formatRangeTime(4.27)).toBe('00:04.2')
    expect(formatRangeTime(64.5)).toBe('01:04.5')
    expect(formatRangeTime(59.9)).toBe('00:59.9')
  })

  it('formats a short duration with one decimal, trimming .0', () => {
    expect(formatDurationSeconds(4)).toBe('4s')
    expect(formatDurationSeconds(4.2)).toBe('4.2s')
    expect(formatDurationSeconds(4.25)).toBe('4.2s')
    expect(formatDurationSeconds(0.5)).toBe('0.5s')
    expect(formatDurationSeconds(59.9)).toBe('59.9s')
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
