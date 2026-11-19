// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildProxy, dropProxy } from '../media/proxies'
import { createMediaAsset } from '../factories'
import { useEditorStore } from '../store'
import { installBrowserMocks, type MockHarness } from './mocks/browser-mocks'
import type { MediaAsset } from '../types'

/**
 * Proxy builds own a mediabunny Input for the whole transcode. Every exit path
 * (success, a missing track, a stale generation) must dispose it: the import
 * path calls `buildProxy` automatically for heavy sources, so a leak here is
 * routine rather than exceptional.
 */

const state = vi.hoisted(() => ({
  inputs: [] as Array<{ disposed: boolean }>,
  mode: 'track' as 'track' | 'none',
  gate: null as Promise<void> | null,
}))

vi.mock('mediabunny', () => {
  class FakeInput {
    disposed = false
    constructor() {
      state.inputs.push(this)
    }
    async getPrimaryVideoTrack() {
      if (state.gate) await state.gate
      if (state.mode === 'none') return undefined
      return {}
    }
    async getAudioTracks(): Promise<unknown[]> {
      return []
    }
    dispose() {
      this.disposed = true
    }
  }
  class FakeCanvasSink {
    async *canvases(): AsyncGenerator<{
      canvas: HTMLCanvasElement
      timestamp: number
      duration: number
    }> {
      yield {
        canvas: document.createElement('canvas'),
        timestamp: 0,
        duration: 1 / 30,
      }
    }
  }
  class FakeOutput {
    target: { buffer: ArrayBuffer | null }
    constructor(options: { target: { buffer: ArrayBuffer | null } }) {
      this.target = options.target
    }
    addVideoTrack(): void {}
    addAudioTrack(): void {}
    async start(): Promise<void> {}
    async finalize(): Promise<void> {}
    async cancel(): Promise<void> {}
  }
  class FakeCanvasSource {
    async add(): Promise<void> {}
    close(): void {}
  }
  return {
    ALL_FORMATS: {},
    BlobSource: class {},
    Input: FakeInput,
    CanvasSink: FakeCanvasSink,
    Output: FakeOutput,
    CanvasSource: FakeCanvasSource,
    BufferTarget: class {
      buffer: ArrayBuffer | null = new ArrayBuffer(8)
    },
    Mp4OutputFormat: class {},
    Quality: class {},
    AudioBufferSource: class {},
    canEncodeAudio: async () => false,
  }
})

let h: MockHarness
let originalCreate: typeof URL.createObjectURL | undefined
let originalRevoke: typeof URL.revokeObjectURL | undefined

beforeEach(() => {
  h = installBrowserMocks()
  document.body.innerHTML = ''
  useEditorStore.setState(useEditorStore.getInitialState())
  state.inputs.length = 0
  state.mode = 'track'
  state.gate = null
  originalCreate = URL.createObjectURL
  originalRevoke = URL.revokeObjectURL
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: () => 'blob:proxy',
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: () => undefined,
  })
})

afterEach(() => {
  h.uninstall()
  useEditorStore.setState(useEditorStore.getInitialState())
  if (originalCreate) {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: originalCreate,
    })
  } else {
    delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL
  }
  if (originalRevoke) {
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: originalRevoke,
    })
  } else {
    delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL
  }
})

function heavyAsset(): MediaAsset {
  return createMediaAsset({
    id: 'm_proxy',
    kind: 'video',
    name: 'heavy.mp4',
    duration: 10,
    width: 3840,
    height: 2160,
    url: 'blob:original',
    file: new File(['video'], 'heavy.mp4', { type: 'video/mp4' }),
  })
}

describe('proxy build Input ownership', () => {
  it('disposes the input after a successful build', async () => {
    await buildProxy(heavyAsset())
    expect(state.inputs).toHaveLength(1)
    expect(state.inputs[0].disposed).toBe(true)
    expect(useEditorStore.getState().proxyByAssetId.m_proxy).toEqual({
      status: 'ready',
      url: 'blob:proxy',
    })
  })

  it('disposes the input when the source has no video track', async () => {
    state.mode = 'none'
    await buildProxy(heavyAsset())
    expect(state.inputs).toHaveLength(1)
    expect(state.inputs[0].disposed).toBe(true)
    expect(useEditorStore.getState().proxyByAssetId.m_proxy).toEqual({ status: 'failed' })
  })

  it('disposes the input when the build became stale mid-transcode', async () => {
    let release!: () => void
    state.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const asset = heavyAsset()
    const build = buildProxy(asset)
    await vi.waitFor(() => expect(state.inputs).toHaveLength(1))
    dropProxy(asset.id)
    release()
    state.gate = null
    await build
    expect(state.inputs[0].disposed).toBe(true)
    expect(useEditorStore.getState().proxyByAssetId.m_proxy).toBeUndefined()
  })
})
