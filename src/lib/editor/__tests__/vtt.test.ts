/**
 * Tests for the WebVTT serializer (vtt.ts): header, timestamps, escaping,
 * line-ending normalization, and the SRT-serializer contracts (blank drop,
 * end clamp, valid input only).
 */
import { describe, expect, it } from 'vitest'

import type { SrtCue } from '../srt'
import { escapeVttText, serializeVtt } from '../vtt'

function cue(over: Partial<SrtCue> = {}): SrtCue {
  return { startMs: 1000, endMs: 2000, text: 'Hello', ...over }
}

describe('timestamps', () => {
  it('formats zero and pads canonically with a dot separator', () => {
    const out = serializeVtt([{ startMs: 0, endMs: 61001, text: 'T' }])
    expect(out).toContain('00:00:00.000 --> 00:01:01.001')
  })

  it('handles sub-second values and hours past 99', () => {
    const out = serializeVtt([{ startMs: 250, endMs: 3723000047, text: 'T' }])
    expect(out).toContain('00:00:00.250 --> 1034:10:00.047')
  })
})

describe('escapeVttText', () => {
  it('escapes ampersands first, then angle brackets', () => {
    expect(escapeVttText('a & b')).toBe('a &amp; b')
    expect(escapeVttText('x < 5 > 3')).toBe('x &lt; 5 &gt; 3')
  })

  it('neutralizes the timestamp arrow losslessly', () => {
    expect(escapeVttText('a --> b')).toBe('a --&gt; b')
  })

  it('leaves pre-escaped input single-pass', () => {
    expect(escapeVttText('&amp;')).toBe('&amp;amp;')
  })
})

describe('serializeVtt', () => {
  it('emits the header with its two line terminators and nothing else when empty', () => {
    expect(serializeVtt([])).toBe('WEBVTT\n\n')
  })

  it('numbers no cues and separates cue blocks with single blank lines', () => {
    const out = serializeVtt([
      cue({ text: 'First' }),
      cue({ startMs: 3000, endMs: 4000, text: 'Second' }),
    ])
    expect(out).toBe(
      'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nFirst\n\n00:00:03.000 --> 00:00:04.000\nSecond\n\n',
    )
  })

  it('keeps emitted order and formats multi-line payloads', () => {
    const out = serializeVtt([cue({ text: 'Hello\nworld' })])
    expect(out).toContain('00:00:01.000 --> 00:00:02.000\nHello\nworld\n\n')
  })

  it('drops blank-text cues and clamps an inverted end to start + 1 ms', () => {
    const out = serializeVtt([
      cue({ text: '   ' }),
      cue({ startMs: 5000, endMs: 4000, text: 'Kept' }),
    ])
    expect(out).toBe('WEBVTT\n\n00:00:05.000 --> 00:00:05.001\nKept\n\n')
  })

  it('normalizes CRLF and standalone CR, and collapses embedded blank-line runs', () => {
    const out = serializeVtt([cue({ text: 'a\r\n\r\nb' }), cue({ text: 'c\r\rd' })])
    expect(out).toContain('\na\nb\n\n')
    expect(out).toContain('\nc\nd\n\n')
    expect(out).not.toMatch(/\n\n[^\n]*\n\n/)
  })

  it('trims leading and trailing newline runs from cue text', () => {
    const out = serializeVtt([cue({ text: '\n\nfoo\n' })])
    expect(out).toContain('--> 00:00:02.000\nfoo\n\n')
  })

  it('never emits a timing-arrow sequence in a payload line', () => {
    const out = serializeVtt([cue({ text: 'a --> b' })])
    const lines = out.split('\n')
    const payload = lines.filter((l) => !l.startsWith('WEBVTT') && !l.includes('-->') && l !== '')
    expect(payload).toEqual(['a --&gt; b'])
    expect(lines.filter((l) => l.includes('-->'))).toHaveLength(1)
  })
})
