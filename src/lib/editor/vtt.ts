/**
 * WebVTT serializer (0.8.9): escape, timestamp, and document helpers behind
 * the captions Download VTT button. Pure and browser-free, like the SRT
 * codec; collection, ordering, and range checks stay in `srt.ts`.
 */
import type { SrtCue } from './srt'

/**
 * Escape cue text per the WebVTT spec: ampersands first, then angle
 * brackets, so the timestamp arrow becomes `--&gt;` losslessly and no
 * literal `-->` survives in payload text. Single-pass: already-escaped
 * input is escaped again, rendering its characters unchanged.
 */
export function escapeVttText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Format integer milliseconds as `HH:MM:SS.mmm` (no float math). */
function formatTimestampVtt(ms: number): string {
  const hours = Math.floor(ms / 3600000)
  const minutes = Math.floor((ms % 3600000) / 60000)
  const seconds = Math.floor((ms % 60000) / 1000)
  const millis = ms % 1000
  const pad = (v: number, len: number) => String(v).padStart(len, '0')
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(millis, 3)}`
}

/**
 * Normalize cue text for a WebVTT payload: CR and CRLF to LF, runs of two or
 * more newlines collapsed to one, leading and trailing newline runs
 * trimmed. A blank line terminates a VTT cue, so no blank run may pass
 * through; the export path already trims via the collector, and this
 * mirrors that defense for direct input.
 */
function normalizeVttText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .replace(/^\n+|\n+$/g, '')
}

/**
 * Serialize cues to WebVTT: `WEBVTT` header plus blank line, then cues in
 * emitted order separated by single blank lines, no sequence numbers.
 * Blank-text cues are dropped (mirroring the SRT export skip); an end
 * before start clamps to start + 1 ms. Valid input only: the export path
 * filters through `collectCaptionCues` first.
 */
export function serializeVtt(cues: SrtCue[]): string {
  let out = 'WEBVTT\n\n'
  for (const cue of cues) {
    const text = normalizeVttText(cue.text)
    if (text.trim() === '') continue
    const endMs = Math.max(cue.endMs, cue.startMs + 1)
    out += `${formatTimestampVtt(cue.startMs)} --> ${formatTimestampVtt(endMs)}\n${escapeVttText(text)}\n\n`
  }
  return out
}
