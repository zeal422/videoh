import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AudioBufferSource, Output } from 'mediabunny'

import { audioChunkRanges, exportTimeline, webCodecsSupported } from '../export/mp4'
import { FakeAudioBuffer, FakeOfflineContext } from './mocks/browser-mocks'
import { createClip, createMediaAsset, createTrack } from '../factories'
import type { Clip, Doc, MediaAsset } from '../types'

/**
 * Audio-only export proof. The WAV muxer is the real mediabunny one; only Web
 * Audio is faked. WAV uses PCM, so these tests run with no VideoEncoder and no
 * AudioEncoder (the browser case this release adds).
 */
function audioDoc(overrides: Partial<Clip> = {}): Doc {
  const file = new File([new Uint8Array([1, 2, 3])], 'voice.wav', { type: 'audio/wav' })
  const media: MediaAsset = createMediaAsset({
    id: 'ma',
    name: 'voice.wav',
    kind: 'audio',
    duration: 1,
    url: 'blob:voice',
    file,
  })
  const clip = createClip({
    id: 'ca',
    mediaId: 'ma',
    audioOnly: true,
    start: 0,
    duration: 1,
    ...overrides,
  })
  return {
    project: {
      id: 'p',
      name: 'n',
      width: 1920,
      height: 1080,
      fps: 30,
      tracks: [createTrack('audio', 1, { id: 't1', clips: [clip] })],
    },
    media: [media],
  }
}

function sink() {
  const calls: string[] = []
  const chunks: { data: Uint8Array; position: number }[] = []
  return {
    calls,
    chunks,
    write: async (chunk: { data: Uint8Array; position: number }) => {
      calls.push('write')
      chunks.push({ data: new Uint8Array(chunk.data), position: chunk.position })
    },
    close: async () => {
      calls.push('close')
    },
    abort: async () => {
      calls.push('abort')
    },
  }
}

const globalScope = globalThis as { AudioBuffer?: unknown }
let previousAudioBuffer: unknown

beforeEach(() => {
  previousAudioBuffer = globalScope.AudioBuffer
  globalScope.AudioBuffer = FakeAudioBuffer
  vi.stubGlobal('window', {})
  vi.stubGlobal('OfflineAudioContext', FakeOfflineContext)
})

afterEach(() => {
  vi.unstubAllGlobals()
  if (previousAudioBuffer === undefined) delete globalScope.AudioBuffer
  else globalScope.AudioBuffer = previousAudioBuffer
})

describe('audio-only export (0.21.0)', () => {
  it('writes a valid WAV blob with no VideoEncoder or AudioEncoder available', async () => {
    expect(webCodecsSupported()).toBe(false)
    expect('AudioEncoder' in window).toBe(false)
    const result = await exportTimeline(audioDoc(), { container: 'wav' })
    expect(result.kind).toBe('blob')
    if (result.kind !== 'blob') throw new Error('expected a blob result')
    expect(result.mimeType).toBe('audio/wav')
    expect(result.duration).toBe(1)
    const bytes = new Uint8Array(await result.blob.arrayBuffer())
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('RIFF')
    expect(String.fromCharCode(...bytes.slice(8, 12))).toBe('WAVE')
    const view = new DataView(bytes.buffer)
    expect(view.getUint32(24, true)).toBe(48_000)
    expect(view.getUint32(40, true)).toBe(bytes.length - 44)
  })

  it('backfills a streamed WAV header through the file sink', async () => {
    const fileSink = sink()
    const result = await exportTimeline(audioDoc(), {
      container: 'wav',
      fileStream: fileSink,
      fileName: 'voice.wav',
    })
    expect(result.kind).toBe('file')
    if (result.kind !== 'file') throw new Error('expected a file result')
    expect(result.fileName).toBe('voice.wav')
    expect(result.mimeType).toBe('audio/wav')
    expect(fileSink.calls.filter((call) => call === 'write').length).toBeGreaterThan(0)
    expect(fileSink.calls.at(-1)).toBe('close')

    const size = Math.max(...fileSink.chunks.map((chunk) => chunk.position + chunk.data.length))
    const bytes = new Uint8Array(size)
    for (const chunk of fileSink.chunks) bytes.set(chunk.data, chunk.position)
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('RIFF')
    expect(new DataView(bytes.buffer).getUint32(40, true)).toBe(bytes.length - 44)
  })

  it('refuses audio-only export when an audible file is offline', async () => {
    const fileSink = sink()
    const withOffline = audioDoc()
    const offline = createMediaAsset({
      id: 'mb',
      kind: 'audio',
      name: 'missing.mp3',
      duration: 1,
      missing: true,
      url: '',
    })
    withOffline.media.push(offline)
    withOffline.project.tracks[0].clips.push(
      createClip({ id: 'cb', mediaId: 'mb', audioOnly: true, start: 0, duration: 1 }),
    )
    await expect(
      exportTimeline(withOffline, { container: 'wav', fileStream: fileSink }),
    ).rejects.toThrow(/missing\.mp3/)
    expect(fileSink.calls).toEqual(['abort'])
  })

  it('refuses a silent timeline and aborts the sink without writing', async () => {
    const fileSink = sink()
    await expect(
      exportTimeline(audioDoc({ muted: true }), { container: 'wav', fileStream: fileSink }),
    ).rejects.toThrow(/no audible audio/i)
    expect(fileSink.calls).toEqual(['abort'])
  })

  it('refuses M4A when the browser has no AAC encoder', async () => {
    vi.stubGlobal('window', {
      AudioEncoder: class {
        static isConfigSupported = async () => ({ supported: false })
      },
    })
    const fileSink = sink()
    await expect(
      exportTimeline(audioDoc(), { container: 'm4a', fileStream: fileSink }),
    ).rejects.toThrow(/M4A export needs an AAC encoder/)
    expect(fileSink.calls).toEqual(['abort'])
  })

  it('honors cancellation before rendering and aborts the sink', async () => {
    const fileSink = sink()
    await expect(
      exportTimeline(audioDoc(), { container: 'wav', fileStream: fileSink }, { cancelled: true }),
    ).rejects.toThrow('Export cancelled')
    expect(fileSink.calls).toEqual(['abort'])
  })

  it('stops before creating the output when cancelled during the mix', async () => {
    let release!: (buffer: FakeAudioBuffer) => void
    let started = false
    class GatedContext extends FakeOfflineContext {
      startRendering(): Promise<FakeAudioBuffer> {
        started = true
        return new Promise((resolve) => {
          release = resolve
        })
      }
    }
    vi.stubGlobal('OfflineAudioContext', GatedContext)
    const startSpy = vi.spyOn(Output.prototype, 'start')
    const addSpy = vi.spyOn(AudioBufferSource.prototype, 'add')
    try {
      const fileSink = sink()
      const handle = { cancelled: false }
      const run = exportTimeline(audioDoc(), { container: 'wav', fileStream: fileSink }, handle)
      await vi.waitFor(() => expect(started).toBe(true))
      handle.cancelled = true
      release(new FakeAudioBuffer())
      await expect(run).rejects.toThrow('Export cancelled')
      expect(startSpy).not.toHaveBeenCalled()
      expect(addSpy).not.toHaveBeenCalled()
      expect(fileSink.calls).toEqual(['abort'])
    } finally {
      startSpy.mockRestore()
      addSpy.mockRestore()
    }
  })

  it('stops before feeding the mix when cancelled during output start', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const originalStart = Output.prototype.start
    const startSpy = vi.spyOn(Output.prototype, 'start').mockImplementation(async function (
      this: Output,
    ) {
      await gate
      return originalStart.call(this)
    })
    const addSpy = vi.spyOn(AudioBufferSource.prototype, 'add')
    try {
      const fileSink = sink()
      const handle = { cancelled: false }
      const run = exportTimeline(audioDoc(), { container: 'wav', fileStream: fileSink }, handle)
      await vi.waitFor(() => expect(startSpy).toHaveBeenCalled())
      handle.cancelled = true
      release()
      await expect(run).rejects.toThrow('Export cancelled')
      expect(addSpy).not.toHaveBeenCalled()
      expect(fileSink.calls).toEqual(['abort'])
    } finally {
      startSpy.mockRestore()
      addSpy.mockRestore()
    }
  })

  it('stops before adding the source when cancelled during source creation', async () => {
    let release!: (supported: boolean) => void
    const gate = new Promise<boolean>((resolve) => {
      release = resolve
    })
    let probed = false
    class GatedEncoder {
      static isConfigSupported = () => {
        probed = true
        return gate.then((supported) => ({ supported }))
      }
    }
    vi.stubGlobal('window', { AudioEncoder: GatedEncoder })
    vi.stubGlobal('AudioEncoder', GatedEncoder)
    const startSpy = vi.spyOn(Output.prototype, 'start')
    const addSpy = vi.spyOn(AudioBufferSource.prototype, 'add')
    try {
      const fileSink = sink()
      const handle = { cancelled: false }
      const run = exportTimeline(audioDoc(), { container: 'mp3', fileStream: fileSink }, handle)
      await vi.waitFor(() => expect(probed).toBe(true))
      handle.cancelled = true
      release(true)
      await expect(run).rejects.toThrow('Export cancelled')
      expect(startSpy).not.toHaveBeenCalled()
      expect(addSpy).not.toHaveBeenCalled()
      expect(fileSink.calls).toEqual(['abort'])
    } finally {
      startSpy.mockRestore()
      addSpy.mockRestore()
    }
  })

  it('rechecks cancellation at the commit boundary and aborts the sink', async () => {
    const fileSink = sink()
    const handle = { cancelled: false }
    let reads = 0
    const options = {
      container: 'wav' as const,
      get fileStream() {
        reads += 1
        // Read 1 creates the export output; read 2 is the commit boundary.
        if (reads === 2) handle.cancelled = true
        return fileSink
      },
    }
    await expect(exportTimeline(audioDoc(), options, handle)).rejects.toThrow('Export cancelled')
    expect(fileSink.calls.at(-1)).toBe('abort')
    expect(fileSink.calls).not.toContain('close')
  })

  it('keeps a file committed by close() even when cancellation lands during it', async () => {
    const handle = { cancelled: false }
    const fileSink = sink()
    fileSink.close = async () => {
      fileSink.calls.push('close')
      handle.cancelled = true
    }
    const result = await exportTimeline(
      audioDoc(),
      { container: 'wav', fileStream: fileSink },
      handle,
    )
    expect(result.kind).toBe('file')
    expect(fileSink.calls.at(-1)).toBe('close')
    expect(fileSink.calls).not.toContain('abort')
  })
})

describe('audio chunking for interleaved video export', () => {
  it('splits the mix into one-second sample ranges with a short tail', () => {
    expect(audioChunkRanges(96_100, 48_000)).toEqual([
      { start: 0, end: 48_000 },
      { start: 48_000, end: 96_000 },
      { start: 96_000, end: 96_100 },
    ])
  })

  it('handles an empty mix without producing a range', () => {
    expect(audioChunkRanges(0, 48_000)).toEqual([])
  })

  it('builds an AudioBuffer fake from the options object used by chunk slicing', () => {
    const options = new FakeAudioBuffer({
      numberOfChannels: 1,
      length: 480,
      sampleRate: 24_000,
    })
    expect(options.numberOfChannels).toBe(1)
    expect(options.length).toBe(480)
    expect(options.sampleRate).toBe(24_000)
    expect(options.duration).toBeCloseTo(0.02, 6)
    expect(options.getChannelData(0)).toHaveLength(480)

    const positional = new FakeAudioBuffer(2, 96, 48_000)
    expect(positional.numberOfChannels).toBe(2)
    expect(positional.length).toBe(96)
    expect(positional.sampleRate).toBe(48_000)
  })
})
