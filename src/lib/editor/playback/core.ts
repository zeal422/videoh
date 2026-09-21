import { docDuration, findMedia, sourceTimeAt } from '../factories'
import { getTransitionSpan } from '../transition'
import { hasLinkedAudioTwin } from '../links'
import { animatedValue } from '../keyframes'
import { ClipMediaPool } from '../media/elements'
import { clamp } from '../time'
import type { Clip, Doc, MediaAsset, Track } from '../types'
import { drawFrame } from './compositor'

/**
 * PlaybackCore — the playback/export engine.
 *
 * - Master clock: the AudioContext clock when audio is available (sample-accurate,
 *   drift-free), otherwise `performance.now()`.
 * - Compositing: draws every frame into the provided canvas via `drawFrame`.
 * - Audio: one HTMLMediaElement per clip (see ClipMediaPool), routed through a
 *   per-clip GainNode → master GainNode → destination (+ optional MediaStream
 *   destination for export). Per-frame gain computes clip gain × mute ×
 *   track mute × crossfade alpha.
 * - Drift correction: element position is compared with the expected source
 *   time every frame; drift > 120 ms triggers a resync.
 */

export interface PlaybackCoreOptions {
  canvas: HTMLCanvasElement
  getDoc: () => Doc
  onFrame?: (t: number) => void
  onEnd?: () => void
  onPlayingChange?: (playing: boolean) => void
}

const DRIFT_THRESHOLD = 0.12

/** Applies a clip's clamped speed to its element (reversed clips are stepped). */
function applyPlaybackRate(el: HTMLMediaElement, clip: Clip): void {
  const rate = clamp(clip.speed ?? 1, 0.25, 4)
  if (el.playbackRate !== rate) el.playbackRate = rate
}

/**
 * The shaping settings a clip's audio chain bakes in. EQ bands, compressor and
 * pan are node parameters set at build time, so a change to any of them means
 * the chain must be rebuilt for the edit to be audible.
 */
function shapingSignature(clip: Clip): string {
  const eq = clip.eq ? `${clip.eq.low}|${clip.eq.mid}|${clip.eq.high}` : ''
  return `${eq}/${clip.compressor ? 'c' : ''}/${clip.pan ?? 0}`
}

export class PlaybackCore {
  private ctx2d: CanvasRenderingContext2D | null
  private pool = new ClipMediaPool()
  private imageCache = new Map<string, HTMLImageElement>()

  private audio: AudioContext | null = null
  private masterGain: GainNode | null = null
  private streamDest: MediaStreamAudioDestinationNode | null = null
  /**
   * Per-clip gain node plus the shaping signature it was built for. EQ,
   * compressor and pan bake their settings into the node chain, so an edit
   * after the chain exists rebuilds it (see `applyGain`).
   */
  private clipGains = new Map<string, { gain: GainNode; sig: string; nodes: AudioNode[] }>()
  private masterVolume = 1
  /** EQ band frequencies for the three-band biquad stack. */
  private static readonly EQ_LO = 200
  private static readonly EQ_MID = 1000
  private static readonly EQ_HIGH = 4000

  private raf = 0
  private playingState = false
  private time = 0
  private anchorDoc = 0
  private anchorAudio = 0
  private anchorPerf = 0

  constructor(private opts: PlaybackCoreOptions) {
    opts.canvas.width = opts.getDoc().project.width
    opts.canvas.height = opts.getDoc().project.height
    this.ctx2d = opts.canvas.getContext('2d')
  }

  /** Audio output stream (a capture destination; export mixes offline instead). */
  get audioStream(): MediaStream | null {
    return this.streamDest?.stream ?? null
  }

  get currentTime(): number {
    return this.time
  }

  get isPlaying(): boolean {
    return this.playingState
  }

  /** Creates + resumes the AudioContext. Call from a user gesture when possible. */
  async prepare(): Promise<void> {
    this.ensureAudio()
    if (this.audio && this.audio.state !== 'running') {
      try {
        await this.audio.resume()
      } catch {
        // autoplay policy — will retry on play()
      }
    }
  }

  async play(from?: number): Promise<void> {
    const doc = this.opts.getDoc()
    const duration = docDuration(doc)
    if (duration <= 0) return

    if (from !== undefined) this.time = from
    if (this.time >= duration - 1e-4) this.time = 0 // restart at the end

    await this.prepare()

    this.anchorDoc = this.time
    this.anchorAudio = this.audio ? this.audio.currentTime : 0
    this.anchorPerf = performance.now()
    this.playingState = true
    this.opts.onPlayingChange?.(true)
    this.tick()
  }

  pause(): void {
    if (!this.playingState) return
    this.playingState = false
    cancelAnimationFrame(this.raf)
    this.pool.pauseAll()
    this.opts.onPlayingChange?.(false)
  }

  toggle(): void {
    if (this.playingState) this.pause()
    else void this.play()
  }

  seek(t: number): void {
    const duration = docDuration(this.opts.getDoc())
    this.time = clamp(t, 0, duration)
    if (this.playingState) {
      this.anchorDoc = this.time
      this.anchorAudio = this.audio ? this.audio.currentTime : 0
      this.anchorPerf = performance.now()
      this.syncMedia(this.time, true)
    } else {
      this.drawStill(this.time)
    }
    this.opts.onFrame?.(this.time)
  }

  stepFrames(n: number): void {
    const { fps } = this.opts.getDoc().project
    const target = Math.max(0, Math.round(this.time * fps) + n) / fps
    this.pause()
    this.seek(target)
  }

  setMasterVolume(v: number): void {
    this.masterVolume = clamp(v, 0, 1)
    if (this.masterGain && this.audio) {
      this.masterGain.gain.setTargetAtTime(this.masterVolume, this.audio.currentTime, 0.02)
    }
  }

  /** Syncs canvas size with (possibly changed) project settings. */
  syncResolution(): void {
    const { width, height } = this.opts.getDoc().project
    if (this.opts.canvas.width !== width) this.opts.canvas.width = width
    if (this.opts.canvas.height !== height) this.opts.canvas.height = height
  }

  /** The source time a clip should show at timeline time `t` (speed-aware). */
  private sourceTime(clip: Clip, t: number): number {
    return sourceTimeAt(clip, t - clip.start)
  }

  dispose(): void {
    this.pause()
    this.pool.dispose()
    this.imageCache.clear()
    if (this.audio) {
      void this.audio.close().catch(() => undefined)
      this.audio = null
      this.masterGain = null
      this.streamDest = null
      this.clipGains.clear()
    }
  }

  // ————— internals —————

  private ensureAudio(): void {
    if (this.audio) return
    try {
      const Ctor: typeof AudioContext | undefined =
        typeof AudioContext !== 'undefined'
          ? AudioContext
          : (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctor) return
      this.audio = new Ctor()
      this.masterGain = this.audio.createGain()
      this.masterGain.gain.value = this.masterVolume
      this.masterGain.connect(this.audio.destination)
      this.streamDest = this.audio.createMediaStreamDestination()
      this.masterGain.connect(this.streamDest)
    } catch {
      this.audio = null // element-volume fallback
    }
  }

  private tick = (): void => {
    if (!this.playingState) return
    const doc = this.opts.getDoc()
    const duration = docDuration(doc)

    const elapsed = this.audio
      ? this.audio.currentTime - this.anchorAudio
      : (performance.now() - this.anchorPerf) / 1000
    this.time = this.anchorDoc + elapsed

    if (this.time >= duration) {
      this.time = duration
      this.syncMedia(this.time)
      this.render(this.time)
      this.opts.onFrame?.(this.time)
      this.pause()
      this.opts.onEnd?.()
      return
    }

    this.syncMedia(this.time)
    this.render(this.time)
    this.opts.onFrame?.(this.time)
    this.raf = requestAnimationFrame(this.tick)
  }

  /** Starts/stops elements, corrects drift, and updates per-clip gain. */
  private syncMedia(t: number, forceSeek = false): void {
    const doc = this.opts.getDoc()
    for (const track of doc.project.tracks) {
      if (track.kind === 'text') continue
      for (const clip of track.clips) {
        const asset = findMedia(doc, clip.mediaId)
        if (!asset || asset.kind === 'image') continue
        const active = t >= clip.start && t < clip.start + clip.duration
        const el = this.pool.get(clip, asset)
        const expected = clamp(this.sourceTime(clip, t), 0, Math.max(0, asset.duration - 0.01))

        if (active) {
          if (clip.reverse) {
            // Reversed clips cannot play backwards in realtime: park the
            // element and seek to the mirrored source position (stepped
            // preview). Seeks walk backwards as the playhead advances.
            if (!el.paused) el.pause()
            if (forceSeek || Math.abs(el.currentTime - expected) > 1 / 60) {
              try {
                el.currentTime = expected
              } catch {
                // ignore
              }
            }
          } else if (el.paused) {
            try {
              el.currentTime = expected
            } catch {
              // seek before metadata — ignore
            }
            el.playbackRate = clamp(clip.speed ?? 1, 0.25, 4)
            void el.play().catch(() => undefined)
          } else if (forceSeek || Math.abs(el.currentTime - expected) > DRIFT_THRESHOLD) {
            try {
              el.currentTime = expected
            } catch {
              // ignore
            }
            // A speed edit while the clip already plays must reach the element
            // without a pause first (reversed clips stay stepped).
            applyPlaybackRate(el, clip)
          } else {
            applyPlaybackRate(el, clip)
          }
          const gain = this.computeGain(doc, track, clip, t)
          this.applyGain(clip.id, el, gain, clip)
        } else if (!el.paused) {
          el.pause()
        }
      }
    }
  }

  /** volume curve (animated or static gain) × clip mute × track mute × crossfade alpha; reversed clips are silent. */
  private computeGain(doc: Doc, track: Track, clip: Clip, t: number): number {
    const local = t - clip.start
    let gain = animatedValue(clip, 'volume', local)
    // A/V pairs: the audio twin is the group's sole sound carrier. The video
    // part keeps PLAYING (its element feeds the compositor frames) but its
    // embedded audio must be shadowed or the pair would double-play.
    // Reversed clips drop their audio (Premiere drops it too).
    if (clip.muted || track.muted || clip.reverse || hasLinkedAudioTwin(doc, clip)) return 0

    // Crossfade audio ramp when inside a transition span on this track.
    const clips = [...track.clips].sort((a, b) => a.start - b.start)
    for (let i = 0; i < clips.length - 1; i++) {
      const a = clips[i]
      const b = clips[i + 1]
      if (!a.transitionOut) continue
      const span = getTransitionSpan(a, b)
      if (!span || t < span.start || t > span.end) continue
      const p = (t - span.start) / Math.max(1e-9, span.duration)
      if (clip.id === a.id) gain *= 1 - p
      else if (clip.id === b.id) gain *= p
    }
    return clamp(gain, 0, 2)
  }

  private applyGain(clipId: string, el: HTMLMediaElement, value: number, clip: Clip): void {
    if (this.audio && this.masterGain) {
      const node = this.pool.getSourceNode(el, this.audio)
      const sig = shapingSignature(clip)
      let entry = this.clipGains.get(clipId)
      if (entry && entry.sig !== sig) {
        // Shaping changed (EQ / compressor / pan edit): tear the chain down so
        // the new settings are audible without restarting playback.
        for (const n of entry.nodes) {
          try {
            n.disconnect()
          } catch {
            // already detached
          }
        }
        try {
          node.disconnect()
        } catch {
          // already detached
        }
        this.clipGains.delete(clipId)
        entry = undefined
      }
      if (!entry) {
        const gain = this.audio.createGain()
        const nodes: AudioNode[] = []
        let head: AudioNode = node
        // Three-band EQ (low shelf / mid peak / high shelf) when configured.
        if (clip.eq) {
          const low = this.audio.createBiquadFilter()
          low.type = 'lowshelf'
          low.frequency.value = PlaybackCore.EQ_LO
          low.gain.value = clamp(clip.eq.low, -24, 24)
          const mid = this.audio.createBiquadFilter()
          mid.type = 'peaking'
          mid.frequency.value = PlaybackCore.EQ_MID
          mid.Q.value = 1
          mid.gain.value = clamp(clip.eq.mid, -24, 24)
          const high = this.audio.createBiquadFilter()
          high.type = 'highshelf'
          high.frequency.value = PlaybackCore.EQ_HIGH
          high.gain.value = clamp(clip.eq.high, -24, 24)
          head.connect(low)
          low.connect(mid)
          mid.connect(high)
          head = high
          nodes.push(low, mid, high)
        }
        if (clip.compressor) {
          const comp = this.audio.createDynamicsCompressor()
          comp.threshold.value = -24
          comp.knee.value = 12
          comp.ratio.value = 4
          comp.attack.value = 0.005
          comp.release.value = 0.18
          head.connect(comp)
          head = comp
          nodes.push(comp)
        }
        if ((clip.pan ?? 0) !== 0 && 'createStereoPanner' in this.audio) {
          const panner = this.audio.createStereoPanner()
          panner.pan.value = clamp(clip.pan ?? 0, -1, 1)
          head.connect(panner)
          head = panner
          nodes.push(panner)
        }
        head.connect(gain)
        gain.connect(this.masterGain)
        entry = { gain, sig, nodes }
        this.clipGains.set(clipId, entry)
      }
      entry.gain.gain.setTargetAtTime(value, this.audio.currentTime, 0.02)
    } else {
      // No Web Audio: fall back to element volume (single-digit dB precision).
      el.volume = clamp(value, 0, 1)
    }
  }

  private render(t: number): void {
    if (!this.ctx2d) return
    drawFrame({
      ctx: this.ctx2d,
      doc: this.opts.getDoc(),
      time: t,
      resolve: (clip) => this.resolveClip(clip),
    })
  }

  /**
   * Paused rendering: positions active video elements at their expected source
   * time and draws. A one-time `seeked` listener re-draws when the frame lands.
   */
  private drawStill(t: number): void {
    const doc = this.opts.getDoc()
    for (const track of doc.project.tracks) {
      if (track.kind === 'text') continue
      for (const clip of track.clips) {
        const asset = findMedia(doc, clip.mediaId)
        if (!asset || asset.kind !== 'video') continue
        const active = t >= clip.start && t < clip.start + clip.duration
        if (!active) continue
        const el = this.pool.get(clip, asset)
        const expected = clamp(this.sourceTime(clip, t), 0, Math.max(0, asset.duration - 0.01))
        if (Math.abs(el.currentTime - expected) > 0.02) {
          try {
            el.currentTime = expected
          } catch {
            // ignore
          }
          el.addEventListener(
            'seeked',
            () => {
              if (!this.playingState) this.render(t)
            },
            { once: true },
          )
        }
      }
    }
    this.render(t)
  }

  private resolveClip(
    clip: Clip,
  ): { asset: MediaAsset; el?: HTMLVideoElement | HTMLImageElement } | undefined {
    const doc = this.opts.getDoc()
    const asset = findMedia(doc, clip.mediaId)
    if (!asset) return undefined
    if (asset.kind === 'image') {
      let img = this.imageCache.get(asset.id)
      if (!img) {
        img = new Image()
        img.onload = () => {
          if (!this.playingState) this.render(this.time) // refresh once decoded
        }
        img.src = asset.url
        this.imageCache.set(asset.id, img)
      }
      return { asset, el: img.complete ? img : undefined }
    }
    if (asset.kind === 'video') {
      return { asset, el: this.pool.get(clip, asset) as HTMLVideoElement }
    }
    return { asset } // audio-only
  }
}
