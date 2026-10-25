import {
  activeTracks,
  clampSourceTime,
  docDuration,
  findMedia,
  findSequence,
  mediaPlayable,
  sequenceDuration,
  sourceTimeAt,
} from '../factories'
import { blendPartnerTime, blendWeight } from '../frame-blend'
import { denoiseFilters } from './denoise'
import { EQ_DB_MAX, EQ_DB_MIN, SPEED_MAX, SPEED_MIN } from '../constants'
import { crossfadeFactor } from '../transition'
import { hasLinkedAudioTwin, linkGroupChangesRate } from '../links'
import { animatedValue, constantTimeScaleRate, hasTimeScaleRamp } from '../keyframes'
import { ClipMediaPool } from '../media/elements'
import { clamp } from '../time'
import type { Clip, Doc, MediaAsset, Track } from '../types'
import { drawFrame, type FrameBlendSource } from './compositor'

/**
 * PlaybackCore: the preview playback engine.
 *
 * - Master clock: the AudioContext clock when audio is available (sample-accurate,
 *   drift-free), otherwise `performance.now()`.
 * - Compositing: draws every frame into the provided canvas via `drawFrame`.
 * - Audio: one HTMLMediaElement per clip (see ClipMediaPool), routed through a
 *   per-clip GainNode → master GainNode → destination (+ optional MediaStream
 *   capture destination). Per-frame gain computes clip gain × mute ×
 *   track mute × crossfade alpha.
 * - Drift correction: element position is compared with the expected source
 *   time every frame; a gap wider than DRIFT_THRESHOLD (0.4 s) triggers a
 *   resync. Reversed and ramped clips are stepped instead (see syncMedia).
 * - Sub-frame-rate blending: a clip reading below the source frame rate parks a
 *   SECOND, muted element on the partner read (frame-blend.ts) and the
 *   compositor blends the pair, exactly as the exporter blends it.
 */

export interface PlaybackCoreOptions {
  canvas: HTMLCanvasElement
  getDoc: () => Doc
  /**
   * The effective source URL for an asset: the proxy URL when proxies are on
   * and ready, else `asset.url`. Omitted by tests, which always read the
   * original.
   */
  resolveMediaUrl?: (asset: MediaAsset) => string
  /**
   * The active compound sequence path (0.8.1). The preview renders and syncs
   * the open sequence's tracks; omitted by tests, which start from the project
   * root.
   */
  getActiveSequencePath?: () => readonly string[]
  onFrame?: (t: number) => void
  onEnd?: () => void
  onPlayingChange?: (playing: boolean) => void
}

/**
 * One clip reachable from the active sequence, with the absolute timeline time
 * its sequence's local 0 sits at and the enclosing compound containers. Used to
 * sync every nested clip's element and to multiply each container's gain once.
 */
interface NestedClip {
  clip: Clip
  track: Track
  /** Absolute time of this clip's sequence local 0. */
  offset: number
  /** Enclosing containers from outermost to innermost, with their track and sequence offset. */
  ancestors: { clip: Clip; track: Track; offset: number }[]
}

/** Depth-first walk of a track list, descending into every compound clip. */
function walkClips(
  doc: Doc,
  tracks: readonly Track[],
  offset: number,
  ancestors: { clip: Clip; track: Track; offset: number }[],
  out: NestedClip[],
): void {
  for (const track of tracks) {
    for (const clip of track.clips) {
      out.push({ clip, track, offset, ancestors })
      if (clip.sequenceId) {
        const sequence = findSequence(doc, clip.sequenceId)
        if (sequence) {
          walkClips(
            doc,
            sequence.tracks,
            offset + clip.start,
            [...ancestors, { clip, track, offset }],
            out,
          )
        }
      }
    }
  }
}

/** True when `t` is inside the clip's window AND every ancestor container's. */
function withinAncestorWindows(
  t: number,
  start: number,
  end: number,
  ancestors: { clip: Clip; offset: number }[],
): boolean {
  if (t < start || t >= end) return false
  for (const ancestor of ancestors) {
    const aStart = ancestor.offset + ancestor.clip.start
    const aEnd = aStart + ancestor.clip.duration
    if (t < aStart || t >= aEnd) return false
  }
  return true
}

/**
 * Drift worth correcting. This must exceed the worst-case seek latency: a seek
 * that lands L seconds after it was issued leaves the element exactly L behind
 * the clock (the clock kept running while the decoder worked). With a threshold
 * below L, every landed seek looks like fresh drift and re-seeks forever: the
 * element never catches up and the preview stays black. 0.4 s covers unbuffered
 * seeks; ordinary playback drift (element clock vs audio clock) stays far below
 * it for a whole session.
 */
const DRIFT_THRESHOLD = 0.4
/**
 * A seek is not instantaneous: Chrome must demux + decode before the new frame
 * is present (the readback position updates immediately, the data does not).
 * A scrub that lands >1 s away takes hundreds of ms; until it lands the element
 * shows no drawable frame. While one is pending, every further seek restarts
 * the wait, so correction decisions made during that window are based on a
 * position the element has not reached yet.
 */
const SEEK_QUIET_MS = 350
/**
 * How far behind its read position a frame may sit and still be the frame the
 * element is showing. The presented frame's timestamp is at most one source
 * frame before the read, so a window this wide admits every sane source rate
 * (0.1 s covers down to 10 fps) while rejecting a frame left over from a seek
 * the element has not finished: blending against that stale frame would mix in
 * a distant part of the clip.
 */
const PRESENTED_STALE_WINDOW = 0.1
/**
 * Slack above a read position: a presented frame may sit marginally ahead of the
 * position reported for it, but a frame well ahead belongs to a position the
 * clip has already moved away from, which is not the frame to blend.
 */
const PRESENTED_LEAD_EPS = 1e-3
/**
 * How far a parked blend partner's target has to move before the paused path
 * re-seeks it. Much tighter than the primary element's 0.02 s dead zone in
 * `drawStill`: the partner read sits only a FRACTION of a source frame ahead of
 * the clip's own read (a quarter of one at 0.25x, a half at 0.5x), so with the
 * primary's threshold the partner would often never leave the frame the primary
 * shows, the pair would collapse onto one sample, and a scrubbed slow clip would
 * keep the very stepping this feature removes.
 */
const PARTNER_SEEK_EPS = 0.002
/**
 * How far INSIDE a frame a parked element is seeked, past the read it was asked
 * for (0.7.0).
 *
 * A read that lands exactly on a source frame's start timestamp is resolved
 * differently by the two decoders: the exporter's sample lookup keeps the last
 * sample with `timestamp <= t`, so the read shows the frame that STARTS there,
 * while an element seek to that same value can present the frame BEFORE it (the
 * position sits within float rounding of the boundary). Both the painted frame
 * and the blend weight depend on it: a partner left on the earlier frame
 * collapses the pair onto one sample (a blend the file has and the monitor does
 * not), and a primary left there matches the file against the wrong frame (a
 * blend the file does not have). Seeking a hair past the read removes the
 * ambiguity without changing which frame any read lands in: the offset is far
 * below every threshold the parked paths compare against (the tightest is half
 * of one output frame's source read, 5e-4 s at the slowest supported read).
 */
const SEEK_FRAME_NUDGE = 1e-4

/**
 * The position an element is parked at for a read: the read itself, a hair
 * inside the frame it names (see SEEK_FRAME_NUDGE). Every park goes through
 * this, because the played, stepped and still paths all have to agree on which
 * frame a read lands in; the dead zones that decide whether a park is needed
 * keep comparing the RAW read, so the offset never triggers a re-seek.
 */
function parkedTarget(read: number): number {
  return read + SEEK_FRAME_NUDGE
}

/**
 * The clip's effective CONSTANT rate, for elements that can follow one: the
 * static speed when no curve exists, the curve's flat value when it has one
 * (the curve overrides the static field). A real ramp returns undefined: no
 * constant rate can follow it, which is why ramped clips are stepped.
 */
function constantRateOf(clip: Clip): number {
  return constantTimeScaleRate(clip) ?? clamp(clip.speed ?? 1, SPEED_MIN, SPEED_MAX)
}

/** Applies a clip's clamped speed to its element (reversed clips are stepped). */
function applyPlaybackRate(el: HTMLMediaElement, clip: Clip): void {
  const rate = constantRateOf(clip)
  if (el.playbackRate !== rate) el.playbackRate = rate
}

/**
 * The shaping settings a clip's audio chain bakes in. EQ bands, compressor,
 * denoise and pan are node parameters set at build time, so a change to any of
 * them means the chain must be rebuilt for the edit to be audible.
 */
function shapingSignature(clip: Clip): string {
  const eq = clip.eq ? `${clip.eq.low}|${clip.eq.mid}|${clip.eq.high}` : ''
  return `${eq}/${clip.compressor ? 'c' : ''}/${clip.denoise ? 'n' : ''}/${clip.pan ?? 0}`
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
   * after the chain exists rebuilds it (see `applyGain`). `el` records the
   * element the chain was built from: a relink swaps the element under the
   * same clip id and signature, and the chain must follow it.
   */
  private clipGains = new Map<
    string,
    { gain: GainNode; sig: string; nodes: AudioNode[]; el: HTMLMediaElement }
  >()
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
  /**
   * Elements with a seek in flight, with the wall-clock time it started and
   * the `seeked` listener that clears it. While an element is here (or reports
   * `seeking`), it is left strictly alone: interrupting a pending seek
   * restarts the decode and can starve the element forever (observed: scrub
   * during playback kept the frame black for the rest of the timeline because
   * each rAF re-seeked a seek that never completed).
   */
  private seekingEls = new Map<HTMLMediaElement, { started: number; onSeeked: () => void }>()
  /**
   * The media timestamp of the frame each element last PRESENTED (0.7.0), from
   * requestVideoFrameCallback. Sub-frame-rate blending needs the timestamps of
   * the frames the decoder actually delivered, not the element's continuous read
   * position: the read of a slow clip sits between two source frames, and only
   * the pair's own timestamps give the weight the export computes. Browsers
   * without requestVideoFrameCallback never report one, and the preview then
   * keeps the stepped draw it always had.
   */
  private presentedTimes = new WeakMap<HTMLMediaElement, number>()
  /** Elements already registered with requestVideoFrameCallback. */
  private watchingFrames = new WeakSet<HTMLMediaElement>()

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
    const duration = this.durationOf(doc)
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
    const duration = this.durationOf(this.opts.getDoc())
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

  /**
   * The source time a clip should show at timeline time `t` (speed-aware).
   * `offset` is the absolute time the clip's sequence local 0 sits at, so a
   * nested clip reads its own local clock.
   */
  private sourceTime(clip: Clip, t: number, offset = 0): number {
    return sourceTimeAt(clip, t - offset - clip.start)
  }

  /** The active sequence's track list (root when no path is supplied). */
  private activeTracks(doc: Doc): readonly Track[] {
    return activeTracks(doc, this.opts.getActiveSequencePath?.() ?? [])
  }

  /**
   * The transport length: the root timeline at the project root, otherwise the
   * open compound sequence's local length (its own ruler).
   */
  private durationOf(doc: Doc): number {
    const path = this.opts.getActiveSequencePath?.() ?? []
    if (path.length === 0) return docDuration(doc)
    const sequence = findSequence(doc, path[path.length - 1])
    return sequence ? sequenceDuration(sequence) : docDuration(doc)
  }

  /** Every clip reachable from the active sequence, nested compounds included. */
  private activeClipList(doc: Doc): NestedClip[] {
    const out: NestedClip[] = []
    walkClips(doc, this.activeTracks(doc), 0, [], out)
    return out
  }

  dispose(): void {
    this.pause()
    this.pool.dispose()
    this.imageCache.clear()
    for (const el of [...this.seekingEls.keys()]) this.endSeek(el) // detach listeners too
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
    const duration = this.durationOf(doc)

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

  /**
   * Releases everything the engine still holds for clip ids that are no longer
   * in the doc (Delete, cut, undo, project replace): the doc iteration in
   * `syncMedia` only ever touches clips that ARE there, so without this a
   * deleted clip's element keeps playing audibly and its nodes keep feeding
   * masterGain for the rest of the session.
   */
  private releaseMissingClips(): void {
    const doc = this.opts.getDoc()
    const live = new Set<string>()
    for (const { clip } of this.activeClipList(doc)) {
      // A clip whose media no longer resolves (its asset was removed from
      // the bin while the clip survives for undo/relink) is NOT live: the
      // doc keeps the clip, but keeping its element would let it play on
      // against a source nothing can resolve (the ghost-playback hole).
      // The SAME predicate gates syncMedia below (mediaPlayable), so the
      // two can never disagree.
      if (!mediaPlayable(findMedia(doc, clip.mediaId))) continue
      live.add(clip.id)
    }
    // Parked blend partners follow the same rule: a clip that is gone must not
    // keep a second decode alive.
    for (const id of this.pool.nextIds()) {
      if (!live.has(id)) this.pool.releaseNext(id)
    }
    for (const id of this.pool.ids()) {
      if (live.has(id)) continue
      const el = this.pool.peek(id)
      if (el) {
        if (!el.paused) el.pause()
        this.endSeek(el)
      }
      const entry = this.clipGains.get(id)
      if (entry) {
        try {
          this.pool.getSourceNode(el!, this.audio!).disconnect()
        } catch {
          // already detached, or audio closed mid-teardown
        }
        for (const n of entry.nodes) {
          try {
            n.disconnect()
          } catch {
            // already detached
          }
        }
        try {
          entry.gain.disconnect() // the chain's edge into masterGain
        } catch {
          // already detached
        }
        this.clipGains.delete(id)
      }
      this.pool.release(id)
    }
  }

  /** Starts/stops elements, corrects drift, and updates per-clip gain. */
  private syncMedia(t: number, forceSeek = false): void {
    const doc = this.opts.getDoc()
    this.releaseMissingClips()
    for (const { clip, track, offset, ancestors } of this.activeClipList(doc)) {
      if (track.kind === 'text') continue
      const asset = findMedia(doc, clip.mediaId)
      // Restored sessions keep assets without a URL ("missing" until
      // relinked). Elements for them are pure noise: error events, autoplay
      // attempts on an empty source, "playing" elements that can never show
      // or sound anything. Skip them entirely, via the same test
      // releaseMissingClips uses above, so a clip this loop refuses to
      // touch has always just had its element released. A compound container
      // (no media) falls through here too.
      if (!mediaPlayable(asset)) continue
      const start = offset + clip.start
      const active = withinAncestorWindows(t, start, start + clip.duration, ancestors)
      const el = this.pool.get(clip, asset, this.mediaUrl(asset))
      // Clamped into the asset: a ramp may over-consume its source, and the
      // excess freezes on the last readable frame (mp4.ts clamps identically).
      const expected = clampSourceTime(this.sourceTime(clip, t, offset), asset)

      if (active) {
        // A pending seek must finish before the element is touched again. An
        // interrupted seek restarts its decode, so a loop of interrupted
        // seeks never yields a frame (black picture, no audio) even though
        // the playhead keeps advancing. `seeking` covers real browsers; the
        // map also carries fakes that never clear the flag. Inactive clips
        // still fall through to the pause below.
        if (this.trackingSeek(el)) continue

        if (clip.reverse || hasTimeScaleRamp(clip)) {
          // Two cases park the element and seek to the exact source position
          // every tick (stepped preview): a reversed clip cannot play
          // backwards in realtime, and a ramped clip's source position is a
          // curve integral that a constant playbackRate cannot follow (the
          // element would drift up to DRIFT_THRESHOLD behind the ramp, which
          // reads as the wrong speed for seconds). A flat curve is NOT
          // parked: its constant rate is applied below like a plain speed.
          // Neither case writes the curve into playbackRate; reverse's seek
          // walks backwards as the playhead advances.
          if (!el.paused) el.pause()
          if (forceSeek || Math.abs(el.currentTime - expected) > 1 / 60) {
            this.seekElement(el, expected)
          }
        } else if (el.paused) {
          this.seekElement(el, expected)
          el.playbackRate = constantRateOf(clip)
          void el.play().catch(() => undefined)
        } else if (forceSeek || Math.abs(el.currentTime - expected) > DRIFT_THRESHOLD) {
          this.seekElement(el, expected)
          // A speed edit while the clip already plays must reach the element
          // without a pause first (reversed clips stay stepped).
          applyPlaybackRate(el, clip)
        } else {
          applyPlaybackRate(el, clip)
        }
        const gain = this.computeGain(doc, track, clip, t, offset, ancestors)
        this.applyGain(clip.id, el, gain, clip)
      } else if (!el.paused) {
        el.pause()
        this.endSeek(el)
      }
      this.syncBlendElement(clip, asset, t, active, forceSeek, offset)
    }
  }

  /**
   * Positions (or drops) the parked blend partner of one clip (0.7.0).
   *
   * The partner is PARKED and seeked to the exact partner read, like a reversed
   * or ramped clip's element: it only has to hold one frame, and a second
   * element playing alongside the first would drift from it. While a seek is in
   * flight the element is left alone, because an interrupted seek restarts its
   * decode (see trackingSeek). A clip that no longer reads below the frame rate
   * (a speed edit) drops its partner: the element would otherwise keep a second
   * decode alive for a pair nothing will ask for.
   */
  private syncBlendElement(
    clip: Clip,
    asset: MediaAsset,
    t: number,
    active: boolean,
    forceSeek: boolean,
    offset = 0,
  ): void {
    const partner = blendPartnerTime(
      clip,
      t - offset - clip.start,
      asset,
      this.opts.getDoc().project.fps,
    )
    if (partner === undefined) {
      this.pool.releaseNext(clip.id)
      return
    }
    const el = this.pool.getNext(clip, asset, this.mediaUrl(asset))
    if (!el) return
    this.watchPresentedFrames(el)
    if (!active) {
      if (!el.paused) el.pause()
      return
    }
    if (this.trackingSeek(el)) return
    const target = clampSourceTime(partner, asset)
    if (forceSeek || Math.abs(el.currentTime - target) > PARTNER_SEEK_EPS) {
      this.seekElement(el, target)
    }
  }

  /**
   * Tracks the media timestamp of the frame an element presents, through
   * requestVideoFrameCallback (0.7.0). The callback is one-shot, so it re-arms
   * itself; an element that never presents another frame (parked, or a browser
   * without the API) simply never reports one.
   */
  private watchPresentedFrames(el: HTMLMediaElement): void {
    const video = el as HTMLVideoElement
    if (typeof video.requestVideoFrameCallback !== 'function') return
    if (this.watchingFrames.has(el)) return
    this.watchingFrames.add(el)
    const onFrame: VideoFrameRequestCallback = (_now, metadata) => {
      this.presentedTimes.set(el, metadata.mediaTime)
      // A parked monitor repaints on the presented frame itself (0.7.0). `seeked`
      // fires when the position lands, which can be BEFORE the decoded frame
      // reaches the compositor: a draw at that moment pairs the newly presented
      // frame with the one before it, or falls back to a single frame, and
      // nothing else would revisit the parked canvas. One repaint per presented
      // frame, and none while playing (the render loop already repaints).
      if (!this.playingState) this.render(this.time)
      video.requestVideoFrameCallback(onFrame)
    }
    video.requestVideoFrameCallback(onFrame)
  }

  /**
   * The media timestamp of the frame an element is SHOWING near `target`, or
   * undefined when the element cannot vouch for one: nothing reported yet, a seek
   * still in flight (the element keeps displaying its OLD frame until the decode
   * lands), a frame from a position already moved away from, or a frame too far
   * behind the target to be the one the read asks for. Each case falls back to
   * the single-frame draw rather than blending against the wrong frame.
   */
  private presentedTime(el: HTMLMediaElement, target: number): number | undefined {
    if (el.seeking) return undefined
    const ts = this.presentedTimes.get(el)
    if (ts === undefined) return undefined
    if (ts > target + PRESENTED_LEAD_EPS) return undefined
    if (target - ts > PRESENTED_STALE_WINDOW) return undefined
    return ts
  }

  /**
   * The blend pair for one clip's sub-frame-rate read: the parked partner
   * element, plus the weight between the two frames the decoder is showing. The
   * weight comes from the shared `blendWeight`, so the preview and the export
   * compute it the same way; only its inputs differ (presented-frame timestamps
   * here, the exporter's decoded sample timestamps there).
   */
  private blendFor(
    clip: Clip,
    primary: HTMLMediaElement,
    asset: MediaAsset,
    local: number,
  ): FrameBlendSource | undefined {
    const { fps } = this.opts.getDoc().project
    const partnerTime = blendPartnerTime(clip, local, asset, fps)
    if (partnerTime === undefined) return undefined
    const partner = this.pool.peekNext(clip.id)
    if (!partner || partner.readyState < 2) return undefined
    // The primary's own read position is the reference for its frame: the
    // element plays on the element clock, so its presented frame can sit a hair
    // ahead of the playhead-derived source time.
    const a = this.presentedTime(primary, primary.currentTime)
    const b = this.presentedTime(partner, clampSourceTime(partnerTime, asset))
    if (a === undefined || b === undefined) return undefined
    const weight = blendWeight(sourceTimeAt(clip, local), a, b)
    // Strictly inside (0, 1): the ends reduce to a single frame, and the export
    // skips the pair there too.
    if (!(weight > 0 && weight < 1)) return undefined
    return { el: partner, weight }
  }

  /**
   * The still path's seek dead zone (0.7.0): HALF the source time one output
   * frame consumes at the playhead, capped at the old flat 0.02 s.
   *
   * A flat 0.02 s is 0.6 of a 30 fps source frame, so a clip reading slower than
   * realtime only re-seeked every few steps and the monitor held a frame the
   * export would already have moved past. Half of one frame's read keeps the
   * element on the frame the read falls in (a step of one output frame always
   * crosses it) while a sub-frame scrub jitter still does not restart a decode.
   */
  private stillSeekEps(clip: Clip, t: number, fps: number, offset = 0): number {
    const step = 1 / Math.max(1, fps)
    const perFrame = Math.abs(
      this.sourceTime(clip, t + step, offset) - this.sourceTime(clip, t, offset),
    )
    return Math.min(0.02, perFrame / 2)
  }

  /** True while the element has a seek in flight (and keeps tracking it). */
  private trackingSeek(el: HTMLMediaElement): boolean {
    if (el.seeking) return true
    const entry = this.seekingEls.get(el)
    if (!entry) return false
    if (performance.now() - entry.started > SEEK_QUIET_MS) {
      this.endSeek(el)
      return false
    }
    return true
  }

  /**
   * Assigns a new element position and tracks the seek until its decode lands.
   * Real browsers fire `seeked` when the frame is ready; the fake elements in
   * tests fire it synchronously on a value change, so only an assignment that
   * actually moves the position is tracked. A no-op assignment (same value)
   * never emits `seeked` there and must not leave a stale "seeking" entry.
   */
  private seekElement(el: HTMLMediaElement, expected: number): void {
    // Track BEFORE the assignment: a synchronous `seeked` (fake elements, or a
    // browser that completes instantly) then clears the entry within this call,
    // and an async browser keeps it until the decode lands.
    this.beginSeek(el)
    const prev = el.currentTime
    // Land inside the frame the read names rather than on its edge (see
    // SEEK_FRAME_NUDGE): the exporter resolves an exact frame start to the frame
    // that begins there, and an element seek to the bare value does not.
    const target = parkedTarget(expected)
    try {
      el.currentTime = target
    } catch {
      this.endSeek(el)
      return // seek before metadata: nothing to track
    }
    if (Math.abs(prev - target) <= 1e-9) this.endSeek(el)
  }

  private beginSeek(el: HTMLMediaElement): void {
    // A superseded seek whose decode lands later must not leave its listener
    // attached until the NEXT seek's `seeked`: the entry owns the handler and
    // `endSeek` removes it, so a re-seek replaces both atomically. The timeout
    // in `trackingSeek` stays only as a backstop for paths that never emit.
    this.endSeek(el)
    const entry: { started: number; onSeeked: () => void } = {
      started: performance.now(),
      onSeeked: () => this.endSeek(el),
    }
    this.seekingEls.set(el, entry)
    el.addEventListener('seeked', entry.onSeeked)
  }

  private endSeek(el: HTMLMediaElement): void {
    const entry = this.seekingEls.get(el)
    if (!entry) return
    el.removeEventListener('seeked', entry.onSeeked)
    this.seekingEls.delete(el)
  }

  /** volume curve (animated or static gain) × clip mute × track mute × crossfade alpha; reversed clips are silent. */
  private computeGain(
    doc: Doc,
    track: Track,
    clip: Clip,
    t: number,
    offset = 0,
    ancestors: { clip: Clip; track: Track; offset: number }[] = [],
  ): number {
    const local = t - offset - clip.start
    let gain = animatedValue(clip, 'volume', local)
    // A/V pairs: the audio twin is the group's sole sound carrier. The video
    // part keeps PLAYING (its element feeds the compositor frames) but its
    // embedded audio must be shadowed or the pair would double-play.
    // Reversed clips drop their audio (Premiere drops it too), and so does an
    // A/V pair whose rates disagree: a real ramp needs varispeed or a
    // resampler (neither exists here), and an effective rate (a curve's
    // constant or the plain static speed) that leaves the halves disagreeing
    // retimes the picture against the twin. A manual link without a carrier is
    // not an A/V pair and keeps its own audio. The check is DERIVED from the
    // rates (linkGroupChangesRate), so it can never go stale the way a stored
    // flag could; it covers both pair members.
    if (
      clip.muted ||
      track.muted ||
      clip.reverse ||
      linkGroupChangesRate(doc, clip) ||
      hasLinkedAudioTwin(doc, clip)
    ) {
      return 0
    }

    // Crossfade audio ramp on this clip's own track (sequence-local span).
    gain *= crossfadeFactor(track, clip, t - offset)
    // Every enclosing compound container applies its gain, mute, volume curve
    // and crossfade ONCE to the nested mix (its own track and local clock).
    for (const ancestor of ancestors) {
      if (ancestor.clip.muted || ancestor.track.muted) return 0
      gain *= animatedValue(ancestor.clip, 'volume', t - ancestor.offset - ancestor.clip.start)
      gain *= crossfadeFactor(ancestor.track, ancestor.clip, t - ancestor.offset)
    }
    return clamp(gain, 0, 2)
  }

  private applyGain(clipId: string, el: HTMLMediaElement, value: number, clip: Clip): void {
    if (this.audio && this.masterGain) {
      const node = this.pool.getSourceNode(el, this.audio)
      const sig = shapingSignature(clip)
      let entry = this.clipGains.get(clipId)
      if (entry && (entry.sig !== sig || entry.el !== el)) {
        // Shaping changed (EQ / compressor / pan edit), or the ELEMENT changed:
        // a relink gives the asset a new url, `pool.get` swaps the element
        // under the same clip id, and the cached chain would keep feeding
        // masterGain from the old element's source node while the compositor
        // reads the new one. Tear the chain down so the new element (or the
        // new settings) are audible without restarting playback.
        for (const n of entry.nodes) {
          try {
            n.disconnect()
          } catch {
            // already detached
          }
        }
        try {
          entry.gain.disconnect() // the old chain's edge into masterGain
        } catch {
          // already detached
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
          low.gain.value = clamp(clip.eq.low, EQ_DB_MIN, EQ_DB_MAX)
          const mid = this.audio.createBiquadFilter()
          mid.type = 'peaking'
          mid.frequency.value = PlaybackCore.EQ_MID
          mid.Q.value = 1
          mid.gain.value = clamp(clip.eq.mid, EQ_DB_MIN, EQ_DB_MAX)
          const high = this.audio.createBiquadFilter()
          high.type = 'highshelf'
          high.frequency.value = PlaybackCore.EQ_HIGH
          high.gain.value = clamp(clip.eq.high, EQ_DB_MIN, EQ_DB_MAX)
          head.connect(low)
          low.connect(mid)
          mid.connect(high)
          head = high
          nodes.push(low, mid, high)
        }
        if (clip.denoise) {
          for (const filter of denoiseFilters(this.audio)) {
            head.connect(filter)
            head = filter
            nodes.push(filter)
          }
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
        entry = { gain, sig, nodes, el }
        this.clipGains.set(clipId, entry)
      }
      entry.gain.gain.setTargetAtTime(value, this.audio.currentTime, 0.02)
    } else {
      // No Web Audio: fall back to element volume (single-digit dB precision).
      el.volume = clamp(value, 0, 1)
    }
  }

  private mediaUrl(asset: MediaAsset): string {
    return this.opts.resolveMediaUrl?.(asset) ?? asset.url
  }

  private render(t: number): void {
    if (!this.ctx2d) return
    const doc = this.opts.getDoc()
    drawFrame({
      ctx: this.ctx2d,
      doc,
      time: t,
      // The frame time is threaded through, never read back off the engine, so
      // one draw is internally consistent: the compositor, the still-frame
      // resolver and the blend pair all use the time this render was asked for.
      // A landing seek asks for the CURRENT playhead (see drawStill), never the
      // time its own seek was issued for, so a superseded seek cannot repaint a
      // stale frame over a newer one. The compositor hands the resolver each
      // clip's own LOCAL time, so a nested clip reads its sequence clock.
      resolve: (clip, local) => this.resolveClip(clip, local),
      tracks: this.activeTracks(doc),
    })
  }

  /**
   * Paused rendering: positions active video elements at their expected source
   * time and draws. A one-time `seeked` listener re-draws when the frame lands.
   */
  private drawStill(t: number): void {
    const doc = this.opts.getDoc()
    // Paused edits (Delete, undo, relink) never reach syncMedia, so the release
    // pass runs here too: a clip deleted while paused must not leave its
    // parked blend element holding a decode for the rest of the session.
    this.releaseMissingClips()
    for (const { clip, track, offset, ancestors } of this.activeClipList(doc)) {
      if (track.kind === 'text') continue
      const asset = findMedia(doc, clip.mediaId)
      if (!asset || asset.kind !== 'video') continue
      // Missing assets have no URL: pool.get would materialize a phantom
      // <video src=""> (decode error noise) for a still frame that can
      // never render. Same skip rule as syncMedia.
      if (asset.missing || !asset.url) continue
      const start = offset + clip.start
      const active = withinAncestorWindows(t, start, start + clip.duration, ancestors)
      if (!active) continue
      const el = this.pool.get(clip, asset, this.mediaUrl(asset))
      // Clamped into the asset: a ramp may over-consume its source, and the
      // excess freezes on the last readable frame (mp4.ts clamps identically).
      const expected = clampSourceTime(this.sourceTime(clip, t, offset), asset)
      if (
        Math.abs(el.currentTime - expected) > this.stillSeekEps(clip, t, doc.project.fps, offset)
      ) {
        try {
          el.currentTime = parkedTarget(expected)
        } catch {
          // ignore
        }
        el.addEventListener(
          'seeked',
          () => {
            // this.time, not t: a seek superseded by a later one still fires
            // its listener, and repainting the captured t would put a stale
            // frame back on screen after the newer seek already drew.
            if (!this.playingState) this.render(this.time)
          },
          { once: true },
        )
      }
      // The blend partner is parked on its own frame here too, so a still
      // frame blends exactly like a playing one. Its seek landing has to
      // redraw: until it does, the pair falls back to the single frame.
      const partner = blendPartnerTime(clip, t - offset - clip.start, asset, doc.project.fps)
      if (partner === undefined) {
        this.pool.releaseNext(clip.id)
        continue
      }
      const next = this.pool.getNext(clip, asset, this.mediaUrl(asset))
      if (!next) continue
      this.watchPresentedFrames(next)
      const target = clampSourceTime(partner, asset)
      if (Math.abs(next.currentTime - target) > PARTNER_SEEK_EPS) {
        try {
          next.currentTime = parkedTarget(target)
        } catch {
          // ignore
        }
        next.addEventListener(
          'seeked',
          () => {
            // Same rule as the primary element above.
            if (!this.playingState) this.render(this.time)
          },
          { once: true },
        )
      }
    }
    this.render(t)
  }

  private resolveClip(
    clip: Clip,
    local: number,
  ):
    | { asset: MediaAsset; el?: HTMLVideoElement | HTMLImageElement; blend?: FrameBlendSource }
    | undefined {
    const doc = this.opts.getDoc()
    const asset = findMedia(doc, clip.mediaId)
    if (!asset) return undefined
    if (asset.kind === 'image') {
      // Missing assets have no URL. An Image with src "" is a permanent
      // decode failure; skip so the frame plan falls through cleanly.
      if (asset.missing || !asset.url) return undefined
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
      // Missing (restored) assets have no URL: never build an element for them.
      if (asset.missing || !asset.url) return undefined
      const el = this.pool.get(clip, asset, this.mediaUrl(asset)) as HTMLVideoElement
      this.watchPresentedFrames(el)
      // Sub-frame-rate reads hand the compositor the parked partner as well, so
      // the monitor blends the pair the exporter blends instead of holding a
      // source frame for two output frames.
      return { asset, el, blend: this.blendFor(clip, el, asset, local) }
    }
    return { asset } // audio-only
  }
}
