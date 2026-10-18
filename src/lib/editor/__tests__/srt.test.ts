/**
 * Anti-regression tests for the SRT codec (srt.ts): parse, serialize, and
 * the doc-to-cues collector behind the captions export. Pure, no harness.
 */
import { describe, expect, it } from 'vitest'

import {
  collectCaptionCues,
  MAX_SRT_TIME_SECONDS,
  parseSrt,
  serializeSrt,
  SrtRangeError,
} from '../srt'
import { createDoc, createTextClip, createTrack } from '../factories'
import type { Doc } from '../types'

/** A doc with one text track carrying the given flagged clips. */
function captionDoc(clips: Parameters<typeof createTextClip>[0][]): Doc {
  const doc = createDoc()
  const track = createTrack('text', 1, { name: 'Captions' })
  track.clips = clips.map((c) => createTextClip({ isCaption: true, ...c }))
  doc.project.tracks.push(track)
  return doc
}

describe('parseSrt', () => {
  it('parses ids, timestamps and multi-line text', () => {
    const { cues, dropped } = parseSrt(
      '1\n00:00:01,000 --> 00:00:02,000\nHello\nworld\n\n2\n00:00:03,500 --> 00:00:04,000\nBye\n',
    )
    expect(dropped).toBe(0)
    expect(cues).toEqual([
      { startMs: 1000, endMs: 2000, text: 'Hello\nworld' },
      { startMs: 3500, endMs: 4000, text: 'Bye' },
    ])
  })

  it('strips the BOM and accepts CRLF', () => {
    const { cues, dropped } = parseSrt('﻿1\r\n00:00:01,000 --> 00:00:02,000\r\nHi\r\n')
    expect(dropped).toBe(0)
    expect(cues).toEqual([{ startMs: 1000, endMs: 2000, text: 'Hi' }])
  })

  it('accepts a dot millisecond separator and strips inline tags', () => {
    const { cues, dropped } = parseSrt(
      '1\n00:00:01.000 --> 00:00:02.000\n<i>Hey</i> <b>you</b> <font color="red">there</font> {an8}\n',
    )
    expect(dropped).toBe(0)
    expect(cues).toEqual([{ startMs: 1000, endMs: 2000, text: 'Hey you there' }])
  })

  it('keeps literal angle-bracket text and strips only real tags', () => {
    const { cues, dropped } = parseSrt(
      '1\n00:00:01,000 --> 00:00:02,000\nx < 5 > 3 and <i>hi</i>\n',
    )
    expect(dropped).toBe(0)
    expect(cues).toEqual([{ startMs: 1000, endMs: 2000, text: 'x < 5 > 3 and hi' }])
  })

  it('strips nested brace blocks entirely', () => {
    const { cues, dropped } = parseSrt('1\n00:00:01,000 --> 00:00:02,000\n{a{b}c}Hi\n')
    expect(dropped).toBe(0)
    expect(cues).toEqual([{ startMs: 1000, endMs: 2000, text: 'Hi' }])
  })

  it('parses blocks without an id and ignores the sequence numbers', () => {
    const { cues, dropped } = parseSrt(
      '00:00:02,000 --> 00:00:03,000\nSecond\n\n99\n00:00:01,000 --> 00:00:02,000\nFirst\n',
    )
    expect(dropped).toBe(0)
    // Sorted by start: the id-99 block comes first despite its number.
    expect(cues).toEqual([
      { startMs: 1000, endMs: 2000, text: 'First' },
      { startMs: 2000, endMs: 3000, text: 'Second' },
    ])
  })

  it('drops a timestamp line with extra arrow segments', () => {
    const { cues, dropped } = parseSrt('1\n00:00:01,000 --> 00:00:02,000 --> 00:00:03,000\nHi\n')
    expect(cues).toEqual([])
    expect(dropped).toBe(1)
  })

  it('parses single-digit minutes and seconds', () => {
    const { cues, dropped } = parseSrt('1\n0:0:1,000 --> 0:0:2,000\nHi\n')
    expect(dropped).toBe(0)
    expect(cues).toEqual([{ startMs: 1000, endMs: 2000, text: 'Hi' }])
  })

  it('drops a cue left blank by tag stripping', () => {
    const { cues, dropped } = parseSrt('1\n00:00:01,000 --> 00:00:02,000\n<i></i>\n')
    expect(cues).toEqual([])
    expect(dropped).toBe(1)
  })

  it('treats a numeric first line as an id only when a timestamp follows', () => {
    // "42" alone is not a cue: no timestamp line, so the block is malformed.
    const { cues, dropped } = parseSrt('42\nNot a timestamp\n')
    expect(cues).toEqual([])
    expect(dropped).toBe(1)
  })

  it('drops inverted, negative, non-finite, blank and too-short cues with exact counts', () => {
    const huge = '9'.repeat(400) // Number() overflows to Infinity: non-finite.
    const input = [
      '1\n00:00:02,000 --> 00:00:01,000\nInverted\n',
      '2\n-00:00:01,000 --> 00:00:02,000\nNegative\n',
      `3\n${huge}:00:01,000 --> ${huge}:00:02,000\nBeyond finite\n`,
      '4\n00:00:03,000 --> 00:00:04,000\n   \n',
      '5\n00:00:05,000 --> 00:00:05,099\nToo short\n',
      '6\n00:00:06,000 --> 00:00:07,000\nKept\n',
    ].join('\n')
    const { cues, dropped } = parseSrt(input)
    expect(dropped).toBe(5)
    expect(cues).toEqual([{ startMs: 6000, endMs: 7000, text: 'Kept' }])
  })

  it('rejects out-of-range timestamps but accepts the maximum', () => {
    // The latest representable end: exactly 1e9 s (277777 h + 6 min 40 s).
    const max = '277777:46:39,500 --> 277777:46:40,000\nEdge\n'
    const over = '277777:46:40,001 --> 277777:46:41,000\nPast\n'
    const { cues, dropped } = parseSrt(`1\n${max}\n2\n${over}`)
    expect(dropped).toBe(1)
    expect(cues).toEqual([{ startMs: 999999999500, endMs: 1000000000000, text: 'Edge' }])
  })

  it('tolerates leading blank lines and runs of blank lines', () => {
    // A stray whitespace-only first line must not poison the opening cue,
    // and runs of blank lines must not eat the cue that follows them.
    const { cues, dropped } = parseSrt(
      ' \n1\n00:00:01,000 --> 00:00:02,000\nA\n\n\n\n2\n00:00:03,000 --> 00:00:04,000\nB\n\n',
    )
    expect(dropped).toBe(0)
    expect(cues).toEqual([
      { startMs: 1000, endMs: 2000, text: 'A' },
      { startMs: 3000, endMs: 4000, text: 'B' },
    ])
  })

  it('returns zero cues and zero dropped for BOM-only input', () => {
    expect(parseSrt('﻿')).toEqual({ cues: [], dropped: 0 })
  })

  it('returns zero cues and zero dropped for empty input', () => {
    expect(parseSrt('')).toEqual({ cues: [], dropped: 0 })
    expect(parseSrt('\n\n  \n')).toEqual({ cues: [], dropped: 0 })
  })

  it('sorts by start, then end, then text in code-unit order', () => {
    const { cues } = parseSrt(
      '1\n00:00:01,000 --> 00:00:03,000\nb\n\n2\n00:00:01,000 --> 00:00:02,000\na\n\n3\n00:00:01,000 --> 00:00:02,000\nA\n',
    )
    expect(cues.map((c) => c.text)).toEqual(['A', 'a', 'b'])
  })
})

describe('serializeSrt', () => {
  it('emits exact wire text with renumbered ids and padded millis', () => {
    expect(
      serializeSrt([
        { startMs: 1000, endMs: 2000, text: 'Hello' },
        { startMs: 3500, endMs: 4000, text: 'World' },
      ]),
    ).toBe('1\n00:00:01,000 --> 00:00:02,000\nHello\n\n2\n00:00:03,500 --> 00:00:04,000\nWorld\n\n')
  })

  it('pads sub-100 ms fields to three digits on serialize', () => {
    expect(serializeSrt([{ startMs: 5, endMs: 105, text: 'Hi' }])).toBe(
      '1\n00:00:00,005 --> 00:00:00,105\nHi\n\n',
    )
  })

  it('drops blank cues and clamps an inverted end past start', () => {
    expect(
      serializeSrt([
        { startMs: 1000, endMs: 2000, text: '   ' },
        { startMs: 1000, endMs: 500, text: 'Fixed' },
      ]),
    ).toBe('1\n00:00:01,000 --> 00:00:01,001\nFixed\n\n')
  })
})

describe('collectCaptionCues', () => {
  it('orders equal-start cues by end then text and preserves overlaps', () => {
    const doc = captionDoc([
      { start: 1, duration: 2, text: 'b' },
      { start: 1, duration: 1, text: 'a' },
      { start: 1.5, duration: 2, text: 'overlap' },
      { start: 1, duration: 1, text: 'A' },
    ])
    expect(collectCaptionCues(doc).map((c) => c.text)).toEqual(['A', 'a', 'b', 'overlap'])
  })

  it('skips textless, sub-minimum and unflagged clips plus nested compounds', () => {
    const doc = captionDoc([
      { start: 1, duration: 1, text: 'kept' },
      { start: 2, duration: 1, text: '' },
      { start: 3, duration: 1, text: '   ' },
      { start: 4, duration: 0.05, text: 'short' },
      { start: 5, duration: 1, text: 'plain', isCaption: false },
    ])
    // A flagged clip inside a compound sequence is container-relative, not
    // root-absolute, so it stays out of the file.
    doc.project.sequences = [
      {
        id: 'seq_1',
        name: 'Nested',
        tracks: [
          {
            id: 'track_nested',
            kind: 'text',
            name: 'T1',
            clips: [createTextClip({ isCaption: true, start: 0, duration: 1, text: 'nested' })],
          },
        ],
      },
    ]
    expect(collectCaptionCues(doc)).toEqual([{ startMs: 1000, endMs: 2000, text: 'kept' }])
  })

  it('ignores flagged clips on non-text tracks, like the panel does', () => {
    const doc = captionDoc([{ start: 1, duration: 1, text: 'kept' }])
    const stray = createTextClip({ isCaption: true, start: 1, duration: 1, text: 'stray' })
    doc.project.tracks.find((t) => t.kind === 'video')!.clips.push(stray)
    expect(collectCaptionCues(doc)).toEqual([{ startMs: 1000, endMs: 2000, text: 'kept' }])
  })

  it('refuses a flagged caption with non-finite times', () => {
    // A deliberately corrupt fixture (the hand-made-file analog): no command
    // can store this anymore, but the file loader takes raw data, so the
    // export must still refuse it instead of downloading NaN timestamps.
    const doc = createDoc()
    const track = createTrack('text', 1, { name: 'Captions' })
    track.clips = [
      createTextClip({ id: 'cap_nan', isCaption: true, start: NaN, duration: 1, text: 'Slip' }),
    ]
    doc.project.tracks.push(track)
    expect(() => collectCaptionCues(doc)).toThrow(SrtRangeError)
  })

  it('refuses non-finite durations and negative starts', () => {
    const doc = createDoc()
    const track = createTrack('text', 1, { name: 'Captions' })
    track.clips = [
      createTextClip({ id: 'cap_neg', isCaption: true, start: -1, duration: 1, text: 'Neg' }),
    ]
    doc.project.tracks.push(track)
    expect(() => collectCaptionCues(doc)).toThrow(SrtRangeError)
    track.clips = [
      createTextClip({ id: 'cap_nand', isCaption: true, start: 1, duration: NaN, text: 'Dust' }),
    ]
    expect(() => collectCaptionCues(doc)).toThrow(SrtRangeError)
  })

  it('skips a flagged clip whose text is not a string', () => {
    // Hydration keeps string text only, so this is a programmatic-doc case:
    // the export skips it like a blank cue instead of throwing on .trim().
    const doc = createDoc()
    const track = createTrack('text', 1, { name: 'Captions' })
    const odd = createTextClip({ id: 'cap_odd', isCaption: true, start: 1, duration: 1, text: 'x' })
    odd.text = 42 as never
    track.clips = [odd]
    doc.project.tracks.push(track)
    expect(collectCaptionCues(doc)).toEqual([])
  })

  it('refuses a negative start that rounds to negative zero', () => {
    // Math.round(-0.4) is -0, and -0 < 0 is false: the millisecond check
    // alone passes, so the raw-seconds sign is checked too.
    const doc = createDoc()
    const track = createTrack('text', 1, { name: 'Captions' })
    track.clips = [
      createTextClip({ id: 'cap_negz', isCaption: true, start: -0.0004, duration: 1, text: 'Neg' }),
    ]
    doc.project.tracks.push(track)
    expect(() => collectCaptionCues(doc)).toThrow(SrtRangeError)
  })

  it('rounds a .5 ms edge up at the collect boundary', () => {
    // 5.7235 s reads exactly 5723.5 ms in floats: Math.round takes it to
    // 5724, pinning the halfway behavior the export depends on.
    const doc = captionDoc([{ start: 5.7235, duration: 0.1, text: 'Edge' }])
    expect(collectCaptionCues(doc)).toEqual([{ startMs: 5724, endMs: 5824, text: 'Edge' }])
  })

  it('keeps the full 0.1 s at large magnitudes', () => {
    const doc = captionDoc([{ start: 100000000.0005, duration: 0.1, text: 'Far' }])
    expect(collectCaptionCues(doc)).toEqual([
      { startMs: 100000000001, endMs: 100000000101, text: 'Far' },
    ])
  })

  it('refuses a clip whose rounded endMs crosses the limit', () => {
    // Raw end lands exactly on the limit, but the rounded endMs passes it.
    const doc = captionDoc([{ start: 999999999.8505, duration: 0.1495, text: 'Edge' }])
    expect(() => collectCaptionCues(doc)).toThrow(SrtRangeError)
  })
})

describe('SRT round trip', () => {
  it('parseSrt(serializeSrt(cues)) deep-equals the cues', () => {
    const cues = [
      { startMs: 1000, endMs: 2000, text: 'Hello\nworld' },
      { startMs: 2000, endMs: 2500, text: 'Kept <i>tags</i>' },
    ]
    const reparsed = parseSrt(serializeSrt(cues))
    expect(reparsed.dropped).toBe(0)
    // Tags are import-only plain-text conversions, so the second cue comes
    // back stripped: compare against the stripped expectation, not the input.
    expect(reparsed.cues).toEqual([
      { startMs: 1000, endMs: 2000, text: 'Hello\nworld' },
      { startMs: 2000, endMs: 2500, text: 'Kept tags' },
    ])
  })

  it('export-then-parse keeps every emitted cue', () => {
    const doc = captionDoc([
      { start: 1, duration: 1, text: 'One' },
      { start: 100000000.0005, duration: 0.1, text: 'Far' },
      { start: 2, duration: 1, text: '' },
    ])
    const emitted = collectCaptionCues(doc)
    const { cues, dropped } = parseSrt(serializeSrt(emitted))
    expect(dropped).toBe(0)
    expect(cues).toEqual(emitted)
  })

  it('MAX_SRT_TIME_SECONDS names the supported bound', () => {
    expect(MAX_SRT_TIME_SECONDS).toBe(1_000_000_000)
  })
})
