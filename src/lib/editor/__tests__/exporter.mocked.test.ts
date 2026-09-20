// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { exportTimeline, type ExportHandle } from '../export/exporter'
import { FakeMediaRecorder, installBrowserMocks, type MockHarness } from './mocks/browser-mocks'
import { createClip, createDoc, createMediaAsset } from '../factories'
import type { Doc } from '../types'

/**
 * exportTimeline against mocked MediaRecorder/canvas/Web Audio ("B" side of
 * the A/B battery): codec selection, recorder wiring, progress reporting,
 * cleanup — and the cancel path, which must REJECT rather than deadlock.
 */

let h: MockHarness

beforeEach(() => {
  h = installBrowserMocks()
})

afterEach(() => {
  h.uninstall()
})

function docWithDuration(duration: number): Doc {
  const doc = createDoc()
  const asset = createMediaAsset({
    kind: 'video',
    name: 'v',
    duration: duration + 10,
    width: 640,
    height: 360,
    url: 'blob:v',
  })
  doc.media.push(asset)
  doc.project.tracks[0].clips.push(
    createClip({ id: 'c1', mediaId: asset.id, start: 0, duration, inPoint: 0 }),
  )
  return doc
}

/** Drives the fake audio clock + rAF pump until the export promise settles. */
async function runUntilDone(
  run: Promise<unknown>,
  ctx: { currentTime: number },
  maxSeconds = 30,
): Promise<void> {
  let done = false
  run.then(
    () => {
      done = true
    },
    () => {
      done = true
    },
  )
  for (let s = 0; s < maxSeconds; s++) {
    ctx.currentTime += 0.25
    await h.pump.pump(2)
    await Promise.resolve()
    if (done) return
    // Real-time slack: after the simulated playback ends, exportTimeline still
    // sleeps ~300ms before stopping the recorder — yield to it.
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('HANG: export never settled within the simulated window')
}

describe('exportTimeline (mocked browser)', () => {
  it('throws when MediaRecorder is unsupported', async () => {
    vi.stubGlobal('MediaRecorder', undefined)
    await expect(exportTimeline(docWithDuration(2))).rejects.toThrow(
      /does not support MediaRecorder/,
    )
  })

  it('throws when the timeline is empty', async () => {
    await expect(exportTimeline(createDoc())).rejects.toThrow(/nothing to export/)
  })

  it('records the mixed stream with the chosen codec and resolves a webm blob', async () => {
    const doc = docWithDuration(2)
    const progress: [number, number][] = []
    const run = exportTimeline(doc, { onProgress: (t, d) => progress.push([t, d]) })

    await runUntilDone(run, h.lastAudioContext())
    const result = (await run) as { blob: Blob; mimeType: string; duration: number }

    // captureStream(fps) on the offscreen canvas
    expect(h.captureCalls).toEqual([{ fps: 30 }])
    const rec = h.lastRecorder()
    expect(rec.started).toBe(true)
    expect(rec.timeslice).toBe(500)
    expect(rec.options.mimeType).toBe('video/webm;codecs=vp9,opus')
    expect(rec.options.videoBitsPerSecond).toBe(6_000_000) // medium
    // Video + mixed audio track reach the recorder
    expect(rec.stream.getVideoTracks().length).toBe(1)
    expect(rec.stream.getAudioTracks().length).toBe(1)

    expect(result.mimeType).toBe('video/webm')
    expect(result.duration).toBe(2)
    expect(result.blob.size).toBeGreaterThan(0)
    expect(progress.length).toBeGreaterThan(0)
    expect(progress[0][1]).toBe(2)
    expect(progress.at(-1)?.[0]).toBeCloseTo(2, 5)

    // Cleanup: audio closed, recorder inactive, tracks stopped.
    expect(h.lastAudioContext().state).toBe('closed')
    expect(rec.state).toBe('inactive')
    const tracks = [...rec.stream.getVideoTracks(), ...rec.stream.getAudioTracks()]
    expect(tracks.every((t) => t.stopped)).toBe(true)
  })

  it('falls back down the codec candidate list (vp8 when vp9 missing)', async () => {
    FakeMediaRecorder.supported = ['video/webm;codecs=vp8,opus']
    const run = exportTimeline(docWithDuration(1))
    await runUntilDone(run, h.lastAudioContext())
    expect(h.lastRecorder().options.mimeType).toBe('video/webm;codecs=vp8,opus')
  })

  it('falls back to plain video/webm when nothing matches', async () => {
    FakeMediaRecorder.supported = []
    const run = exportTimeline(docWithDuration(1))
    await runUntilDone(run, h.lastAudioContext())
    expect(h.lastRecorder().options.mimeType).toBe('video/webm')
  })

  it('uses the high-quality bitrate when requested', async () => {
    const run = exportTimeline(docWithDuration(1), { quality: 'high' })
    await runUntilDone(run, h.lastAudioContext())
    expect(h.lastRecorder().options.videoBitsPerSecond).toBe(12_000_000)
  })

  it('REJECTS with "Export cancelled" when cancelled mid-flight (no deadlock)', async () => {
    // Regression lock: previously `await playbackDone` hung forever because the
    // cancelled core paused without ever firing onEnd — the recorder kept
    // recording and the poll interval leaked. The export must reject instead.
    const handle: ExportHandle = { cancelled: false }
    const run = exportTimeline(docWithDuration(4), {}, handle)

    // Let playback start, then cancel mid-flight.
    h.lastAudioContext().currentTime += 1
    await h.pump.pump(2)
    handle.cancelled = true
    h.lastAudioContext().currentTime += 0.25
    await h.pump.pump(2)

    await expect(
      Promise.race([
        run,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('HANG: cancel deadlocked the export')), 2000),
        ),
      ]),
    ).rejects.toThrow(/Export cancelled/)

    // Cleanup still happened.
    expect(h.lastAudioContext().state).toBe('closed')
    expect(h.lastRecorder().state).toBe('inactive')
  })
})
