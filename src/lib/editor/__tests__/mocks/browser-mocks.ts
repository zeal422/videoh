import { vi } from 'vitest'

/**
 * Browser-API mock harness (worktree `ab/mock-test-harness`).
 *
 * Lets the playback engine, media pool and exporter run deterministically in
 * Node/jsdom ("B" side of the A/B battery):
 * - FakeAudioContext: controllable `currentTime` clock + a recorded gain graph
 *   (edges + setTargetAtTime events) so audio routing can be asserted.
 * - HTMLMediaElement patches: play/pause/paused/currentTime/load behave like
 *   state machines instead of jsdom's "not implemented" stubs.
 * - Fake2DContext: records every compositor call (fillRect/drawImage/fillText,
 *   globalAlpha values) instead of needing the `canvas` native package.
 * - FakeMediaStream + FakeMediaStreamAudioDestinationNode for the audio graph.
 * - Manual requestAnimationFrame pump: frames advance only when the test says.
 *
 * Everything installs through vi.stubGlobal / prototype patching and reports
 * through exported registries the tests assert against.
 */

// ————— Web Audio fakes —————

export interface GainEvent {
  type: 'setTarget' | 'setValue' | 'linearRamp'
  value: number
  time: number
  timeConstant?: number
}

export class FakeAudioParam {
  value = 1
  events: GainEvent[] = []
  setTargetAtTime(value: number, time: number, timeConstant: number): this {
    this.events.push({ type: 'setTarget', value, time, timeConstant })
    return this
  }
  setValueAtTime(value: number, time: number): this {
    this.events.push({ type: 'setValue', value, time })
    return this
  }
  linearRampToValueAtTime(value: number, time: number): this {
    this.events.push({ type: 'linearRamp', value, time })
    return this
  }
  cancelScheduledValues(): this {
    return this
  }
  /** Last scheduled value (tests use this for gain assertions). */
  get last(): GainEvent | undefined {
    return this.events[this.events.length - 1]
  }
}

export class FakeAudioNode {
  connections: FakeAudioNode[] = []
  /** Reverse edges — lets tests find "what feeds me" (e.g. master gain ← destination). */
  inputs: FakeAudioNode[] = []
  connect(dest: FakeAudioNode): FakeAudioNode {
    this.connections.push(dest)
    dest.inputs.push(this)
    return dest
  }
  disconnect(): void {
    for (const dest of this.connections) {
      dest.inputs = dest.inputs.filter((n) => n !== this)
    }
    this.connections = []
  }
}

export class FakeGainNode extends FakeAudioNode {
  gain = new FakeAudioParam()
}

export class FakeMediaElementSourceNode extends FakeAudioNode {
  constructor(public mediaElement: HTMLMediaElement) {
    super()
  }
}

export class FakeBiquadFilterNode extends FakeAudioNode {
  type = 'peaking'
  frequency = new FakeAudioParam()
  Q = new FakeAudioParam()
  gain = new FakeAudioParam()
}

export class FakeDynamicsCompressorNode extends FakeAudioNode {
  threshold = new FakeAudioParam()
  knee = new FakeAudioParam()
  ratio = new FakeAudioParam()
  attack = new FakeAudioParam()
  release = new FakeAudioParam()
}

export class FakeStereoPannerNode extends FakeAudioNode {
  pan = new FakeAudioParam()
}

class FakeStreamDest {
  stream = {
    tracks: [new FakeMediaStreamTrack('audio')],
    getAudioTracks() {
      return this.tracks
    },
    getVideoTracks() {
      return []
    },
    addTrack(t: FakeMediaStreamTrack) {
      this.tracks.push(t)
    },
  }
}

export class FakeMediaStreamAudioDestinationNode extends FakeAudioNode {
  stream = new FakeStreamDest().stream
}

export class FakeAudioContext {
  static instances: FakeAudioContext[] = []
  currentTime = 0
  state: 'suspended' | 'running' | 'closed' = 'suspended'
  sampleRate = 48000
  destination = new FakeAudioNode()
  constructor() {
    FakeAudioContext.instances.push(this)
  }
  async resume(): Promise<void> {
    if (this.state !== 'closed') this.state = 'running'
  }
  async suspend(): Promise<void> {
    this.state = 'suspended'
  }
  async close(): Promise<void> {
    this.state = 'closed'
  }
  /** Every shaping node (EQ / compressor / panner) this context created. */
  shapingNodes: FakeAudioNode[] = []
  createGain(): FakeGainNode {
    return new FakeGainNode()
  }
  createBiquadFilter(): FakeBiquadFilterNode {
    const node = new FakeBiquadFilterNode()
    this.shapingNodes.push(node)
    return node
  }
  createDynamicsCompressor(): FakeDynamicsCompressorNode {
    const node = new FakeDynamicsCompressorNode()
    this.shapingNodes.push(node)
    return node
  }
  createStereoPanner(): FakeStereoPannerNode {
    const node = new FakeStereoPannerNode()
    this.shapingNodes.push(node)
    return node
  }
  createMediaElementSource(el: HTMLMediaElement): FakeMediaElementSourceNode {
    return new FakeMediaElementSourceNode(el)
  }
  createMediaStreamDestination(): FakeMediaStreamAudioDestinationNode {
    return new FakeMediaStreamAudioDestinationNode()
  }
}

// ————— Media stream / recorder fakes —————

export class FakeMediaStreamTrack {
  stopped = false
  constructor(public kind: 'video' | 'audio') {}
  stop(): void {
    this.stopped = true
  }
}

export class FakeMediaStream {
  tracks: FakeMediaStreamTrack[] = []
  constructor(tracks: FakeMediaStreamTrack[] = []) {
    this.tracks = [...tracks]
  }
  getTracks() {
    return this.tracks
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video')
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio')
  }
  addTrack(t: FakeMediaStreamTrack): void {
    this.tracks.push(t)
  }
}

// ————— Canvas 2D fake —————

export interface Context2DCall {
  op: string
  args: unknown[]
}

/** Records every draw call + style property so compositor output is assertable. */
export function createFake2DContext() {
  const calls: Context2DCall[] = []
  const props = new Map<string | symbol, unknown>()
  const methods: Record<string, (...args: unknown[]) => unknown> = {
    save: () => calls.push({ op: 'save', args: [] }),
    restore: () => calls.push({ op: 'restore', args: [] }),
    fillRect: (...a: unknown[]) => calls.push({ op: 'fillRect', args: a }),
    clearRect: (...a: unknown[]) => calls.push({ op: 'clearRect', args: a }),
    drawImage: (...a: unknown[]) => calls.push({ op: 'drawImage', args: a }),
    fillText: (...a: unknown[]) => calls.push({ op: 'fillText', args: a }),
    strokeText: (...a: unknown[]) => calls.push({ op: 'strokeText', args: a }),
    beginPath: () => calls.push({ op: 'beginPath', args: [] }),
    moveTo: (...a: unknown[]) => calls.push({ op: 'moveTo', args: a }),
    lineTo: (...a: unknown[]) => calls.push({ op: 'lineTo', args: a }),
    stroke: () => calls.push({ op: 'stroke', args: [] }),
    setTransform: (...a: unknown[]) => calls.push({ op: 'setTransform', args: a }),
    translate: () => undefined,
    rotate: () => undefined,
    scale: () => undefined,
    measureText: (text: unknown) => ({ width: String(text).length * 7 }),
    createLinearGradient: () => ({ addColorStop: () => undefined }),
    createPattern: () => null,
  }
  return new Proxy(
    { calls, props },
    {
      get(_t, p: string | symbol) {
        if (p === 'calls') return calls
        if (p === 'props') return props
        if (typeof p === 'string' && methods[p]) return methods[p]
        return props.get(p)
      },
      set(_t, p: string | symbol, v) {
        // Style changes are recorded as ops so alpha sequences stay ordered.
        if (typeof p === 'string') calls.push({ op: `set:${p}`, args: [v] })
        props.set(p, v)
        return true
      },
    },
  ) as unknown as CanvasRenderingContext2D & {
    calls: Context2DCall[]
    props: Map<string | symbol, unknown>
  }
}

// ————— element patches —————

const kPaused = Symbol('fake-paused')

/** play()/pause()/paused/currentTime/load become deterministic state machines. */
export function patchMediaElements(): void {
  Object.defineProperty(HTMLMediaElement.prototype, 'paused', {
    configurable: true,
    get(this: HTMLMediaElement) {
      return ((this as unknown as Record<symbol, boolean>)[kPaused] ?? true) as boolean
    },
  })
  ;(HTMLMediaElement.prototype as unknown as Record<string | symbol, unknown>).play = function (
    this: HTMLMediaElement,
  ) {
    ;(this as unknown as Record<symbol, boolean>)[kPaused] = false
    this.dispatchEvent(new Event('play'))
    return Promise.resolve()
  }
  ;(HTMLMediaElement.prototype as unknown as Record<string | symbol, unknown>).pause = function (
    this: HTMLMediaElement,
  ) {
    ;(this as unknown as Record<symbol, boolean>)[kPaused] = true
    this.dispatchEvent(new Event('pause'))
  }
  ;(HTMLMediaElement.prototype as unknown as Record<string | symbol, unknown>).load = function () {
    /* no-op */
  }
  const time = new WeakMap<object, number>()
  Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
    configurable: true,
    get(this: HTMLMediaElement) {
      return time.get(this) ?? 0
    },
    set(this: HTMLMediaElement, v: number) {
      const prev = time.get(this) ?? 0
      time.set(this, v)
      if (Math.abs(prev - v) > 1e-9) this.dispatchEvent(new Event('seeked'))
    },
  })
}

/** Patches getContext('2d') for every canvas (the compositor's render target). */
export function patchCanvas(): void {
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
    const self = this as unknown as Record<string, unknown>
    if (!self.__fakeCtx) self.__fakeCtx = createFake2DContext()
    return self.__fakeCtx as CanvasRenderingContext2D
  } as unknown as typeof HTMLCanvasElement.prototype.getContext
}

// ————— rAF pump —————

export interface RAFPump {
  /** Runs `n` queued animation frames (callbacks may re-queue themselves). */
  pump(n?: number): Promise<void>
  queued(): number
}

export function installRAFPump(): RAFPump {
  const queue = new Map<number, FrameRequestCallback>()
  let nextId = 1
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = nextId++
    queue.set(id, cb)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    queue.delete(id)
  })
  return {
    async pump(n = 1) {
      for (let i = 0; i < n; i++) {
        const cbs = [...queue.values()]
        queue.clear()
        for (const cb of cbs) cb(performance.now())
        await Promise.resolve()
      }
    },
    queued() {
      return queue.size
    },
  }
}

// ————— master install/uninstall —————

export interface MockHarness {
  pump: RAFPump
  audioContexts(): FakeAudioContext[]
  lastAudioContext(): FakeAudioContext
  uninstall(): void
}

/**
 * Installs the full mock browser: AudioContext, MediaStream, rAF pump,
 * canvas 2D, and media element state machines. (The MediaRecorder mocks left
 * with the retired WebM exporter in 0.5.0.)
 */
export function installBrowserMocks(): MockHarness {
  FakeAudioContext.instances = []

  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('MediaStream', FakeMediaStream)
  // Radix primitives (Select, Slider) measure elements via ResizeObserver;
  // jsdom has none, so the harness installs a no-op observer.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  )
  patchMediaElements()
  patchCanvas()
  const pump = installRAFPump()

  return {
    pump,
    audioContexts: () => FakeAudioContext.instances,
    lastAudioContext: () => FakeAudioContext.instances[FakeAudioContext.instances.length - 1],
    uninstall: () => vi.unstubAllGlobals(),
  }
}
