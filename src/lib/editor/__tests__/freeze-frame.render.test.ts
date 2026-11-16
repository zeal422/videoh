// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { renderFreezeFrame, FreezeFrameError } from '../media/freeze-frame'
import { createClip, createDoc, createMediaAsset, createShapeClip, createTrack } from '../factories'
import type { Doc } from '../types'

/**
 * The renderer gets its own doubles: a fake canvas that records the compositor
 * calls, a fake `<video>` that answers `loadeddata` / `seeked`, and a fake
 * `Image`. The real compositor runs, so the seek target, the two passes, and
 * the PNG file shape are the production behavior, not a restatement.
 */

class FakeImage extends EventTarget {
  naturalWidth = 640
  naturalHeight = 360
  width = 640
  height = 360
  displayWidth = 640
  displayHeight = 360
  private source = ''
  set src(value: string) {
    this.source = value
    setTimeout(() => this.dispatchEvent(new Event('load')), 0)
  }
  get src(): string {
    return this.source
  }
}

class FakeVideo extends EventTarget {
  muted = false
  playsInline = false
  preload = ''
  readyState = 2
  videoWidth = 640
  videoHeight = 360
  displayWidth = 640
  displayHeight = 360
  /** The seek positions this element was asked for. */
  seeks: number[] = []
  failLoad = false
  paused = false
  loadCalls = 0
  private source = ''
  private time = 0
  set src(value: string) {
    this.source = value
    setTimeout(() => {
      if (this.failLoad) {
        this.dispatchEvent(new Event('error'))
        return
      }
      this.readyState = 2
      this.dispatchEvent(new Event('loadeddata'))
    }, 0)
  }
  get src(): string {
    return this.source
  }
  set currentTime(value: number) {
    this.time = value
    this.seeks.push(value)
    setTimeout(() => this.dispatchEvent(new Event('seeked')), 0)
  }
  get currentTime(): number {
    return this.time
  }
  pause(): void {
    this.paused = true
  }
  load(): void {
    this.loadCalls += 1
  }
  removeAttribute(name: string): void {
    if (name === 'src') this.source = ''
  }
}

interface CanvasEvent {
  kind: 'fillRect' | 'drawImage' | 'fill'
  style?: string
  width?: number
  height?: number
}

interface CanvasRecord {
  events: CanvasEvent[]
  width: number
  height: number
  options?: CanvasRenderingContext2DSettings
}

let videos: FakeVideo[] = []
let blobResult: Blob | null = null
let toBlobCalls = 0
let drawImageCalls = 0
let failVideoLoad = false
let canvasRecords: CanvasRecord[] = []

function fakeCanvas(): HTMLCanvasElement {
  const record: CanvasRecord = { events: [], width: 0, height: 0 }
  canvasRecords.push(record)
  const target: Record<string | symbol, unknown> = {
    fillRect: (x: number, y: number, width: number, height: number) => {
      record.events.push({
        kind: 'fillRect',
        style: String(target.fillStyle),
        width,
        height,
      })
    },
    drawImage: () => {
      drawImageCalls += 1
      record.events.push({ kind: 'drawImage' })
    },
    fill: () => {
      record.events.push({ kind: 'fill', style: String(target.fillStyle) })
    },
  }
  const context = new Proxy(target, {
    get(source, property) {
      if (property in source) return source[property]
      return () => undefined
    },
    set(source, property, value) {
      ;(source as Record<string | symbol, unknown>)[property] = value
      return true
    },
  })
  return {
    get width() {
      return record.width
    },
    set width(value: number) {
      record.width = value
    },
    get height() {
      return record.height
    },
    set height(value: number) {
      record.height = value
    },
    getContext: (_type: string, options?: CanvasRenderingContext2DSettings) => {
      record.options = options
      return context
    },
    toBlob: (callback: (blob: Blob | null) => void) => {
      toBlobCalls += 1
      callback(blobResult)
    },
  } as unknown as HTMLCanvasElement
}

beforeEach(() => {
  videos = []
  blobResult = new Blob(['png-bytes'], { type: 'image/png' })
  toBlobCalls = 0
  drawImageCalls = 0
  failVideoLoad = false
  canvasRecords = []
  vi.stubGlobal('Image', FakeImage)
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    if (tag === 'video') {
      const video = new FakeVideo()
      video.failLoad = failVideoLoad
      videos.push(video)
      return video
    }
    if (tag === 'canvas') return fakeCanvas()
    return document.createElementNS('http://www.w3.org/1999/xhtml', tag)
  }) as typeof document.createElement)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => null) as never)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function docWithVideo(): Doc {
  const doc = createDoc()
  doc.project.width = 320
  doc.project.height = 180
  doc.media = [
    createMediaAsset({
      id: 'media_v',
      kind: 'video',
      name: 'clip.mp4',
      duration: 20,
      width: 640,
      height: 360,
      url: 'blob:video',
      file: new File(['video'], 'clip.mp4', { type: 'video/mp4' }),
    }),
  ]
  doc.project.tracks = [
    createTrack('video', 1, {
      id: 'v1',
      clips: [
        createClip({
          id: 'clip_1',
          mediaId: 'media_v',
          start: 1,
          duration: 4,
          inPoint: 2,
          speed: 1,
        }),
      ],
    }),
  ]
  return doc
}

describe('renderFreezeFrame', () => {
  it('seeks the source frame, composites it, and returns an opaque PNG file', async () => {
    const doc = docWithVideo()
    const file = await renderFreezeFrame(doc, [], 2)
    // Playhead 2 is 1s into the clip, whose source starts at 2s.
    expect(videos).toHaveLength(1)
    expect(videos[0].seeks).toEqual([3])
    expect(toBlobCalls).toBe(1)
    expect(file.name).toBe('Freeze Frame.png')
    expect(file.type).toBe('image/png')
    expect(file.size).toBeGreaterThan(0)
    // The render pauses and detaches the decoder element when it finishes.
    expect(videos[0].src).toBe('')
    // The still is composited at project size on an opaque surface: the black
    // background covers the frame BEFORE the source is drawn, so no lower layer
    // can show through the still.
    const main = canvasRecords[0]
    expect(main.width).toBe(320)
    expect(main.height).toBe(180)
    expect(main.options?.alpha).toBe(false)
    const backgroundAt = main.events.findIndex(
      (event) =>
        event.kind === 'fillRect' &&
        event.style === '#000000' &&
        event.width === 320 &&
        event.height === 180,
    )
    const sourceAt = main.events.findIndex((event) => event.kind === 'drawImage')
    expect(backgroundAt).toBeGreaterThanOrEqual(0)
    expect(sourceAt).toBeGreaterThan(backgroundAt)
  })

  it('loads a still image directly instead of seeking it', async () => {
    const doc = createDoc()
    doc.media = [
      createMediaAsset({
        id: 'media_img',
        kind: 'image',
        name: 'still.png',
        width: 640,
        height: 360,
        url: 'blob:still',
        file: new File(['image'], 'still.png', { type: 'image/png' }),
      }),
    ]
    doc.project.tracks = [
      createTrack('video', 1, {
        id: 'v1',
        clips: [createClip({ id: 'c', mediaId: 'media_img', start: 0, duration: 4 })],
      }),
    ]
    const file = await renderFreezeFrame(doc, [], 1)
    expect(videos).toHaveLength(0)
    expect(file.type).toBe('image/png')
  })

  it('renders a shape-only frame without loading a media source', async () => {
    const doc = createDoc()
    doc.project.width = 320
    doc.project.height = 180
    doc.project.tracks = [
      createTrack('video', 1, {
        id: 'v1',
        clips: [createShapeClip({ id: 'shape_1', start: 0, duration: 4 })],
      }),
    ]
    const file = await renderFreezeFrame(doc, [], 1)
    // A shape draws from its own geometry: the compositor never asks for a
    // source frame, so the renderer must not refuse or load a decoder.
    expect(videos).toHaveLength(0)
    expect(drawImageCalls).toBe(0)
    expect(toBlobCalls).toBe(1)
    expect(file.type).toBe('image/png')
    const main = canvasRecords[0]
    expect(main.events.some((event) => event.kind === 'fill' && event.style === '#ffffff')).toBe(
      true,
    )
  })

  it('releases the decoder element when the source fails to load', async () => {
    failVideoLoad = true
    const doc = docWithVideo()
    await expect(renderFreezeFrame(doc, [], 2)).rejects.toThrow('could not be decoded')
    expect(toBlobCalls).toBe(0)
    expect(videos).toHaveLength(1)
    expect(videos[0].paused).toBe(true)
    expect(videos[0].src).toBe('')
    expect(videos[0].loadCalls).toBeGreaterThan(0)
  })

  it('keeps overlapping compound instances on their own source frames', async () => {
    const doc = createDoc()
    doc.project.width = 320
    doc.project.height = 180
    doc.media = [
      createMediaAsset({
        id: 'media_v',
        kind: 'video',
        name: 'clip.mp4',
        duration: 20,
        width: 640,
        height: 360,
        url: 'blob:video',
        file: new File(['video'], 'clip.mp4', { type: 'video/mp4' }),
      }),
    ]
    doc.project.sequences = [
      {
        id: 'seq_child',
        name: 'Inside',
        tracks: [
          createTrack('video', 1, {
            id: 'child_v',
            clips: [
              createClip({
                id: 'child_clip',
                mediaId: 'media_v',
                start: 0,
                duration: 10,
                inPoint: 0,
                speed: 1,
              }),
            ],
          }),
        ],
      },
    ]
    doc.project.tracks = [
      createTrack('video', 1, {
        id: 'v1',
        clips: [createClip({ id: 'compound_a', sequenceId: 'seq_child', start: 0, duration: 10 })],
      }),
      createTrack('video', 2, {
        id: 'v2',
        clips: [createClip({ id: 'compound_b', sequenceId: 'seq_child', start: 2, duration: 10 })],
      }),
    ]

    // At t=3 the two instances sit at local times 3 and 1 inside the same child
    // clip. Keying by clip id alone would seek only one of them.
    await renderFreezeFrame(doc, [], 3)

    expect(videos).toHaveLength(2)
    expect(videos.map((video) => video.seeks[0]).sort()).toEqual([1, 3])
  })

  it('refuses an offline source without encoding anything', async () => {
    const doc = docWithVideo()
    doc.media = []
    await expect(renderFreezeFrame(doc, [], 2)).rejects.toBeInstanceOf(FreezeFrameError)
    expect(toBlobCalls).toBe(0)
  })

  it('reports an encode failure', async () => {
    blobResult = null
    const doc = docWithVideo()
    await expect(renderFreezeFrame(doc, [], 2)).rejects.toThrow('could not be encoded')
    expect(toBlobCalls).toBe(1)
  })
})
