'use client'

import { PlaybackCore } from '../playback/core'
import { docDuration } from '../factories'
import type { Doc } from '../types'

/**
 * Timeline export via MediaRecorder (real-time).
 *
 * The export runs its own PlaybackCore on an offscreen canvas:
 * - canvas.captureStream(fps) provides video frames,
 * - the core's Web Audio mix is tapped through a MediaStreamAudioDestinationNode,
 * - MediaRecorder encodes WebM (VP9/VP8 + Opus when available).
 *
 * MVP trade-off (documented): export runs at 1× playback speed — a 60s timeline
 * takes ~60s. WebCodecs-based offline rendering is a future milestone.
 */

export interface ExportHandle {
  cancelled: boolean
}

export interface ExportResult {
  blob: Blob
  mimeType: string
  duration: number
}

export interface ExportOptions {
  onProgress?: (t: number, duration: number) => void
  quality?: 'low' | 'medium' | 'high'
}

const BITRATES: Record<NonNullable<ExportOptions['quality']>, number> = {
  low: 2_500_000,
  medium: 6_000_000,
  high: 12_000_000,
}

function pickMimeType(): string {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4',
  ]
  for (const c of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c)) return c
  }
  return 'video/webm'
}

/** Renders the whole timeline to a video blob. Throws on unsupported browsers. */
export async function exportTimeline(
  doc: Doc,
  opts: ExportOptions = {},
  handle: ExportHandle = { cancelled: false },
): Promise<ExportResult> {
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('This browser does not support MediaRecorder export')
  }
  const duration = docDuration(doc)
  if (duration <= 0) throw new Error('Timeline is empty — nothing to export')

  const canvas = document.createElement('canvas')
  canvas.width = doc.project.width
  canvas.height = doc.project.height

  let resolvePlaybackDone: () => void = () => undefined
  const playbackDone = new Promise<void>((resolve) => {
    resolvePlaybackDone = resolve
  })

  let coreRef: PlaybackCore | null = null
  const core = new PlaybackCore({
    canvas,
    getDoc: () => doc,
    onFrame: (t) => {
      opts.onProgress?.(t, duration)
      if (handle.cancelled) {
        // A paused core never reaches the end, so playbackDone must be
        // resolved here — otherwise `await playbackDone` below deadlocks,
        // the recorder keeps recording and the poll interval leaks.
        coreRef?.pause()
        resolvePlaybackDone()
      }
    },
    onEnd: () => resolvePlaybackDone(),
  })
  coreRef = core

  // Audio graph must be created/resumed inside the user-gesture call chain.
  await core.prepare()

  const videoStream = canvas.captureStream(doc.project.fps)
  const stream = new MediaStream(videoStream.getVideoTracks())
  const audioStream = core.audioStream
  if (audioStream) {
    for (const track of audioStream.getAudioTracks()) stream.addTrack(track)
  }

  const mimeType = pickMimeType()
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: BITRATES[opts.quality ?? 'medium'],
  })
  const chunks: Blob[] = []
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data)
  }
  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve()
  })

  recorder.start(500)
  void core.play(0)

  const cancelPoll = window.setInterval(() => {
    if (handle.cancelled) {
      core.pause()
      resolvePlaybackDone() // same deadlock guard as onFrame (frames may stall)
    }
  }, 100)

  await playbackDone
  window.clearInterval(cancelPoll)

  // Flush the final frames before stopping the recorder.
  await new Promise((r) => setTimeout(r, 300))
  if (recorder.state !== 'inactive') recorder.stop()
  await stopped

  core.dispose()
  stream.getTracks().forEach((t) => t.stop())

  if (handle.cancelled) throw new Error('Export cancelled')

  const type = mimeType.split(';')[0]
  return { blob: new Blob(chunks, { type }), mimeType: type, duration }
}

/** Triggers a browser download for an exported blob. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}
