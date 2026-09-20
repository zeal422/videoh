// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { clamp01, measureTextBox } from '../playback/text-box'
import { installBrowserMocks } from './mocks/browser-mocks'
import { createTextClip } from '../factories'
import type { TextStyle } from '../types'

/**
 * measureTextBox is the geometry twin of the compositor's drawTextClip —
 * it powers the preview drag outline. Against the fake 2D context
 * (measureText = 7px per character) the box math becomes exactly assertable.
 */

let uninstall: () => void

beforeEach(() => {
  uninstall = installBrowserMocks().uninstall
})

afterEach(() => {
  uninstall()
})

const style = (over: Partial<TextStyle> = {}): TextStyle => ({
  fontSize: 64,
  color: '#ffffff',
  fontFamily: 'Arial, sans-serif',
  bold: true,
  italic: false,
  align: 'center',
  x: 0.5,
  y: 0.5,
  shadow: true,
  ...over,
})

describe('measureTextBox', () => {
  it('centers a single line: anchor ± half width, 1.2 line height, shadow pad', () => {
    const clip = createTextClip({ text: 'Hello', style: style() })
    // 'Hello' → 5 chars × 7 = 35px wide; pad = max(4, 64/8) + 2 = 10
    const box = measureTextBox(clip, 1000, 500)!
    expect(box.x0).toBeCloseTo((500 - 17.5 - 10) / 1000)
    expect(box.x1).toBeCloseTo((500 + 17.5 + 10) / 1000)
    // lineHeight = 64 × 1.2 = 76.8 → ±38.4 around centerY = 250
    expect(box.y0).toBeCloseTo((250 - 38.4 - 10) / 500)
    expect(box.y1).toBeCloseTo((250 + 38.4 + 10) / 500)
  })

  it('left/right align anchors the box edge, not the center', () => {
    const common = { fontSize: 32, shadow: false, x: 0.25 } as const
    const left = measureTextBox(
      createTextClip({ text: 'Hi', style: style({ ...common, align: 'left' }) }),
      800,
      400,
    )!
    // anchorX = 200, 'Hi' = 14px, pad = 2 (no shadow)
    expect(left.x0).toBeCloseTo((200 - 2) / 800)
    expect(left.x1).toBeCloseTo((200 + 14 + 2) / 800)

    const right = measureTextBox(
      createTextClip({ text: 'Hi', style: style({ ...common, align: 'right' }) }),
      800,
      400,
    )!
    expect(right.x0).toBeCloseTo((200 - 14 - 2) / 800)
    // right-aligned: the box's right edge IS the anchor (+ pad)
    expect(right.x1).toBeCloseTo((200 + 2) / 800)
  })

  it('multi-line boxes span every line vertically', () => {
    const clip = createTextClip({
      text: 'A\nBBB\nCC',
      style: style({ fontSize: 50, shadow: false }),
    })
    const box = measureTextBox(clip, 1000, 1000)!
    // 3 lines × 50 × 1.2 = 180 tall + 2×2 pad
    expect(box.y1 - box.y0).toBeCloseTo((180 + 4) / 1000)
  })

  it('returns null for non-text clips', () => {
    expect(measureTextBox({ text: undefined, style: undefined }, 100, 100)).toBeNull()
  })
})

describe('clamp01', () => {
  it('clamps into 0..1 (drag + slider share this contract)', () => {
    expect(clamp01(-0.4)).toBe(0)
    expect(clamp01(0.42)).toBe(0.42)
    expect(clamp01(1.7)).toBe(1)
  })
})
